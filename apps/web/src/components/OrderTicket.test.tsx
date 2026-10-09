import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Candle, Instrument, Order, OrderPreview, PlaceOrderRequest, RiskState } from '@pegasus/shared';
import { useLangStore } from '../i18n';
import { api, type LeverageInfo } from '../lib/api';
import { ApiError } from '../lib/http';
import { useStore } from '../store/store';
import { emptyMarket, initialState } from '../store/types';
import { trailingOn } from '../test/signals-fixtures';
import { OrderTicket } from './OrderTicket';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return { ...mod, api: { leverage: vi.fn(), previewOrder: vi.fn(), placeOrder: vi.fn(), trailing: vi.fn(), candles: vi.fn(), campaignSignals: vi.fn(() => Promise.reject(new Error('no signals here'))) } };
});

const eth: Instrument = {
  instId: 'ETH-USDT-SWAP',
  instType: 'SWAP',
  uly: 'ETH-USDT',
  baseCcy: 'ETH',
  quoteCcy: 'USDT',
  settleCcy: 'USDT',
  ctVal: '0.1',
  ctValCcy: 'ETH',
  ctMult: '1',
  ctType: 'linear',
  lotSz: '1',
  minSz: '1',
  tickSz: '0.01',
  maxLmtSz: '100000',
  maxMktSz: '10000',
  maxLever: '100',
  state: 'live',
};
const btc: Instrument = { ...eth, instId: 'BTC-USDT-SWAP', uly: 'BTC-USDT', baseCcy: 'BTC', ctVal: '0.01', ctValCcy: 'BTC', tickSz: '0.1' };

/** The server's reading of a request: the position side is the one the request carries. */
const previewOf = (req: PlaceOrderRequest): OrderPreview => ({
  instId: req.instId,
  side: req.side,
  ordType: req.ordType,
  tdMode: req.tdMode ?? 'cross',
  posSide: req.posSide ?? 'net',
  sz: req.size.value,
  coin: '0.2',
  px: req.px ?? '',
  refPrice: req.px ?? '3000',
  notionalQuote: '600',
  estSlippagePct: '',
  lever: '3',
  slTriggerPx: req.slTriggerPx ?? '',
  stopLossQuote: req.slTriggerPx === undefined ? '' : '40',
  risk: { ok: true, code: 'OK', message: '' },
});

const orderOf = (req: PlaceOrderRequest): Order => ({
  ...(req.slTriggerPx === undefined ? {} : { slTriggerPx: req.slTriggerPx }),
  ordId: 'o1', clOrdId: req.clOrdId ?? '', instId: req.instId, side: req.side, posSide: req.posSide ?? 'net', tdMode: 'cross', ordType: req.ordType, px: req.px ?? '', sz: req.size.value,
  accFillSz: '0', avgPx: '', state: 'live', reduceOnly: false, lever: '3', fee: '0', feeCcy: '', pnl: '0', cTime: 1, uTime: 1,
});

const riskOn: RiskState = {
  killSwitch: true, killSwitchReason: 'manual (terminal)', cancelSweep: { state: 'done', message: 'open orders cancelled', ts: 1 }, dayStartTs: 0,
  dayStartEquity: '10000', baselineTs: 0, currentEquity: '10000', dailyPnl: '0', openOrders: 0, totalPositionNotional: '0', overLimit: [], totalOverLimit: '', updatedAt: 1,
};

