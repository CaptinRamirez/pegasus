/**
 * OKX v5 wire types. Field names mirror the exchange exactly; all numbers are
 * strings as sent by OKX. Only the fields this project consumes are listed,
 * but objects may carry more keys at runtime.
 */

export interface OkxResponse<T> {
  code: string;
  msg: string;
  data: T[];
}

export type OkxInstType = 'SPOT' | 'MARGIN' | 'SWAP' | 'FUTURES' | 'OPTION';
export type OkxTdMode = 'cross' | 'isolated' | 'cash';
export type OkxSide = 'buy' | 'sell';
export type OkxPosSide = 'long' | 'short' | 'net';
export type OkxOrdType = 'market' | 'limit' | 'post_only' | 'fok' | 'ioc' | 'optimal_limit_ioc';
export type OkxOrderState = 'live' | 'partially_filled' | 'filled' | 'canceled' | 'mmp_canceled';
export type OkxPosMode = 'net_mode' | 'long_short_mode';

export interface OkxInstrument {
  instType: OkxInstType;
  instId: string;
  uly: string;
  instFamily: string;
  baseCcy: string;
  quoteCcy: string;
  settleCcy: string;
  ctVal: string;
  ctMult: string;
  ctValCcy: string;
  ctType: 'linear' | 'inverse' | '';
  lotSz: string;
  minSz: string;
  tickSz: string;
  maxLmtSz: string;
  maxMktSz: string;
  lever: string;
  state: 'live' | 'suspend' | 'preopen' | 'test';
  listTime: string;
  expTime: string;
}

export interface OkxTicker {
  instType: OkxInstType;
  instId: string;
  last: string;
  lastSz: string;
  askPx: string;
  askSz: string;
  bidPx: string;
  bidSz: string;
  open24h: string;
  high24h: string;
  low24h: string;
  volCcy24h: string;
  vol24h: string;
  sodUtc0: string;
  sodUtc8: string;
  ts: string;
}

/** [price, size, deprecated liquidated-orders count, order count] */
export type OkxBookLevel = [string, string, string, string];

export interface OkxBookData {
  asks: OkxBookLevel[];
  bids: OkxBookLevel[];
  ts: string;
  checksum?: number;
  seqId?: number;
  prevSeqId?: number;
}

export interface OkxTrade {
  instId: string;
  tradeId: string;
  px: string;
  sz: string;
  side: OkxSide;
  ts: string;
}

/** [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm] */
export type OkxCandleRow = [string, string, string, string, string, string, string, string, string];

/** [ts, open, high, low, close, confirm] of the mark price candle endpoints */
export type OkxMarkPriceCandleRow = [string, string, string, string, string, string];

export interface OkxMarkPrice {
  instType: OkxInstType;
  instId: string;
  markPx: string;
  ts: string;
}

export interface OkxFundingRate {
  instType: OkxInstType;
  instId: string;
  fundingRate: string;
  nextFundingRate: string;
  fundingTime: string;
  nextFundingTime: string;
  ts?: string;
}

export interface OkxTime {
  ts: string;
}

export interface OkxFundingRateHistory {
  instType: OkxInstType;
  instId: string;
  fundingRate: string;
  realizedRate: string;
  fundingTime: string;
  method?: string;
}

/** [ts, open interest (USD), volume (USD)] from /rubik/stat/contracts/open-interest-volume */
export type OkxOpenInterestVolumeRow = [string, string, string];

/** [ts, open interest in contracts, in base coin, in USD] from /rubik/stat/contracts/open-interest-history */
export type OkxOpenInterestHistoryRow = [string, string, string, string];

export interface OkxOpenInterest {
  instType: OkxInstType;
  instId: string;
  /** Open interest in contracts */
  oi: string;
  /** Open interest in currency */
  oiCcy: string;
  oiUsd?: string;
  ts: string;
}

export interface OkxAccountConfig {
  uid: string;
  acctLv: string;
  posMode: OkxPosMode;
  autoLoan: boolean;
  level: string;
  label?: string;
  /** Comma-separated permissions of the API key, e.g. "read_only" or "read_only,trade" */
  perm?: string;
}

export interface OkxBalanceDetail {
  ccy: string;
  eq: string;
  availEq: string;
  cashBal: string;
  availBal: string;
  upl: string;
  frozenBal: string;
  ordFrozen: string;
  isoEq: string;
}

export interface OkxBalance {
  totalEq: string;
  adjEq: string;
  isoEq: string;
  ordFroz: string;
  imr: string;
  mmr: string;
  notionalUsd: string;
  uTime: string;
  details: OkxBalanceDetail[];
}

