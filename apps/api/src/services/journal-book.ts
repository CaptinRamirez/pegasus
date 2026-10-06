import {
  CL_ORD_PREFIXES,
  contractsToCoin,
  D,
  Decimal,
  isLiquidationOrder,
  positionDirection,
  sourceOfClOrdId,
  ZERO,
  type AlgoOrder,
  type Fill,
  type Instrument,
  type JournalEvent,
  type JournalTrade,
  type JournalTradeSummary,
  type Order,
  type OrderCategory,
  type PlaceOrderRequest,
  type Position,
  type PosSide,
  type TdMode,
  type TradeExitReason,
  type TradeFillRole,
  type TradePlan,
  type TradeSource,
  type TradeStatus,
} from '@pegasus/shared';
import { MAX_FILL_KEYS, MAX_PENDING, type JournalData, type PendingOrder, type TrackedAlgo, type TradeOrderRef, type TradeRecord } from './journal-file.js';

/**
 * The trade journal's bookkeeping: assembles trades from what the account reports, without any I/O (the service,
 * journal.ts, feeds it and saves it). Every input is applied in the order it is given; fills must come in the order
 * they happened.
 *
 * Trades. A trade is one position's life on one leg (instrument, margin mode, position side) from flat to flat. A fill
 * on a leg without an open trade opens one, unless it can only close (a reduce-only or liquidation order in net mode,
 * the closing side of a leg in long/short mode): such a fill closes a position the journal never saw open and is not
 * recorded in a trade. A fill in the trade's direction adds to it (role `open` for the fills of the first order, `add`
 * for later orders); one against it reduces it (`reduce`) or takes it to flat (`close`). A net-mode order that is not
 * reduce-only and is larger than the position closes the trade and opens the next one, the other way, with the rest
 * (its fee split in proportion).
 *
 * Arithmetic. The entry average is that of all the opening fills; the P&L of a close is measured from the position's
 * running average (what the exchange books it against: an add after a partial close moves it, a close does not),
 * linear contracts on the base coin, inverse ones on the harmonic average. Fees are the fills' own, positive when
 * paid. Funding is what the exchange last reported on the open position (its accumulated fundingFee). Net P&L =
 * realised - fees + funding; R = net P&L over the initial risk, once closed: the loss of the first order's contracts
 * from their average price to the initial stop (the stop the order carried, else the first stop-loss the exchange
 * listed on the position before any of it was closed).
 *
 * Source (sourceOf). Client order id `pc`: campaign. Otherwise the request of the order when Pegasus placed it
 * (OrderService.onPlaced; `source`, 'manual' when absent); for an order whose request the journal has not seen, the
 * prefix: `ps` signal, `pg` manual, anything else external.
 *
 * Exit reasons (exitReasonOf), per closing order, decided at its first fill:
 * 1. an order of category full_liquidation / partial_liquidation: liquidation; adl: adl;
 * 2. client order id `pc`: campaign; an order Pegasus placed (its request seen, or a `pg` / `ps` id): manual;
 * 3. otherwise (an algo order's closing order carries no client order id of Pegasus): the algo orders last listed on
 *    the position, and those that ended in the last ALGO_ENDED_GRACE_MS, are matched by price, the fill's own and the
 *    mark price when it filled (the exchange's fillMarkPx: a stop triggers on the mark, and its market order may fill
 *    away from it). A stop-loss matches a price at or beyond its trigger (for a long: at or below the trigger x
 *    (1 + ALGO_MATCH_TOLERANCE)), a take-profit one at or beyond its own (for a long: at or above the trigger x
 *    (1 - tolerance)); of those that match, the one whose trigger is nearest wins. A take-profit gives take_profit with its leg; a stop gives
 *    trailing when it counts as the trade's trailing exit, stop otherwise; the exchange's trailing stop (OKX
 *    move_order_stop) counts with the price it last triggered at, and gives trailing;
 * 4. no match: trailing when the position has an exchange trailing stop (whose trigger moved since it was read) or the
 *    plan has a callback trailing exit, external otherwise. An algo order placed and triggered between two reads of
 *    the list (the account reads it every minute, and shortly after every fill, cancel and change made through
 *    Pegasus) was never seen: its close is external.
 *
 * Algo orders (algoOrders), diffed against the last list for every open trade and for trades closed in the last
 * RECENTLY_CLOSED_MS: one that appears is placed (stop / take-profit / trailing), a trigger that changes is moved, one
 * that disappears is triggered when an exit was matched to it, cancelled otherwise (code POSITION_CLOSED when the
 * trade was closed by then). A stop counts as the trailing exit when Pegasus's channel trailing placed it (client id
 * `ch`), or when the plan has a channel trailing exit and the stop was not attached to the opening order or has been
 * moved since; the exchange's trailing stop always does (the price it triggers at follows the market and is not
 * logged as a move). Attached: its client id ends with the tail of the opening order's (the algo orders attached to an
 * order of Pegasus carry it), or its trigger is the plan's own. A take-profit's leg is the one its client id names
 * (`tp<n>`, the take-profits Pegasus attaches), else the plan's leg with the nearest trigger, else the order in which
 * they appeared.
 */

/** What the journal needs of the order of a fill. */
export interface OrderFacts {
  ordId: string;
  clOrdId: string;
  tdMode: TdMode;
  reduceOnly: boolean;
  /** The leverage set the order was placed at; '' when not reported */
  lever: string;
  category?: OrderCategory;
}

export function orderFacts(o: Order): OrderFacts {
  const facts: OrderFacts = { ordId: o.ordId, clOrdId: o.clOrdId, tdMode: o.tdMode, reduceOnly: o.reduceOnly, lever: o.lever };
  if (o.category !== undefined) facts.category = o.category;
  return facts;
}

export interface JournalBookOptions {
  /** The contract spec of an instrument; the service makes sure there is one */
  specOf(instId: string): Instrument;
  /** Server time */
  now(): number;
}

export interface JournalFilter {
  status?: TradeStatus;
  instId?: string;
  source?: TradeSource;
}

