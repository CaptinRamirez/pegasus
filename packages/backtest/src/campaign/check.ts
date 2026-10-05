import { CAMPAIGN_MAJORS, D, DEFAULT_POT_PARAMS, isDecimalString, type CampaignStructure, type Candle } from '@pegasus/shared';
import { DEFAULT_CAMPAIGN_COSTS } from './options.js';
import { multipleStats, statsOfMultiples, type MultipleStats } from './report.js';
import type { CampaignConfig, CampaignRecord, CampaignResult, MaintenanceRates, Tiered } from './types.js';

/**
 * The reference check: a catalogue replay compared with a run of the research engine the rule was
 * ported from. The reference file (packages/backtest/reference/) says what that run was (the rule,
 * the costs, the end of its data and the daily bars it had before the exchange's history begins)
 * and lists its campaigns. The same run can be replayed under the exchange's limits, which the
 * research engine did not have: its totals are then shown next to the reference's.
 */

/** Relative difference of a multiple the check accepts: decimal against binary arithmetic, nothing more. */
export const MULTIPLE_TOLERANCE = 1e-6;

/** One campaign of the reference run. */
export interface ReferenceRow {
  /** Base coin */
  asset: string;
  /** UTC date of the entry bar */
  entry: string;
  /** UTC date of the 12-hour bar the campaign ended in */
  end: string;
  /** Multiple of the stake as the run published it, 4 decimals */
  mult: number;
  liquidated: boolean;
  adds: number;
  /** Highest close equity over the stake as published, 3 decimals */
  peak: number;
  /** The same two before rounding */
  multExact: number;
  peakExact: number;
}

/** The totals of a reference run, in the research engine's names. */
export interface ReferenceTotals {
  n: number;
  lost: number;
  lose: number;
  median: number;
  mean: number;
  meanEx1: number;
  meanEx2: number;
  p2: number;
  p5: number;
  p20: number;
  p100: number;
  max: number;
}

export interface CampaignReference {
  note: string;
  /** Base coin -> instrument, in the order of the run */
  instruments: Record<string, string>;
  /** Close of the last bar of the run, epoch ms */
  sampleEnd: number;
  /** The structure as the research engine names it: leverage, add (1 = the entry quantity per step), step, exit channel */
  params: { L: number; add: number; step: number; ex: string };
  /** Entry rule, 'BO' + the days of the channel */
  entry: string;
  fee: string;
  majors: string[];
  slippage: Tiered;
  exitSlippage: Tiered;
  maintenance: Tiered;
  /** Per instrument: [open time, open, high, low, close] of the daily bars before the first one of the exchange's history */
  warmup: Record<string, Array<[number, string, string, string, string]>>;
  campaigns: ReferenceRow[];
  /** Totals of the same rule without adds */
  noadd: ReferenceTotals;
}

