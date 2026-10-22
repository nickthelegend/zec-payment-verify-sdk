// Paywall hardening. The double-pay race runs against the real lightwalletd with the published x402
// payment (fixtures/testnet.json); the challenge-cap and malformed-header cases need no network.
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPaywall, type PaywallOptions } from '../src/server.js';

const fx = JSON.parse(readFileSync(resolve(__dirname, '../../../fixtures/testnet.json'), 'utf8'));
const servers: { close: () => void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function start(extra: Partial<PaywallOptions> = {}) {
  const server = createPaywall({ payTo: 'utest1-demo-merchant', uivk: fx.x402.uivk, prices: { '/api/quote': 100_000n }, content: (p) => ({ served: p }), issueMemo: () => fx.x402.memo, ...extra });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const header = (p: unknown) => ({ 'x-payment': Buffer.from(JSON.stringify(p)).toString('base64') });

describe('paywall hardening', () => {
  it('two concurrent requests with the same payment are served once, whatever the txid case', async () => {
    const base = await start();
    await fetch(`${base}/api/quote`);
    const [a, b] = await Promise.all([
      fetch(`${base}/api/quote`, { headers: header({ memo: fx.x402.memo, txid: fx.x402.txid }) }),
      fetch(`${base}/api/quote`, { headers: header({ memo: fx.x402.memo, txid: fx.x402.txid.toUpperCase() }) }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 402]);
  });

  it('open challenges are capped and expired ones are dropped', async () => {
    let n = 0;
    // presentWindowMs 0: an expired custom-memo challenge is dropped as soon as it expires.
    const base = await start({ issueMemo: () => `zpv-test-${n++}`, maxOpenChallenges: 3, challengeTtlMs: 150, presentWindowMs: 0 });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await fetch(`${base}/api/quote`)).status);
    expect(statuses).toEqual([402, 402, 402, 503]);
    await new Promise((r) => setTimeout(r, 200));
    expect((await fetch(`${base}/api/quote`)).status).toBe(402);
  });

  it('an X-PAYMENT that is JSON but not {memo, txid} strings is a 400, not a crash', async () => {
    const base = await start();
    for (const p of [null, 7, ['x'], { memo: 1, txid: 2 }]) {
      const r = await fetch(`${base}/api/quote`, { headers: header(p) });
      expect(r.status, JSON.stringify(p)).toBe(400);
    }
  });

  it('lightwalletd endpoints that disagree → 503 unverified, nothing served, and the payment stays claimable', async () => {
    // testnet.zec.rocks has the payment; zec.rocks (a real mainnet lightwalletd) does not, like a server withholding it.
    const split = await start({ lwdUrls: ['https://testnet.zec.rocks:443', 'https://zec.rocks:443'] });
    await fetch(`${split}/api/quote`);
    const r = await fetch(`${split}/api/quote`, { headers: header({ memo: fx.x402.memo, txid: fx.x402.txid }) });
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('30');
    const body = (await r.json()) as { reasons: string[]; data?: unknown };
    expect(body.reasons).toEqual(['UNVERIFIED_DISAGREEMENT']);
    expect(body.data).toBeUndefined();
    expect(await (await fetch(`${split}/api/health`)).json()).toMatchObject({ lightwalletd: { urls: ['https://testnet.zec.rocks:443', 'https://zec.rocks:443'], quorum: 2 } });
    // The payment stayed claimable: a retry that reaches a quorum is served. testnet.zec.rocks plus a
    // closed local port with quorum 1 (one server under two spellings is refused as one endpoint twice).
    const agree = await start({ lwdUrls: ['https://testnet.zec.rocks:443', 'http://127.0.0.1:9'], lwdQuorum: 1 });
    await fetch(`${agree}/api/quote`);
    expect((await fetch(`${agree}/api/quote`, { headers: header({ memo: fx.x402.memo, txid: fx.x402.txid }) })).status).toBe(200);
  });
});
