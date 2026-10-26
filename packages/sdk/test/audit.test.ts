// Additional AUDIT.md cells. All chain access is read-only against recorded transactions.
// Tests load published demo fixtures internally; never log requests, environment, or viewing keys.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { it, expect } from 'vitest';
import { createPublicClient, http } from 'viem';
import {
  verify, verifyZcash, verifyNull402Settlement, proofFromSettleTx, ownsAddress,
  VerifyError, SetupRequiredError, LightwalletdUnreachableError, CheckLimiter,
  crossCheckVerdict, verifyZcashCrossChecked, crossCheckFromEnv, NULL402_FUJI,
} from '../src/index.js';

const root = resolve(__dirname, '../../..');
const fx = JSON.parse(readFileSync(resolve(root, 'fixtures/testnet.json'), 'utf8'));
const run = JSON.parse(readFileSync(resolve(root, 'deployments/testnet.json'), 'utf8'));
const bin = process.env.ZPV_BIN ?? resolve(root, 'packages/core/target/release/zpay-verify');
const merchant = run.wallets.merchant;
const employee = run.wallets.employee;
const x = { rail: 'zcash' as const, uivk: fx.x402.uivk, txid: fx.x402.txid, amountZat: 100000, memo: fx.x402.memo };
const logDir = resolve(root, 'audit/cli-chain');
const statusFile = resolve(root, 'audit/status/cli-chain.json');
const auditLog = process.env.HANKO_AUDIT_LOG ?? 'audit.txt';
const scrub = (s: string) => s.replace(/(?:uivktest1|uviewtest1|uivk1|uview1)[a-z0-9…]+/gi, '[REDACTED_VIEWING_KEY]');
function record(id: string, status: string, evidence: string) {
  mkdirSync(logDir, { recursive: true });
  const rows = JSON.parse(readFileSync(statusFile, 'utf8'));
  const row = rows.find((r: { id: string }) => r.id === id);
  Object.assign(row, { status, evidence: scrub(evidence), fix: '' });
  writeFileSync(statusFile, JSON.stringify(rows, null, 2) + '\n');
  console.log(`AUDIT ${id} ${status}: ${scrub(evidence)}`);
}
class MissingRecordedEvidence extends Error {}
function row(id: string, title: string, check: () => Promise<void>, assertion: string) {
  it(`${id} ${title}`, async () => {
    try {
      await check();
      record(id, 'PASS', `Command: python3 audit/cli-chain/run.py ${auditLog.slice(0,-4)} (pnpm exec vitest run test/audit.test.ts); assertion: ${assertion}. Log: audit/cli-chain/${auditLog}`);
    } catch (e) {
      if (e instanceof MissingRecordedEvidence) { record(id, 'UNTESTED', `${e.message}; command: python3 audit/cli-chain/run.py ${auditLog.slice(0,-4)}; log: audit/cli-chain/${auditLog}`); return; }
      record(id, 'FAIL', `${title}: ${scrub(String(e)).split('\n')[0]}; command: python3 audit/cli-chain/run.py ${auditLog.slice(0,-4)}; log: audit/cli-chain/${auditLog}`);
      throw e;
    }
  });
}
function cli(args: string[], key: string | undefined = fx.x402.uivk, extra: Record<string, string> = {}, timeout = 30000): Promise<{ code: number | null; out: string; err: string; killed: boolean }> {
  // Only this application/test loads the published incoming key; it stays out of argv and output.
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...extra };
  if (key !== undefined) env.ZPV_UIVK = key;
  return new Promise((res, rej) => {
    const p = spawn(bin, args, { env });
    let out = '', err = '', killed = false;
    const timer = setTimeout(() => { killed = true; p.kill('SIGKILL'); }, timeout);
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', e => { clearTimeout(timer); rej(e); });
    p.on('close', code => { clearTimeout(timer); res({ code, out, err, killed }); });
  });
}
const args = (txid = fx.x402.txid, amount = '100000', memo = fx.x402.memo) => ['verify', txid, '--amount', amount, '--memo', memo];
const parsed = (o: Awaited<ReturnType<typeof cli>>) => JSON.parse(o.out);
function report(r: Awaited<ReturnType<typeof verifyZcash>>, height?: number) {
  expect(r.report?.found).toBe(true);
  if (height) expect(r.report?.height).toBe(height);
  expect(r.report?.block_time).toBeGreaterThan(0);
  expect(r.report?.confirmations).toBe(r.report!.tip - r.report!.height! + 1);
}
const payCase = (name: string) => {
  const c = run.paywall.cases[name];
  return { rail: 'zcash' as const, uivk: merchant.uivk, txid: c.txid, amountZat: 10000, memo: c.challengeMemo };
};

