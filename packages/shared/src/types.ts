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
  /**
   * Trigger price of the stop-loss attached to the order (mark-triggered, market execution); absent when none. Not persisted.
   * The exchange generates the stop only once the order is completely filled (see stopAwaitsFullFill, stopUnconfirmedAfterCancel).
   */
  slTriggerPx?: string;
  /** Why the exchange did not create the stop-loss attached to the order ('<failCode>: <failReason>'): the position has no stop. Absent when the stop exists or none was attached. Not persisted. */
  slFailReason?: string;
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
  /** Posted margin (isolated) or initial margin requirement (cross); '' when the exchange reports neither */
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
  /** False when the API key lacks OKX's trade permission (a read-only key): the API refuses every write with READ_ONLY_KEY */
  canTrade: boolean;
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

/**
 * The cancel-all sweep the kill switch starts. idle: the switch is off; pending: running or waiting for a retry;
 * done: no open order is left; failed: given up (the key was rejected or lacks the permission);
 * skipped: not attempted (read-only key, no API key).
 */
export type CancelSweepState = 'idle' | 'pending' | 'done' | 'failed' | 'skipped';

export interface CancelSweep {
  state: CancelSweepState;
  /** Display text, e.g. "open orders cancelled" or "cancel failed: <reason>, retrying in 10 s"; '' when idle */
  message: string;
  /** When the state or message last changed, epoch ms */
  ts: number;
}

export interface RiskState {
  /** True when trading is halted (manually or by the daily loss limit) */
  killSwitch: boolean;
  killSwitchReason: string;
  /** Only its completion is persisted: after a restart with the switch on the sweep runs again unless it had reached done */
  cancelSweep: CancelSweep;
  /** Start of the current UTC day, epoch ms */
  dayStartTs: number;
  /** The day's baseline: the first total equity observed this UTC day, or the equity at a later rebase */
  dayStartEquity: string;
  /** When dayStartEquity was taken, epoch ms; 0 while there is none. Later than dayStartTs when the server was not running at 00:00 UTC or the baseline was rebased */
  baselineTs: number;
  currentEquity: string;
  /** currentEquity - dayStartEquity */
  dailyPnl: string;
  openOrders: number;
  totalPositionNotional: string;
  /**
   * Instruments whose open position has outgrown maxPositionNotionalPerInstrument (a position grows with price;
   * the limit is otherwise only checked when an order is placed). Advisory: nothing is blocked or traded because of it.
   */
  overLimit: PositionOverLimit[];
  /** Excess of totalPositionNotional over maxTotalPositionNotional; '' while within the limit */
  totalOverLimit: string;
  updatedAt: number;
}

/** An instrument whose position notional exceeds the per-instrument limit. Positions only, resting orders are not counted. */
export interface PositionOverLimit {
  instId: string;
  /** USD notional of the instrument's position; in long/short mode the gross of both legs */
  notional: string;
  /** maxPositionNotionalPerInstrument */
  limit: string;
  /** notional - limit: how much to trim to be back at the limit */
  excess: string;
}

export type ConnState = 'connected' | 'connecting' | 'disconnected';

/** Per-instrument market-data streams whose freshness the API watches. */
export type MarketStream = 'ticker' | 'book' | 'mark';

/** disabled: no API key configured; starting: first load in progress; error: the last attempt to reach the account failed */
export type AccountState = 'disabled' | 'starting' | 'ok' | 'error';

export interface AccountError {
  /** OKX's own code, e.g. "50105"; '' when the failure did not come from the exchange (network, timeout) */
  code: string;
  /** The exchange's message verbatim, or the transport failure */
  message: string;
  ts: number;
}

export interface AccountStatus {
  state: AccountState;
  error: AccountError | null;
  /** Server time of the last successful REST reconcile or private push; null before the first one */
  lastSyncAt: number | null;
  /** True when the key is known to lack the trade permission */
  readOnly: boolean;
}

export interface ConnectionStatus {
  okxPublic: ConnState;
  okxPrivate: ConnState;
  okxBusiness: ConnState;
  account: AccountStatus;
  demo: boolean;
  /** Milliseconds since the stalest watched stream last delivered anything; -1 when nothing has arrived yet */
  dataAgeMs: number;
  /** Streams that stopped updating, as `<instId>:<MarketStream>`, e.g. "SOL-USDT-SWAP:book" */
  staleStreams: string[];
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
  /** Normalised trigger price of the attached stop-loss; '' when the order carries none */
  slTriggerPx: string;
  /** Quote-currency loss if the stop fills at its trigger with `sz`, measured from refPrice; '' when there is no stop */
  stopLossQuote: string;
  /** ok=false means the order would be rejected */
  risk: RiskCheckResult;
}
