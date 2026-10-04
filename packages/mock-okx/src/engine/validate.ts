import { d, isDecimalString, isMultipleOf, ZERO, type Dec } from '../num.js';
import type { OkxMgnMode, OkxOrdType, OkxPosSide, OkxSide, OkxTriggerPxType } from '../wire.js';
import { reject, type EngineContext, type Rejection } from './context.js';
import type { AttachedSl, OrderRec } from './orders.js';

const ORD_TYPES: readonly OkxOrdType[] = ['market', 'limit', 'post_only', 'fok', 'ioc'];
const CL_ORD_ID_RE = /^[A-Za-z0-9]{1,32}$/;
const TAG_RE = /^[A-Za-z0-9]{1,16}$/;
const TRIGGER_PX_TYPES: readonly OkxTriggerPxType[] = ['last', 'index', 'mark'];

/**
 * OKX's codes for a stop-loss on the wrong side, by trigger price type and order side: a buy's stop "cannot be
 * higher than" the price, a sell's "cannot be lower than" it.
 */
const WRONG_SIDE_CODES: Record<OkxTriggerPxType, Record<OkxSide, string>> = {
  last: { sell: '51278', buy: '51280' },
  mark: { sell: '51302', buy: '51304' },
  index: { sell: '51306', buy: '51308' },
};

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
  const lever = account.leverFor(instId, tdMode, posSide);
  const marginError = checkMargin(ctx, inst.instId, tdMode, side, posSide, sz, px, lever, reduceOnly);
  if (marginError) return marginError;
  const attachSl = parseAttachedSl(raw['attachAlgoOrds'], ctx, instId, side, px, opening && !reduceOnly);
  if (attachSl && 'sCode' in attachSl) return attachSl;

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
    attachSl,
  };
}

/**
 * The stop-loss of `attachAlgoOrds`, or null when the order carries none. Only one attached order with a
 * stop-loss is simulated; take-profit fields are refused rather than silently dropped.
 *
 * A stop on the wrong side of the price that triggers it is refused with OKX's documented code for that trigger
 * price type and side (51278/51280 last, 51302/51304 mark, 51306/51308 index). The other refusals are the generic
 * parameter error 51000: OKX documents no code for them.
 */
function parseAttachedSl(value: unknown, ctx: EngineContext, instId: string, side: OkxSide, px: Dec | null, opening: boolean): AttachedSl | Rejection | null {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return null;
  const bad = (what: string): Rejection => reject('51000', `Parameter attachAlgoOrds error: ${what}`);
  if (!Array.isArray(value) || value.length !== 1) return bad('exactly one attached order is simulated');
  const a = asRecord(value[0]);
  if (!a) return bad('object expected');
  for (const tp of ['tpTriggerPx', 'tpOrdPx', 'tpTriggerPxType']) if (a[tp] !== undefined && a[tp] !== '') return bad('take-profit is not simulated');
  const inst = ctx.instruments.get(instId);
  const market = ctx.markets.get(instId);
  if (!inst || !market) return reject('51001', 'Instrument ID does not exist.');
  const triggerStr = str(a, 'slTriggerPx');
  if (!triggerStr || !isDecimalString(triggerStr) || d(triggerStr).lte(0) || !isMultipleOf(d(triggerStr), d(inst.tickSz))) return bad('slTriggerPx');
  const slOrdPx = str(a, 'slOrdPx');
  if (!slOrdPx || (slOrdPx !== '-1' && (!isDecimalString(slOrdPx) || d(slOrdPx).lte(0)))) return bad('slOrdPx');
  const typeRaw = a['slTriggerPxType'];
  // OKX's default trigger price type is the last price.
  const slTriggerPxType = typeRaw === undefined || typeRaw === '' ? 'last' : TRIGGER_PX_TYPES.find((t) => t === typeRaw);
  if (!slTriggerPxType) return bad('slTriggerPxType');
  const attachAlgoClOrdId = str(a, 'attachAlgoClOrdId') ?? '';
  if (attachAlgoClOrdId !== '' && !CL_ORD_ID_RE.test(attachAlgoClOrdId)) return bad('attachAlgoClOrdId');
  if (!opening) return bad('a stop-loss cannot be attached to an order that closes a position');
  // Wrong side: already reached by the price that triggers it (the index price is not modelled apart from the mark).
  const trigger = d(triggerStr);
  const triggerRef = slTriggerPxType === 'last' ? market.lastPx : market.markPx;
  const losing = (ref: Dec): boolean => (side === 'buy' ? trigger.lt(ref) : trigger.gt(ref));
  if (!losing(triggerRef)) return reject(WRONG_SIDE_CODES[slTriggerPxType][side], `SL trigger price cannot be ${side === 'buy' ? 'higher' : 'lower'} than the ${slTriggerPxType} price`);
  // At or beyond the order's own price: no documented code.
  if (!losing(px ?? market.lastPx)) return bad(`the SL trigger price must be ${side === 'buy' ? 'lower' : 'higher'} than the order price`);
  return { attachAlgoId: ctx.orders.newAlgoId(), attachAlgoClOrdId, slTriggerPx: trigger, slOrdPx, slTriggerPxType };
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
  const required = openingQty.mul(d(inst.ctVal)).mul(refPx).div(lever);
  const availEq = ctx.account.availEq(ctx.orders.ordFrozen(ctx.instruments));
  if (required.gt(availEq)) return reject('51008', 'Order failed. Insufficient USDT margin in account.');
  return null;
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
