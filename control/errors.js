// Errors that map to a CLI exit code and a JSON body on stdout.
export const EXIT = { ok: 0, doctor: 1, unconfigured: 2, invalid: 4, failed: 5 };

export class CliError extends Error {
  constructor(exitCode, reason, message, extra = {}) {
    super(message);
    this.exitCode = exitCode;
    this.body = { ok: false, reason, message, ...extra };
  }
}

export const invalid = (message, extra) => new CliError(EXIT.invalid, 'invalid_args', message, extra);
