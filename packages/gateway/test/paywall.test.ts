// Real HTTP paywall, real lightwalletd, a real mined payment: the published x402 merchant key and
// its payment (fixtures/testnet.json). The challenge memo is pinned to that payment's memo so a
// historical transaction can answer it.
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPaywall } from '../src/server.js';

const fx = JSON.parse(readFileSync(resolve(__dirname, '../../../fixtures/testnet.json'), 'utf8'));
let base = '';
let close = () => {};
const pay = (path: string, p: object) => fetch(base + path, { headers: { 'x-payment': Buffer.from(JSON.stringify(p)).toString('base64') } });

beforeAll(async () => {
  const server = createPaywall({
    payTo: 'utest1-demo-merchant',
    uivk: fx.x402.uivk,
    prices: { '/api/quote': 100_000n, '/api/report': 100_001n },
    content: (p) => ({ served: p }),
    issueMemo: () => fx.x402.memo,
    corsOrigins: ['http://localhost:5180'],
    verifyApi: true,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

describe('paywall', () => {
  it('answers 402 with a challenge and a ZIP-321 URI', async () => {
    const r = await fetch(`${base}/api/quote`);
    expect(r.status).toBe(402);
    const { accepts } = (await r.json()) as { accepts: { amountZat: string; memo: string; zip321: string; minConf: number }[] };
    expect(accepts[0]).toMatchObject({ amountZat: '100000', memo: fx.x402.memo, minConf: 1 });
    expect(accepts[0].zip321).toBe(`zcash:utest1-demo-merchant?amount=0.001&memo=${Buffer.from(fx.x402.memo).toString('base64url')}`);
  });

  it('a mined payment with the challenge memo and amount → 200 with a receipt; the same txid cannot pay again', async () => {
    await fetch(`${base}/api/quote`);
    const ok = await pay('/api/quote', { memo: fx.x402.memo, txid: fx.x402.txid });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { paid: { txid: string; height: number; paidZat: number }; data: unknown };
    expect(body.paid).toMatchObject({ txid: fx.x402.txid, height: 4_521_112, paidZat: 100_000 });
    expect(body.data).toEqual({ served: '/api/quote' });
    expect(ok.headers.get('x-payment-response')).toBeTruthy();
    await fetch(`${base}/api/quote`);
    const again = await pay('/api/quote', { memo: fx.x402.memo, txid: fx.x402.txid });
    expect(again.status).toBe(402);
    expect(((await again.json()) as { error: string }).error).toMatch(/already paid/);
  });

  it('someone else’s payment, an unknown memo or garbage is refused', async () => {
    // Its own paywall: the x402 memo was burned by the 200 above (a paid memo never answers again).
    const other = createPaywall({ payTo: 'utest1-demo-merchant', uivk: fx.x402.uivk, prices: { '/api/report': 100_001n }, content: (p) => ({ served: p }), issueMemo: () => 'zpv-another-invoice' });
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    const otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    await fetch(`${otherBase}/api/report`);
    const low = await fetch(`${otherBase}/api/report`, { headers: { 'x-payment': Buffer.from(JSON.stringify({ memo: 'zpv-another-invoice', txid: fx.auction.deposit.txid })).toString('base64') } });
    other.close();
    expect(low.status).toBe(402);
    expect(((await low.json()) as { reasons: string[] }).reasons).toEqual(['NO_OUTPUT_TO_KEY']);
    const unknown = await pay('/api/quote', { memo: 'zpv-never-issued', txid: fx.x402.txid });
    expect(unknown.status).toBe(402);
    const garbage = await fetch(`${base}/api/quote`, { headers: { 'x-payment': '%%%' } });
    expect(garbage.status).toBe(400);
  });

  it('/api/verify returns the SDK verdict for either rail, with CORS for the dashboard', async () => {
    const r = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { origin: 'http://localhost:5180', 'content-type': 'application/json' },
      body: JSON.stringify({ rail: 'zcash', uivk: fx.x402.uivk, txid: fx.x402.txid, amountZat: 100_000, memo: fx.x402.memo }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('http://localhost:5180');
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
    const bad = await fetch(`${base}/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rail: 'zcash', uivk: fx.x402.uivk, txid: 'nope', amountZat: 1 }) });
    expect(bad.status).toBe(400);
  });
});
