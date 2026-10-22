// Reference x402 paywall over a shielded Zcash payment, plus a verify API for the dashboard.
//   GET <paid path>                    → 402 with {payTo, amountZat, memo, minConf, zip321}; the memo is
//                                        zpv-<expiry>-<nonce>-<HMAC>, so nothing is stored until a payment
//   same path + X-PAYMENT              → x402 v1 {x402Version, scheme, network, payload: {txid, memoNonce}}
//                                        (as Shielded x402 sends it) or {memo, txid} → @zpv/sdk verify
//                                        with the receiver's incoming viewing key → 200 + X-PAYMENT-RESPONSE
//   POST /api/verify {rail, …}         → the SDK verdict as JSON (both rails)
// The gateway holds only the merchant's incoming viewing key: it can see payments, never spend.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { BusyError, crossCheckFromEnv, LightwalletdBadAnswerError, LightwalletdUnreachableError, SetupRequiredError, verify, VerifyError, type VerifyRequest } from '@zpv/sdk';
import { MemoryStore, type PaywallStore, type Refund } from './store.js';

export { MemoryStore, SqliteStore, type PaywallStore, type Claim, type Refund } from './store.js';

export interface PaywallOptions {
  /** The merchant's unified address (utest1…). */
  payTo: string;
  /** The merchant's unified incoming viewing key. */
  uivk: string;
  /** path → price in zatoshis */
  prices: Record<string, bigint>;
  content: (path: string) => unknown;
  minConf?: number;
  /** How long a challenge stays payable (default 15 min): the payment's block must be no later than
   *  this plus `minedGraceMs`. */
  challengeTtlMs?: number;
  /** A payment mined up to this long after the challenge expired still counts (default 10 min, for
   *  block-time skew). Later is PAYMENT_LATE, recorded for a refund. */
  minedGraceMs?: number;
  /** How long after expiry a challenge can still be answered, for a payment mined in time that needed
   *  confirmations (default 24 h). */
  presentWindowMs?: number;
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
  /** Bearer token for GET /api/refunds (decrypted memos, amounts and txids). Without one the endpoint is
   *  off (503 Setup required: ZPV_ADMIN_TOKEN). Where a request comes from is not trusted: behind a
   *  reverse proxy every request looks local. */
  adminToken?: string;
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
  /** Refused payments one challenge may see before it is closed (default 5). TX_NOT_FOUND (lightwalletd
   *  has not seen the transaction yet), NOT_CONFIRMED and an unverified cross-check do not count. A closed
   *  challenge serves nothing, but a payment presented to it is still checked, and one whose funds reached
   *  the key with its memo is recorded for a refund (reason CHALLENGE_CLOSED). */
  maxFailedAttempts?: number;
}

/**
 * One entry of the 402's `accepts`: an x402 v1 PaymentRequirements for the `zcash-shielded` scheme, in the
 * shape Shielded x402 (Kage) uses (`maxAmountRequired`, `extra: {memoNonce, expiresAt, paymentUri}`),
 * plus Hanko's own names for the same values (`amountZat`, `memo`, `minConf`, `zip321`, and `expiresAt`
 * in milliseconds; `extra.expiresAt` is unix seconds).
 */
export interface Challenge {
  scheme: 'zcash-shielded';
  network: 'zcash-testnet';
  /** Zatoshi, decimal. */
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: 'application/json';
  payTo: string;
  maxTimeoutSeconds: number;
  asset: 'ZEC';
  extra: { memoNonce: string; expiresAt: number; paymentUri: string; minConf: number };
  amountZat: string;
  memo: string;
  minConf: number;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  /** ZIP-321 payment URI a wallet can open. */
  zip321: string;
}

/** X-PAYMENT-RESPONSE (x402 v1 SettlementResponse). A shielded payer is unknown to everyone: payer is "". */
const settlement = (success: boolean, transaction: string, errorReason?: string) =>
  Buffer.from(JSON.stringify({ success, ...(errorReason ? { errorReason } : {}), transaction, network: 'zcash-testnet', payer: '' })).toString('base64');

type Presented = { memo?: string; txid?: string } | { bad: string };

/**
 * X-PAYMENT, either the x402 v1 envelope {x402Version: 1, scheme: "zcash-shielded", network:
 * "zcash-testnet", payload: {txid, memoNonce}} (as Shielded x402 sends it) or Hanko's earlier
 * {memo, txid}. Both base64 JSON.
 */
