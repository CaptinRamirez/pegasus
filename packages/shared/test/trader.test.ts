import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.js';
import { checkDecision, DEFAULT_TRADER_GUARDRAILS, recentTradesOf, swingPoints, traderCosts, wakeOf, emaAlignment, emaLast, emaSeries, estimateUsd, inTraderSession, macd, minutesTo, roundLevels, rsi, traderSize, volumeRatio, vwap, type TraderDecision, type TraderPosition } from '../src/trader.js';
import type { Candle, Instrument } from '../src/types.js';

const inst: Instrument = {
  instId: 'BTC-USDT-SWAP',
  instType: 'SWAP',
  uly: 'BTC-USDT',
  baseCcy: 'BTC',
  quoteCcy: 'USDT',
  settleCcy: 'USDT',
  ctVal: '0.01',
  ctValCcy: 'BTC',
  ctMult: '1',
  ctType: 'linear',
  lotSz: '1',
  minSz: '1',
  tickSz: '0.1',
  maxLmtSz: '0',
  maxMktSz: '0',
  maxLever: '100',
  state: 'live',
};

const bar = (ts: number, close: number, vol = 1): Candle => ({ ts, open: String(close), high: String(close + 1), low: String(close - 1), close: String(close), vol: String(vol), volCcy: '0', confirm: true });

const decision = (over: Partial<TraderDecision>): TraderDecision => ({ action: 'flat', entryType: 'market', limitPrice: null, stopPx: null, targetPx: null, confidence: 0.5, reasons: ['r'], invalidation: 'i', oneLiner: 'o', recheckMinutes: 60, wakeAbove: null, wakeBelow: null, ...over });

