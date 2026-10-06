import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { OrderPreview, PlaceOrderRequest, RiskState } from '@pegasus/shared';
import { useLangStore } from '../i18n';
import { api, type LeverageInfo } from '../lib/api';
import { ApiError } from '../lib/http';
import { useStore } from '../store/store';
import { initialState } from '../store/types';
import { resetUi, useUi } from '../store/ui';
import { campaignAccountResponse, SIGNAL_INSTRUMENTS, signalsResponse, trailingOn } from '../test/signals-fixtures';
import { OrderTicket } from './OrderTicket';
import { SignalsPanel } from './SignalsPanel';
import { RISK_KEY } from './signals/riskPref';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../hooks/useSignalChart', async (importOriginal) => ({ ...(await importOriginal<typeof import('../hooks/useSignalChart')>()), useSignalChart: () => undefined }));
vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return {
    ...mod,
    api: {
      campaignSignals: vi.fn(),
      trailing: vi.fn(),
      candles: vi.fn(() => Promise.resolve([])),
      leverage: vi.fn(),
      setLeverage: vi.fn(),
      previewOrder: vi.fn(),
      placeOrder: vi.fn(),
    },
  };
});

/** The server's reading of a request, as the API sizes it: the last take-profit leg takes what the others leave. */
const previewOf = (req: PlaceOrderRequest): OrderPreview => {
  const sz = Number(req.size.value);
  let used = 0;
  const legs = req.takeProfits ?? [];
  return {
    instId: req.instId,
    side: req.side,
    ordType: req.ordType,
    tdMode: req.tdMode ?? 'cross',
    posSide: req.posSide ?? 'net',
    sz: req.size.value,
    coin: String(sz / 100),
    px: req.px ?? '',
    refPrice: req.px ?? '64180.5',
    notionalQuote: '2567.22',
    estSlippagePct: '0.0001',
    lever: '10',
    slTriggerPx: req.slTriggerPx ?? '',
    stopLossQuote: req.slTriggerPx === undefined ? '' : '211.22',
    ...(legs.length === 0
      ? {}
      : {
          takeProfits: legs.map((l, i) => {
            const legSz = i === legs.length - 1 ? sz - used : Math.floor(sz * Number(l.fraction));
            used += legSz;
            return { triggerPx: l.triggerPx, fraction: l.fraction, sz: String(legSz), profitQuote: '10' };
          }),
        }),
    risk: { ok: true, code: 'OK', message: '' },
  };
};

const riskOn: RiskState = {
  killSwitch: true, killSwitchReason: 'manual (terminal)', cancelSweep: { state: 'done', message: 'open orders cancelled', ts: 1 }, dayStartTs: 0,
  dayStartEquity: '25000', baselineTs: 0, currentEquity: '25000', dailyPnl: '0', openOrders: 0, totalPositionNotional: '0', overLimit: [], totalOverLimit: '', updatedAt: 1,
};

