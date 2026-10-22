# Hanko (zpay-verify) — submission draft (portfolio; DO NOT SUBMIT)

Zecathon allows one entry per team, and that entry is Shielded x402. This is a portfolio piece (it
would fit Core & Tooling). Every fact below is verified in this repo.

**Name:** Hanko (zpay-verify)
**One line:** "Was I paid?" for shielded Zcash: check amount, memo, confirmations and no transparent part with only an incoming viewing key; the same call checks null-402 settlements on Fuji.
**Repo:** github.com/nickthelegend/zec-payment-verify-sdk (not pushed yet; public before submission)
**Demo URL:** https://nickthelegend.github.io/zec-payment-verify-sdk/ (landing) and https://nickthelegend.github.io/zec-payment-verify-sdk/dashboard/ (console). `.github/workflows/pages.yml` publishes both on the first push to `main`, once Pages is enabled (Settings → Pages → GitHub Actions). Not live before that. The console opens on its null-402 tab, which runs in the browser against Fuji; its Zcash tab needs a verify API on the reader's machine and, without one, shows Setup required with the exact command beside real answers recorded on Oct 22, labelled "Recorded output, not live" (no hosted API).
**Video URL:** not recorded for this version. Planned: about 2 minutes against `e2e/stack.sh` with captions saying what replays the Oct 20 run and what is live (the Oct 22 unpinned paywall payment is the live paywall case); Nick records and uploads it. The Oct 20 27-second terminal capture predates the console, landing, cross-check and SQLite store, so it is not submitted.

## Description (for the form, 1,512 characters)

<!-- description:start -->
Hanko answers "was I paid?" for shielded Zcash with only the receiver's incoming viewing key, which sees payments arrive and can never spend. Give it a txid, an amount and an invoice memo. It fetches the transaction from lightwalletd, recomputes the txid, requires it in the block the server names, verifies its proofs and signatures, trial-decrypts the Sapling, Orchard and Ironwood outputs, and answers paid or refused with reason codes.

Real: a Rust crate and CLI, a TypeScript SDK, an x402 paywall in Shielded x402's v1 wire format, tested with Shielded x402's own client (stateless HMAC memos, single-use payments, mined-time expiry, refunds recorded), an MCP server for agents, a console and a landing. 49 of 104 tests hit Zcash testnet or Avalanche Fuji with real mined transactions; the rest are offline on purpose. 62 browser tests in Chrome. On Oct 22 a fresh payment to the unpinned paywall was served once, then refused on replay.

Mock: none. A misbehaving server is a real local socket. Most paywall tests replay the Oct 20 payment via a pinned memo.

Not built: ZIP 311 disclosures (draft ZIP); a hosted Zcash verify API; anchor and chain checks, so a lying lightwalletd that proves over a fake tree can still forge a paid answer (use your own node). Each check tells the lightwalletd the txid and your IP; ZPV_LWD_PROXY (Tor) hides the IP.

BLOCKED: a null-402 proof that passes every check live (needs null-402's operator key); publishing to npm and crates.io (needs the maintainer's accounts).
<!-- description:end -->

## What it does
A Rust crate + CLI (`zpay-verify`), a TypeScript SDK (`@zpv/sdk`, one `verify()` for two rails), an
x402 paywall in Shielded x402's v1 wire format (tested with Shielded x402's own client module), an
MCP server and a console. The Zcash rail fetches the transaction from lightwalletd, recomputes its
txid, requires it in the compact block at the reported height, verifies every proof and signature
against the recomputed signature hash, trial-decrypts Sapling/Orchard/Ironwood outputs with the
receiver's UIVK and applies explicit rules with reason codes.

## Proof it works
- Current code, live: one fresh payment to the unpinned paywall on Oct 22 (`2867d542…664f`, block 4,530,239): stateless HMAC memo, presented with Shielded x402's `fetchWithPayment`, 200, replay 402.
- Oct 20 testnet run: see README "Live on Zcash testnet" (paywall 200, refused wrong memo / underpaid / transparent output, payslip).
- Third-party payments checked: the published x402 payment `030c3cbf…8351`; both real null-402 `settle()` calls on Fuji (`0x8596f52d…a593`, `0xd91c0ab7…1e5c`), each `paid` to its merchant when bound.
- 104 tests + 1 doc example, 0 skipped, on Oct 23, 2026 (TESTING.md). 49 touch a chain (Zcash testnet
  through lightwalletd, or Fuji); 55 are offline on purpose (rules, bad input, status codes, limits, …).
- 62 browser tests in Google Chrome against the real stack (desktop and 375 px), 2 skipped by design.
- Attack tests: one payment served once under concurrency and across processes; 10,000 GETs do not
  lock buyers out; forged memos refused before any check; 150 concurrent checks start at most
  `ZPV_MAX_CHECKS` processes; a dead Tor proxy never falls back to a direct connection; a replayed
  payment to the MCP tool is `ALREADY_USED` with a store.
- Shielded x402's own client module (`parsePaymentRequired`, `fetchWithPayment`) parses the 402 and pays the paywall with the published paywall payment (live test), and paid it live once with a fresh payment.
- A note re-encrypted at ten times its value is refused by the proof and signature checks (live test on the real x402 payment).

## Pre-existing work (disclosure)
The decryption core is extracted from zec-shielded-x402's `check_uivk` (same author). x402 and
Payroll are not modified. Built Oct 20, 2026; hardened Oct 21–22.

## Limits
- Each check tells the lightwalletd which txid you care about, when, and your IP; a cross-check tells
  every endpoint. `ZPV_LWD_PROXY` (Tor) hides the IP only.
- Proofs and signatures are checked; anchors (note commitment tree roots), the coins transparent
  inputs spend and the block's place in the chain are not, so a lying lightwalletd that runs a prover
  over a fake tree can still forge a paid answer. Plaintext is refused unless loopback; the cross-check needs independent endpoints, and the two public
  testnet indexers have one operator.
- Testnet only; SQLite state is per machine; refunds are recorded, not sent; ZIP 311 disclosures not
  built (the ZIP is a draft); a fully passing null-402 proof check is BLOCKED on null-402's operator
  key; packages are not published to npm or crates.io (needs the maintainer's npm and crates.io accounts).
