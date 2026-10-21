# Testing zec-payment-verify-sdk

No mocked clients and no stub RPCs. Every test that touches a chain talks to Zcash testnet through a
real lightwalletd (`testnet.zec.rocks`) or to Avalanche Fuji through its public RPC, using real
mined transactions. The keys used are incoming viewing keys of demo-only wallets, published on
purpose (`fixtures/testnet.json`).

| Package | Runs against | Tests | Touch a chain | What |
|---|---|---|---|---|
| core (Rust, `cargo test`) | — | 3 | 0 | rules: exact payment counts only matching memos; one reason per failure; transparent allowed when asked |
| core (Rust, `tests/live.rs`) | Zcash testnet | 5 | 4 | the x402 payment verifies with the merchant key; wrong memo / higher amount refused; someone else's payment → `NO_OUTPUT_TO_KEY` and the right key sees it; unknown txid, bad key, bad txid; unreachable lightwalletd is an error (offline) |
| core doc example | — | 1 | 0 | the crate doc example (`src/lib.rs`) compiles |
| sdk | Zcash testnet + Fuji | 8 | 7 | both rails: pass, each refusal, errors vs verdicts, missing binary (offline); real settled null-402 proof (valid, root known, replay); without an expected payTo and amount → `UNBOUND`; tampered signals; merchant expectations |
| gateway `paywall.test.ts` | Zcash testnet | 4 | 3 | 402 + ZIP-321 (offline); a real payment answers its challenge → 200, then the txid is refused; wrong payment, unknown memo, garbage; `/api/verify` + CORS |
| gateway `hardening.test.ts` | Zcash testnet | 3 | 1 | two concurrent requests with one real payment (one upper-cased txid) → one 200, one 402; open challenges capped (503) and expired ones dropped (offline); a JSON-but-not-object `X-PAYMENT` → 400 (offline) |
| mcp | Zcash testnet + Fuji, stdio MCP client | 4 | 2 | tools listed read-only (offline); Zcash ok and refused; null-402 settle, unbound and bound; Setup required (offline) |
| **Total** | | **27 + 1 doc example** | **17** | 0 skipped |

Run on Oct 21, 2026 at the commit that adds this table: all passed. The 10 offline tests are offline
on purpose (rules, input validation, an unreachable server, issuing a challenge, the challenge cap, a
malformed header, the tool list, Setup required). The earlier "20 live" figure (Oct 20) counted
every non-rule test as live; it was 15.

The three `hardening.test.ts` cases and the `UNBOUND` cases were written against the unchanged code
first and failed there (`[200, 200]` for the race, `[402, 402, 402, 402]` for the cap, `502` for the
header, no `UNBOUND` reason), then passed with the fixes. See `docs/JUDGE-2026-10-21.md`.

CI: `.github/workflows/ci.yml` runs `pnpm test` on push and pull request (not yet run on GitHub).

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
