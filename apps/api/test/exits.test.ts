import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OkxAlgoOrder, OkxLeverageInfo, OkxOrderAck, OkxPlaceAlgoParams, OkxPlaceOrderParams } from '@pegasus/okx';
import { D, type AlgoOrder, type Candle, type Instrument, type PlaceOrderRequest, type Position, type RiskConfig } from '@pegasus/shared';
import { pino } from 'pino';
import { MemoryStore } from '../src/db/store.js';
import { UnknownInstrumentError } from '../src/errors.js';
import type { OkxClients } from '../src/okx/clients.js';
import { AccountService } from '../src/services/account.js';
import { ChannelTrailingService } from '../src/services/channel-trailing.js';
import { ExitStateFile } from '../src/services/exit-state.js';
import type { MarketDataService } from '../src/services/market-data.js';
import { OrderService } from '../src/services/order-service.js';
import { RiskEngine } from '../src/services/risk-engine.js';

const log = pino({ level: 'silent' });
const DAY = 86_400_000;
const riskConfig: RiskConfig = {
  maxOrderNotional: '20000', maxPositionNotionalPerInstrument: '20000', maxTotalPositionNotional: '30000', maxLeverage: '10',
  dailyLossLimit: '1000', maxOpenOrders: 5, priceBandPct: '0.05', maxSlippagePct: '0.005',
};
const BTC: Instrument = {
  instId: 'BTC-USDT-SWAP', instType: 'SWAP', uly: 'BTC-USDT', baseCcy: 'BTC', quoteCcy: 'USDT', settleCcy: 'USDT',
  ctVal: '0.01', ctValCcy: 'BTC', ctMult: '1', ctType: 'linear', lotSz: '0.1', minSz: '0.1', tickSz: '0.1',
  maxLmtSz: '100000', maxMktSz: '12000', maxLever: '100', state: 'live',
};
const tempFile = (): string => join(mkdtempSync(join(tmpdir(), 'pegasus-exits-')), 'trailing.json');

describe('RiskEngine.checkExits', () => {
  const risk = new RiskEngine(riskConfig, new MemoryStore(), log);

  it('take-profits on the profit side of both the entry and the mark', () => {
    expect(risk.checkExits({ direction: 'long', entryPx: '50000', markPx: '50100', takeProfits: ['51000', '52000'] }).ok).toBe(true);
    expect(risk.checkExits({ direction: 'long', entryPx: '50000', markPx: '50100', takeProfits: ['51000', '50050'] })).toMatchObject({ ok: false, code: 'TP_WRONG_SIDE', details: { leg: 2, triggerPx: '50050' } });
    // between the entry and the mark of a position under water: a take-profit that would take a loss
    expect(risk.checkExits({ direction: 'long', entryPx: '50000', markPx: '49000', takeProfits: ['49500'] }).code).toBe('TP_WRONG_SIDE');
    expect(risk.checkExits({ direction: 'short', entryPx: '50000', markPx: '49900', takeProfits: ['49000'] }).ok).toBe(true);
    expect(risk.checkExits({ direction: 'short', entryPx: '50000', markPx: '49900', takeProfits: ['49950'] }).code).toBe('TP_WRONG_SIDE');
  });

  it('a callback ratio from 0.1% to 20%, and an activation price beyond the mark and the last price', () => {
    expect(risk.checkExits({ direction: 'long', entryPx: '50000', markPx: '50000', callbackRatio: '0.001' }).ok).toBe(true);
    expect(risk.checkExits({ direction: 'long', entryPx: '50000', markPx: '50000', callbackRatio: '0.2' }).ok).toBe(true);
    expect(risk.checkExits({ direction: 'long', entryPx: '50000', markPx: '50000', callbackRatio: '0.0009' })).toMatchObject({ code: 'CALLBACK_RATIO', details: { min: '0.001', max: '0.2' } });
    expect(risk.checkExits({ direction: 'long', entryPx: '50000', markPx: '50000', callbackRatio: '0.25' }).code).toBe('CALLBACK_RATIO');
    expect(risk.checkExits({ direction: 'long', entryPx: '50000', markPx: '50000', lastPx: '50010', callbackRatio: '0.05', activePx: '51000' }).ok).toBe(true);
    expect(risk.checkExits({ direction: 'long', entryPx: '50000', markPx: '50000', lastPx: '51500', callbackRatio: '0.05', activePx: '51000' }).code).toBe('ACTIVE_PX_WRONG_SIDE');
    expect(risk.checkExits({ direction: 'short', entryPx: '50000', markPx: '50000', callbackRatio: '0.05', activePx: '49000' }).ok).toBe(true);
    expect(risk.checkExits({ direction: 'short', entryPx: '50000', markPx: '50000', callbackRatio: '0.05', activePx: '50500' }).code).toBe('ACTIVE_PX_WRONG_SIDE');
  });

  it('pass under the kill switch: an exit only reduces', () => {
    const halted = new RiskEngine(riskConfig, new MemoryStore(), log);
    halted.setKillSwitch(true, 'test');
    expect(halted.checkExits({ direction: 'long', entryPx: '50000', markPx: '50000', takeProfits: ['51000'], callbackRatio: '0.05' }).ok).toBe(true);
  });
});

