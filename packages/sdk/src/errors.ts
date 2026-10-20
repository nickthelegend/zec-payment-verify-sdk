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
