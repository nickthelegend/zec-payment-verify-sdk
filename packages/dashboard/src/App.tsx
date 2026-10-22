import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { proofFromSettleTx, verifyNull402, NULL402_FUJI, type Null402Result } from '@zpv/sdk/null402';
import fx from '@fixtures/testnet.json';

const API = import.meta.env.VITE_ZPV_API ?? 'http://127.0.0.1:8403';
const API_FROM_ENV = Boolean(import.meta.env.VITE_ZPV_API);
const ZEC_TX = 'https://testnet.zcashexplorer.app/transactions/';
const REPO = 'https://github.com/nickthelegend/zec-payment-verify-sdk';
const SETTLE = '0x8596f52de2d8c15680c96a0fa25b1bb5073324155f586203507cddf92f5ca593';

type EndpointAnswer = { lightwalletd: string; answered: boolean; inconsistent?: boolean; ok?: boolean; reasons?: string[]; height?: number | null; tip?: number; error?: string };
type ZcashResult = {
  rail: 'zcash';
  ok: boolean;
  verdict?: 'paid' | 'refused' | 'unverified';
  reasons: string[];
  paidZat: number;
  /** null when the lightwalletd endpoints disagreed or too few answered */
  report: { txid: string; found: boolean; height: number | null; confirmations: number; tip: number; outputs: { pool: string; value: number; memo: string | null; memo_binary: boolean }[]; pools: Record<string, boolean> } | null;
  provenance: { lightwalletd: string; tip: number; checkedAt: string };
  crossCheck?: { quorum: number; agreed: boolean; endpoints: EndpointAnswer[] };
};
type Outcome =
  | { kind: 'zcash'; r: ZcashResult; status: number; ms: number }
  | { kind: 'null402'; r: Null402Result; settledIn: string | null; ms: number }
  | { kind: 'error'; message: string; setup?: boolean; status?: number; body?: unknown };
type Rail = 'zcash' | 'null402';
type Verdict = 'paid' | 'pending' | 'not-paid' | 'unverified';
type LogEntry = { id: number; rail: Rail; status: Verdict | 'error' | 'setup'; ref: string; reasons: string[]; at: string };
type Health = 'checking' | 'up' | 'down';

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
  UNBOUND: 'No expected payee and amount were given, so nothing ties this proof to you.',
  UNVERIFIED_DISAGREEMENT: 'The lightwalletd endpoints gave different answers, so there is no verdict. Neither paid nor refused: retry, or check the endpoints.',
  UNVERIFIED_QUORUM: 'Too few lightwalletd endpoints answered to reach the quorum, so there is no verdict.',
};

const short = (s: string, a = 8, b = 6) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
const taz = (z: number) => `${(z / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 })} TAZ`;

const PRESETS = [
  { label: 'x402 payment', note: 'published merchant key', zcash: { uivk: fx.x402.uivk, txid: fx.x402.txid, amount: String(fx.x402.amountZat), memo: fx.x402.memo, minConf: '1' } },
  { label: 'Wrong invoice memo', note: 'same payment', zcash: { uivk: fx.x402.uivk, txid: fx.x402.txid, amount: String(fx.x402.amountZat), memo: 'x402z-another-invoice', minConf: '1' } },
  { label: 'Someone else’s payment', note: 'auction deposit, x402 key', zcash: { uivk: fx.x402.uivk, txid: fx.auction.deposit.txid, amount: '1', memo: '', minConf: '1' } },
];

function verdictOf(o: Outcome): Verdict | null {
  if (o.kind === 'error') return null;
  if (o.kind === 'zcash' && o.r.verdict === 'unverified') return 'unverified';
  if (o.r.ok) return 'paid';
  if (o.kind === 'zcash' && o.r.reasons.length === 1 && o.r.reasons[0] === 'NOT_CONFIRMED') return 'pending';
  return 'not-paid';
}

/* ---------- small pieces ---------- */

function SealMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="2" y="2" width="28" height="28" rx="5" fill="#e2401f" />
      <rect x="5.5" y="5.5" width="21" height="21" rx="3" fill="none" stroke="#fdebe5" strokeWidth="1.6" />
      <path d="M11.5 10v12M20.5 10v12M11.5 16h9" stroke="#fdebe5" strokeWidth="2.6" strokeLinecap="round" fill="none" />
    </svg>
  );
}

