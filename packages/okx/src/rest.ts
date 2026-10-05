import { OkxApiError, OkxHttpError, OkxTransportError } from './errors.js';
import { restAuthHeaders, type OkxCredentials } from './sign.js';
import type {
  OkxAccountConfig,
  OkxAlgoAck,
  OkxAlgoOrder,
  OkxAmendAlgoParams,
  OkxAmendOrderParams,
  OkxBalance,
  OkxBookData,
  OkxCancelAlgoParams,
  OkxCancelOrderParams,
  OkxCandleRow,
  OkxClosePositionParams,
  OkxFill,
  OkxFundingRate,
  OkxFundingRateHistory,
  OkxInstType,
  OkxInstrument,
  OkxLeverageInfo,
  OkxMarginBalance,
  OkxMarginBalanceParams,
  OkxMarkPrice,
  OkxMarkPriceCandleRow,
  OkxOpenInterest,
  OkxOpenInterestHistoryRow,
  OkxOpenInterestVolumeRow,
  OkxOrder,
  OkxOrderAck,
  OkxPlaceAlgoParams,
  OkxPlaceOrderParams,
  OkxPosition,
  OkxResponse,
  OkxSetLeverageParams,
  OkxTicker,
  OkxTime,
} from './types.js';

export interface OkxRestClientOptions {
  baseUrl: string;
  /**
   * Where the signed requests (account, orders) go when that is not `baseUrl`: paper trading keeps the market
   * data on OKX and sends everything private to the local paper exchange. Nothing signed is sent to `baseUrl` then.
   */
  privateBaseUrl?: string | undefined;
  credentials?: OkxCredentials | undefined;
  /** Adds the `x-simulated-trading: 1` header for demo trading. */
  demo?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Optional clock offset (serverTime - localTime) in ms applied to signatures. */
  clockOffsetMs?: () => number;
}

type Query = Record<string, string | number | boolean | undefined>;

function buildQuery(q: Query | undefined): string {
  if (!q) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === '') continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/**
 * Thin typed wrapper over the OKX v5 REST API. Every method returns the `data`
 * array (or its first element) and throws OkxApiError on a non-zero code.
 */
export class OkxRestClient {
  private readonly baseUrl: string;
  private readonly privateBaseUrl: string;
  private readonly creds: OkxCredentials | undefined;
  private readonly demo: boolean;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly clockOffsetMs: () => number;

  constructor(opts: OkxRestClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.privateBaseUrl = (opts.privateBaseUrl ?? opts.baseUrl).replace(/\/+$/, '');
    this.creds = opts.credentials;
    this.demo = opts.demo ?? false;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.clockOffsetMs = opts.clockOffsetMs ?? (() => 0);
  }

  get hasCredentials(): boolean {
    return this.creds !== undefined;
  }

