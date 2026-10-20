import { useEffect, useRef, useState } from 'react';
import { proofFromSettleTx, verifyNull402, NULL402_FUJI, type Null402Result } from '@zpv/sdk/null402';
import fx from '@fixtures/testnet.json';

const API = import.meta.env.VITE_ZPV_API ?? 'http://127.0.0.1:8403';
const API_FROM_ENV = Boolean(import.meta.env.VITE_ZPV_API);
const ZEC_TX = 'https://testnet.zcashexplorer.app/transactions/';
const REPO = 'https://github.com/nickthelegend/zec-payment-verify-sdk';

type ZcashResult = {
  ok: boolean;
  reasons: string[];
  paidZat: number;
  report: { txid: string; found: boolean; height: number | null; confirmations: number; tip: number; outputs: { pool: string; value: number; memo: string | null; memo_binary: boolean }[]; pools: Record<string, boolean> };
  provenance: { lightwalletd: string; tip: number; checkedAt: string };
};
type Outcome = { kind: 'zcash'; r: ZcashResult } | { kind: 'null402'; r: Null402Result; settledIn: string } | { kind: 'error'; message: string; setup?: boolean };

/** One line in this session's check log (kept in memory only, never stored). */
type LogEntry = { id: number; rail: 'zcash' | 'null402'; status: 'paid' | 'pending' | 'not-paid' | 'error' | 'setup'; ref: string; reasons: string[]; at: string };

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
const DECIMAL = (1.5).toLocaleString().charAt(1);

const PRESETS = [
  { label: 'x402 payment (published merchant key)', zcash: { uivk: fx.x402.uivk, txid: fx.x402.txid, amount: String(fx.x402.amountZat), memo: fx.x402.memo, minConf: '1' } },
  { label: 'Same payment, wrong invoice memo', zcash: { uivk: fx.x402.uivk, txid: fx.x402.txid, amount: String(fx.x402.amountZat), memo: 'x402z-another-invoice', minConf: '1' } },
  { label: 'Auction deposit, checked with the x402 key', zcash: { uivk: fx.x402.uivk, txid: fx.auction.deposit.txid, amount: '1', memo: '', minConf: '1' } },
];
const SETTLE = '0x8596f52de2d8c15680c96a0fa25b1bb5073324155f586203507cddf92f5ca593';
const UNREACHABLE = 'Setup required: the verify API is not reachable';

/** Zatoshi as TAZ, with the decimals faded like a balance. */
function Amount({ zat }: { zat: number }) {
  const s = (zat / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 });
  const i = s.indexOf(DECIMAL);
  return (
    <span className="amount">
      {i === -1 ? s : s.slice(0, i)}
      {i !== -1 && <span className="amount-frac">{s.slice(i)}</span>}
      <span className="amount-unit">TAZ</span>
    </span>
  );
}

