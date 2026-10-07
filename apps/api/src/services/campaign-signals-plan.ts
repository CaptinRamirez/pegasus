import {
  campaignAddTriggered,
  campaignMaintenanceRate,
  campaignSignals,
  contractsToCoin,
  D,
  Decimal,
  floorToStep,
  isolatedLongLiquidationPrice,
  notionalQuote,
  trailingChannel,
  ZERO,
  type CampaignFollowPlan,
  type CampaignHolding,
  type CampaignParams,
  type CampaignPlanWarning,
  type CampaignSignalBar,
  type CampaignSignalReason,
  type CampaignSignalRow,
  type CampaignSignalState,
  type Candle,
  type Instrument,
  type RiskConfig,
  type SignalSnapshot,
  type TdMode,
} from '@pegasus/shared';

/**
 * The campaign rule read for one coin, and the plan to follow a signal by hand: pure functions of the confirmed bars,
 * the mark price and the account, used by campaign-signals.ts. Everything through @pegasus/shared's campaign
 * functions and decimal helpers.
 *
 * States (evaluateCampaignSignal), by priority. Holding (the account holds a long on the coin): `exit` when the last
 * daily close was below the exit level (campaignSignals' exit: the lowest low of the exitChannel bars before it), else
 * `add` when the last confirmed 12-hour close, one that closed after the last opening fill, reached the add trigger
 * (campaignAddTriggered: addRef x (1 + addStep); never in the 'noadd' structure), else `holding`. The add reference is
 * the average price of the last opening order of the journal's trade (the entry or the last add), else the position's
 * average price. Not holding: `entry` when the last daily close was above the entry level (the highest high of the
 * entryChannel bars before it), else `near` when the mark is at most NEAR_PCT below the next entry level (the highest
 * high of the last entryChannel bars, what the next daily close must close above) or above it, else `none`.
 * Bars that are not confirmed are never used.
 *
 * Plan (planCampaignFollow), for `entry` and `add`: an isolated market buy at about the mark, its stop at the exit
 * line (the lowest low of the last exitChannel confirmed daily bars: what the next daily close is measured against,
 * and where the channel trailing exit keeps the stop), the channel trailing exit over exitChannel bars and no
 * take-profit. Size: riskPct of the equity lost from the mark to the stop, in whole lots rounded down, at least the
 * minimum order (BELOW_MIN_ORDER when that risks more): `riskContracts`. Then no more than the risk limits allow
 * (`contracts`): the per-order notional, the coin's position limit less what is held on it and the total limit less
 * what is held, each contract valued at the mark plus the slippage the engine tolerates (RISK_MAX_SLIPPAGE_PCT: the
 * engine values a market buy at its estimated fill, and refuses one that slips more), in whole lots (LIMITED_BY_*
 * says which limit cut the size); when even the minimum order breaks a limit the plan has no size (OVER_*).
 * Leverage, for an entry: the highest whole number up to the campaign's leverage, RISK_MAX_LEVERAGE and the
 * instrument's maximum that keeps the estimated isolated liquidation price (isolatedLongLiquidationPrice with
 * campaignMaintenanceRate: the first tier plus the taker fee; the margin is notional / leverage) at or below the
 * stop x (1 - LIQ_BUFFER_PCT); 1x always does (LEVERAGE_REDUCED names both liquidation prices). For an add, the
 * position's own leverage setting (an add to an isolated position posts notional / setting) and the position after
 * the add is estimated the same way (LIQUIDATION_NEAR_STOP when it would not stay below the stop with the buffer).
 * Linear contracts only.
 */

/** A coin whose mark is at most this far below the next entry level is near an entry. */
export const NEAR_PCT = '0.03';
/** A stop further than this from the entry is unusually wide. */
export const STOP_WIDE_PCT = '0.2';
/** A stop closer than this to the entry is unusually narrow. */
export const STOP_NARROW_PCT = '0.02';
/** A mark this far above the signal's close is far above it. */
export const FAR_ABOVE_PCT = '0.05';
/** The estimated liquidation must be at least this fraction of the stop below the stop. */
export const LIQ_BUFFER_PCT = '0.01';
/** Risk of one plan when the request names none: 1% of the equity. */
export const DEFAULT_FOLLOW_RISK_PCT = '0.01';

export const DAY_MS = 86_400_000;
export const HALF_DAY_MS = 43_200_000;

