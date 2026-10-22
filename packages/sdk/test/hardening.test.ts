// What the zcash rail does with bad input, odd endpoint lists, a proxy, a server that never answers and
// many checks at once. The binary is always the real zpay-verify; "never answers" is a real local TCP
// server that accepts and stays silent, and the cross-checks reach the real testnet.zec.rocks.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BusyError,
  CheckLimiter,
  crossCheckVerdict,
  proofFromSettleTx,
  LightwalletdBadAnswerError,
  LightwalletdUnreachableError,
  SetupRequiredError,
  verify,
  VerifyError,
  verifyZcash,
  verifyZcashCrossChecked,
} from '../src/index.js';

const fx = JSON.parse(readFileSync(resolve(__dirname, '../../../fixtures/testnet.json'), 'utf8'));
const req = { rail: 'zcash' as const, uivk: fx.x402.uivk, txid: fx.x402.txid, amountZat: 100_000, memo: fx.x402.memo };
const ZEC_ROCKS = 'https://testnet.zec.rocks:443';

const saved = { ...process.env };
afterEach(() => {
  for (const k of ['ZPV_LWD_PROXY', 'ZPV_ALLOW_INSECURE_LWD', 'ZPV_LWD_URL', 'ZPV_MAX_CHECKS', 'ZPV_MAX_QUEUE', 'ZPV_CHECK_TIMEOUT_MS', 'ZPV_MAX_NULL402_CHECKS']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** A lightwalletd that accepts TCP connections and never says anything, for `holdMs`. */
async function silentServer(holdMs: number): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((s) => {
    sockets.add(s);
    s.on('error', () => {});
    setTimeout(() => s.destroy(), holdMs).unref();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => (sockets.forEach((s) => s.destroy()), server.close(() => r()))) };
}

/** Running zpay-verify processes whose command line contains `marker`. */
function running(marker: string): number {
  try {
    return execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length;
  } catch {
    return 0; // pgrep exits 1 when nothing matches
  }
}

describe('zcash rail input', () => {
  it('a non-integer or negative amount, a bad minConf or memo, an unknown rail and a non-object are VerifyErrors (offline)', async () => {
    for (const bad of [{ amountZat: 1.5 }, { amountZat: 'abc' }, { amountZat: -1 }, { amountZat: Number.NaN }, { minConf: 1.5 }, { minConf: -1 }, { memo: 7 }]) {
      await expect(verify({ ...req, ...bad } as never), JSON.stringify(bad)).rejects.toBeInstanceOf(VerifyError);
    }
    await expect(verify({ ...req, rail: 'btc' } as never)).rejects.toBeInstanceOf(VerifyError);
    await expect(verify(null as never)).rejects.toBeInstanceOf(VerifyError);
    // A whole number given as a decimal string is fine: it is what JSON clients send for large amounts.
    await expect(verifyZcash({ ...req, amountZat: '100000' as never, txid: 'nope' })).rejects.toThrow(/not a txid/);
  });

  it('two spellings of one endpoint are not two votes (offline)', async () => {
    await expect(verifyZcashCrossChecked(req, { lwdUrls: ['https://testnet.zec.rocks', 'https://testnet.zec.rocks:443'] })).rejects.toThrow(/same endpoint twice/);
    await expect(verifyZcashCrossChecked(req, { lwdUrls: ['https://TESTNET.zec.rocks:443/', 'https://testnet.zec.rocks'] })).rejects.toThrow(/same endpoint twice/);
    await expect(verifyZcashCrossChecked(req, { lwdUrls: ['testnet.zec.rocks:443'] })).rejects.toThrow(/not a URL/);
  });
});

describe('how zpay-verify reaches lightwalletd', () => {
  it('ZPV_LWD_PROXY reaches the binary: a dead proxy is a connection error, never a direct check', async () => {
    process.env.ZPV_LWD_PROXY = 'socks5h://127.0.0.1:1';
    const e = await verifyZcash(req, { lwdUrl: ZEC_ROCKS }).catch((x) => x);
    expect(e).toBeInstanceOf(LightwalletdUnreachableError);
    expect(e.message).toMatch(/via proxy socks5h:\/\/127\.0\.0\.1:1/);
  });

  it('a plaintext URL to a remote host is a setup problem, not bad input (offline)', async () => {
    const e = await verifyZcash(req, { lwdUrl: 'http://203.0.113.1:9067' }).catch((x) => x);
    expect(e).toBeInstanceOf(SetupRequiredError);
    expect(e.message).toMatch(/plaintext http:\/\/ is refused/);
  });

  it('a check that gets no answer is killed after ZPV_CHECK_TIMEOUT_MS (offline)', async () => {
    const silent = await silentServer(20_000);
    const txid = randomBytes(32).toString('hex');
    process.env.ZPV_CHECK_TIMEOUT_MS = '1500';
    const t0 = Date.now();
    const e = await verifyZcash({ ...req, txid }, { lwdUrl: silent.url }).catch((x) => x);
    await silent.close();
    expect(e).toBeInstanceOf(LightwalletdUnreachableError);
    expect(e.message).toMatch(/no answer within 1\.5 s/);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(running(txid)).toBe(0);
  });

  it('at most ZPV_MAX_CHECKS binaries run at once; past ZPV_MAX_QUEUE waiting checks the rest are BusyError (offline)', async () => {
    const silent = await silentServer(2_000);
    const txid = randomBytes(32).toString('hex');
    process.env.ZPV_MAX_CHECKS = '3';
    process.env.ZPV_MAX_QUEUE = '5';
    let peak = 0;
    const watch = setInterval(() => (peak = Math.max(peak, running(txid))), 100);
    const results = await Promise.allSettled(Array.from({ length: 40 }, () => verifyZcash({ ...req, txid }, { lwdUrl: silent.url })));
    clearInterval(watch);
    await silent.close();
    const reasons = results.map((r) => (r.status === 'rejected' ? r.reason : r.value));
    expect(reasons.filter((r) => r instanceof BusyError)).toHaveLength(32);
    expect(reasons.filter((r) => r instanceof LightwalletdUnreachableError)).toHaveLength(8);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('null402 rail limits', () => {
  it('at most ZPV_MAX_NULL402_CHECKS Fuji checks run at once; past ZPV_MAX_QUEUE the rest are BusyError (live Fuji)', async () => {
    const s = await proofFromSettleTx('0x8596f52de2d8c15680c96a0fa25b1bb5073324155f586203507cddf92f5ca593');
    process.env.ZPV_MAX_NULL402_CHECKS = '1';
    process.env.ZPV_MAX_QUEUE = '0';
    const results = await Promise.allSettled(Array.from({ length: 3 }, () => verify({ rail: 'null402', proof: s.proof, publicSignals: s.publicSignals })));
    const busy = results.filter((r) => r.status === 'rejected' && r.reason instanceof BusyError);
    expect(busy).toHaveLength(2);
    expect((busy[0] as PromiseRejectedResult).reason.message).toMatch(/null-402 checks are running .*ZPV_MAX_NULL402_CHECKS 1/);
    const done = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ checks: { proofValid: boolean } }>;
    expect(done.value.checks.proofValid).toBe(true);
  });

  it('a limiter of its own does not share slots with the default one (offline)', async () => {
    process.env.ZPV_MAX_CHECKS = '1';
    process.env.ZPV_MAX_QUEUE = '0';
    const a = new CheckLimiter();
    const b = new CheckLimiter();
    let release = () => {};
    const held = a.run(() => new Promise<void>((r) => (release = r)));
    await expect(a.run(async () => 1)).rejects.toBeInstanceOf(BusyError);
    await expect(b.run(async () => 2)).resolves.toBe(2);
    release();
    await held;
  });
});

describe('cross-check answers', () => {
  it('an endpoint whose answer contradicts itself is a dissent: unverified, with that endpoint named', async () => {
    // A real answer from testnet.zec.rocks, beside the error the core raises for a block that does not
    // list the tx (packages/core VerifyError::Inconsistent, tested there on the real block with the tx removed).
    const real = await verifyZcash(req, { lwdUrl: ZEC_ROCKS });
    expect(real.ok).toBe(true);
    const liar = 'https://liar.example:443';
    const bad = new LightwalletdBadAnswerError(`lightwalletd answered inconsistently: it says ${fx.x402.txid} was mined at height 4521112, but its block at 4521112 does not list it`);
    const r = crossCheckVerdict([ZEC_ROCKS, liar], [{ status: 'fulfilled', value: real }, { status: 'rejected', reason: bad }], 1);
    expect(r.verdict).toBe('unverified');
    expect(r.reasons).toEqual(['UNVERIFIED_DISAGREEMENT']);
    expect(r.crossCheck?.endpoints[1]).toMatchObject({ lightwalletd: liar, answered: true, inconsistent: true, ok: false });
    expect(r.crossCheck?.endpoints[1].error).toMatch(/does not list it/);
  });
});
