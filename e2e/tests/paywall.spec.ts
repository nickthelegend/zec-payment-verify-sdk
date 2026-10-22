// The x402 paywall in Chrome: an x402 v1 402 challenge, then the same URL with an X-PAYMENT header carrying a
// published, already-mined txid. Every answer comes from a live lightwalletd check with the published
// Hanko merchant viewing key. No new payment is made, so a fresh challenge can only be refused; the
// one accept is the published paywall payment presented to a paywall whose memo is pinned to it.
import type { Page } from '@playwright/test';
import { test, expect, URLS, run, shot } from './fixtures';

const header = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
/** X-PAYMENT exactly as Shielded x402's (Kage's) client builds it: xPaymentHeader(txid, memoNonce). */
const kageHeader = (txid: string, memoNonce: string) => header({ x402Version: 1, scheme: 'zcash-shielded', network: 'zcash-testnet', payload: { txid: txid.toLowerCase(), memoNonce } });
const decode = (h: string) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
const cases = run.paywall.cases;
const merchant = run.wallets.merchant.address;

/** Chrome asks every page for /favicon.ico; the paywall is an API and answers 404 for any unknown path. */
const FAVICON = /^http:\/\/127\.0\.0\.1:842[23]\/favicon\.ico$/;

/** Opens the URL in the browser tab with an X-PAYMENT header (or none) and returns the status and JSON. */
async function open(page: Page, url: string, xPayment?: string) {
  await page.setExtraHTTPHeaders(xPayment ? { 'x-payment': xPayment } : {});
  const res = (await page.goto(url))!;
  await page.setExtraHTTPHeaders({});
  return { status: res.status(), body: JSON.parse(await page.locator('body').innerText()), headers: res.headers() };
}

test.describe('x402 paywall (:8422, fresh challenges)', () => {
  test('402 challenge → pay with a published txid → refused honestly', async ({ page, watch }, info) => {
    watch.allow({ url: /^http:\/\/127\.0\.0\.1:8422\/api\/quote$/, status: 402 });
    watch.allow({ url: /^http:\/\/127\.0\.0\.1:8422\/api\/quote$/, status: 400 });
    watch.allow({ url: FAVICON, status: 404 });

    const c402 = await open(page, `${URLS.paywall}/api/quote`);
    expect(c402.status).toBe(402);
    // An x402 v1 PaymentRequiredResponse, in the shape Shielded x402 uses for the same scheme.
    expect(c402.body.x402Version).toBe(1);
    const [c] = c402.body.accepts;
    expect(c).toMatchObject({ scheme: 'zcash-shielded', network: 'zcash-testnet', payTo: merchant, maxAmountRequired: run.paywall.priceZat, asset: 'ZEC', amountZat: run.paywall.priceZat, minConf: 1, resource: '/api/quote' });
    // A stateless memo: expiry, nonce and an HMAC; nothing is stored until a payment is presented.
    expect(c.memo).toMatch(/^zpv-\d{10}-[0-9a-f]{16}-[A-Za-z0-9_-]{22}$/);
    expect(c.extra).toEqual({ memoNonce: c.memo, expiresAt: Number(c.memo.split('-')[1]), paymentUri: c.zip321, minConf: 1 });
    const zip = new URL(c.zip321);
    expect(zip.protocol).toBe('zcash:');
    expect(zip.searchParams.get('amount')).toBe('0.0001');
    expect(Buffer.from(zip.searchParams.get('memo')!, 'base64url').toString()).toBe(c.memo);
    await page.screenshot({ path: shot('paywall-402', info.project.name) });

    // The published paywall payment carries another challenge's memo: refused, nothing served.
    const paid = await open(page, `${URLS.paywall}/api/quote`, header({ memo: c.memo, txid: cases.paywall.txid }));
    expect(paid.status).toBe(402);
    expect(paid.body.error).toBe('payment refused: MEMO_MISMATCH, AMOUNT_TOO_LOW');
    expect(paid.body.reasons).toEqual(['MEMO_MISMATCH', 'AMOUNT_TOO_LOW']);
    expect(paid.body.data).toBeUndefined();
    expect(paid.body.accepts[0].memo).toBe(c.memo);
    await page.screenshot({ path: shot('paywall-refused', info.project.name) });

    // The published memo was never issued by this paywall: unknown memo, a new challenge.
    const unknown = await open(page, `${URLS.paywall}/api/quote`, header({ memo: cases.paywall.challengeMemo, txid: cases.paywall.txid }));
    expect(unknown.status).toBe(402);
    expect(unknown.body.error).toBe('unknown or expired payment memo');
    expect(unknown.body.accepts[0].memo).not.toBe(c.memo);

    // A header that is not base64 JSON.
    const bad = await open(page, `${URLS.paywall}/api/quote`, 'not base64 json');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('X-PAYMENT is not base64 JSON {memo, txid}');
  });
});

