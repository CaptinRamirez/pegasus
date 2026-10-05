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
  CampaignView,
  CancelOrderRequest,
  CandlesQuery,
  ClosePositionRequest,
  ConnectionStatus,
  Fill,
  FillsQuery,
  Instrument,
  KillSwitchRequest,
  Lang,
  OrdType,
  Order,
  OrderBook,
  OrderPreview,
  OrdersHistoryQuery,
  PlaceOrderRequest,
  PlaceStopRequest,
  PosSide,
  Position,
  RiskCheckResult,
  RiskConfig,
  RiskState,
  SetLeverageRequest,
  Side,
  SignalsResponse,
  TdMode,
  Ticker,
} from '@pegasus/shared';
import { http } from './http';

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
};