/** A fill's price within this fraction of an algo order's trigger (or beyond it) matches that algo. */
export const ALGO_MATCH_TOLERANCE = '0.01';
/** An algo order that disappeared from the list this recently can still be matched to a fill that comes after. */
export const ALGO_ENDED_GRACE_MS = 5 * 60_000;
/** Trades closed this recently still follow their algo orders (the ones the close cancelled). */
export const RECENTLY_CLOSED_MS = 60 * 60_000;
/** Plans of orders that never filled are kept this long. */
export const PENDING_MAX_AGE_MS = 7 * 86_400_000;
/** Characters of an order's client id that the exchange's attached algo orders carry at their end. */
const ATTACHED_TAIL = 8;
/** Client id prefix of the stops Pegasus's channel trailing places (services/channel-trailing.ts). */
const CHANNEL_STOP_PREFIX = 'ch';
/** Client id of a take-profit leg Pegasus attached: `tp` + the leg's number + the tail of the order's id. */
const TP_LEG_RE = /^tp([1-9])/;

/** The key a fill is recognised by when it is read again: the exchange's own close (a liquidation) is no trade, its id is '0' on the push and negative in the list of fills, so it is one fill per order. */
export function journalFillKey(f: Pick<Fill, 'instId' | 'tradeId' | 'ordId'>): string {
  const exchangeClose = f.tradeId === '' || f.tradeId === '0' || f.tradeId.startsWith('-');
  return exchangeClose ? `${f.instId}:x:${f.ordId}` : `${f.instId}:${f.tradeId}:${f.ordId}`;
}

const legKey = (instId: string, mgnMode: string, posSide: string): string => `${instId}:${mgnMode}:${posSide}`;
/** Ratios and averages born of a division: 15 significant digits. */
const fine = (v: Decimal): string => v.toSignificantDigits(15).toFixed();

function contractUnit(inst: Instrument): Decimal {
  return D(inst.ctVal).mul(D(inst.ctMult || '1'));
}

/** The average's numerator of `contracts` filled at `px`: px x contracts (linear), contracts / px (inverse, a harmonic average). */
function valueOf(inst: Instrument, px: Decimal, contracts: Decimal): Decimal {
  return inst.ctType === 'inverse' ? contracts.div(px) : px.mul(contracts);
}

function averageOf(inst: Instrument, contracts: Decimal, value: Decimal): Decimal {
  if (contracts.lte(0) || value.lte(0)) return ZERO;
  return inst.ctType === 'inverse' ? contracts.div(value) : value.div(contracts);
}

/** Base coin of fills whose average's numerator is `value`: contracts x unit (linear), unit x Σ contracts / px (inverse). */
function coinOfValue(inst: Instrument, contracts: Decimal, value: Decimal): Decimal {
  return inst.ctType === 'inverse' ? contractUnit(inst).mul(value) : contractsToCoin(contracts, inst);
}

/** Notional of fills: Σ px x contracts x unit (linear), contracts x unit (inverse). */
function notionalOfValue(inst: Instrument, contracts: Decimal, value: Decimal): Decimal {
  return inst.ctType === 'inverse' ? contracts.mul(contractUnit(inst)) : value.mul(contractUnit(inst));
}

/** P&L of closing `contracts` at `px` against the average `avgPx`, in the settlement currency. */
export function closePnl(inst: Instrument, direction: 'long' | 'short', avgPx: Decimal, px: Decimal, contracts: Decimal): Decimal {
  if (avgPx.lte(0) || px.lte(0)) return ZERO;
  const pnl = inst.ctType === 'inverse' ? contracts.mul(contractUnit(inst)).mul(D(1).div(avgPx).minus(D(1).div(px))) : px.minus(avgPx).mul(contractsToCoin(contracts, inst));
  return direction === 'long' ? pnl : pnl.neg();
}

/** Where an order comes from (see the header). */
export function sourceOf(clOrdId: string, pending: PendingOrder | undefined): TradeSource {
  if (clOrdId.startsWith(CL_ORD_PREFIXES.campaign)) return 'campaign';
  if (pending) return pending.source;
  return sourceOfClOrdId(clOrdId);
}

/** The plan an order of Pegasus carries; null for the campaign's (its rule is its plan). */
export function planOf(req: PlaceOrderRequest, order: Order, source: TradeSource): TradePlan | null {
  if (source === 'campaign') return null;
  return {
    // the stop as the order service rounded it to the tick
    slTriggerPx: order.slTriggerPx ?? req.slTriggerPx ?? null,
    takeProfits: (req.takeProfits ?? []).map((leg) => ({ ...leg })),
    breakevenAfterTp1: req.breakevenAfterTp1 ?? false,
    trailing: req.trailing === undefined ? null : { ...req.trailing },
    signal: req.signal === undefined ? null : { ...req.signal },
  };
}

interface ExitDecision {
  reason: TradeExitReason;
  leg: number | null;
  algo: TrackedAlgo | null;
}

export class JournalBook {
  /** Trade ids changed since the last takeChanged() */
  private readonly changed = new Set<string>();
  private readonly keys: Set<string>;
  /** Open trades by leg */
  private readonly open = new Map<string, TradeRecord>();

  constructor(
    readonly data: JournalData,
    private readonly opts: JournalBookOptions,
  ) {
    this.keys = new Set(data.fillKeys);
    for (const rec of data.trades) if (rec.trade.status === 'open') this.open.set(legKey(rec.trade.instId, rec.trade.mgnMode, rec.trade.posSide), rec);
  }

  // ---- queries ----

  openTrade(instId: string, mgnMode: TdMode, posSide: PosSide): TradeRecord | undefined {
    return this.open.get(legKey(instId, mgnMode, posSide));
  }

  openTrades(): TradeRecord[] {
    return [...this.open.values()];
  }

  find(id: string): TradeRecord | undefined {
    return this.data.trades.find((r) => r.trade.id === id);
  }

  /** Trades matching the filter, newest first (highest seq first), `limit` of them older than `before` (a seq). */
  list(filter: JournalFilter, before: number | undefined, limit: number): { trades: JournalTradeSummary[]; total: number; next: number | null } {
    const matching = this.data.trades.filter((r) => (filter.status === undefined || r.trade.status === filter.status) && (filter.instId === undefined || r.trade.instId === filter.instId) && (filter.source === undefined || r.trade.source === filter.source));
    const older = before === undefined ? matching : matching.filter((r) => r.trade.seq < before);
    const page = older.slice(-limit).reverse();
    const last = page[page.length - 1];
    return { trades: page.map((r) => summaryOf(r.trade)), total: matching.length, next: older.length > limit && last ? last.trade.seq : null };
  }

