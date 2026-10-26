// AUDIT.md MCP-001..017: actual SDK Client -> stdio server -> recorded chain reads.
// Incoming demo credentials are loaded internally exactly as in mcp.test.ts.
// Never serialize environment, fixture objects, gateway options or credential values.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type Socket } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createPaywall, SqliteStore } from '@zpv/gateway';
import { zpayBinary } from '@zpv/sdk';
import { afterAll, beforeAll, expect, it } from 'vitest';

const root = resolve(__dirname, '../../..');
const fx = JSON.parse(readFileSync(join(root, 'fixtures/testnet.json'), 'utf8'));
const deployment = JSON.parse(readFileSync(join(root, 'deployments/testnet.json'), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'hanko-mcp-audit-'));
const logDir = join(root, 'audit/mcp');
const statusPath = join(root, 'audit/status/mcp.json');
const suiteLog = process.env.HANKO_MCP_AUDIT_LOG ?? 'suite.txt';
const SETTLE = '0x8596f52de2d8c15680c96a0fa25b1bb5073324155f586203507cddf92f5ca593';
const SETTLE2 = '0xd91c0ab7d0d228d003277d62145442b24dcd52492becf561b9977c40fe781e5c';
const ZCASH = 'verify_zcash_payment';
const FUJI = 'verify_null402_settlement';
const paidArgs = { txid: fx.x402.txid as string, amount_zat: 100000, memo: fx.x402.memo as string };
const scrub = (s: string) => s.replace(/(?:uivktest1|uivk1|uviewtest1|uview1|secret-extended-key-test1|secret-extended-key-main1)[a-z0-9…]+/gi, '[REDACTED_VIEWING_KEY]');
type Session = { client: Client; transport: StdioClientTransport };
const sessions = new Set<Session>();
let plain: Session;
let evidence: unknown[] = [];

async function connect(extra: Record<string, string> = {}, merchant = 'x402') {
  const settings = Object.fromEntries(['ZPV_MCP_MIN_CONF', 'ZPV_MCP_REQUIRE_MEMO', 'ZPV_LWD_URL', 'ZPV_LWD_URLS', 'ZPV_LWD_QUORUM', 'ZPV_FUJI_RPC', 'ZPV_CHECK_TIMEOUT_MS'].filter(k => extra[k] !== undefined).map(k => [k, extra[k]]));
  evidence.push({ session: { merchantConfigured: merchant !== 'missing', isolatedStore: Boolean(extra.ZPV_STORE), auditLogConfigured: Boolean(extra.ZPV_MCP_LOG), settings } });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ZPV_BIN: zpayBinary(), ...extra,
  };
  if (merchant !== 'missing') env.ZPV_MERCHANT_UIVK = merchant === 'deployment' ? deployment.wallets.merchant.uivk : fx.x402.uivk;
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve(__dirname, '../dist/main.js')], env, stderr: 'pipe',
  });
  // Consume stderr without copying environment or debug output into evidence.
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'hanko-mcp-audit', version: '1.0.0' });
  const session = { client, transport };
  sessions.add(session);
  await client.connect(transport);
  return session;
}
async function close(s: Session) { await s.client.close(); sessions.delete(s); }
async function withSession(extra: Record<string, string>, fn: (s: Session) => Promise<void>, merchant?: string) {
  const s = await connect(extra, merchant);
  try { await fn(s); } finally { await close(s); }
}
async function call(s: Session, name: string, args: Record<string, unknown>) {
  const response = await s.client.callTool({ name, arguments: args }, undefined, { timeout: 110000 });
  const content = response.content as { type: string; text?: string }[];
  expect(content[0]?.type).toBe('text');
  const text = content[0].text!;
  const result = response.isError ? text : JSON.parse(text);
  evidence.push({ request: { name, arguments: args }, response: { isError: Boolean(response.isError), result } });
  return { isError: Boolean(response.isError), text, data: result as any };
}
async function json(s: Session, name: string, args: Record<string, unknown>) {
  const r = await call(s, name, args);
  expect(r.isError, r.text).toBe(false);
  return r.data;
}
const paid = async (s = plain, args: Record<string, unknown> = paidArgs) => json(s, ZCASH, args);
function claims(path: string) {
  const db = new DatabaseSync(path);
  try { return db.prepare('SELECT key, state, until FROM claims ORDER BY key').all(); }
  finally { db.close(); }
}
async function waitFor(check: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error('Expected live condition did not occur');
    await new Promise(r => setTimeout(r, 10));
  }
}
function row(id: string, title: string, assertion: string, fn: () => Promise<void>) {
  it(`${id} ${title}`, async () => {
    evidence = [];
    let status = 'PASS';
    let error: unknown;
    try { await fn(); } catch (e) { status = 'FAIL'; error = e; }
    mkdirSync(logDir, { recursive: true });
    mkdirSync(resolve(statusPath, '..'), { recursive: true });
    const previous = (() => {
      try { return JSON.parse(readFileSync(statusPath, 'utf8')); }
      catch { return Array.from({ length: 17 }, (_, i) => ({ id: `MCP-${String(i + 1).padStart(3, '0')}`, status: 'PENDING', evidence: '', fix: '' })); }
    })();
    const entry = previous.find((r: { id: string }) => r.id === id);
    const logPath = join(logDir, `${id}.json`);
    if (status === 'FAIL') writeFileSync(join(logDir, `${id}-initial.json`), scrub(JSON.stringify({ id, status, assertion, error: String(error), evidence }, null, 2)) + '\n');
    writeFileSync(logPath, scrub(JSON.stringify({ id, at: new Date().toISOString(), status, assertion, ...(error ? { error: String(error) } : {}), evidence }, null, 2)) + '\n');
    Object.assign(entry, { status, evidence: `${assertion}. Real stdio: audit/mcp/${id}.json; command: python3 audit/mcp/run.py suite; suite: audit/mcp/${suiteLog}`, fix: entry.fix ?? '' });
    writeFileSync(statusPath, JSON.stringify(previous, null, 2) + '\n');
    console.log(`AUDIT ${id} ${status}`);
    if (error) throw error;
  });
}