export interface OkxPosition {
  instType: OkxInstType;
  instId: string;
  mgnMode: 'cross' | 'isolated';
  posId: string;
  posSide: OkxPosSide;
  pos: string;
  availPos: string;
  avgPx: string;
  markPx: string;
  upl: string;
  uplRatio: string;
  lever: string;
  liqPx: string;
  /** Posted margin of an isolated position; '' for cross */
  margin: string;
  /** Initial margin requirement; the figure a cross position reports instead of margin */
  imr: string;
  /** Margin level of the position, 1 being 100%: an isolated position is liquidated at 1 or less; '' when not reported */
  mgnRatio: string;
  /** Maintenance margin requirement of the position, in its margin currency; '' when not reported */
  mmr: string;
  notionalUsd: string;
  ccy: string;
  cTime: string;
  uTime: string;
  pTime?: string;
}

export interface OkxLeverageInfo {
  instId: string;
  mgnMode: 'cross' | 'isolated';
  posSide: OkxPosSide;
  lever: string;
}

/** POST /api/v5/account/position/margin-balance: add margin to an isolated position, or take margin out of it. */
export interface OkxMarginBalanceParams {
  instId: string;
  /** OKX requires it here in both position modes: `net` in net mode, the side of the position in long/short mode */
  posSide: OkxPosSide;
  type: 'add' | 'reduce';
  /** Amount to add or to take out, in the margin currency */
  amt: string;
  ccy?: string;
}

export interface OkxMarginBalance {
  instId: string;
  posSide: OkxPosSide;
  amt: string;
  type: 'add' | 'reduce';
  /** Real leverage of the position after the adjustment */
  leverage: string;
  ccy: string;
}

export interface OkxOrder {
  instType: OkxInstType;
  instId: string;
  ordId: string;
  clOrdId: string;
  tag: string;
  tdMode: OkxTdMode;
  side: OkxSide;
  posSide: OkxPosSide;
  ordType: OkxOrdType;
  px: string;
  sz: string;
  accFillSz: string;
  fillPx: string;
  fillSz: string;
  fillTime: string;
  tradeId: string;
  avgPx: string;
  state: OkxOrderState;
  lever: string;
  reduceOnly: string;
  fee: string;
  feeCcy: string;
  pnl: string;
  /**
   * `normal` for an order of the user; `full_liquidation` / `partial_liquidation` and `adl` for the order the
   * exchange closes a position with (its `tradeId` is then `0` and `clOrdId` empty); also `twap`, `delivery`, `ddh`, `auto_conversion`
   */
  category: string;
  /** Legacy single stop-loss trigger of the order itself; '' when none */
  slTriggerPx?: string;
  /** The TP/SL attached at placement, echoed back; the exchange creates the algo order when the order fills */
  attachAlgoOrds?: OkxAttachAlgoOrd[];
  cTime: string;
  uTime: string;
  /** Present on the private `orders` channel pushes */
  execType?: 'T' | 'M' | '';
  fillFee?: string;
  fillFeeCcy?: string;
  fillPnl?: string;
  amendResult?: string;
  code?: string;
  msg?: string;
}

export interface OkxFill {
  instType: OkxInstType;
  instId: string;
  tradeId: string;
  ordId: string;
  clOrdId: string;
  billId: string;
  tag: string;
  fillPx: string;
  fillSz: string;
  side: OkxSide;
  posSide: OkxPosSide;
  execType: 'T' | 'M' | '';
  feeCcy: string;
  fee: string;
  fillPnl?: string;
  ts: string;
}

export type OkxTriggerPxType = 'last' | 'index' | 'mark';

/**
 * A take-profit / stop-loss attached to an order (`attachAlgoOrds` of the place-order request and of the order object).
 *
 * One object holds a take-profit, a stop-loss or both, for the whole filled size. Split take-profits are several
 * objects: one per take-profit leg, each with its own `sz` (required, and the legs' sizes must add up to the order's
 * size: OKX 51083), and at most one stop-loss object without `sz` (51084); in that form an object is one-way, a
 * take-profit or a stop-loss (51076). docs/okx-api-notes.md 6.1.
 */
