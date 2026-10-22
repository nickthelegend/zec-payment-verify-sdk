// Cross-checking one payment against several lightwalletd endpoints. Everything here is a real
// server or a real dead socket; nothing is stubbed. What each endpoint really is:
//   ZEC_ROCKS        testnet.zec.rocks (lightwalletd on a Zakura node), the default endpoint
//   ZEC_ROCKS_ALIAS  the same server again, through a URL without the port. verify() refuses it beside
//                    ZEC_ROCKS (one server would vote twice), so the tests that need two agreeing
//                    answers fetch from testnet.zec.rocks twice and hand both real answers to the
//                    cross-check rule (crossCheckVerdict). That exercises the quorum arithmetic, not
//                    operator independence.
//   ZAINO            zaino.testnet.unsafe.zec.rocks, the only other public testnet indexer we found
//                    (Zaino on Zebra, same operator, different software). It answered 503 on Oct 22.
//   MAINNET          zec.rocks, a real mainnet lightwalletd: it does not have the testnet transaction,
//                    so it behaves exactly like a server that withholds it.
//   DEAD             127.0.0.1:1, where nothing listens.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crossCheckVerdict, verify, VerifyError, verifyZcash, verifyZcashCrossChecked, type ZcashResult } from '../src/index.js';

const fx = JSON.parse(readFileSync(resolve(__dirname, '../../../fixtures/testnet.json'), 'utf8'));
const ZEC_ROCKS = 'https://testnet.zec.rocks:443';
const ZEC_ROCKS_ALIAS = 'https://testnet.zec.rocks';
const ZAINO = 'https://zaino.testnet.unsafe.zec.rocks:443';
const MAINNET = 'https://zec.rocks:443';
const DEAD = 'https://127.0.0.1:1';
const req = { rail: 'zcash' as const, uivk: fx.x402.uivk, txid: fx.x402.txid, amountZat: 100_000, memo: fx.x402.memo };

/** Real outcomes for each URL: verifyZcash against that endpoint (testnet.zec.rocks under either spelling, or the dead socket). */
const outcomes = (r: typeof req, urls: string[]) => Promise.allSettled(urls.map((u) => verifyZcash(r, { lwdUrl: u })));

describe('lightwalletd cross-check', () => {
  it('two agreeing answers meet a quorum of 2 even with a third endpoint dead → paid, with every endpoint listed', async () => {
    // Both answers are real fetches from testnet.zec.rocks (see ZEC_ROCKS_ALIAS above); the dead one is a real refused socket.
    const urls = [ZEC_ROCKS, ZEC_ROCKS_ALIAS, DEAD];
    const r = crossCheckVerdict(urls, await outcomes(req, urls), 2);
    expect(r.verdict).toBe('paid');
    expect(r.ok).toBe(true);
    expect(r.paidZat).toBe(100_000);
    expect(r.report?.height).toBe(4_521_112);
    expect(r.crossCheck?.agreed).toBe(true);
    expect(r.crossCheck?.endpoints.map((e) => [e.lightwalletd, e.answered])).toEqual([[ZEC_ROCKS, true], [ZEC_ROCKS_ALIAS, true], [DEAD, false]]);
    expect(r.crossCheck?.endpoints[2].error).toMatch(/cannot connect/);
  });

  it('one answer when the quorum is 2 → unverified, never paid', async () => {
    const r = await verify(req, { lwdUrls: [ZEC_ROCKS, DEAD], quorum: 2 });
    expect(r.verdict).toBe('unverified');
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['UNVERIFIED_QUORUM']);
    expect(r.report).toBeNull();
    expect(r.crossCheck?.endpoints[0]).toMatchObject({ answered: true, ok: true }); // the one answer said paid
  });

  it('a server that does not return the transaction disagrees with one that does → unverified, whatever the quorum', async () => {
    for (const quorum of [1, 2]) {
      const r = await verify(req, { lwdUrls: [ZEC_ROCKS, MAINNET], quorum });
      expect(r.verdict, `quorum ${quorum}`).toBe('unverified');
      expect(r.reasons).toEqual(['UNVERIFIED_DISAGREEMENT']);
      expect(r.crossCheck?.endpoints.map((e) => e.reasons)).toEqual([[], ['TX_NOT_FOUND']]);
    }
  });

  it('agreeing refusals stay refusals: the wrong memo is refused by both', async () => {
    const other = { ...req, memo: 'x402z-other' };
    const r: ZcashResult = crossCheckVerdict([ZEC_ROCKS, ZEC_ROCKS_ALIAS], await outcomes(other, [ZEC_ROCKS, ZEC_ROCKS_ALIAS]), 2);
    expect(r.verdict).toBe('refused');
    expect(r.reasons).toEqual(['MEMO_MISMATCH', 'AMOUNT_TOO_LOW']);
    expect(r.crossCheck?.quorum).toBe(2);
  });

  it('the two public testnet indexers: paid only if both answer and agree, else unverified', async () => {
    const r = await verify(req, { lwdUrls: [ZEC_ROCKS, ZAINO], quorum: 2 });
    const answered = r.crossCheck!.endpoints.filter((e) => e.answered).length;
    console.log(`zaino testnet: ${r.crossCheck!.endpoints[1].answered ? 'answered' : `did not answer (${r.crossCheck!.endpoints[1].error})`} → ${r.verdict}`);
    expect(r.verdict).toBe(answered === 2 && r.crossCheck!.agreed ? 'paid' : 'unverified');
    expect(r.verdict).not.toBe('refused');
  });

  it('ZPV_LWD_URLS and ZPV_LWD_QUORUM switch verify() to a cross-check; bad settings are errors (offline)', async () => {
    const prev = { u: process.env.ZPV_LWD_URLS, q: process.env.ZPV_LWD_QUORUM };
    try {
      process.env.ZPV_LWD_URLS = `${DEAD}, https://127.0.0.1:2`;
      process.env.ZPV_LWD_QUORUM = '1';
      const r = await verify(req);
      expect(r.verdict).toBe('unverified');
      expect(r.reasons).toEqual(['UNVERIFIED_QUORUM']);
      process.env.ZPV_LWD_QUORUM = 'two';
      await expect(verify(req)).rejects.toThrow(/Setup required: ZPV_LWD_QUORUM/);
    } finally {
      for (const [k, v] of [['ZPV_LWD_URLS', prev.u], ['ZPV_LWD_QUORUM', prev.q]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    await expect(verifyZcashCrossChecked(req, { lwdUrls: [DEAD], quorum: 2 })).rejects.toBeInstanceOf(VerifyError);
    await expect(verifyZcashCrossChecked(req, { lwdUrls: [DEAD, DEAD] })).rejects.toThrow(/same URL twice/);
    await expect(verifyZcashCrossChecked({ ...req, txid: 'nope' }, { lwdUrls: [DEAD] })).rejects.toThrow(/not a txid/);
  });
});
