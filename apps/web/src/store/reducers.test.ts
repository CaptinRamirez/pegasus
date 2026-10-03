import { describe, expect, it } from 'vitest';
import type {
  Balance,
  Candle,
  ConnectionStatus,
  HelloPayload,
  Instrument,
  Order,
  OrderBook,
  Position,
  RiskConfig,
  RiskState,
  Ticker,
  Trade,
} from '@pegasus/shared';
import { applyServerMessage } from './reducers';
import { LIMITS, initialState, type TerminalState } from './types';

const inst = (instId: string, baseCcy: string): Instrument => ({
  instId,
  instType: 'SWAP',
  uly: `${baseCcy}-USDT`,
  baseCcy,
  quoteCcy: 'USDT',
  settleCcy: 'USDT',
  ctVal: '0.01',
  ctValCcy: baseCcy,
  ctMult: '1',
  ctType: 'linear',
  lotSz: '1',
  minSz: '1',
  tickSz: '0.1',
  maxLmtSz: '100000',
  maxMktSz: '10000',
  maxLever: '100',
  state: 'live',
});

const BTC = inst('BTC-USDT-SWAP', 'BTC');
const ETH = inst('ETH-USDT-SWAP', 'ETH');

const riskConfig: RiskConfig = {
  maxOrderNotional: '5000',
  maxPositionNotionalPerInstrument: '20000',
  maxTotalPositionNotional: '50000',
  maxLeverage: '10',
  dailyLossLimit: '1000',
  maxOpenOrders: 20,
  priceBandPct: '0.05',
  maxSlippagePct: '0.005',
};

const risk: RiskState = {
  killSwitch: false,
  killSwitchReason: '',
  dayStartTs: 0,
  dayStartEquity: '10000',
  currentEquity: '10050',
  dailyPnl: '50',
  openOrders: 1,
  totalPositionNotional: '0',
  updatedAt: 1,
};

const connection: ConnectionStatus = {
  okxPublic: 'connected',
  okxPrivate: 'connected',
  okxBusiness: 'connecting',
  demo: true,
  lastMessageAgeMs: 10,
};

const balance: Balance = {
  totalEq: '10050',
  details: [{ ccy: 'USDT', eq: '10050', availEq: '9000', cashBal: '10000', upl: '50' }],
  ts: 1,
};

const order = (ordId: string, overrides: Partial<Order> = {}): Order => ({
  ordId,
  clOrdId: `c${ordId}`,
  instId: 'BTC-USDT-SWAP',
  side: 'buy',
  posSide: 'net',
  tdMode: 'cross',
  ordType: 'limit',
  px: '60000',
  sz: '1',
  accFillSz: '0',
  avgPx: '',
  state: 'live',
  reduceOnly: false,
  lever: '5',
  fee: '0',
  feeCcy: 'USDT',
  pnl: '0',
  cTime: 1000,
  uTime: 1000,
  ...overrides,
});

const position = (instId: string, pos: string): Position => ({
  instId,
  posSide: 'net',
  mgnMode: 'cross',
  pos,
  avgPx: '60000',
  markPx: '60100',
  upl: '1',
  uplRatio: '0.001',
  lever: '5',
  liqPx: '50000',
  margin: '120',
  notionalUsd: '601',
  cTime: 1,
  uTime: 2,
});

const hello: HelloPayload = {
  demo: true,
  instruments: [BTC, ETH],
  account: { posMode: 'net_mode', acctLv: '2' },
  riskConfig,
  risk,
  connection,
  balance,
  positions: [position('BTC-USDT-SWAP', '1')],
  openOrders: [order('o1')],
  serverTime: 123,
};

function stateAfterHello(): TerminalState {
  const s = initialState('tok');
  return { ...s, ...applyServerMessage(s, { type: 'hello', data: hello }) };
}

const ticker = (instId: string, last: string): Ticker => ({
  instId,
  last,
  lastSz: '1',
  bidPx: '1',
  bidSz: '1',
  askPx: '2',
  askSz: '1',
  open24h: '1',
  high24h: '3',
  low24h: '1',
  vol24h: '10',
  volCcy24h: '10',
  ts: 5,
});

const trade = (instId: string, tradeId: string, ts: number): Trade => ({
  instId,
  tradeId,
  px: '60000',
  sz: '1',
  side: 'buy',
  ts,
});

