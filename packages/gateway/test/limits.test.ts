// Unauthenticated requests cannot make the gateway fork without limit, and one challenge cannot be
// used to try txids forever. The flood case is offline (a local server that accepts and stays silent
// stands in for a hung lightwalletd; the binary is the real zpay-verify). The attempts case is live:
// random txids that testnet.zec.rocks does not know, then the published x402 payment.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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

function running(marker: string): number {
  try {
    return execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

describe('gateway limits', () => {
  it('150 verify requests at once start at most ZPV_MAX_CHECKS checks; past the queue they are 503 + Retry-After', async () => {
    const sockets = new Set<Socket>();
    const silent = createTcp((s) => {
      sockets.add(s);
      s.on('error', () => {});
      setTimeout(() => s.destroy(), 2_000).unref();
    });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise<void>((r) => (sockets.forEach((s) => s.destroy()), silent.close(() => r()))));
    const base = await start({ lwdUrl: `http://127.0.0.1:${(silent.address() as AddressInfo).port}` });
    process.env.ZPV_MAX_CHECKS = '4';
    process.env.ZPV_MAX_QUEUE = '4';
    const txid = randomBytes(32).toString('hex');
    let peak = 0;
    const watch = setInterval(() => (peak = Math.max(peak, running(txid))), 100);
    const body = JSON.stringify({ rail: 'zcash', uivk: fx.x402.uivk, txid, amountZat: 1 });
    const answers = await Promise.all(
      Array.from({ length: 150 }, () => fetch(`${base}/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then(async (r) => ({ status: r.status, retry: r.headers.get('retry-after'), error: ((await r.json()) as { error: string }).error }))),
    );
    clearInterval(watch);
    const busy = answers.filter((a) => a.status === 503);
    expect(busy).toHaveLength(142);
    expect(busy.every((a) => a.retry === '5' && /payment checks are running/.test(a.error))).toBe(true);
    expect(answers.filter((a) => a.status === 502)).toHaveLength(8); // the silent server hung up: lightwalletd unreachable
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('after 5 refused attempts a challenge is closed, even for a payment that would have paid it', async () => {
    const base = await start({ issueMemo: () => fx.x402.memo });
    await fetch(`${base}/api/quote`);
    const pay = (txid: string) => fetch(`${base}/api/quote`, { headers: { 'x-payment': Buffer.from(JSON.stringify({ memo: fx.x402.memo, txid })).toString('base64') } });
    for (let i = 0; i < 5; i++) {
      const r = await pay(randomBytes(32).toString('hex'));
      expect(r.status).toBe(402);
      expect(((await r.json()) as { reasons: string[] }).reasons).toEqual(['TX_NOT_FOUND']);
    }
    const t0 = Date.now();
    const closed = await pay(fx.x402.txid);
    expect(closed.status).toBe(402);
    const body = (await closed.json()) as { error: string; reasons?: string[]; accepts: { memo: string }[] };
    expect(body.error).toBe('too many refused payments for this challenge (5); ask for a new one');
    expect(body.reasons).toBeUndefined(); // refused before any check
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
