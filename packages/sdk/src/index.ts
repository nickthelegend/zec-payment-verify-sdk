// One verify() for two payment rails. Every result comes from a live check (lightwalletd or a Fuji
// eth_call) and carries its provenance; a failure to check throws, it is never a verdict.
import { verifyNull402, type Null402Request, type Null402Result } from './null402.js';
import { verifyZcash, type ZcashRequest, type ZcashResult } from './zcash.js';

export * from './errors.js';
export * from './zcash.js';
export * from './null402.js';

export type VerifyRequest = ZcashRequest | Null402Request;
export type VerifyResult = ZcashResult | Null402Result;

export interface VerifyOptions {
  /** zcash rail: lightwalletd URL (default ZPV_LWD_URL, else https://testnet.zec.rocks:443) */
  lwdUrl?: string;
  /** null402 rail: Fuji RPC (default ZPV_FUJI_RPC, else the public Avalanche endpoint) */
  fujiRpc?: string;
}

export function verify(req: ZcashRequest, opts?: VerifyOptions): Promise<ZcashResult>;
export function verify(req: Null402Request, opts?: VerifyOptions): Promise<Null402Result>;
export function verify(req: VerifyRequest, opts?: VerifyOptions): Promise<VerifyResult>;
export function verify(req: VerifyRequest, opts: VerifyOptions = {}): Promise<VerifyResult> {
  switch (req.rail) {
    case 'zcash':
      return verifyZcash(req, { lwdUrl: opts.lwdUrl });
    case 'null402':
      return verifyNull402(req, { rpc: opts.fujiRpc });
    default:
      return Promise.reject(new Error(`unknown rail '${(req as { rail?: string }).rail}' (zcash or null402)`));
  }
}