export interface OkxAttachAlgoOrd {
  /** Client id of the attached algo order, up to 32 alphanumeric characters */
  attachAlgoClOrdId?: string;
  /** Order object only: the algo id the exchange gave the attached order */
  attachAlgoId?: string;
  tpTriggerPx?: string;
  /** '-1' executes the take-profit at market; every leg of split take-profits must be '-1' (51082) */
  tpOrdPx?: string;
  slTriggerPx?: string;
  /** '-1' executes the stop at market */
  slOrdPx?: string;
  /** OKX defaults to 'last'; the legs of split take-profits must share one (51080) */
  tpTriggerPxType?: OkxTriggerPxType;
  /** OKX defaults to 'last' */
  slTriggerPxType?: OkxTriggerPxType;
  /** Contracts of one take-profit leg of split take-profits; never sent for a stop-loss */
  sz?: string;
  /** '1' on the stop-loss of split take-profits: the cost-price stop, moved to the average entry price when the first take-profit triggers (needs two legs or more: 51085) */
  amendPxOnTriggerType?: '0' | '1';
  /** Trailing stop attached to the order (OKX 2026-04-13): callback ratio, e.g. '0.05' for 5%. Not sent by Pegasus */
  callbackRatio?: string;
  /** Trailing stop attached to the order: callback as a price distance. Not sent by Pegasus */
  callbackSpread?: string;
  /** Trailing stop attached to the order: activation price. Not sent by Pegasus */
  activePx?: string;
  /** Order object only: set when the exchange could not create the attached order; '' or '0' otherwise */
  failCode?: string;
  /** Order object only: why it could not be created */
  failReason?: string;
}

export interface OkxPlaceOrderParams {
  instId: string;
  tdMode: OkxTdMode;
  side: OkxSide;
  ordType: OkxOrdType;
  sz: string;
  px?: string;
  posSide?: OkxPosSide;
  clOrdId?: string;
  tag?: string;
  reduceOnly?: boolean;
  /** For SWAP: 'base_ccy' | 'quote_ccy' is spot-only; omit for swaps */
  tgtCcy?: string;
  attachAlgoOrds?: OkxAttachAlgoOrd[];
}

export interface OkxOrderAck {
  ordId: string;
  clOrdId: string;
  tag: string;
  sCode: string;
  sMsg: string;
  ts?: string;
}

export interface OkxCancelOrderParams {
  instId: string;
  ordId?: string;
  clOrdId?: string;
}

export interface OkxAmendOrderParams {
  instId: string;
  ordId?: string;
  clOrdId?: string;
  newSz?: string;
  newPx?: string;
  cxlOnFail?: boolean;
  reqId?: string;
}

export type OkxAlgoOrderState = 'live' | 'pause' | 'partially_effective' | 'effective' | 'canceled' | 'order_failed' | 'partially_failed';

/**
 * The algo order types Pegasus uses: `conditional` (one-way: a take-profit or a stop-loss), `oco` (both, the first to
 * trigger cancels the other) and `move_order_stop` (a trailing stop). The algo order list takes `conditional,oco`
 * together but `move_order_stop` only on its own.
 */
export type OkxAlgoOrdType = 'conditional' | 'oco' | 'move_order_stop';

/**
 * An algo order of the algo order list: a take-profit / stop-loss (`conditional`: one-way, `oco`: both) or a
 * trailing stop (`move_order_stop`). The take-profits and the stop attached to an order become `conditional` /
 * `oco` orders once that order is completely filled. Only the fields the terminal reads.
 */
export interface OkxAlgoOrder {
  instType: OkxInstType;
  instId: string;
  algoId: string;
  /** For an attached stop: the attachAlgoClOrdId of the order it came from */
  algoClOrdId: string;
  ordType: string;
  /** Side of the order it sends when triggered */
  side: OkxSide;
  posSide: OkxPosSide;
  tdMode: OkxTdMode;
  /** Contracts; '' when the order closes a fraction of the position instead */
  sz: string;
  /** '1' closes the whole position, whatever its size when triggered; '' otherwise */
  closeFraction: string;
  state: OkxAlgoOrderState;
  reduceOnly: string;
  tpTriggerPx: string;
  tpTriggerPxType: string;
  tpOrdPx: string;
  slTriggerPx: string;
  slTriggerPxType: string;
  /** '-1' executes at market */
  slOrdPx: string;
  /** Trailing stop: callback ratio ('0.05' is 5%); '' otherwise */
  callbackRatio?: string;
  /** Trailing stop: callback as a price distance; '' otherwise */
  callbackSpread?: string;
  /** Trailing stop: the price that activates it; '' when it was active from its placement */
  activePx?: string;
  /** Trailing stop: the price it triggers at now (moves with the market); '' before it is active */
  moveTriggerPx?: string;
  /** '1' on the stop-loss of split take-profits whose trigger moves to the entry price when the first take-profit triggers */
  amendPxOnTriggerType?: string;
  cTime: string;
  uTime: string;
}

