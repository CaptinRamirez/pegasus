import { dailyBarsFromHalfDays, DEFAULT_CAMPAIGN_PARAMS, DEFAULT_POT_PARAMS, type CampaignParams, type Candle } from '@pegasus/shared';
import type { CampaignConfig, CampaignInstrument } from '../src/campaign/types.js';
import { bar, DAY, HALF_DAY, instrument, T0 } from './helpers.js';

/** A 12-hour bar: open, high, low, close. */
export type Row = readonly [number, number, number, number];

/** Channels of 3 and 2 days keep the scenarios short; everything else is the approved rule. */
export const SHORT: CampaignParams = { ...DEFAULT_CAMPAIGN_PARAMS, entryChannel: 3, exitChannel: 2 };
export const NOADD: CampaignParams = { ...SHORT, structure: 'noadd' };

/** The catalogue on the short channels, with the fills and the liquidation of the reference run and without the exchange cap on adds. */
export function config(over: Partial<CampaignConfig> = {}): CampaignConfig {
  return {
    mode: 'catalogue',
    params: SHORT,
    pot: DEFAULT_POT_PARAMS,
    from: null,
    to: null,
    funding: true,
    exchangeCap: false,
    costs: { slippage: { major: '0.0005', other: '0.001' }, exitSlippage: { major: '0.0015', other: '0.0025' }, maintenance: { rates: { BTC: '0.005', ETH: '0.005' }, other: '0.01', plusFee: false } },
    ...over,
  };
}

export const halves = (rows: readonly Row[], t0 = T0): Candle[] => rows.map(([open, high, low, close], i) => bar(t0 + i * HALF_DAY, open, high, low, close));

/** An instrument from its 12-hour bars; the daily bars are the days that have both halves. */
export function data(rows: readonly Row[], over: Partial<CampaignInstrument> = {}): CampaignInstrument {
  const halfDay = halves(rows);
  return { inst: instrument(), halfDay, daily: dailyBarsFromHalfDays(halfDay, 0), funding: null, ...over };
}

export const FLAT_DAY: readonly Row[] = [
  [100, 101, 99, 100],
  [100, 101, 99, 100],
];
/** Closes at 103, above the 101 the flat days reached: the entry signal. */
export const SIGNAL_DAY: readonly Row[] = [
  [100, 100.8, 99.5, 100.5],
  [100.5, 103.5, 100, 103],
];
/** Days 0 to 2 flat, day 3 the signal: its close is at day(4) and the entry at the open of day 4. */
export const SETUP: readonly Row[] = [...FLAT_DAY, ...FLAT_DAY, ...FLAT_DAY, ...SIGNAL_DAY];
export const day = (n: number): number => T0 + n * DAY;
/** A quiet 12 hours at 100: an entry at its open, no add, no liquidation. */
export const QUIET: Row = [100, 100.5, 99.5, 100];
/** A day that closes at 98.5, below the lows of the days before it: the exit signal. */
export const EXIT_DAY: readonly Row[] = [QUIET, [100, 100.2, 98, 98.5]];

const AT_400: Row = [400, 401, 399, 400];
/** The setup, an entry at 100 on day 4, two days at 400, a day that falls to 350 and the exit at the open of day 8, at 350. */
export const RISE_AND_EXIT: readonly Row[] = [...SETUP, QUIET, QUIET, AT_400, AT_400, AT_400, AT_400, [400, 400.5, 349, 350], [350, 351, 349, 350], [350, 351, 349, 350]];
