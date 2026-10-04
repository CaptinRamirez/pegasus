import { EventEmitter } from 'node:events';
import { D, Decimal, ZERO, notionalQuote, utcDayStart, type CancelSweepState, type Instrument, type Order, type OrdType, type PosSide, type Position, type PositionOverLimit, type RiskCheckResult, type RiskConfig, type RiskState, type Side } from '@pegasus/shared';
import type { Store } from '../db/store.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';

export interface RiskCheckInput {
  inst: Instrument;
  side: Side;
  /** Resolved position side: 'net' in net mode, 'long' | 'short' in long/short mode */
  posSide: PosSide;
  ordType: OrdType;
  /** Exchange contracts of the new order */
  contracts: string;
  /** USD notional of the new order */
  notional: string;
  /** Limit price ('' for market) */
  px: string;
  /** Mark/reference price used for the band check */
  refPrice: string;
  /** Leverage currently configured for this instrument/mode */
  lever: string;
  /** Estimated slippage for market orders ('' when unknown) */
  estSlippagePct: string;
  /** True only when the exchange will actually enforce reduce-only (net mode) */
  reduceOnly: boolean;
  /** Current positions (all instruments) */
  positions: Position[];
  /** Resting orders (all instruments); their unfilled size counts as exposure */
  openOrders: Order[];
  /** Opening orders already accepted that the positions above may not show yet */
  reservations: ExposureReservation[];
  instrumentOf: (instId: string) => Instrument | undefined;
}

/** An accepted opening order, held against the limits until the account mirror has caught up with it. */
export interface ExposureReservation {
  clOrdId: string;
  instId: string;
  side: Side;
  posSide: PosSide;
  /** USD notional of the order that the positions do not show yet (the still-resting part included) */
  notional: string;
}

interface PersistedRiskState {
  killSwitch: boolean;
  killSwitchReason: string;
  dayStartTs: number;
  dayStartEquity: string;
  /** Absent in a state saved before the baseline time was recorded */
  baselineTs?: number;
  /** True once the cancel sweep of this halt has completed. Absent in a state saved before it was recorded */
  sweepDone?: boolean;
}

const SETTING_KEY = 'risk.state';
const DAILY_LOSS_REASON = 'DAILY_LOSS_LIMIT';

/** A saved state is trusted only when it has the shape this engine writes: the file can be edited by hand. */
function isPersistedRiskState(v: unknown): v is PersistedRiskState {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s['killSwitch'] === 'boolean' &&
    typeof s['killSwitchReason'] === 'string' &&
    typeof s['dayStartTs'] === 'number' &&
    typeof s['dayStartEquity'] === 'string' &&
    (s['dayStartEquity'] === '' || /^\d+(\.\d+)?$/.test(s['dayStartEquity'])) &&
    (s['baselineTs'] === undefined || typeof s['baselineTs'] === 'number') &&
    (s['sweepDone'] === undefined || typeof s['sweepDone'] === 'boolean')
  );
}

const pass = (): RiskCheckResult => ({ ok: true, code: 'OK', message: 'ok' });
const fail = (code: string, message: string, details?: Record<string, string | number | boolean>): RiskCheckResult =>
  details === undefined ? { ok: false, code, message } : { ok: false, code, message, details };

/**
 * Pre-trade and account-level risk controls. Pure checks live in `check()`;
 * state (daily baseline, kill switch) is updated from account events.
 */
export class RiskEngine extends EventEmitter<{ state: [RiskState] }> {
  readonly state: RiskState;
  /**
   * The cancel sweep of the current halt has completed. Saved with the halt, so that a restart does not sweep
   * again and cancel the exits placed since; cleared whenever the switch changes position.
   */
  private sweepDone = false;

