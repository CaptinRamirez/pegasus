import type { OkxTransportError } from '@pegasus/okx';
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

/** The API key lacks OKX's trade permission; raised before anything is sent to the exchange. */
export class ReadOnlyKeyError extends AppError {
  constructor() {
    super('READ_ONLY_KEY', 'the OKX API key is read-only: trading from Pegasus is disabled', 403);
    this.name = 'ReadOnlyKeyError';
  }
}

/** OKX could not be reached or did not answer in time: 504 on a timeout, 502 otherwise. */
export class ExchangeUnreachableError extends AppError {
  constructor(err: OkxTransportError) {
    super(
      'EXCHANGE_UNREACHABLE',
      err.timedOut ? 'OKX did not answer in time; the request may or may not have been processed' : 'could not reach OKX; check the network connection',
      err.timedOut ? 504 : 502,
      { timedOut: err.timedOut, reason: err.message },
    );
    this.name = 'ExchangeUnreachableError';
  }
}

export class UnknownInstrumentError extends AppError {
  constructor(instId: string) {
    super('UNKNOWN_INSTRUMENT', `instrument ${instId} is not tracked by this server`, 404, { instId });
    this.name = 'UnknownInstrumentError';
  }
}
