import { d, isDecimalString, isMultipleOf, ZERO, type Dec } from '../num.js';
import type { OkxMgnMode, OkxOrdType, OkxPosSide, OkxSide, OkxTriggerPxType } from '../wire.js';
import { reject, type EngineContext, type Market, type Rejection } from './context.js';
import { algoRecord, type AttachedSl, type AttachedTp, type OrderRec, type StopRec } from './orders.js';

const ORD_TYPES: readonly OkxOrdType[] = ['market', 'limit', 'post_only', 'fok', 'ioc'];
const CL_ORD_ID_RE = /^[A-Za-z0-9]{1,32}$/;
const TAG_RE = /^[A-Za-z0-9]{1,16}$/;
const TRIGGER_PX_TYPES: readonly OkxTriggerPxType[] = ['last', 'index', 'mark'];
/** OKX: "The number of TP orders with Split TPs attached in a same order cannot exceed 10" (51079) */
const MAX_SPLIT_TPS = 10;

/**
 * OKX's codes for a stop-loss on the wrong side, by trigger price type and the side of the order it protects: a
 * buy's stop "cannot be higher than" the price, a sell's "cannot be lower than" it.
 */
const WRONG_SIDE_CODES: Record<OkxTriggerPxType, Record<OkxSide, string>> = {
  last: { sell: '51278', buy: '51280' },
  mark: { sell: '51302', buy: '51304' },
  index: { sell: '51306', buy: '51308' },
};

/**
 * The same for a take-profit: a buy's take-profit "cannot be lower than" the price (51279, 51303, 51307), a sell's
 * "cannot be higher than" it (51277, 51300, 51305).
 */
const TP_WRONG_SIDE_CODES: Record<OkxTriggerPxType, Record<OkxSide, string>> = {
  last: { buy: '51279', sell: '51277' },
  mark: { buy: '51303', sell: '51300' },
  index: { buy: '51307', sell: '51305' },
};

/** The price a trigger price type names; the simulator does not model the index apart from the mark. */
function refPriceOf(market: Market, type: OkxTriggerPxType): Dec {
  return type === 'last' ? market.lastPx : market.markPx;
}

const has = (raw: Raw, key: string): boolean => raw[key] !== undefined && raw[key] !== '';

/** A trigger price type as sent; OKX's default is the last price. undefined: not one of the three. */
function triggerPxType(v: unknown): OkxTriggerPxType | undefined {
  return v === undefined || v === '' ? 'last' : TRIGGER_PX_TYPES.find((t) => t === v);
}

/** An order price of a TP/SL leg: '-1' (market) or a positive decimal. */
const validOrdPx = (s: string | undefined): s is string => s !== undefined && (s === '-1' || (isDecimalString(s) && d(s).gt(0)));

/** A trigger price: a positive decimal on the tick. */
function triggerOf(s: string | undefined, tickSz: string): Dec | null {
  if (!s || !isDecimalString(s) || d(s).lte(0) || !isMultipleOf(d(s), d(tickSz))) return null;
  return d(s);
}

/** The take-profit of a position opened by `entrySide` must not already be reached by the price that triggers it. */
function tpWrongSide(market: Market, trigger: Dec, type: OkxTriggerPxType, entrySide: OkxSide): Rejection | null {
  const ref = refPriceOf(market, type);
  const profit = entrySide === 'buy' ? trigger.gt(ref) : trigger.lt(ref);
  return profit ? null : reject(TP_WRONG_SIDE_CODES[type][entrySide], `TP trigger price cannot be ${entrySide === 'buy' ? 'lower' : 'higher'} than the ${type} price`);
}

/** The stop-loss of a position opened by `entrySide` must not already be reached by the price that triggers it. */
function slWrongSide(market: Market, trigger: Dec, type: OkxTriggerPxType, entrySide: OkxSide): Rejection | null {
  const ref = refPriceOf(market, type);
  const losing = entrySide === 'buy' ? trigger.lt(ref) : trigger.gt(ref);
  return losing ? null : reject(WRONG_SIDE_CODES[type][entrySide], `SL trigger price cannot be ${entrySide === 'buy' ? 'higher' : 'lower'} than the ${type} price`);
}

export type Raw = Record<string, unknown>;

export function asRecord(x: unknown): Raw | null {
  return typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Raw) : null;
}

export function str(raw: Raw, key: string): string | undefined {
  const v = raw[key];
  return typeof v === 'string' ? v : undefined;
}

export function parseBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false' || v === undefined || v === '') return false;
  return undefined;
}

