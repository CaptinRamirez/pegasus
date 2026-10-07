import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OkxApiError, OkxTransportError, type OkxLeverageInfo, type OkxMarginBalanceParams, type OkxOrder, type OkxOrderAck, type OkxPlaceOrderParams, type OkxSetLeverageParams } from '@pegasus/okx';
import { D, type Instrument, type PlaceOrderRequest, type RiskConfig } from '@pegasus/shared';
import { pino } from 'pino';
import { MemoryStore } from '../src/db/store.js';
import { UnknownInstrumentError } from '../src/errors.js';
import type { OkxClients } from '../src/okx/clients.js';
import { AccountService } from '../src/services/account.js';
import type { MarketDataService } from '../src/services/market-data.js';
import { OrderService } from '../src/services/order-service.js';
import { RiskEngine } from '../src/services/risk-engine.js';

const log = pino({ level: 'silent' });

describe('OrderService with an unknown position mode', () => {
  it('answers NOT_CONNECTED instead of previewing the order as net mode', async () => {
    const market = { requireInstrument: () => ({ instId: 'BTC-USDT-SWAP' }) } as unknown as MarketDataService;
    const account = new AccountService({ rest: {}, wsPrivate: new EventEmitter() } as unknown as OkxClients, new MemoryStore(), log);
    expect(account.config).toBeNull();
    const orders = new OrderService({} as OkxClients, market, account, {} as RiskEngine, new MemoryStore(), log, { defaultTdMode: 'cross', wsTrading: false });
    const req: PlaceOrderRequest = { instId: 'BTC-USDT-SWAP', side: 'buy', ordType: 'limit', px: '50000', size: { unit: 'contracts', value: '1' } };
    await expect(orders.preview(req)).rejects.toMatchObject({ code: 'NOT_CONNECTED', status: 503 });
  });
});

