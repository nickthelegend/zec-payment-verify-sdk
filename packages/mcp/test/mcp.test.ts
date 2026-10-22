// Real MCP client ↔ real zpv-mcp (stdio) ↔ live Zcash testnet and Avalanche Fuji.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { zpayBinary } from '@zpv/sdk';

const fx = JSON.parse(readFileSync(resolve(__dirname, '../../../fixtures/testnet.json'), 'utf8'));
/** The two real null-402 settle() calls on the Fuji pool (both succeeded; there is no reverted one). */
const SETTLE = '0x8596f52de2d8c15680c96a0fa25b1bb5073324155f586203507cddf92f5ca593';
const SETTLE_2 = '0xd91c0ab7d0d228d003277d62145442b24dcd52492becf561b9977c40fe781e5c';
const dir = mkdtempSync(join(tmpdir(), 'zpv-mcp-'));
let client: Client;

async function connect(extra: Record<string, string>) {
  const c = new Client({ name: 'zpv-test', version: '0' });
  await c.connect(new StdioClientTransport({ command: resolve(__dirname, '../node_modules/.bin/tsx'), args: [resolve(__dirname, '../src/main.ts')], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ZPV_BIN: zpayBinary(), ...extra } }));
  return c;
}
const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: r.isError, text: r.content[0].text };
};
const json = async (c: Client, name: string, args: Record<string, unknown>) => JSON.parse((await call(c, name, args)).text);