/** Validates a place-order request and builds the internal order record (not yet registered). */
export function validatePlace(body: unknown, ctx: EngineContext): OrderRec | Rejection {
  const raw = asRecord(body);
  if (!raw) return reject('51000', 'Parameter error');
  const instId = str(raw, 'instId') ?? '';
  const inst = ctx.instruments.get(instId);
  if (!inst) return reject('51001', 'Instrument ID does not exist.');
  const tdMode = str(raw, 'tdMode');
  if (tdMode !== 'cross' && tdMode !== 'isolated') return reject('51000', 'Parameter tdMode error');
  const side = str(raw, 'side');
  if (side !== 'buy' && side !== 'sell') return reject('51000', 'Parameter side error');
  const ordType = str(raw, 'ordType');
  if (!ordType || !(ORD_TYPES as readonly string[]).includes(ordType)) return reject('51000', 'Parameter ordType error');
  const szStr = str(raw, 'sz');
  if (!szStr || !isDecimalString(szStr) || d(szStr).lte(0)) return reject('51000', 'Parameter sz error');
  const sz = d(szStr);
  const lotSz = d(inst.lotSz);
  if (!isMultipleOf(sz, lotSz)) return reject('51121', 'Order quantity must be a multiple of the lot size.');
  if (sz.lt(d(inst.minSz))) return reject('51020', 'Order amount should be greater than the min available amount.');
  const maxSz = d(ordType === 'market' ? inst.maxMktSz : inst.maxLmtSz);
  if (sz.gt(maxSz)) return reject('51004', 'Order amount exceeds current tier limit.');
  let px: Dec | null = null;
  if (ordType !== 'market') {
    const pxStr = str(raw, 'px');
    if (!pxStr || !isDecimalString(pxStr) || d(pxStr).lte(0)) return reject('51000', 'Parameter px error');
    px = d(pxStr);
    if (!isMultipleOf(px, d(inst.tickSz))) return reject('51000', 'Parameter px error');
  }
  const posSideRaw = raw['posSide'];
  let posSide: OkxPosSide;
  if (ctx.posMode === 'long_short_mode') {
    if (posSideRaw !== 'long' && posSideRaw !== 'short') return reject('51000', 'Parameter posSide error');
    posSide = posSideRaw;
  } else {
    if (posSideRaw !== undefined && posSideRaw !== '' && posSideRaw !== 'net') return reject('51000', 'Parameter posSide error');
    posSide = 'net';
  }
  const clOrdId = str(raw, 'clOrdId') ?? '';
  if (clOrdId !== '' && !CL_ORD_ID_RE.test(clOrdId)) return reject('51000', 'Parameter clOrdId error');
  if (clOrdId !== '' && ctx.orders.clOrdIdInUse(clOrdId)) return reject('51016', 'Duplicated clOrdId.');
  const tag = str(raw, 'tag') ?? '';
  if (tag !== '' && !TAG_RE.test(tag)) return reject('51000', 'Parameter tag error');
  const reduceOnly = parseBool(raw['reduceOnly']);
  if (reduceOnly === undefined) return reject('51000', 'Parameter reduceOnly error');

  const account = ctx.account;
  const existing = account.find(instId, tdMode, posSide);
  const opening = account.isOpening(side, posSide, existing);
  if (reduceOnly && (opening || !existing || existing.qty.lt(sz))) {
    return reject('51119', 'Reduce-only order would open or flip the position.');
  }
  if (ctx.posMode === 'long_short_mode' && !opening) {
    if (!existing || existing.qty.isZero()) return reject('51023', 'Position does not exist.');
    if (existing.qty.lt(sz)) return reject('51119', 'Order size exceeds the position size on the closing side.');
  }
  // An open isolated position posts what is added to it at the leverage it was opened with.
  const lever = tdMode === 'isolated' && existing && !existing.qty.isZero() ? existing.lever : account.leverFor(instId, tdMode, posSide);
  const marginError = checkMargin(ctx, inst.instId, tdMode, side, posSide, sz, px, lever, reduceOnly);
  if (marginError) return marginError;
  const attached = parseAttached(raw['attachAlgoOrds'], ctx, instId, side, px, opening && !reduceOnly, sz);
  if (attached && 'sCode' in attached) return attached;

  const now = ctx.now();
  return {
    ordId: ctx.orders.newOrdId(),
    clOrdId,
    tag,
    instId,
    tdMode,
    side,
    posSide,
    ordType: ordType as OkxOrdType,
    px,
    sz,
    accFillSz: ZERO,
    avgPx: ZERO,
    state: 'live',
    lever,
    reduceOnly,
    fee: ZERO,
    pnl: ZERO,
    cTime: now,
    uTime: now,
    cancelSource: '',
    cancelSourceReason: '',
    lastFill: null,
    amendResult: '',
    reqId: '',
    attachSl: attached?.sl ?? null,
    attachTps: attached?.tps ?? [],
    category: 'normal',
  };
}

/** What an order carries in `attachAlgoOrds`. */
interface AttachedPlan {
  sl: AttachedSl | null;
  tps: AttachedTp[];
}

