// Reference x402 paywall over a shielded Zcash payment, plus a verify API for the dashboard.
//   GET <paid path>                    → 402 with {payTo, amountZat, memo, minConf, zip321}; the memo is
//                                        zpv-<expiry>-<nonce>-<HMAC>, so nothing is stored until a payment
//   same path + X-PAYMENT {memo, txid} → @zpv/sdk verify (receiver's incoming viewing key) → 200
//   POST /api/verify {rail, …}         → the SDK verdict as JSON (both rails)
// The gateway holds only the merchant's incoming viewing key: it can see payments, never spend.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { BusyError, crossCheckFromEnv, LightwalletdBadAnswerError, LightwalletdUnreachableError, SetupRequiredError, verify, VerifyError, type VerifyRequest } from '@zpv/sdk';
import { MemoryStore, type PaywallStore } from './store.js';

export { MemoryStore, SqliteStore, type PaywallStore, type Claim } from './store.js';

export interface PaywallOptions {
  /** The merchant's unified address (utest1…). */
  payTo: string;
  /** The merchant's unified incoming viewing key. */
  uivk: string;
  /** path → price in zatoshis */
  prices: Record<string, bigint>;
  content: (path: string) => unknown;
  minConf?: number;
  /** How long a challenge stays payable (default 15 min). */
  challengeTtlMs?: number;
  /** Custom memos only (issueMemo): most unanswered challenges kept at once (default 10,000); when full,
   *  a new one is a 503. The default memos carry their own expiry and HMAC and are never stored. */
  maxOpenChallenges?: number;
  lwdUrl?: string;
  /** Cross-check every payment against these lightwalletd endpoints. Without lwdUrls and lwdUrl, the SDK reads ZPV_LWD_URLS. */
  lwdUrls?: string[];
  /** With lwdUrls: how many must answer (default all). Disagreement is never served. */
  lwdQuorum?: number;
  /** Origins allowed to call /api/verify from a browser. */
  corsOrigins?: string[];
  /** A custom payment memo for each new challenge, stored until it expires (default: a stateless
   *  zpv-<expiry>-<nonce>-<HMAC> memo). Tests use it to pin the memo of a published payment. */
  issueMemo?: () => string;
  /** Clock (ms), for tests. */
  now?: () => number;
  /**
   * Challenges and claimed memos/txids (default: a MemoryStore, forgotten on restart). Use a
   * SqliteStore so a restart cannot re-unlock a paid response and several processes can share one file.
   */
  store?: PaywallStore;
  /** How long a check may hold its claim before another request may take it over (default 5 min). */
  claimLeaseMs?: number;
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

/**
 * How a failure to check is answered. 400 only for the caller's own input; a lightwalletd that is down
 * or inconsistent is the gateway's problem (502 on the API, 503 + Retry-After on the paywall so an x402
 * client retries instead of giving up after paying); a missing binary or setting is 503 Setup required.
 */
export function failureStatus(e: unknown, surface: 'api' | 'paywall'): { status: number; headers: Record<string, string> } {
  if (e instanceof SetupRequiredError) return { status: 503, headers: surface === 'paywall' ? { 'retry-after': '60' } : {} };
  if (e instanceof BusyError) return { status: 503, headers: { 'retry-after': '5' } };
  if (e instanceof LightwalletdUnreachableError || e instanceof LightwalletdBadAnswerError) return { status: surface === 'api' ? 502 : 503, headers: { 'retry-after': '30' } };
  if (e instanceof VerifyError) return { status: 400, headers: {} };
  return { status: 502, headers: {} };
}

/** zpv-<expiry, unix s>-<16 hex nonce>-<22 base64url chars of HMAC-SHA256>: at most 64 characters. */
const MEMO_RE = /^zpv-(\d{10})-([0-9a-f]{16})-([A-Za-z0-9_-]{22})$/;

export function createPaywall(o: PaywallOptions): Server {
  const minConf = o.minConf ?? 1;
  const ttl = o.challengeTtlMs ?? 15 * 60_000;
  const now = o.now ?? Date.now;
  const maxOpen = o.maxOpenChallenges ?? 10_000;
  const leaseMs = o.claimLeaseMs ?? 5 * 60_000;
  /** Open challenges, and memos and lower-case txids that are being checked or already paid. A
   *  payment is claimed before the await, so two concurrent requests (or two processes sharing a
   *  SqliteStore) carrying the same payment cannot both be served. */
  const store = o.store ?? new MemoryStore();
  const lwdOpts = o.lwdUrls ? { lwdUrls: o.lwdUrls, quorum: o.lwdQuorum } : { lwdUrl: o.lwdUrl };
  /** Which lightwalletd endpoints a zcash check uses (for /api/health), resolved as the SDK does. */
  const lightwalletd = () => {
    if (o.lwdUrls) return { urls: o.lwdUrls, quorum: o.lwdQuorum ?? o.lwdUrls.length };
    const env = o.lwdUrl ? undefined : crossCheckFromEnv();
    if (env) return { urls: env.lwdUrls, quorum: env.quorum ?? env.lwdUrls.length };
    return { urls: [o.lwdUrl ?? process.env.ZPV_LWD_URL ?? 'https://testnet.zec.rocks:443'], quorum: 1 };
  };

  const json = (req: IncomingMessage, res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const origin = req.headers.origin;
    const cors: Record<string, string> =
      origin && o.corsOrigins?.includes(origin)
        ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type, x-payment', 'access-control-expose-headers': 'x-payment-response', vary: 'origin' }
        : {};
    res.writeHead(status, { 'content-type': 'application/json', ...cors, ...headers }).end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  };

  const tag = (path: string, price: bigint, exp: number, nonce: string) =>
    createHmac('sha256', store.secret()).update(`zpv1|${o.payTo}|${path}|${price}|${exp}|${nonce}`).digest('base64url').slice(0, 22);

  function make(memo: string, path: string, price: bigint, expiresAt: number): Challenge {
    return {
      x402Version: 1,
      scheme: 'zcash-shielded',
      network: 'zcash-testnet',
      payTo: o.payTo,
      amountZat: price.toString(),
      memo,
      minConf,
      resource: path,
      expiresAt,
      zip321: `zcash:${o.payTo}?amount=${(Number(price) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}&memo=${b64url(memo)}`,
    };
  }

  /** A new challenge: stateless by default; a custom memo is stored (and capped). Null when the cap is hit. */
  function challenge(path: string, price: bigint): Challenge | null {
    const t = now();
    if (o.issueMemo) {
      const c = make(o.issueMemo(), path, price, t + ttl);
      return store.issue(c, maxOpen, t) ? c : null;
    }
    const exp = Math.ceil((t + ttl) / 1000);
    const nonce = randomBytes(8).toString('hex');
    return make(`zpv-${exp}-${nonce}-${tag(path, price, exp, nonce)}`, path, price, exp * 1000);
  }

  /** The challenge `memo` answers on `path` at `price`, if this paywall issued it. */
  function lookup(memo: string, path: string, price: bigint): Challenge | undefined {
    const m = MEMO_RE.exec(memo);
    if (m) {
      const [, exp, nonce, got] = m;
      const want = tag(path, price, Number(exp), nonce);
      return timingSafeEqual(Buffer.from(got), Buffer.from(want)) ? make(memo, path, price, Number(exp) * 1000) : undefined;
    }
    const c = store.challenge(memo);
    return c && c.resource === path ? c : undefined;
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
        return json(req, res, 200, await verify(body, lwdOpts));
      } catch (e) {
        const f = failureStatus(e, 'api');
        return json(req, res, f.status, { error: (e as Error).message }, f.headers);
      }
    }
    if (url.pathname === '/api/health') return json(req, res, 200, { ok: true, payTo: o.payTo, paths: Object.keys(o.prices), lightwalletd: lightwalletd() });