/**
 * An algo order placed on its own for an open position (POST /api/v5/trade/order-algo):
 * - `conditional`: one-way, a stop-loss (`sl…`) or a take-profit (`tp…`); with both, OKX performs the stop-loss only;
 * - `oco`: both, the first to trigger cancels the other;
 * - `move_order_stop`: a trailing stop, with `callbackRatio` or `callbackSpread` and an optional `activePx`.
 * `sz` or `closeFraction` ('1', conditional and oco only) is required. Fields that do not belong to the type are not sent.
 */
export interface OkxPlaceAlgoParams {
  instId: string;
  tdMode: OkxTdMode;
  /** Side of the closing order: sell for a long, buy for a short */
  side: OkxSide;
  ordType: OkxAlgoOrdType;
  sz?: string;
  /** '1' closes the whole position whatever its size then; conditional and oco only, reduce-only in net mode */
  closeFraction?: string;
  slTriggerPx?: string;
  /** '-1' executes at market */
  slOrdPx?: string;
  slTriggerPxType?: OkxTriggerPxType;
  tpTriggerPx?: string;
  /** '-1' executes at market */
  tpOrdPx?: string;
  tpTriggerPxType?: OkxTriggerPxType;
  /** Trailing stop: '0.05' is 5%; either this or callbackSpread */
  callbackRatio?: string;
  callbackSpread?: string;
  /** Trailing stop: it starts trailing once the price reaches this; at once when absent */
  activePx?: string;
  /** Long/short mode only */
  posSide?: OkxPosSide;
  /** Net mode only */
  reduceOnly?: boolean;
  /** Cancel the TP/SL order (conditional, oco) when its position is fully closed; OKX requires reduceOnly with it */
  cxlOnClosePos?: boolean;
  algoClOrdId?: string;
}

export interface OkxCancelAlgoParams {
  instId: string;
  algoId?: string;
  algoClOrdId?: string;
}

/** Amend of a TP/SL algo order (conditional, oco; not a trailing stop); only the fields that change are sent. */
export interface OkxAmendAlgoParams {
  instId: string;
  algoId?: string;
  algoClOrdId?: string;
  newSz?: string;
  newSlTriggerPx?: string;
  newSlOrdPx?: string;
  newSlTriggerPxType?: OkxTriggerPxType;
  newTpTriggerPx?: string;
  newTpOrdPx?: string;
  newTpTriggerPxType?: OkxTriggerPxType;
  cxlOnFail?: boolean;
  reqId?: string;
}

export interface OkxAlgoAck {
  algoId: string;
  algoClOrdId?: string;
  reqId?: string;
  sCode: string;
  sMsg: string;
}

export interface OkxClosePositionParams {
  instId: string;
  mgnMode: 'cross' | 'isolated';
  posSide?: OkxPosSide;
  ccy?: string;
  autoCxl?: boolean;
  clOrdId?: string;
}

export interface OkxSetLeverageParams {
  instId?: string;
  ccy?: string;
  lever: string;
  mgnMode: 'cross' | 'isolated';
  posSide?: 'long' | 'short';
}

export interface OkxWsArg {
  channel: string;
  instId?: string;
  instType?: string;
  instFamily?: string;
  ccy?: string;
  [k: string]: string | undefined;
}

export interface OkxWsEvent {
  event: 'subscribe' | 'unsubscribe' | 'login' | 'error' | 'channel-conn-count' | 'channel-conn-count-error' | 'notice';
  arg?: OkxWsArg;
  code?: string;
  msg?: string;
  connId?: string;
  channel?: string;
  connCount?: string;
}

export interface OkxWsData<T = unknown> {
  arg: OkxWsArg;
  action?: 'snapshot' | 'update';
  data: T[];
}

export interface OkxWsOpResponse<T = unknown> {
  id: string;
  op: string;
  code: string;
  msg: string;
  data: T[];
  inTime?: string;
  outTime?: string;
}

export type OkxWsMessage = OkxWsEvent | OkxWsData | OkxWsOpResponse;

export function isWsEvent(m: OkxWsMessage): m is OkxWsEvent {
  return typeof (m as OkxWsEvent).event === 'string';
}

export function isWsData(m: OkxWsMessage): m is OkxWsData {
  return (m as OkxWsData).arg !== undefined && Array.isArray((m as OkxWsData).data) && (m as OkxWsEvent).event === undefined;
}

export function isWsOpResponse(m: OkxWsMessage): m is OkxWsOpResponse {
  return typeof (m as OkxWsOpResponse).op === 'string' && typeof (m as OkxWsOpResponse).id === 'string';
}
