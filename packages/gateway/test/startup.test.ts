// The paywall entry point (src/main.ts) refuses settings that would make every customer's payment fail
// after they paid, and names the setting. Offline: whether payTo belongs to the viewing key is decided
// by `zpay-verify owns` (no server), with the published Hanko merchant and x402 merchant keys.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { zpayBinary } from '@zpv/sdk';

const run = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const fx = JSON.parse(readFileSync(resolve(__dirname, '../../../fixtures/testnet.json'), 'utf8'));
const GOOD = { ZPV_PAY_TO: run.wallets.merchant.address, ZPV_MERCHANT_UIVK: run.wallets.merchant.uivk, ZPV_PORT: '0' };

/** Starts main.ts with exactly this environment. Resolves on exit, or once it listens (then it is stopped by PID). */
function startMain(env: Record<string, string>): Promise<{ code: number | null; out: string; err: string; listening: boolean }> {
  return new Promise((res) => {
    const p = spawn(process.execPath, ['--import', 'tsx', resolve(__dirname, '../src/main.ts')], {
      cwd: resolve(__dirname, '..'),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ZPV_BIN: zpayBinary(), ...env },
    });
    let out = '';
    let err = '';
    let listening = false;
    const stop = setTimeout(() => p.kill('SIGTERM'), 20_000);
    p.stdout.on('data', (d) => {
      out += d;
      if (/zpv paywall on http:\/\/127\.0\.0\.1:\d+/.test(out) && !listening) {
        listening = true;
        p.kill('SIGTERM');
      }
    });
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      clearTimeout(stop);
      res({ code, out, err, listening });
    });
  });
}

describe('paywall startup checks', () => {
  it('the published Hanko address with its own viewing key starts and listens', async () => {
    const r = await startMain(GOOD);
    expect(r.listening, r.err).toBe(true);
    expect(r.out).toMatch(/zpv paywall on http:\/\/127\.0\.0\.1:[1-9]\d*/);
  });

  it('bad numbers are refused at startup with exit 2, naming the variable', async () => {
    const bad: [Record<string, string>, RegExp][] = [
      [{ ZPV_MIN_CONF: 'abc' }, /^Setup required: ZPV_MIN_CONF \(a whole number ≥ 1/],
      [{ ZPV_MIN_CONF: '0' }, /^Setup required: ZPV_MIN_CONF .*ZPV_ALLOW_ZERO_CONF=1/],
      [{ ZPV_MIN_CONF: '9007199254740993' }, /^Setup required: ZPV_MIN_CONF/],
      [{ ZPV_MIN_CONF: '4294967296' }, /^Setup required: ZPV_MIN_CONF/],
      [{ ZPV_PRICE_ZAT: '-1' }, /^Setup required: ZPV_PRICE_ZAT/],
      [{ ZPV_PRICE_ZAT: '0' }, /^Setup required: ZPV_PRICE_ZAT/],
      [{ ZPV_PRICE_ZAT: '1.5' }, /^Setup required: ZPV_PRICE_ZAT/],
      [{ ZPV_PRICE_ZAT: '2100000000000001' }, /^Setup required: ZPV_PRICE_ZAT/],
      [{ ZPV_PRICE_ZAT: '420000000000001' }, /^Setup required: ZPV_PRICE_ZAT/],
      [{ ZPV_PORT: '70000' }, /^Setup required: ZPV_PORT/],
      [{ ZPV_ADMIN_TOKEN: 'short' }, /^Setup required: ZPV_ADMIN_TOKEN \(at least 16 characters/],
      [{ ZPV_LWD_QUORUM: '0' }, /^Setup required: ZPV_LWD_QUORUM/],
      [{ ZPV_LWD_URLS: 'https://testnet.zec.rocks:443,http://127.0.0.1:9', ZPV_LWD_QUORUM: '0' }, /^Setup required: ZPV_LWD_QUORUM/],
      [{ ZPV_LWD_URLS: 'https://testnet.zec.rocks:443,http://127.0.0.1:9', ZPV_LWD_QUORUM: '3' }, /^Setup required: ZPV_LWD_QUORUM/],
      [{ ZPV_LWD_URLS: 'https://testnet.zec.rocks:443,http://127.0.0.1:9', ZPV_LWD_QUORUM: 'abc' }, /^Setup required: ZPV_LWD_QUORUM/],
    ];
    for (const [env, msg] of bad) {
      const r = await startMain({ ...GOOD, ...env });
      expect(r.listening, JSON.stringify(env)).toBe(false);
      expect(r.code, JSON.stringify(env)).toBe(2);
      expect(r.err.trim()).toMatch(msg);
    }
    // 0 confirmations only when asked for explicitly.
    const zero = await startMain({ ...GOOD, ZPV_MIN_CONF: '0', ZPV_ALLOW_ZERO_CONF: '1' });
    expect(zero.listening, zero.err).toBe(true);
    const upper = await startMain({ ...GOOD, ZPV_MIN_CONF: '4294967295', ZPV_PRICE_ZAT: '420000000000000', ZPV_LWD_URLS: 'https://testnet.zec.rocks:443,http://127.0.0.1:9', ZPV_LWD_QUORUM: '2' });
    expect(upper.listening, upper.err).toBe(true);
  });

  it('a payTo that the viewing key cannot see, or that is not a shielded testnet address, is refused', async () => {
    const mismatch = await startMain({ ...GOOD, ZPV_MERCHANT_UIVK: fx.x402.uivk });
    expect(mismatch.code).toBe(2);
    expect(mismatch.err).toMatch(/^Setup required: ZPV_PAY_TO \(utest19wj09n…yus7 does not belong to ZPV_MERCHANT_UIVK/);
    const transparent = await startMain({ ...GOOD, ZPV_PAY_TO: run.wallets.payer.transparent });
    expect(transparent.code).toBe(2);
    expect(transparent.err).toMatch(/^Setup required: ZPV_PAY_TO \(not a testnet unified address with a shielded receiver/);
    const badKey = await startMain({ ...GOOD, ZPV_MERCHANT_UIVK: 'uivktest1garbage' });
    expect(badKey.code).toBe(2);
    expect(badKey.err).toMatch(/^Setup required: ZPV_MERCHANT_UIVK/);
  });
});
