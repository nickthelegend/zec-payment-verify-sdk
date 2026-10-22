# Testing zec-payment-verify-sdk (Hanko)

No mocked clients and no stub RPCs. Every test that touches a chain talks to Zcash testnet through a
real lightwalletd (`testnet.zec.rocks`; the cross-check tests also reach the Zaino testnet indexer and
the mainnet `zec.rocks`) or to Avalanche Fuji through its public RPC, using real mined transactions.
The keys used are incoming viewing keys of demo-only wallets, published on purpose
(`fixtures/testnet.json`, `deployments/testnet.json`). Where a test needs a server that misbehaves,
it is a real socket on 127.0.0.1: a closed port, a TCP server that accepts and stays silent, or a
real SOCKS5 proxy that forwards to testnet.zec.rocks.

## Unit and live tests (`pnpm test`)

| Package | Runs against | Tests | Touch a chain | What |
|---|---|---|---|---|
| core rules (Rust, `cargo test`) | — | 3 | 0 | exact payment counts only matching memos; one reason per failure; transparent allowed when asked |
| core `tests/live.rs` | Zcash testnet | 7 | 6 | the x402 payment verifies with the merchant key; wrong memo / higher amount refused; someone else's payment → `NO_OUTPUT_TO_KEY` and the right key sees it; unknown txid, bad key, bad txid; unreachable lightwalletd is an error (offline); the block lightwalletd names lists the paywall payment and gives its time (1,792,512,944, Oct 20 16:15:44 UTC); the real compact block with the tx taken out, or another height, is inconsistent |
| core `tests/transport.rs` | Zcash testnet through a local SOCKS5 proxy | 4 | 2 | a real SOCKS5 proxy carries the check and is given the host name (`socks5h`) or an address (`socks5`); a dead proxy is an error, never a direct connection; plaintext to a remote host refused without a connection attempt, loopback allowed |
| core `tests/cli.rs` | the binary, env only | 6 | 0 | plaintext http:// to a remote host refused (exit 2, under 3 s); loopback allowed; `ZPV_ALLOW_INSECURE_LWD=1` lets it through; a dead `ZPV_LWD_PROXY` is exit 2 although the server is up; a non-SOCKS proxy URL is a setup error; `owns` with the published merchant, employee and x402 keys (0 / 1 / 2) |
| core doc example | — | 1 | 0 | the crate doc example (`src/lib.rs`) compiles |
| sdk `verify.test.ts` | Zcash testnet + Fuji | 12 | 11 | both rails: pass (with block time), each refusal, errors vs verdicts, missing binary (offline); real settled null-402 proof (valid, root known, replay); without an expected payTo and amount → `UNBOUND`; tampered signals; merchant expectations; a settle's receipt status, recipient and amount; both real `settle()` calls on the pool are `paid` to their merchant, another recipient or amount or no binding is not; reverted or pending is never ok (the rule on the real proof check); an unknown hash is an error |
| sdk `crosscheck.test.ts` | testnet.zec.rocks, zaino.testnet.unsafe.zec.rocks, mainnet zec.rocks, a dead socket | 6 | 5 | two agreeing answers + a dead endpoint meet a quorum of 2 → paid; one answer for a quorum of 2 → `UNVERIFIED_QUORUM`; testnet vs a mainnet server that lacks the tx → `UNVERIFIED_DISAGREEMENT` at quorum 1 and 2; agreeing refusals stay refused; the two public testnet indexers → paid only if both answer and agree; env settings and bad settings (offline) |
| sdk `hardening.test.ts` | local sockets, testnet once | 7 | 1 | non-integer/negative amount, bad minConf, memo, rail, non-object → `VerifyError`; two spellings of one endpoint refused; `ZPV_LWD_PROXY` reaches the binary; a plaintext remote URL is Setup required; a silent server is killed after `ZPV_CHECK_TIMEOUT_MS`; 40 checks at once with `ZPV_MAX_CHECKS=3`, `ZPV_MAX_QUEUE=5` → at most 3 processes, 32 `BusyError`; an endpoint whose answer contradicts itself makes the cross-check unverified, naming it |
| gateway `paywall.test.ts` | Zcash testnet | 4 | 3 | 402 + ZIP-321 (offline); a real payment answers its challenge → 200, then the txid is refused; someone else's payment, unknown memo, garbage; `/api/verify` + CORS |
| gateway `hardening.test.ts` | Zcash testnet | 4 | 2 | two concurrent requests with one real payment → one 200, one 402; custom-memo challenges capped (503) and expired ones dropped (offline); a JSON-but-not-object `X-PAYMENT` → 400 (offline); endpoints that disagree → 503 unverified, nothing served, then 200 when a retry reaches its quorum |
| gateway `store.test.ts` | Zcash testnet, SQLite, a second real paywall process | 4 | 2 | a restarted paywall refuses the payment it served; a challenge survives a restart (offline); two processes on one file, sent the same payment at once → one 200, one 402; lease takeover, and a paid memo is burned (offline) |
| gateway `status.test.ts` | a closed local port | 3 | 0 | lightwalletd down → `/api/verify` 502 + `Retry-After`, paywall 503 + `Retry-After`; missing binary → 503 on both; ten malformed bodies → 400 |
| gateway `challenges.test.ts` | a closed local port | 4 | 0 | 10,000 GETs store nothing and the next GET is a 402; OPTIONS 204, HEAD 402 without a body, POST/PUT/DELETE 405; forged expiry, nonce or tag and another resource refused before any check; the HMAC key survives a restart in SQLite, not in memory |
| gateway `x402.test.ts` | Zcash testnet | 3 | 1 | the 402 passes Shielded x402's `parsePaymentRequired` rules (offline); Shielded x402's own `X-PAYMENT` envelope for the published paywall payment → 200 and the spec `X-PAYMENT-RESPONSE`; another scheme, network or version → 400 (offline) |
| gateway `refunds.test.ts` | Zcash testnet | 2 | 2 | the published transparent-part and underpaid payments → 402, recorded, listed on `/api/refunds` (403 through a proxy header); someone else's payment not recorded; the paywall payment presented 30 min after a challenge that expired 5 min before its block → 200 with a 10 min grace, `PAYMENT_LATE` with 2 min, gone after 25 h |
| gateway `limits.test.ts` | a silent local server; Zcash testnet | 2 | 1 | 150 concurrent `/api/verify` with `ZPV_MAX_CHECKS=4` → at most 4 processes, 142 × 503 + `Retry-After: 5`; 5 refused attempts close a challenge, even for the payment that would have paid it |
| gateway `startup.test.ts` | the real entry point, offline | 3 | 0 | the published address and its key start; `ZPV_MIN_CONF` abc or 0, `ZPV_PRICE_ZAT` -1/0/1.5, `ZPV_PORT` 70000 → exit 2 naming the variable; a payTo the key cannot see, a transparent address, a bad key → exit 2 |
| mcp | Zcash testnet + Fuji, stdio MCP client | 7 | 4 | tools listed, their descriptions name the replay rule (offline); Zcash ok and refused; `min_conf: 0` raised to 1; `ZPV_STORE`: ok once, then `ALREADY_USED`, memo required; `ZPV_MCP_REQUIRE_MEMO` and a 0600 log (offline); both real `settle()` calls paid when bound, `UNBOUND`, `RECIPIENT_MISMATCH`; Setup required (offline) |
| **Total** | | **81 + 1 doc example** | **40** | 0 skipped |