row('CLI-001', 'paid CLI report and exit', async () => {
  const o = await cli(args()); expect(o.code).toBe(0);
  expect(parsed(o)).toMatchObject({ verdict: { ok: true, paid_zat: 100000, reasons: [] }, lightwalletd: 'https://testnet.zec.rocks:443', report: { height: 4521112, found: true } });
}, 'CLI exit 0; JSON report/verdict/lightwalletd; paid_zat=100000; reasons=[]');
row('CLI-002', 'all recorded CLI refusals', async () => {
  for (const [name, reasons] of [['wrong-memo', ['MEMO_MISMATCH','AMOUNT_TOO_LOW']], ['underpaid', ['AMOUNT_TOO_LOW']], ['transparent-part', ['TRANSPARENT_PART']]] as const) {
    const r = payCase(name); const o = await cli(args(r.txid, '10000', r.memo), merchant.uivk);
    expect(o.code).toBe(1); expect(parsed(o).verdict.reasons).toEqual(reasons); expect(parsed(o).report.found).toBe(true);
  }
  const o = await cli(args(fx.auction.deposit.txid, '1')); expect(o.code).toBe(1); expect(parsed(o).verdict.reasons).toEqual(['NO_OUTPUT_TO_KEY']);
}, 'exit 1 and exact wrong-memo, underpayment, transparent, wrong-receiver reasons; real reports retained');
row('CLI-003', 'confirmation floor including explicit zero', async () => {
  const pending = await cli([...args(), '--min-conf', '100000000']); expect(pending.code).toBe(1);
  expect(parsed(pending).verdict.reasons).toEqual(['NOT_CONFIRMED']); expect(parsed(pending).report.confirmations).toBeGreaterThan(0);
  expect((await cli([...args(), '--min-conf', '0'])).code).toBe(0);
}, 'floor 100000000 exits 1 NOT_CONFIRMED with actual depth; explicit --min-conf 0 exits 0');
row('CLI-004', 'explicit transparent opt-in', async () => {
  const c = payCase('transparent-part'); const o = await cli([...args(c.txid, '10000', c.memo), '--allow-transparent'], merchant.uivk);
  expect(o.code).toBe(0); expect(parsed(o).report.pools.transparent).toBe(true); expect(parsed(o).verdict.reasons).toEqual([]);
}, 'recorded transparent case exits 0 with --allow-transparent and no refusal reasons');
row('CLI-005', 'argument errors', async () => {
  for (const [a, error] of [
    [['verify', fx.x402.txid], '--amount is required'],
    [args(fx.x402.txid, '1.5'), '--amount must be zatoshis (a whole number)'],
    [[...args(), '--min-conf', 'bad'], '--min-conf must be a whole number'],
    [[...args(), '--mystery'], 'unknown option --mystery'],
  ] as const) {
    const o = await cli([...a]); expect(o.code).toBe(2); expect(o.err).toContain(error); expect(o.out).toBe('');
    if (error.includes('unknown')) expect(o.err).toContain('usage:');
  }
}, 'missing/invalid amount, invalid min-conf, unknown option all exit 2 with exact diagnostics; no JSON verdict');
row('CLI-006', 'missing setup and invalid tx/key', async () => {
  // Undefined default parameters select the published fixture, so missing-key uses an empty isolated env value removal below.
  const noKey = await new Promise<{ code: number | null; err: string }>((res) => {
    const p = spawn(bin, args(), { env: { PATH: process.env.PATH ?? '' } }); let err=''; p.stderr.on('data', d=>err+=d); p.on('close',code=>res({code,err}));
  });
  expect(noKey.code).toBe(2); expect(noKey.err.trim()).toBe('error: Setup required: ZPV_UIVK');
  const badTx = await cli(args('xyz')); expect(badTx.code).toBe(2); expect(badTx.err).toContain('not a txid (64 hex characters)'); expect(badTx.out).toBe('');
  const badKey = await cli(args(), 'uivktest1notakey'); expect(badKey.code).toBe(2); expect(badKey.err).toContain('not a testnet unified incoming viewing key'); expect(badKey.out).toBe('');
}, 'isolated missing-key env and malformed tx/key exit 2; expected Setup required or field diagnostic; no paid JSON');
row('CLI-007', 'inspect one and multiple in argument order', async () => {
  for (const ids of [[fx.x402.txid], [fx.x402.txid, fx.auction.deposit.txid]]) {
    const o = await cli(['inspect', ...ids]); expect(o.code).toBe(0);
    const reports = o.out.trim().split('\n').map(s=>JSON.parse(s)); expect(reports.map(r=>r.txid)).toEqual(ids);
    for (const r of reports) {
      expect(Object.keys(r).sort()).toEqual(['txid','found','height','block_time','confirmations','tip','outputs','pools'].sort()); expect(r.found).toBe(true); expect(r).not.toHaveProperty('verdict');
    }
  }
}, 'one JSON report per input in order with all eight report fields, no verdict, exit 0');
row('CLI-008', 'inspect absent, malformed, transport and interrupted inputs', async () => {
  const gone = await cli(['inspect', 'ab'.repeat(32)]); expect(gone.code).toBe(0); expect(parsed(gone).found).toBe(false);
  const bad = await cli(['inspect','xyz']); expect(bad.code).toBe(2); expect(bad.out).toBe('');
  const dead = await cli(['inspect',fx.x402.txid], fx.x402.uivk, { ZPV_LWD_URL:'http://127.0.0.1:1' }); expect(dead.code).toBe(2); expect(dead.out).toBe('');
  const sockets = new Set<Socket>(); const server = createServer(s=>{ sockets.add(s); s.on('error',()=>{}); });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    const o = await cli(['inspect',fx.x402.txid], fx.x402.uivk, { ZPV_LWD_URL: `http://127.0.0.1:${(server.address() as {port:number}).port}` }, 500);
    expect(o.killed).toBe(true); expect(o.out).toBe('');
  } finally { sockets.forEach(s=>s.destroy()); await new Promise<void>(r=>server.close(()=>r())); }
}, 'absent tx found=false; malformed/dead exit 2; SIGKILL at silent real socket emits no completed report/verdict');
row('CLI-009', 'owns matching receiver offline', async () => {
  const o = await cli(['owns',merchant.address],merchant.uivk); expect(o.code).toBe(0); expect(parsed(o).owns).toBe(true);
  for (const k of ['orchard','sapling']) expect([true,false,null]).toContain(parsed(o)[k]);
}, 'owns matching address exits 0; owns=true with orchard/sapling boolean or null; offline');
row('CLI-010', 'owns another receiver offline', async () => {
  const o = await cli(['owns',employee.address],merchant.uivk); expect(o.code).toBe(1); expect(parsed(o).owns).toBe(false);
}, 'valid other published receiver owns=false exit 1; offline');
row('CLI-011', 'owns malformed, empty, transparent and invalid key', async () => {
  for (const address of ['', 'utest1notanaddress', run.wallets.payer.transparent]) {
    const o=await cli(['owns',address],merchant.uivk); expect(o.code).toBe(2); expect(o.err).toContain('not a testnet unified address with a shielded receiver');
  }
  expect((await cli(['owns',merchant.address],'uivktest1notakey')).code).toBe(2);
}, 'empty, transparent-only and malformed addresses exit 2 with expected diagnostic; bad incoming-key encoding exits 2');
row('CLI-012', 'derive absent or malformed synthetic input only', async () => {
  const absent=await cli(['derive']); expect(absent.code).toBe(2); expect(absent.err.trim()).toBe('error: Setup required: ZPV_UFVK'); expect(absent.out).toBe('');
  const bad=await cli(['derive'], undefined, { ZPV_UFVK: 'not-a-key' }); expect(bad.code).toBe(2); expect(bad.out).toBe('');
}, 'isolated env has no full viewing credential; derive exits 2 Setup required; synthetic non-secret malformed input exits 2 with empty stdout');
row('CLI-014', 'SDK defaults, report and provenance', async () => {
  const r=await verify(x); expect(r).toMatchObject({ rail:'zcash',ok:true,verdict:'paid',paidZat:100000,reasons:[],provenance:{via:'zpay-verify'} }); report(r,4521112);
  expect((await verify({...x,memo:undefined})).paidZat).toBe(100000);
  const transparent=await verify(payCase('transparent-part')); expect(transparent.reasons).toEqual(['TRANSPARENT_PART']);
  expect((await verify({...x,minConf:100000000})).reasons).toEqual(['NOT_CONFIRMED']);
}, 'SDK returns paid/report/via=zpay-verify; omitted memo counts all outputs; shielded-only default rejects transparent; depth enforced');
row('CLI-015', 'proof result and provenance without invented settlement', async () => {
  const s=await proofFromSettleTx(run.thirdParty.null402.settleTx); const r=await verify({rail:'null402',...s});
  expect(r.checks).toEqual({proofValid:true,rootKnown:true,nullifierSpent:true}); expect(Object.keys(r.signals)).toHaveLength(5);
  expect(r.reasons).toEqual(['NULLIFIER_SPENT','UNBOUND']); expect(r.provenance).toMatchObject({rpc:NULL402_FUJI.rpc,chainId:43113,verifier:NULL402_FUJI.verifier,pool:NULL402_FUJI.pool});
  expect(BigInt(r.provenance.blockNumber)).toBeGreaterThan(BigInt(s.blockNumber!)); expect(Date.parse(r.provenance.checkedAt)).toBeGreaterThan(0); expect(r).not.toHaveProperty('verdict');
  const bound=await verify({rail:'null402',...s,expect:{payTo:s.publicSignals[2],requiredAmount:s.publicSignals[3]}}); expect(bound.reasons).toEqual(['NULLIFIER_SPENT']);
}, 'real proof checks true/true/true; five signals; RPC/chain/contracts/block/time provenance; bound NULLIFIER_SPENT and unbound adds UNBOUND; no settlement verdict');
row('CLI-017', 'quorum failure clears all payment fields', async () => {
  const r=await verifyZcashCrossChecked(x,{lwdUrls:['https://testnet.zec.rocks:443','https://127.0.0.1:1'],quorum:2});
  expect(r).toMatchObject({ok:false,verdict:'unverified',reasons:['UNVERIFIED_QUORUM'],paidZat:0,report:null}); expect(r.crossCheck?.endpoints[1]).toMatchObject({answered:false}); expect(r.crossCheck?.endpoints[1].error).toBeTruthy();
}, 'one real paid answer plus dead endpoint at quorum 2 gives unverified, paidZat 0, report null, endpoint error');
row('CLI-019', 'lag rule on local copies of a live authenticated report', async () => {
  const real=await verifyZcash(x); const h=real.report!.height!;
  const answer=(tip:number, absent=false)=>{
    const copy=structuredClone(real); copy.report!.tip=tip; copy.provenance.tip=tip;
    if(absent){ copy.report!.found=false; copy.report!.height=null; copy.report!.block_time=null; copy.report!.outputs=[]; copy.report!.pools={sapling:false,orchard:false,ironwood:false,transparent:false}; copy.paidZat=0; copy.reasons=['TX_NOT_FOUND']; copy.ok=false; copy.verdict='refused'; }
    else copy.report!.confirmations=Math.max(0,tip-h+1);
    return {status:'fulfilled' as const,value:copy};
  };
  const urls=['https://testnet.zec.rocks:443','local-copy-of-live-report (rule input, not another operator)'];
  for(const lag of [1,2,3]){
    const r=crossCheckVerdict(urls,[answer(h),answer(h-lag,true)],2); expect(r.reasons).toEqual(['NOT_CONFIRMED']); expect(r.report?.confirmations).toBe(0); expect(r.crossCheck?.agreed).toBe(true);
  }
  const lower=crossCheckVerdict(urls,[answer(h+3),answer(h+2)],2); expect(lower.report?.tip).toBe(h+2); expect(lower.report?.confirmations).toBe(3);
  for(const tip of [h,h+3,h-100]) expect(crossCheckVerdict(urls,[answer(h),answer(tip,true)],2).reasons).toEqual(['UNVERIFIED_DISAGREEMENT']);
}, 'live authenticated record then explicit local rule inputs: 1/2/3-block lag NOT_CONFIRMED/0 confirmations; lowest tip used; at/past/100-behind absence disagrees; no RPC mock');
row('CLI-020', 'all invalid quorum configuration cases', async () => {
  for(const o of [{lwdUrls:[]},{lwdUrls:['https://testnet.zec.rocks','https://TESTNET.ZEC.ROCKS:443/']},{lwdUrls:['https://127.0.0.1:1'],quorum:0},{lwdUrls:['https://127.0.0.1:1'],quorum:2},{lwdUrls:['https://127.0.0.1:1'],quorum:1.5}]) await expect(verifyZcashCrossChecked(x,o)).rejects.toBeInstanceOf(VerifyError);
  expect(()=>crossCheckFromEnv({ZPV_LWD_URLS:'https://testnet.zec.rocks',ZPV_LWD_QUORUM:'two'})).toThrow('Setup required: ZPV_LWD_QUORUM');
}, 'empty, canonical duplicates and quorum 0/2/fractional rejected with VerifyError; malformed env quorum Setup required');
row('CLI-021', 'SDK ownership matches CLI and error classes', async () => {
  const own=await ownsAddress(merchant.uivk,merchant.address); expect(own).toEqual(parsed(await cli(['owns',merchant.address],merchant.uivk)));
  await expect(ownsAddress(merchant.uivk,'')).rejects.toBeInstanceOf(VerifyError);
  await expect(ownsAddress('uivktest1notakey',merchant.address)).rejects.toBeInstanceOf(VerifyError);
  const saved=process.env.ZPV_BIN; process.env.ZPV_BIN='/nonexistent/zpay-verify';
  try{await expect(ownsAddress(merchant.uivk,merchant.address)).rejects.toBeInstanceOf(SetupRequiredError);}finally{if(saved===undefined)delete process.env.ZPV_BIN;else process.env.ZPV_BIN=saved;}
}, 'ownership equals real CLI receiver JSON; empty/bad-key VerifyError; missing binary SetupRequiredError');

