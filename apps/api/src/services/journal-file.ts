import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JournalTrade, OrdType, PosSide, Side, TdMode, TradePlan, TradeSource } from '@pegasus/shared';

/**
 * The trade journal's file (JOURNAL_FILE, data/journal.json by default), kept whichever store the API uses: every
 * trade with its fills and timeline, the bookkeeping the journal needs to go on after a restart (the orders and algo
 * orders of each trade, the plans of the orders Pegasus placed that have not filled yet, the keys of the fills
 * recorded) and the exchange time of the newest fill recorded, from which the start-up reconcile reads the exchange's
 * fills. Written whole after every change (debounced by the service), through a temporary file and a rename, so that
 * a crash never leaves half a file; read once at start. Follows campaign-ledger.ts.
 */

export const JOURNAL_VERSION = 1;
/** Closed trades kept; the oldest go first */
export const MAX_CLOSED_TRADES = 2_000;
/** Keys of the fills recorded that are kept to recognise a fill read again */
export const MAX_FILL_KEYS = 5_000;
/** Orders Pegasus placed whose plan is kept while they may still fill */
export const MAX_PENDING = 500;
/** Lines of one trade's timeline kept; the oldest go first */
export const MAX_TIMELINE = 1_000;

/** An order of a trade, as far as the journal needs it. */
export interface TradeOrderRef {
  clOrdId: string;
  /** pending: placed while the trade was open and not filled (yet) */
  role: 'pending' | 'open' | 'add' | 'reduce';
  /** Contracts of this order's fills in the trade */
  contracts: string;
  /** The average's numerator of those fills: px x contracts (linear) or contracts / px (inverse) */
  value: string;
  /** Exchange time of its first fill in the trade; 0 while it has none */
  firstTs: number;
  /** Its order_placed line is in the timeline */
  placedLogged: boolean;
  /** Its order_cancelled line is in the timeline */
  cancelled: boolean;
  /** Index in `exits` of the exit it is (reduce) */
  exit: number | null;
}

/** An algo order (stop-loss, take-profit) seen resting on a trade's position. */
export interface TrackedAlgo {
  algoId: string;
  algoClOrdId: string;
  /** Stop-loss trigger as last seen, and the first; null for a take-profit only order */
  sl: string | null;
  slFirst: string | null;
  /** Take-profit trigger as last seen, and the first; null for a stop only order */
  tp: string | null;
  tpFirst: string | null;
  /** Contracts it closes ('' when it closes a fraction, closeFraction) */
  sz: string;
  closeFraction: string;
  /** Server time of the first and the last read that listed it */
  firstSeen: number;
  lastSeen: number;
  /** Times its stop trigger was moved */
  moves: number;
  /** The take-profit leg, 1-based; null for a stop */
  leg: number | null;
  /** Its stop counts as the trade's trailing exit */
  trailing: boolean;
  /** The exchange's own trailing stop (OKX move_order_stop): `sl` is the price it triggers at now, which moves with the market */
  callback: boolean;
  /** It came with the opening order (attached) */
  attached: boolean;
  /** No longer listed, since when (server time) */
  ended: boolean;
  endedAt: number | null;
  /** The order of the exit it triggered, when an exit was matched to it */
  triggeredBy: string | null;
}

/** What the journal keeps about a trade besides what the routes show. */
export interface TradeBook {
  /** Contracts of all the opening fills, and the average's numerator (see TradeOrderRef.value) */
  openedContracts: string;
  openedValue: string;
  /** The order of the first fill */
  openingOrdId: string;
  openingClOrdId: string;
  /** The position's running average price, what the P&L of the closes is measured from (the exchange's after a correction) */
  avgPx: string;
  /** The leverage set for the position: the opening order's, else the position's; '' while unknown */
  lever: string;
  orders: Record<string, TradeOrderRef>;
  algos: Record<string, TrackedAlgo>;
  /** Server time of the last fill, adoption or correction */
  lastActivity: number;
}

export interface TradeRecord {
  trade: JournalTrade;
  book: TradeBook;
}

/** An order Pegasus placed (OrderService.onPlaced) that may still fill: its plan waits for the trade it opens. */
export interface PendingOrder {
  clOrdId: string;
  ordId: string;
  instId: string;
  tdMode: TdMode;
  posSide: PosSide;
  side: Side;
  ordType: OrdType;
  /** Contracts ordered */
  contracts: string;
  /** Limit price; '' at market */
  px: string;
  reduceOnly: boolean;
  /** The order's creation time */
  ts: number;
  source: TradeSource;
  /** null for the campaign's orders */
  plan: TradePlan | null;
}

