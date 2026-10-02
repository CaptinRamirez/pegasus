import { EventEmitter } from 'node:events';
import { D, ZERO, notionalQuote, utcDayStart, type Instrument, type OrdType, type Position, type RiskCheckResult, type RiskConfig, type RiskState, type Side } from '@pegasus/shared';
import type { Store } from '../db/store.js';
import type { Logger } from '../logger.js';

export interface RiskCheckInput {
  inst: Instrument;
  side: Side;
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
  reduceOnly: boolean;
  /** Current positions (all instruments) */
  positions: Position[];
  openOrders: number;
}

interface PersistedRiskState {
  killSwitch: boolean;
  killSwitchReason: string;
  dayStartTs: number;
  dayStartEquity: string;
}

const SETTING_KEY = 'risk.state';

const pass = (): RiskCheckResult => ({ ok: true, code: 'OK', message: 'ok' });
const fail = (code: string, message: string, details?: Record<string, string | number | boolean>): RiskCheckResult =>
  details === undefined ? { ok: false, code, message } : { ok: false, code, message, details };

/**
 * Pre-trade and account-level risk controls. Pure checks live in `check()`;
 * state (daily baseline, kill switch) is updated from account events.
 */
export class RiskEngine extends EventEmitter<{ state: [RiskState] }> {
  readonly state: RiskState;

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
      dayStartTs: utcDayStart(t),
      dayStartEquity: '',
      currentEquity: '',
      dailyPnl: '0',
      openOrders: 0,
      totalPositionNotional: '0',
      updatedAt: t,
    };
  }

  async init(): Promise<void> {
    const saved = await this.store.getSetting<PersistedRiskState>(SETTING_KEY);
    if (!saved) return;
    this.state.killSwitch = saved.killSwitch;
    this.state.killSwitchReason = saved.killSwitchReason;
    if (saved.dayStartTs === utcDayStart(this.now())) {
      this.state.dayStartTs = saved.dayStartTs;
      this.state.dayStartEquity = saved.dayStartEquity;
    }
    if (this.state.killSwitch) this.log.warn({ reason: this.state.killSwitchReason }, 'kill switch is ON (restored from store)');
  }

  /** Feed the latest total equity; rolls the daily baseline at 00:00 UTC and trips the kill switch on the loss limit. */
  updateEquity(totalEq: string): void {
    const t = this.now();
    const day = utcDayStart(t);
    let persist = false;
    if (day !== this.state.dayStartTs || this.state.dayStartEquity === '') {
      this.state.dayStartTs = day;
      this.state.dayStartEquity = totalEq;
      persist = true;
      // A new day clears an automatic daily-loss halt but never a manual one.
      if (this.state.killSwitch && this.state.killSwitchReason.startsWith('DAILY_LOSS_LIMIT')) {
        this.state.killSwitch = false;
        this.state.killSwitchReason = '';
        void this.store.addRiskEvent('KILL_SWITCH_RESET', { reason: 'new UTC day' });
      }
    }
    this.state.currentEquity = totalEq;
    this.state.dailyPnl = D(totalEq).minus(this.state.dayStartEquity).toFixed();
    this.state.updatedAt = t;
    if (!this.state.killSwitch && D(this.config.dailyLossLimit).gt(0) && D(this.state.dailyPnl).lte(D(this.config.dailyLossLimit).neg())) {
      this.state.killSwitch = true;
      this.state.killSwitchReason = `DAILY_LOSS_LIMIT: daily PnL ${this.state.dailyPnl} breached -${this.config.dailyLossLimit}`;
      persist = true;
      this.log.error({ dailyPnl: this.state.dailyPnl, limit: this.config.dailyLossLimit }, 'DAILY LOSS LIMIT HIT - kill switch engaged');
      void this.store.addRiskEvent('DAILY_LOSS_LIMIT', { dailyPnl: this.state.dailyPnl, limit: this.config.dailyLossLimit, equity: totalEq });
    }
    if (persist) this.persist();
    this.emit('state', this.state);
  }

  updateExposure(openOrders: number, totalPositionNotional: string): void {
    this.state.openOrders = openOrders;
    this.state.totalPositionNotional = totalPositionNotional;
    this.state.updatedAt = this.now();
    this.emit('state', this.state);
  }

  setKillSwitch(enabled: boolean, reason: string): RiskState {
    this.state.killSwitch = enabled;
    this.state.killSwitchReason = enabled ? reason || 'MANUAL' : '';
    this.state.updatedAt = this.now();
    this.persist();
    void this.store.addRiskEvent(enabled ? 'KILL_SWITCH_ON' : 'KILL_SWITCH_OFF', { reason });
    this.log.warn({ enabled, reason }, 'kill switch changed');
    this.emit('state', this.state);
    return this.state;
  }

  /** Pre-trade checks. Returns the first violated rule. */
  check(input: RiskCheckInput): RiskCheckResult {
    const c = this.config;
    if (this.state.killSwitch) return fail('KILL_SWITCH', `trading halted: ${this.state.killSwitchReason}`);

    const notional = D(input.notional);
    if (notional.gt(c.maxOrderNotional)) {
      return fail('MAX_ORDER_NOTIONAL', `order notional ${notional.toFixed(2)} exceeds the limit ${c.maxOrderNotional}`, { notional: notional.toFixed(2), limit: c.maxOrderNotional });
    }
    if (D(input.lever).gt(c.maxLeverage)) {
      return fail('MAX_LEVERAGE', `leverage ${input.lever}x exceeds the limit ${c.maxLeverage}x`, { lever: input.lever, limit: c.maxLeverage });
    }
    if (input.openOrders + 1 > c.maxOpenOrders && input.ordType !== 'market') {
      return fail('MAX_OPEN_ORDERS', `already ${input.openOrders} open orders (limit ${c.maxOpenOrders})`, { openOrders: input.openOrders, limit: c.maxOpenOrders });
    }
    const ref = D(input.refPrice);
    if (input.ordType !== 'market' && input.px !== '' && ref.gt(0)) {
      const dev = D(input.px).minus(ref).abs().div(ref);
      if (dev.gt(c.priceBandPct)) {
        return fail('PRICE_BAND', `limit price ${input.px} is ${dev.mul(100).toFixed(2)}% away from the mark price ${ref.toFixed()} (band ${D(c.priceBandPct).mul(100).toFixed(2)}%)`, { px: input.px, refPrice: ref.toFixed(), deviationPct: dev.toFixed(6) });
      }
    }
    if (input.ordType === 'market' && input.estSlippagePct !== '' && D(input.estSlippagePct).gt(c.maxSlippagePct)) {
      return fail('MAX_SLIPPAGE', `estimated slippage ${D(input.estSlippagePct).mul(100).toFixed(3)}% exceeds ${D(c.maxSlippagePct).mul(100).toFixed(3)}%`, { estSlippagePct: input.estSlippagePct, limit: c.maxSlippagePct });
      }
    if (input.reduceOnly) return pass();

    // Projected exposure after this order fills.
    const signedOrder = input.side === 'buy' ? notional : notional.neg();
    let instrumentSigned = ZERO;
    let othersAbs = ZERO;
    for (const p of input.positions) {
      const n = positionSignedNotional(p, input.inst);
      if (p.instId === input.inst.instId) instrumentSigned = instrumentSigned.plus(n);
      else othersAbs = othersAbs.plus(n.abs());
    }
    const projectedInstrument = instrumentSigned.plus(signedOrder).abs();
    if (projectedInstrument.gt(c.maxPositionNotionalPerInstrument)) {
      return fail('MAX_POSITION_NOTIONAL', `projected ${input.inst.instId} exposure ${projectedInstrument.toFixed(2)} exceeds the per-instrument limit ${c.maxPositionNotionalPerInstrument}`, {
        current: instrumentSigned.toFixed(2),
        projected: projectedInstrument.toFixed(2),
        limit: c.maxPositionNotionalPerInstrument,
      });
    }
    const projectedTotal = othersAbs.plus(projectedInstrument);
    if (projectedTotal.gt(c.maxTotalPositionNotional)) {
      return fail('MAX_TOTAL_NOTIONAL', `projected total exposure ${projectedTotal.toFixed(2)} exceeds the limit ${c.maxTotalPositionNotional}`, {
        projected: projectedTotal.toFixed(2),
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
