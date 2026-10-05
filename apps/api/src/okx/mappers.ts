import type {
  OkxAlgoOrder,
  OkxAttachAlgoOrd,
  OkxBalance,
  OkxCandleRow,
  OkxFill,
  OkxFundingRate,
  OkxInstrument,
  OkxMarkPrice,
  OkxOrder,
  OkxPosition,
  OkxTicker,
  OkxTrade,
} from '@pegasus/okx';
import { CANDLE_BARS, ORDER_CATEGORIES, type AlgoOrder, type Balance, type Candle, type CandleBar, type Fill, type FundingRate, type Instrument, type MarkPrice, type Order, type OrdType, type PosSide, type Position, type Ticker, type Trade } from '@pegasus/shared';

const num = (s: string | undefined): number => (s === undefined || s === '' ? 0 : Number(s));

export function mapInstrument(i: OkxInstrument): Instrument {
  const [base = '', quote = ''] = (i.uly || i.instFamily || i.instId.replace(/-SWAP$/, '')).split('-');
  return {
    instId: i.instId,
    instType: 'SWAP',
    uly: i.uly || i.instFamily,
    baseCcy: i.baseCcy || base,
    quoteCcy: i.quoteCcy || quote,
    settleCcy: i.settleCcy,
    ctVal: i.ctVal,
    ctValCcy: i.ctValCcy,
    ctMult: i.ctMult || '1',
    ctType: i.ctType === 'inverse' ? 'inverse' : 'linear',
    lotSz: i.lotSz,
    minSz: i.minSz,
    tickSz: i.tickSz,
    maxLmtSz: i.maxLmtSz || '0',
    maxMktSz: i.maxMktSz || '0',
    maxLever: i.lever || '1',
    state: i.state,
  };
}

export function mapTicker(t: OkxTicker): Ticker {
  return {
    instId: t.instId,
    last: t.last,
    lastSz: t.lastSz,
    bidPx: t.bidPx,
    bidSz: t.bidSz,
    askPx: t.askPx,
    askSz: t.askSz,
    open24h: t.open24h,
    high24h: t.high24h,
    low24h: t.low24h,
    vol24h: t.vol24h,
    volCcy24h: t.volCcy24h,
    ts: num(t.ts),
  };
}

export function mapTrade(t: OkxTrade): Trade {
  return { instId: t.instId, tradeId: t.tradeId, px: t.px, sz: t.sz, side: t.side, ts: num(t.ts) };
}

export function mapCandle(row: OkxCandleRow): Candle {
  return {
    ts: num(row[0]),
    open: row[1],
    high: row[2],
    low: row[3],
    close: row[4],
    vol: row[5],
    volCcy: row[6],
    confirm: row[8] === '1',
  };
}

// OKX aligns these bars to UTC+8 (its 1D opens at 16:00 UTC). The terminal is UTC throughout (risk day,
// daily signals), so they always travel as OKX's UTC-aligned variants: 6Hutc, 12Hutc, 1Dutc, 1Wutc.
const UTC8_BARS: ReadonlySet<CandleBar> = new Set<CandleBar>(['6H', '12H', '1D', '1W']);

/** The OKX name of a bar: the `bar` argument of the REST candle calls and the suffix of the `candle…` channels. */
export function toOkxBar(bar: CandleBar): string {
  return UTC8_BARS.has(bar) ? `${bar}utc` : bar;
}

/** Inverse of toOkxBar; null for a name the terminal never requests (such as OKX's own UTC+8 `1D`). */
export function fromOkxBar(okxBar: string): CandleBar | null {
  return CANDLE_BARS.find((bar) => toOkxBar(bar) === okxBar) ?? null;
}

export function mapMarkPrice(m: OkxMarkPrice): MarkPrice {
  return { instId: m.instId, markPx: m.markPx, ts: num(m.ts) };
}