/** The long the account holds, as the signals need it. */
export interface HeldLong {
  contracts: string;
  avgPx: string;
  mgnMode: TdMode;
  lever: string;
  margin: string;
  liqPx: string;
  addRef: string;
  addRefTs: number | null;
  addRefSource: 'journal' | 'position';
  tradeId: string | null;
}

export interface SignalInput {
  instId: string;
  /** Daily UTC bars, oldest first; unconfirmed ones are left out */
  daily: readonly Candle[];
  /** 12-hour UTC bars, oldest first; unconfirmed ones are left out */
  halfDay: readonly Candle[];
  markPx: string | null;
  params: CampaignParams;
  held: HeldLong | null;
  /** Contracts of a short the account holds on the coin; null without one */
  shortContracts: string | null;
}

export type EvaluatedSignal = Omit<CampaignSignalRow, 'tracked' | 'plan'>;

const fine = (v: Decimal): string => v.toSignificantDigits(15).toFixed();

/** The state of one coin (see the header). */
export function evaluateCampaignSignal(input: SignalInput): EvaluatedSignal {
  const p = input.params;
  const daily = input.daily.filter((c) => c.confirm).sort((a, b) => a.ts - b.ts);
  const halfDay = input.halfDay.filter((c) => c.confirm).sort((a, b) => a.ts - b.ts);
  const lastHalf = halfDay[halfDay.length - 1];
  const halfDayBar: CampaignSignalBar | null = lastHalf ? { barTs: lastHalf.ts, closeTs: lastHalf.ts + HALF_DAY_MS, close: lastHalf.close } : null;
  const need = Math.max(p.entryChannel, p.exitChannel) + 1;
  const last = daily[daily.length - 1];
  if (!last || daily.length < need) {
    return {
      instId: input.instId,
      state: 'unavailable',
      reasons: [{ code: 'NOT_ENOUGH_BARS', params: { have: daily.length, need } }],
      daily: last ? { barTs: last.ts, closeTs: last.ts + DAY_MS, close: last.close } : null,
      halfDay: halfDayBar,
      levels: { entry: null, exit: null, nextEntry: null, nextExit: null },
      markPx: input.markPx,
      entryDistancePct: null,
      holding: null,
      signal: null,
    };
  }
  const sig = campaignSignals(daily, p);
  const nextEntry = trailingChannel(daily, p.entryChannel).high;
  const nextExit = trailingChannel(daily, p.exitChannel).low;
  const entryLevel = sig.entryHigh as string;
  const exitLevel = sig.exitLow as string;
  const mark = input.markPx !== null && D(input.markPx).gt(0) ? D(input.markPx) : null;
  const distance = mark === null ? null : nextEntry.div(mark).minus(1);
  const reasons: CampaignSignalReason[] = [];
  if (mark === null) reasons.push({ code: 'NO_MARK_PRICE', params: {} });
  if (input.shortContracts !== null) reasons.push({ code: 'SHORT_HELD', params: { contracts: input.shortContracts } });
  const row: EvaluatedSignal = {
    instId: input.instId,
    state: 'none',
    reasons,
    daily: { barTs: last.ts, closeTs: last.ts + DAY_MS, close: last.close },
    halfDay: halfDayBar,
    levels: { entry: entryLevel, exit: exitLevel, nextEntry: nextEntry.toFixed(), nextExit: nextExit.toFixed() },
    markPx: mark === null ? null : mark.toFixed(),
    entryDistancePct: distance === null ? null : fine(distance),
    holding: null,
    signal: null,
  };
  const held = input.held;
  if (held) {
    const adds = p.structure === 'pyramid';
    const addTrigger = adds ? D(held.addRef).mul(D(1).plus(p.addStep)) : null;
    const holding: CampaignHolding = { ...held, trailingLine: nextExit.toFixed(), addTrigger: addTrigger === null ? null : addTrigger.toFixed() };
    row.holding = holding;
    let state: CampaignSignalState = 'holding';
    if (sig.exit) {
      state = 'exit';
      reasons.unshift({ code: 'CLOSE_BELOW_EXIT', params: { close: sig.close, level: exitLevel } });
    } else if (adds && lastHalf && lastHalf.ts + HALF_DAY_MS > (held.addRefTs ?? 0) && campaignAddTriggered(lastHalf.close, held.addRef, p)) {
      state = 'add';
      reasons.unshift({ code: 'ADD_TRIGGER_REACHED', params: { close: lastHalf.close, trigger: holding.addTrigger, addRef: held.addRef, barTs: lastHalf.ts } });
      row.signal = { rule: 'campaign', kind: 'add', barTs: lastHalf.ts, close: lastHalf.close, entryLevel, exitLevel };
    } else {
      reasons.unshift({ code: 'HOLDING', params: { contracts: held.contracts, trailingLine: holding.trailingLine, addTrigger: holding.addTrigger } });
    }
    if (!adds) reasons.push({ code: 'ADDS_OFF', params: {} });
    if (held.addRefSource === 'position') reasons.push({ code: 'ADD_REF_FROM_POSITION', params: { avgPx: held.avgPx } });
    row.state = state;
    return row;
  }
  if (sig.entry) {
    row.state = 'entry';
    reasons.unshift({ code: 'CLOSE_ABOVE_ENTRY', params: { close: sig.close, level: entryLevel } });
    row.signal = { rule: 'campaign', kind: 'entry', barTs: last.ts, close: last.close, entryLevel, exitLevel };
  } else if (distance !== null && mark !== null && distance.lte(NEAR_PCT)) {
    row.state = 'near';
    if (distance.lt(0)) reasons.unshift({ code: 'MARK_ABOVE_ENTRY', params: { markPx: mark.toFixed(), level: nextEntry.toFixed() } });
    else reasons.unshift({ code: 'NEAR_ENTRY', params: { markPx: mark.toFixed(), level: nextEntry.toFixed(), distancePct: fine(distance), nearPct: NEAR_PCT } });
  } else {
    row.state = 'none';
    reasons.unshift({ code: 'BELOW_ENTRY', params: { markPx: mark === null ? null : mark.toFixed(), level: nextEntry.toFixed(), distancePct: distance === null ? null : fine(distance) } });
  }
  return row;
}

