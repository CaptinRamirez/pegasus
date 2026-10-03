import { d, isDecimalString, isMultipleOf, ZERO, type Dec } from '../num.js';
import type { OkxMgnMode, OkxOrdType, OkxPosSide, OkxSide } from '../wire.js';
import { reject, type EngineContext, type Rejection } from './context.js';
import type { OrderRec } from './orders.js';

const ORD_TYPES: readonly OkxOrdType[] = ['market', 'limit', 'post_only', 'fok', 'ioc'];
const CL_ORD_ID_RE = /^[A-Za-z0-9]{1,32}$/;
const TAG_RE = /^[A-Za-z0-9]{1,16}$/;

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
  };
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
