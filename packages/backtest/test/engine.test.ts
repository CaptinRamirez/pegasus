import { atr, buildSignalReport, D, dailyBarsFromHalfDays, Decimal, DEFAULT_SIZING, DEFAULT_TREND_PARAMS, type Candle, type FundingRecord } from '@pegasus/shared';
import { describe, expect, it } from 'vitest';
import { blockingGate, oiInputs, phaseSizing, runBacktest, trimContracts, type GateLot } from '../src/engine.js';
import type { EngineConfig, OiLevel, Trade } from '../src/types.js';
import { bar, barsFromCloses, config, DAY, HALF_DAY, HOUR, instrument, instrumentData, T0, trendBars, trendCloses } from './helpers.js';

/** Index of the first bar the indicators can be computed on: its close is the first decision. */
const SIGNAL = 100;
const ts = (i: number): number => T0 + i * DAY;

/** Stop distance the engine must use for a signal at bar SIGNAL: the multiple of that bar's ATR. */
function stopDistance(bars: readonly Candle[], signal = SIGNAL): Decimal {
  return atr(bars.slice(0, signal + 1), DEFAULT_TREND_PARAMS.atrPeriod).mul(DEFAULT_TREND_PARAMS.atrStopMultiple);
}

function only(trades: readonly Trade[]): Trade {
  expect(trades).toHaveLength(1);
  return trades[0] as Trade;
}

describe('E1: decisions fill at the next open', () => {
  it('fills at the open of the bar after the signal bar, not at the signal close', () => {
    const bars = trendBars(SIGNAL + 3);
    const signalClose = Number((bars[SIGNAL] as Candle).close);
    // The next bar opens one above the signal close.
    bars[SIGNAL + 1] = bar(ts(SIGNAL + 1), signalClose + 1, signalClose + 1.2, signalClose - 0.3, signalClose - 0.1);
    const result = runBacktest([instrumentData(bars)], config());
    const trade = only(result.trades);
    expect(trade.signalTs).toBe(ts(SIGNAL));
    expect(trade.entryTime).toBe(ts(SIGNAL + 1));
    expect(trade.entryPx).toBe(String(signalClose + 1));
    expect(trade.entryPx).not.toBe(String(signalClose));
    expect(trade.side).toBe('long');
    expect(result.signals[0]).toMatchObject({ signalTs: ts(SIGNAL), outcome: 'filled' });
    // Still open when the data ends: listed, marked, not closed.
    expect(trade).toMatchObject({ open: true, reason: 'end-of-data' });
  });

  it('does not trade a signal on the last bar', () => {
    const result = runBacktest([instrumentData(trendBars(SIGNAL + 1))], config());
    expect(result.trades).toHaveLength(0);
    expect(result.signals).toEqual([{ instId: 'AAA-USDT-SWAP', phase: 0, signalTs: ts(SIGNAL), side: 'long', outcome: 'no-next-bar' }]);
  });

  it('does not fill across a hole in the data: the bar after the hole is not the next bar', () => {
    const bars = trendBars(SIGNAL + 5);
    // The bar after the signal bar is missing.
    bars.splice(SIGNAL + 1, 1);
    const result = runBacktest([instrumentData(bars)], config());
    expect(result.signals[0]).toEqual({ instId: 'AAA-USDT-SWAP', phase: 0, signalTs: ts(SIGNAL), side: 'long', outcome: 'no-next-bar' });
    expect(result.trades.every((t) => t.signalTs > ts(SIGNAL))).toBe(true);
    // A trim decided at the close before a hole is not sold at the open after it.
    const whole = trendBars(SIGNAL + 5);
    const holed = whole.filter((_, i) => i !== SIGNAL + 2);
    const trade = only(runBacktest([instrumentData(holed)], config({ trimPct: '0.05' })).trades);
    expect(trade.entryTime).toBe(ts(SIGNAL + 1));
    const decisions = runBacktest([instrumentData(holed)], config({ trimPct: '0.05' })).decisions;
    expect(decisions.map((d) => d.closeTs)).toEqual([ts(SIGNAL + 1), ts(SIGNAL + 2), ts(SIGNAL + 4), ts(SIGNAL + 5)]);
    // Only the close of SIGNAL + 3 has a next bar: one trim, of the whole lot's excess, sold at the open of SIGNAL + 4.
    const close = (whole[SIGNAL + 3] as Candle).close;
    const notional = D(trade.contracts).mul('0.01').mul(close);
    const cut = trimContracts(notional, notional, decisions[2]?.equity ?? 0, '0.05', close, instrument());
    expect(cut.gt(0)).toBe(true);
    expect(trade.fees).toBe(D(trade.notional).mul('0.001').plus(cut.mul('0.01').mul((whole[SIGNAL + 4] as Candle).open).mul('0.001')).toFixed(4));
  });

  it('takes no decision before the start date and drops the bars after the end date', () => {
    const result = runBacktest([instrumentData(trendBars(SIGNAL + 12))], config({ from: ts(SIGNAL + 5), to: ts(SIGNAL + 9) }));
    expect(result.decisions[0]?.closeTs).toBe(ts(SIGNAL + 5));
    expect(result.decisions[result.decisions.length - 1]?.closeTs).toBe(ts(SIGNAL + 9));
    expect((result.trades[0] as Trade).entryTime).toBeGreaterThanOrEqual(ts(SIGNAL + 5));
  });
});

