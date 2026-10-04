import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { AccountConfig, AccountStatus, ServerMessage } from '@pegasus/shared';
import type { AppConfig } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import type { AccountService } from '../src/services/account.js';
import type { MarketDataService } from '../src/services/market-data.js';
import type { RiskEngine } from '../src/services/risk-engine.js';
import { Hub } from '../src/ws/hub.js';

class FakeTerminal extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly received: ServerMessage[] = [];
  /** Whether the peer answers protocol pings, as a browser does even for a hidden tab. */
  answers = true;
  pings = 0;
  terminated = false;
  send(text: string): void {
    this.received.push(JSON.parse(text) as ServerMessage);
  }
  ping(): void {
    this.pings++;
    if (this.answers) this.emit('pong');
  }
  close(): void {
    this.readyState = 3;
  }
  terminate(): void {
    this.readyState = 3;
    this.terminated = true;
    this.emit('close');
  }
  say(msg: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }
  ofType(type: ServerMessage['type']): ServerMessage[] {
    return this.received.filter((m) => m.type === type);
  }
}

describe('Hub connection status', () => {
  let hub: Hub;
  let market: EventEmitter & { stale: string[] };
  let account: EventEmitter & { config: AccountConfig | null; accountStatus: AccountStatus };

  beforeEach(() => {
    vi.useFakeTimers();
    market = Object.assign(new EventEmitter(), {
      stale: [] as string[],
      instruments: new Map(),
      ticker: () => null,
      connection: () => ({ public: 'connected', business: 'connected', dataAgeMs: 120, staleStreams: market.stale }),
    });
    account = Object.assign(new EventEmitter(), {
      connection: () => 'connected',
      config: null as AccountConfig | null,
      accountStatus: { state: 'starting', error: null, lastSyncAt: null, readOnly: false } as AccountStatus,
      status: () => account.accountStatus,
      balance: null,
      positionList: () => [],
      openOrderList: () => [],
    });
    const risk = Object.assign(new EventEmitter(), { config: {}, state: {} });
    const log = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
    hub = new Hub({ okx: { demo: false } } as unknown as AppConfig, market as unknown as MarketDataService, account as unknown as AccountService, risk as unknown as RiskEngine, log);
    hub.wire();
  });

  afterEach(async () => {
    await hub.close();
    vi.useRealTimers();
  });

  it('is re-sent every 5 s as a heartbeat and at once when the market status changes', () => {
    const terminal = new FakeTerminal();
    hub.attach(terminal as unknown as WebSocket);
    expect(terminal.received.map((m) => m.type)).toEqual(['hello']);

    vi.advanceTimersByTime(15_000);
    expect(terminal.ofType('connection')).toHaveLength(3);
    expect(terminal.ofType('connection')[0]).toEqual({ type: 'connection', data: { okxPublic: 'connected', okxBusiness: 'connected', okxPrivate: 'connected', account: { state: 'starting', error: null, lastSyncAt: null, readOnly: false }, demo: false, dataAgeMs: 120, staleStreams: [] } });

    market.stale = ['SOL-USDT-SWAP:book'];
    market.emit('status');
    const all = terminal.ofType('connection');
    expect(all).toHaveLength(4);
    expect(all[3]).toMatchObject({ data: { staleStreams: ['SOL-USDT-SWAP:book'] } });
  });

  it('tells a terminal that connected before the account loaded what the position mode is once it is known', () => {
    const terminal = new FakeTerminal();
    hub.attach(terminal as unknown as WebSocket);
    const hello = terminal.ofType('hello')[0];
    expect(hello?.type === 'hello' && hello.data.account).toBeNull();

    account.config = { posMode: 'long_short_mode', acctLv: '2', canTrade: false };
    account.emit('config', account.config);
    expect(terminal.ofType('account')).toEqual([{ type: 'account', data: { posMode: 'long_short_mode', acctLv: '2', canTrade: false } }]);

    const late = new FakeTerminal();
    hub.attach(late as unknown as WebSocket);
    const lateHello = late.ofType('hello')[0];
    expect(lateHello?.type === 'hello' && lateHello.data.account).toEqual(account.config);
  });

  it('sends the account status with the connection status, at once when it changes', () => {
    const terminal = new FakeTerminal();
    hub.attach(terminal as unknown as WebSocket);
    account.accountStatus = { state: 'error', error: { code: '50105', message: 'Invalid OK-ACCESS-PASSPHRASE.', ts: 5 }, lastSyncAt: null, readOnly: false };
    account.emit('status');
    expect(terminal.ofType('connection')).toHaveLength(1);
    expect(terminal.ofType('connection')[0]).toMatchObject({ data: { account: { state: 'error', error: { code: '50105', message: 'Invalid OK-ACCESS-PASSPHRASE.', ts: 5 } } } });
  });

  it('stops the heartbeat on close', async () => {
    await hub.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a terminal that sends nothing for minutes (a hidden tab) as long as it answers protocol pings', () => {
    const terminal = new FakeTerminal();
    hub.attach(terminal as unknown as WebSocket);
    vi.advanceTimersByTime(5 * 60_000);
    expect(terminal.readyState).toBe(terminal.OPEN);
    expect(hub.size).toBe(1);
    expect(terminal.pings).toBe(20);
    expect(terminal.ofType('connection')).toHaveLength(60);
  });

  it('terminates a terminal that stopped answering protocol pings, within two sweeps', () => {
    const terminal = new FakeTerminal();
    const other = new FakeTerminal();
    hub.attach(terminal as unknown as WebSocket);
    hub.attach(other as unknown as WebSocket);
    vi.advanceTimersByTime(60_000);
    terminal.answers = false;
    vi.advanceTimersByTime(15_000);
    expect(terminal.terminated).toBe(false);
    vi.advanceTimersByTime(15_000);
    expect(terminal.terminated).toBe(true);
    expect(other.terminated).toBe(false);
    expect(hub.size).toBe(1);
  });

  it('still answers the application-level ping', () => {
    const terminal = new FakeTerminal();
    hub.attach(terminal as unknown as WebSocket);
    terminal.say({ type: 'ping' });
    expect(terminal.ofType('pong')).toHaveLength(1);
  });
});

