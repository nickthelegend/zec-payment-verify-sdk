# Testing zec-payment-verify-sdk

No mocked clients and no stub RPCs. Every test that touches a chain talks to Zcash testnet through a
real lightwalletd (`testnet.zec.rocks`) or to Avalanche Fuji through its public RPC, using real
mined transactions. The keys used are incoming viewing keys of demo-only wallets, published on
purpose (`fixtures/testnet.json`).

| Package | Runs against | Tests | What |
|---|---|---|---|
| core (Rust, `cargo test`) | — | 3 | rules: exact payment counts only matching memos; one reason per failure; transparent allowed when asked |
| core (Rust, `tests/live.rs`) | Zcash testnet | 5 | the x402 payment verifies with the merchant key; wrong memo / higher amount refused; someone else's payment → `NO_OUTPUT_TO_KEY` and the right key sees it; unknown txid, bad key, bad txid; unreachable lightwalletd is an error |
| core doc example | — | 1 | the README example compiles |
| sdk | Zcash testnet + Fuji | 7 | both rails: pass, each refusal, errors vs verdicts, missing binary; real settled null-402 proof (valid, root known, replay), tampered signals, merchant expectations |
| gateway | Zcash testnet | 4 | 402 + ZIP-321; a real payment answers its challenge → 200, then the txid is refused; wrong payment, unknown memo, garbage; `/api/verify` + CORS |
| mcp | Zcash testnet + Fuji, stdio MCP client | 4 | tools listed read-only; Zcash ok and refused; null-402 settle; Setup required |
| **Total** | | **23 + 1 doc example** | 0 skipped |

`pnpm test` builds the Rust core (`cargo build --release`) and the packages, then runs all of the above.

## Clean install

`scripts/clean-install.sh`: packs `@zpv/sdk` (`pnpm pack`), `cargo install`s the CLI, installs the
tarball with npm into an empty temp directory outside the workspace, and verifies the published x402
payment from there. Result on Oct 20, 2026: `installed @zpv/sdk: ok=true paid=100000 height=4521112`.

## Live run (not part of `pnpm test`)

`ZPV_FUNDER_WALLET=<demo wallet> pnpm --filter @zpv/examples run-live` makes new transactions on
testnet and writes `deployments/testnet.json`: a paywall payment (200), three refused payments
(wrong memo, underpaid, transparent output), and a payslip checked with the employee's key. See the
README table.