/**
 * The take-profits and the stop-loss of `attachAlgoOrds`, or null when the order carries none. Two forms, as OKX
 * documents them ("POST / Place order", "For placing order with TP/SL"):
 *
 * - One object: a take-profit, a stop-loss or both (it becomes an `oco` order), for the whole fill; no `sz`.
 * - Split take-profits: several objects (or one with `sz`). Each is one-way (51076). The take-profit legs carry their
 *   `sz` (51089), execute at market (51082), share one trigger price type (51080), have distinct triggers (51081), are
 *   at most 10 (51079) and add up to the order's size (51083). At most one stop-loss (51084), without `sz`; with
 *   `amendPxOnTriggerType` '1' (the cost-price stop) it needs two take-profits or more (51085).
 *
 * A leg already reached by the price that triggers it is refused with OKX's code for its type and trigger price type
 * (stop-loss 51278/51280, 51302/51304, 51306/51308; take-profit 51277/51279, 51300/51303, 51305/51307). A leg at or
 * beyond the order's own price, and what the simulator does not do (limit take-profits, trigger ratios, attached
 * trailing stops), are the generic parameter error 51000: OKX documents no code for them.
 */
function parseAttached(value: unknown, ctx: EngineContext, instId: string, side: OkxSide, px: Dec | null, opening: boolean, orderSz: Dec): AttachedPlan | Rejection | null {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return null;
  const bad = (what: string): Rejection => reject('51000', `Parameter attachAlgoOrds error: ${what}`);
  if (!Array.isArray(value)) return bad('an array is expected');
  const objects: Raw[] = [];
  for (const item of value as unknown[]) {
    const a = asRecord(item);
    if (!a) return bad('object expected');
    objects.push(a);
  }
  const inst = ctx.instruments.get(instId);
  const market = ctx.markets.get(instId);
  if (!inst || !market) return reject('51001', 'Instrument ID does not exist.');
  for (const a of objects) {
    for (const key of ['callbackRatio', 'callbackSpread', 'activePx']) if (has(a, key)) return bad('an attached trailing stop is not simulated');
    for (const key of ['tpTriggerRatio', 'slTriggerRatio']) if (has(a, key)) return bad(`${key} is not simulated`);
    if (has(a, 'tpOrdKind') && a['tpOrdKind'] !== 'condition') return bad('a limit take-profit is not simulated');
    const clId = str(a, 'attachAlgoClOrdId') ?? '';
    if (clId !== '' && !CL_ORD_ID_RE.test(clId)) return bad('attachAlgoClOrdId');
  }
  const isTp = (a: Raw): boolean => has(a, 'tpTriggerPx') || has(a, 'tpOrdPx');
  const isSl = (a: Raw): boolean => has(a, 'slTriggerPx') || has(a, 'slOrdPx');
  const split = objects.length > 1 || objects.some((a) => has(a, 'sz'));
  const limitPx = px ?? market.lastPx;

  const parseSl = (a: Raw): Omit<AttachedSl, 'attachAlgoId' | 'attachAlgoClOrdId'> | Rejection => {
    const trigger = triggerOf(str(a, 'slTriggerPx'), inst.tickSz);
    if (!trigger) return bad('slTriggerPx');
    const slOrdPx = str(a, 'slOrdPx');
    if (!validOrdPx(slOrdPx)) return bad('slOrdPx');
    const type = triggerPxType(a['slTriggerPxType']);
    if (!type) return bad('slTriggerPxType');
    if (!opening) return bad('a stop-loss cannot be attached to an order that closes a position');
    const wrong = slWrongSide(market, trigger, type, side);
    if (wrong) return wrong;
    if (side === 'buy' ? !trigger.lt(limitPx) : !trigger.gt(limitPx)) return bad(`the SL trigger price must be ${side === 'buy' ? 'lower' : 'higher'} than the order price`);
    return { slTriggerPx: trigger, slOrdPx, slTriggerPxType: type };
  };
  const parseTp = (a: Raw): Omit<AttachedTp, 'attachAlgoId' | 'attachAlgoClOrdId' | 'sz'> | Rejection => {
    const trigger = triggerOf(str(a, 'tpTriggerPx'), inst.tickSz);
    if (!trigger) return bad('tpTriggerPx');
    const tpOrdPx = str(a, 'tpOrdPx');
    if (!validOrdPx(tpOrdPx)) return bad('tpOrdPx');
    const type = triggerPxType(a['tpTriggerPxType']);
    if (!type) return bad('tpTriggerPxType');
    if (!opening) return bad('a take-profit cannot be attached to an order that closes a position');
    const wrong = tpWrongSide(market, trigger, type, side);
    if (wrong) return wrong;
    if (side === 'buy' ? !trigger.gt(limitPx) : !trigger.lt(limitPx)) return bad(`the TP trigger price must be ${side === 'buy' ? 'higher' : 'lower'} than the order price`);
    return { tpTriggerPx: trigger, tpOrdPx, tpTriggerPxType: type };
  };
  const ids = (a: Raw) => ({ attachAlgoId: ctx.orders.newAlgoId(), attachAlgoClOrdId: str(a, 'attachAlgoClOrdId') ?? '' });

  if (!split) {
    const a = objects[0] as Raw;
    if (!isTp(a) && !isSl(a)) return bad('neither a take-profit nor a stop-loss');
    if (has(a, 'amendPxOnTriggerType') && a['amendPxOnTriggerType'] !== '0') return reject('51085', 'The number of TP orders cannot be less than 2 when cost-price SL is enabled (amendPxOnTriggerType set as 1) for Split TPs');
    const sl = isSl(a) ? parseSl(a) : null;
    if (sl && 'sCode' in sl) return sl;
    const tp = isTp(a) ? parseTp(a) : null;
    if (tp && 'sCode' in tp) return tp;
    const id = ids(a);
    return { sl: sl ? { ...id, ...sl } : null, tps: tp ? [{ ...id, ...tp, sz: null }] : [] };
  }

  const tpObjects: Raw[] = [];
  const slObjects: Raw[] = [];
  for (const a of objects) {
    if (isTp(a) && isSl(a)) return reject('51076', "TP/SL orders in Split TPs only support one-way TP/SL. You can't use slTriggerPx&slOrdPx and tpTriggerPx&tpOrdPx at the same time.");
    if (!isTp(a) && !isSl(a)) return bad('neither a take-profit nor a stop-loss');
    (isTp(a) ? tpObjects : slObjects).push(a);
  }
  if (tpObjects.length > MAX_SPLIT_TPS) return reject('51079', `The number of TP orders with Split TPs attached in a same order cannot exceed ${MAX_SPLIT_TPS}`);
  if (slObjects.length > 1) return reject('51084', 'The number of SL orders with Split TPs attached in a same order cannot exceed 1');
  const tps: AttachedTp[] = [];
  let total = ZERO;
  for (const a of tpObjects) {
    const szStr = str(a, 'sz');
    if (!szStr) return reject('51089', 'The size of the TP order among split TPs attached cannot  be empty');
    if (!isDecimalString(szStr) || d(szStr).lte(0)) return bad('sz');
    if (!isMultipleOf(d(szStr), d(inst.lotSz))) return reject('51121', 'Order quantity must be a multiple of the lot size.');
    if (has(a, 'amendPxOnTriggerType')) return bad('amendPxOnTriggerType applies to the stop-loss of split TPs only');
    if (str(a, 'tpOrdPx') !== '-1') return reject('51082', 'TP trigger prices (tpOrdPx) in one order with multiple TPs must be market prices.');
    const tp = parseTp(a);
    if ('sCode' in tp) return tp;
    if (tps.length > 0 && tps[0]?.tpTriggerPxType !== tp.tpTriggerPxType) return reject('51080', 'Take-profit trigger price types (tpTriggerPxType) must be the same in an order with Split TPs attached');
    if (tps.some((t) => t.tpTriggerPx.eq(tp.tpTriggerPx))) return reject('51081', 'Take-profit trigger prices (tpTriggerPx) cannot be the same in an order with Split TPs attached');
    total = total.add(d(szStr));
    tps.push({ ...ids(a), ...tp, sz: d(szStr) });
  }
  if (tps.length > 0 && !total.eq(orderSz)) return reject('51083', 'The total size of TP orders with Split TPs attached in a same order should equal the size of this order');
  let sl: AttachedSl | null = null;
  const slObject = slObjects[0];
  if (slObject) {
    if (has(slObject, 'sz')) return bad('sz applies to the take-profits of split TPs only');
    const amend = slObject['amendPxOnTriggerType'];
    if (amend !== undefined && amend !== '' && amend !== '0' && amend !== '1') return bad('amendPxOnTriggerType');
    if (amend === '1' && tps.length < 2) return reject('51085', 'The number of TP orders cannot be less than 2 when cost-price SL is enabled (amendPxOnTriggerType set as 1) for Split TPs');
    const parsed = parseSl(slObject);
    if ('sCode' in parsed) return parsed;
    sl = { ...ids(slObject), ...parsed, amendPxOnTriggerType: amend === '1' };
  }
  return { sl, tps };
}