row('CHAIN-002', 'historical current-paywall payment and receipts', async () => {
  const p=run.paywallLive; const r=await verify({...x,uivk:employee.uivk,txid:p.txid,amountZat:p.priceZat,memo:p.challengeMemo});
  // The current paywall was configured for the merchant, not the employee payer.
  expect(r.reasons).toEqual(['NO_OUTPUT_TO_KEY']);
  const correct=await verify({...x,uivk:merchant.uivk,txid:p.txid,amountZat:p.priceZat,memo:p.challengeMemo}); report(correct,4530239); expect(correct).toMatchObject({ok:true,paidZat:10000});
  expect(p.challengeMemo).toMatch(/^zpv-\d{10}-[a-f0-9]{16}-[A-Za-z0-9_-]{22}$/); expect(p.http).toBe(200); expect(p.settlement).toMatchObject({success:true,transaction:p.txid}); expect(p.replay.http).toBe(402); expect(p.replay.settlement).toMatchObject({success:false,errorReason:'nonce_already_used'});
}, 'read-only historical payment block 4530239/10000/memo matches; recorded 200 success and 402 nonce_already_used receipts checked; no expired challenge presented as fresh');
for(const [id,name,reasons,paid] of [
  ['CHAIN-003','wrong-memo',['MEMO_MISMATCH','AMOUNT_TOO_LOW'],0],
  ['CHAIN-004','underpaid',['AMOUNT_TOO_LOW'],5000],
  ['CHAIN-005','transparent-part',['TRANSPARENT_PART'],10000],
] as const) row(id,`recorded ${name}`,async()=>{
  const r=await verify(payCase(name)); report(r); expect(r.reasons).toEqual(reasons); expect(r.paidZat).toBe(paid);
  if(name==='underpaid') expect(r.report?.outputs.some(o=>o.value===5000&&o.memo===run.paywall.cases[name].challengeMemo)).toBe(true);
  if(name==='transparent-part') expect(r.report?.pools.transparent).toBe(true);
},`confirmed recorded ${name}; exact reasons ${reasons.join(',')}; paidZat ${paid}; decrypted output/pools checked`);
for(const [id,amount,key,reasons,paid] of [
  ['CHAIN-006',50000,employee.uivk,[],50000],
  ['CHAIN-007',100000,employee.uivk,['AMOUNT_TOO_LOW'],50000],
  ['CHAIN-008',50000,merchant.uivk,['NO_OUTPUT_TO_KEY'],0],
] as const) row(id,'recorded payslip receiver/amount',async()=>{
  const r=await verify({...x,uivk:key,txid:run.payslip.txid,amountZat:amount,memo:run.payslip.memo}); report(r,4522626); expect(r.reasons).toEqual(reasons); expect(r.paidZat).toBe(paid); expect(r.ok).toBe(reasons.length===0);
  if(paid) expect(r.report?.outputs[0]).toMatchObject({value:50000,memo:'payslip 2026-10 #7: net 0.0005 TAZ'});
},`payslip block 4522626 expected ${amount}; paidZat ${paid}; exact reasons ${reasons.join(',')||'none'}; memo/output matched`);
row('CHAIN-009','recorded third-party payment',async()=>{
  const r=await verify(x); report(r,4521112); expect(r).toMatchObject({ok:true,paidZat:100000,reasons:[]}); expect(r.report?.pools.transparent).toBe(false); expect(r.report?.outputs[0]).toMatchObject({value:100000,memo:fx.x402.memo});
},'x402 block 4521112/100000/matching memo; paid; transparent false');
for(const [id,key,amount,reasons,paid] of [
  ['CHAIN-010',fx.x402.uivk,1,['NO_OUTPUT_TO_KEY'],0],
  ['CHAIN-011',fx.auction.uivk,fx.auction.deposit.amountZat,[],fx.auction.deposit.amountZat],
] as const) row(id,'recorded auction receiver',async()=>{
  const a=fx.auction.deposit; const r=await verify({...x,uivk:key,txid:a.txid,amountZat:amount,memo:a.memo}); report(r,a.height); expect(r.reasons).toEqual(reasons); expect(r.paidZat).toBe(paid);
  if(paid) expect(r.report?.outputs.some(o=>o.value===a.amountZat&&o.memo===a.memo)).toBe(true);
},`auction block 4522268; paidZat ${paid}; reasons ${reasons.join(',')||'none'}; published amount/memo checked`);
row('CHAIN-012','five-note funding is not invoice acceptance',async()=>{
  const o=await cli(['inspect',run.fundTx]); expect(o.code).toBe(0); const r=parsed(o); expect(r.found).toBe(true); expect(r.confirmations).toBeGreaterThan(0); expect(r).not.toHaveProperty('verdict');
  // The published deployment deliberately omits the payer's incoming credential. Never silently
  // substitute another receiver and then claim to have checked the payer's five encrypted notes.
  if (!run.wallets.payer.uivk) throw new MissingRecordedEvidence('Dependency: published payer incoming viewing credential for fundTx a2c0578b…57d3; deployments/testnet.json omits it. Read-only authorization/inclusion confirms the funding transaction, but five notes/amounts cannot be decrypted under the published merchant/x402 credentials. No wallet or private credential accessed');
  const own=parsed(await cli(['inspect',run.fundTx],run.wallets.payer.uivk)); expect(own.outputs).toHaveLength(5); expect(own.outputs.every((o:{value:number})=>o.value===400000)).toBe(true);
},'fundTx confirmed/included/authorized; five received notes require published payer incoming credential; no invoice verdict');
row('CHAIN-015','first recorded Fuji settlement',async()=>{
  const s=await proofFromSettleTx(run.thirdParty.null402.settleTx); expect(s).toMatchObject({status:'success',blockNumber:'57020734'});
  const r=await verifyNull402Settlement(run.thirdParty.null402.settleTx,{payTo:s.publicSignals[2],requiredAmount:s.publicSignals[3],recipient:s.recipient});
  expect(r).toMatchObject({ok:true,verdict:'paid',settled:true,status:'success',checks:{proofValid:true,rootKnown:true,nullifierSpent:true},proofCheck:{reasons:['NULLIFIER_SPENT']}});
},'receipt success/block 57020734; decoded pool settle calldata; bound SDK paid/settled and true proof/root/spent; proofCheck NULLIFIER_SPENT');
row('CHAIN-017','Fuji existing-contract provenance',async()=>{
  const c=createPublicClient({transport:http(NULL402_FUJI.rpc)}); expect(await c.getChainId()).toBe(43113);
  const s=await proofFromSettleTx(run.thirdParty.null402.settleTx); const r=await verify({rail:'null402',...s});
  expect(r.provenance).toMatchObject({chainId:43113,rpc:'https://api.avax-test.network/ext/bc/C/rpc',verifier:'0x0b44836dDc460f589ce4EB97f276e533A2bE6060',pool:'0x39a9C4EfabEBA954545Ecb4b16Ba1d92ec46cA1C'});
  console.log('Hanko reads existing null-402 contracts; Hanko deploys no contracts.');
},'real eth_chainId=43113; proof calls use existing published verifier/pool; Hanko deploys no contracts');
row('EDGE-026','Fuji RPC chain ID and same-block read calls',async()=>{
  const methods:Array<{method:string;params?:unknown}>=[];
  const observe = async (request: Request) => {
    const body = await request.clone().json();
    for (const call of Array.isArray(body) ? body : [body]) methods.push({method:call.method,params:call.params});
  };
  // Real RPC requests are observed and forwarded unchanged; no response is replaced or manufactured.
  const c=createPublicClient({transport:http(NULL402_FUJI.rpc,{onFetchRequest:observe})});
  expect(await c.getChainId()).toBe(43113);
  const receipt=await c.getTransactionReceipt({hash:run.thirdParty.null402.settleTx}); expect(receipt.status).toBe('success');
  const s=await proofFromSettleTx(run.thirdParty.null402.settleTx);
  // Instrument the native fetch only around the SDK's actual public RPC calls.
  const nativeFetch=globalThis.fetch;
  globalThis.fetch=(async(input,init)=>{
    const body=typeof init?.body==='string'?JSON.parse(init.body):[];
    for(const call of Array.isArray(body)?body:[body]) methods.push({method:call.method,params:call.params});
    return nativeFetch(input,init);
  }) as typeof fetch;
  try{
    const r=await verify({rail:'null402',...s}); expect(r.checks).toEqual({proofValid:true,rootKnown:true,nullifierSpent:true});
    const calls=methods.filter(m=>m.method==='eth_call'); expect(calls).toHaveLength(3);
    expect(new Set(calls.map(m=>(m.params as unknown[])[1]))).toEqual(new Set(['0x'+BigInt(r.provenance.blockNumber).toString(16)]));
    expect(methods.map(m=>m.method)).toContain('eth_chainId');
    expect(methods.map(m=>m.method)).toContain('eth_getTransactionReceipt');
    expect(methods.every(m=>['eth_chainId','eth_getTransactionReceipt','eth_blockNumber','eth_call'].includes(m.method))).toBe(true);
    console.log(JSON.stringify({rpc:NULL402_FUJI.rpc,chainId:43113,receiptBlock:receipt.blockNumber.toString(),checkBlock:r.provenance.blockNumber,methods:methods.map(m=>m.method),callBlocks:calls.map(m=>(m.params as unknown[])[1])}));
  }finally{globalThis.fetch=nativeFetch;}
},'real RPC eth_chainId 43113 and success receipt; observed exactly three SDK eth_call methods at the reported common block; allowlisted read-only methods only');
row('EDGE-029','missing unreadable/corrupt Sapling params and valid HOME/explicit path',async()=>{
  const tx='4a9412fa75194d31fdae2c796765e1617cdeade286ab231ab75705db827c8634';
  const valid=await cli(['inspect',tx]); expect(valid.code).toBe(0);
  const home=process.env.HOME!;
  const candidates=[resolve(home,'Library/Application Support/ZcashParams'),resolve(home,'.zcash-params'),resolve(home,'.local/share/ZcashParams')];
  const {existsSync}=await import('node:fs'); const path=candidates.find(p=>existsSync(resolve(p,'sapling-spend.params'))); expect(path).toBeTruthy();
  expect((await cli(['inspect',tx],fx.x402.uivk,{ZPV_SAPLING_PARAMS:path!})).code).toBe(0);
  const dir=mkdtempSync(resolve(tmpdir(),'hanko-param-audit-'));
  try{
    for(const params of ['/nonexistent/zcash-params',dir]){
      const o=await cli(['inspect',tx],fx.x402.uivk,{ZPV_SAPLING_PARAMS:params}); expect(o.code).toBe(2); expect(o.err).toContain('Setup required: ZPV_SAPLING_PARAMS');
    }
    // A directory where a file should be is unreadable as a parameter file even under elevated uid.
    mkdirSync(resolve(dir,'sapling-spend.params'));
    expect((await cli(['inspect',tx],fx.x402.uivk,{ZPV_SAPLING_PARAMS:dir})).err).toContain('Setup required: ZPV_SAPLING_PARAMS');
    rmSync(resolve(dir,'sapling-spend.params'),{recursive:true}); writeFileSync(resolve(dir,'sapling-spend.params'),'deliberately not Sapling parameters');
    const corrupt=await cli(['inspect',tx],fx.x402.uivk,{ZPV_SAPLING_PARAMS:dir}); expect(corrupt.code).toBe(2); expect(corrupt.err).toContain('is not the published sapling-spend.params');
  }finally{rmSync(dir,{recursive:true,force:true});}
},'real Sapling authorization succeeds with HOME and explicit published-parameter path; missing/directory-unreadable/hash-mismatched parameter files exit 2 Setup required');
row('EDGE-032','timeout kills child and frees limiter for next real request',async()=>{
  const sockets=new Set<Socket>();const server=createServer(s=>{sockets.add(s);s.on('error',()=>{});});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const old=process.env.ZPV_CHECK_TIMEOUT_MS;const limiter=new CheckLimiter({max:'HANKO_AUDIT_MAX',maxDefault:1,what:'audit checks'});
  try{
    process.env.ZPV_CHECK_TIMEOUT_MS='400'; const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const error=await verifyZcash(x,{lwdUrl:url,limiter}).catch(e=>e);expect(error).toBeInstanceOf(LightwalletdUnreachableError);expect(error.message).toContain('was stopped');
    process.env.ZPV_CHECK_TIMEOUT_MS='30000'; const next=await verifyZcash(x,{limiter});expect(next.ok).toBe(true);
  }finally{if(old===undefined)delete process.env.ZPV_CHECK_TIMEOUT_MS;else process.env.ZPV_CHECK_TIMEOUT_MS=old;sockets.forEach(s=>s.destroy());await new Promise<void>(r=>server.close(()=>r()));}
},'silent real socket timeout returns LightwalletdUnreachableError/was stopped; same single-slot limiter immediately verifies next recorded payment successfully');
row('EDGE-035','proof amount x10, unknown root and expectation mismatches',async()=>{
  const s=await proofFromSettleTx(run.thirdParty.null402.settleTx);
  const bad=await verify({rail:'null402',...s,expect:{payTo:'1',requiredAmount:BigInt(s.publicSignals[3])+1n,contextHash:'2'}});expect(bad.reasons).toEqual(['NULLIFIER_SPENT','PAY_TO_MISMATCH','AMOUNT_MISMATCH','CONTEXT_MISMATCH']);
  const amount=[...s.publicSignals];amount[3]=(BigInt(amount[3])*10n).toString();expect((await verify({rail:'null402',proof:s.proof,publicSignals:amount})).reasons).toContain('BAD_PROOF');
  const rootUnknown=[...s.publicSignals];rootUnknown[1]='0';expect((await verify({rail:'null402',proof:s.proof,publicSignals:rootUnknown})).reasons).toContain('ROOT_UNKNOWN');
},'real Fuji verifier rejects 10x amount BAD_PROOF; root zero gives ROOT_UNKNOWN; merchant mismatches give all three exact mismatch reasons');
row('EDGE-036','each missing settlement binding plus wrong recipient',async()=>{
  const hash=run.thirdParty.null402.settleTx;const s=await proofFromSettleTx(hash);const bound={payTo:s.publicSignals[2],requiredAmount:s.publicSignals[3],recipient:s.recipient};
  for(const field of ['payTo','requiredAmount','recipient'] as const){const e:Partial<typeof bound>={...bound};delete e[field];const r=await verifyNull402Settlement(hash,e);expect(r).toMatchObject({ok:false,verdict:'refused'});expect(r.reasons).toContain('UNBOUND');}
  const r=await verifyNull402Settlement(hash,{...bound,recipient:'0x000000000000000000000000000000000000dEaD'});expect(r).toMatchObject({ok:false,verdict:'refused'});expect(r.reasons).toEqual(['RECIPIENT_MISMATCH']);
},'real recorded settlement missing payTo/amount/recipient separately is refused UNBOUND; wrong recipient refused RECIPIENT_MISMATCH');
row('EDGE-038','malformed hash, non-pool and wrong selector',async()=>{
  await expect(verifyNull402Settlement('bad' as `0x${string}`,{})).rejects.toThrow('settle tx must be a 0x-prefixed 32-byte hash');
  await expect(proofFromSettleTx('0xbc62a275074dfb9434963ab04605c4102fcf937af4b8c8c0fb460368f007b025')).rejects.toThrow('is not a null-402 settle() call');
  const c=createPublicClient({transport:http(NULL402_FUJI.rpc)});
  const tx=await c.getTransaction({hash:'0xbc62a275074dfb9434963ab04605c4102fcf937af4b8c8c0fb460368f007b025'});
  expect(tx.to?.toLowerCase()).toBe(NULL402_FUJI.pool.toLowerCase());
  // The real block of this recorded pool transaction also supplies a non-pool call, without
  // inventing a transaction, substituting an RPC response, or using a signing client.
  let outside: { hash: `0x${string}`; blockNumber: bigint | null } | undefined;
  for(let offset=0;offset<25 && !outside;offset++) {
    const block=await c.getBlock({blockNumber:tx.blockNumber!-BigInt(offset),includeTransactions:true});
    const candidate=block.transactions.find(t=>t.to?.toLowerCase()!==NULL402_FUJI.pool.toLowerCase());
    if(candidate) outside={hash:candidate.hash,blockNumber:block.number};
  }
  if(!outside) throw new MissingRecordedEvidence('Dependency: recorded non-pool Fuji transaction; the 25 blocks at/before published pool transaction had no other destination. Malformed hash and wrong selector already checked');
  await expect(proofFromSettleTx(outside.hash)).rejects.toThrow('is not a call to the null-402 pool');
  console.log(JSON.stringify({nonPoolHash:outside.hash,recordedPoolHash:tx.hash,nonPoolBlock:outside.blockNumber?.toString(),anchorBlock:tx.blockNumber?.toString()}));
},'malformed settlement hash rejected before RPC; recorded pool transaction wrong selector and real non-pool transaction located read-only in its preceding 25-block window rejected with exact field errors; no paid verdict');

