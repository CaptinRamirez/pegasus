import type {
  AccountConfig,
  AlgoOrderList,
  Balance,
  CampaignView,
  Candle,
  CandleBar,
  ConnectionStatus,
  Fill,
  FundingRate,
  InstId,
  Instrument,
  JournalStatus,
  JournalStatusReason,
  JournalTradeSummary,
  MarkPrice,
  OrdType,
  Order,
  OrderBook,
  PosSide,
  Position,
  RiskConfig,
  RiskState,
  Side,
  SizeUnit,
  TdMode,
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

/**
 * Where a toast leads: the trade journal's record of the position an order went into. The journal hears of the
 * trade after the order, so the trade is looked up when the link is followed: the trade of that instrument, margin
 * mode and leg.
 */
export interface ToastLink {
  kind: 'journal';
  instId: InstId;
  mgnMode: TdMode;
  posSide: PosSide;
  ordId: string;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  /** The text as it was pushed: in the language of the page at that time, or the English one when `zh` is set */
  message: string;
  /** The Chinese text of a message that was pushed in both languages; shown instead of `message` while the page is in Chinese */
  zh?: string;
  ts: number;
  /** Never dropped to make room for newer toasts (the lost-stop notice) */
  sticky?: true;
  /** A link shown under the text */
  link?: ToastLink;
}

export interface TicketPrice {
  px: string;
  /** Changes on every click so the same price can be re-applied */
  nonce: number;
}

/** A whole order ticket filled from elsewhere (e.g. a signal row); the instrument is selected with it. */
export interface TicketPrefill {
  instId: InstId;
  side: Side;
  ordType: OrdType;
  px: string;
  sizeValue: string;
  sizeUnit: SizeUnit;
  /** Stop-loss trigger to attach to the order; absent for none */
  slTriggerPx?: string;
  /** Changes on every apply so the same prefill can be re-applied */
  nonce: number;
}

export type TicketPrefillInput = Omit<TicketPrefill, 'nonce'>;

/** A coin and a side put into the order ticket, which takes the focus; nothing else is filled (manual open from the signals tab). */
export interface TicketFocus {
  instId: InstId;
  side: Side;
  /** Changes on every request so the same focus can be asked for again */
  nonce: number;
}

export interface TerminalState {
  token: string | null;
  demo: boolean;
  /** Paper trading: orders and positions are simulated on OKX's live prices */
  paper: boolean;
  instruments: Instrument[];
  account: AccountConfig | null;
  riskConfig: RiskConfig | null;
  serverTime: number | null;
  /** Incremented on every hello (initial connect and each reconnect) */
  helloSeq: number;
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
  /** Stop-loss / take-profit algo orders as the server last read them from the exchange; null until it has read them once */
  algoOrders: AlgoOrderList | null;
  balance: Balance | null;
  /** Whether the server had the account loaded when it last sent its whole state; an empty list means a flat account only then */
  accountLoaded: boolean;
  risk: RiskState | null;
  /** What the server last said about its exchange connections; null while the socket to the server is not open */
  connection: ConnectionStatus | null;
  /** Local time `connection` was received */
  connectionAt: number | null;
  /** Local time the server first reported its OKX account stream as not connected; null while it is connected or unknown */
  privateDownSince: number | null;
  wsStatus: WsStatus;
  /** Local time the socket to the server stopped being open (or first tried to connect); null while it is open */
  wsDownSince: number | null;
  /** Local time of the last message from the server over the socket (HTTP replies do not count); null until the first one */
  lastMessageAt: number | null;
  toasts: Toast[];
  nextToastId: number;
  /** ordIds whose missing stop-loss the trader was already told about: one notice per order, not one per push */
  lostStopNotified: string[];
  ticketPrice: TicketPrice | null;
  ticketPrefill: TicketPrefill | null;
  ticketFocus: TicketFocus | null;
  /** The campaign's state, from the `campaign` message or GET /api/campaign, the newer of the two; null until either came */
  campaign: CampaignView | null;
  /** The trade journal as the `journal` messages left it; null until the first one came */
  journal: JournalSlice | null;
}

/**
 * What the `journal` messages said: the journal's status and the trades they carried, by id, each the newest version
 * seen (at most LIMITS.journalTrades, the most recently changed). GET /api/journal gives the rest.
 */
export interface JournalSlice {
  status: JournalStatus;
  reason: JournalStatusReason | null;
  trades: Record<string, JournalTradeSummary>;
  /** Server time of the last message */
  serverTime: number;
}

export const LIMITS = {
  trades: 60,
  orderHistory: 50,
  fills: 100,
  candles: 600,
  toasts: 6,
  lostStopNotified: 200,
  journalTrades: 200,
} as const;

export const DEFAULT_BAR: CandleBar = '5m';

export function emptyMarket(): MarketData {
  return { ticker: null, book: null, trades: [], candles: {}, markPrice: null, fundingRate: null };
}

export function initialState(token: string | null): TerminalState {
  return {
    token,
    demo: true,
    paper: false,
    instruments: [],
    account: null,
    riskConfig: null,
    serverTime: null,
    helloSeq: 0,
    selectedInstId: null,
    bar: DEFAULT_BAR,
    market: {},
    orders: {},
    orderHistory: [],
    fills: [],
    positions: [],
    algoOrders: null,
    balance: null,
    accountLoaded: false,
    risk: null,
    connection: null,
    connectionAt: null,
    privateDownSince: null,
    wsStatus: 'closed',
    wsDownSince: null,
    lastMessageAt: null,
    toasts: [],
    nextToastId: 1,
    lostStopNotified: [],
    ticketPrice: null,
    ticketPrefill: null,
    ticketFocus: null,
    campaign: null,
    journal: null,
  };
}
