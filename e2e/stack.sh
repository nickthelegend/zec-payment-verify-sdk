#!/usr/bin/env bash
# Starts the real Hanko stack for the browser E2E run, bound to 127.0.0.1, against live Zcash testnet
# lightwalletd (testnet.zec.rocks) with only published keys and already-mined published payments:
#   8420  verify API (packages/gateway dist/api.js), one lightwalletd
#   8421  verify API that cross-checks testnet.zec.rocks and a closed local port, quorum 2 (too few answer)
#   8422  x402 paywall (dist/main.js): the published Hanko merchant address and viewing key, SQLite store
#   8423  x402 paywall whose challenge memo is pinned to the published paywall payment's memo, so that
#         real mined payment can be presented once (e2e/paywall-replay.mjs, as the gateway's live tests do)
#   5190  dashboard (vite dev, as in its README) -> 8420
#   5191  dashboard build -> 8421;  5192  dashboard build -> 8429 (nothing listens: "Setup required")
#   5193  landing (packages/landing/index.html)
# No seed or spending key is read, and no payment is made. PIDs go to e2e/.run/pids; `stack.sh stop`
# kills them by PID.
set -euo pipefail
cd "$(dirname "$0")/.."
RUN=e2e/.run

if [[ "${1:-}" == "stop" ]]; then
  [[ -f $RUN/pids ]] || { echo "no $RUN/pids"; exit 0; }
  while read -r name pid; do kill "$pid" 2>/dev/null && echo "killed $name ($pid)" || echo "$name ($pid) already gone"; done < "$RUN/pids"
  rm -f "$RUN/pids"
  exit 0
fi

node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<13)) { console.error("error: the gateway needs Node >= 22.13 (node:sqlite), this is "+process.version); process.exit(1) }'
[[ -f packages/gateway/dist/api.js && -f packages/sdk/dist/index.js ]] || { echo "error: run pnpm --filter @zpv/sdk --filter @zpv/gateway build" >&2; exit 1; }
[[ -x packages/core/target/release/zpay-verify ]] || { echo "error: packages/core/target/release/zpay-verify missing; run pnpm build:core" >&2; exit 1; }
[[ -f $RUN/pids ]] && { echo "error: $RUN/pids exists; run e2e/stack.sh stop first" >&2; exit 1; }

rm -rf "$RUN"; mkdir -p "$RUN"; chmod 700 "$RUN"
# The Hanko merchant address and incoming viewing key are published in deployments/testnet.json on
# purpose (testnet, incoming only). They go into the env by name and are never printed.
pub() { node -e 'const d=require("./deployments/testnet.json"); process.stdout.write(String(process.argv[1].split(".").reduce((o,k)=>o[k],d)))' "$1"; }
export ZPV_PAY_TO=$(pub wallets.merchant.address) ZPV_MERCHANT_UIVK=$(pub wallets.merchant.uivk)
LWD=https://testnet.zec.rocks:443

VITE="node packages/dashboard/node_modules/vite/bin/vite.js"
VITE_ZPV_API=http://127.0.0.1:8421 $VITE build packages/dashboard --outDir "$PWD/$RUN/dash-xcheck" --emptyOutDir --logLevel warn
VITE_ZPV_API=http://127.0.0.1:8429 $VITE build packages/dashboard --outDir "$PWD/$RUN/dash-down" --emptyOutDir --logLevel warn

start() { # name cmd...
  local name=$1; shift
  "$@" > "$RUN/$name.log" 2>&1 &
  echo "$name $!" >> "$RUN/pids"
}

start api env -u ZPV_LWD_URLS ZPV_PORT=8420 ZPV_LWD_URL=$LWD ZPV_CORS=http://127.0.0.1:5190 node packages/gateway/dist/api.js
start api-xcheck env ZPV_PORT=8421 ZPV_LWD_URLS=$LWD,http://127.0.0.1:9 ZPV_LWD_QUORUM=2 ZPV_CORS=http://127.0.0.1:5191 node packages/gateway/dist/api.js
start paywall env -u ZPV_LWD_URLS ZPV_PORT=8422 ZPV_LWD_URL=$LWD ZPV_STORE="$RUN/paywall.db" ZPV_CORS= node packages/gateway/dist/main.js
start paywall-replay env -u ZPV_LWD_URLS ZPV_PORT=8423 ZPV_LWD_URL=$LWD ZPV_STORE="$RUN/paywall-replay.db" node e2e/paywall-replay.mjs
start dashboard env VITE_ZPV_API=http://127.0.0.1:8420 $VITE packages/dashboard --host 127.0.0.1 --port 5190 --strictPort
start static node e2e/serve-static.mjs 5191:"$RUN/dash-xcheck" 5192:"$RUN/dash-down" 5193:packages/landing

wait_http() { for _ in $(seq 1 100); do curl -fs -o /dev/null "$1" && return 0; sleep 0.3; done; echo "error: $1 never came up" >&2; return 1; }
wait_http http://127.0.0.1:8420/api/health
wait_http http://127.0.0.1:8421/api/health
wait_http http://127.0.0.1:8422/api/health
wait_http http://127.0.0.1:8423/api/health
wait_http http://127.0.0.1:5190/
wait_http http://127.0.0.1:5191/
wait_http http://127.0.0.1:5192/
wait_http http://127.0.0.1:5193/
cat "$RUN/pids"
