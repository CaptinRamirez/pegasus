import {
  barOiChanges,
  buildSignalReport,
  contractsToCoin,
  D,
  dailyBarsFromHalfDays,
  Decimal,
  floorToStep,
  minBarsRequired,
  notionalQuote,
  quoteToContracts,
  splitSizingAcrossPhases,
  ZERO,
  type BarOiChange,
  type Candle,
  type DecimalInput,
  type EntrySide,
  type FundingRecord,
  type Instrument,
  type InstrumentSignalReport,
  type SignalPhase,
  type SizingParams,
} from '@pegasus/shared';
import type { BacktestResult, DecisionRecord, EngineConfig, EquitySample, ExitReason, GateRule, InstrumentData, OiLevel, SignalEvent, Trade, TradeFlags } from './types.js';

/**
 * The backtest engine: replays the confirmed daily bars of every instrument and cut and, at each close,
 * asks buildSignalReport (the function behind the SIGNALS tab) what to do. No indicator, regime, gate or
 * size is computed here; the engine only keeps the book: fills, stops, costs, funding, equity.
 *
 * Timing rules (each pinned by a test in test/engine.test.ts):
 *
 * E1. One lot per instrument and cut. A cut's decision is taken at the close of its bar, from that
 *     bar and the ones before it, and filled at the OPEN of that cut's next bar, never at the signal
 *     bar's close. Without a next bar there is no trade. The next bar is the one that opens at this
 *     bar's close: across a hole in the data nothing is filled and no lot leaves at an open.
 * E2. Contracts are those of the report's sizing plan for the side (0 = the minimum order exceeds the
 *     budget: recorded as skipped). The initial stop is the fill price -/+ atrStopMultiple x the signal
 *     bar's ATR.
 * E3. From the entry bar on, a bar whose low (long) or high (short) reaches the resting stop exits at
 *     the worse of the bar's open and the stop: a gap through the stop fills at the open. The exit is
 *     recorded at bar open + half a bar. The stop is tested before the bar's close is looked at.
 *     The stop rests on the exchange, so it does not wait for the lot's own close: when a 12-hour bar
 *     closes in the middle of the lot's bar (the other cut's close) the lot is tested against that
 *     12-hour bar and leaves there, and at its own close only the second 12-hour bar is tested.
 * E4. Exit mode 'trail': after each close without an exit signal the resting stop moves to the
 *     report's nextExitLow (long) / nextExitHigh (short), only in the favourable direction. Exit mode
 *     'close': the stop stays where it was set. In both, a close beyond the exit channel
 *     (signals.longExit / shortExit) exits at the next open.
 * E5. After an exit the cut is flat and the same close may open a new lot.
 * E6. Costs are charged on the fill notional; prices are not shifted.
 * E7. Funding: every settlement with time in (entry time, exit time] moves side x rate x the lot's
 *     notional at the close of the bar that contains it (the bar with open < time <= close); a long
 *     pays a positive rate. A lot stopped in the first half of its bar pays at that half's close; a
 *     settlement inside a hole in the data is charged at the close of the next bar the lot sees.
 * E8. One equity for all instruments, marked to market at every close; a report is sized from the
 *     equity at its close, after the stops and the funding of the bars that closed with it. The
 *     portfolio gates are checked at the decision, after the exits and trims of every instrument that
 *     closes at the same instant: the outcome does not depend on the order of the instruments.
 * E9. Trim: at a lot's close, when the instrument's marked notional over all its lots exceeds
 *     trimPct x equity, the lot sells its share of the excess at its next open, keeps its stop and
 *     goes on.
 *
 * What the engine knows at a close T: candles that closed at or before T, funding settlements with
 * time <= T, open interest levels at instants <= T. A lot of the other cut is in the middle of its bar
 * at T: it is marked at the price at T, after its stop was tested against the 12-hour bar that closed
 * at T (without 12-hour bars the stop is only tested when the lot's own bar closes).
 *
 * Linear contracts only: P&L = side x (exit - entry) x contracts x ctVal.
 */

