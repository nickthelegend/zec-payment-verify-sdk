import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';

export { URLS } from '../global-setup.ts';
export const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
/** The published payments and keys: the same files the dashboard and landing are built from. */
export const fx = JSON.parse(readFileSync(resolve(REPO_ROOT, 'fixtures/testnet.json'), 'utf8'));
export const run = JSON.parse(readFileSync(resolve(REPO_ROOT, 'deployments/testnet.json'), 'utf8'));
export const REPO = 'https://github.com/nickthelegend/zec-payment-verify-sdk';
export const ZEC_TX = 'https://testnet.zecblock.com/tx/';
/** The hosted verify API on the VPS (Zcash testnet, one lightwalletd). */
export const HOSTED_API = 'https://hanko-api.201-18-198-162.sslip.io';
export const SETTLE = '0x8596f52de2d8c15680c96a0fa25b1bb5073324155f586203507cddf92f5ca593';
/** Every mined txid this project publishes. A link to an explorer must name one of these. */
export const PUBLISHED_TXIDS = new Set<string>([
  fx.x402.txid,
  fx.auction.deposit.txid,
  fx.auction.memoMismatch.txid,
  run.fundTx,
  ...Object.values(run.paywall.cases).map((c: any) => c.txid),
  ...JSON.stringify(run).match(/\b[0-9a-f]{64}\b/g)!,
]);

type Allowed = { url: RegExp; status: number } | { url: RegExp; failure: RegExp } | { console: RegExp };
const LOCAL = /^http:\/\/127\.0\.0\.1:(84\d\d|519\d)\//;

/**
 * Every test gets a `watch` that records console errors, page errors, failed requests and HTTP errors
 * to the page's own origin and to the local stack (the verify APIs), and asserts at the end that there
 * were none. A test may `allow()` exactly the failure that is the product's honest answer (a 402
 * challenge, the refused connection of the API-down state). Nothing else is excused.
 */
export const test = base.extend<{ watch: { allow: (a: Allowed) => void } }>({
  watch: [
    async ({ page }, use, testInfo) => {
      const allowed: Allowed[] = [];
      const problems: string[] = [];
      const ours = (url: string) => {
        try {
          return LOCAL.test(url) || new URL(url).origin === new URL(page.url()).origin;
        } catch {
          return false;
        }
      };
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const text = `${m.text()} @ ${m.location().url || ''}`;
        if (allowed.some((a) => 'console' in a && a.console.test(text))) return;
        const st = /status of (\d{3})/.exec(m.text());
        if (st && allowed.some((a) => 'status' in a && a.status === Number(st[1]) && a.url.test(m.location().url || ''))) return;
        problems.push(`console.error: ${text}`);
      });
      page.on('requestfailed', (r) => {
        if (!ours(r.url())) return;
        const why = r.failure()?.errorText || '';
        if (why === 'net::ERR_ABORTED') return;
        if (allowed.some((a) => 'failure' in a && a.url.test(r.url()) && a.failure.test(why))) return;
        problems.push(`requestfailed: ${r.method()} ${r.url()} ${why}`);
      });
      page.on('response', (r) => {
        if (!ours(r.url()) || r.status() < 400) return;
        if (allowed.some((a) => 'status' in a && a.status === r.status() && a.url.test(r.url()))) return;
        problems.push(`HTTP ${r.status()}: ${r.request().method()} ${r.url()}`);
      });
      await use({ allow: (a) => allowed.push(a) });
      if (problems.length) await testInfo.attach('problems', { body: problems.join('\n') });
      expect(problems, 'console errors / failed requests to the page or the local stack').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** No horizontal page scroll (the 375 px check). */
export async function expectNoHorizontalScroll(page: Page) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw, `page scrollWidth ${sw} > clientWidth ${cw}`).toBeLessThanOrEqual(cw);
}

/** The element is visible below the sticky bars (an anchor jump landed and nothing covers it). */
export async function expectLandedBelowBars(page: Page, selector: string) {
  await expect
    .poll(
      async () =>
        page.evaluate((sel) => {
          const el = document.querySelector(sel)!;
          const r = el.getBoundingClientRect();
          // The lowest sticky bar (top bar, or the mobile nav strip under it).
          const bars = [...document.querySelectorAll<HTMLElement>('.top, .side')].map((b) => b.getBoundingClientRect()).filter((b) => b.top <= 1 + 60 && b.height < innerHeight / 2);
          const covered = Math.max(0, ...bars.map((b) => b.bottom));
          return r.top >= covered - 2 && r.top < innerHeight * 0.6;
        }, selector),
      { message: `${selector} scrolled into view below the sticky bars` },
    )
    .toBe(true);
}

/** Buttons (role=button) whose accessible name contains "log". */
export function logButtons(page: Page) {
  return page.getByRole('button', { name: /log/i });
}

export const isMobile = (name: string) => name === 'mobile';
/** Key screenshots for the report (HANKO_SHOTS, default e2e/shots). */
export const SHOTS = process.env.HANKO_SHOTS ?? resolve(REPO_ROOT, 'e2e/shots');
export const shot = (name: string, project: string) => resolve(SHOTS, `${name}-${project}.png`);
