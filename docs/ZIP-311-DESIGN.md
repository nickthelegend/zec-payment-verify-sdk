# ZIP 311 payment disclosures: design note (not built)

The Oct 21 review's bold idea was "I paid you" without the receiver's viewing key: the payer proves
one output (value, recipient, memo) to a third party, so a lender or an arbiter can check one payment
while the receiver's history stays private. ZIP 311 ("Zcash Payment Disclosures") is the spec for
that. This note records why it is not built in pass 2 and what building it would take.

## Where ZIP 311 stands (read Oct 22, 2026, https://zips.z.cash/zip-0311)

- **Status: Draft.** No reference implementation ("TBD").
- **Sapling only.** The spec says "TODO: Add support for Orchard." Hanko's own payments are in the
  Ironwood pool (NU7; see `fixtures/testnet.json`), and the x402 merchant payment it checks is
  Ironwood too. Neither Orchard nor Ironwood is covered.
- **No wire format.** "TODO: Define encodings for unsigned and signed payment disclosures" and
  "TODO: Decide on payment disclosure versioning." Anything built now would be a private format
  that no wallet produces and nothing else verifies.
- Transparent inputs: the BIP 322 signing and verification steps are TODO.
- librustzcash has no ZIP 311 code. `zcash_primitives` mentions only that the Sapling
  `OutgoingCipherKey` "will eventually be used to implement Sapling payment disclosures".

So the condition for building it ("only if the ZIP is final enough and a Rust/TS implementation path
exists") is not met: the ZIP is a draft without the pools Hanko uses and without an encoding.

## What could be built instead, and why it is not a payment disclosure

The primitive exists: `zcash_note_encryption::try_output_recovery_with_ock` decrypts one output
from its outgoing cipher key (`ock`), with no viewing key at all. A "single-output disclosure"
`{txid, pool, action index, ock}` would let Hanko show that output's value, recipient and memo,
after recomputing the txid as it does today (note decryption also checks the note commitment).

It falls short of ZIP 311 in two ways that matter to an arbiter:

1. **No proof of who paid.** ZIP 311 adds a spend authorization signature over a message, so the
   disclosure says "the holder of this spend key paid". An `ock` only shows what the output contains.
   Whoever made the transaction can derive it, and so can anyone they give the outgoing viewing key to.
2. **The wallet does not export an `ock`.** zingo-cli, the wallet used for this project's payments,
   has no command that exports a single output's `ock`. A demo would need the payer to run custom
   code against their own spending material, which this project does not hold and must not touch.

## If ZIP 311 is finalised

The input fits the SDK as a second key shape next to `uivk`:

```ts
verify({ rail: 'zcash', disclosure: '<encoded ZIP 311 disclosure>', amountZat, memo })
// → the same rules and reasons (MEMO_MISMATCH, AMOUNT_TOO_LOW, NOT_CONFIRMED, TRANSPARENT_PART)
//   plus DISCLOSURE_SIGNATURE_INVALID and DISCLOSURE_MESSAGE_MISMATCH
```

In `packages/core`, decode the disclosure, fetch the transaction (cross-checked like any other
check), recover the disclosed output with the `ock`, verify the spend authorization signature
against the transaction's `rk` for that spend, then apply the existing rules. To revisit once
Orchard/Ironwood support and an encoding land in the ZIP, or when librustzcash ships a
payment-disclosure type.
