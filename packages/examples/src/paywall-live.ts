// One new testnet payment through the current paywall, with nothing pinned: the production entry point
// (packages/gateway dist/main.js) issues a stateless zpv-<expiry>-<nonce>-<HMAC> memo, a demo wallet pays
// it, the payment is presented with an x402 v1 X-PAYMENT (Shielded x402's own client when its checkout
// is there, KAGE_X402_DIR), the paywall answers 200, and the same payment presented again is refused.
// Writes the result to deployments/testnet.json under "paywallLive". Resumable (.demo/paywall-live.json):
// a rerun never pays twice.
//   ZPV_PAYER_WALLET=<zingo data dir of a funded demo wallet> pnpm --filter @zpv/examples paywall-live
// The wallet .demo/wallets/payer is refused (another project uses it), as is the treasury wallet.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { quicksend, spendable, zingoConfig } from './zingo.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const STATE = resolve(ROOT, '.demo/paywall-live.json');
const RECORD = resolve(ROOT, 'deployments/testnet.json');
const run = JSON.parse(readFileSync(RECORD, 'utf8'));
const merchant = run.wallets.merchant;
const PRICE = 10_000n;
const say = (s: string) => console.log(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const wallet = process.env.ZPV_PAYER_WALLET;
if (!wallet) {
  console.error('Setup required: ZPV_PAYER_WALLET (zingo data dir of a funded demo wallet)');
  process.exit(2);
}
for (const banned of [resolve(ROOT, '.demo/wallets/payer'), resolve(homedir(), 'zec-testnet-wallet')]) {
  if (resolve(wallet).startsWith(banned)) {
    console.error(`refusing ${wallet}: this wallet is not used by this script`);
    process.exit(2);
  }
}

type State = { memo?: string; expiresAt?: number; txid?: string; sentAt?: string };
const state: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

type Settlement = { success: boolean; transaction: string; network: string; payer: string; errorReason?: string };
type Presented = { status: number; settlement?: Settlement; body: any };

/** Shielded x402's own client if its checkout is there, else the same v1 envelope written here. */
async function presenter(): Promise<{ by: string; present: (url: string, txid: string, memo: string) => Promise<Presented> }> {
  const dir = process.env.KAGE_X402_DIR ?? resolve(ROOT, '../../../zec-shielded-x402/packages/x402-zcash');
  const src = resolve(dir, 'src/index.ts');
  if (existsSync(src)) {
    const k = (await import(pathToFileURL(src).href)) as { fetchWithPayment: (url: string, p: { txid: string; memoNonce: string }) => Promise<Presented> };
    return { by: 'zec-shielded-x402 packages/x402-zcash fetchWithPayment', present: (url, txid, memo) => k.fetchWithPayment(url, { txid, memoNonce: memo }) };
  }
  return {
    by: 'x402 v1 envelope built in paywall-live.ts',
    present: async (url, txid, memo) => {
      const header = Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'zcash-shielded', network: 'zcash-testnet', payload: { txid, memoNonce: memo } })).toString('base64');
      const r = await fetch(url, { headers: { 'x-payment': header } });
      const h = r.headers.get('x-payment-response');
      return { status: r.status, settlement: h ? JSON.parse(Buffer.from(h, 'base64').toString('utf8')) : undefined, body: await r.json() };
    },
  };
}

