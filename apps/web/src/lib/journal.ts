import type { JournalPage, JournalTradeSummary, TradeSource, TradeStatus } from '@pegasus/shared';
import type { JournalQuery } from './api';
import type { ToastLink } from '../store/types';

/** The filters of the journal tab; null is "all". */
export interface JournalFilter {
  status: TradeStatus | null;
  instId: string | null;
  source: TradeSource | null;
}

export const NO_FILTER: JournalFilter = { status: null, instId: null, source: null };

/** Trades per page of GET /api/journal. */
export const JOURNAL_PAGE = 50;

export function journalQuery(filter: JournalFilter, before: number | null): JournalQuery {
  const q: JournalQuery = { limit: JOURNAL_PAGE };
  if (filter.status !== null) q.status = filter.status;
  if (filter.instId !== null) q.instId = filter.instId;
  if (filter.source !== null) q.source = filter.source;
  if (before !== null) q.before = before;
  return q;
}

export const matchesFilter = (t: JournalTradeSummary, f: JournalFilter): boolean =>
  (f.status === null || t.status === f.status) && (f.instId === null || t.instId === f.instId) && (f.source === null || t.source === f.source);

/**
 * The rows of the journal tab: the trades of the pages loaded, each in the newest version heard (the pages, or the
 * `journal` messages since: newest `updatedAt`), newest trade first. A trade the socket brought that no page holds
 * joins when it matches the filter and is newer than the oldest trade loaded (or every page is loaded); one that no
 * longer matches the filter (an open trade that closed under "open") leaves.
 */
export function mergeJournal(pages: readonly JournalPage[], live: Readonly<Record<string, JournalTradeSummary>> | null, filter: JournalFilter): JournalTradeSummary[] {
  const byId = new Map<string, JournalTradeSummary>();
  let oldestSeq: number | null = null;
  for (const page of pages) {
    for (const t of page.trades) {
      if (!byId.has(t.id)) byId.set(t.id, t);
      if (oldestSeq === null || t.seq < oldestSeq) oldestSeq = t.seq;
    }
  }
  const allLoaded = pages.length > 0 && pages[pages.length - 1]?.next === null;
  for (const t of Object.values(live ?? {})) {
    const known = byId.get(t.id);
    if (known !== undefined) {
      if (t.updatedAt >= known.updatedAt) byId.set(t.id, t);
    } else if (pages.length > 0 && (allLoaded || oldestSeq === null || t.seq > oldestSeq)) {
      byId.set(t.id, t);
    }
  }
  return [...byId.values()].filter((t) => matchesFilter(t, filter)).sort((a, b) => b.seq - a.seq);
}

/**
 * The trade an order went into: of its instrument, margin mode and leg, the open one, else the most recent; null
 * while the journal has none (it hears of the trade after the order).
 */
export function tradeForLink(trades: Iterable<JournalTradeSummary>, link: ToastLink): JournalTradeSummary | null {
  let best: JournalTradeSummary | null = null;
  for (const t of trades) {
    if (t.instId !== link.instId || t.mgnMode !== link.mgnMode || t.posSide !== link.posSide) continue;
    if (best === null) {
      best = t;
      continue;
    }
    const better = (t.status === 'open') !== (best.status === 'open') ? t.status === 'open' : t.seq > best.seq;
    if (better) best = t;
  }
  return best;
}
