#!/usr/bin/env bash
# Install the SDK from its packed tarball and the CLI with `cargo install` into an empty directory
# outside the workspace, then verify the published x402 payment from there. Live testnet.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pnpm --dir "$ROOT/packages/sdk" build >/dev/null
TARBALL="$(cd "$ROOT/packages/sdk" && pnpm pack --pack-destination "$TMP" | tail -1)"
echo "packed $(basename "$TARBALL")"
cargo install --quiet --path "$ROOT/packages/core" --root "$TMP/cargo" --locked
echo "cargo installed $TMP/cargo/bin/zpay-verify"
cd "$TMP" && npm init -y >/dev/null && npm install --silent --no-audit --no-fund "$TARBALL"
cp "$ROOT/fixtures/testnet.json" "$TMP/fx.json"
cat > check.mjs <<'JS'
import { readFileSync } from 'node:fs';
import { verify } from '@zpv/sdk';
const fx = JSON.parse(readFileSync('fx.json', 'utf8')).x402;
const r = await verify({ rail: 'zcash', uivk: fx.uivk, txid: fx.txid, amountZat: fx.amountZat, memo: fx.memo });
console.log(`installed @zpv/sdk: ok=${r.ok} paid=${r.paidZat} height=${r.report.height}`);
process.exit(r.ok ? 0 : 1);
JS
ZPV_BIN="$TMP/cargo/bin/zpay-verify" node check.mjs