export interface PlanInput {
  kind: 'entry' | 'add';
  inst: Instrument;
  markPx: string;
  /** The exit line: the plan's stop */
  stopPx: string;
  signal: SignalSnapshot;
  /** When the bar of the signal closed, and the length of that bar */
  signalCloseTs: number;
  barMs: number;
  /** Equity to size with; null when unknown */
  equity: string | null;
  riskPct: string;
  params: CampaignParams;
  risk: RiskConfig;
  /** USD notional held now on the instrument (both sides) and in total */
  instrumentNotional: string;
  totalNotional: string;
  /** An add: the long held */
  held: HeldLong | null;
  now: number;
  tracked: boolean;
  campaignAccount: boolean;
  killSwitch: boolean;
}

/** The estimated isolated liquidation of a long at `entryPx` with `lever`: it does not depend on the size, so one unit of coin, its margin entry / lever. */
const liquidationAt = (entryPx: Decimal, lever: number, maintenance: string): Decimal =>
  Decimal.max(isolatedLongLiquidationPrice({ qty: 1, avgPx: entryPx, margin: entryPx.div(lever) }, maintenance), ZERO);

/** The line the estimated liquidation must stay at or below: the stop less LIQ_BUFFER_PCT of it. */
const liquidationLimit = (stopPx: Decimal): Decimal => stopPx.mul(D(1).minus(LIQ_BUFFER_PCT));

/**
 * The highest whole leverage up to `cap` whose estimated isolated liquidation stays at or below stop x (1 - LIQ_BUFFER_PCT); 1 at
 * least. `liqPxAtCap` is the liquidation at `cap` itself, the one a reduced leverage is explained by.
 */
export function followLeverage(entryPx: Decimal, stopPx: Decimal, cap: number, maintenance: string): { leverage: number; liqPx: Decimal; liqPxAtCap: Decimal } {
  const limit = liquidationLimit(stopPx);
  const top = Math.max(1, cap);
  const liqPxAtCap = liquidationAt(entryPx, top, maintenance);
  for (let lever = top; lever >= 1; lever--) {
    const liqPx = lever === top ? liqPxAtCap : liquidationAt(entryPx, lever, maintenance);
    if (liqPx.lte(limit) || lever === 1) return { leverage: lever, liqPx, liqPxAtCap };
  }
  return { leverage: 1, liqPx: ZERO, liqPxAtCap };
}

/** The size a risk limit leaves room for: `room` of notional over a contract valued at `perContract`, in whole lots, never negative. */
const roomContracts = (room: Decimal, perContract: Decimal, inst: Instrument): Decimal => Decimal.max(floorToStep(room.div(perContract), inst.lotSz), ZERO);

