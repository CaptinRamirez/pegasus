import {
  D,
  Decimal,
  DEFAULT_CAMPAIGN_PARAMS,
  DEFAULT_POT_PARAMS,
  isDecimalString,
  type CampaignParams,
  type CampaignPotRecord,
  type CampaignRecord as LedgerCampaign,
  type CampaignReconcileRow,
  type CampaignReconciliation,
  type CampaignReplayCampaign,
  type CampaignReplayRun,
  type CampaignReplayView,
  type CampaignStructure,
  type CampaignValueSample,
  type Candle,
  type FundingRecord,
  type Instrument,
  type PotParams,
} from '@pegasus/shared';
import type { CacheStore } from '../data/cache.js';
import { fundingKey, loadCandles, loadFunding, loadInstrument, type Fetchers } from '../data/load.js';
import { runCampaigns } from './engine.js';
import { DEFAULT_CAMPAIGN_CONFIG } from './options.js';
import type { CampaignInstrument, CampaignRecord, CampaignResult } from './types.js';

/**
 * The replay beside a live pot: the campaign replay (engine.ts) run on the exchange's bars from the pot's start with
 * the pot's own rule, the other structure beside it, the pot's start value held in BTC, and the reconciliation of
 * the pot's ledger (apps/api, services/campaign-ledger.ts) with the replay, campaign by campaign.
 *
 * The run is the product's (DEFAULT_CAMPAIGN_CONFIG: adds within the exchange's limits, liquidation at its first
 * maintenance tier plus the fee, the modelled slippage) with:
 *   - from: the first 12-hour close after the pot's start, the first close the live service looks at (C12);
 *   - to (`through`): the last 12-hour close every instrument's bars have, never after `now`; an instrument whose
 *     bars end more than a day before it does not hold the others back (a note says so);
 *   - the free cash starting at the pot's start value (the paper account's equity then), the ladder's rungs on its
 *     start (CampaignConfig.startCash);
 *   - the pot sampled at every 12-hour close, as the ledger is;
 *   - the open of the running bar, when known (Fetchers.latest), filling what the last close decided (C14): the live
 *     service trades right after a close, the replay would otherwise wait 12 hours for that bar to close;
 *   - funding as the given fetchers have it: the API reads OKX's own history (what the paper exchange charged).
 */

const DAY_MS = 86_400_000;
const HALF_DAY_MS = DAY_MS / 2;
/** The instrument the pot's start value is held in, for the comparison */
export const HELD_INSTRUMENT = 'BTC-USDT-SWAP';

const closeAtOrBefore = (t: number): number => Math.floor(t / HALF_DAY_MS) * HALF_DAY_MS;
const isPositive = (v: unknown): v is string => isDecimalString(v) && D(v).gt(0);
const money = (v: Decimal): string => v.toDecimalPlaces(8).toFixed();
const iso = (t: number): string => new Date(t).toISOString().replace(':00.000Z', 'Z');

export interface PotReplayInput {
  /** The ledger's pot: its start time and value, its structure, its start and minimum stake */
  pot: CampaignPotRecord;
  /** The ledger's campaigns */
  campaigns: readonly LedgerCampaign[];
  /** The instruments the pot runs on (the API's CAMPAIGN_INSTRUMENTS) */
  instruments: readonly string[];
  /** The rule; the structure is always the pot's own. DEFAULT_CAMPAIGN_PARAMS by default */
  params?: CampaignParams;
  /** The pot's parameters; the start and the minimum stake are always the pot's own. DEFAULT_POT_PARAMS by default */
  potParams?: PotParams;
  /** The replay ends at the last 12-hour close at or before this time */
  now: number;
  /** DEFAULT_RECONCILE_TOLERANCES by default */
  tolerances?: ReconcileTolerances;
}

export interface PotReplaySources {
  fetchers: Fetchers;
  cache: CacheStore;
  /** Read the pot's span again instead of extending the cache */
  refresh?: boolean;
  log?: (message: string) => void;
}

