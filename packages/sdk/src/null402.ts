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

export async function verifyNull402(req: Null402Request, opts: { rpc?: string } = {}): Promise<Null402Result> {
  if (!Array.isArray(req.publicSignals) || req.publicSignals.length !== 5) throw new VerifyError('publicSignals must be the 5 null-402 signals [nullifier, merkleRoot, payTo, requiredAmount, contextHash]');
  let pub: readonly [bigint, bigint, bigint, bigint, bigint];
  let sol: ReturnType<typeof solidityProof>;
  try {
    pub = req.publicSignals.map((s) => BigInt(s)) as unknown as typeof pub;
    sol = solidityProof(req.proof);
  } catch {
    throw new VerifyError('proof or public signals are not decimal field elements');
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
  const e = req.expect ?? {};
  if (e.payTo !== undefined && BigInt(e.payTo) !== pub[2]) reasons.push('PAY_TO_MISMATCH');
  if (e.requiredAmount !== undefined && BigInt(e.requiredAmount) !== pub[3]) reasons.push('AMOUNT_MISMATCH');
  if (e.contextHash !== undefined && BigInt(e.contextHash) !== pub[4]) reasons.push('CONTEXT_MISMATCH');
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

/** Reads a real proof back out of a null-402 `settle` transaction on Fuji. */
export async function proofFromSettleTx(hash: Hex, opts: { rpc?: string } = {}): Promise<{ proof: SnarkProof; publicSignals: string[]; recipient: string; blockNumber: string }> {
  const tx = await client(opts.rpc ?? NULL402_FUJI.rpc).getTransaction({ hash });
  if (tx.to?.toLowerCase() !== NULL402_FUJI.pool.toLowerCase()) throw new VerifyError(`${hash} is not a call to the null-402 pool`);
  if (!tx.input.startsWith(SETTLE_SELECTOR)) throw new VerifyError(`${hash} is not a null-402 settle() call (selector ${tx.input.slice(0, 10)})`);
  const d = decodeFunctionData({ abi: POOL_ABI, data: tx.input });
  if (d.functionName !== 'settle') throw new VerifyError(`${hash} is not a null-402 settle() call`);
  const [a, b, c, pub, recipient] = d.args;
  const s = (x: bigint) => x.toString();
  return {
    proof: { pi_a: [s(a[0]), s(a[1]), '1'], pi_b: [[s(b[0][1]), s(b[0][0])], [s(b[1][1]), s(b[1][0])], ['1', '0']], pi_c: [s(c[0]), s(c[1]), '1'] },
    publicSignals: pub.map(s),
    recipient,
    blockNumber: String(tx.blockNumber),
  };
}
