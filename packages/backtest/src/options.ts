import { parseArgs } from 'node:util';
import { D, DEFAULT_SIZING, DEFAULT_TREND_PARAMS, isDecimalString, SIGNAL_PHASE_HOURS, type SignalPhase } from '@pegasus/shared';
import type { EngineConfig, ExitMode, LongVenue, OiMode } from './types.js';

/** The documented framework (docs/strategy.md): both cuts, the default trend parameters (shorts off), one unit split across the cuts. */
export const DEFAULT_CONFIG: EngineConfig = {
  phases: SIGNAL_PHASE_HOURS,
  params: DEFAULT_TREND_PARAMS,
  sizing: DEFAULT_SIZING,
  equity: '100000',
  from: null,
  to: null,
  exitMode: 'trail',
  oiMode: 'history',
  trimPct: '0.30',
  longVenue: 'perp',
  funding: true,
  costs: { fee: '0.0005', slippage: '0.0005', stopFee: '0.0005', stopSlippage: '0.0015', spotFee: '0.001' },
  maxInstruments: 3,
  maxGrossPct: '0.5',
  heatCap: null,
};

export const DEFAULT_INSTRUMENTS = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'];
/** docs/strategy.md 2.2 */
const DEFAULT_HEAT_CAP = '0.025';

export const HELP = `pnpm backtest [flags]

Runs the live signal code (buildSignalReport) over history: OKX daily candles and open interest,
Binance funding as the proxy. Fractions are fractions: 0.0075 = 0.75%.

  --inst a,b              instruments (default ${DEFAULT_INSTRUMENTS.join(',')})
  --from YYYY-MM-DD       first decision (default: as soon as the indicators have their bars)
  --to YYYY-MM-DD         last close (default: the newest confirmed bar)
  --phases 0,12           daily cuts, UTC hours (default ${SIGNAL_PHASE_HOURS.join(',')})
  --equity n              starting equity (default ${DEFAULT_CONFIG.equity})
  --risk-pct f            risk of one unit, split across the cuts (default ${DEFAULT_SIZING.riskPct})
  --max-notional-pct f    notional cap of one unit, split across the cuts (default ${DEFAULT_SIZING.maxNotionalPct})
  --exit trail|close      trail: the resting stop follows the exit channel; close: the stop stays at
                          the initial stop and only a close beyond the channel exits (default trail)
  --allow-short           take short entries (default off)
  --entry-channel n       breakout channel (default ${DEFAULT_TREND_PARAMS.entryChannel})
  --exit-channel n        exit channel (default ${DEFAULT_TREND_PARAMS.exitChannel})
  --atr-mult f            stop distance in ATRs (default ${DEFAULT_TREND_PARAMS.atrStopMultiple})
  --oi history|none|calm  open interest input: the history; none = every change unknown (the rule
                          before the OI condition); calm = an unknown bar counts as no deleveraging
  --trim-pct f            trim an instrument back to this share of equity, 0 = off (default ${DEFAULT_CONFIG.trimPct})
  --long-venue perp|spot  spot: longs pay no funding and the spot fee (default perp)
  --no-funding            do not charge funding (the funding filter still sees the rates)
  --fee f                 entry and channel-exit fee (default ${DEFAULT_CONFIG.costs.fee})
  --slippage f            entry and channel-exit slippage (default ${DEFAULT_CONFIG.costs.slippage})
  --stop-fee f            stop-exit fee (default ${DEFAULT_CONFIG.costs.stopFee})
  --stop-slippage f       stop-exit slippage (default ${DEFAULT_CONFIG.costs.stopSlippage})
  --spot-fee f            fee of a long held in spot (default ${DEFAULT_CONFIG.costs.spotFee})
  --max-instruments n     most instruments with open lots (default ${DEFAULT_CONFIG.maxInstruments})
  --max-gross-pct f       marked notional of all lots over equity (default ${DEFAULT_CONFIG.maxGrossPct})
  --heat-cap [f]          portfolio heat cap, off by default; without a value ${DEFAULT_HEAT_CAP}
  --refresh               download the history again instead of extending the cache
  --cache dir             cache directory (default packages/backtest/.cache)
  --out dir               where trades.csv, equity.csv and summary.json go (default packages/backtest/out)
  --json                  print the summary object instead of the text
  --sweep spec            grid, e.g. entry=40:80:10,exit=10:30:5,atr=2:4:0.5 (from:to:step); one line per combination
  --live-r file.json      an array of live R values: where their sum falls among 1000 bootstrap sums
  --help
`;