describe('indicators', () => {
  it('EMA is seeded with the simple average and then smoothed with 2 / (n + 1)', () => {
    const s = emaSeries([1, 2, 3, 4, 5, 6], 3);
    // seed (1+2+3)/3 = 2; then 2 + (4-2)/2 = 3; 3 + (5-3)/2 = 4; 4 + (6-4)/2 = 5
    expect(s.map((v) => v.toFixed())).toEqual(['2', '3', '4', '5']);
    expect(emaLast([1, 2], 3)).toBeNull();
    expect(emaLast([1, 2, 3, 4, 5, 6], 3)?.toFixed()).toBe('5');
  });

  it('RSI is 100 without losses, 0-ish with losses only, and in between otherwise', () => {
    const up = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(rsi(up, 14)?.toFixed()).toBe('100');
    const down = Array.from({ length: 20 }, (_, i) => 100 - i);
    expect(rsi(down, 14)?.toFixed()).toBe('0');
    const mixed = [44, 44.34, 44.09, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46, 46.03, 46.41, 46.22, 45.64];
    const r = rsi(mixed, 14);
    expect(r && r.gt(50) && r.lt(80)).toBe(true);
    expect(rsi([1, 2, 3], 14)).toBeNull();
  });

  it('MACD of a constant series is zero with a zero signal; of a rising series the line is positive', () => {
    const flat = Array.from({ length: 60 }, () => 100);
    expect(macd(flat)?.macd.toFixed()).toBe('0');
    expect(macd(flat)?.hist.toFixed()).toBe('0');
    const rising = Array.from({ length: 60 }, (_, i) => 100 + i);
    const m = macd(rising);
    expect(m && m.macd.gt(0) && m.signal.gt(0)).toBe(true);
    expect(macd(rising.slice(0, 30))).toBeNull();
  });

  it('VWAP weights the typical price by volume; the volume ratio compares the last bar with the 20 before', () => {
    const candles = [bar(0, 100, 1), bar(1, 200, 3)];
    // typical prices 100 and 200, weights 1 and 3
    expect(vwap(candles)?.toFixed()).toBe('175');
    expect(vwap([])).toBeNull();
    const series = [...Array.from({ length: 20 }, (_, i) => bar(i, 100, 2)), bar(20, 100, 6)];
    expect(volumeRatio(series)?.toFixed()).toBe('3');
    expect(volumeRatio(series.slice(1))).toBeNull();
  });

  it('EMA alignment', () => {
    expect(emaAlignment(D(3), D(2), D(1))).toBe('bull');
    expect(emaAlignment(D(1), D(2), D(3))).toBe('bear');
    expect(emaAlignment(D(2), D(3), D(1))).toBe('mixed');
  });

  it('round numbers and the clock', () => {
    expect(roundLevels('82345')).toEqual({ below: '82000', above: '83000' });
    expect(roundLevels('3456.7')).toEqual({ below: '3400', above: '3500' });
    const noon = Date.UTC(2026, 9, 19, 12, 0);
    const us = { sessionStartHour: 13, sessionEndHour: 21 };
    expect(inTraderSession(noon, us)).toBe(false);
    expect(inTraderSession(Date.UTC(2026, 9, 19, 13, 0), us)).toBe(true);
    expect(inTraderSession(Date.UTC(2026, 9, 19, 20, 59), us)).toBe(true);
    expect(inTraderSession(Date.UTC(2026, 9, 19, 21, 0), us)).toBe(false);
    expect(inTraderSession(Date.UTC(2026, 9, 24, 15, 0), us)).toBe(false); // Saturday
    expect(inTraderSession(Date.UTC(2026, 9, 25, 15, 0), us)).toBe(false); // Sunday
    expect(inTraderSession(Date.UTC(2026, 9, 26, 13, 0), us)).toBe(true); // Monday
    // the default: the whole weekday, Asia to America
    expect(inTraderSession(Date.UTC(2026, 9, 26, 0, 0), DEFAULT_TRADER_GUARDRAILS)).toBe(true); // Monday 00:00
    expect(inTraderSession(Date.UTC(2026, 9, 23, 23, 59), DEFAULT_TRADER_GUARDRAILS)).toBe(true); // Friday 23:59
    expect(inTraderSession(Date.UTC(2026, 9, 24, 0, 0), DEFAULT_TRADER_GUARDRAILS)).toBe(false); // Saturday 00:00
    expect(minutesTo(noon, 13, 30)).toBe(90);
    expect(minutesTo(Date.UTC(2026, 9, 19, 14, 0), 13, 30)).toBe(-30);
  });
});

