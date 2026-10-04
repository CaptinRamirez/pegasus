import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AlgoOrder, Fill, Instrument, Order, Position, RiskState } from '@pegasus/shared';
import { api } from '../lib/api';
import { ApiError } from '../lib/http';
import { useHistorySeed } from '../hooks/useSession';
import { useStore } from '../store/store';
import { initialState } from '../store/types';
import { FillsTable } from './FillsTable';
import { OrdersTable } from './OrdersTable';
import { PositionsTable } from './PositionsTable';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return { ...mod, api: { orderHistory: vi.fn(), fills: vi.fn(), placeStop: vi.fn() } };
});

const btc: Instrument = {
  instId: 'BTC-USDT-SWAP', instType: 'SWAP', uly: 'BTC-USDT', baseCcy: 'BTC', quoteCcy: 'USDT', settleCcy: 'USDT', ctVal: '0.01', ctValCcy: 'BTC', ctMult: '1',
  ctType: 'linear', lotSz: '1', minSz: '1', tickSz: '0.1', maxLmtSz: '100000', maxMktSz: '10000', maxLever: '100', state: 'live',
};

const fill: Fill = { tradeId: 't1', ordId: 'o1', clOrdId: '', instId: 'BTC-USDT-SWAP', side: 'buy', posSide: 'long', fillPx: '61000', fillSz: '2', fee: '-0.1', feeCcy: 'USDT', execType: 'T', ts: 1_700_000_000_000 };
const order: Order = {
  ordId: 'o1', clOrdId: 'c1', instId: 'BTC-USDT-SWAP', side: 'buy', posSide: 'long', tdMode: 'cross', ordType: 'limit', px: '61000', sz: '2', accFillSz: '2', avgPx: '61000',
  state: 'filled', reduceOnly: false, lever: '3', fee: '-0.1', feeCcy: 'USDT', pnl: '0', cTime: 1_700_000_000_000, uTime: 1_700_000_000_000,
};
/** A position the owner opened on OKX in an instrument Pegasus does not track. */
const pepe: Position = {
  instId: 'PEPE-USDT-SWAP', posSide: 'long', mgnMode: 'cross', pos: '0.5', avgPx: '0.0000085', markPx: '0.0000086', upl: '1.2', uplRatio: '0.01',
  lever: '3', liqPx: '0.0000031', margin: '', notionalUsd: '43', cTime: 1, uTime: 1,
};

function Seeded({ children }: { children: React.ReactNode }) {
  useHistorySeed();
  return <>{children}</>;
}

