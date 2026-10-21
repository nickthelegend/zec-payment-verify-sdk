#!/usr/bin/env node
// Env: ZPV_PAY_TO (merchant unified address), ZPV_MERCHANT_UIVK (its incoming viewing key),
// ZPV_PRICE_ZAT (default 10000), ZPV_MIN_CONF (default 1), ZPV_PORT (default 8403),
// ZPV_CORS (comma-separated browser origins for /api/verify), ZPV_LWD_URL,
// ZPV_STORE (SQLite file for challenges and claimed payments; without it the state is in memory and a
// restart forgets which payments were already served).
import { SetupRequiredError } from '@zpv/sdk';
import { createPaywall, MemoryStore, SqliteStore } from './server.js';

const need = (k: string) => process.env[k] || (() => { throw new SetupRequiredError(k); })();
try {
  const price = BigInt(process.env.ZPV_PRICE_ZAT ?? '10000');
  const server = createPaywall({
    payTo: need('ZPV_PAY_TO'),
    uivk: need('ZPV_MERCHANT_UIVK'),
    prices: { '/api/quote': price, '/api/report': price * 5n },
    minConf: Number(process.env.ZPV_MIN_CONF ?? 1),
    corsOrigins: (process.env.ZPV_CORS ?? 'http://localhost:5180').split(',').filter(Boolean),
    lwdUrl: process.env.ZPV_LWD_URL,
    store: process.env.ZPV_STORE ? new SqliteStore(process.env.ZPV_STORE) : new MemoryStore(),
    content: (path) => ({ path, servedAt: new Date().toISOString(), note: 'paid with a shielded Zcash payment, checked with a viewing key' }),
  });
  const port = Number(process.env.ZPV_PORT ?? 8403);
  server.listen(port, '127.0.0.1', () => console.log(`zpv paywall on http://127.0.0.1:${port} (payTo ${process.env.ZPV_PAY_TO?.slice(0, 16)}…, state ${process.env.ZPV_STORE ? `in ${process.env.ZPV_STORE}` : 'in memory: a restart forgets served payments'})`));
} catch (e) {
  console.error((e as Error).message);
  process.exit(e instanceof SetupRequiredError ? 2 : 1);
}
