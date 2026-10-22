// Who may make the gateway run a check. The production paywall (main.ts) does not serve /api/verify (only
// api.ts does); /api/verify takes only application/json, so a cross-site "simple" POST cannot run a check;
// a flood of /api/verify calls cannot use up the slots the paywall's own checks need; and the null402 rail
// is bounded like the zcash one. The flood target is a real local server that accepts and stays silent
// (a hung lightwalletd); the payment is the published x402 payment, checked live on testnet.zec.rocks.
import { readFileSync } from 'node:fs';
import { createServer as createTcp, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPaywall, type PaywallOptions } from '../src/server.js';

const fx = JSON.parse(readFileSync(resolve(__dirname, '../../../fixtures/testnet.json'), 'utf8'));
const cleanup: (() => unknown)[] = [];
const saved = { max: process.env.ZPV_MAX_CHECKS, queue: process.env.ZPV_MAX_QUEUE };
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
  for (const [k, v] of [['ZPV_MAX_CHECKS', saved.max], ['ZPV_MAX_QUEUE', saved.queue]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function start(extra: Partial<PaywallOptions>) {
  const server = createPaywall({ payTo: 'utest1-demo-merchant', uivk: fx.x402.uivk, prices: { '/api/quote': 100_000n }, content: (p) => ({ served: p }), ...extra });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const zcash = JSON.stringify({ rail: 'zcash', uivk: fx.x402.uivk, txid: fx.x402.txid, amountZat: 100_000, memo: fx.x402.memo });

describe('who can run a check', () => {
  it('a paywall does not serve /api/verify unless asked to (verifyApi), so the production paywall exposes no free checks', async () => {
    const base = await start({ issueMemo: () => fx.x402.memo, lwdUrl: 'http://127.0.0.1:9' });
    const r = await fetch(`${base}/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: zcash });
    expect(r.status).toBe(404);
  });

  it('/api/verify answers 415 to a body that is not application/json, before any check (a cross-site simple POST)', async () => {
    const base = await start({ verifyApi: true, lwdUrl: 'http://127.0.0.1:9', corsOrigins: ['http://127.0.0.1:5190'] });
    for (const type of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
      const r = await fetch(`${base}/api/verify`, { method: 'POST', headers: { origin: 'https://evil.example', ...(type ? { 'content-type': type } : {}) }, body: zcash });
      expect(r.status, type).toBe(415);
      expect(((await r.json()) as { error: string }).error).toBe('POST /api/verify with content-type application/json');
    }
    // The dead lightwalletd shows that a JSON body does reach the check.
    const json = await fetch(`${base}/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: zcash });
    expect(json.status).toBe(502);
  });

  it('a flood of /api/verify calls cannot take the paywall’s own check slots: with ZPV_MAX_CHECKS=1 and ZPV_MAX_QUEUE=0 the payment is still served', async () => {
    const sockets = new Set<Socket>();
    const silent = createTcp((s) => {
      sockets.add(s);
      s.on('error', () => {});
      setTimeout(() => s.destroy(), 8_000).unref();
    });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise<void>((r) => (sockets.forEach((s) => s.destroy()), silent.close(() => r()))));
    process.env.ZPV_MAX_CHECKS = '1';
    process.env.ZPV_MAX_QUEUE = '0';
    // The public verify API (same process) points at the silent server; its one slot stays busy.
    const api = await start({ verifyApi: true, lwdUrl: `http://127.0.0.1:${(silent.address() as AddressInfo).port}` });
    const flood = Array.from({ length: 5 }, () => fetch(`${api}/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: zcash }).then((r) => r.status));
    await new Promise((r) => setTimeout(r, 400));
    // The paywall checks the published payment on the real testnet.zec.rocks.
    const paywall = await start({ issueMemo: () => fx.x402.memo });
    await fetch(`${paywall}/api/quote`);
    const paid = await fetch(`${paywall}/api/quote`, { headers: { 'x-payment': Buffer.from(JSON.stringify({ memo: fx.x402.memo, txid: fx.x402.txid })).toString('base64') } });
    const body = (await paid.json()) as { error?: string; paid?: { txid: string } };
    expect(paid.status, body.error).toBe(200);
    expect(body.paid?.txid).toBe(fx.x402.txid);
    const statuses = await Promise.all(flood);
    expect(statuses.filter((s) => s === 503)).toHaveLength(4); // the API's own limit still holds
  });
});
