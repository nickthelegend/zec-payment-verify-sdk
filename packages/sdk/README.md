# @zpv/sdk

One `verify()` for two payment rails. Every result comes from a live check and carries its
provenance; a failure to check throws (`VerifyError`, `SetupRequiredError`), it is never a verdict.

```ts
import { verify } from '@zpv/sdk';

// Zcash: a shielded payment, checked with the receiver's incoming viewing key
const z = await verify({ rail: 'zcash', uivk, txid, amountZat: 100_000, memo: 'inv-42', minConf: 1 });
// → { ok, verdict: 'paid' | 'refused', reasons, paidZat, report: { height, confirmations, outputs, pools }, provenance: { lightwalletd, tip } }

// Zcash, cross-checked against several lightwalletd endpoints (or set ZPV_LWD_URLS / ZPV_LWD_QUORUM)
const x = await verify({ rail: 'zcash', uivk, txid, amountZat: 100_000, memo: 'inv-42' }, { lwdUrls: [a, b, c], quorum: 2 });
// → verdict 'unverified' (ok false, report null, reasons UNVERIFIED_DISAGREEMENT / UNVERIFIED_QUORUM)
//   unless at least 2 answered and every answer agreed; crossCheck lists what each endpoint said

// null-402: a Groth16 payment proof, checked against the contracts null-402 deployed on Avalanche Fuji
const n = await verify({ rail: 'null402', proof, publicSignals, expect: { payTo, requiredAmount, contextHash } });
// → { ok, reasons, checks: { proofValid, rootKnown, nullifierSpent }, provenance: { rpc, verifier, pool, blockNumber } }
```

| Rail | How | Reasons |
|---|---|---|
| `zcash` | runs `zpay-verify` (packages/core) with the key in its environment; lightwalletd `ZPV_LWD_URL` (default testnet.zec.rocks) | `TX_NOT_FOUND`, `NO_OUTPUT_TO_KEY`, `MEMO_MISMATCH`, `AMOUNT_TOO_LOW`, `NOT_CONFIRMED`, `TRANSPARENT_PART` |
| `null402` | read-only `eth_call`s on Fuji: `verifier.verifyProof`, `pool.knownRoot(root)`, `pool.spent(nullifier)` (no key, no gas) | `BAD_PROOF`, `ROOT_UNKNOWN`, `NULLIFIER_SPENT`, `PAY_TO_MISMATCH`, `AMOUNT_MISMATCH`, `CONTEXT_MISMATCH` |

`proofFromSettleTx(hash)` reads a real proof back out of a null-402 `settle()` on Fuji.

**Cross-check.** One lightwalletd can withhold a transaction or lag. With `lwdUrls` (or
`ZPV_LWD_URLS`), `zpay-verify` runs once per endpoint, in parallel. The answers must agree on the
verdict and on everything it rests on (found, height, outputs, pools, reasons, amount); tips and
confirmation counts may differ. An endpoint that cannot be reached or queried does not count toward
`quorum` (default: all). Any disagreement, or fewer answers than `quorum`, is `unverified`: never
`paid`, and the gateway answers it with 503 and serves nothing. Bad input and a missing binary still
throw. Public testnet indexers found on Oct 22, 2026: `testnet.zec.rocks` (lightwalletd) and
`zaino.testnet.unsafe.zec.rocks` (Zaino, same operator, different software; it answered 503 that day).
hosh.zec.rocks lists no other testnet server, so a truly independent second operator means running
your own lightwalletd or Zaino.

Setup: the `zcash` rail needs the `zpay-verify` binary (`ZPV_BIN`, or built in `packages/core`, or
`$CARGO_TARGET_DIR/release`). Missing → `Setup required: ZPV_BIN`.

Tests (`pnpm test`): `verify.test.ts` (8, 7 live): the published x402 payment verifies; wrong memo, higher amount,
someone else's payment and an unknown txid are refused; bad input and a missing binary throw; a real
settled null-402 proof is valid on the deployed verifier with a known root and is refused as a
replay; tampered nullifier/amount fail the verifier; wrong merchant expectations are refused; without an expected payTo and amount → `UNBOUND`.
`crosscheck.test.ts` (6, 5 live): two agreeing answers meet a quorum of 2 with a third endpoint dead
→ paid; one answer for a quorum of 2 → unverified; testnet.zec.rocks vs a real mainnet lightwalletd
that lacks the transaction → unverified at quorum 1 and 2; agreeing refusals stay refused; the two
public testnet indexers → paid only if both answer and agree; the env settings and bad settings
(offline). The "two agreeing answers" are the same server under two URLs, labelled so in the test:
it exercises the quorum logic, not operator independence.

Not covered live: a null402 proof that passes all three checks. That needs a fresh deposit whose root
null-402's pool operator registers (`NULL402_OPERATOR_KEY`, not held here) and a prover key matching
the deployed verifier (not published, see below). **BLOCKED** on those.

Finding: the circuit files in null-402's dashboard (`null-402-dashboard/public/circuit/`, vk sha256
`529671e8…`) are from a different setup than the deployed verifier (whose constants match
`null-402-contracts/src/Groth16Verifier.sol`). A real settled proof verifies against the Solidity
constants and fails against the dashboard's key, so proofs made with those files fail on Fuji.