export interface PotReplay {
  /** The first close the pot looked at: entries are decided from it on */
  from: number;
  /** The last 12-hour close replayed */
  through: number;
  same: CampaignReplayRun;
  other: CampaignReplayRun;
  heldBtc: CampaignValueSample[];
  reconciliation: CampaignReconciliation;
  /** The engine's results behind `same` and `other` */
  results: { same: CampaignResult; other: CampaignResult };
  /** What the replay went without */
  notes: string[];
}

/**
 * How far live and replay may differ and still match.
 *
 * entryPx, 0.01: the relative difference of the entry's fill prices. The replay fills at the open of the 12-hour bar
 * after the signal close times 1 + slippage (0.05% on BTC and ETH, 0.10% on the others); the live service buys a few
 * seconds to a few minutes after that close, at the book's prices then: the price drifts from the bar's open in that
 * time, the market order walks the real book, and an entry retried within the close's 10-minute window can fill
 * later still. 1% covers that drift on the coins traded and still catches a fill at the wrong bar or the wrong price.
 *
 * multiple, 0.1: the difference of the multiples (what a campaign returned over its stake), as a fraction of the
 * larger of 1 and the replay's multiple. At 10x every 0.1% between the live and the replayed fills of the entry and
 * of the exit moves a multiple by about 0.01 of the stake, so the drift above, partial fills that leave a campaign
 * holding less than the rule's quantity (and an add or a sale sized on the position the book left), funding that
 * is OKX's own on the live side, and an exit late by a missed close all show here first. A liquidation is the
 * exchange's, on its mark price and its own tiers, where the replay liquidates on the bar's traded low at the first
 * tier: it can come a bar apart or not at all, which the end and its close show, not this tolerance.
 *
 * The other fields are compared exactly: the close of the entry, the number of adds and of harvest sales, the kind
 * of end and the close it came at.
 */
export interface ReconcileTolerances {
  entryPx: string;
  multiple: string;
}

export const DEFAULT_RECONCILE_TOLERANCES: ReconcileTolerances = { entryPx: '0.01', multiple: '0.1' };

/** What an instrument's data is for the replay. */
interface Loaded {
  inst: Instrument;
  daily: Candle[];
  halfDay: Candle[];
  funding: FundingRecord[] | null;
  /** The newest bars, the forming one included */
  latest: Candle[];
}

