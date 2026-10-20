// Video demo: re-checks, live, the transactions the testnet run made (deployments/testnet.json),
// through the same paths a user would take: the CLI, the paywall over HTTP, the SDK, and Fuji.
//   pnpm --filter @zpv/examples demo
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPaywall } from '@zpv/gateway';
import { proofFromSettleTx, verify, zpayBinary } from '@zpv/sdk';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const run = JSON.parse(readFileSync(resolve(ROOT, 'deployments/testnet.json'), 'utf8'));
const fx = JSON.parse(readFileSync(resolve(ROOT, 'fixtures/testnet.json'), 'utf8'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = async (s: string, ms = 900) => {
  console.log(s);
  await sleep(ms);
};
const short = (s: string) => `${s.slice(0, 10)}…${s.slice(-6)}`;

async function main() {
  await say('1. CLI: did the x402 payment pay the merchant 100000 zat with its invoice memo?');
  await say(`   $ ZPV_UIVK=<merchant key> zpay-verify verify ${short(fx.x402.txid)} --amount 100000 --memo ${fx.x402.memo}`, 300);
  for (const memo of [fx.x402.memo, 'x402z-another-invoice']) {
    let out = '';
    let code = 0;
    try {
      out = execFileSync(zpayBinary(), ['verify', fx.x402.txid, '--amount', '100000', '--memo', memo], { env: { PATH: process.env.PATH ?? '', ZPV_UIVK: fx.x402.uivk } }).toString();
    } catch (e) {
      const err = e as { status: number; stdout: Buffer };
      code = err.status;
      out = err.stdout.toString();
    }
    const v = JSON.parse(out) as { verdict: { ok: boolean; paid_zat: number; reasons: string[] }; report: { height: number; confirmations: number } };
    await say(`   memo ${memo}: exit ${code}, ok=${v.verdict.ok}, paid ${v.verdict.paid_zat}${v.verdict.reasons.length ? `, ${v.verdict.reasons.join(', ')}` : ''} (block ${v.report.height}, ${v.report.confirmations} confirmations)`);
  }

  await say('\n2. Paywall: the payments from the live run, checked again now with the merchant key');
  const cases = run.paywall.cases as Record<string, { txid: string; challengeMemo: string; sentMemo: string; amountZat: string }>;
  const queue = Object.values(cases).map((c) => c.challengeMemo);
  const server = createPaywall({ payTo: run.wallets.merchant.address, uivk: run.wallets.merchant.uivk, prices: { '/api/quote': BigInt(run.paywall.priceZat) }, content: () => ({ quote: 'ZEC/USD' }), issueMemo: () => queue.shift() ?? 'zpv-x' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const [label, c] of Object.entries(cases)) {
    const first = await fetch(`${base}/api/quote`);
    const paid = await fetch(`${base}/api/quote`, { headers: { 'x-payment': Buffer.from(JSON.stringify({ memo: c.challengeMemo, txid: c.txid })).toString('base64') } });
    const body = (await paid.json()) as { reasons?: string[]; paid?: { height: number } };
    await say(`   ${label.padEnd(16)} sent ${c.amountZat.padStart(5)} zat memo ${c.sentMemo === c.challengeMemo ? 'challenge' : `"${c.sentMemo}"`}  tx ${short(c.txid)}  GET → ${first.status}, X-PAYMENT → ${paid.status}${body.reasons ? ` ${body.reasons.join(', ')}` : ` (block ${body.paid?.height})`}`);
  }
  server.close();

  await say('\n3. Payslip: a lender checks the employee\'s pay with the employee\'s viewing key only');
  const p = run.payslip;
  const ok = await verify({ rail: 'zcash', uivk: run.wallets.employee.uivk, txid: p.txid, amountZat: BigInt(p.amountZat), memo: p.memo });
  await say(`   ${short(p.txid)}: ok=${ok.ok}, ${ok.paidZat} zat, memo "${ok.report.outputs[0]?.memo}"`);
  const twice = await verify({ rail: 'zcash', uivk: run.wallets.employee.uivk, txid: p.txid, amountZat: BigInt(p.amountZat) * 2n, memo: p.memo });
  await say(`   claiming twice the pay: ok=${twice.ok}, ${twice.reasons.join(', ')}`);

  await say('\n4. null-402 on Avalanche Fuji: a real settle(), read-only checks against the deployed contracts');
  const s = await proofFromSettleTx(run.thirdParty.null402.settleTx);
  const n = await verify({ rail: 'null402', proof: s.proof, publicSignals: s.publicSignals });
  await say(`   proof valid ${n.checks.proofValid}, root known ${n.checks.rootKnown}, nullifier spent ${n.checks.nullifierSpent} → ${n.reasons.join(', ')}`);
  const bumped = [...s.publicSignals];
  bumped[3] = (BigInt(bumped[3]) * 10n).toString();
  const t = await verify({ rail: 'null402', proof: s.proof, publicSignals: bumped });
  await say(`   same proof claiming 10× the amount: proof valid ${t.checks.proofValid} → ${t.reasons.join(', ')}`, 2000);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`FAILED: ${(e as Error).message}`);
    process.exit(1);
  },
);
