import type {
  AccountConfig,
  AlgoOrderList,
  AmendAlgoOrderRequest,
  Balance,
  Candle,
  CancelAlgoOrderRequest,
  CancelAllRequest,
  CampaignLogPage,
  CampaignReplayView,
  CampaignSignalsResponse,
  CampaignView,
  ChannelTrailingEntry,
  ClearChannelTrailingRequest,
  CancelOrderRequest,
  CandlesQuery,
  ClosePositionRequest,
  ConnectionStatus,
  Fill,
  FillsQuery,
  Instrument,
  JournalPage,
  JournalTrade,
  KillSwitchRequest,
  Lang,
  OrdType,
  Order,
  OrderBook,
  OrderPreview,
  OrdersHistoryQuery,
  PlaceOrderRequest,
  PlaceStopRequest,
  PlaceTakeProfitsRequest,
  PlaceTakeProfitsResult,
  PlaceTrailingStopRequest,
  PlaceTrailingStopResult,
  PosSide,
  Position,
  RiskCheckResult,
  RiskConfig,
  RiskState,
  SetChannelTrailingRequest,
  SetLeverageRequest,
  Side,
  SignalsResponse,
  TdMode,
  Ticker,
  TradeSource,
  TradeStatus,
  TrailingView,
} from '@pegasus/shared';
import { ApiError, http } from './http';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * A reply of the right shape, or a failure: an API that does not know the route, or something else answering it, must
 * not put another object on screen.
 */
async function shaped<T>(reply: Promise<unknown>, valid: (v: Record<string, unknown>) => boolean, what: string): Promise<T> {
  const v = await reply;
  if (!isObject(v) || !valid(v)) throw new ApiError('INTERNAL', `the API's answer is not ${what}`, undefined, 200);
  return v as T;
}

export type { OrderPreview };

export interface HealthResponse {
  ok: true;
  demo: boolean;
  paper: boolean;
  connection: ConnectionStatus;
  serverTime: number;
}

export interface AccountResponse {
  config: AccountConfig | null;
  balance: Balance | null;
}

export interface LeverageInfo {
  instId: string;
  mgnMode: TdMode;
  posSide: PosSide;
  lever: string;
}

export interface PlaceOrderResponse {
  order: Order;
  preview: OrderPreview;
}

export interface RiskResponse {
  config: RiskConfig;
  state: RiskState;
}

/** Type alias (not interface) so it satisfies the http QueryParams index signature. */
export type SignalsQuery = {
  instId?: string;
  /** Equity used for sizing; the server falls back to the account's total equity */
  equity?: string;
  riskPct?: string;
  maxNotionalPct?: string;
  /** Language of the reasons and sizing notes the server writes; English when absent */
  lang?: Lang;
};

/** GET /api/campaign/signals: `riskPct` a fraction below 1 (the server's default 0.01); `equity` the account's total equity when absent. */
export type CampaignSignalsQuery = {
  riskPct?: string;
  equity?: string;
};

/** GET /api/journal: every filter optional; `before` is the `next` of the page before (a trade's seq); `limit` 1 to 200, default 50. */
export type JournalQuery = {
  status?: TradeStatus;
  instId?: string;
  source?: TradeSource;
  before?: number;
  limit?: number;
};

/** POST /api/positions/channel-trailing/clear */
export interface ClearChannelTrailingResult {
  instId: string;
  mgnMode: TdMode;
  posSide: PosSide;
  cleared: boolean;
}

/** GET /api/campaign/log: `before` is the `next` of the page before (a step's seq); the server's limit is 1 to 100. */
export type CampaignLogQuery = {
  before?: number;
  limit?: number;
};

