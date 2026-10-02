import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HelloPayload, Instrument, ServerMessage } from '@pegasus/shared';
import { App } from './App';
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
  account: { posMode: 'net_mode', acctLv: '2' },
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
    dayStartTs: 0,
    dayStartEquity: '10000',
    currentEquity: '10123.45',
    dailyPnl: '123.45',
    openOrders: 0,
    totalPositionNotional: '0',
    updatedAt: 1,
  },
  connection: { okxPublic: 'connected', okxPrivate: 'connected', okxBusiness: 'connected', demo: true, lastMessageAgeMs: 5 },
  balance: { totalEq: '10123.45', details: [{ ccy: 'USDT', eq: '10123.45', availEq: '9000', cashBal: '10000', upl: '123.45' }], ts: 1 },
  positions: [
    { instId: 'BTC-USDT-SWAP', posSide: 'net', mgnMode: 'cross', pos: '3', avgPx: '60000', markPx: '61000', upl: '30', uplRatio: '0.0166', lever: '5', liqPx: '50000', margin: '360', notionalUsd: '1830', cTime: 1, uTime: 2 },
  ],
  openOrders: [],
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
  });
});