describe('E2: size from the report, stop from the fill', () => {
  it('takes the contracts of the sizing plan and puts the stop atrStopMultiple ATRs of the signal bar below the fill', () => {
    const bars = trendBars(SIGNAL + 3);
    const cfg = config();
    const trade = only(runBacktest([instrumentData(bars)], cfg).trades);
    const report = buildSignalReport('AAA-USDT-SWAP', bars.slice(0, SIGNAL + 1), null, ts(SIGNAL + 1), instrument(), '100000', cfg.params, phaseSizing(cfg));
    expect(trade.contracts).toBe(report.sizing?.long.contracts);
    const distance = stopDistance(bars);
    expect(D(trade.entryPx).minus(trade.initialStop).eq(distance)).toBe(true);
    expect(trade.riskQuote).toBe(D(trade.contracts).mul('0.01').mul(distance).toFixed(2));
    expect(trade.flags.capped).toBe(true);
  });

  it('records a signal whose minimum order exceeds the budget as skipped', () => {
    const data = instrumentData(trendBars(SIGNAL + 3), { inst: instrument('AAA-USDT-SWAP', { minSz: '1000000' }) });
    const result = runBacktest([data], config());
    expect(result.trades).toHaveLength(0);
    expect(result.signals[0]).toMatchObject({ outcome: 'skipped', rule: 'min-size' });
  });
});

describe('E3: stop fills, E5: re-entry, E6: costs', () => {
  /** Entry at the open of bar SIGNAL + 1; `hit` rewrites one later bar given the resting stop. */
  function scenario(index: number, hit: (stop: number, original: Candle) => Candle): { trades: Trade[]; stop: Decimal } {
    const bars = trendBars(SIGNAL + 4);
    const stop = D((bars[SIGNAL + 1] as Candle).open).minus(stopDistance(bars));
    bars[index] = hit(stop.toNumber(), bars[index] as Candle);
    return { trades: runBacktest([instrumentData(bars)], config()).trades, stop };
  }

  it('fills at the stop when the bar trades through it', () => {
    const { trades, stop } = scenario(SIGNAL + 2, (s, b) => bar(b.ts, Number(b.open), Number(b.high), s - 1, Number(b.close)));
    const trade = trades[0] as Trade;
    expect(trade.reason).toBe('stop');
    expect(D(trade.exitPx).eq(stop)).toBe(true);
    expect(trade.exitTime).toBe(ts(SIGNAL + 2) + HALF_DAY);
    expect(trade.open).toBe(false);
    // E6: entry at fee + slippage, the stop exit at stop fee + stop slippage, both on the fill notional.
    const coin = D(trade.contracts).mul('0.01');
    expect(trade.fees).toBe(coin.mul(trade.entryPx).mul('0.001').plus(coin.mul(stop).mul('0.002')).toFixed(4));
    expect(D(trade.netPnl).toFixed(2)).toBe(D(trade.grossPnl).minus(trade.fees).toFixed(2));
    expect(D(trade.grossR).toFixed(2)).toBe('-1.00');
    expect(D(trade.r).lt(-1)).toBe(true);
  });

  it('fills at the open when the bar gaps through the stop', () => {
    const { trades, stop } = scenario(SIGNAL + 2, (s, b) => bar(b.ts, s - 2, Number(b.high), s - 3, Number(b.close)));
    const trade = trades[0] as Trade;
    expect(trade.reason).toBe('stop');
    expect(D(trade.exitPx).eq(D(stop.toNumber() - 2))).toBe(true);
    expect(D(trade.grossR).lt(-1)).toBe(true);
  });

  it('tests the stop on the entry bar too', () => {
    const { trades, stop } = scenario(SIGNAL + 1, (s, b) => bar(b.ts, Number(b.open), Number(b.high), s - 0.5, Number(b.close)));
    const trade = trades[0] as Trade;
    expect(D(trade.exitPx).eq(stop)).toBe(true);
    expect(trade.exitTime).toBe(ts(SIGNAL + 1) + HALF_DAY);
  });

  it('E5: the close of the bar that stopped the lot may open a new one', () => {
    // Bar SIGNAL + 2 trades through the stop and still closes at a new high.
    const { trades } = scenario(SIGNAL + 2, (s, b) => bar(b.ts, Number(b.open), Number(b.high), s - 1, Number(b.close)));
    expect(trades).toHaveLength(2);
    expect(trades[1]).toMatchObject({ signalTs: ts(SIGNAL + 2), entryTime: ts(SIGNAL + 3), open: true });
  });
});

