// Live: Zcash testnet through lightwalletd (zpay-verify), and Avalanche Fuji through eth_call to the
// contracts null-402 deployed. No mocked clients, no stub RPC.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { proofFromSettleTx, settlementVerdict, SetupRequiredError, verify, verifyNull402Settlement, VerifyError, verifyZcash } from '../src/index.js';

const fx = JSON.parse(readFileSync(resolve(__dirname, '../../../fixtures/testnet.json'), 'utf8'));
/** A real null-402 settle() on Fuji (pool 0x39a9…cA1C, block 57020734). */
const SETTLE_TX = '0x8596f52de2d8c15680c96a0fa25b1bb5073324155f586203507cddf92f5ca593';
/** The pool's other settle() (block 57020809): same merchant, another note. Routescan lists 7 transactions
 *  to the pool on Oct 22, 2026, all status 1, so there is no real reverted settle() to test against. */
const SETTLE_TX_2 = '0xd91c0ab7d0d228d003277d62145442b24dcd52492becf561b9977c40fe781e5c';

describe('zcash rail', () => {
  it('the published x402 payment verifies, with provenance', async () => {
    const r = await verify({ rail: 'zcash', uivk: fx.x402.uivk, txid: fx.x402.txid, amountZat: 100_000, memo: fx.x402.memo });
    expect(r.ok, r.reasons.join()).toBe(true);
    expect(r.paidZat).toBe(100_000);
    expect(r.report.height).toBe(4_521_112);
    // the block lightwalletd names lists the tx; its time is earlier than the Oct 20 paywall payment's block (1,792,512,944)
    expect(r.report.block_time).toBeGreaterThan(1_790_000_000);
    expect(r.report.block_time).toBeLessThan(1_792_512_944);
    expect(r.provenance.lightwalletd).toMatch(/^https:\/\//);
    expect(r.provenance.tip).toBeGreaterThan(4_521_112);
  });

  it('wrong memo, too high an amount, someone else’s payment, unknown txid: refused with reasons', async () => {
    const base = { rail: 'zcash' as const, uivk: fx.x402.uivk, txid: fx.x402.txid };
    expect((await verify({ ...base, amountZat: 100_000, memo: 'x402z-other' })).reasons).toEqual(['MEMO_MISMATCH', 'AMOUNT_TOO_LOW']);
    expect((await verify({ ...base, amountZat: 100_001, memo: fx.x402.memo })).reasons).toEqual(['AMOUNT_TOO_LOW']);
    expect((await verify({ ...base, txid: fx.auction.deposit.txid, amountZat: 1 })).reasons).toEqual(['NO_OUTPUT_TO_KEY']);
    expect((await verify({ ...base, txid: 'ab'.repeat(32), amountZat: 1 })).reasons).toEqual(['TX_NOT_FOUND']);
  });

  it('bad input and a missing binary are errors, not verdicts', async () => {
    await expect(verify({ rail: 'zcash', uivk: fx.x402.uivk, txid: 'nope', amountZat: 1 })).rejects.toBeInstanceOf(VerifyError);
    await expect(verify({ rail: 'zcash', uivk: 'uivktest1garbage', txid: fx.x402.txid, amountZat: 1 })).rejects.toThrow(/not a testnet unified incoming viewing key/);
    const prev = process.env.ZPV_BIN;
    process.env.ZPV_BIN = '/nonexistent/zpay-verify';
    await expect(verifyZcash({ rail: 'zcash', uivk: fx.x402.uivk, txid: fx.x402.txid, amountZat: 1 })).rejects.toBeInstanceOf(SetupRequiredError);
    if (prev === undefined) delete process.env.ZPV_BIN;
    else process.env.ZPV_BIN = prev;
  });
});

describe('null402 rail (Avalanche Fuji)', () => {
  it('a real settled proof: valid on the deployed verifier, root known, nullifier spent → refused as a replay', async () => {
    const s = await proofFromSettleTx(SETTLE_TX);
    const r = await verify({ rail: 'null402', proof: s.proof, publicSignals: s.publicSignals });
    expect(r.checks).toEqual({ proofValid: true, rootKnown: true, nullifierSpent: true });
    expect(r.reasons).toEqual(['NULLIFIER_SPENT', 'UNBOUND']);
    expect(Number(r.provenance.blockNumber)).toBeGreaterThan(Number(s.blockNumber));
  });

  it('without an expected payTo and amount the result is never ok: UNBOUND', async () => {
    const s = await proofFromSettleTx(SETTLE_TX);
    for (const expectation of [undefined, { payTo: s.publicSignals[2] }, { requiredAmount: s.publicSignals[3] }]) {
      const r = await verify({ rail: 'null402', proof: s.proof, publicSignals: s.publicSignals, expect: expectation });
      expect(r.ok).toBe(false);
      expect(r.reasons).toContain('UNBOUND');
    }
    const bound = await verify({ rail: 'null402', proof: s.proof, publicSignals: s.publicSignals, expect: { payTo: s.publicSignals[2], requiredAmount: s.publicSignals[3] } });
    expect(bound.reasons).not.toContain('UNBOUND');
  });

  it('the same proof with its nullifier or amount changed fails the deployed verifier', async () => {
    const s = await proofFromSettleTx(SETTLE_TX);
    for (const i of [0, 3]) {
      const pub = [...s.publicSignals];
      pub[i] = (BigInt(pub[i]) + 1n).toString();
      const r = await verify({ rail: 'null402', proof: s.proof, publicSignals: pub });
      expect(r.checks.proofValid).toBe(false);
      expect(r.reasons).toContain('BAD_PROOF');
    }
  });

  it('a merchant expecting another payTo, amount or context refuses the proof', async () => {
    const s = await proofFromSettleTx(SETTLE_TX);
    const r = await verify({ rail: 'null402', ...s, expect: { payTo: '1', requiredAmount: BigInt(s.publicSignals[3]) + 1n, contextHash: '2' } });
    expect(r.checks.proofValid).toBe(true);
    expect(r.reasons).toEqual(['NULLIFIER_SPENT', 'PAY_TO_MISMATCH', 'AMOUNT_MISMATCH', 'CONTEXT_MISMATCH']);
    const same = await verify({ rail: 'null402', ...s, expect: { payTo: s.publicSignals[2], requiredAmount: s.publicSignals[3], contextHash: s.publicSignals[4] } });
    expect(same.reasons).toEqual(['NULLIFIER_SPENT']);
  });

  it('a non-settle tx or malformed signals are errors', async () => {
    await expect(verify({ rail: 'null402', proof: { pi_a: [], pi_b: [], pi_c: [] }, publicSignals: ['1'] })).rejects.toBeInstanceOf(VerifyError);
    await expect(proofFromSettleTx('0xbc62a275074dfb9434963ab04605c4102fcf937af4b8c8c0fb460368f007b025')).rejects.toThrow(/not a null-402 settle\(\) call/);
  });
});

describe('null402 settlement (was this mined settle() a payment to me?)', () => {
  it('a successful settle() is read with its receipt status, payee and amount', async () => {
    const s = await proofFromSettleTx(SETTLE_TX);
    expect(s.status).toBe('success');
    expect(s.blockNumber).toBe('57020734');
    expect(s.recipient).toBe('0x605ab54711b69C1D783fd72447d92C3dA10797CD');
    expect(s.amount).toBe('1000');
  });

  it('a successful settle() bound to the merchant is paid; another payee, amount or recipient, or no binding, is not', async () => {
    const s = await proofFromSettleTx(SETTLE_TX);
    const me = { payTo: s.publicSignals[2], requiredAmount: s.publicSignals[3], recipient: s.recipient };
    for (const tx of [SETTLE_TX, SETTLE_TX_2]) {
      const r = await verifyNull402Settlement(tx as `0x${string}`, me);
      expect(r.ok, `${tx}: ${r.reasons}`).toBe(true);
      expect(r).toMatchObject({ verdict: 'paid', settled: true, status: 'success', reasons: [] });
      expect(r.checks).toEqual({ proofValid: true, rootKnown: true, nullifierSpent: true });
      // The plain proof check says what it says: this proof can no longer be settled to anyone.
      expect(r.proofCheck.reasons).toEqual(['NULLIFIER_SPENT']);
    }
    const other = await verifyNull402Settlement(SETTLE_TX, { ...me, recipient: '0x0000000000000000000000000000000000000001', requiredAmount: '999' });
    expect(other).toMatchObject({ ok: false, verdict: 'refused', settled: true });
    expect(other.reasons).toEqual(['AMOUNT_MISMATCH', 'RECIPIENT_MISMATCH']);
    const unbound = await verifyNull402Settlement(SETTLE_TX, {});
    expect(unbound.ok).toBe(false);
    expect(unbound.reasons).toEqual(['UNBOUND']);
  });

  it('a reverted or pending settle() is never ok, whatever the proof (the rule, on the real proof check)', async () => {
    const s = await proofFromSettleTx(SETTLE_TX);
    const check = await verify({ rail: 'null402', proof: s.proof, publicSignals: s.publicSignals, expect: { payTo: s.publicSignals[2], requiredAmount: s.publicSignals[3] } });
    for (const [status, reason] of [['reverted', 'SETTLE_REVERTED'], ['pending', 'SETTLE_PENDING']] as const) {
      const v = settlementVerdict(status, check, s.recipient, { payTo: s.publicSignals[2], requiredAmount: s.publicSignals[3], recipient: s.recipient });
      expect(v).toMatchObject({ ok: false, verdict: 'unsettled', settled: false });
      expect(v.reasons).toEqual([reason]);
    }
  });

  it('a hash Fuji does not know is an error, not a verdict', async () => {
    await expect(verifyNull402Settlement(`0x${'ab'.repeat(32)}`, {})).rejects.toThrow(/Fuji does not know/);
  });
});
