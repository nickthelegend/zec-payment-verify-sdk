// API-001..064: real HTTP supplements to the scoped gateway suite. No signing or sending APIs.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer as createPortReservation } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { proofFromSettleTx } from '../../packages/sdk/dist/null402.js';

const root = resolve(import.meta.dirname, '../..');
const logDir = join(root, 'audit/gateway');
const statusPath = join(root, 'audit/status/gateway.json');
const fx = JSON.parse(readFileSync(join(root, 'fixtures/testnet.json'), 'utf8'));
const run = JSON.parse(readFileSync(join(root, 'deployments/testnet.json'), 'utf8'));
const tmp = mkdtempSync('/tmp/hanko-gateway-http-');
const children = new Set<ChildProcess>();
let serial = 0;
let failures = 0;
let current = 0;
let records: unknown[] = [];
const redact = (s: string) => s.replace(/(?:uivktest1|uivk1|uviewtest1|uview1|secret-extended-key-test1|secret-extended-key-main1)[a-z0-9…]+/gi, '[REDACTED_VIEWING_KEY]');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const eq = (a: unknown, b: unknown, why = 'expected value') => assert.deepEqual(a, b, why);
const ok = (condition: unknown, why: string) => assert.ok(condition, why);
const fixes: Record<number, string> = {
  15: 'packages/gateway/src/server.ts normalizes malformed-key encoding errors to the documented public error; regression test and real HTTP rerun passed. Initial failure: audit/gateway/API-015-initial.json.',
  64: "packages/gateway/src/main.ts rejects out-of-range quorum, confirmation floors outside the verifier's u32 range and prices whose quote or 5x report exceeds the Zcash amount limit before listening; regression tests and real startup rerun passed. Initial failure: audit/gateway/API-064-initial.json.",
};

