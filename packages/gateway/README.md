# @zpv/gateway

A reference x402 paywall over shielded Zcash payments (Node `http`, no framework). It holds only the
merchant's **incoming viewing key**: it can see payments, never spend.

- `GET /api/quote` → `402` with `{scheme: "zcash-shielded", payTo, amountZat, memo: "zpv-<nonce>", minConf, expiresAt, zip321}`.
- The payer sends that amount with that memo, then retries with `X-PAYMENT: base64({memo, txid})`.
- The gateway runs `@zpv/sdk` `verify({rail: "zcash", …})`. Paid → `200` with the data and an `X-PAYMENT-RESPONSE` receipt; the memo is closed and the txid can never pay again. Not yet confirmed → `402` "payment seen, n/m confirmations". Anything else → `402` with the reasons.
- `POST /api/verify` → the SDK verdict for either rail (used by the dashboard; CORS for `ZPV_CORS`).

```sh
ZPV_PAY_TO=utest1… ZPV_MERCHANT_UIVK=uivktest1… ZPV_PRICE_ZAT=10000 pnpm --filter @zpv/gateway dev   # :8403
```

Tests (`pnpm test`, 4, live lightwalletd): 402 + ZIP-321; a real mined payment answers its challenge
→ 200, and the same txid is refused next time; someone else's payment, an unknown memo and garbage
are refused; `/api/verify` with CORS.
