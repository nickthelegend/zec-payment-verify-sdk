// Real MCP client ↔ real zpv-mcp (stdio) ↔ live Zcash testnet and Avalanche Fuji.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { zpayBinary } from '@zpv/sdk';

const fx = JSON.parse(readFileSync(resolve(__dirname, '../../../fixtures/testnet.json'), 'utf8'));
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

beforeAll(async () => {
  client = await connect({ ZPV_MERCHANT_UIVK: fx.x402.uivk });
});
afterAll(async () => client?.close());

describe('zpv-mcp', () => {
  it('lists the two read-only tools', async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(['verify_null402_settlement', 'verify_zcash_payment']);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it('verify_zcash_payment: the published x402 payment is ok; a wrong memo is not', async () => {
    const ok = JSON.parse((await call(client, 'verify_zcash_payment', { txid: fx.x402.txid, amount_zat: 100_000, memo: fx.x402.memo })).text);
    expect(ok).toMatchObject({ ok: true, paid_zat: 100_000, height: 4_521_112, transparent: false });
    const bad = JSON.parse((await call(client, 'verify_zcash_payment', { txid: fx.x402.txid, amount_zat: 100_000, memo: 'other' })).text);
    expect(bad.reasons).toEqual(['MEMO_MISMATCH', 'AMOUNT_TOO_LOW']);
  });

  it('verify_null402_settlement: a real Fuji settle is a valid proof whose nullifier is already spent', async () => {
    const r = JSON.parse((await call(client, 'verify_null402_settlement', { settle_tx: '0x8596f52de2d8c15680c96a0fa25b1bb5073324155f586203507cddf92f5ca593' })).text);
    expect(r.checks).toEqual({ proofValid: true, rootKnown: true, nullifierSpent: true });
    expect(r.reasons).toEqual(['NULLIFIER_SPENT', 'UNBOUND']);
    const bound = JSON.parse((await call(client, 'verify_null402_settlement', { settle_tx: '0x8596f52de2d8c15680c96a0fa25b1bb5073324155f586203507cddf92f5ca593', expect_pay_to: r.signals.payTo, expect_amount: r.signals.requiredAmount })).text);
    expect(bound.reasons).toEqual(['NULLIFIER_SPENT']);
  });

  it('without the merchant key: Setup required, not a verdict', async () => {
    const c = await connect({});
    const r = await call(c, 'verify_zcash_payment', { txid: fx.x402.txid, amount_zat: 1 });
    await c.close();
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Setup required: ZPV_MERCHANT_UIVK');
  });
});
