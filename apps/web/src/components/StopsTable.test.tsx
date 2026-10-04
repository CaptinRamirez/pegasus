import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AlgoOrder, Instrument, Position } from '@pegasus/shared';
import { api } from '../lib/api';
import { ApiError } from '../lib/http';
import { STOPS_STALE_MS } from '../store/alerts';
import { useStore } from '../store/store';
import { initialState } from '../store/types';
import { StopsTable, loosensStop } from './StopsTable';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return { ...mod, api: { algoOrders: vi.fn(), amendAlgoOrder: vi.fn(), cancelAlgoOrder: vi.fn() } };
});

const BTC = 'BTC-USDT-SWAP';
const btc: Instrument = {
  instId: BTC, instType: 'SWAP', uly: 'BTC-USDT', baseCcy: 'BTC', quoteCcy: 'USDT', settleCcy: 'USDT', ctVal: '0.01', ctValCcy: 'BTC', ctMult: '1',
  ctType: 'linear', lotSz: '1', minSz: '1', tickSz: '0.1', maxLmtSz: '100000', maxMktSz: '10000', maxLever: '100', state: 'live',
};
const long: Position = {
  instId: BTC, posSide: 'net', mgnMode: 'cross', pos: '10', avgPx: '60000', markPx: '61000', upl: '0', uplRatio: '0', lever: '3', liqPx: '', margin: '', notionalUsd: '6100', cTime: 1, uTime: 1,
};
const stop = (overrides: Partial<AlgoOrder> = {}): AlgoOrder => ({
  algoId: 'a1', algoClOrdId: 'slpg1', instId: BTC, side: 'sell', posSide: 'net', tdMode: 'cross', sz: '10', closeFraction: '', slTriggerPx: '59000', slTriggerPxType: 'mark', slOrdPx: '-1', tpTriggerPx: '',
  cTime: 1_700_000_000_000, uTime: 1_700_000_000_000,
  ...overrides,
});

describe('loosensStop', () => {
  it('a lower stop under a long and a higher stop over a short give the position more room to lose', () => {
    expect(loosensStop(stop(), '58000')).toBe(true);
    expect(loosensStop(stop(), '59500')).toBe(false);
    expect(loosensStop(stop({ side: 'buy' }), '60000')).toBe(true);
    expect(loosensStop(stop({ side: 'buy' }), '58000')).toBe(false);
  });
});