function checkMargin(ctx: EngineContext, instId: string, tdMode: OkxMgnMode, side: OkxSide, posSide: OkxPosSide, sz: Dec, px: Dec | null, lever: Dec, reduceOnly: boolean): Rejection | null {
  if (reduceOnly) return null;
  const inst = ctx.instruments.get(instId);
  const market = ctx.markets.get(instId);
  if (!inst || !market) return null;
  const openingQty = ctx.account.openingQty(instId, tdMode, side, posSide, sz);
  if (openingQty.lte(0)) return null;
  const top = side === 'buy' ? market.book.bestAsk() : market.book.bestBid();
  const refPx = px ?? top?.px ?? market.markPx;
  const notional = openingQty.mul(d(inst.ctVal)).mul(refPx);
  // An isolated order needs its margin and its fee in the available balance: the margin leaves it for the
  // position, and what is left must still pay the fee (the taker rate, the higher one, is assumed).
  const required = tdMode === 'isolated' ? notional.div(lever).add(notional.mul(ctx.takerFee)) : notional.div(lever);
  const availEq = ctx.account.availEq(ctx.orders.ordFrozen(ctx.instruments));
  if (required.gt(availEq)) return reject('51008', 'Order failed. Insufficient USDT margin in account.');
  return null;
}

/**
 * Validates an algo order placed on its own (POST /api/v5/trade/order-algo) and builds its record. Simulated: for a
 * number of contracts (`sz`; `closeFraction` is refused), a `conditional` order (a stop-loss or a take-profit; with
 * both OKX performs the stop-loss only), an `oco` order (both) and a trailing stop (`move_order_stop`, with
 * `callbackRatio` or `callbackSpread` and an optional `activePx`). The other types are refused with the generic
 * parameter error.
 *
 * - Only closing orders are simulated: every one needs an open position on its closing side, may not exceed it, and
 *   sends a reduce-only order when triggered (in net mode also when placed without `reduceOnly`, which Pegasus always
 *   sends there). Unverified: the codes OKX answers with when there is no position or the size exceeds it; the
 *   simulator uses the ones of an ordinary reduce-only order (51023, 51119). `cxlOnClosePos` (TP/SL orders only) needs
 *   `reduceOnly` in net mode (OKX: "If true is passed in, users must pass reduceOnly = true as well"); the simulator
 *   accepts it in long/short mode as well (unverified there). Without it the order stays after its position is fully
 *   closed (OKX: "the TP/SL order will not be affected when the position is fully closed"); a trailing stop has no
 *   such flag and always stays.
 * - A leg already reached by the price of its trigger type is refused with OKX's code (see parseAttached).
 * - A trailing stop: a callback ratio outside (0, 1) is refused with 51257 (OKX documents the code, not its bounds);
 *   an `activePx` not above the last price for one that sells (below, for one that buys) with 51258 / 51259.
 */
