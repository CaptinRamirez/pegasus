import type { CandleBar } from './types.js';

export const BAR_MS: Record<CandleBar, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1H': 3_600_000,
  '2H': 7_200_000,
  '4H': 14_400_000,
  '6H': 21_600_000,
  '12H': 43_200_000,
  '1D': 86_400_000,
  '1W': 604_800_000,
};

/** Start of the UTC day containing `ts`. */
export function utcDayStart(ts: number): number {
  return ts - (ts % 86_400_000);
}

/** Floor a timestamp to the start of its candle bucket. */
export function floorToBar(ts: number, bar: CandleBar): number {
  const ms = BAR_MS[bar];
  return ts - (ts % ms);
}