beforeAll(async () => { plain = await connect(); });
afterAll(async () => {
  for (const s of sessions) await close(s);
  rmSync(dir, { recursive: true, force: true });
});

row('MCP-001', 'initialize and tools/list', 'Server identity/version, exact two tools, replay/binding/confirmation-floor descriptions', async () => {
  expect(plain.client.getServerVersion()).toEqual({ name: 'zec-payment-verify', version: '0.1.0' });
  const result = await plain.client.listTools();
  evidence.push({ serverInfo: plain.client.getServerVersion(), tools: result.tools });
  expect(result.tools.map(t => t.name).sort()).toEqual([FUJI, ZCASH].sort());
  const z = result.tools.find(t => t.name === ZCASH)!;
  expect(z.description).toMatch(/same txid passes every time/);
  expect(z.description).toMatch(/ZPV_MCP_MIN_CONF, default 1/);
  const n = result.tools.find(t => t.name === FUJI)!;
  expect(n.description).toMatch(/record the settle hashes/);
  expect(n.description).toMatch(/expect_recipient.*required for ok/);
});
row('MCP-002', 'matching recorded Zcash check', 'Paid JSON includes all documented fields, real outputs/height/depth and single_use false', async () => {
  const r = await paid();
  expect(r).toMatchObject({ ok: true, verdict: 'paid', reasons: [], paid_zat: 100000, height: 4521112, transparent: false, min_conf: 1, single_use: false });
  expect(r.confirmations).toBeGreaterThan(0);
  expect(r.outputs.length).toBeGreaterThan(0);
  expect(r.lightwalletd).toBe('https://testnet.zec.rocks:443');
});
row('MCP-003', 'all recorded Zcash refusal types', 'Wrong memo, underpayment, transparent part and wrong receiver return exact refused reasons', async () => {
  await withSession({}, async s => {
    for (const [name, reasons] of [
      ['wrong-memo', ['MEMO_MISMATCH', 'AMOUNT_TOO_LOW']],
      ['underpaid', ['AMOUNT_TOO_LOW']],
      ['transparent-part', ['TRANSPARENT_PART']],
    ] as const) {
      const c = deployment.paywall.cases[name];
      expect(await paid(s, { txid: c.txid, amount_zat: 10000, memo: c.challengeMemo })).toMatchObject({ ok: false, verdict: 'refused', reasons });
    }
  }, 'deployment');
  expect(await paid(plain, { ...paidArgs, txid: fx.auction.deposit.txid })).toMatchObject({ ok: false, verdict: 'refused', reasons: ['NO_OUTPUT_TO_KEY'] });
});
row('MCP-004', 'confirmation floor and malformed configuration', 'Default/configured floor is reported and enforced; malformed/out-of-range floors are Setup required', async () => {
  expect((await paid(plain, { ...paidArgs, min_conf: 0 })).min_conf).toBe(1);
  await withSession({ ZPV_MCP_MIN_CONF: '100000000' }, async s => {
    expect(await paid(s, { ...paidArgs, min_conf: 0 })).toMatchObject({ ok: false, reasons: ['NOT_CONFIRMED'], min_conf: 100000000 });
    expect((await paid(s, { ...paidArgs, min_conf: 100000001 })).min_conf).toBe(100000001);
  });
  for (const floor of ['abc', '1.5', '-1', '4294967296', '9007199254740993', '9'.repeat(400)]) {
    await withSession({ ZPV_MCP_MIN_CONF: floor }, async s => {
      const r = await call(s, ZCASH, paidArgs);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^Setup required: ZPV_MCP_MIN_CONF/);
    });
  }
});
row('MCP-005', 'missing merchant credential is expected setup error', 'Missing merchant environment returns exactly isError Setup required and no verdict', async () => {
  await withSession({}, async s => {
    const r = await call(s, ZCASH, paidArgs);
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Setup required: ZPV_MERCHANT_UIVK');
  }, 'missing');
});
row('MCP-006', 'read-only repeated check', 'Without store readOnlyHint true, replay warning, repeated payment remains paid/single_use false', async () => {
  const tool = (await plain.client.listTools()).tools.find(t => t.name === ZCASH)!;
  evidence.push({ annotations: tool.annotations, description: tool.description });
  expect(tool.annotations?.readOnlyHint).toBe(true);
  expect(tool.description).toMatch(/record the txids you accepted/);
  for (let i = 0; i < 2; i++) expect(await paid()).toMatchObject({ ok: true, single_use: false });
});
row('MCP-007', 'stored single-use annotations and paid claims', 'Disposable SQLite has exactly paid memo/tx claims after successful acceptance; non-read-only annotations', async () => {
  const path = join(dir, 'single.sqlite');
  await withSession({ ZPV_STORE: path }, async s => {
    const tool = (await s.client.listTools()).tools.find(t => t.name === ZCASH)!;
    evidence.push({ annotations: tool.annotations, title: tool.title });
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(await paid(s)).toMatchObject({ ok: true, single_use: true });
    const rows = claims(path);
    evidence.push({ claims: rows });
    expect(rows).toEqual([
      { key: `memo:${paidArgs.memo}`, state: 'paid', until: 0 },
      { key: `tx:${paidArgs.txid}`, state: 'paid', until: 0 },
    ]);
  });
});
row('MCP-008', 'normalized replay and shared gateway state', 'Same txid in uppercase, consumed memo, and actual gateway-paid shared SQLite state return ALREADY_USED', async () => {
  const path = join(dir, 'replay.sqlite');
  await withSession({ ZPV_STORE: path }, async s => {
    expect((await paid(s)).ok).toBe(true);
    for (const args of [
      { ...paidArgs, txid: paidArgs.txid.toUpperCase() },
      { ...paidArgs, txid: fx.auction.deposit.txid },
      { ...paidArgs, memo: 'different-invoice' },
    ]) expect(await paid(s, args)).toMatchObject({ ok: false, verdict: 'refused', reasons: ['ALREADY_USED'] });
  });
  const sharedPath = join(dir, 'shared.sqlite');
  const store = new SqliteStore(sharedPath);
  const server = createPaywall({
    payTo: 'utest1-demo-merchant', uivk: fx.x402.uivk,
    prices: { '/recorded': 100000n }, content: () => ({ delivered: true }),
    issueMemo: () => paidArgs.memo, store,
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/recorded`;
    expect((await fetch(url)).status).toBe(402);
    const r = await fetch(url, { headers: { 'x-payment': Buffer.from(JSON.stringify({ memo: paidArgs.memo, txid: paidArgs.txid })).toString('base64') } });
    evidence.push({ gateway: { status: r.status, body: await r.json() } });
    expect(r.status).toBe(200);
    await withSession({ ZPV_STORE: sharedPath }, async s => {
      expect(await paid(s)).toMatchObject({ ok: false, reasons: ['ALREADY_USED'] });
    });
  } finally {
    await new Promise<void>((res, rej) => server.close(e => e ? rej(e) : res()));
    store.close();
  }
});
row('MCP-009', 'required invoice memo settings', 'Store and REQUIRE_MEMO settings return exact setting-specific error text', async () => {
  for (const [env, text] of [
    [{ ZPV_STORE: join(dir, 'memo.sqlite') }, 'memo is required: with ZPV_STORE each payment is accepted once, by its invoice memo and txid'],
    [{ ZPV_MCP_REQUIRE_MEMO: '1' }, 'memo is required: ZPV_MCP_REQUIRE_MEMO is set'],
  ] as const) {
    await withSession(env, async s => {
      const r = await call(s, ZCASH, { txid: paidArgs.txid, amount_zat: 1 });
      expect(r.isError).toBe(true);
      expect(r.text).toBe(text);
    });
  }
});
row('MCP-010', 'concurrent, interrupted, refused and failed claims', 'Real concurrent stdio BEING_CHECKED, refusal/error release, killed claimant five-minute lease takeover and stale token protection', async () => {
  const path = join(dir, 'concurrent.sqlite');
  const sockets = new Set<Socket>();
  let accepted = false;
  const silent = createServer(s => { sockets.add(s); accepted = true; s.on('close', () => sockets.delete(s)); });
  await new Promise<void>(r => silent.listen(0, '127.0.0.1', r));
  const s = await connect({ ZPV_STORE: path, ZPV_LWD_URL: `http://127.0.0.1:${(silent.address() as { port: number }).port}`, ZPV_CHECK_TIMEOUT_MS: '1500' });
  let pending: Promise<unknown> | undefined;
  try {
    pending = s.client.callTool({ name: ZCASH, arguments: paidArgs }).then(r => ({ result: r }), e => ({ error: String(e) }));
    await waitFor(() => accepted);
    expect(await paid(s)).toMatchObject({ ok: false, verdict: 'refused', reasons: ['BEING_CHECKED'] });
    const db = new DatabaseSync(path);
    const old = db.prepare('SELECT owner, until FROM claims LIMIT 1').get() as { owner: string; until: number };
    expect(old.until - Date.now()).toBeGreaterThan(290000);
    process.kill(s.transport.pid!, 'SIGKILL');
    await pending;
    // Advance only the disposable SQLite lease timestamps; no wall-clock or chain modification.
    db.prepare("UPDATE claims SET until = ? WHERE state = 'checking'").run(Date.now() - 1);
    db.close();
    const store = new SqliteStore(path);
    try {
      const takeover = store.claim(paidArgs.memo, paidArgs.txid, Date.now(), 300000);
      expect(takeover.ok).toBe(true);
      expect(store.settle(paidArgs.memo, paidArgs.txid, old.owner)).toBe(false);
      store.release(paidArgs.memo, paidArgs.txid, old.owner);
      if (!takeover.ok) throw new Error('No lease takeover');
      expect(store.settle(paidArgs.memo, paidArgs.txid, takeover.token)).toBe(true);
      evidence.push({ killedClaimant: true, leaseMs: 300000, recoveredAfterLease: true, staleOwnerCouldSettle: false, staleOwnerCouldRelease: false });
    } finally { store.close(); }
    await withSession({ ZPV_STORE: path }, async replacement => {
      expect(await paid(replacement)).toMatchObject({ ok: false, reasons: ['ALREADY_USED'] });
    });
  } finally {
    await close(s);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(r => silent.close(() => r()));
    await pending;
  }
  // Refused and actual failed-dependency checks both release reservations.
  for (const failure of [false, true]) {
    const releasePath = join(dir, `release-${failure}.sqlite`);
    await withSession({ ZPV_STORE: releasePath, ...(failure ? { ZPV_LWD_URL: 'http://127.0.0.1:1' } : {}) }, async c => {
      const r = await call(c, ZCASH, failure ? paidArgs : { ...paidArgs, amount_zat: 100001 });
      expect(r.isError).toBe(failure);
      if (!failure) expect(r.data.reasons).toEqual(['AMOUNT_TOO_LOW']);
      expect(claims(releasePath)).toEqual([]);
    });
    await withSession({ ZPV_STORE: releasePath }, async c => { expect((await paid(c)).ok).toBe(true); });
  }
});
row('MCP-011', 'real quorum shortfall and disagreement', 'Quorum/disagreement return unverified, null report fields and cross_check details; disposable claims released', async () => {
  for (const [name, urls, quorum, reason] of [
    ['quorum', 'https://testnet.zec.rocks:443,http://127.0.0.1:1', '2', 'UNVERIFIED_QUORUM'],
    ['disagreement', 'https://testnet.zec.rocks:443,https://zec.rocks:443', '1', 'UNVERIFIED_DISAGREEMENT'],
  ]) {
    const path = join(dir, `${name}.sqlite`);
    await withSession({ ZPV_STORE: path, ZPV_LWD_URLS: urls, ZPV_LWD_QUORUM: quorum }, async s => {
      const r = await paid(s);
      expect(r).toMatchObject({ ok: false, verdict: 'unverified', reasons: [reason], paid_zat: 0, height: null, confirmations: null, outputs: [], single_use: true });
      expect(r.cross_check.agreed).toBe(false);
      expect(r.cross_check.endpoints).toHaveLength(2);
      expect(claims(path)).toEqual([]);
    });
  }
});
row('MCP-012', 'schema rejects before verification/claims', 'Malformed hash, negative/fractional amounts/depth, oversized memo and invalid decimal/address expectations return schema errors with no SQLite claims or verification log', async () => {
  const path = join(dir, 'invalid.sqlite');
  const log = join(dir, 'invalid.jsonl');
  const store = new SqliteStore(path);
  store.close();
  await withSession({ ZPV_STORE: path, ZPV_MCP_LOG: log, ZPV_LWD_URL: 'http://127.0.0.1:1', ZPV_FUJI_RPC: 'http://127.0.0.1:1' }, async s => {
    for (const args of [
      { ...paidArgs, txid: 'bad' }, { ...paidArgs, amount_zat: -1 }, { ...paidArgs, amount_zat: 1.5 },
      { ...paidArgs, min_conf: -1 }, { ...paidArgs, min_conf: 0.5 }, { ...paidArgs, memo: 'a'.repeat(513) },
    ]) {
      const r = await call(s, ZCASH, args);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/validation error/i);
    }
    for (const args of [
      { settle_tx: 'bad' }, { settle_tx: SETTLE, expect_pay_to: '-1' }, { settle_tx: SETTLE, expect_amount: '1.5' },
      { settle_tx: SETTLE, expect_pay_to: '1e3' }, { settle_tx: SETTLE, expect_recipient: '0x1' },
    ]) {
      const r = await call(s, FUJI, args);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/validation error/i);
    }
    expect(claims(path)).toEqual([]);
    // Schema errors happen before the verification handler. Any audit records
    // must be errors, never a successful verification.
    try { expect(readFileSync(log, 'utf8').split('\n').filter(Boolean).map(s => JSON.parse(s)).every(r => r.isError)).toBe(true); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    evidence.push({ claims: [], verificationOccurred: false });
  });
});

async function boundArgs(s = plain) {
  const r = await json(s, FUJI, { settle_tx: SETTLE });
  return { expect_pay_to: r.signals.payTo as string, expect_amount: r.signals.requiredAmount as string, expect_recipient: r.recipient as string };
}
row('MCP-013', 'both recorded successful Fuji settlements', 'Both bound recordings paid/success/settled with checks, five signals, recipient, blocks and spent proof; read-only annotation', async () => {
  const args = await boundArgs();
  const annotation = (await plain.client.listTools()).tools.find(t => t.name === FUJI)!.annotations;
  expect(annotation?.readOnlyHint).toBe(true);
  evidence.push({ annotations: annotation });
  for (const [tx, block] of [[SETTLE, '57020734'], [SETTLE2, '57020809']]) {
    const r = await json(plain, FUJI, { settle_tx: tx, ...args });
    expect(r).toMatchObject({ ok: true, verdict: 'paid', settled: true, status: 'success', reasons: [], checks: { proofValid: true, rootKnown: true, nullifierSpent: true }, recipient: args.expect_recipient, settled_in_block: block, proof_check: { ok: false, reasons: ['NULLIFIER_SPENT'] } });
    expect(Object.keys(r.signals)).toHaveLength(5);
    expect(BigInt(r.checked_at_block)).toBeGreaterThanOrEqual(BigInt(block));
  }
});
row('MCP-014', 'unbound and all misdirected settlement expectations', 'Missing recipient, wrong recipient, wrong payTo and wrong amount yield exact refusal reasons', async () => {
  const me = await boundArgs();
  for (const [args, reason] of [
    [{ expect_pay_to: me.expect_pay_to, expect_amount: me.expect_amount }, 'UNBOUND'],
    [{ ...me, expect_recipient: '0x0000000000000000000000000000000000000001' }, 'RECIPIENT_MISMATCH'],
    [{ ...me, expect_pay_to: (BigInt(me.expect_pay_to) + 1n).toString() }, 'PAY_TO_MISMATCH'],
    [{ ...me, expect_amount: (BigInt(me.expect_amount) + 1n).toString() }, 'AMOUNT_MISMATCH'],
  ] as const) expect(await json(plain, FUJI, { settle_tx: SETTLE, ...args })).toMatchObject({ ok: false, verdict: 'refused', reasons: [reason] });
});
row('MCP-015', 'Fuji replay remains paid', 'Repeated bound recorded settlement remains paid even with ZPV_STORE; description requires caller settlement-hash tracking', async () => {
  const me = await boundArgs();
  const path = join(dir, 'fuji-replay.sqlite');
  const store = new SqliteStore(path); store.close();
  await withSession({ ZPV_STORE: path }, async s => {
    for (let i = 0; i < 2; i++) expect(await json(s, FUJI, { settle_tx: SETTLE, ...me })).toMatchObject({ ok: true, verdict: 'paid', settled: true });
    const tool = (await s.client.listTools()).tools.find(t => t.name === FUJI)!;
    expect(tool.description).toMatch(/does not remember settlements.*record the settle hashes/);
    expect(claims(path)).toEqual([]);
  });
});
row('MCP-016', 'real failed lightwalletd and Fuji dependencies', 'Real closed loopback dependency returns isError text, no paid log and no retained SQLite paid claim', async () => {
  const path = join(dir, 'dependency.sqlite');
  const log = join(dir, 'dependency.jsonl');
  await withSession({ ZPV_STORE: path, ZPV_LWD_URL: 'http://127.0.0.1:1', ZPV_FUJI_RPC: 'http://127.0.0.1:1', ZPV_MCP_LOG: log }, async s => {
    for (const [tool, args] of [[ZCASH, paidArgs], [FUJI, { settle_tx: SETTLE }]] as const) {
      const r = await call(s, tool, args);
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain('"verdict": "paid"');
    }
    expect(claims(path)).toEqual([]);
    const entries = readFileSync(log, 'utf8').trim().split('\n').map(s => JSON.parse(s));
    expect(entries).toHaveLength(2);
    expect(entries.every(r => r.isError && typeof r.result === 'string')).toBe(true);
    evidence.push({ claims: [], auditLog: entries });
  });
});
row('MCP-017', 'audit JSONL and existing permissions', 'Each completed tool call (including schema rejection and both tools) appends at/tool/args/isError/result; new/existing logs mode 0600; no incoming credential in records', async () => {
  const me = await boundArgs();
  for (const existing of [false, true]) {
    const log = join(dir, `log-${existing}.jsonl`);
    if (existing) { writeFileSync(log, ''); chmodSync(log, 0o644); }
    await withSession({ ZPV_MCP_LOG: log, ZPV_MCP_REQUIRE_MEMO: '1' }, async s => {
      expect((await paid(s)).ok).toBe(true);
      expect((await paid(s, { ...paidArgs, amount_zat: 100001 })).ok).toBe(false);
      expect((await call(s, ZCASH, { txid: paidArgs.txid, amount_zat: 1 })).isError).toBe(true);
      expect((await call(s, ZCASH, { ...paidArgs, amount_zat: -1 })).isError).toBe(true);
      expect((await json(s, FUJI, { settle_tx: SETTLE, ...me })).ok).toBe(true);
      const raw = readFileSync(log, 'utf8');
      // Assertions only show boolean results if violated, never credential text.
      expect(raw.includes(fx.x402.uivk)).toBe(false);
      expect(raw.includes(deployment.wallets.merchant.uivk)).toBe(false);
      const entries = raw.trim().split('\n').map(s => JSON.parse(s));
      expect(entries).toHaveLength(5);
      expect(entries.map(r => r.isError)).toEqual([false, false, true, true, false]);
      for (const e of entries) {
        expect(Object.keys(e).sort()).toEqual(['at', 'tool', 'args', 'isError', 'result'].sort());
        expect(Number.isNaN(Date.parse(e.at))).toBe(false);
        expect([ZCASH, FUJI]).toContain(e.tool);
      }
      const mode = statSync(log).mode & 0o777;
      expect(mode).toBe(0o600);
      evidence.push({ existingFile: existing, mode: mode.toString(8), auditLog: entries });
    });
  }
});
