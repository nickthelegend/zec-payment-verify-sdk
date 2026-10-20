# Hanko — verify shielded Zcash payments with a viewing key

**"Was I paid?" for shielded Zcash.** Check that a transaction paid you at least N zatoshi with
memo M, with enough confirmations and no transparent part, using only your **incoming viewing key**
(it sees payments coming in; it cannot spend). The same `verify()` checks a **null-402** Groth16
payment proof against the contracts null-402 deployed on Avalanche Fuji.

A Rust crate + CLI, a TypeScript SDK, an x402 paywall, an MCP server and a dashboard. The core is
extracted from [zec-shielded-x402](https://github.com/nickthelegend/zec-shielded-x402)'s `check_uivk`.

```ts
const r = await verify({ rail: 'zcash', uivk, txid, amountZat: 10_000, memo: 'zpv-…' });
r.ok; r.reasons;   // [] or TX_NOT_FOUND / NO_OUTPUT_TO_KEY / MEMO_MISMATCH / AMOUNT_TOO_LOW / NOT_CONFIRMED / TRANSPARENT_PART
```

## Live on Zcash testnet

Run of Oct 20, 2026 (`deployments/testnet.json`, `pnpm --filter @zpv/examples run-live`). New
demo-only wallets; their incoming viewing keys are published in the record on purpose. All mined
transactions below were re-checked by the merchant's or the employee's viewing key.

| Case | Transaction | The check said |
|---|---|---|
| paywall: `GET /api/quote` → 402, payer sends 10,000 zat with the challenge memo, retries with `X-PAYMENT` | [`7c1f6cc0…`](https://testnet.zcashexplorer.app/transactions/7c1f6cc09a7ae9171beffbbb2dfbf15668431d7b997f742e18706d9296b34c16) (block 4,522,621) | **200**, receipt, memo closed |
| 10,000 zat with another memo | [`1620eccc…`](https://testnet.zcashexplorer.app/transactions/1620eccca54f2558e3cde640f3f378b55278ee5e2e553006cff41bbf238549c0) | 402 `MEMO_MISMATCH, AMOUNT_TOO_LOW` |
| 5,000 zat with the right memo | [`f9db1841…`](https://testnet.zcashexplorer.app/transactions/f9db1841853b2e7befb516b62563c770aceef538769f35a15cd4c4021cf4dce2) | 402 `AMOUNT_TOO_LOW` |
| 10,000 zat with the right memo, plus a transparent output in the same tx | [`bb8d8842…`](https://testnet.zcashexplorer.app/transactions/bb8d88426b96a4cd92ec90446d154de5321da7b2bb863d9249a43838e49a82ec) | 402 `TRANSPARENT_PART` |
| payslip: employer pays 50,000 zat, memo `payslip 2026-10 #7: net 0.0005 TAZ`; a lender checks with the employee's key | [`38958ceb…`](https://testnet.zcashexplorer.app/transactions/38958ceb0ce952ccf6c11003258072dc8ea97f4f6408dc11c2515aeb126b5869) (block 4,522,626) | ok; claiming twice the pay → `AMOUNT_TOO_LOW`; the merchant's key → `NO_OUTPUT_TO_KEY` |
| funding of the demo payer (5 notes) | [`a2c0578b…`](https://testnet.zcashexplorer.app/transactions/a2c0578b58c7c76d989f60292dd445f364fc40e40d1c21f89fc48ece7dfb57d3) | — |

Third-party payments, no new transaction:

| Payment | Key | Result |
|---|---|---|
| zec-shielded-x402 demo payment [`030c3cbf…8351`](https://testnet.zcashexplorer.app/transactions/030c3cbf78ce8460553bba4e82c0ba813f039bd3ecf4d7f2e81c59837dc28351) | x402 merchant's published UIVK | ok, 100,000 zat, memo `x402z-f19a63da20cbc0749ea800b3` |
| sealed-bid auction deposit [`06d12181…0af1`](https://testnet.zcashexplorer.app/transactions/06d121813387444ca3ecc9720e73160b5b80645d9204c6c411e51cef3a190af1) | x402 key / auction's key | `NO_OUTPUT_TO_KEY` / ok |
| null-402 `settle()` on Fuji [`0x8596f52d…a593`](https://testnet.snowtrace.io/tx/0x8596f52de2d8c15680c96a0fa25b1bb5073324155f586203507cddf92f5ca593) | verifier [`0x0b44836d…6060`](https://testnet.snowtrace.io/address/0x0b44836dDc460f589ce4EB97f276e533A2bE6060), pool [`0x39a9C4Ef…cA1C`](https://testnet.snowtrace.io/address/0x39a9C4EfabEBA954545Ecb4b16Ba1d92ec46cA1C) | proof valid, root known, `NULLIFIER_SPENT`; 10× the amount → `BAD_PROOF` |

No contracts are deployed by this project.

## Packages

| Package | What |
|---|---|
| [`packages/core`](packages/core) | `zpay-verify` Rust crate + CLI: fetch, recompute the txid, trial-decrypt Sapling/Orchard/Ironwood with a UIVK, rules with reason codes, exit 0/1/2 |
| [`packages/sdk`](packages/sdk) | `@zpv/sdk`: `verify()` with the `zcash` and `null402` rails, `proofFromSettleTx`; `@zpv/sdk/null402` runs in the browser |
| [`packages/gateway`](packages/gateway) | x402 paywall (memo nonce, ZIP-321 URI, single-use memo and txid) + `POST /api/verify` |
| [`packages/mcp`](packages/mcp) | `zpv-mcp`: `verify_zcash_payment`, `verify_null402_settlement` (read-only; merchant key from the environment) |
| [`packages/examples`](packages/examples) | `run-live` (the table above) and `demo` (the video) |
| [`packages/dashboard`](packages/dashboard) | "Was I paid?": verdict stamp, reasons, decrypted outputs, provenance |
| [`packages/docs`](packages/docs) | rules, do X → see Y, trust model, API, the null-402 key mismatch finding |
| [`packages/landing`](packages/landing) | one-page landing |

## Run it

Needs Node 22+, pnpm 10, Rust 1.89 (pinned in `packages/core`).

```sh
pnpm install
pnpm test                          # builds zpay-verify + packages; 23 live tests + 1 doc example (TESTING.md)
pnpm --filter @zpv/gateway api &   # verify API for the dashboard
pnpm --filter @zpv/dashboard dev   # http://localhost:5180
scripts/clean-install.sh           # tarball + cargo install in an empty dir, verifies a real payment
```

Demo video: `zec-payment-verify-demo.mp4` (shared separately until hosted) (live re-checks of the run's transactions).

## Honest limits

- Testnet only. The checker trusts lightwalletd not to withhold or lag transactions; it recomputes
  every txid, so it cannot be handed a different transaction.
- A UIVK reveals every incoming payment to its wallet. The keys published here are demo-only.
- The paywall keeps memo nonces and used txids in memory.
- A null-402 proof that passes all three checks is not shown live: it needs null-402's pool operator
  to register a new root (`NULL402_OPERATOR_KEY`, not held). **BLOCKED** on that.
- Not published to npm or crates.io (needs the maintainer's npm and crates.io accounts); installable from the packed tarball.
- Portfolio piece; the Zecathon entry is Shielded x402.

MIT — Copyright (c) 2026 Nivesh Gajengi.
