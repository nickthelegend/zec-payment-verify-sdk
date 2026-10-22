// One verify() for two payment rails. Every result comes from a live check (lightwalletd or a Fuji
// eth_call) and carries its provenance; a failure to check throws, it is never a verdict.
import { verifyNull402, type Null402Request, type Null402Result } from './null402.js';
import { VerifyError } from './errors.js';
import { crossCheckFromEnv, verifyZcash, verifyZcashCrossChecked, type ZcashRequest, type ZcashResult } from './zcash.js';

export * from './errors.js';
export * from './zcash.js';
export * from './null402.js';

export type VerifyRequest = ZcashRequest | Null402Request;
export type VerifyResult = ZcashResult | Null402Result;

export interface VerifyOptions {
  /** zcash rail: lightwalletd URL (default ZPV_LWD_URL, else https://testnet.zec.rocks:443) */
  lwdUrl?: string;
  /**
   * zcash rail: check against several lightwalletd endpoints instead (default ZPV_LWD_URLS,
   * comma-separated). Disagreement, or fewer than `quorum` answers, gives verdict `unverified`.
   */
  lwdUrls?: string[];
  /** With lwdUrls: how many must answer (default ZPV_LWD_QUORUM, else all). */
  quorum?: number;
  /** null402 rail: Fuji RPC (default ZPV_FUJI_RPC, else the public Avalanche endpoint) */
  fujiRpc?: string;
}

export function verify(req: ZcashRequest, opts?: VerifyOptions): Promise<ZcashResult>;
export function verify(req: Null402Request, opts?: VerifyOptions): Promise<Null402Result>;
export function verify(req: VerifyRequest, opts?: VerifyOptions): Promise<VerifyResult>;
export function verify(req: VerifyRequest, opts: VerifyOptions = {}): Promise<VerifyResult> {
  if (typeof req !== 'object' || req === null || Array.isArray(req)) return Promise.reject(new VerifyError('the request must be an object with a rail (zcash or null402)'));
  switch (req.rail) {
    case 'zcash': {
      if (opts.lwdUrls) return verifyZcashCrossChecked(req, { lwdUrls: opts.lwdUrls, quorum: opts.quorum });
      if (opts.lwdUrl) return verifyZcash(req, { lwdUrl: opts.lwdUrl });
      let env;
      try {
        env = crossCheckFromEnv();
      } catch (e) {
        return Promise.reject(e);
      }
      return env ? verifyZcashCrossChecked(req, { ...env, quorum: opts.quorum ?? env.quorum }) : verifyZcash(req, {});
    }
    case 'null402':
      return verifyNull402(req, { rpc: opts.fujiRpc });
    default:
      return Promise.reject(new VerifyError(`unknown rail '${(req as { rail?: string }).rail}' (zcash or null402)`));
  }
}
