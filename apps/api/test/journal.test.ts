/**
 * The trade journal's file (services/journal-file.ts) and service (services/journal.ts): the file is written whole and
 * read back, never trusted (nor written over) when it is not one this version wrote; the service reads the fills of
 * the time the API was not running, adopts the positions it did not see open and closes the ones that are gone.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { OkxFill, OkxOrder } from '@pegasus/okx';
import type { AccountConfig, AccountStatus, Instrument, JournalUpdate, Position } from '@pegasus/shared';
import type { OkxClients } from '../src/okx/clients.js';
import type { AccountService } from '../src/services/account.js';
import { JournalService } from '../src/services/journal.js';
import { JournalBook } from '../src/services/journal-book.js';
import { emptyJournal, JOURNAL_VERSION, loadJournal, MAX_CLOSED_TRADES, saveJournal, trimJournal } from '../src/services/journal-file.js';

const log = pino({ level: 'silent' });
const fileIn = (): string => join(mkdtempSync(join(tmpdir(), 'pegasus-journal-')), 'nested', 'journal.json');

const BTC: Instrument = {
  instId: 'BTC-USDT-SWAP',
  instType: 'SWAP',
  uly: 'BTC-USDT',
  baseCcy: 'BTC',
  quoteCcy: 'USDT',
  settleCcy: 'USDT',
  ctVal: '0.01',
  ctValCcy: 'BTC',
  ctMult: '1',
  ctType: 'linear',
  lotSz: '0.01',
  minSz: '0.01',
  tickSz: '0.1',
  maxLmtSz: '10000',
  maxMktSz: '5000',
  maxLever: '100',
  state: 'live',
};

const T0 = Date.UTC(2026, 9, 1, 8);

function okxFill(f: Partial<OkxFill> & Pick<OkxFill, 'ordId' | 'side' | 'fillPx' | 'fillSz' | 'ts' | 'billId'>): OkxFill {
  return { instType: 'SWAP', instId: 'BTC-USDT-SWAP', tradeId: `t${f.billId}`, clOrdId: '', tag: '', posSide: 'net', execType: 'T', feeCcy: 'USDT', fee: '-0.5', ...f };
}

function okxOrder(o: Partial<OkxOrder> & Pick<OkxOrder, 'ordId' | 'side'>): OkxOrder {
  return {
    instType: 'SWAP',
    instId: 'BTC-USDT-SWAP',
    clOrdId: '',
    tag: '',
    tdMode: 'isolated',
    posSide: 'net',
    ordType: 'market',
    px: '',
    sz: '2',
    accFillSz: '2',
    fillPx: '',
    fillSz: '',
    fillTime: '',
    tradeId: '',
    avgPx: '',
    state: 'filled',
    lever: '5',
    reduceOnly: 'false',
    fee: '0',
    feeCcy: 'USDT',
    pnl: '0',
    category: 'normal',
    cTime: String(T0),
    uTime: String(T0),
    ...o,
  };
}

/** The exchange as the journal reads it, and an account that only emits. */
function fakes(exchange: { fills: OkxFill[]; orders: OkxOrder[]; positions?: Position[]; failFills?: number }) {
  let failures = exchange.failFills ?? 0;
  const rest = {
    getFills: async (params: { limit?: number; instId?: string }) => {
      if (failures > 0) {
        failures--;
        throw new Error('ECONNREFUSED');
      }
      const rows = exchange.fills.filter((f) => params.instId === undefined || f.instId === params.instId).sort((a, b) => Number(b.ts) - Number(a.ts));
      return rows.slice(0, params.limit ?? 100);
    },
    getOrdersHistory: async () => exchange.orders,
    getOrder: async (params: { ordId?: string }) => {
      const o = exchange.orders.find((x) => x.ordId === params.ordId);
      if (!o) throw new Error('51603 Order does not exist');
      return o;
    },
    getPositions: async () => [],
    getInstruments: async () => [],
  };
  const clients = { rest, clock: { offsetMs: 0 } } as unknown as OkxClients;
  const account = Object.assign(new EventEmitter(), {
    enabled: true,
    config: { posMode: 'net_mode', acctLv: '2', canTrade: true } as AccountConfig | null,
    status: (): AccountStatus => ({ state: 'ok', error: null, lastSyncAt: Date.now(), readOnly: false }),
    positionList: (): Position[] => exchange.positions ?? [],
  }) as unknown as AccountService;
  return { clients, account };
}

