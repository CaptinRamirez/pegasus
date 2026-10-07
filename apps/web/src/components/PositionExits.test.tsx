import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AlgoOrder, CampaignView, Position } from '@pegasus/shared';
import { api } from '../lib/api';
import { ApiError } from '../lib/http';
import { useStore } from '../store/store';
import { initialState } from '../store/types';
import { campaigns, runningView } from '../test/campaign-fixtures';
import { SIGNAL_INSTRUMENTS, trailingOn } from '../test/signals-fixtures';
import { PositionsTable } from './PositionsTable';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return {
    ...mod,
    api: {
      trailing: vi.fn(),
      algoOrders: vi.fn(),
      candles: vi.fn(() => Promise.resolve([])),
      placeTakeProfits: vi.fn(),
      placeTrailingStop: vi.fn(),
      setChannelTrailing: vi.fn(),
      clearChannelTrailing: vi.fn(),
      cancelAlgoOrder: vi.fn(),
    },
  };
});

const pos = (instId: string, size: string, avgPx: string, markPx: string): Position => ({
  instId, posSide: 'net', mgnMode: 'isolated', pos: size, avgPx, markPx, upl: '1', uplRatio: '0.01', lever: '10', liqPx: '1', margin: '10', notionalUsd: '100', cTime: 1, uTime: 1,
});
const algo = (o: Partial<AlgoOrder>): AlgoOrder => ({
  algoId: 'a', algoClOrdId: '', instId: 'ETH-USDT-SWAP', side: 'sell', posSide: 'net', tdMode: 'isolated', sz: '10', closeFraction: '', slTriggerPx: '', slTriggerPxType: '', slOrdPx: '-1', tpTriggerPx: '', cTime: 1, uTime: 1, ...o,
});
const eth = pos('ETH-USDT-SWAP', '20', '3020.5', '3188.75');
const xrp = pos('XRP-USDT-SWAP', '30', '0.622', '0.6219');
const orders: AlgoOrder[] = [
  algo({ algoId: 'sl-eth', sz: '20', slTriggerPx: '2905.4', slTriggerPxType: 'mark' }),
  algo({ algoId: 'tp-b', tpTriggerPx: '3550' }),
  algo({ algoId: 'tp-a', tpTriggerPx: '3400' }),
  algo({ algoId: 'tr-xrp', instId: 'XRP-USDT-SWAP', sz: '30', ordType: 'move_order_stop', callbackRatio: '0.05', moveTriggerPx: '0.5908' }),
];