Run on Oct 22, 2026 at the commit that adds this table: all passed (`pnpm test`, exit 0). The 41
offline tests are offline on purpose: rules, input validation and status codes, plaintext and proxy
refusals, `owns`, killing a silent check, the process limit, challenges (issuing, flooding, forging,
restarting), the x402 envelope checks, startup checks, the tool list, Setup required, cross-check
settings and lease takeover.

**Honest labels for the cross-check.** hosh.zec.rocks lists only two public testnet indexers that are
online (Oct 22): testnet.zec.rocks and zaino.testnet.unsafe.zec.rocks, run by one operator, and the
Zaino one answered 503 every time we tried on Oct 22 (again during this run). `verify()` now refuses
one server under two spellings (`https://testnet.zec.rocks` and `…:443`) as the same endpoint twice,
so the tests that need two agreeing answers fetch from testnet.zec.rocks twice and hand both real
answers to the cross-check rule (`crossCheckVerdict`). That exercises the quorum and agreement logic,
not operator independence. The disagreeing server is real: zec.rocks is a mainnet lightwalletd, which
does not have the testnet transaction, exactly what a server withholding it looks like. The dead
endpoint is `127.0.0.1:1`. A self-contradicting answer cannot be produced by a real public server, so
the core tests that rule on the real compact block with the tx removed, and the SDK test pairs a real
answer with the exact error the core raises.

