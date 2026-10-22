#!/usr/bin/env node
// Records what the verify API answers for the console's three examples, live, into
// fixtures/console-recorded.json. The hosted console (GitHub Pages) shows these, labelled
// "Recorded output, not live", next to its Setup-required banner when no verify API runs on the
// reader's machine. Each response is the SDK's verify() result exactly as POST /api/verify returns it
// (JSON), never edited. The viewing keys are the published ones (fixtures/testnet.json); the request
// is stored with the key shortened, as the console shows it.
// Needs: packages/sdk built and packages/core/target/release/zpay-verify. Env: ZPV_LWD_URL (default
// https://testnet.zec.rocks:443).
import { readFileSync, writeFileSync } from 'node:fs';
import { verify } from '../packages/sdk/dist/index.js';

const fx = JSON.parse(readFileSync(new URL('../fixtures/testnet.json', import.meta.url), 'utf8'));
const lwdUrl = process.env.ZPV_LWD_URL ?? 'https://testnet.zec.rocks:443';
const examples = [
  { label: 'x402 payment', request: { rail: 'zcash', uivk: fx.x402.uivk, txid: fx.x402.txid, amountZat: fx.x402.amountZat, memo: fx.x402.memo, minConf: 1 } },
  { label: 'Wrong invoice memo', request: { rail: 'zcash', uivk: fx.x402.uivk, txid: fx.x402.txid, amountZat: fx.x402.amountZat, memo: 'x402z-another-invoice', minConf: 1 } },
  { label: 'Someone else’s payment', request: { rail: 'zcash', uivk: fx.x402.uivk, txid: fx.auction.deposit.txid, amountZat: 1, minConf: 1 } },
];
const samples = [];
for (const ex of examples) {
  const response = JSON.parse(JSON.stringify(await verify(ex.request, { lwdUrl })));
  samples.push({ label: ex.label, request: { ...ex.request, uivk: `${ex.request.uivk.slice(0, 14)}…` }, status: 200, response });
  console.log(`${ex.label}: ${response.verdict} ${response.reasons.join(', ')}`);
}
const out = { recordedAt: new Date().toISOString(), lightwalletd: lwdUrl, by: 'scripts/record-console-samples.mjs', samples };
writeFileSync(new URL('../fixtures/console-recorded.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log('wrote fixtures/console-recorded.json');
