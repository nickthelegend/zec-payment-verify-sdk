// A second, separate paywall process for store.test.ts: the published x402 merchant key, its memo
// pinned, state in the SQLite file given as argv[2]. Prints {"port": n} once it listens.
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createPaywall } from '../../src/server.js';
import { SqliteStore } from '../../src/store.js';

const fx = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../fixtures/testnet.json'), 'utf8'));
const store = new SqliteStore(process.argv[2]);
const server = createPaywall({ payTo: 'utest1-demo-merchant', uivk: fx.x402.uivk, prices: { '/api/quote': 100_000n }, content: (p) => ({ served: p, pid: process.pid }), issueMemo: () => fx.x402.memo, store });
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: (server.address() as AddressInfo).port })));
process.on('SIGTERM', () => {
  server.close();
  store.close();
  process.exit(0);
});