describe('E4: exits', () => {
  // 141 bars up, then 20 bars down by 1.5 a day.
  const up = trendCloses(SIGNAL + 41);
  const top = up[up.length - 1] as number;
  const bars = barsFromCloses([...up, ...Array.from({ length: 20 }, (_, k) => top - 1.5 * (k + 1))], 100);

  it('trail: the resting stop follows nextExitLow and never moves back', () => {
    const result = runBacktest([instrumentData(bars)], config({ exitMode: 'trail' }));
    const trade = only(result.trades);
    let stop = D(trade.initialStop);
    let held = 0;
    let moved = 0;
    for (const d of result.decisions) {
      if (d.stop === null) continue;
      const expected = Decimal.max(stop, d.nextExitLow);
      expect(D(d.stop).eq(expected)).toBe(true);
      if (D(d.nextExitLow).lt(stop)) held++;
      if (expected.gt(stop)) moved++;
      stop = expected;
    }
    expect(held).toBeGreaterThan(0);
    expect(moved).toBeGreaterThan(0);
    // The decline runs into the trailed stop inside a bar.
    expect(trade.reason).toBe('trail');
    const exitBar = bars.find((b) => b.ts === trade.exitTime - HALF_DAY) as Candle;
    expect(D(trade.exitPx).eq(Decimal.min(exitBar.open, stop))).toBe(true);
    expect(D(trade.exitPx).gt(trade.initialStop)).toBe(true);
    // One book: the equity at the end is the start plus the net result of the trade.
    const last = result.series[result.series.length - 1];
    expect(D(last?.equity ?? 0).minus(100000).minus(trade.netPnl).abs().lt('0.01')).toBe(true);
  });

  it('close: the stop stays at the initial stop and a close below the exit channel leaves at the next open', () => {
    const result = runBacktest([instrumentData(bars)], config({ exitMode: 'close' }));
    const trade = only(result.trades);
    for (const d of result.decisions) if (d.stop !== null) expect(d.stop).toBe(trade.initialStop);
    const signal = result.decisions.find((d) => d.longExit && d.ts > trade.entryTime);
    expect(signal).toBeDefined();
    expect(trade.reason).toBe('channel');
    expect(trade.exitTime).toBe(signal?.closeTs ?? 0);
    expect(trade.exitPx).toBe((bars.find((b) => b.ts === trade.exitTime) as Candle).open);
  });
});

