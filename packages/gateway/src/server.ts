// Reference x402 paywall over a shielded Zcash payment, plus a verify API for the dashboard.
//   GET <paid path>                    → 402 with {payTo, amountZat, memo, minConf, zip321}
//   same path + X-PAYMENT {memo, txid} → @zpv/sdk verify (receiver's incoming viewing key) → 200
//   POST /api/verify {rail, …}         → the SDK verdict as JSON (both rails)
// The gateway holds only the merchant's incoming viewing key: it can see payments, never spend.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { SetupRequiredError, verify, VerifyError, type VerifyRequest } from '@zpv/sdk';

export interface PaywallOptions {
  /** The merchant's unified address (utest1…). */
  payTo: string;
  /** The merchant's unified incoming viewing key. */
  uivk: string;
  /** path → price in zatoshis */
  prices: Record<string, bigint>;
  content: (path: string) => unknown;
  minConf?: number;
  challengeTtlMs?: number;
  /** Most unanswered challenges kept at once (default 10,000). When full, a new one is a 503. */
  maxOpenChallenges?: number;
  lwdUrl?: string;
  /** Origins allowed to call /api/verify from a browser. */
  corsOrigins?: string[];
  /** Payment memo for a new challenge (default: zpv-<24 random hex>). */
  issueMemo?: () => string;
}

export interface Challenge {
  x402Version: 1;
  scheme: 'zcash-shielded';
  network: 'zcash-testnet';
  payTo: string;
  amountZat: string;
  memo: string;
  minConf: number;
  resource: string;
  expiresAt: number;
  /** ZIP-321 payment URI a wallet can open. */
  zip321: string;
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

export function createPaywall(o: PaywallOptions): Server {
  const minConf = o.minConf ?? 1;
  const ttl = o.challengeTtlMs ?? 60 * 60_000;
  const maxOpen = o.maxOpenChallenges ?? 10_000;
  const open = new Map<string, Challenge>();
  /** Lower-case txids that already paid for a request. */
  const usedTxids = new Set<string>();
  /** Memos and txids whose check is in progress. Claimed before the await, so two concurrent
   *  requests carrying the same payment cannot both be served. */
  const checking = new Set<string>();

  const json = (req: IncomingMessage, res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const origin = req.headers.origin;
    const cors: Record<string, string> = origin && o.corsOrigins?.includes(origin) ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type', vary: 'origin' } : {};
    res.writeHead(status, { 'content-type': 'application/json', ...cors, ...headers }).end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  };

  /** Expired challenges are dropped; a Map iterates in insertion order, so the oldest come first. */
  function prune() {
    const now = Date.now();
    for (const [memo, c] of open) {
      if (c.expiresAt >= now) break;
      open.delete(memo);
    }
  }

  function challenge(path: string, price: bigint): Challenge | null {
    prune();
    if (open.size >= maxOpen) return null;
    const memo = o.issueMemo?.() ?? `zpv-${randomBytes(12).toString('hex')}`;
    const c: Challenge = {
      x402Version: 1,
      scheme: 'zcash-shielded',
      network: 'zcash-testnet',
      payTo: o.payTo,
      amountZat: price.toString(),
      memo,
      minConf,
      resource: path,
      expiresAt: Date.now() + ttl,
      zip321: `zcash:${o.payTo}?amount=${(Number(price) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}&memo=${b64url(memo)}`,
    };
    open.delete(memo); // re-insert at the end so insertion order stays expiry order
    open.set(memo, c);
    return c;
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    let s = '';
    for await (const chunk of req) {
      s += chunk;
      if (s.length > 1_000_000) throw new VerifyError('request body too large');
    }
    try {
      return JSON.parse(s);
    } catch {
      throw new VerifyError('body is not JSON');
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname === '/api/verify') {
      if (req.method === 'OPTIONS') return json(req, res, 204, null);
      if (req.method !== 'POST') return json(req, res, 405, { error: 'POST a verify request' });
      try {
        const body = (await readBody(req)) as VerifyRequest;
        return json(req, res, 200, await verify(body, { lwdUrl: o.lwdUrl }));
      } catch (e) {
        const status = e instanceof SetupRequiredError ? 503 : e instanceof VerifyError ? 400 : 502;
        return json(req, res, status, { error: (e as Error).message });
      }
    }
    if (url.pathname === '/api/health') return json(req, res, 200, { ok: true, payTo: o.payTo, paths: Object.keys(o.prices) });

    const price = o.prices[url.pathname];
    if (price === undefined) return json(req, res, 404, { error: 'not found' });
    const header = req.headers['x-payment'];
    const fresh = () => {
      const c = challenge(url.pathname, price);
      return c ? { status: 402, body: { error: 'payment required', accepts: [c] } } : { status: 503, body: { error: 'too many open payment challenges; retry later' } };
    };
    if (!header || typeof header !== 'string') {
      const f = fresh();
      return json(req, res, f.status, f.body, f.status === 503 ? { 'retry-after': '60' } : {});
    }

    let p: { memo?: string; txid?: string };
    try {
      p = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    } catch {
      return json(req, res, 400, { error: 'X-PAYMENT is not base64 JSON {memo, txid}' });
    }
    const c = p.memo ? open.get(p.memo) : undefined;
    if (!c || c.resource !== url.pathname || c.expiresAt < Date.now()) {
      const f = fresh();
      return json(req, res, f.status, f.status === 402 ? { ...f.body, error: 'unknown or expired payment memo' } : f.body);
    }
    if (!p.txid) return json(req, res, 402, { error: 'X-PAYMENT has no txid', accepts: [c] });
    const txid = p.txid.toLowerCase();
    if (usedTxids.has(txid)) return json(req, res, 402, { error: 'this transaction already paid for a request', accepts: [c] });
    const memoKey = `memo:${c.memo}`;
    const txKey = `tx:${txid}`;
    if (checking.has(memoKey) || checking.has(txKey)) return json(req, res, 402, { error: 'this payment is already being checked by another request; retry', accepts: [c] });
    checking.add(memoKey);
    checking.add(txKey);
    let r;
    try {
      r = await verify({ rail: 'zcash', uivk: o.uivk, txid, amountZat: price, memo: c.memo, minConf }, { lwdUrl: o.lwdUrl });
    } catch (e) {
      return json(req, res, e instanceof VerifyError ? 400 : 502, { error: (e as Error).message });
    } finally {
      checking.delete(memoKey);
      checking.delete(txKey);
    }
    if (!r.ok) {
      const pendingOnly = r.reasons.length === 1 && r.reasons[0] === 'NOT_CONFIRMED';
      return json(req, res, 402, { error: pendingOnly ? `payment seen, ${r.report.confirmations}/${minConf} confirmations` : `payment refused: ${r.reasons.join(', ')}`, reasons: r.reasons, paidZat: r.paidZat, accepts: [c] });
    }
    // Synchronous from here to the response: no other request can interleave.
    open.delete(c.memo);
    usedTxids.add(txid);
    const receipt = { txid, height: r.report.height, confirmations: r.report.confirmations, paidZat: r.paidZat, memo: c.memo, lightwalletd: r.provenance.lightwalletd };
    return json(req, res, 200, { paid: receipt, data: o.content(url.pathname) }, { 'x-payment-response': Buffer.from(JSON.stringify(receipt)).toString('base64') });
  }

  return createServer((req, res) => {
    handle(req, res).catch((e: Error) => json(req, res, 502, { error: e.message }));
  });
}
