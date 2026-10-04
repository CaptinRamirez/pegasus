import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OkxApiError, OkxTransportError, OkxWsError, type OkxAccountConfig, type OkxBalance, type OkxLeverageInfo, type OkxOrder, type OkxPosition } from '@pegasus/okx';
import type { AccountConfig, Balance, Order } from '@pegasus/shared';
import { pino } from 'pino';
import { MemoryStore } from '../src/db/store.js';
import type { OkxClients } from '../src/okx/clients.js';
import { AccountService } from '../src/services/account.js';

const log = pino({ level: 'silent' });

class FakePrivateSocket extends EventEmitter {
  isReady = false;
  currentStatus: 'connecting' | 'connected' | 'disconnected' = 'disconnected';
  connects = 0;
  async subscribe(): Promise<void> {}
  connect(): void {
    this.connects++;
  }
  async close(): Promise<void> {}
}

function setup(opts: { credentials?: boolean } = {}) {
  const exchange = {
    config: { uid: '1', acctLv: '2', posMode: 'long_short_mode', autoLoan: false, level: 'Lv1', perm: 'read_only,trade' } as OkxAccountConfig,
    fail: null as Error | null,
    configCalls: 0,
  };
  const guarded = async <T>(value: () => T): Promise<T> => {
    if (exchange.fail) throw exchange.fail;
    return value();
  };
  const rest = {
    getAccountConfig: () => {
      exchange.configCalls++;
      return guarded(() => ({ ...exchange.config }));
    },
    getBalance: () => guarded(() => ({ totalEq: '1000', uTime: String(Date.now()), details: [] }) as unknown as OkxBalance),
    getPositions: () => guarded(() => []),
    getOrdersPending: () => guarded(() => []),
  };
  const ws = new FakePrivateSocket();
  const clients = { rest, wsPrivate: opts.credentials === false ? null : ws, clock: { offsetMs: 0 }, demo: false } as unknown as OkxClients;
  const account = new AccountService(clients, new MemoryStore(), log);
  let statusEvents = 0;
  account.on('status', () => statusEvents++);
  return { account, exchange, ws, statusEvents: () => statusEvents };
}

describe('AccountService status', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is disabled without credentials and starting before the first attempt', () => {
    expect(setup({ credentials: false }).account.status()).toEqual({ state: 'disabled', error: null, lastSyncAt: null, readOnly: false });
    expect(setup().account.status()).toEqual({ state: 'starting', error: null, lastSyncAt: null, readOnly: false });
  });

  it('records why each start attempt failed, keeps retrying and reports ok once one succeeds', async () => {
    const { account, exchange, ws, statusEvents } = setup();
    exchange.fail = new OkxApiError('50105', 'Invalid OK-ACCESS-PASSPHRASE.', '/api/v5/account/config');
    void account.startWithRetry();
    await vi.advanceTimersByTimeAsync(0);
    expect(account.status()).toEqual({ state: 'error', error: { code: '50105', message: 'Invalid OK-ACCESS-PASSPHRASE.', ts: 1_700_000_000_000 }, lastSyncAt: null, readOnly: false });
    expect(account.config).toBeNull();
    expect(statusEvents()).toBe(1);
    expect(ws.connects).toBe(0);

    // the second attempt fails differently: the reason shown is the current one
    exchange.fail = new OkxTransportError('/api/v5/account/config', 'could not reach OKX (ENOTFOUND)', false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(account.status().error).toMatchObject({ code: '', message: 'could not reach OKX (ENOTFOUND)' });
    expect(statusEvents()).toBe(2);

    exchange.fail = null;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(account.status()).toEqual({ state: 'ok', error: null, lastSyncAt: 1_700_000_015_000, readOnly: false });
    expect(account.balance?.totalEq).toBe('1000');
    expect(ws.connects).toBe(1);
    await account.stop();
  });

  it('a failing reconcile is reported with the time of the last good sync, and cleared by the next good one', async () => {
    const { account, exchange } = setup();
    await account.start();
    const syncedAt = account.status().lastSyncAt;
    expect(syncedAt).toBe(1_700_000_000_000);

    exchange.fail = new OkxApiError('50110', 'Invalid IP', '/api/v5/account/config');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(account.status()).toMatchObject({ state: 'error', error: { code: '50110', message: 'Invalid IP' }, lastSyncAt: syncedAt });

    exchange.fail = null;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(account.status()).toMatchObject({ state: 'ok', error: null, lastSyncAt: 1_700_000_120_000 });
    await account.stop();
  });

  it('a private push counts as a sync', async () => {
    const { account, ws } = setup();
    await account.start();
    await vi.advanceTimersByTimeAsync(7_000);
    ws.emit('data', { arg: { channel: 'positions', instType: 'SWAP' }, data: [] });
    expect(account.status().lastSyncAt).toBe(1_700_000_007_000);
    await account.stop();
  });

  it('reports a rejected private-socket login until the socket is ready', async () => {
    const { account, ws, statusEvents } = setup();
    await account.start();
    const before = statusEvents();
    ws.emit('error', new OkxWsError('login failed: Login failed.', '60009'));
    expect(account.status()).toMatchObject({ state: 'error', error: { code: '60009', message: 'login failed: Login failed.' } });
    expect(statusEvents()).toBe(before + 1);
    // a successful reconcile over REST does not hide a stream that still cannot log in
    await vi.advanceTimersByTimeAsync(60_000);
    expect(account.status().state).toBe('error');

    ws.isReady = true;
    ws.emit('ready');
    await vi.advanceTimersByTimeAsync(0);
    expect(account.status()).toMatchObject({ state: 'ok', error: null });
    await account.stop();
  });

  it('connection() says connecting while the socket is open but not logged in', () => {
    const { account, ws } = setup();
    expect(account.connection()).toBe('disconnected');
    ws.currentStatus = 'connecting';
    expect(account.connection()).toBe('connecting');
    ws.currentStatus = 'connected';
    expect(account.connection()).toBe('connecting');
    ws.isReady = true;
    expect(account.connection()).toBe('connected');
    expect(setup({ credentials: false }).account.connection()).toBe('disconnected');
  });
});

