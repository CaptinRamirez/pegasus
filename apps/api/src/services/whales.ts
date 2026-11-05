import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from 'pino';

/**
 * The Hyperliquid whale recorder (docs/proposals/owner-methods-2026-11.md, addendum), on the plain paper stack beside the
 * paper books: every 4 hours (UTC slots) the leaderboard's 100 largest accounts and each one's open positions, appended
 * as one JSON line to WHALES_FILE. History cannot be fetched honestly afterwards (today's leaders are leaders because
 * their past trades won), so the record starts now and is studied later with the accounts as they stood at each slot.
 * A slot already in the file is not taken again; a slot that fails is tried again at the next look.
 */

export interface WhalesConfig {
  enabled: boolean;
  file: string;
  /** How many of the largest accounts each snapshot holds */
  top: number;
}

export interface WhalePosition {
  coin: string;
  /** Signed size in coins: positive long, negative short */
  szi: string;
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  leverage: number | null;
}

export interface WhaleAccount {
  address: string;
  accountValue: string;
  pnlMonth: string | null;
  pnlAllTime: string | null;
  positions: WhalePosition[];
}

export interface WhaleSnapshot {
  slot: number;
  ts: number;
  accounts: WhaleAccount[];
  /** Per coin: the summed notional long and short of the accounts, USD */
  net: Record<string, { long: number; short: number }>;
}

export interface WhaleSources {
  leaderboard(): Promise<Array<{ address: string; accountValue: string; pnlMonth: string | null; pnlAllTime: string | null }>>;
  positions(address: string): Promise<WhalePosition[]>;
}

const SLOT_MS = 4 * 3_600_000;
const LEADERBOARD_URL = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
const INFO_URL = 'https://api.hyperliquid.xyz/info';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '0');

export function hyperliquidSources(fetchImpl: typeof fetch = fetch, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): WhaleSources {
  const json = async (url: string, init?: RequestInit): Promise<unknown> => {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  };
  return {
    async leaderboard() {
      const body = await json(LEADERBOARD_URL);
      const rows = isObject(body) && Array.isArray(body['leaderboardRows']) ? body['leaderboardRows'] : [];
      return rows.filter(isObject).map((r) => {
        const perf = Array.isArray(r['windowPerformances']) ? (r['windowPerformances'] as unknown[]) : [];
        const pnl = (name: string): string | null => {
          const w = perf.find((x) => Array.isArray(x) && x[0] === name) as [string, unknown] | undefined;
          return w && isObject(w[1]) ? str(w[1]['pnl']) : null;
        };
        return { address: str(r['ethAddress']), accountValue: str(r['accountValue']), pnlMonth: pnl('month'), pnlAllTime: pnl('allTime') };
      });
    },
    async positions(address) {
      await sleep(100);
      const body = await json(INFO_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'clearinghouseState', user: address }) });
      const list = isObject(body) && Array.isArray(body['assetPositions']) ? body['assetPositions'] : [];
      return list.filter(isObject).map((a) => (isObject(a['position']) ? a['position'] : {})).map((p) => {
        const lev = isObject(p['leverage']) ? Number(p['leverage']['value']) : NaN;
        return { coin: str(p['coin']), szi: str(p['szi']), entryPx: str(p['entryPx']), positionValue: str(p['positionValue']), unrealizedPnl: str(p['unrealizedPnl']), leverage: Number.isFinite(lev) ? lev : null };
      });
    },
  };
}

/** The slots already in the file, from its last lines. */
function recordedSlots(file: string): Set<number> {
  const out = new Set<number>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n').slice(-50)) {
    try {
      const v = JSON.parse(line) as { slot?: unknown };
      if (typeof v.slot === 'number') out.add(v.slot);
    } catch {
      // a partly written last line: the slot is taken again
    }
  }
  return out;
}

export class WhaleRecorder {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private done = new Set<number>();
  private readonly now: () => number;

  constructor(
    private readonly config: WhalesConfig,
    private readonly deps: { sources: WhaleSources; log: Logger },
    private readonly opts: { now?: () => number; checkEveryMs?: number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  start(): Promise<void> {
    this.done = recordedSlots(this.config.file);
    const every = this.opts.checkEveryMs ?? 5 * 60_000;
    if (every > 0) this.timer = setInterval(() => void this.tick(), every);
    return this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const slot = Math.floor(this.now() / SLOT_MS) * SLOT_MS;
    if (this.busy || this.done.has(slot)) return;
    this.busy = true;
    try {
      const board = await this.deps.sources.leaderboard();
      const top = board.sort((a, b) => Number(b.accountValue) - Number(a.accountValue)).slice(0, this.config.top);
      const accounts: WhaleAccount[] = [];
      const net: WhaleSnapshot['net'] = {};
      for (const a of top) {
        const positions = await this.deps.sources.positions(a.address);
        accounts.push({ ...a, positions });
        for (const p of positions) {
          const side = Number(p.szi) >= 0 ? 'long' : 'short';
          const n = (net[p.coin] ??= { long: 0, short: 0 });
          // research totals in USD, not money of the account: a number is enough
          n[side] += Math.abs(Number(p.positionValue));
        }
      }
      const snap: WhaleSnapshot = { slot, ts: this.now(), accounts, net };
      mkdirSync(dirname(this.config.file), { recursive: true });
      appendFileSync(this.config.file, `${JSON.stringify(snap)}\n`);
      this.done.add(slot);
      this.deps.log.info({ slot: new Date(slot).toISOString(), accounts: accounts.length, btc: net['BTC'] ?? null }, 'hyperliquid whales recorded');
    } catch (err) {
      this.deps.log.warn({ err: (err as Error).message }, 'the hyperliquid whales could not be recorded; tried again at the next look');
    } finally {
      this.busy = false;
    }
  }
}
