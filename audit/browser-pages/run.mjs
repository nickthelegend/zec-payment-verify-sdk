// Real Chrome against scripts/build-pages.sh output; no mocks, signing, video or trace.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../../e2e/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const dir = 'audit/browser-pages', statusFile = 'audit/status/browser-pages.json';
const ids = ['PAGE-036', 'PAGE-037', 'PAGE-038', 'PAGE-039', 'PAGE-040', 'EDGE-021'];
const selected = process.argv.slice(2).length ? process.argv.slice(2) : ids;
assert(selected.every(id => ids.includes(id)));
const origin = 'http://127.0.0.1:5193', api = 'http://127.0.0.1:8403';
const clean = s => String(s).replace(/u(?:ivk|fvk|view)(?:test)?1[a-z0-9…]+/gi, '[redacted]').slice(0, 2500);
await mkdir(dir, { recursive: true }); await mkdir('audit/status', { recursive: true });
let results = ids.map(id => ({ id, status: 'PENDING', evidence: [], fix: '' }));
try { results = JSON.parse(await readFile(statusFile, 'utf8')); } catch {}
const persist = () => writeFile(statusFile, JSON.stringify(results, null, 2) + '\n');
await persist();
const manifest = { started: new Date().toISOString(), runnerPid: process.pid, channel: 'chrome', headless: true, video: false, trace: false, rowTimeoutMs: 90000, processes: [] };
const sessionFile = `${dir}/session-${process.pid}.json`;
const track = (label, child) => { const p = { label, pid: child.pid }; manifest.processes.push(p); child.once('exit', (code, signal) => Object.assign(p, { exited: true, code, signal })); return child; };
const stop = async child => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  await Promise.race([new Promise(r => child.once('exit', r)), new Promise(r => setTimeout(r, 1500))]);
  if (child.exitCode === null && child.signalCode === null) try { process.kill(child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
};
let server, chrome, browser;
try {
  // No verify server is started. Expected connection refusal is evidence of setup-required.
  const net = await import('node:net');
  await new Promise((res, rej) => { const s = net.connect(8403, '127.0.0.1'); s.once('connect', () => { s.destroy(); rej(new Error('Port 8403 must have no listener')); }); s.once('error', e => e.code === 'ECONNREFUSED' ? res() : rej(e)); });
  manifest.noLocalVerifyApi = true;
  server = track('static Pages server', spawn(process.execPath, ['e2e/serve-static.mjs', '5193:site'], { stdio: ['ignore', 'pipe', 'pipe'] }));
  await new Promise((res, rej) => { server.stdout.once('data', res); server.once('error', rej); server.once('exit', c => rej(new Error(`Static server exited ${c}`))); });
  chrome = await chromium.launchServer({ channel: 'chrome', headless: true }); track('Google Chrome', chrome.process());
  browser = await chromium.connect(chrome.wsEndpoint()); manifest.browser = browser.version();
  await writeFile(sessionFile, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Chrome ${manifest.browser}; server PID ${server.pid}; Chrome PID ${chrome.process().pid}`);
  for (const id of selected) {
    const row = results.find(r => r.id === id), attempt = row.evidence.length + 1;
    row.status = 'RUNNING'; await persist();
    const ev = { id, attempt, at: new Date().toISOString(), browser: manifest.browser, viewport: id === 'EDGE-021' ? { width: 375, height: 812 } : { width: 1440, height: 900 }, checks: [], requests: [], network: [], console: [], pageErrors: [], requestFailures: [], screenshots: [], errors: [] };
    const context = await browser.newContext({ viewport: ev.viewport, ...(id === 'EDGE-021' ? { isMobile: true, hasTouch: true } : {}) });
    const page = await context.newPage(); page.setDefaultTimeout(6000); page.setDefaultNavigationTimeout(20000);
    page.on('request', r => { const item = { url: clean(r.url()), method: r.method(), resourceType: r.resourceType() }; if (r.url().includes('/ext/bc/C/rpc') && r.postData()) { try { const data = JSON.parse(r.postData()); item.rpcMethods = (Array.isArray(data) ? data : [data]).map(x => x.method); } catch {} } ev.requests.push(item); });
    page.on('response', r => ev.network.push({ url: clean(r.url()), status: r.status(), method: r.request().method(), resourceType: r.request().resourceType() }));
    page.on('requestfailed', r => ev.requestFailures.push({ url: clean(r.url()), error: clean(r.failure()?.errorText) }));
    page.on('console', m => ev.console.push({ type: m.type(), text: clean(m.text()), url: clean(m.location().url) }));
    page.on('pageerror', e => ev.pageErrors.push(clean(e.message)));
    const check = (ok, name, actual) => { ev.checks.push({ name, pass: !!ok, ...(actual === undefined ? {} : { actual }) }); assert(ok, name); };
    const shot = async name => { const path = `${dir}/${id}-${name}-${attempt}.jpg`; const buf = await page.screenshot({ type: 'jpeg', quality: 38, mask: [page.getByLabel('uivk', { exact: true })] }); check(buf.length <= 200000, 'screenshot <=200 KB', buf.length); await writeFile(path, buf); ev.screenshots.push(path); };
    const layout = async state => {
      const size = await page.evaluate(() => ({ width: innerWidth, client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
      check(size.scroll <= size.client && size.client === ev.viewport.width, `${state}: no horizontal page scroll`, size);
      for (const selector of ['.send', '.v-badge', '.pane', '.checks', '#history .log', '.cmd', 'input[aria-label="settle_tx"]']) {
        for (const item of await page.locator(selector).all()) {
          if (!await item.isVisible()) continue;
          await item.scrollIntoViewIfNeeded();
          const rect = await item.boundingBox(); check(rect.x >= -1 && rect.x + rect.width <= size.client + 1, `${state}: ${selector} fits horizontally`, rect);
        }
      }
      await expect(page.locator('.send')).toBeEnabled();
    };
    const open = async (path = '/dashboard/') => { const r = await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' }); check(r.status() === 200, `${path} HTTP 200`); await page.evaluate(() => document.fonts.ready); };
    const setup = async () => { await page.getByRole('button', { name: /Zcash payment/ }).click(); await expect(page.getByRole('status')).toHaveText('verify API not reachable'); await expect(page.locator('.prose > .banner')).toContainText('Setup required'); };
    const send = async () => { await page.getByRole('button', { name: 'Send request', exact: true }).click(); await expect(page.locator('.send')).toHaveText('Send request', { timeout: 45000 }); await expect(page.locator('.verdict .v-badge')).toHaveText('Not paid'); return JSON.parse(await page.locator('.pane.response pre').innerText()); };
    const task = async () => {
      if (id === 'PAGE-036') {
        for (const path of ['site/index.html', 'site/reference.html', 'site/dashboard/index.html', 'site/.nojekyll', 'site/assets/hero.webp']) check((await stat(path)).isFile(), `built ${path}`);
        const built = await readFile('site/dashboard/index.html', 'utf8'); const assets = [...built.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(m => m[1]);
        check(assets.length >= 2 && assets.every(x => x.startsWith('./assets/')), 'relative dashboard JS/CSS assets', assets);
        check((await readFile('site/assets/hero.webp')).equals(await readFile('packages/landing/assets/hero.webp')), 'built generated hero matches source');
        for (const base of ['/', '/zec-payment-verify-sdk/']) {
          await open(base); await expect(page.locator('h1')).toContainText('Was I paid?');
          const img = await page.locator('.stage img').evaluate(el => ({ src: el.currentSrc, complete: el.complete, width: el.naturalWidth }));
          check(img.complete && img.width > 0 && img.src === `${origin}${base}assets/hero.webp`, `${base} cinematic hero loads`, img);
          await shot(base === '/' ? 'root-landing' : 'subpath-landing');
          await page.getByRole('link', { name: 'Open the console', exact: true }).first().click();
          await expect(page).toHaveURL(`${origin}${base}dashboard/`); await expect(page.locator('h1')).toHaveText('Is this proof a payment to me?'); await shot(base === '/' ? 'root-console' : 'subpath-console');
        }
      } else {
        await open();
        if (id === 'PAGE-037' || id === 'EDGE-021') {
          await expect(page.locator('h1')).toHaveText('Is this proof a payment to me?'); await expect(page.getByRole('button', { name: /null-402 proof/ })).toHaveAttribute('aria-current', 'true'); await expect(page.getByRole('status')).toHaveText('Fuji, straight from this browser'); await expect(page.getByRole('alert')).toHaveCount(0); await expect(page.getByText('Setup required', { exact: true })).toHaveCount(0);
          await expect(page.getByLabel('settle_tx')).toHaveValue(/^0x8596f52d.*a593$/);
          if (id === 'EDGE-021') { await layout('null402 inputs'); await page.locator('.send').scrollIntoViewIfNeeded(); await shot('proof-inputs'); }
          const response = await send(); ev.liveResponse = response;
          check(response.reasons.includes('NULLIFIER_SPENT') && response.reasons.includes('UNBOUND'), 'live spent/unbound proof');
          check(response.checks.proofValid === true && response.checks.rootKnown === true && response.checks.nullifierSpent === true, 'live verifier/root/spent all true', response.checks);
          await expect(page.locator('.verdict .checks')).toContainText('verifier.verifyProof');
          check(ev.requests.some(r => r.rpcMethods?.includes('eth_call')), 'direct Fuji eth_call');
          check(!ev.requests.some(r => r.url.startsWith(api)), 'null402 makes no request to 127.0.0.1:8403');
          await page.locator('.verdict').scrollIntoViewIfNeeded(); await shot('proof-checks');
          if (id === 'EDGE-021') {
            await layout('null402 checks and response');
            await page.getByLabel('expect.payTo').fill(response.signals.payTo); await page.getByLabel('expect.requiredAmount').fill(response.signals.requiredAmount); await page.getByLabel('Claim 10× the amount the proof authorises').check();
            const bad = await send(); check(bad.reasons.includes('BAD_PROOF'), 'mobile tampered proof rejected');
            await expect(page.locator('#history .log > li')).toHaveCount(2); await layout('proof history'); await page.locator('#history').scrollIntoViewIfNeeded(); await shot('history');
            await setup(); await layout('Pages setup and matching recorded output'); await page.locator('.prose > .banner').scrollIntoViewIfNeeded(); await shot('setup'); await page.locator('[data-recorded]').scrollIntoViewIfNeeded(); await shot('recorded');
            await expect(page.locator('[data-recorded] .v-badge')).toHaveText('Paid'); await expect(page.locator('.stamp')).toHaveCount(0);
            await page.getByRole('radio', { name: /Wrong invoice memo/ }).click(); await expect(page.locator('[data-recorded] .reasons')).toContainText('MEMO_MISMATCH'); await layout('recorded refusal');
            await page.getByLabel('amountZat').fill('123'); await expect(page.locator('[data-recorded]')).toContainText('No recorded output for these parameters'); await expect(page.locator('.pane.response pre')).toHaveCount(0); await layout('no recording'); await shot('no-recording');
          }
        } else {
          await setup();
          if (id === 'PAGE-038') {
            await expect(page.locator('.banner .cmd')).toHaveText(`ZPV_CORS=${origin} pnpm --filter @zpv/gateway api`); await expect(page.locator('.prose > .banner')).toContainText('local network'); await expect(page.locator('.prose > .banner')).toContainText('allow it');
            check(ev.requestFailures.some(r => r.url === `${api}/api/health` && r.error.includes('ERR_CONNECTION_REFUSED')), 'actual missing API connection refused');
            await page.locator('.prose > .banner').scrollIntoViewIfNeeded(); await shot('setup-required');
          }
          if (id === 'PAGE-039') {
            const recorded = JSON.parse(await readFile('fixtures/console-recorded.json', 'utf8'));
            const rec = page.locator('[data-recorded]'); await expect(rec).toContainText('Recorded output, not live'); await expect(rec).toContainText(recorded.recordedAt.slice(0, 10)); await expect(rec).toContainText(new URL(recorded.lightwalletd).host); await expect(rec).toContainText(recorded.by); await expect(rec.locator('.v-badge')).toHaveText('Paid');
            check(JSON.stringify(JSON.parse(await page.locator('.pane.response pre').innerText())) === JSON.stringify(recorded.samples[0].response), 'matching JSON equals recorded fixture');
            await expect(page.locator('.pane.response')).toContainText('Recorded output, not live'); await expect(page.locator('.stamp')).toHaveCount(0); await rec.scrollIntoViewIfNeeded(); await shot('matching-recording');
            await page.getByRole('radio', { name: /Wrong invoice memo/ }).click(); await expect(rec.locator('.reasons')).toContainText('MEMO_MISMATCH');
            const wrong = JSON.parse(await page.locator('.pane.response pre').innerText()); check(wrong.reasons.includes('MEMO_MISMATCH') && wrong.verdict === 'refused', 'wrong memo recorded refusal JSON'); await expect(rec.locator('.v-badge')).toHaveText('Not paid'); await expect(page.locator('.stamp')).toHaveCount(0); await shot('wrong-memo');
          }
          if (id === 'PAGE-040') {
            await page.getByLabel('amountZat').fill('123'); await expect(page.locator('[data-recorded]')).toContainText('No recorded output for these parameters'); await expect(page.locator('.pane.response pre')).toHaveCount(0); await expect(page.locator('.stamp')).toHaveCount(0); await page.locator('[data-recorded]').scrollIntoViewIfNeeded(); await shot('no-recording');
          }
        }
      }
      check(true, 'all row expectations matched');
    };
    let timer;
    try { await Promise.race([task(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('90 second row deadline exceeded')), 90000); })]); }
    catch (e) { ev.errors.push(clean(e.message)); try { await shot('failure'); } catch {} }
    finally { clearTimeout(timer); await context.close(); }
    const expectedRefusal = r => id !== 'PAGE-036' && id !== 'PAGE-037' && r.url === `${api}/api/health` && /ERR_CONNECTION_REFUSED/.test(r.error ?? r.text);
    ev.expectedSetupFailures = { requests: ev.requestFailures.filter(expectedRefusal), console: ev.console.filter(expectedRefusal) };
    ev.unexpected = { http: ev.network.filter(r => r.status >= 400), console: ev.console.filter(r => r.type === 'error' && !expectedRefusal(r)), pageErrors: ev.pageErrors, requests: ev.requestFailures.filter(r => !expectedRefusal(r)) };
    const methods = ev.requests.flatMap(r => r.rpcMethods ?? []); check(methods.every(m => ['eth_chainId', 'eth_blockNumber', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getBlockByNumber', 'eth_call'].includes(m)), 'only read-only RPC methods', [...new Set(methods)]);
    ev.status = ev.errors.length || Object.values(ev.unexpected).some(a => a.length) ? 'FAIL' : 'PASS'; ev.finished = new Date().toISOString();
    const path = `${dir}/${id}-${attempt}.json`; await writeFile(path, JSON.stringify(ev, null, 2) + '\n'); row.status = ev.status; row.evidence.push(path); await persist();
    console.log(`${id} ${ev.status} ${ev.errors.join('; ')} ${JSON.stringify(ev.unexpected)}`);
  }
} finally {
  if (browser) await browser.close(); if (chrome) await chrome.close(); if (chrome) await stop(chrome.process()); await stop(server);
  manifest.finished = new Date().toISOString(); await writeFile(sessionFile, JSON.stringify(manifest, null, 2) + '\n');
}
process.exitCode = results.filter(r => selected.includes(r.id)).some(r => r.status !== 'PASS') ? 1 : 0;
