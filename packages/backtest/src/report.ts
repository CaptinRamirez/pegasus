import type { BacktestResult, EngineConfig, Trade } from './types.js';
import { phaseLabel } from './engine.js';
import { bootstrapPercentile, regress, returnsOf, rStats, seriesStats, mean, type BootstrapResult, type Regression, type RStats, type SeriesStats } from './stats.js';

/**
 * The summary of a run. The statistics are numbers (see stats.ts); the benchmark is a statistic too,
 * built from the 1Dutc closes the engine marked the instruments at.
 */

export interface Summary {
  run: {
    instruments: string[];
    phases: number[];
    /** First and last equity sample, ISO dates; '' when nothing was sampled */
    from: string;
    to: string;
    startEquity: string;
    endEquity: string;
    entryChannel: number;
    exitChannel: number;
    atrStopMultiple: string;
    allowShort: boolean;
    /** One cut's lot */
    riskPct: string;
    maxNotionalPct: string;
    exitMode: string;
    oiMode: string;
    trimPct: string;
    longVenue: string;
    funding: boolean;
  };
  signals: {
    entries: number;
    filled: number;
    /** By rule: min-size, no-equity */
    skipped: Record<string, number>;
    /** By gate */
    blocked: Record<string, number>;
    noNextBar: number;
  };
  trades: { closed: number; open: number; trimmed: number; exits: Record<string, number> };
  r: {
    overall: RStats;
    bySide: Record<string, RStats>;
    byInstrument: Record<string, RStats>;
    byCut: Record<string, RStats>;
    /** By the year of the entry */
    byYear: Record<string, RStats>;
  };
  portfolio: {
    withFunding: SeriesStats;
    /** The same trades with the funding added back */
    withoutFunding: SeriesStats;
    /** Funding paid over the run, quote currency (negative = received) */
    fundingPaid: string;
    /** Marked notional over equity */
    avgGross: number;
    maxGross: number;
    /** Share of days with an open lot */
    timeInMarket: number;
  };
  benchmark: {
    /** Instruments with a price at the first sample; the others are left out */
    instruments: string[];
    buyAndHold: SeriesStats;
    /** avgGross of the money in the basket, the rest in cash, rebalanced daily: the basket at the strategy's exposure */
    atAvgExposure: SeriesStats;
    /** Strategy daily returns on the basket's */
    regression: Regression | null;
  } | null;
  oiCoverage: { bars: number; known: number; share: number; entrySignals: number; entrySignalsKnown: number };
  notes: string[];
  liveR?: BootstrapResult;
}

const isoDate = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

function count<T>(items: readonly T[], keyOf: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[keyOf(item)] = (out[keyOf(item)] ?? 0) + 1;
  return out;
}

function groupR(trades: readonly Trade[], keyOf: (t: Trade) => string): Record<string, RStats> {
  const groups = new Map<string, number[]>();
  for (const t of trades) {
    const key = keyOf(t);
    const list = groups.get(key);
    if (list) list.push(Number(t.r));
    else groups.set(key, [Number(t.r)]);
  }
  return Object.fromEntries([...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([key, rs]) => [key, rStats(rs)]));
}

/** R of the closed trades, in entry order. */
export function closedR(result: BacktestResult): number[] {
  return result.trades.filter((t) => !t.open).map((t) => Number(t.r));
}