export function validatePlaceAlgo(body: unknown, ctx: EngineContext): StopRec | Rejection {
  const raw = asRecord(body);
  if (!raw) return reject('51000', 'Parameter error');
  const instId = str(raw, 'instId') ?? '';
  const inst = ctx.instruments.get(instId);
  const market = ctx.markets.get(instId);
  if (!inst || !market) return reject('51001', 'Instrument ID does not exist.');
  const tdMode = str(raw, 'tdMode');
  if (tdMode !== 'cross' && tdMode !== 'isolated') return reject('51000', 'Parameter tdMode error');
  const side = str(raw, 'side');
  if (side !== 'buy' && side !== 'sell') return reject('51000', 'Parameter side error');
  const ordType = str(raw, 'ordType');
  if (ordType !== 'conditional' && ordType !== 'oco' && ordType !== 'move_order_stop') return reject('51000', 'Parameter ordType error: only conditional, oco and move_order_stop are simulated');
  if (has(raw, 'closeFraction')) return reject('51000', 'Parameter closeFraction error: not simulated');
  if (has(raw, 'tpOrdKind') && raw['tpOrdKind'] !== 'condition') return reject('51000', 'Parameter tpOrdKind error: a limit take-profit is not simulated');
  const posSideRaw = raw['posSide'];
  let posSide: OkxPosSide;
  if (ctx.posMode === 'long_short_mode') {
    if (posSideRaw !== 'long' && posSideRaw !== 'short') return reject('51000', 'Parameter posSide error');
    posSide = posSideRaw;
  } else {
    if (posSideRaw !== undefined && posSideRaw !== '' && posSideRaw !== 'net') return reject('51000', 'Parameter posSide error');
    posSide = 'net';
  }
  const szStr = str(raw, 'sz');
  if (!szStr || !isDecimalString(szStr) || d(szStr).lte(0)) return reject('51000', 'Parameter sz error');
  const sz = d(szStr);
  if (!isMultipleOf(sz, d(inst.lotSz))) return reject('51121', 'Order quantity must be a multiple of the lot size.');
  const reduceOnlyRaw = parseBool(raw['reduceOnly']);
  if (reduceOnlyRaw === undefined) return reject('51000', 'Parameter reduceOnly error');
  const cxlOnClosePos = ordType === 'move_order_stop' ? false : parseBool(raw['cxlOnClosePos']);
  if (cxlOnClosePos === undefined) return reject('51000', 'Parameter cxlOnClosePos error');
  if (ctx.posMode === 'net_mode' && cxlOnClosePos && !reduceOnlyRaw) return reject('51000', 'Parameter cxlOnClosePos error: reduceOnly must be true with it');
  const entrySide: OkxSide = side === 'sell' ? 'buy' : 'sell';
  // The legs: parsed before anything is looked up, so that a malformed one is refused as a parameter error.
  const legs: Partial<StopRec> = {};
  const isTp = has(raw, 'tpTriggerPx') || has(raw, 'tpOrdPx');
  const isSl = has(raw, 'slTriggerPx') || has(raw, 'slOrdPx');
  if (ordType === 'move_order_stop') {
    for (const key of ['tpTriggerPx', 'tpOrdPx', 'slTriggerPx', 'slOrdPx']) if (has(raw, key)) return reject('51000', `Parameter ${key} error: not applicable to a trailing stop`);
    const ratioStr = str(raw, 'callbackRatio');
    const spreadStr = str(raw, 'callbackSpread');
    if (has(raw, 'callbackRatio') === has(raw, 'callbackSpread')) return reject('51000', 'Parameter error: either callbackRatio or callbackSpread is required');
    if (ratioStr) {
      if (!isDecimalString(ratioStr) || d(ratioStr).lte(0) || d(ratioStr).gte(1)) return reject('51257', 'Trailing stop order callback rate error. The callback rate should be 0< x<100%.');
      legs.callbackRatio = d(ratioStr);
    } else {
      if (!spreadStr || !isDecimalString(spreadStr) || d(spreadStr).lte(0)) return reject('51000', 'Parameter callbackSpread error');
      legs.callbackSpread = d(spreadStr);
    }
    const activeStr = str(raw, 'activePx');
    if (activeStr !== undefined && activeStr !== '') {
      const activePx = triggerOf(activeStr, inst.tickSz);
      if (!activePx) return reject('51000', 'Parameter activePx error');
      // The help center: a trailing stop is activated once the latest price reaches the activation price.
      if (side === 'sell' ? !activePx.gt(market.lastPx) : !activePx.lt(market.lastPx)) {
        return side === 'sell'
          ? reject('51258', 'Trailing stop order placement failed. The trigger price of a sell order must be higher than the last transaction price.')
          : reject('51259', 'Trailing stop order placement failed. The trigger price of a buy order must be lower than the last transaction price.');
      }
      legs.activePx = activePx;
    } else if (market.lastPx.gt(0)) {
      // "If not provided, the trailing stop is activated immediately upon order placement": it trails from the last price.
      legs.extremePx = market.lastPx;
    }
    legs.ordType = 'move_order_stop';
  } else {
    if (!isTp && !isSl) return reject('51000', 'Parameter error: a take-profit or a stop-loss is required');
    if (ordType === 'oco' && !(isTp && isSl)) return reject('51000', 'Parameter error: an oco order needs both a take-profit and a stop-loss');
    if (isSl) {
      const trigger = triggerOf(str(raw, 'slTriggerPx'), inst.tickSz);
      if (!trigger) return reject('51000', 'Parameter slTriggerPx error');
      const slOrdPx = str(raw, 'slOrdPx');
      if (!validOrdPx(slOrdPx)) return reject('51000', 'Parameter slOrdPx error');
      const type = triggerPxType(raw['slTriggerPxType']);
      if (!type) return reject('51000', 'Parameter slTriggerPxType error');
      Object.assign(legs, { slTriggerPx: trigger, slOrdPx, slTriggerPxType: type });
    }
    if (isTp) {
      const trigger = triggerOf(str(raw, 'tpTriggerPx'), inst.tickSz);
      if (!trigger) return reject('51000', 'Parameter tpTriggerPx error');
      const tpOrdPx = str(raw, 'tpOrdPx');
      if (!validOrdPx(tpOrdPx)) return reject('51000', 'Parameter tpOrdPx error');
      const type = triggerPxType(raw['tpTriggerPxType']);
      if (!type) return reject('51000', 'Parameter tpTriggerPxType error');
      // OKX: a conditional order with both performs the stop-loss only, the take-profit is ignored.
      if (ordType === 'oco' || !isSl) Object.assign(legs, { tpTriggerPx: trigger, tpOrdPx, tpTriggerPxType: type });
    }
    legs.ordType = ordType;
  }
  const algoClOrdId = str(raw, 'algoClOrdId') ?? '';
  if (algoClOrdId !== '' && !CL_ORD_ID_RE.test(algoClOrdId)) return reject('51000', 'Parameter algoClOrdId error');
  if (algoClOrdId !== '' && ctx.orders.algoClOrdIdInUse(algoClOrdId)) return reject('51016', 'Duplicated clOrdId.');
  // The position the order closes: open, and on the other side of the order. Only closing algo orders are simulated:
  // one placed in net mode without reduceOnly is treated as reduce-only too (Pegasus always sends the flag there).
  const position = ctx.account.find(instId, tdMode, posSide);
  if (!position || position.qty.isZero() || position.dir !== (side === 'sell' ? 1 : -1)) return reject('51023', 'Position does not exist.');
  if (sz.gt(position.qty)) return reject('51119', 'Order size exceeds the position size on the closing side.');
  if (legs.slTriggerPx) {
    const wrong = slWrongSide(market, legs.slTriggerPx, legs.slTriggerPxType ?? 'last', entrySide);
    if (wrong) return wrong;
  }
  if (legs.tpTriggerPx) {
    const wrong = tpWrongSide(market, legs.tpTriggerPx, legs.tpTriggerPxType ?? 'last', entrySide);
    if (wrong) return wrong;
  }
  const now = ctx.now();
  return algoRecord({ algoId: ctx.orders.newAlgoId(), algoClOrdId, ordId: '', instId, tdMode, posSide, side, sz, cTime: now, uTime: now, reduceOnly: true, cxlOnClosePos, ...legs });
}

