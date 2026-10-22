// MCP tools for agents and merchants: check a payment before delivering anything.
// The merchant's incoming viewing key comes from ZPV_MERCHANT_UIVK (never a tool argument, so it does
// not pass through the model). Settings the model cannot change, all from the server's environment:
//   ZPV_STORE              SQLite file (the gateway's store): verify_zcash_payment accepts each payment
//                          once (by memo and txid) and needs a memo. Shared with a paywall on the same
//                          file, so a payment served there is ALREADY_USED here and the other way round.
//   ZPV_MCP_MIN_CONF       the lowest min_conf a call may use (default 1); a lower one is raised to it.
//   ZPV_MCP_REQUIRE_MEMO=1 a memo is required even without ZPV_STORE.
//   ZPV_MCP_LOG            one JSON line per call (decrypted memos and amounts), written with mode 0600.
import { appendFileSync, closeSync, fchmodSync, openSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SetupRequiredError, verify, verifyNull402Settlement, VerifyError } from '@zpv/sdk';
import { SqliteStore } from '@zpv/gateway';

function log(tool: string, args: unknown, isError: boolean, result: unknown) {
  const f = process.env.ZPV_MCP_LOG;
  if (!f) return;
  const fd = openSync(f, 'a', 0o600);
  try {
    fchmodSync(fd, 0o600); // also tightens a file that existed before
    appendFileSync(fd, JSON.stringify({ at: new Date().toISOString(), tool, args, isError, result }) + '\n');
  } finally {
    closeSync(fd);
  }
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

function minConfFloor(): number {
  const v = process.env.ZPV_MCP_MIN_CONF?.trim();
  if (!v) return 1;
  if (!/^\d+$/.test(v)) throw new SetupRequiredError('ZPV_MCP_MIN_CONF', `a whole number, got ${v}`);
  return Number(v);
}

let store: SqliteStore | undefined;
const singleUse = () => {
  const f = process.env.ZPV_STORE;
  if (!f) return undefined;
  store ??= new SqliteStore(f);
  return store;
};

export function createServer(): McpServer {
  const server = new McpServer({ name: 'zec-payment-verify', version: '0.1.0' });
  // With ZPV_STORE the zcash tool writes: a paid answer consumes the payment, so it is not read-only, and a
  // client that auto-approves read-only tools must not run it on a "just checking" call.
  const consumes = Boolean(process.env.ZPV_STORE);

  server.registerTool(
    'verify_zcash_payment',
    {
      title: consumes ? 'Accept a shielded Zcash payment to the merchant (single use)' : 'Check a shielded Zcash payment to the merchant',
      description:
        (consumes ? 'This server runs with ZPV_STORE: a paid answer consumes the payment (its memo and txid are marked used), so call it only when you are about to deliver. ' : '') +
        'Did transaction `txid` pay the merchant at least `amount_zat` zatoshis with memo `memo`, with at least `min_conf` confirmations and no transparent part? Checked live on Zcash testnet with the merchant’s incoming viewing key. Returns ok, verdict (paid, refused, or unverified when ZPV_LWD_URLS lists several lightwalletd endpoints and they disagree or too few answer), reasons (TX_NOT_FOUND, NO_OUTPUT_TO_KEY, MEMO_MISMATCH, AMOUNT_TOO_LOW, NOT_CONFIRMED, TRANSPARENT_PART, UNVERIFIED_DISAGREEMENT, UNVERIFIED_QUORUM, ALREADY_USED) and what the key saw. ' +
        'Replay: unless the server runs with ZPV_STORE (single_use true in the answer), a check does not mark a payment as used: the same txid passes every time it is asked, and without a memo any past payment to the merchant passes, so record the txids you accepted and always pass the invoice memo. With ZPV_STORE each payment is accepted once and a second check answers ALREADY_USED. min_conf cannot go below the server’s floor (ZPV_MCP_MIN_CONF, default 1).',
      inputSchema: {
        txid: z.string().regex(/^[0-9a-fA-F]{64}$/),
        amount_zat: z.number().int().nonnegative(),
        memo: z.string().max(512).optional(),
        min_conf: z.number().int().nonnegative().optional(),
      },
      annotations: consumes ? { readOnlyHint: false, destructiveHint: false, idempotentHint: false } : { readOnlyHint: true },
    },
    (a) =>
      run('verify_zcash_payment', a, async () => {
        const uivk = process.env.ZPV_MERCHANT_UIVK;
        if (!uivk) throw new SetupRequiredError('ZPV_MERCHANT_UIVK');
        const minConf = Math.max(a.min_conf ?? 0, minConfFloor());
        const s = singleUse();
        if ((s || process.env.ZPV_MCP_REQUIRE_MEMO === '1') && !a.memo) {
          throw new VerifyError(`memo is required: ${s ? 'with ZPV_STORE each payment is accepted once, by its invoice memo and txid' : 'ZPV_MCP_REQUIRE_MEMO is set'}`);
        }
        const txid = a.txid.toLowerCase();
        const shape = (r: Awaited<ReturnType<typeof verify>> & { rail: 'zcash' }) => ({
          ok: r.ok,
          verdict: r.verdict,
          reasons: r.reasons,
          paid_zat: r.paidZat,
          height: r.report?.height ?? null,
          confirmations: r.report?.confirmations ?? null,
          outputs: r.report?.outputs ?? [],
          transparent: r.report?.pools.transparent ?? null,
          lightwalletd: r.provenance.lightwalletd,
          min_conf: minConf,
          single_use: Boolean(s),
          ...(r.crossCheck ? { cross_check: r.crossCheck } : {}),
        });
        const check = () => verify({ rail: 'zcash', uivk, txid, amountZat: a.amount_zat, memo: a.memo, minConf });
        if (!s) return shape(await check());

        const claim = s.claim(a.memo!, txid, Date.now(), 5 * 60_000);
        if (!claim.ok) {
          return { ok: false, verdict: 'refused', reasons: [claim.why === 'used' ? 'ALREADY_USED' : 'BEING_CHECKED'], paid_zat: 0, min_conf: minConf, single_use: true };
        }
        let r;
        try {
          r = await check();
        } catch (e) {
          s.release(a.memo!, txid, claim.token);
          throw e;
        }
        if (!r.ok) {
          s.release(a.memo!, txid, claim.token);
          return shape(r);
        }
        if (!s.settle(a.memo!, txid, claim.token)) return { ...shape(r), ok: false, verdict: 'refused', reasons: ['ALREADY_USED'] };
        return shape(r);
      }),
  );

  server.registerTool(
    'verify_null402_settlement',
    {
      title: 'Was this null-402 settlement on Avalanche Fuji a payment to me?',
      description:
        'Reads a mined null-402 settle() transaction and its receipt on Fuji. A reverted or pending settle() paid nobody and is never ok (SETTLE_REVERTED, SETTLE_PENDING; verdict unsettled). A successful one is ok (verdict paid, settled true) when its proof is valid on the deployed verifier, its Merkle root is known to the pool, its nullifier is spent (by this settlement), the proof pays expect_pay_to the amount expect_amount, and the pool paid expect_recipient; otherwise verdict refused with PAY_TO_MISMATCH, AMOUNT_MISMATCH, RECIPIENT_MISMATCH, or UNBOUND when any of the three is missing. expect_recipient (your EVM address) is required for ok: the pool does not bind settle()’s recipient to the proof, so a proof naming your payee and amount can be settled to someone else. proof_check answers a different question, whether the proof could still be settled to you: once settled it is always NULLIFIER_SPENT. This tool does not remember settlements you already accepted: record the settle hashes yourself.',
      inputSchema: {
        settle_tx: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        expect_pay_to: z.string().regex(/^\d+$/).optional(),
        expect_amount: z.string().regex(/^\d+$/).optional(),
        expect_recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().describe('The EVM address the pool must have paid. Required for ok (without it the answer is UNBOUND).'),
      },
      annotations: { readOnlyHint: true },
    },
    (a) =>
      run('verify_null402_settlement', a, async () => {
        const r = await verifyNull402Settlement(a.settle_tx as `0x${string}`, { payTo: a.expect_pay_to, requiredAmount: a.expect_amount, recipient: a.expect_recipient });
        return {
          ok: r.ok,
          verdict: r.verdict,
          settled: r.settled,
          status: r.status,
          reasons: r.reasons,
          checks: r.checks,
          signals: r.signals,
          recipient: r.recipient,
          settled_in_block: r.settledInBlock ?? null,
          checked_at_block: r.checkedAtBlock ?? null,
          proof_check: r.proofCheck,
        };
      }),
  );
  return server;
}
