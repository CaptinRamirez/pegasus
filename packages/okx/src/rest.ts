import { OkxApiError, OkxHttpError } from './errors.js';
import { restAuthHeaders, type OkxCredentials } from './sign.js';
import type {
  OkxAccountConfig,
  OkxAmendOrderParams,
  OkxBalance,
  OkxBookData,
  OkxCancelOrderParams,
  OkxCandleRow,
  OkxClosePositionParams,
  OkxFill,
  OkxFundingRate,
  OkxInstType,
  OkxInstrument,
  OkxLeverageInfo,
  OkxMarkPrice,
  OkxOrder,
  OkxOrderAck,
  OkxPlaceOrderParams,
  OkxPosition,
  OkxResponse,
  OkxSetLeverageParams,
  OkxTicker,
  OkxTime,
} from './types.js';

export interface OkxRestClientOptions {
  baseUrl: string;
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
  private readonly creds: OkxCredentials | undefined;
  private readonly demo: boolean;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly clockOffsetMs: () => number;

  constructor(opts: OkxRestClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
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
    try {
      res = await this.fetchImpl(`${this.baseUrl}${requestPath}`, init);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
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

  getMarkPrice(instType: OkxInstType, instId?: string): Promise<OkxMarkPrice[]> {
    return this.getData<OkxMarkPrice>('/api/v5/public/mark-price', { instType, instId });
  }

  async getFundingRate(instId: string): Promise<OkxFundingRate> {
    const [f] = await this.getData<OkxFundingRate>('/api/v5/public/funding-rate', { instId });
    if (!f) throw new OkxApiError('EMPTY', `no funding rate for ${instId}`, '/api/v5/public/funding-rate');
    return f;
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