describe('E7: funding', () => {
  /** A lot from the open of bar SIGNAL + 1 (E), stopped inside bar SIGNAL + 3 (exit time X = its open + 12h). */
  function run(funding: FundingRecord[], over: Partial<EngineConfig> = {}, step = 0.5): Trade {
    const bars = trendBars(SIGNAL + 5, step > 0 ? 100 : 300, step);
    const distance = stopDistance(bars);
    const b = bars[SIGNAL + 3] as Candle;
    const entry = D((bars[SIGNAL + 1] as Candle).open);
    bars[SIGNAL + 3] =
      step > 0 ? bar(b.ts, Number(b.open), Number(b.high), entry.minus(distance).toNumber() - 1, Number(b.close)) : bar(b.ts, Number(b.open), entry.plus(distance).toNumber() + 1, Number(b.low), Number(b.close));
    const trades = runBacktest([instrumentData(bars, { funding })], config(over)).trades;
    return trades[0] as Trade;
  }
  const E = ts(SIGNAL + 1);
  const X = ts(SIGNAL + 3) + HALF_DAY;
  const every8h = (rate: (t: number) => string): FundingRecord[] => {
    const out: FundingRecord[] = [];
    for (let t = E - DAY; t <= X + DAY; t += 8 * HOUR) out.push({ fundingTime: t, fundingRate: rate(t) });
    return out;
  };

  it('charges the settlements in (entry, exit] at the notional of the close of their bar', () => {
    const records = every8h((t) => (t === E + 16 * HOUR ? '-0.0003' : '0.0001'));
    const trade = run(records);
    expect(trade.exitTime).toBe(X);
    const closes = trendCloses(SIGNAL + 5);
    const coin = D(trade.contracts).mul('0.01');
    let expected = D(0);
    let counted = 0;
    for (const r of records) {
      if (r.fundingTime <= E || r.fundingTime > X) continue;
      // The bar with open < time <= close.
      const index = Math.ceil((r.fundingTime - T0) / DAY) - 1;
      expected = expected.minus(D(r.fundingRate).mul(coin).mul(closes[index] as number));
      counted++;
    }
    expect(counted).toBe(7);
    expect(trade.funding).toBe(expected.toFixed(4));
    expect(D(trade.netPnl).toFixed(2)).toBe(D(trade.grossPnl).minus(trade.fees).plus(trade.funding).toFixed(2));
  });

  it('leaves out the settlement at the entry time and the one after the exit, and takes the one at the exit time', () => {
    const at = (t: number): FundingRecord[] => [{ fundingTime: t, fundingRate: '0.0001' }];
    expect(run(at(E)).funding).toBe('0.0000');
    expect(run(at(X + HOUR)).funding).toBe('0.0000');
    expect(D(run(at(E + HOUR)).funding).lt(0)).toBe(true);
    expect(D(run(at(X)).funding).lt(0)).toBe(true);
  });

  it('a long pays a positive rate and receives a negative one; a short the reverse', () => {
    expect(D(run(every8h(() => '0.0001')).funding).lt(0)).toBe(true);
    expect(D(run(every8h(() => '-0.0001')).funding).gt(0)).toBe(true);
    const short = run(
      every8h(() => '0.0001'),
      { params: { ...DEFAULT_TREND_PARAMS, allowShort: true } },
      -0.5,
    );
    expect(short.side).toBe('short');
    expect(D(short.funding).gt(0)).toBe(true);
  });

  it('charges nothing with funding off, and a long in spot pays the spot fee and no funding', () => {
    const records = every8h(() => '0.0001');
    expect(run(records, { funding: false }).funding).toBe('0.0000');
    const spot = run(records, { longVenue: 'spot' });
    expect(spot.funding).toBe('0.0000');
    const coin = D(spot.contracts).mul('0.01');
    expect(spot.fees).toBe(coin.mul(spot.entryPx).mul('0.0015').plus(coin.mul(spot.exitPx).mul('0.0025')).toFixed(4));
  });
});

describe('shorts', () => {
  const bars = trendBars(SIGNAL + 3, 300, -0.5);

  it('are off by default', () => {
    const result = runBacktest([instrumentData(bars)], config());
    expect(result.trades).toHaveLength(0);
    expect(result.signals).toHaveLength(0);
    expect(result.decisions.length).toBeGreaterThan(0);
    expect(result.decisions.every((d) => !d.shortEntry)).toBe(true);
  });

  it('are taken with allowShort, at the short plan and with the stop above the fill', () => {
    const cfg = config({ params: { ...DEFAULT_TREND_PARAMS, allowShort: true } });
    const trade = only(runBacktest([instrumentData(bars)], cfg).trades);
    expect(trade.side).toBe('short');
    expect(D(trade.initialStop).minus(trade.entryPx).eq(stopDistance(bars))).toBe(true);
    const report = buildSignalReport('AAA-USDT-SWAP', bars.slice(0, SIGNAL + 1), null, ts(SIGNAL + 1), instrument(), '100000', cfg.params, phaseSizing(cfg));
    expect(trade.contracts).toBe(report.sizing?.short.contracts);
    expect(D(trade.contracts).lt(report.sizing?.long.contracts ?? 0)).toBe(true);
  });
});

/** Half-day bars rising a quarter each; both cuts break out every day. */
function twoCutData(halfBars: number, mutate: (closes: number[]) => void = () => undefined): { halfDay: Candle[]; daily: Candle[] } {
  const closes = trendCloses(halfBars, 100, 0.25, 0.05);
  mutate(closes);
  const halfDay = barsFromCloses(closes, 100, T0, HALF_DAY);
  return { halfDay, daily: dailyBarsFromHalfDays(halfDay, 0) };
}

