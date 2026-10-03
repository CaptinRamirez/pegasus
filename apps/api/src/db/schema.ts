import { bigint, boolean, index, jsonb, numeric, pgTable, primaryKey, serial, text } from 'drizzle-orm/pg-core';

export const orders = pgTable(
  'orders',
  {
    ordId: text('ord_id').primaryKey(),
    clOrdId: text('cl_ord_id').notNull().default(''),
    instId: text('inst_id').notNull(),
    side: text('side').notNull(),
    posSide: text('pos_side').notNull(),
    tdMode: text('td_mode').notNull(),
    ordType: text('ord_type').notNull(),
    px: text('px').notNull().default(''),
    sz: numeric('sz').notNull(),
    accFillSz: numeric('acc_fill_sz').notNull().default('0'),
    avgPx: text('avg_px').notNull().default(''),
    state: text('state').notNull(),
    reduceOnly: boolean('reduce_only').notNull().default(false),
    lever: text('lever').notNull().default(''),
    fee: numeric('fee').notNull().default('0'),
    feeCcy: text('fee_ccy').notNull().default(''),
    pnl: numeric('pnl').notNull().default('0'),
    cTime: bigint('c_time', { mode: 'number' }).notNull(),
    uTime: bigint('u_time', { mode: 'number' }).notNull(),
  },
  (t) => [index('orders_inst_ctime_idx').on(t.instId, t.cTime), index('orders_cl_ord_id_idx').on(t.clOrdId)],
);

/** OKX trade ids are only unique per instrument, so the key is (instId, tradeId). */
export const fills = pgTable(
  'fills',
  {
    tradeId: text('trade_id').notNull(),
    ordId: text('ord_id').notNull(),
    clOrdId: text('cl_ord_id').notNull().default(''),
    instId: text('inst_id').notNull(),
    side: text('side').notNull(),
    posSide: text('pos_side').notNull(),
    fillPx: numeric('fill_px').notNull(),
    fillSz: numeric('fill_sz').notNull(),
    fee: numeric('fee').notNull().default('0'),
    feeCcy: text('fee_ccy').notNull().default(''),
    execType: text('exec_type').notNull().default(''),
    ts: bigint('ts', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ name: 'fills_pkey', columns: [t.instId, t.tradeId] }), index('fills_inst_ts_idx').on(t.instId, t.ts)],
);

export const riskEvents = pgTable('risk_events', {
  id: serial('id').primaryKey(),
  ts: bigint('ts', { mode: 'number' }).notNull(),
  type: text('type').notNull(),
  detail: jsonb('detail').notNull(),
});

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});
