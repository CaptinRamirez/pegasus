import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { D, floorToStep, type OrderPreview, type PlaceOrderRequest, type RiskState } from '@pegasus/shared';
import { useLangStore } from '../i18n';
import { api, type LeverageInfo } from '../lib/api';
import { ApiError } from '../lib/http';
import { useStore } from '../store/store';
import { initialState } from '../store/types';
import { resetUi, useUi } from '../store/ui';
import { ADA_TENTHS, adaScenarioResponse, campaignAccountResponse, SIGNAL_INSTRUMENTS, signalsResponse, trailingOn } from '../test/signals-fixtures';
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
      'Buy 4 contracts (0.04 BTC) of BTC-USDT-SWAP at market, isolated 10×; stop 58,900 (8.23% below), at risk 211.22 USDT (0.84% of equity); no take-profit; trailing stop at the 10-day low, now 58,900.',
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

  it('the sheet proposes a ladder of take-profits in R with the cost-price stop, converts a basis, and sizes from the risk', async () => {
    await render();
    await until('the follow button', () => follow()?.disabled === false);
    await click(follow());
    await until('the live check', () => confirm()?.disabled === false);
    await type(fieldInput('Risk % of equity'), '0.5');
    await click(sheetButton('Size from risk'));
    expect(fieldInput('Contracts')?.value).toBe('2');
    await click(sheetButton('Ladder'));
    // the program's ladder: 1.5R for half, 3R for the rest, the stop to the entry after the first leg
    const rows = () => [...(sheet()?.querySelectorAll<HTMLElement>('.exit-row') ?? [])];
    const rowValue = (i: number) => rows()[i]?.querySelector<HTMLInputElement>('input')?.value;
    const rowBasis = (i: number) => rows()[i]?.querySelector<HTMLSelectElement>('select')?.value;
    expect([rowBasis(0), rowValue(0), rowBasis(1), rowValue(1)]).toEqual(['r', '1.5', 'r', '3']);
    expect(sheet()?.querySelector<HTMLInputElement>('.exit-breakeven input')?.checked).toBe(true);
    // each row says what it comes to: the price on the tick, the gain, the leg's contracts and its profit
    expect(rows()[0]?.querySelector('.exit-echo')?.textContent).toBe('= 72,101.2 · +12.34% · 1 ct · +79.21 USDT');
    expect(rows()[1]?.querySelector('.exit-echo')?.textContent).toBe('= 80,022 · +24.68% · 1 ct · +158.42 USDT');
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
    expect(sheet()?.querySelector('.follow-summary p')?.textContent).toContain('take-profit 1.50R 72,101.2 (+12.34%, 50%), 3.00R 80,022 (+24.68%, rest); stop to the entry after the first take-profit');
    // another basis converts the value instead of clearing it: the price, then the percentage from the entry
    const select = async (i: number, basis: string) => {
      const el = rows()[i]?.querySelector<HTMLSelectElement>('select');
      await act(async () => {
        if (el === null || el === undefined) throw new Error('no basis');
        el.value = basis;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };
    await select(0, 'price');
    expect(rowValue(0)).toBe('72101.2');
    expect(rows()[0]?.querySelector('.exit-echo')?.textContent).toBe('+12.34% · 1.50R · 1 ct · +79.21 USDT');
    // 12.34% would come back as 72,100.3: the percentage carries the decimals that keep 72,101.2
    await select(0, 'pct');
    expect(rowValue(0)).toBe('12.3413');
    await select(0, 'price');
    expect(rowValue(0)).toBe('72101.2');
    await select(0, 'pct');
    await select(0, 'r');
    expect(rowValue(0)).toBe('1.5');
  });

  describe("the owner's ADA entry: nothing left blank or to the trader's guess", () => {
    /** The server's reading of an ADA order, from the request: contracts in tenths, the notional at the mark, the legs sized as the API does. */
    const adaPreview = (req: PlaceOrderRequest): OrderPreview => {
      const sz = D(req.size.value);
      const notional = sz.mul(100).mul('0.2723');
      let used = D(0);
      const legs = req.takeProfits ?? [];
      return {
        ...previewOf(req),
        coin: sz.mul(100).toFixed(),
        refPrice: '0.2723',
        notionalQuote: notional.toFixed(),
        lever: '6',
        stopLossQuote: req.slTriggerPx === undefined ? '' : sz.mul(100).mul(D('0.2723').minus(req.slTriggerPx)).toFixed(),
        ...(legs.length === 0
          ? {}
          : {
              takeProfits: legs.map((l, i) => {
                const legSz = i === legs.length - 1 ? sz.minus(used) : floorToStep(sz.mul(l.fraction), '0.1');
                used = used.plus(legSz);
                return { triggerPx: l.triggerPx, fraction: l.fraction, sz: legSz.toFixed(), profitQuote: legSz.mul(100).mul(D(l.triggerPx).minus('0.2723')).toFixed() };
              }),
            }),
        risk: notional.gt(5000)
          ? { ok: false, code: 'MAX_ORDER_NOTIONAL', message: `order notional ${notional.toFixed(2)} exceeds the limit 5000`, details: { notional: notional.toFixed(2), limit: '5000' } }
          : { ok: true, code: 'OK', message: '' },
      };
    };
    const openSheet = async () => {
      campaignSignals.mockResolvedValue(adaScenarioResponse);
      previewOrder.mockImplementation((req) => Promise.resolve(adaPreview(req)));
      useStore.setState({
        instruments: [ADA_TENTHS],
        riskConfig: { maxOrderNotional: '5000', maxPositionNotionalPerInstrument: '40000', maxTotalPositionNotional: '100000', maxLeverage: '10', dailyLossLimit: '1000', maxOpenOrders: 20, priceBandPct: '0.05', maxSlippagePct: '0.005' },
        balance: { totalEq: '99960', details: [{ ccy: 'USDT', eq: '99960', availEq: '99960', cashBal: '99960', upl: '0' }], ts: 1 },
      });
      await render();
      await until('the follow button', () => follow()?.disabled === false);
      await click(follow());
      await until('the live check', () => lastPreviewed() !== undefined && confirm()?.disabled === false);
    };
    const check = () => sheet()?.querySelector('.follow-check')?.textContent ?? '';
    const summary = () => sheet()?.querySelector('.follow-summary p')?.textContent ?? '';
    const why = () => sheet()?.querySelector('.follow-why')?.textContent ?? '';
    const rows = () => [...(sheet()?.querySelectorAll<HTMLElement>('.exit-row') ?? [])];
    const rowInput = (i: number) => rows()[i]?.querySelector<HTMLInputElement>('input');

    it('sizes to the limit and says so, words the leverage with its prices, and never shows a dash for a figure it can compute', async () => {
      await openSheet();
      // the risk's 210 contracts cut to what the per-order limit allows, said under the field
      expect(fieldInput('Contracts')?.value).toBe('182.7');
      expect(sheet()?.querySelector('.follow-size-note')?.textContent).toBe(
        'Risk 0.75% sizes 210 contracts; the per-order notional limit of 5,000.00 USDT allows 182.7 (each contract counted at 27.37 USDT: the entry plus 0.50% of slippage): 182.7 filled in, actual risk 0.65% (652.24 USDT).',
      );
      expect(fieldInput('Leverage')?.value).toBe('6');
      // the cap is said under the field, not again among the warnings
      const warnings = [...(sheet()?.querySelectorAll('.sig-warnings li') ?? [])].map((li) => li.textContent);
      expect(warnings).toEqual([
        'At 10× the estimated liquidation 0.2477 would be above the stop 0.2366: the position would be liquidated before the stop. The leverage is lowered to 6×, where the liquidation is 0.2293, below the stop (it must stay at or below 0.2342).',
      ]);
      // every figure of the check, the coin size among them
      for (const part of ['Contracts182.7 ct', 'Coin18,270.0 ADA', 'Ref price0.2723', 'Notional4,974.92 USDT', 'Margin at 6×829.15 USDT', 'Fee (taker 0.050%, est.)2.4875 USDT', 'Liquidation (est.)0.2293', 'Loss at stop652.24 USDT · 0.65% of equity']) {
        expect(check()).toContain(part);
      }
      expect(summary()).toBe(
        'Buy 182.7 contracts (18,270.0 ADA) of ADA-USDT-SWAP at market, isolated 6×; stop 0.2366 (13.11% below), at risk 652.24 USDT (0.65% of equity); no take-profit; trailing stop at the 10-day low, now 0.2366.',
      );
      expect(sheet()?.querySelector('.exit-now')?.textContent).toBe('The stop is now at 0.2366 (the lowest low of the last 10 daily bars) and moves up only, after every 00:00 UTC close.');
      expect(why()).toBe('');
      expect(confirm()?.disabled).toBe(false);
    });

    it('proposes every take-profit level: 2R alone, 1.5R and 3R for a ladder, each with its price, gain, contracts and profit', async () => {
      await openSheet();
      await click(sheetButton('Single'));
      expect(rows()[0]?.querySelector<HTMLSelectElement>('select')?.value).toBe('r');
      expect(rowInput(0)?.value).toBe('2');
      expect(rows()[0]?.querySelector('.exit-echo')?.textContent).toBe('= 0.3437 · +26.22% · 182.7 ct · +1,304.48 USDT');
      await until('the preview with the leg', () => lastPreviewed()?.takeProfits?.length === 1 && confirm()?.disabled === false);
      expect(lastPreviewed()?.takeProfits).toEqual([{ triggerPx: '0.3437', fraction: '1' }]);
      expect(summary()).toContain('take-profit 2.00R 0.3437 (+26.22%, 100%); trailing stop at the 10-day low, now 0.2366.');
      expect([...(sheet()?.querySelectorAll('.follow-tps tbody tr') ?? [])].map((r) => r.textContent)).toEqual(['TP10.3437182.7+1,304.48 USDT']);

      await click(sheetButton('Ladder'));
      expect([rowInput(0)?.value, rowInput(1)?.value]).toEqual(['1.5', '3']);
      expect(sheet()?.querySelector<HTMLInputElement>('.exit-breakeven input')?.checked).toBe(true);
      expect(rows()[0]?.querySelector('.exit-echo')?.textContent).toBe('= 0.3258 · +19.65% · 91.3 ct · +488.46 USDT');
      expect(rows()[1]?.querySelector('.exit-echo')?.textContent).toBe('= 0.3794 · +39.33% · 91.4 ct · +978.89 USDT');
      // the legs are in the check before the server has answered, and the same once it has
      expect([...(sheet()?.querySelectorAll('.follow-tps tbody tr') ?? [])].map((r) => r.textContent)).toEqual(['TP10.325891.3+488.46 USDT', 'TP20.379491.4+978.89 USDT']);
      await until('the ladder preview', () => lastPreviewed()?.takeProfits?.length === 2 && confirm()?.disabled === false);
      expect(lastPreviewed()).toMatchObject({ takeProfits: [{ triggerPx: '0.3258', fraction: '0.5' }, { triggerPx: '0.3794', fraction: '0.5' }], breakevenAfterTp1: true, trailing: { kind: 'channel', bars: 10 } });
      expect(summary()).toContain('take-profit 1.50R 0.3258 (+19.65%, 50%), 3.00R 0.3794 (+39.33%, rest); stop to the entry after the first take-profit; trailing stop at the 10-day low, now 0.2366.');
    });

    it('a level cleared or on the wrong side is said under its row and beside the button, the rest of the sheet stays; Suggest brings the level back', async () => {
      await openSheet();
      await click(sheetButton('Single'));
      await type(rowInput(0), '');
      expect(sheet()?.querySelector('.exit-hint.warn')?.textContent).toBe('Take-profit 1: no level yet; suggested 0.3437 (2R).');
      expect(sheet()?.querySelector('.exit-error')).toBeNull();
      // the order is still previewed with the trailing stop alone; the figures stay; the summary says what is missing, and the verdict that the pass is partial
      await until('the preview without the leg', () => lastPreviewed()?.takeProfits === undefined && lastPreviewed()?.trailing !== undefined);
      expect(check()).toContain('Coin18,270.0 ADA');
      expect(check()).not.toContain('–');
      expect(summary()).toContain('take-profit leg 1 not filled in, suggested 0.3437 (2R); trailing stop at the 10-day low, now 0.2366.');
      await until('the partial verdict', () => check().includes('Risk check passed for the order without the exit-plan parts still to fix.'));
      expect(sheet()?.querySelector('.risk-msg.good')).toBeNull();
      expect(confirm()?.disabled).toBe(true);
      expect(why()).toBe('Exit plan: Take-profit 1: no level yet; suggested 0.3437 (2R).');
      await click(sheetButton('Suggest'));
      expect(rowInput(0)?.value).toBe('2');
      // a row holding the program's level offers no Suggest
      expect(sheetButton('Suggest')).toBeUndefined();
      await until('the leg again', () => lastPreviewed()?.takeProfits?.length === 1 && confirm()?.disabled === false);
      // a price below the entry is on the wrong side: said with the entry to beat and the proposal
      await type(rowInput(0), '-1');
      expect(sheet()?.querySelector('.exit-error')?.textContent).toBe('Take-profit 1: enter a price, an R multiple or a percentage above 0.');
      const basis = rows()[0]?.querySelector<HTMLSelectElement>('select');
      await act(async () => {
        if (basis === null || basis === undefined) throw new Error('no basis');
        basis.value = 'price';
        basis.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await type(rowInput(0), '0.25');
      expect(sheet()?.querySelector('.exit-error')?.textContent).toBe('Take-profit 1: 0.25 is not above the entry 0.2723 (a long takes profit above it); suggested 0.3437 (2R).');
      expect(why()).toBe('Exit plan: Take-profit 1: 0.25 is not above the entry 0.2723 (a long takes profit above it); suggested 0.3437 (2R).');
      // a row in error echoes no contracts of its own
      expect(rows()[0]?.querySelector('.exit-echo')?.textContent).toBe('');
      expect(summary()).toContain('take-profit leg 1 not on the profit side of the entry;');
      // a price off the tick is echoed at the price the server rounds it to (down, towards the entry), and that is what is sent
      await type(rowInput(0), '0.30005');
      expect(rows()[0]?.querySelector('.exit-echo')?.textContent).toBe('= 0.3 (rounded to the tick 0.0001) · +10.17% · 0.78R · 182.7 ct · +506.08 USDT');
      await until('the rounded trigger', () => lastPreviewed()?.takeProfits?.[0]?.triggerPx === '0.3' && confirm()?.disabled === false);
      expect([...(sheet()?.querySelectorAll('.follow-tps tbody tr') ?? [])].map((r) => r.textContent)).toEqual(['TP10.3182.7+506.08 USDT']);
      expect(summary()).toContain('take-profit 0.78R 0.3 (+10.17%, 100%);');
    });

    it('a leverage whose liquidation is not safely below the stop is refused by the sheet itself, with the leverage to lower it to', async () => {
      await openSheet();
      await type(fieldInput('Leverage'), '10');
      await until('the check at 10x', () => check().includes('Margin at 10×'));
      // the liquidation at 10x, in red, and the verdict says it instead of a pass; the reason beside the disabled button names the leverage
      expect(check()).toContain('Liquidation (est.)0.2477');
      expect([...(sheet()?.querySelectorAll('.follow-check .kv .neg') ?? [])].map((el) => el.textContent)).toContain('0.2477');
      expect(check()).toContain('At 10× the liquidation 0.2477 is above the stop 0.2366: the position would be liquidated before the stop. Lower the leverage to 6×.');
      expect(sheet()?.querySelector('.risk-msg.good')).toBeNull();
      expect(confirm()?.disabled).toBe(true);
      expect(why()).toBe('Liquidation before the stop: lower the leverage to 6×.');
      // at 7x the liquidation 0.2359 is below the stop but within the buffer: said as such
      await type(fieldInput('Leverage'), '7');
      await until('the check at 7x', () => check().includes('Margin at 7×'));
      expect(check()).toContain('At 7× the liquidation 0.2359 is below the stop 0.2366 but within the buffer (it must stay at or below 0.2342): a wick could liquidate the position before the stop. Lower the leverage to 6×.');
      await type(fieldInput('Leverage'), '6');
      await until('the pass at 6x', () => confirm()?.disabled === false);
      expect(check()).toContain('Liquidation (est.)0.2293');
      expect(why()).toBe('');
      // cross margin: the liquidation is the account's, said instead of a dash
      const mode = sheet()?.querySelector<HTMLSelectElement>('select');
      await act(async () => {
        if (mode === null || mode === undefined) throw new Error('no select');
        mode.value = 'cross';
        mode.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await until('the cross preview', () => lastPreviewed()?.tdMode === 'cross' && confirm()?.disabled === false);
      expect(check()).toContain("Liquidation (est.)cross: depends on the whole account's margin");
      expect(check()).not.toContain('–');
    });

    it('a stop not below the entry is refused by the sheet itself, in the page\'s language: the order is checked without it and its figures stay', async () => {
      await openSheet();
      previewOrder.mockImplementation((req) =>
        req.slTriggerPx !== undefined && D(req.slTriggerPx).gte('0.2723')
          ? Promise.reject(new ApiError('VALIDATION', 'the stop-loss trigger 0.2800 must be below both the order price 0.2723 and the mark price 0.2723 for a buy order', undefined, 400))
          : Promise.resolve(adaPreview(req)),
      );
      const stopInput = () => sheet()?.querySelector<HTMLInputElement>('input[aria-label="Stop (mark trigger)"]');
      await type(stopInput(), '0.28');
      expect(sheet()?.querySelector('.follow-section .follow-hint.warn')?.textContent).toBe('not below the entry: the server refuses it');
      await until('the refusal', () => why() !== '');
      expect(why()).toBe('Stop: not below the entry (the server refuses it); lower it, or leave it empty.');
      expect(confirm()?.disabled).toBe(true);
      expect(check()).toContain('Stop: not below the entry (the server refuses it); lower it, or leave it empty.');
      expect(check()).not.toContain('VALIDATION');
      expect(check()).toContain('Coin18,270.0 ADA');
      expect(check()).toContain('Loss at stopnot below the entry: the server refuses it');
      await until('the check without the stop', () => check().includes('Est. slippage0.010%'));
      expect(check()).not.toContain('–');
      // the stop never went to the server: it is checked without it
      expect(previewOrder.mock.calls.every((c) => c[0].slTriggerPx === undefined || D(c[0].slTriggerPx).lt('0.2723'))).toBe(true);
      expect(summary()).toContain('stop 0.28 not below the entry (the server refuses it);');
      // the levels say why they are percentages: the stop typed does not count
      await click(sheetButton('Single'));
      expect(rowInput(0)?.value).toBe('10');
      expect(sheet()?.querySelector('.exit-stop-ignored')?.textContent).toBe(
        'The stop 0.28 is not on the losing side of the entry (below it for a long), so it does not count: the levels are proposed as percentages from the entry.',
      );
      // a stop that is not a price
      await type(stopInput(), 'abc');
      expect(why()).toBe('Stop: enter a price, or leave it empty.');
      await type(stopInput(), '0.2366');
      await until('the pass again', () => confirm()?.disabled === false);
      expect(why()).toBe('');
    });

    it("a server refusal that is not the risk engine's stands beside the disabled button too", async () => {
      await openSheet();
      previewOrder.mockImplementation((req) =>
        req.takeProfits !== undefined
          ? Promise.reject(new ApiError('NO_PRICE', 'no live mark price for ADA-USDT-SWAP: mark-triggered take-profits and trailing exits cannot be checked against it; retry shortly', undefined, 503))
          : Promise.resolve(adaPreview(req)),
      );
      await click(sheetButton('Single'));
      await until('the refusal', () => why().startsWith('Refused by the server'));
      expect(why()).toBe('Refused by the server: NO_PRICE: no live mark price for ADA-USDT-SWAP: mark-triggered take-profits and trailing exits cannot be checked against it; retry shortly');
      expect(confirm()?.disabled).toBe(true);
      expect(check()).toContain('NO_PRICE: no live mark price for ADA-USDT-SWAP');
    });

    it('with the stop cleared the loss is said at the channel stop, the summary says where the stop will be, and Suggest brings the stop back', async () => {
      await openSheet();
      const stopInput = () => sheet()?.querySelector<HTMLInputElement>('input[aria-label="Stop (mark trigger)"]');
      await type(stopInput(), '');
      expect(sheet()?.querySelector('.follow-section .follow-hint.warn')?.textContent).toBe('No stop attached; suggested 0.2366 (the exit line). Channel trailing puts a stop at 0.2366 once the order has filled.');
      await until('the preview without a stop', () => lastPreviewed()?.slTriggerPx === undefined && confirm()?.disabled === false);
      expect(check()).toContain('Loss at stop652.24 USDT · 0.65% of equity · at the channel stop 0.2366');
      expect(check()).not.toContain('–');
      expect(sheet()?.querySelector('.follow-size-note')?.textContent).toBe(
        'Risk 0.75% sizes 210 contracts; the per-order notional limit of 5,000.00 USDT allows 182.7 (each contract counted at 27.37 USDT: the entry plus 0.50% of slippage): 182.7 filled in, actual risk 0.65% (652.24 USDT).',
      );
      expect(summary()).toBe(
        'Buy 182.7 contracts (18,270.0 ADA) of ADA-USDT-SWAP at market, isolated 6×; no stop attached; channel trailing puts one at 0.2366 after the fill (13.11% below), at risk 652.24 USDT (0.65% of equity); no take-profit; trailing stop at the 10-day low, now 0.2366.',
      );
      // the levels are measured from the stop the order will have, the channel's: 2R over the same 0.0357 as with the attached stop
      await click(sheetButton('Single'));
      expect([rows()[0]?.querySelector<HTMLSelectElement>('select')?.value, rowInput(0)?.value]).toEqual(['r', '2']);
      expect(rows()[0]?.querySelector('.exit-echo')?.textContent).toBe('= 0.3437 · +26.22% · 182.7 ct · +1,304.48 USDT');
      await until('the leg in the preview', () => lastPreviewed()?.takeProfits?.[0]?.triggerPx === '0.3437' && lastPreviewed()?.slTriggerPx === undefined && confirm()?.disabled === false);
      expect(summary()).toContain('take-profit 2.00R 0.3437 (+26.22%, 100%); trailing stop at the 10-day low, now 0.2366.');
      // a ladder too, but without the cost-price stop: the exchange moves a stop attached to the order only
      await click(sheetButton('Ladder'));
      expect([rowInput(0)?.value, rowInput(1)?.value]).toEqual(['1.5', '3']);
      const breakeven = () => sheet()?.querySelector<HTMLInputElement>('.exit-breakeven input');
      expect(breakeven()?.checked).toBe(false);
      expect(breakeven()?.disabled).toBe(true);
      expect(sheet()?.querySelector('.exit-breakeven')?.textContent).toContain('(needs a stop attached to the order and two legs or more)');
      await until('the ladder in the preview', () => lastPreviewed()?.takeProfits?.length === 2 && confirm()?.disabled === false);
      expect(lastPreviewed()?.breakevenAfterTp1).toBeUndefined();
      await click(sheet()?.querySelector('.follow-stop-suggest'));
      expect(stopInput()?.value).toBe('0.2366');
      expect(sheet()?.querySelector('.follow-stop-suggest')).toBeNull();
      // ... with the stop back the levels are the same, and the cost-price stop comes with it
      expect([rows()[0]?.querySelector<HTMLSelectElement>('select')?.value, rowInput(0)?.value, rowInput(1)?.value]).toEqual(['r', '1.5', '3']);
      expect(breakeven()?.checked).toBe(true);
      // no stop and no channel: the loss is said to be unbounded, and the levels are percentages from the entry
      await type(stopInput(), '');
      await click([...(sheet()?.querySelectorAll<HTMLButtonElement>('.exit-block:last-child .seg-btn') ?? [])].find((b) => b.textContent === 'None'));
      expect(check()).toContain('Loss at stopnot bounded (no stop)');
      expect(summary()).toContain('; no stop: the loss is not bounded;');
      expect([rows()[0]?.querySelector<HTMLSelectElement>('select')?.value, rowInput(0)?.value, rowInput(1)?.value]).toEqual(['pct', '5', '10']);
      expect(breakeven()?.checked).toBe(false);
    });

    it('with the size cleared the program says the size it proposes, nowhere a dash with a unit', async () => {
      await openSheet();
      await type(fieldInput('Contracts'), '');
      expect(sheet()?.querySelector('.follow-size-note')?.textContent).toBe('No size yet; suggested 182.7 contracts (Size from risk).');
      expect(check()).toContain('Contracts–');
      expect(check()).not.toContain('– ct');
      expect(check()).toContain('Enter the contracts to check the order; suggested 182.7.');
      expect(summary()).toBe(
        'Buy contracts not filled in (suggested 182.7) of ADA-USDT-SWAP at market, isolated 6×; stop 0.2366 (13.11% below); no take-profit; trailing stop at the 10-day low, now 0.2366.',
      );
      expect(confirm()?.disabled).toBe(true);
      expect(why()).toBe('Contracts: not filled in; suggested 182.7.');
      await click(sheetButton('Size from risk'));
      expect(fieldInput('Contracts')?.value).toBe('182.7');
    });

    it('a callback trailing stop names its trigger: at the current price, or the earliest once the activation price is reached', async () => {
      await openSheet();
      await click(sheetButton('Callback'));
      const fields = () => [...(sheet()?.querySelectorAll<HTMLInputElement>('.exit-field input') ?? [])];
      expect(sheet()?.querySelector('.exit-now')?.textContent).toBe('Closes once the price comes back 5% from its highest since activation; at the current price that is 0.2586.');
      await until('the callback preview', () => lastPreviewed()?.trailing?.kind === 'callback');
      expect(summary()).toContain('; trailing stop 5.00% callback (0.2586 at the current price).');
      await type(fields()[0], '3');
      await type(fields()[1], '0.28');
      expect(sheet()?.querySelector('.exit-now')?.textContent).toBe('Closes once the price comes back 3% from its highest since activation; the earliest trigger is then 0.2716. Activates at 0.28.');
      await until('the activation in the preview', () => {
        const trailing = lastPreviewed()?.trailing;
        return trailing?.kind === 'callback' && trailing.activePx === '0.28';
      });
      expect(summary()).toContain('; trailing stop 3.00% callback from 0.28 (0.2716 at the earliest).');
    });

    it('a ladder out of order is said under its row: the legs fill in their order', async () => {
      await openSheet();
      await click(sheetButton('Ladder'));
      await type(rowInput(1), '1');
      expect(rows()[1]?.parentElement?.querySelector('.exit-error')?.textContent).toBe('Take-profit 2: must be beyond take-profit 1 (higher for a long, lower for a short): the legs fill in their order.');
      expect(why()).toBe('Exit plan: Take-profit 2: must be beyond take-profit 1 (higher for a long, lower for a short): the legs fill in their order.');
      expect(summary()).toContain('take-profit 1.50R 0.3258 (+19.65%, 50%), leg 2 not beyond the leg before it;');
      expect(confirm()?.disabled).toBe(true);
    });

    it("a size typed over the limit is refused by the server: the reason stands beside the disabled button, and the cap under the field", async () => {
      await openSheet();
      await type(fieldInput('Contracts'), '210');
      expect(sheet()?.querySelector('.follow-size-note')?.textContent).toBe(
        'Over the per-order notional limit of 5,000.00 USDT: at most 182.7 contracts (each contract counted at 27.37 USDT: the entry plus 0.50% of slippage).Use 182.7',
      );
      await until('the refusal', () => why().startsWith('Refused'));
      // the risk engine's refusal worded by the page, with the unit and separators
      expect(why()).toBe("Refused by the risk check (MAX_ORDER_NOTIONAL): the order's notional 5,718.30 USDT is over the per-order limit of 5,000.00 USDT");
      expect(confirm()?.disabled).toBe(true);
      expect(check()).toContain('Notional5,718.30 USDT');
      // one click takes the most the limit allows
      await click(sheetButton('Use 182.7'));
      expect(fieldInput('Contracts')?.value).toBe('182.7');
      expect(sheet()?.querySelector('.follow-size-note')).toBeNull();
      await until('the check passing again', () => confirm()?.disabled === false);
      expect(why()).toBe('');
      // sizing from the risk again applies the cap, and says so again
      await type(fieldInput('Contracts'), '200');
      await click(sheetButton('Size from risk'));
      expect(fieldInput('Contracts')?.value).toBe('182.7');
      expect(sheet()?.querySelector('.follow-size-note')?.textContent).toContain('Risk 0.75% sizes 210 contracts');
    });

    it("the size follows the form while it is the program's: the note is true of the field after the stop, the limit price, the risk or the leverage changes", async () => {
      await openSheet();
      const stopInput = () => sheet()?.querySelector<HTMLInputElement>('input[aria-label="Stop (mark trigger)"]');
      const note = () => sheet()?.querySelector('.follow-size-note')?.textContent ?? '';
      // a stop almost at the entry: the risk would buy 24,990 contracts, the limit still allows 182.7, and the risk at that stop is 5.48 USDT
      await type(stopInput(), '0.2720');
      expect(fieldInput('Contracts')?.value).toBe('182.7');
      expect(note()).toBe('Risk 0.75% sizes 24,990 contracts; the per-order notional limit of 5,000.00 USDT allows 182.7 (each contract counted at 27.37 USDT: the entry plus 0.50% of slippage): 182.7 filled in, actual risk 0.01% (5.48 USDT).');
      // a far stop: the risk buys 103.6 contracts, within every limit, so the field follows and nothing cuts it
      await type(stopInput(), '0.2');
      expect(fieldInput('Contracts')?.value).toBe('103.6');
      expect(sheet()?.querySelector('.follow-size-note')).toBeNull();
      expect(check()).toContain('Loss at stop749.03 USDT · 0.75% of equity');
      await type(stopInput(), '0.2366');
      expect(fieldInput('Contracts')?.value).toBe('182.7');
      // a limit price below the mark: sized and cut at that price
      await click(sheetButton('limit'));
      await type(fieldInput('Limit price'), '0.2650');
      // (a limit order is counted at its price alone: 5,000 over 26.50 = 188.6)
      expect(fieldInput('Contracts')?.value).toBe('188.6');
      expect(note()).toBe('Risk 0.75% sizes 263.9 contracts; the per-order notional limit of 5,000.00 USDT allows 188.6 (each contract counted at 26.50 USDT): 188.6 filled in, actual risk 0.54% (535.62 USDT).');
      await click(sheetButton('market'));
      // the risk percentage: half the risk, half the contracts
      await type(fieldInput('Risk % of equity'), '0.3');
      expect(fieldInput('Contracts')?.value).toBe('84');
      expect(sheet()?.querySelector('.follow-size-note')).toBeNull();
      // ... and cleared: the field keeps the last size and the note says what is missing
      await type(fieldInput('Risk % of equity'), '');
      expect(fieldInput('Contracts')?.value).toBe('84');
      expect(note()).toBe('Risk %: enter a positive number to size from it; the size filled in is the last one computed.');
      await type(fieldInput('Risk % of equity'), '0.75');
      expect(fieldInput('Contracts')?.value).toBe('182.7');
      // a size of the trader's own stays theirs when the stop moves; Size from risk hands the field back to the program
      await type(fieldInput('Contracts'), '100');
      await type(stopInput(), '0.2');
      expect(fieldInput('Contracts')?.value).toBe('100');
      await click(sheetButton('Size from risk'));
      expect(fieldInput('Contracts')?.value).toBe('103.6');
      await type(stopInput(), '0.2366');
      expect(fieldInput('Contracts')?.value).toBe('182.7');
      // the balance bound follows the leverage: at 1x the margin for 182.7 contracts is more than the balance allows
      useStore.setState({ balance: { totalEq: '99960', details: [{ ccy: 'USDT', eq: '99960', availEq: '3000', cashBal: '99960', upl: '0' }], ts: 1 } });
      await type(fieldInput('Leverage'), '1');
      expect(fieldInput('Contracts')?.value).toBe('109.5');
      expect(note()).toContain('the available balance of 3,000.00 USDT allows 109.5');
    });

    it('a callback trailing stop nearer than the stop is priced: it fires first, at its smaller loss; without any other stop it is the stop', async () => {
      await openSheet();
      await click(sheetButton('Callback'));
      await until('the callback preview', () => lastPreviewed()?.trailing?.kind === 'callback');
      // the risk is still counted at the attached stop 0.2366 (the size too), and the callback stop at 0.2586 is said to fire first
      expect(check()).toContain('Loss at stop652.24 USDT · 0.65% of equity · the callback stop 0.2586 fires first: 250.30 USDT (0.25% of equity)');
      expect(summary()).toContain('stop 0.2366 (13.11% below), at risk 652.24 USDT (0.65% of equity); the callback stop 0.2586 fires first: 250.30 USDT (0.25% of equity); no take-profit; trailing stop 5.00% callback (0.2586 at the current price).');
      // a callback wider than the stop's distance fires after it: nothing more to say
      const fields = () => [...(sheet()?.querySelectorAll<HTMLInputElement>('.exit-field input') ?? [])];
      await type(fields()[0], '15');
      expect(check()).not.toContain('fires first');
      await type(fields()[0], '5');
      // no stop attached: the callback stop is the stop the order will have, the loss and the levels are measured at it
      const stopInput = () => sheet()?.querySelector<HTMLInputElement>('input[aria-label="Stop (mark trigger)"]');
      await type(stopInput(), '');
      expect(sheet()?.querySelector('.follow-section .follow-hint.warn')?.textContent).toBe('No stop attached; suggested 0.2366 (the exit line). The callback trailing stop stands at 0.2586 once the order has filled.');
      expect(check()).toContain('Loss at stop250.30 USDT · 0.25% of equity · at the callback stop 0.2586');
      expect(summary()).toContain('no stop attached; the callback trailing stop stands at 0.2586 after the fill (5.03% below), at risk 250.30 USDT (0.25% of equity);');
      await click(sheetButton('Single'));
      // 2R over 0.0137: 0.2997
      expect(rows()[0]?.querySelector('.exit-echo')?.textContent).toBe('= 0.2997 · +10.06% · 182.7 ct · +500.60 USDT');
      // an activation price already reached: the trigger is at the current price, not "at the earliest"
      await type(fields()[1], '0.26');
      expect(sheet()?.querySelector('.exit-now')?.textContent).toBe('Closes once the price comes back 5% from its highest since activation; at the current price that is 0.2586. Activates at 0.26.');
      await until('the activation in the preview', () => {
        const trailing = lastPreviewed()?.trailing;
        return trailing?.kind === 'callback' && trailing.activePx === '0.26';
      });
      expect(summary()).toContain('trailing stop 5.00% callback from 0.26 (0.2586 at the current price).');
      // one not reached yet: the stop is not armed at the fill, so it is no stop
      await type(fields()[1], '0.28');
      expect(check()).toContain('Loss at stopnot bounded (no stop)');
      expect(summary()).toContain('trailing stop 5.00% callback from 0.28 (0.266 at the earliest).');
    });

    it('a stop that is not a price is said as such everywhere; an off-tick stop is rounded as the server rounds it', async () => {
      await openSheet();
      const stopInput = () => sheet()?.querySelector<HTMLInputElement>('input[aria-label="Stop (mark trigger)"]');
      for (const text of ['abc', '0,2366', '0']) {
        await type(stopInput(), text);
        expect(sheet()?.querySelector('.follow-section .follow-hint.warn')?.textContent).toBe('not a price: enter one (digits and a point), or leave it empty');
        expect(check()).toContain('Loss at stopnot a price: enter one (digits and a point), or leave it empty');
        expect(summary()).toContain(`stop "${text}" is not a price (enter one, or leave it empty); no take-profit;`);
        expect(summary()).not.toContain('–');
        expect(why()).toBe('Stop: enter a price, or leave it empty.');
        expect(confirm()?.disabled).toBe(true);
      }
      // the stop is sent rounded up to the tick, towards the entry, and the loss is counted at that price
      await type(stopInput(), '0.23665');
      expect(stopInput()?.closest('.follow-field')?.querySelector('.follow-hint')?.textContent).toBe('13.07% below the entry · rounded to the tick 0.0001: 0.2367');
      await until('the rounded stop', () => lastPreviewed()?.slTriggerPx === '0.2367' && confirm()?.disabled === false);
      expect(check()).toContain('Loss at stop650.41 USDT');
      expect(summary()).toContain('stop 0.2367 (13.07% below), at risk 650.41 USDT (0.65% of equity);');
    });

    it('a blank leverage or limit price is said in the check and the summary, never a bare dash or a figure under the wrong label', async () => {
      await openSheet();
      await type(fieldInput('Leverage'), '');
      expect([...(sheet()?.querySelectorAll('.follow-field .follow-hint.warn') ?? [])].map((el) => el.textContent)).toContain('Leverage: enter a positive number.');
      expect(check()).toContain('Marginleverage not filled in');
      expect(check()).toContain('Liquidation (est.)leverage not filled in');
      expect(check()).toContain('Leverage: enter a positive number.');
      expect(check()).not.toContain('Risk check passed');
      expect(check()).not.toContain('–');
      expect(summary()).toContain('at market, isolated leverage not filled in; stop 0.2366');
      expect(why()).toBe('Leverage: enter a positive number.');
      expect(confirm()?.disabled).toBe(true);
      // at 1x the position cannot be liquidated: said instead of a zero
      await type(fieldInput('Leverage'), '1');
      await until('the check at 1x', () => check().includes('Margin at 1×'));
      expect(check()).toContain('Liquidation (est.)none: at this leverage the price cannot reach it');
      await type(fieldInput('Leverage'), '6');
      // a limit order whose price is cleared: the figures are at the mark and say so
      await click(sheetButton('limit'));
      await type(fieldInput('Limit price'), '');
      expect(check()).toContain('Limit pricenot filled in; figures at the mark 0.2723');
      expect(check()).toContain('Enter the limit price to check the order.');
      expect(summary()).toContain('of ADA-USDT-SWAP at a limit price not filled in yet, isolated 6×;');
      expect(summary()).not.toContain('–');
      expect(why()).toBe('Limit price: enter one.');
    });

    it('a size off the lot is sent rounded down and said so; one below the minimum order is refused by the sheet with the figure as typed', async () => {
      await openSheet();
      await type(fieldInput('Contracts'), '100.05');
      expect(sheet()?.querySelector('.follow-size-note')?.textContent).toBe('100.05 is not a whole number of lots of 0.1: the order is sent for 100 contracts.');
      expect(check()).toContain('Contracts100 ct');
      expect(check()).toContain('Coin10,000.0 ADA');
      await until('the rounded size', () => lastPreviewed()?.size.value === '100' && confirm()?.disabled === false);
      expect(summary()).toContain('Buy 100 contracts (10,000.0 ADA)');
      await type(fieldInput('Contracts'), '0.05');
      expect(sheet()?.querySelector('.follow-size-note')?.textContent).toBe('0.05 is below the minimum order of 0.1 contracts: the server refuses it.');
      expect(check()).toContain('Contracts0.05 ct');
      expect(check()).toContain('Coin5.0 ADA');
      expect(check()).toContain('Contracts: below the minimum order of 0.1; suggested 182.7.');
      expect(why()).toBe('Contracts: below the minimum order of 0.1; suggested 182.7.');
      expect(confirm()?.disabled).toBe(true);
      // one contract: a tiny share of the equity is still a figure
      await type(fieldInput('Contracts'), '1');
      expect(check()).toContain('Loss at stop3.57 USDT · 0.0036% of equity');
    });

    it('a ladder share over 100 shows no rest figure; a leg too small for the minimum order is flagged; a missing share names its suggestion', async () => {
      await openSheet();
      await click(sheetButton('Ladder'));
      const shareInput = (i: number) => rows()[i]?.querySelectorAll<HTMLInputElement>('input')[1];
      await type(shareInput(0), '150');
      expect(rows()[0]?.parentElement?.querySelector('.exit-error')?.textContent).toBe('Take-profit 1: enter its share as a percentage above 0 and at most 100.');
      expect(rows()[1]?.querySelector('.exit-rest')?.textContent).toBe('rest');
      // a share that sizes the leg below the minimum order
      await type(shareInput(0), '0.01');
      expect(rows()[0]?.parentElement?.querySelector('.exit-error')?.textContent).toBe('Take-profit 1: its share comes to 0 contracts, below the minimum order of 0.1: a larger share, fewer legs or a larger order.');
      expect(why()).toBe('Exit plan: Take-profit 1: its share comes to 0 contracts, below the minimum order of 0.1: a larger share, fewer legs or a larger order.');
      expect(summary()).toContain('take-profit leg 1 below the minimum order,');
      // a leg added after a share of the trader's own: its share is asked for, with the even split suggested, in the row and in the summary
      await type(shareInput(0), '30');
      await click(sheetButton('+ leg'));
      expect(rows()[1]?.parentElement?.querySelector('.exit-hint.warn')?.textContent).toBe('Take-profit 2: no share yet; suggested 33%.');
      expect(summary()).toContain('leg 2 share not filled in, suggested 33%');
    });

    it("the plan's warnings are labelled as the plan's figures, and a 10% level says the gain the tick makes of it", async () => {
      await openSheet();
      expect(sheet()?.querySelector('.sig-warnings-note')?.textContent).toBe("The plan's warnings, at its own leverage, stop and the mark price; the live check on the right follows the form.");
      const stopInput = () => sheet()?.querySelector<HTMLInputElement>('input[aria-label="Stop (mark trigger)"]');
      await type(stopInput(), '0.28');
      await click(sheetButton('Single'));
      // 0.2723 x 1.10 = 0.29953, on the tick 0.2995: +9.99%, said beside the 10
      expect(rowInput(0)?.value).toBe('10');
      expect(rows()[0]?.querySelector('.exit-echo')?.textContent).toBe('= 0.2995 · +9.99% · 182.7 ct · +496.94 USDT');
    });

    it('in Chinese: the size note, the leverage warning and the proposed level', async () => {
      useLangStore.setState({ lang: 'zh' });
      await openSheet();
      expect(sheet()?.querySelector('.follow-size-note')?.textContent).toBe('按风险 0.75% 应为 210 张；单笔名义上限 5,000.00 USDT 只允许 182.7 张（每张按 27.37 USDT 计：开仓价加 0.50% 滑点余量），已填 182.7 张，实际风险 0.65%（652.24 USDT）。');
      expect(sheet()?.querySelector('.sig-warnings li')?.textContent).toBe('10 倍时强平价 0.2477，在止损 0.2366 之上，止损前会先被强平；已降到 6 倍，强平价 0.2293，在止损之下（要求不高于 0.2342）。');
      await click(sheetButton('单一止盈'));
      expect(rowInput(0)?.value).toBe('2');
      expect(rows()[0]?.querySelector('.exit-echo')?.textContent).toBe('= 0.3437 · +26.22% · 182.7 张 · +1,304.48 USDT');
      expect(sheet()?.querySelector('.exit-now')?.textContent).toBe('止损现在在 0.2366（最近 10 日最低价），每天 UTC 00:00 收盘后只往上移。');
      await until('the preview', () => lastPreviewed()?.takeProfits?.length === 1 && confirm()?.disabled === false);
      expect(summary()).toBe('买入 ADA-USDT-SWAP 182.7 张（18,270.0 ADA），市价，逐仓 6 倍；止损 0.2366（低于开仓价 13.11%），风险 652.24 USDT（占权益 0.65%）；止盈 2.00R 0.3437（+26.22%，100%）；通道移动止损，10 日低点，现在 0.2366。');
      // a level cleared, the stop cleared, the leverage too high: each said in Chinese with its figures
      await type(rowInput(0), '');
      expect(sheet()?.querySelector('.exit-hint.warn')?.textContent).toBe('止盈 1：价位未填，建议 0.3437（2R）。');
      expect(summary()).toContain('止盈 第 1 档未填，建议 0.3437（2R）；通道移动止损，10 日低点，现在 0.2366。');
      expect(why()).toBe('离场方案：止盈 1：价位未填，建议 0.3437（2R）。');
      await click(sheetButton('建议'));
      await type(sheet()?.querySelector<HTMLInputElement>('input[aria-label="止损（标记价触发）"]'), '');
      await until('the preview without a stop', () => lastPreviewed()?.slTriggerPx === undefined);
      expect(sheet()?.querySelector('.follow-section .follow-hint.warn')?.textContent).toBe('未附带止损，建议 0.2366（出场线）。成交后通道移动止损会在 0.2366 挂出止损。');
      expect(summary()).toContain('未附带止损，成交后通道移动止损在 0.2366 挂出止损（低于开仓价 13.11%），风险 652.24 USDT（占权益 0.65%）；止盈 2.00R 0.3437（+26.22%，100%）；');
      expect(check()).toContain('按通道止损 0.2366');
      // the hint under the contracts field says the share of the equity is the risk's
      expect(sheet()?.querySelector('.follow-field .follow-hint.num')?.textContent).toBe('18,270.0 ADA · 风险占权益 0.65%');
      await click(sheet()?.querySelector('.follow-stop-suggest'));
      await type(fieldInput('杠杆'), '10');
      await until('the check at 10x', () => check().includes('10 倍时强平价'));
      expect(check()).toContain('10 倍时强平价 0.2477，在止损 0.2366 之上，止损前会先被强平。请把杠杆降到 6 倍。');
      expect(why()).toBe('止损前会先被强平：请把杠杆降到 6 倍。');
      // a price on the wrong side, with the entry to beat and the proposal; a stop not below the entry
      await type(fieldInput('杠杆'), '6');
      const basis = rows()[0]?.querySelector<HTMLSelectElement>('select');
      await act(async () => {
        if (basis === null || basis === undefined) throw new Error('no basis');
        basis.value = 'price';
        basis.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await type(rowInput(0), '0.25');
      expect(sheet()?.querySelector('.exit-error')?.textContent).toBe('止盈 1：0.25 不高于开仓价 0.2723（做多的止盈应在开仓价之上），建议 0.3437（2R）。');
      await type(sheet()?.querySelector<HTMLInputElement>('input[aria-label="止损（标记价触发）"]'), '0.28');
      expect(why()).toBe('止损：不低于开仓价（服务器会拒绝），请调低或留空。');
    });
  });

  it("an add is checked against the position after it, as the plan is, not against a fresh position at the add price", async () => {
    previewOrder.mockImplementation((req) => Promise.resolve({ ...previewOf(req), refPrice: '3188.75', coin: '0.8', notionalQuote: '2551', lever: '10', stopLossQuote: '226.68' }));
    await render();
    await until('the coins', () => coin('ETH') !== undefined);
    await click(coin('ETH'));
    await until('the follow button', () => follow()?.disabled === false);
    await click(follow());
    await until('the live check', () => lastPreviewed()?.instId === 'ETH-USDT-SWAP' && confirm()?.disabled === false);
    const check = () => sheet()?.querySelector('.follow-check')?.textContent ?? '';
    expect(sheet()?.textContent).toContain('Follow the add signal');
    // 8 contracts at 3,188.75 on the 20 held at 3,020.5 (margin 604.1 at the position's 10x): the position's liquidation after
    // the add, 2,774.2, is below the 2,876.35 line; the add alone, as a fresh position, would be at 2,882.85, above it
    expect(fieldInput('Contracts')?.value).toBe('8');
    expect(fieldInput('Leverage')?.value).toBe('10');
    expect(check()).toContain('Liquidation (est.)2,774.2');
    expect(sheet()?.querySelector('.follow-check .risk-msg.bad')).toBeNull();
    expect(sheet()?.querySelector('.follow-why')).toBeNull();
    expect(confirm()?.disabled).toBe(false);
    // at 20x the position after the add (its margin then its notional over 20) would be liquidated at 2,928.32, above the stop; 14x is the highest that passes
    await type(fieldInput('Leverage'), '20');
    await until('the check at 20x', () => check().includes('Margin at 20×'));
    expect(check()).toContain("After the add, at the position's 20×, its liquidation 2,928.32 is above the stop 2,905.4: the position would be liquidated before the stop. Lower the leverage to 14×.");
    expect(confirm()?.disabled).toBe(true);
    expect(sheet()?.querySelector('.follow-why')?.textContent).toBe('Liquidation before the stop: lower the leverage to 14×.');
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