describe('the split across cuts', () => {
  const { halfDay, daily } = twoCutData(2 * (SIGNAL + 4));
  const data = [instrumentData(daily, { halfDay })];
  // The daily bars of so smooth a series are all "shocks" against their own tiny sigma; without an open
  // interest history each would count as a crisis day, so the unknown changes are read as calm.
  const calm = { oiMode: 'calm' } as const;

  it('halves the risk and the cap of a unit', () => {
    expect(phaseSizing(config({ phases: [0] }))).toMatchObject({ riskPct: '0.0075', maxNotionalPct: '0.1' });
    expect(phaseSizing(config({ phases: [0, 12] }))).toMatchObject({ riskPct: '0.00375', maxNotionalPct: '0.05' });
  });

  it('gives each cut its own lot at half the size, filled at its own open', () => {
    const one = runBacktest(data, config({ phases: [0], ...calm })).trades[0] as Trade;
    const two = runBacktest(data, config({ phases: [0, 12], ...calm })).trades;
    const first = two.find((t) => t.phase === 0) as Trade;
    const second = two.find((t) => t.phase === 12) as Trade;
    expect(first.entryTime % DAY).toBe(0);
    expect(second.entryTime % DAY).toBe(HALF_DAY);
    // Capped: 10% of equity for the single cut, 5% for each of two.
    expect(Number(one.notional)).toBeGreaterThan(9950);
    expect(Number(one.notional)).toBeLessThanOrEqual(10000);
    for (const t of [first, second]) {
      expect(Number(t.notional)).toBeGreaterThan(4950);
      expect(Number(t.notional)).toBeLessThanOrEqual(5000);
    }
    expect(D(one.contracts).minus(D(first.contracts).mul(2)).abs().lte(1)).toBe(true);
  });

  it('halves the risk when the cap does not bind', () => {
    const wide = { sizing: { ...DEFAULT_SIZING, maxNotionalPct: '5' }, maxGrossPct: '50', ...calm };
    const one = runBacktest(data, config({ phases: [0], ...wide })).trades[0] as Trade;
    const two = runBacktest(data, config({ phases: [0, 12], ...wide })).trades;
    expect(one.flags.capped).toBe(false);
    expect(Number(one.riskQuote)).toBeGreaterThan(745);
    expect(Number(one.riskQuote)).toBeLessThanOrEqual(750);
    for (const t of two.slice(0, 2)) {
      expect(Number(t.riskQuote)).toBeGreaterThan(370);
      // The second lot is sized from the equity at its own close, a little above the start.
      expect(Number(t.riskQuote)).toBeLessThanOrEqual(376);
    }
  });
});

describe("E3 with two cuts: the stop does not wait for the lot's own close", () => {
  const cfg = config({ phases: [0, 12], exitMode: 'close', oiMode: 'calm' });
  const base = twoCutData(2 * (SIGNAL + 6));
  const first = runBacktest([instrumentData(base.daily, { halfDay: base.halfDay })], cfg).trades.find((t) => t.phase === 12) as Trade;
  const E = first.entryTime;

  /** The same data with the 12-hour bar that opens at `at` trading down to one below the 12:00 lot's stop. */
  function run(at: number): { trade: Trade; result: ReturnType<typeof runBacktest> } {
    const halfDay = base.halfDay.map((c) => (c.ts === at ? bar(c.ts, Number(c.open), Number(c.high), Number(first.initialStop) - 1, Number(c.close)) : c));
    const result = runBacktest([instrumentData(dailyBarsFromHalfDays(halfDay, 0), { halfDay })], cfg);
    return { trade: result.trades.find((t) => t.phase === 12) as Trade, result };
  }

  it('a stop hit in the first half of the bar is booked when that 12-hour bar closes', () => {
    expect(E % DAY).toBe(HALF_DAY);
    const { trade, result } = run(E + DAY);
    expect(trade).toMatchObject({ entryTime: E, initialStop: first.initialStop, reason: 'stop', exitPx: first.initialStop, open: false });
    expect(trade.exitTime).toBe(E + DAY + HALF_DAY / 2);
    // At the 00:00 close in the middle of its bar the lot is gone: the sample holds only the lots open then.
    const at = E + DAY + HALF_DAY;
    const sample = result.series.find((s) => s.ts === at);
    expect(sample?.lots).toBe(result.trades.filter((t) => t.entryTime <= at && (t.open || t.exitTime > at)).length);
    // One book: the 00:00 decision is sized from an equity that has the stop loss in it.
    const flat = result.trades.filter((t) => !t.open && t.exitTime <= at);
    const held = result.trades.filter((t) => t.entryTime < at && (t.open || t.exitTime > at));
    expect(flat.length).toBeGreaterThan(0);
    expect(held.every((t) => t.phase === 0)).toBe(true);
    const decision = result.decisions.find((d) => d.closeTs === at);
    const mark = (base.halfDay.find((c) => c.ts + HALF_DAY === at) as Candle).close;
    let expected = D(100000);
    for (const t of flat) expected = expected.plus(t.netPnl);
    for (const t of held) expected = expected.plus(D(mark).minus(t.entryPx).mul(t.contracts).mul('0.01')).minus(D(t.notional).mul('0.001'));
    expect(D(decision?.equity ?? 0).minus(expected).abs().lt('0.02')).toBe(true);
    // E5: the cut is flat and enters again at its own next close.
    expect(result.trades.some((t) => t.phase === 12 && t.entryTime === E + 2 * DAY)).toBe(true);
  });

  it("at its own close only the second half is tested, and filled at the worse of that half's open and the stop", () => {
    const { trade } = run(E + DAY + HALF_DAY);
    expect(trade).toMatchObject({ reason: 'stop', exitPx: first.initialStop });
    expect(trade.exitTime).toBe(E + DAY + HALF_DAY + HALF_DAY / 2);
  });
});