/** The pot replayed from its start with its own rule and with the other structure, its start value held in BTC, and the ledger reconciled with it. */
export async function replayPot(input: PotReplayInput, sources: PotReplaySources): Promise<PotReplay> {
  const { pot } = input;
  const { fetchers, cache } = sources;
  const refresh = sources.refresh === true;
  const log = sources.log ?? (() => undefined);
  const notes: string[] = [];
  if (pot.structure !== 'pyramid' && pot.structure !== 'noadd') throw new Error(`the pot's structure ${JSON.stringify(pot.structure)} is not one of the rule`);
  if (!isPositive(pot.start) || !isPositive(pot.minStake) || !Number.isFinite(pot.startedAt)) throw new Error('the pot has no start time, start or minimum stake');
  const params: CampaignParams = { ...(input.params ?? DEFAULT_CAMPAIGN_PARAMS), structure: pot.structure };
  const potParams: PotParams = { ...(input.potParams ?? DEFAULT_POT_PARAMS), start: pot.start, minStake: pot.minStake };
  const startCash = isPositive(pot.startValue) ? pot.startValue : pot.start;
  const from = closeAtOrBefore(pot.startedAt) + HALF_DAY_MS;
  // The bars of the channels of the first daily close the pot looks at, and two days to spare.
  const since = Math.floor(from / DAY_MS) * DAY_MS - (Math.max(params.entryChannel, params.exitChannel) + 2) * DAY_MS;
  const instIds = [...new Set(input.instruments)];

  const loaded = new Map<string, Loaded>();
  for (const instId of instIds.includes(HELD_INSTRUMENT) ? instIds : [...instIds, HELD_INSTRUMENT]) {
    const replayed = instIds.includes(instId);
    const inst = await loadInstrument(instId, fetchers, cache, refresh);
    const daily = replayed ? await loadCandles(instId, '1Dutc', fetchers, cache, refresh, since) : [];
    const halfDay = await loadCandles(instId, '12Hutc', fetchers, cache, refresh, since);
    let funding: FundingRecord[] | null = null;
    if (replayed) {
      try {
        funding = await loadFunding(instId, fetchers, cache, refresh, from - DAY_MS);
      } catch (err) {
        funding = cache.read<FundingRecord[]>(fundingKey(instId, fetchers));
        notes.push(`${instId}: funding history not updated (${(err as Error).message})${funding ? ', using the cached settlements' : ''}`);
      }
      const first = funding?.[0];
      if (!first) notes.push(`${instId}: no funding history: no funding charged`);
      else if (first.fundingTime > from + DAY_MS) notes.push(`${instId}: funding known from ${iso(first.fundingTime)} on only`);
    }
    let latest: Candle[] = [];
    try {
      latest = (await fetchers.latest?.(instId, '12Hutc')) ?? [];
    } catch (err) {
      notes.push(`${instId}: the running bar could not be read (${(err as Error).message}): what its last close decided is not filled`);
    }
    loaded.set(instId, { inst, daily, halfDay, funding, latest });
    log(`${instId}: ${daily.length} daily bars, ${halfDay.length} half-day bars${funding ? `, ${funding.length} funding settlements` : ''}`);
  }

  // The last close every instrument has; one that lags by more than a day does not hold the others back.
  const cap = closeAtOrBefore(input.now);
  let through = cap;
  for (const instId of instIds) {
    const bars = (loaded.get(instId) as Loaded).halfDay.filter((c) => c.confirm && c.ts + HALF_DAY_MS <= cap);
    const last = bars[bars.length - 1];
    if (!last) notes.push(`${instId}: no 12-hour bars: not replayed`);
    else if (last.ts + HALF_DAY_MS < cap - DAY_MS) notes.push(`${instId}: its bars end at ${iso(last.ts + HALF_DAY_MS)}: replayed that far only`);
    else through = Math.min(through, last.ts + HALF_DAY_MS);
  }

  const data: CampaignInstrument[] = instIds.map((instId) => {
    const l = loaded.get(instId) as Loaded;
    const d: CampaignInstrument = { inst: l.inst, daily: l.daily, halfDay: l.halfDay, funding: l.funding };
    // C14: the bar that opened at `through`, confirmed since or still forming.
    const running = [...l.latest, ...l.halfDay].find((c) => c.ts === through);
    if (running) d.next = { ts: through, open: running.open };
    return d;
  });
  const run = (structure: CampaignStructure): CampaignResult =>
    runCampaigns(data, { ...DEFAULT_CAMPAIGN_CONFIG, params: { ...params, structure }, pot: potParams, from, to: through, startCash, sampleEveryClose: true });
  const otherStructure: CampaignStructure = pot.structure === 'pyramid' ? 'noadd' : 'pyramid';
  const same = run(pot.structure);
  // The engine runs in one go: the event loop is given a turn between the two runs.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const other = run(otherStructure);
  notes.push(...same.notes);

  return {
    from,
    through,
    same: replayRun(same, pot.structure, startCash),
    other: replayRun(other, otherStructure, startCash),
    heldBtc: heldInBtc((loaded.get(HELD_INSTRUMENT) as Loaded).halfDay, pot, startCash, from, through),
    reconciliation: reconcileCampaigns(input.campaigns, same.campaigns, through, input.tolerances),
    results: { same, other },
    notes,
  };
}