export interface AmendAlgoRequest {
  stop: StopRec;
  newSlTriggerPx: Dec | null;
  newSlOrdPx: string | null;
  newSlTriggerPxType: OkxTriggerPxType | null;
  newTpTriggerPx: Dec | null;
  newTpOrdPx: string | null;
  newSz: Dec | null;
  reqId: string;
}

/**
 * Validates an amend of an active TP/SL order (POST /api/v5/trade/amend-algos). The refusals OKX documents are used
 * where one exists: 51527 (the stop order does not exist), 51526 (a take-profit or stop-loss cannot be added to or
 * removed from a stop order: a trigger of 0, or a leg the order does not have) and 51528 (the trigger price type
 * cannot be modified). A trailing stop is not amended this way ("not including Move_order_stop order"); OKX names no
 * code for trying, the simulator answers with the generic parameter error. Unverified: OKX documents no code for an
 * amended trigger on the wrong side of the price; the simulator answers with the codes of a placement.
 */
export function validateAmendAlgo(body: unknown, ctx: EngineContext): AmendAlgoRequest | Rejection {
  const raw = asRecord(body);
  if (!raw) return reject('51000', 'Parameter error');
  const instId = str(raw, 'instId') ?? '';
  const inst = ctx.instruments.get(instId);
  const market = ctx.markets.get(instId);
  if (!inst || !market) return reject('51001', 'Instrument ID does not exist.');
  const algoId = str(raw, 'algoId');
  const algoClOrdId = str(raw, 'algoClOrdId');
  if (!algoId && !algoClOrdId) return reject('51000', 'Either algoId or algoClOrdId is required');
  const stop = ctx.orders.findStop(instId, algoId, algoClOrdId);
  if (!stop) return reject('51527', 'Order modification unsuccessful. The stop order does not exist.');
  if (stop.ordType === 'move_order_stop') return reject('51000', 'Parameter algoId error: a trailing stop cannot be amended (amend-algos supports stop and trigger orders only)');
  const triggerStr = str(raw, 'newSlTriggerPx');
  const ordPxStr = str(raw, 'newSlOrdPx');
  const typeRaw = raw['newSlTriggerPxType'];
  const tpTriggerStr = str(raw, 'newTpTriggerPx');
  const tpOrdPxStr = str(raw, 'newTpOrdPx');
  const tpTypeRaw = raw['newTpTriggerPxType'];
  const szStr = str(raw, 'newSz');
  if (!triggerStr && !ordPxStr && (typeRaw === undefined || typeRaw === '') && !tpTriggerStr && !tpOrdPxStr && (tpTypeRaw === undefined || tpTypeRaw === '') && !szStr) {
    return reject('51000', 'Parameter error: nothing to amend');
  }
  const addOrRemove = (): Rejection => reject('51526', 'Order modification unsuccessful. Take profit/Stop loss conditions cannot be added to or removed from stop orders.');
  let newSlTriggerPx: Dec | null = null;
  if (triggerStr) {
    if (!isDecimalString(triggerStr) || d(triggerStr).lt(0)) return reject('51000', 'Parameter newSlTriggerPx error');
    if (d(triggerStr).isZero() || stop.slTriggerPx === null) return addOrRemove();
    newSlTriggerPx = d(triggerStr);
    if (!isMultipleOf(newSlTriggerPx, d(inst.tickSz))) return reject('51000', 'Parameter newSlTriggerPx error');
  }
  let newSlOrdPx: string | null = null;
  if (ordPxStr) {
    if (!validOrdPx(ordPxStr)) return reject('51000', 'Parameter newSlOrdPx error');
    if (stop.slTriggerPx === null) return addOrRemove();
    newSlOrdPx = ordPxStr;
  }
  let newSlTriggerPxType: OkxTriggerPxType | null = null;
  if (typeRaw !== undefined && typeRaw !== '') {
    newSlTriggerPxType = TRIGGER_PX_TYPES.find((t) => t === typeRaw) ?? null;
    if (!newSlTriggerPxType) return reject('51000', 'Parameter newSlTriggerPxType error');
    if (newSlTriggerPxType !== stop.slTriggerPxType) return reject('51528', 'Unable to modify trigger price type');
  }
  let newTpTriggerPx: Dec | null = null;
  if (tpTriggerStr) {
    if (!isDecimalString(tpTriggerStr) || d(tpTriggerStr).lt(0)) return reject('51000', 'Parameter newTpTriggerPx error');
    if (d(tpTriggerStr).isZero() || stop.tpTriggerPx === null) return addOrRemove();
    newTpTriggerPx = d(tpTriggerStr);
    if (!isMultipleOf(newTpTriggerPx, d(inst.tickSz))) return reject('51000', 'Parameter newTpTriggerPx error');
  }
  let newTpOrdPx: string | null = null;
  if (tpOrdPxStr) {
    if (!validOrdPx(tpOrdPxStr)) return reject('51000', 'Parameter newTpOrdPx error');
    if (stop.tpTriggerPx === null) return addOrRemove();
    newTpOrdPx = tpOrdPxStr;
  }
  if (tpTypeRaw !== undefined && tpTypeRaw !== '') {
    const type = TRIGGER_PX_TYPES.find((t) => t === tpTypeRaw);
    if (!type) return reject('51000', 'Parameter newTpTriggerPxType error');
    if (type !== stop.tpTriggerPxType) return reject('51528', 'Unable to modify trigger price type');
  }
  let newSz: Dec | null = null;
  if (szStr) {
    if (!isDecimalString(szStr) || d(szStr).lte(0)) return reject('51000', 'Parameter newSz error');
    newSz = d(szStr);
    if (!isMultipleOf(newSz, d(inst.lotSz))) return reject('51121', 'Order quantity must be a multiple of the lot size.');
  }
  // The resulting legs must not already be reached by the price that triggers them. The codes are keyed by the side
  // of the order they protect: an order that sells protects a buy.
  const entrySide: OkxSide = stop.side === 'sell' ? 'buy' : 'sell';
  const sl = newSlTriggerPx ?? stop.slTriggerPx;
  if (sl) {
    const wrong = slWrongSide(market, sl, newSlTriggerPxType ?? stop.slTriggerPxType, entrySide);
    if (wrong) return wrong;
  }
  const tp = newTpTriggerPx ?? stop.tpTriggerPx;
  if (tp) {
    const wrong = tpWrongSide(market, tp, stop.tpTriggerPxType, entrySide);
    if (wrong) return wrong;
  }
  return { stop, newSlTriggerPx, newSlOrdPx, newSlTriggerPxType, newTpTriggerPx, newTpOrdPx, newSz, reqId: str(raw, 'reqId') ?? '' };
}