export function mapFundingRate(f: OkxFundingRate): FundingRate {
  return {
    instId: f.instId,
    fundingRate: f.fundingRate,
    nextFundingRate: f.nextFundingRate,
    fundingTime: num(f.fundingTime),
    nextFundingTime: num(f.nextFundingTime),
  };
}

function mapPosSide(s: string | undefined): PosSide {
  return s === 'long' || s === 'short' ? s : 'net';
}

function mapOrdType(t: string): OrdType {
  switch (t) {
    case 'market':
    case 'limit':
    case 'post_only':
    case 'fok':
    case 'ioc':
      return t;
    default:
      return 'limit';
  }
}

/** The stop-loss entries of an order's attachAlgoOrds (a take-profit only entry carries no slTriggerPx). */
function attachedStops(o: OkxOrder): OkxAttachAlgoOrd[] {
  return (o.attachAlgoOrds ?? []).filter((a) => a.slTriggerPx !== undefined && a.slTriggerPx !== '');
}

const stopFailed = (a: OkxAttachAlgoOrd): boolean => a.failCode !== undefined && a.failCode !== '' && a.failCode !== '0';

/** The attached stop-loss the exchange reports as not created (its failCode is set), or null: that position has no stop. */
export function failedAttachedStop(o: OkxOrder): OkxAttachAlgoOrd | null {
  return attachedStops(o).find(stopFailed) ?? null;
}

export function mapOrder(o: OkxOrder): Order {
  // The stop attached at placement is echoed in attachAlgoOrds; the order's own slTriggerPx is the older single field.
  // An entry with a failCode is a stop the exchange did not create: it must not be shown as if it existed.
  const attached = attachedStops(o);
  const slTriggerPx = attached.length > 0 ? (attached.find((a) => !stopFailed(a))?.slTriggerPx ?? '') : (o.slTriggerPx ?? '');
  const order: Order = {
    ordId: o.ordId,
    clOrdId: o.clOrdId ?? '',
    instId: o.instId,
    side: o.side,
    posSide: mapPosSide(o.posSide),
    tdMode: o.tdMode === 'isolated' ? 'isolated' : 'cross',
    ordType: mapOrdType(o.ordType),
    px: o.px ?? '',
    sz: o.sz,
    accFillSz: o.accFillSz || '0',
    avgPx: o.avgPx ?? '',
    state: o.state === 'mmp_canceled' ? 'canceled' : o.state,
    reduceOnly: o.reduceOnly === 'true',
    lever: o.lever ?? '',
    fee: o.fee || '0',
    feeCcy: o.feeCcy ?? '',
    pnl: o.pnl || '0',
    cTime: num(o.cTime),
    uTime: num(o.uTime),
  };
  if (slTriggerPx !== '') order.slTriggerPx = slTriggerPx;
  // The trader must hear about the missing stop, so the reason travels with the order.
  const lost = attached.find(stopFailed);
  if (lost !== undefined) order.slFailReason = `${lost.failCode ?? ''}: ${lost.failReason ?? ''}`;
  // What tells the exchange's own close of a position (a liquidation) from the trader's. A category this code does not know is left out.
  const category = ORDER_CATEGORIES.find((c) => c === o.category);
  if (category !== undefined) order.category = category;
  return order;
}

export function mapAlgoOrder(a: OkxAlgoOrder): AlgoOrder {
  const slTriggerPx = a.slTriggerPx ?? '';
  const type = a.slTriggerPxType;
  return {
    algoId: a.algoId,
    algoClOrdId: a.algoClOrdId ?? '',
    instId: a.instId,
    side: a.side,
    posSide: mapPosSide(a.posSide),
    tdMode: a.tdMode === 'isolated' ? 'isolated' : 'cross',
    sz: a.sz ?? '',
    closeFraction: a.closeFraction ?? '',
    slTriggerPx,
    // OKX triggers on the last price when the order names no type.
    slTriggerPxType: slTriggerPx === '' ? '' : type === 'mark' || type === 'index' ? type : 'last',
    slOrdPx: a.slOrdPx ?? '',
    tpTriggerPx: a.tpTriggerPx ?? '',
    cTime: num(a.cTime),
    uTime: num(a.uTime),
  };
}

