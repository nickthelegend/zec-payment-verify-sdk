# @zpv/gateway

A reference x402 paywall over shielded Zcash payments (Node `http`, no framework). It holds only the
merchant's **incoming viewing key**: it can see payments, never spend.

- `GET /api/quote` → `402` with `{scheme: "zcash-shielded", payTo, amountZat, memo: "zpv-<nonce>", minConf, expiresAt, zip321}`.
- The payer sends that amount with that memo, then retries with `X-PAYMENT: base64({memo, txid})`.
- The gateway runs `@zpv/sdk` `verify({rail: "zcash", …})`. Paid → `200` with the data and an `X-PAYMENT-RESPONSE` receipt; the memo is closed and the txid can never pay again. Not yet confirmed → `402` "payment seen, n/m confirmations". Anything else → `402` with the reasons.
- `POST /api/verify` → the SDK verdict for either rail (used by the dashboard; CORS for `ZPV_CORS`).

**State.** Open challenges and claimed memos/txids live in a `PaywallStore`. The default
`MemoryStore` forgets them on restart. `SqliteStore` (`node:sqlite`, Node ≥ 22.13; `ZPV_STORE=<file>`)
keeps them in one SQLite file: a restarted paywall still refuses a txid it already served, and several
paywall processes on one file serve a payment once. A check claims the memo and txid in a
`BEGIN IMMEDIATE` transaction before it awaits lightwalletd, under a lease (`claimLeaseMs`, default
5 min) so a crashed process does not lock a payment forever; a request whose lease was taken over is
not served.

```sh
ZPV_PAY_TO=utest1… ZPV_MERCHANT_UIVK=uivktest1… ZPV_PRICE_ZAT=10000 ZPV_STORE=paywall.sqlite pnpm --filter @zpv/gateway dev   # :8403
```

Tests (`pnpm test`, live lightwalletd): `paywall.test.ts` (4): 402 + ZIP-321; a real mined payment
answers its challenge → 200, and the same txid is refused next time; someone else's payment, an
unknown memo and garbage are refused; `/api/verify` with CORS. `hardening.test.ts` (3): concurrent
double-pay, challenge cap, malformed header. `store.test.ts` (4): a restarted paywall on the same
SQLite file refuses the payment it served; a challenge survives a restart; a real second paywall
process on the same file and this one, sent the same payment at once → one 200, one 402; lease
takeover.