  /** Whether a fill was recorded already. */
  hasFill(f: Pick<Fill, 'instId' | 'tradeId' | 'ordId'>): boolean {
    return this.keys.has(journalFillKey(f));
  }

  /** Contracts of an order's fills recorded in its trade; 0 when none. */
  filledOf(ordId: string): Decimal {
    let total = ZERO;
    for (const rec of this.data.trades) {
      const ref = rec.book.orders[ordId];
      if (ref) total = total.plus(ref.contracts);
    }
    return total;
  }

  /** The trades changed since the last call, newest first. */
  takeChanged(): JournalTradeSummary[] {
    const ids = this.changed;
    if (ids.size === 0) return [];
    const out = this.data.trades.filter((r) => ids.has(r.trade.id)).map((r) => summaryOf(r.trade));
    ids.clear();
    return out.reverse();
  }

  get hasChanges(): boolean {
    return this.changed.size > 0;
  }

  // ---- inputs ----

  /** An order Pegasus placed (OrderService.onPlaced): its plan waits for the trade it opens; one on the leg of an open trade joins its timeline. */
  placed(req: PlaceOrderRequest, order: Order): void {
    const now = this.opts.now();
    const source: TradeSource = order.clOrdId.startsWith(CL_ORD_PREFIXES.campaign) ? 'campaign' : (req.source ?? 'manual');
    const pending: PendingOrder = {
      clOrdId: order.clOrdId,
      ordId: order.ordId,
      instId: order.instId,
      tdMode: order.tdMode,
      posSide: order.posSide,
      side: order.side,
      ordType: order.ordType,
      contracts: order.sz,
      px: order.px,
      reduceOnly: order.reduceOnly,
      ts: order.cTime || now,
      source,
      plan: planOf(req, order, source),
    };
    this.data.pending = this.data.pending.filter((p) => p.clOrdId !== pending.clOrdId && now - p.ts < PENDING_MAX_AGE_MS);
    this.data.pending.push(pending);
    if (this.data.pending.length > MAX_PENDING) this.data.pending.splice(0, this.data.pending.length - MAX_PENDING);
    // Its fills may have come first: the order is in a trade already.
    for (let i = this.data.trades.length - 1; i >= 0; i--) {
      const rec = this.data.trades[i] as TradeRecord;
      const ref = rec.book.orders[order.ordId];
      if (!ref) continue;
      this.logPlaced(rec, ref, pending);
      if (order.ordId === rec.book.openingOrdId && rec.trade.source !== 'campaign') {
        rec.trade.source = source;
        rec.trade.plan = pending.plan;
        if (pending.plan?.slTriggerPx) rec.trade.initialStop = pending.plan.slTriggerPx;
      }
      this.refresh(rec);
      return;
    }
    const rec = this.openTrade(order.instId, order.tdMode, order.posSide);
    if (rec) {
      const ref = this.orderRef(rec, order.ordId, order.clOrdId, 'pending');
      this.logPlaced(rec, ref, pending);
      this.refresh(rec);
    }
  }

  /** An order update: a cancelled order of a trade joins its timeline; the plan of one cancelled without a fill is dropped. */
  order(o: Order): void {
    if (o.state !== 'canceled') return;
    const filled = D(o.accFillSz || '0');
    if (filled.isZero()) this.data.pending = this.data.pending.filter((p) => p.ordId !== o.ordId);
    for (const rec of this.data.trades) {
      const ref = rec.book.orders[o.ordId];
      if (!ref || ref.cancelled) continue;
      ref.cancelled = true;
      const left = D(o.sz || '0').minus(filled);
      this.event(rec, { ts: o.uTime || this.opts.now(), kind: 'order_cancelled', ordId: o.ordId, clOrdId: o.clOrdId, contracts: Decimal.max(left, ZERO).toFixed() });
      this.refresh(rec);
    }
  }

  /**
   * Whether a fill would close contracts of an open trade without saying why: no liquidation, no client order id of
   * Pegasus. Its exit reason then comes from the algo orders, for which the mark price when it filled helps.
   */
  closesUnexplained(f: Fill, o: OrderFacts): boolean {
    if (isLiquidationOrder(o) || o.category === 'adl') return false;
    const clOrdId = f.clOrdId || o.clOrdId;
    if (clOrdId !== '' && (this.pendingOf(clOrdId, f.ordId) !== undefined || sourceOfClOrdId(clOrdId) !== 'external')) return false;
    const rec = this.openTrade(f.instId, o.tdMode, f.posSide);
    return rec !== undefined && (rec.trade.direction === 'long') !== (f.side === 'buy');
  }

  /** A fill with its order, and the mark price when it filled when known. Returns false when it was recorded already. */
  fill(f: Fill, o: OrderFacts, markPx: string | null = null): boolean {
    const key = journalFillKey(f);
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    this.data.fillKeys.push(key);
    if (this.data.fillKeys.length > MAX_FILL_KEYS + 1_000) {
      const dropped = this.data.fillKeys.splice(0, this.data.fillKeys.length - MAX_FILL_KEYS);
      for (const k of dropped) this.keys.delete(k);
    }
    if (this.data.lastFillTs === null || f.ts > this.data.lastFillTs) this.data.lastFillTs = f.ts;
    const contracts = D(f.fillSz || '0');
    const px = D(f.fillPx || '0');
    if (contracts.lte(0) || px.lte(0)) return true;
    const inst = this.opts.specOf(f.instId);
    const fee = D(f.fee || '0');
    const exchangeClose = isLiquidationOrder(o) || o.category === 'adl';
    const rec = this.openTrade(f.instId, o.tdMode, f.posSide);
    if (!rec) {
      const closes = f.posSide === 'long' ? f.side === 'sell' : f.posSide === 'short' ? f.side === 'buy' : o.reduceOnly || exchangeClose;
      // A close of a position the journal never saw open; the consistency check adopts what is still open.
      if (!closes) this.openWith(f, o, inst, f.posSide === 'short' || (f.posSide === 'net' && f.side === 'sell') ? 'short' : 'long', contracts, fee);
      return true;
    }
    const t = rec.trade;
    if ((t.direction === 'long') === (f.side === 'buy')) {
      this.grow(rec, f, o, inst, contracts, fee);
      return true;
    }
    const size = D(t.size);
    const closing = Decimal.min(contracts, size);
    const closingFee = fee.mul(closing).div(contracts);
    const mark = markPx !== null && markPx !== '' && D(markPx).gt(0) ? D(markPx) : null;
    this.shrink(rec, f, o, inst, closing, closingFee, mark);
    const rest = contracts.minus(closing);
    if (rest.gt(0) && f.posSide === 'net' && !o.reduceOnly && !exchangeClose) {
      this.openWith(f, o, inst, t.direction === 'long' ? 'short' : 'long', rest, fee.minus(closingFee));
    }
    return true;
  }