const candle = (ts: number, close: string): Candle => ({
  ts,
  open: '1',
  high: '2',
  low: '0.5',
  close,
  vol: '1',
  volCcy: '1',
  confirm: false,
});

describe('applyServerMessage', () => {
  it('hello populates state and selects the first instrument', () => {
    const s = stateAfterHello();
    expect(s.demo).toBe(true);
    expect(s.instruments).toEqual([BTC, ETH]);
    expect(s.account).toEqual(hello.account);
    expect(s.riskConfig).toEqual(riskConfig);
    expect(s.risk).toEqual(risk);
    expect(s.connection).toEqual(connection);
    expect(s.balance).toEqual(balance);
    expect(s.positions).toEqual(hello.positions);
    expect(s.orders).toEqual({ o1: order('o1') });
    expect(s.serverTime).toBe(123);
    expect(s.selectedInstId).toBe('BTC-USDT-SWAP');
    expect(Object.keys(s.market).sort()).toEqual(['BTC-USDT-SWAP', 'ETH-USDT-SWAP']);
  });

  it('hello keeps an already selected instrument when it is still tracked', () => {
    const s = { ...initialState('tok'), selectedInstId: 'ETH-USDT-SWAP' };
    const next = applyServerMessage(s, { type: 'hello', data: hello });
    expect(next.selectedInstId).toBe('ETH-USDT-SWAP');
  });

  it('ticker updates only the matching instrument', () => {
    const s = stateAfterHello();
    const next = applyServerMessage(s, { type: 'ticker', data: ticker('ETH-USDT-SWAP', '3000') });
    expect(next.market?.['ETH-USDT-SWAP']?.ticker?.last).toBe('3000');
    expect(next.market?.['BTC-USDT-SWAP']?.ticker).toBeNull();
    expect(next.market?.['BTC-USDT-SWAP']).toBe(s.market['BTC-USDT-SWAP']);
  });

  it('book replaces the order book of the matching instrument', () => {
    const s = stateAfterHello();
    const book: OrderBook = { instId: 'BTC-USDT-SWAP', bids: [['60000', '2']], asks: [['60001', '1']], ts: 9 };
    const next = applyServerMessage(s, { type: 'book', data: book });
    expect(next.market?.['BTC-USDT-SWAP']?.book).toEqual(book);
    expect(next.market?.['ETH-USDT-SWAP']?.book).toBeNull();
  });

  it('trades are prepended newest first, deduped and capped', () => {
    let s = stateAfterHello();
    s = { ...s, ...applyServerMessage(s, { type: 'trades', data: [trade('BTC-USDT-SWAP', 't1', 1), trade('BTC-USDT-SWAP', 't2', 2)] }) };
    expect(s.market['BTC-USDT-SWAP']?.trades.map((t) => t.tradeId)).toEqual(['t2', 't1']);
    expect(s.market['ETH-USDT-SWAP']?.trades).toEqual([]);

    const many: Trade[] = [];
    for (let i = 0; i < LIMITS.trades + 10; i += 1) many.push(trade('BTC-USDT-SWAP', `m${i}`, 100 + i));
    s = { ...s, ...applyServerMessage(s, { type: 'trades', data: many }) };
    const trades = s.market['BTC-USDT-SWAP']?.trades ?? [];
    expect(trades).toHaveLength(LIMITS.trades);
    expect(trades[0]?.tradeId).toBe(`m${LIMITS.trades + 9}`);
  });

  it('order upserts live orders and moves filled/canceled ones to history', () => {
    let s = stateAfterHello();
    s = { ...s, ...applyServerMessage(s, { type: 'order', data: order('o2') }) };
    expect(Object.keys(s.orders).sort()).toEqual(['o1', 'o2']);

    s = { ...s, ...applyServerMessage(s, { type: 'order', data: order('o2', { state: 'partially_filled', accFillSz: '0.5', uTime: 1001 }) }) };
    expect(s.orders['o2']?.state).toBe('partially_filled');
    expect(s.orders['o2']?.accFillSz).toBe('0.5');

    s = { ...s, ...applyServerMessage(s, { type: 'order', data: order('o2', { state: 'filled', accFillSz: '1', uTime: 1002 }) }) };
    expect(s.orders['o2']).toBeUndefined();
    expect(s.orders['o1']).toBeDefined();
    expect(s.orderHistory.map((o) => o.ordId)).toEqual(['o2']);

    s = { ...s, ...applyServerMessage(s, { type: 'order', data: order('o1', { state: 'canceled', uTime: 1003 }) }) };
    expect(s.orders).toEqual({});
    expect(s.orderHistory.map((o) => o.ordId)).toEqual(['o1', 'o2']);
  });

  it('order history is capped and newest first', () => {
    let s = stateAfterHello();
    for (let i = 0; i < LIMITS.orderHistory + 5; i += 1) {
      s = { ...s, ...applyServerMessage(s, { type: 'order', data: order(`h${i}`, { state: 'canceled', uTime: 2000 + i }) }) };
    }
    expect(s.orderHistory).toHaveLength(LIMITS.orderHistory);
    expect(s.orderHistory[0]?.ordId).toBe(`h${LIMITS.orderHistory + 4}`);
  });

  it('positions replace the list wholesale', () => {
    const s = stateAfterHello();
    const next = applyServerMessage(s, { type: 'positions', data: [position('ETH-USDT-SWAP', '-3')] });
    expect(next.positions).toEqual([position('ETH-USDT-SWAP', '-3')]);
    const empty = applyServerMessage(s, { type: 'positions', data: [] });
    expect(empty.positions).toEqual([]);
  });

  it('candle upserts by ts and ignores other bars', () => {
    let s: TerminalState = { ...stateAfterHello(), bar: '5m' };
    const ignored = applyServerMessage(s, { type: 'candle', data: { instId: 'BTC-USDT-SWAP', bar: '1m', candle: candle(60_000, '1') } });
    expect(ignored).toEqual({});

    s = { ...s, ...applyServerMessage(s, { type: 'candle', data: { instId: 'BTC-USDT-SWAP', bar: '5m', candle: candle(300_000, '1.5') } }) };
    s = { ...s, ...applyServerMessage(s, { type: 'candle', data: { instId: 'BTC-USDT-SWAP', bar: '5m', candle: candle(600_000, '1.6') } }) };
    s = { ...s, ...applyServerMessage(s, { type: 'candle', data: { instId: 'BTC-USDT-SWAP', bar: '5m', candle: candle(300_000, '1.7') } }) };
    const candles = s.market['BTC-USDT-SWAP']?.candles ?? {};
    expect(Object.keys(candles)).toHaveLength(2);
    expect(candles[300_000]?.close).toBe('1.7');
    expect(candles[600_000]?.close).toBe('1.6');
    expect(s.market['ETH-USDT-SWAP']?.candles).toEqual({});
  });

  it('fill, balance, risk and connection pushes replace their slices', () => {
    let s = stateAfterHello();
    const fill = { tradeId: 'f1', ordId: 'o1', clOrdId: 'co1', instId: 'BTC-USDT-SWAP', side: 'buy' as const, posSide: 'net' as const, fillPx: '60000', fillSz: '1', fee: '-0.1', feeCcy: 'USDT', execType: 'T' as const, ts: 7 };
    s = { ...s, ...applyServerMessage(s, { type: 'fill', data: fill }) };
    s = { ...s, ...applyServerMessage(s, { type: 'fill', data: fill }) };
    expect(s.fills).toEqual([fill]);

    const nextRisk = { ...risk, killSwitch: true, killSwitchReason: 'manual' };
    s = { ...s, ...applyServerMessage(s, { type: 'risk', data: nextRisk }) };
    expect(s.risk?.killSwitch).toBe(true);

    s = { ...s, ...applyServerMessage(s, { type: 'balance', data: { ...balance, totalEq: '9' } }) };
    expect(s.balance?.totalEq).toBe('9');

    s = { ...s, ...applyServerMessage(s, { type: 'connection', data: { ...connection, okxPrivate: 'disconnected' } }) };
    expect(s.connection?.okxPrivate).toBe('disconnected');
  });

  it('error messages become toasts; pong and subscribed are no-ops', () => {
    const s = stateAfterHello();
    const next = applyServerMessage(s, { type: 'error', data: { code: 'BAD', message: 'nope' } });
    expect(next.toasts?.[0]?.kind).toBe('error');
    expect(next.toasts?.[0]?.message).toContain('BAD');
    expect(applyServerMessage(s, { type: 'pong', data: { ts: 1 } })).toEqual({});
    expect(applyServerMessage(s, { type: 'subscribed', data: { instId: 'BTC-USDT-SWAP', bar: '5m' } })).toEqual({});
  });
});
