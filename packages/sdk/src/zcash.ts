// The zcash rail: runs the zpay-verify binary (packages/core) with the key in its environment.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CheckLimiter, envInt } from './limiter.js';
import { LightwalletdBadAnswerError, LightwalletdUnreachableError, SetupRequiredError, VerifyError } from './errors.js';

export interface ZcashRequest {
  rail: 'zcash';
  /** The receiver's unified incoming viewing key (uivktest1…). */
  uivk: string;
  txid: string;
  /** Whole zatoshi: a number, a bigint, or a decimal string. */
  amountZat: number | bigint;
  /** Only outputs with exactly this text memo count (at most 512 bytes). Without it every output to the
   *  key counts, so any past payment to the receiver can pass: track which txids you accepted. */
  memo?: string;
  /** Default 1. */
  minConf?: number;
  /** Default false: a transaction with any transparent input or output is refused. */
  allowTransparent?: boolean;
}

export interface ZcashOutput {
  pool: 'Sapling' | 'Orchard' | 'Ironwood';
  value: number;
  memo: string | null;
  memo_binary: boolean;
}

export interface ZcashReport {
  txid: string;
  found: boolean;
  height: number | null;
  /** Unix time of the block that mined it (lightwalletd's compact block, which must list the tx). */
  block_time: number | null;
  confirmations: number;
  tip: number;
  outputs: ZcashOutput[];
  pools: { sapling: boolean; orchard: boolean; ironwood: boolean; transparent: boolean };
}

/** One lightwalletd's part in a cross-check. */
export interface EndpointAnswer {
  lightwalletd: string;
  answered: boolean;
  /** It answered, but the answer contradicts itself (LightwalletdBadAnswerError): counted as a dissent. */
  inconsistent?: boolean;
  ok?: boolean;
  reasons?: string[];
  paidZat?: number;
  found?: boolean;
  height?: number | null;
  tip?: number;
  /** Why it did not answer (connection or RPC failure), or why its answer was not usable. */
  error?: string;
}

export interface CrossCheck {
  quorum: number;
  /** True when at least `quorum` endpoints answered and every answer agreed. */
  agreed: boolean;
  endpoints: EndpointAnswer[];
}

export interface ZcashResult {
  rail: 'zcash';
  ok: boolean;
  /**
   * `paid`: ok. `refused`: checked and not paid. `unverified`: lightwalletd endpoints disagreed or
   * too few answered, so nothing can be said (reasons `UNVERIFIED_DISAGREEMENT` / `UNVERIFIED_QUORUM`).
   */
  verdict: 'paid' | 'refused' | 'unverified';
  reasons: string[];
  paidZat: number;
  /** What the key sees in the transaction; null when the result is unverified. */
  report: ZcashReport | null;
  provenance: { lightwalletd: string; tip: number; checkedAt: string; via: 'zpay-verify' };
  /** Present when the payment was checked against several lightwalletd endpoints. */
  crossCheck?: CrossCheck;
}

/** ZPV_BIN, else the binary built in this repo (packages/core/target/release/zpay-verify). */
export function zpayBinary(env: Record<string, string | undefined> = process.env): string {
  if (env.ZPV_BIN) {
    if (!existsSync(env.ZPV_BIN)) throw new SetupRequiredError('ZPV_BIN', `${env.ZPV_BIN} does not exist`);
    return env.ZPV_BIN;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '../../core/target/release/zpay-verify'), env.CARGO_TARGET_DIR ? resolve(env.CARGO_TARGET_DIR, 'release/zpay-verify') : ''].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new SetupRequiredError('ZPV_BIN', 'build packages/core (cargo build --release) or point ZPV_BIN at zpay-verify');
  return found;
}

/** 21 million ZEC in zatoshi: no payment can be larger. */
const MAX_ZAT = 2_100_000_000_000_000n;

function zatoshi(v: unknown): bigint {
  let z: bigint | undefined;
  if (typeof v === 'bigint') z = v;
  else if (typeof v === 'number' && Number.isSafeInteger(v)) z = BigInt(v);
  else if (typeof v === 'string' && /^\d{1,19}$/.test(v)) z = BigInt(v);
  if (z === undefined || z < 0n || z > MAX_ZAT) throw new VerifyError(`amountZat must be a whole number of zatoshi from 0 to ${MAX_ZAT}, got ${typeof v === 'bigint' ? v : (JSON.stringify(v) ?? String(v))}`);
  return z;
}

