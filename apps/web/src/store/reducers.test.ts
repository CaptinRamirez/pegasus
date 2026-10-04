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
import { accountAsOf, accountUnknown, activeAlerts, isStreamStale, killSwitchSweepNotice } from './alerts';
import { applyServerMessage, applyWsStatus, stampMessage } from './reducers';
import { ACCOUNT_NOT_LOADED_BLOCK, READ_ONLY_KEY_BLOCK, getTradingBlock } from './store';
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
  cancelSweep: { state: 'idle', message: '', ts: 1 },
  dayStartTs: 0,
  dayStartEquity: '10000',
  baselineTs: 0,
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
  account: { state: 'ok', error: null, lastSyncAt: 1, readOnly: false },
  demo: true,
  dataAgeMs: 10,
  staleStreams: [],
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
  account: { posMode: 'net_mode', acctLv: '2', canTrade: true },
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

  it('account corrects the config of a terminal that connected before the account was loaded', () => {
    let s = initialState('tok');
    s = { ...s, ...applyServerMessage(s, { type: 'hello', data: { ...hello, account: null } }) };
    expect(s.account).toBeNull();
    expect(getTradingBlock(s)).toBe(ACCOUNT_NOT_LOADED_BLOCK);

    s = { ...s, ...applyServerMessage(s, { type: 'account', data: { posMode: 'long_short_mode', acctLv: '2', canTrade: true } }) };
    expect(s.account).toEqual({ posMode: 'long_short_mode', acctLv: '2', canTrade: true });
    expect(getTradingBlock(s)).toBeNull();

    // the key lost (or never had) the trade permission
    s = { ...s, ...applyServerMessage(s, { type: 'account', data: { posMode: 'long_short_mode', acctLv: '2', canTrade: false } }) };
    expect(getTradingBlock(s)).toBe(READ_ONLY_KEY_BLOCK);
    expect(READ_ONLY_KEY_BLOCK).toEqual({ en: 'Read-only API key: trading from Pegasus is disabled', zh: '只读 key：无法从 Pegasus 下单' });
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

describe('applyWsStatus', () => {
  it('drops the exchange connection status whenever the socket to the server is not open', () => {
    let s = stateAfterHello();
    s = { ...s, ...applyWsStatus(s, 'open', 1_000) };
    expect(s.connection).toEqual(connection);
    expect(s.wsDownSince).toBeNull();

    s = { ...s, ...applyWsStatus(s, 'closed', 5_000) };
    expect(s.wsStatus).toBe('closed');
    expect(s.connection).toBeNull();
    expect(s.wsDownSince).toBe(5_000);
    // what was on screen stays, it is just no longer claimed to be live
    expect(s.positions).toEqual(hello.positions);
    expect(s.balance).toEqual(balance);

    // reconnect attempts do not move the start of the outage
    s = { ...s, ...applyWsStatus(s, 'connecting', 6_000) };
    s = { ...s, ...applyWsStatus(s, 'closed', 7_000) };
    expect(s.wsDownSince).toBe(5_000);

    s = { ...s, ...applyWsStatus(s, 'open', 8_000) };
    expect(s.wsDownSince).toBeNull();
    expect(s.connection).toBeNull(); // until the next hello says otherwise
  });

  it('stampMessage records when the server was last heard and when it last reported its connections', () => {
    const s = initialState('tok');
    expect(stampMessage(s, { type: 'pong', data: { ts: 1 } }, 42)).toEqual({ lastMessageAt: 42 });
    expect(stampMessage(s, { type: 'connection', data: connection }, 43)).toEqual({ lastMessageAt: 43, connectionAt: 43, privateDownSince: null });
    expect(stampMessage(s, { type: 'hello', data: hello }, 44)).toEqual({ lastMessageAt: 44, connectionAt: 44, privateDownSince: null });
  });

  it('stampMessage keeps the time the account stream was first reported down until it is connected again', () => {
    const down: ConnectionStatus = { ...connection, okxPrivate: 'disconnected' };
    let s = initialState('tok');
    s = { ...s, ...stampMessage(s, { type: 'hello', data: { ...hello, connection: down } }, 100) };
    expect(s.privateDownSince).toBe(100);
    s = { ...s, ...stampMessage(s, { type: 'connection', data: { ...down, okxPrivate: 'connecting' } }, 105) };
    expect(s.privateDownSince).toBe(100);
    // the socket to the server drops: nothing is known about the account stream any more
    expect(applyWsStatus(s, 'closed', 110).privateDownSince).toBeNull();
    s = { ...s, ...stampMessage(s, { type: 'connection', data: connection }, 120) };
    expect(s.privateDownSince).toBeNull();
  });

  it('remembers whether the account was ever loaded, across a socket drop', () => {
    const unloaded: ConnectionStatus = { ...connection, account: { state: 'starting', error: null, lastSyncAt: null, readOnly: false } };
    let s = initialState('tok');
    expect(s.accountLoaded).toBe(false);
    s = { ...s, ...applyServerMessage(s, { type: 'hello', data: { ...hello, connection: unloaded } }) };
    expect(s.accountLoaded).toBe(false);
    s = { ...s, ...applyServerMessage(s, { type: 'connection', data: connection }) };
    expect(s.accountLoaded).toBe(true);
    s = { ...s, ...applyWsStatus(s, 'closed', 5_000) };
    expect(s.accountLoaded).toBe(true);
    // a restarted server that has not loaded the account yet sends empty lists: they are not a flat account
    s = { ...s, ...applyServerMessage(s, { type: 'hello', data: { ...hello, connection: unloaded } }) };
    expect(s.accountLoaded).toBe(false);
  });
});

describe('activeAlerts', () => {
  const healthy: ConnectionStatus = { ...connection, okxBusiness: 'connected' };
  const at = new Date(2026, 9, 4, 14, 3, 22).getTime();
  const live = { wsStatus: 'open' as const, wsDownSince: null, lastMessageAt: at, connection: healthy, connectionAt: at, privateDownSince: null };

  it('is empty while everything is connected and fresh', () => {
    expect(activeAlerts(live, at + 1_000)).toEqual([]);
  });

  it('reports a backend socket that has not been open for more than 3 s, with the time of the last server message', () => {
    const down = { ...live, wsStatus: 'closed' as const, wsDownSince: at + 20_000, connection: null, connectionAt: null };
    expect(activeAlerts(down, at + 22_000)).toEqual([]);
    const alerts = activeAlerts(down, at + 23_001);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.en).toBe('Backend disconnected since 14:03:22. Prices, order book and positions below are frozen.');
    expect(alerts[0]?.zh).toBe('与后端的连接已断开，下方数据已停止更新');
    // still trying to reconnect counts as not open
    expect(activeAlerts({ ...down, wsStatus: 'connecting' }, at + 60_000)).toHaveLength(1);
    // never connected at all
    expect(activeAlerts({ ...down, lastMessageAt: null }, at + 60_000)[0]?.en).toContain('Cannot reach the backend');
  });

  it('reports an OKX socket that is not connected', () => {
    const pub = activeAlerts({ ...live, connection: { ...healthy, okxPublic: 'disconnected', dataAgeMs: 60_000, staleStreams: ['BTC-USDT-SWAP:ticker', 'BTC-USDT-SWAP:book', 'BTC-USDT-SWAP:mark'] } }, at);
    // one line for the feed, not a second one listing every stream of it
    expect(pub.map((a) => a.id)).toEqual(['okx-public']);
    expect(pub[0]?.en).toBe('OKX market data feed disconnected. Prices and order books are frozen. Oldest data: 14:02:22.');
    const biz = activeAlerts({ ...live, connection: { ...healthy, okxBusiness: 'connecting' } }, at);
    expect(biz.map((a) => a.id)).toEqual(['okx-business']);
    expect(biz[0]?.zh.length).toBeGreaterThan(0);
  });

  it('reports stale streams by name', () => {
    const one = activeAlerts({ ...live, connection: { ...healthy, dataAgeMs: 95_000, staleStreams: ['SOL-USDT-SWAP:book'] } }, at);
    expect(one.map((a) => a.id)).toEqual(['stale']);
    expect(one[0]?.en).toBe('Market data stopped updating: SOL-USDT-SWAP order book. Those values are frozen. Oldest data: 14:01:47.');
    const many = activeAlerts({ ...live, connection: { ...healthy, staleStreams: ['A:mark', 'B:mark', 'C:ticker', 'D:book', 'E:book'] } }, at);
    expect(many[0]?.en).toContain('A mark price, B mark price, C price (+2 more)');
  });

  it('reports an account stream that stays down while the account itself is fine', () => {
    const down = (okxPrivate: 'connecting' | 'disconnected', state: 'disabled' | 'starting' | 'ok') => ({
      ...live,
      privateDownSince: at,
      connection: { ...healthy, okxPrivate, account: { state, error: null, lastSyncAt: state === 'ok' ? at : null, readOnly: false } },
    });
    // a reconnect that succeeds within 10 s is not worth a banner
    expect(activeAlerts(down('disconnected', 'ok'), at + 10_000)).toEqual([]);
    const alerts = activeAlerts(down('disconnected', 'ok'), at + 10_001);
    expect(alerts.map((a) => a.id)).toEqual(['okx-private']);
    expect(alerts[0]?.en).toBe('OKX account stream disconnected since 14:03:22. Positions, orders and balance refresh only about once a minute.');
    expect(alerts[0]?.zh).toBe('OKX 账户推送已断开，持仓、委托和余额约每分钟才刷新一次');
    expect(activeAlerts(down('connecting', 'ok'), at + 60_000)[0]?.en).toContain('OKX account stream connecting since 14:03:22');
    // without an API key the private socket is never connected, and while the account still loads the panels say so
    expect(activeAlerts(down('disconnected', 'disabled'), at + 60_000)).toEqual([]);
    expect(activeAlerts(down('disconnected', 'starting'), at + 60_000)).toEqual([]);
    expect(activeAlerts({ ...live, privateDownSince: null }, at + 60_000)).toEqual([]);
  });

  it('reports an account that cannot be reached in plain language with the code and text of OKX', () => {
    const failed = (code: string, message: string, lastSyncAt: number | null, okxPrivate: 'connected' | 'disconnected' = 'disconnected') =>
      activeAlerts({ ...live, privateDownSince: at - 600_000, connection: { ...healthy, okxPrivate, account: { state: 'error', error: { code, message, ts: at }, lastSyncAt, readOnly: false } } }, at);

    const never = failed('50105', 'Invalid OK-ACCESS-PASSPHRASE.', null);
    expect(never.map((a) => a.id)).toEqual(['account']);
    expect(never[0]?.en).toBe(
      'Account data is not updating: the API passphrase is wrong (OKX: [50105] Invalid OK-ACCESS-PASSPHRASE.). Positions, orders and balance are NOT loaded: an empty table does not mean a flat account.',
    );
    expect(never[0]?.zh).toBe('账户数据未更新：API 密码短语（passphrase）错误。持仓、委托和余额尚未加载，空表不代表空仓');

    // it worked before: say since when the numbers on screen are frozen
    const frozen = failed('50110', 'Invalid IP', at - 300_000);
    expect(frozen.map((a) => a.id)).toEqual(['account']);
    expect(frozen[0]?.en).toBe(
      "Account data is not updating since 13:58:22: this computer's IP address is not on the API key's allow-list (OKX: [50110] Invalid IP). Positions, orders and balance below are from that time.",
    );
    expect(frozen[0]?.zh).toBe('账户数据已停止更新：本机 IP 不在 API key 的白名单内。下方持仓、委托和余额不是最新数据');

    // the login of the stream is rejected but the reconcile succeeds every minute: the data IS updating, only slower
    const slow = failed('60009', 'login failed: Login failed.', at - 30_000);
    expect(slow.map((a) => a.id)).toEqual(['account']);
    expect(slow[0]?.en).toBe(
      'Live account stream unavailable: OKX rejected the login of the account stream; check the API key, secret and passphrase (OKX: [60009] login failed: Login failed.). Positions, orders and balance refresh about once a minute.',
    );
    expect(slow[0]?.zh).toContain('账户实时推送不可用');
    // one reconcile failed while pushes keep arriving
    const pushed = failed('', 'fetch failed', at - 5_000, 'connected');
    expect(pushed[0]?.en).toBe('The last account refresh failed (fetch failed). Live updates from the account stream still arrive.');
    expect(pushed[0]?.zh).toBe('账户定时刷新失败，实时推送仍在更新');
    // exactly 90 s old still counts as updating, like the "as of" label
    expect(failed('', 'fetch failed', at - 90_000)[0]?.en).toContain('Live account stream unavailable');
    expect(failed('', 'fetch failed', at - 90_001)[0]?.en).toContain('Account data is not updating since');

    expect(failed('50101', 'Broker id of APIKey does not match current environment.', null)[0]?.en).toContain('other OKX environment');
    expect(failed('50102', 'Timestamp request expired', null)[0]?.en).toContain('clock');
    expect(failed('60009', 'login failed: Login failed.', null)[0]?.en).toContain('rejected the login of the account stream');

    // a code the notes do not document, and a failure that did not come from OKX: verbatim, no guess
    expect(failed('59999', 'Something new', null)[0]?.en).toContain('Account data is not updating (OKX: [59999] Something new). ');
    expect(failed('', 'could not reach OKX (ENOTFOUND)', null)[0]?.en).toContain('Account data is not updating (could not reach OKX (ENOTFOUND)). ');
    expect(failed('59999', 'Something new', null)[0]?.zh).toBe('账户数据未更新。持仓、委托和余额尚未加载，空表不代表空仓');

    // no banner while the account is fine, still starting, or not configured
    for (const state of ['ok', 'starting', 'disabled'] as const) {
      expect(activeAlerts({ ...live, connection: { ...healthy, account: { state, error: null, lastSyncAt: null, readOnly: false } } }, at)).toEqual([]);
    }
  });

  it('accountAsOf: the time of the last sync once it is older than 90 s', () => {
    const synced = (lastSyncAt: number | null): ConnectionStatus => ({ ...healthy, account: { ...healthy.account, lastSyncAt } });
    expect(accountAsOf(synced(at), at + 90_000)).toBeNull();
    expect(accountAsOf(synced(at), at + 90_001)).toBe(at);
    expect(accountAsOf(synced(null), at)).toBeNull();
    expect(accountAsOf(null, at)).toBeNull();
  });

  it('accountUnknown: an empty account is only a flat account once it was loaded', () => {
    const acct = (state: 'disabled' | 'starting' | 'ok' | 'error', lastSyncAt: number | null) => ({
      connection: { ...healthy, account: { state, error: null, lastSyncAt, readOnly: false } },
      accountLoaded: lastSyncAt !== null,
      lastMessageAt: at,
    });
    expect(accountUnknown(acct('disabled', null))).toBe('disabled');
    expect(accountUnknown(acct('starting', null))).toBe('loading');
    expect(accountUnknown(acct('error', null))).toBe('failed');
    expect(accountUnknown(acct('ok', at))).toBeNull();
    expect(accountUnknown(acct('error', at))).toBeNull(); // loaded once: the banner and "as of" say it is old
    // the socket to the server is down: what was loaded before stays a real account, anything else is not a flat one
    expect(accountUnknown({ connection: null, accountLoaded: true, lastMessageAt: at })).toBeNull();
    expect(accountUnknown({ connection: null, accountLoaded: false, lastMessageAt: at })).toBe('unloaded');
    expect(accountUnknown({ connection: null, accountLoaded: false, lastMessageAt: null })).toBe('waiting');
  });

  it('killSwitchSweepNotice: promises the cancel only when it can happen', () => {
    const account = { posMode: 'long_short_mode' as const, acctLv: '2', canTrade: true };
    expect(killSwitchSweepNotice({ connection: healthy, account })).toContain('ALL open orders on the account will be cancelled');
    // the socket to the server is down but the account was loaded: the server still sweeps
    expect(killSwitchSweepNotice({ connection: null, account })).toContain('ALL open orders on the account will be cancelled');
    const readOnly = killSwitchSweepNotice({ connection: healthy, account: { ...account, canTrade: false } });
    expect(readOnly).toContain('read-only');
    expect(readOnly).not.toContain('will be cancelled');
    const noKey = killSwitchSweepNotice({ connection: { ...healthy, okxPrivate: 'disconnected', account: { state: 'disabled', error: null, lastSyncAt: null, readOnly: false } }, account: null });
    expect(noKey).toBe('No API key is configured, so Pegasus cannot cancel anything: your open orders on OKX stay as they are.');
    const notLoaded = killSwitchSweepNotice({ connection: { ...healthy, account: { state: 'error', error: { code: '50105', message: 'x', ts: at }, lastSyncAt: null, readOnly: false } }, account: null });
    expect(notLoaded).toContain('The account is not loaded');
    expect(notLoaded).not.toContain('will be cancelled');
  });

  it('isStreamStale: listed streams, and everything while the server cannot be heard', () => {
    const c = { ...healthy, staleStreams: ['SOL-USDT-SWAP:book'] };
    expect(isStreamStale({ connection: c }, 'SOL-USDT-SWAP', 'book')).toBe(true);
    expect(isStreamStale({ connection: c }, 'SOL-USDT-SWAP', 'ticker')).toBe(false);
    expect(isStreamStale({ connection: c }, 'BTC-USDT-SWAP', 'book')).toBe(false);
    expect(isStreamStale({ connection: null }, 'BTC-USDT-SWAP', 'book')).toBe(true);
  });
});