export const api = {
  health: () => http<HealthResponse>('/api/health'),
  instruments: (token?: string) =>
    http<Instrument[]>('/api/instruments', token === undefined ? {} : { token }),
  account: () => http<AccountResponse>('/api/account'),
  leverage: (instId: string, mgnMode: TdMode) =>
    http<LeverageInfo[]>('/api/account/leverage', { query: { instId, mgnMode } }),
  setLeverage: (body: SetLeverageRequest) => http<LeverageInfo[]>('/api/account/leverage', { body }),
  positions: () => http<Position[]>('/api/positions'),
  closePosition: (body: ClosePositionRequest) =>
    http<{ instId: string; posSide: PosSide }>('/api/positions/close', { body }),
  openOrders: () => http<Order[]>('/api/orders/open'),
  orderHistory: (query: OrdersHistoryQuery) => http<Order[]>('/api/orders/history', { query }),
  fills: (query: FillsQuery) => http<Fill[]>('/api/fills', { query }),
  previewOrder: (body: PlaceOrderRequest, signal?: AbortSignal) =>
    http<OrderPreview>('/api/orders/preview', { body, signal }),
  placeOrder: (body: PlaceOrderRequest) => http<PlaceOrderResponse>('/api/orders', { body }),
  cancelOrder: (body: CancelOrderRequest) =>
    http<{ ordId: string; clOrdId: string }>('/api/orders/cancel', { body }),
  cancelAll: (body: CancelAllRequest) => http<{ canceled: number }>('/api/orders/cancel-all', { body }),
  /** A fresh read of the stop-loss / take-profit algo orders from the exchange. */
  algoOrders: () => http<AlgoOrderList>('/api/algo-orders'),
  placeStop: (body: PlaceStopRequest) => http<{ algoId: string; instId: string; slTriggerPx: string; sz: string }>('/api/algo-orders', { body }),
  amendAlgoOrder: (body: AmendAlgoOrderRequest) =>
    http<{ algoId: string; instId: string; slTriggerPx: string; previous: string }>('/api/algo-orders/amend', { body }),
  cancelAlgoOrder: (body: CancelAlgoOrderRequest) => http<{ algoId: string; instId: string }>('/api/algo-orders/cancel', { body }),
  candles: (query: CandlesQuery) => http<Candle[]>('/api/candles', { query }),
  book: (instId: string) => http<OrderBook>('/api/book', { query: { instId } }),
  ticker: (instId: string) => http<Ticker>('/api/ticker', { query: { instId } }),
  risk: () => http<RiskResponse>('/api/risk'),
  setKillSwitch: (body: KillSwitchRequest) => http<RiskState>('/api/risk/kill-switch', { body }),
  signals: (query: SignalsQuery = {}) => http<SignalsResponse>('/api/signals', { query }),
  /** The campaign's state; also pushed as the `campaign` message while the campaign is enabled. */
  campaign: () => http<CampaignView>('/api/campaign'),
  campaignLog: (query: CampaignLogQuery = {}) => http<CampaignLogPage>('/api/campaign/log', { query }),
  /** The replay beside the pot; an API without the route answers NOT_FOUND (404). */
  campaignReplay: () => http<CampaignReplayView>('/api/campaign/replay'),
  /** The campaign rule read per coin, each entry or add with a plan to follow it by hand. */
  campaignSignals: (query: CampaignSignalsQuery = {}) =>
    shaped<CampaignSignalsResponse>(http<unknown>('/api/campaign/signals', { query }), (v) => Array.isArray(v['rows']) && isObject(v['params']) && isObject(v['campaign']), 'a signals report'),
  /** The trade journal, newest first, without fills and timeline. */
  journal: (query: JournalQuery = {}) => shaped<JournalPage>(http<unknown>('/api/journal', { query }), (v) => Array.isArray(v['trades']) && typeof v['status'] === 'string', 'a journal page'),
  /** One trade with its fills and timeline; TRADE_NOT_FOUND (404) for an id the journal does not have. */
  journalTrade: (id: string) =>
    shaped<JournalTrade>(http<unknown>(`/api/journal/${encodeURIComponent(id)}`), (v) => typeof v['id'] === 'string' && Array.isArray(v['timeline']) && Array.isArray(v['fills']), 'a trade'),
  /** Channel trailing and whether exits are offered at all (403 EXITS_UNAVAILABLE where they are not). */
  trailing: () => shaped<TrailingView>(http<unknown>('/api/trailing'), (v) => typeof v['enabled'] === 'boolean' && Array.isArray(v['entries']), 'the trailing view'),
  placeTakeProfits: (body: PlaceTakeProfitsRequest) => http<PlaceTakeProfitsResult>('/api/positions/take-profits', { body }),
  placeTrailingStop: (body: PlaceTrailingStopRequest) => http<PlaceTrailingStopResult>('/api/positions/trailing-stop', { body }),
  setChannelTrailing: (body: SetChannelTrailingRequest) => http<ChannelTrailingEntry>('/api/positions/channel-trailing', { body }),
  clearChannelTrailing: (body: ClearChannelTrailingRequest) => http<ClearChannelTrailingResult>('/api/positions/channel-trailing/clear', { body }),
};
