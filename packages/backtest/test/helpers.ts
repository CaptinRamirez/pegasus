import { DEFAULT_SIZING, DEFAULT_TREND_PARAMS, type Candle, type Instrument } from '@pegasus/shared';
import type { EngineConfig, InstrumentData } from '../src/types.js';

export const DAY = 86_400_000;
export const HALF_DAY = DAY / 2;
export const HOUR = 3_600_000;
/** 2022-01-01 00:00 UTC */
export const T0 = Date.UTC(2022, 0, 1);

/** One contract = 0.01 coin, whole contracts. */
export function instrument(instId = 'AAA-USDT-SWAP', over: Partial<Instrument> = {}): Instrument {
  return {
    instId,
    instType: 'SWAP',
    uly: instId.replace(/-SWAP$/, ''),
    baseCcy: instId.split('-')[0] ?? '',
    quoteCcy: 'USDT',
    settleCcy: 'USDT',
    ctVal: '0.01',
    ctValCcy: instId.split('-')[0] ?? '',
    ctMult: '1',
    ctType: 'linear',
    lotSz: '1',
    minSz: '1',
    tickSz: '0.1',
    maxLmtSz: '0',
    maxMktSz: '0',
    maxLever: '100',
    state: 'live',
    ...over,
  };
}

export function bar(ts: number, open: number, high: number, low: number, close: number): Candle {
  return { ts, open: String(open), high: String(high), low: String(low), close: String(close), vol: '1', volCcy: '1', confirm: true };
}

const round = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * Bars from closes: each opens at the previous close and reaches 0.2 beyond its body on both sides.
 * `barMs` apart from `t0`.
 */
export function barsFromCloses(closes: readonly number[], first: number, t0 = T0, barMs = DAY): Candle[] {
  let prev = first;
  return closes.map((close, i) => {
    const open = prev;
    prev = close;
    return bar(t0 + i * barMs, open, round(Math.max(open, close) + 0.2), round(Math.min(open, close) - 0.2), close);
  });
}

/**
 * A steady trend with a wiggle: every second bar (the even ones for a positive step) closes at a new
 * extreme, the others drift back a little. No bar moves by three daily sigmas.
 */
export function trendCloses(n: number, start = 100, step = 0.5, wiggle = 0.3): number[] {
  const sign = step >= 0 ? 1 : -1;
  return Array.from({ length: n }, (_, i) => round(start + step * i + (i % 2 === 0 ? wiggle : -wiggle) * sign));
}

export function trendBars(n: number, start = 100, step = 0.5, t0 = T0, barMs = DAY, wiggle = 0.3): Candle[] {
  return barsFromCloses(trendCloses(n, start, step, wiggle), start, t0, barMs);
}

export function instrumentData(daily: Candle[], over: Partial<InstrumentData> = {}): InstrumentData {
  return { inst: instrument(), daily, halfDay: [], funding: null, oi: null, ...over };
}

/** The framework's defaults on the 00:00 cut alone. */
export function config(over: Partial<EngineConfig> = {}): EngineConfig {
  return {
    phases: [0],
    params: DEFAULT_TREND_PARAMS,
    sizing: DEFAULT_SIZING,
    equity: '100000',
    from: null,
    to: null,
    exitMode: 'trail',
    oiMode: 'history',
    trimPct: '0',
    longVenue: 'perp',
    funding: true,
    costs: { fee: '0.0005', slippage: '0.0005', stopFee: '0.0005', stopSlippage: '0.0015', spotFee: '0.001' },
    maxInstruments: 3,
    maxGrossPct: '0.5',
    heatCap: null,
    ...over,
  };
}
