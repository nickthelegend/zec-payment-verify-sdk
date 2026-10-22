# Hanko (zpay-verify) — submission draft (portfolio; DO NOT SUBMIT)

Zecathon allows one entry per team, and that entry is Shielded x402. This is a portfolio piece (it
would fit Core & Tooling). Every fact below is verified in this repo.

**Name:** Hanko (zpay-verify)
**One line:** "Was I paid?" for shielded Zcash: check amount, memo, confirmations and no transparent part with only an incoming viewing key; the same call checks null-402 settlements on Fuji.
**Repo:** github.com/nickthelegend/zec-payment-verify-sdk (not pushed yet; public before submission)
**Demo URL:** https://nickthelegend.github.io/zec-payment-verify-sdk/ (landing) and https://nickthelegend.github.io/zec-payment-verify-sdk/dashboard/ (console). `.github/workflows/pages.yml` publishes both on the first push to `main`, once Pages is enabled (Settings → Pages → GitHub Actions). Not live before that. The console's null-402 tab runs in the browser against Fuji; its Zcash tab needs a local verify API and says Setup required without one (no hosted API).
**Video URL:** not recorded for this version. Planned: about 2 minutes against `e2e/stack.sh` with captions saying what is replayed from the Oct 20 run and what is live; Nick records and uploads it. The Oct 20 27-second terminal capture predates the console, landing, cross-check and SQLite store, so it is not submitted.

## Description (for the form, 1,561 characters)

<!-- description:start -->
Hanko answers "was I paid?" for shielded Zcash with only the receiver's incoming viewing key, which sees payments arrive and can never spend. Give it a txid, an amount and an invoice memo. It fetches the transaction from lightwalletd, recomputes the txid, requires it in the block the server names, trial-decrypts the Sapling, Orchard and Ironwood outputs, and answers paid or refused with reason codes.

Real: a Rust crate and CLI, a TypeScript SDK, an x402 paywall that speaks Shielded x402's v1 wire format (stateless HMAC memos, single-use payments, mined-time expiry, refunds recorded), an MCP server for agents (single-use with a store), a console and an API-reference landing. Every check in the tests is live on Zcash testnet or Avalanche Fuji against real mined transactions: 81 tests (40 touch a chain) and 56 browser tests in Chrome. A live run on Oct 20 paid the paywall and had wrong-memo, underpaid and transparent payments refused.

Mock: none. Where a test needs a misbehaving server it uses a real local socket: a closed port, a silent server, a SOCKS5 proxy.

Not built: ZIP 311 payment disclosures (the ZIP is a draft); a hosted Zcash verify API; proof and signature checks, so a lying lightwalletd can forge a paid answer (use your own node, or several independent ones). Each check tells the lightwalletd which txid you care about and your IP; Tor through ZPV_LWD_PROXY hides the IP.

BLOCKED: a null-402 proof that passes every check live (needs null-402's operator key); publishing to npm and crates.io (needs the maintainer's accounts).
<!-- description:end -->

## What it does
A Rust crate + CLI (`zpay-verify`), a TypeScript SDK (`@zpv/sdk`, one `verify()` for two rails), an
x402 paywall wire-compatible with Shielded x402, an MCP server and a console. The Zcash rail fetches
the transaction from lightwalletd, recomputes its txid, requires it in the compact block at the
reported height, trial-decrypts Sapling/Orchard/Ironwood outputs with the receiver's UIVK and applies
explicit rules with reason codes.

## Proof it works
- Live testnet run: see README "Live on Zcash testnet" (paywall 200, refused wrong memo / underpaid / transparent output, payslip).
- Third-party payments checked: the published x402 payment `030c3cbf…8351`; both real null-402 `settle()` calls on Fuji (`0x8596f52d…a593`, `0xd91c0ab7…1e5c`), each `paid` to its merchant when bound.
- 81 tests + 1 doc example, 0 skipped, on Oct 22, 2026 (TESTING.md). 40 touch a chain (Zcash testnet
  through lightwalletd, or Fuji); 41 are offline on purpose (rules, bad input, status codes, limits, …).
- 56 browser tests in Google Chrome against the real stack (desktop and 375 px), 2 skipped by design.
- Attack tests: one payment served once under concurrency and across processes; 10,000 GETs do not
  lock buyers out; forged memos refused before any check; 150 concurrent checks start at most
  `ZPV_MAX_CHECKS` processes; a dead Tor proxy never falls back to a direct connection; a replayed
  payment to the MCP tool is `ALREADY_USED` with a store.
- Shielded x402's own `X-PAYMENT` envelope pays the paywall for the published paywall payment (live test).

## Pre-existing work (disclosure)
The decryption core is extracted from zec-shielded-x402's `check_uivk` (same author). x402 and
Payroll are not modified. Built Oct 20, 2026; hardened Oct 21–22.

## Limits
- Each check tells the lightwalletd which txid you care about, when, and your IP; a cross-check tells
  every endpoint. `ZPV_LWD_PROXY` (Tor) hides the IP only.
- Proofs and signatures are not checked: a lying or intercepted lightwalletd can forge a paid answer.
  Plaintext is refused unless loopback; the cross-check needs independent endpoints, and the two public
  testnet indexers have one operator.
- Testnet only; SQLite state is per machine; refunds are recorded, not sent; ZIP 311 disclosures not
  built (the ZIP is a draft); a fully passing null-402 proof check is BLOCKED on null-402's operator
  key; packages are not published to npm or crates.io (needs the maintainer's npm and crates.io accounts).
