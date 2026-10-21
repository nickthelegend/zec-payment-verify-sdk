// The zcash rail: runs the zpay-verify binary (packages/core) with the key in its environment.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SetupRequiredError, VerifyError } from './errors.js';

export interface ZcashRequest {
  rail: 'zcash';
  /** The receiver's unified incoming viewing key (uivktest1…). */
  uivk: string;
  txid: string;
  amountZat: number | bigint;
  /** Only outputs with exactly this text memo count. */
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
  confirmations: number;
  tip: number;
  outputs: ZcashOutput[];
  pools: { sapling: boolean; orchard: boolean; ironwood: boolean; transparent: boolean };
}

/** One lightwalletd's part in a cross-check. */
export interface EndpointAnswer {
  lightwalletd: string;
  answered: boolean;
  ok?: boolean;
  reasons?: string[];
  paidZat?: number;
  found?: boolean;
  height?: number | null;
  tip?: number;
  /** Why it did not answer (connection or RPC failure). */
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

function checkInput(req: ZcashRequest): bigint {
  if (!/^[0-9a-fA-F]{64}$/.test(req.txid)) throw new VerifyError(`not a txid (64 hex characters): ${req.txid}`);
  if (!req.uivk?.startsWith('uivktest1')) throw new VerifyError('uivk must be a testnet unified incoming viewing key (uivktest1…)');
  const amount = BigInt(req.amountZat);
  if (amount < 0n) throw new VerifyError('amountZat must be ≥ 0');
  return amount;
}

/** zpay-verify could not reach or query this lightwalletd (as opposed to bad input). */
export class LightwalletdUnreachableError extends VerifyError {
  constructor(message: string) {
    super(message);
    this.name = 'LightwalletdUnreachableError';
  }
}

export async function verifyZcash(req: ZcashRequest, opts: { lwdUrl?: string; bin?: string } = {}): Promise<ZcashResult> {
  const amount = checkInput(req);
  const args = ['verify', req.txid, '--amount', amount.toString(), '--min-conf', String(req.minConf ?? 1)];
  if (req.memo !== undefined) args.push('--memo', req.memo);
  if (req.allowTransparent) args.push('--allow-transparent');
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', ZPV_UIVK: req.uivk };
  const lwd = opts.lwdUrl ?? process.env.ZPV_LWD_URL;
  if (lwd) env.ZPV_LWD_URL = lwd;
  const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((res, rej) => {
    const p = spawn(opts.bin ?? zpayBinary(), args, { env });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', rej);
    p.on('close', (c) => res({ code: c, stdout, stderr }));
  });
  if (code === 2 || (code !== 0 && code !== 1)) {
    const msg = stderr.replace(/^error: /, '').trim() || `zpay-verify exited with ${code}`;
    throw /^(cannot connect to lightwalletd|lightwalletd RPC failed)/.test(msg) ? new LightwalletdUnreachableError(msg) : new VerifyError(msg);
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

export interface CrossCheckOptions {
  /** Two or more lightwalletd URLs, ideally run by different operators on different software. */
  lwdUrls: string[];
  /** How many must answer (default: all of them). Every answer must agree, whatever the quorum. */
  quorum?: number;
  bin?: string;
}

/** What has to match between two endpoints' answers: the verdict and everything it rests on. The
 *  tip and the confirmation count may differ by a block or two as long as the verdict does not. */
function signature(r: ZcashResult) {
  const { found, height, outputs, pools } = r.report!;
  return JSON.stringify({ ok: r.ok, reasons: r.reasons, paidZat: r.paidZat, found, height, outputs, pools });
}

/**
 * Check one payment against several lightwalletd endpoints. `paid` or `refused` only when at least
 * `quorum` endpoints answered and all answers agree; otherwise `unverified` (never `paid`). Bad input
 * and a missing binary still throw, as in verifyZcash.
 */
export async function verifyZcashCrossChecked(req: ZcashRequest, o: CrossCheckOptions): Promise<ZcashResult> {
  checkInput(req);
  const urls = o.lwdUrls.map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) throw new VerifyError('lwdUrls is empty');
  if (new Set(urls).size !== urls.length) throw new VerifyError('lwdUrls has the same URL twice');
  const quorum = o.quorum ?? urls.length;
  if (!Number.isInteger(quorum) || quorum < 1 || quorum > urls.length) throw new VerifyError(`quorum must be a whole number from 1 to ${urls.length}`);

  const settled = await Promise.allSettled(urls.map((u) => verifyZcash(req, { lwdUrl: u, bin: o.bin })));
  const endpoints: EndpointAnswer[] = [];
  const answers: ZcashResult[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      const r = s.value;
      answers.push(r);
      endpoints.push({ lightwalletd: urls[i], answered: true, ok: r.ok, reasons: r.reasons, paidZat: r.paidZat, found: r.report!.found, height: r.report!.height, tip: r.report!.tip });
    } else if (s.reason instanceof LightwalletdUnreachableError) {
      endpoints.push({ lightwalletd: urls[i], answered: false, error: s.reason.message });
    } else {
      throw s.reason; // bad input or Setup required: the same for every endpoint, not a verdict
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
  if (answers.length > 1 && !agree) return unverified('UNVERIFIED_DISAGREEMENT', false);
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