  /** The algo orders as last read (AlgoOrderList): what was placed, moved, triggered or cancelled on the trades' positions. */
  algoOrders(list: readonly AlgoOrder[], ts: number): void {
    const now = this.opts.now();
    for (const rec of this.data.trades) {
      const t = rec.trade;
      const open = t.status === 'open';
      if (!open && (t.closedAt === null || now - t.closedAt > RECENTLY_CLOSED_MS || Object.values(rec.book.algos).every((a) => a.ended))) continue;
      const closingSide = t.direction === 'long' ? 'sell' : 'buy';
      const current = list.filter((a) => a.instId === t.instId && a.tdMode === t.mgnMode && a.posSide === t.posSide && a.side === closingSide);
      let touched = false;
      for (const a of current) {
        const known = rec.book.algos[a.algoId];
        if (!known) {
          // A closed trade gains no new algo orders: one listed now belongs to the next position.
          if (open) {
            this.algoPlaced(rec, a, ts);
            touched = true;
          }
        } else if (!known.ended) {
          touched = this.algoUpdated(rec, known, a, ts) || touched;
        }
      }
      const listed = new Set(current.map((a) => a.algoId));
      for (const known of Object.values(rec.book.algos)) {
        if (known.ended || listed.has(known.algoId)) continue;
        this.algoEnded(rec, known, ts);
        touched = true;
      }
      if (touched) this.refresh(rec);
    }
  }

  /** The positions as the account shows them: the margin and leverage of trades that hold only their opening order. */
  positions(list: readonly Position[]): void {
    for (const rec of this.open.values()) {
      const t = rec.trade;
      const p = list.find((x) => x.instId === t.instId && x.mgnMode === t.mgnMode && x.posSide === t.posSide && !D(x.pos || '0').isZero());
      if (!p) continue;
      let touched = false;
      if (p.lever !== '' && rec.book.lever === '') {
        rec.book.lever = p.lever;
        touched = true;
      }
      const onlyOpening = Object.values(rec.book.orders).every((r) => r.role === 'open' || r.role === 'pending');
      if (onlyOpening && p.margin !== '' && D(p.margin).gt(0) && t.entry.margin !== p.margin) {
        t.entry.margin = p.margin;
        touched = true;
      }
      if (touched) this.refresh(rec);
    }
  }

  /** The funding the exchange reports on an open position (its fundingFee): received positive, paid negative. */
  funding(instId: string, mgnMode: TdMode, posSide: PosSide, fundingFee: string): void {
    const rec = this.openTrade(instId, mgnMode, posSide);
    if (!rec || rec.trade.funding === fundingFee || !/^-?\d+(\.\d+)?$/.test(fundingFee)) return;
    rec.trade.funding = fundingFee;
    this.refresh(rec);
  }

  /** A position the journal did not see open: a trade from what the exchange reports of it. */
  adopt(p: Position, source: TradeSource): TradeRecord | null {
    const direction = positionDirection(p);
    const avg = D(p.avgPx || '0');
    if (direction === null || avg.lte(0) || this.openTrade(p.instId, p.mgnMode, p.posSide)) return null;
    const now = this.opts.now();
    const inst = this.opts.specOf(p.instId);
    const size = D(p.pos).abs();
    const value = valueOf(inst, avg, size);
    const rec = this.newTrade({
      instId: p.instId,
      mgnMode: p.mgnMode,
      posSide: p.posSide,
      direction,
      source,
      openedAt: p.cTime || now,
      inst,
      plan: null,
      openingOrdId: '',
      openingClOrdId: '',
      avgPx: avg.toFixed(),
      lever: p.lever,
    });
    const t = rec.trade;
    t.adopted = true;
    t.size = size.toFixed();
    t.entry = { ...t.entry, avgPx: avg.toFixed(), contracts: size.toFixed(), coin: fine(coinOfValue(inst, size, value)), notional: fine(notionalOfValue(inst, size, value)), maxContracts: size.toFixed(), margin: p.margin !== '' && D(p.margin).gt(0) ? p.margin : null };
    rec.book.openedContracts = size.toFixed();
    rec.book.openedValue = value.toFixed();
    rec.book.lastActivity = now;
    this.event(rec, { ts: now, kind: 'adopted', px: avg.toFixed(), contracts: size.toFixed(), code: 'POSITION_ADOPTED' });
    this.refresh(rec);
    return rec;
  }

  /** The position of an open trade is gone and the exchange's fills do not say how: closed, reason unknown, no exit recorded. */
  closeGone(rec: TradeRecord): void {
    const t = rec.trade;
    if (t.status !== 'open') return;
    const now = this.opts.now();
    this.event(rec, { ts: now, kind: 'reconciled', contracts: t.size, code: 'POSITION_GONE' });
    t.size = '0';
    this.closeTrade(rec, now, 'unknown');
    rec.book.lastActivity = now;
    this.refresh(rec);
  }

  /** The exchange shows another size for an open trade than its fills add up to: the exchange's size and average from now on. */
  correctSize(rec: TradeRecord, p: Position): void {
    const t = rec.trade;
    const size = D(p.pos || '0').abs();
    if (t.status !== 'open' || size.isZero() || size.eq(t.size)) return;
    const now = this.opts.now();
    this.event(rec, { ts: now, kind: 'reconciled', contracts: size.toFixed(), px: p.avgPx, code: 'SIZE_CORRECTED' });
    t.size = size.toFixed();
    if (size.gt(t.entry.maxContracts)) t.entry.maxContracts = size.toFixed();
    if (p.avgPx !== '' && D(p.avgPx).gt(0)) rec.book.avgPx = p.avgPx;
    rec.book.lastActivity = now;
    this.refresh(rec);
  }

