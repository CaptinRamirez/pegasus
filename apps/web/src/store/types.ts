import type {
  AccountConfig,
  Balance,
  Candle,
  CandleBar,
  ConnectionStatus,
  Fill,
  FundingRate,
  InstId,
  Instrument,
  MarkPrice,
  Order,
  OrderBook,
  Position,
  RiskConfig,
  RiskState,
  Ticker,
  Trade,
} from '@pegasus/shared';
import type { WsStatus } from '../lib/ws';

export interface MarketData {
  ticker: Ticker | null;
  book: OrderBook | null;
  /** Newest first */
  trades: Trade[];
  /** Candles of the currently selected bar, keyed by open time (epoch ms) */
  candles: Record<number, Candle>;
  markPrice: MarkPrice | null;
  fundingRate: FundingRate | null;
}

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  ts: number;
}

export interface TicketPrice {
  px: string;
  /** Changes on every click so the same price can be re-applied */
  nonce: number;
}

export interface TerminalState {
  token: string | null;
  demo: boolean;
  instruments: Instrument[];
  account: AccountConfig | null;
  riskConfig: RiskConfig | null;
  serverTime: number | null;
  selectedInstId: InstId | null;
  bar: CandleBar;
  market: Record<InstId, MarketData>;
  /** Open orders by ordId */
  orders: Record<string, Order>;
  /** Terminal orders (filled/canceled), newest first, capped */
  orderHistory: Order[];
  /** Newest first, capped */
  fills: Fill[];
  positions: Position[];
  balance: Balance | null;
  risk: RiskState | null;
  connection: ConnectionStatus | null;
  wsStatus: WsStatus;
  toasts: Toast[];
  nextToastId: number;
  ticketPrice: TicketPrice | null;
}

export const LIMITS = {
  trades: 60,
  orderHistory: 50,
  fills: 100,
  candles: 600,
  toasts: 6,
} as const;

export const DEFAULT_BAR: CandleBar = '5m';

export function emptyMarket(): MarketData {
  return { ticker: null, book: null, trades: [], candles: {}, markPrice: null, fundingRate: null };
}

export function initialState(token: string | null): TerminalState {
  return {
    token,
    demo: true,
    instruments: [],
    account: null,
    riskConfig: null,
    serverTime: null,
    selectedInstId: null,
    bar: DEFAULT_BAR,
    market: {},
    orders: {},
    orderHistory: [],
    fills: [],
    positions: [],
    balance: null,
    risk: null,
    connection: null,
    wsStatus: 'closed',
    toasts: [],
    nextToastId: 1,
    ticketPrice: null,
  };
}