/** The production paywall (dist/main.js) on a free port, state in a SQLite file so a restart still accepts its memos. */
async function startPaywall(): Promise<{ base: string; stop: () => void }> {
  const p = spawn(process.execPath, [resolve(ROOT, 'packages/gateway/dist/main.js')], {
    env: { PATH: process.env.PATH ?? '', HOME: homedir(), ZPV_PAY_TO: merchant.address, ZPV_MERCHANT_UIVK: merchant.uivk, ZPV_PRICE_ZAT: PRICE.toString(), ZPV_PORT: '0', ZPV_STORE: resolve(ROOT, '.demo/paywall-live.db'), ...(process.env.ZPV_BIN ? { ZPV_BIN: process.env.ZPV_BIN } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  const port = await new Promise<number>((res, rej) => {
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
      const m = /zpv paywall on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) res(Number(m[1]));
    });
    p.on('close', (c) => rej(new Error(`paywall exited ${c}: ${err.trim()}`)));
  });
  say(`paywall (dist/main.js, pid ${p.pid}) on 127.0.0.1:${port}`);
  return { base: `http://127.0.0.1:${port}`, stop: () => p.kill('SIGTERM') };
}

async function main() {
  const { by, present } = await presenter();
  const pw = await startPaywall();
  try {
    const url = `${pw.base}/api/quote`;
    if (!state.memo) {
      const r = await fetch(url);
      const body = (await r.json()) as { accepts: { memo: string; expiresAt: number; amountZat: string; payTo: string }[] };
      if (r.status !== 402) throw new Error(`expected 402, got ${r.status}`);
      const c = body.accepts[0];
      if (!/^zpv-\d+-[0-9a-f]+-[A-Za-z0-9_-]+$/.test(c.memo) || c.payTo !== merchant.address || c.amountZat !== PRICE.toString()) throw new Error(`unexpected challenge ${JSON.stringify(c)}`);
      Object.assign(state, { memo: c.memo, expiresAt: c.expiresAt });
      save();
      say(`402: pay ${c.amountZat} zat with memo ${c.memo} (expires ${new Date(c.expiresAt).toISOString()})`);
    }
    if (!state.txid) {
      const cfg = zingoConfig();
      const have = await spendable(cfg, wallet!);
      say(`payer spendable: ${have} zat`);
      if (have < PRICE + 15_000n) throw new Error(`the payer wallet has ${have} zat spendable; it needs the price plus the fee`);
      const [txid] = await quicksend(cfg, wallet!, [{ address: merchant.address, amount: PRICE, memo: state.memo }]);
      Object.assign(state, { txid, sentAt: new Date().toISOString() });
      save();
      say(`sent ${txid}`);
    }
    // Present it until it is mined and confirmed: TX_NOT_FOUND and NOT_CONFIRMED are not refusals.
    const deadline = Date.now() + 45 * 60_000;
    let paid: Presented | undefined;
    const tries: { at: string; status: number; reasons?: string[]; error?: string }[] = [];
    while (Date.now() < deadline) {
      const r = await present(url, state.txid!, state.memo!);
      tries.push({ at: new Date().toISOString(), status: r.status, reasons: r.body?.reasons, error: r.body?.error });
      if (r.status === 200) {
        paid = r;
        break;
      }
      const reasons: string[] = r.body?.reasons ?? [];
      const waiting = r.status === 503 || (r.status === 402 && (reasons.join() === 'TX_NOT_FOUND' || reasons.join() === 'NOT_CONFIRMED'));
      say(`  ${r.status} ${r.body?.error ?? ''}`);
      if (!waiting) throw new Error(`refused: ${r.status} ${JSON.stringify(r.body)}`);
      await sleep(30_000);
    }
    if (!paid) throw new Error('not confirmed within 45 minutes; rerun to continue (nothing is paid twice)');
    say(`200: ${JSON.stringify(paid.body.paid)}`);
    const replay = await present(url, state.txid!, state.memo!);
    say(`replay: ${replay.status} ${replay.body?.error}`);
    if (replay.status !== 402) throw new Error(`the replay was answered ${replay.status}`);
    run.paywallLive = {
      ranAt: new Date().toISOString(),
      note: 'One payment through the current paywall (dist/main.js), nothing pinned: stateless HMAC memo, x402 v1 X-PAYMENT, served once, replay refused.',
      lightwalletd: 'https://testnet.zec.rocks:443',
      payerWallet: 'demo wallet .demo/wallets/employee (not .demo/wallets/payer)',
      presentedWith: by,
      priceZat: PRICE.toString(),
      challengeMemo: state.memo,
      txid: state.txid,
      sentAt: state.sentAt,
      attempts: tries.length,
      firstAttempts: tries.slice(0, 3),
      http: paid.status,
      settlement: paid.settlement,
      paid: paid.body.paid,
      replay: { http: replay.status, error: replay.body?.error, settlement: replay.settlement },
    };
    writeFileSync(RECORD, JSON.stringify(run, null, 2) + '\n');
    say('wrote deployments/testnet.json paywallLive');
  } finally {
    pw.stop();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