  // ---- trades ----

  private newTrade(a: { instId: string; mgnMode: TdMode; posSide: PosSide; direction: 'long' | 'short'; source: TradeSource; openedAt: number; inst: Instrument; plan: TradePlan | null; openingOrdId: string; openingClOrdId: string; avgPx: string; lever: string }): TradeRecord {
    const seq = ++this.data.seq;
    const now = this.opts.now();
    const trade: JournalTrade = {
      id: `${seq}-${a.instId}`,
      seq,
      instId: a.instId,
      mgnMode: a.mgnMode,
      posSide: a.posSide,
      direction: a.direction,
      source: a.source,
      status: 'open',
      openedAt: a.openedAt,
      closedAt: null,
      durationMs: null,
      updatedAt: now,
      ccy: a.inst.settleCcy || a.inst.quoteCcy,
      entry: { avgPx: a.avgPx, contracts: '0', coin: '0', notional: '0', maxContracts: '0', leverage: null, mgnMode: a.mgnMode, margin: null },
      size: '0',
      exitPx: null,
      plan: a.plan,
      initialStop: a.plan?.slTriggerPx ?? null,
      initialRisk: null,
      fees: '0',
      funding: null,
      realisedPnl: '0',
      netPnl: '0',
      rMultiple: null,
      exits: [],
      closeReason: null,
      adopted: false,
      fills: [],
      timeline: [],
    };
    const rec: TradeRecord = {
      trade,
      book: { openedContracts: '0', openedValue: '0', openingOrdId: a.openingOrdId, openingClOrdId: a.openingClOrdId, avgPx: a.avgPx, lever: a.lever, orders: {}, algos: {}, lastActivity: now },
    };
    this.data.trades.push(rec);
    this.open.set(legKey(a.instId, a.mgnMode, a.posSide), rec);
    return rec;
  }

  private openWith(f: Fill, o: OrderFacts, inst: Instrument, direction: 'long' | 'short', contracts: Decimal, fee: Decimal): void {
    const clOrdId = f.clOrdId || o.clOrdId;
    const pending = this.pendingOf(clOrdId, f.ordId);
    const source = sourceOf(clOrdId, pending);
    const plan = source === 'manual' || source === 'signal' ? (pending?.plan ?? null) : null;
    const rec = this.newTrade({ instId: f.instId, mgnMode: o.tdMode, posSide: f.posSide, direction, source, openedAt: f.ts, inst, plan, openingOrdId: f.ordId, openingClOrdId: clOrdId, avgPx: f.fillPx, lever: o.lever });
    this.grow(rec, f, o, inst, contracts, fee);
  }

  /** A fill in the trade's direction. */
  private grow(rec: TradeRecord, f: Fill, o: OrderFacts, inst: Instrument, contracts: Decimal, fee: Decimal): void {
    const t = rec.trade;
    const b = rec.book;
    const px = D(f.fillPx);
    const role: TradeFillRole = f.ordId === b.openingOrdId ? 'open' : 'add';
    const ref = this.orderRef(rec, f.ordId, f.clOrdId || o.clOrdId, role);
    if (ref.role === 'pending') ref.role = role;
    const pending = this.pendingOf(ref.clOrdId, f.ordId);
    if (pending) this.logPlaced(rec, ref, pending);
    const value = valueOf(inst, px, contracts);
    ref.contracts = D(ref.contracts).plus(contracts).toFixed();
    ref.value = D(ref.value).plus(value).toFixed();
    if (ref.firstTs === 0) ref.firstTs = f.ts;
    const held = D(t.size);
    // The position's running average, what the exchange measures the closes against.
    b.avgPx = fine(averageOf(inst, held.plus(contracts), valueOf(inst, D(b.avgPx), held).plus(value)));
    b.openedContracts = D(b.openedContracts).plus(contracts).toFixed();
    b.openedValue = D(b.openedValue).plus(value).toFixed();
    if (role === 'open' && b.lever === '' && o.lever !== '') b.lever = o.lever;
    const opened = D(b.openedContracts);
    const openedValue = D(b.openedValue);
    const size = held.plus(contracts);
    t.size = size.toFixed();
    t.entry.avgPx = fine(averageOf(inst, opened, openedValue));
    t.entry.contracts = opened.toFixed();
    t.entry.coin = fine(coinOfValue(inst, opened, openedValue));
    t.entry.notional = fine(notionalOfValue(inst, opened, openedValue));
    if (size.gt(t.entry.maxContracts)) t.entry.maxContracts = size.toFixed();
    t.fees = D(t.fees).minus(fee).toFixed();
    const coin = fine(coinOfValue(inst, contracts, value));
    t.fills.push({ ts: f.ts, ordId: f.ordId, clOrdId: ref.clOrdId, tradeId: f.tradeId, side: f.side, role, px: px.toFixed(), contracts: contracts.toFixed(), coin, fee: fee.toFixed(), pnl: '0', posAfter: size.toFixed() });
    this.event(rec, { ts: f.ts, kind: 'fill', ordId: f.ordId, clOrdId: ref.clOrdId, side: f.side, role, px: px.toFixed(), contracts: contracts.toFixed(), fee: fee.toFixed() });
    b.lastActivity = this.opts.now();
    this.refresh(rec);
  }