describe('OrderService cancel and close while the private stream is down', () => {
  class DownSocket extends EventEmitter {
    isReady = false;
    currentStatus = 'disconnected';
    async subscribe(): Promise<void> {}
    connect(): void {}
    async close(): Promise<void> {}
  }

  async function setup(perm = 'read_only,trade') {
    const sent: Array<{ op: string; params: unknown }> = [];
    const open = { ordId: '7', clOrdId: 'c7', instId: 'BTC-USDT-SWAP', side: 'buy', posSide: 'long', tdMode: 'cross', ordType: 'limit', px: '49000', sz: '1', accFillSz: '0', avgPx: '', state: 'live', lever: '5', fee: '0', feeCcy: '', pnl: '0', cTime: '1', uTime: '1' };
    const rest = {
      getAccountConfig: async () => ({ uid: '1', acctLv: '2', posMode: 'long_short_mode', autoLoan: false, level: 'Lv1', perm }),
      getBalance: async () => ({ totalEq: '1000', uTime: '1', details: [] }),
      getPositions: async () => [],
      getOrdersPending: async () => [open],
      cancelOrder: async (params: unknown) => {
        sent.push({ op: 'cancel', params });
        return { ordId: '7', clOrdId: 'c7', tag: '', sCode: '0', sMsg: '' };
      },
      cancelBatchOrders: async (params: unknown) => {
        sent.push({ op: 'cancel-batch', params });
        return [{ ordId: '7', clOrdId: 'c7', tag: '', sCode: '0', sMsg: '' }];
      },
      closePosition: async (params: unknown) => {
        sent.push({ op: 'close', params });
        return [];
      },
    };
    const clients = { rest, wsPrivate: new DownSocket(), clock: { offsetMs: 0 }, demo: false } as unknown as OkxClients;
    const store = new MemoryStore();
    const account = new AccountService(clients, store, log);
    await account.start();
    expect(account.ready).toBe(false);
    // only the tracked instrument is known to the market service
    const market = {
      requireInstrument: (instId: string) => {
        if (instId !== 'BTC-USDT-SWAP') throw new UnknownInstrumentError(instId);
        return { instId };
      },
    } as unknown as MarketDataService;
    const orders = new OrderService(clients, market, account, {} as RiskEngine, store, log, { defaultTdMode: 'cross', wsTrading: true });
    return { orders, account, sent };
  }

  it('cancel, cancelAll and closePosition go out over REST without the private socket', async () => {
    const { orders, account, sent } = await setup();
    expect(await orders.cancel({ instId: 'BTC-USDT-SWAP', ordId: '7' })).toMatchObject({ ordId: '7' });
    expect(await orders.cancelAll()).toBe(1);
    expect(await orders.closePosition({ instId: 'BTC-USDT-SWAP', mgnMode: 'cross', posSide: 'long' })).toEqual({ instId: 'BTC-USDT-SWAP', posSide: 'long' });
    expect(sent.map((s) => s.op)).toEqual(['cancel', 'cancel-batch', 'close']);
    expect(sent[1]?.params).toEqual([{ instId: 'BTC-USDT-SWAP', ordId: '7' }]);
    // placing an order still needs the stream: its risk checks read the live mirror
    expect(() => account.requireTrading()).toThrowError(expect.objectContaining({ code: 'NOT_CONNECTED' }));
    await account.stop();
  });

  it('closes a position in an instrument the server does not track', async () => {
    const { orders, account, sent } = await setup();
    expect(await orders.closePosition({ instId: 'PEPE-USDT-SWAP', mgnMode: 'isolated', posSide: 'short' })).toEqual({ instId: 'PEPE-USDT-SWAP', posSide: 'short' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.params).toMatchObject({ instId: 'PEPE-USDT-SWAP', mgnMode: 'isolated', posSide: 'short', autoCxl: true });
    await account.stop();
  });

  it('still refuses a read-only key and an account that is not loaded', async () => {
    const readOnly = await setup('read_only');
    await expect(readOnly.orders.cancel({ instId: 'BTC-USDT-SWAP', ordId: '7' })).rejects.toMatchObject({ code: 'READ_ONLY_KEY', status: 403 });
    await expect(readOnly.orders.cancelAll()).rejects.toMatchObject({ code: 'READ_ONLY_KEY' });
    await expect(readOnly.orders.closePosition({ instId: 'BTC-USDT-SWAP', mgnMode: 'cross', posSide: 'long' })).rejects.toMatchObject({ code: 'READ_ONLY_KEY' });
    expect(readOnly.sent).toEqual([]);
    await readOnly.account.stop();

    const account = new AccountService({ rest: {}, wsPrivate: new DownSocket() } as unknown as OkxClients, new MemoryStore(), log);
    const orders = new OrderService({} as OkxClients, {} as MarketDataService, account, {} as RiskEngine, new MemoryStore(), log, { defaultTdMode: 'cross', wsTrading: false });
    await expect(orders.cancelAll()).rejects.toMatchObject({ code: 'NOT_CONNECTED', status: 503 });
  });
});

describe('OrderService order path against a stubbed exchange', () => {
  const NOW = 1_700_000_000_000;
  const BTC: Instrument = {
    instId: 'BTC-USDT-SWAP', instType: 'SWAP', uly: 'BTC-USDT', baseCcy: 'BTC', quoteCcy: 'USDT', settleCcy: 'USDT',
    ctVal: '0.01', ctValCcy: 'BTC', ctMult: '1', ctType: 'linear', lotSz: '0.1', minSz: '0.1', tickSz: '0.1',
    maxLmtSz: '100000', maxMktSz: '12000', maxLever: '100', state: 'live',
  };
  const riskConfig: RiskConfig = {
    maxOrderNotional: '20000', maxPositionNotionalPerInstrument: '20000', maxTotalPositionNotional: '30000', maxLeverage: '10',
    dailyLossLimit: '1000', maxOpenOrders: 5, priceBandPct: '0.05', maxSlippagePct: '0.005',
  };

  class ReadySocket extends EventEmitter {
    isReady = true;
    currentStatus = 'connected';
    request = vi.fn();
    async subscribe(): Promise<void> {}
    connect(): void {}
    async close(): Promise<void> {}
  }

  const notFound = (): never => {
    throw new OkxApiError('51603', 'Order does not exist', '/api/v5/trade/order');
  };

  async function harness(opts: { posMode?: 'net_mode' | 'long_short_mode'; wsTrading?: boolean } = {}) {
    const posMode = opts.posMode ?? 'long_short_mode';
    const exchange = {
      lever: '5',
      leverageRows: null as OkxLeverageInfo[] | null,
      leverageFails: false,
      leverageCalls: 0,
      bookSynced: true,
      /** The mark price the market service reports */
      mark: '50000',
      /** false: the mark stream is stale, refPrice falls back to the last price */
      markLive: true,
      placed: [] as OkxPlaceOrderParams[],
      /** What the exchange does with an order after recording it; the default acknowledges it. */
      answer: (params: OkxPlaceOrderParams, n: number): OkxOrderAck | Promise<OkxOrderAck> => ({ ordId: `o${n}`, clOrdId: params.clOrdId ?? '', tag: '', sCode: '0', sMsg: '' }),
      lookup: notFound as (clOrdId: string) => OkxOrder,
      lookups: 0,
      /** What went to the margin-balance and set-leverage endpoints */
      margins: [] as OkxMarginBalanceParams[],
      levers: [] as OkxSetLeverageParams[],
    };
    const rest = {
      adjustMargin: async (params: OkxMarginBalanceParams) => {
        exchange.margins.push(params);
        return { instId: params.instId, posSide: params.posSide, amt: params.amt, type: params.type, leverage: '10', ccy: 'USDT' };
      },
      setLeverage: async (params: OkxSetLeverageParams) => {
        exchange.levers.push(params);
        return [{ instId: params.instId ?? '', mgnMode: params.mgnMode, posSide: params.posSide ?? 'net', lever: params.lever }];
      },
      getAccountConfig: async () => ({ uid: '1', acctLv: '2', posMode, autoLoan: false, level: 'Lv1', perm: 'read_only,trade' }),
      getBalance: async () => ({ totalEq: '100000', uTime: '1', details: [] }),
      getPositions: async () => [],
      getOrdersPending: async () => [],
      getLeverageInfo: async (instId: string): Promise<OkxLeverageInfo[]> => {
        exchange.leverageCalls++;
        if (exchange.leverageFails) throw new OkxApiError('50001', 'Service temporarily unavailable', '/api/v5/account/leverage-info');
        if (exchange.leverageRows) return exchange.leverageRows;
        const sides = posMode === 'long_short_mode' ? (['long', 'short'] as const) : (['net'] as const);
        return sides.map((posSide) => ({ instId, mgnMode: 'cross', posSide, lever: exchange.lever }));
      },
      placeOrder: async (params: OkxPlaceOrderParams) => {
        exchange.placed.push(params);
        return exchange.answer(params, exchange.placed.length);
      },
      getOrder: async (q: { clOrdId?: string }) => {
        exchange.lookups++;
        return exchange.lookup(q.clOrdId ?? '');
      },
    };
    const ws = new ReadySocket();
    const clients = { rest, wsPrivate: ws, clock: { offsetMs: 0 }, demo: false } as unknown as OkxClients;
    const store = new MemoryStore();
    const account = new AccountService(clients, store, log);
    await account.start();
    const market = {
      requireInstrument: (instId: string) => {
        if (instId !== BTC.instId) throw new UnknownInstrumentError(instId);
        return BTC;
      },
      specOf: (instId: string) => (instId === BTC.instId ? BTC : undefined),
      bestPrice: () => (exchange.bookSynced ? '50000' : undefined),
      refPrice: () => exchange.mark,
      liveMarkPrice: () => (exchange.markLive ? exchange.mark : undefined),
      estimateMarketFill: () => (exchange.bookSynced ? { avgPx: '50000', slippagePct: '0', complete: true } : null),
    } as unknown as MarketDataService;
    const risk = new RiskEngine(riskConfig, store, log);
    const orders = new OrderService(clients, market, account, risk, store, log, { defaultTdMode: 'cross', wsTrading: opts.wsTrading ?? false });
    return { orders, account, risk, exchange, ws };
  }

  /** contracts * 0.01 BTC * 50,000 = 500 USD per contract */
  const order = (overrides: Partial<PlaceOrderRequest> = {}): PlaceOrderRequest => ({ instId: BTC.instId, side: 'buy', posSide: 'long', ordType: 'market', size: { unit: 'contracts', value: '30' }, ...overrides });
  const rawOrder = (clOrdId: string, overrides: Partial<Record<keyof OkxOrder, string>> = {}): OkxOrder =>
    ({ ordId: '77', clOrdId, instId: BTC.instId, side: 'buy', posSide: 'long', tdMode: 'cross', ordType: 'market', px: '', sz: '30', accFillSz: '0', avgPx: '', state: 'live', lever: '5', fee: '0', feeCcy: '', pnl: '0', cTime: String(NOW), uTime: String(NOW), ...overrides }) as unknown as OkxOrder;
  const positionPush = (pos: string, uTime: number, posSide = 'long') => ({
    arg: { channel: 'positions', instType: 'SWAP' },
    data: [{ instId: BTC.instId, posSide, mgnMode: 'cross', pos, avgPx: '50000', markPx: '50000', notionalUsd: D(pos).times(500).toFixed(), cTime: String(uTime), uTime: String(uTime) }],
  });
  /** A REST submit that hangs until the client's 10 s timeout */
  const hang = (): Promise<OkxOrderAck> =>
    new Promise((_, reject) => setTimeout(() => reject(new OkxTransportError('/api/v5/trade/order', 'request timed out', true)), 10_000));
  const settle = <T>(p: Promise<T>): Promise<T | { code: string; status: number; details?: Record<string, unknown> }> => p.catch((e: { code: string; status: number }) => e);

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('REST: an OKX timeout code (51149, 50004) is an unknown outcome, looked up by clOrdId and never reported as a rejection', async () => {
    const h = await harness();
    for (const code of ['51149', '50004']) {
      h.exchange.answer = () => {
        throw new OkxApiError(code, 'Order timed out', '/api/v5/trade/order');
      };
      // the order did arrive
      h.exchange.lookup = (clOrdId) => rawOrder(clOrdId, { ordId: `found-${code}` });
      const placed = await h.orders.place(order({ side: 'sell', clOrdId: `c${code}` }));
      expect(placed.order).toMatchObject({ ordId: `found-${code}`, clOrdId: `c${code}` });
    }
    expect(h.exchange.placed).toHaveLength(2); // one attempt each: never resent

    // it did not arrive, as far as can be told: unknown, not rejected
    h.exchange.lookup = notFound;
    const pending = settle(h.orders.place(order({ side: 'sell' })));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toMatchObject({ code: 'ORDER_STATUS_UNKNOWN', status: 504 });
    expect(h.exchange.placed).toHaveLength(3);

    // a real refusal is still a refusal, without any lookup
    const lookups = h.exchange.lookups;
    h.exchange.answer = () => {
      throw new OkxApiError('51008', 'Order failed. Insufficient margin', '/api/v5/trade/order');
    };
    expect(await settle(h.orders.place(order({ side: 'sell' })))).toMatchObject({ code: 'EXCHANGE', status: 502, details: { okxCode: '51008' } });
    expect(h.exchange.lookups).toBe(lookups);
    await h.account.stop();
  });

  it('WebSocket: a timeout sCode is looked up as well, and the order is not resent over REST', async () => {
    const h = await harness({ wsTrading: true });
    h.ws.request.mockImplementation(async (_op: string, args: OkxPlaceOrderParams[]) => ({ id: '1', op: 'order', code: '1', msg: '', data: [{ ordId: '', clOrdId: args[0]?.clOrdId ?? '', tag: '', sCode: '51149', sMsg: 'Order timed out' }] }));
    h.exchange.lookup = (clOrdId) => rawOrder(clOrdId, { ordId: '88' });
    const placed = await h.orders.place(order({ side: 'sell' }));
    expect(placed.order.ordId).toBe('88');
    expect(h.ws.request).toHaveBeenCalledTimes(1);
    expect(h.exchange.placed).toEqual([]);

    h.exchange.lookup = notFound;
    const pending = settle(h.orders.place(order({ side: 'sell' })));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toMatchObject({ code: 'ORDER_STATUS_UNKNOWN', status: 504 });
    expect(h.exchange.placed).toEqual([]);
    await h.account.stop();
  });

  it('an exit does not need the leverage or a synced book; an opening order still fails closed on both', async () => {
    const h = await harness();
    h.exchange.leverageFails = true;
    const limit = { ordType: 'limit', px: '50000' } as const;
    expect(await settle(h.orders.preview(order(limit)))).toMatchObject({ code: 'LEVERAGE_UNAVAILABLE', status: 503 });
    const calls = h.exchange.leverageCalls;
    expect(await h.orders.preview(order({ ...limit, side: 'sell' }))).toMatchObject({ posSide: 'long', lever: '', risk: { ok: true } });
    expect(h.exchange.leverageCalls).toBe(calls); // not even asked

    h.exchange.leverageFails = false;
    h.exchange.bookSynced = false;
    expect(await settle(h.orders.preview(order()))).toMatchObject({ code: 'NO_BOOK', status: 503 });
    expect(await h.orders.preview(order({ side: 'sell' }))).toMatchObject({ estSlippagePct: '', lever: '', refPrice: '50000', notionalQuote: '15000', risk: { ok: true } });

    // both at once, with the kill switch on: the exit still goes out
    h.exchange.leverageFails = true;
    h.risk.setKillSwitch(true, 'test');
    await h.orders.place(order({ side: 'sell' }));
    expect(h.exchange.placed).toMatchObject([{ side: 'sell', posSide: 'long', ordType: 'market', sz: '30' }]);
    expect(await settle(h.orders.place(order({ ...limit, posSide: 'short', side: 'sell' })))).toMatchObject({ code: 'LEVERAGE_UNAVAILABLE' });
    expect(h.exchange.placed).toHaveLength(1);
    await h.account.stop();
  });

  it('net mode: a reduce-only order is an exit too', async () => {
    const h = await harness({ posMode: 'net_mode' });
    h.exchange.leverageFails = true;
    h.exchange.bookSynced = false;
    const net: PlaceOrderRequest = { instId: BTC.instId, side: 'sell', ordType: 'market', size: { unit: 'contracts', value: '30' } };
    expect(await settle(h.orders.preview(net))).toMatchObject({ code: 'NO_BOOK' });
    await h.orders.place({ ...net, reduceOnly: true });
    expect(h.exchange.placed).toMatchObject([{ side: 'sell', reduceOnly: true }]);
    expect(h.exchange.placed[0]).not.toHaveProperty('posSide');
    await h.account.stop();
  });

  it('the leverage rule fails closed on an empty reply, and an order is checked against the leverage OKX has now', async () => {
    const h = await harness();
    h.exchange.leverageRows = [];
    expect(await settle(h.orders.preview(order()))).toMatchObject({ code: 'LEVERAGE_UNAVAILABLE', status: 503 });
    h.exchange.leverageRows = null;

    expect(await h.orders.preview(order())).toMatchObject({ lever: '5', risk: { ok: true } });
    h.exchange.lever = '50'; // raised on OKX itself
    const calls = h.exchange.leverageCalls;
    expect(await h.orders.preview(order())).toMatchObject({ lever: '5', risk: { ok: true } }); // previews use the cache
    expect(h.exchange.leverageCalls).toBe(calls);
    expect(await settle(h.orders.place(order()))).toMatchObject({ code: 'RISK_REJECTED', details: { code: 'MAX_LEVERAGE', details: { lever: '50' } } });
    expect(h.exchange.placed).toEqual([]);
    await h.account.stop();
  });

  it('concurrent orders cannot all pass on the same snapshot: an accepted order is reserved against the limits', async () => {
    const h = await harness();
    // three market buys of 15,000 against a per-instrument limit of 20,000, before any push arrives
    const results = await Promise.all([settle(h.orders.place(order())), settle(h.orders.place(order())), settle(h.orders.place(order()))]);
    expect(results[0]).toHaveProperty('order');
    for (const refused of results.slice(1)) expect(refused).toMatchObject({ code: 'RISK_REJECTED', details: { code: 'MAX_POSITION_NOTIONAL', details: { current: '15000.00' } } });
    expect(h.exchange.placed).toHaveLength(1);
    await h.account.stop();
  });

  it('a reservation ends when the positions show the fill, and is not counted twice with it', async () => {
    const h = await harness();
    const placed = await h.orders.place(order());
    const current = async (): Promise<unknown> => (await h.orders.preview(order())).risk.details?.['current'];
    expect(await current()).toBe('15000.00');

    // the fill is pushed on the orders channel first: the order is gone, the position is not there yet
    h.ws.emit('data', { arg: { channel: 'orders', instType: 'SWAP' }, data: [rawOrder(placed.order.clOrdId, { ordId: placed.order.ordId, state: 'filled', accFillSz: '30', uTime: String(NOW + 40) })] });
    expect(h.account.openOrders.size).toBe(0);
    expect(await current()).toBe('15000.00');

    h.ws.emit('data', { arg: { channel: 'positions', instType: 'SWAP' }, data: [{ instId: BTC.instId, posSide: 'long', mgnMode: 'cross', pos: '30', avgPx: '50000', markPx: '50000', notionalUsd: '15000', cTime: String(NOW + 40), uTime: String(NOW + 40) }] });
    expect(await current()).toBe('15000.00'); // the position, not position + reservation
    await h.account.stop();
  });

  it('a reservation is freed by a definite refusal and by a cancel without a fill, kept on an unknown outcome, and never outlives 10 s', async () => {
    const h = await harness();
    const acknowledge = h.exchange.answer;

    // refused by the exchange: nothing is held
    h.exchange.answer = () => {
      throw new OkxApiError('51008', 'Order failed. Insufficient margin', '/api/v5/trade/order');
    };
    expect(await settle(h.orders.place(order()))).toMatchObject({ code: 'EXCHANGE' });
    h.exchange.answer = acknowledge;

    // a resting order counts once (as the resting order), and nothing is left when it is cancelled unfilled
    const limit = await h.orders.place(order({ ordType: 'limit', px: '50000' }));
    expect((await h.orders.preview(order())).risk).toMatchObject({ ok: false, details: { current: '15000.00' } });
    h.ws.emit('data', { arg: { channel: 'orders', instType: 'SWAP' }, data: [rawOrder(limit.order.clOrdId, { ordId: limit.order.ordId, ordType: 'limit', px: '50000', state: 'canceled', uTime: String(NOW + 40) })] });
    expect((await h.orders.preview(order())).risk.ok).toBe(true);

    // unknown outcome: the order may be live, so it stays reserved ...
    h.exchange.answer = () => {
      throw new OkxApiError('51149', 'Order timed out', '/api/v5/trade/order');
    };
    const unknown = settle(h.orders.place(order({ clOrdId: 'retry1' })));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await unknown).toMatchObject({ code: 'ORDER_STATUS_UNKNOWN' });
    expect((await h.orders.preview(order())).risk).toMatchObject({ ok: false, code: 'MAX_POSITION_NOTIONAL' });
    // ... but a retry under the same clOrdId is the same order, and OKX answering "duplicate" proves the first one arrived
    h.exchange.answer = () => {
      throw new OkxApiError('51016', 'Client order ID already exists', '/api/v5/trade/order');
    };
    const duplicate = settle(h.orders.place(order({ clOrdId: 'retry1' })));
    await vi.advanceTimersByTimeAsync(1_000); // the retry looks the first attempt up twice, a pause apart, before it goes out
    expect(await duplicate).toMatchObject({ code: 'EXCHANGE', details: { okxCode: '51016' } });
    expect((await h.orders.preview(order())).risk.ok).toBe(false);

    // no push ever arrives: the reservation still cannot leak
    await vi.advanceTimersByTimeAsync(9_999);
    expect((await h.orders.preview(order())).risk.ok).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await h.orders.preview(order())).risk.ok).toBe(true);
    await h.account.stop();
  });

  it('a retry under the clOrdId of an unknown outcome is answered with the first attempt when that one reached OKX, and nothing is sent twice', async () => {
    const h = await harness();
    const acknowledge = h.exchange.answer;
    const outage = (): never => {
      throw new OkxTransportError('/api/v5/trade/order', 'socket hang up', false);
    };
    // OKX fills the market order, but the reply and every lookup are lost in the same outage
    h.exchange.answer = outage;
    h.exchange.lookup = outage;
    const first = settle(h.orders.place(order({ clOrdId: 'x1' })));
    await vi.advanceTimersByTimeAsync(3_000);
    const unknown = await first;
    expect(unknown).toMatchObject({ code: 'ORDER_STATUS_UNKNOWN', status: 504, message: expect.stringContaining('positions, fills and open orders') });
    expect(h.exchange.placed).toHaveLength(1);

    // the outage is over for orders but the lookup still fails: the retry must not go out blind
    h.exchange.answer = acknowledge;
    expect(await settle(h.orders.place(order({ clOrdId: 'x1' })))).toMatchObject({ code: 'ORDER_STATUS_UNKNOWN', status: 504 });
    expect(h.exchange.placed).toHaveLength(1);

    // a filled order has freed its clOrdId, so OKX would accept the retry: it is answered with the first order instead
    h.exchange.lookup = (clOrdId) => rawOrder(clOrdId, { ordId: 'first', state: 'filled', accFillSz: '30', avgPx: '50000' });
    const retried = await h.orders.place(order({ clOrdId: 'x1' }));
    expect(retried.order).toMatchObject({ ordId: 'first', clOrdId: 'x1', state: 'filled', accFillSz: '30' });
    expect(retried.preview).toMatchObject({ sz: '30', posSide: 'long', notionalQuote: '15000', risk: { ok: true } });
    expect(h.exchange.placed).toHaveLength(1);
    await h.account.stop();
  });

  it('the retry is submitted once when OKX says twice that the first attempt does not exist; an order under a new id is never looked up first', async () => {
    const h = await harness();
    const acknowledge = h.exchange.answer;
    h.exchange.answer = () => {
      throw new OkxTransportError('/api/v5/trade/order', 'connect ECONNRESET', false);
    };
    const first = settle(h.orders.place(order({ clOrdId: 'y1' })));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await first).toMatchObject({ code: 'ORDER_STATUS_UNKNOWN' });
    expect(h.exchange.placed).toHaveLength(1);

    h.exchange.answer = acknowledge;
    // "does not exist" once is not proof that the first attempt is not in flight: the lookup is repeated after a pause
    const retry = h.orders.place(order({ clOrdId: 'y1' }));
    await vi.advanceTimersByTimeAsync(1_000);
    const retried = await retry;
    expect(retried.order).toMatchObject({ ordId: 'o2', clOrdId: 'y1', state: 'live' });
    expect(h.exchange.placed).toHaveLength(2);

    // an acknowledged order is remembered too: the reply may have been lost on the way to the page
    h.exchange.lookup = (clOrdId) => rawOrder(clOrdId, { ordId: 'o2', state: 'filled', accFillSz: '30', avgPx: '50000' });
    expect((await h.orders.place(order({ clOrdId: 'y1' }))).order).toMatchObject({ ordId: 'o2', state: 'filled' });
    expect(h.exchange.placed).toHaveLength(2);

    // a definite refusal is forgotten, and a first submit pays no extra round trip
    h.exchange.answer = () => {
      throw new OkxApiError('51008', 'Order failed. Insufficient margin', '/api/v5/trade/order');
    };
    expect(await settle(h.orders.place(order({ side: 'sell', clOrdId: 'z1' })))).toMatchObject({ code: 'EXCHANGE' });
    h.exchange.answer = acknowledge;
    const lookups = h.exchange.lookups;
    await h.orders.place(order({ side: 'sell', clOrdId: 'z1' }));
    await h.orders.place(order({ side: 'sell' }));
    expect(h.exchange.lookups).toBe(lookups);
    expect(h.exchange.placed).toHaveLength(5);
    await h.account.stop();
  });

  it('a retry marked by the page is looked up even when this process never saw the first attempt (API restarted in between)', async () => {
    // a fresh service: the first attempt went out through a process that is gone
    const h = await harness();
    // OKX filled it, which freed the id: sent blind, the retry would execute a second time
    h.exchange.lookup = (clOrdId) => rawOrder(clOrdId, { ordId: 'first', state: 'filled', accFillSz: '30', avgPx: '50000' });
    const retried = await h.orders.place(order({ clOrdId: 'r1', retry: true }));
    expect(retried.order).toMatchObject({ ordId: 'first', clOrdId: 'r1', state: 'filled', accFillSz: '30' });
    expect(h.exchange.placed).toHaveLength(0);

    // the lookup fails: nothing goes out
    h.exchange.lookup = () => {
      throw new OkxTransportError('/api/v5/trade/order', 'socket hang up', false);
    };
    expect(await settle(h.orders.place(order({ clOrdId: 'r2', retry: true })))).toMatchObject({ code: 'ORDER_STATUS_UNKNOWN', status: 504 });
    expect(h.exchange.placed).toHaveLength(0);

    // OKX never had it: nothing goes out on the first "does not exist", the lookup is repeated after a pause, then sent exactly once
    h.exchange.lookup = notFound;
    const lookups = h.exchange.lookups;
    const sending = h.orders.place(order({ clOrdId: 'r3', retry: true }));
    await vi.advanceTimersByTimeAsync(999);
    expect(h.exchange.lookups).toBe(lookups + 1);
    expect(h.exchange.placed).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const sent = await sending;
    expect(sent.order).toMatchObject({ ordId: 'o1', clOrdId: 'r3', state: 'live' });
    expect(h.exchange.lookups).toBe(lookups + 2);
    expect(h.exchange.placed).toHaveLength(1);
    expect(h.exchange.placed[0]).not.toHaveProperty('retry');
    await h.account.stop();
  });

  it('an earlier attempt that shows up only on the second lookup is answered with, and nothing is sent', async () => {
    const h = await harness();
    let calls = 0;
    h.exchange.lookup = (clOrdId) => {
      calls += 1;
      if (calls === 1) notFound();
      return rawOrder(clOrdId, { ordId: 'late', state: 'live' });
    };
    const pending = h.orders.place(order({ clOrdId: 'r9', retry: true }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).order).toMatchObject({ ordId: 'late', clOrdId: 'r9', state: 'live' });
    expect(h.exchange.placed).toHaveLength(0);
    expect(h.exchange.lookups).toBe(2);
    await h.account.stop();
  });

  it('a submit that hangs keeps its reservation through the timeout and the lookup; the 10 s start when the outcome is known to be unknown', async () => {
    const h = await harness();
    const refused = async (): Promise<boolean> => (await h.orders.preview(order())).risk.code === 'MAX_POSITION_NOTIONAL';
    h.exchange.answer = hang;
    const first = settle(h.orders.place(order()));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await refused()).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000); // the REST timeout fires; the lookup by clOrdId starts
    expect(await refused()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await refused()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await first).toMatchObject({ code: 'ORDER_STATUS_UNKNOWN', status: 504 });
    expect(h.exchange.placed).toHaveLength(1);

    // the order may be live: still held, and released 10 s after the outcome settled (no leak)
    await vi.advanceTimersByTimeAsync(9_999);
    expect(await refused()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect((await h.orders.preview(order())).risk.ok).toBe(true);
    await h.account.stop();
  });

  it('a submit that timed out but is found by the lookup is reserved for 10 s from that acknowledgement', async () => {
    const h = await harness();
    const refused = async (): Promise<boolean> => (await h.orders.preview(order())).risk.code === 'MAX_POSITION_NOTIONAL';
    h.exchange.answer = hang;
    h.exchange.lookup = (clOrdId) => (h.exchange.lookups < 2 ? notFound() : rawOrder(clOrdId, { ordId: 'late' }));
    const first = settle(h.orders.place(order()));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await refused()).toBe(true); // a check between the timeout and the answer must not drop it
    await vi.advanceTimersByTimeAsync(500);
    expect(await first).toMatchObject({ order: { ordId: 'late' } });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(await refused()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect((await h.orders.preview(order())).risk.ok).toBe(true);
    await h.account.stop();
  });

  it('a fill whose positions push arrives before its order push is not counted twice', async () => {
    const h = await harness();
    const placed = await h.orders.place(order());
    h.ws.emit('data', positionPush('30', NOW + 40));
    h.ws.emit('data', { arg: { channel: 'orders', instType: 'SWAP' }, data: [rawOrder(placed.order.clOrdId, { ordId: placed.order.ordId, state: 'filled', accFillSz: '30', uTime: String(NOW + 40) })] });
    expect((await h.orders.preview(order())).risk.details?.['current']).toBe('15000.00');
    // 15,000 held + 4,000 is inside the 20,000 limit, without waiting for the reservation to expire
    expect((await h.orders.preview(order({ size: { unit: 'contracts', value: '8' } }))).risk.ok).toBe(true);
    await h.account.stop();
  });

  it('a partial fill is counted once, in either push order, and stays reserved until the positions show it', async () => {
    for (const positionsFirst of [false, true]) {
      const h = await harness();
      const current = async (): Promise<unknown> => (await h.orders.preview(order())).risk.details?.['current'];
      const placed = await h.orders.place(order({ ordType: 'limit', px: '50000' }));
      const partial = { arg: { channel: 'orders', instType: 'SWAP' }, data: [rawOrder(placed.order.clOrdId, { ordId: placed.order.ordId, ordType: 'limit', px: '50000', state: 'partially_filled', accFillSz: '20', uTime: String(NOW + 40) })] };
      if (positionsFirst) {
        h.ws.emit('data', positionPush('20', NOW + 40));
        expect(await current()).toBe('25000.00'); // the fill is not known to be this order's yet: fail closed
        h.ws.emit('data', partial);
      } else {
        h.ws.emit('data', partial);
        // the fill is in neither the positions nor the resting order: it must stay reserved
        expect(await current()).toBe('15000.00');
        h.ws.emit('data', positionPush('20', NOW + 40));
      }
      // 10,000 position + 5,000 resting
      expect(await current()).toBe('15000.00');
      expect((await h.orders.preview(order({ size: { unit: 'contracts', value: '8' } }))).risk.ok).toBe(true);
      await h.account.stop();
    }
  });

  describe('attached stop-loss', () => {
    /** 2 contracts * 0.01 BTC = 0.02 BTC, 1,000 USD at 50,000 */
    const small = (overrides: Partial<PlaceOrderRequest> = {}): PlaceOrderRequest => order({ ordType: 'limit', px: '50000', size: { unit: 'contracts', value: '2' }, ...overrides });

    it('is refused on a closing order, in long/short mode and in net mode', async () => {
      const h = await harness();
      const closing = small({ side: 'sell', posSide: 'long', slTriggerPx: '51000' });
      expect(await settle(h.orders.preview(closing))).toMatchObject({ code: 'VALIDATION', status: 400 });
      expect(await settle(h.orders.place(closing))).toMatchObject({ code: 'VALIDATION', status: 400 });
      expect(h.exchange.placed).toEqual([]);
      await h.account.stop();

      const net = await harness({ posMode: 'net_mode' });
      const reduce: PlaceOrderRequest = { instId: BTC.instId, side: 'sell', ordType: 'limit', px: '50000', size: { unit: 'contracts', value: '2' }, reduceOnly: true, slTriggerPx: '51000' };
      expect(await settle(net.orders.place(reduce))).toMatchObject({ code: 'VALIDATION', status: 400 });
      expect(net.exchange.placed).toEqual([]);
      // the same order opening a short carries it
      await net.orders.place({ ...reduce, reduceOnly: false });
      expect(net.exchange.placed).toMatchObject([{ side: 'sell', attachAlgoOrds: [{ slTriggerPx: '51000' }] }]);
      await net.account.stop();
    });

    it('is refused on the wrong side of the order price or of the mark price, with both prices in the details', async () => {
      const h = await harness();
      // a buy: at or above the limit price
      for (const slTriggerPx of ['50000', '50500']) {
        expect(await settle(h.orders.place(small({ slTriggerPx })))).toMatchObject({ code: 'VALIDATION', status: 400, details: { slTriggerPx, refPrice: '50000', markPx: '50000' } });
      }
      // below the limit price but not below the mark: a mark-triggered stop would fire at once
      h.exchange.mark = '49000';
      expect(await settle(h.orders.place(small({ slTriggerPx: '49500' })))).toMatchObject({ code: 'VALIDATION', status: 400, details: { slTriggerPx: '49500', refPrice: '50000', markPx: '49000' } });
      expect(await settle(h.orders.place(small({ slTriggerPx: '49000' })))).toMatchObject({ code: 'VALIDATION' });
      expect((await h.orders.preview(small({ slTriggerPx: '48999.9' }))).slTriggerPx).toBe('48999.9');

      // a sell that opens a short: the mirror image
      h.exchange.mark = '50000';
      const short = (slTriggerPx: string): PlaceOrderRequest => small({ side: 'sell', posSide: 'short', slTriggerPx });
      expect(await settle(h.orders.place(short('49000')))).toMatchObject({ code: 'VALIDATION', details: { refPrice: '50000', markPx: '50000' } });
      h.exchange.mark = '51000';
      expect(await settle(h.orders.place(short('50500')))).toMatchObject({ code: 'VALIDATION', details: { slTriggerPx: '50500', refPrice: '50000', markPx: '51000' } });
      expect((await h.orders.preview(short('51000.1'))).slTriggerPx).toBe('51000.1');

      // a market order is measured against its estimated fill
      h.exchange.mark = '50000';
      expect(await settle(h.orders.place(order({ size: { unit: 'contracts', value: '2' }, slTriggerPx: '50000' })))).toMatchObject({ code: 'VALIDATION', details: { refPrice: '50000', markPx: '50000' } });
      expect(h.exchange.placed).toEqual([]);
      // a refused stop holds no reservation: the full size still passes
      expect((await h.orders.preview(order())).risk.ok).toBe(true);
      await h.account.stop();
    });

    it('is refused without a live mark price, whatever the last price says; the order without the stop still goes', async () => {
      const h = await harness();
      // the mark stream is stale: the reference price is the last trade, which says nothing about where the mark is
      h.exchange.markLive = false;
      expect(await settle(h.orders.preview(small({ slTriggerPx: '49000' })))).toMatchObject({ code: 'NO_PRICE', status: 503 });
      expect(await settle(h.orders.place(small({ slTriggerPx: '49000' })))).toMatchObject({ code: 'NO_PRICE', status: 503 });
      expect(h.exchange.placed).toEqual([]);
      await h.orders.place(small());
      expect(h.exchange.placed).toHaveLength(1);
      expect(h.exchange.placed[0]).not.toHaveProperty('attachAlgoOrds');
      await h.account.stop();
    });

    it('net mode: is refused on an order that reduces the open net position even without reduce-only', async () => {
      const net = await harness({ posMode: 'net_mode' });
      net.ws.emit('data', positionPush('-10', NOW, 'net'));
      const buy: PlaceOrderRequest = { instId: BTC.instId, side: 'buy', ordType: 'limit', px: '50000', size: { unit: 'contracts', value: '2' }, slTriggerPx: '49000' };
      expect(await settle(net.orders.preview(buy))).toMatchObject({ code: 'VALIDATION', status: 400 });
      expect(await settle(net.orders.place(buy))).toMatchObject({ code: 'VALIDATION', status: 400 });
      expect(net.exchange.placed).toEqual([]);
      // adding to the short is an opening order and carries its stop
      await net.orders.place({ ...buy, side: 'sell', slTriggerPx: '51000' });
      expect(net.exchange.placed).toMatchObject([{ side: 'sell', attachAlgoOrds: [{ slTriggerPx: '51000' }] }]);
      await net.account.stop();
    });

    it('rounds the trigger to the tick towards the entry and previews the loss at the stop', async () => {
      const h = await harness();
      const long = await h.orders.preview(small({ slTriggerPx: '48000.03' }));
      // 0.02 BTC * (50,000 - 48,000.1)
      expect(long).toMatchObject({ slTriggerPx: '48000.1', stopLossQuote: '39.998', risk: { ok: true } });
      const short = await h.orders.preview(small({ side: 'sell', posSide: 'short', slTriggerPx: '52000.07' }));
      expect(short).toMatchObject({ slTriggerPx: '52000', stopLossQuote: '40' });
      // rounding must not carry the trigger onto the entry
      expect(await settle(h.orders.preview(small({ slTriggerPx: '49999.95' })))).toMatchObject({ code: 'VALIDATION', details: { slTriggerPx: '50000' } });
      // no stop: both fields are empty
      expect(await h.orders.preview(small())).toMatchObject({ slTriggerPx: '', stopLossQuote: '' });
      await h.account.stop();
    });

    it('REST: sends a mark-triggered market stop with its own client id, and only when one was asked for', async () => {
      const h = await harness();
      const placed = await h.orders.place(small({ slTriggerPx: '48000.03', clOrdId: 'abc1' }));
      expect(h.exchange.placed[0]).toMatchObject({ clOrdId: 'abc1', side: 'buy', posSide: 'long', px: '50000', sz: '2' });
      expect(h.exchange.placed[0]?.attachAlgoOrds).toEqual([{ attachAlgoClOrdId: 'slabc1', slTriggerPx: '48000.1', slOrdPx: '-1', slTriggerPxType: 'mark' }]);
      expect(placed.order).toMatchObject({ state: 'live', slTriggerPx: '48000.1' });
      expect(placed.preview).toMatchObject({ slTriggerPx: '48000.1', stopLossQuote: '39.998' });

      const plain = await h.orders.place(small());
      expect(h.exchange.placed[1]).not.toHaveProperty('attachAlgoOrds');
      expect(plain.order).not.toHaveProperty('slTriggerPx');

      // the longest client order id still gives an id inside OKX's 32 alphanumeric characters
      const longId = 'pgw' + 'a1'.repeat(14) + 'z';
      expect(longId).toHaveLength(32);
      await h.orders.place(small({ slTriggerPx: '48000', clOrdId: longId }));
      expect(h.exchange.placed[2]?.attachAlgoOrds?.[0]?.attachAlgoClOrdId).toBe(`sl${longId.slice(2)}`);
      expect(h.exchange.placed[2]?.attachAlgoOrds?.[0]?.attachAlgoClOrdId).toMatch(/^[A-Za-z0-9]{32}$/);
      await h.account.stop();
    });

    it('never relaxes a limit: an order over the notional limit is rejected with or without a stop', async () => {
      const h = await harness();
      const big = order({ ordType: 'limit', px: '50000', size: { unit: 'contracts', value: '60' } });
      const without = await h.orders.preview(big);
      const withStop = await h.orders.preview({ ...big, slTriggerPx: '49999' });
      expect(without.risk).toMatchObject({ ok: false, code: 'MAX_ORDER_NOTIONAL' });
      expect(withStop.risk).toEqual(without.risk);
      expect(await settle(h.orders.place({ ...big, slTriggerPx: '49999' }))).toMatchObject({ code: 'RISK_REJECTED' });
      expect(h.exchange.placed).toEqual([]);
      await h.account.stop();
    });

    it('WebSocket: the same params go out on the order op', async () => {
      const h = await harness({ wsTrading: true });
      h.ws.request.mockImplementation(async (_op: string, args: OkxPlaceOrderParams[]) => ({ id: '1', op: 'order', code: '0', msg: '', data: [{ ordId: 'w1', clOrdId: args[0]?.clOrdId ?? '', tag: '', sCode: '0', sMsg: '' }] }));
      const placed = await h.orders.place(small({ side: 'sell', posSide: 'short', slTriggerPx: '52000.07', clOrdId: 'ws1' }));
      expect(placed.order).toMatchObject({ ordId: 'w1', slTriggerPx: '52000' });
      expect(h.ws.request).toHaveBeenCalledTimes(1);
      const [op, args] = h.ws.request.mock.calls[0] as [string, OkxPlaceOrderParams[]];
      expect(op).toBe('order');
      expect(args).toHaveLength(1);
      expect(args[0]).toMatchObject({ instId: BTC.instId, side: 'sell', posSide: 'short', clOrdId: 'ws1', px: '50000', sz: '2' });
      expect(args[0]?.attachAlgoOrds).toEqual([{ attachAlgoClOrdId: 'slws1', slTriggerPx: '52000', slOrdPx: '-1', slTriggerPxType: 'mark' }]);
      expect(h.exchange.placed).toEqual([]);
      await h.account.stop();
    });

    it('a retry that finds the earlier attempt at the exchange sends no second order and no second stop', async () => {
      const h = await harness();
      const req = small({ slTriggerPx: '48000', clOrdId: 'rs1' });
      await h.orders.place(req);
      expect(h.exchange.placed).toHaveLength(1);
      // the first attempt filled, which freed its id at OKX; its stop is active
      h.exchange.lookup = (clOrdId) => ({ ...rawOrder(clOrdId, { ordId: 'o1', ordType: 'limit', px: '50000', sz: '2', state: 'filled', accFillSz: '2', avgPx: '50000' }), attachAlgoOrds: [{ attachAlgoClOrdId: 'slrs1', slTriggerPx: '48000', slOrdPx: '-1', slTriggerPxType: 'mark' }] });
      const retried = await h.orders.place({ ...req, retry: true });
      expect(retried.order).toMatchObject({ ordId: 'o1', state: 'filled', slTriggerPx: '48000' });
      expect(retried.preview).toMatchObject({ slTriggerPx: '48000', stopLossQuote: '', risk: { ok: true } });
      expect(h.exchange.placed).toHaveLength(1);
      await h.account.stop();
    });
  });

  describe('isolated margin of the campaign', () => {
    it('moves margin of the position the mode names; taking it out is halted by the kill switch, adding it never is', async () => {
      const net = await harness({ posMode: 'net_mode' });
      await net.orders.adjustIsolatedMargin({ instId: BTC.instId, posSide: 'net', type: 'add', amt: '12.5' });
      expect(await settle(net.orders.adjustIsolatedMargin({ instId: BTC.instId, posSide: 'long', type: 'add', amt: '1' }))).toMatchObject({ code: 'VALIDATION' });
      expect(await settle(net.orders.adjustIsolatedMargin({ instId: BTC.instId, posSide: 'net', type: 'reduce', amt: '0' }))).toMatchObject({ code: 'VALIDATION' });
      net.risk.setKillSwitch(true, 'test');
      expect(await settle(net.orders.adjustIsolatedMargin({ instId: BTC.instId, posSide: 'net', type: 'reduce', amt: '1' }))).toMatchObject({ code: 'RISK_REJECTED', details: { code: 'KILL_SWITCH' } });
      await net.orders.adjustIsolatedMargin({ instId: BTC.instId, posSide: 'net', type: 'add', amt: '1' });
      expect(net.exchange.margins).toEqual([
        { instId: BTC.instId, posSide: 'net', type: 'add', amt: '12.5' },
        { instId: BTC.instId, posSide: 'net', type: 'add', amt: '1' },
      ]);
      await net.account.stop();

      const hedged = await harness();
      expect(await settle(hedged.orders.adjustIsolatedMargin({ instId: BTC.instId, posSide: 'net', type: 'add', amt: '1' }))).toMatchObject({ code: 'VALIDATION' });
      await hedged.orders.adjustIsolatedMargin({ instId: BTC.instId, posSide: 'long', type: 'reduce', amt: '2' });
      expect(hedged.exchange.margins).toEqual([{ instId: BTC.instId, posSide: 'long', type: 'reduce', amt: '2' }]);
      await hedged.account.stop();
    });

    it('sets the isolated leverage beyond RISK_MAX_LEVERAGE, of one side in long/short mode', async () => {
      const hedged = await harness();
      expect(await settle(hedged.orders.setIsolatedLeverage(BTC.instId, '100', 'net'))).toMatchObject({ code: 'VALIDATION' });
      await hedged.orders.setIsolatedLeverage(BTC.instId, '100', 'long');
      expect(hedged.exchange.levers).toEqual([{ instId: BTC.instId, lever: '100', mgnMode: 'isolated', posSide: 'long' }]);
      await hedged.account.stop();
      const net = await harness({ posMode: 'net_mode' });
      await net.orders.setIsolatedLeverage(BTC.instId, '100', 'net');
      expect(net.exchange.levers).toEqual([{ instId: BTC.instId, lever: '100', mgnMode: 'isolated' }]);
      await net.account.stop();
    });

    it('a campaign context is for isolated orders only, and replaces the check of the leverage set by the one of the leverage run at', async () => {
      const h = await harness();
      h.exchange.lever = '100';
      // 30 contracts at 50,000: 15,000 on a margin of 1,500 is 10x
      const isolated = order({ tdMode: 'isolated' });
      expect(await settle(h.orders.preview(order(), { leverage: '10', margin: '1500' }))).toMatchObject({ code: 'VALIDATION' });
      expect((await h.orders.preview(isolated)).risk).toMatchObject({ ok: false, code: 'MAX_LEVERAGE' });
      expect((await h.orders.preview(isolated, { leverage: '10', margin: '1500' })).risk).toMatchObject({ ok: true });
      expect((await h.orders.preview(isolated, { leverage: '10', margin: '1400' })).risk).toMatchObject({ ok: false, code: 'MAX_LEVERAGE' });
      await h.orders.place(isolated, { leverage: '10', margin: '1500' });
      expect(h.exchange.placed).toMatchObject([{ tdMode: 'isolated', side: 'buy', posSide: 'long', sz: '30' }]);
      await h.account.stop();
    });
  });

  it('a push for the other leg does not release a reservation', async () => {
    const h = await harness();
    const placed = await h.orders.place(order());
    h.ws.emit('data', { arg: { channel: 'orders', instType: 'SWAP' }, data: [rawOrder(placed.order.clOrdId, { ordId: placed.order.ordId, state: 'filled', accFillSz: '30', uTime: String(NOW + 40) })] });
    h.ws.emit('data', positionPush('10', NOW + 50, 'short'));
    // 5,000 short + the 15,000 long fill the positions have not shown yet
    expect((await h.orders.preview(order())).risk.details?.['current']).toBe('20000.00');
    h.ws.emit('data', positionPush('30', NOW + 60));
    expect((await h.orders.preview(order())).risk.details?.['current']).toBe('20000.00');
    await h.account.stop();
  });
});