const STAMP_WORD: Record<Verdict, [string, string]> = { paid: ['PAID', 'VIEWING KEY'], pending: ['WAIT', 'UNCONFIRMED'], 'not-paid': ['UNPAID', 'SEE REASONS'], unverified: ['HOLD', 'NO CONSENSUS'] };
const VERDICT_WORD: Record<Verdict, string> = { paid: 'Paid', pending: 'Pending', 'not-paid': 'Not paid', unverified: 'Unverified' };

/** The seal that lands on a response. Keyed by the caller so each new verdict presses again. */
function Stamp({ v }: { v: Verdict }) {
  const [word, sub] = STAMP_WORD[v];
  const color = v === 'paid' ? '#e2401f' : v === 'pending' ? '#c9a27a' : v === 'unverified' ? '#a8681a' : '#8f8783';
  return (
    <svg className={`stamp stamp-${v}`} viewBox="0 0 132 132" role="img" aria-label={`Verdict: ${VERDICT_WORD[v].toLowerCase()}`}>
      <defs>
        <filter id={`ink-${v}`} x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="2.6" result="d" />
          <feComponentTransfer in="n" result="holes">
            <feFuncA type="discrete" tableValues="0 0 0 0 0 0 0 0 0 1" />
          </feComponentTransfer>
          <feComposite in="d" in2="holes" operator="out" />
        </filter>
      </defs>
      <g filter={`url(#ink-${v})`} fill="none" stroke={color}>
        <rect x="8" y="8" width="116" height="116" rx="14" strokeWidth="5" />
        <rect x="17" y="17" width="98" height="98" rx="8" strokeWidth="1.6" />
        <path d="M40 46h52" strokeWidth="1.6" />
        <text x="66" y="71" textAnchor="middle" fill={color} stroke="none" fontFamily="Hanken Grotesk, sans-serif" fontWeight="600" fontSize={word.length > 4 ? 25 : 31} letterSpacing="1">
          {word}
        </text>
        <text x="66" y="92" textAnchor="middle" fill={color} stroke="none" fontFamily="JetBrains Mono, monospace" fontWeight="500" fontSize="8.5" letterSpacing="1.2">
          {sub}
        </text>
      </g>
    </svg>
  );
}

/** Pretty-printed, highlighted JSON as React nodes (no HTML strings: memos come from the chain). */
function Json({ v, ind = '' }: { v: unknown; ind?: string }): ReactNode {
  const pad = ind + '  ';
  if (v === null || v === undefined) return <span className="j-n">null</span>;
  if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'bigint') return <span className="j-n">{String(v)}</span>;
  if (typeof v === 'string') return <span className="j-s">"{v}"</span>;
  if (Array.isArray(v)) {
    if (!v.length) return <span className="j-p">[]</span>;
    if (v.every((x) => typeof x !== 'object' || x === null))
      return (
        <>
          <span className="j-p">[</span>
          {v.map((x, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="j-p">, </span>}
              <Json v={x} />
            </Fragment>
          ))}
          <span className="j-p">]</span>
        </>
      );
    return (
      <>
        <span className="j-p">[</span>
        {'\n'}
        {v.map((x, i) => (
          <Fragment key={i}>
            {pad}
            <Json v={x} ind={pad} />
            {i < v.length - 1 && <span className="j-p">,</span>}
            {'\n'}
          </Fragment>
        ))}
        {ind}
        <span className="j-p">]</span>
      </>
    );
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) return <span className="j-p">{'{}'}</span>;
  return (
    <>
      <span className="j-p">{'{'}</span>
      {'\n'}
      {entries.map(([k, x], i) => (
        <Fragment key={k}>
          {pad}
          <span className="j-k">"{k}"</span>
          <span className="j-p">: </span>
          <Json v={x} ind={pad} />
          {i < entries.length - 1 && <span className="j-p">,</span>}
          {'\n'}
        </Fragment>
      ))}
      {ind}
      <span className="j-p">{'}'}</span>
    </>
  );
}