  /** A fill against the trade's direction, at most its size. */
  private shrink(rec: TradeRecord, f: Fill, o: OrderFacts, inst: Instrument, contracts: Decimal, fee: Decimal, markPx: Decimal | null): void {
    const t = rec.trade;
    const b = rec.book;
    const px = D(f.fillPx);
    const size = D(t.size);
    const after = size.minus(contracts);
    const role: TradeFillRole = after.isZero() ? 'close' : 'reduce';
    const pnl = closePnl(inst, t.direction, D(b.avgPx), px, contracts);
    const ref = this.orderRef(rec, f.ordId, f.clOrdId || o.clOrdId, 'reduce');
    ref.role = 'reduce';
    const pending = this.pendingOf(ref.clOrdId, f.ordId);
    if (pending) this.logPlaced(rec, ref, pending);
    const value = valueOf(inst, px, contracts);
    ref.contracts = D(ref.contracts).plus(contracts).toFixed();
    ref.value = D(ref.value).plus(value).toFixed();
    if (ref.firstTs === 0) ref.firstTs = f.ts;
    if (ref.exit === null) {
      const decision = this.exitReasonOf(rec, f, o, px, markPx);
      ref.exit = t.exits.length;
      t.exits.push({ ts: f.ts, reason: decision.reason, leg: decision.leg, ordId: f.ordId, clOrdId: ref.clOrdId, algoId: decision.algo?.algoId ?? null, px: px.toFixed(), contracts: '0', coin: '0', pnl: '0', fee: '0' });
      if (decision.reason === 'liquidation' || decision.reason === 'adl') {
        this.event(rec, { ts: f.ts, kind: 'liquidation', ordId: f.ordId, px: px.toFixed(), contracts: contracts.toFixed(), pnl: pnl.toFixed(), reason: decision.reason });
      } else if (decision.algo) {
        this.markTriggered(rec, decision.algo, f.ordId, f.ts, decision.reason);
      }
    }
    const exit = t.exits[ref.exit];
    if (exit) {
      const exitContracts = D(ref.contracts);
      exit.contracts = exitContracts.toFixed();
      exit.px = fine(averageOf(inst, exitContracts, D(ref.value)));
      exit.coin = fine(coinOfValue(inst, exitContracts, D(ref.value)));
      exit.pnl = D(exit.pnl).plus(pnl).toFixed();
      exit.fee = D(exit.fee).minus(fee).toFixed();
    }
    t.size = after.toFixed();
    t.realisedPnl = D(t.realisedPnl).plus(pnl).toFixed();
    t.fees = D(t.fees).minus(fee).toFixed();
    const reason = exit?.reason ?? 'external';
    t.fills.push({ ts: f.ts, ordId: f.ordId, clOrdId: ref.clOrdId, tradeId: f.tradeId, side: f.side, role, px: px.toFixed(), contracts: contracts.toFixed(), coin: fine(coinOfValue(inst, contracts, value)), fee: fee.toFixed(), pnl: pnl.toFixed(), posAfter: after.toFixed() });
    this.event(rec, { ts: f.ts, kind: 'fill', ordId: f.ordId, clOrdId: ref.clOrdId, side: f.side, role, px: px.toFixed(), contracts: contracts.toFixed(), fee: fee.toFixed(), pnl: pnl.toFixed(), reason });
    b.lastActivity = this.opts.now();
    if (after.isZero()) this.closeTrade(rec, f.ts, reason);
    this.refresh(rec);
  }

  private closeTrade(rec: TradeRecord, ts: number, reason: TradeExitReason): void {
    const t = rec.trade;
    t.status = 'closed';
    t.closedAt = ts;
    t.closeReason = reason;
    const key = legKey(t.instId, t.mgnMode, t.posSide);
    if (this.open.get(key) === rec) this.open.delete(key);
  }

  // ---- exits ----

  private exitReasonOf(rec: TradeRecord, f: Fill, o: OrderFacts, px: Decimal, markPx: Decimal | null): ExitDecision {
    if (isLiquidationOrder(o)) return { reason: 'liquidation', leg: null, algo: null };
    if (o.category === 'adl') return { reason: 'adl', leg: null, algo: null };
    const clOrdId = f.clOrdId || o.clOrdId;
    if (clOrdId.startsWith(CL_ORD_PREFIXES.campaign)) return { reason: 'campaign', leg: null, algo: null };
    if (clOrdId !== '' && (this.pendingOf(clOrdId, f.ordId) !== undefined || sourceOfClOrdId(clOrdId) !== 'external')) return { reason: 'manual', leg: null, algo: null };
    const match = this.matchAlgo(rec, markPx === null ? [px] : [px, markPx], this.opts.now());
    if (match) return { reason: match.as === 'tp' ? 'take_profit' : match.algo.trailing ? 'trailing' : 'stop', leg: match.as === 'tp' ? match.algo.leg : null, algo: match.algo };
    if (rec.trade.plan?.trailing?.kind === 'callback') return { reason: 'trailing', leg: null, algo: null };
    return { reason: 'external', leg: null, algo: null };
  }

  /** The algo order a closing fill came from, by its trigger and the fill's prices (its own, the mark when it filled; see the header). */
  private matchAlgo(rec: TradeRecord, prices: readonly Decimal[], now: number): { algo: TrackedAlgo; as: 'sl' | 'tp' } | null {
    const long = rec.trade.direction === 'long';
    let best: { algo: TrackedAlgo; as: 'sl' | 'tp'; distance: Decimal } | null = null;
    for (const algo of Object.values(rec.book.algos)) {
      if (algo.triggeredBy !== null || (algo.ended && now - (algo.endedAt ?? 0) > ALGO_ENDED_GRACE_MS)) continue;
      for (const as of ['sl', 'tp'] as const) {
        const trigger = as === 'sl' ? algo.sl : algo.tp;
        if (trigger === null) continue;
        for (const px of prices) {
          if (!triggerReached(as, long, px, D(trigger))) continue;
          const distance = px.minus(trigger).abs().div(trigger);
          if (best === null || distance.lt(best.distance)) best = { algo, as, distance };
        }
      }
    }
    if (best !== null) return { algo: best.algo, as: best.as };
    // The exchange's trailing stop triggers where the market took it since the last read.
    const callback = Object.values(rec.book.algos).find((a) => a.callback && a.triggeredBy === null && (!a.ended || now - (a.endedAt ?? 0) <= ALGO_ENDED_GRACE_MS));
    return callback ? { algo: callback, as: 'sl' } : null;
  }

  private markTriggered(rec: TradeRecord, algo: TrackedAlgo, ordId: string, ts: number, reason: TradeExitReason): void {
    algo.triggeredBy = ordId;
    const kind = reason === 'take_profit' ? 'tp_triggered' : reason === 'trailing' ? 'trailing_triggered' : 'stop_triggered';
    // An algo order the list stopped showing before its fill came was logged as cancelled: it was not.
    rec.trade.timeline = rec.trade.timeline.filter((e) => !(e.algoId === algo.algoId && e.kind.endsWith('_cancelled')));
    const ev: JournalEvent = { ts, kind, algoId: algo.algoId, ordId };
    const trigger = reason === 'take_profit' ? algo.tp : algo.sl;
    if (trigger !== null) ev.px = trigger;
    if (reason === 'take_profit' && algo.leg !== null) ev.leg = algo.leg;
    this.event(rec, ev);
  }

