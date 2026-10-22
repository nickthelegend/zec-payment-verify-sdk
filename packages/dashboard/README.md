# dashboard

"Was I paid?" as an API console, in the same three-column archetype as the landing: endpoints on the
left, the request's parameters and the human verdict in the centre, and the exact request and the
real response on the right, where a seal (Paid / Unpaid / Wait / Hold) presses onto each new response.

- **Zcash payment** (`POST /api/verify` on the local verify API, `pnpm --filter @zpv/gateway api`,
  :8403): viewing key + txid + amount + memo + confirmations → verdict, reasons in plain words, every
  output the key decrypts, provenance (block, confirmations, pools, lightwalletd, tip). The key goes
  only to that API; the request pane shows it shortened. When the API cross-checks
  (`ZPV_LWD_URLS`), the send row says how many endpoints and the quorum (from `GET /api/health`),
  every verdict lists what each endpoint said, and endpoints that disagree or too few answers give an
  **Unverified** badge and a HOLD seal, never Paid.
- **null-402 proof**: a Fuji `settle()` tx → the proof is read from it and checked in the browser
  with read-only calls to the deployed verifier and pool (viem). `expect.payTo` and
  `expect.requiredAmount` are needed for a "Paid"; leave them empty to see `UNBOUND`. Optional
  tamper: claim 10× the amount.
- Examples are real: the published x402 payment, the same payment with another invoice memo, and an
  auction deposit checked with the wrong key.
- While a check runs its parameters and example chips are locked (a disabled fieldset), so the request
  pane always shows the request the answer is for. Switching rail abandons the check in flight (its
  fetch is aborted and a late answer is dropped); a check with no answer in 90 s is an error. On the
  null-402 tab the status is neutral: that tab never uses the local API.
- States: the top bar pings `GET /api/health` on load; API down or not allowing this origin →
  "Setup required" with the fix and a re-check button. Empty, waiting and error panes.
  375 px without horizontal scroll; reduced motion skips the stamp animation.

```sh
pnpm --filter @zpv/gateway api        # needs zpay-verify built (packages/core)
pnpm --filter @zpv/dashboard dev      # http://localhost:5180 (the API allows this origin by default)
```

`VITE_ZPV_API` points the dashboard at another verify API (default `http://127.0.0.1:8403`);
`ZPV_CORS` on the API lists the origins it answers.