/** The view of GET /api/campaign/replay of a replay that has just been computed. */
export function replayView(replay: PotReplay, computedAt: number): CampaignReplayView {
  return { status: 'ready', reason: null, computedAt, through: replay.through, same: replay.same, other: replay.other, heldBtc: replay.heldBtc, reconciliation: replay.reconciliation };
}

const byEntry = (a: CampaignRecord, b: CampaignRecord): number => a.entryTime - b.entryTime || a.instId.localeCompare(b.instId);

/** A campaign of the replay as the view lists it. A campaign the sale of a harvest closed is listed as an exit: its multiple holds what the harvests banked. */
function replayCampaign(c: CampaignRecord): CampaignReplayCampaign {
  return {
    instId: c.instId,
    signalTs: c.signalTs,
    entryTs: c.entryTime,
    entryPx: c.entryPx,
    stake: c.stake,
    adds: c.adds,
    end: c.open ? 'open' : c.end === 'liquidated' ? 'liquidated' : 'exit',
    endTs: c.open ? null : c.endTime,
    multiple: c.open ? null : c.multiple,
  };
}

function replayRun(result: CampaignResult, structure: CampaignStructure, startCash: string): CampaignReplayRun {
  return {
    structure,
    samples: result.pot.map((s) => ({ ts: s.ts, value: s.value, banked: s.banked })),
    campaigns: [...result.campaigns].sort(byEntry).map(replayCampaign),
    bankings: result.bankings.map((b) => ({ closeTs: b.ts, amount: b.amount })),
    value: result.end?.value ?? startCash,
    banked: result.end?.banked ?? '0',
    finished: result.finishedAt !== null,
  };
}

/**
 * The pot's start value held in BTC from the start: at every 12-hour close from `from` to `through`, the start value
 * times the close over the price at the start. That price is the mark the ledger recorded at the start
 * (btcMarkAtStart) or, when it could not be read, the close of the last 12-hour bar before the start.
 */
export function heldInBtc(halfDay: readonly Candle[], pot: Pick<CampaignPotRecord, 'startedAt' | 'btcMarkAtStart'>, startValue: string, from: number, through: number): CampaignValueSample[] {
  const confirmed = halfDay.filter((c) => c.confirm);
  const before = confirmed.filter((c) => c.ts + HALF_DAY_MS <= pot.startedAt).at(-1);
  const base = isPositive(pot.btcMarkAtStart) ? D(pot.btcMarkAtStart) : before ? D(before.close) : null;
  if (base === null || !base.gt(0)) return [];
  return confirmed
    .filter((c) => c.ts + HALF_DAY_MS >= from && c.ts + HALF_DAY_MS <= through)
    .map((c) => ({ ts: c.ts + HALF_DAY_MS, value: money(D(startValue).mul(c.close).div(base)) }));
}

// ---- the reconciliation ----

/** The ledger's end of a campaign as of `through`, with the close it belongs to; null while it is open then. */
function liveEnd(c: LedgerCampaign, through: number): { kind: string; close: number } | null {
  const end = c.end;
  if (!end) return null;
  if (end.kind === 'exit' || end.kind === 'harvest') {
    // Decided at a close and carried out right after it, as the replay fills it at the open of that close (C14).
    const close = end.kind === 'exit' ? (end.closeTs ?? closeAtOrBefore(end.ts)) : (c.sales.at(-1)?.closeTs ?? closeAtOrBefore(end.ts));
    return close <= through ? { kind: end.kind, close } : null;
  }
  // A liquidation (or a close by another order) inside a 12-hour bar: the bar's open, as the replay dates it. Inside
  // the bar running after `through` the replay has not seen it.
  const close = closeAtOrBefore(end.ts);
  return close < through ? { kind: end.kind, close } : null;
}

const within = (live: string, replay: string, tolerance: string, floor: string | null): boolean => {
  if (!isDecimalString(live) || !isDecimalString(replay)) return false;
  const scale = floor === null ? D(replay).abs() : Decimal.max(floor, D(replay).abs());
  return D(live).minus(replay).abs().lte(scale.mul(tolerance));
};