  // ---- algo orders ----

  private algoPlaced(rec: TradeRecord, a: AlgoOrder, ts: number): void {
    const t = rec.trade;
    const callback = a.ordType === 'move_order_stop';
    const sl = callback ? (a.moveTriggerPx !== undefined && a.moveTriggerPx !== '' ? a.moveTriggerPx : null) : a.slTriggerPx !== '' ? a.slTriggerPx : null;
    const tp = !callback && a.tpTriggerPx !== '' ? a.tpTriggerPx : null;
    const attached = this.isAttached(rec, a);
    const known = Object.values(rec.book.algos);
    const algo: TrackedAlgo = {
      algoId: a.algoId,
      algoClOrdId: a.algoClOrdId,
      sl,
      slFirst: sl,
      tp,
      tpFirst: tp,
      sz: a.sz,
      closeFraction: a.closeFraction,
      firstSeen: ts,
      lastSeen: ts,
      moves: 0,
      leg: tp === null ? null : this.legOf(rec, a.algoClOrdId, tp, known),
      trailing: callback || (sl !== null && (a.algoClOrdId.startsWith(CHANNEL_STOP_PREFIX) || (t.plan?.trailing?.kind === 'channel' && !attached))),
      callback,
      attached,
      ended: false,
      endedAt: null,
      triggeredBy: null,
    };
    rec.book.algos[a.algoId] = algo;
    const at = a.cTime > 0 ? a.cTime : ts;
    if (callback) {
      // Its trigger is where the market takes it; the activation price, when it has one, is what was set.
      const ev: JournalEvent = { ts: at, kind: 'trailing_placed', algoId: a.algoId };
      const px = a.activePx !== undefined && a.activePx !== '' ? a.activePx : sl;
      if (px !== null) ev.px = px;
      if (a.sz !== '') ev.contracts = a.sz;
      this.event(rec, ev);
    } else if (sl !== null) {
      const ev: JournalEvent = { ts: at, kind: algo.trailing ? 'trailing_placed' : 'stop_placed', algoId: a.algoId, px: sl };
      if (a.sz !== '') ev.contracts = a.sz;
      this.event(rec, ev);
      // The initial stop: the plan's, else the first one listed before any of the position was closed.
      if (t.initialStop === null && t.exits.length === 0) t.initialStop = sl;
    }
    if (tp !== null) {
      const ev: JournalEvent = { ts: at, kind: 'tp_placed', algoId: a.algoId, px: tp };
      if (algo.leg !== null) ev.leg = algo.leg;
      if (a.sz !== '') ev.contracts = a.sz;
      this.event(rec, ev);
    }
  }

  private algoUpdated(rec: TradeRecord, known: TrackedAlgo, a: AlgoOrder, ts: number): boolean {
    known.lastSeen = ts;
    known.sz = a.sz;
    known.closeFraction = a.closeFraction;
    const at = a.uTime > 0 ? a.uTime : ts;
    if (known.callback) {
      // The price an exchange trailing stop triggers at follows the market: kept for the match, not logged.
      if (a.moveTriggerPx !== undefined && a.moveTriggerPx !== '') known.sl = a.moveTriggerPx;
      return false;
    }
    let moved = false;
    const sl = a.slTriggerPx !== '' ? a.slTriggerPx : null;
    if (sl !== null && known.sl !== null && !D(sl).eq(known.sl)) {
      known.moves++;
      if (!known.trailing && rec.trade.plan?.trailing?.kind === 'channel') known.trailing = true;
      this.event(rec, { ts: at, kind: known.trailing ? 'trailing_moved' : 'stop_moved', algoId: known.algoId, fromPx: known.sl, px: sl });
      moved = true;
    }
    if (sl !== null) known.sl = sl;
    const tp = a.tpTriggerPx !== '' ? a.tpTriggerPx : null;
    if (tp !== null && known.tp !== null && !D(tp).eq(known.tp)) {
      const ev: JournalEvent = { ts: at, kind: 'tp_moved', algoId: known.algoId, fromPx: known.tp, px: tp };
      if (known.leg !== null) ev.leg = known.leg;
      this.event(rec, ev);
      moved = true;
    }
    if (tp !== null) known.tp = tp;
    return moved;
  }

  private algoEnded(rec: TradeRecord, known: TrackedAlgo, ts: number): void {
    const t = rec.trade;
    known.ended = true;
    known.endedAt = this.opts.now();
    if (known.triggeredBy !== null) return;
    const kind = known.callback || (known.sl !== null && known.trailing) ? 'trailing_cancelled' : known.sl !== null ? 'stop_cancelled' : 'tp_cancelled';
    const ev: JournalEvent = { ts, kind, algoId: known.algoId };
    const trigger = known.sl ?? known.tp;
    if (trigger !== null) ev.px = trigger;
    if (known.sl === null && known.leg !== null) ev.leg = known.leg;
    if (t.status === 'closed' || D(t.size).isZero()) ev.code = 'POSITION_CLOSED';
    this.event(rec, ev);
  }

  /** Whether an algo order came with the opening order (see the header). */
  private isAttached(rec: TradeRecord, a: AlgoOrder): boolean {
    const tail = rec.book.openingClOrdId.slice(-ATTACHED_TAIL);
    if (tail.length === ATTACHED_TAIL && a.algoClOrdId.endsWith(tail)) return true;
    const plan = rec.trade.plan;
    if (plan === null) return false;
    if (plan.slTriggerPx !== null && a.slTriggerPx !== '' && D(a.slTriggerPx).eq(plan.slTriggerPx)) return true;
    return a.tpTriggerPx !== '' && plan.takeProfits.some((leg) => D(leg.triggerPx).eq(a.tpTriggerPx));
  }

  /** The take-profit leg of an algo order: the one its client id names, else the plan's leg with the nearest trigger, else the next number. */
  private legOf(rec: TradeRecord, algoClOrdId: string, tp: string, known: TrackedAlgo[]): number {
    const named = TP_LEG_RE.exec(algoClOrdId);
    if (named) return Number(named[1]);
    const legs = rec.trade.plan?.takeProfits ?? [];
    if (legs.length === 0) return known.filter((a) => a.tp !== null).length + 1;
    let best = 0;
    for (let i = 1; i < legs.length; i++) {
      if (D((legs[i] as { triggerPx: string }).triggerPx).minus(tp).abs().lt(D((legs[best] as { triggerPx: string }).triggerPx).minus(tp).abs())) best = i;
    }
    return best + 1;
  }