describe('no look-ahead', () => {
  it('decides the same up to bar t whatever comes after it', () => {
    const halves = 2 * (SIGNAL + 30);
    // A jump of 4% inside half-day bar 221, with open interest falling 30% over it: a crisis day at both cuts.
    const jump = (closes: number[]): void => {
      for (let i = 221; i < closes.length; i++) closes[i] = (closes[i] as number) + 6;
    };
    const base = twoCutData(halves, jump);
    const funding: FundingRecord[] = Array.from({ length: (halves * 12) / 8 }, (_, k) => ({ fundingTime: T0 + k * 8 * HOUR, fundingRate: '0.0002' }));
    const oi: OiLevel[] = Array.from({ length: halves + 1 }, (_, i) => ({ ts: T0 + i * HALF_DAY, value: i < 222 ? '1000' : '700' }));
    const cutoff = T0 + 118 * DAY;

    const scale = (c: Candle): Candle => (c.ts < cutoff ? c : { ...c, open: D(c.open).mul(2).toFixed(), high: D(c.high).mul(3).toFixed(), low: D(c.low).div(2).toFixed(), close: D(c.close).mul(2).toFixed() });
    const laterHalf = base.halfDay.map(scale);
    const later = {
      halfDay: laterHalf,
      daily: dailyBarsFromHalfDays(laterHalf, 0),
      funding: funding.map((r) => (r.fundingTime <= cutoff ? r : { ...r, fundingRate: '0.005' })),
      oi: oi.map((l) => (l.ts <= cutoff ? l : { ...l, value: '3000' })),
    };
    const cfg = config({ phases: [0, 12], exitMode: 'trail', trimPct: '0.3' });
    const a = runBacktest([instrumentData(base.daily, { halfDay: base.halfDay, funding, oi })], cfg);
    const b = runBacktest([instrumentData(later.daily, later)], cfg);

    const upTo = <T extends { closeTs: number }>(rows: readonly T[]): T[] => rows.filter((d) => d.closeTs <= cutoff);
    expect(upTo(a.decisions).length).toBeGreaterThan(30);
    expect(upTo(b.decisions)).toEqual(upTo(a.decisions));
    expect(b.signals.filter((s) => s.signalTs + DAY <= cutoff)).toEqual(a.signals.filter((s) => s.signalTs + DAY <= cutoff));
    // The future differs, and so do the decisions taken in it: the comparison above is not vacuous.
    expect(b.decisions).not.toEqual(a.decisions);
    // The open interest history was in play before the cutoff.
    expect(upTo(a.decisions).some((d) => d.regime === 'crisis' && d.oiKnown)).toBe(true);
  });

  it('shows the report only the open interest levels up to the close', () => {
    const window = trendBars(30);
    const close = ts(30);
    const levels = (until: number): OiLevel[] => Array.from({ length: until + 1 }, (_, i) => ({ ts: ts(i), value: String(1000 + 10 * i) }));
    const known = oiInputs(levels(30), window, close, 'history');
    expect(known.known).toBe(true);
    expect(known.oiChanges).toHaveLength(30);
    expect(known.crowding).toBe(D(1300).div(1200).minus(1).toFixed(6));
    // Levels after the close change nothing.
    expect(oiInputs([...levels(30), { ts: ts(31), value: '5' }], window, close, 'history')).toEqual(known);
    // Asked one close earlier, the level at the later close is there but not yet known.
    const earlier = oiInputs(levels(30), window.slice(0, 29), ts(29), 'history');
    expect(earlier.oiChanges).toHaveLength(29);
    expect(earlier.crowding).toBe(D(1290).div(1190).minus(1).toFixed(6));
    // The level at the close is missing: the last bar and the 10-day change are unknown.
    const before = oiInputs(levels(29), window, close, 'history');
    expect(before).toMatchObject({ known: false, crowding: null });
    expect(before.oiChanges).toHaveLength(29);
    expect(oiInputs(levels(29), window, close, 'calm').oiChanges?.[29]).toEqual({ ts: ts(29), change: '0' });
    expect(oiInputs(levels(30), window, close, 'none')).toMatchObject({ oiChanges: null, crowding: null });
    expect(oiInputs(null, window, close, 'history')).toEqual({ oiChanges: null, crowding: null, known: false });
  });
});