describe('OrderService exits against a stubbed exchange', () => {
  class ReadySocket extends EventEmitter {
    isReady = true;
    currentStatus = 'connected';
    request = vi.fn();
    async subscribe(): Promise<void> {}
    connect(): void {}
    async close(): Promise<void> {}
  }

  async function harness(opts: { posMode?: 'net_mode' | 'long_short_mode'; exits?: boolean; positions?: unknown[] } = {}) {
    const posMode = opts.posMode ?? 'net_mode';
    const exchange = {
      placed: [] as OkxPlaceOrderParams[],
      algos: [] as OkxPlaceAlgoParams[],
      algoList: [] as OkxAlgoOrder[],
      canceled: [] as string[],
      algoFails: null as ((n: number) => Error | null) | null,
      positions: opts.positions ?? [],
      mark: '50000',
    };
    const rest = {
      getAccountConfig: async () => ({ uid: '1', acctLv: '2', posMode, autoLoan: false, level: 'Lv1', perm: 'read_only,trade' }),
      getBalance: async () => ({ totalEq: '100000', uTime: '1', details: [] }),
      getPositions: async () => exchange.positions,
      getOrdersPending: async () => [],
      getLeverageInfo: async (instId: string): Promise<OkxLeverageInfo[]> => (posMode === 'long_short_mode' ? (['long', 'short'] as const) : (['net'] as const)).map((posSide) => ({ instId, mgnMode: 'cross', posSide, lever: '5' })),
      placeOrder: async (params: OkxPlaceOrderParams): Promise<OkxOrderAck> => {
        exchange.placed.push(params);
        return { ordId: `o${exchange.placed.length}`, clOrdId: params.clOrdId ?? '', tag: '', sCode: '0', sMsg: '' };
      },
      getAlgoOrdersPending: async () => exchange.algoList,
      placeAlgoOrder: async (params: OkxPlaceAlgoParams) => {
        exchange.algos.push(params);
        const failure = exchange.algoFails?.(exchange.algos.length);
        if (failure) throw failure;
        return { algoId: `a${exchange.algos.length}`, sCode: '0', sMsg: '' };
      },
      cancelAlgoOrder: async (params: { algoId?: string }) => {
        exchange.canceled.push(params.algoId ?? '');
        return { algoId: params.algoId ?? '', sCode: '0', sMsg: '' };
      },
    };
    const clients = { rest, wsPrivate: new ReadySocket(), clock: { offsetMs: 0 }, demo: false } as unknown as OkxClients;
    const store = new MemoryStore();
    const account = new AccountService(clients, store, log);
    await account.start();
    const market = {
      requireInstrument: (instId: string) => {
        if (instId !== BTC.instId) throw new UnknownInstrumentError(instId);
        return BTC;
      },
      specOf: (instId: string) => (instId === BTC.instId ? BTC : undefined),
      bestPrice: () => '50000',
      refPrice: () => exchange.mark,
      liveMarkPrice: () => exchange.mark,
      ticker: () => ({ last: exchange.mark }),
      estimateMarketFill: () => ({ avgPx: '50000', slippagePct: '0', complete: true }),
    } as unknown as MarketDataService;
    const risk = new RiskEngine(riskConfig, store, log);
    const orders = new OrderService(clients, market, account, risk, store, log, { defaultTdMode: 'cross', wsTrading: false, exits: opts.exits ?? true });
    return { orders, account, risk, exchange };
  }

  /** 10 contracts = 0.1 BTC, 5,000 USD */
  const order = (overrides: Partial<PlaceOrderRequest> = {}): PlaceOrderRequest => ({ instId: BTC.instId, side: 'buy', ordType: 'market', size: { unit: 'contracts', value: '10' }, ...overrides });
  const settle = <T>(p: Promise<T>): Promise<T | { code: string; status: number; details?: Record<string, unknown> }> => p.catch((e: { code: string; status: number }) => e);

  it('sizes the legs in whole lots of the order, the last taking the rest, and previews each one', async () => {
    const { orders } = await harness();
    const preview = await orders.preview(order({ size: { unit: 'contracts', value: '3' }, takeProfits: [{ triggerPx: '51000.04', fraction: '0.5' }, { triggerPx: '52000', fraction: '0.25' }] }));
    expect(preview.risk.ok).toBe(true);
    // rounded down to the tick (towards the entry); 0.5 of 3 is 1.5; the last leg takes the 1.5 left
    expect(preview.takeProfits).toEqual([
      { triggerPx: '51000', fraction: '0.5', sz: '1.5', profitQuote: D('0.015').mul(1000).toFixed() },
      { triggerPx: '52000', fraction: '0.25', sz: '1.5', profitQuote: D('0.015').mul(2000).toFixed() },
    ]);
    // a take-profit below the mark is the risk engine's refusal, shown in the preview
    const wrong = await orders.preview(order({ takeProfits: [{ triggerPx: '49000', fraction: '1' }] }));
    expect(wrong.risk).toMatchObject({ ok: false, code: 'TP_WRONG_SIDE' });
  });

  it('sends split take-profits and the cost-price stop as OKX documents them; source and signal never leave the server', async () => {
    const { orders, exchange } = await harness();
    const { order: placed } = await orders.place(
      order({
        slTriggerPx: '49000',
        takeProfits: [{ triggerPx: '51000', fraction: '0.4' }, { triggerPx: '52000', fraction: '0.6' }],
        breakevenAfterTp1: true,
        source: 'signal',
        signal: { rule: 'campaign', kind: 'entry', barTs: 1, close: '50000', entryLevel: '49900', exitLevel: '45000' },
      }),
    );
    expect(placed.clOrdId).toMatch(/^ps[a-z0-9]+$/);
    const sent = exchange.placed[0];
    expect(sent).not.toHaveProperty('source');
    expect(sent).not.toHaveProperty('signal');
    const tail = placed.clOrdId.slice(-29);
    expect(sent?.attachAlgoOrds).toEqual([
      { attachAlgoClOrdId: `tp1${tail}`, tpTriggerPx: '51000', tpOrdPx: '-1', tpTriggerPxType: 'mark', sz: '4' },
      { attachAlgoClOrdId: `tp2${tail}`, tpTriggerPx: '52000', tpOrdPx: '-1', tpTriggerPxType: 'mark', sz: '6' },
      { attachAlgoClOrdId: `sl${placed.clOrdId.slice(-30)}`, slTriggerPx: '49000', slOrdPx: '-1', slTriggerPxType: 'mark', amendPxOnTriggerType: '1' },
    ]);

    // one take-profit with the stop: one object, which OKX makes an oco order
    await orders.place(order({ slTriggerPx: '49000', takeProfits: [{ triggerPx: '51000', fraction: '0.5' }] }));
    expect(exchange.placed[1]?.attachAlgoOrds).toEqual([{ attachAlgoClOrdId: expect.stringMatching(/^sl/), tpTriggerPx: '51000', tpOrdPx: '-1', tpTriggerPxType: 'mark', slTriggerPx: '49000', slOrdPx: '-1', slTriggerPxType: 'mark' }]);
    // a manual order is a pg order
    expect(exchange.placed[1]?.clOrdId).toMatch(/^pg/);
  });

  it('refuses what OKX would refuse, and the prefixes that do not fit the source', async () => {
    const { orders, exchange } = await harness();
    // three legs of 0.2 contracts: one comes to 0.1... of 0.3 the legs are 0.1, 0.1, 0.1; of 0.2 one is 0
    expect(await settle(orders.place(order({ size: { unit: 'contracts', value: '0.2' }, takeProfits: [{ triggerPx: '51000', fraction: '0.3' }, { triggerPx: '52000', fraction: '0.3' }, { triggerPx: '53000', fraction: '0.4' }] })))).toMatchObject({ code: 'TP_LEG_TOO_SMALL', details: { leg: 1, sz: '0', minSz: '0.1' } });
    expect(await settle(orders.place(order({ takeProfits: [{ triggerPx: '51000.01', fraction: '0.5' }, { triggerPx: '51000.04', fraction: '0.5' }] })))).toMatchObject({ code: 'TP_TRIGGERS_NOT_DISTINCT' });
    expect(await settle(orders.place(order({ slTriggerPx: '49000', takeProfits: [{ triggerPx: '51000', fraction: '1' }], breakevenAfterTp1: true })))).toMatchObject({ code: 'BREAKEVEN_NEEDS_SPLIT_TP', status: 400 });
    expect(await settle(orders.place(order({ takeProfits: [{ triggerPx: '51000', fraction: '0.5' }, { triggerPx: '52000', fraction: '0.5' }], breakevenAfterTp1: true })))).toMatchObject({ code: 'BREAKEVEN_NEEDS_SPLIT_TP' });
    expect(await settle(orders.place(order({ side: 'sell', reduceOnly: true, takeProfits: [{ triggerPx: '49000', fraction: '1' }] })))).toMatchObject({ code: 'VALIDATION' });
    expect(await settle(orders.place(order({ trailing: { kind: 'callback', ratio: '0.5' } })))).toMatchObject({ code: 'RISK_REJECTED', details: { code: 'CALLBACK_RATIO' } });
    expect(await settle(orders.place(order({ source: 'signal', clOrdId: 'pgw123' })))).toMatchObject({ code: 'VALIDATION' });
    expect(await settle(orders.place(order({ clOrdId: 'psw123' })))).toMatchObject({ code: 'VALIDATION' });
    expect(exchange.placed).toEqual([]);
    // a signal order may bring its own ps id
    expect((await orders.place(order({ source: 'signal', clOrdId: 'psw123' }))).order.clOrdId).toBe('psw123');
  });

  it('outside paper trading and the local mock the exits are refused and nothing is sent; plain orders and stops are as before', async () => {
    const { orders, exchange } = await harness({ exits: false });
    expect(await settle(orders.place(order({ takeProfits: [{ triggerPx: '51000', fraction: '1' }] })))).toMatchObject({ code: 'EXITS_UNAVAILABLE', status: 403 });
    expect(await settle(orders.place(order({ trailing: { kind: 'channel', bars: 10 } })))).toMatchObject({ code: 'EXITS_UNAVAILABLE' });
    expect(await settle(orders.placeTakeProfits({ instId: BTC.instId, mgnMode: 'cross', takeProfits: [{ triggerPx: '51000', fraction: '1' }] }))).toMatchObject({ code: 'EXITS_UNAVAILABLE' });
    expect(await settle(orders.placeTrailingStop({ instId: BTC.instId, mgnMode: 'cross', ratio: '0.05' }))).toMatchObject({ code: 'EXITS_UNAVAILABLE' });
    expect(exchange.placed).toEqual([]);
    await orders.place(order({ slTriggerPx: '49000' }));
    expect(exchange.placed[0]?.attachAlgoOrds).toEqual([{ attachAlgoClOrdId: expect.stringMatching(/^sl/), slTriggerPx: '49000', slOrdPx: '-1', slTriggerPxType: 'mark' }]);
  });

  it('take-profit legs and a trailing stop for an open position; they pass under the kill switch, an opening order with them does not', async () => {
    const position = { instId: BTC.instId, posSide: 'net', mgnMode: 'cross', pos: '10', avgPx: '50000', markPx: '50000', upl: '0', uplRatio: '0', lever: '5', liqPx: '', margin: '', notionalUsd: '5000', cTime: '1', uTime: '1' };
    const { orders, risk, exchange } = await harness({ positions: [position] });
    risk.setKillSwitch(true, 'test');
    expect(await settle(orders.place(order({ takeProfits: [{ triggerPx: '51000', fraction: '1' }] })))).toMatchObject({ code: 'RISK_REJECTED', details: { code: 'KILL_SWITCH' } });

    const tps = await orders.placeTakeProfits({ instId: BTC.instId, mgnMode: 'cross', takeProfits: [{ triggerPx: '51000', fraction: '0.25' }, { triggerPx: '52000', fraction: '0.25' }] });
    expect(tps.legs).toEqual([{ algoId: 'a1', triggerPx: '51000', sz: '2.5' }, { algoId: 'a2', triggerPx: '52000', sz: '2.5' }]);
    expect(exchange.algos[0]).toMatchObject({ ordType: 'conditional', side: 'sell', sz: '2.5', tpTriggerPx: '51000', tpOrdPx: '-1', tpTriggerPxType: 'mark', reduceOnly: true, cxlOnClosePos: true, algoClOrdId: expect.stringMatching(/^tp1/) });
    expect(exchange.algos[0]).not.toHaveProperty('posSide');

    // with 5 already resting for a position of 10, 0.6 more is more than it holds
    exchange.algoList = exchange.algos.map((a, i) => ({ instType: 'SWAP', instId: a.instId, algoId: `a${i + 1}`, algoClOrdId: a.algoClOrdId ?? '', ordType: 'conditional', side: a.side, posSide: 'net', tdMode: 'cross', sz: a.sz ?? '', closeFraction: '', state: 'live', reduceOnly: 'true', tpTriggerPx: a.tpTriggerPx ?? '', tpTriggerPxType: 'mark', tpOrdPx: '-1', slTriggerPx: '', slTriggerPxType: '', slOrdPx: '', cTime: '1', uTime: '1' }));
    expect(await settle(orders.placeTakeProfits({ instId: BTC.instId, mgnMode: 'cross', takeProfits: [{ triggerPx: '53000', fraction: '0.6' }] }))).toMatchObject({ code: 'TP_EXCEEDS_POSITION', details: { existing: '5', requested: '6', size: '10' } });

    const trail = await orders.placeTrailingStop({ instId: BTC.instId, mgnMode: 'cross', ratio: '0.05', activePx: '51000.04' });
    expect(trail).toEqual({ algoId: 'a3', instId: BTC.instId, posSide: 'net', sz: '10', callbackRatio: '0.05', activePx: '51000' });
    expect(exchange.algos[2]).toEqual({ instId: BTC.instId, tdMode: 'cross', side: 'sell', reduceOnly: true, ordType: 'move_order_stop', sz: '10', callbackRatio: '0.05', algoClOrdId: expect.stringMatching(/^tr/), activePx: '51000' });
    expect(await settle(orders.placeTrailingStop({ instId: BTC.instId, mgnMode: 'cross', ratio: '0.3' }))).toMatchObject({ code: 'RISK_REJECTED', details: { code: 'CALLBACK_RATIO' } });
  });

  it('a leg the exchange refuses cancels the legs placed before it', async () => {
    const position = { instId: BTC.instId, posSide: 'long', mgnMode: 'cross', pos: '10', avgPx: '50000', markPx: '50000', upl: '0', uplRatio: '0', lever: '5', liqPx: '', margin: '', notionalUsd: '5000', cTime: '1', uTime: '1' };
    const { orders, exchange } = await harness({ posMode: 'long_short_mode', positions: [position] });
    const { OkxApiError } = await import('@pegasus/okx');
    exchange.algoFails = (n) => (n === 2 ? new OkxApiError('51303', 'TP trigger price cannot be lower than the mark price', '/api/v5/trade/order-algo') : null);
    expect(await settle(orders.placeTakeProfits({ instId: BTC.instId, mgnMode: 'cross', posSide: 'long', takeProfits: [{ triggerPx: '51000', fraction: '0.5' }, { triggerPx: '52000', fraction: '0.5' }] }))).toMatchObject({ code: 'EXCHANGE', details: { okxCode: '51303' } });
    expect(exchange.algos[0]).toMatchObject({ posSide: 'long', side: 'sell' });
    expect(exchange.algos[0]).not.toHaveProperty('reduceOnly');
    expect(exchange.canceled).toEqual(['a1']);
    // posSide is required in long/short mode
    expect(await settle(orders.placeTrailingStop({ instId: BTC.instId, mgnMode: 'cross', ratio: '0.05' }))).toMatchObject({ code: 'VALIDATION' });
  });
});

