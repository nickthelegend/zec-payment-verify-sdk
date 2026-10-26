import { createRequire } from 'node:module';
import { writeFile, readFile, mkdir, mkdtemp, cp, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../../e2e/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const root = process.cwd(), dir = 'audit/browser-reference';
const ids = [...Array.from({ length: 12 }, (_, i) => `PAGE-${String(i + 9).padStart(3, '0')}`), 'EDGE-014', 'EDGE-016', 'EDGE-019'];
const requested = process.argv.slice(2);
assert(requested.every(id => ids.includes(id)), 'only assigned rows may run');
const selected = requested.length ? requested : ids;
await mkdir(dir, { recursive: true });
await mkdir('audit/status', { recursive: true });
let results = ids.map(id => ({ id, status: 'PENDING', evidence: [], fix: '' }));
try { results = JSON.parse(await readFile('audit/status/browser-reference.json', 'utf8')); } catch {}
const persist = () => writeFile('audit/status/browser-reference.json', JSON.stringify(results, null, 2) + '\n');
await persist();
const clean = value => String(value).replace(/(?:uivk(?:test)?1|u(?:fvk|view)(?:test)?1)[a-z0-9]+/gi, '[REDACTED]').slice(0, 1200);
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const processes = [];
let browser, chrome, staticServer, temp;
const manifest = { started: new Date().toISOString(), runnerPid: process.pid, channel: 'chrome', headless: true, video: false, trace: false, rowTimeoutMs: 90000, processes };
const saveManifest = () => writeFile(`${dir}/session.json`, JSON.stringify(manifest, null, 2) + '\n');
const spawnTracked = (label, command, args, options = {}) => {
  const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const entry = { label, pid: child.pid }; processes.push(entry);
  child.once('exit', (code, signal) => Object.assign(entry, { exited: true, code, signal }));
  return child;
};
const killPid = async child => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  await Promise.race([new Promise(res => child.once('exit', res)), new Promise(res => setTimeout(res, 2000))]);
  if (child.exitCode === null && child.signalCode === null) { try { process.kill(child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
};
try {
  // Build only the client console. envDir:false prevents Vite from reading any .env files.
  // Public fixtures are bundled by Vite; their contents are never inspected or logged here.
  temp = await mkdtemp(join(tmpdir(), 'hanko-reference-'));
  const viteConfig = join(root, 'packages/dashboard/.reference-audit.config.mjs');
  await writeFile(viteConfig, `import react from '@vitejs/plugin-react';\nexport default {envDir:false,plugins:[react()],resolve:{alias:{'@fixtures':${JSON.stringify(join(root, 'fixtures'))},'@deployments':${JSON.stringify(join(root, 'deployments'))}}},define:{'import.meta.env.VITE_ZPV_PAGES':'"1"','import.meta.env.VITE_ZPV_API':'undefined'}};\n`);
  try {
    const build = spawnTracked('Pages client build', process.execPath, ['packages/dashboard/node_modules/vite/bin/vite.js', 'build', 'packages/dashboard', '--config', viteConfig, '--base', './', '--outDir', join(temp, 'dashboard'), '--emptyOutDir', '--logLevel', 'warn']);
    let error = ''; build.stderr.on('data', d => { error += d.toString(); });
    const code = await new Promise(res => build.once('exit', res));
    if (code !== 0) throw new Error(`client build failed: ${clean(error)}`);
  } finally { await rm(viteConfig, { force: true }); }
  await cp('packages/landing/reference.html', join(temp, 'reference.html'));
  const port = await freePort(), pagesPort = await freePort();
  staticServer = spawnTracked('static server', process.execPath, ['e2e/serve-static.mjs', `${port}:packages/landing`, `${pagesPort}:${temp}`]);
  await new Promise((res, rej) => { staticServer.stdout.once('data', res); staticServer.once('error', rej); });
  manifest.urls = { live: 'https://hanko-landing-six.vercel.app/reference.html', local: `http://127.0.0.1:${port}/reference.html`, pages: `http://127.0.0.1:${pagesPort}/reference.html` };
  chrome = await chromium.launchServer({ channel: 'chrome', headless: true });
  const chromeProcess = chrome.process();
  const chromeEntry = { label: 'Chrome', pid: chromeProcess.pid }; processes.push(chromeEntry);
  chromeProcess.once('exit', (code, signal) => Object.assign(chromeEntry, { exited: true, code, signal }));
  browser = await chromium.connect(chrome.wsEndpoint());
  manifest.browser = browser.version(); await saveManifest();
  console.log(`Chrome ${browser.version()}; runner PID ${process.pid}; server PID ${staticServer.pid}; Chrome PID ${chromeProcess.pid}`);
  for (const id of selected) {
    const row = results.find(r => r.id === id), attempt = row.evidence.length + 1;
    const ev = { id, attempt, at: new Date().toISOString(), browser: browser.version(), checks: [], surfaces: [], console: [], pageErrors: [], network: [], requestFailures: [], errors: [], screenshots: [] };
    let context, page, surface, cancelled = false;
    const ensure = (ok, check, actual) => { ev.checks.push({ surface, check, pass: !!ok, ...(actual === undefined ? {} : { actual }) }); assert(ok, check); };
    const open = async (name, options = {}, init) => {
      if (cancelled) throw new Error('row cancelled');
      if (context) await context.close();
      surface = name;
      context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference', ...options });
      if (init) await context.addInitScript(init);
      page = await context.newPage(); page.setDefaultTimeout(4500); page.setDefaultNavigationTimeout(18000);
      page.on('console', m => ev.console.push({ surface: name, type: m.type(), text: clean(m.text()) }));
      page.on('pageerror', e => ev.pageErrors.push({ surface: name, message: clean(e.message) }));
      page.on('response', r => ev.network.push({ surface: name, url: clean(r.url()), status: r.status(), resourceType: r.request().resourceType() }));
      page.on('requestfailed', r => ev.requestFailures.push({ surface: name, url: clean(r.url()), error: clean(r.failure()?.errorText) }));
      const response = await page.goto(manifest.urls[name], { waitUntil: 'load' });
      ensure(response.status() === 200, 'reference HTTP 200', response.status());
      await page.locator('.copy').first().waitFor({ state: 'attached' });
      await page.evaluate(() => document.fonts.ready);
      ev.surfaces.push({ surface: name, url: manifest.urls[name], viewport: page.viewportSize(), reducedMotion: options.reducedMotion || 'no-preference' });
    };
    const each = async (fn, options, init) => { for (const name of ['live', 'local']) { try { await open(name, options, init); await fn(name); } catch (e) { ev.errors.push({ surface: name, message: clean(e.message) }); } } };
    const screenshot = async suffix => {
      const path = `${dir}/${id}-${surface}-${suffix}-${attempt}.jpg`;
      const buffer = await page.screenshot({ type: 'jpeg', quality: 42, fullPage: false });
      ensure(buffer.length <= 200000, 'screenshot <=200 KB', buffer.length);
      await writeFile(path, buffer); ev.screenshots.push(path);
    };
    const selectedLink = hash => page.locator(`#toc a[href="#${hash}"]`);
    const belowBars = async hash => {
      const rect = await page.locator(`#${hash}`).evaluate(el => {
        const top = document.querySelector('.top').getBoundingClientRect().bottom;
        const nav = document.querySelector('.side').getBoundingClientRect();
        return { y: el.getBoundingClientRect().top, bars: innerWidth <= 900 ? Math.max(top, nav.bottom) : top, height: innerHeight };
      });
      ensure(rect.y >= rect.bars - 1 && rect.y < rect.height, `#${hash} exposed below sticky bars`, rect);
    };
    const navigate = async hash => {
      await selectedLink(hash).click();
      await expect(page).toHaveURL(new RegExp(`#${hash}$`));
      await belowBars(hash);
      await expect(selectedLink(hash)).toHaveAttribute('aria-current', 'true');
      ensure(await page.locator('#toc a[aria-current="true"]').count() === 1, 'exactly one current section');
    };
    const task = async () => {
      if (id === 'PAGE-009') await each(async () => {
        ensure(await page.title() === 'Hanko API reference', 'exact title');
        ensure(await page.locator('h1').innerText() === 'Was I paid?', 'exact h1');
        ensure((await page.locator('.facts').innerText()).includes('UIVK only (no spend key)'), 'exact key-needed fact');
        ensure(await page.locator('#api a[href="https://hanko-api.201-18-198-162.sslip.io/api/health"]').count() === 1, 'hosted API linked');
        ensure(!(await page.locator('.blocked').allTextContents()).some(t => /hosted.*api/i.test(t)), 'hosted API not marked blocked');
        await screenshot('overview');
      });
      if (id === 'PAGE-010') await each(async () => {
        ensure(await page.locator('#toc a').count() === 12, 'all 12 section links');
        for (const hash of ['overview','quickstart','zcash','crosscheck','reasons','null402','paywall','api','mcp','evidence','tests','trust']) await navigate(hash);
        await screenshot('trust');
      });
      if (id === 'PAGE-011') {
        const spy = async () => {
          await page.evaluate(() => window.scrollTo(0, document.getElementById('null402').offsetTop - (innerWidth <= 900 ? 130 : 76)));
          await expect(selectedLink('null402')).toHaveAttribute('aria-current', 'true');
          if (page.viewportSize().width <= 900) {
            const b = await selectedLink('null402').boundingBox();
            ensure(b.x >= 0 && b.x + b.width <= 375, 'selected mobile section scrolled into view', b);
          }
          await page.evaluate(() => scrollTo(0, 0));
          await expect(selectedLink('overview')).toHaveAttribute('aria-current', 'true');
          await screenshot(page.viewportSize().width <= 900 ? 'mobile-spy' : 'spy');
        };
        await each(spy); await each(spy, { viewport: { width: 375, height: 812 } });
      }
      if (id === 'PAGE-012') await each(async () => {
        const jump = page.getByRole('searchbox', { name: 'Filter the sections' });
        await page.keyboard.press('/'); await expect(jump).toBeFocused();
        await jump.fill('cross');
        const shown = await page.locator('#toc li:not([hidden]) a').allTextContents();
        ensure(shown.length === 1 && shown[0].includes('Cross-check'), 'cross leaves only Cross-check visible', shown);
        await jump.press('Enter'); await expect(page).toHaveURL(/#crosscheck$/); await belowBars('crosscheck');
        await screenshot('cross');
      });
      if (id === 'PAGE-013') await each(async () => {
        const jump = page.getByRole('searchbox', { name: 'Filter the sections' });
        await jump.fill('zzz'); await expect(page.locator('#toc-empty')).toHaveText('No section matches.');
        await expect(page.locator('#toc-empty')).toBeVisible();
        const before = page.url(); await jump.press('Enter'); ensure(page.url() === before, 'Enter with no match leaves location unchanged');
        await screenshot('empty');
        await jump.press('Escape'); await expect(jump).toHaveValue('');
        ensure(await page.locator('#toc li:not([hidden]) a').count() === 12, 'Escape restores all 12 links');
      });
      if (id === 'PAGE-014') await each(async () => {
        const tabs = page.locator('[data-tabs]').first();
        const checkLanguage = async lang => {
          const actual = await page.locator('[data-tabs]').evaluateAll((all, lang) => all.every(t => [...t.querySelectorAll('button')].every(b => b.getAttribute('aria-selected') === String(b.dataset.l === lang))), lang);
          ensure(actual, `all tabs aria-selected ${lang}`);
          ensure(await page.locator('pre[data-lang]').evaluateAll((all, lang) => all.every(p => p.hidden === (p.dataset.lang !== lang)), lang), `all panes switch to ${lang}`);
        };
        for (const lang of ['ts','rust','cli']) { await tabs.locator(`[data-l="${lang}"]`).click(); await checkLanguage(lang); }
        await tabs.locator('[data-l="cli"]').press('ArrowRight'); await checkLanguage('ts'); await expect(tabs.locator('[data-l="ts"]')).toBeFocused();
        await tabs.locator('[data-l="ts"]').press('ArrowLeft'); await checkLanguage('cli'); await expect(tabs.locator('[data-l="cli"]')).toBeFocused();
        await page.reload(); await checkLanguage('cli'); await screenshot('cli');
      });
      if (id === 'PAGE-015') await each(async () => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
        const panes = page.locator('.pane'); ensure(await panes.count() > 15, 'all code panes present', await panes.count());
        for (const lang of ['ts','rust','cli']) {
          await page.locator(`[data-tabs] [data-l="${lang}"]`).first().click();
          for (let i = 0; i < await panes.count(); i++) {
            const pane = panes.nth(i), b = pane.locator('.copy');
            ensure(await b.count() === 1, `pane ${i} has exactly one Copy button`);
            const pre = pane.locator('pre:not([hidden])').first();
            const want = (await pre.innerText()).trim();
            await b.click(); await expect(b).toHaveText('Copied');
            const copied = await page.evaluate(() => navigator.clipboard.readText());
            ensure(copied === want, `pane ${i} copies exact trimmed visible ${lang} text`);
          }
        }
        const b = panes.last().locator('.copy'); await screenshot('copied');
        await expect(b).toHaveText('Copy', { timeout: 2400 });
        ensure(true, 'Copied resets to Copy after the 1600 ms timer');
      });
      if (id === 'PAGE-016') await each(async () => {
        const b = page.locator('.copy').first();
        const want = (await page.locator('.pane').first().locator('pre:not([hidden])').innerText()).trim();
        await b.click(); await expect(b).toHaveText('Copied');
        ensure(await page.evaluate(() => window.__legacy.trim()) === want, 'clipboard rejection offers selected pane through legacy copy');
        await page.evaluate(() => window.__legacyOK = false);
        await b.click(); await expect(b).toHaveText('Selected, press Ctrl+C');
        ensure(await page.evaluate(() => getSelection().toString().trim()) === want, 'both failures leave pane text selected');
        await screenshot('fallback'); await expect(b).toHaveText('Copy', { timeout: 2400 });
      }, {}, () => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('intentional clipboard denial'); } } });
        window.__legacyOK = true;
        document.execCommand = command => { if (command === 'copy') { window.__legacy = getSelection().toString(); return window.__legacyOK; } return false; };
      });
      if (id === 'PAGE-017') await each(async () => {
        const seal = page.locator('#seal');
        await expect(seal).toHaveClass('seal land');
        await expect.poll(() => seal.evaluate(el => getComputedStyle(el).opacity)).toBe('0.94');
        ensure(await seal.evaluate(el => getComputedStyle(el).animationName) === 'press', 'seal press animation');
        const before = await seal.evaluate(el => el.getAnimations().map(a => a.startTime));
        await screenshot('seal');
        await page.locator('#trust').scrollIntoViewIfNeeded(); await page.locator('#seal-pane').scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);
        ensure(JSON.stringify(await seal.evaluate(el => el.getAnimations().map(a => a.startTime))) === JSON.stringify(before), 'seal does not press again on re-entry');
        ensure(await page.evaluate(() => window.__presses) === 1, 'exactly one seal animationstart');
      }, {}, () => { window.__presses = 0; document.addEventListener('animationstart', e => { if (e.target.id === 'seal' && e.animationName === 'press') window.__presses++; }); });
      if (id === 'PAGE-018') await each(async () => {
        const cross = JSON.parse(await page.locator('[data-json="crosscheck"]').innerText());
        ensure(cross.verdict === 'unverified' && cross.reasons.includes('UNVERIFIED_DISAGREEMENT') && cross.report === null, 'exact recorded unverified disagreement values');
        const text = await page.locator('[data-json="crosscheck"]').innerText();
        for (const endpoint of ['testnet.zec.rocks:443','zec.rocks:443','zaino.testnet.unsafe.zec.rocks:443']) ensure(text.includes(endpoint), `recorded endpoint ${endpoint}`);
        const receipt = await page.locator('[data-json="receipt"]').innerText();
        ensure(/7c1f6cc0[0-9a-f]{52}4c16/.test(receipt), 'receipt names the recorded paywall txid');
        await selectedLink('crosscheck').click(); await screenshot('recorded-crosscheck');
      });
      if (id === 'PAGE-019') await each(async () => {
        const hrefs = await page.locator('a[href^="#"]').evaluateAll(as => as.map(a => a.getAttribute('href').slice(1)));
        for (const hash of hrefs) ensure(await page.locator(`[id="${hash}"]`).count() === 1, `fragment #${hash} has exactly one target`);
        await selectedLink('trust').click(); await page.getByRole('link', { name: 'Hanko, back to the overview' }).click();
        await expect(page).toHaveURL(/#overview$/); await belowBars('overview');
        ensure(await page.locator('.foot a').filter({ hasText: /^overview$/ }).getAttribute('href') === './', 'footer overview returns to ./');
        ensure(await page.locator('.foot a').filter({ hasText: /^source$/ }).getAttribute('href') === 'https://github.com/nickthelegend/zec-payment-verify-sdk', 'footer source targets repo');
        ensure((await page.locator('.foot').innerText()).includes('Copyright (c) 2026 Nivesh Gajengi'), 'exact footer copyright');
      });
      if (id === 'PAGE-020') {
        for (const name of ['live','local','pages']) {
          try {
            await open(name);
            ensure(await page.getByRole('link', { name: 'Dashboard', exact: true }).getAttribute('href') === 'dashboard/', 'Dashboard same-site href');
            // The raw landing folder contains no dashboard. Exercise its built sibling on Pages.
            if (name === 'local') continue;
            const [r] = await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.getByRole('link', { name: 'Dashboard', exact: true }).click()]);
            ensure(r.status() === 200 && page.url() === new URL('dashboard/', manifest.urls[name]).href, 'Dashboard opens same-site /dashboard/ with HTTP 200');
            await expect(page.locator('h1')).toHaveText(name === 'pages' ? 'Is this proof a payment to me?' : 'Was I paid?');
            ensure(true, `${name} exact dashboard initial rail`);
            if (name === 'pages') await expect(page.getByRole('status')).toHaveText('Fuji, straight from this browser');
            else await expect(page.getByRole('status')).toHaveText('verify API reachable', { timeout: 18000 });
            // Never record form values, DOM dumps, screenshots or response bodies from a console.
          } catch (e) { ev.errors.push({ surface: name, message: clean(e.message) }); }
        }
        ev.note = 'Raw landing folder href verified; Pages sibling console bundled with envDir:false and no gateway. No console form values, response bodies or screenshots collected.';
      }
      if (id === 'EDGE-014') await each(async () => {
        const state = await page.locator('#seal').evaluate(el => ({ class: el.getAttribute('class'), opacity: getComputedStyle(el).opacity, animation: getComputedStyle(el).animationName, bleed: getComputedStyle(el.querySelector('.bleed')).display }));
        ensure(!state.class.includes('armed') && state.opacity === '0.94' && state.animation === 'none' && state.bleed === 'none', 'reduced-motion seal visible .94, unarmed, no press or bleed', state);
        await screenshot('reduce'); await navigate('null402'); await navigate('overview');
      }, { reducedMotion: 'reduce' });
      if (id === 'EDGE-016') await each(async () => {
        await page.keyboard.press('Tab'); const skip = page.getByRole('link', { name: 'Skip to the reference' });
        await expect(skip).toBeFocused(); await expect(skip).toBeInViewport();
        await screenshot('skip'); await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/#overview$/); await belowBars('overview');
        await expect(page.locator('h1')).toBeInViewport();
      });
      if (id === 'EDGE-019') await each(async () => {
        ensure(await page.evaluate(() => document.documentElement.scrollWidth === 375), '375px no horizontal page scroll', await page.evaluate(() => document.documentElement.scrollWidth));
        await expect(page.locator('.jump')).toBeHidden();
        const panes = page.locator('.pane');
        for (let i = 0; i < await panes.count(); i++) {
          const pane = panes.nth(i); await pane.scrollIntoViewIfNeeded();
          const [b,p,t] = await Promise.all([pane.locator('.copy').boundingBox(),pane.boundingBox(),pane.locator('.pane-title').boundingBox()]);
          ensure(b.x >= p.x + 4 && b.x + b.width <= p.x + p.width - 4 && b.x >= t.x + t.width - 0.5, `pane ${i} Copy fits without title overlap`, { button:b,pane:p,title:t });
        }
        for (const hash of ['overview','quickstart','zcash','crosscheck','reasons','null402','paywall','api','mcp','evidence','tests','trust']) await navigate(hash);
        ensure(await page.evaluate(() => document.documentElement.scrollWidth === 375), 'no horizontal page scroll after navigation');
        await screenshot('mobile-trust'); await navigate('overview'); await screenshot('mobile-overview');
      }, { viewport: { width: 375, height: 812 } });
    };
    let timer;
    try { await Promise.race([task(), new Promise((_, reject) => { timer = setTimeout(() => { cancelled = true; reject(new Error('90 second row deadline exceeded')); }, 90000); })]); }
    catch (e) { ev.errors.push({ surface, message: clean(e.message) }); }
    finally { clearTimeout(timer); if (context) await context.close(); }
    const badNetwork = ev.network.filter(r => r.status >= 400);
    const badConsole = ev.console.filter(m => m.type === 'error');
    ev.failures = { network: badNetwork, console: badConsole, pageErrors: ev.pageErrors, requestFailures: ev.requestFailures };
    ev.status = ev.errors.length || badNetwork.length || badConsole.length || ev.pageErrors.length || ev.requestFailures.length ? 'FAIL' : 'PASS';
    const path = `${dir}/${id}-${attempt}.json`;
    await writeFile(path, JSON.stringify(ev, null, 2) + '\n');
    row.status = ev.status; row.evidence.push(path); await persist();
    console.log(`${id} ${ev.status}: ${ev.checks.length} checks; ${JSON.stringify(ev.errors)}; network=${badNetwork.length} console=${badConsole.length} pageErrors=${ev.pageErrors.length} requestFailures=${ev.requestFailures.length}`);
  }
} finally {
  if (browser) await browser.close();
  if (chrome) { const child = chrome.process(); await chrome.close(); await killPid(child); }
  await killPid(staticServer);
  if (temp) await rm(temp, { recursive: true, force: true });
  manifest.finished = new Date().toISOString(); await saveManifest();
}
