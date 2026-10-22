// The dashboard console against the real verify APIs. Every verdict here is computed live: the API
// runs zpay-verify against testnet.zec.rocks with the published x402 merchant viewing key, and the
// null-402 tab reads the deployed verifier and pool on Avalanche Fuji from this browser.
import type { Page } from '@playwright/test';
import { test, expect, URLS, fx, ZEC_TX, SETTLE, expectNoHorizontalScroll, expectLandedBelowBars, logButtons, isMobile, shot } from './fixtures';

const send = (page: Page) => page.getByRole('button', { name: /Send request|Checking/ });
const verdict = (page: Page) => page.locator('section.verdict');
const response = (page: Page) => page.locator('.pane.response');
const history = (page: Page) => page.locator('#history');

/**
 * Sends and waits for the answer. The button must show "Checking…" while the check runs: a request the
 * browser refuses at once (API down) can finish before a poll sees that label, so an observer installed
 * before the click records every label the button shows, and the assertion is on that record.
 */
async function sendAndWait(page: Page) {
  await send(page).evaluate((btn) => {
    const w = window as unknown as { __hankoLabels: string[] };
    w.__hankoLabels = [];
    new MutationObserver(() => w.__hankoLabels.push(btn.textContent ?? '')).observe(btn, { childList: true, subtree: true, characterData: true });
  });
  await send(page).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __hankoLabels: string[] }).__hankoLabels.some((l) => /Checking…/.test(l)))).toBe(true);
  await expect(send(page)).toHaveText(/Send request/, { timeout: 60_000 });
}

