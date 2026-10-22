// x402 v1 on the wire, the way Shielded x402 (Kage, zec-shielded-x402) speaks it under the same
// "zcash-shielded" scheme. Kage's client builds X-PAYMENT as base64 {x402Version: 1, scheme, network,
// payload: {txid, memoNonce}} (packages/x402-zcash/src/index.ts, xPaymentHeader) and reads
// X-PAYMENT-RESPONSE as {success, transaction, network, payer}. The accepted payment is the published
// paywall payment of the Oct 20 run (deployments/testnet.json), presented to a paywall whose memo is
// pinned to it and checked live with the published Hanko merchant key. No new transaction.
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPaywall, type PaywallOptions } from '../src/server.js';

const run = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const merchant = run.wallets.merchant;
const paid = run.paywall.cases.paywall;
const servers: { close: () => void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function start(extra: Partial<PaywallOptions> = {}) {
  const server = createPaywall({ payTo: merchant.address, uivk: merchant.uivk, prices: { '/api/quote': BigInt(run.paywall.priceZat) }, content: (p) => ({ served: p }), ...extra });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
/** Kage's xPaymentHeader(txid, memoNonce), byte for byte. */
const kageHeader = (txid: string, memoNonce: string) => Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'zcash-shielded', network: 'zcash-testnet', payload: { txid: txid.trim().toLowerCase(), memoNonce } })).toString('base64');
const decode = (h: string | null) => JSON.parse(Buffer.from(h!, 'base64').toString('utf8'));

describe('x402 v1 wire format', () => {
  it('the 402 is an x402 v1 PaymentRequiredResponse that Kage’s parsePaymentRequired accepts (offline)', async () => {
    const base = await start();
    const r = await fetch(`${base}/api/quote`);
    expect(r.status).toBe(402);
    const body = (await r.json()) as { x402Version: number; error: string; accepts: Record<string, any>[] };
    expect(body.x402Version).toBe(1);
    expect(body.error).toBe('payment required');
    const a = body.accepts.find((x) => x.scheme === 'zcash-shielded' && x.network === 'zcash-testnet')!;
    expect(a).toMatchObject({ maxAmountRequired: '10000', resource: '/api/quote', payTo: merchant.address, asset: 'ZEC', mimeType: 'application/json', maxTimeoutSeconds: 900 });
    expect(typeof a.description).toBe('string');
    // Kage's checks (parsePaymentRequired): memoNonce 1-64 of [A-Za-z0-9_-], expiresAt in unix seconds in the future, a zatoshi integer, a testnet UA.
    expect(a.extra.memoNonce).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(a.extra.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(a.extra.expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 901); // 15 min, rounded up to a whole second
    expect(a.maxAmountRequired).toMatch(/^[0-9]+$/);
    expect(a.payTo.startsWith('utest1')).toBe(true);
    expect(a.extra.paymentUri).toBe(a.zip321);
    expect(a.extra.memoNonce).toBe(a.memo);
  });

  it('Kage’s X-PAYMENT for a real payment → 200, X-PAYMENT-RESPONSE {success, transaction, network, payer: ""}, the receipt in the body', async () => {
    const base = await start({ issueMemo: () => paid.challengeMemo });
    await fetch(`${base}/api/quote`);
    const r = await fetch(`${base}/api/quote`, { headers: { 'x-payment': kageHeader(paid.txid.toUpperCase(), paid.challengeMemo) } });
    expect(r.status).toBe(200);
    expect(decode(r.headers.get('x-payment-response'))).toEqual({ success: true, transaction: paid.txid, network: 'zcash-testnet', payer: '' });
    const body = (await r.json()) as { paid: Record<string, unknown>; data: unknown };
    expect(body.paid).toMatchObject({ txid: paid.txid, height: paid.paid.height, paidZat: 10_000, memo: paid.challengeMemo });
    expect(body.data).toEqual({ served: '/api/quote' });
    // The same envelope again: the memo and the txid are spent.
    await fetch(`${base}/api/quote`);
    const again = await fetch(`${base}/api/quote`, { headers: { 'x-payment': kageHeader(paid.txid, paid.challengeMemo) } });
    expect(again.status).toBe(402);
  });

  it('a v1 envelope with another scheme, network or version is 400 (offline)', async () => {
    const base = await start({ issueMemo: () => paid.challengeMemo });
    for (const over of [{ scheme: 'exact' }, { network: 'zcash-mainnet' }, { x402Version: 2 }, { payload: { txid: paid.txid } }]) {
      const env = { x402Version: 1, scheme: 'zcash-shielded', network: 'zcash-testnet', payload: { txid: paid.txid, memoNonce: paid.challengeMemo }, ...over };
      const r = await fetch(`${base}/api/quote`, { headers: { 'x-payment': Buffer.from(JSON.stringify(env)).toString('base64') } });
      expect(r.status, JSON.stringify(over)).toBe(400);
      expect(decode(r.headers.get('x-payment-response'))).toMatchObject({ success: false, transaction: '', network: 'zcash-testnet', payer: '' });
    }
  });
});
