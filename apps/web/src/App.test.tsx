import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HelloPayload, Instrument, ServerMessage } from '@pegasus/shared';
import { App } from './App';
import { LANG_KEY, useLangStore } from './i18n';
import { TOKEN_KEY } from './lib/http';
import { useStore } from './store/store';
import { initialState } from './store/types';

vi.mock('./hooks/useCandleChart', () => ({ useCandleChart: () => undefined }));

class FakeSocket {
  static last: FakeSocket | null = null;
  static readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public readonly url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  push(msg: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const btc: Instrument = {
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
  lotSz: '1',
  minSz: '1',
  tickSz: '0.1',
  maxLmtSz: '100000',
  maxMktSz: '10000',
  maxLever: '100',
  state: 'live',
};

const hello: HelloPayload = {
  demo: true,
  instruments: [btc],
  account: { posMode: 'net_mode', acctLv: '2', canTrade: true },
  riskConfig: {
    maxOrderNotional: '5000',
    maxPositionNotionalPerInstrument: '20000',
    maxTotalPositionNotional: '50000',
    maxLeverage: '10',
    dailyLossLimit: '1000',
    maxOpenOrders: 20,
    priceBandPct: '0.05',
    maxSlippagePct: '0.005',
  },
  risk: {
    killSwitch: false,
    killSwitchReason: '',
    cancelSweep: { state: 'idle', message: '', ts: 1 },
    dayStartTs: 0,
    dayStartEquity: '10000',
    baselineTs: 0,
    currentEquity: '10123.45',
    dailyPnl: '123.45',
    openOrders: 0,
    totalPositionNotional: '0',
    overLimit: [],
    totalOverLimit: '',
    updatedAt: 1,
  },
  connection: { okxPublic: 'connected', okxPrivate: 'connected', okxBusiness: 'connected', account: { state: 'ok', error: null, lastSyncAt: Date.now(), readOnly: false }, demo: true, dataAgeMs: 5, staleStreams: [] },
  balance: { totalEq: '10123.45', details: [{ ccy: 'USDT', eq: '10123.45', availEq: '9000', cashBal: '10000', upl: '123.45' }], ts: 1 },
  positions: [
    { instId: 'BTC-USDT-SWAP', posSide: 'net', mgnMode: 'cross', pos: '3', avgPx: '60000', markPx: '61000', upl: '30', uplRatio: '0.0166', lever: '5', liqPx: '50000', margin: '360', notionalUsd: '1830', cTime: 1, uTime: 2 },
  ],
  openOrders: [],
  algoOrders: null,
  paper: false,
  serverTime: 1,
};

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('App', () => {
  let root: Root;
  let container: HTMLDivElement;
  const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>();

  beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.startsWith('/api/orders/history') || url.startsWith('/api/fills') || url.startsWith('/api/candles')) return Promise.resolve(envelope([]));
      if (url.startsWith('/api/account/leverage')) return Promise.resolve(envelope([{ instId: 'BTC-USDT-SWAP', mgnMode: 'cross', posSide: 'net', lever: '5' }]));
      if (url.startsWith('/api/instruments')) return Promise.resolve(envelope([btc]));
      return Promise.resolve(envelope(null));
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    localStorage.clear();
    useStore.setState({ ...initialState(null) });
    useLangStore.setState({ lang: 'en' });
  });