describe('Hub candle subscriptions', () => {
  let hub: Hub;
  /** Reference counts as MarketDataService keeps them: moved at call time, the wire request awaited afterwards. */
  let refs: Map<string, number>;
  let overReleased: string[];
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  beforeEach(() => {
    refs = new Map();
    overReleased = [];
    const market = Object.assign(new EventEmitter(), {
      instruments: new Map(),
      ticker: () => null,
      book: () => null,
      trades: () => [],
      markPrice: () => null,
      fundingRate: () => null,
      connection: () => ({ public: 'connected', business: 'connected', dataAgeMs: 0, staleStreams: [] }),
      getInstrument: (instId: string) => (instId.endsWith('-USDT-SWAP') ? { instId } : undefined),
      subscribeCandles: async (instId: string, bar: string) => {
        const key = `${instId}:${bar}`;
        refs.set(key, (refs.get(key) ?? 0) + 1);
        await Promise.resolve();
      },
      unsubscribeCandles: async (instId: string, bar: string) => {
        const key = `${instId}:${bar}`;
        const n = (refs.get(key) ?? 0) - 1;
        if (n < 0) overReleased.push(key);
        if (n <= 0) refs.delete(key);
        else refs.set(key, n);
        await Promise.resolve();
      },
    });
    const account = Object.assign(new EventEmitter(), { connection: () => 'connected', config: null, status: () => ({ state: 'ok', error: null, lastSyncAt: 1, readOnly: false }), balance: null, positionList: () => [], openOrderList: () => [] });
    const risk = Object.assign(new EventEmitter(), { config: {}, state: {} });
    const log = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
    hub = new Hub({ okx: { demo: false } } as unknown as AppConfig, market as unknown as MarketDataService, account as unknown as AccountService, risk as unknown as RiskEngine, log);
  });

  afterEach(async () => {
    await hub.close();
  });

  async function twoWindowsOnBtc(): Promise<[FakeTerminal, FakeTerminal]> {
    const a = new FakeTerminal();
    const b = new FakeTerminal();
    hub.attach(a as unknown as WebSocket);
    hub.attach(b as unknown as WebSocket);
    a.say({ type: 'subscribe', instId: 'BTC-USDT-SWAP', bar: '1m' });
    b.say({ type: 'subscribe', instId: 'BTC-USDT-SWAP', bar: '1m' });
    await flush();
    expect([...refs]).toEqual([['BTC-USDT-SWAP:1m', 2]]);
    return [a, b];
  }

  it('an instrument switch (unsubscribe and subscribe back to back) releases the old candles once, not twice', async () => {
    const [a] = await twoWindowsOnBtc();
    a.say({ type: 'unsubscribe', instId: 'BTC-USDT-SWAP' });
    a.say({ type: 'subscribe', instId: 'ETH-USDT-SWAP', bar: '1m' });
    await flush();
    // the second window still holds BTC
    expect([...refs].sort()).toEqual([['BTC-USDT-SWAP:1m', 1], ['ETH-USDT-SWAP:1m', 1]]);
    expect(overReleased).toEqual([]);
    expect(a.ofType('subscribed').at(-1)).toEqual({ type: 'subscribed', data: { instId: 'ETH-USDT-SWAP', bar: '1m' } });
  });

  it('two switches in the same tick leave exactly the last one held', async () => {
    const [a] = await twoWindowsOnBtc();
    a.say({ type: 'subscribe', instId: 'ETH-USDT-SWAP', bar: '5m' });
    a.say({ type: 'setBar', instId: 'ETH-USDT-SWAP', bar: '1H' });
    a.say({ type: 'subscribe', instId: 'SOL-USDT-SWAP' });
    await flush();
    expect([...refs].sort()).toEqual([['BTC-USDT-SWAP:1m', 1], ['SOL-USDT-SWAP:1H', 1]]);
    expect(overReleased).toEqual([]);
  });

  it('a terminal that goes away in the middle of a switch holds nothing afterwards', async () => {
    const [a, b] = await twoWindowsOnBtc();
    a.say({ type: 'subscribe', instId: 'ETH-USDT-SWAP', bar: '1m' });
    a.terminate();
    await flush();
    expect([...refs]).toEqual([['BTC-USDT-SWAP:1m', 1]]);
    b.say({ type: 'unsubscribe', instId: 'BTC-USDT-SWAP' });
    b.say({ type: 'unsubscribe', instId: 'BTC-USDT-SWAP' });
    await flush();
    expect([...refs]).toEqual([]);
    expect(overReleased).toEqual([]);
  });
});
