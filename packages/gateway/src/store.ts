// Where the paywall keeps its state: open challenges, and the memos and txids that are being checked
// or have already paid. MemoryStore is the default (one process, forgotten on restart). SqliteStore
// keeps the same state in one SQLite file (node:sqlite, Node ≥ 22.13), so a restarted paywall still
// refuses a payment it already served, and several paywall processes on one file serve a payment once.
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Challenge } from './server.js';

export type Claim = { ok: true; token: string } | { ok: false; why: 'used' | 'busy' };

export interface PaywallStore {
  /** Drop expired challenges, then keep `c` unless `maxOpen` challenges are already open. */
  issue(c: Challenge, maxOpen: number, now: number): boolean;
  challenge(memo: string): Challenge | undefined;
  /**
   * Reserve the memo and the (lower-case) txid for one check, atomically. `used`: either already
   * paid for a request. `busy`: another request holds an unexpired lease on either.
   */
  claim(memo: string, txid: string, now: number, leaseMs: number): Claim;
  /** Give the reservation back (the check refused or failed). Only the holder's token releases it. */
  release(memo: string, txid: string, token: string): void;
  /**
   * Mark the txid paid for good, close the challenge and drop the memo's reservation (a closed memo
   * cannot be answered again). False if the reservation is no longer this token's (its lease expired
   * and another request took it over): then do not serve.
   */
  settle(memo: string, txid: string, token: string): boolean;
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

  issue(c: Challenge, maxOpen: number, now: number): boolean {
    for (const [memo, o] of this.open) {
      if (o.expiresAt >= now) break;
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
    const [mk, tk] = keys(memo, txid);
    this.claims.delete(mk);
    this.claims.set(tk, { state: 'paid', until: 0, owner: token });
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
      CREATE TABLE IF NOT EXISTS claims (
        key TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('checking', 'paid')),
        until INTEGER NOT NULL,
        owner TEXT NOT NULL
      );`);
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

  issue(c: Challenge, maxOpen: number, now: number): boolean {
    return this.tx(() => {
      this.db.prepare('DELETE FROM challenges WHERE expires_at < ?').run(now);
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
      this.db.prepare("UPDATE claims SET state = 'paid', until = 0 WHERE key = ?").run(tk);
      this.db.prepare('DELETE FROM claims WHERE key = ?').run(mk);
      this.db.prepare('DELETE FROM challenges WHERE memo = ?').run(memo);
      return true;
    });
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }
}
