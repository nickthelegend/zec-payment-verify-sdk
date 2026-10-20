# dashboard

"Was I paid?": paste a payment, get a verdict with where it came from.

- **Zcash payment:** incoming viewing key + txid + amount + memo + confirmations → `POST /api/verify` on the local verify API (`pnpm --filter @zpv/gateway api`, :8403) → a stamp (Paid / Not paid / Pending), the reasons in plain words, every output the key decrypts, and provenance (block, confirmations, pools, lightwalletd and tip). The key goes only to that local API.
- **null-402 proof:** a Fuji `settle()` tx → the proof is read from it and checked in the browser with read-only calls to the deployed verifier and pool (viem), optionally with 10× the amount claimed.
- Presets are real: the published x402 payment, the same payment with another invoice memo, and an auction deposit checked with the wrong key.

```sh
pnpm --filter @zpv/gateway api        # needs zpay-verify built (packages/core)
pnpm --filter @zpv/dashboard dev      # http://localhost:5180
```

API down → "Setup required: the verify API is not reachable…". Light and dark; 375 px without horizontal scroll.

`VITE_ZPV_API` points the dashboard at another verify API (default `http://127.0.0.1:8403`).
