#!/usr/bin/env bash
# Builds the static site that GitHub Pages serves (.github/workflows/pages.yml) into ${1:-site}:
#   index.html    the landing (packages/landing/index.html, self-contained)
#   dashboard/    the console, built with relative asset paths so it works under /zec-payment-verify-sdk/.
#                 Its null-402 tab runs entirely in the browser against Avalanche Fuji. Its Zcash tab
#                 needs a verify API on the reader's machine (127.0.0.1:8403) and says "Setup required"
#                 when none answers: there is no hosted verify API (that needs a server account).
# No key, no server, nothing deployed by this script.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${1:-site}
case "$OUT" in "" | "/" | "." | "..") echo "error: refusing to build into '$OUT'" >&2; exit 1 ;; esac
[[ -f packages/sdk/dist/null402.js ]] || pnpm --filter @zpv/sdk build
rm -rf "$OUT"
mkdir -p "$OUT"
cp packages/landing/index.html "$OUT/index.html"
node packages/dashboard/node_modules/vite/bin/vite.js build packages/dashboard --base ./ --outDir "$(cd "$OUT" && pwd)/dashboard" --emptyOutDir --logLevel warn
touch "$OUT/.nojekyll"
echo "site: $OUT/index.html and $OUT/dashboard/"