  constructor(
    readonly config: RiskConfig,
    private readonly store: Store,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    super();
    const t = now();
    this.state = {
      killSwitch: false,
      killSwitchReason: '',
      cancelSweep: { state: 'idle', message: '', ts: t },
      dayStartTs: utcDayStart(t),
      dayStartEquity: '',
      baselineTs: 0,
      currentEquity: '',
      dailyPnl: '0',
      openOrders: 0,
      totalPositionNotional: '0',
      overLimit: [],
      totalOverLimit: '',
      updatedAt: t,
    };
  }

  async init(): Promise<void> {
    let saved: PersistedRiskState | null;
    try {
      const raw = await this.store.getSetting<unknown>(SETTING_KEY);
      if (raw !== null && !isPersistedRiskState(raw)) throw new Error(`the risk state saved in ${this.store.settingsLocation} is not valid`);
      saved = raw;
    } catch (err) {
      // Fail closed: whether a halt was on and what the day's baseline was is unknown, so trading stays halted
      // until the owner releases it. It is a halt like a manual one: a new day does not clear it.
      this.state.killSwitch = true;
      this.state.killSwitchReason = `STATE_FILE_UNREADABLE: ${(err as Error).message}; the saved halt and day baseline are unknown`;
      this.log.error({ err: (err as Error).message }, 'saved risk state could not be read - kill switch engaged');
      this.persist();
      void this.store.addRiskEvent('STATE_FILE_UNREADABLE', { error: (err as Error).message });
      return;
    }
    if (!saved) return;
    const sameDay = saved.dayStartTs === utcDayStart(this.now());
    if (sameDay) {
      this.state.dayStartTs = saved.dayStartTs;
      this.state.dayStartEquity = saved.dayStartEquity;
      this.state.baselineTs = saved.dayStartEquity === '' ? 0 : (saved.baselineTs ?? saved.dayStartTs);
    }
    // A new day clears an automatic daily-loss halt but never a manual one. Decided here, not at the first
    // equity of the day: a halt restored even for a moment would start the cancel sweep.
    if (saved.killSwitch && !sameDay && saved.killSwitchReason.startsWith(DAILY_LOSS_REASON)) {
      this.persist();
      void this.store.addRiskEvent('KILL_SWITCH_RESET', { reason: 'new UTC day' });
      return;
    }
    this.state.killSwitch = saved.killSwitch;
    this.state.killSwitchReason = saved.killSwitchReason;
    if (this.state.killSwitch && saved.sweepDone === true) {
      // The sweeper reads this as "nothing left to do": only an unfinished, failed or skipped sweep is taken up again.
      this.sweepDone = true;
      this.state.cancelSweep = { state: 'done', message: 'open orders cancelled before the restart', ts: this.now() };
    }
    if (this.state.killSwitch) this.log.warn({ reason: this.state.killSwitchReason, sweepDone: this.sweepDone }, 'kill switch is ON (restored from store)');
  }

  /** Feed the latest total equity; rolls the daily baseline at 00:00 UTC and trips the kill switch on the loss limit. */
  updateEquity(totalEq: string): void {
    // An empty equity is "not reported", never zero: as a value it would read as a total loss or become a zero baseline.
    if (totalEq === '') return;
    const t = this.now();
    const day = utcDayStart(t);
    let persist = false;
    if (day !== this.state.dayStartTs || this.state.dayStartEquity === '') {
      this.state.dayStartTs = day;
      this.state.dayStartEquity = totalEq;
      this.state.baselineTs = t;
      persist = true;
      // A new day clears an automatic daily-loss halt but never a manual one.
      if (this.state.killSwitch && this.state.killSwitchReason.startsWith(DAILY_LOSS_REASON)) {
        this.state.killSwitch = false;
        this.state.killSwitchReason = '';
        this.sweepDone = false;
        void this.store.addRiskEvent('KILL_SWITCH_RESET', { reason: 'new UTC day' });
      }
    }
    this.state.currentEquity = totalEq;
    this.state.dailyPnl = D(totalEq).minus(this.state.dayStartEquity).toFixed();
    this.state.updatedAt = t;
    if (!this.state.killSwitch && this.dailyLossBreached()) {
      this.state.killSwitch = true;
      this.state.killSwitchReason = `${DAILY_LOSS_REASON}: daily PnL ${this.state.dailyPnl} breached -${this.config.dailyLossLimit}`;
      this.sweepDone = false;
      persist = true;
      this.log.error({ dailyPnl: this.state.dailyPnl, limit: this.config.dailyLossLimit }, 'DAILY LOSS LIMIT HIT - kill switch engaged');
      void this.store.addRiskEvent('DAILY_LOSS_LIMIT', { dailyPnl: this.state.dailyPnl, limit: this.config.dailyLossLimit, equity: totalEq });
    }
    if (persist) this.persist();
    this.emit('state', this.state);
  }