function differences(live: LedgerCampaign, replay: CampaignRecord, through: number, tolerances: ReconcileTolerances): CampaignReconcileRow['differences'] {
  const out: CampaignReconcileRow['differences'] = [];
  const differ = (field: string, l: string | null, r: string | null): void => {
    out.push({ field, live: l, replay: r });
  };
  if (live.entry.closeTs !== replay.entryTime) differ('entryClose', String(live.entry.closeTs), String(replay.entryTime));
  if (!within(live.entry.avgPx, replay.entryPx, tolerances.entryPx, null)) differ('entryPx', live.entry.avgPx === '' ? null : live.entry.avgPx, replay.entryPx);
  const adds = live.adds.filter((a) => a.closeTs <= through).length;
  if (adds !== replay.adds) differ('adds', String(adds), String(replay.adds));
  const sales = live.sales.filter((s) => s.closeTs <= through).length;
  if (sales !== replay.sales) differ('sales', String(sales), String(replay.sales));
  const end = liveEnd(live, through);
  const replayEnd = replay.open ? 'open' : replay.end;
  if ((end?.kind ?? 'open') !== replayEnd) differ('end', end?.kind ?? 'open', replayEnd);
  if (end && !replay.open) {
    if (end.close !== replay.endTime) differ('endClose', String(end.close), String(replay.endTime));
    if (live.multiple !== null && !within(live.multiple, replay.multiple, tolerances.multiple, '1')) differ('multiple', live.multiple, replay.multiple);
  }
  return out;
}

/**
 * The ledger against the replay of the same pot, campaign by campaign, keyed by instrument and signalTs: the open time
 * of the daily bar whose close gave the entry signal on both sides (the ledger's CampaignRecord.signalTs, the engine's
 * CampaignRecord.signalTs), and in the rows. Only what both sides could have by `through` is compared: the ledger's campaigns that
 * entered at a close after it are left out, and its adds, sales and ends after it count as not yet made. A
 * campaign open on both sides is not compared on its multiple (the ledger has none while it runs).
 */
export function reconcileCampaigns(
  ledger: readonly LedgerCampaign[],
  replayed: readonly CampaignRecord[],
  through: number,
  tolerances: ReconcileTolerances = DEFAULT_RECONCILE_TOLERANCES,
): CampaignReconciliation {
  const key = (instId: string, signalTs: number): string => `${instId} ${signalTs}`;
  const replay = new Map(replayed.map((c) => [key(c.instId, c.signalTs), c]));
  const seen = new Set<string>();
  const rows: CampaignReconcileRow[] = [];
  for (const live of ledger) {
    if (live.entry.closeTs > through) continue;
    const k = key(live.instId, live.signalTs);
    seen.add(k);
    const r = replay.get(k);
    if (!r) {
      rows.push({ instId: live.instId, signalTs: live.signalTs, campaignId: live.id, verdict: 'live-only', differences: [] });
      continue;
    }
    const found = differences(live, r, through, tolerances);
    rows.push({ instId: live.instId, signalTs: live.signalTs, campaignId: live.id, verdict: found.length === 0 ? 'match' : 'differs', differences: found });
  }
  for (const [k, r] of replay) {
    if (!seen.has(k)) rows.push({ instId: r.instId, signalTs: r.signalTs, campaignId: null, verdict: 'replay-only', differences: [] });
  }
  rows.sort((a, b) => a.signalTs - b.signalTs || a.instId.localeCompare(b.instId));
  const count = (verdict: CampaignReconcileRow['verdict']): number => rows.filter((r) => r.verdict === verdict).length;
  return { tolerances: { ...tolerances }, matched: count('match'), differing: count('differs'), liveOnly: count('live-only'), replayOnly: count('replay-only'), rows };
}

/** Rows of a reconciliation that are not a match. */
export const reconcileMismatches = (r: CampaignReconciliation): number => r.differing + r.liveOnly + r.replayOnly;

