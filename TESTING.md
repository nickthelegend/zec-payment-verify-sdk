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
| core `tests/auth.rs` | Zcash testnet | 4 | 4 | proofs and signatures: the published x402 payment passes; the same payment with its note made worth 10× and re-encrypted to the same address (the rules alone say paid) is refused; a changed proof byte or another tx's binding signature (same txid) is refused; two third-party shielding transactions (Sapling, Ironwood) verify with the outputs their transparent inputs spend and fail with one zatoshi changed or none given; a Sapling tx without the Sapling parameters is Setup required |
| core `tests/live.rs` | Zcash testnet | 7 | 6 | the x402 payment verifies with the merchant key; wrong memo / higher amount refused; someone else's payment → `NO_OUTPUT_TO_KEY` and the right key sees it; unknown txid, bad key, bad txid; unreachable lightwalletd is an error (offline); the block lightwalletd names lists the paywall payment and gives its time (1,792,512,944, Oct 20 16:15:44 UTC); the real compact block with the tx taken out, or another height, is inconsistent |
| core `tests/transport.rs` | Zcash testnet through a local SOCKS5 proxy | 4 | 2 | a real SOCKS5 proxy carries the check and is given the host name (`socks5h`) or an address (`socks5`); a dead proxy is an error, never a direct connection; plaintext to a remote host refused without a connection attempt, loopback allowed |
| core `tests/cli.rs` | the binary, env only | 6 | 0 | plaintext http:// to a remote host refused (exit 2, under 3 s); loopback allowed; `ZPV_ALLOW_INSECURE_LWD=1` lets it through; a dead `ZPV_LWD_PROXY` is exit 2 although the server is up; a non-SOCKS proxy URL is a setup error; `owns` with the published merchant, employee and x402 keys (0 / 1 / 2) |
| core doc example | — | 1 | 0 | the crate doc example (`src/lib.rs`) compiles |
| sdk `verify.test.ts` | Zcash testnet + Fuji | 15 | 12 | both rails: pass (with block time), each refusal, errors vs verdicts, missing binary (offline); a third-party Sapling tx is checked with the Sapling parameters found from the caller's environment, Setup required without them; real settled null-402 proof (valid, root known, replay); without an expected payTo and amount → `UNBOUND`; tampered signals; merchant expectations; a settle's receipt status, recipient and amount; both real `settle()` calls `paid` when bound; a settlement without an expected recipient is `UNBOUND` and one paid to `0x…dEaD` is `RECIPIENT_MISMATCH` (offline rule); empty, negative, non-decimal or ≥ 2^256 signals and expected values are `VerifyError`s (offline); reverted or pending is never ok; an unknown hash is an error |
| sdk `crosscheck.test.ts` | testnet.zec.rocks, zaino.testnet.unsafe.zec.rocks, mainnet zec.rocks, a dead socket | 11 | 5 | two agreeing answers + a dead endpoint meet a quorum of 2 → paid; one answer for a quorum of 2 → `UNVERIFIED_QUORUM`; testnet vs a mainnet server that lacks the tx → `UNVERIFIED_DISAGREEMENT` at quorum 1 and 2; agreeing refusals stay refused; the two public testnet indexers → paid only if both answer and agree; env settings (offline); lag (offline rule): an endpoint a block behind with the tx in its mempool, or without it, → `NOT_CONFIRMED`, not a disagreement; tips a block apart → confirmations at the lower tip; mempool-only lag → pending; an endpoint at or past the block without the tx, or 100 blocks behind, is still a disagreement |
| sdk `hardening.test.ts` | local sockets, testnet, Fuji | 9 | 2 | non-integer/negative amount, bad minConf, memo, rail, non-object → `VerifyError`; two spellings of one endpoint refused; `ZPV_LWD_PROXY` reaches the binary; a plaintext remote URL is Setup required; a silent server is killed after `ZPV_CHECK_TIMEOUT_MS`; 40 checks at once with `ZPV_MAX_CHECKS=3`, `ZPV_MAX_QUEUE=5` → at most 3 processes, 32 `BusyError`; 3 null-402 checks at once with `ZPV_MAX_NULL402_CHECKS=1`, `ZPV_MAX_QUEUE=0` → 1 answer, 2 `BusyError` (live Fuji); a limiter of its own does not share slots (offline); an endpoint whose answer contradicts itself makes the cross-check unverified, naming it |
| gateway `paywall.test.ts` | Zcash testnet | 4 | 3 | 402 + ZIP-321 (offline); a real payment answers its challenge → 200, then the txid is refused; someone else's payment, unknown memo, garbage; `/api/verify` + CORS |
| gateway `hardening.test.ts` | Zcash testnet | 4 | 2 | two concurrent requests with one real payment → one 200, one 402; custom-memo challenges capped (503) and expired ones dropped (offline); a JSON-but-not-object `X-PAYMENT` → 400 (offline); endpoints that disagree → 503 unverified, nothing served, then 200 when a retry reaches its quorum |
| gateway `store.test.ts` | Zcash testnet, SQLite, a second real paywall process | 4 | 2 | a restarted paywall refuses the payment it served; a challenge survives a restart (offline); two processes on one file, sent the same payment at once → one 200, one 402; lease takeover, and a paid memo is burned (offline) |
| gateway `status.test.ts` | a closed local port, a dead Fuji RPC | 4 | 0 | lightwalletd down → `/api/verify` 502 + `Retry-After`, paywall 503 + `Retry-After`; missing binary → 503 on both; fifteen malformed bodies (a NUL in the memo or key, a negative or 2^256 signal, an empty expected payTo among them) → 400 with a one-line message; a Fuji failure → 502 without viem's request dump or version footer |
| gateway `challenges.test.ts` | a closed local port | 4 | 0 | 10,000 GETs store nothing and the next GET is a 402; OPTIONS 204, HEAD 402 without a body, POST/PUT/DELETE 405; forged expiry, nonce or tag and another resource refused before any check; the HMAC key survives a restart in SQLite, not in memory |
| gateway `x402.test.ts` | Zcash testnet | 3 | 1 | the 402 passes Shielded x402's `parsePaymentRequired` rules (offline); the v1 `X-PAYMENT` envelope for the published paywall payment → 200 and the spec `X-PAYMENT-RESPONSE`; another scheme, network or version → 400 (offline) |
| gateway `kage-client.test.ts` | Zcash testnet, Shielded x402's own `packages/x402-zcash` | 2 | 1 | its `parsePaymentRequired` accepts Hanko's 402 and HMAC memo and its ZIP 321 URI matches (offline); its `fetchWithPayment` presents the published paywall payment → 200 and `success: true`, then 402 |
| gateway `refunds.test.ts` | Zcash testnet | 3 | 2 | the published transparent-part and underpaid payments → 402, recorded, listed on `/api/refunds` with the admin token; without the token, with a wrong one, or relayed by a proxy → 401; someone else's payment not recorded; no `ZPV_ADMIN_TOKEN` → 503 Setup required even from loopback (offline); mined-time expiry: served with a 10 min grace, `PAYMENT_LATE` with 2 min, gone after 25 h |
| gateway `limits.test.ts` | a silent local server; Zcash testnet | 3 | 2 | 150 concurrent `/api/verify` with `ZPV_MAX_CHECKS=4` → at most 4 processes, 142 × 503 + `Retry-After: 5`; 6 unknown txids (`TX_NOT_FOUND`) do not close a challenge, the real payment is then served; 5 counted refusals close it, and the real payment presented then is checked, not served, and recorded as a `CHALLENGE_CLOSED` refund |
| gateway `api.test.ts` | a silent local server; Zcash testnet | 3 | 1 | a paywall without `verifyApi` answers 404 to `/api/verify` (offline); text/plain, form and multipart bodies → 415 before any check (offline); with `ZPV_MAX_CHECKS=1`, `ZPV_MAX_QUEUE=0` and the verify API's slot held, the paywall still serves the published payment (200) |
| gateway `startup.test.ts` | the real entry point, offline | 3 | 0 | the published address and its key start; `ZPV_MIN_CONF` abc or 0, `ZPV_PRICE_ZAT` -1/0/1.5, `ZPV_PORT` 70000, a short `ZPV_ADMIN_TOKEN` → exit 2 naming the variable; a payTo the key cannot see, a transparent address, a bad key → exit 2 |
| mcp | Zcash testnet + Fuji, stdio MCP client | 8 | 4 | tools listed, their descriptions name the replay rule (offline); Zcash ok and refused; `min_conf: 0` raised to 1; `ZPV_STORE`: ok once, then `ALREADY_USED`, memo required; `ZPV_MCP_REQUIRE_MEMO` and a 0600 log (offline); both real `settle()` calls paid when bound, `UNBOUND` without the recipient, `RECIPIENT_MISMATCH`; `verify_zcash_payment` is `readOnlyHint: true` without a store and `readOnlyHint: false`, single use, with one (offline); Setup required (offline) |
| **Total** | | **104 + 1 doc example** | **49** | 0 skipped |

