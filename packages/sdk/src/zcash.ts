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

export interface ZcashResult {
  rail: 'zcash';
  ok: boolean;
  reasons: string[];
  paidZat: number;
  report: ZcashReport;
  provenance: { lightwalletd: string; tip: number; checkedAt: string; via: 'zpay-verify' };
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

export async function verifyZcash(req: ZcashRequest, opts: { lwdUrl?: string; bin?: string } = {}): Promise<ZcashResult> {
  if (!/^[0-9a-fA-F]{64}$/.test(req.txid)) throw new VerifyError(`not a txid (64 hex characters): ${req.txid}`);
  if (!req.uivk?.startsWith('uivktest1')) throw new VerifyError('uivk must be a testnet unified incoming viewing key (uivktest1…)');
  const amount = BigInt(req.amountZat);
  if (amount < 0n) throw new VerifyError('amountZat must be ≥ 0');
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
  if (code === 2 || (code !== 0 && code !== 1)) throw new VerifyError(stderr.replace(/^error: /, '').trim() || `zpay-verify exited with ${code}`);
  const out = JSON.parse(stdout) as { report: ZcashReport; verdict: { ok: boolean; paid_zat: number; reasons: string[] }; lightwalletd: string };
  return {
    rail: 'zcash',
    ok: out.verdict.ok,
    reasons: out.verdict.reasons,
    paidZat: out.verdict.paid_zat,
    report: out.report,
    provenance: { lightwalletd: out.lightwalletd, tip: out.report.tip, checkedAt: new Date().toISOString(), via: 'zpay-verify' },
  };
}