function Param({ name, type, req, children, input }: { name: string; type: string; req?: string; children?: ReactNode; input: ReactNode }) {
  return (
    <li className="param">
      <div className="p-head">
        <span className="p-name">{name}</span>
        <span className="p-type">{type}</span>
        {req && <span className={req === 'required' || req === 'required for ok' ? 'p-req' : 'p-opt'}>{req}</span>}
      </div>
      {children && <p className="p-desc">{children}</p>}
      {input}
    </li>
  );
}

function Reasons({ reasons }: { reasons: string[] }) {
  if (!reasons.length) return null;
  return (
    <ul className="reasons" aria-label="Reasons">
      {reasons.map((x) => (
        <li key={x}>
          <code className={`tag ${x === 'NOT_CONFIRMED' ? 'tag-wait' : 'tag-no'}`}>{x}</code>
          <span>{WHY[x] ?? ''}</span>
        </li>
      ))}
    </ul>
  );
}

/* ---------- verdict prose (centre column) ---------- */

/** What each lightwalletd said, when the API cross-checks (ZPV_LWD_URLS on the verify API). */
function CrossCheckTable({ c }: { c: NonNullable<ZcashResult['crossCheck']> }) {
  const answered = c.endpoints.filter((e) => e.answered).length;
  return (
    <>
      <h3>Cross-check</h3>
      <p className="muted">
        {answered} of {c.endpoints.length} endpoints answered; quorum {c.quorum}; {c.agreed ? 'every answer agreed.' : 'no verdict.'}
      </p>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th scope="col">Endpoint</th>
              <th scope="col">Said</th>
            </tr>
          </thead>
          <tbody>
            {c.endpoints.map((e) => (
              <tr key={e.lightwalletd}>
                <td>
                  <code>{e.lightwalletd.replace(/^https?:\/\//, '')}</code>
                </td>
                <td className="xc-said">{e.inconsistent ? <span>inconsistent answer: {e.error}</span> : e.answered ? (e.ok ? 'paid' : (e.reasons ?? []).join(', ') || 'not paid') + (e.height ? ` · block ${e.height.toLocaleString('en-US')}` : '') : <span className="muted">no answer: {e.error}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ZcashVerdict({ r }: { r: ZcashResult }) {
  const v = verdictOf({ kind: 'zcash', r, status: 200, ms: 0 })!;
  if (!r.report) {
    return (
      <>
        <p className="v-line">
          <span className={`v-badge v-${v}`}>{VERDICT_WORD[v]}</span>
          No verdict: this payment is neither paid nor refused.
        </p>
        <Reasons reasons={r.reasons} />
        {r.crossCheck && <CrossCheckTable c={r.crossCheck} />}
      </>
    );
  }
  return (
    <>
      <p className="v-line">
        <span className={`v-badge v-${v}`}>{VERDICT_WORD[v]}</span>
        {r.ok ? `${taz(r.paidZat)} reached this key with the expected memo.` : r.report.found ? `Counted toward this check: ${taz(r.paidZat)}.` : 'No such transaction.'}
      </p>
      <Reasons reasons={r.reasons} />
      {r.crossCheck && <CrossCheckTable c={r.crossCheck} />}
      {r.report.found && (
        <>
          <h3>What the viewing key sees</h3>
          {r.report.outputs.length === 0 ? (
            <p className="muted">No output in this transaction decrypts to this key.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
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
              <code>{short(r.report.txid)}</code> ↗
            </a>
          </dd>
        </div>
        <div>
          <dt>Mined</dt>
          <dd>{r.report.height ? `block ${r.report.height.toLocaleString('en-US')}, ${r.report.confirmations.toLocaleString('en-US')} confirmations` : r.report.found ? 'in the mempool' : '—'}</dd>
        </div>
        <div>
          <dt>Pools</dt>
          <dd>{Object.entries(r.report.pools).filter(([, on]) => on).map(([k]) => k).join(', ') || '—'}</dd>
        </div>
        <div>
          <dt>Checked via</dt>
          <dd>
            {new URL(r.provenance.lightwalletd).host} at tip {r.provenance.tip.toLocaleString('en-US')}, {new Date(r.provenance.checkedAt).toLocaleTimeString()}
          </dd>
        </div>
      </dl>
    </>
  );
}

function Null402Verdict({ r, settledIn }: { r: Null402Result; settledIn: string | null }) {
  const v = r.ok ? 'paid' : 'not-paid';
  return (
    <>
      <p className="v-line">
        <span className={`v-badge v-${v}`}>{r.ok ? 'Paid' : 'Not paid'}</span>
        {r.ok ? 'Valid, the pool’s tree, unspent, and it pays what you expect.' : 'Do not accept this proof as a new payment to you.'}
      </p>
      <Reasons reasons={r.reasons} />
      <h3>Read-only calls on Fuji</h3>
      <ul className="checks">
        <li>
          <code>verifier.verifyProof</code>
          <span className={`tag ${r.checks.proofValid ? 'tag-ok' : 'tag-no'}`}>{String(r.checks.proofValid)}</span>
        </li>
        <li>
          <code>pool.knownRoot(root)</code>
          <span className={`tag ${r.checks.rootKnown ? 'tag-ok' : 'tag-no'}`}>{String(r.checks.rootKnown)}</span>
        </li>
        <li>
          <code>pool.spent(nullifier)</code>
          <span className={`tag ${r.checks.nullifierSpent ? 'tag-no' : 'tag-ok'}`}>{String(r.checks.nullifierSpent)}</span>
        </li>
      </ul>
      <h3>Provenance</h3>
      <dl className="prov">
        <div>
          <dt>Proof from</dt>
          <dd>{settledIn === null ? 'settle() not mined yet' : `settle() in Fuji block ${Number(settledIn).toLocaleString('en-US')}`}</dd>
        </div>
        <div>
          <dt>Checked at</dt>
          <dd>
            Fuji block {Number(r.provenance.blockNumber).toLocaleString('en-US')} via {new URL(r.provenance.rpc).host}
          </dd>
        </div>
      </dl>
    </>
  );
}

/* ---------- app ---------- */

export function App() {
  const [rail, setRail] = useState<Rail>('zcash');
  const [preset, setPreset] = useState(0);
  const [z, setZ] = useState(PRESETS[0].zcash);
  const [settleTx, setSettleTx] = useState(SETTLE);
  const [expPayTo, setExpPayTo] = useState('');
  const [expAmount, setExpAmount] = useState('');
  const [tamper, setTamper] = useState(false);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<Outcome | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [health, setHealth] = useState<Health>('checking');
  /** The lightwalletd endpoints the verify API checks against, from GET /api/health. */
  const [lwd, setLwd] = useState<{ urls: string[]; quorum: number } | null>(null);
  const [seq, setSeq] = useState(0);
  const logId = useRef(0);
  /** The request whose answer may still be shown. Switching rail moves it on, so a late answer is dropped. */
  const current = useRef(0);
  const inFlight = useRef<AbortController | null>(null);

  // Is the verify API there? A real request, not an assumption.
  async function ping() {
    setHealth('checking');
    try {
      const r = await fetch(`${API}/api/health`);
      setHealth(r.ok ? 'up' : 'down');
      if (r.ok) setLwd(((await r.json()) as { lightwalletd?: { urls: string[]; quorum: number } }).lightwalletd ?? null);
    } catch {
      setHealth('down');
    }
  }
  useEffect(() => {
    void ping();
  }, []);

  function record(o: Outcome, ref: string, r: Rail) {
    const v = verdictOf(o);
    logId.current += 1;
    const entry: LogEntry = { id: logId.current, rail: r, status: o.kind === 'error' ? (o.setup ? 'setup' : 'error') : v!, ref, reasons: o.kind === 'error' ? [] : o.r.reasons, at: new Date().toLocaleTimeString() };
    setLog((l) => [entry, ...l].slice(0, 10));
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const id = ++current.current;
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    setBusy(true);
    setOut(null);
    const t0 = performance.now();
    let o: Outcome;
    const ref = rail === 'zcash' ? z.txid.trim() : settleTx.trim();
    const sentRail = rail;
    try {
      if (rail === 'zcash') {
        let res: Response;
        try {
          res = await fetch(`${API}/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(zcashBody()), signal: ctrl.signal });
        } catch {
          if (id !== current.current) return; // abandoned: another rail or request took over
          if (ctrl.signal.aborted) throw new Error(`the verify API at ${API} gave no answer within 90 s`);
          setHealth('down');
          throw Object.assign(new Error(`Setup required: the verify API is not reachable at ${API}. Start it with pnpm --filter @zpv/gateway api`), { setup: true });
        }
        setHealth('up');
        const body = await res.json();
        o = res.ok ? { kind: 'zcash', r: body, status: res.status, ms: Math.round(performance.now() - t0) } : { kind: 'error', message: body.error ?? `HTTP ${res.status}`, setup: res.status === 503, status: res.status, body };
      } else {
        const s = await proofFromSettleTx(settleTx.trim() as `0x${string}`);
        const pub = [...s.publicSignals];
        if (tamper) pub[3] = (BigInt(pub[3]) * 10n).toString();
        const expect = { payTo: expPayTo.trim() || undefined, requiredAmount: expAmount.trim() || undefined };
        const r = await verifyNull402({ rail: 'null402', proof: s.proof, publicSignals: pub, expect });
        o = { kind: 'null402', r, settledIn: s.blockNumber, ms: Math.round(performance.now() - t0) };
      }
    } catch (err) {
      const message = (err as Error).message.split('\n')[0];
      o = { kind: 'error', message, setup: Boolean((err as { setup?: boolean }).setup) };
    } finally {
      clearTimeout(timer);
    }
    // Only the latest request, on the rail it was sent from, may put its answer on screen.
    if (id !== current.current || sentRail !== railRef.current) return;
    inFlight.current = null;
    setOut(o);
    setSeq((n) => n + 1);
    record(o, ref, sentRail);
    setBusy(false);
  }

  function zcashBody() {
    return { rail: 'zcash', uivk: z.uivk.trim(), txid: z.txid.trim(), amountZat: Number(z.amount), memo: z.memo || undefined, minConf: Number(z.minConf || 1) };
  }

  const railRef = useRef<Rail>('zcash');
  function pickRail(r: Rail) {
    // Abandon a check in flight: its answer belongs to the other rail's request.
    current.current += 1;
    inFlight.current?.abort();
    inFlight.current = null;
    railRef.current = r;
    setBusy(false);
    setRail(r);
    setOut(null);
  }

  // The request as it will be sent. The key is shown shortened: this pane is for reading, not copying secrets.
  const requestBody = rail === 'zcash' ? { ...zcashBody(), uivk: z.uivk.trim() ? `${z.uivk.trim().slice(0, 14)}…` : '' } : null;
  const v = out ? verdictOf(out) : null;
  const amountOk = /^\d+$/.test(z.amount);

  return (
    <div className="app">
      <a className="skip" href="#params">
        Skip to the parameters
      </a>
      <header className="top">
        <a className="brand" href={REPO} aria-label="Hanko on GitHub">
          <SealMark />
          Hanko
        </a>
        <span className="ver">console · testnet</span>
        <div className="top-end">
          <span className={`health ${rail === 'null402' ? 'health-neutral' : `health-${health}`}`} role="status">
            <span className="dot" aria-hidden="true" />
            {rail === 'null402' ? 'Fuji, straight from this browser' : health === 'up' ? 'verify API reachable' : health === 'down' ? 'verify API not reachable' : 'checking the verify API…'}
          </span>
          <a href={REPO} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </div>
      </header>

      <div className="layout">
        <aside className="side" aria-label="Endpoints">
          <nav>
            <h2>Check</h2>
            <ul>
              <li>
                <button type="button" aria-current={rail === 'zcash'} onClick={() => pickRail('zcash')}>
                  <span className="verb">POST</span> Zcash payment
                </button>
              </li>
              <li>
                <button type="button" aria-current={rail === 'null402'} onClick={() => pickRail('null402')}>
                  <span className="verb">CALL</span> null-402 proof
                </button>
              </li>
            </ul>
            <h2>This page</h2>
            <ul>
              <li>
                <a href="#history">
                  History <span className="count">{log.length}</span>
                </a>
              </li>
              <li>
                <a href="#evidence">Real payments</a>
              </li>
            </ul>
          </nav>
        </aside>

        <main className="doc" id="main">
          <div className="row">
            <div className="prose">
              <p className="kicker">{rail === 'zcash' ? 'POST /api/verify · rail zcash' : 'null-402 · Avalanche Fuji · read-only'}</p>
              <h1>{rail === 'zcash' ? 'Was I paid?' : 'Is this proof a payment to me?'}</h1>
              <p className="lede">
                {rail === 'zcash'
                  ? 'Paste a transaction and your incoming viewing key. The local verify API fetches it from lightwalletd (from several, when it cross-checks), decrypts what is yours and applies the rules. Endpoints that disagree give no verdict, never a Paid.'
                  : 'Read a proof back out of a null-402 settle() on Fuji and check it against the deployed verifier and pool, from this browser.'}
              </p>

              {health === 'down' && rail === 'zcash' && (
                <div className="banner" role="alert">
                  <span className="tag tag-wait">Setup required</span>
                  <p>
                    The verify API is not reachable at <code>{API}</code>
                    {API_FROM_ENV ? '' : ' (default; set VITE_ZPV_API to change it)'}, or it does not allow this page's origin (<code>ZPV_CORS</code>). Start it with <code>pnpm --filter @zpv/gateway api</code>, then{' '}
                    <button type="button" className="link" onClick={() => void ping()}>
                      check again
                    </button>
                    .
                  </p>
                </div>
              )}

              <form id="params" onSubmit={send} aria-describedby="send-note">
                {/* Locked while a check runs, so the request on screen is the one the answer is for. */}
                <fieldset className="params-set" disabled={busy}>
                {rail === 'zcash' ? (
                  <>
                    <h3>Examples</h3>
                    <div className="chips" role="radiogroup" aria-label="Real examples">
                      {PRESETS.map((p, i) => (
                        <button
                          key={p.label}
                          type="button"
                          role="radio"
                          aria-checked={preset === i}
                          className="chip"
                          onClick={() => {
                            setPreset(i);
                            setZ(p.zcash);
                            setOut(null);
                          }}
                        >
                          <span>{p.label}</span>
                          <small>{p.note}</small>
                        </button>
                      ))}
                    </div>
                    <h3>Body parameters</h3>
                    <ul className="params">
                      <Param name="uivk" type="string" req="required" input={<input className="mono" aria-label="uivk" value={z.uivk} onChange={(e) => setZ({ ...z, uivk: e.target.value })} placeholder="uivktest1…" spellCheck={false} autoComplete="off" required />}>
                        Your incoming viewing key. It goes only to the verify API.
                      </Param>
                      <Param name="txid" type="string, 64 hex" req="required" input={<input className="mono" aria-label="txid" value={z.txid} onChange={(e) => setZ({ ...z, txid: e.target.value })} placeholder="64 hex characters" spellCheck={false} pattern="[0-9a-fA-F]{64}" required />} />
                      <Param
                        name="amountZat"
                        type="integer"
                        req="required"
                        input={
                          <div className="with-unit">
                            <input className="mono" aria-label="amountZat" value={z.amount} onChange={(e) => setZ({ ...z, amount: e.target.value })} inputMode="numeric" pattern="\d+" required />
                            <span className="unit">{amountOk ? `= ${taz(Number(z.amount))}` : 'whole zatoshi'}</span>
                          </div>
                        }
                      >
                        At least this many zatoshi, in outputs with the memo.
                      </Param>
                      <Param name="memo" type="string" req="optional" input={<input className="mono" aria-label="memo" value={z.memo} onChange={(e) => setZ({ ...z, memo: e.target.value })} placeholder="any memo" spellCheck={false} />}>
                        Only outputs with exactly this memo count.
                      </Param>
                      <Param name="minConf" type="integer" req="default 1" input={<input className="mono narrow" aria-label="minConf" value={z.minConf} onChange={(e) => setZ({ ...z, minConf: e.target.value })} inputMode="numeric" pattern="\d+" />} />
                    </ul>
                  </>
                ) : (
                  <>
                    <h3>Parameters</h3>
                    <ul className="params">
                      <Param name="settle_tx" type="0x hash" req="required" input={<input className="mono" aria-label="settle_tx" value={settleTx} onChange={(e) => setSettleTx(e.target.value)} spellCheck={false} pattern="0x[0-9a-fA-F]{64}" required />}>
                        A null-402 <code>settle()</code> transaction on Fuji; the proof is read from it.
                      </Param>
                      <Param name="expect.payTo" type="decimal field element" req="required for ok" input={<input className="mono" aria-label="expect.payTo" value={expPayTo} onChange={(e) => setExpPayTo(e.target.value)} placeholder="leave empty to see UNBOUND" spellCheck={false} pattern="\d*" />}>
                        Who you are, as the proof's <code>payTo</code> signal.
                      </Param>
                      <Param name="expect.requiredAmount" type="integer" req="required for ok" input={<input className="mono" aria-label="expect.requiredAmount" value={expAmount} onChange={(e) => setExpAmount(e.target.value)} placeholder="e.g. 1000" inputMode="numeric" pattern="\d*" />}>
                        What you charge.
                      </Param>
                      <Param
                        name="tamper"
                        type="demo"
                        req="optional"
                        input={
                          <label className="check">
                            <input type="checkbox" checked={tamper} onChange={(e) => setTamper(e.target.checked)} />
                            <span>Claim 10× the amount the proof authorises</span>
                          </label>
                        }
                      />
                    </ul>
                  </>
                )}
                </fieldset>
                <div className="send-row">
                  <button className="send" disabled={busy}>
                    <SealMark size={18} />
                    {busy ? 'Checking…' : 'Send request'}
                  </button>
                  <span className="muted small" id="send-note">
                    {rail === 'zcash'
                      ? `to ${API}${lwd ? (lwd.urls.length > 1 ? ` · cross-checks ${lwd.urls.length} lightwalletd, quorum ${lwd.quorum}` : ` · one lightwalletd, ${lwd.urls[0].replace(/^https?:\/\//, '')}`) : ''}`
                      : `to ${new URL(NULL402_FUJI.rpc).host}`}
                  </span>
                </div>
              </form>

              <section className="verdict" aria-live="polite" aria-busy={busy} aria-labelledby="h-verdict">
                <h2 id="h-verdict">Verdict</h2>
                {!out && !busy && <p className="muted">Nothing checked yet. Pick an example or fill the parameters, then send the request.</p>}
                {busy && <p className="muted">Checking live…</p>}
                {out?.kind === 'error' && (
                  <div className={out.setup ? 'banner' : 'banner banner-bad'} role="alert">
                    <span className={`tag ${out.setup ? 'tag-wait' : 'tag-no'}`}>{out.setup ? 'Setup required' : 'Could not check'}</span>
                    <p>{out.message}</p>
                  </div>
                )}
                {out?.kind === 'zcash' && <ZcashVerdict r={out.r} />}
                {out?.kind === 'null402' && <Null402Verdict r={out.r} settledIn={out.settledIn} />}
              </section>

              <section id="history" aria-labelledby="h-history">
                <h2 id="h-history">History</h2>
                <p className="muted small">This session only; nothing is stored.</p>
                {log.length === 0 ? (
                  <p className="muted">No checks yet. Each one you send is listed here with its verdict and reasons.</p>
                ) : (
                  <ul className="log">
                    {log.map((e) => (
                      <li key={e.id}>
                        <span className={`dot-v v-${e.status}`} aria-hidden="true" />
                        <span className="log-main">
                          <span>
                            {e.rail === 'zcash' ? 'Zcash' : 'null-402'} · {e.at} ·{' '}
                            <b>{e.status === 'setup' ? 'Setup required' : e.status === 'error' ? 'Error' : VERDICT_WORD[e.status]}</b>
                          </span>
                          {/^(0x)?[0-9a-fA-F]{64}$/.test(e.ref) ? (
                            <a href={e.rail === 'zcash' ? ZEC_TX + e.ref : `${NULL402_FUJI.explorer}/tx/${e.ref}`} target="_blank" rel="noreferrer">
                              <code>{short(e.ref)}</code> ↗
                            </a>
                          ) : (
                            <code className="muted">{e.ref ? short(e.ref) : '—'}</code>
                          )}
                          {e.reasons.length > 0 && <span className="log-reasons">{e.reasons.join(' · ')}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section id="evidence" aria-labelledby="h-evidence">
                <h2 id="h-evidence">Real payments to try</h2>
                <div className="tbl-wrap">
                  <table className="tbl">
                    <tbody>
                      <tr>
                        <td>Shielded x402 merchant payment</td>
                        <td>
                          <a href={ZEC_TX + fx.x402.txid} target="_blank" rel="noreferrer">
                            <code>{short(fx.x402.txid)}</code> ↗
                          </a>
                        </td>
                      </tr>
                      <tr>
                        <td>Sealed-bid auction deposit</td>
                        <td>
                          <a href={ZEC_TX + fx.auction.deposit.txid} target="_blank" rel="noreferrer">
                            <code>{short(fx.auction.deposit.txid)}</code> ↗
                          </a>
                        </td>
                      </tr>
                      <tr>
                        <td>null-402 settle() on Fuji</td>
                        <td>
                          <a href={`${NULL402_FUJI.explorer}/tx/${SETTLE}`} target="_blank" rel="noreferrer">
                            <code>{short(SETTLE)}</code> ↗
                          </a>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>
            </div>

            <div className="code" aria-label="Request and response">
              <div className="code-stick">
                <div className="pane">
                  <div className="pane-head">
                    <span className="pane-title">
                      <b>Request</b>
                    </span>
                    <span className="pane-sub">{rail === 'zcash' ? 'POST /api/verify' : '3 × eth_call'}</span>
                  </div>
                  <pre>
                    {rail === 'zcash' ? (
                      <code>
                        <span className="j-p">curl -s {API}/api/verify \{'\n'}  -H 'content-type: application/json' \{'\n'}  -d </span>
                        <Json v={requestBody} ind="  " />
                      </code>
                    ) : (
                      <code>
                        <span className="j-c"># proof read from settle() {short(settleTx.trim() || '—')}</span>
                        {'\n'}
                        <span className="j-p">verifier </span>
                        <span className="j-s">{short(NULL402_FUJI.verifier, 6, 4)}</span>
                        <span className="j-p">.verifyProof(a, b, c, signals{tamper ? ' with amount × 10' : ''}){'\n'}pool     </span>
                        <span className="j-s">{short(NULL402_FUJI.pool, 6, 4)}</span>
                        <span className="j-p">.knownRoot(root){'\n'}pool     </span>
                        <span className="j-s">{short(NULL402_FUJI.pool, 6, 4)}</span>
                        <span className="j-p">.spent(nullifier){'\n'}</span>
                        <span className="j-c"># expect </span>
                        <Json v={{ payTo: expPayTo.trim() || null, requiredAmount: expAmount.trim() || null }} />
                      </code>
                    )}
                  </pre>
                  {rail === 'zcash' && <div className="pane-foot">The key is shortened here; the full key is sent.</div>}
                </div>

                <div className="pane response">
                  <div className="pane-head">
                    <span className="pane-title">
                      <b>Response</b>
                    </span>
                    {out?.kind === 'zcash' && <span className={`status ${v === 'paid' ? 'ok' : ''}`}>{`${out.status} · ${out.ms} ms`}</span>}
                    {out?.kind === 'null402' && <span className={`status ${v === 'paid' ? 'ok' : ''}`}>{`block ${Number(out.r.provenance.blockNumber).toLocaleString('en-US')} · ${out.ms} ms`}</span>}
                    {out?.kind === 'error' && <span className="status">{out.status ? `HTTP ${out.status}` : out.setup ? 'setup required' : 'error'}</span>}
                  </div>
                  {!out && !busy && <p className="pane-empty">No request sent yet.</p>}
                  {busy && (
                    <p className="pane-empty">
                      <span className="pulse" aria-hidden="true" />
                      Waiting for {rail === 'zcash' ? new URL(API).host : 'Fuji'}…
                    </p>
                  )}
                  {out && (
                    <pre>
                      <code>
                        <Json v={out.kind === 'error' ? (out.body ?? { error: out.message }) : out.r} />
                      </code>
                    </pre>
                  )}
                  {v && (
                    <div className="stamp-slot" key={seq}>
                      <Stamp v={v} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
      <footer className="foot">
        <span>Hanko · MIT · Copyright (c) 2026 Nivesh Gajengi</span>
        <span>testnet only · the viewing key is sent only to your verify API</span>
      </footer>
    </div>
  );
}