describe('the exits of a position', () => {
  let root: Root;
  let container: HTMLDivElement;
  const trailing = vi.mocked(api.trailing);
  const algoOrders = vi.mocked(api.algoOrders);
  const placeTakeProfits = vi.mocked(api.placeTakeProfits);
  const placeTrailingStop = vi.mocked(api.placeTrailingStop);
  const setChannelTrailing = vi.mocked(api.setChannelTrailing);
  const clearChannelTrailing = vi.mocked(api.clearChannelTrailing);
  const cancelAlgoOrder = vi.mocked(api.cancelAlgoOrder);
  const confirm = vi.spyOn(window, 'confirm');

  beforeEach(() => {
    for (const m of [trailing, algoOrders, placeTakeProfits, placeTrailingStop, setChannelTrailing, clearChannelTrailing, cancelAlgoOrder]) m.mockReset();
    trailing.mockResolvedValue(trailingOn);
    algoOrders.mockResolvedValue({ orders, ts: Date.now() });
    confirm.mockReset();
    confirm.mockReturnValue(true);
    useStore.setState({
      ...initialState('tok'),
      instruments: SIGNAL_INSTRUMENTS,
      account: { posMode: 'net_mode', acctLv: '2', canTrade: true },
      accountLoaded: true,
      positions: [eth, xrp],
      algoOrders: { orders, ts: Date.now() },
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
          <PositionsTable />
        </QueryClientProvider>,
      );
    });
  };
  const until = async (what: string, cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (cond()) return;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    throw new Error(`timeout waiting for ${what}`);
  };
  const column = (label: string): string[] => {
    const col = [...container.querySelectorAll('thead th')].map((th) => th.textContent).indexOf(label);
    return [...container.querySelectorAll('tbody tr')].map((tr) => tr.querySelectorAll('td')[col]?.textContent ?? '');
  };
  const exitsButton = (row: number) => container.querySelectorAll<HTMLButtonElement>('button.pos-exits')[row];
  const dialog = () => document.body.querySelector<HTMLElement>('.exits-dialog');
  const button = (label: string) => [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent === label);
  const type = (input: HTMLInputElement | null | undefined, value: string): Promise<void> =>
    act(async () => {
      if (input === null || input === undefined) throw new Error('no input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const toasts = (): string[] => useStore.getState().toasts.map((t) => `${t.kind}: ${t.message}`);

  it('show the take-profit legs, the exchange trailing stop and the channel level of every position', async () => {
    await render();
    await until('the channel', () => column('Trailing')[1]?.includes('channel') === true);
    expect(column('Take-profit')).toEqual(['3,400 / 3,550', '–']);
    expect(column('Trailing')).toEqual(['–', 'channel 10d · 0.5712callback 5.00% · 0.5908']);
    expect(column('Stop')).toEqual(['2,905.4', 'no stopadd stop']);
  });

  it('places take-profit legs for an open position, each closing its share of it', async () => {
    placeTakeProfits.mockResolvedValue({ instId: 'ETH-USDT-SWAP', posSide: 'net', legs: [{ algoId: 't1', triggerPx: '3700', sz: '10' }] });
    await render();
    await until('the exits', () => exitsButton(0)?.disabled === false);
    await act(async () => exitsButton(0)?.click());
    const form = () => dialog()?.querySelectorAll<HTMLElement>('.exits-form')[0];
    expect(dialog()?.querySelector('.overlay-title')?.textContent).toBe('Exits of ETH-USDT-SWAP long');
    // what rests already, take-profits lowest first
    expect([...(dialog()?.querySelectorAll('.exits-section')[1]?.querySelectorAll('.exits-item') ?? [])].map((i) => i.textContent)).toEqual(['3,400 · 10 ctCancel', '3,550 · 10 ctCancel']);
    const inputs = () => [...(form()?.querySelectorAll<HTMLInputElement>('input') ?? [])];
    // the program proposes the level beyond the legs already resting (2R = 3,250.7 would sit under both): the first
    // whole R step past 3,550, 5R from the average 3,020.5 over the stop 2,905.4; the resting legs cover the whole
    // position, so no share is proposed and the hint says why
    expect(inputs()[0]?.value).toBe('5');
    expect(inputs()[1]?.value).toBe('');
    expect(form()?.querySelector('.exit-echo')?.textContent).toBe('= 3,596 · +19.05%');
    expect(form()?.querySelector('.exits-resting')?.textContent).toBe('The resting take-profits already cover the whole position (20 contracts): cancel one to add a leg.');
    expect(form()?.querySelector('.exit-hint.warn')?.textContent).toBe('Take-profit 1: no share yet.');
    expect(button('Place take-profits')?.disabled).toBe(true);
    // a price of the trader's own instead
    const basis = form()?.querySelector<HTMLSelectElement>('select.exit-basis');
    await act(async () => {
      if (basis === null || basis === undefined) throw new Error('no basis');
      basis.value = 'price';
      basis.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(inputs()[0]?.value).toBe('3596');
    await type(inputs()[0], '3700');
    await type(inputs()[1], '50');
    expect(form()?.querySelector('.exit-echo')?.textContent).toBe('+22.50% · 5.90R · 10 ct · +679.50 USDT');
    await act(async () => button('Place take-profits')?.click());
    await until('the legs', () => placeTakeProfits.mock.calls.length === 1);
    expect(placeTakeProfits).toHaveBeenCalledWith({ instId: 'ETH-USDT-SWAP', mgnMode: 'isolated', takeProfits: [{ triggerPx: '3700', fraction: '0.5' }] });
    await until('the toast', () => toasts().length === 1);
    expect(toasts()).toEqual(['success: 1 take-profit leg placed for ETH-USDT-SWAP']);
    expect(algoOrders).toHaveBeenCalled();
  });

  it('sets channel trailing or the exchange trailing stop, stops channel trailing, and cancels an exit after asking', async () => {
    setChannelTrailing.mockResolvedValue({ ...trailingOn.entries[0]!, instId: 'ETH-USDT-SWAP' });
    placeTrailingStop.mockResolvedValue({ algoId: 'tr1', instId: 'ETH-USDT-SWAP', posSide: 'net', sz: '20', callbackRatio: '0.03', activePx: '' });
    clearChannelTrailing.mockResolvedValue({ instId: 'XRP-USDT-SWAP', mgnMode: 'isolated', posSide: 'net', cleared: true });
    cancelAlgoOrder.mockResolvedValue({ algoId: 'tr-xrp', instId: 'XRP-USDT-SWAP' });
    await render();
    await until('the exits', () => exitsButton(0)?.disabled === false);
    await act(async () => exitsButton(0)?.click());
    const trailForm = () => dialog()?.querySelectorAll<HTMLElement>('.exits-form')[1];
    await type(trailForm()?.querySelector<HTMLInputElement>('input'), '15');
    await act(async () => [...(trailForm()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent === 'Place')?.click());
    await until('channel trailing', () => setChannelTrailing.mock.calls.length === 1);
    expect(setChannelTrailing).toHaveBeenCalledWith({ instId: 'ETH-USDT-SWAP', mgnMode: 'isolated', bars: 15 });
    await act(async () => [...(trailForm()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent === 'Callback')?.click());
    const ratio = () => trailForm()?.querySelectorAll<HTMLInputElement>('input')[0];
    await type(ratio(), '3');
    // the trigger is measured from the mark price of the position, not from its average entry
    expect(trailForm()?.querySelector('.exit-now')?.textContent).toBe('Closes once the price comes back 3% from its highest since activation; at the current price that is 3,093.08.');
    await act(async () => [...(trailForm()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent === 'Place')?.click());
    await until('the trailing stop', () => placeTrailingStop.mock.calls.length === 1);
    expect(placeTrailingStop).toHaveBeenCalledWith({ instId: 'ETH-USDT-SWAP', mgnMode: 'isolated', ratio: '0.03' });
    await act(async () => dialog()?.querySelector<HTMLButtonElement>('.overlay-close')?.click());

    await act(async () => exitsButton(1)?.click());
    expect(dialog()?.textContent).toContain('10-day channel, stop at 0.5712');
    expect(dialog()?.textContent).toContain('last moved 0.565 → 0.5712');
    await act(async () => button('Stop channel trailing')?.click());
    await until('the clear', () => clearChannelTrailing.mock.calls.length === 1);
    expect(clearChannelTrailing).toHaveBeenCalledWith({ instId: 'XRP-USDT-SWAP', mgnMode: 'isolated' });
    expect(confirm.mock.calls.at(-1)?.[0]).toBe('Stop channel trailing for XRP-USDT-SWAP? The stop stays where it is.');
    await act(async () => dialog()?.querySelectorAll('.exits-section')[2]?.querySelector<HTMLButtonElement>('button')?.click());
    await until('the cancel', () => cancelAlgoOrder.mock.calls.length === 1);
    expect(cancelAlgoOrder).toHaveBeenCalledWith({ instId: 'XRP-USDT-SWAP', algoId: 'tr-xrp' });
    expect(confirm.mock.calls.at(-1)?.[0]).toBe('Cancel the trailing stop of XRP-USDT-SWAP?');
  });

  it('says a refusal in words from its code', async () => {
    placeTakeProfits.mockRejectedValue(new ApiError('TP_EXCEEDS_POSITION', 'the take-profits would close 30 contracts of a position of 20', { existing: '20', requested: '10', size: '20' }, 400));
    await render();
    await until('the exits', () => exitsButton(0)?.disabled === false);
    await act(async () => exitsButton(0)?.click());
    const inputs = () => [...(dialog()?.querySelectorAll<HTMLElement>('.exits-form')[0]?.querySelectorAll<HTMLInputElement>('input') ?? [])];
    await type(inputs()[0], '3700');
    await type(inputs()[1], '50');
    await act(async () => button('Place take-profits')?.click());
    await until('the refusal', () => dialog()?.querySelector('[role="alert"].notice') !== null);
    expect(dialog()?.querySelector('.notice-danger')?.textContent).toBe(
      "With the 20 contracts the take-profits already close, these 10 would close more than the position's 20: cancel one or ask for less.",
    );
    expect(toasts()[0]).toContain('error: Not done:');
  });

  it('a position without resting take-profits gets the plain proposal for all of it, and a channel level from the daily bars', async () => {
    vi.mocked(api.candles).mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({ ts: 1_700_000_000_000 + i * 86_400_000, open: '0.6', high: '0.7', low: i === 11 ? '0.9' : String(0.58 + i * 0.001), close: '0.65', vol: '1', volCcy: '1', confirm: i < 11 })),
    );
    await render();
    await until('the exits', () => exitsButton(1)?.disabled === false);
    await act(async () => exitsButton(1)?.click());
    const form = () => dialog()?.querySelectorAll<HTMLElement>('.exits-form')[0];
    const inputs = () => [...(form()?.querySelectorAll<HTMLInputElement>('input') ?? [])];
    // no stop on the position: 10% from the average, for the whole position, with the leg's contracts and profit
    expect([inputs()[0]?.value, inputs()[1]?.value]).toEqual(['10', '100']);
    expect(form()?.querySelector('.exit-echo')?.textContent).toBe('= 0.6842 · 30 ct · +186.60 USDT');
    expect(form()?.querySelector('.exits-resting')).toBeNull();
    // the channel level kept for the position for its own days; for other days the N-day low of the confirmed daily bars
    const trailForm = () => dialog()?.querySelectorAll<HTMLElement>('.exits-form')[1];
    await until('the kept level', () => trailForm()?.querySelector('.exit-now')?.textContent?.includes('0.5712') === true);
    await type(trailForm()?.querySelector<HTMLInputElement>('input'), '5');
    await until('the level from the bars', () => trailForm()?.querySelector('.exit-now')?.textContent?.includes('0.586') === true);
    expect(trailForm()?.querySelector('.exit-now')?.textContent).toBe('The stop is now at 0.586 (the lowest low of the last 5 daily bars) and moves up only, after every 00:00 UTC close.');
  });

  it('where exits are not offered the Exits button is disabled and says why', async () => {
    trailing.mockRejectedValue(new ApiError('EXITS_UNAVAILABLE', 'exits are offered in paper trading only', undefined, 403));
    await render();
    await until('the answer', () => exitsButton(0)?.title.includes('paper trading') === true);
    expect(exitsButton(0)?.disabled).toBe(true);
    expect(exitsButton(0)?.title).toBe('Take-profit and trailing exits are offered in paper trading and against the local mock only.');
  });

  it("a position of the campaign: its exits are the rule's, nothing can be set by hand", async () => {
    const open = campaigns.find((c) => c.end === null);
    if (open === undefined) throw new Error('fixture');
    const view: CampaignView = { ...runningView, campaigns: [{ ...open, instId: 'XRP-USDT-SWAP' }] };
    useStore.setState({ campaign: view });
    await render();
    await until('the exits', () => exitsButton(1)?.disabled === false);
    await act(async () => exitsButton(1)?.click());
    expect(dialog()?.querySelector('.notice-warn')?.textContent).toBe("The campaign's position: its exits are the rule's and are not set by hand.");
    expect(button('Stop channel trailing')?.disabled).toBe(true);
    expect(button('Place take-profits')?.disabled).toBe(true);
  });
});