  const render = async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <App />
        </QueryClientProvider>,
      );
    });
  };

  it('shows the token gate without a token and signs in after validating it', async () => {
    useStore.setState({ token: null });
    await render();
    expect(container.textContent).toContain('API token');
    const input = container.querySelector<HTMLInputElement>('input#token');
    expect(input).not.toBeNull();
    if (input === null) return;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'tok123');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = container.querySelector('form');
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(localStorage.getItem(TOKEN_KEY)).toBe('tok123');
    expect(useStore.getState().token).toBe('tok123');
    expect(container.textContent).toContain('Order ticket');
  });

  it('renders the terminal from a hello message and subscribes to the first instrument', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok');
    useStore.setState({ token: 'tok' });
    await render();
    const ws = FakeSocket.last;
    expect(ws).not.toBeNull();
    if (ws === null) return;
    expect(ws.url).toContain('/ws?token=tok');

    await act(async () => {
      ws.push({ type: 'hello', data: hello });
    });
    expect(ws.sent).toContain(JSON.stringify({ type: 'subscribe', instId: 'BTC-USDT-SWAP', bar: useStore.getState().bar }));

    const text = container.textContent ?? '';
    expect(text).toContain('DEMO');
    expect(text).toContain('10,123.45 USD');
    expect(text).toContain('+123.45');
    expect(text).toContain('BTC-USDT-SWAP');
    expect(text).toContain('0.03 BTC'); // 3 contracts * 0.01 ctVal in the positions table
    expect(text).toContain('Enter a size to preview');

    await act(async () => {
      ws.push({ type: 'ticker', data: { instId: 'BTC-USDT-SWAP', last: '61234.5', lastSz: '1', bidPx: '61234', bidSz: '1', askPx: '61235', askSz: '1', open24h: '60000', high24h: '62000', low24h: '59000', vol24h: '1000', volCcy24h: '10', ts: 2 } });
      ws.push({ type: 'book', data: { instId: 'BTC-USDT-SWAP', bids: [['61234', '10'], ['61233', '5']], asks: [['61235', '7'], ['61236', '3']], ts: 3 } });
      ws.push({ type: 'trades', data: [{ instId: 'BTC-USDT-SWAP', tradeId: 't1', px: '61234.5', sz: '2', side: 'buy', ts: 4 }] });
    });
    const after = container.textContent ?? '';
    expect(after).toContain('61,234.5');
    expect(after).toContain('+2.06%');
    expect(container.querySelectorAll('.book-row')).toHaveLength(4);
    expect(container.querySelectorAll('.tape-row.buy')).toHaveLength(1);
    expect(container.querySelectorAll('.banner')).toHaveLength(0);
    expect(container.querySelectorAll('.panel-stale, .inst-row.stale')).toHaveLength(0);

    // the server flags the book: banner, dimmed panel; the price is still live
    await act(async () => {
      ws.push({ type: 'connection', data: { ...hello.connection, dataAgeMs: 95_000, staleStreams: ['BTC-USDT-SWAP:book'] } });
    });
    expect(container.querySelector('.banner')?.textContent).toContain('Market data stopped updating: BTC-USDT-SWAP order book');
    expect(container.querySelectorAll('.panel-book.panel-stale')).toHaveLength(1);
    expect(container.querySelectorAll('.panel-trades.panel-stale, .inst-row.stale')).toHaveLength(0);

    // the socket to the server closes: no dot claims to be connected and everything on screen is marked
    await act(async () => {
      ws.onclose?.();
    });
    expect(container.querySelectorAll('.dot.connected')).toHaveLength(0);
    expect(container.querySelectorAll('.panel-book.panel-stale, .panel-trades.panel-stale, .inst-row.stale')).toHaveLength(3);
    expect(container.textContent).toContain('61,234.5'); // the last values stay visible
  });

  it('dims Last, Mark and 24h vol in the chart header when their stream is stale', async () => {
    const ws = await connect(hello);
    await act(async () => {
      ws.push({ type: 'ticker', data: { instId: 'BTC-USDT-SWAP', last: '61234.5', lastSz: '1', bidPx: '61234', bidSz: '1', askPx: '61235', askSz: '1', open24h: '60000', high24h: '62000', low24h: '59000', vol24h: '1000', volCcy24h: '10', ts: 2 } });
      ws.push({ type: 'markPrice', data: { instId: 'BTC-USDT-SWAP', markPx: '61230.1', ts: 2 } });
    });
    const stale = (): string[] => [...container.querySelectorAll('.chart-info .stale')].map((el) => el.textContent ?? '');
    expect(stale()).toEqual([]);
    await act(async () => {
      ws.push({ type: 'connection', data: { ...hello.connection, dataAgeMs: 35_000, staleStreams: ['BTC-USDT-SWAP:mark'] } });
    });
    expect(stale()).toEqual(['Mark 61,230.1']);
    expect(container.querySelector('.chart-info .stale')?.getAttribute('title')).toBe('Mark price stopped updating');
    await act(async () => {
      ws.push({ type: 'connection', data: { ...hello.connection, dataAgeMs: 125_000, staleStreams: ['BTC-USDT-SWAP:ticker'] } });
    });
    expect(stale().map((t) => t.split(' ')[0])).toEqual(['Last', '24h']);
    // the socket to the server is down: nothing in the header may read as current
    await act(async () => {
      ws.onclose?.();
    });
    expect(stale()).toHaveLength(3);
  });

  it('does not read as a flat account while the server was never heard or the account never loaded', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok');
    useStore.setState({ token: 'tok' });
    await render();
    const ws = FakeSocket.last;
    if (ws === null) throw new Error('no socket');
    const tab = async (label: string): Promise<void> => {
      await act(async () => {
        [...container.querySelectorAll<HTMLButtonElement>('button.tab')].find((b) => b.textContent?.startsWith(label))?.click();
      });
    };
    const emptyTexts = (): string[] => [...container.querySelectorAll('.panel-bottom .empty, .col-right .empty')].map((el) => el.textContent ?? '');
    // the page is open but the API has not said anything yet (it is still starting)
    expect(container.textContent).not.toContain('No open positions');
    expect(container.textContent).not.toContain('No balance yet');
    expect(emptyTexts().filter((t) => t === 'Waiting for server…')).toHaveLength(2);
    await tab('Open orders');
    expect(container.textContent).not.toContain('No open orders');

    // the server answers while the account is still loading, then the socket drops
    await act(async () => {
      ws.push({ type: 'hello', data: { ...hello, account: null, balance: null, positions: [], connection: { ...hello.connection, okxPrivate: 'disconnected', account: { state: 'starting', error: null, lastSyncAt: null, readOnly: false } } } });
    });
    expect(container.textContent).toContain('Loading orders');
    await act(async () => {
      ws.onclose?.();
    });
    expect(container.textContent).not.toContain('No open orders');
    expect(container.textContent).not.toContain('No balance yet');
    expect(emptyTexts().filter((t) => t === 'Account not loaded')).toHaveLength(2);
    await tab('Positions');
    expect(container.textContent).not.toContain('No open positions');
    expect(emptyTexts().filter((t) => t === 'Account not loaded')).toHaveLength(2);
  });

  it('a loaded flat account still reads as flat after the socket drops', async () => {
    const ws = await connect({ ...hello, positions: [] });
    expect(container.textContent).toContain('No open positions');
    await act(async () => {
      ws.onclose?.();
    });
    expect(container.textContent).toContain('No open positions');
  });

  const connect = async (data: HelloPayload): Promise<FakeSocket> => {
    localStorage.setItem(TOKEN_KEY, 'tok');
    useStore.setState({ token: 'tok' });
    await render();
    const ws = FakeSocket.last;
    if (ws === null) throw new Error('no socket');
    await act(async () => {
      ws.push({ type: 'hello', data });
    });
    return ws;
  };
  const button = (label: string): HTMLButtonElement | undefined =>
    [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

  it('with a read-only key: order entry, Close and Cancel are disabled and say why', async () => {
    const order = { ordId: 'o1', clOrdId: 'c1', instId: 'BTC-USDT-SWAP', side: 'buy', posSide: 'long', tdMode: 'cross', ordType: 'limit', px: '59000', sz: '1', accFillSz: '0', avgPx: '', state: 'live', reduceOnly: false, lever: '5', fee: '0', feeCcy: '', pnl: '0', cTime: 1, uTime: 1 } as const;
    await connect({
      ...hello,
      account: { posMode: 'long_short_mode', acctLv: '2', canTrade: false },
      connection: { ...hello.connection, account: { ...hello.connection.account, readOnly: true } },
      openOrders: [order],
    });
    const why = 'Read-only API key: trading from Pegasus is disabled';
    expect(container.querySelector('.notice-warn')?.textContent).toBe(why);
    const submit = container.querySelector<HTMLButtonElement>('button.btn-buy');
    expect(submit?.disabled).toBe(true);
    expect(submit?.title).toBe(why);
    expect(button('Close')).toMatchObject({ disabled: true, title: why });
    expect(button('Set')).toMatchObject({ disabled: true, title: why });

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button.tab')].find((b) => b.textContent?.startsWith('Open orders'))?.click();
    });
    expect(button('Cancel')).toMatchObject({ disabled: true, title: why });
    expect(button('Cancel all')).toMatchObject({ disabled: true, title: why });

    // on a Chinese page the same is said in Chinese
    await act(async () => useLangStore.getState().setLang('zh'));
    const whyZh = '只读 key：无法从 Pegasus 下单';
    expect(container.querySelector('.notice-warn')?.textContent).toBe(whyZh);
    expect(button('撤销')).toMatchObject({ disabled: true, title: whyZh });
    expect(button('全部撤销')).toMatchObject({ disabled: true, title: whyZh });
  });

  it('before the account is loaded: no net-mode ticket is offered, and the account message fixes it without a reload', async () => {
    const ws = await connect({
      ...hello,
      account: null,
      balance: null,
      positions: [],
      connection: { ...hello.connection, okxPrivate: 'disconnected', account: { state: 'starting', error: null, lastSyncAt: null, readOnly: false } },
    });
    expect(container.querySelector<HTMLButtonElement>('button.btn-buy')?.disabled).toBe(true);
    expect(container.querySelector('.notice-warn')?.textContent).toContain('Account not loaded');
    expect(container.textContent).not.toContain('Reduce only');
    expect(container.textContent).not.toContain('No open positions');
    expect(container.textContent).toContain('Loading positions');

    await act(async () => {
      ws.push({ type: 'account', data: { posMode: 'long_short_mode', acctLv: '2', canTrade: true } });
    });
    expect(container.querySelector('.notice-warn')).toBeNull();
    // long/short mode: the side buttons and the close checkbox state the intent; there is no free position-side control
    expect(container.textContent).toContain('Close / reduce existing position');
    expect(container.textContent).not.toContain('Position side');
    expect(container.textContent).not.toContain('Reduce only');
  });

  it('reloads the candle history after a gap: on every later hello and when the OKX candle feed comes back', async () => {
    const candleFetches = (): number => fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/candles')).length;
    const settle = (): Promise<void> =>
      act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    fetchMock.mockClear();
    const ws = await connect(hello);
    await settle();
    expect(candleFetches()).toBe(1);

    // an ordinary status message changes nothing
    await act(async () => {
      ws.push({ type: 'connection', data: { ...hello.connection, dataAgeMs: 7 } });
    });
    await settle();
    expect(candleFetches()).toBe(1);

    // the business socket drops and comes back: the bars of the gap were never pushed
    await act(async () => {
      ws.push({ type: 'connection', data: { ...hello.connection, okxBusiness: 'disconnected' } });
    });
    await settle();
    expect(candleFetches()).toBe(1);
    await act(async () => {
      ws.push({ type: 'connection', data: { ...hello.connection, okxBusiness: 'connecting' } });
      ws.push({ type: 'connection', data: hello.connection });
    });
    await settle();
    expect(candleFetches()).toBe(2);

    // the socket to the server was down (PC sleep, API restart): the next hello reloads
    await act(async () => {
      ws.push({ type: 'hello', data: hello });
    });
    await settle();
    expect(candleFetches()).toBe(3);
  });

  it('says so when the account cannot be reached or no API key is configured, instead of looking flat', async () => {
    const down = { ...hello, account: null, balance: null, positions: [] };
    const ws = await connect({
      ...down,
      connection: { ...hello.connection, okxPrivate: 'disconnected', account: { state: 'error', error: { code: '50111', message: 'Invalid OK-ACCESS-KEY', ts: 1 }, lastSyncAt: null, readOnly: false } },
    });
    const banner = container.querySelector('.banner')?.textContent ?? '';
    expect(banner).toContain('OKX does not recognise the API key (OKX: [50111] Invalid OK-ACCESS-KEY)');
    expect(banner).not.toContain('API key 无效');
    expect(container.textContent).toContain('Positions not loaded');
    expect(container.textContent).not.toContain('No open positions');

    await act(async () => {
      ws.push({ type: 'connection', data: { ...hello.connection, okxPrivate: 'disconnected', account: { state: 'disabled', error: null, lastSyncAt: null, readOnly: false } } });
    });
    expect(container.querySelectorAll('.banner')).toHaveLength(0);
    expect(container.textContent).toContain('No API key configured: only market data is shown');
    expect(container.textContent).not.toContain('未配置 API key，仅显示行情');
    expect(container.textContent).toContain('No API key configured: positions are not shown');
  });

  it('switches the whole page between English and Chinese from the header and remembers the choice', async () => {
    const noAccount = { state: 'error', error: { code: '50111', message: 'Invalid OK-ACCESS-KEY', ts: 1 }, lastSyncAt: null, readOnly: false } as const;
    const ws = await connect({ ...hello, account: null, balance: null, positions: [], connection: { ...hello.connection, okxPrivate: 'disconnected', account: noAccount } });
    expect(container.textContent).toContain('Order ticket');
    expect(localStorage.getItem(LANG_KEY)).toBeNull();

    await act(async () => {
      button('中文')?.click();
    });
    expect(localStorage.getItem(LANG_KEY)).toBe('zh');
    expect([...container.querySelectorAll('button.tab')].map((b) => b.textContent)).toEqual(['持仓', '当前委托', '止损单', '历史委托', '成交记录', '信号']);
    const banner = container.querySelector('.banner')?.textContent ?? '';
    expect(banner).toContain('账户数据未更新：API key 无效（OKX: [50111] Invalid OK-ACCESS-KEY）');
    expect(banner).not.toContain('Account data is not updating');
    expect(container.textContent).toContain('持仓未加载');
    expect(container.textContent).toContain('下单');
    expect(container.textContent).not.toContain('Order ticket');
    expect(button('退出登录')).toBeUndefined(); // a link, not a button
    expect(container.querySelector('header a')?.textContent).toBe('退出登录');

    await act(async () => {
      ws.push({ type: 'connection', data: { ...hello.connection, okxPrivate: 'disconnected', account: { state: 'disabled', error: null, lastSyncAt: null, readOnly: false } } });
    });
    expect(container.textContent).toContain('未配置 API key，仅显示行情');

    await act(async () => {
      button('EN')?.click();
    });
    expect(localStorage.getItem(LANG_KEY)).toBe('en');
    expect(container.textContent).toContain('No API key configured: only market data is shown');
    expect(container.textContent).toContain('Order ticket');
  });

  it('the token gate offers the language switch before signing in', async () => {
    useStore.setState({ token: null });
    await render();
    expect(container.textContent).toContain('Sign in');
    await act(async () => {
      button('中文')?.click();
    });
    expect(container.querySelector('label[for="token"]')?.textContent).toBe('API 令牌');
    expect(container.querySelector('button[type="submit"]')?.textContent).toBe('登录');
  });

  it('asks the kill-switch question in the language of the page', async () => {
    const confirm = vi.fn<(text?: string) => boolean>(() => false);
    vi.stubGlobal('confirm', confirm);
    await connect(hello);
    await act(async () => useLangStore.getState().setLang('zh'));
    await act(async () => {
      button('紧急停止')?.click();
    });
    const asked = confirm.mock.calls[0]?.[0] ?? '';
    expect(asked).toContain('确定开启紧急停止？');
    expect(asked).toContain('账户上的全部当前委托都会被撤销');
    expect(asked).not.toContain('Engage the kill switch');
  });

  it('the kill-switch dialog says that ALL open orders are cancelled, and the risk panel shows how the cancel sweep went', async () => {
    const confirm = vi.fn<(text?: string) => boolean>(() => false);
    vi.stubGlobal('confirm', confirm);
    const ws = await connect(hello);
    await act(async () => {
      button('Kill switch')?.click();
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    const asked = confirm.mock.calls[0]?.[0] ?? '';
    expect(asked).toContain('ALL open orders on the account will be cancelled');
    expect(asked).toContain('resting exit orders');
    expect(asked).toContain('orders you placed on OKX directly');
    expect(container.textContent).not.toContain('Cancel all open orders:');

    const on = { ...hello.risk, killSwitch: true, killSwitchReason: 'manual (terminal)' };
    await act(async () => {
      ws.push({ type: 'risk', data: { ...on, cancelSweep: { state: 'pending', message: 'cancel failed: [50011] Requests too frequent., retrying in 10 s', ts: 2 } } });
    });
    expect(container.querySelector('.notice-warn')?.textContent).toBe('Cancel all open orders: cancel failed: [50011] Requests too frequent., retrying in 10 s');
    await act(async () => {
      ws.push({ type: 'risk', data: { ...on, cancelSweep: { state: 'done', message: 'open orders cancelled', ts: 3 } } });
    });
    expect(container.querySelector('.notice-ok')?.textContent).toBe('Cancel all open orders: open orders cancelled');
    await act(async () => {
      ws.push({ type: 'risk', data: { ...on, cancelSweep: { state: 'failed', message: 'cancel failed: [50120] no permission', ts: 4 } } });
    });
    expect(container.textContent).toContain('Cancel all open orders: cancel failed: [50120] no permission. Open orders are NOT cancelled; cancel them on OKX.');
  });

  it('without an API key or a loaded account the kill-switch dialog does not promise a cancel', async () => {
    const confirm = vi.fn<(text?: string) => boolean>(() => false);
    vi.stubGlobal('confirm', confirm);
    const ws = await connect({ ...hello, account: null, balance: null, positions: [], connection: { ...hello.connection, okxPrivate: 'disconnected', account: { state: 'disabled', error: null, lastSyncAt: null, readOnly: false } } });
    await act(async () => {
      button('Kill switch')?.click();
    });
    expect(confirm.mock.calls[0]?.[0]).toContain('No API key is configured, so Pegasus cannot cancel anything');
    expect(confirm.mock.calls[0]?.[0]).not.toContain('will be cancelled');
    await act(async () => {
      ws.push({ type: 'connection', data: { ...hello.connection, okxPrivate: 'disconnected', account: { state: 'error', error: { code: '50111', message: 'Invalid OK-ACCESS-KEY', ts: 1 }, lastSyncAt: null, readOnly: false } } });
    });
    await act(async () => {
      button('Kill switch')?.click();
    });
    expect(confirm.mock.calls[1]?.[0]).toContain('The account is not loaded');
    expect(confirm.mock.calls[1]?.[0]).not.toContain('will be cancelled');
  });

  it('the reply to the kill-switch toggle updates the risk state without counting as a message from the socket', async () => {
    vi.stubGlobal('confirm', () => true);
    const ws = await connect(hello);
    await act(async () => {
      ws.onclose?.();
    });
    useStore.setState({ lastMessageAt: 1_234 });
    fetchMock.mockImplementation((input) =>
      Promise.resolve(envelope(String(input).startsWith('/api/risk/kill-switch') ? { ...hello.risk, killSwitch: true, killSwitchReason: 'manual (terminal)' } : [])),
    );
    await act(async () => {
      button('Kill switch')?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(useStore.getState().risk?.killSwitch).toBe(true);
    expect(button('KILL SWITCH ON')).toBeDefined();
    // "Backend disconnected since ..." quotes this time: an HTTP reply must not move it
    expect(useStore.getState().lastMessageAt).toBe(1_234);
  });

  it('releasing while the daily loss limit is breached asks in plain words before sending rebase', async () => {
    const confirm = vi.fn<(text?: string) => boolean>(() => true);
    vi.stubGlobal('confirm', confirm);
    const halted = { ...hello.risk, killSwitch: true, killSwitchReason: 'DAILY_LOSS_LIMIT: daily PnL -1100 breached -1000', dayStartEquity: '100000', currentEquity: '98900', dailyPnl: '-1100' };
    await connect({ ...hello, risk: halted });
    const sent = (): unknown[] =>
      (fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit | undefined]>)
        .filter(([input]) => String(input).startsWith('/api/risk/kill-switch'))
        .map(([, init]) => JSON.parse(String(init?.body)) as unknown);
    fetchMock.mockClear();
    fetchMock.mockImplementation((input) => {
      if (!String(input).startsWith('/api/risk/kill-switch')) return Promise.resolve(envelope([]));
      if (sent().length === 1) {
        const refusal = { ok: false, error: { code: 'DAILY_LOSS_ACTIVE', message: 'the daily loss limit is still breached', details: { dailyPnl: '-1100', limit: '1000', equity: '98900' } } };
        return Promise.resolve(new Response(JSON.stringify(refusal), { status: 409, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(envelope({ ...halted, killSwitch: false, killSwitchReason: '', dayStartEquity: '98900', dailyPnl: '0', baselineTs: 5 }));
    });
    await act(async () => {
      button('KILL SWITCH ON')?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // the plain release is tried first; only the server's refusal brings up the second question
    expect(sent()).toEqual([{ enabled: false }, { enabled: false, rebase: true }]);
    expect(confirm).toHaveBeenCalledTimes(2);
    const asked = confirm.mock.calls[1]?.[0] ?? '';
    expect(asked).toContain("today's PnL is -1,100.00 USD and the limit is -1,000 USD");
    expect(asked).toContain('restarts at 0 from the current equity (98,900.00 USD)');
    expect(asked).not.toContain('当日亏损');
    expect(useStore.getState().risk).toMatchObject({ killSwitch: false, dayStartEquity: '98900' });
    expect(container.textContent).not.toContain('DAILY_LOSS_ACTIVE');

    // declined: nothing more is sent and the halt stays
    await act(async () => {
      useStore.setState({ risk: halted });
    });
    confirm.mockImplementation((text) => !(text ?? '').includes('The daily loss limit is still in force'));
    fetchMock.mockClear();
    await act(async () => {
      button('KILL SWITCH ON')?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(sent()).toEqual([{ enabled: false }]);
    expect(useStore.getState().risk?.killSwitch).toBe(true);
  });

  it('the risk panel says since when daily PnL is counted when that is not the UTC day start', async () => {
    const day = Date.UTC(2026, 9, 4);
    const label = (): string => [...container.querySelectorAll('.kv-list .k')].map((el) => el.textContent ?? '').find((t) => t.startsWith('Daily PnL')) ?? '';
    // the first balance of the day, seconds after 00:00 UTC: the plain label
    const ws = await connect({ ...hello, risk: { ...hello.risk, dayStartTs: day, baselineTs: day + 20_000 } });
    expect(label()).toBe('Daily PnL');
    expect(container.textContent).toContain('Day start equity');
    // the terminal was started at 09:12 UTC (or the baseline was rebased then)
    await act(async () => {
      ws.push({ type: 'risk', data: { ...hello.risk, dayStartTs: day, baselineTs: day + (9 * 60 + 12) * 60_000 } });
    });
    expect(label()).toBe('Daily PnL since 09:12 UTC');
    expect(container.textContent).toContain('Baseline equity');
    expect(container.textContent).not.toContain('Day start equity');
  });

  it('a halt from an unreadable state file is explained under the kill-switch notice', async () => {
    await connect({ ...hello, risk: { ...hello.risk, killSwitch: true, killSwitchReason: 'STATE_FILE_UNREADABLE: the state file C:\\pegasus\\data\\pegasus-state.json could not be parsed (Unexpected end of JSON input); the saved halt and day baseline are unknown' } });
    const notice = [...container.querySelectorAll('.notice-danger')].map((el) => el.textContent ?? '').find((t) => t.startsWith('KILL SWITCH ON')) ?? '';
    expect(notice).toContain('pegasus-state.json could not be parsed');
    expect(notice).not.toContain('状态文件无法读取');
    // the server words the reason in English; the Chinese page adds what it means and what to do
    await act(async () => useLangStore.getState().setLang('zh'));
    const noticeZh = [...container.querySelectorAll('.notice-danger')].map((el) => el.textContent ?? '').find((t) => t.startsWith('紧急停止已开启 —')) ?? '';
    expect(noticeZh).toContain('pegasus-state.json could not be parsed');
    expect(noticeZh).toContain('状态文件无法读取');
  });

  it('with a read-only key the kill-switch dialog does not promise a cancel, and the panel says the sweep was skipped', async () => {
    const confirm = vi.fn<(text?: string) => boolean>(() => false);
    vi.stubGlobal('confirm', confirm);
    const ws = await connect({ ...hello, account: { posMode: 'long_short_mode', acctLv: '2', canTrade: false } });
    await act(async () => {
      button('Kill switch')?.click();
    });
    const asked = confirm.mock.calls[0]?.[0] ?? '';
    expect(asked).toContain('read-only');
    expect(asked).toContain('your open orders on OKX stay as they are');
    expect(asked).not.toContain('will be cancelled');
    await act(async () => {
      ws.push({ type: 'risk', data: { ...hello.risk, killSwitch: true, killSwitchReason: 'manual (terminal)', cancelSweep: { state: 'skipped', message: 'skipped: read-only key', ts: 2 } } });
    });
    expect(container.textContent).toContain('Cancel all open orders: skipped: read-only key. Open orders are NOT cancelled; cancel them on OKX.');
  });

  it('labels account data with its time once the last sync is older than 90 s', async () => {
    const ws = await connect(hello);
    expect(container.textContent).not.toContain('as of');
    const old = new Date(Date.now() - 200_000);
    await act(async () => {
      ws.push({ type: 'connection', data: { ...hello.connection, account: { ...hello.connection.account, lastSyncAt: old.getTime() } } });
    });
    const hms = [old.getHours(), old.getMinutes(), old.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
    expect(container.querySelector('.panel-head .stale-tag')?.textContent).toBe(`as of ${hms}`);
    expect(container.querySelector('caption.as-of')?.textContent).toBe(`Positions as of ${hms}`);
  });
});