    const price = o.prices[url.pathname];
    if (price === undefined) return json(req, res, 404, { error: 'not found' });
    if (req.method === 'OPTIONS') return json(req, res, 204, null, { allow: 'GET, HEAD, OPTIONS', 'access-control-allow-methods': 'GET, HEAD, OPTIONS' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(req, res, 405, { error: `${req.method} is not allowed on a paid path: GET it` }, { allow: 'GET, HEAD, OPTIONS' });
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
    const isObject = typeof p === 'object' && p !== null && !Array.isArray(p);
    if (!isObject || (p.memo !== undefined && typeof p.memo !== 'string') || (p.txid !== undefined && typeof p.txid !== 'string')) {
      return json(req, res, 400, { error: 'X-PAYMENT must be base64 JSON {memo: string, txid: string}' });
    }
    const c = p.memo ? lookup(p.memo, url.pathname, price) : undefined;
    if (!c || c.expiresAt < now()) {
      const f = fresh();
      return json(req, res, f.status, f.status === 402 ? { ...f.body, error: 'unknown or expired payment memo' } : f.body);
    }
    if (!p.txid) return json(req, res, 402, { error: 'X-PAYMENT has no txid', accepts: [c] });
    const txid = p.txid.toLowerCase();
    const claim = store.claim(c.memo, txid, now(), leaseMs);
    if (!claim.ok) {
      const error = claim.why === 'used' ? 'this transaction already paid for a request' : 'this payment is already being checked by another request; retry';
      return json(req, res, 402, { error, accepts: [c] });
    }
    let r;
    try {
      r = await verify({ rail: 'zcash', uivk: o.uivk, txid, amountZat: price, memo: c.memo, minConf }, lwdOpts);
    } catch (e) {
      store.release(c.memo, txid, claim.token);
      const f = failureStatus(e, 'paywall');
      const error = f.status === 503 ? `payment could not be checked: ${(e as Error).message}; nothing was served, retry later` : (e as Error).message;
      return json(req, res, f.status, { error, accepts: f.status === 503 ? [c] : undefined }, f.headers);
    }
    if (r.verdict === 'unverified') {
      // The lightwalletd endpoints disagreed or too few answered: no verdict, so neither serve nor refuse.
      store.release(c.memo, txid, claim.token);
      return json(req, res, 503, { error: `payment could not be verified: ${r.reasons.join(', ')}; retry later`, reasons: r.reasons, crossCheck: r.crossCheck, accepts: [c] }, { 'retry-after': '30' });
    }
    if (!r.ok || !r.report) {
      store.release(c.memo, txid, claim.token);
      const pendingOnly = r.reasons.length === 1 && r.reasons[0] === 'NOT_CONFIRMED';
      return json(req, res, 402, { error: pendingOnly ? `payment seen, ${r.report?.confirmations ?? 0}/${minConf} confirmations` : `payment refused: ${r.reasons.join(', ')}`, reasons: r.reasons, paidZat: r.paidZat, accepts: [c] });
    }
    if (!store.settle(c.memo, txid, claim.token)) return json(req, res, 402, { error: 'this payment was claimed by another request while it was being checked', accepts: [c] });
    const receipt = { txid, height: r.report.height, confirmations: r.report.confirmations, paidZat: r.paidZat, memo: c.memo, lightwalletd: r.provenance.lightwalletd };
    return json(req, res, 200, { paid: receipt, data: o.content(url.pathname) }, { 'x-payment-response': Buffer.from(JSON.stringify(receipt)).toString('base64') });
  }

  return createServer((req, res) => {
    handle(req, res).catch((e: Error) => json(req, res, 502, { error: e.message }));
  });
}