  /**
   * Feed the open-order count and the positions. Also derives which positions have outgrown the notional limits:
   * the limits are checked when an order is placed, but a position grows with price afterwards. That is shown,
   * never acted on: nothing is traded or blocked because of it, and it is not persisted.
   */
  updateExposure(openOrders: number, totalPositionNotional: string, positions: Position[], instrumentOf: (instId: string) => Instrument | undefined): void {
    this.state.openOrders = openOrders;
    this.state.totalPositionNotional = totalPositionNotional;
    this.state.overLimit = positionsOverLimit(positions, this.config.maxPositionNotionalPerInstrument, instrumentOf);
    const totalExcess = D(totalPositionNotional).minus(this.config.maxTotalPositionNotional);
    this.state.totalOverLimit = totalExcess.gt(0) ? totalExcess.toFixed() : '';
    this.state.updatedAt = this.now();
    this.emit('state', this.state);
  }

  private dailyLossBreached(): boolean {
    return D(this.config.dailyLossLimit).gt(0) && D(this.state.dailyPnl).lte(D(this.config.dailyLossLimit).neg());
  }

  /**
   * A release while the daily loss limit is still breached would be undone by the next balance event, so it is
   * refused unless `rebase` is set. With `rebase` the day's baseline restarts at the current equity: the
   * deliberate override for a transfer out of the account, which an equity-based rule cannot tell from a loss.
   */
  setKillSwitch(enabled: boolean, reason: string, rebase = false): RiskState {
    if (!enabled && this.dailyLossBreached()) {
      const { dailyPnl, currentEquity, dayStartEquity } = this.state;
      if (!rebase) {
        throw new AppError(
          'DAILY_LOSS_ACTIVE',
          `the daily loss limit is still breached (daily PnL ${dailyPnl}, limit -${this.config.dailyLossLimit}): releasing needs rebase, which restarts the day's baseline at the current equity`,
          409,
          { dailyPnl, limit: this.config.dailyLossLimit, equity: currentEquity },
        );
      }
      this.state.dayStartEquity = currentEquity;
      this.state.baselineTs = this.now();
      this.state.dailyPnl = '0';
      this.log.warn({ from: dayStartEquity, to: currentEquity, dailyPnl }, 'daily baseline rebased to the current equity');
      void this.store.addRiskEvent('DAILY_BASELINE_REBASED', { from: dayStartEquity, to: currentEquity, dailyPnl, limit: this.config.dailyLossLimit });
    }
    // A new engagement gets its own sweep; engaging a switch that is already on starts none, so its record stays.
    if (enabled !== this.state.killSwitch) this.sweepDone = false;
    this.state.killSwitch = enabled;
    this.state.killSwitchReason = enabled ? reason || 'MANUAL' : '';
    this.state.updatedAt = this.now();
    this.persist();
    void this.store.addRiskEvent(enabled ? 'KILL_SWITCH_ON' : 'KILL_SWITCH_OFF', { reason });
    this.log.warn({ enabled, reason }, 'kill switch changed');
    this.emit('state', this.state);
    return this.state;
  }