describe('the SIGNALS tab', () => {
  let root: Root;
  let container: HTMLDivElement;
  const campaignSignals = vi.mocked(api.campaignSignals);
  const trailing = vi.mocked(api.trailing);
  const leverage = vi.mocked(api.leverage);
  const setLeverage = vi.mocked(api.setLeverage);
  const previewOrder = vi.mocked(api.previewOrder);
  const placeOrder = vi.mocked(api.placeOrder);

  beforeEach(() => {
    campaignSignals.mockReset();
    campaignSignals.mockResolvedValue(signalsResponse);
    trailing.mockReset();
    trailing.mockResolvedValue(trailingOn);
    leverage.mockReset();
    leverage.mockImplementation((instId, mgnMode) => Promise.resolve<LeverageInfo[]>([{ instId, mgnMode, posSide: 'net', lever: '3' }]));
    setLeverage.mockReset();
    setLeverage.mockImplementation((body) => Promise.resolve<LeverageInfo[]>([{ instId: body.instId, mgnMode: body.mgnMode, posSide: 'net', lever: body.lever }]));
    previewOrder.mockReset();
    previewOrder.mockImplementation((req) => Promise.resolve(previewOf(req)));
    placeOrder.mockReset();
    placeOrder.mockImplementation((req) =>
      Promise.resolve({
        order: { ordId: 'o9', clOrdId: req.clOrdId ?? '', instId: req.instId, side: req.side, posSide: 'net', tdMode: req.tdMode ?? 'isolated', ordType: req.ordType, px: '', sz: req.size.value, accFillSz: req.size.value, avgPx: '64185.2', state: 'filled', reduceOnly: false, lever: '10', fee: '-1.28', feeCcy: 'USDT', pnl: '0', cTime: 1, uTime: 1 },
        preview: previewOf(req),
      }),
    );
    localStorage.clear();
    useStore.setState({
      ...initialState('tok'),
      instruments: SIGNAL_INSTRUMENTS,
      selectedInstId: 'BTC-USDT-SWAP',
      account: { posMode: 'net_mode', acctLv: '2', canTrade: true },
      riskConfig: { maxOrderNotional: '20000', maxPositionNotionalPerInstrument: '40000', maxTotalPositionNotional: '100000', maxLeverage: '10', dailyLossLimit: '1000', maxOpenOrders: 20, priceBandPct: '0.05', maxSlippagePct: '0.005' },
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
    resetUi();
    localStorage.clear();
  });

  const render = async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <SignalsPanel />
          <OrderTicket />
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
  const click = (el: Element | null | undefined): Promise<void> =>
    act(async () => {
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  const type = (input: HTMLInputElement | null | undefined, value: string): Promise<void> =>
    act(async () => {
      if (input === null || input === undefined) throw new Error('no input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const coin = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('.sig-coin')].find((b) => b.querySelector('.sig-coin-name')?.textContent === name);
  const follow = () => container.querySelector<HTMLButtonElement>('.sig-follow');
  const manual = () => container.querySelector<HTMLButtonElement>('.sig-manual');
  const sheet = () => document.body.querySelector<HTMLElement>('.follow-sheet');
  const sheetButton = (label: string) => [...(sheet()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent === label);
  const fieldInput = (label: string) =>
    [...(sheet()?.querySelectorAll<HTMLLabelElement>('.follow-field') ?? [])].find((l) => l.querySelector('span')?.textContent?.startsWith(label))?.querySelector<HTMLInputElement>('input') ?? null;
  const lastPreviewed = (): PlaceOrderRequest | undefined => previewOrder.mock.calls.at(-1)?.[0];
  const confirm = () => document.body.querySelector<HTMLButtonElement>('.follow-confirm');

  it('lists the coins actionable first; the first coin says its state in words and shows the plan to follow it', async () => {
    await render();
    await until('the coins', () => container.querySelectorAll('.sig-coin').length === 10);
    const rows = [...container.querySelectorAll('.sig-coin')].map((r) => [...r.querySelectorAll('span')].map((s) => s.textContent).join('|'));
    expect(rows[0]).toBe('BTC|Entry|Entry|64,180.5|broken');
    expect(rows[3]).toBe('LTC|Exit|Exit|80.02|–');
    expect(rows[9]).toBe('LINK|N/A|N/A|14.208|–');
    expect(campaignSignals).toHaveBeenCalledWith({ riskPct: '0.005' });
    expect(container.querySelector('.sig-headline')?.textContent).toBe('Entry signal: open a long');
    expect(container.querySelector('.sig-sentence')?.textContent).toBe(
      'BTC closed the day above its 20-day high 63,250 (close 64,120). Rule: long; exit on a daily close below the 10-day low 58,900.',
    );
    const facts = container.querySelector('.sig-facts')?.textContent ?? '';
    expect(facts).toContain('Daily close 64,120');
    expect(facts).toContain('2026-10-05 00:00 UTC · ');
    expect(facts).toContain('+0.09%');
    const levels = [...container.querySelectorAll('.sig-level')].map((l) => l.textContent);
    // a fired signal shows the line its close broke, not the next close's line
    expect(levels[0]).toBe('Entry: 20-day high (broken)63,250closed at 64,120, above it');
    expect(levels[1]).toBe('Exit line: 10-day low58,900');
    expect(levels[2]).toBe('Next add67,389.5after an entry at the mark');
    const plan = container.querySelector('.sig-plan')?.textContent ?? '';
    for (const part of ['Plan to follow the entry', 'Entry (mark now)64,180.5', 'Stop (exit line)58,900', 'Contracts4 ct', 'Notional2,567.22 USDT', 'Leverage10×', 'Margin256.72 USDT', 'At risk211.22 USDT', 'Of equity0.84%']) {
      expect(plan).toContain(part);
    }
    expect(plan).toContain('Trailing stop at the 10-day low, moved after every daily close');
    expect(plan).toContain('No take-profit: the rule exits on the channel only');
    expect(follow()?.disabled).toBe(false);
  });

  it('says every warning in words; a coin without a signal cannot be followed and says what to do', async () => {
    await render();
    await until('the coins', () => coin('ADA') !== undefined);
    await click(coin('ADA'));
    const warnings = [...container.querySelectorAll('.sig-warnings li')].map((li) => li.textContent);
    expect(warnings).toHaveLength(5);
    expect(warnings[2]).toBe('The stop is 25.18% below the entry, wider than 20.00%: the position is small for its risk.');
    expect(follow()?.disabled).toBe(false);
    await click(coin('LTC'));
    expect(container.querySelector('.sig-headline')?.textContent).toBe('Exit signal: close the long');
    expect(container.querySelector('.sig-sentence')?.textContent).toContain('closed the day below its 10-day low 80.15 (close 79.88): the rule closes the long.');
    expect(container.querySelector('.sig-sentence')?.textContent).toContain('Close the long in the Positions tab');
    expect(follow()?.disabled).toBe(true);
    expect(follow()?.title).toBe('Only an entry or an add signal can be followed.');
    await click(coin('LINK'));
    expect(container.querySelector('.sig-sentence')?.textContent).toBe('The daily bars could not be read (OKX answered 50011 Too Many Requests).');
  });

  it('on the campaign stack: a clear banner, and following is disabled because the pot trades the account by itself', async () => {
    campaignSignals.mockResolvedValue(campaignAccountResponse);
    await render();
    await until('the banner', () => container.querySelector('.sig-banner') !== null);
    expect(container.querySelector('.sig-banner')?.textContent).toContain('This stack runs the campaign pot on its own paper account');
    expect(container.querySelector('.sig-banner')?.textContent).toContain(':5174/');
    expect(follow()?.disabled).toBe(true);
    expect(container.querySelector('.sig-block')?.textContent).toBe('The campaign pot trades this account by itself: following a signal here would disturb it.');
    expect(container.querySelector('.sig-warnings li')?.textContent).toContain('The campaign pot runs on this account');
  });

  it('under the kill switch, and where exits are not offered, says why following is disabled', async () => {
    useStore.setState({ risk: riskOn });
    await render();
    await until('the banner', () => container.querySelector('.sig-banner') !== null);
    expect(container.querySelector('.sig-banner')?.textContent).toBe('The kill switch is on: opening orders are refused, so no signal can be followed.');
    expect(container.querySelector('.sig-block')?.textContent).toBe('The kill switch is on: opening orders are refused.');
    await act(async () => useStore.setState({ risk: { ...riskOn, killSwitch: false } }));

    trailing.mockRejectedValue(new ApiError('EXITS_UNAVAILABLE', 'exits are offered in paper trading only', undefined, 403));
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await until('the exits banner', () => (container.querySelector('.sig-banner')?.textContent ?? '').includes('paper trading'));
    expect(follow()?.disabled).toBe(true);
    expect(container.querySelector('.sig-block')?.textContent).toContain("Exits are not offered here: the plan's channel trailing stop cannot be placed.");
    // the ticket says so too
    expect(container.querySelector('.ticket-exits-off')?.textContent).toBe('Take-profit and trailing exits are offered in paper trading and against the local mock only.');
  });

  it('in Chinese: the state, the sentence and the buttons', async () => {
    useLangStore.setState({ lang: 'zh' });
    await render();
    await until('the coins', () => container.querySelector('.sig-headline') !== null);
    expect(container.querySelector('.sig-headline')?.textContent).toBe('开仓信号：做多');
    expect(container.querySelector('.sig-sentence')?.textContent).toBe('BTC 日线收在 20 日高点 63,250 之上（收盘 64,120）。规则：做多，日线跌破 10 日低点 58,900 离场。');
    expect(follow()?.textContent).toBe('按信号开仓');
    expect(manual()?.textContent).toBe('手动开仓');
    expect(coin('XRP')?.textContent).toContain('持仓中');
  });

  it('remembers the risk per trade and sizes the plans with it', async () => {
    localStorage.setItem(RISK_KEY, '0.0075');
    await render();
    await until('the first read', () => campaignSignals.mock.calls.length > 0);
    expect(campaignSignals).toHaveBeenLastCalledWith({ riskPct: '0.0075' });
    const select = container.querySelector<HTMLSelectElement>('.sig-toolbar select');
    await act(async () => {
      if (select === null) return;
      select.value = '0.01';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until('the read at 1%', () => campaignSignals.mock.calls.some((c) => c[0]?.riskPct === '0.01'));
    expect(localStorage.getItem(RISK_KEY)).toBe('0.01');
  });

  it('manual open puts the coin and Buy into the order ticket and focuses it, with nothing else filled in', async () => {
    await render();
    await until('the coins', () => coin('ETH') !== undefined);
    const inputs = () => [...container.querySelectorAll<HTMLInputElement>('.form input.num')];
    await type(inputs()[0], '1234');
    await click(coin('ETH'));
    await click(manual());
    await until('the ticket of ETH', () => useStore.getState().selectedInstId === 'ETH-USDT-SWAP' && document.activeElement === inputs()[0]);
    expect(useStore.getState().ticketFocus).toMatchObject({ instId: 'ETH-USDT-SWAP', side: 'buy' });
    expect(inputs().slice(0, 3).map((i) => i.value)).toEqual(['', '', '']);
    expect(container.querySelector('.btn-group .btn.active')?.textContent).toBe('Buy / Long');
    expect(previewOrder).not.toHaveBeenCalled();
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('follow opens the confirmation sheet with the plan filled in, checked live, and sends nothing before Confirm', async () => {
    await render();
    await until('the follow button', () => follow()?.disabled === false);
    await click(follow());
    await until('the live check', () => lastPreviewed() !== undefined && confirm()?.disabled === false);
    expect(fieldInput('Contracts')?.value).toBe('4');
    expect(fieldInput('Leverage')?.value).toBe('10');
    expect(fieldInput('Risk % of equity')?.value).toBe('1');
    expect(sheet()?.querySelector<HTMLInputElement>('input[aria-label="Stop (mark trigger)"]')?.value).toBe('58900');
    expect(lastPreviewed()).toEqual({
      instId: 'BTC-USDT-SWAP',
      side: 'buy',
      ordType: 'market',
      tdMode: 'isolated',
      size: { unit: 'contracts', value: '4' },
      slTriggerPx: '58900',
      trailing: { kind: 'channel', bars: 10 },
      source: 'signal',
      signal: signalsResponse.rows[0]?.signal,
    });
    expect(sheet()?.querySelector('.follow-signal')?.textContent).toContain('daily close 64,120 above the 20-day high 63,250');
    expect(sheet()?.querySelector('.follow-summary p')?.textContent).toBe(
      'Buy 4 contracts (0.0400 BTC) of BTC-USDT-SWAP at market, isolated 10×; stop 58,900 (8.23% below), at risk 211.22 USDT (0.84% of equity); no take-profit; trailing stop at the 10-day low.',
    );
    expect(sheet()?.querySelector('.follow-note')?.textContent).toBe('Leverage is set from 3× to 10× before the order is sent.');
    expect(setLeverage).not.toHaveBeenCalled();
    expect(placeOrder).not.toHaveBeenCalled();
    await click(sheetButton('Cancel'));
    expect(sheet()).toBeNull();
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('one click sets the leverage, then sends the order as a signal with a ps client order id; the toast leads to the journal', async () => {
    await render();
    await until('the follow button', () => follow()?.disabled === false);
    await click(follow());
    await until('the live check', () => confirm()?.disabled === false);
    await click(confirm());
    await until('the order', () => placeOrder.mock.calls.length === 1);
    expect(setLeverage).toHaveBeenCalledWith({ instId: 'BTC-USDT-SWAP', lever: '10', mgnMode: 'isolated' });
    expect(setLeverage.mock.invocationCallOrder[0] ?? 0).toBeLessThan(placeOrder.mock.invocationCallOrder[0] ?? 0);
    const sent = placeOrder.mock.calls[0]?.[0];
    expect(sent).toMatchObject({ instId: 'BTC-USDT-SWAP', side: 'buy', ordType: 'market', tdMode: 'isolated', source: 'signal', trailing: { kind: 'channel', bars: 10 } });
    expect(sent?.clOrdId).toMatch(/^psw[0-9a-z]+$/);
    expect(sent?.reduceOnly).toBeUndefined();
    expect(sent?.posSide).toBeUndefined();
    await until('the sheet to close', () => sheet() === null);
    const toast = useStore.getState().toasts.at(-1);
    expect(toast?.message).toBe('Signal followed: buy 4 contracts of BTC-USDT-SWAP (filled).');
    expect(toast?.zh).toBe('已按信号下单：买入 BTC-USDT-SWAP 4 张（完全成交）。');
    expect(toast?.link).toEqual({ kind: 'journal', instId: 'BTC-USDT-SWAP', mgnMode: 'isolated', posSide: 'net', ordId: 'o9' });
    expect(useUi.getState().tab).toBeNull();
  });

  it('the sheet takes a ladder of take-profits in R with the cost-price stop, and sizes from the risk', async () => {
    await render();
    await until('the follow button', () => follow()?.disabled === false);
    await click(follow());
    await until('the live check', () => confirm()?.disabled === false);
    await type(fieldInput('Risk % of equity'), '0.5');
    await click(sheetButton('Size from risk'));
    expect(fieldInput('Contracts')?.value).toBe('2');
    await click(sheetButton('Ladder'));
    const rows = [...(sheet()?.querySelectorAll<HTMLElement>('.exit-row') ?? [])];
    for (const [i, value] of ['1.5', '3'].entries()) {
      const select = rows[i]?.querySelector<HTMLSelectElement>('select');
      await act(async () => {
        if (select === null || select === undefined) return;
        select.value = 'r';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await type(rows[i]?.querySelector<HTMLInputElement>('input'), value);
    }
    await click(sheet()?.querySelector('.exit-breakeven input'));
    await until('the ladder preview', () => lastPreviewed()?.takeProfits?.length === 2 && confirm()?.disabled === false);
    // 1.5R and 3R over the 5,280.5 risk distance from the mark, on the tick down
    expect(lastPreviewed()).toMatchObject({
      size: { unit: 'contracts', value: '2' },
      takeProfits: [
        { triggerPx: '72101.2', fraction: '0.5' },
        { triggerPx: '80022', fraction: '0.5' },
      ],
      breakevenAfterTp1: true,
      trailing: { kind: 'channel', bars: 10 },
    });
    const legs = [...(sheet()?.querySelectorAll('.follow-tps tbody tr') ?? [])].map((r) => r.textContent);
    expect(legs).toEqual(['TP172,101.21+10.00 USDT', 'TP280,0221+10.00 USDT']);
    expect(sheet()?.querySelector('.follow-summary p')?.textContent).toContain('take-profit 72,101.2 (50%), 80,022 (rest); stop to the entry after the first take-profit');
  });

  it('a refusal is said in words from its code; a failed leverage sends no order; an unknown outcome is retried under the same id', async () => {
    await render();
    await until('the follow button', () => follow()?.disabled === false);
    await click(follow());
    await until('the live check', () => confirm()?.disabled === false);
    const alert = () => document.body.querySelector('.follow-error')?.textContent ?? '';

    setLeverage.mockRejectedValueOnce(new ApiError('RISK_REJECTED', 'risk check failed', { ok: false, code: 'MAX_LEVERAGE', message: 'leverage 20x exceeds the limit 10x' }, 422));
    await click(confirm());
    await until('the leverage failure', () => alert() !== '');
    expect(alert()).toContain('The leverage could not be set, so no order was sent');
    expect(placeOrder).not.toHaveBeenCalled();

    placeOrder.mockRejectedValueOnce(new ApiError('TP_LEG_TOO_SMALL', 'take-profit 2 comes to 0 contracts', { leg: 2, sz: '0', minSz: '1', orderSz: '1' }, 400));
    await click(confirm());
    await until('the refusal', () => alert().includes('TP_LEG_TOO_SMALL'));
    expect(alert()).toBe('Order rejected: TP_LEG_TOO_SMALL: Take-profit 2 would close 0 contracts, below the minimum order of 1: use fewer legs or a larger size.');
    expect(sheet()).not.toBeNull();

    placeOrder.mockRejectedValueOnce(new ApiError('NETWORK', 'Failed to fetch', undefined, 0));
    await click(confirm());
    await until('the unknown outcome', () => alert().includes('Order status unknown'));
    await click(confirm());
    await until('the retry', () => placeOrder.mock.calls.length === 3);
    expect(placeOrder.mock.calls[2]?.[0].clOrdId).toBe(placeOrder.mock.calls[1]?.[0].clOrdId);
    expect(placeOrder.mock.calls[2]?.[0].retry).toBe(true);
    expect(placeOrder.mock.calls[1]?.[0].clOrdId).not.toBe(placeOrder.mock.calls[0]?.[0].clOrdId);
  });
});
