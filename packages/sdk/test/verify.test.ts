// Live: Zcash testnet through lightwalletd (zpay-verify), and Avalanche Fuji through eth_call to the
// contracts null-402 deployed. No mocked clients, no stub RPC.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { proofFromSettleTx, SetupRequiredError, verify, VerifyError, verifyZcash } from '../src/index.js';

const fx = JSON.parse(readFileSync(resolve(__dirname, '../../../fixtures/testnet.json'), 'utf8'));
/** A real null-402 settle() on Fuji (pool 0x39a9…cA1C, block 57020734). */
const SETTLE_TX = '0x8596f52de2d8c15680c96a0fa25b1bb5073324155f586203507cddf92f5ca593';

describe('zcash rail', () => {
  it('the published x402 payment verifies, with provenance', async () => {
    const r = await verify({ rail: 'zcash', uivk: fx.x402.uivk, txid: fx.x402.txid, amountZat: 100_000, memo: fx.x402.memo });
    expect(r.ok, r.reasons.join()).toBe(true);
    expect(r.paidZat).toBe(100_000);
    expect(r.report.height).toBe(4_521_112);
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
    expect(r.reasons).toEqual(['NULLIFIER_SPENT']);
    expect(Number(r.provenance.blockNumber)).toBeGreaterThan(Number(s.blockNumber));
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
