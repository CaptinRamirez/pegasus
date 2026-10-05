import { D, potRungLevel } from '@pegasus/shared';
import { mean, median } from '../stats.js';
import type { Banking, CampaignConfig, CampaignMode, CampaignRecord, CampaignResult, PotSample } from './types.js';

/**
 * The summary of a campaign replay. The statistics are plain numbers computed from the finished
 * campaigns (see stats.ts); the money in them was decimal arithmetic in the engine.
 */

/** The distribution of the multiples (proceeds over stake) of a set of campaigns. */
export interface MultipleStats {
  count: number;
  /** Share that returned nothing: liquidated or nothing left at the exit, and nothing harvested before */
  lost: number;
  /** Share that returned less than the stake */
  belowStake: number;
  median: number;
  mean: number;
  /** Mean without the largest multiple; null with fewer than two campaigns */
  meanWithoutTop1: number | null;
  /** Mean without the two largest multiples; null with fewer than three campaigns */
  meanWithoutTop2: number | null;
  /** Share with a multiple of at least 2, 5, 20, 100 */
  atLeast2: number;
  atLeast5: number;
  atLeast20: number;
  atLeast100: number;
  max: number;
}

export function multipleStats(campaigns: readonly CampaignRecord[]): MultipleStats {
  return statsOfMultiples(campaigns.map((c) => Number(c.multiple)));
}

export function statsOfMultiples(values: readonly number[]): MultipleStats {
  const n = values.length;
  const multiples = [...values].sort((a, b) => a - b);
  const sum = multiples.reduce((a, b) => a + b, 0);
  const share = (count: number): number => (n === 0 ? 0 : count / n);
  const atLeast = (threshold: number): number => share(multiples.filter((m) => m >= threshold).length);
  const top = (k: number): number => multiples.slice(n - k).reduce((a, b) => a + b, 0);
  return {
    count: n,
    lost: share(multiples.filter((m) => m === 0).length),
    belowStake: share(multiples.filter((m) => m < 1).length),
    median: median(multiples),
    mean: mean(multiples),
    meanWithoutTop1: n > 1 ? (sum - top(1)) / (n - 1) : null,
    meanWithoutTop2: n > 2 ? (sum - top(2)) / (n - 2) : null,
    atLeast2: atLeast(2),
    atLeast5: atLeast(5),
    atLeast20: atLeast(20),
    atLeast100: atLeast(100),
    max: multiples[n - 1] ?? 0,
  };
}

export interface CampaignSummary {
  run: {
    mode: CampaignMode;
    instruments: string[];
    /** First open and last close of the bars replayed, ISO dates; '' without bars */
    from: string;
    to: string;
    structure: string;
    entryChannel: number;
    exitChannel: number;
    leverage: string;
    addStep: string;
    feeRate: string;
    funding: boolean;
    /** Adds cut to what the exchange accepts: notional within maxLever x the position's margin */
    exchangeCap: boolean;
    /** Maintenance rate of each instrument's liquidation price */
    maintenance: Record<string, string>;
  };
  signals: {
    /** Entry signals on an instrument without a campaign */
    entries: number;
    taken: number;
    /** By rule: cash, min-size */
    skipped: Record<string, number>;
    noNextBar: number;
  };
  campaigns: {
    count: number;
    exited: number;
    liquidated: number;
    /** Closed by the sale of a harvest */
    harvested: number;
    /** Still open at the end: in the multiples at their mark */
    open: number;
    adds: number;
    multiples: MultipleStats;
    byInstrument: Record<string, { count: number; lost: number; mean: number }>;
    /** The five largest multiples */
    top: Array<{ instId: string; entry: string; end: string; multiple: number; peak: number; adds: number }>;
  };
  /** null in the catalogue */
  pot: {
    start: string;
    minStake: string;
    /** Sum of the stakes of the campaigns taken */
    staked: string;
    /** The highest value the pot was marked at, at a 12-hour close, before the harvest of that close */
    peak: { date: string; value: string } | null;
    /** The harvests: when, the rungs passed after it, the pot value then, what was banked and how (see Banking) */
    bankings: Array<{ time: string; rungs: number; value: string; target: string; fromCash: string; fraction: string; fromSales: string; amount: string }>;
    /** Pot value at which money next leaves the pot */
    nextRung: string;
    end: { time: string; freeCash: string; openEquity: string; value: string; banked: string; total: string; open: number };
    /** When the free cash fell below the minimum stake with nothing open; null when the pot was still alive at the end */
    finished: string | null;
  } | null;
  notes: string[];
  /** With --check: the comparison with the reference run */
  check?: { ok: boolean; lines: string[] };
}

const isoDate = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
const isoMinute = (ts: number): string => new Date(ts).toISOString().slice(0, 16).replace('T', ' ');

function count<T>(items: readonly T[], keyOf: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[keyOf(item)] = (out[keyOf(item)] ?? 0) + 1;
  return out;
}