function checkInput(req: ZcashRequest): bigint {
  if (typeof req !== 'object' || req === null) throw new VerifyError('the request must be an object');
  if (typeof req.txid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(req.txid)) throw new VerifyError(`not a txid (64 hex characters): ${String(req.txid)}`);
  if (typeof req.uivk !== 'string' || !req.uivk.startsWith('uivktest1')) throw new VerifyError('uivk must be a testnet unified incoming viewing key (uivktest1…)');
  const amount = zatoshi(req.amountZat);
  if (req.memo !== undefined && typeof req.memo !== 'string') throw new VerifyError('memo must be a string');
  if (req.memo !== undefined && Buffer.byteLength(req.memo, 'utf8') > 512) throw new VerifyError('memo is longer than 512 bytes, the most a Zcash memo holds');
  if (req.minConf !== undefined && !(Number.isSafeInteger(req.minConf) && req.minConf >= 0)) throw new VerifyError(`minConf must be a whole number ≥ 0, got ${JSON.stringify(req.minConf)}`);
  if (req.allowTransparent !== undefined && typeof req.allowTransparent !== 'boolean') throw new VerifyError('allowTransparent must be true or false');
  return amount;
}

/** The zcash rail's default limiter, shared by every caller in this process that does not bring its own. */
export const defaultZcashLimiter = new CheckLimiter();

/** The error zpay-verify printed (exit 2), as the error class a caller can act on. */
export function classifyCliError(msg: string): Error {
  if (/^(cannot connect to lightwalletd|lightwalletd RPC failed)/.test(msg)) return new LightwalletdUnreachableError(msg);
  if (/^(lightwalletd answered inconsistently|lightwalletd returned a transaction whose txid differs|transaction does not parse)/.test(msg)) return new LightwalletdBadAnswerError(msg);
  const setup = /^Setup required: (\S+?)\s+(.*)$/s.exec(msg);
  if (setup) return new SetupRequiredError(setup[1], setup[2]);
  if (/^invalid lightwalletd URL/.test(msg)) return new SetupRequiredError('ZPV_LWD_URL', msg);
  return new VerifyError(msg);
}

const seconds = (ms: number) => `${Number((ms / 1000).toFixed(1))} s`;

export async function verifyZcash(req: ZcashRequest, opts: { lwdUrl?: string; bin?: string; limiter?: CheckLimiter } = {}): Promise<ZcashResult> {
  const amount = checkInput(req);
  const args = ['verify', req.txid, '--amount', amount.toString(), '--min-conf', String(req.minConf ?? 1)];
  if (req.memo !== undefined) args.push('--memo', req.memo);
  if (req.allowTransparent) args.push('--allow-transparent');
  // Only what the binary needs: the key, which lightwalletd, and how to reach it.
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', ZPV_UIVK: req.uivk };
  const lwd = opts.lwdUrl ?? process.env.ZPV_LWD_URL;
  if (lwd) env.ZPV_LWD_URL = lwd;
  for (const k of ['ZPV_LWD_PROXY', 'ZPV_ALLOW_INSECURE_LWD']) if (process.env[k]) env[k] = process.env[k]!;
  const bin = opts.bin ?? zpayBinary();
  const timeoutMs = envInt('ZPV_CHECK_TIMEOUT_MS', 90_000, 1);
  const { code, stdout, stderr, timedOut } = await (opts.limiter ?? defaultZcashLimiter).run(
    () =>
      new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((res, rej) => {
        const p = spawn(bin, args, { env });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          p.kill('SIGKILL');
        }, timeoutMs);
        p.stdout.on('data', (d) => (stdout += d));
        p.stderr.on('data', (d) => (stderr += d));
        p.on('error', (e) => {
          clearTimeout(timer);
          rej(e);
        });
        p.on('close', (c) => {
          clearTimeout(timer);
          res({ code: c, stdout, stderr, timedOut });
        });
      }),
  );
  if (timedOut) throw new LightwalletdUnreachableError(`zpay-verify got no answer within ${seconds(timeoutMs)} from ${lwd ?? 'the default lightwalletd'} and was stopped (ZPV_CHECK_TIMEOUT_MS)`);
  if (code === 2 || (code !== 0 && code !== 1)) {
    const msg = stderr.replace(/^error: /, '').trim() || `zpay-verify exited with ${code}`;
    throw classifyCliError(msg);
  }
  const out = JSON.parse(stdout) as { report: ZcashReport; verdict: { ok: boolean; paid_zat: number; reasons: string[] }; lightwalletd: string };
  return {
    rail: 'zcash',
    ok: out.verdict.ok,
    verdict: out.verdict.ok ? 'paid' : 'refused',
    reasons: out.verdict.reasons,
    paidZat: out.verdict.paid_zat,
    report: out.report,
    provenance: { lightwalletd: out.lightwalletd, tip: out.report.tip, checkedAt: new Date().toISOString(), via: 'zpay-verify' },
  };
}