const TOTAL_KEYS = ['n', 'lost', 'lose', 'median', 'mean', 'meanEx1', 'meanEx2', 'p2', 'p5', 'p20', 'p100', 'max'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isTiered = (v: unknown): v is Tiered => isRecord(v) && isDecimalString(v['major']) && isDecimalString(v['other']);
const hasNumbers = (v: unknown, keys: readonly string[]): v is Record<string, unknown> => isRecord(v) && keys.every((k) => typeof v[k] === 'number' && Number.isFinite(v[k]));
const isParams = (v: unknown): boolean => hasNumbers(v, ['L', 'add', 'step']) && isString(v['ex']) && /^EX\d+$/.test(v['ex']);
const isWarmupBar = (v: unknown): boolean => Array.isArray(v) && v.length === 5 && typeof v[0] === 'number' && v.slice(1).every(isDecimalString);
const isRow = (v: unknown): boolean =>
  hasNumbers(v, ['mult', 'adds', 'peak', 'multExact', 'peakExact']) && isString(v['asset']) && isString(v['entry']) && isString(v['end']) && typeof v['liquidated'] === 'boolean';

/** Reads a reference file's content; throws with what is wrong with it. */
export function parseReference(value: unknown): CampaignReference {
  const fail = (what: string): never => {
    throw new Error(`not a campaign reference: ${what}`);
  };
  if (!isRecord(value)) return fail('an object is expected');
  const { params, instruments, majors, warmup, campaigns } = value;
  if (!isParams(params)) return fail('params must hold L, add, step and ex ("EX" + days)');
  if ((params as CampaignReference['params']).add !== 1) return fail('params.add must be 1: the campaigns listed are those of the pyramid');
  if (!isString(value['entry']) || !/^BO\d+$/.test(value['entry'])) return fail('entry must be "BO" + days');
  if (!isRecord(instruments) || !Object.values(instruments).every(isString)) return fail('instruments must map base coins to instruments');
  if (typeof value['sampleEnd'] !== 'number' || !isDecimalString(value['fee'])) return fail('sampleEnd and fee are missing');
  if (!Array.isArray(majors) || !majors.every(isString)) return fail('majors must list base coins');
  if (!isTiered(value['slippage']) || !isTiered(value['exitSlippage']) || !isTiered(value['maintenance'])) return fail('slippage, exitSlippage and maintenance must each hold major and other');
  if (!isRecord(warmup) || !Object.values(warmup).every((bars) => Array.isArray(bars) && bars.every(isWarmupBar))) return fail('warmup must hold [time, open, high, low, close] rows per instrument');
  if (!Array.isArray(campaigns) || campaigns.length === 0 || !campaigns.every(isRow)) return fail('campaigns must list asset, entry, end, mult, liquidated, adds, peak, multExact and peakExact');
  if (!hasNumbers(value['noadd'], TOTAL_KEYS)) return fail(`noadd must hold ${TOTAL_KEYS.join(', ')}`);
  return value as unknown as CampaignReference;
}

/**
 * What the reference run replayed, as a config of the campaign engine. With `exchangeLimits` the same
 * run under the exchange's limits instead of the reference's own: adds cut to maxLever x margin and
 * liquidation at the first maintenance tier plus the fee.
 */
export function referenceConfig(ref: CampaignReference, structure: CampaignStructure, exchangeLimits = false): CampaignConfig {
  if (ref.majors.length !== CAMPAIGN_MAJORS.length || !ref.majors.every((coin) => CAMPAIGN_MAJORS.includes(coin))) {
    throw new Error(`the reference counts ${ref.majors.join(', ')} as majors, the rule ${CAMPAIGN_MAJORS.join(', ')}`);
  }
  const maintenance: MaintenanceRates = exchangeLimits
    ? DEFAULT_CAMPAIGN_COSTS.maintenance
    : { rates: Object.fromEntries(ref.majors.map((coin) => [coin, ref.maintenance.major])), other: ref.maintenance.other, plusFee: false };
  return {
    mode: 'catalogue',
    params: {
      entryChannel: Number(ref.entry.slice(2)),
      exitChannel: Number(ref.params.ex.slice(2)),
      leverage: D(ref.params.L).toFixed(),
      structure,
      addStep: D(ref.params.step).toFixed(),
      feeRate: ref.fee,
    },
    // The catalogue has no pot: these are not used.
    pot: DEFAULT_POT_PARAMS,
    from: null,
    to: ref.sampleEnd,
    funding: true,
    exchangeCap: exchangeLimits,
    costs: { slippage: ref.slippage, exitSlippage: ref.exitSlippage, maintenance },
  };
}

/** The daily bars the reference run had before the first daily bar of `instId`. */
export function referenceWarmup(ref: CampaignReference, instId: string): Candle[] {
  return (ref.warmup[instId] ?? []).map(([ts, open, high, low, close]) => ({ ts, open, high, low, close, vol: '0', volCcy: '0', confirm: true }));
}

export interface CheckOutcome {
  ok: boolean;
  /** What was compared and every difference found */
  lines: string[];
}

const isoDate = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
/** Relative difference; a zero is only equal to a zero. */
const relative = (mine: number, theirs: number): number => (theirs === 0 ? (mine === 0 ? 0 : Number.POSITIVE_INFINITY) : Math.abs(mine - theirs) / Math.abs(theirs));
/** Whether `mine` rounds to the published `theirs` at `decimals`, give or take the tolerance at the rounding edge. */
const roundsTo = (mine: number, theirs: number, decimals: number): boolean => Math.abs(mine - theirs) <= 0.5 * 10 ** -decimals + MULTIPLE_TOLERANCE * Math.abs(theirs);

/** The pyramid: every campaign of the reference against the replay's, by instrument and entry date. */
function checkRows(result: CampaignResult, ref: CampaignReference): CheckOutcome {
  const assetOf = new Map(Object.entries(ref.instruments).map(([asset, instId]) => [instId, asset]));
  const mine = new Map<string, CampaignRecord>();
  for (const c of result.campaigns) mine.set(`${assetOf.get(c.instId) ?? c.instId} ${isoDate(c.entryTime)}`, c);
  const rows = ref.campaigns.filter((r) => result.instIds.includes(ref.instruments[r.asset] ?? ''));
  const problems: string[] = [];
  const seen = new Set<string>();
  let matched = 0;
  let worst = 0;
  let worstKey = '';
  for (const r of rows) {
    const key = `${r.asset} ${r.entry}`;
    seen.add(key);
    const c = mine.get(key);
    if (!c) {
      problems.push(`${key}: in the reference (ends ${r.end}, ${r.liquidated ? 'liquidated' : `${r.mult}x`}, ${r.adds} adds), not in the replay`);
      continue;
    }
    const multiple = Number(c.multiple);
    const peak = Number(c.peak);
    const differences: string[] = [];
    if (isoDate(c.endTime) !== r.end) differences.push(`ends ${isoDate(c.endTime)}, reference ${r.end}`);
    if ((c.end === 'liquidated') !== r.liquidated) differences.push(`${c.end}, reference ${r.liquidated ? 'liquidated' : 'not liquidated'}`);
    if (c.adds !== r.adds) differences.push(`${c.adds} adds, reference ${r.adds}`);
    const off = relative(multiple, r.multExact);
    if (off > MULTIPLE_TOLERANCE || !roundsTo(multiple, r.mult, 4)) differences.push(`multiple ${c.multiple}, reference ${r.multExact} (published ${r.mult})`);
    if (relative(peak, r.peakExact) > MULTIPLE_TOLERANCE || !roundsTo(peak, r.peak, 3)) differences.push(`peak ${c.peak}, reference ${r.peakExact} (published ${r.peak})`);
    if (differences.length > 0) {
      problems.push(`${key}: ${differences.join('; ')}`);
      continue;
    }
    matched++;
    if (off > worst) {
      worst = off;
      worstKey = key;
    }
  }
  for (const [key, c] of mine) {
    if (!seen.has(key)) problems.push(`${key}: in the replay (ends ${isoDate(c.endTime)}, ${c.end}, ${c.multiple}x), not in the reference`);
  }
  const lines = [
    `check: ${rows.length} of the ${ref.campaigns.length} reference campaigns are on the instruments replayed; ` +
      `compared by instrument and entry date: end date, liquidated, adds, multiple and peak (within ${MULTIPLE_TOLERANCE} relative)`,
    `check: ${matched} of ${rows.length} match; largest difference of a matched multiple ${worst.toExponential(1)}${worstKey === '' ? '' : ` (${worstKey})`}`,
    ...problems.map((p) => `check: DIFFERS ${p}`),
  ];
  const ok = problems.length === 0 && rows.length > 0;
  lines.push(ok ? 'check: PASS' : `check: FAIL (${problems.length} ${problems.length === 1 ? 'difference' : 'differences'})`);
  return { ok, lines };
}

/** Without adds the reference publishes totals only: they are compared with the replay's. */
function checkTotals(result: CampaignResult, ref: CampaignReference): CheckOutcome {
  const all = Object.values(ref.instruments);
  if (all.length !== result.instIds.length || !all.every((instId) => result.instIds.includes(instId))) {
    return { ok: false, lines: ['check: FAIL (the reference without adds is a total over all its instruments: replay all of them)'] };
  }
  const stats: MultipleStats = multipleStats(result.campaigns);
  const pairs: Array<[string, number | null, number]> = [
    ['campaigns', stats.count, ref.noadd.n],
    ['lost entirely', stats.lost, ref.noadd.lost],
    ['below the stake', stats.belowStake, ref.noadd.lose],
    ['median', stats.median, ref.noadd.median],
    ['mean', stats.mean, ref.noadd.mean],
    ['mean without the top one', stats.meanWithoutTop1, ref.noadd.meanEx1],
    ['mean without the top two', stats.meanWithoutTop2, ref.noadd.meanEx2],
    ['share >= 2x', stats.atLeast2, ref.noadd.p2],
    ['share >= 5x', stats.atLeast5, ref.noadd.p5],
    ['share >= 20x', stats.atLeast20, ref.noadd.p20],
    ['share >= 100x', stats.atLeast100, ref.noadd.p100],
    ['largest multiple', stats.max, ref.noadd.max],
  ];
  const lines = [`check: the totals of the replay without adds against the reference's (within ${MULTIPLE_TOLERANCE} relative)`];
  let problems = 0;
  for (const [label, mine, theirs] of pairs) {
    const same = mine !== null && relative(mine, theirs) <= MULTIPLE_TOLERANCE;
    if (!same) problems++;
    lines.push(`check: ${same ? 'same   ' : 'DIFFERS'} ${label}: ${mine ?? 'n/a'}, reference ${theirs}`);
  }
  lines.push(problems === 0 ? 'check: PASS' : `check: FAIL (${problems} ${problems === 1 ? 'difference' : 'differences'})`);
  return { ok: problems === 0, lines };
}

/** Compares a catalogue replay run with referenceConfig(ref, structure) and the warm-up bars of `ref`. */
export function checkCampaigns(result: CampaignResult, ref: CampaignReference, structure: CampaignStructure): CheckOutcome {
  return structure === 'pyramid' ? checkRows(result, ref) : checkTotals(result, ref);
}

/** The totals of a reference run in the replay's own terms. */
const asStats = (t: ReferenceTotals): MultipleStats => ({
  count: t.n,
  lost: t.lost,
  belowStake: t.lose,
  median: t.median,
  mean: t.mean,
  meanWithoutTop1: t.meanEx1,
  meanWithoutTop2: t.meanEx2,
  atLeast2: t.p2,
  atLeast5: t.p5,
  atLeast20: t.p20,
  atLeast100: t.p100,
  max: t.max,
});

const percent = (v: number, digits: number): string => `${(v * 100).toFixed(digits)}%`;
const times = (v: number | null): string => (v === null ? 'n/a' : `${v >= 100 ? v.toFixed(0) : v.toFixed(2)}x`);

/**
 * The totals of the reference run next to those of its replay under the exchange's limits
 * (referenceConfig with exchangeLimits). The two are meant to differ: there is no pass or fail.
 */
export function compareWithReference(result: CampaignResult, ref: CampaignReference, structure: CampaignStructure): CheckOutcome {
  const all = Object.values(ref.instruments);
  const whole = all.length === result.instIds.length && all.every((instId) => result.instIds.includes(instId));
  if (structure === 'noadd' && !whole) return { ok: false, lines: ['compare: the reference without adds is a total over all its instruments: replay all of them'] };
  const rows = ref.campaigns.filter((r) => result.instIds.includes(ref.instruments[r.asset] ?? ''));
  const theirs = structure === 'pyramid' ? statsOfMultiples(rows.map((r) => r.multExact)) : asStats(ref.noadd);
  const mine = multipleStats(result.campaigns);
  const table: Array<[string, string, string]> = [
    ['campaigns', String(theirs.count), String(mine.count)],
    ['lost entirely', percent(theirs.lost, 1), percent(mine.lost, 1)],
    ['mean', times(theirs.mean), times(mine.mean)],
    ['mean without the top two', times(theirs.meanWithoutTop2), times(mine.meanWithoutTop2)],
    ['>= 5x', percent(theirs.atLeast5, 2), percent(mine.atLeast5, 2)],
    ['>= 20x', percent(theirs.atLeast20, 2), percent(mine.atLeast20, 2)],
    ['>= 100x', percent(theirs.atLeast100, 2), percent(mine.atLeast100, 2)],
    ['largest', times(theirs.max), times(mine.max)],
  ];
  const top = [...result.campaigns]
    .sort((a, b) => Number(b.multiple) - Number(a.multiple))
    .slice(0, 5)
    .map((c) => `${c.instId} ${isoDate(c.entryTime)} > ${isoDate(c.endTime)} ${times(Number(c.multiple))} (peak ${times(Number(c.peak))}, ${c.adds} adds)`);
  const lines = [
    `compare: the reference run${structure === 'noadd' ? ' without adds' : ''} and its replay under the exchange's limits ` +
      '(adds cut to maxLever x margin, liquidation at the first maintenance tier plus the fee)' +
      (whole ? '' : `, on ${result.instIds.length} of its ${all.length} instruments`),
    `compare: ${''.padEnd(26)}${'reference'.padStart(10)}${'with the limits'.padStart(17)}`,
    ...table.map(([label, a, b]) => `compare: ${label.padEnd(26)}${a.padStart(10)}${b.padStart(17)}`),
    `compare: largest with the limits: ${top.join('; ') || 'none'}`,
  ];
  return { ok: true, lines };
}
