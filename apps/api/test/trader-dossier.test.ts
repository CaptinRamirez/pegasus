import type { Candle, TraderFrame, TraderLevels } from '@pegasus/shared';
import { describe, expect, it } from 'vitest';
import { detectTriggers, frameOf, levelsOf } from '../src/services/trader-dossier.js';

const H = 3_600_000;
const M15 = 15 * 60_000;
/** 2026-10-19, a Monday, 00:00 UTC */
const T0 = Date.UTC(2026, 9, 19);
const bar = (ts: number, o: number, h: number, l: number, c: number, confirm = true): Candle => ({ ts, open: String(o), high: String(h), low: String(l), close: String(c), vol: '1', volCcy: '0', confirm });

describe('frameOf', () => {
  it('reads confirmed bars only, computes the indicators and shows the bars as rows with their swing points', () => {
    const candles = Array.from({ length: 60 }, (_, i) => bar(T0 + i * M15, 100 + i, 101 + i, 99 + i, 100.5 + i));
    candles.push(bar(T0 + 60 * M15, 160, 161, 159, 160.5, false));
    const f = frameOf('15m', candles);
    expect(f).toMatchObject({ bar: '15m', asOf: T0 + 59 * M15, close: '159.5', alignment: 'bull', ema200: null, rsi14: '100' });
    // 60 confirmed bars, fewer than the 96 shown at most; the forming one is left out
    expect(f?.bars).toHaveLength(60);
    expect(f?.bars[59]).toEqual([T0 + 59 * M15, '159', '160', '158', '159.5', '1']);
    // a straight climb has no pivots
    expect(f?.swings).toEqual([]);
    expect(f?.macd?.histRising).toBeDefined();
    expect(f?.atr14).not.toBeNull();
    expect(frameOf('1H', [])).toBeNull();
    expect(frameOf('1H', [bar(T0, 1, 2, 0, 1, false)])).toBeNull();
  });
});

describe('levelsOf', () => {
  it('takes the day before from the daily bars and the sessions from the 15-minute bars of the UTC day', () => {
    const now = T0 + 14 * H;
    const fifteen: Candle[] = [];
    for (let i = 0; i < 96; i++) fifteen.push(bar(T0 - 24 * H + i * M15, 100, 101, 99, 100));
    for (let i = 0; i < 56; i++) {
      const ts = T0 + i * M15;
      const [h, l] = ts < T0 + 8 * H ? [111, 109] : ts < T0 + 13 * H ? [122, 118] : [133, 127];
      fifteen.push(bar(ts, h - 1, h, l, l + 1));
    }
    const daily = [bar(T0 - 24 * H, 100, 105, 95, 100), bar(T0, 110, 133, 109, 130, false)];
    const lv: TraderLevels = levelsOf(fifteen, daily, now, '131');
    expect(lv).toMatchObject({ prevDayHigh: '105', prevDayLow: '95', prevDayClose: '100', dayOpen: '110', dayHigh: '133', dayLow: '109', asiaHigh: '111', asiaLow: '109', europeHigh: '122', europeLow: '118', roundBelow: '130', roundAbove: '140' });
    expect(lv.vwap).not.toBeNull();
    // without the forming daily bar the day's range comes from the 15-minute bars
    const without = levelsOf(fifteen, daily.slice(0, 1), now, '131');
    expect(without).toMatchObject({ dayOpen: '110', dayHigh: '133', dayLow: '109' });
  });
});

describe('detectTriggers', () => {
  const frame = (close: string, alignment: TraderFrame['alignment']): TraderFrame => ({ bar: '15m', asOf: 0, close, ema5: null, ema10: null, ema21: null, ema50: null, ema200: null, alignment, macd: null, rsi14: null, atr14: null, volumeRatio: null, bars: [], swings: [] });
  const levels: TraderLevels = { prevDayHigh: '105', prevDayLow: '95', prevDayClose: '100', dayOpen: '100', dayHigh: '104', dayLow: '98', asiaHigh: null, asiaLow: null, europeHigh: null, europeLow: null, vwap: '101', roundBelow: '100', roundAbove: '110' };

  it('names a close through a level and a flip of the 15-minute alignment', () => {
    const prev = { frames: [frame('104', 'mixed')], levels };
    const next = { frames: [frame('106', 'bull')], levels };
    expect(detectTriggers(prev, next)).toEqual(['closed above prevDayHigh 105', 'closed above dayHigh 104', '15m EMA alignment mixed -> bull']);
    expect(detectTriggers(null, next)).toEqual([]);
    // a move that crosses nothing (from 103 to 103.5: no level in between) and keeps the alignment is no event
    expect(detectTriggers({ frames: [frame('103', 'mixed')], levels }, { frames: [frame('103.5', 'mixed')], levels })).toEqual([]);
  });
});