describe('AccountService config', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is null until loaded, then announced', async () => {
    const { account } = setup();
    const seen: AccountConfig[] = [];
    account.on('config', (c) => seen.push(c));
    expect(account.config).toBeNull();
    await account.start();
    expect(account.config).toEqual({ posMode: 'long_short_mode', acctLv: '2', canTrade: true });
    expect(seen).toEqual([{ posMode: 'long_short_mode', acctLv: '2', canTrade: true }]);
    await account.stop();
  });

  it('is reloaded on every reconcile, so a mode or permission change made on OKX is picked up', async () => {
    const { account, exchange, statusEvents } = setup();
    const seen: AccountConfig[] = [];
    account.on('config', (c) => seen.push(c));
    await account.start();
    expect(exchange.configCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(exchange.configCalls).toBe(2);
    expect(seen).toHaveLength(1); // unchanged: not announced again

    exchange.config.posMode = 'net_mode';
    exchange.config.perm = 'read_only';
    const before = statusEvents();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(account.config).toEqual({ posMode: 'net_mode', acctLv: '2', canTrade: false });
    expect(seen).toHaveLength(2);
    expect(account.status().readOnly).toBe(true);
    expect(statusEvents()).toBe(before + 1);
    await account.stop();
  });

  it('canTrade is false only when perm is present and lacks trade', async () => {
    const canTrade = async (perm: string | undefined): Promise<boolean | undefined> => {
      const { account, exchange } = setup();
      if (perm === undefined) delete exchange.config.perm;
      else exchange.config.perm = perm;
      await account.start();
      await account.stop();
      return account.config?.canTrade;
    };
    expect(await canTrade('read_only')).toBe(false);
    expect(await canTrade('read_only,withdraw')).toBe(false);
    expect(await canTrade('read_only,trade')).toBe(true);
    expect(await canTrade('read_only, trade')).toBe(true);
    // unknown: assume it can and let the exchange decide
    expect(await canTrade('')).toBe(true);
    expect(await canTrade(undefined)).toBe(true);
  });

  it('refresh() is a completed reconcile that needs no private socket: it waits for one in flight, pulls again and rejects on failure', async () => {
    const { account, exchange, ws } = setup();
    await account.start();
    expect(ws.isReady).toBe(false);
    expect(exchange.configCalls).toBe(1);

    void account.reconcile();
    await account.refresh();
    expect(exchange.configCalls).toBe(3); // the reconcile in flight, then the refresh's own pull

    exchange.fail = new OkxApiError('50110', 'Invalid IP', '/api/v5/account/config');
    await expect(account.refresh()).rejects.toMatchObject({ code: '50110' });
    expect(account.status().error).toMatchObject({ code: '50110' });
    await account.stop();

    await expect(setup({ credentials: false }).account.refresh()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('requireRestTrading needs the loaded config and the trade permission, not the private socket', async () => {
    const fresh = setup();
    expect(() => fresh.account.requireRestTrading()).toThrowError(expect.objectContaining({ code: 'NOT_CONNECTED', status: 503 }));
    expect(() => setup({ credentials: false }).account.requireRestTrading()).toThrowError(expect.objectContaining({ code: 'NOT_CONNECTED' }));

    const { account, exchange, ws } = setup();
    await account.start();
    expect(ws.isReady).toBe(false);
    expect(account.requireRestTrading()).toMatchObject({ posMode: 'long_short_mode', canTrade: true });
    exchange.config.perm = 'read_only';
    await account.refresh();
    expect(() => account.requireRestTrading()).toThrowError(expect.objectContaining({ code: 'READ_ONLY_KEY', status: 403 }));
    await account.stop();
  });

  it('requireTrading refuses a read-only key and an unloaded account', async () => {
    const fresh = setup();
    expect(() => fresh.account.requireTrading()).toThrowError(expect.objectContaining({ code: 'NOT_CONNECTED', status: 503 }));

    const { account, exchange, ws } = setup();
    exchange.config.perm = 'read_only';
    await account.start();
    ws.isReady = true;
    expect(() => account.requireTrading()).toThrowError(expect.objectContaining({ code: 'READ_ONLY_KEY', status: 403 }));
    await account.stop();
  });
});

describe('AccountService mirror', () => {
  const NOW = 1_700_000_000_000;
  const BTC = 'BTC-USDT-SWAP';

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const rawOrder = (ordId: string, cTime: number): OkxOrder =>
    ({ ordId, clOrdId: `c${ordId}`, instId: BTC, side: 'buy', posSide: 'long', tdMode: 'cross', ordType: 'limit', px: '49000', sz: '1', accFillSz: '0', avgPx: '', state: 'live', lever: '5', fee: '0', feeCcy: '', pnl: '0', cTime: String(cTime), uTime: String(cTime) }) as unknown as OkxOrder;
  const rawPosition = (pos: string, uTime: number): OkxPosition =>
    ({ instId: BTC, posSide: 'long', mgnMode: 'cross', pos, avgPx: '50000', markPx: '50000', upl: '0', uplRatio: '0', lever: '5', liqPx: '', margin: '', notionalUsd: '500', cTime: String(uTime), uTime: String(uTime) }) as unknown as OkxPosition;
  const positionsPush = (row: OkxPosition) => ({ arg: { channel: 'positions', instType: 'SWAP' }, data: [row] });

  function mirror() {
    const exchange = {
      totalEq: '1000',
      pending: [] as OkxOrder[],
      positions: (async () => []) as () => Promise<OkxPosition[]>,
      lookup: (): OkxOrder => {
        throw new OkxApiError('51603', 'Order does not exist', '/api/v5/trade/order');
      },
      lookups: 0,
      leverage: [] as OkxLeverageInfo[],
      leverageCalls: 0,
    };
    const rest = {
      getAccountConfig: async () => ({ uid: '1', acctLv: '2', posMode: 'long_short_mode', autoLoan: false, level: 'Lv1', perm: 'read_only,trade' }),
      getBalance: async () => ({ totalEq: exchange.totalEq, uTime: String(Date.now()), details: [] }),
      getPositions: () => exchange.positions(),
      getOrdersPending: async () => exchange.pending,
      getOrder: async () => {
        exchange.lookups++;
        return exchange.lookup();
      },
      getLeverageInfo: async () => {
        exchange.leverageCalls++;
        return exchange.leverage;
      },
    };
    const ws = new FakePrivateSocket();
    const clients = { rest, wsPrivate: ws, clock: { offsetMs: 0 }, demo: false } as unknown as OkxClients;
    const account = new AccountService(clients, new MemoryStore(), log);
    const orders: Order[] = [];
    account.on('order', (o) => orders.push(o));
    return { account, exchange, ws, clients, orders };
  }

  it('drops an open order the exchange no longer knows (51603): at once when old, after two snapshots when young', async () => {
    const { account, exchange, orders } = mirror();
    exchange.pending = [rawOrder('1', NOW - 600_000), rawOrder('2', NOW)];
    await account.start();
    expect(account.openOrders.size).toBe(2);

    // both were cancelled elsewhere while this machine slept, long enough ago for OKX to have purged them
    exchange.pending = [];
    await vi.advanceTimersByTimeAsync(60_000);
    expect([...account.openOrders.keys()]).toEqual(['2']); // one minute old and missed once: may not be queryable yet
    expect(orders[orders.length - 1]).toMatchObject({ ordId: '1', state: 'canceled', uTime: NOW + 60_000 });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(account.openOrders.size).toBe(0);
    expect(orders[orders.length - 1]).toMatchObject({ ordId: '2', state: 'canceled' });

    // gone for good: not looked up again, and a late snapshot that still lists it does not bring it back
    const lookups = exchange.lookups;
    exchange.pending = [rawOrder('2', NOW)];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exchange.lookups).toBe(lookups);
    expect(account.openOrders.size).toBe(0);
    await account.stop();
  });

  it('keeps a vanished order while its state cannot be confirmed for any other reason', async () => {
    const { account, exchange } = mirror();
    exchange.pending = [rawOrder('1', NOW - 600_000)];
    await account.start();
    exchange.pending = [];
    exchange.lookup = () => {
      throw new OkxTransportError('/api/v5/trade/order', 'OKX did not answer within 10000 ms', true);
    };
    await vi.advanceTimersByTimeAsync(180_000);
    expect(exchange.lookups).toBe(3);
    expect([...account.openOrders.keys()]).toEqual(['1']);
    await account.stop();
  });

  it('a position closed by a push is not re-inserted by a REST snapshot taken before the close', async () => {
    const { account, exchange, ws } = mirror();
    await account.start();
    ws.emit('data', positionsPush(rawPosition('1', NOW + 1_000)));
    expect(account.positionList()).toHaveLength(1);

    // a reconcile reads the open position; the close is pushed before that snapshot is applied
    let release: (rows: OkxPosition[]) => void = () => undefined;
    exchange.positions = () => new Promise((resolve) => (release = resolve));
    const pulling = account.refresh();
    await vi.advanceTimersByTimeAsync(0);
    ws.emit('data', positionsPush(rawPosition('0', NOW + 2_000)));
    expect(account.positionList()).toHaveLength(0);
    release([rawPosition('1', NOW + 1_000)]);
    await pulling;
    expect(account.positionList()).toHaveLength(0);

    // reopened later: a row newer than the close is accepted again
    exchange.positions = async () => [rawPosition('2', NOW + 3_000)];
    await account.refresh();
    expect(account.positionList()).toMatchObject([{ pos: '2' }]);
    await account.stop();
  });

  it('compares exchange update times with the exchange clock, not the local one', async () => {
    const { account, exchange, ws, clients } = mirror();
    clients.clock.offsetMs = -120_000; // the clock of this machine runs two minutes ahead of OKX
    await account.start();
    let release: (rows: OkxPosition[]) => void = () => undefined;
    exchange.positions = () => new Promise((resolve) => (release = resolve));
    const pulling = account.refresh();
    await vi.advanceTimersByTimeAsync(0);
    // opened after the snapshot was taken, stamped with the exchange time
    ws.emit('data', positionsPush(rawPosition('1', NOW - 120_000 + 50)));
    release([]);
    await pulling;
    expect(account.positionList()).toHaveLength(1);
    await account.stop();
  });

  it('keeps the last total equity when the exchange reports none', async () => {
    const { account, ws } = mirror();
    const seen: Balance[] = [];
    account.on('balance', (b) => seen.push(b));
    await account.start();
    ws.emit('data', { arg: { channel: 'account' }, data: [{ totalEq: '', uTime: String(NOW + 1), details: [{ ccy: 'USDT', eq: '990', availEq: '900', cashBal: '990', upl: '0' }] }] });
    expect(account.balance).toMatchObject({ totalEq: '1000', details: [{ ccy: 'USDT', eq: '990' }] });
    expect(seen.map((b) => b.totalEq)).toEqual(['1000', '1000']);
    await account.stop();

    // nothing to keep yet: no balance at all rather than an equity of zero
    const empty = mirror();
    empty.exchange.totalEq = '';
    const first: Balance[] = [];
    empty.account.on('balance', (b) => first.push(b));
    await empty.account.start();
    expect(empty.account.balance).toBeNull();
    expect(first).toEqual([]);
    await empty.account.stop();
  });

  it('leverageFor fails when OKX reports no leverage, and reads past the cache on request', async () => {
    const { account, exchange } = mirror();
    await expect(account.leverageFor(BTC, 'cross', 'long')).rejects.toThrow(/no leverage/);
    const rows = (shortLever: string): OkxLeverageInfo[] => [{ instId: BTC, mgnMode: 'cross', posSide: 'long', lever: '5' }, { instId: BTC, mgnMode: 'cross', posSide: 'short', lever: shortLever }];
    exchange.leverage = rows('3');
    expect(await account.leverageFor(BTC, 'cross', 'short')).toBe('3');
    exchange.leverage = rows('20'); // changed on OKX
    expect(await account.leverageFor(BTC, 'cross', 'short')).toBe('3');
    expect(await account.leverageFor(BTC, 'cross', 'short', true)).toBe('20');
    expect(await account.leverageFor(BTC, 'cross', 'short')).toBe('20');
    expect(exchange.leverageCalls).toBe(3);
  });
});
