# examples

- `run-live` — new transactions on Zcash testnet, resumable (`.demo/run-state.json`), writes
  `deployments/testnet.json`: paywall payment (200), wrong memo, underpaid and transparent-output
  payments (402 with reasons), a payslip checked by a lender with the employee's key, the published
  x402 payment and a real null-402 settle on Fuji. Needs `ZPV_FUNDER_WALLET` (zingo data dir of a
  funded demo wallet; the treasury wallet is refused by path).
- `demo` — re-checks the recorded run live through the CLI, the paywall, the SDK and Fuji (the video).

```sh
CARGO_TARGET_DIR=<where zpay-verify is built> ZPV_FUNDER_WALLET=<zingo data dir of a funded demo wallet> pnpm --filter @zpv/examples run-live
pnpm --filter @zpv/examples demo     # re-checks deployments/testnet.json live (no new transactions)
```

