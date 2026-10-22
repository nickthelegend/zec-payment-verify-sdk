// Bounds how many checks run at once. No Node imports: the null402 rail uses it in the browser too.
import { BusyError, SetupRequiredError } from './errors.js';

/** A setting from the environment as a whole number ≥ min (default when unset). */
export function envInt(name: string, dflt: number, min: number): number {
  const v = (typeof process !== 'undefined' ? process.env?.[name] : undefined)?.trim();
  if (!v) return dflt;
  if (!/^\d+$/.test(v) || Number(v) < min) throw new SetupRequiredError(name, `a whole number ≥ ${min}, got ${v}`);
  return Number(v);
}

/**
 * Bounds the checks that run at once (by default ZPV_MAX_CHECKS, 8: zpay-verify processes) and how many
 * may wait for a slot (ZPV_MAX_QUEUE, default 32). Past that a check is a BusyError at once, so a flood
 * of requests cannot fork without limit. A cross-check takes one slot per endpoint. The SDK keeps one for
 * the zcash rail and one for the null402 rail (ZPV_MAX_NULL402_CHECKS, default 16 Fuji checks); a
 * server can give a surface its own (the paywall's checks do not share slots with a public verify API).
 */
export class CheckLimiter {
  private running = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly setting: { max: string; maxDefault: number; what: string } = { max: 'ZPV_MAX_CHECKS', maxDefault: 8, what: 'payment checks' }) {}

  async run<T>(f: () => Promise<T>): Promise<T> {
    const max = envInt(this.setting.max, this.setting.maxDefault, 1);
    const queue = envInt('ZPV_MAX_QUEUE', 32, 0);
    if (this.running >= max) {
      if (this.waiting.length >= queue) throw new BusyError(`${this.running} ${this.setting.what} are running and ${this.waiting.length} are waiting (${this.setting.max} ${max}, ZPV_MAX_QUEUE ${queue}); retry later`);
      await new Promise<void>((r) => this.waiting.push(r)); // the check that ends hands its slot over
    } else this.running++;
    try {
      return await f();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}