export function buildCampaignSummary(result: CampaignResult, config: CampaignConfig, notes: readonly string[] = []): CampaignSummary {
  const { campaigns } = result;
  const byInstrument: CampaignSummary['campaigns']['byInstrument'] = {};
  for (const instId of result.instIds) {
    const own = campaigns.filter((c) => c.instId === instId);
    if (own.length === 0) continue;
    const stats = multipleStats(own);
    byInstrument[instId] = { count: stats.count, lost: stats.lost, mean: stats.mean };
  }
  const top = [...campaigns]
    .sort((a, b) => Number(b.multiple) - Number(a.multiple))
    .slice(0, 5)
    .map((c) => ({ instId: c.instId, entry: isoDate(c.entryTime), end: isoDate(c.endTime), multiple: Number(c.multiple), peak: Number(c.peak), adds: c.adds }));

  let pot: CampaignSummary['pot'] = null;
  if (result.end) {
    const { end, peak } = result;
    let staked = D(0);
    for (const c of campaigns) staked = staked.plus(c.stake);
    const lastBanking = result.bankings[result.bankings.length - 1];
    pot = {
      start: config.pot.start,
      minStake: config.pot.minStake,
      staked: staked.toFixed(2),
      peak: peak ? { date: isoDate(peak.ts), value: D(peak.value).toFixed(2) } : null,
      bankings: result.bankings.map((b) => ({
        time: isoMinute(b.ts),
        rungs: b.rungs,
        value: D(b.value).toFixed(2),
        target: D(b.target).toFixed(2),
        fromCash: D(b.fromCash).toFixed(2),
        fraction: D(b.fraction).toFixed(4),
        fromSales: D(b.fromSales).toFixed(2),
        amount: D(b.amount).toFixed(2),
      })),
      nextRung: potRungLevel(lastBanking?.rungs ?? 0, config.pot).toFixed(),
      end: {
        time: isoMinute(end.ts),
        freeCash: D(end.freeCash).toFixed(2),
        openEquity: D(end.openEquity).toFixed(2),
        value: D(end.value).toFixed(2),
        banked: D(end.banked).toFixed(2),
        total: D(end.value).plus(end.banked).toFixed(2),
        open: end.open,
      },
      finished: result.finishedAt === null ? null : isoMinute(result.finishedAt),
    };
  }

  return {
    run: {
      mode: result.mode,
      instruments: result.instIds,
      from: result.span ? isoDate(result.span.from) : '',
      to: result.span ? isoDate(result.span.to) : '',
      structure: config.params.structure,
      entryChannel: config.params.entryChannel,
      exitChannel: config.params.exitChannel,
      leverage: config.params.leverage,
      addStep: config.params.addStep,
      feeRate: config.params.feeRate,
      funding: config.funding,
      exchangeCap: config.exchangeCap,
      maintenance: result.maintenance,
    },
    signals: {
      entries: result.signals.length,
      taken: result.signals.filter((s) => s.outcome === 'taken').length,
      skipped: count(
        result.signals.filter((s) => s.outcome === 'skipped'),
        (s) => s.rule ?? 'unknown',
      ),
      noNextBar: result.signals.filter((s) => s.outcome === 'no-next-bar').length,
    },
    campaigns: {
      count: campaigns.length,
      exited: campaigns.filter((c) => c.end === 'exit').length,
      liquidated: campaigns.filter((c) => c.end === 'liquidated').length,
      harvested: campaigns.filter((c) => c.end === 'harvest').length,
      open: campaigns.filter((c) => c.open).length,
      adds: campaigns.reduce((a, c) => a + c.adds, 0),
      multiples: multipleStats(campaigns),
      byInstrument,
      top,
    },
    pot,
    notes: [...result.notes, ...notes],
  };
}

// ---- console ----

const pct = (v: number, digits = 1): string => `${(v * 100).toFixed(digits)}%`;
const times = (v: number | null): string => (v === null ? 'n/a' : `${v >= 100 ? v.toFixed(0) : v.toFixed(2)}x`);

