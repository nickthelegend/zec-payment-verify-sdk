# @zpv/gateway

A reference x402 paywall over shielded Zcash payments (Node `http`, no framework). It holds only the
merchant's **incoming viewing key**: it can see payments, never spend.

- `GET /api/quote` (or `HEAD`) → `402` with `{scheme: "zcash-shielded", payTo, amountZat, memo, minConf, expiresAt, zip321}`.
  The memo is `zpv-<expiry>-<nonce>-<HMAC>`: an HMAC-SHA256 over the payee, the path, the price, the
  expiry and the nonce, under a key the store keeps. Nothing is stored until a payment is presented,
  so any number of GETs cannot lock buyers out (10,000 in about a second in the tests, then a 402 as
  usual). A challenge is payable for `challengeTtlMs` (default 15 min). `OPTIONS` is 204; other
  methods on a paid path are 405. A custom memo (`issueMemo`) is stored instead, capped by
  `maxOpenChallenges`.
- The 402 body is an x402 v1 `PaymentRequiredResponse` (`{x402Version: 1, error, accepts}`); each
  entry carries `maxAmountRequired`, `asset: "ZEC"`, `maxTimeoutSeconds` and
  `extra: {memoNonce, expiresAt (unix s), paymentUri}`, the shape Shielded x402 (Kage) uses for the same
  `zcash-shielded` scheme, plus Hanko's own `amountZat`, `memo`, `minConf`, `zip321`, `expiresAt` (ms).
- The payer sends that amount with that memo, then retries with `X-PAYMENT`: the x402 v1 envelope
  `base64({x402Version: 1, scheme: "zcash-shielded", network: "zcash-testnet", payload: {txid, memoNonce}})`
  (what Kage's client sends; `kage-client.test.ts` imports Kage's own `packages/x402-zcash` and pays the
  paywall with its `fetchWithPayment`) or Hanko's earlier `base64({memo, txid})`. Another scheme, network or
  version is a 400.
- The gateway runs `@zpv/sdk` `verify({rail: "zcash", …})`. Paid → `200` with `{paid: receipt, data}` and `X-PAYMENT-RESPONSE: base64({success: true, transaction: txid, network: "zcash-testnet", payer: ""})` (refusals carry `success: false` and an `errorReason`); the memo and the txid are burned and can never pay again. Not yet confirmed → `402` "payment seen, n/m confirmations". Anything else → `402` with the reasons.
- **Mined-time expiry**, as Shielded x402 does: a payment counts if its block was mined no later than
  the challenge's expiry plus `minedGraceMs` (default 10 min), even when it is presented later (up to
  `presentWindowMs`, default 24 h, e.g. while it gathers confirmations). Mined later → `402
  PAYMENT_LATE`.
- **Refunds.** A refused payment whose outputs with the challenge memo reached the key (underpaid,
  `TRANSPARENT_PART`, `PAYMENT_LATE`) is recorded in the store, and the 402 says the funds arrived
  and are recorded. `GET /api/refunds` lists them (txid, memo, amount, reasons, block) only with
  `Authorization: Bearer <ZPV_ADMIN_TOKEN>` (401 otherwise, compared in constant time). Without
  `ZPV_ADMIN_TOKEN` (at least 16 characters) the endpoint is off: 503 `Setup required:
  ZPV_ADMIN_TOKEN`. Where the request comes from is not trusted: behind a reverse proxy that adds no
  forwarding header every request arrives from loopback. The merchant holds a viewing key, not a spend
  key, so the refund itself is sent by hand from the wallet.
- With `lwdUrls` (or `ZPV_LWD_URLS` + `ZPV_LWD_QUORUM`) each payment is checked against several lightwalletd endpoints. If they disagree or too few answer → `503` + `Retry-After` with `UNVERIFIED_*` and each endpoint's answer; nothing is served and the payment stays claimable.
- `POST /api/verify` → the SDK verdict for either rail (used by the dashboard; CORS for `ZPV_CORS`). Only
  with `verifyApi: true`, which the verify API (`api.ts`) sets and the paywall (`main.ts`) does not: a
  production paywall gives strangers no free checks. The body must be `content-type: application/json`
  (415 otherwise), so a cross-site form or `text/plain` POST, which a browser sends without asking,
  cannot run a check.

