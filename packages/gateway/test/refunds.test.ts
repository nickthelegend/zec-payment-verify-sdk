// Money that reached the merchant but bought nothing is written down, and a payment is judged by when
// it was mined, not when it was presented. Live: the published refused payments of the Oct 20 run
// (deployments/testnet.json), presented to paywalls whose memo is pinned to theirs and checked with
// the published Hanko merchant key. The clock is moved only for the expiry case.
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPaywall, type PaywallOptions } from '../src/server.js';

const run = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const fx = JSON.parse(readFileSync(resolve(__dirname, '../../../fixtures/testnet.json'), 'utf8'));
const merchant = run.wallets.merchant;
const cases = run.paywall.cases;
/** Block 4,522,621, which mined the paywall, underpaid and transparent-part payments (core live test). */
const BLOCK_TIME_MS = 1_792_512_944_000;
const servers: { close: () => void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function start(extra: Partial<PaywallOptions>) {
  const server = createPaywall({ payTo: merchant.address, uivk: merchant.uivk, prices: { '/api/quote': 10_000n }, content: (p) => ({ served: p }), ...extra });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const pay = (base: string, memo: string, txid: string) => fetch(`${base}/api/quote`, { headers: { 'x-payment': Buffer.from(JSON.stringify({ memo, txid })).toString('base64') } });
type Refund = { txid: string; memo: string; paidZat: number; reasons: string[]; height: number; at: string };
const refunds = async (base: string) => ((await (await fetch(`${base}/api/refunds`)).json()) as { refunds: Refund[] }).refunds;

describe('refunds', () => {
  it('a refused payment whose funds reached the key is recorded and listed locally; one that paid someone else is not', async () => {
    let memo = cases['transparent-part'].challengeMemo;
    const base = await start({ issueMemo: () => memo });
    await fetch(`${base}/api/quote`);
    const t = await pay(base, memo, cases['transparent-part'].txid);
    expect(t.status).toBe(402);
    const tb = (await t.json()) as { reasons: string[]; error: string; received: { zat: number; recorded: boolean } };
    expect(tb.reasons).toEqual(['TRANSPARENT_PART']);
    expect(tb.received).toEqual({ zat: 10_000, recorded: true });
    expect(tb.error).toMatch(/the funds arrived and are recorded for a refund/);

    memo = cases.underpaid.challengeMemo;
    await fetch(`${base}/api/quote`);
    const u = await pay(base, memo, cases.underpaid.txid);
    expect(((await u.json()) as { reasons: string[] }).reasons).toEqual(['AMOUNT_TOO_LOW']);

    memo = 'zpv-not-this-merchant';
    await fetch(`${base}/api/quote`);
    const other = await pay(base, memo, fx.auction.deposit.txid);
    const ob = (await other.json()) as { reasons: string[]; received?: unknown };
    expect(ob.reasons).toEqual(['NO_OUTPUT_TO_KEY']);
    expect(ob.received).toBeUndefined();

    const list = await refunds(base);
    expect(list.map((r) => [r.txid, r.paidZat, r.reasons])).toEqual([
      [cases.underpaid.txid, 5_000, ['AMOUNT_TOO_LOW']],
      [cases['transparent-part'].txid, 10_000, ['TRANSPARENT_PART']],
    ]);
    expect(list[0]).toMatchObject({ memo: cases.underpaid.challengeMemo, height: 4_522_621 });
    // Presented again: listed once.
    memo = cases.underpaid.challengeMemo;
    await pay(base, memo, cases.underpaid.txid);
    expect(await refunds(base)).toHaveLength(2);
    // Only to the merchant's own machine: a request relayed by a proxy is refused.
    const relayed = await fetch(`${base}/api/refunds`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(relayed.status).toBe(403);
  });
});

describe('mined-time expiry', () => {
  it('a payment mined before its challenge expired is served when presented later; mined after expiry plus the grace it is PAYMENT_LATE and recorded', async () => {
    const memo = cases.paywall.challengeMemo;
    let clock = BLOCK_TIME_MS - 10 * 60_000; // challenge issued 10 min before the block, payable for 5 min
    const opts = { issueMemo: () => memo, now: () => clock, challengeTtlMs: 5 * 60_000 };

    // Grace 10 min: the block came 5 min after expiry, inside the grace. Presented 30 min after the block.
    const ok = await start({ ...opts, minedGraceMs: 10 * 60_000 });
    await fetch(`${ok}/api/quote`);
    clock = BLOCK_TIME_MS + 30 * 60_000;
    const served = await pay(ok, memo, cases.paywall.txid);
    expect(served.status).toBe(200);
    expect(((await served.json()) as { paid: { txid: string } }).paid.txid).toBe(cases.paywall.txid);

    // Grace 2 min: the block came after expiry plus the grace.
    clock = BLOCK_TIME_MS - 10 * 60_000;
    const late = await start({ ...opts, minedGraceMs: 2 * 60_000 });
    await fetch(`${late}/api/quote`);
    clock = BLOCK_TIME_MS + 30 * 60_000;
    const r = await pay(late, memo, cases.paywall.txid);
    expect(r.status).toBe(402);
    const body = (await r.json()) as { reasons: string[]; error: string; data?: unknown };
    expect(body.reasons).toEqual(['PAYMENT_LATE']);
    expect(body.error).toMatch(/mined at 2026-10-20T16:15:44.000Z, after the challenge expired/);
    expect(body.data).toBeUndefined();
    expect((await refunds(late)).map((x) => [x.txid, x.reasons])).toEqual([[cases.paywall.txid, ['PAYMENT_LATE']]]);

    // Past the presentation window the challenge is gone: unknown, nothing checked.
    clock = BLOCK_TIME_MS + 25 * 60 * 60_000;
    const gone = await pay(late, memo, cases.paywall.txid);
    expect(((await gone.json()) as { error: string }).error).toBe('unknown or expired payment memo');
  });
});
