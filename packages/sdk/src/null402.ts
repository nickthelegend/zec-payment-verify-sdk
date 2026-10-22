// The null402 rail: a null-402 Groth16 payment proof checked against the contracts null-402 deployed
// on Avalanche Fuji, with read-only eth_calls (no key, no gas):
//   verifier.verifyProof(a, b, c, pubSignals)   the proof is valid for these public signals
//   pool.knownRoot(merkleRoot)                  the tree it proves against is a real pool tree
//   pool.spent(nullifier)                       the note has not paid already
import { createPublicClient, decodeFunctionData, http, toFunctionSelector, type Hex } from 'viem';
import { avalancheFuji } from 'viem/chains';
import { VerifyError } from './errors.js';

export const NULL402_FUJI = {
  chainId: 43113,
  rpc: 'https://api.avax-test.network/ext/bc/C/rpc',
  verifier: '0x0b44836dDc460f589ce4EB97f276e533A2bE6060',
  pool: '0x39a9C4EfabEBA954545Ecb4b16Ba1d92ec46cA1C',
  explorer: 'https://testnet.snowtrace.io',
} as const;

/** snarkjs proof JSON. */
export interface SnarkProof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}

export interface Null402Request {
  rail: 'null402';
  proof: SnarkProof;
  /** [nullifier, merkleRoot, payTo, requiredAmount, contextHash] as decimal strings */
  publicSignals: string[];
  /** What the merchant expects; each one given must match the proof's public signal. Without both
   *  `payTo` and `requiredAmount` nothing ties the proof to the caller, so the result is never ok
   *  (reason `UNBOUND`): a valid, unspent proof that pays someone else is not "paid". */
  expect?: { payTo?: string; requiredAmount?: string | bigint; contextHash?: string };
}

export interface Null402Result {
  rail: 'null402';
  ok: boolean;
  reasons: string[];
  checks: { proofValid: boolean; rootKnown: boolean; nullifierSpent: boolean };
  signals: { nullifier: string; merkleRoot: string; payTo: string; requiredAmount: string; contextHash: string };
  provenance: { rpc: string; chainId: number; verifier: string; pool: string; blockNumber: string; checkedAt: string };
}