  /** Progress of the cancel-all sweep, reported by the kill-switch sweeper so it reaches the terminal with the risk state. */
  setCancelSweep(state: CancelSweepState, message: string): void {
    const t = this.now();
    this.state.cancelSweep = { state, message, ts: t };
    this.state.updatedAt = t;
    const done = state === 'done' && this.state.killSwitch;
    if (done !== this.sweepDone) {
      this.sweepDone = done;
      this.persist();
    }
    this.emit('state', this.state);
  }

  /**
   * Pre-trade checks. Returns the first violated rule.
   *
   * Orders that can only reduce exposure (reduce-only in net mode, or the
   * closing direction of a leg in long/short mode) are never blocked by the
   * kill switch or the exposure rules: a halt must stop new risk, not exits.
   * They still pass the price band so a mistyped exit price is caught.
   */
  check(input: RiskCheckInput): RiskCheckResult {
    const c = this.config;
    const closing = isClosingOrder(input);
    if (this.state.killSwitch && !closing) return fail('KILL_SWITCH', `trading halted: ${this.state.killSwitchReason}`);

    const ref = D(input.refPrice);
    if (input.ordType !== 'market' && input.px !== '' && ref.gt(0)) {
      const dev = D(input.px).minus(ref).abs().div(ref);
      if (dev.gt(c.priceBandPct)) {
        return fail('PRICE_BAND', `limit price ${input.px} is ${dev.mul(100).toFixed(2)}% away from the mark price ${ref.toFixed()} (band ${D(c.priceBandPct).mul(100).toFixed(2)}%)`, { px: input.px, refPrice: ref.toFixed(), deviationPct: dev.toFixed(6) });
      }
    }
    if (closing) return pass();

    const notional = D(input.notional);
    if (notional.gt(c.maxOrderNotional)) {
      return fail('MAX_ORDER_NOTIONAL', `order notional ${notional.toFixed(2)} exceeds the limit ${c.maxOrderNotional}`, { notional: notional.toFixed(2), limit: c.maxOrderNotional });
    }
    if (D(input.lever).gt(c.maxLeverage)) {
      return fail('MAX_LEVERAGE', `leverage ${input.lever}x exceeds the limit ${c.maxLeverage}x`, { lever: input.lever, limit: c.maxLeverage });
    }
    if (input.openOrders.length + 1 > c.maxOpenOrders && input.ordType !== 'market') {
      return fail('MAX_OPEN_ORDERS', `already ${input.openOrders.length} open orders (limit ${c.maxOpenOrders})`, { openOrders: input.openOrders.length, limit: c.maxOpenOrders });
    }
    if (input.ordType === 'market' && input.estSlippagePct !== '' && D(input.estSlippagePct).gt(c.maxSlippagePct)) {
      return fail('MAX_SLIPPAGE', `estimated slippage ${D(input.estSlippagePct).mul(100).toFixed(3)}% exceeds ${D(c.maxSlippagePct).mul(100).toFixed(3)}%`, { estSlippagePct: input.estSlippagePct, limit: c.maxSlippagePct });
      }
    // Projected exposure after this order and every resting order fill.
    const exposure = projectExposure(input);
    // Fail closed: a resting order that cannot be valued could hide any amount of exposure.
    if (exposure.unvalued !== null) {
      return fail('EXPOSURE_UNKNOWN', `the resting order ${exposure.unvalued.ordId} on ${exposure.unvalued.instId} cannot be valued (unknown contract size); cancel it or wait for it to fill`, { instId: exposure.unvalued.instId, ordId: exposure.unvalued.ordId });
    }
    if (exposure.instrument.gt(c.maxPositionNotionalPerInstrument)) {
      return fail('MAX_POSITION_NOTIONAL', `projected ${input.inst.instId} exposure ${exposure.instrument.toFixed(2)} exceeds the per-instrument limit ${c.maxPositionNotionalPerInstrument}`, {
        current: exposure.currentInstrument.toFixed(2),
        projected: exposure.instrument.toFixed(2),
        limit: c.maxPositionNotionalPerInstrument,
      });
    }
    if (exposure.total.gt(c.maxTotalPositionNotional)) {
      return fail('MAX_TOTAL_NOTIONAL', `projected total exposure ${exposure.total.toFixed(2)} exceeds the limit ${c.maxTotalPositionNotional}`, {
        projected: exposure.total.toFixed(2),
        limit: c.maxTotalPositionNotional,
      });
    }
    return pass();
  }

