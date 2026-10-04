import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Fill, Instrument, Order, Position } from '@pegasus/shared';
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
  return { ...mod, api: { orderHistory: vi.fn(), fills: vi.fn() } };
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
    expect(untracked[9]).toBe('0.0000031'); // liq px
    expect(untracked[10]).toBe('–'); // margin: OKX reported none
    const tracked = cells(rows[1]);
    expect(tracked[0]).toBe('BTC-USDT-SWAP');
    expect(tracked[4]).toBe('60,000');
    expect(tracked[10]).toBe('610.00');
    expect(rows[1]?.querySelector('.untracked-tag')).toBeNull();
  });
});