describe('History and Fills tables', () => {
  let root: Root;
  let container: HTMLDivElement;
  const orderHistory = vi.mocked(api.orderHistory);
  const fills = vi.mocked(api.fills);
  const down = (): Promise<never> => Promise.reject(new ApiError('NETWORK', 'Failed to fetch', undefined, 0));

  beforeEach(() => {
    orderHistory.mockReset();
    fills.mockReset();
    useStore.setState({ ...initialState('tok'), instruments: [btc] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useStore.setState({ ...initialState(null) });
  });

  const render = async (table: React.ReactNode) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <Seeded>{table}</Seeded>
        </QueryClientProvider>,
      );
    });
  };
  const until = async (what: string, cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      if (cond()) return;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    }
    throw new Error(`timeout waiting for ${what}`);
  };
  const text = (): string => container.textContent ?? '';

  it('a failed first load is retried on the first hello: the page was opened before the API was up', async () => {
    orderHistory.mockImplementation(down);
    fills.mockImplementation(down);
    await render(<FillsTable />);
    await until('the failure', () => text().includes('Could not load fills'));
    expect(text()).not.toContain('No fills');

    orderHistory.mockResolvedValue([order]);
    fills.mockResolvedValue([fill]);
    const before = fills.mock.calls.length;
    await act(async () => {
      useStore.setState({ helloSeq: 1 });
    });
    await until('the fills', () => text().includes('61,000'));
    expect(fills.mock.calls.length).toBe(before + 1);
    expect(text()).not.toContain('Could not load');
  });

  it('a first hello after a successful load does not fetch again; a later one does', async () => {
    orderHistory.mockResolvedValue([order]);
    fills.mockResolvedValue([fill]);
    await render(<FillsTable />);
    await until('the fills', () => text().includes('61,000'));
    await act(async () => {
      useStore.setState({ helloSeq: 1 });
    });
    expect(fills).toHaveBeenCalledTimes(1);
    await act(async () => {
      useStore.setState({ helloSeq: 2 });
    });
    await until('the refetch', () => fills.mock.calls.length === 2);
  });

  it('says that the history could not be loaded instead of "No order history", and Retry loads it', async () => {
    orderHistory.mockImplementation(down);
    fills.mockResolvedValue([]);
    await render(<OrdersTable mode="history" />);
    await until('the failure', () => text().includes('Could not load order history'));
    expect(text()).not.toContain('No order history');
    orderHistory.mockResolvedValue([order]);
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry');
    await act(async () => {
      retry?.click();
    });
    await until('the history', () => text().includes('filled'));
    expect(text()).not.toContain('Could not load');
  });

  it('marks a partial table: rows pushed live while the seed failed', async () => {
    orderHistory.mockResolvedValue([]);
    fills.mockImplementation(down);
    useStore.setState({ fills: [fill] });
    await render(<FillsTable />);
    await until('the failure', () => text().includes('Could not load earlier fills'));
    expect(text()).toContain('61,000');
  });

  it('open orders show the stop attached to a resting order, and a dash when there is none', async () => {
    const resting: Order = { ...order, state: 'live', accFillSz: '0', avgPx: '' };
    useStore.setState({ orders: { o1: { ...resting, slTriggerPx: '58000' }, o2: { ...resting, ordId: 'o2', cTime: order.cTime - 1 } } });
    await render(<OrdersTable mode="open" />);
    const headers = [...container.querySelectorAll('th')].map((th) => th.textContent);
    const col = headers.indexOf('Stop');
    expect(col).toBe(headers.indexOf('Price') + 1);
    const stops = [...container.querySelectorAll('tbody tr')].map((tr) => tr.querySelectorAll('td')[col]?.textContent);
    expect(stops).toEqual(['58,000', '–']);
    expect(container.querySelector('tbody .untracked-tag')).toBeNull();
  });

  it('a partially filled open order shows that its stop is not active until the order is filled', async () => {
    const partial: Order = { ...order, state: 'partially_filled', accFillSz: '1' };
    useStore.setState({ orders: { o1: { ...partial, slTriggerPx: '58000' }, o2: { ...partial, ordId: 'o2', cTime: order.cTime - 1 } } });
    await render(<OrdersTable mode="open" />);
    const col = [...container.querySelectorAll('th')].map((th) => th.textContent).indexOf('Stop');
    const cells = [...container.querySelectorAll('tbody tr')].map((tr) => tr.querySelectorAll('td')[col]);
    expect(cells.map((td) => td?.textContent)).toEqual(['58,000not active', '–']);
    expect(cells[0]?.querySelector('span')?.getAttribute('title')).toContain('only when the order is completely filled');
    expect(cells[0]?.querySelector('span')?.getAttribute('title')).toContain('WITHOUT a stop');
  });

  it('an empty list after a successful load still reads as empty', async () => {
    orderHistory.mockResolvedValue([]);
    fills.mockResolvedValue([]);
    await render(<OrdersTable mode="history" />);
    await until('the load', () => orderHistory.mock.calls.length === 1);
    expect(text()).toBe('No order history');
  });
});

