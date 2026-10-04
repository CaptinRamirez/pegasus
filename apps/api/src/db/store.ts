import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Fill, Order } from '@pegasus/shared';

export interface ListOrdersOptions {
  instId?: string;
  limit: number;
  /** When set only orders in these states are returned */
  states?: Order['state'][];
}

export interface ListFillsOptions {
  instId?: string;
  limit: number;
}

/**
 * Persistence boundary. The API keeps its authoritative state in memory
 * (fed by the exchange); the store is a durable journal for history,
 * risk events and small settings such as the kill switch.
 */
export interface Store {
  readonly kind: 'memory' | 'postgres';
  /** Where the settings are kept, for messages to the owner: a file path, or a description */
  readonly settingsLocation: string;
  upsertOrder(order: Order): Promise<void>;
  upsertFill(fill: Fill): Promise<void>;
  listOrders(opts: ListOrdersOptions): Promise<Order[]>;
  listFills(opts: ListFillsOptions): Promise<Fill[]>;
  getSetting<T>(key: string): Promise<T | null>;
  setSetting<T>(key: string, value: T): Promise<void>;
  addRiskEvent(type: string, detail: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

/**
 * Orders, fills and risk events live in memory only. The settings (the kill switch and the day baseline) are also
 * written to `stateFile` when one is given, so that a halt survives closing and reopening the terminal.
 */
export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  private readonly orders = new Map<string, Order>();
  private readonly fills = new Map<string, Fill>();
  private readonly settings = new Map<string, unknown>();
  readonly riskEvents: Array<{ ts: number; type: string; detail: Record<string, unknown> }> = [];
  /** Set when the state file exists but could not be read: what it held is unknown, so reads fail until the settings are written again. */
  private unreadable: Error | null = null;

  readonly settingsLocation: string;

  constructor(private readonly stateFile?: string) {
    this.settingsLocation = stateFile ?? 'memory';
    if (stateFile === undefined) return;
    let text: string;
    try {
      text = readFileSync(stateFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // first start
      this.unreadable = new Error(`the state file ${stateFile} could not be read (${(err as Error).message})`);
      return;
    }
    try {
      const saved = (JSON.parse(text) as { settings?: unknown } | null)?.settings;
      if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) throw new Error('no settings object in it');
      for (const [key, value] of Object.entries(saved)) this.settings.set(key, value);
    } catch (err) {
      this.unreadable = new Error(`the state file ${stateFile} could not be parsed (${(err as Error).message})`);
      // A copy is kept aside for inspection. The bad file itself stays until the next write replaces it: a start
      // that ends before that write must leave the damage for the following start to find, not a missing file.
      try {
        copyFileSync(stateFile, `${stateFile}.corrupt`);
      } catch {
        // best effort
      }
    }
  }

  async upsertOrder(order: Order): Promise<void> {
    const prev = this.orders.get(order.ordId);
    if (prev && prev.uTime > order.uTime) return; // never regress to an older snapshot
    this.orders.set(order.ordId, order);
    if (this.orders.size > 5_000) {
      const oldest = [...this.orders.values()].sort((a, b) => a.uTime - b.uTime).slice(0, 1_000);
      for (const o of oldest) this.orders.delete(o.ordId);
    }
  }

  async upsertFill(fill: Fill): Promise<void> {
    // OKX trade ids are only unique per instrument
    this.fills.set(`${fill.instId}:${fill.tradeId}`, fill);
  }

  async listOrders(opts: ListOrdersOptions): Promise<Order[]> {
    return [...this.orders.values()]
      .filter((o) => (opts.instId === undefined || o.instId === opts.instId) && (opts.states === undefined || opts.states.includes(o.state)))
      .sort((a, b) => b.cTime - a.cTime)
      .slice(0, opts.limit);
  }

  async listFills(opts: ListFillsOptions): Promise<Fill[]> {
    return [...this.fills.values()]
      .filter((f) => opts.instId === undefined || f.instId === opts.instId)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, opts.limit);
  }

  async getSetting<T>(key: string): Promise<T | null> {
    if (this.unreadable) throw this.unreadable;
    return this.settings.has(key) ? (this.settings.get(key) as T) : null;
  }

  async setSetting<T>(key: string, value: T): Promise<void> {
    this.settings.set(key, value);
    this.unreadable = null;
    if (this.stateFile === undefined) return;
    // Synchronous, so two writes can never interleave; through a temporary file, so a crash mid-write never leaves half a file.
    const tmp = `${this.stateFile}.tmp`;
    mkdirSync(dirname(this.stateFile), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify({ settings: Object.fromEntries(this.settings) }, null, 2)}\n`);
    renameSync(tmp, this.stateFile);
  }

  async addRiskEvent(type: string, detail: Record<string, unknown>): Promise<void> {
    this.riskEvents.push({ ts: Date.now(), type, detail });
    if (this.riskEvents.length > 1_000) this.riskEvents.splice(0, this.riskEvents.length - 1_000);
  }

  async close(): Promise<void> {}
}
