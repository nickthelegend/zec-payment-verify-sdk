// The landing (packages/landing/index.html), the way a reader uses it: left nav, centre docs, dark
// request/response panes, the seal, language tabs, copy buttons, the jump filter and every link.
import { test, expect, URLS, fx, run, REPO, ZEC_TX, SETTLE, PUBLISHED_TXIDS, expectNoHorizontalScroll, expectLandedBelowBars, logButtons, isMobile, shot } from './fixtures';

const SECTIONS = ['overview', 'quickstart', 'zcash', 'crosscheck', 'reasons', 'null402', 'paywall', 'api', 'mcp', 'evidence', 'tests', 'trust'];

test.describe('landing', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URLS.landing + '/');
    await expect(page.getByRole('heading', { level: 1, name: 'Was I paid?' })).toBeVisible();
  });

  test('loads: hero, facts, no horizontal scroll, no "log" button', async ({ page }, info) => {
    await expect(page).toHaveTitle('Hanko API reference');
    await expect(page.locator('.lede')).toContainText('incoming viewing key');
    await expect(page.locator('.facts')).toContainText('UIVK only (no spend key)');
    await expectNoHorizontalScroll(page);
    // Nick: "Can't use the log button". The landing has no button whose label contains "log".
    await expect(logButtons(page)).toHaveCount(0);
    await page.screenshot({ path: shot('landing-hero', info.project.name) });
  });

  test('left nav: every link jumps to its section below the sticky bars and is the one highlighted', async ({ page }, info) => {
    const nav = page.locator('#toc');
    await expect(nav.locator('a')).toHaveCount(SECTIONS.length);
    for (const id of SECTIONS) {
      const link = nav.locator(`a[href="#${id}"]`);
      await link.click();
      await expect(page).toHaveURL(new RegExp(`#${id}$`));
      await expectLandedBelowBars(page, `#${id}`);
      await expect(link, `#${id} highlighted after clicking it`).toHaveAttribute('aria-current', 'true');
      await expect(nav.locator('a[aria-current="true"]')).toHaveCount(1);
      if (isMobile(info.project.name)) await expect(link).toBeInViewport();
    }
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: shot('landing-nav-trust', info.project.name) });
  });

  test('scrolling by hand moves the highlight (scroll-spy)', async ({ page }) => {
    await page.locator('#null402').scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollTo(0, document.getElementById('null402')!.offsetTop - 70));
    await expect(page.locator('#toc a[href="#null402"]')).toHaveAttribute('aria-current', 'true');
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.locator('#toc a[href="#overview"]')).toHaveAttribute('aria-current', 'true');
  });

  test('jump filter: type, Enter jumps, no match message, Escape clears, "/" focuses', async ({ page }, info) => {
    test.skip(isMobile(info.project.name), 'the jump box is hidden below 900 px by design');
    const jump = page.getByRole('searchbox', { name: 'Filter the sections' });
    await page.keyboard.press('/');
    await expect(jump).toBeFocused();
    await jump.fill('cross');
    await expect(page.locator('#toc li:not([hidden]) a')).toHaveText([/Cross-check/]);
    await jump.press('Enter');
    await expect(page).toHaveURL(/#crosscheck$/);
    await expectLandedBelowBars(page, '#crosscheck');
    await jump.fill('zzz');
    await expect(page.locator('#toc-empty')).toBeVisible();
    await expect(page.locator('#toc-empty')).toHaveText('No section matches.');
    await jump.focus();
    await jump.press('Escape');
    await expect(jump).toHaveValue('');
    await expect(page.locator('#toc li:not([hidden]) a')).toHaveCount(SECTIONS.length);
    await expect(page.locator('#toc-empty')).toBeHidden();
  });

  test('language tabs: click and arrow keys switch every pane, and the choice survives a reload', async ({ page }) => {
    const tabs = page.getByRole('tablist', { name: 'Language' }).first();
    const shown = () => page.locator('pre[data-lang]:not([hidden])').first().getAttribute('data-lang');
    await tabs.getByRole('tab', { name: 'Rust' }).click();
    await expect(tabs.getByRole('tab', { name: 'Rust' })).toHaveAttribute('aria-selected', 'true');
    expect(await shown()).toBe('rust');
    await expect(page.locator('pre[data-lang="rust"]').first()).toContainText('zpay_verify');
    await tabs.getByRole('tab', { name: 'CLI' }).click();
    expect(await shown()).toBe('cli');
    await expect(page.locator('pre[data-lang="cli"]').first()).toContainText('exit 0 = paid');
    await tabs.getByRole('tab', { name: 'CLI' }).press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'TypeScript' })).toBeFocused();
    expect(await shown()).toBe('ts');
    await tabs.getByRole('tab', { name: 'TypeScript' }).press('ArrowLeft');
    expect(await shown()).toBe('cli');
    await page.reload();
    expect(await shown()).toBe('cli');
    await expect(page.getByRole('tablist', { name: 'Language' }).first().getByRole('tab', { name: 'CLI' })).toHaveAttribute('aria-selected', 'true');
  });

  test('the seal presses once when its spot on the response is on screen', async ({ page }, info) => {
    const seal = page.locator('#seal');
    if (isMobile(info.project.name)) {
      // Scroll only until the seal's corner of the (long) response pane shows at the bottom of the screen.
      await page.evaluate(() => {
        const r = document.getElementById('seal-pane')!.getBoundingClientRect();
        window.scrollBy(0, r.top + 200 - innerHeight + 10);
      });
    }
    // On desktop the response is beside the hero: the seal presses without any scrolling.
    await expect(seal).toHaveClass(/\bland\b/);
    await expect(seal).not.toHaveClass(/\barmed\b/);
    await expect.poll(() => seal.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.94');
    expect(await seal.evaluate((el) => getComputedStyle(el).animationName)).toBe('press');
    await page.screenshot({ path: shot('landing-seal', info.project.name) });
    // Scroll away and back: it does not press again.
    await page.locator('#trust').scrollIntoViewIfNeeded();
    await page.locator('#seal-pane').scrollIntoViewIfNeeded();
    expect(await seal.getAttribute('class')).toBe('seal land');
  });

  test('reduced motion: the seal is already down, no animation', async ({ browser }, info) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: info.project.use.viewport, recordVideo: { dir: info.outputPath('rm-video') } });
    const page = await ctx.newPage();
    await page.goto(URLS.landing + '/');
    const seal = page.locator('#seal');
    await expect(seal).not.toHaveClass(/\barmed\b/);
    expect(await seal.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    expect(await seal.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.94');
    expect(await page.locator('#seal .bleed').evaluate((el) => getComputedStyle(el).display)).toBe('none');
    await ctx.close();
  });

  test('copy buttons: every code pane copies exactly what it shows', async ({ page, context }, info) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: URLS.landing });
    const panes = page.locator('.pane');
    const n = await panes.count();
    expect(n).toBeGreaterThan(15);
    for (let i = 0; i < n; i++) {
      const pane = panes.nth(i);
      const btn = pane.locator('.pane-head').getByRole('button', { name: /^Copy/ });
      await expect(btn, `pane ${i} has a copy button`).toHaveCount(1);
      const pre = pane.locator('pre:not([hidden])').first();
      await btn.scrollIntoViewIfNeeded();
      // Not clipped by the pane (375 px), and not overlapping the pane's title.
      const [bb, pb, tb] = [await btn.boundingBox(), await pane.boundingBox(), await pane.locator('.pane-title').boundingBox()];
      expect(bb!.x + bb!.width, `pane ${i} copy button inside the pane`).toBeLessThanOrEqual(pb!.x + pb!.width - 4);
      expect(bb!.x, `pane ${i} copy button clear of the title`).toBeGreaterThanOrEqual(tb!.x + tb!.width);
      await btn.click();
      await expect(btn).toHaveText('Copied');
      const want = (await pre.innerText()).trim();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(want);
      if (i === 0) await page.screenshot({ path: shot('landing-copied', info.project.name) });
    }
    // The button goes back to "Copy".
    await expect(panes.first().locator('.pane-head').getByRole('button', { name: /^Copy/ })).toHaveText('Copy', { timeout: 4000 });
    // The shown language is the one copied.
    await page.getByRole('tablist', { name: 'Language' }).first().getByRole('tab', { name: 'Rust' }).click();
    await panes.first().locator('.pane-head').getByRole('button', { name: /^Copy/ }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('use zpay_verify::{verify, Expect};');
  });

  test('cross-check section: options, a real three-endpoint answer, no verdict', async ({ page }, info) => {
    await page.locator('#toc a[href="#crosscheck"]').click();
    const sec = page.locator('#crosscheck');
    await expect(sec.getByRole('heading', { name: 'Cross-check lightwalletd' })).toBeVisible();
    await expect(sec).toContainText('ZPV_LWD_URLS');
    const resp = sec.locator('[data-json="crosscheck"]');
    await expect(resp).toContainText('"verdict": "unverified"');
    await expect(resp).toContainText('UNVERIFIED_DISAGREEMENT');
    await expect(resp).toContainText('"report": null');
    for (const host of ['testnet.zec.rocks:443', 'zec.rocks:443', 'zaino.testnet.unsafe.zec.rocks:443']) await expect(resp).toContainText(host);
    await expect(sec.locator('.status')).toHaveText('unverified');
    await page.screenshot({ path: shot('landing-crosscheck', info.project.name) });
  });

  test('every link: anchors resolve, explorer links name published txids, repo links are this repo', async ({ page }) => {
    const hrefs = await page.locator('a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href')!));
    expect(hrefs.length).toBeGreaterThan(25);
    for (const h of hrefs) {
      if (h.startsWith('#')) {
        expect(await page.locator(h).count(), `anchor ${h} has a target`).toBe(1);
      } else if (h.startsWith(ZEC_TX)) {
        expect(PUBLISHED_TXIDS.has(h.slice(ZEC_TX.length)), `${h} is a published txid`).toBe(true);
      } else if (h.startsWith('https://testnet.snowtrace.io/tx/')) {
        expect(h).toBe(`https://testnet.snowtrace.io/tx/${SETTLE}`);
      } else {
        expect(h, 'the console beside it, or this repo').toMatch(new RegExp(`^(dashboard/|${REPO.replace(/\./g, '\\.')})$`));
      }
    }
    // The evidence table's labels are the first8…last4 of the txid they link to.
    for (const a of await page.locator('#evidence a.tx').all()) {
      const t = (await a.getAttribute('href'))!.slice(ZEC_TX.length);
      await expect(a).toHaveText(`${t.slice(0, 8)}…${t.slice(-4)}`);
    }
    // The paywall receipt is the real one from the run record.
    await expect(page.locator('[data-json="receipt"]')).toContainText(run.paywall.cases.paywall.txid);
    await expect(page.locator('[data-json="x402ok"]')).toContainText(fx.x402.txid);
  });

  test('the Dashboard link opens the running console (the GitHub Pages layout): it opens on null-402, which answers live from Fuji; the Zcash tab says Setup required', async ({ page, watch }, info) => {
    // On Pages there is no verify API: the console looks for one on the reader's machine only once the
    // Zcash tab is opened. Its refused connection is the honest "Setup required" state, nothing else is excused.
    watch.allow({ url: /^http:\/\/127\.0\.0\.1:8403\//, failure: /ERR_CONNECTION_REFUSED/ });
    watch.allow({ console: /Failed to load resource: net::ERR_CONNECTION_REFUSED @ http:\/\/127\.0\.0\.1:8403\// });
    await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
    await expect(page).toHaveURL(`${URLS.landing}/dashboard/`);
    await expect(page.getByRole('heading', { level: 1, name: 'Is this proof a payment to me?' })).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('Fuji, straight from this browser');
    const send = page.getByRole('button', { name: /Send request|Checking/ });
    await send.click();
    await expect(send).toHaveText(/Send request/, { timeout: 60_000 });
    const reasons = page.locator('section.verdict .reasons');
    await expect(reasons).toContainText('NULLIFIER_SPENT');
    await expect(reasons).toContainText('UNBOUND');
    await page.screenshot({ path: shot('pages-dashboard-null402', info.project.name) });
    await page.getByLabel('Claim 10× the amount the proof authorises').check();
    await send.click();
    await expect(send).toHaveText(/Send request/, { timeout: 60_000 });
    await expect(reasons).toContainText('BAD_PROOF');
    await page.getByRole('button', { name: /Zcash payment/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Was I paid?' })).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('verify API not reachable');
    await expect(page.locator('.prose > .banner')).toContainText('Setup required');
    await expectNoHorizontalScroll(page);
  });

  test('brand, skip link and footer links', async ({ page }, info) => {
    await page.locator('#toc a[href="#trust"]').click();
    await page.getByRole('link', { name: 'Hanko, back to the overview' }).click();
    await expect(page).toHaveURL(/#overview$/);
    await expect(page.getByRole('heading', { level: 1 })).toBeInViewport();
    if (!isMobile(info.project.name)) {
      await page.reload();
      await page.keyboard.press('Tab');
      const skip = page.getByRole('link', { name: 'Skip to the reference' });
      await expect(skip).toBeFocused();
      await expect(skip).toBeInViewport();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/#overview$/);
    }
    const foot = page.locator('.foot');
    await expect(foot).toContainText('Copyright (c) 2026 Nivesh Gajengi');
    await expect(foot.getByRole('link', { name: 'source' })).toHaveAttribute('href', REPO);
    await expectNoHorizontalScroll(page);
  });
});