| Status | `/api/verify` | paywall (`X-PAYMENT`) |
|---|---|---|
| 400 | the body is not a verify request (not JSON, not an object, unknown rail, `amountZat` not a whole number ≥ 0, bad txid or key, a memo or key with a NUL or control character, a null-402 signal or expected value that is not a decimal uint256) | the header is malformed |
| 415 | the body is not `application/json` | — |
| 502 + `Retry-After` | lightwalletd unreachable or inconsistent, or Fuji unreachable (the message is one line: no request dump or library version) | — |
| 503 + `Retry-After` | too many checks running (`ZPV_MAX_CHECKS`) | lightwalletd unreachable or inconsistent, endpoints disagree, too many checks, or Setup required; nothing is served and the payment stays claimable |
| 503 | Setup required (no `zpay-verify`, a bad setting) | |

**Limits.** Every check runs `zpay-verify` once per lightwalletd endpoint. At most `ZPV_MAX_CHECKS`
(default 8) run at once and `ZPV_MAX_QUEUE` (default 32) wait; past that the answer is 503 +
`Retry-After: 5`. The paywall's own checks have slots of their own, so a flood of `/api/verify` calls
in the same process cannot turn paying customers away; null-402 checks are bounded by
`ZPV_MAX_NULL402_CHECKS` (default 16). A check with no answer is killed after `ZPV_CHECK_TIMEOUT_MS` (default 90 s).
A challenge is closed after `maxFailedAttempts` (default 5) refused payments. `TX_NOT_FOUND` (lightwalletd
has not seen the transaction yet, as when a wallet retries `X-PAYMENT` right after broadcasting),
`NOT_CONFIRMED` and an unverified cross-check do not count. A closed challenge serves nothing, but a
payment presented to it is still checked: if its funds reached the key with the challenge's memo it is
recorded for a refund with reason `CHALLENGE_CLOSED`, and the 402 says so. A new challenge is free.

**State.** The challenge HMAC key, claimed and paid memos/txids, and custom-memo challenges live in a `PaywallStore`. The default
`MemoryStore` forgets them on restart. `SqliteStore` (`node:sqlite`, Node ≥ 22.13; `ZPV_STORE=<file>`)
keeps them in one SQLite file: a restarted paywall still refuses a txid it already served and still
accepts the memos it issued, and several paywall processes on one file serve a payment once. A check claims the memo and txid in a
`BEGIN IMMEDIATE` transaction before it awaits lightwalletd, under a lease (`claimLeaseMs`, default
5 min) so a crashed process does not lock a payment forever; a request whose lease was taken over is
not served.

**Startup checks.** `main.ts` exits 2 with `Setup required: <name>` before listening when
`ZPV_MIN_CONF` is not a whole number from 1 to 4,294,967,295 (0 needs `ZPV_ALLOW_ZERO_CONF=1`), `ZPV_PRICE_ZAT` is not a
whole number from 1 to 420,000,000,000,000 zatoshi (so the 5× report also fits Zcash's amount range),
`ZPV_PORT` is out of range, `ZPV_LWD_QUORUM` is outside 1 through the configured URL count or lacks
`ZPV_LWD_URLS`, or `ZPV_PAY_TO` is not a
testnet unified address with a shielded receiver that belongs to `ZPV_MERCHANT_UIVK` (checked offline
with `zpay-verify owns`; SDK `ownsAddress`). Any of these would take customers' money and refuse every
payment.

```sh
ZPV_PAY_TO=utest1… ZPV_MERCHANT_UIVK=uivktest1… ZPV_PRICE_ZAT=10000 ZPV_STORE=paywall.sqlite pnpm --filter @zpv/gateway dev   # :8403
```

Tests (`pnpm test`, live lightwalletd): `paywall.test.ts` (4): 402 + ZIP-321; a real mined payment
answers its challenge → 200, and the same txid is refused next time; someone else's payment, an
unknown memo and garbage are refused; `/api/verify` with CORS. `hardening.test.ts` (4): concurrent
double-pay, challenge cap, malformed header, and a quorum shortfall using testnet.zec.rocks and a
closed loopback port → 503 unverified, then 200 when quorum is met. `store.test.ts` (4): a restarted paywall on the same
SQLite file refuses the payment it served; a challenge survives a restart; a real second paywall
process on the same file and this one, sent the same payment at once → one 200, one 402; lease
takeover.
