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
  (what Kage's client sends) or Hanko's earlier `base64({memo, txid})`. Another scheme, network or
  version is a 400.
- The gateway runs `@zpv/sdk` `verify({rail: "zcash", …})`. Paid → `200` with `{paid: receipt, data}` and `X-PAYMENT-RESPONSE: base64({success: true, transaction: txid, network: "zcash-testnet", payer: ""})` (refusals carry `success: false` and an `errorReason`); the memo and the txid are burned and can never pay again. Not yet confirmed → `402` "payment seen, n/m confirmations". Anything else → `402` with the reasons.
- With `lwdUrls` (or `ZPV_LWD_URLS` + `ZPV_LWD_QUORUM`) each payment is checked against several lightwalletd endpoints. If they disagree or too few answer → `503` + `Retry-After` with `UNVERIFIED_*` and each endpoint's answer; nothing is served and the payment stays claimable.
- `POST /api/verify` → the SDK verdict for either rail (used by the dashboard; CORS for `ZPV_CORS`).

| Status | `/api/verify` | paywall (`X-PAYMENT`) |
|---|---|---|
| 400 | the body is not a verify request (not JSON, not an object, unknown rail, `amountZat` not a whole number ≥ 0, bad txid or key) | the header is malformed |
| 502 + `Retry-After` | lightwalletd unreachable or inconsistent, or Fuji unreachable | — |
| 503 + `Retry-After` | too many checks running (`ZPV_MAX_CHECKS`) | lightwalletd unreachable or inconsistent, endpoints disagree, too many checks, or Setup required; nothing is served and the payment stays claimable |
| 503 | Setup required (no `zpay-verify`, a bad setting) | |

**State.** The challenge HMAC key, claimed and paid memos/txids, and custom-memo challenges live in a `PaywallStore`. The default
`MemoryStore` forgets them on restart. `SqliteStore` (`node:sqlite`, Node ≥ 22.13; `ZPV_STORE=<file>`)
keeps them in one SQLite file: a restarted paywall still refuses a txid it already served and still
accepts the memos it issued, and several paywall processes on one file serve a payment once. A check claims the memo and txid in a
`BEGIN IMMEDIATE` transaction before it awaits lightwalletd, under a lease (`claimLeaseMs`, default
5 min) so a crashed process does not lock a payment forever; a request whose lease was taken over is
not served.

```sh
ZPV_PAY_TO=utest1… ZPV_MERCHANT_UIVK=uivktest1… ZPV_PRICE_ZAT=10000 ZPV_STORE=paywall.sqlite pnpm --filter @zpv/gateway dev   # :8403
```

Tests (`pnpm test`, live lightwalletd): `paywall.test.ts` (4): 402 + ZIP-321; a real mined payment
answers its challenge → 200, and the same txid is refused next time; someone else's payment, an
unknown memo and garbage are refused; `/api/verify` with CORS. `hardening.test.ts` (4): concurrent
double-pay, challenge cap, malformed header, and a payment that testnet.zec.rocks has and a real mainnet lightwalletd does not →
503 unverified, then 200 from two agreeing endpoints. `store.test.ts` (4): a restarted paywall on the same
SQLite file refuses the payment it served; a challenge survives a restart; a real second paywall
process on the same file and this one, sent the same payment at once → one 200, one 402; lease
takeover.
