// Which status each failure gets. An x402 client treats 400 as "fix your request" and gives up, so a
// lightwalletd that is down must never look like bad input. Offline: the dead lightwalletd is a closed
// local port, and the published x402 key and memo are used only as well-formed input.
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPaywall, type PaywallOptions } from '../src/server.js';

const fx = JSON.parse(readFileSync(resolve(__dirname, '../../../fixtures/testnet.json'), 'utf8'));
const DEAD_LWD = 'http://127.0.0.1:9';
const servers: { close: () => void }[] = [];
const savedBin = process.env.ZPV_BIN;
afterEach(() => {
  servers.splice(0).forEach((s) => s.close());
  if (savedBin === undefined) delete process.env.ZPV_BIN;
  else process.env.ZPV_BIN = savedBin;
});

async function start(extra: Partial<PaywallOptions> = {}) {
  const server = createPaywall({ payTo: 'utest1-demo-merchant', uivk: fx.x402.uivk, prices: { '/api/quote': 100_000n }, content: (p) => ({ served: p }), issueMemo: () => fx.x402.memo, lwdUrl: DEAD_LWD, verifyApi: true, ...extra });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const post = (base: string, body: string) => fetch(`${base}/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
const pay = (base: string) => fetch(`${base}/api/quote`, { headers: { 'x-payment': Buffer.from(JSON.stringify({ memo: fx.x402.memo, txid: fx.x402.txid })).toString('base64') } });
const zcash = { rail: 'zcash', uivk: fx.x402.uivk, txid: fx.x402.txid, amountZat: 100_000, memo: fx.x402.memo };

describe('gateway status codes', () => {
  it('lightwalletd unreachable: /api/verify is 502 with Retry-After, the paywall 503 with Retry-After', async () => {
    const base = await start();
    const v = await post(base, JSON.stringify(zcash));
    expect(v.status).toBe(502);
    expect(v.headers.get('retry-after')).toBe('30');
    expect(((await v.json()) as { error: string }).error).toMatch(/^cannot connect to lightwalletd/);
    await fetch(`${base}/api/quote`);
    const p = await pay(base);
    expect(p.status).toBe(503);
    expect(p.headers.get('retry-after')).toBe('30');
    const body = (await p.json()) as { error: string; data?: unknown };
    expect(body.error).toMatch(/could not be checked.*cannot connect to lightwalletd/);
    expect(body.data).toBeUndefined();
  });

  it('a missing zpay-verify binary is 503 Setup required on both', async () => {
    process.env.ZPV_BIN = '/nonexistent/zpay-verify';
    const base = await start();
    const v = await post(base, JSON.stringify(zcash));
    expect(v.status).toBe(503);
    expect(((await v.json()) as { error: string }).error).toBe('Setup required: ZPV_BIN (/nonexistent/zpay-verify does not exist)');
    await fetch(`${base}/api/quote`);
    const p = await pay(base);
    expect(p.status).toBe(503);
    expect(p.headers.get('retry-after')).toBeTruthy();
  });

  it('a body that is not a verify request is 400, never 502', async () => {
    const base = await start();
    const bad: [string, string][] = [
      ['null', 'null'],
      ['array', '[]'],
      ['number', '7'],
      ['unknown rail', JSON.stringify({ ...zcash, rail: 'btc' })],
      ['amountZat "abc"', JSON.stringify({ ...zcash, amountZat: 'abc' })],
      ['amountZat 1.5', JSON.stringify({ ...zcash, amountZat: 1.5 })],
      ['minConf "x"', JSON.stringify({ ...zcash, minConf: 'x' })],
      ['memo 7', JSON.stringify({ ...zcash, memo: 7 })],
      ['null402 without publicSignals', JSON.stringify({ rail: 'null402', proof: {} })],
      ['not JSON', '{'],
    ];
    for (const [what, body] of bad) {
      const r = await post(base, body);
      expect(r.status, what).toBe(400);
      expect(((await r.json()) as { error: string }).error, what).toBeTruthy();
    }
  });
});