  // ---- helpers ----

  private pendingOf(clOrdId: string, ordId: string): PendingOrder | undefined {
    for (let i = this.data.pending.length - 1; i >= 0; i--) {
      const p = this.data.pending[i] as PendingOrder;
      if ((clOrdId !== '' && p.clOrdId === clOrdId) || p.ordId === ordId) return p;
    }
    return undefined;
  }

  private orderRef(rec: TradeRecord, ordId: string, clOrdId: string, role: TradeOrderRef['role']): TradeOrderRef {
    let ref = rec.book.orders[ordId];
    if (!ref) {
      ref = { clOrdId, role, contracts: '0', value: '0', firstTs: 0, placedLogged: false, cancelled: false, exit: null };
      rec.book.orders[ordId] = ref;
    }
    return ref;
  }

  private logPlaced(rec: TradeRecord, ref: TradeOrderRef, p: PendingOrder): void {
    if (ref.placedLogged) return;
    ref.placedLogged = true;
    const ev: JournalEvent = { ts: p.ts, kind: 'order_placed', ordId: p.ordId, clOrdId: p.clOrdId, side: p.side, ordType: p.ordType, contracts: p.contracts, source: p.source };
    if (p.px !== '') ev.px = p.px;
    if (p.plan !== null) ev.plan = p.plan;
    this.event(rec, ev);
  }

  /** Adds a line to the timeline, in time order; an order's placement before what happened at the same time. */
  private event(rec: TradeRecord, ev: JournalEvent): void {
    const timeline = rec.trade.timeline;
    const first = ev.kind === 'order_placed';
    let i = timeline.length;
    while (i > 0 && ((timeline[i - 1] as JournalEvent).ts > ev.ts || (first && (timeline[i - 1] as JournalEvent).ts === ev.ts))) i--;
    timeline.splice(i, 0, ev);
  }

  /** The figures derived from the others, after every change; marks the trade changed. */
  private refresh(rec: TradeRecord): void {
    const t = rec.trade;
    const b = rec.book;
    const inst = this.opts.specOf(t.instId);
    const net = D(t.realisedPnl).minus(t.fees).plus(t.funding === null ? ZERO : D(t.funding));
    t.netPnl = net.toFixed();
    // The opening order's contracts at their average, stopped at the initial stop: 1 R.
    const opening = b.orders[b.openingOrdId];
    const openContracts = opening ? D(opening.contracts) : D(b.openedContracts);
    const openValue = opening ? D(opening.value) : D(b.openedValue);
    t.initialRisk = null;
    if (t.initialStop !== null && openContracts.gt(0)) {
      const loss = closePnl(inst, t.direction, averageOf(inst, openContracts, openValue), D(t.initialStop), openContracts).neg();
      if (loss.gt(0)) t.initialRisk = fine(loss);
    }
    t.rMultiple = t.status === 'closed' && t.initialRisk !== null ? fine(net.div(t.initialRisk)) : null;
    t.durationMs = t.closedAt === null ? null : Math.max(0, t.closedAt - t.openedAt);
    // Leverage: the opening order's notional over the margin reported while it was all the position held.
    const margin = t.entry.margin === null ? ZERO : D(t.entry.margin);
    t.entry.leverage = margin.gt(0) && openContracts.gt(0) ? fine(notionalOfValue(inst, openContracts, openValue).div(margin)) : b.lever !== '' ? b.lever : null;
    let exitContracts = ZERO;
    let exitValue = ZERO;
    for (const ref of Object.values(b.orders)) {
      if (ref.role !== 'reduce') continue;
      exitContracts = exitContracts.plus(ref.contracts);
      exitValue = exitValue.plus(ref.value);
    }
    t.exitPx = exitContracts.gt(0) ? fine(averageOf(inst, exitContracts, exitValue)) : null;
    t.updatedAt = this.opts.now();
    this.changed.add(t.id);
  }
}

/** The last order that opened or added to the trade: its average price and first fill time; null when none is recorded (an adopted trade). */
export function lastOpeningOf(rec: TradeRecord, inst: Instrument): { px: string; ts: number } | null {
  let best: TradeOrderRef | null = null;
  for (const ref of Object.values(rec.book.orders)) {
    if ((ref.role !== 'open' && ref.role !== 'add') || !D(ref.contracts).gt(0)) continue;
    if (best === null || ref.firstTs > best.firstTs) best = ref;
  }
  return best === null ? null : { px: fine(averageOf(inst, D(best.contracts), D(best.value))), ts: best.firstTs };
}

/** Whether a fill at `px` is at or beyond a trigger, within ALGO_MATCH_TOLERANCE: a stop is reached falling for a long, a take-profit rising. */
function triggerReached(as: 'sl' | 'tp', long: boolean, px: Decimal, trigger: Decimal): boolean {
  const tol = D(ALGO_MATCH_TOLERANCE);
  const falling = (as === 'sl') === long;
  return falling ? px.lte(trigger.mul(D(1).plus(tol))) : px.gte(trigger.mul(D(1).minus(tol)));
}

/** A trade without its fills and timeline (GET /api/journal). */
export function summaryOf(t: JournalTrade): JournalTradeSummary {
  return {
    id: t.id,
    seq: t.seq,
    instId: t.instId,
    mgnMode: t.mgnMode,
    posSide: t.posSide,
    direction: t.direction,
    source: t.source,
    status: t.status,
    openedAt: t.openedAt,
    closedAt: t.closedAt,
    durationMs: t.durationMs,
    updatedAt: t.updatedAt,
    ccy: t.ccy,
    entry: { ...t.entry },
    size: t.size,
    exitPx: t.exitPx,
    plan: t.plan,
    initialStop: t.initialStop,
    initialRisk: t.initialRisk,
    fees: t.fees,
    funding: t.funding,
    realisedPnl: t.realisedPnl,
    netPnl: t.netPnl,
    rMultiple: t.rMultiple,
    exits: t.exits.map((e) => ({ ...e })),
    closeReason: t.closeReason,
    adopted: t.adopted,
  };
}