beforeAll(async () => {
  client = await connect({ ZPV_MERCHANT_UIVK: fx.x402.uivk });
});
afterAll(async () => {
  await client?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('zpv-mcp', () => {
  it('lists the two read-only tools, and the zcash one says that a check alone does not use a payment up', async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(['verify_null402_settlement', 'verify_zcash_payment']);
    const z = tools.find((t) => t.name === 'verify_zcash_payment')!;
    expect(z.description).toMatch(/does not mark a payment as used/);
    expect(z.description).toMatch(/ALREADY_USED/);
    expect(tools.find((t) => t.name === 'verify_null402_settlement')!.description).toMatch(/SETTLE_REVERTED/);
  });

  it('verify_zcash_payment: the published x402 payment is ok; a wrong memo is not', async () => {
    const ok = await json(client, 'verify_zcash_payment', { txid: fx.x402.txid, amount_zat: 100_000, memo: fx.x402.memo });
    expect(ok).toMatchObject({ ok: true, paid_zat: 100_000, height: 4_521_112, transparent: false, single_use: false, min_conf: 1 });
    const bad = await json(client, 'verify_zcash_payment', { txid: fx.x402.txid, amount_zat: 100_000, memo: 'other' });
    expect(bad.reasons).toEqual(['MEMO_MISMATCH', 'AMOUNT_TOO_LOW']);
  });

  it('the model cannot lower min_conf below ZPV_MCP_MIN_CONF (default 1); it can raise it', async () => {
    const zero = await json(client, 'verify_zcash_payment', { txid: fx.x402.txid, amount_zat: 100_000, memo: fx.x402.memo, min_conf: 0 });
    expect(zero.min_conf).toBe(1);
    const deep = await json(client, 'verify_zcash_payment', { txid: fx.x402.txid, amount_zat: 100_000, memo: fx.x402.memo, min_conf: 100_000_000 });
    expect(deep).toMatchObject({ ok: false, reasons: ['NOT_CONFIRMED'], min_conf: 100_000_000 });
  });

  it('with ZPV_STORE a payment is accepted once: the second call is ALREADY_USED, and a memo is required', async () => {
    const c = await connect({ ZPV_MERCHANT_UIVK: fx.x402.uivk, ZPV_STORE: join(dir, 'mcp.sqlite') });
    try {
      const first = await json(c, 'verify_zcash_payment', { txid: fx.x402.txid, amount_zat: 100_000, memo: fx.x402.memo });
      expect(first).toMatchObject({ ok: true, verdict: 'paid', single_use: true });
      const second = await json(c, 'verify_zcash_payment', { txid: fx.x402.txid.toUpperCase(), amount_zat: 100_000, memo: fx.x402.memo });
      expect(second).toMatchObject({ ok: false, verdict: 'refused', reasons: ['ALREADY_USED'] });
      const noMemo = await call(c, 'verify_zcash_payment', { txid: fx.x402.txid, amount_zat: 1 });
      expect(noMemo.isError).toBe(true);
      expect(noMemo.text).toMatch(/memo is required/);
    } finally {
      await c.close();
    }
  });

  it('ZPV_MCP_REQUIRE_MEMO makes the memo required; ZPV_MCP_LOG is written 0600', async () => {
    const log = join(dir, 'calls.jsonl');
    const c = await connect({ ZPV_MERCHANT_UIVK: fx.x402.uivk, ZPV_MCP_REQUIRE_MEMO: '1', ZPV_MCP_LOG: log });
    try {
      const r = await call(c, 'verify_zcash_payment', { txid: fx.x402.txid, amount_zat: 1 });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/memo is required/);
    } finally {
      await c.close();
    }
    expect(statSync(log).mode & 0o777).toBe(0o600);
  });

  it('verify_null402_settlement: a real successful settle() bound to the merchant is paid; unbound or another recipient is not', async () => {
    const unbound = await json(client, 'verify_null402_settlement', { settle_tx: SETTLE });
    expect(unbound.checks).toEqual({ proofValid: true, rootKnown: true, nullifierSpent: true });
    expect(unbound).toMatchObject({ ok: false, settled: true, status: 'success', reasons: ['UNBOUND'], settled_in_block: '57020734' });
    expect(unbound.proof_check.reasons).toEqual(['NULLIFIER_SPENT', 'UNBOUND']);
    const me = { expect_pay_to: unbound.signals.payTo, expect_amount: unbound.signals.requiredAmount, expect_recipient: unbound.recipient };
    for (const tx of [SETTLE, SETTLE_2]) {
      const bound = await json(client, 'verify_null402_settlement', { settle_tx: tx, ...me });
      expect(bound, tx).toMatchObject({ ok: true, verdict: 'paid', settled: true, reasons: [] });
    }
    const other = await json(client, 'verify_null402_settlement', { settle_tx: SETTLE, ...me, expect_recipient: '0x0000000000000000000000000000000000000001' });
    expect(other).toMatchObject({ ok: false, verdict: 'refused', reasons: ['RECIPIENT_MISMATCH'] });
    // The pool pays whatever recipient settle() names, so payee and amount alone are not a payment to me.
    const noRecipient = await json(client, 'verify_null402_settlement', { settle_tx: SETTLE, expect_pay_to: me.expect_pay_to, expect_amount: me.expect_amount });
    expect(noRecipient).toMatchObject({ ok: false, verdict: 'refused', reasons: ['UNBOUND'] });
    const tool = (await client.listTools()).tools.find((t) => t.name === 'verify_null402_settlement')!;
    expect(tool.description).toMatch(/expect_recipient[^.]*required for ok/);
  });

  it('verify_zcash_payment is annotated read-only only when it writes nothing: with ZPV_STORE it consumes the payment', async () => {
    const plain = (await client.listTools()).tools.find((t) => t.name === 'verify_zcash_payment')!;
    expect(plain.annotations).toMatchObject({ readOnlyHint: true });
    const c = await connect({ ZPV_MERCHANT_UIVK: fx.x402.uivk, ZPV_STORE: join(dir, 'annotations.sqlite') });
    try {
      const single = (await c.listTools()).tools.find((t) => t.name === 'verify_zcash_payment')!;
      expect(single.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
      expect(single.title).toMatch(/single use/i);
      expect(single.description).toMatch(/consumes the payment/);
    } finally {
      await c.close();
    }
  });

  it('without the merchant key: Setup required, not a verdict', async () => {
    const c = await connect({});
    const r = await call(c, 'verify_zcash_payment', { txid: fx.x402.txid, amount_zat: 1 });
    await c.close();
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Setup required: ZPV_MERCHANT_UIVK');
  });
});
