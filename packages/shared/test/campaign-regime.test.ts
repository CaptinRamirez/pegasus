import { describe, expect, it } from 'vitest';
import {
  atrPct,
  campaignSignals,
  channelTests,
  cooldownUntil,
  D,
  DEFAULT_REGIME_PARAMS,
  fundingMean,
  regimeDecision,
  regimeState,
  regimeVetoes,
  type Candle,
  type FundingRecord,
  type PendingLevel,
  type RegimeParams,
} from '../src/index.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);
const bar = (i: number, open: number, high: number, low: number, close: number, confirm = true): Candle => ({ ts: T0 + i * DAY, open: String(open), high: String(high), low: String(low), close: String(close), vol: '1', volCcy: '1', confirm });
/** `n` flat bars at 100 (high 101, low 99) */
const flat = (n: number, from = 0): Candle[] => Array.from({ length: n }, (_, i) => bar(from + i, 100, 101, 99, 100));
const settle = (t: number, rate: string): FundingRecord => ({ fundingTime: t, fundingRate: rate });

const SHORT: RegimeParams = { ...DEFAULT_REGIME_PARAMS, pendingBars: 3 };
const P = { entryChannel: 3, exitChannel: 2 };

describe('fundingMean', () => {
  const close = T0 + 10 * DAY;
  it('averages the settlements of the 3 days before the close per 8 hours, the one at the close excluded', () => {
    const records = Array.from({ length: 12 }, (_, i) => settle(close - 11 * 8 * HOUR + i * 8 * HOUR, i === 11 ? '1' : '0.0001'));
    // 9 settlements in (close - 72h, close): close - 64h ... close - 8h; the one at the close and the older ones are out
    expect(fundingMean(records, close)?.toFixed()).toBe('0.0001');
  });
  it('scales a shortened period to 8 hours and needs six settlements', () => {
    const base = Array.from({ length: 5 }, (_, i) => settle(close - 64 * HOUR + i * 8 * HOUR, '0.0001'));
    expect(fundingMean(base, close)).toBeNull();
    // A 4-hour settlement at 0.0002 is 0.0004 per 8 hours.
    const records = [...base, settle(close - 24 * HOUR, '0.0001'), settle(close - 20 * HOUR, '0.0002')];
    expect(fundingMean(records, close)?.toFixed()).toBe(D('0.0001').mul(6).plus('0.0004').div(7).toFixed());
  });
  it('skips settlements without a rate and takes 8 hours for the first one known', () => {
    const records = [settle(close - 70 * HOUR, ''), ...Array.from({ length: 6 }, (_, i) => settle(close - 60 * HOUR + i * 8 * HOUR, '0.0002'))];
    expect(fundingMean(records, close)?.toFixed()).toBe('0.0002');
  });
});

describe('atrPct and channelTests', () => {
  it('is the ATR over the last close, null with too few bars', () => {
    expect(atrPct(flat(20))).toBeNull();
    // 21 flat bars: every true range is 2 (high - low), ATR 2, close 100.
    expect(atrPct(flat(21))?.toFixed()).toBe('0.02');
    expect(atrPct([...flat(21), bar(21, 100, 110, 90, 100, false)])?.toFixed()).toBe('0.02');
  });
  it('counts the bars of the channel whose high is within 1% of its top, the top bar included', () => {
    const days = [bar(0, 100, 105, 99, 100), bar(1, 100, 104.2, 99, 100), bar(2, 100, 103, 99, 100), bar(3, 100, 106, 99, 105.9)];
    expect(channelTests(days, 3)).toBe(2);
    expect(channelTests(days, 4)).toBeNull();
  });
});

describe('regimeState, regimeVetoes, cooldownUntil', () => {
  it('is red at the funding or the ATR threshold and green on unknown readings', () => {
    expect(regimeState({ atrPct: '0.0599', funding: '0.00099' })).toBe('GREEN');
    expect(regimeState({ atrPct: '0.06', funding: '0' })).toBe('RED');
    expect(regimeState({ atrPct: '0.01', funding: '0.001' })).toBe('RED');
    expect(regimeState({ atrPct: null, funding: null })).toBe('GREEN');
  });
  it('vetoes hot funding, a wild ATR and a liquidation within the cooldown, in that order', () => {
    const close = T0 + 20 * DAY;
    expect(regimeVetoes({ atrPct: '0.07', funding: '0.002', liquidatedAt: close - 10 * DAY }, close)).toEqual(['veto-funding', 'veto-wild', 'veto-cooldown']);
    expect(regimeVetoes({ atrPct: '0.02', funding: '0.0001', liquidatedAt: close - 10 * DAY - 1 }, close)).toEqual([]);
    expect(regimeVetoes({ atrPct: null, funding: null, liquidatedAt: null }, close)).toEqual([]);
    expect(cooldownUntil(close - 3 * DAY)).toBe(close + 7 * DAY);
    expect(cooldownUntil(null)).toBeNull();
  });
});