export interface AmendRequest {
  order: OrderRec;
  newSz: Dec | null;
  newPx: Dec | null;
  reqId: string;
}

export function validateAmend(body: unknown, ctx: EngineContext): AmendRequest | Rejection {
  const raw = asRecord(body);
  if (!raw) return reject('51000', 'Parameter error');
  const instId = str(raw, 'instId') ?? '';
  const inst = ctx.instruments.get(instId);
  if (!inst) return reject('51001', 'Instrument ID does not exist.');
  const order = ctx.orders.findLive(instId, str(raw, 'ordId'), str(raw, 'clOrdId'));
  if (!order) return reject('51503', 'Order modification failed as the order has been filled, canceled or does not exist.');
  const newSzStr = str(raw, 'newSz');
  const newPxStr = str(raw, 'newPx');
  if (!newSzStr && !newPxStr) return reject('51000', 'Parameter newSz or newPx error');
  let newSz: Dec | null = null;
  if (newSzStr) {
    if (!isDecimalString(newSzStr)) return reject('51000', 'Parameter newSz error');
    newSz = d(newSzStr);
    if (!isMultipleOf(newSz, d(inst.lotSz))) return reject('51121', 'Order quantity must be a multiple of the lot size.');
    if (newSz.lte(order.accFillSz)) return reject('51000', 'Parameter newSz error');
  }
  let newPx: Dec | null = null;
  if (newPxStr) {
    if (order.ordType === 'market' || !isDecimalString(newPxStr) || d(newPxStr).lte(0)) return reject('51000', 'Parameter newPx error');
    newPx = d(newPxStr);
    if (!isMultipleOf(newPx, d(inst.tickSz))) return reject('51000', 'Parameter newPx error');
  }
  return { order, newSz, newPx, reqId: str(raw, 'reqId') ?? '' };
}
