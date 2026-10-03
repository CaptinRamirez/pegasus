/**
 * Domain model shared by the API server and the web terminal.
 * Every numeric quantity (price, size, PnL, equity, rate) is a decimal string.
 * Timestamps are epoch milliseconds as numbers.
 */

export type InstId = string;
export type Side = 'buy' | 'sell';
export type PosSide = 'long' | 'short' | 'net';
export type TdMode = 'cross' | 'isolated';
export type OrdType = 'market' | 'limit' | 'post_only' | 'fok' | 'ioc';
export type OrderState = 'live' | 'partially_filled' | 'filled' | 'canceled';
export type PosMode = 'net_mode' | 'long_short_mode';
export type CtType = 'linear' | 'inverse';
export type InstState = 'live' | 'suspend' | 'preopen' | 'test';

export type CandleBar =
  | '1m' | '3m' | '5m' | '15m' | '30m'
  | '1H' | '2H' | '4H' | '6H' | '12H'
  | '1D' | '1W';

export const CANDLE_BARS: readonly CandleBar[] = [
  '1m', '3m', '5m', '15m', '30m', '1H', '2H', '4H', '6H', '12H', '1D', '1W',
] as const;

export interface Instrument {
  instId: InstId;
  instType: 'SWAP';
  /** Underlying, e.g. BTC-USDT */
  uly: string;
  /** Base currency, e.g. BTC */
  baseCcy: string;
  /** Quote currency, e.g. USDT */
  quoteCcy: string;
  /** Settlement currency, e.g. USDT (linear) or BTC (inverse) */
  settleCcy: string;
  /** Contract value, in ctValCcy, e.g. "0.01" BTC for BTC-USDT-SWAP, "100" USD for BTC-USD-SWAP */
  ctVal: string;
  ctValCcy: string;
  ctMult: string;
  ctType: CtType;
  /** Size increment in contracts */
  lotSz: string;
  /** Minimum order size in contracts */
  minSz: string;
  /** Price increment */
  tickSz: string;
  /** Max limit order size in contracts */
  maxLmtSz: string;
  /** Max market order size in contracts */
  maxMktSz: string;
  /** Maximum leverage offered by the exchange */
  maxLever: string;
  state: InstState;
}

export interface Ticker {
  instId: InstId;
  last: string;
  lastSz: string;
  bidPx: string;
  bidSz: string;
  askPx: string;
  askSz: string;
  open24h: string;
  high24h: string;
  low24h: string;
  /** 24h volume in contracts */
  vol24h: string;
  /** 24h volume in base/quote ccy as reported by the exchange */
  volCcy24h: string;
  ts: number;
}

/** [price, size in contracts] */
export type BookLevel = readonly [px: string, sz: string];

export interface OrderBook {
  instId: InstId;
  /** Best bid first */
  bids: BookLevel[];
  /** Best ask first */
  asks: BookLevel[];
  ts: number;
  seqId?: number;
}

export interface Trade {
  instId: InstId;
  tradeId: string;
  px: string;
  /** Size in contracts */
  sz: string;
  side: Side;
  ts: number;
}

export interface Candle {
  /** Open time, epoch ms */
  ts: number;
  open: string;
  high: string;
  low: string;
  close: string;
  /** Volume in contracts */
  vol: string;
  /** Volume in currency as reported by the exchange */
  volCcy: string;
  /** true once the candle is closed */
  confirm: boolean;
}

export interface MarkPrice {
  instId: InstId;
  markPx: string;
  ts: number;
}

export interface FundingRate {
  instId: InstId;
  fundingRate: string;
  nextFundingRate: string;
  fundingTime: number;
  nextFundingTime: number;
}

export interface Order {
  ordId: string;
  clOrdId: string;
  instId: InstId;
  side: Side;
  posSide: PosSide;
  tdMode: TdMode;
  ordType: OrdType;
  /** Limit price; empty string for market orders */
  px: string;
  /** Size in contracts */
  sz: string;
  /** Accumulated filled size in contracts */
  accFillSz: string;
  /** Average fill price; empty string until filled */
  avgPx: string;
  state: OrderState;
  reduceOnly: boolean;
  lever: string;
  fee: string;
  feeCcy: string;
  pnl: string;
  cTime: number;
  uTime: number;
}