/** Whether a unified address belongs to a viewing key, per shielded receiver (null: no such receiver). */
export interface Ownership {
  owns: boolean;
  orchard: boolean | null;
  sapling: boolean | null;
}

/**
 * Does the testnet unified address `ua` belong to `uivk`? Runs `zpay-verify owns` (offline: each
 * shielded receiver's diversifier is decrypted with the key). A merchant checks this before advertising
 * `ua`: payments to an address the key cannot see would all be refused after the customer paid.
 * A malformed key or address throws VerifyError.
 */
export async function ownsAddress(uivk: string, ua: string, opts: { bin?: string } = {}): Promise<Ownership> {
  if (typeof uivk !== 'string' || !uivk.startsWith('uivktest1')) throw new VerifyError('uivk must be a testnet unified incoming viewing key (uivktest1…)');
  if (typeof ua !== 'string' || !ua.trim()) throw new VerifyError('not a testnet unified address with a shielded receiver: (empty)');
  const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((res, rej) => {
    const p = spawn(opts.bin ?? zpayBinary(), ['owns', ua.trim()], { env: { PATH: process.env.PATH ?? '', ZPV_UIVK: uivk } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', rej);
    p.on('close', (c) => res({ code: c, stdout, stderr }));
  });
  if (code !== 0 && code !== 1) throw classifyCliError(stderr.replace(/^error: /, '').trim() || `zpay-verify exited with ${code}`);
  return JSON.parse(stdout) as Ownership;
}

export interface CrossCheckOptions {
  /** Two or more lightwalletd URLs, ideally run by different operators on different software. */
  lwdUrls: string[];
  /** How many must answer (default: all of them). Every answer must agree, whatever the quorum. */
  quorum?: number;
  bin?: string;
  /** Default: the SDK's shared zcash limiter. */
  limiter?: CheckLimiter;
}

/** What has to match between two endpoints' answers: the verdict and everything it rests on. The
 *  tip and the confirmation count may differ by a block or two as long as the verdict does not. */
function signature(r: ZcashResult) {
  const { found, height, block_time, outputs, pools } = r.report!;
  return JSON.stringify({ ok: r.ok, reasons: r.reasons, paidZat: r.paidZat, found, height, block_time, outputs, pools });
}

/** scheme://host:port with the default port filled in, so two spellings of one server are one endpoint. */
function endpointKey(u: string): string {
  let x: URL;
  try {
    x = new URL(u);
  } catch {
    throw new VerifyError(`lwdUrls: not a URL: ${u}`);
  }
  if (x.protocol !== 'https:' && x.protocol !== 'http:') throw new VerifyError(`lwdUrls: not a URL: ${u} (https://host:port)`);
  return `${x.protocol}//${x.hostname}:${x.port || (x.protocol === 'https:' ? '443' : '80')}`;
}

/**
 * Check one payment against several lightwalletd endpoints. `paid` or `refused` only when at least
 * `quorum` endpoints answered and all answers agree; otherwise `unverified` (never `paid`). Bad input
 * and a missing binary still throw, as in verifyZcash. Two spellings of one server (with and without
 * :443) are refused: they would be one server voting twice.
 */
export async function verifyZcashCrossChecked(req: ZcashRequest, o: CrossCheckOptions): Promise<ZcashResult> {
  checkInput(req);
  const urls = o.lwdUrls.map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) throw new VerifyError('lwdUrls is empty');
  const seen = new Map<string, string>();
  for (const u of urls) {
    const k = endpointKey(u);
    const first = seen.get(k);
    if (first !== undefined) throw new VerifyError(`lwdUrls has the same URL twice: ${first} and ${u} are the same endpoint twice (${k})`);
    seen.set(k, u);
  }
  const quorum = o.quorum ?? urls.length;
  if (!Number.isInteger(quorum) || quorum < 1 || quorum > urls.length) throw new VerifyError(`quorum must be a whole number from 1 to ${urls.length}`);
  const settled = await Promise.allSettled(urls.map((u) => verifyZcash(req, { lwdUrl: u, bin: o.bin, limiter: o.limiter })));
  return crossCheckVerdict(urls, settled, quorum);
}

/**
 * The cross-check rule on its own: `settled[i]` is endpoint `urls[i]`'s outcome. An endpoint that cannot
 * be reached does not count toward the quorum; one whose answer contradicts itself is a dissent. Any
 * dissent or disagreement is UNVERIFIED_DISAGREEMENT; fewer answers than `quorum` is UNVERIFIED_QUORUM.
 */
export function crossCheckVerdict(urls: string[], settled: PromiseSettledResult<ZcashResult>[], quorum: number): ZcashResult {
  const endpoints: EndpointAnswer[] = [];
  const answers: ZcashResult[] = [];
  let dissent = false;
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      const r = s.value;
      answers.push(r);
      endpoints.push({ lightwalletd: urls[i], answered: true, ok: r.ok, reasons: r.reasons, paidZat: r.paidZat, found: r.report!.found, height: r.report!.height, tip: r.report!.tip });
    } else if (s.reason instanceof LightwalletdBadAnswerError) {
      dissent = true;
      endpoints.push({ lightwalletd: urls[i], answered: true, inconsistent: true, ok: false, error: s.reason.message });
    } else if (s.reason instanceof LightwalletdUnreachableError) {
      endpoints.push({ lightwalletd: urls[i], answered: false, error: s.reason.message });
    } else {
      throw s.reason; // bad input, Setup required or busy: the same for every endpoint, not a verdict
    }
  });

  const checkedAt = new Date().toISOString();
  const tips = answers.map((a) => a.report!.tip);
  const tip = tips.length ? Math.min(...tips) : 0;
  const unverified = (reason: string, agreed: boolean): ZcashResult => ({
    rail: 'zcash',
    ok: false,
    verdict: 'unverified',
    reasons: [reason],
    paidZat: 0,
    report: null,
    provenance: { lightwalletd: urls.join(', '), tip, checkedAt, via: 'zpay-verify' },
    crossCheck: { quorum, agreed, endpoints },
  });
  const agree = answers.every((a) => signature(a) === signature(answers[0]));
  if (dissent || (answers.length > 1 && !agree)) return unverified('UNVERIFIED_DISAGREEMENT', false);
  if (answers.length < quorum) return unverified('UNVERIFIED_QUORUM', false);

  const first = answers[0];
  const confirmations = Math.min(...answers.map((a) => a.report!.confirmations));
  return {
    ...first,
    report: { ...first.report!, confirmations, tip },
    provenance: { ...first.provenance, tip, checkedAt },
    crossCheck: { quorum, agreed: true, endpoints },
  };
}

/** ZPV_LWD_URLS (comma-separated) and ZPV_LWD_QUORUM from the environment, if set. */
export function crossCheckFromEnv(env: Record<string, string | undefined> = process.env): { lwdUrls: string[]; quorum?: number } | undefined {
  const lwdUrls = (env.ZPV_LWD_URLS ?? '').split(',').map((u) => u.trim()).filter(Boolean);
  if (lwdUrls.length === 0) return undefined;
  const q = env.ZPV_LWD_QUORUM?.trim();
  if (q && !/^\d+$/.test(q)) throw new SetupRequiredError('ZPV_LWD_QUORUM', `a whole number, got ${q}`);
  return { lwdUrls, quorum: q ? Number(q) : undefined };
}