test.describe('x402 paywall with the memo pinned to the published payment (:8423)', () => {
  test('wrong tx refused → the published payment accepted once → its replay refused', async ({ page, watch }, info) => {
    watch.allow({ url: /^http:\/\/127\.0\.0\.1:8423\/api\/quote$/, status: 402 });
    watch.allow({ url: FAVICON, status: 404 });

    const c402 = await open(page, `${URLS.replay}/api/quote`);
    expect(c402.status).toBe(402);
    const [c] = c402.body.accepts;
    expect(c.memo).toBe(cases.paywall.challengeMemo);

    // The transparent-part case pays the merchant with another memo: refused, and the claim is released.
    const wrong = await open(page, `${URLS.replay}/api/quote`, header({ memo: c.memo, txid: cases['transparent-part'].txid }));
    expect(wrong.status).toBe(402);
    expect(wrong.body.error).toMatch(/^payment refused: /);
    expect(wrong.body.reasons).toContain('MEMO_MISMATCH');

    // Presented the way Shielded x402's client presents it: the x402 v1 envelope.
    const ok = await open(page, `${URLS.replay}/api/quote`, kageHeader(cases.paywall.txid, c.memo));
    expect(ok.status).toBe(200);
    expect(ok.body.paid).toMatchObject({ txid: cases.paywall.txid, height: cases.paywall.paid.height, paidZat: 10000, memo: c.memo, lightwalletd: 'https://testnet.zec.rocks:443' });
    expect(ok.body.paid.confirmations).toBeGreaterThan(1000);
    expect(ok.body.data).toMatchObject({ path: '/api/quote', note: 'paid with a shielded Zcash payment, checked with a viewing key' });
    expect(decode(ok.headers['x-payment-response'])).toEqual({ success: true, transaction: cases.paywall.txid, network: 'zcash-testnet', payer: '' });
    await page.screenshot({ path: shot('paywall-accepted', info.project.name) });

    // The same header again: that challenge is closed, so nothing is served and a new challenge comes back.
    const again = await open(page, `${URLS.replay}/api/quote`, header({ memo: c.memo, txid: cases.paywall.txid }));
    expect(again.status).toBe(402);
    expect(again.body.error).toBe('unknown or expired payment memo');
    expect(again.body.data).toBeUndefined();
    // This paywall re-issues the same pinned memo, so the new challenge is answerable. The txid (in
    // upper case this time) is recorded as paid, so the replay is still refused.
    expect(again.body.accepts[0].memo).toBe(c.memo);
    const replay = await open(page, `${URLS.replay}/api/quote`, header({ memo: c.memo, txid: cases.paywall.txid.toUpperCase() }));
    expect(replay.status).toBe(402);
    expect(replay.body.error).toBe('this transaction already paid for a request');
    expect(replay.body.data).toBeUndefined();
    await page.screenshot({ path: shot('paywall-replay-refused', info.project.name) });
  });
});