Run on Oct 23, 2026 (IST; Oct 22 UTC) at the commit that adds this table: all passed (`pnpm test`,
exit 0). The 55 offline tests are offline on purpose: rules, input validation and status codes,
plaintext and proxy refusals, `owns`, killing a silent check, the process limits, challenges
(issuing, flooding, forging, restarting), the x402 envelope checks, the cross-check rule for lag,
startup checks, the tool list and annotations, Setup required, cross-check settings and lease
takeover.

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

**What failed on the old code (this round, Oct 22–23).** Each new test was run against the code
before its fix first:
- sdk: `settlementVerdict('success', …, '0x…dEaD', {payTo, requiredAmount})` was `paid`; an empty
  `expect.payTo` matched a zero payTo signal; three concurrent null-402 checks with a limit of 1 all
  ran; the cross-check called an endpoint one block behind a disagreement (`unverified`); a Sapling
  transaction was Setup required because the binary never got `HOME`.
- gateway: six `TX_NOT_FOUND` attempts closed the challenge and the real payment got "too many
  refused payments" with no check and no refund; `/api/refunds` answered 200 to any loopback request
  and with no token configured; the production paywall served `/api/verify`, a `text/plain` POST ran a
  check, and with the API's one slot busy the paying customer got 503; a NUL in the memo was 502 with
  Node's spawn error, and a Fuji failure returned viem's multi-line dump.
