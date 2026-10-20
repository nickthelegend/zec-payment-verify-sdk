# zec-payment-verify-sdk

> Shielded Payment-Verify SDK (Zcash, extracted from x402) — portfolio

**Status: scaffold only — nothing built or deployed yet.** Spec: `grokbot/specs/zec-payment-verify-sdk.md`. Intended repo: `nickthelegend/zec-payment-verify-sdk` (not created).

## Packages
| Package | Role |
|---|---|
| [`packages/core`](./packages/core) | Rust crate `zpay-verify`: verify a shielded payment by UIVK + memo + amount + confirmations (extracted from x402) |
| [`packages/sdk`](./packages/sdk) | TS package: one `verify()` interface with backends `zcash` (UIVK via lightwalletd) and `null402` (Groth16 proof via eth_call to the deployed Fuji verifier) |
| [`packages/gateway`](./packages/gateway) | Reference x402 middleware (Hono) using the SDK — pick rail per request |
| [`packages/mcp`](./packages/mcp) | MCP tool `verify_payment` for agents/merchants |
| [`packages/examples`](./packages/examples) | x402 paywall (Zcash), payroll payslip check (real payroll txids), null-402 rail |
| [`packages/dashboard`](./packages/dashboard) | Paste txid/proof → verdict with provenance |
| [`packages/docs`](./packages/docs) | API reference |
| [`packages/landing`](./packages/landing) | Landing |

## Live testnet deployment
_None yet._ No new contracts. References: x402 demo tx cd64980a… (block 4521440), payroll txids; null-402 Fuji verifier 0x0b44836dDc460f589ce4EB97f276e533A2bE6060 (read-only).

## Run the whole thing
_To be written once packages exist._

## Tests — real testnet, no mocked clients
| Package | Network | What | Result |
|---|---|---|---|
| core | live testnet | right memo/amount pass; wrong memo/amount/transparent receiver fail on real txs | not run yet |
| sdk zcash | live testnet | same via TS | not run yet |
| sdk null402 | live Fuji eth_call | real proof valid; tampered nullifier false | not run yet |
| install | clean env | npm/cargo install from tarball works | not run yet |

MIT — Copyright (c) 2026 Nivesh Gajengi.
