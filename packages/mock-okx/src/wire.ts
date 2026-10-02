/**
 * OKX v5 wire shapes produced by the mock. Field names mirror the exchange;
 * every number is a string. Kept in sync with packages/okx/src/types.ts.
 */

export interface OkxResponse<T> {
  code: string;
  msg: string;
  data: T[];
}

export type OkxInstType = 'SPOT' | 'MARGIN' | 'SWAP' | 'FUTURES' | 'OPTION';
export type OkxTdMode = 'cross' | 'isolated' | 'cash';
export type OkxMgnMode = 'cross' | 'isolated';
export type OkxSide = 'buy' | 'sell';
export type OkxPosSide = 'long' | 'short' | 'net';
export type OkxOrdType = 'market' | 'limit' | 'post_only' | 'fok' | 'ioc';
export type OkxOrderState = 'live' | 'partially_filled' | 'filled' | 'canceled';
export type OkxPosMode = 'net_mode' | 'long_short_mode';
export type OkxExecType = 'T' | 'M' | '';

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
  category: string;
  optType: string;
  stk: string;
  alias: string;
  maxIcebergSz: string;
  maxTriggerSz: string;
  maxStopSz: string;
  maxTwapSz: string;
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
  count: string;
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
  method: string;
  fundingRate: string;
  nextFundingRate: string;
  fundingTime: string;
  nextFundingTime: string;
  minFundingRate: string;
  maxFundingRate: string;
  settState: string;
  settFundingRate: string;
  premium: string;
  interestRate: string;
  impactValue: string;
  ts: string;
}

export interface OkxAccountConfig {
  uid: string;
  mainUid: string;
  acctLv: string;
  posMode: OkxPosMode;
  autoLoan: boolean;
  greeksType: string;
  level: string;
  levelTmp: string;
  ctIsoMode: string;
  mgnIsoMode: string;
  spotOffsetType: string;
  roleType: string;
  traderInsts: string[];
  spotRoleType: string;
  spotTraderInsts: string[];
  opAuth: string;
  kycLv: string;
  label: string;
  ip: string;
  perm: string;
  liquidationGear: string;
  enableSpotBorrow: boolean;
  spotBorrowAutoRepay: boolean;
}

export interface OkxBalanceDetail {
  ccy: string;
  eq: string;
  eqUsd: string;
  availEq: string;
  cashBal: string;
  availBal: string;
  upl: string;
  uplLiab: string;
  frozenBal: string;
  ordFrozen: string;
  isoEq: string;
  isoUpl: string;
  imr: string;
  mmr: string;
  mgnRatio: string;
  notionalLever: string;
  disEq: string;
  liab: string;
  interest: string;
  crossLiab: string;
  isoLiab: string;
  maxLoan: string;
  twap: string;
  stgyEq: string;
  spotInUseAmt: string;
  uTime: string;
}

export interface OkxBalance {
  totalEq: string;
  adjEq: string;
  isoEq: string;
  ordFroz: string;
  imr: string;
  mmr: string;
  mgnRatio: string;
  notionalUsd: string;
  upl: string;
  borrowFroz: string;
  uTime: string;
  details: OkxBalanceDetail[];
}

export interface OkxPosition {
  instType: OkxInstType;
  instId: string;
  mgnMode: OkxMgnMode;
  posId: string;
  posSide: OkxPosSide;
  pos: string;
  baseBal: string;
  quoteBal: string;
  posCcy: string;
  availPos: string;
  avgPx: string;
  markPx: string;
  upl: string;
  uplRatio: string;
  uplLastPx: string;
  uplRatioLastPx: string;
  lever: string;
  liqPx: string;
  imr: string;
  margin: string;
  mgnRatio: string;
  mmr: string;
  liab: string;
  liabCcy: string;
  interest: string;
  tradeId: string;
  notionalUsd: string;
  adl: string;
  ccy: string;
  last: string;
  idxPx: string;
  usdPx: string;
  bePx: string;
  deltaBS: string;
  deltaPA: string;
  gammaBS: string;
  gammaPA: string;
  thetaBS: string;
  thetaPA: string;
  vegaBS: string;
  vegaPA: string;
  spotInUseAmt: string;
  spotInUseCcy: string;
  realizedPnl: string;
  pnl: string;
  fee: string;
  fundingFee: string;
  liqPenalty: string;
  closeOrderAlgo: unknown[];
  cTime: string;
  uTime: string;
  pTime: string;
}

export interface OkxLeverageInfo {
  instId: string;
  mgnMode: OkxMgnMode;
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
  ccy: string;
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
  rebate: string;
  rebateCcy: string;
  pnl: string;
  category: string;
  source: string;
  cancelSource: string;
  cancelSourceReason: string;
  tgtCcy: string;
  tpTriggerPx: string;
  tpOrdPx: string;
  slTriggerPx: string;
  slOrdPx: string;
  stpMode: string;
  algoClOrdId: string;
  algoId: string;
  attachAlgoOrds: unknown[];
  cTime: string;
  uTime: string;
  execType: OkxExecType;
  fillFee: string;
  fillFeeCcy: string;
  fillPnl: string;
  fillNotionalUsd: string;
  notionalUsd: string;
  amendResult: string;
  reqId: string;
  code: string;
  msg: string;
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
  fillIdxPx: string;
  fillPnl: string;
  fillPxVol: string;
  fillPxUsd: string;
  fillMarkVol: string;
  fillFwdPx: string;
  fillMarkPx: string;
  side: OkxSide;
  posSide: OkxPosSide;
  execType: OkxExecType;
  feeCcy: string;
  fee: string;
  ts: string;
  fillTime: string;
}

export interface OkxOrderAck {
  ordId: string;
  clOrdId: string;
  tag: string;
  sCode: string;
  sMsg: string;
  ts: string;
  reqId?: string;
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
  reduceOnly?: boolean | string;
}

export interface OkxWsArg {
  channel: string;
  instId?: string;
  instType?: string;
  instFamily?: string;
  ccy?: string;
  uid?: string;
  [k: string]: string | undefined;
}
