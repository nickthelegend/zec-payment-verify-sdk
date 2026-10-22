#!/usr/bin/env node
// Env: ZPV_PAY_TO (merchant unified address), ZPV_MERCHANT_UIVK (its incoming viewing key),
// ZPV_PRICE_ZAT (default 10000), ZPV_MIN_CONF (default 1; 0 only with ZPV_ALLOW_ZERO_CONF=1),
// ZPV_PORT (default 8403), ZPV_CORS (comma-separated browser origins for /api/verify), ZPV_LWD_URL (or
// ZPV_LWD_URLS + ZPV_LWD_QUORUM: every payment cross-checked, disagreement answered with 503 and never
// served), ZPV_STORE (SQLite file for the challenge key, claimed payments and refunds; without it the
// state is in memory and a restart forgets which payments were already served), ZPV_ADMIN_TOKEN (at least
// 16 characters; GET /api/refunds needs it as a bearer token, and is off without it).
//
// Settings are checked before listening, and a bad one exits 2 with "Setup required: <name>": a
// paywall that starts with them would take customers' money and refuse every payment.
import { crossCheckFromEnv, ownsAddress, SetupRequiredError, VerifyError } from '@zpv/sdk';
import type { AddressInfo } from 'node:net';
import { createPaywall, MemoryStore, SqliteStore } from './server.js';

const need = (k: string) => process.env[k]?.trim() || (() => { throw new SetupRequiredError(k); })();

/** A whole number from the environment, at least `min` (and at most `max`). */
function whole(k: string, dflt: string, min: bigint, why = '', max?: bigint): bigint {
  const v = process.env[k]?.trim() || dflt;
  if (!/^\d{1,19}$/.test(v) || BigInt(v) < min || (max !== undefined && BigInt(v) > max)) {
    throw new SetupRequiredError(k, `a whole number ≥ ${min}${max !== undefined ? ` and ≤ ${max}` : ''}${why}, got ${v}`);
  }
  return BigInt(v);
}

const short = (s: string) => `${s.slice(0, 12)}…${s.slice(-4)}`;

async function main() {
  const payTo = need('ZPV_PAY_TO');
  const uivk = need('ZPV_MERCHANT_UIVK');
  const zeroConf = process.env.ZPV_ALLOW_ZERO_CONF === '1';
  const minConf = Number(whole('ZPV_MIN_CONF', '1', zeroConf ? 0n : 1n, zeroConf ? '' : ' (0 accepts mempool transactions, which can still be replaced; set ZPV_ALLOW_ZERO_CONF=1 to allow it)'));
  const price = whole('ZPV_PRICE_ZAT', '10000', 1n);
  const port = Number(whole('ZPV_PORT', '8403', 0n, '', 65535n));
  crossCheckFromEnv(); // a malformed ZPV_LWD_QUORUM is Setup required now, not on the first payment
  const adminToken = process.env.ZPV_ADMIN_TOKEN?.trim() || undefined;
  if (adminToken !== undefined && adminToken.length < 16) throw new SetupRequiredError('ZPV_ADMIN_TOKEN', 'at least 16 characters (it guards the refund list)');

  let owned;
  try {
    owned = await ownsAddress(uivk, payTo);
  } catch (e) {
    if (!(e instanceof VerifyError) || e instanceof SetupRequiredError) throw e;
    if (/incoming viewing key/.test(e.message)) throw new SetupRequiredError('ZPV_MERCHANT_UIVK', e.message);
    throw new SetupRequiredError('ZPV_PAY_TO', e.message);
  }
  if (!owned.owns) {
    throw new SetupRequiredError('ZPV_PAY_TO', `${short(payTo)} does not belong to ZPV_MERCHANT_UIVK: the key could never see a payment to it, so every one would be refused after the customer paid`);
  }

  const server = createPaywall({
    payTo,
    uivk,
    prices: { '/api/quote': price, '/api/report': price * 5n },
    minConf,
    corsOrigins: (process.env.ZPV_CORS ?? 'http://localhost:5180').split(',').filter(Boolean),
    lwdUrl: process.env.ZPV_LWD_URL,
    store: process.env.ZPV_STORE ? new SqliteStore(process.env.ZPV_STORE) : new MemoryStore(),
    adminToken,
    content: (path) => ({ path, servedAt: new Date().toISOString(), note: 'paid with a shielded Zcash payment, checked with a viewing key' }),
  });
  server.listen(port, '127.0.0.1', () => {
    const at = (server.address() as AddressInfo).port;
    console.log(`zpv paywall on http://127.0.0.1:${at} (payTo ${payTo.slice(0, 16)}…, min ${minConf} confirmation(s), state ${process.env.ZPV_STORE ? `in ${process.env.ZPV_STORE}` : 'in memory: a restart forgets served payments'})`);
  });
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => server.close(() => process.exit(0)));
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(e instanceof SetupRequiredError ? 2 : 1);
});
