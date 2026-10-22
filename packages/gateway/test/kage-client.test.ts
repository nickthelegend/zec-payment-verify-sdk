// Shielded x402's (Kage's) own client against Hanko's paywall: not a copy of its header builder, the
// module itself, imported from the zec-shielded-x402 checkout (packages/x402-zcash/src/index.ts). Set
// KAGE_X402_DIR to that package; by default it is the sibling checkout ../../../zec-shielded-x402 of this
// repo (CI clones it there). Without it this test fails with Setup required: it is never skipped.
// The payment is the published paywall payment of the Oct 20 run, presented to a paywall whose memo is
// pinned to it and checked live on testnet.zec.rocks with the published Hanko merchant key.
import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createPaywall, type PaywallOptions } from '../src/server.js';

const run = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const merchant = run.wallets.merchant;
const paid = run.paywall.cases.paywall;
const KAGE_DIR = process.env.KAGE_X402_DIR ?? resolve(__dirname, '../../../../../../zec-shielded-x402/packages/x402-zcash');
const KAGE_SRC = resolve(KAGE_DIR, 'src/index.ts');

type Kage = {
  parsePaymentRequired: (body: unknown, nowUnix?: number) => { payTo: string; amountZat: bigint; memoNonce: string; expiresAt: number; resource: string; paymentUri?: string };
  fetchWithPayment: (url: string, payment: { txid: string; memoNonce: string }) => Promise<{ status: number; settlement?: { success: boolean; transaction: string; network: string; payer: string; errorReason?: string }; body: any; challenge?: { memoNonce: string } }>;
  zip321Uri: (payTo: string, amountZat: bigint, memo: string) => string;
};
async function kage(): Promise<Kage> {
  if (!existsSync(KAGE_SRC)) throw new Error(`Setup required: KAGE_X402_DIR (Shielded x402's packages/x402-zcash, not found at ${KAGE_DIR})`);
  return (await import(pathToFileURL(KAGE_SRC).href)) as Kage;
}

const servers: { close: () => void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));
async function start(extra: Partial<PaywallOptions> = {}) {
  const server = createPaywall({ payTo: merchant.address, uivk: merchant.uivk, prices: { '/api/quote': BigInt(run.paywall.priceZat) }, content: (p) => ({ served: p }), ...extra });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('Shielded x402’s own client (zec-shielded-x402 packages/x402-zcash) against Hanko', () => {
  it('parsePaymentRequired accepts Hanko’s 402 with a stateless HMAC memo, and its ZIP 321 URI is Hanko’s (offline)', async () => {
    const k = await kage();
    const base = await start();
    const r = await fetch(`${base}/api/quote`);
    expect(r.status).toBe(402);
    const c = k.parsePaymentRequired(await r.json());
    expect(c).toMatchObject({ payTo: merchant.address, amountZat: 10_000n, resource: '/api/quote' });
    expect(c.memoNonce).toMatch(/^zpv-\d{10}-[0-9a-f]{16}-[A-Za-z0-9_-]{22}$/);
    expect(c.paymentUri).toBe(k.zip321Uri(c.payTo, c.amountZat, c.memoNonce));
  });

  it('fetchWithPayment presents a real mined payment → 200 with a successful settlement; the same payment again → 402', async () => {
    const k = await kage();
    const base = await start({ issueMemo: () => paid.challengeMemo });
    const challenge = k.parsePaymentRequired(await (await fetch(`${base}/api/quote`)).json());
    expect(challenge.memoNonce).toBe(paid.challengeMemo);
    const ok = await k.fetchWithPayment(`${base}/api/quote`, { txid: paid.txid.toUpperCase(), memoNonce: challenge.memoNonce });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.settlement).toEqual({ success: true, transaction: paid.txid, network: 'zcash-testnet', payer: '' });
    expect(ok.body.paid).toMatchObject({ txid: paid.txid, paidZat: 10_000, memo: paid.challengeMemo });
    const again = await k.fetchWithPayment(`${base}/api/quote`, { txid: paid.txid, memoNonce: challenge.memoNonce });
    expect(again.status).toBe(402);
    expect(again.settlement).toMatchObject({ success: false });
    expect(again.challenge?.memoNonce).toBe(paid.challengeMemo);
  });
});
