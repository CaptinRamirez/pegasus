import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Instrument, Order, OrderPreview, PlaceOrderRequest, RiskState } from '@pegasus/shared';
import { api, type LeverageInfo } from '../lib/api';
import { ApiError } from '../lib/http';
import { useStore } from '../store/store';
import { initialState } from '../store/types';
import { OrderTicket } from './OrderTicket';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return { ...mod, api: { leverage: vi.fn(), previewOrder: vi.fn(), placeOrder: vi.fn() } };
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
  risk: { ok: true, code: 'OK', message: '' },
});

const orderOf = (req: PlaceOrderRequest): Order => ({
  ordId: 'o1', clOrdId: req.clOrdId ?? '', instId: req.instId, side: req.side, posSide: req.posSide ?? 'net', tdMode: 'cross', ordType: req.ordType, px: req.px ?? '', sz: req.size.value,
  accFillSz: '0', avgPx: '', state: 'live', reduceOnly: false, lever: '3', fee: '0', feeCcy: '', pnl: '0', cTime: 1, uTime: 1,
});

const riskOn: RiskState = {
  killSwitch: true, killSwitchReason: 'manual (terminal)', cancelSweep: { state: 'done', message: 'open orders cancelled', ts: 1 }, dayStartTs: 0,
  dayStartEquity: '10000', baselineTs: 0, currentEquity: '10000', dailyPnl: '0', openOrders: 0, totalPositionNotional: '0', updatedAt: 1,
};

describe('OrderTicket', () => {
  let root: Root;
  let container: HTMLDivElement;
  const leverage = vi.mocked(api.leverage);
  const previewOrder = vi.mocked(api.previewOrder);
  const placeOrder = vi.mocked(api.placeOrder);

  beforeEach(() => {
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
    expect(placeOrder.mock.calls[0]?.[0]).toMatchObject({ instId: 'ETH-USDT-SWAP', side: 'buy', posSide: 'long', reduceOnly: false });
    expect(placeOrder.mock.calls[0]?.[0].clOrdId).toMatch(/^pgw[0-9a-z]{9,29}$/);
    await until('the toast', () => useStore.getState().toasts.length === 1);
    expect(useStore.getState().toasts[0]?.message).toBe('Order live: Open long, buy 2 contracts ETH-USDT-SWAP @ 3000 (o1)');
    expect(submit()?.title).toBe('Open long: buy 2 contracts ETH-USDT-SWAP @ 3000');
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
    expect(alert()).toContain('订单状态未知：重试前请先查看持仓、成交和当前委托');
    expect(alert()).not.toContain('rejected');
    const toast = useStore.getState().toasts.at(-1);
    expect(toast?.kind).toBe('error');
    expect(toast?.message).toContain('Order status unknown: check Positions, Fills and Open orders before retrying');
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
    const lever = (): HTMLInputElement | undefined => inputs()[2];
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
});
