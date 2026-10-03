import type { RiskCheckResult } from '@pegasus/shared';

/** Error with a stable API code; translated to the ApiErr envelope by the HTTP layer. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class RiskRejectedError extends AppError {
  constructor(public readonly result: RiskCheckResult) {
    super('RISK_REJECTED', result.message, 422, { ...result });
    this.name = 'RiskRejectedError';
  }
}

export class NotConnectedError extends AppError {
  constructor(what: string) {
    super('NOT_CONNECTED', `${what} is not connected`, 503);
    this.name = 'NotConnectedError';
  }
}

export class UnknownInstrumentError extends AppError {
  constructor(instId: string) {
    super('UNKNOWN_INSTRUMENT', `instrument ${instId} is not tracked by this server`, 404, { instId });
    this.name = 'UnknownInstrumentError';
  }
}
