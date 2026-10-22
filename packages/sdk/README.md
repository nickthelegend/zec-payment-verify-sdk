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

`ownsAddress(uivk, ua)` says whether each shielded receiver of a testnet unified address belongs to
the key (`zpay-verify owns`, offline). Check it before advertising an address.

`proofFromSettleTx(hash)` reads a real proof back out of a null-402 `settle()` on Fuji, with the
receipt's `status` (`success`, `reverted`, `pending`), the `recipient` and `amount` it paid, and
`blockNumber` (null while pending).

Two different questions about null-402:

- **Could this proof still be settled to me?** `verify({rail: 'null402', proof, publicSignals, expect})`.
  A proof read out of a mined settle() always answers `NULLIFIER_SPENT` here: it paid once already.
- **Was this mined settle() a payment to me?** `verifyNull402Settlement(hash, {payTo, requiredAmount, recipient, contextHash?})`.
  A reverted or pending settle() is never ok (`SETTLE_REVERTED`, `SETTLE_PENDING`, verdict
  `unsettled`). A successful one is `paid` when the proof is valid against a known root, its nullifier
  is spent, and the payee, amount and recipient (and context, when given) are yours; otherwise
  `refused` with `PAY_TO_MISMATCH` / `AMOUNT_MISMATCH` / `RECIPIENT_MISMATCH` / `CONTEXT_MISMATCH`, or
  `UNBOUND` without a payTo, amount and recipient. The recipient is required because the pool does
  not bind it: `settle()` pays whatever address its caller names (Null402Pool.sol leaves that binding
  off-chain), so a proof naming your payee and amount can be settled to someone else. It does not
  stop you counting one settlement twice: remember which settle hashes you accepted.
- Every signal and expected value must be a decimal uint256 string (1-78 digits, below 2^256) or a
  bigint; anything else, an empty string included, is a `VerifyError` before any RPC call.

**Cross-check.** One lightwalletd can withhold a transaction, lag, or forge one: the checker
recomputes the txid, requires it in the block the server names and verifies its proofs and
signatures, but not its anchors, the coins its transparent inputs spend, or the block's place in the
chain, so a server that proves over a fake tree and forges the block is believed. With `lwdUrls` (or
`ZPV_LWD_URLS`), `zpay-verify` runs once per endpoint, in parallel. The endpoints that have seen the
transaction's block must agree on everything the verdict rests on (found, height, block time,
outputs, pools, amount, reasons other than `NOT_CONFIRMED`); confirmations are counted at the lowest
tip. Lag is not disagreement: an endpoint whose tip is up to `CROSS_CHECK_MAX_LAG` (3) blocks below
the block another endpoint mined the transaction in, or that has not received a mempool transaction
yet, still answers for the quorum but is not compared (`lagging: true`), and the result is
`NOT_CONFIRMED` until it catches up. An endpoint at or past that block that does not have the
transaction, or one further behind, is a dissent. An endpoint that cannot be reached or queried does not count toward
`quorum` (default: all); one whose answer contradicts itself counts as a dissent. Two spellings of one
server (`https://testnet.zec.rocks` and `…:443`) are refused: endpoints are compared as
scheme://host:port. Any disagreement, or fewer answers than `quorum`, is `unverified`: never
`paid`, and the gateway answers it with 503 and serves nothing. Bad input and a missing binary still
throw. Public testnet indexers found on Oct 22, 2026: `testnet.zec.rocks` (lightwalletd) and
`zaino.testnet.unsafe.zec.rocks` (Zaino, same operator, different software; it answered 503 that day).
hosh.zec.rocks lists no other testnet server, so a truly independent second operator means running
your own lightwalletd or Zaino.

Setup: the `zcash` rail needs the `zpay-verify` binary (`ZPV_BIN`, or built in `packages/core`, or
`$CARGO_TARGET_DIR/release`). Missing → `Setup required: ZPV_BIN`.

**Errors.** Every failure to check throws; the class says what to do:

| Error | When |
|---|---|
| `VerifyError` | bad input: txid, key, `amountZat` not a whole number ≥ 0, `minConf`, memo over 512 bytes, unknown rail |
| `LightwalletdUnreachableError` | no connection, an RPC failure, a proxy that is down, or no answer within `ZPV_CHECK_TIMEOUT_MS` (default 90 s; the process is killed) |
| `LightwalletdBadAnswerError` | the server answered, but the answer contradicts itself (txid mismatch, unparseable bytes, a block that does not list the tx). In a cross-check it is a dissent: `UNVERIFIED_DISAGREEMENT` |
| `BusyError` | more than `ZPV_MAX_CHECKS` (default 8) `zpay-verify` processes running and `ZPV_MAX_QUEUE` (default 32) waiting in this process, or more than `ZPV_MAX_NULL402_CHECKS` (default 16) null-402 checks (4 Fuji RPC calls each) running and `ZPV_MAX_QUEUE` waiting. A server can give a surface its own `CheckLimiter` (`verify(req, {limiter})`), as the paywall does for its own checks |
| `SetupRequiredError` | missing binary, a malformed setting (`ZPV_LWD_PROXY`, `ZPV_LWD_QUORUM`, …), or a plaintext `http://` lightwalletd that is not loopback |

The three middle classes extend `VerifyError` (so existing `catch` blocks still see them); test for
them first.

The binary gets only the key, the lightwalletd URL, `ZPV_LWD_PROXY` and `ZPV_ALLOW_INSECURE_LWD`.

**What a lightwalletd learns.** Each check asks the server for one txid (`GetTransaction`) and its
block. The operator learns that this txid matters to you, when you asked, and your IP address, which
links that payment to you. A cross-check tells every endpoint. `ZPV_LWD_PROXY=socks5h://127.0.0.1:9050`
(Tor) hides the IP; the txid and the timing are still seen. Fetching compact blocks instead would hide
the txid, but they carry no memo, and the memo is what ties a payment to an invoice.

Tests (`pnpm test`): `verify.test.ts` (12, 11 live): the published x402 payment verifies (with the
time of the block that lists it); wrong memo, higher amount, someone else's payment and an unknown txid
are refused; bad input and a missing binary throw; a real settled null-402 proof is valid on the
deployed verifier with a known root and is refused as a replay; tampered nullifier/amount fail the
verifier; wrong merchant expectations are refused; without an expected payTo and amount → `UNBOUND`.
`crosscheck.test.ts` (6, 5 live): two agreeing answers meet a quorum of 2 with a third endpoint dead
→ paid; one answer for a quorum of 2 → unverified; testnet.zec.rocks vs a real mainnet lightwalletd
that lacks the transaction → unverified at quorum 1 and 2; agreeing refusals stay refused; the two
public testnet indexers → paid only if both answer and agree; the env settings and bad settings
(offline). The "two agreeing answers" are two real fetches from testnet.zec.rocks given to the
cross-check rule (`crossCheckVerdict`), labelled so in the test: they exercise the quorum logic, not
operator independence (verify() refuses one server under two spellings).
`verify.test.ts` also covers settlements (4 more, all live): a settle's receipt status, recipient and
amount; both real settle() calls on the pool are `paid` to their merchant, and another recipient or
amount, or no binding, is not; a reverted or pending status is never ok (the rule, on the real proof
check: there is no real reverted settle() on the pool, Routescan lists 7 transactions, all status 1);
an unknown hash is an error.
`hardening.test.ts` (7, 2 live): bad amounts, minConf, memo, rail and a non-object are `VerifyError`;
two spellings of one endpoint are refused; `ZPV_LWD_PROXY` reaches the binary (a dead proxy is an
error, never a direct check); a plaintext remote URL is Setup required; a silent server is killed
after `ZPV_CHECK_TIMEOUT_MS`; 40 checks at once with `ZPV_MAX_CHECKS=3`, `ZPV_MAX_QUEUE=5` → never more
than 3 processes, 32 `BusyError`; an endpoint whose answer contradicts itself makes the cross-check
unverified, naming it.

Not covered live: a null402 proof that passes all three checks. That needs a fresh deposit whose root
null-402's pool operator registers (`NULL402_OPERATOR_KEY`, not held here) and a prover key matching
the deployed verifier (not published, see below). **BLOCKED** on those.

Finding: the circuit files in null-402's dashboard (`null-402-dashboard/public/circuit/`, vk sha256
`529671e8…`) are from a different setup than the deployed verifier (whose constants match
`null-402-contracts/src/Groth16Verifier.sol`). A real settled proof verifies against the Solidity
constants and fails against the dashboard's key, so proofs made with those files fail on Fuji.
