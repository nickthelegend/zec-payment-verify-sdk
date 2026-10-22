// Where the paywall keeps its state: open challenges, and the memos and txids that are being checked
// or have already paid. MemoryStore is the default (one process, forgotten on restart). SqliteStore
// keeps the same state in one SQLite file (node:sqlite, Node ≥ 22.13), so a restarted paywall still
// refuses a payment it already served, and several paywall processes on one file serve a payment once.
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Challenge } from './server.js';

export type Claim = { ok: true; token: string } | { ok: false; why: 'used' | 'busy' };

/** A payment that reached the merchant's key with the challenge memo but was refused: owed back by hand. */
export interface Refund {
  txid: string;
  memo: string;
  resource: string;
  /** Zatoshi in outputs with the challenge memo. */
  paidZat: number;
  reasons: string[];
  height: number | null;
  /** Unix seconds of the block that mined it. */
  blockTime: number | null;
  /** When the paywall refused it (ISO). */
  at: string;
}

export interface PaywallStore {
  /**
   * The key that authenticates challenge memos (HMAC). Stable for the store's life: a SqliteStore keeps
   * it in its file, so a restarted paywall and other processes on the file accept each other's memos.
   */
  secret(): Buffer;
  /** Custom memos only (issueMemo): drop challenges that expired before `cutoff`, then keep `c` unless
   *  `maxOpen` are open. */
  issue(c: Challenge, maxOpen: number, cutoff: number): boolean;
  challenge(memo: string): Challenge | undefined;
  /**
   * Reserve the memo and the (lower-case) txid for one check, atomically. `used`: either already
   * paid for a request. `busy`: another request holds an unexpired lease on either.
   */
  claim(memo: string, txid: string, now: number, leaseMs: number): Claim;
  /** Give the reservation back (the check refused or failed). Only the holder's token releases it. */
  release(memo: string, txid: string, token: string): void;
  /**
   * Mark the txid and the memo paid for good (neither can pay again) and close a stored challenge.
   * False if the reservation is no longer this token's (its lease expired and another request took it
   * over): then do not serve.
   */
  settle(memo: string, txid: string, token: string): boolean;
  /** Count one refused payment presented for `memo`; returns the count so far. */
  fail(memo: string): number;
  failures(memo: string): number;
  /** Record (or update, by txid) a refused payment that reached the key. */
  recordRefund(r: Refund): void;
  /** Newest first. */
  refunds(): Refund[];
  close(): void;
}

const keys = (memo: string, txid: string) => [`memo:${memo}`, `tx:${txid}`] as const;
const newToken = () => randomBytes(12).toString('hex');

interface Row {
  state: 'checking' | 'paid';
  until: number;
  owner: string;
}

export class MemoryStore implements PaywallStore {
  /** A Map iterates in insertion order and challenges are re-inserted on issue: oldest expiry first. */
  private open = new Map<string, Challenge>();
  private claims = new Map<string, Row>();
  private key = randomBytes(32);
  private owed = new Map<string, Refund>();
  private failed = new Map<string, number>();

  fail(memo: string) {
    const n = (this.failed.get(memo) ?? 0) + 1;
    this.failed.set(memo, n);
    return n;
  }

  failures(memo: string) {
    return this.failed.get(memo) ?? 0;
  }

  secret() {
    return this.key;
  }

  recordRefund(r: Refund) {
    this.owed.delete(r.txid);
    this.owed.set(r.txid, r);
  }

  refunds() {
    return [...this.owed.values()].reverse();
  }

  issue(c: Challenge, maxOpen: number, cutoff: number): boolean {
    for (const [memo, o] of this.open) {
      if (o.expiresAt >= cutoff) break;
      this.open.delete(memo);
    }
    if (this.open.size >= maxOpen) return false;
    this.open.delete(c.memo);
    this.open.set(c.memo, c);
    return true;
  }

  challenge(memo: string) {
    return this.open.get(memo);
  }

  claim(memo: string, txid: string, now: number, leaseMs: number): Claim {
    const rows = keys(memo, txid).map((k) => this.claims.get(k));
    if (rows.some((r) => r?.state === 'paid')) return { ok: false, why: 'used' };
    if (rows.some((r) => r && r.until > now)) return { ok: false, why: 'busy' };
    const token = newToken();
    for (const k of keys(memo, txid)) this.claims.set(k, { state: 'checking', until: now + leaseMs, owner: token });
    return { ok: true, token };
  }

  release(memo: string, txid: string, token: string) {
    for (const k of keys(memo, txid)) {
      const r = this.claims.get(k);
      if (r?.state === 'checking' && r.owner === token) this.claims.delete(k);
    }
  }

  settle(memo: string, txid: string, token: string): boolean {
    if (!keys(memo, txid).every((k) => this.claims.get(k)?.owner === token)) return false;
    for (const k of keys(memo, txid)) this.claims.set(k, { state: 'paid', until: 0, owner: token });
    this.open.delete(memo);
    return true;
  }

