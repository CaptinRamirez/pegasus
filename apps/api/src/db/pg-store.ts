import { and, desc, eq, inArray } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Fill, Order, OrderState } from '@pegasus/shared';
import { fills, orders, riskEvents, settings } from './schema.js';
import type { ListFillsOptions, ListOrdersOptions, Store } from './store.js';

export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS orders (
  ord_id text PRIMARY KEY,
  cl_ord_id text NOT NULL DEFAULT '',
  inst_id text NOT NULL,
  side text NOT NULL,
  pos_side text NOT NULL,
  td_mode text NOT NULL,
  ord_type text NOT NULL,
  px text NOT NULL DEFAULT '',
  sz numeric NOT NULL,
  acc_fill_sz numeric NOT NULL DEFAULT 0,
  avg_px text NOT NULL DEFAULT '',
  state text NOT NULL,
  reduce_only boolean NOT NULL DEFAULT false,
  lever text NOT NULL DEFAULT '',
  fee numeric NOT NULL DEFAULT 0,
  fee_ccy text NOT NULL DEFAULT '',
  pnl numeric NOT NULL DEFAULT 0,
  c_time bigint NOT NULL,
  u_time bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_inst_ctime_idx ON orders (inst_id, c_time);
CREATE INDEX IF NOT EXISTS orders_cl_ord_id_idx ON orders (cl_ord_id);
CREATE TABLE IF NOT EXISTS fills (
  trade_id text PRIMARY KEY,
  ord_id text NOT NULL,
  cl_ord_id text NOT NULL DEFAULT '',
  inst_id text NOT NULL,
  side text NOT NULL,
  pos_side text NOT NULL,
  fill_px numeric NOT NULL,
  fill_sz numeric NOT NULL,
  fee numeric NOT NULL DEFAULT 0,
  fee_ccy text NOT NULL DEFAULT '',
  exec_type text NOT NULL DEFAULT '',
  ts bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS fills_inst_ts_idx ON fills (inst_id, ts);
CREATE TABLE IF NOT EXISTS risk_events (
  id serial PRIMARY KEY,
  ts bigint NOT NULL,
  type text NOT NULL,
  detail jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at bigint NOT NULL
);
`;

type OrderRow = typeof orders.$inferSelect;
type FillRow = typeof fills.$inferSelect;

function rowToOrder(r: OrderRow): Order {
  return {
    ordId: r.ordId,
    clOrdId: r.clOrdId,
    instId: r.instId,
    side: r.side as Order['side'],
    posSide: r.posSide as Order['posSide'],
    tdMode: r.tdMode as Order['tdMode'],
    ordType: r.ordType as Order['ordType'],
    px: r.px,
    sz: r.sz,
    accFillSz: r.accFillSz,
    avgPx: r.avgPx,
    state: r.state as OrderState,
    reduceOnly: r.reduceOnly,
    lever: r.lever,
    fee: r.fee,
    feeCcy: r.feeCcy,
    pnl: r.pnl,
    cTime: r.cTime,
    uTime: r.uTime,
  };
}

function rowToFill(r: FillRow): Fill {
  return {
    tradeId: r.tradeId,
    ordId: r.ordId,
    clOrdId: r.clOrdId,
    instId: r.instId,
    side: r.side as Fill['side'],
    posSide: r.posSide as Fill['posSide'],
    fillPx: r.fillPx,
    fillSz: r.fillSz,
    fee: r.fee,
    feeCcy: r.feeCcy,
    execType: r.execType as Fill['execType'],
    ts: r.ts,
  };
}

export class PgStore implements Store {
  readonly kind = 'postgres' as const;
  private readonly sql: postgres.Sql;
  private readonly db: PostgresJsDatabase;

  constructor(url: string) {
    this.sql = postgres(url, { max: 5, onnotice: () => {} });
    this.db = drizzle(this.sql);
  }

  async migrate(): Promise<void> {
    await this.sql.unsafe(MIGRATION_SQL);
  }

  async upsertOrder(o: Order): Promise<void> {
    const row: typeof orders.$inferInsert = { ...o };
    await this.db
      .insert(orders)
      .values(row)
      .onConflictDoUpdate({
        target: orders.ordId,
        set: { clOrdId: o.clOrdId, px: o.px, sz: o.sz, accFillSz: o.accFillSz, avgPx: o.avgPx, state: o.state, lever: o.lever, fee: o.fee, feeCcy: o.feeCcy, pnl: o.pnl, uTime: o.uTime },
      });
  }

  async upsertFill(f: Fill): Promise<void> {
    await this.db.insert(fills).values({ ...f }).onConflictDoNothing();
  }

  async listOrders(opts: ListOrdersOptions): Promise<Order[]> {
    const conds = [];
    if (opts.instId !== undefined) conds.push(eq(orders.instId, opts.instId));
    if (opts.states !== undefined && opts.states.length > 0) conds.push(inArray(orders.state, opts.states));
    const rows = await this.db
      .select()
      .from(orders)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(orders.cTime))
      .limit(opts.limit);
    return rows.map(rowToOrder);
  }

  async listFills(opts: ListFillsOptions): Promise<Fill[]> {
    const rows = await this.db
      .select()
      .from(fills)
      .where(opts.instId !== undefined ? eq(fills.instId, opts.instId) : undefined)
      .orderBy(desc(fills.ts))
      .limit(opts.limit);
    return rows.map(rowToFill);
  }

  async getSetting<T>(key: string): Promise<T | null> {
    const rows = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
    const row = rows[0];
    return row ? (row.value as T) : null;
  }

  async setSetting<T>(key: string, value: T): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value: value as unknown, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: settings.key, set: { value: value as unknown, updatedAt: Date.now() } });
  }

  async addRiskEvent(type: string, detail: Record<string, unknown>): Promise<void> {
    await this.db.insert(riskEvents).values({ ts: Date.now(), type, detail });
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