describe('regimeDecision', () => {
  /** Signals of a close over flat days whose channel high is 101. */
  const signals = (close: number, high = Math.max(close, 101)) => campaignSignals([...flat(3), bar(3, 100, high, 99, close)], { ...P, leverage: '10', structure: 'pyramid', addStep: '0.05', feeRate: '0.0005' });
  const green = { state: 'GREEN' as const, vetoes: [] as const };

  it('enters a breakout at or above the thin margin and waits on a thinner one, keeping the level', () => {
    const wide = regimeDecision({ signals: signals(102.01), low: 100, pending: null, ...green }, SHORT);
    expect(wide).toMatchObject({ entry: 'breakout', skip: null, pending: null, margin: '0.01' });
    const thin = regimeDecision({ signals: signals(101.5), low: 100, pending: null, ...green }, SHORT);
    expect(thin).toMatchObject({ entry: null, skip: 'thin', pending: { level: '101', setAt: T0 + 3 * DAY, bars: 0 } });
    expect(regimeDecision({ signals: signals(100), low: 99, pending: null, ...green }, SHORT)).toMatchObject({ entry: null, skip: 'no-signal', pending: null, margin: D(100).div(101).minus(1).toFixed() });
  });

  it('takes a thin breakout at once with entry "breakout"', () => {
    expect(regimeDecision({ signals: signals(101.5), low: 100, pending: null, ...green }, { ...SHORT, entry: 'breakout' })).toMatchObject({ entry: 'breakout', pending: null });
  });

  it('C17: the acceptance is the one close after the level was set, a close above the level', () => {
    const pending: PendingLevel = { level: '101', setAt: T0 + 3 * DAY, bars: 0 };
    expect(regimeDecision({ signals: signals(101.2), low: 100.5, pending, ...green }, SHORT)).toMatchObject({ entry: 'acceptance', pending: null });
    // Not above the level: kept for the retest.
    expect(regimeDecision({ signals: signals(100.8), low: 100.5, pending, ...green }, SHORT)).toMatchObject({ entry: null, skip: 'pending-wait', pending: { level: '101', bars: 1 } });
    // Two closes later a close above the level is no acceptance any more, and without a retest low (above 102.01) no entry.
    expect(regimeDecision({ signals: signals(101.2), low: 102.5, pending: { ...pending, bars: 1 }, ...green }, SHORT)).toMatchObject({ entry: null, skip: 'pending-wait', pending: { bars: 2 } });
  });

  it('C18: the retest is a low back within the margin above the level and a close above it; the acceptance close wins', () => {
    const pending: PendingLevel = { level: '101', setAt: T0 + 3 * DAY, bars: 1 };
    expect(regimeDecision({ signals: signals(101.3), low: 102.02, pending, ...green }, SHORT)).toMatchObject({ entry: null, skip: 'pending-wait' });
    expect(regimeDecision({ signals: signals(101.3), low: 102.01, pending, ...green }, SHORT)).toMatchObject({ entry: 'retest', pending: null });
    expect(regimeDecision({ signals: signals(101.3), low: 102, pending: { ...pending, bars: 0 }, ...green }, SHORT)).toMatchObject({ entry: 'acceptance' });
    // With entry 'accept' there is no retest.
    expect(regimeDecision({ signals: signals(101.3), low: 102, pending, ...green }, { ...SHORT, entry: 'accept' })).toMatchObject({ entry: null, skip: 'pending-wait' });
  });

  it('C19: a later thin close does not move the level; the level expires after pendingBars closes', () => {
    const pending: PendingLevel = { level: '101', setAt: T0 + 3 * DAY, bars: 1 };
    // Close 101.5 over a channel high of 101.2: thin again, the level stays 101 and this close is a retest of it.
    const again = regimeDecision({ signals: signals(101.5, 101.2), low: 101.9, pending, ...green }, SHORT);
    expect(again).toMatchObject({ entry: 'retest', pending: null });
    const late = regimeDecision({ signals: signals(100), low: 99, pending: { ...pending, bars: 3 }, ...green }, SHORT);
    expect(late).toMatchObject({ entry: null, skip: 'no-signal', pending: null });
    const kept = regimeDecision({ signals: signals(100), low: 99, pending: { ...pending, bars: 2 }, ...green }, SHORT);
    expect(kept).toMatchObject({ pending: { bars: 3 } });
  });

  it('a red light, then the first veto, keeps an entry from being taken; the crossing becomes the pending level', () => {
    const red = regimeDecision({ signals: signals(103), low: 100, pending: null, state: 'RED', vetoes: [] }, SHORT);
    expect(red).toMatchObject({ entry: null, skip: 'regime-red', pending: { level: '101', setAt: T0 + 3 * DAY, bars: 0 } });
    // Green two closes later with a retest of that level: the entry comes without a new crossing of the (higher) channel.
    const retest = regimeDecision({ signals: signals(101.5, 103.5), low: 101.8, pending: { ...(red.pending as PendingLevel), bars: 1 }, ...green }, SHORT);
    expect(retest).toMatchObject({ entry: 'retest', pending: null });
    const pending: PendingLevel = { level: '101', setAt: T0 + 3 * DAY, bars: 0 };
    const vetoed = regimeDecision({ signals: signals(101.2), low: 100.5, pending, state: 'GREEN', vetoes: ['veto-wild', 'veto-cooldown'] }, SHORT);
    expect(vetoed).toMatchObject({ entry: null, skip: 'veto-wild', pending: { level: '101', bars: 1 } });
  });
});