describe('rows of an instrument outside the tracked list', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    useStore.setState({
      ...initialState('tok'),
      instruments: [btc],
      account: { posMode: 'long_short_mode', acctLv: '2', canTrade: true },
      accountLoaded: true,
      positions: [pepe, { ...pepe, instId: 'BTC-USDT-SWAP', pos: '3', avgPx: '60000', markPx: '61000', liqPx: '', margin: '610' }],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useStore.setState({ ...initialState(null) });
  });

  it('are tagged and show their prices and size as reported, not rounded to a default tick and lot', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <PositionsTable />
        </QueryClientProvider>,
      );
    });
    const rows = [...container.querySelectorAll('tbody tr')];
    const cells = (row: Element | undefined): string[] => [...(row?.querySelectorAll('td') ?? [])].map((td) => td.textContent ?? '');
    const untracked = cells(rows[0]);
    expect(untracked[0]).toBe('PEPE-USDT-SWAPuntracked');
    expect(untracked[2]).toBe('0.5'); // contracts
    expect(untracked[4]).toBe('0.0000085'); // avg px
    expect(untracked[6]).toBe('?'); // stop: the stops were not read yet
    expect(untracked[10]).toBe('0.0000031'); // liq px
    expect(untracked[11]).toBe('–'); // margin: OKX reported none
    const tracked = cells(rows[1]);
    expect(tracked[0]).toBe('BTC-USDT-SWAP');
    expect(tracked[4]).toBe('60,000');
    expect(tracked[11]).toBe('610.00');
    expect(rows[1]?.querySelector('.untracked-tag')).toBeNull();
    // no risk state, or nothing over the limit: no row is marked
    expect(container.querySelector('.over-limit')).toBeNull();
    expect(container.querySelector('.over-limit-tag')).toBeNull();
  });

  it('marks the row of a position that has outgrown its limit and shows how much to trim; Close stays enabled', async () => {
    const risk: RiskState = {
      killSwitch: false, killSwitchReason: '', cancelSweep: { state: 'idle', message: '', ts: 1 }, dayStartTs: 0, dayStartEquity: '100000', baselineTs: 0,
      currentEquity: '100000', dailyPnl: '0', openOrders: 0, totalPositionNotional: '36643', updatedAt: 1,
      overLimit: [{ instId: 'BTC-USDT-SWAP', notional: '36600', limit: '30000', excess: '6600' }], totalOverLimit: '',
    };
    // 60 contracts x 0.01 BTC x 61,000 = 36,600: 610 per contract, 6,600 / 610 = 10.8 -> 10 whole contracts
    const big: Position = { ...pepe, instId: 'BTC-USDT-SWAP', pos: '60', avgPx: '20000', markPx: '61000', liqPx: '', margin: '12200', notionalUsd: '36600' };
    useStore.setState({ risk, positions: [pepe, big] });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <PositionsTable />
        </QueryClientProvider>,
      );
    });
    const rows = [...container.querySelectorAll('tbody tr')];
    expect(rows[0]?.classList.contains('over-limit')).toBe(false);
    expect(rows[0]?.querySelector('.over-limit-tag')).toBeNull();
    expect(rows[1]?.classList.contains('over-limit')).toBe(true);
    expect(rows[1]?.querySelector('.over-limit-tag')?.textContent).toBe('over limit: trim 6,600 USD (10 ct)');
    expect(rows[1]?.querySelectorAll('td')[12]?.textContent).toBe('36,600over limit: trim 6,600 USD (10 ct)');
    expect(rows[1]?.querySelector('button')?.disabled).toBe(false);
  });

  it('long/short mode: both legs are marked, the trim is shown on the larger leg only', async () => {
    const risk: RiskState = {
      killSwitch: false, killSwitchReason: '', cancelSweep: { state: 'idle', message: '', ts: 1 }, dayStartTs: 0, dayStartEquity: '100000', baselineTs: 0,
      currentEquity: '100000', dailyPnl: '0', openOrders: 0, totalPositionNotional: '36600', updatedAt: 1,
      overLimit: [{ instId: 'BTC-USDT-SWAP', notional: '36600', limit: '30000', excess: '6600' }], totalOverLimit: '',
    };
    // 20 short + 40 long contracts at 610 each: 12,200 + 24,400 = 36,600 gross, 6,600 over
    const leg: Position = { ...pepe, instId: 'BTC-USDT-SWAP', avgPx: '20000', markPx: '61000', liqPx: '', margin: '1000' };
    const short: Position = { ...leg, posSide: 'short', pos: '20', notionalUsd: '12200' };
    const long: Position = { ...leg, posSide: 'long', pos: '40', notionalUsd: '24400' };
    useStore.setState({ risk, positions: [short, long] });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <PositionsTable />
        </QueryClientProvider>,
      );
    });
    const rows = [...container.querySelectorAll('tbody tr')];
    expect(rows.map((r) => r.classList.contains('over-limit'))).toEqual([true, true]);
    expect(rows[0]?.querySelector('.over-limit-tag')).toBeNull();
    expect(rows[1]?.querySelector('.over-limit-tag')?.textContent).toBe('over limit: trim 6,600 USD (10 ct)');
    expect(container.querySelectorAll('.over-limit-tag')).toHaveLength(1);
  });
});