const DAY_MS = 86_400_000;
const HALF_DAY_MS = DAY_MS / 2;
/** The live service computes a report from one page of daily candles. */
export const SIGNAL_WINDOW_BARS = 300;
/** The live service passes the newest page of funding records. */
const FUNDING_RECORDS = 100;
/** Weight of a lot's risk when another instrument holds a lot on the same side (docs/strategy.md 2.2). */
const CORRELATED_HEAT = '1.5';

/** Sizing of one cut's lot: the unit split across the cuts, with the stop multiple of the trend parameters. */
export function phaseSizing(config: EngineConfig): SizingParams {
  return splitSizingAcrossPhases({ ...config.sizing, atrStopMultiple: config.params.atrStopMultiple }, config.phases.length);
}

/** Index of the first element with time > t in an array sorted by time. */
function upperBound<T>(rows: readonly T[], t: number, timeOf: (row: T) => number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timeOf(rows[mid] as T) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---- open interest inputs, as the live service builds them ----

export interface OiInputs {
  /** Per bar of the window (crisis rule); null = unknown for every bar */
  oiChanges: BarOiChange[] | null;
  /** Over the 10 days ending at the close (crowding rule); null = unknown */
  crowding: string | null;
  /** The history had the change of the window's last bar */
  known: boolean;
}

/**
 * Reads the open interest inputs of a report off the levels of one instrument. `barMs` is the length
 * of a bar (a day). A level is used only when its instant is at or before the close the report is for.
 * The change of a bar depends on its two levels alone, so it is computed once (by barOiChanges) and kept.
 */
export function oiReader(levels: readonly OiLevel[] | null, barMs = DAY_MS): (window: readonly Candle[], close: number, mode: EngineConfig['oiMode']) => OiInputs {
  const byInstant = new Map<number, OiLevel>();
  for (const l of levels ?? []) byInstant.set(l.ts, l);
  const perBar = new Map<number, BarOiChange | null>();
  /** Change from `ts` to `ts + span`; null when a level is missing or the later one lies after the close. */
  const change = (ts: number, span: number, close: number): BarOiChange | null => {
    if (ts + span > close) return null;
    const open = byInstant.get(ts);
    const end = byInstant.get(ts + span);
    return open && end ? (barOiChanges([open, end], [ts], span)[0] ?? null) : null;
  };
  const barChange = (ts: number, close: number): BarOiChange | null => {
    if (ts + barMs > close) return null;
    let c = perBar.get(ts);
    if (c === undefined) {
      c = change(ts, barMs, close);
      perBar.set(ts, c);
    }
    return c;
  };
  return (window, close, mode) => {
    const last = window[window.length - 1];
    const calm = (): BarOiChange[] => window.map((c) => barChange(c.ts, close) ?? { ts: c.ts, change: '0' });
    if (!levels || !last) return { oiChanges: mode === 'calm' ? calm() : null, crowding: null, known: false };
    const known = barChange(last.ts, close) !== null;
    if (mode === 'none') return { oiChanges: null, crowding: null, known };
    const crowding = change(close - 10 * barMs, 10 * barMs, close)?.change ?? null;
    // calm: a bar whose change is unknown counts as a bar on which open interest did not move.
    if (mode === 'calm') return { oiChanges: calm(), crowding, known };
    const changes: BarOiChange[] = [];
    for (const c of window) {
      const bar = barChange(c.ts, close);
      if (bar) changes.push(bar);
    }
    return { oiChanges: changes, crowding, known };
  };
}

/** The open interest inputs of the report for the window that closes at `close`, from the levels known by then. */
export function oiInputs(levels: readonly OiLevel[] | null, window: readonly Candle[], close: number, mode: EngineConfig['oiMode'], barMs = DAY_MS): OiInputs {
  return oiReader(levels, barMs)(window, close, mode);
}

// ---- portfolio gates and the trim rule ----

/** An open lot as the gates see it. */
export interface GateLot {
  instId: string;
  side: EntrySide;
  /** Marked notional */
  notional: DecimalInput;
  /** Loss from the entry price to the current stop; 0 once the stop has passed the entry */
  risk: DecimalInput;
}

export interface GateLimits {
  maxInstruments: number;
  maxGrossPct: string;
  heatCap: string | null;
}

/** Whether lots of two or more instruments, the candidate included, sit on `side`. */
function correlated(lots: readonly GateLot[], side: EntrySide): boolean {
  return new Set(lots.filter((l) => l.side === side).map((l) => l.instId)).size > 1;
}

/**
 * The portfolio rule that blocks `candidate`, or null when it may be opened (docs/strategy.md 3.4):
 * the number of instruments with open lots, the marked notional of all lots plus the new one against
 * equity, and, when a heat cap is set, the risk of all lots to their current stops plus the new lot's
 * (x1.5 for lots whose side is shared by another instrument) against equity.
 */
export function blockingGate(open: readonly GateLot[], candidate: GateLot, equity: DecimalInput, limits: GateLimits): GateRule | null {
  const eq = D(equity);
  const instruments = new Set(open.map((l) => l.instId));
  if (!instruments.has(candidate.instId) && instruments.size >= limits.maxInstruments) return 'max-instruments';
  const all = [...open, candidate];
  let gross = ZERO;
  for (const l of all) gross = gross.plus(l.notional);
  if (gross.gt(eq.mul(limits.maxGrossPct))) return 'max-gross';
  if (limits.heatCap !== null) {
    let heat = ZERO;
    for (const l of all) heat = heat.plus(D(l.risk).mul(correlated(all, l.side) ? CORRELATED_HEAT : 1));
    if (heat.gt(eq.mul(limits.heatCap))) return 'heat';
  }
  return null;
}

/**
 * Contracts a lot sells under the trim rule (docs/strategy.md 3.4): its share of the instrument's
 * excess over trimPct x equity, converted at `px` and rounded down to lotSz. 0 when there is no excess.
 */
export function trimContracts(lotNotional: DecimalInput, instNotional: DecimalInput, equity: DecimalInput, trimPct: DecimalInput, px: DecimalInput, inst: Instrument): Decimal {
  const total = D(instNotional);
  const limit = D(equity).mul(trimPct);
  if (D(trimPct).lte(0) || total.lte(0) || !total.gt(limit)) return ZERO;
  const share = total.minus(limit).mul(lotNotional).div(total);
  return floorToStep(quoteToContracts(share, px, inst), inst.lotSz);
}

// ---- the book ----

interface Lot {
  instId: string;
  inst: Instrument;
  phase: SignalPhase;
  side: EntrySide;
  dir: 1 | -1;
  signalTs: number;
  /** Index of the entry bar in the cut's bars */
  entryIndex: number;
  entryTime: number;
  entryPx: Decimal;
  /** Instant up to which the price was tested against the resting stop */
  stopTestedTo: number;
  /** Instant up to which the funding settlements were charged */
  fundedTo: number;
  initialStop: Decimal;
  stop: Decimal;
  /** The trailing rule has moved the stop: its exit is a 'trail' exit */
  stopMoved: boolean;
  contracts0: Decimal;
  contracts: Decimal;
  notional0: Decimal;
  risk0: Decimal;
  /** Price P&L of the contracts already sold */
  realized: Decimal;
  fees: Decimal;
  funding: Decimal;
  flags: TradeFlags;
}

/** The bars of one instrument at one cut. */
interface Series {
  data: InstrumentData;
  phase: SignalPhase;
  bars: Candle[];
  /** Close time of a bar -> its index */
  closeIndex: Map<number, number>;
  /** The open interest inputs of this instrument */
  oi: ReturnType<typeof oiReader>;
}

const lotKey = (instId: string, phase: SignalPhase): string => `${instId}:${phase}`;

export function runBacktest(data: readonly InstrumentData[], config: EngineConfig): BacktestResult {
  const { params, costs } = config;
  const sizing = phaseSizing(config);
  const minBars = minBarsRequired(params);
  const inRange = (c: Candle): boolean => c.confirm && (config.to === null || c.ts + DAY_MS <= config.to);

  // ---- series, marks and the timeline ----
  const instIds = data.map((d) => d.inst.instId);
  const series: Series[] = [];
  /** Per instrument: instant -> the 12-hour bar that closes there */
  const halves = new Map<string, Map<number, Candle>>();
  const fundingOf = new Map<string, FundingRecord[] | null>();
  /** Per instrument: instant -> the close of a bar that closes there */
  const marks = new Map<string, Map<number, string>>();
  for (const d of data) {
    if (d.inst.ctType !== 'linear') throw new Error(`${d.inst.instId}: the backtester handles linear contracts only`);
    const byInstant = new Map<number, string>();
    marks.set(d.inst.instId, byInstant);
    const oi = oiReader(d.oi);
    halves.set(d.inst.instId, new Map(d.halfDay.filter((c) => c.confirm).map((c) => [c.ts + HALF_DAY_MS, c])));
    fundingOf.set(d.inst.instId, d.funding);
    const daily = d.daily.filter(inRange);
    for (const c of daily) byInstant.set(c.ts + DAY_MS, c.close);
    for (const phase of config.phases) {
      const bars = phase === 0 ? daily : dailyBarsFromHalfDays(d.halfDay, phase).filter(inRange);
      const closeIndex = new Map<number, number>();
      bars.forEach((c, i) => {
        closeIndex.set(c.ts + DAY_MS, i);
        byInstant.set(c.ts + DAY_MS, c.close);
      });
      series.push({ data: d, phase, bars, closeIndex, oi });
    }
  }
  const instants = [...new Set([...marks.values()].flatMap((m) => [...m.keys()]))].sort((a, b) => a - b);

  // ---- state ----
  let cash = D(config.equity);
  let fundingPaid = ZERO;
  let started = false;
  const lots = new Map<string, Lot>();
  const lastPrice = new Map<string, string>();
  const trades: Trade[] = [];
  const signals: SignalEvent[] = [];
  const decisions: DecisionRecord[] = [];
  const samples: EquitySample[] = [];

  const coin = (lot: Lot, contracts: Decimal): Decimal => contractsToCoin(contracts, lot.inst);
  const pricePnl = (lot: Lot, px: DecimalInput, contracts: Decimal): Decimal => D(px).minus(lot.entryPx).mul(lot.dir).mul(coin(lot, contracts));
  const markOf = (lot: Lot): string => lastPrice.get(lot.instId) ?? lot.entryPx.toFixed();
  const markedNotional = (lot: Lot): Decimal => notionalQuote(lot.contracts, markOf(lot), lot.inst);
  const equityNow = (): Decimal => {
    let eq = cash;
    for (const lot of lots.values()) eq = eq.plus(pricePnl(lot, markOf(lot), lot.contracts));
    return eq;
  };
  /** Fraction of the fill notional a fill costs. A long held in spot pays the spot fee instead of the swap's. */
  const costRate = (side: EntrySide, stop: boolean): Decimal => {
    const fee = config.longVenue === 'spot' && side === 'long' ? costs.spotFee : stop ? costs.stopFee : costs.fee;
    return D(fee).plus(stop ? costs.stopSlippage : costs.slippage);
  };

  const toTrade = (lot: Lot, exitTime: number, exitPx: DecimalInput, reason: ExitReason, open: boolean): Trade => {
    // A lot still open is shown at its mark: the unsold contracts count at `exitPx`, without exit costs.
    const gross = open ? lot.realized.plus(pricePnl(lot, exitPx, lot.contracts)) : lot.realized;
    const net = gross.minus(lot.fees).plus(lot.funding);
    return {
      instId: lot.instId,
      phase: lot.phase,
      side: lot.side,
      signalTs: lot.signalTs,
      entryTime: lot.entryTime,
      entryPx: lot.entryPx.toFixed(),
      initialStop: lot.initialStop.toFixed(),
      exitTime,
      exitPx: D(exitPx).toFixed(),
      reason,
      contracts: lot.contracts0.toFixed(),
      notional: lot.notional0.toFixed(2),
      riskQuote: lot.risk0.toFixed(2),
      fees: lot.fees.toFixed(4),
      funding: lot.funding.toFixed(4),
      grossPnl: gross.toFixed(4),
      netPnl: net.toFixed(4),
      r: net.div(lot.risk0).toFixed(4),
      grossR: gross.div(lot.risk0).toFixed(4),
      flags: { ...lot.flags },
      holdingDays: D(exitTime - lot.entryTime).div(DAY_MS).toFixed(2),
      open,
    };
  };

  /** Sell `contracts` of the lot at `px` and book the price P&L and the cost of the fill. */
  const sell = (lot: Lot, contracts: Decimal, px: DecimalInput, stop: boolean): void => {
    const pnl = pricePnl(lot, px, contracts);
    const cost = notionalQuote(contracts, px, lot.inst).mul(costRate(lot.side, stop));
    lot.realized = lot.realized.plus(pnl);
    lot.fees = lot.fees.plus(cost);
    lot.contracts = lot.contracts.minus(contracts);
    cash = cash.plus(pnl).minus(cost);
  };
  const closeLot = (lot: Lot, px: DecimalInput, time: number, reason: ExitReason, stop: boolean): void => {
    sell(lot, lot.contracts, px, stop);
    lots.delete(lotKey(lot.instId, lot.phase));
    trades.push(toTrade(lot, time, px, reason, false));
  };

  /** E7: the settlements not yet charged, up to `until`, at the lot's notional at the close of `bar`. */
  const chargeFunding = (lot: Lot, records: readonly FundingRecord[] | null, bar: Candle, until: number): void => {
    const since = lot.fundedTo;
    lot.fundedTo = until;
    if (!config.funding || !records || (config.longVenue === 'spot' && lot.side === 'long')) return;
    const notional = notionalQuote(lot.contracts, bar.close, lot.inst);
    const from = upperBound(records, since, (r) => r.fundingTime);
    for (let k = from; k < records.length; k++) {
      const r = records[k] as FundingRecord;
      if (r.fundingTime > until) break;
      if (r.fundingRate === '') continue;
      const flow = D(r.fundingRate).mul(notional).mul(-lot.dir);
      lot.funding = lot.funding.plus(flow);
      fundingPaid = fundingPaid.minus(flow);
      cash = cash.plus(flow);
    }
  };

  /**
   * E3: tests the stop that rested through `bar` (a daily bar or one 12-hour half of it, closed by now).
   * A hit closes the lot at the worse of the bar's open and the stop and charges the funding up to the
   * exit; returns whether the lot left.
   */
  const stopOut = (lot: Lot, records: readonly FundingRecord[] | null, bar: Candle, barMs: number): boolean => {
    lot.stopTestedTo = bar.ts + barMs;
    const hit = lot.side === 'long' ? D(bar.low).lte(lot.stop) : D(bar.high).gte(lot.stop);
    if (!hit) return false;
    const exitTime = bar.ts + barMs / 2;
    chargeFunding(lot, records, bar, exitTime);
    const px = lot.side === 'long' ? Decimal.min(bar.open, lot.stop) : Decimal.max(bar.open, lot.stop);
    closeLot(lot, px, exitTime, lot.stopMoved ? 'trail' : 'stop', true);
    return true;
  };

  const gateLots = (): GateLot[] =>
    [...lots.values()].map((lot) => ({
      instId: lot.instId,
      side: lot.side,
      notional: markedNotional(lot),
      risk: Decimal.max(ZERO, lot.entryPx.minus(lot.stop).mul(lot.dir)).mul(coin(lot, lot.contracts)),
    }));

  const report = (s: Series, i: number, close: number, equity: Decimal): { report: InstrumentSignalReport; oiKnown: boolean } => {
    const window = s.bars.slice(Math.max(0, i + 1 - SIGNAL_WINDOW_BARS), i + 1);
    const funding = s.data.funding;
    // Settlements up to the close, the newest page of them as the live service asks for.
    const known = funding ? upperBound(funding, close, (r) => r.fundingTime) : 0;
    const records = funding ? funding.slice(Math.max(0, known - FUNDING_RECORDS), known) : null;
    const oi = s.oi(window, close, config.oiMode);
    const r = buildSignalReport(s.data.inst.instId, window, records, close, s.data.inst, equity.toFixed(), params, sizing, oi.crowding, oi.oiChanges, s.phase);
    return { report: r, oiKnown: oi.known };
  };

  /** The bar that opens at the close of bar `i`; a later bar behind a hole in the data is not a next bar. */
  const nextBar = (s: Series, i: number): Candle | undefined => {
    const next = s.bars[i + 1];
    return next && next.ts === (s.bars[i] as Candle).ts + DAY_MS ? next : undefined;
  };

  /**
   * What the close of bar `i` of `s` means for the cut's open lot: the channel exit, the trailing stop
   * and the trim, the fills at the open of the next bar. Returns the report for the entry.
   */
  const manage = (s: Series, i: number, close: number, equity: Decimal): InstrumentSignalReport => {
    const { inst } = s.data;
    const key = lotKey(inst.instId, s.phase);
    const bar = s.bars[i] as Candle;
    const next = nextBar(s, i);
    const { report: rep, oiKnown } = report(s, i, close, equity);
    const ind = rep.indicators;
    let lot = lots.get(key);

    if (lot) {
      const exitSignal = lot.side === 'long' ? rep.signals.longExit : rep.signals.shortExit;
      if (exitSignal) {
        // E4: the close is beyond the exit channel; out at the next open.
        if (next) {
          closeLot(lot, next.open, next.ts, 'channel', false);
          lot = undefined;
        }
      } else {
        if (config.exitMode === 'trail') {
          const level = D(lot.side === 'long' ? ind.nextExitLow : ind.nextExitHigh);
          if (lot.side === 'long' ? level.gt(lot.stop) : level.lt(lot.stop)) {
            lot.stop = level;
            lot.stopMoved = true;
          }
        }
        if (next) {
          // E9: the instrument has outgrown its limit; this lot sells its share of the excess.
          let instNotional = ZERO;
          for (const l of lots.values()) if (l.instId === inst.instId) instNotional = instNotional.plus(markedNotional(l));
          const cut = trimContracts(markedNotional(lot), instNotional, equity, config.trimPct, bar.close, inst);
          if (cut.gt(0) && cut.lt(lot.contracts)) {
            sell(lot, cut, next.open, false);
            lot.flags.trimmed = true;
          }
        }
      }
    }

    decisions.push({
      instId: inst.instId,
      phase: s.phase,
      ts: bar.ts,
      closeTs: close,
      equity: equity.toFixed(),
      regime: rep.regime,
      longEntry: rep.signals.longEntry,
      shortEntry: rep.signals.shortEntry,
      longExit: rep.signals.longExit,
      shortExit: rep.signals.shortExit,
      contractsLong: rep.sizing?.long.contracts ?? '',
      contractsShort: rep.sizing?.short.contracts ?? '',
      oiKnown,
      nextExitLow: ind.nextExitLow,
      nextExitHigh: ind.nextExitHigh,
      stop: lot ? lot.stop.toFixed() : null,
    });
    return rep;
  };

  /** The entry decided at the close of bar `i` of `s` from its report, filled at the open of the next bar. */
  const enter = (s: Series, i: number, rep: InstrumentSignalReport, equity: Decimal): void => {
    const { inst } = s.data;
    const key = lotKey(inst.instId, s.phase);
    const bar = s.bars[i] as Candle;
    const next = nextBar(s, i);
    const ind = rep.indicators;
    // E5: a cut that is flat after this close, or leaves at the next open, may enter again.
    if (lots.has(key)) return;
    const side: EntrySide | null = rep.signals.longEntry ? 'long' : rep.signals.shortEntry ? 'short' : null;
    if (side === null) return;
    const event = { instId: inst.instId, phase: s.phase, signalTs: bar.ts, side };
    if (!next) {
      signals.push({ ...event, outcome: 'no-next-bar' });
      return;
    }
    const plan = rep.sizing?.[side];
    if (!plan) {
      signals.push({ ...event, outcome: 'skipped', rule: 'no-equity' });
      return;
    }
    const contracts = D(plan.contracts);
    if (contracts.isZero()) {
      signals.push({ ...event, outcome: 'skipped', rule: 'min-size' });
      return;
    }
    const gate = blockingGate(gateLots(), { instId: inst.instId, side, notional: plan.notional, risk: plan.riskQuote }, equity, config);
    if (gate !== null) {
      signals.push({ ...event, outcome: 'blocked', rule: gate });
      return;
    }
    // E1, E2: filled at the next open; the stop is measured from the fill with the signal bar's ATR.
    const dir = side === 'long' ? 1 : -1;
    const entryPx = D(next.open);
    const distance = D(params.atrStopMultiple).mul(ind.atr);
    const stop = entryPx.minus(distance.mul(dir));
    const notional = notionalQuote(contracts, entryPx, inst);
    const cost = notional.mul(costRate(side, false));
    cash = cash.minus(cost);
    lots.set(key, {
      instId: inst.instId,
      inst,
      phase: s.phase,
      side,
      dir,
      signalTs: bar.ts,
      entryIndex: i + 1,
      entryTime: next.ts,
      entryPx,
      stopTestedTo: next.ts,
      fundedTo: next.ts,
      initialStop: stop,
      stop,
      stopMoved: false,
      contracts0: contracts,
      contracts,
      notional0: notional,
      risk0: contractsToCoin(contracts, inst).mul(distance),
      realized: ZERO,
      fees: cost,
      funding: ZERO,
      flags: { crisis: rep.regime === 'crisis', crowded: plan.adjustments.some((a) => a.startsWith('crowded')), capped: plan.capped, trimmed: false },
    });
    signals.push({ ...event, outcome: 'filled' });
  };

  // ---- the replay ----
  for (const now of instants) {
    for (const [instId, byInstant] of marks) {
      const px = byInstant.get(now);
      if (px !== undefined) lastPrice.set(instId, px);
    }
    const closing: Array<{ s: Series; i: number }> = [];
    for (const s of series) {
      const i = s.closeIndex.get(now);
      if (i !== undefined) closing.push({ s, i });
    }

    // E3: the bar that just closed is tested against the stop that rested through it; then its funding.
    for (const { s, i } of closing) {
      const lot = lots.get(lotKey(s.data.inst.instId, s.phase));
      if (!lot || lot.entryIndex > i) continue;
      const bar = s.bars[i] as Candle;
      // The first half was tested when it closed: only the second half is new.
      const half = lot.stopTestedTo === bar.ts + HALF_DAY_MS ? halves.get(lot.instId)?.get(now) : undefined;
      const out = half ? stopOut(lot, s.data.funding, half, HALF_DAY_MS) : stopOut(lot, s.data.funding, bar, DAY_MS);
      if (!out) chargeFunding(lot, s.data.funding, bar, now);
    }
    // E3: a lot in the middle of its bar is tested against the 12-hour bar that just closed.
    for (const lot of [...lots.values()]) {
      const half = halves.get(lot.instId)?.get(now);
      if (half && lot.stopTestedTo === half.ts) stopOut(lot, fundingOf.get(lot.instId) ?? null, half, HALF_DAY_MS);
    }

    // E8: one equity for every decision of this instant.
    if (config.from === null || now >= config.from) {
      const equity = equityNow();
      // Two passes: every exit and trim of this instant is booked before any gate is checked.
      const entries: Array<{ s: Series; i: number; rep: InstrumentSignalReport }> = [];
      for (const { s, i } of closing) {
        if (i + 1 < minBars) continue;
        started = true;
        entries.push({ s, i, rep: manage(s, i, now, equity) });
      }
      for (const { s, i, rep } of entries) enter(s, i, rep, equity);
    }

    if (started && now % DAY_MS === 0) {
      const equity = equityNow();
      let gross = ZERO;
      for (const lot of lots.values()) gross = gross.plus(markedNotional(lot));
      samples.push({
        ts: now,
        equity: equity.toFixed(4),
        equityNoFunding: equity.plus(fundingPaid).toFixed(4),
        gross: gross.toFixed(2),
        lots: lots.size,
        marks: instIds.map((id) => lastPrice.get(id) ?? ''),
      });
    }
  }

  // Lots still open: listed at their mark, never closed.
  const end = instants[instants.length - 1] ?? 0;
  const openTrades = [...lots.values()].map((lot) => toTrade(lot, end, markOf(lot), 'end-of-data', true));
  const byEntry = (a: Trade, b: Trade): number => a.entryTime - b.entryTime;
  return { instIds, sizing, trades: [...trades.sort(byEntry), ...openTrades.sort(byEntry)], signals, decisions, series: samples };
}

/** Hours of a UTC day at which a cut closes, for labels. */
export function phaseLabel(phase: SignalPhase): string {
  return `${String(phase).padStart(2, '0')}:00`;
}

export { DAY_MS };