describe('ChannelTrailingService', () => {
  const T0 = Date.UTC(2026, 9, 1);
  /** Daily bars from T0: lows climbing by 100 a day from 49000, highs 1000 above */
  const days = (n: number, confirmLast = true): Candle[] =>
    Array.from({ length: n }, (_, i) => ({ ts: T0 + i * DAY, open: String(49500 + i * 100), high: String(50000 + i * 100), low: String(49000 + i * 100), close: String(49800 + i * 100), vol: '1', volCcy: '1', confirm: i < n - 1 || confirmLast }));

  function fake(opts: { position?: Partial<Position>; stops?: Partial<AlgoOrder>[]; now: number; candles: Candle[]; campaign?: boolean; file?: string }) {
    const position: Position = { instId: BTC.instId, posSide: 'net', mgnMode: 'cross', pos: '10', avgPx: '49000', markPx: '51000', upl: '0', uplRatio: '0', lever: '5', liqPx: '', margin: '', notionalUsd: '5100', cTime: 1, uTime: 1, ...opts.position };
    const world = {
      positions: [position],
      stops: (opts.stops ?? []).map((s, i) => ({ algoId: `s${i}`, algoClOrdId: '', instId: BTC.instId, side: 'sell', posSide: 'net', tdMode: 'cross', sz: '10', closeFraction: '', slTriggerPx: '48000', slTriggerPxType: 'mark', slOrdPx: '-1', tpTriggerPx: '', cTime: 1, uTime: 1, ...s }) as AlgoOrder),
      mark: '51000',
      now: opts.now,
      candles: opts.candles,
      amendFails: false,
    };
    const account = { config: { posMode: 'net_mode' }, status: () => ({ lastSyncAt: 1 }), positionList: () => world.positions, refreshAlgoOrders: async () => ({ orders: world.stops, ts: world.now }) } as unknown as AccountService;
    const orders = {
      amendStop: vi.fn(async (req: { algoId: string; slTriggerPx: string }) => {
        if (world.amendFails) {
          const { AppError } = await import('../src/errors.js');
          throw new AppError('EXCHANGE', 'refused', 502, { okxCode: '51000' });
        }
        const s = world.stops.find((x) => x.algoId === req.algoId);
        if (s) s.slTriggerPx = req.slTriggerPx;
        return { algoId: req.algoId, instId: BTC.instId, slTriggerPx: req.slTriggerPx, previous: '' };
      }),
      placeStop: vi.fn(async (req: { slTriggerPx: string; sz?: string }) => {
        const algoId = `p${world.stops.length}`;
        world.stops.push({ algoId, algoClOrdId: 'ch', instId: BTC.instId, side: 'sell', posSide: 'net', tdMode: 'cross', sz: req.sz ?? '10', closeFraction: '', slTriggerPx: req.slTriggerPx, slTriggerPxType: 'mark', slOrdPx: '-1', tpTriggerPx: '', cTime: 1, uTime: 1 });
        return { algoId, instId: BTC.instId, slTriggerPx: req.slTriggerPx, sz: req.sz ?? '10' };
      }),
      cancelStop: vi.fn(async (req: { algoId: string }) => {
        world.stops = world.stops.filter((s) => s.algoId !== req.algoId);
        return { algoId: req.algoId, instId: BTC.instId };
      }),
    } as unknown as OrderService;
    const market = { specOf: () => BTC, liveMarkPrice: () => world.mark } as unknown as MarketDataService;
    const state = new ExitStateFile(opts.file ?? tempFile());
    const service = new ChannelTrailingService(
      { clients: {} as OkxClients, account, orders, market, store: new MemoryStore(), log },
      { enabled: true, state, now: () => world.now, candles: async () => world.candles, checkEveryMs: 0, isCampaignPosition: () => opts.campaign === true },
    );
    return { service, world, orders, state };
  }

  it('places a stop at the channel when the position has none, and moves it up after each daily close, never down', async () => {
    // 20 closed days; at the close ending day 19 the lowest low of the last 10 (days 10 to 19) is 50000
    const { service, world, orders } = fake({ now: T0 + 20 * DAY + 1000, candles: days(20) });
    const entry = await service.enable({ instId: BTC.instId, mgnMode: 'cross', bars: 10 }, { kind: 'route' });
    expect(entry).toMatchObject({ direction: 'long', bars: 10, source: 'route', level: '50000', levelClose: T0 + 20 * DAY, lastError: null, lastMove: { action: 'placed', from: null, to: '50000' } });
    expect(world.stops.map((s) => [s.sz, s.slTriggerPx])).toEqual([['10', '50000']]);

    // the next close: the channel rose by 100
    world.now = T0 + 21 * DAY + 1000;
    world.candles = days(21);
    await service.tick();
    expect(world.stops.map((s) => s.slTriggerPx)).toEqual(['50100']);
    expect(service.view().entries[0]).toMatchObject({ level: '50100', lastMove: { action: 'amended', from: '50000', to: '50100' } });

    // a day whose low drops below the channel: the level falls, the stop does not
    world.now = T0 + 22 * DAY + 1000;
    world.candles = [...days(21), { ts: T0 + 21 * DAY, open: '51000', high: '51500', low: '49500', close: '51200', vol: '1', volCcy: '1', confirm: true }];
    const amends = vi.mocked(orders.amendStop).mock.calls.length;
    await service.tick();
    expect(world.stops.map((s) => s.slTriggerPx)).toEqual(['50100']);
    expect(vi.mocked(orders.amendStop).mock.calls.length).toBe(amends);
    expect(service.view().entries[0]?.levelClose).toBe(T0 + 22 * DAY);
  });

  it('waits for the daily bar of the close to be confirmed; leaves a stop already above the level; replaces one the exchange will not amend', async () => {
    const { service, world, orders } = fake({ now: T0 + 20 * DAY + 1000, candles: days(20, false), stops: [{ slTriggerPx: '50500', sz: '4' }, { algoId: 'low', slTriggerPx: '47000', sz: '6' }] });
    const entry = await service.enable({ instId: BTC.instId, mgnMode: 'cross', bars: 10 }, { kind: 'route' });
    expect(entry.levelClose).toBeNull();
    expect(entry.lastError?.message).toContain('not confirmed yet');
    world.candles = days(20);
    world.amendFails = true;
    await service.tick();
    // the stop at 50500 stays; the one at 47000 is cancelled and placed again at the channel for its 6 contracts
    expect(vi.mocked(orders.cancelStop)).toHaveBeenCalledWith({ instId: BTC.instId, algoId: 'low' });
    expect(world.stops.map((s) => [s.sz, s.slTriggerPx]).sort()).toEqual([['4', '50500'], ['6', '50000']]);
    expect(service.view().entries[0]?.lastMove).toMatchObject({ action: 'replaced', from: '47000', to: '50000' });
  });

  it('catches up with the closes missed while it was not running: the best of their levels; a short trails the highest high', async () => {
    const file = tempFile();
    const first = fake({ now: T0 + 20 * DAY + 1000, candles: days(20), position: { pos: '-10', markPx: '49000' }, stops: [{ side: 'buy', slTriggerPx: '60000' }], file });
    first.world.mark = '49000';
    await first.service.enable({ instId: BTC.instId, mgnMode: 'cross', bars: 3 }, { kind: 'route' });
    // the highest high of days 17 to 19 is 51900
    expect(first.world.stops.map((s) => s.slTriggerPx)).toEqual(['51900']);
    await first.service.stop();

    // three closes later, read again from the file; the highs kept climbing, then one day spiked
    const candles = [...days(22), { ts: T0 + 22 * DAY, open: '50000', high: '50100', low: '48000', close: '48500', vol: '1', volCcy: '1', confirm: true }];
    const again = fake({ now: T0 + 23 * DAY + 1000, candles, position: { pos: '-10', markPx: '48500' }, stops: [{ side: 'buy', slTriggerPx: '51900' }], file });
    again.world.mark = '48500';
    expect(again.service.view().entries).toMatchObject([{ direction: 'short', bars: 3, level: '51900', levelClose: T0 + 20 * DAY }]);
    await again.service.tick();
    // closes of days 21 (52000), 22 (52100), 23 (52100): the lowest high is the best for a short, so the stop stays at 51900
    expect(again.world.stops.map((s) => s.slTriggerPx)).toEqual(['51900']);
    expect(again.service.view().entries[0]?.levelClose).toBe(T0 + 23 * DAY);
  });

  it('never touches a position of the campaign, refuses to flag one, and ends the flag of a closed position', async () => {
    const campaign = fake({ now: T0 + 20 * DAY + 1000, candles: days(20), campaign: true, position: { mgnMode: 'isolated' } });
    await expect(campaign.service.enable({ instId: BTC.instId, mgnMode: 'isolated', bars: 10 }, { kind: 'route' })).rejects.toMatchObject({ code: 'CAMPAIGN_POSITION', status: 409 });
    expect(campaign.world.stops).toEqual([]);

    const { service, world, state } = fake({ now: T0 + 20 * DAY + 1000, candles: days(20) });
    await service.enable({ instId: BTC.instId, mgnMode: 'cross', bars: 10 }, { kind: 'order', clOrdId: 'pgabc' });
    expect(JSON.parse(readFileSync(state.file, 'utf8'))).toMatchObject({ version: 1, channel: [{ instId: BTC.instId, source: 'order', clOrdId: 'pgabc', level: '50000' }] });
    world.positions = [];
    world.now += DAY;
    await service.tick();
    expect(service.view().entries).toEqual([]);
    expect(JSON.parse(readFileSync(state.file, 'utf8')).channel).toEqual([]);
    await expect(service.enable({ instId: BTC.instId, mgnMode: 'cross', bars: 10 }, { kind: 'route' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('does not place a stop the mark has already passed', async () => {
    const { service, world } = fake({ now: T0 + 20 * DAY + 1000, candles: days(20) });
    world.mark = '49950';
    const entry = await service.enable({ instId: BTC.instId, mgnMode: 'cross', bars: 10 }, { kind: 'route' });
    expect(entry.lastError?.message).toContain('at or beyond the mark price 49950');
    expect(world.stops).toEqual([]);
  });
});

describe('ExitStateFile', () => {
  it('a file it cannot trust is kept aside, nothing is written over it', () => {
    const file = tempFile();
    writeFileSync(file, '{"version":7}');
    const state = new ExitStateFile(file);
    expect(state.error).toContain('schema version 7');
    expect(existsSync(`${file}.corrupt`)).toBe(true);
    state.state.channel.push({} as never);
    state.save();
    expect(readFileSync(file, 'utf8')).toBe('{"version":7}');
  });
});

describe('the exits switch of the configuration', () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());

  it('is on in paper trading and against a mock on this machine, off against OKX', async () => {
    const { loadConfig } = await import('../src/config.js');
    const mock = { OKX_REST_URL: 'http://127.0.0.1:9100', OKX_WS_PUBLIC_URL: 'ws://127.0.0.1:9100/ws/v5/public', OKX_WS_PRIVATE_URL: 'ws://localhost:9100/ws/v5/private', OKX_WS_BUSINESS_URL: 'ws://127.0.0.1:9100/ws/v5/business' };
    expect(loadConfig({ ...mock }).exits.enabled).toBe(true);
    expect(loadConfig({ ...mock, OKX_REST_URL: 'https://www.okx.com' }).exits.enabled).toBe(false);
    expect(loadConfig({}).exits.enabled).toBe(false);
    expect(loadConfig({ PAPER_EXCHANGE_URL: 'http://127.0.0.1:9200' }).exits.enabled).toBe(true);
    const paper = loadConfig({ PAPER_EXCHANGE_URL: 'http://127.0.0.1:9200', STATE_FILE: 'data/pegasus-state.paper.json' });
    expect(paper.exits.stateFile.replace(/\\/g, '/')).toMatch(/data\/pegasus-state\.paper\.trailing\.json$/);
    expect(loadConfig({ TRAILING_STATE_FILE: 'data/x.json' }).exits.stateFile.replace(/\\/g, '/')).toMatch(/data\/x\.json$/);
  });
});