describe('the stop column of the positions table', () => {
  let root: Root;
  let container: HTMLDivElement;
  const long: Position = { ...pepe, instId: 'BTC-USDT-SWAP', posSide: 'net', pos: '10', avgPx: '60000', markPx: '61000', liqPx: '', margin: '610' };
  const stop = (overrides: Partial<AlgoOrder> = {}): AlgoOrder => ({
    algoId: 'a1', algoClOrdId: '', instId: 'BTC-USDT-SWAP', side: 'sell', posSide: 'net', tdMode: 'cross', sz: '10', closeFraction: '', slTriggerPx: '59000', slTriggerPxType: 'mark', slOrdPx: '-1', tpTriggerPx: '', cTime: 1, uTime: 1,
    ...overrides,
  });

  beforeEach(() => {
    useStore.setState({ ...initialState('tok'), instruments: [btc], account: { posMode: 'net_mode', acctLv: '2', canTrade: true }, accountLoaded: true, positions: [long] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useStore.setState({ ...initialState(null) });
  });

  const stopCell = async (orders: AlgoOrder[] | null): Promise<{ text: string; tag: string | null }> => {
    await act(async () => {
      useStore.setState({ algoOrders: orders === null ? null : { orders, ts: Date.now() } });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <PositionsTable />
        </QueryClientProvider>,
      );
    });
    const col = [...container.querySelectorAll('th')].map((th) => th.textContent).indexOf('Stop');
    const td = container.querySelectorAll('tbody tr td')[col];
    return { text: td?.textContent ?? '', tag: td?.querySelector('.stop-tag')?.textContent ?? null };
  };

  it('is unknown until the stops were read: a missing read is not a missing stop', async () => {
    expect(await stopCell(null)).toEqual({ text: '?', tag: null });
  });

  it('shows the stop price when the position is covered and says so when it has no stop', async () => {
    expect(await stopCell([stop()])).toEqual({ text: '59,000', tag: null });
    expect(await stopCell([])).toEqual({ text: 'no stopadd stop', tag: 'no stop' });
    // the stop of another instrument or of the other side does not count
    expect((await stopCell([stop({ instId: 'ETH-USDT-SWAP' }), stop({ algoId: 'a2', side: 'buy' })])).tag).toBe('no stop');
  });

  it('shows both lots of two cuts, a position that is only partly covered, and stops left over from a closed lot', async () => {
    expect(await stopCell([stop({ sz: '5' }), stop({ algoId: 'a2', sz: '5', slTriggerPx: '58000' })])).toEqual({ text: '59,000 / 58,000', tag: null });
    expect(await stopCell([stop({ sz: '4' })])).toEqual({ text: '59,000covers 4 of 10 ctadd stop', tag: 'covers 4 of 10 ct' });
    expect(await stopCell([stop(), stop({ algoId: 'a2', sz: '5', slTriggerPx: '58000' })])).toEqual({ text: '59,000 / 58,000stops 15 ct > position 10 ct', tag: 'stops 15 ct > position 10 ct' });
  });
});

describe('adding a stop from the positions table', () => {
  let root: Root;
  let container: HTMLDivElement;
  const placeStop = vi.mocked(api.placeStop);
  const prompt = vi.spyOn(window, 'prompt');
  const long: Position = { ...pepe, instId: 'BTC-USDT-SWAP', posSide: 'net', pos: '10', avgPx: '60000', markPx: '61000', liqPx: '', margin: '610' };
  const stop = (sz: string): AlgoOrder => ({
    algoId: `a${sz}`, algoClOrdId: '', instId: 'BTC-USDT-SWAP', side: 'sell', posSide: 'net', tdMode: 'cross', sz, closeFraction: '', slTriggerPx: '59000', slTriggerPxType: 'mark', slOrdPx: '-1', tpTriggerPx: '', cTime: 1, uTime: 1,
  });

  beforeEach(() => {
    placeStop.mockReset();
    prompt.mockReset();
    useStore.setState({ ...initialState('tok'), instruments: [btc], account: { posMode: 'net_mode', acctLv: '2', canTrade: true }, accountLoaded: true, positions: [long] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useStore.setState({ ...initialState(null) });
  });

  const render = async (orders: AlgoOrder[] | null) => {
    useStore.setState({ algoOrders: orders === null ? null : { orders, ts: Date.now() } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <PositionsTable />
        </QueryClientProvider>,
      );
    });
  };
  const addButton = (): HTMLButtonElement | undefined => [...container.querySelectorAll('button')].find((b) => b.textContent === 'add stop');
  const click = async () => {
    await act(async () => {
      addButton()?.click();
    });
  };
  const toasts = (): string[] => useStore.getState().toasts.map((t) => `${t.kind}: ${t.message}`);

  it('offers it only where part of the position has no stop, and only once the stops are known', async () => {
    await render(null);
    expect(addButton()).toBeUndefined();
    await render([stop('10')]);
    expect(addButton()).toBeUndefined();
    await render([stop('10'), stop('5')]); // over: cancel one instead
    expect(addButton()).toBeUndefined();
    await render([]);
    expect(addButton()).toBeDefined();
    await render([stop('4')]);
    expect(addButton()).toBeDefined();
  });

  it('asks for the price, names the uncovered contracts and sends the position, not a size', async () => {
    placeStop.mockResolvedValue({ algoId: 'a9', instId: 'BTC-USDT-SWAP', slTriggerPx: '59000', sz: '6' });
    await render([stop('4')]);
    prompt.mockReturnValue(' 59000 ');
    await click();
    expect(prompt.mock.calls[0]?.[0]).toContain('the 6 contracts of the long position in BTC-USDT-SWAP that have no stop');
    expect(placeStop).toHaveBeenCalledWith({ instId: 'BTC-USDT-SWAP', mgnMode: 'cross', slTriggerPx: '59000' });
    expect(toasts()).toEqual(['success: Stop placed: BTC-USDT-SWAP 6 contracts at 59000']);
  });

  it('sends nothing when the prompt is dismissed or the price is not a positive number, and names the leg in long/short mode', async () => {
    await render([]);
    prompt.mockReturnValue(null);
    await click();
    prompt.mockReturnValue('abc');
    await click();
    expect(placeStop).not.toHaveBeenCalled();
    expect(toasts()).toEqual(['error: Enter the stop price as a positive number']);

    placeStop.mockRejectedValue(new ApiError('VALIDATION', 'the stop-loss trigger 62000 must be below the mark price 61000', undefined, 400));
    await act(async () => {
      useStore.setState({ account: { posMode: 'long_short_mode', acctLv: '2', canTrade: true }, positions: [{ ...long, posSide: 'long' }] });
    });
    prompt.mockReturnValue('62000');
    await click();
    expect(placeStop).toHaveBeenCalledWith({ instId: 'BTC-USDT-SWAP', mgnMode: 'cross', slTriggerPx: '62000', posSide: 'long' });
    expect(toasts()[1]).toContain('error: Stop NOT placed:');
  });

  it('a read-only key is not offered it', async () => {
    useStore.setState({ account: { posMode: 'net_mode', acctLv: '2', canTrade: false } });
    await render([]);
    expect(addButton()).toBeUndefined();
    expect(container.querySelector('.stop-tag')?.textContent).toBe('no stop');
  });
});
