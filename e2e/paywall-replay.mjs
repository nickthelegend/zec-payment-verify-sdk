// The real x402 paywall (packages/gateway) with its challenge memo pinned to the memo of the published
// paywall payment (deployments/testnet.json paywall.cases.paywall), as the gateway's own live tests pin
// theirs. That mined payment can then be presented and is checked live against lightwalletd with the
// published merchant viewing key: served once, refused on replay. No new payment is made.
// Env: ZPV_PAY_TO, ZPV_MERCHANT_UIVK, ZPV_PORT, ZPV_STORE, ZPV_LWD_URL.
import { readFileSync } from 'node:fs';
import { createPaywall, SqliteStore } from '../packages/gateway/dist/server.js';

const run = JSON.parse(readFileSync(new URL('../deployments/testnet.json', import.meta.url), 'utf8'));
const pinned = run.paywall.cases.paywall;
for (const k of ['ZPV_PAY_TO', 'ZPV_MERCHANT_UIVK', 'ZPV_STORE']) if (!process.env[k]) { console.error(`Setup required: ${k}`); process.exit(2); }
const port = Number(process.env.ZPV_PORT ?? 8423);
createPaywall({
  payTo: process.env.ZPV_PAY_TO,
  uivk: process.env.ZPV_MERCHANT_UIVK,
  prices: { '/api/quote': BigInt(run.paywall.priceZat) },
  minConf: run.paywall.minConf,
  lwdUrl: process.env.ZPV_LWD_URL,
  store: new SqliteStore(process.env.ZPV_STORE),
  issueMemo: () => pinned.challengeMemo,
  content: (path) => ({ path, servedAt: new Date().toISOString(), note: 'paid with a shielded Zcash payment, checked with a viewing key' }),
}).listen(port, '127.0.0.1', () => console.log(`replay paywall on http://127.0.0.1:${port} (memo pinned to ${pinned.challengeMemo})`));
