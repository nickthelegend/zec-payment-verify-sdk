// Disposable local paywall. Credentials are read internally from the two published fixture files.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPaywall, MemoryStore, SqliteStore } from '../../packages/gateway/src/server.js';

const root = resolve(import.meta.dirname, '../..');
const fixtures = JSON.parse(readFileSync(resolve(root, 'fixtures/testnet.json'), 'utf8'));
const recorded = JSON.parse(readFileSync(resolve(root, 'deployments/testnet.json'), 'utf8'));
const config = JSON.parse(process.env.HANKO_AUDIT_OPTIONS ?? '{}');
const profile = config.profile === 'x402' ? fixtures.x402 : config.profile === 'employee' ? recorded.wallets.employee : recorded.wallets.merchant;
const { profile: _profile, memo, memoList, counterMemo, nowMs, memory, ...options } = config;
let issued = 0;
let clock = nowMs;
const store = memory ? new MemoryStore() : new SqliteStore(process.env.ZPV_STORE!);
const server = createPaywall({
  payTo: profile.address ?? recorded.wallets.merchant.address,
  uivk: profile.uivk,
  prices: { '/api/quote': 10_000n, '/api/report': 50_000n },
  content: (path) => ({ path, note: 'paid with a shielded Zcash payment, checked with a viewing key' }),
  store,
  ...(memoList ? { issueMemo: () => memoList[issued++ % memoList.length] }
    : memo === undefined ? {} : { issueMemo: () => counterMemo ? `${memo}-${issued++}` : memo }),
  ...(clock === undefined ? {} : { now: () => clock }),
  ...options,
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (typeof address === 'object' && address) console.log(JSON.stringify({ port: address.port, pid: process.pid }));
});
process.on('message', (message: any) => {
  if (message.clock !== undefined) clock = message.clock;
  process.send?.({ ready: true });
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  server.closeAllConnections();
  server.close(() => { store.close(); process.exit(0); });
});
