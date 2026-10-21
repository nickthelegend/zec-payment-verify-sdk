# Hanko: API, rules and trust

## The question it answers

"Did transaction X pay me at least N, with memo M, deep enough, without exposing anything?" A
merchant, a payroll auditor or an agent asks it before delivering. The answer needs only the
receiver's **incoming viewing key** (UIVK). That key sees payments coming in; it cannot spend, and it
cannot see spends or change.

## Do X → see Y

| Do | See |
|---|---|
| `ZPV_UIVK=<x402 merchant key> zpay-verify verify 030c3cbf…8351 --amount 100000 --memo x402z-f19a63da20cbc0749ea800b3` | `"ok":true`, `paid_zat 100000`, Ironwood output, block 4,521,112; exit 0 |
| the same with `--memo x402z-other` | `MEMO_MISMATCH, AMOUNT_TOO_LOW`; exit 1 |
| the same key on the auction deposit `06d12181…0af1` | `NO_OUTPUT_TO_KEY` (real tx, not ours) |
| `verify({rail: 'null402', …proofFromSettleTx('0x8596f52d…a593')})` | proof valid on the Fuji verifier, root known, `NULLIFIER_SPENT`, `UNBOUND` (no expectations given) |
| `GET /api/quote` on the gateway, pay the challenge, retry with `X-PAYMENT` | `402` → `200` with a receipt; the same txid is refused next time |
| dashboard, "Auction deposit, checked with the x402 key" | stamp "Not paid", the reason in words, provenance |

## Zcash rail: how a payment is checked

1. `GetTransaction(txid)` on lightwalletd; recompute the txid from the returned bytes and compare.
2. Parse with the consensus branch for its height (NU7 on testnet).
3. Trial-decrypt every Sapling output, Orchard action and Ironwood action with the UIVK.
4. Apply the rules:

| Rule | Reason |
|---|---|
| lightwalletd does not know the tx, or only on an orphaned fork | `TX_NOT_FOUND` |
| nothing decrypts to the key | `NO_OUTPUT_TO_KEY` |
| outputs to the key exist, none with the memo | `MEMO_MISMATCH` |
| outputs with the memo sum below the amount | `AMOUNT_TOO_LOW` |
| confirmations below `min_conf` (0 in the mempool) | `NOT_CONFIRMED` |
| any transparent input or output, unless allowed | `TRANSPARENT_PART` |

A key that does not parse, a malformed txid, an unreachable lightwalletd or a txid mismatch is an
**error** (exit 2, `VerifyError`), never a verdict.

## null402 rail

null-402 (Avalanche, same author) pays per API call with a Groth16 proof of an unspent note. The rail
makes three read-only `eth_call`s on Fuji at one block: `verifier.verifyProof(a, b, c, pub)`,
`pool.knownRoot(merkleRoot)` (else the proof could be about a made-up tree) and
`pool.spent(nullifier)` (else it is a replay). Merchant expectations: `payTo` and
`requiredAmount` (both needed for `ok`; without them the reason `UNBOUND` is added, because a valid,
unspent proof that pays someone else is not a payment to you) and optionally `contextHash`.

**Not shown live:** a proof that passes all three. It needs a new deposit whose root null-402's
operator registers (`NULL402_OPERATOR_KEY`) and the prover key that matches the deployed verifier.
Neither is available here. **BLOCKED** on those.

**Finding in null-402:** `null-402-dashboard/public/circuit/` (vk sha256 `529671e8…`) is from a
different setup than the deployed verifier, whose constants match
`null-402-contracts/src/Groth16Verifier.sol`. A real settled proof verifies against the Solidity
constants and fails against the dashboard key, so a proof made with those files fails on Fuji.

## Trust model

- The checker trusts lightwalletd to serve the chain honestly. The txid is recomputed, so it
  cannot swap transactions, but it could withhold one (`TX_NOT_FOUND`) or lag (fewer
  confirmations). Run your own lightwalletd/Zaino for stronger guarantees.
- A UIVK reveals every incoming payment to that wallet: amounts, memos and which of its addresses
  received each one. Give it only to whoever should see that. The demo keys in `fixtures/` and
  `deployments/` belong to demo-only testnet wallets and are published on purpose.
- The gateway keeps memo nonces and used txids in memory. A restart forgets them, so a production
  paywall needs a store.
- Testnet only. The binary decodes testnet keys only.

## API

- Rust: `zpay_verify::verify(lwd_url, uivk, txid, &Expect) -> Result<Verification, VerifyError>`,
  plus `inspect`, `check`, `uivk_from_ufvk`.
- TS: `verify(req, opts)` with `rail: 'zcash' | 'null402'`, plus `proofFromSettleTx`, `zpayBinary`
  and `NULL402_FUJI`. `@zpv/sdk/null402` is the browser-safe part.
- HTTP (gateway): `GET <paid path>` → 402; `X-PAYMENT: base64({memo, txid})`; `POST /api/verify`.
- MCP: `verify_zcash_payment`, `verify_null402_settlement`.

## Pre-existing work

The decryption core is extracted from zec-shielded-x402's `check_uivk` (same author, MIT; x402 itself
is not modified). The zingo-cli wrapper comes from zec-sealed-bid-auction. null-402's contracts are
used read-only.