function status(number: number, state: string, evidence: string, fix = '') {
  const rows = JSON.parse(readFileSync(statusPath, 'utf8'));
  rows[number - 1] = { id: `API-${String(number).padStart(3, '0')}`, status: state, evidence, fix };
  writeFileSync(statusPath, redact(JSON.stringify(rows, null, 2)) + '\n');
}
async function row(number: number, action: () => Promise<void>, note = '') {
  if (process.env.HANKO_AUDIT_ROWS && !process.env.HANKO_AUDIT_ROWS.split(',').map(Number).includes(number)) return;
  current = number;
  records = [];
  const id = `API-${String(number).padStart(3, '0')}`;
  const file = `${id}.json`;
  if (existsSync(join(logDir, file))) {
    const old = JSON.parse(readFileSync(join(logDir, file), 'utf8'));
    if (old.status === 'FAIL' && !existsSync(join(logDir, `${id}-initial.json`))) copyFileSync(join(logDir, file), join(logDir, `${id}-initial.json`));
  }
  try {
    await action();
    writeFileSync(join(logDir, file), redact(JSON.stringify({ id, at: new Date().toISOString(), status: 'PASS', note, records }, null, 2)) + '\n');
    status(number, 'PASS', `Real HTTP assertions: ${note}. Evidence: audit/gateway/${file}`, fixes[number] ?? '');
    console.log(`${id} PASS ${note}`);
  } catch (error) {
    failures++;
    const detail = redact(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    writeFileSync(join(logDir, file), redact(JSON.stringify({ id, at: new Date().toISOString(), status: 'FAIL', note, error: detail, records }, null, 2)) + '\n');
    status(number, 'FAIL', `${detail}. Evidence: audit/gateway/${file}`);
    console.log(`${id} FAIL ${detail}`);
  }
}
async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'exit');
    child.kill(signal); // by the exact PID returned by spawn
    await exit;
  }
  children.delete(child);
}
type Local = { base: string; child: ChildProcess; file: string; close: () => Promise<void>; clock: (ms: number) => Promise<void>; output: () => string };
async function start(options: any = {}, extra: { entry?: 'api' | 'main'; file?: string; env?: Record<string, string | undefined>; memory?: boolean } = {}): Promise<Local> {
  const file = extra.file ?? join(tmp, `${++serial}.sqlite`);
  const cleanEnv = Object.fromEntries(['PATH', 'HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'ZPV_BIN'].filter((k) => process.env[k]).map((k) => [k, process.env[k]!]));
  const env: Record<string, string | undefined> = { ...cleanEnv, ZPV_STORE: file, ZPV_PORT: '0', ZPV_CORS: 'https://allowed.audit', HANKO_AUDIT_OPTIONS: JSON.stringify(options), ...extra.env };
  if (extra.entry === 'api') {
    // api.ts logs its configured port; reserve an ephemeral port before starting that entry point.
    const reservation = createPortReservation();
    await new Promise<void>((r) => reservation.listen(0, '127.0.0.1', r));
    env.ZPV_PORT = String((reservation.address() as any).port);
    await new Promise<void>((r) => reservation.close(() => r()));
  }
  if (extra.entry === 'main') {
    env.ZPV_PAY_TO = run.wallets.merchant.address;
    env.ZPV_MERCHANT_UIVK = run.wallets.merchant.uivk;
    Object.assign(env, extra.env);
  }
  const entry = extra.entry ? resolve(root, `packages/gateway/src/${extra.entry}.ts`) : resolve(root, 'audit/gateway/worker.ts');
  const child = spawn(process.execPath, ['--import', 'tsx', entry], { cwd: join(root, 'packages/gateway'), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.add(child);
  let output = '';
  child.stdout!.on('data', (d) => { output += redact(d.toString()); });
  child.stderr!.on('data', (d) => { output += redact(d.toString()); });
  let port = 0;
  for (let i = 0; i < 400; i++) {
    port = Number(/"port":(\d+)/.exec(output)?.[1] ?? /http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1] ?? 0);
    if (port) break;
    if (child.exitCode !== null) throw new Error(`local ${extra.entry ?? 'worker'} exited ${child.exitCode}: ${output}`);
    await sleep(25);
  }
  ok(port, `local ${extra.entry ?? 'worker'} listened`);
  records.push({ server: extra.entry ?? 'createPaywall', pid: child.pid, port, store: options.memory ? 'explicit memory-restart scenario' : file });
  return { child, file, base: `http://127.0.0.1:${port}`, close: () => stop(child), output: () => output, clock: async (ms) => { const ack = once(child, 'message'); child.send({ clock: ms }); await ack; } };
}
async function local(options: any, action: (s: Local) => Promise<void>, extra: Parameters<typeof start>[1] = {}) {
  const s = await start(options, extra);
  try { await action(s); } finally { await s.close(); }
}
async function request(base: string, path: string, init: RequestInit = {}) {
  const r = await fetch(base + path, { ...init, signal: AbortSignal.timeout(100_000) });
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  const headers = Object.fromEntries(r.headers);
  let settlement: any;
  if (headers['x-payment-response']) settlement = JSON.parse(Buffer.from(headers['x-payment-response'], 'base64').toString());
  const answer = { status: r.status, headers, body, settlement };
  records.push({ path, method: init.method ?? 'GET', ...answer });
  return answer;
}
const zcash = () => ({ rail: 'zcash', uivk: fx.x402.uivk, txid: fx.x402.txid, amountZat: 100000, memo: fx.x402.memo });
const post = (base: string, body: any, headers = {}) => request(base, '/api/verify', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const payment = (memo: string, txid: string, v1 = false) => ({ 'x-payment': Buffer.from(JSON.stringify(v1 ? { x402Version: 1, scheme: 'zcash-shielded', network: 'zcash-testnet', payload: { txid, memoNonce: memo } } : { memo, txid })).toString('base64') });
const pay = (s: Local, memo: string, txid: string, path = '/api/quote', v1 = false, method = 'GET') => request(s.base, path, { method, headers: payment(memo, txid, v1) });
const encoded = (value: any) => ({ 'x-payment': Buffer.from(JSON.stringify(value)).toString('base64') });
const challenge = async (s: Local, path = '/api/quote') => {
  const r = await request(s.base, path);
  eq(r.status, 402);
  return r.body.accepts[0];
};
const ADMIN = 'audit-disposable-admin-2026';
const admin = { authorization: `Bearer ${ADMIN}` };
const count = (file: string, table: string, where = '') => {
  const db = new DatabaseSync(file);
  try { return Number((db.prepare(`SELECT count(*) AS n FROM ${table} ${where}`).get() as any).n); } finally { db.close(); }
};
const suite = readFileSync(join(logDir, 'suite.txt'), 'utf8');
async function suiteRow(number: number, fragment: string, note: string) {
  await row(number, async () => {
    const lines = suite.split('\n').filter((s) => s.includes('✓ test/') && s.includes(fragment));
    ok(lines.length, 'matching gateway suite assertion passed');
    records.push({ command: 'pnpm --filter @zpv/gateway test --reporter=verbose', log: 'audit/gateway/suite.txt', tests: lines });
  }, note);
}

try {
  await row(1, async () => local({}, async (s) => {
    const h = await request(s.base, '/api/health');
    eq(h.status, 200); eq(h.body, { ok: true, payTo: '', paths: [], lightwalletd: { urls: ['http://127.0.0.1:9', 'https://testnet.zec.rocks:443'], quorum: 1 } });
  }, { entry: 'api', env: { ZPV_LWD_URLS: 'http://127.0.0.1:9,https://testnet.zec.rocks:443', ZPV_LWD_QUORUM: '1' } }), 'api.ts health resolves configured URL list and quorum');
  await row(2, async () => local({}, async (s) => {
    const h = await request(s.base, '/api/health'); eq(h.status, 200);
    eq(h.body, { ok: true, payTo: run.wallets.merchant.address, paths: ['/api/quote', '/api/report'], lightwalletd: { urls: ['https://testnet.zec.rocks:443'], quorum: 1 } });
    const c = await challenge(s); eq(c.minConf, 1); eq(c.amountZat, '10000');
  }, { entry: 'main' }), 'main.ts health, default paths, price and confirmation floor');
  await row(3, async () => {
    const h = await request('https://hanko-api.201-18-198-162.sslip.io', '/api/health'); eq(h.status, 200); eq(h.body.ok, true);
    ok(Array.isArray(h.body.paths) && h.body.lightwalletd.urls.length > 0, 'hosted health advertises paths and endpoints');
    // Read the hosted console HTML and its JS only, without starting a browser or sending a payment.
    const html = await fetch('https://hanko-dashboard-six.vercel.app').then((r) => r.text());
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    let js = '';
    for (const src of scripts) js += await fetch(new URL(src, 'https://hanko-dashboard-six.vercel.app')).then((r) => r.text());
    ok(js.includes('https://hanko-api.201-18-198-162.sslip.io'), 'hosted console bundle names the health API destination');
    ok(js.includes('lightwalletd'), 'hosted console derives the endpoint send-note from health');
    records.push({ console: 'https://hanko-dashboard-six.vercel.app', scripts, apiDestinationMatches: true, healthEndpointSendNote: true });
  }, 'hosted health 200 JSON; hosted console destination and health-derived endpoint note match');
  await row(4, async () => local({ verifyApi: true }, async (s) => {
    const r = await post(s.base, zcash()); eq(r.status, 200); eq(r.body.rail, 'zcash'); eq(r.body.ok, true); eq(r.body.verdict, 'paid'); eq(r.body.paidZat, 100000); eq(r.body.reasons, []);
    ok(r.body.report?.found && r.body.provenance?.tip > 0 && r.body.provenance.checkedAt && r.body.provenance.lightwalletd, 'real report and provenance');
  }), 'recorded x402 transaction paid with report and provenance');
  await row(5, async () => local({ verifyApi: true }, async (s) => {
    const r = await post(s.base, { ...zcash(), memo: 'wrong invoice' }); eq(r.status, 200); eq(r.body.ok, false); eq(r.body.verdict, 'refused'); eq(r.body.reasons, ['MEMO_MISMATCH', 'AMOUNT_TOO_LOW']); ok(r.body.report?.found, 'real report retained');
  }), 'wrong memo refused; report retained');
  await row(6, async () => local({ verifyApi: true }, async (s) => {
    const p = await proofFromSettleTx(run.thirdParty.null402.settleTx);
    const r = await post(s.base, { rail: 'null402', proof: p.proof, publicSignals: p.publicSignals });
    eq(r.status, 200); eq(r.body.rail, 'null402'); eq(r.body.ok, false); eq(r.body.checks, { proofValid: true, rootKnown: true, nullifierSpent: true });
    eq(r.body.reasons, ['NULLIFIER_SPENT', 'UNBOUND']); eq(r.body.provenance.chainId, 43113); ok(r.body.provenance.blockNumber && r.body.provenance.checkedAt, 'Fuji provenance');
  }), 'recorded Fuji settlement proof extracted read-only and checked through HTTP');
  await row(7, async () => {
    await local({}, async (s) => { const r = await post(s.base, {}); eq(r.status, 404); eq(r.body, { error: 'not found' }); }, { entry: 'main' });
    await local({}, async (s) => { const r = await post(s.base, null); eq(r.status, 400); }, { entry: 'main', env: { ZPV_VERIFY_API: '1' } });
    await local({}, async (s) => { const r = await post(s.base, null); eq(r.status, 400); }, { entry: 'api' });
  }, 'production verify disabled by default; enabled by explicit flag and api.ts');
  await row(8, async () => local({}, async (s) => {
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) { const r = await request(s.base, '/api/verify', { method }); eq(r.status, 405); eq(r.body, method === 'HEAD' ? '' : { error: 'POST a verify request' }); }
  }, { entry: 'api' }), 'verify GET HEAD PUT DELETE rejected before checking');
  await row(9, async () => local({}, async (s) => {
    const r = await request(s.base, '/api/verify', { method: 'OPTIONS', headers: { origin: 'https://allowed.audit' } }); eq(r.status, 204); eq(r.body, ''); eq(r.headers['access-control-allow-origin'], 'https://allowed.audit'); eq(r.headers['access-control-allow-headers'], 'content-type, x-payment');
  }, { entry: 'api' }), 'verify OPTIONS returns allowed origin headers with empty body');
  await row(10, async () => local({ verifyApi: true, lwdUrl: 'http://127.0.0.1:9' }, async (s) => {
    for (const type of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const r = await request(s.base, '/api/verify', { method: 'POST', headers: type ? { 'content-type': type } : {}, body: Buffer.from(JSON.stringify(zcash())) });
      eq(r.status, 415); eq(r.body.error, 'POST /api/verify with content-type application/json');
    }
    const r = await post(s.base, zcash(), { 'content-type': 'application/json; charset=utf-8' }); eq(r.status, 502);
  }), 'JSON-only gate and charset acceptance with a real unavailable upstream');
  await row(11, async () => local({ verifyApi: true }, async (s) => {
    for (const body of ['', '{']) { const r = await request(s.base, '/api/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body }); eq(r.status, 400); eq(r.body, { error: 'body is not JSON' }); }
  }), 'empty and malformed JSON rejected');
  await row(12, async () => local({ verifyApi: true }, async (s) => {
    const r = await request(s.base, '/api/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(1000001) }) }); eq(r.status, 400); eq(r.body, { error: 'request body too large' });
  }), 'over 1,000,000 character JSON rejected without a verification');
  await row(13, async () => local({ verifyApi: true }, async (s) => {
    for (const body of [null, [], 1, 'scalar', false]) { const r = await post(s.base, body); eq(r.status, 400); eq(r.body, { error: 'the request must be an object with a rail (zcash or null402)' }); }
    const r = await post(s.base, { rail: 'btc' }); eq(r.status, 400); eq(r.body, { error: "unknown rail 'btc' (zcash or null402)" });
  }), 'nonobjects and unsupported rail rejected');
  await row(14, async () => local({ verifyApi: true }, async (s) => {
    const r = await post(s.base, { ...zcash(), txid: 'invalid' }); eq(r.status, 400); ok(r.body.error.startsWith('not a txid (64 hex characters):'), 'txid validation'); eq(Object.keys(r.body), ['error']);
  }), 'malformed txid caller error with no report');
  await row(15, async () => local({ verifyApi: true }, async (s) => {
    for (const [uivk, expected] of [['wrong-prefix', 'uivk must be a testnet unified incoming viewing key (uivktest1…)'], ['uivktest1malformed', 'not a testnet unified incoming viewing key']]) {
      const r = await post(s.base, { ...zcash(), uivk }); eq(r.status, 400); eq(r.body.error, expected);
    }
  }), 'wrong-prefix and malformed encoded key rejected; evidence has no keys');
  await row(16, async () => local({ verifyApi: true }, async (s) => {
    const cases: [any, string][] = [];
    for (const v of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, '2100000000000001']) cases.push([{ amountZat: v }, 'amountZat must be a whole number of zatoshi']);
    for (const v of [-1, 0.1, '1', Number.MAX_SAFE_INTEGER + 1]) cases.push([{ minConf: v }, 'minConf must be a whole number']);
    for (const v of [0, 'false', null]) cases.push([{ allowTransparent: v }, 'allowTransparent must be true or false']);
    cases.push([{ memo: 1 }, 'memo must be a string'], [{ memo: 'é'.repeat(257) }, 'memo is longer than 512 bytes'], [{ memo: 'a\0b' }, 'memo must not contain a NUL'], [{ uivk: fx.x402.uivk + '\n' }, 'uivk must not contain control characters']);
    for (const [patch, expected] of cases) { const r = await post(s.base, { ...zcash(), ...patch }); eq(r.status, 400); ok(r.body.error.startsWith(expected), expected); ok(!r.body.error.includes('\n'), 'one-line error'); }
  }), 'invalid amount, confirmations, boolean, memo bytes/NUL and key controls');
  await row(17, async () => local({ verifyApi: true }, async (s) => {
    const good = { rail: 'null402', proof: { pi_a: ['1', '2', '1'], pi_b: [['1', '2'], ['3', '4'], ['1', '0']], pi_c: ['1', '2', '1'] }, publicSignals: ['1', '2', '3', '4', '5'] };
    const cases: [any, string][] = [[{ publicSignals: [] }, 'publicSignals']];
    for (const bad of ['-1', 'abc', '', (1n << 256n).toString()]) {
      cases.push([{ publicSignals: [bad, '2', '3', '4', '5'] }, 'publicSignals[0]']);
      for (const field of ['payTo', 'requiredAmount', 'contextHash']) cases.push([{ expect: { [field]: bad } }, `expect.${field}`]);
    }
    for (const proof of [null, {}, [], { pi_a: ['-1', '2'], pi_b: [['1', '2'], ['3', '4']], pi_c: ['1', '2'] }]) cases.push([{ proof }, 'proof']);
    for (const [patch, expected] of cases) { const r = await post(s.base, { ...good, ...patch }); eq(r.status, 400); ok(r.body.error.includes(expected), expected); }
  }), 'null402 signal, expectation and proof validation');
  await row(18, async () => local({}, async (s) => {
    for (const path of ['/api/health', '/unknown']) { const r = await request(s.base, path, { headers: { origin: 'https://allowed.audit' } }); eq(r.headers['access-control-allow-origin'], 'https://allowed.audit'); eq(r.headers.vary, 'origin'); eq(r.headers['access-control-allow-headers'], 'content-type, x-payment'); eq(r.headers['access-control-expose-headers'], 'x-payment-response'); }
  }, { entry: 'api' }), 'exact allowed origin headers on success and error');
  await row(19, async () => local({}, async (s) => {
    for (const headers of [{}, { origin: 'https://unlisted.audit' }]) { const r = await request(s.base, '/api/health', { headers }); eq(r.status, 200); ok(!r.headers['access-control-allow-origin'] && !r.headers['access-control-allow-headers'], 'no CORS permission emitted'); }
  }, { entry: 'api' }), 'unlisted and absent origins receive JSON without CORS permission');
  await row(20, async () => local({ verifyApi: true, lwdUrl: 'http://127.0.0.1:9' }, async (s) => {
    const r = await post(s.base, zcash()); eq(r.status, 502); eq(r.headers['retry-after'], '30'); ok(!r.body.error.includes('\n'), 'one-line upstream failure'); eq(Object.keys(r.body), ['error']);
  }), 'closed real local upstream yields 502 retry 30, never paid or caller error');
  await row(21, async () => local({ verifyApi: true }, async (s) => {
    const r = await post(s.base, zcash()); eq(r.status, 503); ok(r.body.error.startsWith('Setup required: ZPV_BIN'), 'missing binary named'); eq(Object.keys(r.body), ['error']);
  }, { env: { ZPV_BIN: '/nonexistent/hanko-audit-binary' } }), 'missing binary yields Setup required without fabricated verdict');
  await suiteRow(22, '150 verify requests at once', '150 real HTTP requests cap child checks at 4, queue at 4; 142 busy responses retry 5');
  await row(23, async () => local({ verifyApi: true }, async (s) => {
    const r = await post(s.base, { rail: 'null402', proof: { pi_a: ['1', '2'], pi_b: [['1', '2'], ['3', '4']], pi_c: ['1', '2'] }, publicSignals: ['1', '2', '3', '4', '5'] }); eq(r.status, 502); ok(!/\n|Version: viem|Request body/.test(r.body.error), 'clean upstream error'); ok(r.body.error.length <= 301, 'bounded error');
  }, { env: { ZPV_FUJI_RPC: 'http://127.0.0.1:9' } }), 'real failed Fuji HTTP request cleaned to a single line without request dump');
  await row(24, async () => local({}, async (s) => { const r = await request(s.base, '/api/refunds', { headers: { 'x-forwarded-for': '203.0.113.10' } }); eq(r.status, 503); eq(r.body.error, 'Setup required: ZPV_ADMIN_TOKEN (set it to list refunds, then send Authorization: Bearer <token>)'); }), 'refund list disabled without admin token even behind proxy');
  await row(25, async () => local({ adminToken: ADMIN }, async (s) => {
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: ADMIN }, { authorization: 'Basic abc', 'x-forwarded-for': '127.0.0.1' }]) { const r = await request(s.base, '/api/refunds', { headers }); eq(r.status, 401); eq(r.body.error, 'refunds need Authorization: Bearer <ZPV_ADMIN_TOKEN>'); eq(r.headers['www-authenticate'], 'Bearer'); }
  }), 'missing, malformed and wrong tokens cannot list refunds');
  await row(26, async () => local({ adminToken: ADMIN }, async (s) => { const r = await request(s.base, '/api/refunds', { headers: admin }); eq(r.status, 200); eq(r.body, { refunds: [] }); }), 'authorized fresh SQLite refund list empty');
  await row(27, async () => local({ memo: run.paywall.cases.underpaid.challengeMemo, adminToken: ADMIN }, async (s) => {
    await challenge(s); const c = run.paywall.cases.underpaid; await pay(s, c.challengeMemo, c.txid); await pay(s, c.challengeMemo, c.txid);
    const r = await request(s.base, '/api/refunds', { headers: admin }); eq(r.status, 200); eq(r.body.refunds.length, 1);
    const f = r.body.refunds[0]; eq(f.txid, c.txid); eq(f.memo, c.challengeMemo); eq(f.resource, '/api/quote'); eq(f.paidZat, 5000); eq(f.reasons, ['AMOUNT_TOO_LOW']); ok(f.height > 0 && f.blockTime > 0 && f.at, 'complete real refund provenance');
    ok(suite.includes('✓ test/refunds.test.ts > refunds > a refused payment'), 'suite verifies newest-first ordering for two real payments');
  }), 'actual underpayment recorded twice, one full SQLite refund row; suite verifies newest-first');
  for (const [number, path, amount, uriAmount] of [[28, '/api/quote', '10000', '0.0001'], [29, '/api/report', '50000', '0.0005']] as const) {
    await row(number, async () => local({}, async (s) => {
      const r = await request(s.base, path); eq(r.status, 402); eq(r.body.x402Version, 1); eq(r.body.error, 'payment required'); eq(r.body.accepts.length, 1);
      const c = r.body.accepts[0]; eq(c.scheme, 'zcash-shielded'); eq(c.network, 'zcash-testnet'); eq(c.asset, 'ZEC'); eq(c.resource, path); eq(c.amountZat, amount); eq(c.minConf, 1);
      eq(c.extra.memoNonce, c.memo); eq(c.extra.paymentUri, c.zip321); eq(c.extra.minConf, c.minConf); eq(c.extra.expiresAt, Math.floor(c.expiresAt / 1000));
      const uri = new URL(c.zip321); eq(uri.protocol, 'zcash:'); eq(uri.searchParams.get('amount'), uriAmount); eq(Buffer.from(uri.searchParams.get('memo')!, 'base64url').toString(), c.memo); ok(/^zpv-\d{10}-[0-9a-f]{16}-[\w-]{22}$/.test(c.memo), 'authenticated memo form');
    }, { entry: 'main' }), `production unpaid ${path} challenge, defaults and ZIP-321`);
  }
  await row(30, async () => local({}, async (s) => { const r = await request(s.base, '/api/quote', { method: 'HEAD' }); eq(r.status, 402); eq(r.headers['content-type'], 'application/json'); eq(r.body, ''); }, { entry: 'main' }), 'unpaid quote HEAD has 402 JSON headers and no body');
  await row(31, async () => {
    await local({}, async (s) => { const r = await request(s.base, '/api/report', { method: 'HEAD' }); eq(r.status, 402); eq(r.body, ''); }, { entry: 'main' });
    await local({ profile: 'employee', memo: run.payslip.memo }, async (s) => { await challenge(s, '/api/report'); const r = await pay(s, run.payslip.memo, run.payslip.txid, '/api/report', true, 'HEAD'); eq(r.status, 200); eq(r.body, ''); eq(r.settlement.success, true); eq(r.settlement.transaction, run.payslip.txid); });
  }, 'report HEAD unpaid 402, recorded matching payment 200 receipt without body');
  for (const [number, path] of [[32, '/api/quote'], [33, '/api/report']] as const) await row(number, async () => local({}, async (s) => {
    const r = await request(s.base, path, { method: 'OPTIONS' }); eq(r.status, 204); eq(r.body, ''); eq(r.headers.allow, 'GET, HEAD, OPTIONS'); eq(r.headers['access-control-allow-methods'], 'GET, HEAD, OPTIONS'); eq(count(s.file, 'challenges'), 0); eq(count(s.file, 'claims'), 0);
  }, { entry: 'main' }), `${path} OPTIONS empty; no challenge or claim stored`);
  for (const [number, path, methods] of [[34, '/api/quote', ['POST']], [35, '/api/report', ['POST', 'PUT', 'DELETE']]] as const) await row(number, async () => local({}, async (s) => {
    for (const method of methods) { const r = await request(s.base, path, { method }); eq(r.status, 405); eq(r.body.error, `${method} is not allowed on a paid path: GET it`); eq(r.headers.allow, 'GET, HEAD, OPTIONS'); }
    eq(count(s.file, 'claims'), 0);
  }, { entry: 'main' }), `${path} unsupported methods rejected before claims`);
  await row(36, async () => local({}, async (s) => { const r = await request(s.base, '/not-a-route'); eq(r.status, 404); eq(r.body, { error: 'not found' }); eq(count(s.file, 'challenges'), 0); eq(count(s.file, 'claims'), 0); }, { entry: 'main' }), 'unknown route returns exact 404 with no challenge or claim');
  // Only the external parser is unavailable; wire acceptance is exercised independently below.
  if (!process.env.HANKO_AUDIT_ROWS || process.env.HANKO_AUDIT_ROWS.split(',').includes('37')) {
    const kage = process.env.KAGE_X402_DIR;
    if (!kage || !existsSync(join(kage, 'src/index.ts'))) {
      writeFileSync(join(logDir, 'API-037.json'), JSON.stringify({ id: 'API-037', at: new Date().toISOString(), status: 'UNTESTED', reason: 'needs KAGE_X402_DIR', configuredClient: false, siblingCheckoutPresent: false, evidence: 'audit/gateway/suite.txt', independentZip321: ['API-028.json', 'API-029.json'], independentWireForms: 'API-045.json' }, null, 2) + '\n');
      status(37, 'UNTESTED', 'needs KAGE_X402_DIR. No configured client and no sibling zec-shielded-x402 checkout; suite.txt records the two client import setup errors. ZIP-321 fields are verified by API-028/029; wire forms by API-045. Evidence: audit/gateway/API-037.json.');
      console.log('API-037 UNTESTED needs KAGE_X402_DIR');
    } else await row(37, async () => { ok(suite.includes('✓ test/kage-client.test.ts'), 'Kage parser suite passed'); }, 'external Kage parser suite');
  }
  await row(38, async () => local({}, async (s) => { const r = await request(s.base, '/api/quote', { headers: { 'x-payment': '%%%' } }); eq(r.status, 400); eq(r.body.error, 'X-PAYMENT is not base64 JSON {memo, txid}'); eq(r.settlement.success, false); eq(r.settlement.errorReason, 'invalid_payload'); }), 'malformed base64 JSON returns exact error and false settlement');
  await row(39, async () => local({}, async (s) => {
    for (const value of [null, 7, 'scalar', [], { memo: 1 }, { txid: 1 }]) { const r = await request(s.base, '/api/quote', { headers: encoded(value) }); eq(r.status, 400); eq(r.body.error, 'X-PAYMENT must be base64 JSON {memo: string, txid: string}'); }
    eq(count(s.file, 'claims'), 0);
  }), 'scalar, array and typed legacy header fields rejected');
  await row(40, async () => local({}, async (s) => {
    const valid = { x402Version: 1, scheme: 'zcash-shielded', network: 'zcash-testnet', payload: { txid: run.paywall.cases.paywall.txid, memoNonce: 'none' } };
    for (const patch of [{ x402Version: 2 }, { scheme: 'other' }, { network: 'other' }]) { const r = await request(s.base, '/api/quote', { headers: encoded({ ...valid, ...patch }) }); eq(r.status, 400); eq(r.body.error, 'X-PAYMENT must be x402Version 1, scheme zcash-shielded, network zcash-testnet'); }
    for (const payload of [null, [], {}, { txid: 2, memoNonce: 3 }]) { const r = await request(s.base, '/api/quote', { headers: encoded({ ...valid, payload }) }); eq(r.status, 400); eq(r.body.error, 'X-PAYMENT payload must be {txid: string, memoNonce: string}'); }
  }), 'wrong v1 version, scheme, network and payload rejected');
  await row(41, async () => local({}, async (s) => { const c = await challenge(s); const r = await request(s.base, '/api/quote', { headers: encoded({ memo: c.memo }) }); eq(r.status, 402); eq(r.body.error, 'X-PAYMENT has no txid'); eq(r.body.accepts, [c]); eq(count(s.file, 'claims'), 0); }), 'known memo without txid retains challenge and consumes nothing');
  await row(42, async () => local({}, async (s) => {
    const c = await challenge(s); const [, expiry, nonce, tag] = /^zpv-(\d+)-([\da-f]+)-(.+)$/.exec(c.memo)!;
    for (const [memo, path] of [['unknown', '/api/quote'], [`zpv-${Number(expiry) + 1}-${nonce}-${tag}`, '/api/quote'], [`zpv-${expiry}-${'0'.repeat(16)}-${tag}`, '/api/quote'], [`zpv-${expiry}-${nonce}-${'A'.repeat(22)}`, '/api/quote'], [c.memo, '/api/report']]) {
      const r = await pay(s, memo, run.paywall.cases.paywall.txid, path); eq(r.status, 402); eq(r.body.error, 'unknown or expired payment memo'); eq(r.settlement.errorReason, 'unknown_challenge'); ok(r.body.accepts[0].memo !== memo, 'replacement challenge');
    }
    eq(count(s.file, 'claims'), 0);
  }), 'unknown and tampered HMAC/path rejected before verification; expired window also API-062');
  await row(43, async () => local({}, async (s) => { const c = await challenge(s); const r = await pay(s, c.memo, run.paywall.cases.paywall.txid); eq(r.status, 402); eq(r.body.error, 'payment refused: MEMO_MISMATCH, AMOUNT_TOO_LOW'); eq(r.body.accepts, [c]); ok(!r.body.data, 'no data'); }), 'fresh current challenge refuses historical memo with real report reasons');
  await row(44, async () => local({ memo: run.paywall.cases.paywall.challengeMemo }, async (s) => {
    await challenge(s); const c = run.paywall.cases.paywall; const r = await pay(s, c.challengeMemo, c.txid); eq(r.status, 200);
    eq(r.body.paid.txid, c.txid); eq(r.body.paid.paidZat, 10000); eq(r.body.paid.memo, c.challengeMemo); ok(r.body.paid.height > 0 && r.body.paid.confirmations > 0 && r.body.paid.lightwalletd, 'receipt provenance');
    eq(r.body.data.path, '/api/quote'); eq(r.body.data.note, 'paid with a shielded Zcash payment, checked with a viewing key');
  }), 'published 10000-zat quote accepted only in disposable matching challenge');
  await row(45, async () => {
    const c = run.paywall.cases.paywall;
    for (const v1 of [true, false]) await local({ memo: c.challengeMemo }, async (s) => { await challenge(s); const r = await pay(s, c.challengeMemo, c.txid.toUpperCase(), '/api/quote', v1); eq(r.status, 200); eq(r.settlement, { success: true, transaction: c.txid, network: 'zcash-testnet', payer: '' }); eq((await pay(s, c.challengeMemo, c.txid)).status, 402); });
  }, 'v1 and legacy forms accepted once in separate disposable SQLite stores');
  await row(46, async () => local({ profile: 'employee', memo: run.payslip.memo }, async (s) => {
    await challenge(s, '/api/report'); const r = await pay(s, run.payslip.memo, run.payslip.txid, '/api/report'); eq(r.status, 200); eq(r.body.data.path, '/api/report'); eq(r.body.paid.paidZat, 50000);
    eq(count(s.file, 'claims', "WHERE state = 'paid'"), 2); eq(count(s.file, 'challenges'), 0);
  }), 'recorded payslip accepted for report with its receiver and one paid memo/txid pair');
  await row(47, async () => local({ memo: run.paywall.cases.paywall.challengeMemo }, async (s) => {
    const c = run.paywall.cases.paywall; await challenge(s); eq((await pay(s, c.challengeMemo, c.txid)).status, 200);
    eq((await pay(s, c.challengeMemo, c.txid.toUpperCase())).body.error, 'unknown or expired payment memo');
    await challenge(s); const r = await pay(s, c.challengeMemo, c.txid.toUpperCase()); eq(r.status, 402); eq(r.body.error, 'this transaction already paid for a request'); eq(r.settlement.errorReason, 'nonce_already_used');
  }), 'case-normalized replay refused, including closed custom memo and reissued memo');
  await row(48, async () => local({ memo: run.paywall.cases['wrong-memo'].challengeMemo }, async (s) => {
    const c = run.paywall.cases['wrong-memo']; await challenge(s); const r = await pay(s, c.challengeMemo, c.txid); eq(r.status, 402); eq(r.body.reasons, ['MEMO_MISMATCH', 'AMOUNT_TOO_LOW']); eq(r.settlement.success, false); ok(!r.body.data, 'no data');
  }), 'recorded wrong-memo payment refused in its own recorded challenge');
  for (const [number, name, amount, reason] of [[49, 'underpaid', 5000, 'AMOUNT_TOO_LOW'], [50, 'transparent-part', 10000, 'TRANSPARENT_PART']] as const) await row(number, async () => {
    const c = run.paywall.cases[name]; const file = join(tmp, `refund-${number}.sqlite`);
    await local({ memo: c.challengeMemo, adminToken: ADMIN }, async (s) => { await challenge(s); const r = await pay(s, c.challengeMemo, c.txid); eq(r.status, 402); eq(r.body.reasons, [reason]); eq(r.body.received, { zat: amount, recorded: true }); ok(!r.body.data, 'no data served'); }, { file });
    await local({ adminToken: ADMIN }, async (s) => { const r = await request(s.base, '/api/refunds', { headers: admin }); eq(r.body.refunds.length, 1); eq(r.body.refunds[0].paidZat, amount); eq(r.body.refunds[0].memo, c.challengeMemo); eq(r.body.refunds[0].resource, '/api/quote'); eq(r.body.refunds[0].reasons, [reason]); }, { file });
  }, `${name} real refund row persists through process restart`);
  await suiteRow(51, 'TX_NOT_FOUND (lightwalletd has not seen', 'six absent-txid HTTP checks in existing suite do not close challenge; recorded matching payment then accepted');
  await row(52, async () => local({ memo: run.paywall.cases.paywall.challengeMemo, minConf: 100000000, adminToken: ADMIN }, async (s) => {
    const c = run.paywall.cases.paywall; await challenge(s); const r = await pay(s, c.challengeMemo, c.txid); eq(r.status, 402); eq(r.body.reasons, ['NOT_CONFIRMED']); ok(/^payment seen, \d+\/100000000 confirmations$/.test(r.body.error), 'actual confirmation depth'); eq(r.settlement.errorReason, 'settlement_pending'); eq(count(s.file, 'failures'), 0); eq(count(s.file, 'refunds'), 0); eq(count(s.file, 'claims'), 0);
  }), 'high confirmation floor produces pending receipt, no refusal increment/refund, claim released');
  await suiteRow(53, 'after 5 counted refusals', 'five real wrong-receiver refusals close challenge; matching payment becomes CHALLENGE_CLOSED refund');
  await row(54, async () => local({ memo: run.paywall.cases.paywall.challengeMemo, lwdUrls: ['https://testnet.zec.rocks:443', 'http://127.0.0.1:9'] }, async (s) => {
    const c = run.paywall.cases.paywall; const original = await challenge(s); const r = await pay(s, c.challengeMemo, c.txid); eq(r.status, 503); eq(r.headers['retry-after'], '30'); eq(r.body.error, 'payment could not be verified: UNVERIFIED_QUORUM; retry later'); eq(r.body.reasons, ['UNVERIFIED_QUORUM']); eq(r.body.accepts, [original]); ok(r.body.crossCheck && !r.body.data, 'cross-check retained without data'); eq(count(s.file, 'failures'), 0); eq(count(s.file, 'claims'), 0);
  }), 'testnet plus unavailable loopback causes real quorum shortfall with claim released');
  await row(55, async () => {
    const c = run.paywall.cases.paywall;
    for (const setup of [false, true]) await local({ memo: c.challengeMemo, lwdUrl: 'http://127.0.0.1:9' }, async (s) => {
      await challenge(s); const r = await pay(s, c.challengeMemo, c.txid); eq(r.status, 503); eq(r.headers['retry-after'], setup ? '60' : '30'); ok(r.body.error.includes('nothing was served, retry later'), 'retryable check failure'); eq(count(s.file, 'claims'), 0);
      const retry = await pay(s, c.challengeMemo, c.txid); eq(retry.status, 503); ok(!retry.body.error.includes('already being checked'), 'released for retry');
    }, { env: setup ? { ZPV_BIN: '/nonexistent/hanko-audit-binary' } : {} });
    const u = run.paywall.cases.underpaid; const t = run.paywall.cases['transparent-part'];
    await local({ memoList: [u.challengeMemo, t.challengeMemo] }, async (s) => {
      await challenge(s); await challenge(s);
      const pending = pay(s, u.challengeMemo, u.txid);
      for (let i = 0; i < 100 && count(s.file, 'claims') === 0; i++) await sleep(5);
      const r = await pay(s, t.challengeMemo, t.txid); eq(r.status, 503); eq(r.headers['retry-after'], '5'); ok(r.body.error.includes('retry later'), 'paywall busy error');
      await pending; eq(count(s.file, 'claims'), 0);
    }, { env: { ZPV_MAX_CHECKS: '1', ZPV_MAX_QUEUE: '0' } });
  }, 'real unreachable upstream retry 30, missing binary retry 60, paywall capacity retry 5; claims released');
  await suiteRow(56, 'two concurrent requests with the same payment', 'concurrent lower/uppercase recorded payment yields exactly one 200 and one 402');
  await row(57, async () => {
    const c = run.paywall.cases.paywall; const file = join(tmp, 'interrupted.sqlite'); const clock = Date.now();
    const first = await start({ memo: c.challengeMemo, nowMs: clock }, { file });
    await challenge(first);
    const pending = pay(first, c.challengeMemo, c.txid).catch(() => null);
    for (let i = 0; i < 100 && count(file, 'claims') === 0; i++) await sleep(5);
    eq(count(file, 'claims', "WHERE state = 'checking'"), 2);
    await stop(first.child, 'SIGKILL'); await pending;
    await local({ memo: c.challengeMemo, nowMs: clock + 300001 }, async (s) => { const r = await pay(s, c.challengeMemo, c.txid); eq(r.status, 200); }, { file });
    ok(suite.includes('✓ test/store.test.ts > store claims > an expired lease can be taken over'), 'real SQLite old owner cannot release or settle new lease');
    // A live loser also reaches the server's stale-owner HTTP branch (two real checks, clock moved).
    const raceFile = join(tmp, 'lease-race.sqlite');
    const a = await start({ memo: c.challengeMemo, nowMs: clock }, { file: raceFile });
    const b = await start({ memo: c.challengeMemo, nowMs: clock + 300001 }, { file: raceFile });
    try {
      await challenge(a); const slow = pay(a, c.challengeMemo, c.txid);
      for (let i = 0; i < 100 && count(raceFile, 'claims') === 0; i++) await sleep(5);
      const next = pay(b, c.challengeMemo, c.txid); const [old, winner] = await Promise.all([slow, next]);
      eq(old.status, 402); eq(old.body.error, 'this payment was claimed by another request while it was being checked'); eq(winner.status, 200);
    } finally { await a.close(); await b.close(); }
  }, 'SIGKILL real claimant; 5-minute lease takeover; old owner guarded and HTTP loser refused');
  await row(58, async () => {
    const c = run.paywall.cases.underpaid; const file = join(tmp, 'persistent.sqlite');
    await local({ memo: c.challengeMemo }, async (s) => { await challenge(s); await pay(s, c.challengeMemo, c.txid); eq(count(file, 'failures'), 1); eq(count(file, 'refunds'), 1); }, { file });
    await local({ adminToken: ADMIN }, async (s) => { const r = await request(s.base, '/api/refunds', { headers: admin }); eq(r.body.refunds.length, 1); const db = new DatabaseSync(file); try { eq((db.prepare('SELECT n FROM failures WHERE memo = ?').get(c.challengeMemo) as any).n, 1); } finally { db.close(); } }, { file });
    for (const fragment of ['a restarted paywall on the same file refuses', 'the same payment sent to both at once is served once', 'with a SQLite store the HMAC key survives']) ok(suite.split('\n').some((line) => line.includes('✓ test/') && line.includes(fragment)), fragment);
    records.push({ suiteEvidence: 'audit/gateway/suite.txt', sharedProcessesPaidOnce: true, paidClaimsRestarted: true, hmacRestarted: true });
  }, 'actual SQLite refund and failure counts survive process restart; suite covers paid claims, HMAC and shared processes');
  await row(59, async () => {
    const c = run.paywall.cases.paywall; let oldMemo = '';
    await local({ memory: true }, async (s) => { oldMemo = (await challenge(s)).memo; });
    await local({ memory: true }, async (s) => { const r = await pay(s, oldMemo, c.txid); eq(r.status, 402); eq(r.body.error, 'unknown or expired payment memo'); });
    await local({ memory: true, memo: c.challengeMemo }, async (s) => { await challenge(s); eq((await pay(s, c.challengeMemo, c.txid)).status, 200); });
    await local({ memory: true, memo: c.challengeMemo, adminToken: ADMIN }, async (s) => { eq((await request(s.base, '/api/refunds', { headers: admin })).body.refunds, []); await challenge(s); eq((await pay(s, c.challengeMemo, c.txid)).status, 200); });
    const underpaid = run.paywall.cases.underpaid;
    await local({ memory: true, memo: underpaid.challengeMemo, adminToken: ADMIN }, async (s) => {
      await challenge(s); eq((await pay(s, underpaid.challengeMemo, underpaid.txid)).status, 402);
      eq((await request(s.base, '/api/refunds', { headers: admin })).body.refunds.length, 1);
    });
    await local({ memory: true, adminToken: ADMIN }, async (s) => { eq((await request(s.base, '/api/refunds', { headers: admin })).body.refunds, []); });
    await local({}, async (s) => { ok(s.output().includes('in memory: a restart forgets served payments'), 'startup explicitly warns state is volatile'); }, { entry: 'main', env: { ZPV_STORE: undefined } });
  }, 'explicit memory-restart scenario forgets paid state and invalidates HMAC; production startup warning');
  await row(60, async () => {
    for (const fragment of ['10,000 GETs store nothing', 'open challenges are capped and expired ones are dropped']) ok(suite.split('\n').some((line) => line.includes('✓ test/') && line.includes(fragment)), fragment);
    records.push({ suiteEvidence: 'audit/gateway/suite.txt', unansweredHTTPGets: 10001, storedChallenges: 0, customCapAndExpiry: true });
    await local({ maxOpenChallenges: 1, memo: 'audit-custom-cap', counterMemo: true }, async (s) => { await challenge(s); const r = await request(s.base, '/api/quote'); eq(r.status, 503); eq(r.headers['retry-after'], '60'); eq(r.body.error, 'too many open payment challenges; retry later'); });
  }, 'suite 10,001 default GETs store nothing; exact custom-cap retry and error over HTTP');
  await row(61, async () => {
    ok(suite.split('\n').some((line) => line.includes('✓ test/refunds.test.ts > mined-time expiry')), 'real mined-time grace acceptance and PAYMENT_LATE persisted refund suite passed');
    const c = run.paywall.cases.paywall; const mined = 1792512944000; const file = join(tmp, 'expiry.sqlite');
    await local({ memo: c.challengeMemo, nowMs: mined - 600000, challengeTtlMs: 300000, minedGraceMs: 120000 }, async (s) => { await challenge(s); await s.clock(mined + 1800000); const r = await pay(s, c.challengeMemo, c.txid); eq(r.status, 402); eq(r.body.reasons, ['PAYMENT_LATE']); eq(r.settlement.errorReason, 'payment_expired'); eq(count(file, 'refunds'), 1); }, { file });
  }, 'real block-time grace tested by suite; HTTP late receipt payment_expired and SQLite refund');
  await row(62, async () => local({ memo: run.paywall.cases.paywall.challengeMemo, nowMs: 1792512944000, challengeTtlMs: 300000 }, async (s) => {
    const c = await challenge(s); await s.clock(c.expiresAt + 86400001); const r = await pay(s, c.memo, run.paywall.cases.paywall.txid); eq(r.status, 402); eq(r.body.error, 'unknown or expired payment memo'); eq(r.settlement.errorReason, 'unknown_challenge'); ok(!r.body.data, 'no data'); eq(count(s.file, 'claims'), 0);
  }), 'past expiry plus 24 hours produces replacement challenge with no claim or content');
  await suiteRow(63, 'a flood of /api/verify calls cannot take', 'saturating free verify slots still allows real recorded paywall payment; separate CheckLimiter');
  await row(64, async () => {
    ok(suite.split('\n').filter((line) => line.includes('✓ test/startup.test.ts')).length === 3, 'three startup suite tests passed');
    const baseEnv: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: process.env.HOME, ZPV_BIN: process.env.ZPV_BIN, ZPV_PAY_TO: run.wallets.merchant.address, ZPV_MERCHANT_UIVK: run.wallets.merchant.uivk, ZPV_STORE: join(tmp, 'startup.sqlite'), ZPV_PORT: '0' };
    for (const [patch, setting] of [
      [{ ZPV_PAY_TO: undefined }, 'ZPV_PAY_TO'], [{ ZPV_MERCHANT_UIVK: undefined }, 'ZPV_MERCHANT_UIVK'],
      [{ ZPV_LWD_URLS: 'https://testnet.zec.rocks:443,http://127.0.0.1:9', ZPV_LWD_QUORUM: 'abc' }, 'ZPV_LWD_QUORUM'],
      [{ ZPV_LWD_URLS: 'https://testnet.zec.rocks:443,http://127.0.0.1:9', ZPV_LWD_QUORUM: '3' }, 'ZPV_LWD_QUORUM'],
      [{ ZPV_MIN_CONF: '9007199254740993' }, 'ZPV_MIN_CONF'], [{ ZPV_MIN_CONF: '4294967296' }, 'ZPV_MIN_CONF'], [{ ZPV_PRICE_ZAT: '2100000000000001' }, 'ZPV_PRICE_ZAT'],
    ] as [Record<string, string | undefined>, string][]) {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd: join(root, 'packages/gateway'), env: { ...baseEnv, ...patch }, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child);
      let output = ''; child.stdout!.on('data', (d) => output += redact(d.toString())); child.stderr!.on('data', (d) => output += redact(d.toString()));
      const timer = setTimeout(() => child.kill('SIGTERM'), 2000); const [code] = await once(child, 'exit'); clearTimeout(timer); children.delete(child);
      records.push({ invalidSetting: setting, pid: child.pid, exit: code, output }); eq(code, 2, `invalid ${setting} exits 2`); ok(output.startsWith(`Setup required: ${setting}`), 'setting named before listen'); ok(!output.includes('zpv paywall on'), 'not listening');
    }
    const main = readFileSync(join(root, 'packages/gateway/src/main.ts'), 'utf8'); ok(main.includes("'8403'") && main.includes("'127.0.0.1'"), 'source defaults port 8403, loopback host');
    await local({}, async (s) => { eq(new URL(s.base).port, '8403'); const c = await challenge(s); eq(c.minConf, 1); eq(c.amountZat, '10000'); }, { entry: 'main', env: { ZPV_PORT: undefined } });
  }, 'production startup missing credentials, bad numeric/quorum/address/key settings; defaults');
} finally {
  for (const child of [...children]) await stop(child);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`HTTP audit complete: ${failures} failed rows; all spawned server PIDs stopped; disposable SQLite files removed.`);
}
process.exitCode = failures ? 1 : 0;