export function buildSummary(result: BacktestResult, config: EngineConfig, notes: readonly string[] = [], liveR: readonly number[] | null = null): Summary {
  const closed = result.trades.filter((t) => !t.open);
  const { series } = result;
  const first = series[0];
  const last = series[series.length - 1];
  const equity = series.map((s) => Number(s.equity));
  const exposure = series.map((s) => (Number(s.equity) > 0 ? Number(s.gross) / Number(s.equity) : 0));
  const avgGross = mean(exposure);

  // Equal-weight buy-and-hold: one unit of money split at the first sample between the instruments that have a price then.
  let benchmark: Summary['benchmark'] = null;
  if (first) {
    const held = result.instIds.map((id, k) => ({ id, k })).filter(({ k }) => first.marks[k] !== undefined && first.marks[k] !== '');
    if (held.length > 0) {
      const basket = series.map((s) => mean(held.map(({ k }) => Number(s.marks[k]) / Number(first.marks[k]))));
      // Held at a constant share: left alone, a basket that multiplies would soon be far above the strategy's exposure.
      const scaled = [1];
      for (const r of returnsOf(basket)) scaled.push((scaled[scaled.length - 1] as number) * (1 + avgGross * r));
      benchmark = {
        instruments: held.map((h) => h.id),
        buyAndHold: seriesStats(basket),
        atAvgExposure: seriesStats(scaled),
        regression: regress(returnsOf(equity), returnsOf(basket)),
      };
    }
  }

  const entrySignals = result.decisions.filter((d) => d.longEntry || d.shortEntry);
  const known = result.decisions.filter((d) => d.oiKnown).length;
  const fundingPaid = last ? (Number(last.equityNoFunding) - Number(last.equity)).toFixed(2) : '0.00';
  const summary: Summary = {
    run: {
      instruments: result.instIds,
      phases: [...config.phases],
      from: first ? isoDate(first.ts) : '',
      to: last ? isoDate(last.ts) : '',
      startEquity: config.equity,
      endEquity: last?.equity ?? config.equity,
      entryChannel: config.params.entryChannel,
      exitChannel: config.params.exitChannel,
      atrStopMultiple: config.params.atrStopMultiple,
      allowShort: config.params.allowShort,
      riskPct: result.sizing.riskPct,
      maxNotionalPct: result.sizing.maxNotionalPct,
      exitMode: config.exitMode,
      oiMode: config.oiMode,
      trimPct: config.trimPct,
      longVenue: config.longVenue,
      funding: config.funding,
    },
    signals: {
      entries: result.signals.length,
      filled: result.signals.filter((s) => s.outcome === 'filled').length,
      skipped: count(
        result.signals.filter((s) => s.outcome === 'skipped'),
        (s) => s.rule ?? 'unknown',
      ),
      blocked: count(
        result.signals.filter((s) => s.outcome === 'blocked'),
        (s) => s.rule ?? 'unknown',
      ),
      noNextBar: result.signals.filter((s) => s.outcome === 'no-next-bar').length,
    },
    trades: { closed: closed.length, open: result.trades.length - closed.length, trimmed: result.trades.filter((t) => t.flags.trimmed).length, exits: count(closed, (t) => t.reason) },
    r: {
      overall: rStats(closed.map((t) => Number(t.r))),
      bySide: groupR(closed, (t) => t.side),
      byInstrument: groupR(closed, (t) => t.instId),
      byCut: groupR(closed, (t) => phaseLabel(t.phase)),
      byYear: groupR(closed, (t) => String(new Date(t.entryTime).getUTCFullYear())),
    },
    portfolio: {
      withFunding: seriesStats(equity),
      withoutFunding: seriesStats(series.map((s) => Number(s.equityNoFunding))),
      fundingPaid,
      avgGross,
      maxGross: exposure.reduce((a, b) => Math.max(a, b), 0),
      timeInMarket: series.length === 0 ? 0 : series.filter((s) => s.lots > 0).length / series.length,
    },
    benchmark,
    oiCoverage: {
      bars: result.decisions.length,
      known,
      share: result.decisions.length === 0 ? 0 : known / result.decisions.length,
      entrySignals: entrySignals.length,
      entrySignalsKnown: entrySignals.filter((d) => d.oiKnown).length,
    },
    notes: [...notes],
  };
  if (liveR !== null) {
    const boot = bootstrapPercentile(closedR(result), liveR);
    if (boot) summary.liveR = boot;
  }
  return summary;
}

// ---- console ----

const pct = (v: number, digits = 1): string => `${(v * 100).toFixed(digits)}%`;
const num = (v: number | null, digits = 2): string => (v === null ? 'n/a' : v.toFixed(digits));
const signed = (v: number, digits = 2): string => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;

function rLine(label: string, s: RStats): string {
  return (
    `${label.padEnd(15)} n ${String(s.count).padStart(4)}  win ${pct(s.winRate, 0).padStart(4)}  mean ${signed(s.mean).padStart(6)}R  median ${signed(s.median).padStart(6)}R  ` +
    `PF ${num(s.profitFactor).padStart(5)}  total ${signed(s.total, 1).padStart(7)}R  t ${num(s.tStat).padStart(5)}  top2 ${s.largest.map((v) => signed(v, 1)).join(' ') || '-'}  ` +
    `without ${signed(s.totalWithoutLargest, 1)}R  <-1.5R ${s.lossesBeyond1_5R}`
  );
}

function seriesLine(label: string, s: SeriesStats): string {
  return `${label.padEnd(26)} CAGR ${pct(s.cagr).padStart(7)}  vol ${pct(s.vol).padStart(6)}  Sharpe ${num(s.sharpe).padStart(5)}  maxDD ${pct(s.maxDrawdown).padStart(6)}  MAR ${num(s.mar).padStart(5)}  total ${pct(s.totalReturn)}`;
}

