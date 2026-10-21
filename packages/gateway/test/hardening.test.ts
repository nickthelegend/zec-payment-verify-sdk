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
    const base = await start({ issueMemo: () => `zpv-test-${n++}`, maxOpenChallenges: 3, challengeTtlMs: 150 });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await fetch(`${base}/api/quote`)).status);
    expect(statuses).toEqual([402, 402, 402, 503]);
    await new Promise((r) => setTimeout(r, 200));
    expect((await fetch(`${base}/api/quote`)).status).toBe(402);
  });
});
