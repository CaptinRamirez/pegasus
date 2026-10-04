import type { OkxOpenInterestHistoryRow } from './types.js';

/** Open interest at one instant, columns as on the wire. */
export interface OpenInterestSnapshot {
  /** The instant the level refers to, epoch ms */
  ts: number;
  oi: string;
  oiCcy: string;
  oiUsd: string;
}

export interface NormalizeOpenInterestOptions {
  /** Current time, epoch ms: decides which periods are complete */
  now: number;
  /**
   * Also emit the daily rows of days older than the oldest half-day row, with the type of the oldest
   * determined day. Off by default: the convention may change exactly where the half-day rows end.
   */
  extendBeforeHalfDayCoverage?: boolean;
}

const HALF_DAY = 43_200_000;
const DAY = 86_400_000;

type RowType = 'start' | 'end';

interface Parsed {
  row: OkxOpenInterestHistoryRow;
  /** oiCcy as an exact scaled integer */
  ccy: bigint;
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;
const SCALE = 18;

/** A plain non-negative decimal string as an integer scaled by 10^18 (exact; digits beyond that are cut), null when it is not one. */
function scaled(s: string): bigint | null {
  const m = DECIMAL.exec(s);
  if (!m) return null;
  const frac = (m[2] ?? '').slice(0, SCALE).padEnd(SCALE, '0');
  return BigInt((m[1] as string) + frac);
}

/** |a - b| <= 1e-4 x max(a, b) */
function near(a: bigint, b: bigint): boolean {
  const diff = a > b ? a - b : b - a;
  return diff * 10_000n <= (a > b ? a : b);
}

function index(rows: readonly OkxOpenInterestHistoryRow[], periodMs: number): Map<number, Parsed> {
  const out = new Map<number, Parsed>();
  for (const row of rows) {
    const ts = Number(row[0]);
    const ccy = scaled(row[2]);
    if (!Number.isSafeInteger(ts) || ts % periodMs !== 0 || ccy === null || ccy <= 0n) continue;
    out.set(ts, { row, ccy });
  }
  return out;
}

/**
 * Turn the 1Dutc and 12Hutc rows of /rubik/stat/contracts/open-interest-history into levels at known
 * instants, oldest first.
 *
 * OKX labels a row with the start of its period but fills it by one of two conventions, depending on the
 * age of the data (docs/okx-api-notes.md §5.9): recent rows hold the level at the END of the period (the
 * newest one is still forming and tracks the live level), older rows are a snapshot AT the label. Where
 * one convention gives way to the other is not documented, so it is read off the data: a daily row equals
 * the first half-day row of its day under the START convention and the second one under END. A day on
 * which open interest barely moved cannot tell and takes the type of the nearest day that can.
 *
 * Nothing is emitted for an instant whose candidates disagree, and nothing at all when no day can be typed.
 */
export function normalizeOpenInterestHistory(
  daily: readonly OkxOpenInterestHistoryRow[],
  halfDay: readonly OkxOpenInterestHistoryRow[],
  opts: NormalizeOpenInterestOptions,
): OpenInterestSnapshot[] {
  const { now } = opts;
  const days = index(daily, DAY);
  const halves = index(halfDay, HALF_DAY);
  if (halves.size === 0) return [];
  const oldestHalf = Math.min(...halves.keys());

  const starts = new Set<number>(days.keys());
  for (const ts of halves.keys()) starts.add(ts - (ts % DAY));
  const ordered = [...starts].sort((a, b) => a - b);

  const types = new Map<number, RowType>();
  for (const day of ordered) {
    const d = days.get(day);
    const h0 = halves.get(day);
    const h1 = halves.get(day + HALF_DAY);
    if (now < day + DAY || !d || !h0 || !h1) continue;
    const atStart = near(d.ccy, h0.ccy);
    const atEnd = near(d.ccy, h1.ccy);
    if (atStart && !atEnd) types.set(day, 'start');
    else if (atEnd && !atStart) types.set(day, 'end');
  }
  const determined = [...types.keys()].sort((a, b) => a - b);
  const oldest = determined[0];
  const newest = determined[determined.length - 1];
  if (oldest === undefined || newest === undefined) return [];

  /** Type of the determined day nearest to `day`, the earlier one on a tie. */
  const nearestType = (day: number): RowType => {
    let best = oldest;
    for (const cand of determined) {
      if (Math.abs(cand - day) < Math.abs(best - day)) best = cand;
    }
    return types.get(best) as RowType;
  };

  const candidates = new Map<number, Parsed[]>();
  const put = (instant: number, p: Parsed | undefined): void => {
    if (!p) return;
    const list = candidates.get(instant);
    if (list) list.push(p);
    else candidates.set(instant, [p]);
  };

  for (const day of ordered) {
    const h0 = halves.get(day);
    const h1 = halves.get(day + HALF_DAY);
    if (day < oldestHalf) {
      if (opts.extendBeforeHalfDayCoverage !== true) continue;
      put(types.get(oldest) === 'start' ? day : day + DAY, days.get(day));
      continue;
    }
    if (now < day + DAY) {
      // The forming day: only what is complete at `now`. A forming END row is still moving.
      if (types.get(newest) === 'start') {
        if (day <= now) put(day, h0);
        if (day + HALF_DAY <= now) put(day + HALF_DAY, h1);
      } else if (day + HALF_DAY <= now) {
        put(day + HALF_DAY, h0);
      }
      continue;
    }
    const type = types.get(day) ?? nearestType(day);
    if (type === 'start') {
      put(day, h0);
      put(day + HALF_DAY, h1);
    } else {
      put(day + HALF_DAY, h0);
      put(day + DAY, h1);
    }
  }

  const out: OpenInterestSnapshot[] = [];
  for (const [ts, list] of [...candidates].sort((a, b) => a[0] - b[0])) {
    const first = list[0] as Parsed;
    if (!list.every((p) => near(p.ccy, first.ccy))) continue;
    out.push({ ts, oi: first.row[1], oiCcy: first.row[2], oiUsd: first.row[3] });
  }
  return out;
}