  private persist(): void {
    const p: PersistedRiskState = {
      killSwitch: this.state.killSwitch,
      killSwitchReason: this.state.killSwitchReason,
      dayStartTs: this.state.dayStartTs,
      dayStartEquity: this.state.dayStartEquity,
      baselineTs: this.state.baselineTs,
      sweepDone: this.sweepDone,
    };
    void this.store.setSetting(SETTING_KEY, p).catch((err: Error) => this.log.warn({ err: err.message }, 'could not persist risk state'));
  }
}

/** Signed USD notional of a position: positive long, negative short. */
export function positionSignedNotional(p: Position, inst?: Instrument): ReturnType<typeof D> {
  const pos = D(p.pos || '0');
  let abs = D(p.notionalUsd || '0').abs();
  if (abs.isZero() && inst && p.instId === inst.instId && D(p.markPx || '0').gt(0)) {
    abs = notionalQuote(pos.abs(), p.markPx, inst);
  }
  const isShort = p.posSide === 'short' || (p.posSide === 'net' && pos.lt(0));
  return isShort ? abs.neg() : abs;
}

/**
 * Instruments whose position notional exceeds the per-instrument limit, in the order the positions list them.
 * Positions only (no resting orders), with the accounting of the pre-trade rule: a net position counts at its
 * absolute notional, the long and short legs of long/short mode count gross.
 */
export function positionsOverLimit(positions: Position[], limit: string, instrumentOf: (instId: string) => Instrument | undefined): PositionOverLimit[] {
  const byInst = new Map<string, { net: Decimal; legs: Decimal }>();
  for (const p of positions) {
    const n = positionSignedNotional(p, instrumentOf(p.instId));
    const acc = byInst.get(p.instId) ?? { net: ZERO, legs: ZERO };
    if (p.posSide === 'net') acc.net = acc.net.plus(n);
    else acc.legs = acc.legs.plus(n.abs());
    byInst.set(p.instId, acc);
  }
  const over: PositionOverLimit[] = [];
  for (const [instId, acc] of byInst) {
    const notional = acc.net.abs().plus(acc.legs);
    if (notional.gt(limit)) over.push({ instId, notional: notional.toFixed(), limit, excess: notional.minus(limit).toFixed() });
  }
  return over;
}

/**
 * True when the order can only reduce exposure: reduce-only in net mode (the
 * exchange enforces it) or, in long/short mode, the closing direction of a leg
 * (sell a long / buy a short; the exchange rejects over-closing).
 */
export function isClosingOrder(input: Pick<RiskCheckInput, 'posSide' | 'side' | 'reduceOnly'>): boolean {
  if (input.posSide === 'long') return input.side === 'sell';
  if (input.posSide === 'short') return input.side === 'buy';
  return input.reduceOnly;
}

/** Unfilled notional of a resting order, or null for orders without a price (market remainders). */
function restingNotional(o: Order, inst: Instrument): Decimal | null {
  if (o.px === '' || o.ordType === 'market') return null;
  const remaining = D(o.sz).minus(o.accFillSz || '0');
  if (remaining.lte(0)) return null;
  return notionalQuote(remaining, o.px, inst);
}

interface Exposure {
  /** Absolute notional of the instrument before the order (positions + resting orders) */
  currentInstrument: Decimal;
  /** Projected absolute notional of the instrument after the order */
  instrument: Decimal;
  /** Projected total across instruments */
  total: Decimal;
  /** First resting opening order whose instrument spec is unknown, so its notional could not be counted */
  unvalued: Order | null;
}