row('CHAIN-001','recorded Oct 20 payment answers one reconstructed challenge',async()=>{
  const c=run.paywall.cases.paywall;
  const r=await verify(payCase('paywall')); report(r,4522621); expect(r).toMatchObject({ok:true,paidZat:10000,reasons:[]}); expect(r.report?.block_time).toBe(1792512944);
  const { createPaywall } = await import('../../gateway/src/server.js');
  // Standalone CHAIN-001 check only: no gateway suite, production process, fresh challenge payment,
  // or persistent store. Historical memo and clock reconstruct the recorded invoice locally.
  const server=createPaywall({payTo:merchant.address,uivk:merchant.uivk,prices:{'/recorded-chain-001':10000n},content:()=>({recorded:true}),issueMemo:()=>c.challengeMemo,now:()=>r.report!.block_time!*1000});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/recorded-chain-001`;
  try {
    const challenge=await fetch(base); expect(challenge.status).toBe(402); expect((await challenge.json()).accepts[0].memo).toBe(c.challengeMemo);
    const headers={'x-payment':Buffer.from(JSON.stringify({memo:c.challengeMemo,txid:c.txid})).toString('base64')};
    const accepted=await fetch(base,{headers}); expect(accepted.status).toBe(200); expect((await accepted.json()).paid).toMatchObject({txid:c.txid,height:4522621,paidZat:10000});
    expect(JSON.parse(Buffer.from(accepted.headers.get('x-payment-response')!,'base64').toString())).toMatchObject({success:true,transaction:c.txid});
    expect((await fetch(base,{headers})).status).toBe(402);
  }finally{await new Promise<void>(done=>server.close(()=>done()));}
},'recorded Oct20 tx authorization/inclusion/height4522621/time1792512944/10000/memo; isolated historical matching challenge returns 200 once with success receipt then replay402; no fresh payment');
row('CHAIN-016','second Fuji settlement SDK path; MCP evidence belongs to another task',async()=>{
  const hash='0xd91c0ab7d0d228d003277d62145442b24dcd52492becf561b9977c40fe781e5c';
  const s=await proofFromSettleTx(hash); expect(s).toMatchObject({status:'success',blockNumber:'57020809'});
  const r=await verifyNull402Settlement(hash,{payTo:s.publicSignals[2],requiredAmount:s.publicSignals[3],recipient:s.recipient}); expect(r).toMatchObject({ok:true,verdict:'paid',settled:true,settledInBlock:'57020809',checks:{proofValid:true,rootKnown:true,nullifierSpent:true}});
  throw new MissingRecordedEvidence('SDK path PASS for recorded 0xd91c0ab7…1e5c at block57020809, correct recipient/payTo/amount and paid/settled. Dependency for complete row: live MCP result for this recorded settlement from the task owning MCP; this task is explicitly forbidden to run MCP suites');
},'read-only second recorded settlement block57020809/status success/SDK paid; MCP evidence required separately');
row('EDGE-025','all recorded Zcash transactions through actual lightwalletd',async()=>{
  const ids=[...new Set<string>([
    ...Object.values(run.paywall.cases).map((c:any)=>c.txid),run.payslip.txid,run.fundTx,run.paywallLive.txid,
    fx.x402.txid,fx.auction.deposit.txid,fx.auction.memoMismatch.txid,
  ])];
  const o=await cli(['inspect',...ids],fx.x402.uivk,{},120000); expect(o.code).toBe(0);
  const records=o.out.trim().split('\n').map(l=>JSON.parse(l)); expect(records.map(r=>r.txid)).toEqual(ids);
  for(const r of records){
    // inspect runs GetTransaction, recomputes txid, authorizes and requires GetBlock inclusion before returning.
    expect(r.found).toBe(true); expect(r.height).toBeGreaterThan(0); expect(r.block_time).toBeGreaterThan(0); expect(r.confirmations).toBe(r.tip-r.height+1);
    console.log(JSON.stringify({txid:r.txid,height:r.height,block_time:r.block_time,tip:r.tip,confirmations:r.confirmations,pools:r.pools}));
  }
  expect(records.find(r=>r.txid===fx.x402.txid).height).toBe(4521112);
  expect(records.find(r=>r.txid===run.paywallLive.txid).height).toBe(4530239);
  const down=await cli(['inspect',fx.x402.txid],fx.x402.uivk,{ZPV_LWD_URL:'http://127.0.0.1:1'}); expect(down.code).toBe(2); expect(down.out).toBe(''); expect(down.err).toContain('cannot connect to lightwalletd');
},'10 unique published Zcash txids read via GetTransaction/GetBlock/tip at testnet.zec.rocks:443, txid recomputation/auth/inclusion enforced by inspect; heights/times/depth logged; unavailable transport emits error exit2/empty stdout');