/**
 * Builds a Fill from an `orders` channel push that carries a fill; returns null when the push has no fill.
 * The order of a liquidation carries trade id `0`: its fill keeps that id and is told apart by its order (fillKey).
 */
export function fillFromOrderPush(o: OkxOrder): Fill | null {
  if (!o.tradeId || o.tradeId === '' || !o.fillSz || o.fillSz === '0' || o.fillSz === '') return null;
  return {
    tradeId: o.tradeId,
    ordId: o.ordId,
    clOrdId: o.clOrdId ?? '',
    instId: o.instId,
    side: o.side,
    posSide: mapPosSide(o.posSide),
    fillPx: o.fillPx,
    fillSz: o.fillSz,
    fee: o.fillFee ?? o.fee ?? '0',
    feeCcy: o.fillFeeCcy ?? o.feeCcy ?? '',
    execType: o.execType ?? '',
    ts: num(o.fillTime || o.uTime),
  };
}

export function mapFill(f: OkxFill): Fill {
  return {
    tradeId: f.tradeId,
    ordId: f.ordId,
    clOrdId: f.clOrdId ?? '',
    instId: f.instId,
    side: f.side,
    posSide: mapPosSide(f.posSide),
    fillPx: f.fillPx,
    fillSz: f.fillSz,
    fee: f.fee || '0',
    feeCcy: f.feeCcy ?? '',
    execType: f.execType ?? '',
    ts: num(f.ts),
  };
}

export function mapPosition(p: OkxPosition): Position {
  const position: Position = {
    instId: p.instId,
    posSide: mapPosSide(p.posSide),
    mgnMode: p.mgnMode === 'isolated' ? 'isolated' : 'cross',
    pos: p.pos || '0',
    avgPx: p.avgPx ?? '',
    markPx: p.markPx ?? '',
    upl: p.upl || '0',
    uplRatio: p.uplRatio || '0',
    lever: p.lever ?? '',
    liqPx: p.liqPx ?? '',
    // OKX fills margin only for isolated positions; a cross position carries its requirement in imr.
    margin: p.margin || p.imr || '',
    notionalUsd: p.notionalUsd || '0',
    cTime: num(p.cTime),
    uTime: num(p.uTime),
  };
  // Not reported is not zero: a margin level of 0 would read as a position about to be liquidated.
  if (p.mgnRatio) position.mgnRatio = p.mgnRatio;
  if (p.mmr) position.mmr = p.mmr;
  return position;
}

export function mapBalance(b: OkxBalance): Balance {
  return {
    totalEq: b.totalEq || '0',
    details: (b.details ?? []).map((d) => ({ ccy: d.ccy, eq: d.eq || '0', availEq: d.availEq || '0', cashBal: d.cashBal || '0', upl: d.upl || '0' })),
    ts: num(b.uTime),
  };
}

/** OKX keeps separate positions per instrument, margin mode and side; the key must carry all three. */
export const positionKey = (p: { instId: string; mgnMode: string; posSide: PosSide }): string => `${p.instId}:${p.mgnMode}:${p.posSide}`;

/**
 * What makes a fill one fill: the trade and the order it filled. OKX trade ids are unique per instrument only,
 * and a close made by the exchange itself is no trade at all: the order of every liquidation carries trade id 0,
 * so two liquidations of one instrument differ in their order alone. (A liquidation is taken to be one fill per
 * order; a self-trade, one trade id on two orders of this account, is two fills.)
 */
export const fillKey = (f: Pick<Fill, 'instId' | 'tradeId' | 'ordId'>): string => `${f.instId}:${f.tradeId}:${f.ordId}`;
