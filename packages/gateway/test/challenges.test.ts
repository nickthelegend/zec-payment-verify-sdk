// Challenges cost the gateway nothing until a payment arrives: the memo carries its own expiry and an
// HMAC over the payee, the resource and the price, so a flood of GETs stores nothing and locks nobody
// out. Offline: no payment is checked here (a presented memo either fails before any check, or reaches
// a check against a closed local port, which proves it was accepted).
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createPaywall, MemoryStore, SqliteStore, type PaywallOptions } from '../src/server.js';

const dir = mkdtempSync(join(tmpdir(), 'zpv-challenges-'));
const UIVK = 'uivktest1ma9hgu9cmmmkv5f5npk7aktj8tradzqyxzwerez5trhku0xxgx7vsh0azzurz44pfdhmyrzxnur3n282f5t0glhje7kay4fw79njmg64g2wupcznmpfpy0gh6wngu0qw07ry404hnh6rq9vuj264gcjfxucylma4c8cuygxezqx2xwph5x66nckx4095pgvjzuq5rudsmr9dztnyv9f2w74unppttta6cu7fr3tx494zqstn2hv';
const TXID = 'ab'.repeat(32);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function start(extra: Partial<PaywallOptions> = {}) {
  const server = createPaywall({ payTo: 'utest1-demo-merchant', uivk: UIVK, prices: { '/api/quote': 10_000n, '/api/report': 50_000n }, content: (p) => ({ served: p }), lwdUrl: 'http://127.0.0.1:9', ...extra });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const memoOf = async (r: Response) => ((await r.json()) as { accepts: { memo: string }[] }).accepts[0].memo;
const present = (base: string, path: string, memo: string) => fetch(base + path, { headers: { 'x-payment': Buffer.from(JSON.stringify({ memo, txid: TXID })).toString('base64') } });

describe('stateless challenges', () => {
  it('10,000 GETs store nothing and do not stop the next buyer getting a 402', async () => {
    const store = new SqliteStore(join(dir, 'flood.sqlite'));
    cleanup.push(() => store.close());
    const base = await start({ store });
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) {
      const batch = await Promise.all(Array.from({ length: 500 }, () => fetch(`${base}/api/quote`).then((r) => (r.body?.cancel(), r.status))));
      expect(new Set(batch)).toEqual(new Set([402]));
    }
    console.log(`10,000 GETs in ${Date.now() - t0} ms`);
    const next = await fetch(`${base}/api/quote`);
    expect(next.status).toBe(402);
    expect(await memoOf(next)).toMatch(/^zpv-\d{10}-[0-9a-f]{16}-[A-Za-z0-9_-]{22}$/);
    expect((store.db.prepare('SELECT count(*) AS n FROM challenges').get() as { n: number }).n).toBe(0);
  });

  it('OPTIONS is 204, HEAD gets the 402 headers without a body, other methods are 405 and issue nothing', async () => {
    const base = await start({ corsOrigins: ['http://localhost:5180'] });
    const opt = await fetch(`${base}/api/quote`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5180' } });
    expect(opt.status).toBe(204);
    expect(opt.headers.get('access-control-allow-headers')).toMatch(/x-payment/);
    const head = await fetch(`${base}/api/quote`, { method: 'HEAD' });
    expect(head.status).toBe(402);
    expect(await head.text()).toBe('');
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const r = await fetch(`${base}/api/quote`, { method });
      expect(r.status, method).toBe(405);
      expect(r.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    }
  });

  it('a memo only answers its own resource and price, and a changed expiry, nonce or tag is refused before any check', async () => {
    const base = await start();
    const memo = await memoOf(await fetch(`${base}/api/quote`));
    const [, exp, nonce, tag] = /^zpv-(\d+)-([0-9a-f]+)-(.+)$/.exec(memo)!;
    const forged = [
      memo.replace(`-${exp}-`, `-${Number(exp) + 3600}-`),
      memo.replace(`-${nonce}-`, `-${'0'.repeat(16)}-`),
      `zpv-${exp}-${nonce}-${'A'.repeat(22)}`,
    ];
    for (const m of forged) {
      const r = await present(base, '/api/quote', m);
      expect(r.status, m).toBe(402);
      expect(((await r.json()) as { error: string }).error).toBe('unknown or expired payment memo');
    }
    // The real memo on another price list entry is not this challenge either.
    const other = await present(base, '/api/report', memo);
    expect(other.status).toBe(402);
    expect(((await other.json()) as { error: string }).error).toBe('unknown or expired payment memo');
    // The real memo on its own resource is accepted and goes to a check (here: lightwalletd is a closed port).
    const real = await present(base, '/api/quote', memo);
    expect(real.status).toBe(503);
    expect(((await real.json()) as { error: string }).error).toMatch(/cannot connect to lightwalletd/);
  });

  it('with a SQLite store the HMAC key survives a restart; in memory it does not', async () => {
    const file = join(dir, 'secret.sqlite');
    const s1 = new SqliteStore(file);
    const a = await start({ store: s1 });
    const memo = await memoOf(await fetch(`${a}/api/quote`));
    const s2 = new SqliteStore(file);
    cleanup.push(() => s2.close(), () => s1.close());
    const b = await start({ store: s2 });
    expect((await present(b, '/api/quote', memo)).status).toBe(503); // accepted, then lightwalletd is down
    const m = await start({ store: new MemoryStore() });
    expect((await present(m, '/api/quote', memo)).status).toBe(402);
  });
});