export interface Fill {
  tradeId: string;
  ordId: string;
  clOrdId: string;
  instId: InstId;
  side: Side;
  posSide: PosSide;
  fillPx: string;
  /** Filled size in contracts */
  fillSz: string;
  fee: string;
  feeCcy: string;
  /** 'T' taker or 'M' maker */
  execType: 'T' | 'M' | '';
  ts: number;
}

export interface Position {
  instId: InstId;
  posSide: PosSide;
  mgnMode: TdMode;
  /** Position size in contracts. In net mode negative means short. */
  pos: string;
  avgPx: string;
  markPx: string;
  /** Unrealised PnL */
  upl: string;
  uplRatio: string;
  lever: string;
  liqPx: string;
  margin: string;
  notionalUsd: string;
  cTime: number;
  uTime: number;
}

export interface BalanceDetail {
  ccy: string;
  eq: string;
  availEq: string;
  cashBal: string;
  upl: string;
}

export interface Balance {
  /** Total equity in USD */
  totalEq: string;
  details: BalanceDetail[];
  ts: number;
}

export interface AccountConfig {
  posMode: PosMode;
  acctLv: string;
}

export interface RiskConfig {
  /** Max USD notional of a single order */
  maxOrderNotional: string;
  /** Max USD notional of the position in one instrument (after the order fills) */
  maxPositionNotionalPerInstrument: string;
  /** Max USD notional across all positions (after the order fills) */
  maxTotalPositionNotional: string;
  maxLeverage: string;
  /** Daily loss (realised + unrealised, from 00:00 UTC) that trips the kill switch, in USD */
  dailyLossLimit: string;
  maxOpenOrders: number;
  /** Limit price must be within this fraction of the mark price */
  priceBandPct: string;
  /** Market orders whose estimated slippage exceeds this fraction are rejected */
  maxSlippagePct: string;
}

export interface RiskState {
  /** True when trading is halted (manually or by the daily loss limit) */
  killSwitch: boolean;
  killSwitchReason: string;
  /** Start of the current UTC day, epoch ms */
  dayStartTs: number;
  /** Total equity observed at the start of the day (or when the server started) */
  dayStartEquity: string;
  currentEquity: string;
  /** currentEquity - dayStartEquity */
  dailyPnl: string;
  openOrders: number;
  totalPositionNotional: string;
  updatedAt: number;
}

export type ConnState = 'connected' | 'connecting' | 'disconnected';

export interface ConnectionStatus {
  okxPublic: ConnState;
  okxPrivate: ConnState;
  okxBusiness: ConnState;
  demo: boolean;
  /** Milliseconds since the last message from the exchange on any socket */
  lastMessageAgeMs: number;
}

export interface RiskCheckResult {
  ok: boolean;
  /** Machine readable reason, e.g. 'KILL_SWITCH', 'MAX_ORDER_NOTIONAL' */
  code: string;
  message: string;
  /** Diagnostic values the UI can show */
  details?: Record<string, string | number | boolean>;
}

/** Response of POST /api/orders/preview: the exchange-ready order plus the risk verdict. */
export interface OrderPreview {
  instId: InstId;
  side: Side;
  ordType: OrdType;
  tdMode: TdMode;
  posSide: PosSide;
  /** Exchange-ready size in contracts */
  sz: string;
  /** Base coin equivalent of sz */
  coin: string;
  /** Normalised limit price; '' for market orders */
  px: string;
  /** Price used for notional and coin/quote conversions */
  refPrice: string;
  /** USD(T) notional of this order */
  notionalQuote: string;
  /** Estimated slippage for market orders from the order book; '' otherwise */
  estSlippagePct: string;
  /** Leverage currently configured for the instrument/mode */
  lever: string;
  /** ok=false means the order would be rejected */
  risk: RiskCheckResult;
}
