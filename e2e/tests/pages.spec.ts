// The hosted console as GitHub Pages serves it (scripts/build-pages.sh, served on :5193 by the stack).
// On Pages no verify API runs on the reader's machine, so the first screen must be a check that works
// from the browser (the null-402 tab, live from Fuji), not a red error; the Zcash tab says exactly how to
// start the API and shows real recorded output, labelled as recorded.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, URLS, fx, SETTLE, REPO_ROOT, expectNoHorizontalScroll, shot } from './fixtures';

const recorded = JSON.parse(readFileSync(resolve(REPO_ROOT, 'fixtures/console-recorded.json'), 'utf8'));

const LOCAL_API = 'http://127.0.0.1:8403';

test.describe('hosted console (GitHub Pages build)', () => {
  test('first screen: the null-402 check, working, with no error and no request to a local API', async ({ page }, info) => {
    const local: string[] = [];
    page.on('request', (r) => r.url().startsWith(LOCAL_API) && local.push(r.url()));
    await page.goto(`${URLS.landing}/dashboard/`);
    await expect(page.getByRole('heading', { level: 1, name: 'Is this proof a payment to me?' })).toBeVisible();
    await expect(page.getByRole('button', { name: /null-402 proof/ })).toHaveAttribute('aria-current', 'true');
    await expect(page.getByRole('status')).toHaveText('Fuji, straight from this browser');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText('Setup required')).toHaveCount(0);
    await expect(page.getByLabel('settle_tx')).toHaveValue(SETTLE);
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: shot('pages-first-screen', info.project.name) });
    const send = page.getByRole('button', { name: /Send request|Checking/ });
    await send.click();
    await expect(send).toHaveText(/Send request/, { timeout: 60_000 });
    const reasons = page.locator('section.verdict .reasons');
    await expect(reasons).toContainText('NULLIFIER_SPENT');
    await expect(page.locator('section.verdict .checks')).toContainText('verifier.verifyProof');
    // Nothing asked the reader's machine for an API (on a public site Chrome would prompt for local-network access).
    expect(local).toEqual([]);
  });

  test('Zcash tab: Setup required with the exact command and the local-network prompt, beside recorded real output labelled not live', async ({ page, watch }, info) => {
    watch.allow({ url: /^http:\/\/127\.0\.0\.1:8403\//, failure: /ERR_CONNECTION_REFUSED/ });
    watch.allow({ console: /Failed to load resource: net::ERR_CONNECTION_REFUSED @ http:\/\/127\.0\.0\.1:8403\// });
    await page.goto(`${URLS.landing}/dashboard/`);
    await page.getByRole('button', { name: /Zcash payment/ }).click();
    await expect(page.getByRole('status')).toHaveText('verify API not reachable');
    const banner = page.locator('.prose > .banner');
    await expect(banner).toContainText('Setup required');
    await expect(banner.locator('code.cmd')).toHaveText(`ZPV_CORS=${URLS.landing} pnpm --filter @zpv/gateway api`);
    await expect(banner).toContainText('local network');
    // The recorded answer for the selected example, labelled, with when and where it was recorded.
    const rec = page.locator('[data-recorded]');
    await expect(rec).toContainText('Recorded output, not live');
    await expect(rec).toContainText(recorded.recordedAt.slice(0, 10));
    await expect(rec.locator('.v-badge')).toHaveText('Paid');
    await expect(rec).toContainText(fx.x402.memo);
    const pane = page.locator('.pane.response');
    await expect(pane).toContainText('Recorded output, not live');
    await expect(pane.locator('pre')).toContainText('"verdict": "paid"');
    await expect(pane.locator('pre')).toContainText(`"confirmations": ${recorded.samples[0].response.report.confirmations}`);
    // A recorded answer is not a verdict: no seal.
    await expect(page.locator('.stamp')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: shot('pages-zcash-recorded', info.project.name) });
    await page.getByRole('radio', { name: /Wrong invoice memo/ }).click();
    await expect(rec.locator('.reasons')).toContainText('MEMO_MISMATCH');
    // Parameters that were never recorded get no recorded answer.
    await page.getByLabel('amountZat').fill('123');
    await expect(rec).toContainText('No recorded output for these parameters');
    await expect(pane.locator('pre')).toHaveCount(0);
  });
});