test.describe('dashboard console (verify API on :8420, one lightwalletd)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URLS.dashboard + '/');
    await expect(page.getByRole('status')).toHaveText('verify API reachable');
  });

  test('loads with honest empty states and the live endpoint in the send row', async ({ page }, info) => {
    await expect(page.getByRole('heading', { level: 1, name: 'Was I paid?' })).toBeVisible();
    await expect(page.locator('#send-note')).toHaveText('to http://127.0.0.1:8420 · one lightwalletd, testnet.zec.rocks:443');
    await expect(verdict(page)).toContainText('Nothing checked yet.');
    await expect(response(page)).toContainText('No request sent yet.');
    await expect(history(page)).toContainText('No checks yet.');
    await expect(page.getByRole('link', { name: /History/ })).toContainText('0');
    // The request pane shows the key shortened; the input holds the full published key.
    await expect(page.getByLabel('uivk', { exact: true })).toHaveValue(fx.x402.uivk);
    await expect(page.locator('.pane').first()).toContainText(`"${fx.x402.uivk.slice(0, 14)}…"`);
    await expect(page.locator('.pane').first()).not.toContainText(fx.x402.uivk);
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: shot('dash-empty', info.project.name), fullPage: false });
  });

  test('verify the published paid x402 payment: Paid seal, outputs, provenance, history', async ({ page }, info) => {
    await sendAndWait(page);
    const v = verdict(page);
    // The answer is on screen without scrolling (on a phone the verdict is below the send button).
    await expect(v.locator('.v-badge')).toBeInViewport();
    await expect(v.locator('.v-badge')).toHaveText('Paid');
    await expect(v).toContainText('0.001 TAZ reached this key with the expected memo.');
    await expect(v.locator('table').first()).toContainText(fx.x402.memo);
    await expect(v.locator('table').first()).toContainText('0.001 TAZ');
    await expect(v.getByRole('link', { name: /030c3cbf…/ })).toHaveAttribute('href', ZEC_TX + fx.x402.txid);
    await expect(v).toContainText(`block ${fx.x402.height.toLocaleString('en-US')}`);
    await expect(v).toContainText(/Checked viatestnet\.zec\.rocks at tip [\d,]+/);
    await expect(response(page).getByRole('img', { name: 'Verdict: paid' })).toBeVisible();
    await expect(response(page).locator('.status')).toHaveText(/^200 · \d+ ms$/);
    await expect(response(page).locator('pre')).toContainText('"verdict": "paid"');
    await expect(response(page).locator('pre')).toContainText('"ok": true');
    await page.screenshot({ path: shot('dash-paid', info.project.name) });
    // History is the console's log of checks.
    await expect(page.getByRole('link', { name: /History/ })).toContainText('1');
    const row = history(page).locator('li').first();
    await expect(row).toContainText('Zcash');
    await expect(row).toContainText('Paid');
    await expect(row.getByRole('link')).toHaveAttribute('href', ZEC_TX + fx.x402.txid);
    await expectNoHorizontalScroll(page);
  });

  test('wrong invoice memo: Unpaid seal and MEMO_MISMATCH in plain words', async ({ page }, info) => {
    await page.getByRole('radio', { name: /Wrong invoice memo/ }).click();
    await expect(page.getByRole('radio', { name: /Wrong invoice memo/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByLabel('memo', { exact: true })).toHaveValue('x402z-another-invoice');
    await sendAndWait(page);
    await expect(verdict(page).locator('.v-badge')).toHaveText('Not paid');
    await expect(verdict(page).locator('.reasons')).toContainText('MEMO_MISMATCH');
    await expect(verdict(page).locator('.reasons')).toContainText('none with the expected memo');
    await expect(response(page).getByRole('img', { name: 'Verdict: not paid' })).toBeVisible();
    await expect(response(page).locator('pre')).toContainText('"verdict": "refused"');
    await page.screenshot({ path: shot('dash-wrong-memo', info.project.name) });
  });

  test('wrong amount (one zat more than was paid): Unpaid, AMOUNT_TOO_LOW', async ({ page }, info) => {
    const amount = page.getByLabel('amountZat', { exact: true });
    await amount.fill(String(fx.x402.amountZat + 1));
    await expect(page.locator('.unit')).toHaveText('= 0.00100001 TAZ');
    await expect(page.locator('.pane').first()).toContainText(`"amountZat": ${fx.x402.amountZat + 1}`);
    await sendAndWait(page);
    await expect(verdict(page).locator('.v-badge')).toHaveText('Not paid');
    await expect(verdict(page).locator('.reasons')).toContainText('AMOUNT_TOO_LOW');
    await expect(verdict(page)).toContainText('Counted toward this check: 0.001 TAZ.');
    await expect(response(page).getByRole('img', { name: 'Verdict: not paid' })).toBeVisible();
    await page.screenshot({ path: shot('dash-wrong-amount', info.project.name) });
  });

  test("someone else's payment: the key sees nothing in it", async ({ page }) => {
    await page.getByRole('radio', { name: /Someone else/ }).click();
    await sendAndWait(page);
    await expect(verdict(page).locator('.v-badge')).toHaveText('Not paid');
    await expect(verdict(page).locator('.reasons')).toContainText('NO_OUTPUT_TO_KEY');
    await expect(verdict(page)).toContainText('No output in this transaction decrypts to this key.');
  });

  test('more confirmations than the chain has: Pending and the WAIT seal', async ({ page }, info) => {
    await page.getByLabel('minConf', { exact: true }).fill('100000000');
    await sendAndWait(page);
    await expect(verdict(page).locator('.v-badge')).toHaveText('Pending');
    await expect(verdict(page).locator('.reasons')).toContainText('NOT_CONFIRMED');
    await expect(verdict(page).locator('.reasons')).toContainText('Not mined deep enough yet.');
    await expect(response(page).getByRole('img', { name: 'Verdict: pending' })).toBeVisible();
    await expect(history(page).locator('li').first()).toContainText('Pending');
    await page.screenshot({ path: shot('dash-pending', info.project.name) });
  });

  test('a txid lightwalletd does not know: Not paid, TX_NOT_FOUND', async ({ page }) => {
    await page.getByLabel('txid', { exact: true }).fill('ab'.repeat(32));
    await sendAndWait(page);
    await expect(verdict(page).locator('.v-badge')).toHaveText('Not paid');
    await expect(verdict(page)).toContainText('No such transaction.');
    await expect(verdict(page).locator('.reasons')).toContainText('TX_NOT_FOUND');
  });

  test('a key that is not a viewing key: the API answers 400 and the console says so', async ({ page, watch }) => {
    watch.allow({ url: /^http:\/\/127\.0\.0\.1:8420\/api\/verify$/, status: 400 });
    await page.getByLabel('uivk', { exact: true }).fill('uivktest1notakey');
    await sendAndWait(page);
    const alert = verdict(page).getByRole('alert');
    await expect(alert).toContainText('Could not check');
    await expect(alert).not.toContainText('Setup required');
    await expect(response(page).locator('.status')).toHaveText('HTTP 400');
    await expect(response(page).locator('pre')).toContainText('"error"');
    await expect(response(page).getByRole('img', { name: /Verdict/ })).toHaveCount(0);
    await expect(history(page).locator('li').first()).toContainText('Error');
  });

  test('a malformed txid is stopped in the browser; no request is sent', async ({ page }) => {
    let calls = 0;
    page.on('request', (r) => r.url().endsWith('/api/verify') && calls++);
    await page.getByLabel('txid', { exact: true }).fill('not-a-txid');
    await send(page).click();
    expect(await page.getByLabel('txid', { exact: true }).evaluate((el: HTMLInputElement) => el.validity.patternMismatch)).toBe(true);
    await expect(verdict(page)).toContainText('Nothing checked yet.');
    expect(calls).toBe(0);
  });

  test('History (the check log): several checks listed newest first, the nav link jumps to it', async ({ page }, info) => {
    // The console has no button labelled "log"; its log of checks is History.
    await expect(logButtons(page)).toHaveCount(0);
    await sendAndWait(page);
    await page.getByRole('radio', { name: /Wrong invoice memo/ }).click();
    await sendAndWait(page);
    const link = page.getByRole('link', { name: /History/ });
    await expect(link).toContainText('2');
    await link.click();
    await expect(page).toHaveURL(/#history$/);
    await expectLandedBelowBars(page, '#h-history');
    const rows = history(page).locator('li');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Not paid');
    await expect(rows.nth(0)).toContainText('MEMO_MISMATCH');
    await expect(rows.nth(1)).toContainText('Paid');
    await page.screenshot({ path: shot('dash-history', info.project.name) });
    await page.getByRole('link', { name: 'Real payments' }).click();
    await expect(page).toHaveURL(/#evidence$/);
    await expectLandedBelowBars(page, '#h-evidence');
    const ev = page.locator('#evidence');
    await expect(ev.getByRole('link', { name: /030c3cbf/ })).toHaveAttribute('href', ZEC_TX + fx.x402.txid);
    await expect(ev.getByRole('link', { name: /06d12181/ })).toHaveAttribute('href', ZEC_TX + fx.auction.deposit.txid);
    await expect(ev.getByRole('link', { name: /0x8596f5/ })).toHaveAttribute('href', `https://testnet.snowtrace.io/tx/${SETTLE}`);
    await expectNoHorizontalScroll(page);
  });

  test('null-402 tab: the published settle() proof is valid but already spent, never Paid', async ({ page }, info) => {
    await page.getByRole('button', { name: /null-402 proof/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Is this proof a payment to me?');
    await expect(page.getByRole('status')).toHaveText('Fuji, straight from this browser');
    await expect(page.getByLabel('settle_tx')).toHaveValue(SETTLE);
    await sendAndWait(page);
    const v = verdict(page);
    await expect(v.locator('.v-badge')).toHaveText('Not paid');
    await expect(v.locator('.reasons')).toContainText('NULLIFIER_SPENT');
    await expect(v.locator('.reasons')).toContainText('UNBOUND');
    await expect(v.locator('.checks li')).toHaveText([/verifier\.verifyProof\s*true/, /pool\.knownRoot\(root\)\s*true/, /pool\.spent\(nullifier\)\s*true/]);
    await expect(response(page).getByRole('img', { name: 'Verdict: not paid' })).toBeVisible();
    await expect(response(page).locator('.status')).toHaveText(/^block [\d,]+ · \d+ ms$/);
    await page.screenshot({ path: shot('dash-null402', info.project.name) });

    // With the proof's own payee and amount the binding passes, and it is still spent.
    const signals = JSON.parse(await response(page).locator('pre').innerText()).signals;
    await page.getByLabel('expect.payTo').fill(signals.payTo);
    await page.getByLabel('expect.requiredAmount').fill(signals.requiredAmount);
    await sendAndWait(page);
    await expect(verdict(page).locator('.reasons li')).toHaveCount(1);
    await expect(verdict(page).locator('.reasons')).toContainText('NULLIFIER_SPENT');

    // Tamper: claim 10x the amount. The deployed verifier rejects the proof.
    await page.getByLabel('Claim 10× the amount the proof authorises').check();
    await expect(page.locator('.pane').first()).toContainText('with amount × 10');
    await sendAndWait(page);
    await expect(verdict(page).locator('.reasons')).toContainText('BAD_PROOF');
    await expect(verdict(page).locator('.checks li').first()).toContainText('false');
    await page.screenshot({ path: shot('dash-null402-tamper', info.project.name) });
    await expect(page.getByRole('link', { name: /History/ })).toContainText('3');
    await expect(history(page).locator('li').first()).toContainText('null-402');
    await expect(history(page).locator('li').first().getByRole('link')).toHaveAttribute('href', `https://testnet.snowtrace.io/tx/${SETTLE}`);

    // Back to the Zcash rail: the old verdict is cleared.
    await page.getByRole('button', { name: /Zcash payment/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Was I paid?');
    await expect(verdict(page)).toContainText('Nothing checked yet.');
    await expectNoHorizontalScroll(page);
  });

  test('a check in flight: the parameters are locked, and switching rail drops its answer (never a seal beside another request)', async ({ page }) => {
    await send(page).click();
    await expect(send(page)).toHaveText(/Checking…/);
    // The preset chips and inputs cannot change the request the pane shows while its answer is pending.
    const wrongMemo = page.getByRole('radio', { name: /Wrong invoice memo/ });
    await expect(wrongMemo).toBeDisabled();
    await expect(page.getByLabel('memo', { exact: true })).toBeDisabled();
    await wrongMemo.click({ force: true });
    await expect(page.getByLabel('memo', { exact: true })).toHaveValue(fx.x402.memo);
    // Switching rail mid-check abandons it: the Zcash answer must not land on the null-402 tab.
    await page.getByRole('button', { name: /null-402 proof/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Is this proof a payment to me?');
    await expect(send(page)).toHaveText(/Send request/);
    await page.waitForTimeout(4_000); // longer than the live Zcash check takes
    await expect(verdict(page)).toContainText('Nothing checked yet.');
    await expect(response(page).getByRole('img', { name: /Verdict/ })).toHaveCount(0);
    await expect(page.locator('.v-badge')).toHaveCount(0);
    await expect(history(page).locator('li')).toHaveCount(0);
  });

  test('reduced motion: the seal lands without the press animation', async ({ browser }, info) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: info.project.use.viewport, recordVideo: { dir: info.outputPath('rm-video') } });
    const page = await ctx.newPage();
    await page.goto(URLS.dashboard + '/');
    await expect(page.getByRole('status')).toHaveText('verify API reachable');
    await sendAndWait(page);
    const stamp = response(page).getByRole('img', { name: 'Verdict: paid' });
    await expect(stamp).toBeVisible();
    expect(await stamp.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    await ctx.close();
  });

  test('skip link goes to the parameters', async ({ page }, info) => {
    test.skip(isMobile(info.project.name), 'keyboard path');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to the parameters' });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#params$/);
  });
});

test.describe('dashboard on a cross-checking API with too few endpoints (:8421)', () => {
  test('Unverified badge, HOLD seal and the endpoint table; never Paid', async ({ page }, info) => {
    await page.goto(URLS.dashboardXcheck + '/');
    await expect(page.getByRole('status')).toHaveText('verify API reachable');
    await expect(page.locator('#send-note')).toHaveText('to http://127.0.0.1:8421 · cross-checks 2 lightwalletd, quorum 2');
    await sendAndWait(page);
    const v = verdict(page);
    await expect(v.locator('.v-badge')).toHaveText('Unverified');
    await expect(v).toContainText('No verdict: this payment is neither paid nor refused.');
    await expect(v.locator('.reasons')).toContainText('UNVERIFIED_QUORUM');
    await expect(v.locator('.reasons')).toContainText('Too few lightwalletd endpoints answered');
    await expect(v).toContainText('1 of 2 endpoints answered; quorum 2; no verdict.');
    const rows = v.locator('table tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('testnet.zec.rocks:443');
    await expect(rows.nth(0)).toContainText(`paid · block ${fx.x402.height.toLocaleString('en-US')}`);
    await expect(rows.nth(1)).toContainText('127.0.0.1:9');
    await expect(rows.nth(1)).toContainText('no answer: cannot connect to lightwalletd');
    await expect(response(page).getByRole('img', { name: 'Verdict: unverified' })).toBeVisible();
    await expect(response(page).getByRole('img', { name: 'Verdict: paid' })).toHaveCount(0);
    await expect(response(page).locator('pre')).toContainText('"report": null');
    await expect(page.locator('.v-badge', { hasText: /^Paid$/ })).toHaveCount(0);
    await expect(history(page).locator('li').first()).toContainText('Unverified');
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: shot('dash-hold', info.project.name) });
  });
});

test.describe('dashboard with the local verify API down (:8429)', () => {
  test('Setup required on load, "check again" re-pings, sending says Setup required', async ({ page, watch }, info) => {
    // The refused connection to the absent API is the state under test; nothing else is excused.
    watch.allow({ url: /^http:\/\/127\.0\.0\.1:8429\//, failure: /ERR_CONNECTION_REFUSED/ });
    watch.allow({ console: /Failed to load resource: net::ERR_CONNECTION_REFUSED @ http:\/\/127\.0\.0\.1:8429\// });
    await page.goto(URLS.dashboardDown + '/');
    await expect(page.getByRole('status')).toHaveText('verify API not reachable');
    const banner = page.locator('.prose > .banner');
    await expect(banner).toContainText('Setup required');
    await expect(banner).toContainText('http://127.0.0.1:8429');
    await expect(banner).toContainText('pnpm --filter @zpv/gateway api');
    await page.screenshot({ path: shot('dash-setup-required', info.project.name) });
    let pings = 0;
    page.on('request', (r) => r.url().endsWith('/api/health') && pings++);
    await banner.getByRole('button', { name: 'check again' }).click();
    await expect.poll(() => pings).toBe(1);
    await expect(page.getByRole('status')).toHaveText('verify API not reachable');
    await sendAndWait(page);
    const v = verdict(page);
    await expect(v.getByRole('alert')).toBeInViewport();
    await expect(v.getByRole('alert')).toContainText('Setup required');
    await expect(v.getByRole('alert')).toContainText('the verify API is not reachable at http://127.0.0.1:8429');
    await expect(response(page).locator('.status')).toHaveText('setup required');
    await expect(response(page).getByRole('img', { name: /Verdict/ })).toHaveCount(0);
    await expect(history(page).locator('li').first()).toContainText('Setup required');
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: shot('dash-setup-required-sent', info.project.name) });
    // The null-402 tab does not use the local API: its status is neutral, not the red "down" state.
    await page.getByRole('button', { name: /null-402 proof/ }).click();
    await expect(page.getByRole('status')).toHaveText('Fuji, straight from this browser');
    await expect(page.locator('.health')).not.toHaveClass(/health-down/);
    expect(await page.locator('.health .dot').evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgb(226, 64, 31)');
  });
});