describe('OrderTicket', () => {
  let root: Root;
  let container: HTMLDivElement;
  const leverage = vi.mocked(api.leverage);
  const previewOrder = vi.mocked(api.previewOrder);
  const placeOrder = vi.mocked(api.placeOrder);
  const trailing = vi.mocked(api.trailing);
  const candles = vi.mocked(api.candles);

  beforeEach(() => {
    trailing.mockReset();
    candles.mockReset();
    candles.mockResolvedValue([]);
    // an API that does not answer for its exits: the ticket shows no exits section
    trailing.mockRejectedValue(new ApiError('NOT_FOUND', 'route not found', undefined, 404));
    leverage.mockReset();
    leverage.mockImplementation((instId, mgnMode) => Promise.resolve<LeverageInfo[]>([{ instId, mgnMode, posSide: 'long', lever: '3' }, { instId, mgnMode, posSide: 'short', lever: '3' }]));
    previewOrder.mockReset();
    previewOrder.mockImplementation((req) => Promise.resolve(previewOf(req)));
    placeOrder.mockReset();
    placeOrder.mockImplementation((req) => Promise.resolve({ order: orderOf(req), preview: previewOf(req) }));
    useStore.setState({
      ...initialState('tok'),
      instruments: [eth, btc],
      selectedInstId: 'ETH-USDT-SWAP',
      account: { posMode: 'long_short_mode', acctLv: '2', canTrade: true },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useStore.setState({ ...initialState(null) });
    useLangStore.setState({ lang: 'en' });
  });

  const render = async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <OrderTicket />
        </QueryClientProvider>,
      );
    });
  };

  /** Polls until the condition holds; the preview is debounced by 300 ms. */
  const until = async (what: string, cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (cond()) return;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    throw new Error(`timeout waiting for ${what}`);
  };

  const click = (el: Element | null | undefined): Promise<void> =>
    act(async () => {
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  const type = (input: HTMLInputElement | undefined, value: string): Promise<void> =>
    act(async () => {
      if (input === undefined) throw new Error('no input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const sideButton = (label: string): HTMLButtonElement | undefined => [...container.querySelectorAll<HTMLButtonElement>('.btn-group .btn')].find((b) => b.textContent?.startsWith(label));
  const inputs = (): HTMLInputElement[] => [...container.querySelectorAll<HTMLInputElement>('.form input.num')];
  const closeBox = (): HTMLInputElement | null => container.querySelector<HTMLInputElement>('.check input');
  const submit = (): HTMLButtonElement | null => container.querySelector<HTMLButtonElement>('button.btn-buy, button.btn-sell');
  const lastPreviewed = (): PlaceOrderRequest | undefined => previewOrder.mock.calls.at(-1)?.[0];
  /** Fills price and size, and waits for the server's preview of exactly that. */
  const fill = async (px: string, size: string): Promise<void> => {
    await type(inputs()[0], px);
    await type(inputs()[1], size);
    await until('the preview', () => lastPreviewed()?.px === px && lastPreviewed()?.size.value === size && submit()?.disabled === false);
  };
  const prefillShort = (): Promise<void> =>
    act(async () => {
      useStore.getState().applyTicketPrefill({ instId: 'ETH-USDT-SWAP', side: 'sell', ordType: 'limit', px: '3000', sizeValue: '2', sizeUnit: 'contracts' });
    });

  it('long/short mode: switching a pre-filled short entry to Buy opens a long instead of reducing the short', async () => {
    await render();
    await prefillShort();
    await until('the short preview', () => lastPreviewed()?.side === 'sell' && submit()?.disabled === false);
    expect(lastPreviewed()).toMatchObject({ side: 'sell', posSide: 'short', reduceOnly: false });
    expect(submit()?.textContent).toBe('Open short: Sell ETH limit');

    await click(sideButton('Buy'));
    await until('the long preview', () => lastPreviewed()?.side === 'buy' && submit()?.disabled === false);
    expect(lastPreviewed()).toMatchObject({ side: 'buy', posSide: 'long', reduceOnly: false });
    expect(submit()?.textContent).toBe('Open long: Buy ETH limit');
    expect(container.querySelector('.preview')?.textContent).toContain('ActionOpen long (buy)');
    expect(container.querySelector('.preview')?.textContent).toContain('Leverage3x');
    expect(container.querySelector('.risk-msg')?.textContent).toBe('Risk check passed');
    // there is no separate position-side control left to disagree with the buttons
    expect(container.textContent).not.toContain('Position side');

    await click(submit());
    await until('the order', () => placeOrder.mock.calls.length === 1);
    expect(placeOrder.mock.calls[0]?.[0]).toMatchObject({ instId: 'ETH-USDT-SWAP', side: 'buy', posSide: 'long', reduceOnly: false, source: 'manual' });
    expect(placeOrder.mock.calls[0]?.[0].clOrdId).toMatch(/^pgw[0-9a-z]{9,29}$/);
    // the toast leads to the trade in the journal
    await until('the toast', () => useStore.getState().toasts.length === 1);
    expect(useStore.getState().toasts[0]?.link).toEqual({ kind: 'journal', instId: 'ETH-USDT-SWAP', mgnMode: 'cross', posSide: 'long', ordId: 'o1' });
    await until('the toast', () => useStore.getState().toasts.length === 1);
    expect(useStore.getState().toasts[0]?.message).toBe('Order live: Open long, buy 2 contracts ETH-USDT-SWAP @ 3000 (o1)');
    expect(submit()?.title).toBe('Open long: buy 2 contracts ETH-USDT-SWAP @ 3000');
  });

  it('an opening order carries the stop typed into the ticket; the preview shows it with the loss, and a closing order has no stop', async () => {
    await render();
    const stopInput = (): HTMLInputElement | undefined => inputs()[2];
    expect(container.textContent).toContain('Stop (mark)');
    // the field's tooltip states OKX's rule: no stop until the order is completely filled
    const stopTitle = stopInput()?.closest('.field')?.querySelector('label')?.title ?? '';
    expect(stopTitle).toContain('only once the order is completely filled');
    expect(stopTitle).toContain('the filled part has no stop');
    expect(stopTitle).not.toContain('sized to the fill');
    await fill('3000', '2');
    expect(lastPreviewed()).not.toHaveProperty('slTriggerPx');
    expect(container.querySelector('.preview')?.textContent).not.toContain('Stop (mark)');

    await type(stopInput(), '2800');
    await until('the stop preview', () => lastPreviewed()?.slTriggerPx === '2800' && submit()?.disabled === false);
    expect(container.querySelector('.preview')?.textContent).toContain('Stop (mark)2,800Loss at stop40.00 USDT');
    expect(container.querySelector('.preview')?.textContent).toContain('Loss at stop40.00 USDT');
    expect(submit()?.title).toBe('Open long: buy 2 coin ETH-USDT-SWAP @ 3000, stop 2800 (mark)');

    // a stop that is not a price leaves the form incomplete: nothing can be submitted without the stop the user asked for
    await type(stopInput(), '28x');
    await until('the incomplete form', () => submit()?.disabled === true && submit()?.title === 'Complete the form');
    await type(stopInput(), '2800');
    await until('the stop preview again', () => lastPreviewed()?.slTriggerPx === '2800' && submit()?.disabled === false);

    await click(submit());
    await until('the order', () => placeOrder.mock.calls.length === 1);
    expect(placeOrder.mock.calls[0]?.[0]).toMatchObject({ side: 'buy', posSide: 'long', px: '3000', slTriggerPx: '2800' });
    await until('the toast', () => useStore.getState().toasts.length === 1);
    expect(useStore.getState().toasts[0]?.message).toBe('Order live: Open long, buy 2 contracts ETH-USDT-SWAP @ 3000, stop 2800 (mark) (o1)');

    // closing: the field is gone and the stop is not sent
    await click(closeBox());
    expect(inputs().map((i) => i.value)).not.toContain('2800');
    await until('the closing preview', () => lastPreviewed()?.posSide === 'short' && !(container.textContent ?? '').includes('Stop (mark)'));
    expect(lastPreviewed()).not.toHaveProperty('slTriggerPx');
  });

  it('a pre-fill brings its stop, a pre-fill without one clears it, and an instrument change clears it', async () => {
    await render();
    await act(async () => {
      useStore.getState().applyTicketPrefill({ instId: 'ETH-USDT-SWAP', side: 'buy', ordType: 'limit', px: '3000', sizeValue: '2', sizeUnit: 'contracts', slTriggerPx: '2750' });
    });
    expect(inputs().slice(0, 3).map((i) => i.value)).toEqual(['3000', '2', '2750']);
    await until('the preview', () => lastPreviewed()?.slTriggerPx === '2750');
    await prefillShort();
    expect(inputs().slice(0, 3).map((i) => i.value)).toEqual(['3000', '2', '']);
    await type(inputs()[2], '3200');
    await act(async () => {
      useStore.getState().selectInstrument('BTC-USDT-SWAP');
    });
    expect(inputs()[2]?.value).toBe('');
  });

  it('long/short mode: the close checkbox sends the closing direction of the leg and says so', async () => {
    await render();
    expect(sideButton('Sell')?.textContent).toBe('Sell / Short');
    await click(sideButton('Sell'));
    await click(closeBox());
    expect(sideButton('Sell')?.textContent).toBe('Sell / Close long');
    expect(sideButton('Buy')?.textContent).toBe('Buy / Close short');
    await fill('3000', '2');
    // on the wire: the leg's posSide, and no reduce-only flag in long/short mode
    expect(lastPreviewed()).toMatchObject({ side: 'sell', posSide: 'long', reduceOnly: false });
    expect(submit()?.textContent).toBe('Close long: Sell ETH limit');
    expect(container.querySelector('.preview')?.textContent).toContain('ActionClose long (sell)');
    expect(container.querySelector('.risk-msg')?.textContent).toBe('Closing order: limits not applied');
    await click(submit());
    await until('the order', () => placeOrder.mock.calls.length === 1);
    expect(placeOrder.mock.calls[0]?.[0]).toMatchObject({ side: 'sell', posSide: 'long', reduceOnly: false });

    await click(sideButton('Buy'));
    await until('the other leg', () => lastPreviewed()?.side === 'buy');
    expect(lastPreviewed()).toMatchObject({ side: 'buy', posSide: 'short' });
  });

  it('the close checkbox does not survive an instrument change or a pre-fill', async () => {
    await render();
    await click(closeBox());
    expect(closeBox()?.checked).toBe(true);
    await act(async () => {
      useStore.getState().selectInstrument('BTC-USDT-SWAP');
    });
    expect(closeBox()?.checked).toBe(false);
    await click(closeBox());
    await prefillShort();
    expect(closeBox()?.checked).toBe(false);
    await until('the entry preview', () => lastPreviewed()?.instId === 'ETH-USDT-SWAP');
    expect(lastPreviewed()).toMatchObject({ side: 'sell', posSide: 'short' });
  });

  it('net mode: no position side is sent and the reduce-only flag is', async () => {
    useStore.setState({ account: { posMode: 'net_mode', acctLv: '2', canTrade: true } });
    await render();
    expect(container.textContent).not.toContain('Close / reduce existing position');
    await click(closeBox());
    await fill('3000', '2');
    expect(lastPreviewed()).toMatchObject({ side: 'buy', reduceOnly: true });
    expect(lastPreviewed()?.posSide).toBeUndefined();
    expect(submit()?.textContent).toBe('Buy ETH limit');
    expect(container.querySelector('.preview')?.textContent).not.toContain('Action');
  });

  it('with the kill switch on the button follows the server verdict: a closing order can be sent, an entry cannot', async () => {
    useStore.setState({ risk: riskOn });
    previewOrder.mockImplementation((req) => {
      const closing = (req.side === 'sell') === (req.posSide === 'long');
      return Promise.resolve({ ...previewOf(req), risk: closing ? { ok: true, code: 'OK', message: '' } : { ok: false, code: 'KILL_SWITCH', message: 'trading is halted' } });
    });
    await render();
    expect(container.querySelector('.notice-danger')?.textContent).toContain('Kill switch is on');
    await type(inputs()[0], '3000');
    await type(inputs()[1], '2');
    await until('the rejected preview', () => (container.querySelector('.risk-msg')?.textContent ?? '').includes('KILL_SWITCH'));
    expect(submit()?.disabled).toBe(true);
    await click(sideButton('Sell'));
    await click(closeBox());
    await until('the closing preview', () => submit()?.disabled === false);
    expect(submit()?.textContent).toBe('Close long: Sell ETH limit');
  });

  it('an unknown outcome is not called a rejection, stays under the button, and a retry reuses the client order id', async () => {
    await render();
    await fill('3000', '2');
    placeOrder.mockRejectedValueOnce(new ApiError('ORDER_STATUS_UNKNOWN', 'the exchange did not acknowledge the order', { clOrdId: 'x' }, 504));
    await click(submit());
    await until('the failure', () => container.querySelector('[role="alert"]') !== null);
    const alert = (): string => container.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert()).toContain('Order status unknown: check Positions, Fills and Open orders before retrying');
    expect(alert()).not.toContain('订单状态未知');
    expect(alert()).not.toContain('rejected');
    const toast = useStore.getState().toasts.at(-1);
    expect(toast?.kind).toBe('error');
    expect(toast?.message).toContain('Order status unknown: check Positions, Fills and Open orders before retrying');
    // the notice stays up across a switch of the language, so it is kept in both
    expect(toast?.zh).toContain('订单状态未知：重试前请先查看持仓、成交和当前委托');
    await act(async () => useLangStore.setState({ lang: 'zh' }));
    expect(alert()).toContain('订单状态未知：重试前请先查看持仓、成交和当前委托');
    expect(alert()).not.toContain('Order status unknown');
    await act(async () => useLangStore.setState({ lang: 'en' }));
    const first = placeOrder.mock.calls[0]?.[0].clOrdId;
    expect(first).toMatch(/^pgw/);
    expect(placeOrder.mock.calls[0]?.[0].retry).toBeUndefined();

    // the same order again: the exchange can now tell it is a duplicate
    placeOrder.mockRejectedValueOnce(new ApiError('EXCHANGE', 'Duplicated clOrdId.', { okxCode: '51016', okxMsg: 'Duplicated clOrdId.' }, 502));
    await click(submit());
    await until('the second attempt', () => placeOrder.mock.calls.length === 2 && alert().includes('earlier attempt'));
    expect(placeOrder.mock.calls[1]?.[0].clOrdId).toBe(first);
    // marked as a retry, so the server looks the id up even if it was restarted since the first attempt
    expect(placeOrder.mock.calls[1]?.[0].retry).toBe(true);
    expect(alert()).toContain('The earlier attempt did reach OKX');

    // now the outcome is known: a further order is a new one
    await click(submit());
    await until('the third attempt', () => placeOrder.mock.calls.length === 3);
    expect(placeOrder.mock.calls[2]?.[0].clOrdId).not.toBe(first);
    expect(placeOrder.mock.calls[2]?.[0].retry).toBeUndefined();
    await until('the message to clear', () => container.querySelector('[role="alert"]') === null);
  });

  it('a network failure and a 5xx without a verdict are unknown too; an edited order gets a new id', async () => {
    await render();
    await fill('3000', '2');
    placeOrder.mockRejectedValueOnce(new ApiError('NETWORK', 'Failed to fetch', undefined, 0));
    await click(submit());
    await until('the failure', () => (container.querySelector('[role="alert"]')?.textContent ?? '').includes('Order status unknown'));
    const first = placeOrder.mock.calls[0]?.[0].clOrdId;

    // editing the form removes the message: it was about the order as submitted
    await fill('3000', '3');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    placeOrder.mockRejectedValueOnce(new ApiError('SOMETHING_NEW', 'HTTP 503', undefined, 503));
    await click(submit());
    await until('the failure', () => (container.querySelector('[role="alert"]')?.textContent ?? '').includes('Order status unknown'));
    expect(placeOrder.mock.calls[1]?.[0].clOrdId).not.toBe(first);
  });

  it('a definite refusal is still called a rejection, and the next submit is a new order', async () => {
    await render();
    await fill('3000', '2');
    placeOrder.mockRejectedValueOnce(new ApiError('EXCHANGE', 'Insufficient USDT margin in account.', { okxCode: '51008', okxMsg: 'Insufficient USDT margin in account.' }, 502));
    await click(submit());
    await until('the failure', () => container.querySelector('[role="alert"]') !== null);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Order rejected: EXCHANGE: Insufficient USDT margin in account.');
    placeOrder.mockRejectedValueOnce(new ApiError('RISK_REJECTED', 'risk check failed', { message: 'order notional 600 exceeds 500' }, 422));
    await click(submit());
    await until('the second failure', () => (container.querySelector('[role="alert"]')?.textContent ?? '').includes('RISK_REJECTED'));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Order rejected: RISK_REJECTED: risk check failed — order notional 600 exceeds 500');
    expect(placeOrder.mock.calls[1]?.[0].clOrdId).not.toBe(placeOrder.mock.calls[0]?.[0].clOrdId);
  });

  it('the leverage box never carries a typed or fetched value over to another instrument', async () => {
    leverage.mockImplementation((instId, mgnMode) =>
      instId === 'BTC-USDT-SWAP' ? Promise.reject(new ApiError('EXCHANGE_UNREACHABLE', 'timeout', undefined, 504)) : Promise.resolve<LeverageInfo[]>([{ instId, mgnMode, posSide: 'long', lever: '3' }, { instId, mgnMode, posSide: 'short', lever: '3' }]),
    );
    useStore.setState({ instruments: [eth, btc, { ...eth, instId: 'SOL-USDT-SWAP', baseCcy: 'SOL' }] });
    await render();
    // price, size, stop, then the leverage box
    const lever = (): HTMLInputElement | undefined => inputs()[3];
    await until('the leverage', () => lever()?.value === '3');
    // half-typed on ETH, then on to an instrument with the same leverage
    await type(lever(), '7');
    await act(async () => {
      useStore.getState().selectInstrument('SOL-USDT-SWAP');
    });
    await until('the leverage of SOL', () => lever()?.value === '3');
    // the query for BTC fails: no number of another instrument is left in the box
    await act(async () => {
      useStore.getState().selectInstrument('BTC-USDT-SWAP');
    });
    await until('the failed query', () => lever()?.placeholder === 'unavailable');
    expect(lever()?.value).toBe('');
    expect(container.textContent).toContain('unavailable');
  });

  it('exits: explained where the API refuses them; offered, a ladder with the cost-price stop and channel trailing go with the order', async () => {
    trailing.mockRejectedValue(new ApiError('EXITS_UNAVAILABLE', 'exits are offered in paper trading only', undefined, 403));
    await render();
    await until('the answer', () => container.querySelector('.ticket-exits-off') !== null);
    expect(container.querySelector('.ticket-exits-off')?.textContent).toBe('Take-profit and trailing exits are offered in paper trading and against the local mock only.');
    expect(container.querySelector('.ticket-exits-toggle')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);

    trailing.mockResolvedValue(trailingOn);
    await render();
    await until('the exits section', () => container.querySelector('.ticket-exits-toggle') !== null);
    // closed, it adds no field: price, size, stop and leverage are still the ticket's inputs
    expect(inputs()).toHaveLength(4);
    await fill('3000', '4');
    await type(inputs()[2], '2900');
    await click(container.querySelector('.ticket-exits-toggle'));
    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('.ticket-exits button')].find((b) => b.textContent === label);
    await click(button('Ladder'));
    const rows = () => [...container.querySelectorAll<HTMLElement>('.ticket-exits .exit-row')];
    const rowInput = (i: number) => rows()[i]?.querySelector<HTMLInputElement>('input') ?? undefined;
    // the program's ladder over the 100 risk distance: 1.5R for half the 4 ETH (40 contracts), 3R for the rest, the stop to the entry after the first
    expect([rowInput(0)?.value, rowInput(1)?.value]).toEqual(['1.5', '3']);
    expect(rows()[0]?.querySelector('.exit-echo')?.textContent).toBe('= 3,150 · +5.00% · 20 ct · +300.00 USDT');
    expect(rows()[1]?.querySelector('.exit-echo')?.textContent).toBe('= 3,300 · +10.00% · 20 ct · +600.00 USDT');
    expect(container.querySelector<HTMLInputElement>('.ticket-exits .exit-breakeven input')?.checked).toBe(true);
    // prices of the trader's own instead
    for (const [i, px] of ['3100', '3200'].entries()) {
      const basis = rows()[i]?.querySelector<HTMLSelectElement>('select');
      await act(async () => {
        if (basis === null || basis === undefined) throw new Error('no basis');
        basis.value = 'price';
        basis.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await type(rowInput(i), px);
    }
    await click(button('Channel'));
    expect(container.querySelector('.ticket-exits .exit-now')?.textContent).toBe('The stop will be the lowest low of the last 10 daily bars when the order is placed, and moves up only, after every 00:00 UTC close.');
    await until('the exits in the preview', () => lastPreviewed()?.takeProfits?.[0]?.triggerPx === '3100' && lastPreviewed()?.trailing !== undefined && submit()?.disabled === false);
    expect(lastPreviewed()).toMatchObject({
      slTriggerPx: '2900',
      takeProfits: [
        { triggerPx: '3100', fraction: '0.5' },
        { triggerPx: '3200', fraction: '0.5' },
      ],
      breakevenAfterTp1: true,
      trailing: { kind: 'channel', bars: 10 },
      source: 'manual',
    });
    // a new leg goes halfway between its neighbours and the shares are split again: nothing is left to fill in
    await click(button('+ leg'));
    expect([rowInput(0)?.value, rowInput(1)?.value, rowInput(2)?.value]).toEqual(['3100', '3150', '3200']);
    expect(container.querySelector('.ticket-exits .exit-error')).toBeNull();
    await until('the three legs', () => lastPreviewed()?.takeProfits?.length === 3 && submit()?.disabled === false);
    expect(lastPreviewed()?.takeProfits).toEqual([
      { triggerPx: '3100', fraction: '0.33' },
      { triggerPx: '3150', fraction: '0.33' },
      { triggerPx: '3200', fraction: '0.34' },
    ]);
    // a level cleared is said under its row with the program's proposal and under the button; the order is previewed
    // without the legs (the trailing stop stays), its figures stay, the pass is partial, and nothing can be submitted
    await type(rowInput(1), '');
    expect(rows()[1]?.parentElement?.querySelector('.exit-hint.warn')?.textContent).toBe('Take-profit 2: no level yet; suggested 3,225 (2.25R).');
    await until('the preview without the legs', () => lastPreviewed()?.takeProfits === undefined && lastPreviewed()?.trailing !== undefined);
    expect(submit()?.disabled).toBe(true);
    expect(container.querySelector('.ticket-why')?.textContent).toBe('Exit plan: Take-profit 2: no level yet; suggested 3,225 (2.25R).');
    expect(submit()?.title).toBe('Exit plan: Take-profit 2: no level yet; suggested 3,225 (2.25R).');
    await until('the partial verdict', () => (container.querySelector('.risk-msg')?.textContent ?? '').includes('without the exit-plan parts still to fix'));
    expect(container.querySelector('.preview')?.textContent).toContain('Contracts4Coin0.2 ETH');
    expect(container.querySelector('.preview')?.textContent).not.toContain('Enter a size');
    // closing the section takes the exits off the order
    await click(container.querySelector('.ticket-exits-toggle'));
    await until('the order without exits', () => lastPreviewed()?.takeProfits === undefined && submit()?.disabled === false);
    expect(lastPreviewed()?.trailing).toBeUndefined();
    expect(container.querySelector('.ticket-why')).toBeNull();
  });

  it('a short: the levels are proposed below the entry, mirrored on the tick; without a stop they are percentages from the entry', async () => {
    trailing.mockResolvedValue(trailingOn);
    await render();
    await until('the exits section', () => container.querySelector('.ticket-exits-toggle') !== null);
    await click(sideButton('Sell'));
    await fill('3000', '4');
    await type(inputs()[2], '3100');
    await click(container.querySelector('.ticket-exits-toggle'));
    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('.ticket-exits button')].find((b) => b.textContent === label);
    const rows = () => [...container.querySelectorAll<HTMLElement>('.ticket-exits .exit-row')];
    const rowInput = (i: number) => rows()[i]?.querySelector<HTMLInputElement>('input') ?? undefined;
    await click(button('Single'));
    // 2R below the entry over the 100 risk distance up to the stop; the profit of 4 ETH (40 contracts)
    expect(rows()[0]?.querySelector<HTMLSelectElement>('select')?.value).toBe('r');
    expect(rowInput(0)?.value).toBe('2');
    expect(rows()[0]?.querySelector('.exit-echo')?.textContent).toBe('= 2,800 · +6.67% · 40 ct · +800.00 USDT');
    await until('the short preview', () => lastPreviewed()?.takeProfits?.[0]?.triggerPx === '2800' && submit()?.disabled === false);
    expect(lastPreviewed()).toMatchObject({ side: 'sell', posSide: 'short', slTriggerPx: '3100', takeProfits: [{ triggerPx: '2800', fraction: '1' }] });
    await click(button('Ladder'));
    expect([rowInput(0)?.value, rowInput(1)?.value]).toEqual(['1.5', '3']);
    expect(rows()[0]?.querySelector('.exit-echo')?.textContent).toBe('= 2,850 · +5.00% · 20 ct · +300.00 USDT');
    expect(container.querySelector<HTMLInputElement>('.ticket-exits .exit-breakeven input')?.checked).toBe(true);
    // the stop taken away: the levels left to the program become percentages from the entry, and the cost-price stop goes
    await type(inputs()[2], '');
    expect([rows()[0]?.querySelector<HTMLSelectElement>('select')?.value, rowInput(0)?.value, rowInput(1)?.value]).toEqual(['pct', '5', '10']);
    expect(rows()[0]?.querySelector('.exit-echo')?.textContent).toBe('= 2,850 · 20 ct · +300.00 USDT');
    expect(container.querySelector<HTMLInputElement>('.ticket-exits .exit-breakeven input')?.checked).toBe(false);
    // a stop on the wrong side of a short (below the entry) gives no R: the percentages stay, and both the stop field and the levels say why
    await type(inputs()[2], '2900');
    expect([rows()[0]?.querySelector<HTMLSelectElement>('select')?.value, rowInput(0)?.value]).toEqual(['pct', '5']);
    expect(container.querySelector('.ticket-hint')?.textContent).toBe('Not above the entry (a short needs its stop above it): the server refuses the stop.');
    expect(container.querySelector('.exit-stop-ignored')?.textContent).toBe(
      'The stop 2,900 is not on the losing side of the entry (above it for a short), so it does not count: the levels are proposed as percentages from the entry.',
    );
  });

  it('a limit order without its price: the level is proposed as a percentage and the row says the price is what is missing', async () => {
    trailing.mockResolvedValue(trailingOn);
    await render();
    await until('the exits section', () => container.querySelector('.ticket-exits-toggle') !== null);
    await type(inputs()[1], '4');
    await click(container.querySelector('.ticket-exits-toggle'));
    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('.ticket-exits button')].find((b) => b.textContent === label);
    const rows = () => [...container.querySelectorAll<HTMLElement>('.ticket-exits .exit-row')];
    await click(button('Single'));
    expect(rows()[0]?.querySelector<HTMLInputElement>('input')?.value).toBe('10');
    expect(container.querySelector('.ticket-exits .exit-hint.warn')?.textContent).toBe('Take-profit 1: an R multiple or a percentage needs an entry price (the limit price, or the last price for a market order).');
    expect(container.querySelector('.ticket-exits .exit-error')).toBeNull();
    // the price typed: the level is measured from it
    await type(inputs()[0], '3000');
    expect(rows()[0]?.querySelector('.exit-echo')?.textContent).toBe('= 3,300 · 40 ct · +1,200.00 USDT');
    expect(container.querySelector('.ticket-exits .exit-hint.warn')).toBeNull();
  });

  it('channel trailing names its level from the daily bars for any day count, for a short the highest high', async () => {
    trailing.mockResolvedValue(trailingOn);
    const bar = (i: number, low: string, high: string): Candle => ({ ts: Date.UTC(2026, 8, 1) + i * 86_400_000, open: '3000', high, low, close: '3000', vol: '1', volCcy: '1', confirm: true });
    candles.mockResolvedValue([...Array.from({ length: 24 }, (_, i) => bar(i, i === 3 ? '2700' : '2850', i === 20 ? '3350' : '3200')), { ...bar(24, '2500', '3500'), confirm: false }]);
    await render();
    await until('the exits section', () => container.querySelector('.ticket-exits-toggle') !== null);
    await fill('3000', '4');
    await click(container.querySelector('.ticket-exits-toggle'));
    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('.ticket-exits button')].find((b) => b.textContent === label);
    await click(button('Channel'));
    // the 10-day low of the last ten confirmed bars (the unconfirmed one does not count); 20 days reach the low of the fourth bar
    await until('the level', () => container.querySelector('.ticket-exits .exit-now')?.textContent?.includes('now at') === true);
    expect(container.querySelector('.ticket-exits .exit-now')?.textContent).toBe('The stop is now at 2,850 (the lowest low of the last 10 daily bars) and moves up only, after every 00:00 UTC close.');
    const days = container.querySelector<HTMLInputElement>('.ticket-exits .exit-field input');
    await type(days ?? undefined, '21');
    expect(container.querySelector('.ticket-exits .exit-now')?.textContent).toBe('The stop is now at 2,700 (the lowest low of the last 21 daily bars) and moves up only, after every 00:00 UTC close.');
    // more days than bars: computed when placed
    await type(days ?? undefined, '60');
    expect(container.querySelector('.ticket-exits .exit-now')?.textContent).toBe('The stop will be the lowest low of the last 60 daily bars when the order is placed, and moves up only, after every 00:00 UTC close.');
    // a short trails the highest high
    await type(days ?? undefined, '10');
    await click(sideButton('Sell'));
    expect(container.querySelector('.ticket-exits .exit-now')?.textContent).toBe('The stop is now at 3,350 (the highest high of the last 10 daily bars) and moves down only, after every 00:00 UTC close.');
  });

  it('channel trailing without an attached stop: the levels are measured from the channel level, which the cost-price stop cannot use', async () => {
    trailing.mockResolvedValue(trailingOn);
    const bar = (i: number, low: string): Candle => ({ ts: Date.UTC(2026, 8, 1) + i * 86_400_000, open: '3000', high: '3200', low, close: '3000', vol: '1', volCcy: '1', confirm: true });
    candles.mockResolvedValue(Array.from({ length: 24 }, (_, i) => bar(i, '2850')));
    await render();
    await until('the exits section', () => container.querySelector('.ticket-exits-toggle') !== null);
    await fill('3000', '4');
    await click(container.querySelector('.ticket-exits-toggle'));
    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('.ticket-exits button')].find((b) => b.textContent === label);
    const rows = () => [...container.querySelectorAll<HTMLElement>('.ticket-exits .exit-row')];
    const rowInput = (i: number) => rows()[i]?.querySelector<HTMLInputElement>('input') ?? undefined;
    const breakeven = () => container.querySelector<HTMLInputElement>('.ticket-exits .exit-breakeven input');
    await click(button('Channel'));
    await until('the level', () => container.querySelector('.ticket-exits .exit-now')?.textContent?.includes('now at 2,850') === true);
    await click(button('Ladder'));
    // the stop the order will have is the channel's 2,850: 1.5R and 3R over the 150 risk distance, no cost-price stop (the exchange moves an attached stop only)
    expect([rows()[0]?.querySelector<HTMLSelectElement>('select')?.value, rowInput(0)?.value, rowInput(1)?.value]).toEqual(['r', '1.5', '3']);
    expect(rows()[0]?.querySelector('.exit-echo')?.textContent).toBe('= 3,225 · +7.50% · 20 ct · +450.00 USDT');
    expect(rows()[1]?.querySelector('.exit-echo')?.textContent).toBe('= 3,450 · +15.00% · 20 ct · +900.00 USDT');
    expect(breakeven()?.checked).toBe(false);
    expect(breakeven()?.disabled).toBe(true);
    expect(container.querySelector('.ticket-exits .exit-breakeven')?.textContent).toContain('(needs a stop attached to the order and two legs or more)');
    expect(container.querySelector('.ticket-exits .exit-error')).toBeNull();
    await until('the legs in the preview', () => lastPreviewed()?.takeProfits?.[0]?.triggerPx === '3225' && submit()?.disabled === false);
    expect(lastPreviewed()).toMatchObject({ takeProfits: [{ triggerPx: '3225', fraction: '0.5' }, { triggerPx: '3450', fraction: '0.5' }], trailing: { kind: 'channel', bars: 10 } });
    expect(lastPreviewed()?.slTriggerPx).toBeUndefined();
    expect(lastPreviewed()?.breakevenAfterTp1).toBeUndefined();
    // a stop attached: the levels follow it, and the cost-price stop comes with it
    await type(inputs()[2], '2900');
    expect(rows()[0]?.querySelector('.exit-echo')?.textContent).toBe('= 3,150 · +5.00% · 20 ct · +300.00 USDT');
    expect(breakeven()?.checked).toBe(true);
    await until('the stop in the preview', () => lastPreviewed()?.slTriggerPx === '2900' && lastPreviewed()?.breakevenAfterTp1 === true && submit()?.disabled === false);
    // a channel level on the profit side of the entry is said: a stop there would fire at once
    await type(inputs()[0], '2800');
    expect(container.querySelector('.ticket-exits .exit-channel-wrong')?.textContent).toBe('The level 2,850 is not below the entry: a stop there would fire at once. Choose more days, or no channel trailing.');
  });

  it("a market order's levels are measured from the last price when the section was opened, so they do not move with the ticks", async () => {
    trailing.mockResolvedValue(trailingOn);
    const tick = (last: string) =>
      act(async () => {
        useStore.setState({ market: { 'ETH-USDT-SWAP': { ...emptyMarket(), ticker: { instId: 'ETH-USDT-SWAP', last, lastSz: '1', bidPx: last, bidSz: '1', askPx: last, askSz: '1', open24h: last, high24h: last, low24h: last, vol24h: '1', volCcy24h: '1', ts: 1 } } } });
      });
    await tick('3000');
    await render();
    await until('the exits section', () => container.querySelector('.ticket-exits-toggle') !== null);
    const ordType = container.querySelector<HTMLSelectElement>('.field select');
    await act(async () => {
      if (ordType === null) throw new Error('no select');
      ordType.value = 'market';
      ordType.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // size, stop, leverage: no price field for a market order
    expect(inputs()).toHaveLength(3);
    await type(inputs()[0], '4');
    await click(container.querySelector('.ticket-exits-toggle'));
    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('.ticket-exits button')].find((b) => b.textContent === label);
    const rows = () => [...container.querySelectorAll<HTMLElement>('.ticket-exits .exit-row')];
    await click(button('Single'));
    expect(rows()[0]?.querySelector('.exit-echo')?.textContent).toBe('= 3,300 · 40 ct · +1,200.00 USDT');
    expect(container.querySelector('.ticket-exits .exit-entry-note')?.textContent).toBe('R and % are measured from 3,000, the last price when this section was opened; close and reopen it to measure from the price now.');
    await until('the preview', () => lastPreviewed()?.takeProfits?.[0]?.triggerPx === '3300' && submit()?.disabled === false);
    // the price moves: the level and the request do not
    await tick('3010');
    await tick('3020');
    expect(rows()[0]?.querySelector('.exit-echo')?.textContent).toBe('= 3,300 · 40 ct · +1,200.00 USDT');
    expect(submit()?.disabled).toBe(false);
    expect(previewOrder.mock.calls.every((c) => c[0].takeProfits?.[0]?.triggerPx === '3300')).toBe(true);
    // reopened, the section measures from the price now
    await click(container.querySelector('.ticket-exits-toggle'));
    await click(container.querySelector('.ticket-exits-toggle'));
    expect(container.querySelector('.ticket-exits .exit-entry-note')?.textContent).toContain('measured from 3,020');
    expect(rows()[0]?.querySelector('.exit-echo')?.textContent).toBe('= 3,322 · 40 ct · +1,208.00 USDT');
  });

  it('a stop on the wrong side: the order is previewed without it, its figures stay, and the reason is under the button', async () => {
    trailing.mockResolvedValue(trailingOn);
    await render();
    await until('the exits section', () => container.querySelector('.ticket-exits-toggle') !== null);
    await fill('3000', '4');
    await type(inputs()[2], '3100');
    expect(container.querySelector('.ticket-hint.warn')?.textContent).toBe('Not below the entry (a long needs its stop below it): the server refuses the stop.');
    await until('the button to be held back', () => submit()?.disabled === true);
    // the stop was never sent for a check: the server's English refusal never shows up
    expect(previewOrder.mock.calls.every((c) => c[0].slTriggerPx === undefined)).toBe(true);
    expect(container.querySelector('.preview')?.textContent).toContain('Contracts4');
    expect(container.querySelector('.preview.rejected')).toBeNull();
    expect(submit()?.disabled).toBe(true);
    expect(container.querySelector('.ticket-why')?.textContent).toBe('Stop (mark): Not below the entry (a long needs its stop below it): the server refuses the stop.');
    // a price typed off the tick is echoed at the price the server rounds it to
    await type(inputs()[2], '2900');
    await until('the stop in the preview', () => lastPreviewed()?.slTriggerPx === '2900' && submit()?.disabled === false);
    expect(container.querySelector('.ticket-why')).toBeNull();
    await click(container.querySelector('.ticket-exits-toggle'));
    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('.ticket-exits button')].find((b) => b.textContent === label);
    const rows = () => [...container.querySelectorAll<HTMLElement>('.ticket-exits .exit-row')];
    await click(button('Single'));
    const basis = rows()[0]?.querySelector<HTMLSelectElement>('select');
    await act(async () => {
      if (basis === null || basis === undefined) throw new Error('no basis');
      basis.value = 'price';
      basis.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await type(rows()[0]?.querySelector<HTMLInputElement>('input') ?? undefined, '3300.005');
    expect(rows()[0]?.querySelector('.exit-echo')?.textContent).toBe('= 3,300 (rounded to the tick 0.01) · +10.00% · 3.00R · 40 ct · +1,200.00 USDT');
    await until('the rounded trigger', () => lastPreviewed()?.takeProfits?.[0]?.triggerPx === '3300' && submit()?.disabled === false);
  });

  it("the program's cost-price stop goes with the stop even after a level was edited: no error that cannot be taken off", async () => {
    trailing.mockResolvedValue(trailingOn);
    await render();
    await until('the exits section', () => container.querySelector('.ticket-exits-toggle') !== null);
    await fill('3000', '4');
    await type(inputs()[2], '2900');
    await click(container.querySelector('.ticket-exits-toggle'));
    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('.ticket-exits button')].find((b) => b.textContent === label);
    const rows = () => [...container.querySelectorAll<HTMLElement>('.ticket-exits .exit-row')];
    const rowInput = (i: number) => rows()[i]?.querySelector<HTMLInputElement>('input') ?? undefined;
    const breakeven = () => container.querySelector<HTMLInputElement>('.ticket-exits .exit-breakeven input');
    await click(button('Ladder'));
    expect(breakeven()?.checked).toBe(true);
    const basis = rows()[0]?.querySelector<HTMLSelectElement>('select');
    await act(async () => {
      if (basis === null || basis === undefined) throw new Error('no basis');
      basis.value = 'price';
      basis.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await type(rowInput(0), '3100');
    await type(inputs()[2], '');
    expect(breakeven()?.checked).toBe(false);
    expect(container.querySelector('.ticket-exits .exit-error')).toBeNull();
    await until('the order without the stop', () => lastPreviewed()?.slTriggerPx === undefined && lastPreviewed()?.takeProfits?.length === 2 && submit()?.disabled === false);
    expect(lastPreviewed()?.breakevenAfterTp1).toBeUndefined();
    // a level out of order (the second leg, in percent since the stop went, at 1%: 3,030, under the first) is said on its row
    await type(rowInput(1), '1');
    expect(rows()[1]?.parentElement?.querySelector('.exit-error')?.textContent).toBe('Take-profit 2: must be beyond take-profit 1 (higher for a long, lower for a short): the legs fill in their order.');
    await until('the incomplete form', () => submit()?.disabled === true);
  });
});