async function waitFor<T>(fn: () => T | null | undefined | false, label: string, timeoutMs = 3_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('the journal file', () => {
  it('is new when it does not exist, and reads back what was written, its directory created', () => {
    const file = fileIn();
    expect(loadJournal(file)).toEqual({ ok: true, data: emptyJournal(), existed: false });
    const b = new JournalBook(emptyJournal(), { specOf: () => BTC, now: () => T0 });
    b.fill({ tradeId: '1', ordId: 'o1', clOrdId: 'pgw1', instId: 'BTC-USDT-SWAP', side: 'buy', posSide: 'net', fillPx: '60000', fillSz: '1', fee: '-0.3', feeCcy: 'USDT', execType: 'T', ts: T0 }, { ordId: 'o1', clOrdId: 'pgw1', tdMode: 'cross', reduceOnly: false, lever: '3' });
    saveJournal(file, b.data);
    const read = loadJournal(file);
    expect(read).toEqual({ ok: true, data: b.data, existed: true });
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect((JSON.parse(readFileSync(file, 'utf8')) as { version: number }).version).toBe(JOURNAL_VERSION);
    // a book over what was read goes on where it stopped
    if (!read.ok) throw new Error(read.error);
    const again = new JournalBook(read.data, { specOf: () => BTC, now: () => T0 });
    expect(again.openTrade('BTC-USDT-SWAP', 'cross', 'net')?.trade.id).toBe('1-BTC-USDT-SWAP');
    expect(again.hasFill({ instId: 'BTC-USDT-SWAP', tradeId: '1', ordId: 'o1' })).toBe(true);
  });

  it('is not trusted when it is not one this version wrote: an error, a copy kept aside, the file left as it was', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pegasus-journal-')), 'journal.json');
    for (const [text, problem] of [
      ['{"version": 1, "trades"', /not valid/],
      [JSON.stringify({ ...emptyJournal(), version: 2 }), /schema version 2, this version reads 1/],
      [JSON.stringify({ ...emptyJournal(), trades: [{ trade: { id: 'x' }, book: {} }] }), /trade x: instId is not a string/],
      [JSON.stringify({ ...emptyJournal(), seq: '3' }), /seq is not a number/],
      [JSON.stringify({ ...emptyJournal(), fillKeys: [1] }), /a fill key is not a string/],
    ] as const) {
      writeFileSync(file, text);
      const read = loadJournal(file);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.error).toMatch(problem);
      expect(readFileSync(`${file}.corrupt`, 'utf8')).toBe(text);
      expect(readFileSync(file, 'utf8')).toBe(text);
    }
  });

  it('keeps the newest closed trades, every open one, and the newest fill keys', () => {
    const data = emptyJournal();
    const b = new JournalBook(data, { specOf: () => BTC, now: () => T0 });
    b.fill({ tradeId: 'open', ordId: 'keep', clOrdId: '', instId: 'BTC-USDT-SWAP', side: 'buy', posSide: 'long', fillPx: '1', fillSz: '1', fee: '0', feeCcy: 'USDT', execType: 'T', ts: T0 }, { ordId: 'keep', clOrdId: '', tdMode: 'cross', reduceOnly: false, lever: '' });
    for (let i = 0; i < MAX_CLOSED_TRADES + 3; i++) {
      b.fill({ tradeId: `a${i}`, ordId: `a${i}`, clOrdId: '', instId: 'BTC-USDT-SWAP', side: 'buy', posSide: 'net', fillPx: '1', fillSz: '1', fee: '0', feeCcy: 'USDT', execType: 'T', ts: T0 + i }, { ordId: `a${i}`, clOrdId: '', tdMode: 'isolated', reduceOnly: false, lever: '' });
      b.fill({ tradeId: `b${i}`, ordId: `b${i}`, clOrdId: '', instId: 'BTC-USDT-SWAP', side: 'sell', posSide: 'net', fillPx: '1', fillSz: '1', fee: '0', feeCcy: 'USDT', execType: 'T', ts: T0 + i }, { ordId: `b${i}`, clOrdId: '', tdMode: 'isolated', reduceOnly: true, lever: '' });
    }
    trimJournal(data);
    expect(data.trades.filter((r) => r.trade.status === 'closed')).toHaveLength(MAX_CLOSED_TRADES);
    expect(data.trades[0]?.trade.id).toBe('1-BTC-USDT-SWAP');
    expect(data.trades[1]?.trade.seq).toBe(5);
  });
});