export interface JournalData {
  version: typeof JOURNAL_VERSION;
  /** The last trade number given */
  seq: number;
  /** Exchange time of the newest fill recorded; null before the first (a new journal reads no history) */
  lastFillTs: number | null;
  /** Oldest first */
  trades: TradeRecord[];
  /** Oldest first */
  pending: PendingOrder[];
  /** Newest last */
  fillKeys: string[];
}

export function emptyJournal(): JournalData {
  return { version: JOURNAL_VERSION, seq: 0, lastFillTs: null, trades: [], pending: [], fillKeys: [] };
}

export type JournalLoad = { ok: true; data: JournalData; existed: boolean } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** What makes the file one this version wrote; anything else is not trusted (the file can be edited by hand). */
function problemOf(v: unknown): string | null {
  if (!isObject(v)) return 'not a JSON object';
  if (v['version'] !== JOURNAL_VERSION) return `schema version ${JSON.stringify(v['version'])}, this version reads ${JOURNAL_VERSION}`;
  for (const key of ['trades', 'pending', 'fillKeys']) if (!Array.isArray(v[key])) return `${key} is not a list`;
  if (!isNumber(v['seq'])) return 'seq is not a number';
  if (v['lastFillTs'] !== null && !isNumber(v['lastFillTs'])) return 'lastFillTs is not a number';
  for (const r of v['trades'] as unknown[]) {
    if (!isObject(r) || !isObject(r['trade']) || !isObject(r['book'])) return 'a trade is not complete';
    const t = r['trade'];
    const b = r['book'];
    for (const key of ['id', 'instId', 'mgnMode', 'posSide', 'direction', 'source', 'status', 'size', 'fees', 'realisedPnl', 'netPnl']) if (!isString(t[key])) return `trade ${String(t['id'])}: ${key} is not a string`;
    if (!isNumber(t['seq']) || !isNumber(t['openedAt'])) return `trade ${String(t['id'])}: seq or openedAt is not a number`;
    if (!isObject(t['entry']) || !Array.isArray(t['exits']) || !Array.isArray(t['fills']) || !Array.isArray(t['timeline'])) return `trade ${String(t['id'])} is not complete`;
    for (const key of ['openedContracts', 'openedValue', 'openingOrdId', 'avgPx']) if (!isString(b[key])) return `trade ${String(t['id'])}: book.${key} is not a string`;
    if (!isObject(b['orders']) || !isObject(b['algos'])) return `trade ${String(t['id'])}: its orders or algo orders are not complete`;
  }
  for (const p of v['pending'] as unknown[]) if (!isObject(p) || !isString(p['clOrdId']) || !isString(p['instId'])) return 'a pending order is not complete';
  if ((v['fillKeys'] as unknown[]).some((k) => !isString(k))) return 'a fill key is not a string';
  return null;
}

/**
 * Reads the journal. A missing file is a new journal. A file that cannot be read or is not one this version wrote is
 * an error: the journal then records nothing and does not write (a copy is kept as `<file>.corrupt`), so that what the
 * file held is never overwritten.
 */
export function loadJournal(file: string): JournalLoad {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, data: emptyJournal(), existed: false };
    return { ok: false, error: `the trade journal ${file} could not be read (${(err as Error).message})` };
  }
  let parsed: unknown;
  let problem: string | null;
  try {
    parsed = JSON.parse(text);
    problem = problemOf(parsed);
  } catch (err) {
    problem = (err as Error).message;
  }
  if (problem !== null) {
    try {
      copyFileSync(file, `${file}.corrupt`);
    } catch {
      // best effort
    }
    return { ok: false, error: `the trade journal ${file} is not valid (${problem})` };
  }
  return { ok: true, data: parsed as JournalData, existed: true };
}

/** Trims what is kept (the oldest closed trades, timelines, fill keys, pending orders), then writes the journal whole through a temporary file. */
export function saveJournal(file: string, data: JournalData): void {
  trimJournal(data);
  const tmp = `${file}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(data)}\n`);
  renameSync(tmp, file);
}

export function trimJournal(data: JournalData): void {
  const closed = data.trades.filter((r) => r.trade.status === 'closed').length;
  if (closed > MAX_CLOSED_TRADES) {
    let drop = closed - MAX_CLOSED_TRADES;
    data.trades = data.trades.filter((r) => {
      if (drop > 0 && r.trade.status === 'closed') {
        drop--;
        return false;
      }
      return true;
    });
  }
  for (const r of data.trades) if (r.trade.timeline.length > MAX_TIMELINE) r.trade.timeline.splice(0, r.trade.timeline.length - MAX_TIMELINE);
  if (data.fillKeys.length > MAX_FILL_KEYS) data.fillKeys.splice(0, data.fillKeys.length - MAX_FILL_KEYS);
  if (data.pending.length > MAX_PENDING) data.pending.splice(0, data.pending.length - MAX_PENDING);
}
