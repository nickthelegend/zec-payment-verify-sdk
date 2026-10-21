// MCP tools for agents and merchants: check a payment before delivering anything.
// The merchant's incoming viewing key comes from ZPV_MERCHANT_UIVK (never a tool argument, so it does
// not pass through the model). Optional ZPV_MCP_LOG: one JSON line per call.
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { proofFromSettleTx, SetupRequiredError, verify } from '@zpv/sdk';

function log(tool: string, args: unknown, isError: boolean, result: unknown) {
  const f = process.env.ZPV_MCP_LOG;
  if (f) appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), tool, args, isError, result }) + '\n');
}

async function run(tool: string, args: unknown, fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    log(tool, args, false, result);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    const text = (e as Error).message;
    log(tool, args, true, text);
    return { isError: true, content: [{ type: 'text' as const, text }] };
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'zec-payment-verify', version: '0.1.0' });

  server.registerTool(
    'verify_zcash_payment',
    {
      title: 'Check a shielded Zcash payment to the merchant',
      description:
        'Did transaction `txid` pay the merchant at least `amount_zat` zatoshis with memo `memo`, with at least `min_conf` confirmations and no transparent part? Checked live on Zcash testnet with the merchant’s incoming viewing key. Returns ok, reasons (TX_NOT_FOUND, NO_OUTPUT_TO_KEY, MEMO_MISMATCH, AMOUNT_TOO_LOW, NOT_CONFIRMED, TRANSPARENT_PART) and what the key saw.',
      inputSchema: {
        txid: z.string().regex(/^[0-9a-fA-F]{64}$/),
        amount_zat: z.number().int().nonnegative(),
        memo: z.string().max(512).optional(),
        min_conf: z.number().int().nonnegative().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (a) =>
      run('verify_zcash_payment', a, async () => {
        const uivk = process.env.ZPV_MERCHANT_UIVK;
        if (!uivk) throw new SetupRequiredError('ZPV_MERCHANT_UIVK');
        const r = await verify({ rail: 'zcash', uivk, txid: a.txid, amountZat: a.amount_zat, memo: a.memo, minConf: a.min_conf ?? 1 });
        return { ok: r.ok, reasons: r.reasons, paid_zat: r.paidZat, height: r.report.height, confirmations: r.report.confirmations, outputs: r.report.outputs, transparent: r.report.pools.transparent, lightwalletd: r.provenance.lightwalletd };
      }),
  );

  server.registerTool(
    'verify_null402_settlement',
    {
      title: 'Check a null-402 payment proof on Avalanche Fuji',
      description:
        'Reads the proof out of a null-402 settle() transaction on Fuji and checks it against the deployed verifier and pool with read-only calls: proof valid, Merkle root known to the pool, nullifier spent. Pass expect_pay_to and expect_amount: without both the result is never ok (reason UNBOUND), because nothing ties the proof to you.',
      inputSchema: {
        settle_tx: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        expect_pay_to: z.string().regex(/^\d+$/).optional(),
        expect_amount: z.string().regex(/^\d+$/).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (a) =>
      run('verify_null402_settlement', a, async () => {
        const s = await proofFromSettleTx(a.settle_tx as `0x${string}`);
        const r = await verify({ rail: 'null402', proof: s.proof, publicSignals: s.publicSignals, expect: { payTo: a.expect_pay_to, requiredAmount: a.expect_amount } });
        return { ok: r.ok, reasons: r.reasons, checks: r.checks, signals: r.signals, recipient: s.recipient, settled_in_block: s.blockNumber, checked_at_block: r.provenance.blockNumber };
      }),
  );
  return server;
}
