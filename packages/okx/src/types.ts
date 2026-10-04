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

/** A take-profit / stop-loss attached to an order (`attachAlgoOrds` of the place-order request and of the order object). */
export interface OkxAttachAlgoOrd {
  /** Client id of the attached algo order, up to 32 alphanumeric characters */
  attachAlgoClOrdId?: string;
  tpTriggerPx?: string;
  tpOrdPx?: string;
  slTriggerPx?: string;
  /** '-1' executes the stop at market */
  slOrdPx?: string;
  tpTriggerPxType?: OkxTriggerPxType;
  /** OKX defaults to 'last' */
  slTriggerPxType?: OkxTriggerPxType;
  sz?: string;
  amendPxOnTriggerType?: '0' | '1';
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