/** The compact console summary. */
export function formatCampaignSummary(s: CampaignSummary): string {
  const lines: string[] = [];
  const { run, campaigns: c } = s;
  lines.push(`Campaign replay (${run.mode})  ${run.instruments.join(', ')}  ${run.from} to ${run.to}`);
  lines.push(
    `rule: close above the ${run.entryChannel}-day high, long at ${run.leverage}x isolated, ${run.structure === 'pyramid' ? `adds every ${pct(Number(run.addStep), 0)} (pyramid)` : 'no adds'}, ` +
      `out below the ${run.exitChannel}-day low; fee ${pct(Number(run.feeRate), 2)}, funding ${run.funding ? 'charged' : 'not charged'}`,
  );
  const byRate = new Map<string, string[]>();
  for (const [instId, rate] of Object.entries(run.maintenance)) byRate.set(rate, [...(byRate.get(rate) ?? []), instId.split('-')[0] ?? instId]);
  lines.push(
    `liquidation at a maintenance rate of ${[...byRate].map(([rate, coins]) => `${pct(Number(rate), 2)} (${coins.join(', ')})`).join(', ') || 'n/a'}; ` +
      `adds ${run.exchangeCap ? 'cut to what the exchange accepts (maxLever x margin)' : 'carried by open profit, without the exchange cap'}`,
  );
  const list = (r: Record<string, number>): string =>
    Object.entries(r)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ') || 'none';
  lines.push('');
  lines.push(`signals: ${s.signals.entries} entries, ${s.signals.taken} taken; skipped: ${list(s.signals.skipped)}; no next bar: ${s.signals.noNextBar}`);
  lines.push(`campaigns: ${c.count} (${c.liquidated} liquidated, ${c.exited} exited, ${c.harvested > 0 ? `${c.harvested} closed by a harvest, ` : ''}${c.open} open at the end, marked), ${c.adds} adds`);
  const m = c.multiples;
  lines.push(
    `multiples of the stake: lost ${pct(m.lost)}  below the stake ${pct(m.belowStake)}  median ${times(m.median)}  mean ${times(m.mean)}  without the top two ${times(m.meanWithoutTop2)}  ` +
      `>=5x ${pct(m.atLeast5)}  >=20x ${pct(m.atLeast20)}  >=100x ${pct(m.atLeast100)}  max ${times(m.max)}`,
  );
  for (const [instId, own] of Object.entries(c.byInstrument)) lines.push(`${instId.padEnd(15)} n ${String(own.count).padStart(4)}  lost ${pct(own.lost, 0).padStart(4)}  mean ${times(own.mean)}`);
  if (c.top.length > 0) lines.push(`largest: ${c.top.map((t) => `${t.instId} ${t.entry} > ${t.end} ${times(t.multiple)} (peak ${times(t.peak)}, ${t.adds} adds)`).join('; ')}`);
  if (s.pot) {
    const { pot } = s;
    lines.push('');
    lines.push(`Pot: start ${pot.start}, minimum stake ${pot.minStake}; staked ${pot.staked} over ${c.count} campaigns`);
    if (pot.peak) lines.push(`highest value ${pot.peak.value} on ${pot.peak.date} (marked at a 12-hour close, before any harvest)`);
    for (const b of pot.bankings) {
      const sold = Number(b.fraction) > 0 ? `, ${b.fromSales} from selling ${pct(Number(b.fraction), 2)} of every open campaign` : '';
      lines.push(`banked ${b.amount} at ${b.time}, rung ${b.rungs}: the pot was worth ${b.value}; ${b.fromCash} from the free cash${sold}`);
    }
    if (pot.bankings.length === 0) lines.push(`nothing banked: the pot was never worth ${pot.nextRung} at a 12-hour close`);
    lines.push(`end ${pot.end.time}: free cash ${pot.end.freeCash} + open campaigns ${pot.end.openEquity} (${pot.end.open}) = pot ${pot.end.value}; banked ${pot.end.banked}; total ${pot.end.total}`);
    lines.push(pot.finished === null ? `the pot is alive; money next leaves it at ${pot.nextRung}` : `the pot was finished at ${pot.finished}: nothing open and the free cash below the minimum stake`);
  }
  for (const note of s.notes) lines.push(`note: ${note}`);
  if (s.check) {
    lines.push('');
    lines.push(...s.check.lines);
  }
  return lines.join('\n');
}

// ---- files ----

export function campaignsCsv(campaigns: readonly CampaignRecord[]): string {
  const header = 'instId,signalBar,entryTime,entryPx,endTime,end,stake,contracts,adds,harvested,proceeds,multiple,peak,fees,funding,open';
  const iso = (ts: number): string => new Date(ts).toISOString();
  const rows = campaigns.map((c) =>
    [c.instId, iso(c.signalTs), iso(c.entryTime), c.entryPx, iso(c.endTime), c.end, c.stake, c.contracts, c.adds, c.harvested, c.proceeds, c.multiple, c.peak, c.fees, c.funding, c.open]
      .map(String)
      .join(','),
  );
  return [header, ...rows].join('\n') + '\n';
}

/** One line per harvest: when, the rungs passed after it, the pot value then, what was banked and how. */
export function bankingsCsv(bankings: readonly Banking[]): string {
  const header = 'time,rungs,potValue,target,fromCash,fraction,fromSales,amount';
  const rows = bankings.map((b) => [new Date(b.ts).toISOString(), b.rungs, b.value, b.target, b.fromCash, b.fraction, b.fromSales, b.amount].join(','));
  return [header, ...rows].join('\n') + '\n';
}

export function potCsv(samples: readonly PotSample[]): string {
  const header = 'date,freeCash,openEquity,value,banked,total,open';
  const rows = samples.map((s) => [isoDate(s.ts), s.freeCash, s.openEquity, s.value, s.banked, D(s.value).plus(s.banked).toFixed(), s.open].join(','));
  return [header, ...rows].join('\n') + '\n';
}