function parsePayment(header: string): Presented {
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return { bad: 'X-PAYMENT is not base64 JSON {memo, txid}' };
  }
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return { bad: 'X-PAYMENT must be base64 JSON {memo: string, txid: string}' };
  if ('x402Version' in p || 'payload' in p || 'scheme' in p) {
    if (p.x402Version !== 1 || p.scheme !== 'zcash-shielded' || p.network !== 'zcash-testnet') return { bad: 'X-PAYMENT must be x402Version 1, scheme zcash-shielded, network zcash-testnet' };
    const pl = p.payload as Record<string, unknown> | null;
    if (typeof pl !== 'object' || pl === null || typeof pl.txid !== 'string' || typeof pl.memoNonce !== 'string') return { bad: 'X-PAYMENT payload must be {txid: string, memoNonce: string}' };
    return { memo: pl.memoNonce, txid: pl.txid };
  }
  if ((p.memo !== undefined && typeof p.memo !== 'string') || (p.txid !== undefined && typeof p.txid !== 'string')) return { bad: 'X-PAYMENT must be base64 JSON {memo: string, txid: string}' };
  return { memo: p.memo as string | undefined, txid: p.txid as string | undefined };
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
  const minedGrace = o.minedGraceMs ?? 10 * 60_000;
  const presentWindow = o.presentWindowMs ?? 24 * 60 * 60_000;
  const maxFailed = o.maxFailedAttempts ?? 5;
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
    const zip321 = `zcash:${o.payTo}?amount=${(Number(price) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}&memo=${b64url(memo)}`;
    return {
      scheme: 'zcash-shielded',
      network: 'zcash-testnet',
      maxAmountRequired: price.toString(),
      resource: path,
      description: `${path}: send ${price} zatoshi to payTo with the memo ${memo}, then retry with X-PAYMENT`,
      mimeType: 'application/json',
      payTo: o.payTo,
      maxTimeoutSeconds: Math.round(ttl / 1000),
      asset: 'ZEC',
      extra: { memoNonce: memo, expiresAt: Math.floor(expiresAt / 1000), paymentUri: zip321, minConf },
      amountZat: price.toString(),
      memo,
      minConf,
      expiresAt,
      zip321,
    };
  }

  /** A new challenge: stateless by default; a custom memo is stored (and capped). Null when the cap is hit. */
  function challenge(path: string, price: bigint): Challenge | null {
    const t = now();
    if (o.issueMemo) {
      const c = make(o.issueMemo(), path, price, t + ttl);
      return store.issue(c, maxOpen, t - presentWindow) ? c : null;
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
    if (url.pathname === '/api/refunds') {
      // Decrypted memos, amounts and txids: only with the admin token, wherever the request comes from.
      if (!o.adminToken) return json(req, res, 503, { error: 'Setup required: ZPV_ADMIN_TOKEN (set it to list refunds, then send Authorization: Bearer <token>)' });
      const auth = req.headers.authorization ?? '';
      const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const digest = (t: string) => createHash('sha256').update(t, 'utf8').digest();
      if (!given || !timingSafeEqual(digest(given), digest(o.adminToken))) return json(req, res, 401, { error: 'refunds need Authorization: Bearer <ZPV_ADMIN_TOKEN>' }, { 'www-authenticate': 'Bearer' });
      return json(req, res, 200, { refunds: store.refunds() });
    }
    if (url.pathname === '/api/health') return json(req, res, 200, { ok: true, payTo: o.payTo, paths: Object.keys(o.prices), lightwalletd: lightwalletd() });

    const price = o.prices[url.pathname];
    if (price === undefined) return json(req, res, 404, { error: 'not found' });
    if (req.method === 'OPTIONS') return json(req, res, 204, null, { allow: 'GET, HEAD, OPTIONS', 'access-control-allow-methods': 'GET, HEAD, OPTIONS' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(req, res, 405, { error: `${req.method} is not allowed on a paid path: GET it` }, { allow: 'GET, HEAD, OPTIONS' });
    const header = req.headers['x-payment'];
    const fresh = () => {
      const c = challenge(url.pathname, price);
      return c ? { status: 402, body: { x402Version: 1, error: 'payment required', accepts: [c] } } : { status: 503, body: { x402Version: 1, error: 'too many open payment challenges; retry later', accepts: [] } };
    };
    if (!header || typeof header !== 'string') {
      const f = fresh();
      return json(req, res, f.status, f.body, f.status === 503 ? { 'retry-after': '60' } : {});
    }

    const p = parsePayment(header);
    if ('bad' in p) return json(req, res, 400, { error: p.bad }, { 'x-payment-response': settlement(false, '', 'invalid_payload') });
    const c = p.memo ? lookup(p.memo, url.pathname, price) : undefined;
    if (!c || now() > c.expiresAt + presentWindow) {
      const f = fresh();
      return json(req, res, f.status, f.status === 402 ? { ...f.body, error: 'unknown or expired payment memo' } : f.body, { 'x-payment-response': settlement(false, '', 'unknown_challenge') });
    }
    // One challenge per answer: the entry the payer answered.
    const challenged = (error: string, extra: Record<string, unknown> = {}) => ({ x402Version: 1, error, ...extra, accepts: [c] });
    if (!p.txid) return json(req, res, 402, challenged('X-PAYMENT has no txid'));
    const closed = store.failures(c.memo) >= maxFailed;
    const txid = p.txid.trim().toLowerCase();
    const claim = store.claim(c.memo, txid, now(), leaseMs);
    if (!claim.ok) {
      const error = claim.why === 'used' ? 'this transaction already paid for a request' : 'this payment is already being checked by another request; retry';
      return json(req, res, 402, challenged(error), { 'x-payment-response': settlement(false, '', claim.why === 'used' ? 'nonce_already_used' : 'settlement_pending') });
    }
    let r;
    try {
      r = await verify({ rail: 'zcash', uivk: o.uivk, txid, amountZat: price, memo: c.memo, minConf }, lwdOpts);
    } catch (e) {
      store.release(c.memo, txid, claim.token);
      const f = failureStatus(e, 'paywall');
      const error = f.status === 503 ? `payment could not be checked: ${(e as Error).message}; nothing was served, retry later` : (e as Error).message;
      return json(req, res, f.status, f.status === 503 ? challenged(error) : { error }, f.headers);
    }
    if (r.verdict === 'unverified') {
      // The lightwalletd endpoints disagreed or too few answered: no verdict, so neither serve nor refuse.
      store.release(c.memo, txid, claim.token);
      return json(req, res, 503, challenged(`payment could not be verified: ${r.reasons.join(', ')}; retry later`, { reasons: r.reasons, crossCheck: r.crossCheck }), { 'retry-after': '30' });
    }
    // Mined-time expiry (as Shielded x402 does): what counts is when the block was mined, not when the
    // payment is presented. A transaction still in the mempool counts as mined now.
    const minedAt = r.report?.block_time != null ? r.report.block_time * 1000 : now();
    const late = r.report?.found === true && minedAt > c.expiresAt + minedGrace;
    // A closed challenge serves nothing; a payment that would have paid it is recorded for a refund.
    const reasons = closed ? (r.ok && !late ? ['CHALLENGE_CLOSED'] : [...r.reasons, ...(late ? ['PAYMENT_LATE'] : []), 'CHALLENGE_CLOSED'])
      : late ? [...r.reasons.filter((x) => x !== 'NOT_CONFIRMED'), 'PAYMENT_LATE'] : r.reasons;
    if (!r.ok || !r.report || late || closed) {
      store.release(c.memo, txid, claim.token);
      const pendingOnly = reasons.length === 1 && reasons[0] === 'NOT_CONFIRMED';
      // Not seen yet (a wallet retrying right after broadcasting) or not confirmed yet is not a refusal.
      const notSeen = reasons.length === 1 && reasons[0] === 'TX_NOT_FOUND';
      if (!pendingOnly && !notSeen && !closed) store.fail(c.memo);
      // Funds with this challenge's memo reached the key but buy nothing: write them down for a refund.
      let received: { zat: number; recorded: boolean } | undefined;
      if (!pendingOnly && r.paidZat > 0 && r.report) {
        const refund: Refund = { txid, memo: c.memo, resource: c.resource, paidZat: r.paidZat, reasons, height: r.report.height, blockTime: r.report.block_time, at: new Date().toISOString() };
        store.recordRefund(refund);
        received = { zat: r.paidZat, recorded: true };
      }
      let error = closed
        ? `this challenge is closed after ${maxFailed} refused payments; ask for a new one (this payment was checked: ${r.ok && !late ? 'it would have paid' : r.reasons.join(', ') || 'refused'})`
        : pendingOnly ? `payment seen, ${r.report?.confirmations ?? 0}/${minConf} confirmations` : `payment refused: ${reasons.join(', ')}`;
      if (late) error += ` (mined at ${new Date(minedAt).toISOString()}, after the challenge expired at ${new Date(c.expiresAt).toISOString()})`;
      if (received) error += '; the funds arrived and are recorded for a refund';
      return json(req, res, 402, challenged(error, { reasons, paidZat: r.paidZat, ...(received ? { received } : {}) }), { 'x-payment-response': settlement(false, '', late ? 'payment_expired' : pendingOnly ? 'settlement_pending' : 'invalid_payment') });
    }
    if (!store.settle(c.memo, txid, claim.token)) return json(req, res, 402, challenged('this payment was claimed by another request while it was being checked'));
    const receipt = { txid, height: r.report.height, confirmations: r.report.confirmations, paidZat: r.paidZat, memo: c.memo, lightwalletd: r.provenance.lightwalletd };
    return json(req, res, 200, { paid: receipt, data: o.content(url.pathname) }, { 'x-payment-response': settlement(true, txid) });
  }

  return createServer((req, res) => {
    handle(req, res).catch((e: Error) => json(req, res, 502, { error: e.message }));
  });
}