/** The compact console summary. */
export function formatSummary(s: Summary): string {
  const lines: string[] = [];
  const { run } = s;
  lines.push(`Backtest ${run.instruments.join(', ')}  ${run.from} to ${run.to}  cuts ${run.phases.map((p) => `${String(p).padStart(2, '0')}:00`).join(' + ')} UTC`);
  lines.push(
    `rule ${run.entryChannel}/${run.exitChannel}, stop ${run.atrStopMultiple} ATR, shorts ${run.allowShort ? 'on' : 'off'}, exit ${run.exitMode}, OI ${run.oiMode}, trim ${run.trimPct === '0' ? 'off' : pct(Number(run.trimPct), 0)}, ` +
      `longs in ${run.longVenue}, funding ${run.funding ? 'charged' : 'not charged'}; per cut: risk ${pct(Number(run.riskPct), 3)}, cap ${pct(Number(run.maxNotionalPct), 1)}`,
  );
  lines.push(`equity ${Number(run.startEquity).toFixed(0)} -> ${Number(run.endEquity).toFixed(0)}`);
  const list = (r: Record<string, number>): string =>
    Object.entries(r)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ') || 'none';
  lines.push('');
  lines.push(`signals: ${s.signals.entries} entries, ${s.signals.filled} filled; skipped: ${list(s.signals.skipped)}; blocked: ${list(s.signals.blocked)}; no next bar: ${s.signals.noNextBar}`);
  lines.push(`trades: ${s.trades.closed} closed (${list(s.trades.exits)}), ${s.trades.open} open at the end (not in the R statistics), ${s.trades.trimmed} trimmed`);
  lines.push('');
  lines.push('R statistics (net P&L over the initial risk)');
  lines.push(rLine('all', s.r.overall));
  for (const [title, groups] of [
    ['side', s.r.bySide],
    ['instrument', s.r.byInstrument],
    ['cut', s.r.byCut],
    ['year', s.r.byYear],
  ] as const) {
    for (const [key, stats] of Object.entries(groups)) lines.push(rLine(title === 'year' || title === 'side' ? `${title} ${key}` : key, stats));
  }
  lines.push('');
  lines.push('Portfolio (equity sampled daily at 00:00 UTC)');
  lines.push(seriesLine('with funding', s.portfolio.withFunding));
  lines.push(seriesLine('funding added back', s.portfolio.withoutFunding));
  lines.push(
    `funding paid ${s.portfolio.fundingPaid}; gross exposure avg ${pct(s.portfolio.avgGross)} max ${pct(s.portfolio.maxGross)} of equity; in the market ${pct(s.portfolio.timeInMarket, 0)} of days`,
  );
  if (s.benchmark) {
    lines.push('');
    lines.push(`Benchmark (equal-weight buy-and-hold of ${s.benchmark.instruments.join(', ')}, 1Dutc closes)`);
    lines.push(seriesLine('buy-and-hold', s.benchmark.buyAndHold));
    lines.push(seriesLine(`held at ${pct(s.portfolio.avgGross)} exposure`, s.benchmark.atAvgExposure));
    const reg = s.benchmark.regression;
    if (reg) lines.push(`strategy on basket: beta ${reg.beta.toFixed(3)}, alpha ${pct(reg.alphaAnnual, 2)} a year (t ${num(reg.alphaT)}), R2 ${reg.r2.toFixed(3)}, ${reg.n} days`);
  }
  lines.push('');
  const oi = s.oiCoverage;
  lines.push(`OI coverage: the bar's OI change was known on ${oi.known} of ${oi.bars} signal bars (${pct(oi.share)}); on ${oi.entrySignalsKnown} of ${oi.entrySignals} bars with an entry signal`);
  if (s.liveR) {
    const b = s.liveR;
    lines.push(
      `live R: ${b.n} trades, sum ${signed(b.liveSum)}R = percentile ${b.percentile.toFixed(1)} of ${b.draws} bootstrap sums (10th percentile ${signed(b.p10)}R, median ${signed(b.median)}R)` +
        (b.liveSum < b.p10 ? ': BELOW the 10th percentile, the system may have stopped working' : ': inside the normal range'),
    );
  }
  for (const note of s.notes) lines.push(`note: ${note}`);
  return lines.join('\n');
}

// ---- files ----

const csvCell = (v: string | number | boolean): string => String(v);

export function tradesCsv(trades: readonly Trade[]): string {
  const header = 'instId,cut,side,signalBar,entryTime,entryPx,initialStop,exitTime,exitPx,reason,contracts,notional,riskQuote,fees,funding,grossPnl,netPnl,r,grossR,crisis,crowded,capped,trimmed,holdingDays,open';
  const iso = (ts: number): string => new Date(ts).toISOString();
  const rows = trades.map((t) =>
    [
      t.instId,
      phaseLabel(t.phase),
      t.side,
      iso(t.signalTs),
      iso(t.entryTime),
      t.entryPx,
      t.initialStop,
      iso(t.exitTime),
      t.exitPx,
      t.reason,
      t.contracts,
      t.notional,
      t.riskQuote,
      t.fees,
      t.funding,
      t.grossPnl,
      t.netPnl,
      t.r,
      t.grossR,
      t.flags.crisis,
      t.flags.crowded,
      t.flags.capped,
      t.flags.trimmed,
      t.holdingDays,
      t.open,
    ]
      .map(csvCell)
      .join(','),
  );
  return [header, ...rows].join('\n') + '\n';
}

export function equityCsv(result: BacktestResult): string {
  const header = ['date', 'equity', 'equityNoFunding', 'gross', 'lots', ...result.instIds].join(',');
  const rows = result.series.map((s) => [isoDate(s.ts), s.equity, s.equityNoFunding, s.gross, s.lots, ...s.marks].join(','));
  return [header, ...rows].join('\n') + '\n';
}