  /**
   * Low-level request. Throws OkxApiError when `code` is not '0', except for
   * batch endpoints (`batch: true`) where code '1' (all failed) and '2'
   * (partially succeeded) still carry per-item `sCode`/`sMsg` results that the
   * caller inspects.
   */
  async request<T>(method: 'GET' | 'POST', path: string, opts: { query?: Query; body?: unknown; auth?: boolean; batch?: boolean } = {}): Promise<OkxResponse<T>> {
    const requestPath = `${path}${buildQuery(opts.query)}`;
    const bodyText = method === 'POST' && opts.body !== undefined ? JSON.stringify(opts.body) : '';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.demo) headers['x-simulated-trading'] = '1';
    if (opts.auth) {
      if (!this.creds) throw new OkxApiError('NO_CREDENTIALS', 'this endpoint needs API credentials', requestPath);
      Object.assign(headers, restAuthHeaders(this.creds, method, requestPath, bodyText, Date.now() + this.clockOffsetMs()));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (method === 'POST') init.body = bodyText;
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(`${opts.auth ? this.privateBaseUrl : this.baseUrl}${requestPath}`, init);
      // The timer stays armed until the body is read: a response that stalls after its headers must time out too.
      text = await res.text();
    } catch (err) {
      if (controller.signal.aborted) throw new OkxTransportError(requestPath, `OKX did not answer within ${this.timeoutMs} ms`, true);
      const cause = (err as { cause?: { code?: unknown } }).cause;
      const reason = typeof cause?.code === 'string' ? cause.code : (err as Error).message;
      throw new OkxTransportError(requestPath, `could not reach OKX (${reason})`, false);
    } finally {
      clearTimeout(timer);
    }
    let json: OkxResponse<T>;
    try {
      json = JSON.parse(text) as OkxResponse<T>;
    } catch {
      throw new OkxHttpError(res.status, requestPath, text);
    }
    if (typeof json !== 'object' || json === null || typeof json.code !== 'string') {
      throw new OkxHttpError(res.status, requestPath, text);
    }
    const perItem = Array.isArray(json.data) && json.data.length > 0 && typeof (json.data[0] as { sCode?: unknown }).sCode === 'string';
    if (json.code !== '0' && !(opts.batch && perItem && (json.code === '1' || json.code === '2'))) {
      // Order endpoints return code '1' with per-item sCode/sMsg; surface the first item's message.
      const first = Array.isArray(json.data) ? (json.data[0] as { sCode?: string; sMsg?: string } | undefined) : undefined;
      const code = first?.sCode && first.sCode !== '0' ? first.sCode : json.code;
      const msg = first?.sMsg && first.sCode !== '0' ? first.sMsg : json.msg;
      throw new OkxApiError(code, msg || `HTTP ${res.status}`, requestPath, json.data);
    }
    if (!Array.isArray(json.data)) json.data = [];
    return json;
  }

  private async getData<T>(path: string, query?: Query, auth = false): Promise<T[]> {
    const q: { query?: Query; auth: boolean } = { auth };
    if (query !== undefined) q.query = query;
    return (await this.request<T>('GET', path, q)).data;
  }

  private async postData<T>(path: string, body: unknown, batch = false): Promise<T[]> {
    return (await this.request<T>('POST', path, { body, auth: true, batch })).data;
  }

  // ---- public ----

  async getTime(): Promise<number> {
    const [t] = await this.getData<OkxTime>('/api/v5/public/time');
    if (!t) throw new OkxApiError('EMPTY', 'no server time returned', '/api/v5/public/time');
    return Number(t.ts);
  }

  getInstruments(instType: OkxInstType, instId?: string): Promise<OkxInstrument[]> {
    return this.getData<OkxInstrument>('/api/v5/public/instruments', { instType, instId });
  }

  async getTicker(instId: string): Promise<OkxTicker> {
    const [t] = await this.getData<OkxTicker>('/api/v5/market/ticker', { instId });
    if (!t) throw new OkxApiError('EMPTY', `no ticker for ${instId}`, '/api/v5/market/ticker');
    return t;
  }

  getTickers(instType: OkxInstType): Promise<OkxTicker[]> {
    return this.getData<OkxTicker>('/api/v5/market/tickers', { instType });
  }

  async getBooks(instId: string, sz = 50): Promise<OkxBookData> {
    const [b] = await this.getData<OkxBookData>('/api/v5/market/books', { instId, sz });
    if (!b) throw new OkxApiError('EMPTY', `no book for ${instId}`, '/api/v5/market/books');
    return b;
  }

  /** Latest candles (up to 300), newest first. */
  getCandles(instId: string, bar: string, opts: { after?: number; before?: number; limit?: number } = {}): Promise<OkxCandleRow[]> {
    return this.getData<OkxCandleRow>('/api/v5/market/candles', { instId, bar, after: opts.after, before: opts.before, limit: opts.limit });
  }

  /** Older candles (up to 100 per call), newest first. */
  getHistoryCandles(instId: string, bar: string, opts: { after?: number; before?: number; limit?: number } = {}): Promise<OkxCandleRow[]> {
    return this.getData<OkxCandleRow>('/api/v5/market/history-candles', { instId, bar, after: opts.after, before: opts.before, limit: opts.limit });
  }

  /** Latest mark price candles (up to 100 per call), newest first: [ts, o, h, l, c, confirm]. */
  getMarkPriceCandles(instId: string, bar: string, opts: { after?: number; before?: number; limit?: number } = {}): Promise<OkxMarkPriceCandleRow[]> {
    return this.getData<OkxMarkPriceCandleRow>('/api/v5/market/mark-price-candles', { instId, bar, after: opts.after, before: opts.before, limit: opts.limit });
  }

  /** Older mark price candles (up to 100 per call), newest first. */
  getHistoryMarkPriceCandles(instId: string, bar: string, opts: { after?: number; before?: number; limit?: number } = {}): Promise<OkxMarkPriceCandleRow[]> {
    return this.getData<OkxMarkPriceCandleRow>('/api/v5/market/history-mark-price-candles', { instId, bar, after: opts.after, before: opts.before, limit: opts.limit });
  }

  getMarkPrice(instType: OkxInstType, instId?: string): Promise<OkxMarkPrice[]> {
    return this.getData<OkxMarkPrice>('/api/v5/public/mark-price', { instType, instId });
  }

  async getFundingRate(instId: string): Promise<OkxFundingRate> {
    const [f] = await this.getData<OkxFundingRate>('/api/v5/public/funding-rate', { instId });
    if (!f) throw new OkxApiError('EMPTY', `no funding rate for ${instId}`, '/api/v5/public/funding-rate');
    return f;
  }

  /** Settled funding records, newest first. OKX only keeps roughly the last three months. */
  getFundingRateHistory(instId: string, opts: { before?: number; after?: number; limit?: number } = {}): Promise<OkxFundingRateHistory[]> {
    return this.getData<OkxFundingRateHistory>('/api/v5/public/funding-rate-history', { instId, before: opts.before, after: opts.after, limit: opts.limit });
  }

  getOpenInterest(instType: OkxInstType, instId?: string): Promise<OkxOpenInterest[]> {
    return this.getData<OkxOpenInterest>('/api/v5/public/open-interest', { instType, instId });
  }

  /**
   * Aggregated open interest and volume history for a currency across OKX
   * contracts (trading statistics), newest first. `period` is 5m, 1H or 1D.
   */
  getOpenInterestVolume(ccy: string, period: '5m' | '1H' | '1D' = '1D', opts: { begin?: number; end?: number } = {}): Promise<OkxOpenInterestVolumeRow[]> {
    return this.getData<OkxOpenInterestVolumeRow>('/api/v5/rubik/stat/contracts/open-interest-volume', { ccy, period, begin: opts.begin, end: opts.end });
  }

  /**
   * Open interest history of one instrument (trading statistics), newest first, up to 100 rows.
   * `period` takes the candle bar names, including the UTC-aligned ones (`1Dutc`); plain `1D` is the UTC+8 day.
   * Rate limit: 5 requests per 2 seconds per IP.
   */
  getOpenInterestHistory(instId: string, period = '1Dutc', opts: { begin?: number; end?: number; limit?: number } = {}): Promise<OkxOpenInterestHistoryRow[]> {
    return this.getData<OkxOpenInterestHistoryRow>('/api/v5/rubik/stat/contracts/open-interest-history', { instId, period, begin: opts.begin, end: opts.end, limit: opts.limit });
  }

  // ---- account ----

  async getAccountConfig(): Promise<OkxAccountConfig> {
    const [c] = await this.getData<OkxAccountConfig>('/api/v5/account/config', undefined, true);
    if (!c) throw new OkxApiError('EMPTY', 'no account config returned', '/api/v5/account/config');
    return c;
  }

  async getBalance(ccy?: string): Promise<OkxBalance> {
    const [b] = await this.getData<OkxBalance>('/api/v5/account/balance', { ccy }, true);
    if (!b) throw new OkxApiError('EMPTY', 'no balance returned', '/api/v5/account/balance');
    return b;
  }

  getPositions(instType?: OkxInstType, instId?: string): Promise<OkxPosition[]> {
    return this.getData<OkxPosition>('/api/v5/account/positions', { instType, instId }, true);
  }

  setLeverage(params: OkxSetLeverageParams): Promise<OkxLeverageInfo[]> {
    return this.postData<OkxLeverageInfo>('/api/v5/account/set-leverage', params);
  }

  getLeverageInfo(instId: string, mgnMode: 'cross' | 'isolated'): Promise<OkxLeverageInfo[]> {
    return this.getData<OkxLeverageInfo>('/api/v5/account/leverage-info', { instId, mgnMode }, true);
  }

  /**
   * Adds margin to an isolated position from the available balance, or takes margin out of it. Taking margin out
   * raises the real leverage of the position; OKX refuses an amount beyond what the position can spare (59301),
   * a position that does not exist (59300) and an adjustment while an order that closes the position rests (59302).
   */
  async adjustMargin(params: OkxMarginBalanceParams): Promise<OkxMarginBalance> {
    const [r] = await this.postData<OkxMarginBalance>('/api/v5/account/position/margin-balance', params);
    if (!r) throw new OkxApiError('EMPTY', 'no margin adjustment returned', '/api/v5/account/position/margin-balance');
    return r;
  }

  // ---- trade ----

  async placeOrder(params: OkxPlaceOrderParams): Promise<OkxOrderAck> {
    const [ack] = await this.postData<OkxOrderAck>('/api/v5/trade/order', params);
    if (!ack) throw new OkxApiError('EMPTY', 'no order ack returned', '/api/v5/trade/order');
    if (ack.sCode !== '0') throw new OkxApiError(ack.sCode, ack.sMsg, '/api/v5/trade/order', ack);
    return ack;
  }

  async cancelOrder(params: OkxCancelOrderParams): Promise<OkxOrderAck> {
    const [ack] = await this.postData<OkxOrderAck>('/api/v5/trade/cancel-order', params);
    if (!ack) throw new OkxApiError('EMPTY', 'no cancel ack returned', '/api/v5/trade/cancel-order');
    if (ack.sCode !== '0') throw new OkxApiError(ack.sCode, ack.sMsg, '/api/v5/trade/cancel-order', ack);
    return ack;
  }

  /** Up to 20 orders per call. Per-item results are returned; items with sCode != '0' failed (never throws on partial failure). */
  cancelBatchOrders(params: OkxCancelOrderParams[]): Promise<OkxOrderAck[]> {
    return this.postData<OkxOrderAck>('/api/v5/trade/cancel-batch-orders', params, true);
  }

  /** Up to 20 orders per call. Per-item results are returned; items with sCode != '0' were rejected. */
  placeBatchOrders(params: OkxPlaceOrderParams[]): Promise<OkxOrderAck[]> {
    return this.postData<OkxOrderAck>('/api/v5/trade/batch-orders', params, true);
  }

  async amendOrder(params: OkxAmendOrderParams): Promise<OkxOrderAck> {
    const [ack] = await this.postData<OkxOrderAck>('/api/v5/trade/amend-order', params);
    if (!ack) throw new OkxApiError('EMPTY', 'no amend ack returned', '/api/v5/trade/amend-order');
    if (ack.sCode !== '0') throw new OkxApiError(ack.sCode, ack.sMsg, '/api/v5/trade/amend-order', ack);
    return ack;
  }

  /**
   * Untriggered algo orders, newest first, up to 100 per call; `after` pages to the ones older than that algoId.
   * `ordType` is required; `conditional,oco` (the two TP/SL types) is the only combination OKX accepts in one call.
   */
  getAlgoOrdersPending(params: { ordType: string; instType?: OkxInstType; instId?: string; algoId?: string; after?: string; limit?: number }): Promise<OkxAlgoOrder[]> {
    return this.getData<OkxAlgoOrder>('/api/v5/trade/orders-algo-pending', params, true);
  }

  /** Places a TP/SL algo order of its own (not attached to an order). */
  async placeAlgoOrder(params: OkxPlaceAlgoParams): Promise<OkxAlgoAck> {
    const [ack] = await this.postData<OkxAlgoAck>('/api/v5/trade/order-algo', params);
    if (!ack) throw new OkxApiError('EMPTY', 'no algo order ack returned', '/api/v5/trade/order-algo');
    if (ack.sCode !== '0') throw new OkxApiError(ack.sCode, ack.sMsg, '/api/v5/trade/order-algo', ack);
    return ack;
  }

  /** Cancels one untriggered algo order (the endpoint takes an array of up to 10; one is sent). */
  async cancelAlgoOrder(params: OkxCancelAlgoParams): Promise<OkxAlgoAck> {
    const [ack] = await this.postData<OkxAlgoAck>('/api/v5/trade/cancel-algos', [params]);
    if (!ack) throw new OkxApiError('EMPTY', 'no cancel ack returned', '/api/v5/trade/cancel-algos');
    if (ack.sCode !== '0') throw new OkxApiError(ack.sCode, ack.sMsg, '/api/v5/trade/cancel-algos', ack);
    return ack;
  }

  /** Amends an untriggered TP/SL or trigger algo order. */
  async amendAlgoOrder(params: OkxAmendAlgoParams): Promise<OkxAlgoAck> {
    const [ack] = await this.postData<OkxAlgoAck>('/api/v5/trade/amend-algos', params);
    if (!ack) throw new OkxApiError('EMPTY', 'no amend ack returned', '/api/v5/trade/amend-algos');
    if (ack.sCode !== '0') throw new OkxApiError(ack.sCode, ack.sMsg, '/api/v5/trade/amend-algos', ack);
    return ack;
  }

  closePosition(params: OkxClosePositionParams): Promise<{ instId: string; posSide: string; clOrdId: string; tag: string }[]> {
    return this.postData('/api/v5/trade/close-position', params);
  }

  async getOrder(params: { instId: string; ordId?: string; clOrdId?: string }): Promise<OkxOrder> {
    const [o] = await this.getData<OkxOrder>('/api/v5/trade/order', params, true);
    if (!o) throw new OkxApiError('EMPTY', 'order not found', '/api/v5/trade/order');
    return o;
  }

  getOrdersPending(params: { instType?: OkxInstType; instId?: string; limit?: number } = {}): Promise<OkxOrder[]> {
    return this.getData<OkxOrder>('/api/v5/trade/orders-pending', params, true);
  }

  /** Last 7 days. Newest first. */
  getOrdersHistory(params: { instType: OkxInstType; instId?: string; limit?: number; after?: string; before?: string }): Promise<OkxOrder[]> {
    return this.getData<OkxOrder>('/api/v5/trade/orders-history', params, true);
  }

  /** Last 3 days. Newest first. */
  getFills(params: { instType?: OkxInstType; instId?: string; limit?: number; after?: string; before?: string } = {}): Promise<OkxFill[]> {
    return this.getData<OkxFill>('/api/v5/trade/fills', params, true);
  }
}
