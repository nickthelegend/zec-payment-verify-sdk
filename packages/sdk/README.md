# @zpv/sdk

One `verify()` for two payment rails. Every result comes from a live check and carries its
provenance; a failure to check throws (`VerifyError`, `SetupRequiredError`), it is never a verdict.

```ts
import { verify } from '@zpv/sdk';

// Zcash: a shielded payment, checked with the receiver's incoming viewing key
const z = await verify({ rail: 'zcash', uivk, txid, amountZat: 100_000, memo: 'inv-42', minConf: 1 });
// → { ok, reasons, paidZat, report: { height, confirmations, outputs, pools }, provenance: { lightwalletd, tip } }

// null-402: a Groth16 payment proof, checked against the contracts null-402 deployed on Avalanche Fuji
const n = await verify({ rail: 'null402', proof, publicSignals, expect: { payTo, requiredAmount, contextHash } });
// → { ok, reasons, checks: { proofValid, rootKnown, nullifierSpent }, provenance: { rpc, verifier, pool, blockNumber } }
```

| Rail | How | Reasons |
|---|---|---|
| `zcash` | runs `zpay-verify` (packages/core) with the key in its environment; lightwalletd `ZPV_LWD_URL` (default testnet.zec.rocks) | `TX_NOT_FOUND`, `NO_OUTPUT_TO_KEY`, `MEMO_MISMATCH`, `AMOUNT_TOO_LOW`, `NOT_CONFIRMED`, `TRANSPARENT_PART` |
| `null402` | read-only `eth_call`s on Fuji: `verifier.verifyProof`, `pool.knownRoot(root)`, `pool.spent(nullifier)` (no key, no gas) | `BAD_PROOF`, `ROOT_UNKNOWN`, `NULLIFIER_SPENT`, `PAY_TO_MISMATCH`, `AMOUNT_MISMATCH`, `CONTEXT_MISMATCH` |

`proofFromSettleTx(hash)` reads a real proof back out of a null-402 `settle()` on Fuji.

Setup: the `zcash` rail needs the `zpay-verify` binary (`ZPV_BIN`, or built in `packages/core`, or
`$CARGO_TARGET_DIR/release`). Missing → `Setup required: ZPV_BIN`.

Tests (`pnpm test`, 7, all live): the published x402 payment verifies; wrong memo, higher amount,
someone else's payment and an unknown txid are refused; bad input and a missing binary throw; a real
settled null-402 proof is valid on the deployed verifier with a known root and is refused as a
replay; tampered nullifier/amount fail the verifier; wrong merchant expectations are refused.

Not covered live: a null402 proof that passes all three checks. That needs a fresh deposit whose root
null-402's pool operator registers (`NULL402_OPERATOR_KEY`, not held here) and a prover key matching
the deployed verifier (not published, see below). **BLOCKED** on those.

Finding: the circuit files in null-402's dashboard (`null-402-dashboard/public/circuit/`, vk sha256
`529671e8…`) are from a different setup than the deployed verifier (whose constants match
`null-402-contracts/src/Groth16Verifier.sol`). A real settled proof verifies against the Solidity
constants and fails against the dashboard's key, so proofs made with those files fail on Fuji.