  close() {}
}

export class SqliteStore implements PaywallStore {
  readonly db: DatabaseSync;

  constructor(readonly path: string) {
    this.db = new DatabaseSync(path);
    // WAL lets readers run beside the one writer; busy_timeout makes a second process wait for the
    // write lock instead of failing. Every claim runs in BEGIN IMMEDIATE, so two processes cannot
    // both see a key as free.
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS challenges (
        memo TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS challenges_by_expiry ON challenges (expires_at);
      CREATE TABLE IF NOT EXISTS failures (
        memo TEXT PRIMARY KEY,
        n INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refunds (
        txid TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS claims (
        key TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('checking', 'paid')),
        until INTEGER NOT NULL,
        owner TEXT NOT NULL
      );`);
  }

  private key?: Buffer;

  secret(): Buffer {
    if (!this.key) {
      // INSERT OR IGNORE: the first process to get here writes the key, every other one reads it.
      this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('challenge-hmac', ?)").run(randomBytes(32));
      const row = this.db.prepare("SELECT value FROM meta WHERE key = 'challenge-hmac'").get() as { value: Uint8Array };
      this.key = Buffer.from(row.value);
    }
    return this.key;
  }

  private tx<T>(f: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = f();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  issue(c: Challenge, maxOpen: number, cutoff: number): boolean {
    return this.tx(() => {
      this.db.prepare('DELETE FROM challenges WHERE expires_at < ?').run(cutoff);
      const { n } = this.db.prepare('SELECT count(*) AS n FROM challenges WHERE memo <> ?').get(c.memo) as { n: number };
      if (n >= maxOpen) return false;
      this.db.prepare('INSERT OR REPLACE INTO challenges (memo, expires_at, body) VALUES (?, ?, ?)').run(c.memo, c.expiresAt, JSON.stringify(c));
      return true;
    });
  }

  challenge(memo: string) {
    const row = this.db.prepare('SELECT body FROM challenges WHERE memo = ?').get(memo) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as Challenge) : undefined;
  }

  claim(memo: string, txid: string, now: number, leaseMs: number): Claim {
    const [mk, tk] = keys(memo, txid);
    return this.tx((): Claim => {
      const rows = this.db.prepare('SELECT state, until FROM claims WHERE key IN (?, ?)').all(mk, tk) as unknown as Row[];
      if (rows.some((r) => r.state === 'paid')) return { ok: false, why: 'used' };
      if (rows.some((r) => r.until > now)) return { ok: false, why: 'busy' };
      const token = newToken();
      const put = this.db.prepare(`INSERT INTO claims (key, state, until, owner) VALUES (?, 'checking', ?, ?)
        ON CONFLICT (key) DO UPDATE SET state = 'checking', until = excluded.until, owner = excluded.owner`);
      put.run(mk, now + leaseMs, token);
      put.run(tk, now + leaseMs, token);
      return { ok: true, token };
    });
  }

  release(memo: string, txid: string, token: string) {
    const [mk, tk] = keys(memo, txid);
    this.db.prepare("DELETE FROM claims WHERE key IN (?, ?) AND state = 'checking' AND owner = ?").run(mk, tk, token);
  }

  settle(memo: string, txid: string, token: string): boolean {
    const [mk, tk] = keys(memo, txid);
    return this.tx(() => {
      const { n } = this.db.prepare("SELECT count(*) AS n FROM claims WHERE key IN (?, ?) AND state = 'checking' AND owner = ?").get(mk, tk, token) as { n: number };
      if (n !== 2) return false;
      this.db.prepare("UPDATE claims SET state = 'paid', until = 0 WHERE key IN (?, ?)").run(mk, tk);
      this.db.prepare('DELETE FROM challenges WHERE memo = ?').run(memo);
      return true;
    });
  }

  fail(memo: string): number {
    const row = this.db.prepare('INSERT INTO failures (memo, n) VALUES (?, 1) ON CONFLICT (memo) DO UPDATE SET n = n + 1 RETURNING n').get(memo) as { n: number };
    return row.n;
  }

  failures(memo: string): number {
    return (this.db.prepare('SELECT n FROM failures WHERE memo = ?').get(memo) as { n: number } | undefined)?.n ?? 0;
  }

  recordRefund(r: Refund) {
    this.db.prepare('INSERT OR REPLACE INTO refunds (txid, at, body) VALUES (?, ?, ?)').run(r.txid, Date.parse(r.at), JSON.stringify(r));
  }

  refunds(): Refund[] {
    return (this.db.prepare('SELECT body FROM refunds ORDER BY at DESC, rowid DESC').all() as { body: string }[]).map((x) => JSON.parse(x.body) as Refund);
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }
}