export class UsageError extends Error {}

export interface SweepGrid {
  entry: number[];
  exit: number[];
  atr: string[];
}

export interface CliOptions {
  help: boolean;
  instIds: string[];
  config: EngineConfig;
  refresh: boolean;
  json: boolean;
  /** As typed; resolved by the caller */
  out: string | null;
  cache: string | null;
  liveR: string | null;
  sweep: SweepGrid | null;
}

function fraction(name: string, value: string): string {
  if (!isDecimalString(value) || D(value).lt(0)) throw new UsageError(`--${name} takes a non-negative decimal, got "${value}"`);
  return value;
}

function positiveInt(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} takes a positive whole number, got "${value}"`);
  return n;
}

function utcDate(name: string, value: string): number {
  const ts = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
  if (!Number.isFinite(ts)) throw new UsageError(`--${name} takes a date YYYY-MM-DD, got "${value}"`);
  return ts;
}

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) throw new UsageError(`--${name} takes ${allowed.join(' | ')}, got "${value}"`);
  return value as T;
}

function parsePhases(value: string): SignalPhase[] {
  const phases = value.split(',').map((part) => {
    const hour = Number(part.trim());
    if (!(SIGNAL_PHASE_HOURS as readonly number[]).includes(hour)) throw new UsageError(`--phases takes hours out of ${SIGNAL_PHASE_HOURS.join(', ')}, got "${part}"`);
    return hour as SignalPhase;
  });
  if (phases.length === 0 || new Set(phases).size !== phases.length) throw new UsageError('--phases takes each cut once');
  return phases;
}

/** "40:80:10" -> 40, 50, ... 80; a single value stands for itself. Decimal steps stay exact. */
function range(name: string, value: string): string[] {
  const parts = value.split(':');
  if (parts.some((p) => !isDecimalString(p) || D(p).lte(0)) || (parts.length !== 1 && parts.length !== 3)) throw new UsageError(`--sweep ${name} takes from:to:step or one value, got "${value}"`);
  const [from, to, step] = parts as [string, string | undefined, string | undefined];
  if (to === undefined || step === undefined) return [D(from).toFixed()];
  const out: string[] = [];
  for (let v = D(from); v.lte(to); v = v.plus(step)) out.push(v.toFixed());
  return out;
}

export function parseSweep(spec: string, config: EngineConfig): SweepGrid {
  const grid = { entry: [String(config.params.entryChannel)], exit: [String(config.params.exitChannel)], atr: [config.params.atrStopMultiple] };
  for (const part of spec.split(',')) {
    const [key, value] = part.split('=');
    if ((key !== 'entry' && key !== 'exit' && key !== 'atr') || value === undefined) throw new UsageError(`--sweep takes entry=, exit= and atr= ranges, got "${part}"`);
    grid[key] = range(key, value);
  }
  return { entry: grid.entry.map((v) => positiveInt('sweep entry', v)), exit: grid.exit.map((v) => positiveInt('sweep exit', v)), atr: grid.atr };
}

export function parseCli(argv: readonly string[]): CliOptions {
  // --heat-cap may stand alone: it then takes the framework's 2.5%.
  const args: string[] = [];
  argv.forEach((arg, i) => {
    args.push(arg);
    const next = argv[i + 1];
    if (arg === '--heat-cap' && (next === undefined || next.startsWith('--'))) args.push(DEFAULT_HEAT_CAP);
  });
  const string = { type: 'string' } as const;
  const boolean = { type: 'boolean' } as const;
  let values;
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        inst: string,
        from: string,
        to: string,
        phases: string,
        equity: string,
        'risk-pct': string,
        'max-notional-pct': string,
        exit: string,
        'allow-short': boolean,
        'entry-channel': string,
        'exit-channel': string,
        'atr-mult': string,
        oi: string,
        'trim-pct': string,
        'long-venue': string,
        'no-funding': boolean,
        fee: string,
        slippage: string,
        'stop-fee': string,
        'stop-slippage': string,
        'spot-fee': string,
        'max-instruments': string,
        'max-gross-pct': string,
        'heat-cap': string,
        refresh: boolean,
        cache: string,
        out: string,
        json: boolean,
        sweep: string,
        'live-r': string,
        help: boolean,
      },
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const d = DEFAULT_CONFIG;
  const opt = (name: keyof typeof values, fallback: string): string => {
    const v = values[name];
    return typeof v === 'string' ? fraction(name, v) : fallback;
  };
  const params = {
    ...d.params,
    allowShort: values['allow-short'] === true ? true : d.params.allowShort,
    entryChannel: values['entry-channel'] !== undefined ? positiveInt('entry-channel', values['entry-channel']) : d.params.entryChannel,
    exitChannel: values['exit-channel'] !== undefined ? positiveInt('exit-channel', values['exit-channel']) : d.params.exitChannel,
    atrStopMultiple: opt('atr-mult', d.params.atrStopMultiple),
  };
  if (D(params.atrStopMultiple).lte(0)) throw new UsageError('--atr-mult must be positive');
  const equity = opt('equity', d.equity);
  if (D(equity).lte(0)) throw new UsageError('--equity must be positive');
  const config: EngineConfig = {
    phases: values.phases !== undefined ? parsePhases(values.phases) : d.phases,
    params,
    sizing: { riskPct: opt('risk-pct', d.sizing.riskPct), maxNotionalPct: opt('max-notional-pct', d.sizing.maxNotionalPct), atrStopMultiple: params.atrStopMultiple },
    equity,
    from: values.from !== undefined ? utcDate('from', values.from) : null,
    to: values.to !== undefined ? utcDate('to', values.to) : null,
    exitMode: values.exit !== undefined ? oneOf<ExitMode>('exit', values.exit, ['trail', 'close']) : d.exitMode,
    oiMode: values.oi !== undefined ? oneOf<OiMode>('oi', values.oi, ['history', 'none', 'calm']) : d.oiMode,
    trimPct: opt('trim-pct', d.trimPct),
    longVenue: values['long-venue'] !== undefined ? oneOf<LongVenue>('long-venue', values['long-venue'], ['perp', 'spot']) : d.longVenue,
    funding: values['no-funding'] !== true,
    costs: {
      fee: opt('fee', d.costs.fee),
      slippage: opt('slippage', d.costs.slippage),
      stopFee: opt('stop-fee', d.costs.stopFee),
      stopSlippage: opt('stop-slippage', d.costs.stopSlippage),
      spotFee: opt('spot-fee', d.costs.spotFee),
    },
    maxInstruments: values['max-instruments'] !== undefined ? positiveInt('max-instruments', values['max-instruments']) : d.maxInstruments,
    maxGrossPct: opt('max-gross-pct', d.maxGrossPct),
    heatCap: values['heat-cap'] !== undefined ? fraction('heat-cap', values['heat-cap']) : d.heatCap,
  };
  const instIds = (values.inst ?? DEFAULT_INSTRUMENTS.join(','))
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s !== '');
  if (instIds.length === 0 || new Set(instIds).size !== instIds.length) throw new UsageError('--inst takes each instrument once');
  return {
    help: values.help === true,
    instIds,
    config,
    refresh: values.refresh === true,
    json: values.json === true,
    out: values.out ?? null,
    cache: values.cache ?? null,
    liveR: values['live-r'] ?? null,
    sweep: values.sweep !== undefined ? parseSweep(values.sweep, config) : null,
  };
}
