import { createRequire } from 'node:module';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../../e2e/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const root = process.cwd(), dir = 'audit/reverify-console';
const api = 'https://hanko-api.201-18-198-162.sslip.io';
const ids = Array.from({ length: 15 }, (_, i) => `PAGE-${String(i + 21).padStart(3, '0')}`);
const selected = process.argv.slice(2).length ? process.argv.slice(2) : ids;
assert(selected.every(id => ids.includes(id)), 'only PAGE-021 through PAGE-035');
await mkdir(dir, { recursive: true }); await mkdir('audit/status', { recursive: true });
let results = ids.map(id => ({ id, status: 'PENDING', evidence: [], fix: '' }));
if (selected.length !== ids.length) try { results = JSON.parse(await readFile('audit/reverify-console/console-status.json', 'utf8')); } catch {}
const persist = () => writeFile('audit/reverify-console/console-status.json', JSON.stringify(results, null, 2) + '\n');
await persist();
const clean = value => String(value).replace(/(?:uivk(?:test)?1|u(?:fvk|view)(?:test)?1)[a-z0-9]+/gi, '[shortened-key]').slice(0, 2000);
let server, chrome, browser;
const config = resolve('packages/dashboard/.console-audit.config.mjs');
const manifest = { started: new Date().toISOString(), runnerPid: process.pid, channel: 'chrome', headless: true, video: false, trace: false, rowTimeoutMs: 90000, processes: [], urls: { hosted: 'https://hanko-dashboard-six.vercel.app', local: 'http://localhost:5180' } };
const saveSession = () => writeFile(`${dir}/console-session-${process.pid}.json`, JSON.stringify(manifest, null, 2) + '\n');
const track = (label, child) => {
  const entry = { label, pid: child.pid }; manifest.processes.push(entry);
  child.once('exit', (code, signal) => Object.assign(entry, { exited: true, code, signal })); return child;
};
const killPid = async child => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  await Promise.race([new Promise(r => child.once('exit', r)), new Promise(r => setTimeout(r, 2000))]);
  if (child.exitCode === null && child.signalCode === null) try { process.kill(child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
};
try {
 const slotOwner=await readFile('/tmp/grokbot-heavy-slots/slot1/owner','utf8');assert(slotOwner.startsWith('audit-t13 '),'audit-t13 heavy slot must be held');manifest.slotOwner=slotOwner.trim();
  // Never let Vite read .env files. Public fixtures are loaded only by the application.
  await writeFile(config, `import react from '@vitejs/plugin-react';\nexport default {envDir:false,plugins:[react()],resolve:{alias:{'@fixtures':${JSON.stringify(resolve('fixtures'))},'@deployments':${JSON.stringify(resolve('deployments'))}}},define:{'import.meta.env.VITE_ZPV_API':undefined,'import.meta.env.VITE_ZPV_PROXY_API':${JSON.stringify(JSON.stringify(api))},'import.meta.env.VITE_ZPV_PAGES':'undefined'},server:{host:'localhost',port:5180,strictPort:true,fs:{allow:[${JSON.stringify(root)}]},proxy:{'/api':{target:${JSON.stringify(api)},changeOrigin:true,secure:true}}}};\n`);
  server = track('dashboard Vite dev server', spawn(process.execPath, ['packages/dashboard/node_modules/vite/bin/vite.js', 'packages/dashboard', '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] }));
  let startup = '';
  server.stderr.on('data', d => { startup += clean(d.toString()); });
  await Promise.race([new Promise((res, rej) => { server.stdout.on('data', d => { if (d.toString().includes('localhost:5180')) res(); }); server.once('exit', c => rej(new Error(`Vite exit ${c}: ${startup}`))); }), new Promise((_, rej) => setTimeout(() => rej(new Error('Vite startup timeout')), 15000))]);
  chrome = await chromium.launchServer({ channel: 'chrome', headless: true });
  track('Google Chrome', chrome.process()); browser = await chromium.connect(chrome.wsEndpoint());
  manifest.browser = browser.version(); await saveSession();
  console.log(`Chrome ${manifest.browser}; runner ${process.pid}; Vite ${server.pid}; Chrome ${chrome.process().pid}`);
  for (const id of selected) {
    const row = results.find(r => r.id === id), attempt = row.evidence.length + 1;
    const ev = { id, attempt, at: new Date().toISOString(), browser: manifest.browser, checks: [], surfaces: [], console: [], pageErrors: [], network: [], requestFailures: [], errors: [], screenshots: [] };
    let context, page, surface, cancelled = false;
    const ensure = (ok, check, actual) => { ev.checks.push({ surface, check, pass: !!ok, ...(actual === undefined ? {} : { actual }) }); assert(ok, check); };
    const v = () => page.locator('.verdict'), response = () => page.locator('.response');
    const history = () => page.locator('#history .log > li');
    const preview = () => page.locator('.pane').first().locator('pre');
    const choose = async name => page.getByRole('radio', { name: new RegExp(name) }).click();
    const send = async () => {
      const button = page.getByRole('button', { name: 'Send request', exact: true });
      const requestApi = surface === 'local' ? manifest.urls.local : api;
      const zcash = await page.getByRole('button', { name: /Zcash payment/ }).getAttribute('aria-current') === 'true';
      const pending = zcash ? Promise.race([
        page.waitForResponse(r => r.url() === `${requestApi}/api/verify` && r.request().method() === 'POST', { timeout: 30000 }),
        page.waitForEvent('requestfailed', { predicate: r => r.url() === `${requestApi}/api/verify`, timeout: 30000 }).then(r => { throw new Error(`verify request failed: ${r.failure()?.errorText}`); }),
      ]) : null;
      await button.click();
      if (pending) ensure((await pending).status() === 200, 'verify HTTP 200');
      await expect(page.locator('.send')).toHaveText('Send request', { timeout: 30000 });
      await expect(v().locator('.v-badge')).toBeVisible({ timeout: 2000 });
      // Only response JSON is collected, never fixture sources, form keys or POST bodies.
      const body = JSON.parse(await response().locator('pre').innerText());
      ev.surfaces.find(s => s.name === surface).responses.push(body);
      return body;
    };
    const verdict = async (badge, reason, seal = 'not paid') => {
      await expect(v().locator('.v-badge')).toHaveText(badge);
      if (reason) await expect(v().locator('.reasons')).toContainText(reason);
      await expect(response().getByRole('img', { name: `Verdict: ${seal}`, exact: true })).toBeVisible();
      const words = { paid: ['PAID', 'VIEWING KEY'], pending: ['WAIT', 'UNCONFIRMED'], 'not paid': ['UNPAID', 'SEE REASONS'] }[seal];
      ensure(JSON.stringify(await response().locator('.stamp text').allTextContents()) === JSON.stringify(words), 'exact seal lettering', words);
    };
    const screenshot = async suffix => {
      if(ev.screenshots.length)return;
      const path = `${dir}/${id}.jpg`;
      const buffer = await page.screenshot({ type: 'jpeg', quality: 20, fullPage: false, mask: [page.getByLabel('uivk', { exact: true }), page.locator('.j-s').filter({hasText:/u(?:ivk|fvk|view)(?:test)?1/i})] });
      ensure(buffer.length <= 200000, 'screenshot <=200 KB', buffer.length); await writeFile(path, buffer); ev.screenshots.push(path);
    };
    const belowBars = async target => {
      await page.getByRole('link', { name: target === 'history' ? /History/ : 'Real payments' }).click();
      await expect(page).toHaveURL(new RegExp(`#${target}$`));
      await page.waitForTimeout(500);
      const rect = await page.locator(`#h-${target}`).evaluate(el => ({ y: el.getBoundingClientRect().top, bar: document.querySelector('.top').getBoundingClientRect().bottom, height: innerHeight }));
      ensure(rect.y >= rect.bar - 1 && rect.y < rect.height, `${target} heading below sticky bars`, rect);
    };
    const task = async () => {
      for (surface of (process.env.HANKO_AUDIT_SURFACE ? [process.env.HANKO_AUDIT_SURFACE] : ['hosted', 'local'])) {
        if (cancelled) return;
        try {
          context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
          page = await context.newPage(); page.setDefaultTimeout(4500); page.setDefaultNavigationTimeout(20000);
          const name = surface; const requestApi = surface === 'local' ? manifest.urls.local : api;
          page.on('console', m => ev.console.push({ surface: name, type: m.type(), text: clean(m.text()) }));
          page.on('pageerror', e => ev.pageErrors.push({ surface: name, message: clean(e.message) }));
          page.on('response', r => ev.network.push({ surface: name, url: clean(r.url()), method: r.request().method(), status: r.status(), resourceType: r.request().resourceType() }));
          page.on('requestfailed', r => ev.requestFailures.push({ surface: name, url: clean(r.url()), error: clean(r.failure()?.errorText) }));
          const health = page.waitForResponse(r => r.url() === `${requestApi}/api/health`, { timeout: 20000 });
          const navigation = await page.goto(manifest.urls[surface], { waitUntil: 'load' });
          ensure(navigation.status() === 200, 'dashboard HTTP 200', navigation.status());
          const hr = await health, hb = await hr.json();
          ensure(hr.status() === 200 && hb.ok === true, 'hosted verify health HTTP 200 ok');
          await expect(page.getByRole('status')).toHaveText('verify API reachable');
          ev.surfaces.push({ name: surface, url: manifest.urls[surface], health: hb, responses: [] });
          await page.evaluate(() => document.fonts.ready);
          if (id === 'PAGE-021') {
            await expect(page.locator('h1')).toHaveText('Was I paid?');
            await expect(page.getByRole('button', { name: /Zcash payment/ })).toHaveAttribute('aria-current', 'true');
            const expected = `to ${requestApi}${hb.lightwalletd ? (hb.lightwalletd.urls.length > 1 ? ` · cross-checks ${hb.lightwalletd.urls.length} lightwalletd, quorum ${hb.lightwalletd.quorum}` : ` · one lightwalletd, ${hb.lightwalletd.urls[0].replace(/^https?:\/\//, '')}`) : ''}`;
            await expect(page.locator('#send-note')).toHaveText(expected); ensure(!!hb.lightwalletd?.urls.length, 'health advertises endpoints', hb.lightwalletd);
          }
          if (id === 'PAGE-022') {
            await expect(v()).toContainText('Nothing checked yet.'); await expect(response()).toContainText('No request sent yet.');
            await expect(page.locator('#history')).toContainText('No checks yet.'); await expect(page.locator('.count')).toHaveText('0'); await expect(page.locator('.stamp')).toHaveCount(0);
          }
          if (id === 'PAGE-023') {
            await page.getByLabel('amountZat', { exact: true }).fill('100001'); await page.getByLabel('memo', { exact: true }).fill('x402z-another-invoice'); await page.getByLabel('minConf', { exact: true }).fill('3');
            await expect(page.locator('.unit')).toHaveText('= 0.00100001 TAZ');
            const json = JSON.parse((await preview().innerText()).split('  -d ')[1]);
            ensure(json.rail === 'zcash' && json.amountZat === 100001 && json.memo === 'x402z-another-invoice' && json.minConf === 3 && /^[a-f0-9]{64}$/.test(json.txid), 'edited exact JSON and numeric types', { ...json, uivk: '[shortened-key]' });
            ensure(json.uivk.length === 15 && json.uivk.endsWith('…'), 'preview key shortened');
            await page.getByLabel('memo', { exact: true }).fill(''); ensure(!Object.hasOwn(JSON.parse((await preview().innerText()).split('  -d ')[1]), 'memo'), 'empty memo omitted from JSON');
          }
          if (id === 'PAGE-024') {
            const body = await send(); await verdict('Paid', null, 'paid');
            await expect(v()).toContainText('0.001 TAZ reached this key with the expected memo.');
            ensure(body.report.txid.startsWith('030c3cbf') && body.report.txid.endsWith('8351'), 'recorded x402 txid');
            ensure(body.report.outputs.length > 0 && body.report.height > 0 && body.report.tip >= body.report.height && !!body.provenance.lightwalletd && !!body.provenance.checkedAt, 'outputs and block/tip/endpoint provenance');
            await expect(v().locator('.prov')).toContainText('block'); await expect(v().locator('.prov')).toContainText('at tip');
          }
          if (id === 'PAGE-025') {
            await choose('Wrong invoice memo'); await expect(page.getByLabel('memo', { exact: true })).toHaveValue('x402z-another-invoice'); const body = await send();
            await verdict('Not paid', 'MEMO_MISMATCH'); await expect(v()).toContainText('none with the expected memo'); ensure(body.verdict === 'refused', 'response verdict refused');
          }
          if (id === 'PAGE-026') {
            await page.getByLabel('amountZat', { exact: true }).fill('100001'); await expect(page.locator('.unit')).toHaveText('= 0.00100001 TAZ'); await send();
            await verdict('Not paid', 'AMOUNT_TOO_LOW'); await expect(v()).toContainText('Counted toward this check: 0.001 TAZ.');
          }
          if (id === 'PAGE-027') {
            await choose('Someone else'); await send(); await verdict('Not paid', 'NO_OUTPUT_TO_KEY'); await expect(v()).toContainText('No output in this transaction decrypts to this key.');
          }
          if (id === 'PAGE-028') {
            await page.getByLabel('minConf', { exact: true }).fill('100000000'); await send(); await verdict('Pending', 'NOT_CONFIRMED', 'pending');
            await expect(v()).toContainText('Not mined deep enough yet.'); await expect(history().first()).toContainText('Pending');
          }
          if (id === 'PAGE-029') {
            await page.getByLabel('txid', { exact: true }).fill('ab'.repeat(32)); const body = await send(); await verdict('Not paid', 'TX_NOT_FOUND');
            await expect(v()).toContainText('No such transaction.'); ensure(body.verdict === 'refused', 'absent txid is refusal'); await expect(v().getByRole('alert')).toHaveCount(0);
          }
          if (id === 'PAGE-030') {
            const refs = []; for (const name of ['x402 payment', 'Wrong invoice memo', 'Someone else']) { await choose(name); const body = await send(); refs.unshift(body.report.txid); }
            await expect(page.locator('.count')).toHaveText('3'); await expect(history()).toHaveCount(3);
            for (let i = 0; i < 3; i++) { const li = history().nth(i); await expect(li).toContainText('Zcash'); ensure(/\d+:\d+:\d+/.test(await li.innerText()), 'history contains time'); await expect(li.getByRole('link')).toHaveAttribute('href', `https://testnet.zecblock.com/tx/${refs[i]}`); }
            await expect(history().nth(0)).toContainText('NO_OUTPUT_TO_KEY'); await expect(history().nth(1)).toContainText('MEMO_MISMATCH'); await expect(history().nth(2)).toContainText('Paid');
            await belowBars('history'); await screenshot('history'); await belowBars('evidence');
          }
          if (id === 'PAGE-031') {
            // Distinct absent txids are real read-only checks, and exercise ordering within the 90s row budget.
            const newest = []; for (let i = 0; i < 11; i++) { const txid = (1000+i).toString(16).padStart(64,'0'); await page.getByLabel('txid', {exact:true}).fill(txid); await send(); newest.unshift(`https://testnet.zecblock.com/tx/${txid}`); }
            await expect(history()).toHaveCount(10); await expect(page.locator('.count')).toHaveText('10');
            ensure(JSON.stringify(await history().getByRole('link').evaluateAll(es=>es.map(e=>e.href))) === JSON.stringify(newest.slice(0,10)), 'latest ten checks in newest-first order'); await belowBars('history'); await screenshot('ten-checks');
            await page.reload(); await expect(page.getByRole('status')).toHaveText('verify API reachable'); await expect(page.locator('#history')).toContainText('No checks yet.'); await expect(page.locator('.count')).toHaveText('0'); await expect(history()).toHaveCount(0);
          }
          if (['PAGE-032', 'PAGE-033', 'PAGE-034'].includes(id)) {
            await page.getByRole('button', { name: /null-402 proof/ }).click(); await expect(page.locator('h1')).toHaveText('Is this proof a payment to me?'); await expect(page.getByRole('status')).toHaveText('Fuji, straight from this browser');
            ensure(/^0x8596f52d.*a593$/.test(await page.getByLabel('settle_tx').inputValue()), 'recorded settlement selected');
            const body = await send();
            if (id === 'PAGE-032') { await verdict('Not paid', 'NULLIFIER_SPENT'); await expect(v()).toContainText('UNBOUND'); ensure(body.checks.proofValid === true && body.checks.rootKnown === true && body.checks.nullifierSpent === true, 'true/true/true proof/root/spent checks', body.checks); }
            else {
              await page.getByLabel('expect.payTo').fill(body.signals.payTo); await page.getByLabel('expect.requiredAmount').fill(body.signals.requiredAmount);
              if (id === 'PAGE-034') { await page.getByLabel('Claim 10× the amount the proof authorises').check(); await expect(preview()).toContainText('with amount × 10'); }
              const bound = await send(); await verdict('Not paid', id === 'PAGE-033' ? 'NULLIFIER_SPENT' : 'BAD_PROOF'); ensure(!bound.reasons.includes('UNBOUND'), 'binding removes UNBOUND');
              if (id === 'PAGE-033') ensure(JSON.stringify(bound.reasons) === JSON.stringify(['NULLIFIER_SPENT']), 'only spent reason remains');
              else { await expect(v().locator('.checks li').first()).toHaveText(/verifier\.verifyProof\s*false/); await expect(history().first()).toContainText('null-402'); }
            }
          }
          if (id === 'PAGE-035') {
            // A real null-402 result exercises the rail-switch row independently of API CORS.
            await page.getByRole('button', { name: /null-402 proof/ }).click(); await send(); await verdict('Not paid', 'NULLIFIER_SPENT');
            await page.getByRole('button', { name: /Zcash payment/ }).click(); await expect(v()).toContainText('Nothing checked yet.'); await expect(response().locator('.stamp')).toHaveCount(0); await expect(response()).toContainText('No request sent yet.'); await expect(page.locator('.send')).toHaveText('Send request'); await expect(page.locator('.count')).toHaveText('1'); await expect(history()).toHaveCount(1); await expect(page.getByLabel('txid', { exact: true })).toBeVisible(); await expect(preview()).toContainText('"rail": "zcash"');
            await page.getByRole('button', { name: /null-402 proof/ }).click(); await expect(v()).toContainText('Nothing checked yet.'); await expect(response().locator('.stamp')).toHaveCount(0); await expect(page.locator('.send')).toHaveText('Send request'); await expect(page.locator('.count')).toHaveText('1'); await expect(page.getByLabel('settle_tx')).toBeVisible(); await expect(preview()).toContainText('verifyProof');
          }
          await screenshot('result'); ensure(true, 'all row expectations matched on this surface');
        } catch (e) {
          ev.errors.push({ surface, message: clean(e.message) });
          if (page && !page.isClosed()) try { await screenshot('failure'); } catch (shotError) { ev.errors.push({ surface, message: `Failure screenshot: ${clean(shotError.message)}` }); }
        }
        finally { if (context) await context.close(); context = null; }
      }
    };
    let timer;
    try { await Promise.race([task(), new Promise((_, reject) => { timer = setTimeout(() => { cancelled = true; reject(new Error('90 second row deadline exceeded')); }, 90000); })]); }
    catch (e) { ev.errors.push({ surface, message: clean(e.message) }); }
    finally { clearTimeout(timer); if (context) await context.close(); }
    ev.failures = { network: ev.network.filter(r => r.status >= 400), console: ev.console.filter(m => m.type === 'error'), pageErrors: ev.pageErrors, requestFailures: ev.requestFailures };
    ev.surfaceResults = Object.fromEntries(['hosted', 'local'].map(name => [name,
      ev.checks.some(c => c.surface === name && c.check === 'all row expectations matched on this surface') &&
      !ev.errors.some(e => e.surface === name) && !Object.values(ev.failures).some(a => a.some(e => e.surface === name)) ? 'PASS' : 'FAIL']));
    ev.status = ev.errors.length || Object.values(ev.failures).some(a => a.length) ? 'FAIL' : 'PASS';
    ev.durationMs = Date.now() - Date.parse(ev.at); const path = `${dir}/${id}-${process.env.HANKO_AUDIT_SURFACE || 'both'}-${attempt}.json`; await writeFile(path, cleanEvidence(ev)); row.status = ev.status; row.surfaces = ev.surfaceResults; row.evidence.push(path); await persist();
    console.log(`${id} ${ev.status}: ${ev.checks.length} assertions; ${JSON.stringify(ev.errors)}; network=${ev.failures.network.length} console=${ev.failures.console.length} pageErrors=${ev.pageErrors.length} requestFailures=${ev.requestFailures.length}`);
  }
} finally {
  if (browser) await browser.close(); if (chrome) { const p = chrome.process(); await chrome.close(); await killPid(p); }
  await killPid(server); await rm(config, { force: true }); manifest.finished = new Date().toISOString(); await saveSession();
}
function cleanEvidence(value) { return JSON.stringify(value, (_, v) => typeof v === 'string' ? clean(v) : v, 2) + '\n'; }
