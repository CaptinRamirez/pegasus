import { describe, expect, it } from 'vitest';
import { channelStopLevel, dailyCloseAtOrBefore, placeTakeProfitsRequestSchema, placeTrailingStopRequestSchema, setChannelTrailingRequestSchema, sizeTakeProfitLegs, type Candle } from '../src/index.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);
const day = (i: number, high: string, low: string, confirm = true): Candle => ({ ts: T0 + i * DAY, open: low, high, low, close: high, vol: '1', volCcy: '1', confirm });

describe('sizeTakeProfitLegs', () => {
  it('whole: whole lots of the order size, the last leg taking what the others leave', () => {
    expect(sizeTakeProfitLegs(['0.5', '0.5'], '3', '1', 'whole').map((x) => x.toFixed())).toEqual(['1', '2']);
    expect(sizeTakeProfitLegs(['0.3', '0.3', '0.4'], '10', '0.1', 'whole').map((x) => x.toFixed())).toEqual(['3', '3', '4']);
    expect(sizeTakeProfitLegs(['0.33', '0.33', '0.34'], '1', '0.1', 'whole').map((x) => x.toFixed())).toEqual(['0.3', '0.3', '0.4']);
    // fractions that add up to less than 1: the legs still cover the whole order (OKX 51083)
    expect(sizeTakeProfitLegs(['0.25', '0.25'], '8', '1', 'whole').map((x) => x.toFixed())).toEqual(['2', '6']);
    // a leg can round to nothing: the caller refuses it
    expect(sizeTakeProfitLegs(['0.1', '0.9'], '5', '1', 'whole').map((x) => x.toFixed())).toEqual(['0', '5']);
  });

  it('share: the legs cover their fractions of the position only', () => {
    expect(sizeTakeProfitLegs(['0.25', '0.25'], '8', '1', 'share').map((x) => x.toFixed())).toEqual(['2', '2']);
    expect(sizeTakeProfitLegs(['0.5'], '7', '1', 'share').map((x) => x.toFixed())).toEqual(['3']);
    expect(sizeTakeProfitLegs(['0.3', '0.3'], '10', '0.1', 'share').map((x) => x.toFixed())).toEqual(['3', '3']);
  });
});

describe('channelStopLevel', () => {
  const bars = [day(0, '110', '100'), day(1, '115', '104'), day(2, '120', '108'), day(3, '118', '111'), day(4, '119', '113', false)];
  it('is the lowest low (a long) or highest high (a short) of the last n bars that had closed by the close', () => {
    // at the close ending bar 3 (00:00 of day 4) the last three closed bars are 1, 2 and 3
    expect(channelStopLevel(bars, 3, 'long', T0 + 4 * DAY)?.toFixed()).toBe('104');
    expect(channelStopLevel(bars, 3, 'short', T0 + 4 * DAY)?.toFixed()).toBe('120');
    expect(channelStopLevel(bars, 2, 'long', T0 + 4 * DAY)?.toFixed()).toBe('108');
    // a bar that has not closed by then, or is not confirmed, does not count
    expect(channelStopLevel(bars, 2, 'long', T0 + 3 * DAY)?.toFixed()).toBe('104');
    expect(channelStopLevel(bars, 2, 'long', T0 + 5 * DAY)?.toFixed()).toBe('108');
    expect(channelStopLevel(bars, 5, 'long', T0 + 5 * DAY)).toBeNull();
  });

  it('dailyCloseAtOrBefore is the last 00:00 UTC', () => {
    expect(dailyCloseAtOrBefore(T0 + 4 * DAY + 5)).toBe(T0 + 4 * DAY);
    expect(dailyCloseAtOrBefore(T0)).toBe(T0);
  });
});

describe('position exit requests', () => {
  it('take-profits: at most 5 legs whose fractions add up to at most 1', () => {
    const base = { instId: 'BTC-USDT-SWAP', mgnMode: 'cross' };
    expect(placeTakeProfitsRequestSchema.safeParse({ ...base, takeProfits: [{ triggerPx: '70000', fraction: '0.5' }] }).success).toBe(true);
    expect(placeTakeProfitsRequestSchema.safeParse({ ...base, takeProfits: [{ triggerPx: '70000', fraction: '0.6' }, { triggerPx: '71000', fraction: '0.5' }] }).success).toBe(false);
    expect(placeTakeProfitsRequestSchema.safeParse({ ...base, takeProfits: [] }).success).toBe(false);
  });

  it('a trailing stop takes a ratio up to 1; channel trailing 2 to 100 bars', () => {
    const base = { instId: 'BTC-USDT-SWAP', mgnMode: 'isolated', posSide: 'long' };
    expect(placeTrailingStopRequestSchema.safeParse({ ...base, ratio: '0.05', activePx: '70000' }).success).toBe(true);
    expect(placeTrailingStopRequestSchema.safeParse({ ...base, ratio: '1.5' }).success).toBe(false);
    expect(setChannelTrailingRequestSchema.safeParse({ ...base, bars: 10 }).success).toBe(true);
    expect(setChannelTrailingRequestSchema.safeParse({ ...base, bars: 1 }).success).toBe(false);
  });
});
