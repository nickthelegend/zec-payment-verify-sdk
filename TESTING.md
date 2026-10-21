# Testing zec-payment-verify-sdk

No mocked clients and no stub RPCs. Every test that touches a chain talks to Zcash testnet through a
real lightwalletd (`testnet.zec.rocks`; the cross-check tests also reach the Zaino testnet indexer
and the mainnet `zec.rocks`) or to Avalanche Fuji through its public RPC, using real mined
transactions. The keys used are incoming viewing keys of demo-only wallets, published on
purpose (`fixtures/testnet.json`).

| Package | Runs against | Tests | Touch a chain | What |
|---|---|---|---|---|
| core (Rust, `cargo test`) | — | 3 | 0 | rules: exact payment counts only matching memos; one reason per failure; transparent allowed when asked |
| core (Rust, `tests/live.rs`) | Zcash testnet | 5 | 4 | the x402 payment verifies with the merchant key; wrong memo / higher amount refused; someone else's payment → `NO_OUTPUT_TO_KEY` and the right key sees it; unknown txid, bad key, bad txid; unreachable lightwalletd is an error (offline) |
| core doc example | — | 1 | 0 | the crate doc example (`src/lib.rs`) compiles |
| sdk `verify.test.ts` | Zcash testnet + Fuji | 8 | 7 | both rails: pass, each refusal, errors vs verdicts, missing binary (offline); real settled null-402 proof (valid, root known, replay); without an expected payTo and amount → `UNBOUND`; tampered signals; merchant expectations |
| sdk `crosscheck.test.ts` | Zcash testnet (testnet.zec.rocks, zaino.testnet.unsafe.zec.rocks) + a mainnet lightwalletd (zec.rocks) + a dead socket | 6 | 5 | two agreeing answers + a dead endpoint meet a quorum of 2 → paid; one answer for a quorum of 2 → `UNVERIFIED_QUORUM`; testnet vs a real mainnet server that lacks the tx → `UNVERIFIED_DISAGREEMENT` at quorum 1 and 2; agreeing refusals stay refused; the two public testnet indexers → paid only if both answer and agree; env settings and bad settings (offline) |
| gateway `paywall.test.ts` | Zcash testnet | 4 | 3 | 402 + ZIP-321 (offline); a real payment answers its challenge → 200, then the txid is refused; wrong payment, unknown memo, garbage; `/api/verify` + CORS |
| gateway `hardening.test.ts` | Zcash testnet | 4 | 2 | two concurrent requests with one real payment (one upper-cased txid) → one 200, one 402; open challenges capped (503) and expired ones dropped (offline); a JSON-but-not-object `X-PAYMENT` → 400 (offline); endpoints that disagree → 503 unverified, nothing served, then 200 from agreeing endpoints, and `/api/health` lists them |
| gateway `store.test.ts` | Zcash testnet, a SQLite file, a second real paywall process | 4 | 2 | a restarted paywall on the same file refuses the payment it served; a challenge survives a restart (offline); this process and a separate paywall process on one file, sent the same payment at once → one 200, one 402, and neither serves it again; an expired lease is taken over and the old holder can neither release nor settle (offline) |
| mcp | Zcash testnet + Fuji, stdio MCP client | 4 | 2 | tools listed read-only (offline); Zcash ok and refused; null-402 settle, unbound and bound; Setup required (offline) |
| **Total** | | **38 + 1 doc example** | **25** | 0 skipped |

Run on Oct 22, 2026 at the commit that adds this table: all passed. The 13 offline tests are offline
on purpose (rules, input validation, an unreachable server, issuing a challenge, the challenge cap, a
malformed header, the tool list, Setup required, cross-check settings, a challenge read back after a
restart, lease takeover). The earlier "20 live" figure (Oct 20) counted every non-rule test as live;
it was 15.

**Honest labels for the cross-check.** hosh.zec.rocks lists only two public testnet indexers that are
online (Oct 22): testnet.zec.rocks and zaino.testnet.unsafe.zec.rocks, run by one operator, and the
Zaino one answered 503 every time we tried on Oct 22. So "two agreeing answers" in the tests are
testnet.zec.rocks reached through two URLs (`:443` and no port). That exercises the quorum and
agreement logic, not operator independence. The disagreeing server is real: zec.rocks is a mainnet lightwalletd, which does not have the testnet
transaction, exactly what a server withholding it looks like. The dead endpoint is `127.0.0.1:1`.
The Zaino test asserts the invariant (paid only if both answered and agreed, else unverified) and
logs which way it went.

Pass 2 (Oct 22): `store.test.ts` and `crosscheck.test.ts` and the new hardening case were also run
against the code before their fix: the restart test got `200` (expected 402), the two-process test
`[200, 200]` (one payment served by both processes), the challenge-after-restart test `undefined`,
every cross-check case had no `verdict` (the old `verify()` ignored `lwdUrls` and said ok), and the
paywall served the payment (`200`, expected 503) while its two endpoints disagreed. The lease test is
a unit test of the new store.

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