describe('the journal service', () => {
  it('reads the fills of the time the API was not running: a stop that fired then closes its trade', async () => {
    const file = fileIn();
    // what the journal held when the API stopped: an open long and its stop
    const before = new JournalBook(emptyJournal(), { specOf: () => BTC, now: () => T0 });
    before.fill({ tradeId: 't1', ordId: 'o1', clOrdId: 'pgwabc12345678', instId: 'BTC-USDT-SWAP', side: 'buy', posSide: 'net', fillPx: '60000', fillSz: '2', fee: '-0.6', feeCcy: 'USDT', execType: 'T', ts: T0 }, { ordId: 'o1', clOrdId: 'pgwabc12345678', tdMode: 'isolated', reduceOnly: false, lever: '5' });
    before.algoOrders([{ algoId: 'sl1', algoClOrdId: 'slabc12345678', instId: 'BTC-USDT-SWAP', side: 'sell', posSide: 'net', tdMode: 'isolated', sz: '2', closeFraction: '', slTriggerPx: '57000', slTriggerPxType: 'mark', slOrdPx: '-1', tpTriggerPx: '', cTime: T0, uTime: T0 }], T0 + 1_000);
    saveJournal(file, before.data);

    // the exchange's fills now: the opening one again, the stop's market order (no client id) three hours later
    const exchange = {
      fills: [okxFill({ ordId: 'o1', clOrdId: 'pgwabc12345678', tradeId: 't1', side: 'buy', fillPx: '60000', fillSz: '2', ts: String(T0), billId: '1' }), okxFill({ ordId: 'x1', side: 'sell', fillPx: '56950', fillSz: '2', ts: String(T0 + 3 * 3_600_000), billId: '2' })],
      orders: [okxOrder({ ordId: 'x1', side: 'sell', reduceOnly: 'true' })],
      // the first read fails: it is tried again
      failFills: 1,
    };
    const { clients, account } = fakes(exchange);
    const changes: JournalUpdate[] = [];
    const service = new JournalService({ clients, market: { specOf: () => BTC }, account, log }, { file, checkEveryMs: 0, fundingEveryMs: 0, retryMs: 10, flushMs: 5 });
    service.on('change', (u) => changes.push(u));
    await service.start();
    expect(service.status.status).toBe('starting');
    // what the account reports meanwhile waits for the history
    account.emit('order', { ordId: 'x1', clOrdId: '', instId: 'BTC-USDT-SWAP', side: 'sell', posSide: 'net', tdMode: 'isolated', ordType: 'market', px: '', sz: '2', accFillSz: '2', avgPx: '56950', state: 'filled', reduceOnly: true, lever: '5', fee: '-0.5', feeCcy: 'USDT', pnl: '-61', cTime: T0, uTime: T0 });
    await waitFor(() => service.status.status === 'ready', 'ready');
    const page = await waitFor(() => {
      const p = service.page({}, undefined, 10);
      return p.trades[0]?.status === 'closed' ? p : null;
    }, 'the trade closed');
    expect(page.trades[0]).toMatchObject({ id: '1-BTC-USDT-SWAP', closeReason: 'stop', realisedPnl: '-61', fees: '1.1', size: '0' });
    const detail = service.trade('1-BTC-USDT-SWAP');
    // the trigger, then the fill of the market order it sent
    expect(detail?.timeline.map((e) => e.kind)).toEqual(['fill', 'stop_placed', 'stop_triggered', 'fill']);
    await waitFor(() => changes.some((c) => c.trades.some((t) => t.status === 'closed')), 'a change message');
    expect(changes.some((c) => c.status === 'starting' && c.reason?.code === 'JOURNAL_STARTING' && /ECONNREFUSED/.test(c.reason.message))).toBe(true);
    await service.stop();
    // the file holds it
    const read = loadJournal(file);
    expect(read.ok && read.data.trades[0]?.trade.closeReason).toBe('stop');
    expect(read.ok && read.data.lastFillTs).toBe(T0 + 3 * 3_600_000);
  });

  it('a new journal reads no history, adopts the positions open at start and closes one that is gone without fills', async () => {
    const file = fileIn();
    const held: Position = { instId: 'BTC-USDT-SWAP', posSide: 'net', mgnMode: 'isolated', pos: '3', avgPx: '50000', markPx: '51000', upl: '30', uplRatio: '0.1', lever: '10', liqPx: '45500', margin: '150', notionalUsd: '1530', cTime: T0 - 86_400_000, uTime: T0 - 3_600_000 };
    const exchange = {
      // an old fill of the campaign opened the position; the journal does not replay it
      fills: [okxFill({ ordId: 'c0', clOrdId: 'pcabcdef', side: 'buy', fillPx: '50000', fillSz: '3', ts: String(T0 - 86_400_000), billId: '9' })],
      orders: [] as OkxOrder[],
      positions: [held],
    };
    const { clients, account } = fakes(exchange);
    let now = T0;
    const service = new JournalService({ clients, market: { specOf: () => BTC }, account, log }, { file, checkEveryMs: 0, fundingEveryMs: 0, flushMs: 5, quietMs: 1_000, now: () => now });
    await service.start();
    await waitFor(() => service.status.status === 'ready', 'ready');
    expect(service.page({}, undefined, 10).total).toBe(0);
    await service.check();
    const adopted = service.page({}, undefined, 10).trades[0];
    expect(adopted).toMatchObject({ adopted: true, source: 'campaign', size: '3', status: 'open' });
    expect(adopted?.entry).toMatchObject({ avgPx: '50000', margin: '150', leverage: '10' });
    // the position is gone and no fill says how
    exchange.positions = [];
    await service.check();
    // not before the leg has been quiet for quietMs
    expect(service.page({}, undefined, 10).trades[0]?.status).toBe('open');
    now += 2_000;
    await service.check();
    expect(service.page({}, undefined, 10).trades[0]).toMatchObject({ status: 'closed', closeReason: 'unknown' });
    await service.stop();
  });

  it('records nothing and leaves the file as it is when the file cannot be trusted; nothing to record without an account', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pegasus-journal-')), 'journal.json');
    writeFileSync(file, '{ "version": 1, ');
    const { clients, account } = fakes({ fills: [], orders: [] });
    const service = new JournalService({ clients, market: { specOf: () => BTC }, account, log }, { file, checkEveryMs: 0, fundingEveryMs: 0, flushMs: 5 });
    await service.start();
    expect(service.status).toMatchObject({ status: 'blocked', reason: { code: 'JOURNAL_UNREADABLE' } });
    expect(service.page({}, undefined, 10)).toMatchObject({ status: 'blocked', trades: [], total: 0 });
    account.emit('fill', { tradeId: '1', ordId: 'o', clOrdId: '', instId: 'BTC-USDT-SWAP', side: 'buy', posSide: 'net', fillPx: '1', fillSz: '1', fee: '0', feeCcy: 'USDT', execType: 'T', ts: T0 });
    await service.stop();
    expect(readFileSync(file, 'utf8')).toBe('{ "version": 1, ');
    expect(existsSync(`${file}.corrupt`)).toBe(true);

    const disabled = Object.assign(fakes({ fills: [], orders: [] }), {});
    (disabled.account as unknown as { enabled: boolean }).enabled = false;
    const none = new JournalService({ clients: disabled.clients, market: { specOf: () => BTC }, account: disabled.account, log }, { file: fileIn(), checkEveryMs: 0, fundingEveryMs: 0 });
    await none.start();
    expect(none.status).toMatchObject({ status: 'disabled', reason: { code: 'JOURNAL_DISABLED' } });
  });
});