**What failed on the old code (Ultra round, Oct 22).** Each new test was run against the code before
its fix first:
- core CLI: `ZPV_LWD_PROXY=socks5h://127.0.0.1:1` printed a paid verdict (exit 0, direct connection);
  `http://203.0.113.1:9067` waited for the connect timeout instead of refusing; `owns` did not exist.
- sdk: `amountZat: 1.5` threw a `RangeError`, not a `VerifyError`; two spellings of one server were
  two votes (paid); the proxy setting never reached the binary (paid); a silent server ran for the
  full 20 s hold; 40 parallel checks were all spawned; settlements had no status.
- gateway: lightwalletd down was 400 on both surfaces; a null body, `rail: "btc"`, `amountZat:
  "abc"` were 502; the 10,001st GET was 503 (lockout); OPTIONS issued a challenge (402); the 402 had no
  top-level `x402Version`, and Shielded x402's `X-PAYMENT` envelope got "unknown or expired payment
  memo"; refused payments were not recorded; a payment presented after expiry was refused; a sixth
  attempt was still checked (200 for the real payment); `ZPV_MIN_CONF=abc` and a payTo the key cannot
  see started the paywall.
- mcp: a bound real settlement was `NULLIFIER_SPENT` (never ok); the same payment passed twice;
  `min_conf: 0` was used as given.
- The 150-request gateway limit test passed from the SDK limiter commit on; its SDK-level twin is the
  one that failed on the old code.

Earlier rounds: the store and cross-check tests (pass 2) and the hardening and `UNBOUND` cases
(pass 1) were also written against the unchanged code first; see the git history.

## Browser tests (`e2e/`, Playwright in Google Chrome)

`e2e/stack.sh` starts the real stack on 127.0.0.1 (two verify APIs, two paywalls, the dashboard in
dev and as builds, and the GitHub Pages site from `scripts/build-pages.sh`); `npm run test:e2e` runs
the specs; `e2e/stack.sh stop` kills the stack's processes by PID.

| Spec | Desktop (1280×800) | Mobile (375×812) |
|---|---|---|
| `landing.spec.ts` | 12 passed | 11 passed, 1 skipped (the jump box is hidden below 900 px) |
| `dashboard.spec.ts` | 16 passed | 15 passed, 1 skipped (keyboard skip link) |
| `paywall.spec.ts` | 2 passed | — (one published payment, one store) |
| **Total** | **30** | **26 + 2 skipped** |

56 passed, 0 failed, 2 skipped on Oct 22, 2026. New this round: the Dashboard link of the Pages site
opens the console, whose null-402 tab returns `NULLIFIER_SPENT` + `UNBOUND` and then `BAD_PROOF` live
from Fuji while its Zcash tab says Setup required; a check in flight locks the parameters and a rail
switch drops its answer; the null-402 tab's status is neutral; the paywall answers in x402 v1 and
accepts Shielded x402's envelope. Every test also asserts no console errors, no failed requests to the
page or the stack beyond the honest ones it names, and no horizontal scroll at 375 px.

## CI

`.github/workflows/ci.yml` runs `pnpm test` on push and pull request; `.github/workflows/pages.yml`
publishes the landing and console. Neither has run on GitHub yet: nothing is pushed.

## Clean install

`scripts/clean-install.sh`: packs `@zpv/sdk` (`pnpm pack`), `cargo install`s the CLI, installs the
tarball with npm into an empty temp directory outside the workspace, and verifies the published x402
payment from there. Result on Oct 20, 2026: `installed @zpv/sdk: ok=true paid=100000 height=4521112`.

## Live run (not part of `pnpm test`)

`ZPV_FUNDER_WALLET=<demo wallet> pnpm --filter @zpv/examples run-live` makes new transactions on
testnet and writes `deployments/testnet.json`: a paywall payment (200), three refused payments
(wrong memo, underpaid, transparent output), and a payslip checked with the employee's key. See the
README table. Not rerun in this round (no new payment was made).
