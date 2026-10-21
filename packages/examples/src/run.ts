// Live example run on Zcash testnet; writes deployments/testnet.json. Resumable: state in
// .demo/run-state.json, so a rerun continues where it stopped and never pays twice.
//   ZPV_FUNDER_WALLET=<zingo data dir of a funded demo wallet> pnpm --filter @zpv/examples run-live
// Wallets live in .demo/wallets/{merchant,payer,employee} (gitignored). Their incoming viewing keys are
// published in the record on purpose (demo-only wallets): they reveal incoming payments, cannot spend.
//
//  1. paywall: GET → 402 → the payer pays the challenge → X-PAYMENT → 200 (checked with the merchant UIVK)
//  2. refusals, each a real transaction: wrong memo, underpaid, a transparent output in the same tx
//  3. payslip: an employer pays an employee; a lender checks it with the employee's UIVK only
//  4. third-party checks: the published x402 payment, and a real null-402 settle on Fuji
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPaywall } from '@zpv/gateway';
import { proofFromSettleTx, SetupRequiredError, verify, zpayBinary, type ZcashResult } from '@zpv/sdk';
import { address, exportUfvk, height, quicksend, spendable, zingoConfig, type Receiver } from './zingo.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEMO = resolve(ROOT, '.demo');
const W = (n: string) => resolve(DEMO, 'wallets', n);
const STATE = resolve(DEMO, 'run-state.json');
const cfg = zingoConfig();
const PRICE = 10_000n;
const PAYSLIP = 50_000n;
const PAYSLIP_MEMO = 'payslip 2026-10 #7: net 0.0005 TAZ';
const NULL402_SETTLE = '0x8596f52de2d8c15680c96a0fa25b1bb5073324155f586203507cddf92f5ca593';
const fx = JSON.parse(readFileSync(resolve(ROOT, 'fixtures/testnet.json'), 'utf8'));

