import { useState } from 'react';
import { proofFromSettleTx, verifyNull402, NULL402_FUJI, type Null402Result } from '@zpv/sdk/null402';
import fx from '@fixtures/testnet.json';

const API = import.meta.env.VITE_ZPV_API ?? 'http://127.0.0.1:8403';
const ZEC_TX = 'https://testnet.zcashexplorer.app/transactions/';

type ZcashResult = {
  ok: boolean;
  reasons: string[];
  paidZat: number;
  report: { txid: string; found: boolean; height: number | null; confirmations: number; tip: number; outputs: { pool: string; value: number; memo: string | null; memo_binary: boolean }[]; pools: Record<string, boolean> };
  provenance: { lightwalletd: string; tip: number; checkedAt: string };
};
type Outcome = { kind: 'zcash'; r: ZcashResult } | { kind: 'null402'; r: Null402Result; settledIn: string } | { kind: 'error'; message: string; setup?: boolean };

const WHY: Record<string, string> = {
  TX_NOT_FOUND: 'Lightwalletd does not know this transaction.',
  NO_OUTPUT_TO_KEY: 'The transaction exists, but nothing in it is addressed to this viewing key.',
  MEMO_MISMATCH: 'Payments to this key exist in the transaction, none with the expected memo.',
  AMOUNT_TOO_LOW: 'What matches the memo adds up to less than the amount.',
  NOT_CONFIRMED: 'Not mined deep enough yet.',
  TRANSPARENT_PART: 'The transaction has a transparent input or output, which exposes part of it.',
  BAD_PROOF: 'The deployed verifier rejects this proof for these public signals.',
  ROOT_UNKNOWN: 'The proof is about a Merkle tree the pool never registered.',
  NULLIFIER_SPENT: 'This note already paid: the pool marked its nullifier spent.',
  PAY_TO_MISMATCH: 'The proof pays someone else.',
  AMOUNT_MISMATCH: 'The proof authorises a different amount.',
  CONTEXT_MISMATCH: 'The proof is bound to a different request.',
};

const short = (s: string, a = 8, b = 6) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
const taz = (z: number) => `${(z / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 })} TAZ`;

const PRESETS = [
  { label: 'x402 payment (published merchant key)', zcash: { uivk: fx.x402.uivk, txid: fx.x402.txid, amount: String(fx.x402.amountZat), memo: fx.x402.memo, minConf: '1' } },
  { label: 'Same payment, wrong invoice memo', zcash: { uivk: fx.x402.uivk, txid: fx.x402.txid, amount: String(fx.x402.amountZat), memo: 'x402z-another-invoice', minConf: '1' } },
  { label: 'Auction deposit, checked with the x402 key', zcash: { uivk: fx.x402.uivk, txid: fx.auction.deposit.txid, amount: '1', memo: '', minConf: '1' } },
];
const SETTLE = '0x8596f52de2d8c15680c96a0fa25b1bb5073324155f586203507cddf92f5ca593';

function Stamp({ ok, pending }: { ok: boolean; pending?: boolean }) {
  return <div className={`stamp ${ok ? 'stamp-ok' : pending ? 'stamp-pending' : 'stamp-no'}`}>{ok ? 'Paid' : pending ? 'Pending' : 'Not paid'}</div>;
}

function Reasons({ reasons }: { reasons: string[] }) {
  if (!reasons.length) return null;
  return (
    <ul className="reasons">
      {reasons.map((x) => (
        <li key={x}>
          <code>{x}</code> {WHY[x] ?? ''}
        </li>
      ))}
    </ul>
  );
}