/** How to follow an entry or an add by hand (see the header). */
export function planCampaignFollow(input: PlanInput): CampaignFollowPlan {
  const { inst, params } = input;
  const entry = D(input.markPx);
  const stop = D(input.stopPx);
  const warnings: CampaignPlanWarning[] = [];
  const maintenance = campaignMaintenanceRate(inst, params);
  const stopDistance = entry.minus(stop);
  const stopDistancePct = entry.gt(0) ? stopDistance.div(entry) : ZERO;
  const cap = Math.max(1, Math.floor(Decimal.min(params.leverage, input.risk.maxLeverage, D(inst.maxLever || params.leverage)).toNumber()));
  const plan: CampaignFollowPlan = {
    kind: input.kind,
    instId: inst.instId,
    side: 'buy',
    tdMode: 'isolated',
    spec: inst,
    entryPx: entry.toFixed(),
    stopPx: stop.toFixed(),
    stopDistance: stopDistance.toFixed(),
    stopDistancePct: fine(stopDistancePct),
    riskTarget: null,
    riskAmount: null,
    riskContracts: null,
    contracts: null,
    coin: null,
    notional: null,
    leverage: String(cap),
    margin: null,
    liqPx: null,
    maintenanceRate: maintenance,
    trailing: { kind: 'channel', bars: params.exitChannel },
    takeProfits: [],
    after: null,
    signal: input.signal,
    warnings,
  };
  if (!input.tracked) warnings.push({ code: 'NOT_TRACKED', params: {} });
  if (input.campaignAccount) warnings.push({ code: 'CAMPAIGN_ACCOUNT', params: {} });
  if (input.killSwitch) warnings.push({ code: 'KILL_SWITCH', params: {} });
  const signalAge = input.now - input.signalCloseTs;
  if (signalAge > input.barMs) warnings.push({ code: 'SIGNAL_STALE', params: { barTs: input.signal.barTs, closedAt: input.signalCloseTs, ageMs: signalAge } });
  const close = D(input.signal.close);
  const rise = close.gt(0) ? entry.div(close).minus(1) : ZERO;
  if (rise.gt(FAR_ABOVE_PCT)) warnings.push({ code: 'PRICE_FAR_ABOVE_SIGNAL', params: { markPx: entry.toFixed(), close: close.toFixed(), risePct: fine(rise), limit: FAR_ABOVE_PCT } });
  if (inst.ctType !== 'linear') {
    warnings.push({ code: 'LINEAR_ONLY', params: {} });
    return plan;
  }
  if (!stopDistance.gt(0)) {
    warnings.push({ code: 'STOP_NOT_BELOW_ENTRY', params: { stopPx: stop.toFixed(), entryPx: entry.toFixed() } });
    return plan;
  }
  if (stopDistancePct.gt(STOP_WIDE_PCT)) warnings.push({ code: 'STOP_TOO_WIDE', params: { stopDistancePct: fine(stopDistancePct), limit: STOP_WIDE_PCT } });
  if (stopDistancePct.lt(STOP_NARROW_PCT)) warnings.push({ code: 'STOP_TOO_NARROW', params: { stopDistancePct: fine(stopDistancePct), limit: STOP_NARROW_PCT } });

  // Leverage: an entry's is chosen against the stop; an add posts at the position's own setting.
  const held = input.kind === 'add' ? input.held : null;
  let leverage: number;
  if (held && held.lever !== '' && D(held.lever).gt(0)) {
    leverage = D(held.lever).toNumber();
    plan.leverage = held.lever;
  } else {
    const chosen = followLeverage(entry, stop, cap, maintenance);
    leverage = chosen.leverage;
    plan.leverage = String(chosen.leverage);
    plan.liqPx = fine(chosen.liqPx);
    if (chosen.leverage < cap) {
      warnings.push({
        code: 'LEVERAGE_REDUCED',
        params: { leverage: chosen.leverage, maxLeverage: cap, liqPx: fine(chosen.liqPx), liqPxAtMax: fine(chosen.liqPxAtCap), stopPx: stop.toFixed(), limitPx: fine(liquidationLimit(stop)) },
      });
    }
  }

  const equity = input.equity !== null && D(input.equity).gt(0) ? D(input.equity) : null;
  if (equity === null) {
    warnings.push({ code: 'EQUITY_UNKNOWN', params: {} });
    return plan;
  }
  const riskTarget = equity.mul(input.riskPct);
  const riskPerContract = stopDistance.mul(contractsToCoin(1, inst));
  const sized = floorToStep(riskTarget.div(riskPerContract), inst.lotSz);
  let contracts = sized;
  if (sized.lt(inst.minSz)) {
    contracts = D(inst.minSz);
    warnings.push({ code: 'BELOW_MIN_ORDER', params: { sized: sized.toFixed(), minSz: inst.minSz, riskAmount: fine(contracts.mul(riskPerContract)) } });
  }
  plan.riskTarget = fine(riskTarget);
  plan.riskContracts = contracts.toFixed();

  // The risk limits, as the engine checks an opening order: each contract valued at the mark plus the slippage it tolerates.
  const risk = input.risk;
  const valued = notionalQuote(1, entry, inst).mul(D(1).plus(risk.maxSlippagePct));
  const rooms = [
    { code: 'ORDER_NOTIONAL', limit: risk.maxOrderNotional, held: ZERO, room: roomContracts(D(risk.maxOrderNotional), valued, inst) },
    { code: 'POSITION_NOTIONAL', limit: risk.maxPositionNotionalPerInstrument, held: D(input.instrumentNotional), room: roomContracts(D(risk.maxPositionNotionalPerInstrument).minus(input.instrumentNotional), valued, inst) },
    { code: 'TOTAL_NOTIONAL', limit: risk.maxTotalPositionNotional, held: D(input.totalNotional), room: roomContracts(D(risk.maxTotalPositionNotional).minus(input.totalNotional), valued, inst) },
  ] as const;
  let tightest: (typeof rooms)[number] = rooms[0];
  for (const r of rooms) if (r.room.lt(tightest.room)) tightest = r;
  if (tightest.room.lt(inst.minSz)) {
    // not even the minimum order passes: no size, as without a stop (so the plan does not hold the minimum: BELOW_MIN_ORDER goes);
    // the minimum order counted as the room was, each contract at the mark plus the slippage
    const minNotional = valued.mul(inst.minSz);
    const params = tightest.code === 'ORDER_NOTIONAL' ? { notional: fine(minNotional), limit: tightest.limit } : { projected: fine(tightest.held.plus(minNotional)), limit: tightest.limit };
    const below = warnings.findIndex((w) => w.code === 'BELOW_MIN_ORDER');
    if (below >= 0) warnings.splice(below, 1);
    warnings.push({ code: `OVER_${tightest.code}`, params });
    return plan;
  }
  if (tightest.room.lt(contracts)) {
    contracts = tightest.room;
    warnings.push({
      code: `LIMITED_BY_${tightest.code}`,
      params: {
        riskContracts: plan.riskContracts,
        contracts: contracts.toFixed(),
        notional: fine(notionalQuote(contracts, entry, inst)),
        limit: tightest.limit,
        riskAmount: fine(contracts.mul(riskPerContract)),
        perContract: fine(valued),
        slippagePct: risk.maxSlippagePct,
      },
    });
  }
  const coin = contractsToCoin(contracts, inst);
  const notional = notionalQuote(contracts, entry, inst);
  const margin = notional.div(leverage);
  plan.riskAmount = fine(contracts.mul(riskPerContract));
  plan.contracts = contracts.toFixed();
  plan.coin = coin.toFixed();
  plan.notional = fine(notional);
  plan.margin = fine(margin);
  if (!held) {
    plan.liqPx = fine(isolatedLongLiquidationPrice({ qty: coin, avgPx: entry, margin }, maintenance));
  } else {
    // The position after the add, at the mark.
    const heldCoin = contractsToCoin(held.contracts, inst);
    const totalCoin = heldCoin.plus(coin);
    const avgPx = heldCoin.mul(held.avgPx).plus(coin.mul(entry)).div(totalCoin);
    const isolated = held.mgnMode === 'isolated' && held.margin !== '';
    const afterMargin = isolated ? D(held.margin).plus(margin) : null;
    const afterLiq = afterMargin === null ? null : isolatedLongLiquidationPrice({ qty: totalCoin, avgPx, margin: afterMargin }, maintenance);
    plan.after = { contracts: D(held.contracts).plus(contracts).toFixed(), avgPx: fine(avgPx), margin: afterMargin === null ? null : fine(afterMargin), liqPx: afterLiq === null ? null : fine(afterLiq) };
    plan.liqPx = plan.after.liqPx;
    if (afterLiq !== null && afterLiq.gt(liquidationLimit(stop))) {
      warnings.push({ code: 'LIQUIDATION_NEAR_STOP', params: { liqPx: fine(afterLiq), stopPx: stop.toFixed(), limitPx: fine(liquidationLimit(stop)), leverage: plan.leverage } });
    }
  }
  return plan;
}