- mcp: a settlement bound by payTo and amount but no recipient was `paid`; `verify_zcash_payment`
  was `readOnlyHint: true` with `ZPV_STORE`.
- dashboard (Playwright): the Pages console opened on the Zcash tab and pinged `127.0.0.1:8403`;
  there was no recorded output, no exact command and no local-network note; a paid answer without a
  memo said "with the expected memo".
- core: `tests/auth.rs` calls `auth::check_authorization`, which did not exist; before it `inspect`
  accepted the re-encrypted 10× note (the rules call it paid, as the test shows).
- `kage-client.test.ts` passed when written: it covers a claim (Shielded x402's own client can pay the
  paywall) that was tested only with a copied header before.

**What failed on the old code (Ultra round 1, Oct 22).** Each new test was run against the code before
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
| `landing.spec.ts` | 15 passed | 14 passed, 1 skipped (the jump box is hidden below 900 px) |
| `dashboard.spec.ts` | 17 passed | 16 passed, 1 skipped (keyboard skip link) |
| `pages.spec.ts` | 2 passed | 2 passed |
| `paywall.spec.ts` | 2 passed | — (one published payment, one store) |
| **Total** | **36** | **32 + 2 skipped** |

62 passed, 0 failed, 2 skipped on Oct 23, 2026 (IST). Oct 25, 2026: the landing became a one-screen overview and the API reference moved to `reference.html`; the 12 reference tests now open `reference.html` and 3 new ones cover the overview (headline, buttons, the stamped response, reduced motion, the numbers equal this file's totals, links). `landing.spec.ts` alone: 29 passed, 1 skipped, so the suite is now 68 passed, 2 skipped. New this round: the Pages console opens on the
null-402 tab with no error and no request to a local API, and answers live from Fuji; its Zcash tab
gives the exact `ZPV_CORS=<origin> pnpm --filter @zpv/gateway api` command and the local-network note,
beside the recorded real answer for the selected example, labelled "Recorded output, not live" and
never stamped, and nothing for parameters that were not recorded; a paid check without a memo says
no memo was checked and shows `NO_MEMO_BOUND`. Every test also asserts no console errors, no failed
requests to the page or the stack beyond the honest ones it names, and no horizontal scroll at 375 px.

## CI

`.github/workflows/ci.yml` runs `pnpm test` on push and pull request; `.github/workflows/pages.yml`
publishes the landing and console. Neither has run on GitHub yet: nothing is pushed.
CI fetches the Sapling parameters from download.z.cash and clones zec-shielded-x402 for
`kage-client.test.ts`; that test needs Kage's `packages/x402-zcash` on its GitHub `main`, which is
local-only on Oct 22 (until Kage is pushed, that one test fails with Setup required: KAGE_X402_DIR).

## Clean install

`scripts/clean-install.sh`: packs `@zpv/sdk` (`pnpm pack`), `cargo install`s the CLI, installs the
tarball with npm into an empty temp directory outside the workspace, and verifies the published x402
payment from there. Result on Oct 20, 2026: `installed @zpv/sdk: ok=true paid=100000 height=4521112`.

## Live runs (not part of `pnpm test`)

`ZPV_FUNDER_WALLET=<demo wallet> pnpm --filter @zpv/examples run-live` makes new transactions on
testnet and writes `deployments/testnet.json`: a paywall payment (200), three refused payments
(wrong memo, underpaid, transparent output), and a payslip checked with the employee's key (Oct 20).

`ZPV_PAYER_WALLET=<demo wallet> pnpm --filter @zpv/examples paywall-live` pays the current paywall
once with nothing pinned (Oct 22): stateless HMAC memo, 10,000 zat from the employee demo wallet,
presented with Shielded x402's `fetchWithPayment` until confirmed → 200, replay → 402; tx
`2867d542…664f`, block 4,530,239 (`deployments/testnet.json` `paywallLive`). The paywall tests in
`pnpm test` still present the Oct 20 payment to a paywall whose memo is pinned to it, because a test
cannot pay anew on every run; this run is the one fresh payment through the unpinned path.

## Zero-tolerance audit rerun (2026-10-26)

These counts are copied from the audit logs and status files. A combined `pnpm test` total for this rerun was not recorded. Handback labels for individual checklist rows are in `audit/HANDOFF.md`.

`audit/reverify-backend/README.md` prints 130 PASS, 0 FAIL, 6 UNTESTED across 136 backend rows. It also prints core 25 tests + 1 doc example, SDK 75/75, gateway 38/38, MCP 25/25, and the HTTP supplement 64/64 rows passing. `audit/reverify-backend/summary.json` prints the same row split: PASS 130, UNTESTED 6 (API 64 PASS; CHAIN 16 PASS and 2 UNTESTED; CLI 20 PASS and 1 UNTESTED; MCP 17 PASS; EDGE 13 PASS and 3 UNTESTED). That split is the backend mapping before the handback relabels EDGE-039 and EDGE-040.

`audit/reverify-backend/core.txt` prints separate Cargo results: `src/lib.rs` 4 passed, 0 failed; `src/main.rs` 0 passed, 0 failed; `tests/auth.rs` 4 passed, 0 failed; `tests/cli.rs` 6 passed, 0 failed; `tests/live.rs` 7 passed, 0 failed; `tests/transport.rs` 4 passed, 0 failed; doc-tests 1 passed, 0 failed. Exit 0. A single Cargo summary line was not printed; the 25 + 1 figure above is the README's total.

`audit/reverify-backend/sdk.txt`: Test Files 4 passed (4); Tests 75 passed (75). Exit 0.

`audit/reverify-backend/suite.txt` (gateway): Test Files 11 passed (11); Tests 38 passed (38). Exit 0. The same README says the first gateway run had 36 passing tests and two missing `KAGE_X402_DIR` setup failures (`suite-initial-missing-kage.txt`); the rerun above is after the public client checkout.

`audit/reverify-backend/mcp.txt`: Test Files 2 passed (2); Tests 25 passed (25).

`audit/reverify-backend/http.txt`: HTTP audit complete: 0 failed rows.

`audit/reverify-backend/sdk-build.txt`, `gateway-build.txt`, and `mcp-build.txt` each print EXIT 0. A test count for those builds was not recorded.

`audit/reverify-console/validation.json` prints 39 rows, PASS 38, FAIL 0, UNTESTED 1, 743 assertions, 39 screenshots. `audit/reverify-console/README.md` prints the same 38 PASS, 0 FAIL, 1 UNTESTED. `console-run.txt` prints PAGE-021 through PAGE-035 each PASS with network=0, console=0, pageErrors=0, requestFailures=0. `pages-run.txt` prints PAGE-036 through PAGE-040 and EDGE-021 PASS with empty unexpected http, console, pageErrors, and requests. `edges-run.txt` prints EDGE-001 through EDGE-023 with unexpected http, console, requests, and pageErrors all 0, and EDGE-024 UNTESTED with unexpected http 2, console 7, requests 1, pageErrors 0.

`audit/reverify-landing/README.md` prints 34 PASS, 1 FAIL, 0 UNTESTED across 35 rows, 747 assertions, and 55 JPEG screenshots. The FAIL it names is HERO-009. The handback marks that row UNTESTED; see `audit/HANDOFF.md`.

`audit/reverify-backend/validation.json` records auditBytes 8311997 against a budget of 15000000. `audit/reverify-console/validation.json` records auditBytes 7187861. `audit/reverify-landing/README.md` records 14,148,462 bytes at its own validation. A single byte count taken after every reverify directory was present was not printed in those files. At handback, `du -sh audit` printed 9.4M, which is under 15 MB, so no superseded images were deleted.