type State = Record<string, unknown> & { txs?: Record<string, string>; checks?: Record<string, unknown> };
const state: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
state.txs ??= {};
state.checks ??= {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const say = (s: string) => console.log(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function uivkOf(ufvk: string): string {
  return execFileSync(zpayBinary(), ['derive'], { env: { PATH: process.env.PATH ?? '', ZPV_UFVK: ufvk } }).toString().trim();
}

/** Sends once per label: the txid is saved before anything else happens. */
async function sendOnce(label: string, from: string, to: Receiver[]): Promise<string> {
  if (state.txs![label]) return state.txs![label];
  let txid = '';
  // A note is spendable only a few blocks after it is mined; until then zingo-cli reports
  // "Insufficient balance". Wait for it rather than fail (nothing was broadcast).
  for (let i = 0; ; i++) {
    try {
      [txid] = await quicksend(cfg, W(from), to);
      break;
    } catch (e) {
      if (!/Insufficient balance/.test((e as Error).message) || i >= 20) throw e;
      say(`  … ${label}: notes not spendable yet, waiting a block`);
      await sleep(60_000);
    }
  }
  state.txs![label] = txid;
  save();
  say(`  sent ${label}: ${txid}`);
  return txid;
}

async function waitMined(txid: string, uivk: string) {
  for (let i = 0; i < 60; i++) {
    const r = await verify({ rail: 'zcash', uivk, txid, amountZat: 0, minConf: 1, allowTransparent: true });
    if ((r.report?.confirmations ?? 0) >= 1) return r;
    say(`  … ${txid.slice(0, 10)} ${r.report?.found ? 'in the mempool' : r.verdict === 'unverified' ? `unverified (${r.reasons.join(', ')})` : 'not seen yet'}`);
    await sleep(20_000);
  }
  throw new Error(`${txid} not mined after 20 minutes`);
}

async function main() {
  const funder = process.env.ZPV_FUNDER_WALLET;
  mkdirSync(resolve(DEMO, 'wallets'), { recursive: true, mode: 0o700 });
  const addr: Record<string, string> = (state.addresses as Record<string, string>) ?? {};
  const keys: Record<string, string> = (state.uivks as Record<string, string>) ?? {};
  for (const n of ['merchant', 'payer', 'employee']) {
    addr[n] ??= await address(cfg, W(n));
    keys[n] ??= uivkOf(await exportUfvk(cfg, W(n)));
  }
  // The payer's transparent address, for the "transparent part" refusal.
  state.payerTaddr ??= (await (async () => {
    const out = execFileSync(cfg.bin, ['--chain', 'testnet', '--server', cfg.server, '--data-dir', W('payer'), '--waitsync', 'new_taddress_allow_gap'], { cwd: '/tmp' }).toString();
    const m = out.match(/tm[0-9A-Za-z]{33}/);
    if (!m) throw new Error('no transparent address from zingo-cli');
    return m[0];
  })());
  Object.assign(state, { addresses: addr, uivks: keys });
  save();
  say(`merchant ${addr.merchant.slice(0, 20)}…  payer ${addr.payer.slice(0, 20)}…  employee ${addr.employee.slice(0, 20)}…`);

  // Funding: one transaction, several notes, so the payer can send without waiting for change.
  if (!state.txs!.fund) {
    if (!funder) throw new SetupRequiredError('ZPV_FUNDER_WALLET', 'zingo data dir of a funded demo testnet wallet');
    const bal = await spendable(cfg, funder);
    say(`funder spendable ${bal} zat`);
    if (bal < 2_200_000n) throw new Error(`funder has ${bal} zat, needs 2,200,000`);
  }
  const fund = await sendOnce('fund', funder ?? '', Array.from({ length: 5 }, () => ({ address: addr.payer, amount: 400_000n })));
  await waitMined(fund, keys.payer);

  // 1 + 2: four payments to the merchant, each answering its own challenge. Memos are saved, and the
  // paywall re-issues them, so a resumed run answers the same challenges.
  type Case = { label: string; memo: (c: string) => string; amount: bigint; extra?: Receiver[]; expect: number; reasons?: string[] };
  const cases: Case[] = [
    { label: 'paywall', memo: (c) => c, amount: PRICE, expect: 200 },
    { label: 'wrong-memo', memo: () => 'zpv-not-the-challenge', amount: PRICE, expect: 402, reasons: ['MEMO_MISMATCH', 'AMOUNT_TOO_LOW'] },
    { label: 'underpaid', memo: (c) => c, amount: PRICE / 2n, expect: 402, reasons: ['AMOUNT_TOO_LOW'] },
    { label: 'transparent-part', memo: (c) => c, amount: PRICE, extra: [{ address: state.payerTaddr as string, amount: 20_000n }], expect: 402, reasons: ['TRANSPARENT_PART'] },
  ];
  const memos = ((state.memos as Record<string, string>) ??= {});
  for (const k of cases) memos[k.label] ??= `zpv-${randomBytes(12).toString('hex')}`;
  save();
  const queue = cases.map((k) => memos[k.label]);
  const server = createPaywall({ payTo: addr.merchant, uivk: keys.merchant, prices: { '/api/quote': PRICE }, content: () => ({ quote: 'ZEC/USD', note: 'paid with a shielded payment' }), issueMemo: () => queue.shift() ?? `zpv-${randomBytes(12).toString('hex')}` });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const k of cases) {
    const r = await fetch(`${base}/api/quote`);
    const c = ((await r.json()) as { accepts: { memo: string; zip321: string }[] }).accepts[0];
    say(`GET /api/quote → ${r.status}, memo ${c.memo} (${k.label})`);
  }
  const xpay = (memo: string, txid: string) => fetch(`${base}/api/quote`, { headers: { 'x-payment': Buffer.from(JSON.stringify({ memo, txid })).toString('base64') } });

  for (const k of cases) {
    const c = memos[k.label];
    await sendOnce(k.label, 'payer', [{ address: addr.merchant, amount: k.amount, memo: k.memo(c) }, ...(k.extra ?? [])]);
  }
  await sendOnce('payslip', 'payer', [{ address: addr.employee, amount: PAYSLIP, memo: PAYSLIP_MEMO }]);

  const results: Record<string, unknown> = {};
  for (const k of cases) {
    const txid = state.txs![k.label];
    await waitMined(txid, keys.merchant);
    const r = await xpay(memos[k.label], txid);
    const body = (await r.json()) as { reasons?: string[]; error?: string; paid?: unknown };
    results[k.label] = { txid, challengeMemo: memos[k.label], sentMemo: k.memo(memos[k.label]), amountZat: k.amount.toString(), http: r.status, reasons: body.reasons ?? [], error: body.error ?? null, paid: body.paid ?? null };
    const pass = r.status === k.expect && (!k.reasons || JSON.stringify(body.reasons) === JSON.stringify(k.reasons));
    say(`${pass ? '✓' : '✗'} ${k.label}: HTTP ${r.status}${body.reasons ? ` ${body.reasons.join(', ')}` : ''}`);
    if (!pass) throw new Error(`${k.label}: expected ${k.expect} ${k.reasons ?? ''}, got ${r.status} ${JSON.stringify(body)}`);
  }
  server.close();

  // 3: payslip, checked by a lender with the employee's incoming viewing key only.
  const slip = state.txs!.payslip;
  await waitMined(slip, keys.employee);
  const lender = await verify({ rail: 'zcash', uivk: keys.employee, txid: slip, amountZat: PAYSLIP, memo: PAYSLIP_MEMO });
  const inflated = await verify({ rail: 'zcash', uivk: keys.employee, txid: slip, amountZat: PAYSLIP * 2n, memo: PAYSLIP_MEMO });
  const otherKey = await verify({ rail: 'zcash', uivk: keys.merchant, txid: slip, amountZat: PAYSLIP, memo: PAYSLIP_MEMO });
  say(`${lender.ok ? '✓' : '✗'} payslip with the employee key: ${lender.paidZat} zat "${lender.report?.outputs[0]?.memo}"`);
  say(`✓ claiming twice the pay: ${inflated.reasons.join(', ')}; the merchant's key on the payslip: ${otherKey.reasons.join(', ')}`);
  if (!lender.ok || inflated.ok || otherKey.ok) throw new Error('payslip checks did not come out as expected');

  // 4: third-party checks with no new transaction.
  const x402 = await verify({ rail: 'zcash', uivk: fx.x402.uivk, txid: fx.x402.txid, amountZat: fx.x402.amountZat, memo: fx.x402.memo });
  const settled = await proofFromSettleTx(NULL402_SETTLE);
  const n402 = await verify({ rail: 'null402', proof: settled.proof, publicSignals: settled.publicSignals });
  say(`✓ published x402 payment: ${x402.ok}; null-402 settle on Fuji: proof valid ${n402.checks.proofValid}, root known ${n402.checks.rootKnown}, ${n402.reasons.join(', ')}`);

  const brief = (r: ZcashResult) => ({ ok: r.ok, reasons: r.reasons, paidZat: r.paidZat, verdict: r.verdict, height: r.report?.height ?? null, confirmations: r.report?.confirmations ?? null, outputs: r.report?.outputs ?? [], pools: r.report?.pools ?? null });
  writeFileSync(
    resolve(ROOT, 'deployments/testnet.json'),
    JSON.stringify(
      {
        network: 'zcash-testnet',
        ranAt: new Date().toISOString(),
        lightwalletd: x402.provenance.lightwalletd,
        tipAtEnd: await height(cfg, W('merchant')),
        wallets: { merchant: { address: addr.merchant, uivk: keys.merchant }, payer: { address: addr.payer, transparent: state.payerTaddr }, employee: { address: addr.employee, uivk: keys.employee } },
        fundTx: fund,
        paywall: { priceZat: PRICE.toString(), minConf: 1, cases: results },
        payslip: { txid: slip, amountZat: PAYSLIP.toString(), memo: PAYSLIP_MEMO, lender: brief(lender), claimedDouble: brief(inflated), merchantKey: brief(otherKey) },
        thirdParty: { x402: { txid: fx.x402.txid, ...brief(x402) }, null402: { settleTx: NULL402_SETTLE, checks: n402.checks, reasons: n402.reasons, provenance: n402.provenance } },
      },
      null,
      2,
    ) + '\n',
  );
  say('wrote deployments/testnet.json');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`FAILED: ${(e as Error).message}`);
    process.exit(1);
  },
);