function ZcashView({ r }: { r: ZcashResult }) {
  const pendingOnly = r.reasons.length === 1 && r.reasons[0] === 'NOT_CONFIRMED';
  return (
    <div className="result">
      <Stamp ok={r.ok} pending={pendingOnly} />
      <div className="result-body">
        <p className="lead">
          {r.ok ? `${taz(r.paidZat)} received with the expected memo.` : r.report.found ? `Counted ${taz(r.paidZat)}.` : 'No such transaction.'}
        </p>
        <Reasons reasons={r.reasons} />
        {r.report.found && (
          <>
            <h3>What the viewing key sees</h3>
            {r.report.outputs.length === 0 ? (
              <p className="muted">No output decrypts to this key.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Pool</th>
                      <th scope="col">Amount</th>
                      <th scope="col">Memo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.report.outputs.map((o, i) => (
                      <tr key={i}>
                        <td>{o.pool}</td>
                        <td>{taz(o.value)}</td>
                        <td>{o.memo ? <code>{o.memo}</code> : <span className="muted">{o.memo_binary ? 'binary' : 'none'}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        <h3>Provenance</h3>
        <dl className="prov">
          <dt>Transaction</dt>
          <dd>
            <a href={ZEC_TX + r.report.txid} target="_blank" rel="noreferrer">
              <code>{short(r.report.txid)}</code>
            </a>
          </dd>
          <dt>Mined</dt>
          <dd>{r.report.height ? `block ${r.report.height.toLocaleString()}, ${r.report.confirmations.toLocaleString()} confirmations` : r.report.found ? 'in the mempool' : '—'}</dd>
          <dt>Pools in the tx</dt>
          <dd>{Object.entries(r.report.pools).filter(([, v]) => v).map(([k]) => k).join(', ') || '—'}</dd>
          <dt>Checked via</dt>
          <dd>
            {r.provenance.lightwalletd} at tip {r.provenance.tip.toLocaleString()}, {new Date(r.provenance.checkedAt).toLocaleTimeString()}
          </dd>
        </dl>
      </div>
    </div>
  );
}

function Null402View({ r, settledIn }: { r: Null402Result; settledIn: string }) {
  return (
    <div className="result">
      <Stamp ok={r.ok} />
      <div className="result-body">
        <p className="lead">{r.ok ? 'The proof is valid, its tree is the pool’s, and the note is unspent.' : 'This proof should not be accepted as a new payment.'}</p>
        <Reasons reasons={r.reasons} />
        <h3>Checks on Avalanche Fuji (read-only calls)</h3>
        <ul className="checks">
          <li className={r.checks.proofValid ? 'yes' : 'no'}>verifier.verifyProof: {String(r.checks.proofValid)}</li>
          <li className={r.checks.rootKnown ? 'yes' : 'no'}>pool.knownRoot(root): {String(r.checks.rootKnown)}</li>
          <li className={r.checks.nullifierSpent ? 'no' : 'yes'}>pool.spent(nullifier): {String(r.checks.nullifierSpent)}</li>
        </ul>
        <h3>Provenance</h3>
        <dl className="prov">
          <dt>Proof from</dt>
          <dd>settle() in Fuji block {Number(settledIn).toLocaleString()}</dd>
          <dt>Amount</dt>
          <dd>{r.signals.requiredAmount}</dd>
          <dt>Verifier</dt>
          <dd>
            <a href={`${NULL402_FUJI.explorer}/address/${r.provenance.verifier}`} target="_blank" rel="noreferrer">
              <code>{short(r.provenance.verifier, 8, 4)}</code>
            </a>
          </dd>
          <dt>Checked at</dt>
          <dd>Fuji block {Number(r.provenance.blockNumber).toLocaleString()} via {new URL(r.provenance.rpc).host}</dd>
        </dl>
      </div>
    </div>
  );
}

export function App() {
  const [rail, setRail] = useState<'zcash' | 'null402'>('zcash');
  const [z, setZ] = useState(PRESETS[0].zcash);
  const [settleTx, setSettleTx] = useState(SETTLE);
  const [tamper, setTamper] = useState(false);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<Outcome | null>(null);

  async function check(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setOut(null);
    try {
      if (rail === 'zcash') {
        let res: Response;
        try {
          res = await fetch(`${API}/api/verify`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rail: 'zcash', uivk: z.uivk.trim(), txid: z.txid.trim(), amountZat: Number(z.amount), memo: z.memo || undefined, minConf: Number(z.minConf || 1) }),
          });
        } catch {
          setOut({ kind: 'error', setup: true, message: `Setup required: the verify API is not reachable at ${API}. Start it with: pnpm --filter @zpv/gateway api` });
          return;
        }
        const body = await res.json();
        if (!res.ok) setOut({ kind: 'error', message: body.error ?? `HTTP ${res.status}`, setup: res.status === 503 });
        else setOut({ kind: 'zcash', r: body });
      } else {
        const s = await proofFromSettleTx(settleTx.trim() as `0x${string}`);
        const pub = [...s.publicSignals];
        if (tamper) pub[3] = (BigInt(pub[3]) * 10n).toString();
        setOut({ kind: 'null402', r: await verifyNull402({ rail: 'null402', proof: s.proof, publicSignals: pub }), settledIn: s.blockNumber });
      }
    } catch (err) {
      setOut({ kind: 'error', message: (err as Error).message.split('\n')[0] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="top">
        <span className="brand">zpay-verify</span>
        <span className="muted small">Zcash testnet · Avalanche Fuji</span>
      </header>
      <main>
        <section className="intro">
          <h1>Was I paid?</h1>
          <p className="lede">
            Check a shielded Zcash payment with only your incoming viewing key, or a null-402 payment proof against the contracts on Fuji. Every answer comes from a live
            check, with where it came from.
          </p>
        </section>

        <form className="desk" onSubmit={check}>
          <div className="tabs" role="tablist" aria-label="Payment rail">
            <button type="button" role="tab" aria-selected={rail === 'zcash'} className={rail === 'zcash' ? 'tab on' : 'tab'} onClick={() => { setRail('zcash'); setOut(null); }}>
              Zcash payment
            </button>
            <button type="button" role="tab" aria-selected={rail === 'null402'} className={rail === 'null402' ? 'tab on' : 'tab'} onClick={() => { setRail('null402'); setOut(null); }}>
              null-402 proof
            </button>
          </div>

          {rail === 'zcash' ? (
            <div className="fields">
              <label className="wide">
                Try a real one
                <select onChange={(e) => { setZ(PRESETS[Number(e.target.value)].zcash); setOut(null); }} defaultValue="0">
                  {PRESETS.map((p, i) => (
                    <option key={p.label} value={i}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="wide">
                Incoming viewing key
                <input value={z.uivk} onChange={(e) => setZ({ ...z, uivk: e.target.value })} placeholder="uivktest1…" spellCheck={false} autoComplete="off" required />
              </label>
              <label className="wide">
                Transaction id
                <input value={z.txid} onChange={(e) => setZ({ ...z, txid: e.target.value })} placeholder="64 hex characters" spellCheck={false} pattern="[0-9a-fA-F]{64}" required />
              </label>
              <label>
                Amount (zatoshi)
                <input value={z.amount} onChange={(e) => setZ({ ...z, amount: e.target.value })} inputMode="numeric" pattern="\d+" required />
              </label>
              <label>
                Memo
                <input value={z.memo} onChange={(e) => setZ({ ...z, memo: e.target.value })} placeholder="any memo" spellCheck={false} />
              </label>
              <label>
                Confirmations
                <input value={z.minConf} onChange={(e) => setZ({ ...z, minConf: e.target.value })} inputMode="numeric" pattern="\d+" />
              </label>
            </div>
          ) : (
            <div className="fields">
              <label className="wide">
                null-402 settle() transaction on Fuji
                <input value={settleTx} onChange={(e) => setSettleTx(e.target.value)} spellCheck={false} pattern="0x[0-9a-fA-F]{64}" required />
              </label>
              <label className="check">
                <input type="checkbox" checked={tamper} onChange={(e) => setTamper(e.target.checked)} /> Claim 10× the amount the proof authorises
              </label>
            </div>
          )}
          <button className="go" disabled={busy}>
            {busy ? 'Checking…' : 'Check payment'}
          </button>
        </form>

        <section aria-live="polite" className="outcome">
          {!out && !busy && <p className="muted empty">The verdict appears here.</p>}
          {out?.kind === 'error' && <p className={out.setup ? 'setup' : 'bad'}>{out.message}</p>}
          {out?.kind === 'zcash' && <ZcashView r={out.r} />}
          {out?.kind === 'null402' && <Null402View r={out.r} settledIn={out.settledIn} />}
        </section>
      </main>
      <footer>MIT · Copyright (c) 2026 Nivesh Gajengi · testnet only · the viewing key is sent only to your local verify API</footer>
    </>
  );
}
