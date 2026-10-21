# Hanko (zec-payment-verify-sdk) — submission draft (portfolio; DO NOT SUBMIT)

Zecathon allows one entry per team, and that entry is Shielded x402. This is a portfolio piece (it
would fit Core & Tooling). Every fact below is verified in this repo.

**Name:** zpay-verify — Zcash payment verify SDK
**One line:** "Was I paid?" for shielded Zcash: check amount, memo, confirmations and no transparent part with only an incoming viewing key; the same call checks null-402 proofs on Fuji.
**Repo:** github.com/nickthelegend/zec-payment-verify-sdk (public before submission)
**Video:** a demo video from Oct 20 exists but is not hosted publicly yet

## What it does
A Rust crate + CLI (`zpay-verify`), a TypeScript SDK (`@zpv/sdk`, one `verify()` for two rails), a
reference x402 paywall, an MCP server and a dashboard. The Zcash rail fetches the transaction from
lightwalletd, recomputes its txid, trial-decrypts Sapling/Orchard/Ironwood outputs with the
receiver's UIVK and applies explicit rules with reason codes.

## Proof it works
- Live testnet run: see README "Live on Zcash testnet" (paywall 200, refused wrong memo / underpaid / transparent output, payslip).
- Third-party payments checked: the published x402 payment `030c3cbf…8351`; a real null-402 settle on Fuji `0x8596f52d…a593`.
- 27 tests + 1 doc example, 0 skipped, on Oct 21, 2026 (TESTING.md). 17 touch a chain (Zcash testnet
  through lightwalletd, or Fuji); 10 are offline on purpose (rules, bad input, challenge cap, …).
- Paywall hardening with attack tests: one payment cannot be served to two concurrent requests;
  open challenges are capped; a null-402 check is never ok without an expected payee and amount.

## Pre-existing work (disclosure)
The decryption core is extracted from zec-shielded-x402's `check_uivk` (same author). x402 and
Payroll are not modified. Built Oct 20, 2026.

## Limits
Testnet only; trusts lightwalletd not to withhold transactions; in-memory paywall state; a fully
passing null-402 check is BLOCKED on null-402's operator key; packages are not published to npm or
crates.io (needs the maintainer's npm and crates.io accounts).
