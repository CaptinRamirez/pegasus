/** Thrown when OKX answers with a non-zero `code` (or a non-zero per-item sCode). */
export class OkxApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly okxMessage: string,
    public readonly requestPath: string,
    public readonly data?: unknown,
  ) {
    super(`OKX ${requestPath} failed: [${code}] ${okxMessage}`);
    this.name = 'OkxApiError';
  }

  get isRateLimited(): boolean {
    return this.code === '50011' || this.code === '50061';
  }

  /**
   * The request timed out inside OKX (50004 endpoint timeout, 51149 order timeout): it may or may
   * not have been executed, so an order must be looked up instead of being reported as rejected.
   */
  get isOutcomeUnknown(): boolean {
    return this.code === '50004' || this.code === '51149';
  }

  get isAuthError(): boolean {
    return ['50100', '50101', '50102', '50103', '50104', '50105', '50111', '50112', '50113', '50114', '50115'].includes(this.code);
  }
}

/**
 * Thrown when no complete response arrived: the network failed or the request timed out.
 * Deliberately not an OkxApiError: the exchange may or may not have processed the request,
 * so callers must treat the outcome as unknown.
 */
export class OkxTransportError extends Error {
  constructor(
    public readonly requestPath: string,
    message: string,
    public readonly timedOut: boolean,
  ) {
    super(message);
    this.name = 'OkxTransportError';
  }
}

/** Thrown on non-JSON / non-2xx responses. */
export class OkxHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly requestPath: string,
    public readonly bodyText: string,
  ) {
    super(`OKX ${requestPath} HTTP ${status}: ${bodyText.slice(0, 300)}`);
    this.name = 'OkxHttpError';
  }
}

export class OkxWsError extends Error {
  /**
   * @param sent true when the request frame was (or may have been) delivered to the
   * exchange before the failure, so the operation's outcome is unknown; false when it
   * was never sent and can safely be retried on another transport.
   */
  constructor(
    message: string,
    public readonly code?: string,
    public readonly sent: boolean = false,
  ) {
    super(message);
    this.name = 'OkxWsError';
  }
}