/**
 * Exposure accounting:
 *  - net mode: a resting order may fill or not, so the instrument is projected at the worse of its two
 *    extremes: every resting buy filled (position + buys) or every resting sell filled (−position + sells);
 *  - long/short mode: the long and short legs are independent, so exposure is their gross sum
 *    and an order only ever adds to its own leg or reduces it (never below zero).
 * Resting orders that can only reduce exposure are not counted, on any instrument.
 */
export function projectExposure(input: RiskCheckInput): Exposure {
  const notional = D(input.notional);
  const hedged = input.posSide === 'long' || input.posSide === 'short';
  let othersAbs = ZERO;
  let unvalued: Order | null = null;
  // per-instrument accumulators
  let signed = ZERO;
  let restingBuys = ZERO;
  let restingSells = ZERO;
  let longLeg = ZERO;
  let shortLeg = ZERO;
  // opening notional on the order's own instrument: onto its leg in long/short mode, onto its side otherwise
  const addOpening = (side: Side, posSide: PosSide, n: Decimal): void => {
    if (hedged) {
      if (posSide === 'long' && side === 'buy') longLeg = longLeg.plus(n);
      else if (posSide === 'short' && side === 'sell') shortLeg = shortLeg.plus(n);
    } else if (side === 'buy') restingBuys = restingBuys.plus(n);
    else restingSells = restingSells.plus(n);
  };

  for (const p of input.positions) {
    const n = positionSignedNotional(p, input.inst);
    if (p.instId !== input.inst.instId) {
      othersAbs = othersAbs.plus(n.abs());
      continue;
    }
    signed = signed.plus(n);
    if (p.posSide === 'short') shortLeg = shortLeg.plus(n.abs());
    else if (p.posSide === 'long') longLeg = longLeg.plus(n.abs());
  }
  const restingByClOrdId = new Map<string, Decimal>();
  for (const o of input.openOrders) {
    // only opening orders add exposure; closing orders cannot increase it
    if (isClosingOrder(o)) continue;
    const inst = o.instId === input.inst.instId ? input.inst : input.instrumentOf(o.instId);
    if (!inst) {
      unvalued ??= o;
      continue;
    }
    const n = restingNotional(o, inst);
    if (n === null) continue;
    if (o.clOrdId !== '') restingByClOrdId.set(o.clOrdId, n);
    if (o.instId !== input.inst.instId) othersAbs = othersAbs.plus(n);
    else addOpening(o.side, o.posSide, n);
  }
  for (const r of input.reservations) {
    // the part of the order that still rests is already counted above
    const n = Decimal.max(D(r.notional).minus(restingByClOrdId.get(r.clOrdId) ?? ZERO), ZERO);
    if (r.instId !== input.inst.instId) othersAbs = othersAbs.plus(n);
    else addOpening(r.side, r.posSide, n);
  }

  let current: Decimal;
  let projected: Decimal;
  if (hedged) {
    current = longLeg.plus(shortLeg);
    const opening = (input.side === 'buy') === (input.posSide === 'long');
    const same = input.posSide === 'long' ? longLeg : shortLeg;
    const other = input.posSide === 'long' ? shortLeg : longLeg;
    const projectedSame = opening ? same.plus(notional) : Decimal.max(same.minus(notional), ZERO);
    projected = projectedSame.plus(other);
  } else {
    current = Decimal.max(signed.plus(restingBuys), signed.neg().plus(restingSells));
    const buys = input.side === 'buy' ? restingBuys.plus(notional) : restingBuys;
    const sells = input.side === 'sell' ? restingSells.plus(notional) : restingSells;
    projected = Decimal.max(signed.plus(buys), signed.neg().plus(sells));
  }
  return { currentInstrument: current, instrument: projected, total: othersAbs.plus(projected), unvalued };
}
