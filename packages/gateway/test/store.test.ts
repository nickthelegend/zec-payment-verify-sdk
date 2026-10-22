// Persistent paywall state. Real lightwalletd, the published x402 payment (fixtures/testnet.json),
// a real SQLite file in a temp directory and, for the shared-store case, a real second process.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPaywall, type PaywallOptions } from '../src/server.js';
import { MemoryStore, SqliteStore } from '../src/store.js';

const fx = JSON.parse(readFileSync(resolve(__dirname, '../../../fixtures/testnet.json'), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'zpv-store-'));
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach((f) => f()));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function start(extra: Partial<PaywallOptions>) {
  const server = createPaywall({ payTo: 'utest1-demo-merchant', uivk: fx.x402.uivk, prices: { '/api/quote': 100_000n }, content: (p) => ({ served: p, pid: process.pid }), issueMemo: () => fx.x402.memo, ...extra });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const close = () => new Promise<void>((r) => server.close(() => r()));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close };
}
const pay = (base: string) => fetch(`${base}/api/quote`, { headers: { 'x-payment': Buffer.from(JSON.stringify({ memo: fx.x402.memo, txid: fx.x402.txid })).toString('base64') } });

describe('SQLite paywall store', () => {
  it('a restarted paywall on the same file refuses a payment it already served', async () => {
    const file = join(dir, 'restart.sqlite');
    const s1 = new SqliteStore(file);
    const a = await start({ store: s1 });
    await fetch(`${a.base}/api/quote`);
    expect((await pay(a.base)).status).toBe(200);
    await a.close();
    s1.close();

    const s2 = new SqliteStore(file);
    cleanup.push(() => s2.close());
    const b = await start({ store: s2 });
    cleanup.push(() => void b.close());
    expect((await fetch(`${b.base}/api/quote`)).status).toBe(402); // same pinned memo, issued again
    const again = await pay(b.base);
    expect(again.status).toBe(402);
    expect(((await again.json()) as { error: string }).error).toMatch(/already paid/);
  });

  it('a challenge issued before a restart can still be answered after it', async () => {
    let n = 0;
    const s1 = new SqliteStore(join(dir, 'challenge.sqlite'));
    const a = await start({ store: s1, issueMemo: () => `zpv-restart-${n++}` });
    const { accepts } = (await (await fetch(`${a.base}/api/quote`)).json()) as { accepts: { memo: string }[] };
    await a.close();
    s1.close();
    const s2 = new SqliteStore(join(dir, 'challenge.sqlite'));
    cleanup.push(() => s2.close());
    expect(s2.challenge(accepts[0].memo)).toMatchObject({ memo: 'zpv-restart-0', amountZat: '100000', resource: '/api/quote' });
  });

  describe('two paywall processes on one file', () => {
    let child: ChildProcess;
    let childBase = '';
    const file = join(dir, 'shared.sqlite');

    beforeAll(async () => {
      new SqliteStore(file).close(); // create the schema before both processes open it
      child = spawn(process.execPath, ['--import', 'tsx', resolve(__dirname, 'support/paywall-process.ts'), file], { cwd: resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'inherit'] });
      const port = await new Promise<number>((res, rej) => {
        child.once('exit', (c) => rej(new Error(`paywall process exited with ${c}`)));
        child.stdout!.on('data', (d: Buffer) => {
          const m = /"port":(\d+)/.exec(d.toString());
          if (m) res(Number(m[1]));
        });
      });
      childBase = `http://127.0.0.1:${port}`;
    });
    afterAll(() => {
      child?.kill('SIGTERM');
    });

    it('the same payment sent to both at once is served once', async () => {
      const store = new SqliteStore(file);
      cleanup.push(() => store.close());
      const here = await start({ store });
      cleanup.push(() => void here.close());
      expect((await fetch(`${here.base}/api/quote`)).status).toBe(402);
      expect((await fetch(`${childBase}/api/quote`)).status).toBe(402);
      const [a, b] = await Promise.all([pay(here.base), pay(childBase)]);
      expect([a.status, b.status].sort()).toEqual([200, 402]);
      // and afterwards neither process serves it again
      expect((await pay(childBase)).status).toBe(402);
      expect((await pay(here.base)).status).toBe(402);
    });
  });
});

describe('store claims', () => {
  it('an expired lease can be taken over, the old holder can then neither release nor settle it, and a settled txid stays used', () => {
    const s = new SqliteStore(join(dir, 'lease.sqlite'));
    cleanup.push(() => s.close());
    const first = s.claim('m', 't', 1_000, 100);
    expect(first.ok).toBe(true);
    expect(s.claim('m', 't', 1_050, 100)).toEqual({ ok: false, why: 'busy' });
    const second = s.claim('m', 't', 1_200, 100);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    s.release('m', 't', first.token);
    expect(s.claim('m', 't', 1_250, 100)).toEqual({ ok: false, why: 'busy' });
    expect(s.settle('m', 't', first.token)).toBe(false);
    expect(s.settle('m', 't', second.token)).toBe(true);
    expect(s.claim('another-memo', 't', 9_999, 100)).toEqual({ ok: false, why: 'used' });
    // A paid memo is burned too: a stateless memo has no stored challenge to close, so another txid
    // cannot answer it again.
    expect(s.claim('m', 'another-txid', 9_999, 100)).toEqual({ ok: false, why: 'used' });
    const mem = new MemoryStore();
    const c = mem.claim('m', 't', 1_000, 100);
    expect(c.ok && mem.settle('m', 't', c.token)).toBe(true);
    expect(mem.claim('m', 'another-txid', 1_001, 100)).toEqual({ ok: false, why: 'used' });
  });
});