describe('E8: portfolio gates', () => {
  const lot = (instId: string, side: 'long' | 'short', notional: number, risk: number): GateLot => ({ instId, side, notional, risk });
  const limits = { maxInstruments: 3, maxGrossPct: '0.5', heatCap: null };

  it('limits the instruments with open lots', () => {
    const open = [lot('A', 'long', 5000, 300), lot('B', 'long', 5000, 300), lot('C', 'long', 5000, 300)];
    expect(blockingGate(open, lot('D', 'long', 5000, 300), 100000, limits)).toBe('max-instruments');
    // A second lot of an instrument already held is not a new instrument.
    expect(blockingGate(open, lot('C', 'long', 5000, 300), 100000, limits)).toBeNull();
  });

  it('limits the marked notional of all lots plus the new one', () => {
    const open = [lot('A', 'long', 45000, 300)];
    expect(blockingGate(open, lot('B', 'long', 5000, 300), 100000, limits)).toBeNull();
    expect(blockingGate(open, lot('B', 'long', 5001, 300), 100000, limits)).toBe('max-gross');
  });

  it('limits the heat when asked to, weighting lots of different instruments on one side by 1.5', () => {
    const heat = { ...limits, heatCap: '0.025' };
    // One instrument: 1000 + 1000 <= 2500.
    expect(blockingGate([lot('A', 'long', 5000, 1000)], lot('A', 'long', 5000, 1000), 100000, heat)).toBeNull();
    // Two instruments on the same side: (1000 + 1000) x 1.5 > 2500.
    expect(blockingGate([lot('A', 'long', 5000, 1000)], lot('B', 'long', 5000, 1000), 100000, heat)).toBe('heat');
    // Opposite sides are not weighted.
    expect(blockingGate([lot('A', 'long', 5000, 1000)], lot('B', 'short', 5000, 1400), 100000, heat)).toBeNull();
    expect(blockingGate([lot('A', 'long', 5000, 1000)], lot('B', 'long', 5000, 1000), 100000, limits)).toBeNull();
  });

  it('records a blocked signal with the rule that blocked it', () => {
    const result = runBacktest([instrumentData(trendBars(SIGNAL + 3))], config({ maxGrossPct: '0.01' }));
    expect(result.trades).toHaveLength(0);
    expect(result.signals[0]).toMatchObject({ outcome: 'blocked', rule: 'max-gross' });
  });

  it('counts the lots already open when a second instrument signals', () => {
    const bars = trendBars(SIGNAL + 3);
    const data = [instrumentData(bars), instrumentData(bars, { inst: instrument('BBB-USDT-SWAP') })];
    const result = runBacktest(data, config({ maxInstruments: 1 }));
    expect(result.trades.map((t) => t.instId)).toEqual(['AAA-USDT-SWAP']);
    expect(result.signals.find((s) => s.instId === 'BBB-USDT-SWAP')).toMatchObject({ outcome: 'blocked', rule: 'max-instruments' });
  });

  it('books the exits of an instant before its gates: the order of the instruments does not matter', () => {
    // A rises, then falls through its exit channel; B rises all along and signals on every second bar.
    const up = trendCloses(SIGNAL + 41);
    const top = up[up.length - 1] as number;
    const a = barsFromCloses([...up, ...Array.from({ length: 20 }, (_, k) => top - 1.5 * (k + 1))], 100);
    const cfg = config({ maxInstruments: 1, exitMode: 'close' });
    const alone = only(runBacktest([instrumentData(a)], cfg).trades);
    expect(alone.reason).toBe('channel');
    // B starts a day or two later, so that A is in first and B's signals fall on A's exit signal bar.
    const exitBar = (alone.exitTime - T0) / DAY - 1;
    const shift = exitBar % 2 === 0 ? 2 : 1;
    const b = instrumentData(trendBars(a.length - shift, 100, 0.5, T0 + shift * DAY), { inst: instrument('BBB-USDT-SWAP') });
    const run = (data: Parameters<typeof runBacktest>[0]): Trade[] => runBacktest(data, cfg).trades;
    const bFirst = run([b, instrumentData(a)]);
    const second = bFirst.find((t) => t.instId === 'BBB-USDT-SWAP') as Trade;
    expect(bFirst.find((t) => t.instId === 'AAA-USDT-SWAP')).toMatchObject({ reason: 'channel', exitTime: alone.exitTime });
    // B is filled at the very open A leaves at.
    expect(second.signalTs).toBe(ts(exitBar));
    expect(second.entryTime).toBe(alone.exitTime);
    expect(run([instrumentData(a), b])).toEqual(bFirst);
  });
});

