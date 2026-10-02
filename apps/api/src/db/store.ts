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
  upsertOrder(order: Order): Promise<void>;
  upsertFill(fill: Fill): Promise<void>;
  listOrders(opts: ListOrdersOptions): Promise<Order[]>;
  listFills(opts: ListFillsOptions): Promise<Fill[]>;
  getSetting<T>(key: string): Promise<T | null>;
  setSetting<T>(key: string, value: T): Promise<void>;
  addRiskEvent(type: string, detail: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  private readonly orders = new Map<string, Order>();
  private readonly fills = new Map<string, Fill>();
  private readonly settings = new Map<string, unknown>();
  readonly riskEvents: Array<{ ts: number; type: string; detail: Record<string, unknown> }> = [];

  async upsertOrder(order: Order): Promise<void> {
    this.orders.set(order.ordId, order);
    if (this.orders.size > 5_000) {
      const oldest = [...this.orders.values()].sort((a, b) => a.uTime - b.uTime).slice(0, 1_000);
      for (const o of oldest) this.orders.delete(o.ordId);
    }
  }

  async upsertFill(fill: Fill): Promise<void> {
    this.fills.set(fill.tradeId, fill);
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
    return this.settings.has(key) ? (this.settings.get(key) as T) : null;
  }

  async setSetting<T>(key: string, value: T): Promise<void> {
    this.settings.set(key, value);
  }

  async addRiskEvent(type: string, detail: Record<string, unknown>): Promise<void> {
    this.riskEvents.push({ ts: Date.now(), type, detail });
    if (this.riskEvents.length > 1_000) this.riskEvents.splice(0, this.riskEvents.length - 1_000);
  }

  async close(): Promise<void> {}
}