function Seal({ size = 32 }: { size?: number }) {
  return (
    <svg className="seal" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="#e2401f" />
      <rect x="5" y="5" width="22" height="22" rx="4" fill="none" stroke="#fdebe5" strokeWidth="1.6" />
      <path d="M11.5 10v12M20.5 10v12M11.5 16h9" stroke="#fdebe5" strokeWidth="2.6" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function Stamp({ ok, pending }: { ok: boolean; pending?: boolean }) {
  return <div className={`stamp ${ok ? 'stamp-ok' : pending ? 'stamp-pending' : 'stamp-no'}`}>{ok ? 'Paid' : pending ? 'Pending' : 'Not paid'}</div>;
}

function Reasons({ reasons }: { reasons: string[] }) {
  if (!reasons.length) return null;
  return (
    <ul className="reasons" aria-label="Reasons">
      {reasons.map((x) => (
        <li key={x}>
          <code className={`pill ${x === 'NOT_CONFIRMED' ? 'pill-wait' : 'pill-no'}`}>{x}</code>
          <span>{WHY[x] ?? ''}</span>
        </li>
      ))}
    </ul>
  );
}

function ZcashView({ r }: { r: ZcashResult }) {
  const pendingOnly = r.reasons.length === 1 && r.reasons[0] === 'NOT_CONFIRMED';
  return (
    <div className="result">
      <div className="result-head">
        <Stamp ok={r.ok} pending={pendingOnly} />
        <span className="pill pill-muted">Zcash testnet</span>
      </div>
      <div className="figure">
        <span className="figure-label">{r.ok ? 'Received' : 'Counted toward this check'}</span>
        {r.report.found ? <Amount zat={r.paidZat} /> : <span className="amount amount-none">—</span>}
      </div>
      <p className="lead">
        {r.ok ? `${taz(r.paidZat)} received with the expected memo.` : r.report.found ? `Counted ${taz(r.paidZat)}.` : 'No such transaction.'}
      </p>
      <Reasons reasons={r.reasons} />
      {r.report.found && (
        <>
          <h3>What the viewing key sees</h3>
          {r.report.outputs.length === 0 ? (
            <p className="muted note">No output decrypts to this key.</p>
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
                      <td>
                        <span className="pill pill-muted">{o.pool}</span>
                      </td>
                      <td className="num">{taz(o.value)}</td>
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
        <div>
          <dt>Transaction</dt>
          <dd>
            <a href={ZEC_TX + r.report.txid} target="_blank" rel="noreferrer">
              <code>{short(r.report.txid)}</code>
              <span className="ext" aria-hidden="true">↗</span>
            </a>
          </dd>
        </div>
        <div>
          <dt>Mined</dt>
          <dd>{r.report.height ? `block ${r.report.height.toLocaleString()}, ${r.report.confirmations.toLocaleString()} confirmations` : r.report.found ? 'in the mempool' : '—'}</dd>
        </div>
        <div>
          <dt>Pools in the tx</dt>
          <dd>{Object.entries(r.report.pools).filter(([, v]) => v).map(([k]) => k).join(', ') || '—'}</dd>
        </div>
        <div>
          <dt>Checked via</dt>
          <dd>
            {r.provenance.lightwalletd} at tip {r.provenance.tip.toLocaleString()}, {new Date(r.provenance.checkedAt).toLocaleTimeString()}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function Null402View({ r, settledIn }: { r: Null402Result; settledIn: string }) {
  return (
    <div className="result">
      <div className="result-head">
        <Stamp ok={r.ok} />
        <span className="pill pill-muted">Avalanche Fuji</span>
      </div>
      <p className="lead">{r.ok ? 'The proof is valid, its tree is the pool’s, and the note is unspent.' : 'This proof should not be accepted as a new payment.'}</p>
      <Reasons reasons={r.reasons} />
      <h3>Checks on Avalanche Fuji (read-only calls)</h3>
      <ul className="checks">
        <li>
          <code>verifier.verifyProof</code>
          <span className={`pill ${r.checks.proofValid ? 'pill-ok' : 'pill-no'}`}>{String(r.checks.proofValid)}</span>
        </li>
        <li>
          <code>pool.knownRoot(root)</code>
          <span className={`pill ${r.checks.rootKnown ? 'pill-ok' : 'pill-no'}`}>{String(r.checks.rootKnown)}</span>
        </li>
        <li>
          <code>pool.spent(nullifier)</code>
          <span className={`pill ${r.checks.nullifierSpent ? 'pill-no' : 'pill-ok'}`}>{String(r.checks.nullifierSpent)}</span>
        </li>
      </ul>
      <h3>Provenance</h3>
      <dl className="prov">
        <div>
          <dt>Proof from</dt>
          <dd>settle() in Fuji block {Number(settledIn).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Amount</dt>
          <dd>{r.signals.requiredAmount}</dd>
        </div>
        <div>
          <dt>Verifier</dt>
          <dd>
            <a href={`${NULL402_FUJI.explorer}/address/${r.provenance.verifier}`} target="_blank" rel="noreferrer">
              <code>{short(r.provenance.verifier, 8, 4)}</code>
              <span className="ext" aria-hidden="true">↗</span>
            </a>
          </dd>
        </div>
        <div>
          <dt>Checked at</dt>
          <dd>Fuji block {Number(r.provenance.blockNumber).toLocaleString()} via {new URL(r.provenance.rpc).host}</dd>
        </div>
      </dl>
    </div>
  );
}

const STATUS_LABEL: Record<LogEntry['status'], string> = { paid: 'Paid', pending: 'Pending', 'not-paid': 'Not paid', error: 'Error', setup: 'Setup required' };
const STATUS_PILL: Record<LogEntry['status'], string> = { paid: 'pill-ok', pending: 'pill-wait', 'not-paid': 'pill-no', error: 'pill-no', setup: 'pill-wait' };
const refLink = (rail: LogEntry['rail'], ref: string) => (rail === 'zcash' ? ZEC_TX + ref : `${NULL402_FUJI.explorer}/tx/${ref}`);

export function App() {
  const [rail, setRail] = useState<'zcash' | 'null402'>('zcash');
  const [z, setZ] = useState(PRESETS[0].zcash);
  const [settleTx, setSettleTx] = useState(SETTLE);
  const [tamper, setTamper] = useState(false);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<Outcome | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const logId = useRef(0);

  // Record every finished check in this session's log, exactly as the verdict panel shows it.
  useEffect(() => {
    if (!out) return;
    const ref = out.kind === 'zcash' ? out.r.report.txid : out.kind === 'null402' ? settleTx.trim() : rail === 'zcash' ? z.txid.trim() : settleTx.trim();
    const entryRail = out.kind === 'error' ? rail : out.kind;
    let status: LogEntry['status'];
    if (out.kind === 'error') status = out.setup ? 'setup' : 'error';
    else if (out.r.ok) status = 'paid';
    else if (out.kind === 'zcash' && out.r.reasons.length === 1 && out.r.reasons[0] === 'NOT_CONFIRMED') status = 'pending';
    else status = 'not-paid';
    const reasons = out.kind === 'error' ? [] : out.r.reasons;
    logId.current += 1;
    const entry: LogEntry = { id: logId.current, rail: entryRail, status, ref, reasons, at: new Date().toLocaleTimeString() };
    setLog((l) => [entry, ...l].slice(0, 8));
  }, [out]);

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

  const amountIsZat = /^\d+$/.test(z.amount);

  return (
    <div className="page">
      <a className="skip" href="#check">
        Skip to the check
      </a>
      <div className="frame">
        <header className="bar">
          <a className="brand" href="#top" aria-label="Hanko, home">
            <Seal />
            <span className="wordmark">Hanko</span>
          </a>
          <nav className="nav" aria-label="Sections">
            <a href="#check">Check</a>
            <a href="#verdict">Verdict</a>
            <a href="#history">History</a>
            <a href="#evidence">Evidence</a>
          </nav>
          <div className="bar-end">
            <span className="net">
              <span className="dot" aria-hidden="true" />
              <span className="net-long">Zcash testnet · Fuji</span>
              <span className="net-short">Testnet</span>
            </span>
            <a className="gh" href={REPO} target="_blank" rel="noreferrer">
              GitHub <span aria-hidden="true">↗</span>
            </a>
          </div>
        </header>

        <main className="grid" id="top">
          <div className="col col-main">
            <section className="hero">
              <p className="eyebrow">判子 · shielded payment checks</p>
              <h1>Was I paid?</h1>
              <p className="lede">
                Check a shielded Zcash payment with only your incoming viewing key, or a null-402 payment proof against the contracts on Fuji. Every answer comes from a live
                check, with where it came from.
              </p>
            </section>

            <section className="panel verdict" id="verdict" aria-live="polite" aria-busy={busy}>
              <div className="panel-head">
                <h2>Verdict</h2>
                {out && out.kind !== 'error' && <span className="muted small">Live check</span>}
              </div>
              {!out && !busy && (
                <div className="state empty">
                  <div className="ghost-stamp" aria-hidden="true">
                    <Seal size={40} />
                  </div>
                  <p className="state-title">No verdict yet</p>
                  <p className="muted">The verdict appears here.</p>
                </div>
              )}
              {busy && (
                <div className="state loading">
                  <span className="spinner" aria-hidden="true" />
                  <p className="state-title">Checking…</p>
                  <p className="muted">{rail === 'zcash' ? `Asking the verify API at ${API}.` : 'Reading the null-402 contracts on Avalanche Fuji.'}</p>
                </div>
              )}
              {out?.kind === 'error' &&
                (out.setup ? (
                  <div className="state setup" role="alert">
                    <span className="pill pill-wait">{out.message.startsWith(UNREACHABLE) ? 'Setup required: VITE_ZPV_API' : 'Setup required'}</span>
                    <p className="state-msg">{out.message}</p>
                    {out.message.startsWith(UNREACHABLE) && (
                      <p className="muted small">
                        Point the dashboard at your verify API with <code>VITE_ZPV_API</code> in <code>packages/dashboard/.env</code>
                        {API_FROM_ENV ? '' : ` (unset, so it uses ${API})`}.
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="state bad" role="alert">
                    <span className="pill pill-no">Check failed</span>
                    <p className="state-msg">{out.message}</p>
                  </div>
                ))}
              {out?.kind === 'zcash' && <ZcashView r={out.r} />}
              {out?.kind === 'null402' && <Null402View r={out.r} settledIn={out.settledIn} />}
            </section>

            <section className="panel" id="evidence">
              <div className="panel-head">
                <h2>Real testnet payments</h2>
                <span className="muted small">Explorer links</span>
              </div>
              <ul className="rows">
                <li className="row">
                  <div className="row-main">
                    <span className="row-title">x402 merchant payment</span>
                    <a className="mono-link" href={ZEC_TX + fx.x402.txid} target="_blank" rel="noreferrer">
                      <code>{short(fx.x402.txid)}</code>
                      <span className="ext" aria-hidden="true">↗</span>
                    </a>
                  </div>
                  <span className="pill pill-muted">Zcash testnet</span>
                </li>
                <li className="row">
                  <div className="row-main">
                    <span className="row-title">Sealed-bid auction deposit</span>
                    <a className="mono-link" href={ZEC_TX + fx.auction.deposit.txid} target="_blank" rel="noreferrer">
                      <code>{short(fx.auction.deposit.txid)}</code>
                      <span className="ext" aria-hidden="true">↗</span>
                    </a>
                  </div>
                  <span className="pill pill-muted">Zcash testnet</span>
                </li>
                <li className="row">
                  <div className="row-main">
                    <span className="row-title">null-402 settle()</span>
                    <a className="mono-link" href={`${NULL402_FUJI.explorer}/tx/${SETTLE}`} target="_blank" rel="noreferrer">
                      <code>{short(SETTLE)}</code>
                      <span className="ext" aria-hidden="true">↗</span>
                    </a>
                  </div>
                  <span className="pill pill-muted">Fuji</span>
                </li>
              </ul>
            </section>
          </div>

          <div className="col col-side">
            <form className="panel send" id="check" onSubmit={check}>
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
                  <label className="card">
                    <span className="card-label">Try a real one</span>
                    <select onChange={(e) => { setZ(PRESETS[Number(e.target.value)].zcash); setOut(null); }} defaultValue="0">
                      {PRESETS.map((p, i) => (
                        <option key={p.label} value={i}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="card">
                    <span className="card-label">Incoming viewing key</span>
                    <input className="mono" value={z.uivk} onChange={(e) => setZ({ ...z, uivk: e.target.value })} placeholder="uivktest1…" spellCheck={false} autoComplete="off" required />
                  </label>
                  <label className="card">
                    <span className="card-label">Transaction id</span>
                    <input className="mono" value={z.txid} onChange={(e) => setZ({ ...z, txid: e.target.value })} placeholder="64 hex characters" spellCheck={false} pattern="[0-9a-fA-F]{64}" required />
                  </label>
                  <label className="card card-amount">
                    <span className="card-row">
                      <span className="card-label">Expected amount</span>
                      <span className="card-label">zatoshi</span>
                    </span>
                    <input className="big" value={z.amount} onChange={(e) => setZ({ ...z, amount: e.target.value })} inputMode="numeric" pattern="\d+" required />
                    <span className="card-row">
                      <span className="card-label">At least</span>
                      <span className="conv">{amountIsZat ? taz(Number(z.amount)) : 'Whole zatoshi only'}</span>
                    </span>
                  </label>
                  <div className="pair">
                    <label className="card">
                      <span className="card-label">Memo</span>
                      <input className="mono" value={z.memo} onChange={(e) => setZ({ ...z, memo: e.target.value })} placeholder="any memo" spellCheck={false} />
                    </label>
                    <label className="card card-conf">
                      <span className="card-label">Confirmations</span>
                      <input value={z.minConf} onChange={(e) => setZ({ ...z, minConf: e.target.value })} inputMode="numeric" pattern="\d+" />
                    </label>
                  </div>
                </div>
              ) : (
                <div className="fields">
                  <label className="card">
                    <span className="card-label">null-402 settle() transaction on Fuji</span>
                    <input className="mono" value={settleTx} onChange={(e) => setSettleTx(e.target.value)} spellCheck={false} pattern="0x[0-9a-fA-F]{64}" required />
                  </label>
                  <label className="toggle">
                    <input type="checkbox" checked={tamper} onChange={(e) => setTamper(e.target.checked)} />
                    <span>Claim 10× the amount the proof authorises</span>
                  </label>
                  <dl className="contracts">
                    <div>
                      <dt>Verifier</dt>
                      <dd>
                        <a href={`${NULL402_FUJI.explorer}/address/${NULL402_FUJI.verifier}`} target="_blank" rel="noreferrer">
                          <code>{short(NULL402_FUJI.verifier, 8, 4)}</code>
                          <span className="ext" aria-hidden="true">↗</span>
                        </a>
                      </dd>
                    </div>
                    <div>
                      <dt>Pool</dt>
                      <dd>
                        <a href={`${NULL402_FUJI.explorer}/address/${NULL402_FUJI.pool}`} target="_blank" rel="noreferrer">
                          <code>{short(NULL402_FUJI.pool, 8, 4)}</code>
                          <span className="ext" aria-hidden="true">↗</span>
                        </a>
                      </dd>
                    </div>
                  </dl>
                </div>
              )}
              <button className="go" disabled={busy}>
                {busy ? 'Checking…' : 'Check payment'}
              </button>
              <p className="api-note">
                {rail === 'zcash' ? (
                  <>
                    Verify API <code>{API}</code>
                    {API_FROM_ENV ? '' : ' (default; set VITE_ZPV_API to change it)'}
                  </>
                ) : (
                  <>Read-only calls straight to Fuji from this browser</>
                )}
              </p>
            </form>

            <section className="panel" id="history">
              <div className="panel-head">
                <h2>This session</h2>
                <span className="muted small">Not saved</span>
              </div>
              {log.length === 0 ? (
                <p className="muted note">No checks yet. Each one you run is listed here with its verdict and reasons.</p>
              ) : (
                <ul className="rows">
                  {log.map((e) => (
                    <li className="row" key={e.id}>
                      <div className="row-main">
                        <span className="row-title">
                          {e.rail === 'zcash' ? 'Zcash' : 'null-402'} · {e.at}
                        </span>
                        {/^(0x)?[0-9a-fA-F]{64}$/.test(e.ref) ? (
                          <a className="mono-link" href={refLink(e.rail, e.ref)} target="_blank" rel="noreferrer">
                            <code>{short(e.ref)}</code>
                            <span className="ext" aria-hidden="true">↗</span>
                          </a>
                        ) : (
                          <code className="muted">{e.ref ? short(e.ref) : '—'}</code>
                        )}
                        {e.reasons.length > 0 && (
                          <span className="row-reasons">
                            {e.reasons.map((x) => (
                              <code key={x} className="pill pill-quiet">
                                {x}
                              </code>
                            ))}
                          </span>
                        )}
                      </div>
                      <span className={`pill ${STATUS_PILL[e.status]}`}>{STATUS_LABEL[e.status]}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </main>
      </div>
      <footer className="foot">
        <span>
          <strong>Hanko</strong> · MIT · Copyright (c) 2026 Nivesh Gajengi
        </span>
        <span>testnet only · the viewing key is sent only to your local verify API</span>
      </footer>
    </div>
  );
}