describe('E9: trim', () => {
  it('sells the share of the excess over the limit, rounded down to the lot size', () => {
    // Instrument at 40,000 with a 30% limit of 100,000: 10,000 over; this lot is half of it.
    expect(trimContracts(20000, 40000, 100000, '0.3', 100, instrument()).toFixed()).toBe('5000');
    expect(trimContracts(20000, 40000, 100000, '0.3', 150, instrument('AAA-USDT-SWAP', { lotSz: '10' })).toFixed()).toBe('3330');
    expect(trimContracts(20000, 30000, 100000, '0.3', 100, instrument()).toFixed()).toBe('0');
    expect(trimContracts(20000, 40000, 100000, '0', 100, instrument()).toFixed()).toBe('0');
  });

  it('trims a lot at its next open and lets it go on with its stop', () => {
    const bars = trendBars(SIGNAL + 6);
    const result = runBacktest([instrumentData(bars)], config({ trimPct: '0.05' }));
    const trade = only(result.trades);
    expect(trade.flags.trimmed).toBe(true);
    expect(trade.open).toBe(true);
    // Entered near 10% of equity; from the first close on it is held at 5%.
    expect(Number(trade.notional)).toBeGreaterThan(9900);
    const after = result.series.filter((s) => s.ts >= ts(SIGNAL + 3));
    expect(after.length).toBeGreaterThan(0);
    for (const s of after) expect(Number(s.gross) / Number(s.equity)).toBeLessThan(0.0505);
    // The trims paid exit costs on top of the entry's.
    expect(D(trade.fees).gt(D(trade.notional).mul('0.001'))).toBe(true);
    expect(runBacktest([instrumentData(bars)], config({ trimPct: '0' })).trades[0]?.flags.trimmed).toBe(false);
  });

  it('sells the trimmed contracts at the next open, not at the close that decided the trim', () => {
    // Entry at the open of SIGNAL + 1; its close decides one trim, sold at the open of SIGNAL + 2, the last bar.
    const bars = trendBars(SIGNAL + 3);
    const close = Number((bars[SIGNAL + 1] as Candle).close);
    const last = bars[SIGNAL + 2] as Candle;
    const nextOpen = close + 0.7;
    bars[SIGNAL + 2] = bar(last.ts, nextOpen, Number(last.high) + 1, Number(last.low), Number(last.close));
    const result = runBacktest([instrumentData(bars)], config({ trimPct: '0.05' }));
    const trade = only(result.trades);
    expect(trade).toMatchObject({ open: true, flags: { trimmed: true } });
    const decision = result.decisions.find((d) => d.closeTs === ts(SIGNAL + 2));
    const notional = D(trade.contracts).mul('0.01').mul(close);
    const cut = trimContracts(notional, notional, decision?.equity ?? 0, '0.05', close, instrument());
    expect(cut.gt(0)).toBe(true);
    const rest = D(trade.contracts).minus(cut);
    // Price P&L: the trimmed contracts at the next open, the rest at the last mark.
    const marked = rest.mul('0.01').mul(D(last.close).minus(trade.entryPx));
    expect(trade.grossPnl).toBe(cut.mul('0.01').mul(D(nextOpen).minus(trade.entryPx)).plus(marked).toFixed(4));
    expect(trade.grossPnl).not.toBe(cut.mul('0.01').mul(D(close).minus(trade.entryPx)).plus(marked).toFixed(4));
    // Costs: the entry's, and fee + slippage on the trim's fill notional at the next open.
    expect(trade.fees).toBe(D(trade.notional).mul('0.001').plus(cut.mul('0.01').mul(nextOpen).mul('0.001')).toFixed(4));
  });
});
