import type {
  AccountConfig,
  Balance,
  Candle,
  CancelAllRequest,
  CancelOrderRequest,
  CandlesQuery,
  ClosePositionRequest,
  ConnectionStatus,
  Fill,
  FillsQuery,
  Instrument,
  InstrumentSignalReport,
  KillSwitchRequest,
  OrdType,
  Order,
  OrderBook,
  OrderPreview,
  OrdersHistoryQuery,
  PlaceOrderRequest,
  PosSide,
  Position,
  RiskCheckResult,
  RiskConfig,
  RiskState,
  SetLeverageRequest,
  Side,
  TdMode,
  Ticker,
} from '@pegasus/shared';
import { http } from './http';

export type { OrderPreview };

export interface HealthResponse {
  ok: true;
  demo: boolean;
  connection: ConnectionStatus;
  serverTime: number;
}

export interface AccountResponse {
  config: AccountConfig;
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
};

export interface SignalReportError {
  instId: string;
  error: { code: string; message: string };
}

export type SignalReportRow = InstrumentSignalReport | SignalReportError;

export interface SignalsResponse {
  generatedAt: number;
  equity: string | null;
  reports: SignalReportRow[];
}

export function isSignalReportError(row: SignalReportRow): row is SignalReportError {
  return 'error' in row;
}

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
  candles: (query: CandlesQuery) => http<Candle[]>('/api/candles', { query }),
  book: (instId: string) => http<OrderBook>('/api/book', { query: { instId } }),
  ticker: (instId: string) => http<Ticker>('/api/ticker', { query: { instId } }),
  risk: () => http<RiskResponse>('/api/risk'),
  setKillSwitch: (body: KillSwitchRequest) => http<RiskState>('/api/risk/kill-switch', { body }),
  signals: (query: SignalsQuery = {}) => http<SignalsResponse>('/api/signals', { query }),
};