describe('StopsTable', () => {
  let root: Root;
  let container: HTMLDivElement;
  const read = vi.mocked(api.algoOrders);
  const amend = vi.mocked(api.amendAlgoOrder);
  const cancel = vi.mocked(api.cancelAlgoOrder);
  const confirm = vi.spyOn(window, 'confirm');

  beforeEach(() => {
    read.mockReset();
    amend.mockReset();
    cancel.mockReset();
    confirm.mockReset();
    useStore.setState({
      ...initialState('tok'),
      instruments: [btc],
      account: { posMode: 'net_mode', acctLv: '2', canTrade: true },
      accountLoaded: true,
      lastMessageAt: Date.now(),
      positions: [long],
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

  const render = async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <StopsTable />
        </QueryClientProvider>,
      );
    });
  };
  const text = (): string => container.textContent ?? '';
  const button = (label: string): HTMLButtonElement | undefined => [...container.querySelectorAll('button')].find((b) => b.textContent === label);
  const click = async (label: string) => {
    await act(async () => {
      button(label)?.click();
    });
  };
  const type = async (value: string) => {
    const input = container.querySelector('input');
    if (!input) throw new Error('no input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const toasts = (): string[] => useStore.getState().toasts.map((t) => `${t.kind}: ${t.message}`);

  it('says that the stops were not read instead of showing an empty table, and Refresh reads them', async () => {
    await render();
    expect(text()).toContain('Stops have not been read from OKX yet');
    read.mockResolvedValue({ orders: [stop()], ts: Date.now() });
    await click('Refresh');
    expect(read).toHaveBeenCalledTimes(1);
    expect(text()).toContain('59,000');
    expect(text()).not.toContain('have not been read');
  });

  it('an empty list that was read says so, with the time it was read', async () => {
    useStore.setState({ algoOrders: { orders: [], ts: Date.now() } });
    await render();
    expect(text()).toContain('No stops resting at OKX: read from OKX at');
    expect(container.querySelector('.stale-tag')).toBeNull();
  });

  it('shows a stop with its trigger, execution and size, and marks a list that is no longer refreshed', async () => {
    useStore.setState({ algoOrders: { orders: [stop()], ts: Date.now() - STOPS_STALE_MS - 1_000 } });
    await render();
    const cells = [...container.querySelectorAll('tbody tr td')].map((td) => td.textContent);
    expect(cells.slice(1, 7)).toEqual([BTC, 'long cross', '59,000 mark', 'market', '10', '–']);
    expect(container.querySelector('caption')?.textContent).toContain('(not refreshed since)');
    expect(container.querySelector('.stop-tag')).toBeNull();
  });

  it('tags a stop whose position is gone, and one that closes the whole position', async () => {
    useStore.setState({ positions: [], algoOrders: { orders: [stop({ sz: '', closeFraction: '1' })], ts: Date.now() } });
    await render();
    expect(container.querySelector('.stop-tag')?.textContent).toBe('no position');
    expect(text()).toContain('whole position');
  });

  it('moves a stop towards the price without asking, and reports what the server did', async () => {
    useStore.setState({ algoOrders: { orders: [stop()], ts: Date.now() } });
    amend.mockResolvedValue({ algoId: 'a1', instId: BTC, slTriggerPx: '59500', previous: '59000' });
    await render();
    expect(button('Move')?.disabled).toBe(true); // nothing typed yet
    await type('59500');
    await click('Move');
    expect(confirm).not.toHaveBeenCalled();
    expect(amend).toHaveBeenCalledWith({ instId: BTC, algoId: 'a1', slTriggerPx: '59500' });
    expect(toasts()).toEqual([`success: Stop moved: ${BTC} 59000 → 59500`]);
    expect(container.querySelector('input')?.value).toBe('');
  });

  it('asks before moving a stop away from the price, and sends nothing when the answer is no', async () => {
    useStore.setState({ algoOrders: { orders: [stop()], ts: Date.now() } });
    await render();
    await type('58000');
    confirm.mockReturnValue(false);
    await click('Move');
    expect(confirm.mock.calls[0]?.[0]).toContain('AWAY from the price (59000 → 58000)');
    expect(amend).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    amend.mockRejectedValue(new ApiError('VALIDATION', 'the stop-loss trigger 58000 must be below the mark price 57000', undefined, 400));
    await click('Move');
    expect(amend).toHaveBeenCalledTimes(1);
    expect(toasts()[0]).toContain('error: Stop NOT moved:');
  });

  it('refuses a price that is not a positive number before anything is sent', async () => {
    useStore.setState({ algoOrders: { orders: [stop()], ts: Date.now() } });
    await render();
    await type('abc');
    await click('Move');
    expect(amend).not.toHaveBeenCalled();
    expect(toasts()).toEqual(['error: Enter the new stop price as a positive number']);
  });

  it('cancels a stop only after a confirmation that says the position loses it', async () => {
    useStore.setState({ algoOrders: { orders: [stop()], ts: Date.now() } });
    cancel.mockResolvedValue({ algoId: 'a1', instId: BTC });
    await render();
    confirm.mockReturnValue(false);
    await click('Cancel');
    expect(confirm.mock.calls[0]?.[0]).toBe(`Cancel the ${BTC} stop at 59000? Its position will be left without this stop.`);
    expect(cancel).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await click('Cancel');
    expect(cancel).toHaveBeenCalledWith({ instId: BTC, algoId: 'a1' });
    expect(toasts()).toEqual([`info: Stop cancelled: ${BTC} a1`]);
  });

  it('a read-only key can look but neither move nor cancel', async () => {
    useStore.setState({ account: { posMode: 'net_mode', acctLv: '2', canTrade: false }, algoOrders: { orders: [stop()], ts: Date.now() } });
    await render();
    await type('59500');
    expect(button('Move')?.disabled).toBe(true);
    expect(button('Cancel')?.disabled).toBe(true);
    expect(button('Refresh')?.disabled).toBe(false);
  });
});