describe('checkDecision', () => {
  const g = DEFAULT_TRADER_GUARDRAILS;
  const held: TraderPosition = { side: 'long', contracts: '3', entryPx: '82000', stopPx: '81700', targetPx: null, openedAt: 0, clOrdId: 'pt1', equityAtEntry: '56' };

  it('accepts a long with the stop below, within the distance limits, and a target at least as far', () => {
    const v = checkDecision(decision({ action: 'long', stopPx: '81700', targetPx: '82500' }), '82000', g, null);
    expect(v).toEqual({ ok: true, action: 'long', entryType: 'market', entryPx: '82000', stopPx: '81700', targetPx: '82500' });
    expect(checkDecision(decision({ action: 'short', stopPx: '82450', targetPx: '81700' }), '82150', g, null)).toMatchObject({ ok: true, action: 'short' });
  });

  it('refuses a stop on the wrong side, a target under one to one, a limit far from the mark, an entry while holding', () => {
    expect(checkDecision(decision({ action: 'long', stopPx: '82100' }), '82000', g, null)).toMatchObject({ ok: false, reason: /wrong side/ });
    // how far the stop goes is the model's call: very near and very far both pass
    expect(checkDecision(decision({ action: 'long', stopPx: '81950' }), '82000', g, null)).toMatchObject({ ok: true, stopPx: '81950' });
    expect(checkDecision(decision({ action: 'long', stopPx: '78000' }), '82000', g, null)).toMatchObject({ ok: true, stopPx: '78000' });
    expect(checkDecision(decision({ action: 'long', stopPx: '81700', targetPx: '82100' }), '82000', g, null)).toMatchObject({ ok: false, reason: /one to one/ });
    expect(checkDecision(decision({ action: 'long', entryType: 'limit', limitPrice: '70000', stopPx: '69500' }), '82000', g, null)).toMatchObject({ ok: false, reason: /from the mark/ });
    expect(checkDecision(decision({ action: 'long', entryType: 'limit', limitPrice: null, stopPx: '81700' }), '82000', g, null)).toMatchObject({ ok: false, reason: /without a price/ });
    expect(checkDecision(decision({ action: 'long', stopPx: null }), '82000', g, null)).toMatchObject({ ok: false, reason: /without a stop/ });
    expect(checkDecision(decision({ action: 'short', stopPx: '82450' }), '82000', g, held)).toMatchObject({ ok: false, reason: /while a long is held/ });
  });

  it('a limit entry is measured from its price', () => {
    const v = checkDecision(decision({ action: 'short', entryType: 'limit', limitPrice: '82150', stopPx: '82450', targetPx: '81700' }), '82000', g, null);
    expect(v).toEqual({ ok: true, action: 'short', entryType: 'limit', entryPx: '82150', stopPx: '82450', targetPx: '81700' });
  });

  it('close and tighten_stop need a position; the new stop must be tighter and on the right side of the mark', () => {
    expect(checkDecision(decision({ action: 'close' }), '82000', g, null)).toMatchObject({ ok: false });
    expect(checkDecision(decision({ action: 'close' }), '82000', g, held)).toEqual({ ok: true, action: 'close' });
    expect(checkDecision(decision({ action: 'tighten_stop', stopPx: '81900' }), '82300', g, held)).toEqual({ ok: true, action: 'tighten_stop', stopPx: '81900' });
    expect(checkDecision(decision({ action: 'tighten_stop', stopPx: '81600' }), '82300', g, held)).toMatchObject({ ok: false, reason: /not tighter/ });
    expect(checkDecision(decision({ action: 'tighten_stop', stopPx: '82400' }), '82300', g, held)).toMatchObject({ ok: false, reason: /not tighter/ });
    expect(checkDecision(decision({ action: 'flat' }), '82000', g, held)).toEqual({ ok: true, action: 'flat' });
  });
});

describe('traderSize', () => {
  it('risks riskPct of the equity at the stop, in whole lots, with the smallest leverage that posts the notional', () => {
    const g = { ...DEFAULT_TRADER_GUARDRAILS, riskPct: '0.02' };
    // equity 56, risk 1.12 USDT, stop 300 away: 0.003733 BTC = 0.37 contracts of 0.01 -> 0 lots
    expect(traderSize({ equity: '56', entryPx: '82000', stopPx: '81700', inst, guardrails: g })).toBeNull();
    // equity 5600: 112 USDT risk / 300 = 0.3733 BTC = 37 contracts; notional 30,340; leverage ceil(30340/5600*1.1) = 6
    const s = traderSize({ equity: '5600', entryPx: '82000', stopPx: '81700', inst, guardrails: g });
    expect(s).toEqual({ contracts: '37', notional: '30340', leverage: '6', riskQuote: '111' });
  });

  it('is capped by maxLeverage of the equity and refuses below the minimum order', () => {
    // a very tight stop would ask for more than 10x: cut to 0.95 x 10 x equity / price contracts
    const s = traderSize({ equity: '5600', entryPx: '82000', stopPx: '81877', inst, guardrails: DEFAULT_TRADER_GUARDRAILS });
    expect(s).not.toBeNull();
    expect(D(s?.notional ?? '0').lte(D('5600').mul(10))).toBe(true);
    expect(s?.leverage).toBe('10');
    expect(traderSize({ equity: '5600', entryPx: '82000', stopPx: '82000', inst, guardrails: DEFAULT_TRADER_GUARDRAILS })).toBeNull();
  });
});