/** A time field of the differences (an epoch ms as a string) as a date and minute. */
const shown = (field: string, value: string | null): string => (value === null ? 'none' : field.endsWith('Close') && /^\d+$/.test(value) ? iso(Number(value)) : value);

/** The text pnpm backtest:campaign --reconcile prints. */
export function formatPotReplay(replay: PotReplay, pot: CampaignPotRecord): string {
  const run = (r: CampaignReplayRun, label: string): string => {
    const open = r.campaigns.filter((c) => c.end === 'open').length;
    return `  ${label.padEnd(22)}value ${r.value.padEnd(14)} banked ${r.banked.padEnd(12)} ${r.campaigns.length} campaigns (${open} open)${r.finished ? ', finished' : ''}`;
  };
  const r = replay.reconciliation;
  const lines = [
    `the pot started ${iso(pot.startedAt)} with ${pot.startValue || pot.start} USDT (${pot.structure}); replayed from the close ${iso(replay.from)} through ${iso(replay.through)}`,
    run(replay.same, `${replay.same.structure} (the pot's)`),
    run(replay.other, replay.other.structure),
    `  ${'held in BTC'.padEnd(22)}value ${replay.heldBtc.at(-1)?.value ?? (pot.startValue || pot.start)}`,
    `reconciliation of the ledger with the replay (entryPx within ${r.tolerances['entryPx'] ?? '?'} of the replay's, multiple within ${r.tolerances['multiple'] ?? '?'} of the larger of 1 and the replay's; the rest exactly): ` +
      `${r.matched} match, ${r.differing} differ, ${r.liveOnly} live only, ${r.replayOnly} replay only`,
    ...r.rows
      .filter((row) => row.verdict !== 'match')
      .map((row) => `  ${row.verdict.padEnd(12)} ${row.instId} signal ${iso(row.signalTs).slice(0, 10)}${row.campaignId ? ` (${row.campaignId})` : ''}${row.differences.map((d) => `; ${d.field} live ${shown(d.field, d.live)}, replay ${shown(d.field, d.replay)}`).join('')}`),
    ...replay.notes.map((n) => `note: ${n}`),
  ];
  return lines.join('\n');
}

// ---- a ledger file ----

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The pot and the campaigns of a campaign ledger file (the API's CAMPAIGN_STATE_FILE); throws with what is wrong.
 * Only what the replay and the reconciliation read is checked.
 */
export function parseLedger(value: unknown): { pot: CampaignPotRecord; campaigns: LedgerCampaign[] } {
  const fail = (what: string): never => {
    throw new Error(`not a campaign ledger: ${what}`);
  };
  if (!isObject(value)) return fail('a JSON object is expected');
  const { pot, campaigns } = value;
  if (pot === null) return fail('its pot has not started');
  if (!isObject(pot)) return fail('pot is missing');
  if (typeof pot['startedAt'] !== 'number' || !Number.isFinite(pot['startedAt'])) return fail('pot.startedAt is not a time');
  if (pot['structure'] !== 'pyramid' && pot['structure'] !== 'noadd') return fail('pot.structure is neither pyramid nor noadd');
  for (const k of ['start', 'minStake']) if (!isPositive(pot[k])) return fail(`pot.${k} is not a positive decimal`);
  for (const k of ['startValue', 'btcMarkAtStart']) if (typeof pot[k] !== 'string') return fail(`pot.${k} is not a string`);
  if (!Array.isArray(campaigns)) return fail('campaigns is not a list');
  for (const c of campaigns as unknown[]) {
    if (!isObject(c) || typeof c['id'] !== 'string' || typeof c['instId'] !== 'string' || typeof c['signalTs'] !== 'number' || !isObject(c['entry']) || !Array.isArray(c['adds']) || !Array.isArray(c['sales'])) {
      return fail('a campaign is not complete');
    }
  }
  return { pot: pot as unknown as CampaignPotRecord, campaigns: campaigns as LedgerCampaign[] };
}