const VERIFIER_ABI = [
  {
    type: 'function',
    name: 'verifyProof',
    stateMutability: 'view',
    inputs: [
      { name: '_pA', type: 'uint256[2]' },
      { name: '_pB', type: 'uint256[2][2]' },
      { name: '_pC', type: 'uint256[2]' },
      { name: '_pubSignals', type: 'uint256[5]' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

const POOL_ABI = [
  { type: 'function', name: 'knownRoot', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'spent', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'bool' }] },
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'a', type: 'uint256[2]' },
      { name: 'b', type: 'uint256[2][2]' },
      { name: 'c', type: 'uint256[2]' },
      { name: 'pubSignals', type: 'uint256[5]' },
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const SETTLE_SELECTOR = toFunctionSelector('settle(uint256[2],uint256[2][2],uint256[2],uint256[5],address,uint256)');

const client = (rpc: string) => createPublicClient({ chain: avalancheFuji, transport: http(rpc, { retryCount: 2, timeout: 20_000 }) });

/** Solidity calldata order: G2 coordinates are [c1, c0] (snarkjs stores [c0, c1]). */
export function solidityProof(p: SnarkProof) {
  const n = (x: string) => BigInt(x);
  return {
    a: [n(p.pi_a[0]), n(p.pi_a[1])] as const,
    b: [
      [n(p.pi_b[0][1]), n(p.pi_b[0][0])],
      [n(p.pi_b[1][1]), n(p.pi_b[1][0])],
    ] as const,
    c: [n(p.pi_c[0]), n(p.pi_c[1])] as const,
  };
}

const UINT256 = 1n << 256n;

/** A decimal uint256 (a string of 1-78 digits, or a bigint) as a bigint; anything else is a VerifyError
 *  naming `what`. An empty string is refused (BigInt('') would be 0 and match a zero signal). */
export function uint256(v: unknown, what: string): bigint {
  let x: bigint | undefined;
  if (typeof v === 'bigint') x = v;
  else if (typeof v === 'string' && /^\d{1,78}$/.test(v)) x = BigInt(v);
  if (x === undefined || x < 0n || x >= UINT256) {
    const shown = typeof v === 'bigint' ? v.toString() : (JSON.stringify(v) ?? String(v));
    throw new VerifyError(`${what} must be a decimal uint256 (1-78 digits, below 2^256), got ${shown.length > 90 ? `${shown.slice(0, 90)}…` : shown}`);
  }
  return x;
}

/** The merchant's expectations, checked before any RPC call. */
function expectations(e: { payTo?: unknown; requiredAmount?: unknown; contextHash?: unknown } | undefined) {
  if (e !== undefined && (typeof e !== 'object' || e === null || Array.isArray(e))) throw new VerifyError('expect must be an object {payTo, requiredAmount, contextHash?}');
  const o = e ?? {};
  return {
    payTo: o.payTo === undefined ? undefined : uint256(o.payTo, 'expect.payTo'),
    requiredAmount: o.requiredAmount === undefined ? undefined : uint256(o.requiredAmount, 'expect.requiredAmount'),
    contextHash: o.contextHash === undefined ? undefined : uint256(o.contextHash, 'expect.contextHash'),
  };
}

export async function verifyNull402(req: Null402Request, opts: { rpc?: string } = {}): Promise<Null402Result> {
  if (!Array.isArray(req.publicSignals) || req.publicSignals.length !== 5) throw new VerifyError('publicSignals must be the 5 null-402 signals [nullifier, merkleRoot, payTo, requiredAmount, contextHash]');
  const pub = req.publicSignals.map((s, i) => uint256(s, `publicSignals[${i}]`)) as unknown as readonly [bigint, bigint, bigint, bigint, bigint];
  const e = expectations(req.expect);
  let sol: ReturnType<typeof solidityProof>;
  try {
    const p = req.proof;
    if (typeof p !== 'object' || p === null) throw new Error();
    for (const [k, xs] of [['pi_a', p.pi_a], ['pi_c', p.pi_c]] as const) (xs ?? []).slice(0, 2).forEach((x, i) => uint256(x, `proof.${k}[${i}]`));
    (p.pi_b ?? []).slice(0, 2).forEach((row, i) => (row ?? []).slice(0, 2).forEach((x, j) => uint256(x, `proof.pi_b[${i}][${j}]`)));
    sol = solidityProof(p);
  } catch (err) {
    if (err instanceof VerifyError) throw err;
    throw new VerifyError('proof must be snarkjs JSON {pi_a, pi_b, pi_c} of decimal field elements');
  }
  const rpc = opts.rpc ?? (typeof process !== 'undefined' ? process.env?.ZPV_FUJI_RPC : undefined) ?? NULL402_FUJI.rpc;
  const c = client(rpc);
  const blockNumber = await c.getBlockNumber();
  const at = { blockNumber };
  const [proofValid, rootKnown, nullifierSpent] = await Promise.all([
    c.readContract({ address: NULL402_FUJI.verifier, abi: VERIFIER_ABI, functionName: 'verifyProof', args: [sol.a, sol.b, sol.c, pub], ...at }),
    c.readContract({ address: NULL402_FUJI.pool, abi: POOL_ABI, functionName: 'knownRoot', args: [pub[1]], ...at }),
    c.readContract({ address: NULL402_FUJI.pool, abi: POOL_ABI, functionName: 'spent', args: [pub[0]], ...at }),
  ]);
  const reasons: string[] = [];
  if (!proofValid) reasons.push('BAD_PROOF');
  if (!rootKnown) reasons.push('ROOT_UNKNOWN');
  if (nullifierSpent) reasons.push('NULLIFIER_SPENT');
  if (e.payTo !== undefined && e.payTo !== pub[2]) reasons.push('PAY_TO_MISMATCH');
  if (e.requiredAmount !== undefined && e.requiredAmount !== pub[3]) reasons.push('AMOUNT_MISMATCH');
  if (e.contextHash !== undefined && e.contextHash !== pub[4]) reasons.push('CONTEXT_MISMATCH');
  if (e.payTo === undefined || e.requiredAmount === undefined) reasons.push('UNBOUND');
  return {
    rail: 'null402',
    ok: reasons.length === 0,
    reasons,
    checks: { proofValid, rootKnown, nullifierSpent },
    signals: { nullifier: pub[0].toString(), merkleRoot: pub[1].toString(), payTo: pub[2].toString(), requiredAmount: pub[3].toString(), contextHash: pub[4].toString() },
    provenance: { rpc, chainId: NULL402_FUJI.chainId, verifier: NULL402_FUJI.verifier, pool: NULL402_FUJI.pool, blockNumber: blockNumber.toString(), checkedAt: new Date().toISOString() },
  };
}

/** Where a settle() transaction stands: mined and succeeded, mined and reverted, or not mined yet. */
export type SettleStatus = 'success' | 'reverted' | 'pending';

export interface SettleTx {
  proof: SnarkProof;
  publicSignals: string[];
  /** The address the pool paid (settle's `recipient` argument). */
  recipient: string;
  /** settle's `amount` argument. */
  amount: string;
  /** Null while pending. */
  blockNumber: string | null;
  /** From the transaction receipt: a reverted settle() paid nobody. */
  status: SettleStatus;
}

/** Reads a real proof back out of a null-402 `settle` transaction on Fuji, with its receipt status. */
export async function proofFromSettleTx(hash: Hex, opts: { rpc?: string } = {}): Promise<SettleTx> {
  const c = client(opts.rpc ?? NULL402_FUJI.rpc);
  let tx;
  try {
    tx = await c.getTransaction({ hash });
  } catch (e) {
    if ((e as Error).name === 'TransactionNotFoundError') throw new VerifyError(`${hash}: Fuji does not know this transaction`);
    throw e;
  }
  if (tx.to?.toLowerCase() !== NULL402_FUJI.pool.toLowerCase()) throw new VerifyError(`${hash} is not a call to the null-402 pool`);
  if (!tx.input.startsWith(SETTLE_SELECTOR)) throw new VerifyError(`${hash} is not a null-402 settle() call (selector ${tx.input.slice(0, 10)})`);
  const d = decodeFunctionData({ abi: POOL_ABI, data: tx.input });
  if (d.functionName !== 'settle') throw new VerifyError(`${hash} is not a null-402 settle() call`);
  const [a, b, cc, pub, recipient, amount] = d.args;
  let status: SettleStatus = 'pending';
  if (tx.blockNumber !== null) {
    try {
      status = (await c.getTransactionReceipt({ hash })).status;
    } catch (e) {
      if ((e as Error).name !== 'TransactionReceiptNotFoundError') throw e;
    }
  }
  const s = (x: bigint) => x.toString();
  return {
    proof: { pi_a: [s(a[0]), s(a[1]), '1'], pi_b: [[s(b[0][1]), s(b[0][0])], [s(b[1][1]), s(b[1][0])], ['1', '0']], pi_c: [s(cc[0]), s(cc[1]), '1'] },
    publicSignals: pub.map(s),
    recipient,
    amount: amount.toString(),
    blockNumber: tx.blockNumber === null ? null : tx.blockNumber.toString(),
    status,
  };
}

/** What the merchant expects a settlement to have paid it. */
export interface SettlementExpect {
  /** The proof's payTo signal (decimal field element). */
  payTo?: string;
  requiredAmount?: string | bigint;
  /** The EVM address the pool should have paid. Required for ok: the pool does not bind settle()'s
   *  recipient to the proof (Null402Pool.sol leaves that binding off-chain), so a proof that names your
   *  payTo can be settled to any address the caller chooses. */
  recipient?: string;
  contextHash?: string;
}

export interface SettlementResult {
  ok: boolean;
  /** paid: a successful settle() bound to the merchant. refused: settled, but not to this merchant as
   *  expected. unsettled: reverted or not mined, so nobody was paid. */
  verdict: 'paid' | 'refused' | 'unsettled';
  settled: boolean;
  status: SettleStatus;
  /** SETTLE_REVERTED, SETTLE_PENDING, BAD_PROOF, ROOT_UNKNOWN, NULLIFIER_NOT_SPENT, PAY_TO_MISMATCH,
   *  AMOUNT_MISMATCH, CONTEXT_MISMATCH, RECIPIENT_MISMATCH, UNBOUND (no expected payTo, amount or recipient). */
  reasons: string[];
  checks: Null402Result['checks'];
  signals: Null402Result['signals'];
  recipient: string;
  /** The plain proof check: could this proof still be settled to you? Always NULLIFIER_SPENT once settled. */
  proofCheck: { ok: boolean; reasons: string[] };
  /** The settle() transaction's block (null while pending) and the block the proof was checked at. */
  settledInBlock?: string | null;
  checkedAtBlock?: string;
}

/**
 * The settlement rule. A reverted or pending settle() is never ok. A successful one is ok when the proof
 * is valid against a known root, its nullifier is now spent (by this settle), and the payee, amount and
 * recipient (and context, when given) are the merchant's. Without an expected payTo, amount and recipient
 * it is UNBOUND: the pool pays whatever recipient settle() names, so "the proof names me" is not "I was paid".
 */
export function settlementVerdict(status: SettleStatus, check: Null402Result, recipient: string, e: SettlementExpect): SettlementResult {
  const base = { status, checks: check.checks, signals: check.signals, recipient, proofCheck: { ok: check.ok, reasons: check.reasons } };
  if (status !== 'success') return { ...base, ok: false, verdict: 'unsettled', settled: false, reasons: [status === 'reverted' ? 'SETTLE_REVERTED' : 'SETTLE_PENDING'] };
  const reasons = check.reasons.filter((r) => r !== 'NULLIFIER_SPENT' && r !== 'UNBOUND');
  if (!check.checks.nullifierSpent) reasons.push('NULLIFIER_NOT_SPENT');
  if (e.recipient !== undefined && e.recipient.toLowerCase() !== recipient.toLowerCase()) reasons.push('RECIPIENT_MISMATCH');
  if (e.payTo === undefined || e.requiredAmount === undefined || e.recipient === undefined) reasons.push('UNBOUND');
  return { ...base, ok: reasons.length === 0, verdict: reasons.length === 0 ? 'paid' : 'refused', settled: true, reasons };
}

/** Was the mined null-402 settle() `hash` a payment to the merchant described by `e`? Read-only, live on Fuji. */
export async function verifyNull402Settlement(hash: Hex, e: SettlementExpect, opts: { rpc?: string } = {}): Promise<SettlementResult> {
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new VerifyError(`settle tx must be a 0x-prefixed 32-byte hash, got ${JSON.stringify(hash)}`);
  expectations(e);
  if (e.recipient !== undefined && !(typeof e.recipient === 'string' && /^0x[0-9a-fA-F]{40}$/.test(e.recipient))) throw new VerifyError(`expect recipient must be a 0x-prefixed 20-byte address, got ${JSON.stringify(e.recipient)}`);
  const s = await proofFromSettleTx(hash, opts);
  const check = await verifyNull402({ rail: 'null402', proof: s.proof, publicSignals: s.publicSignals, expect: { payTo: e.payTo, requiredAmount: e.requiredAmount, contextHash: e.contextHash } }, opts);
  return { ...settlementVerdict(s.status, check, s.recipient, e), settledInBlock: s.blockNumber, checkedAtBlock: check.provenance.blockNumber };
}