describe('cost estimate', () => {
  it('prices the tokens at the model rates', () => {
    expect(estimateUsd('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }).toFixed()).toBe('4');
    expect(estimateUsd('claude-opus-5-5', { inputTokens: 6000, outputTokens: 2000, cacheReadTokens: 3000 }).toFixed(4)).toBe('0.0646');
  });
});

describe('wakeOf', () => {
  const bar = Date.UTC(2026, 9, 19, 13, 0);
  const M = 60_000;
  it('keeps the recheck within 15 to 480 minutes, on a 15-minute close, with the wake levels that are prices', () => {
    expect(wakeOf(decision({ recheckMinutes: 120, wakeAbove: '82428.5', wakeBelow: '81682' }), bar)).toEqual({ at: bar + 120 * M, above: '82428.5', below: '81682', setAt: bar });
    expect(wakeOf(decision({ recheckMinutes: 5 }), bar).at).toBe(bar + 15 * M);
    expect(wakeOf(decision({ recheckMinutes: 2000 }), bar).at).toBe(bar + 480 * M);
    // 50 minutes is the 15-minute close after it: one hour
    expect(wakeOf(decision({ recheckMinutes: 50 }), bar).at).toBe(bar + 60 * M);
    expect(wakeOf(decision({ recheckMinutes: Number.NaN, wakeAbove: 'soon', wakeBelow: '-3' }), bar)).toEqual({ at: bar + 60 * M, above: null, below: null, setAt: bar });
    expect(wakeOf(null, bar).at).toBe(bar + 60 * M);
  });
});

describe('what the model is shown about costs and its own trades', () => {
  it('prices a round trip in points at the mark', () => {
    expect(traderCosts('83700')).toEqual({ takerFeePct: '0.05', makerFeePct: '0.02', roundTripPoints: '83.7' });
  });

  it('lists its last trades with the stop as a percent of the entry and the minutes held', () => {
    const t0 = Date.UTC(2026, 9, 21, 13, 30);
    const stopped = { side: 'long' as const, openedAt: t0, closedAt: t0 + 15 * 60_000, entryPx: '83700', exitPx: null, contracts: '0.62', pnl: '-1.55', end: 'stop' as const, stopPx: '83520', targetPx: '84050' };
    const old = { side: 'short' as const, openedAt: t0 - 3_600_000, closedAt: t0 - 1_800_000, entryPx: '84000', exitPx: null, contracts: '0.5', pnl: '0.8', end: 'close' as const };
    expect(recentTradesOf([stopped, old])).toEqual([
      { side: 'long', entryPx: '83700', stopPx: '83520', targetPx: '84050', stopPct: '0.215', minutesHeld: 15, end: 'stop', pnl: '-1.55', closedAt: t0 + 15 * 60_000 },
      { side: 'short', entryPx: '84000', stopPx: null, targetPx: null, stopPct: null, minutesHeld: 30, end: 'close', pnl: '0.8', closedAt: t0 - 1_800_000 },
    ]);
    expect(recentTradesOf([stopped, old], 1)).toHaveLength(1);
  });
});

describe('swingPoints', () => {
  it('finds the highs above and the lows below their three neighbours either side, the newest three bars excluded', () => {
    // closes: a hill at bar 5, a valley at bar 10, a hill at bar 14 (inside the last three: not yet a pivot)
    const closes = [100, 101, 102, 103, 104, 110, 104, 103, 102, 101, 95, 101, 102, 103, 112, 103, 102];
    const candles = closes.map((c, i) => bar(i, c));
    expect(swingPoints(candles)).toEqual([
      { ts: 5, kind: 'high', px: '111' },
      { ts: 10, kind: 'low', px: '94' },
    ]);
    expect(swingPoints(candles, 3, 1)).toEqual([{ ts: 10, kind: 'low', px: '94' }]);
    expect(swingPoints(candles.slice(0, 5))).toEqual([]);
  });
});
