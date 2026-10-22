/** A required setting, binary or file is missing. Shown as "Setup required", never faked. */
export class SetupRequiredError extends Error {
  constructor(public readonly missing: string, detail?: string) {
    super(`Setup required: ${missing}${detail ? ` (${detail})` : ''}`);
    this.name = 'SetupRequiredError';
  }
}

/** The request could not be checked (bad input, network). Not a verdict. */
export class VerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifyError';
  }
}

/** zpay-verify could not reach or query a lightwalletd, or it gave no answer in time. Not bad input:
 *  retry later. (A subclass of VerifyError for compatibility; check for it first.) */
export class LightwalletdUnreachableError extends VerifyError {
  constructor(message: string) {
    super(message);
    this.name = 'LightwalletdUnreachableError';
  }
}

/** A lightwalletd answered, but its answer contradicts itself (a txid that does not match, bytes that do
 *  not parse, a block that does not list the tx). Under a cross-check it counts as a dissent. */
export class LightwalletdBadAnswerError extends VerifyError {
  constructor(message: string) {
    super(message);
    this.name = 'LightwalletdBadAnswerError';
  }
}

/** Too many zpay-verify checks are running and waiting in this process (ZPV_MAX_CHECKS, ZPV_MAX_QUEUE). Retry later. */
export class BusyError extends VerifyError {
  constructor(message: string) {
    super(message);
    this.name = 'BusyError';
  }
}
