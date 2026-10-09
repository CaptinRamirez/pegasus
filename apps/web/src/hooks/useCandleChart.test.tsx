import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Candle } from '@pegasus/shared';
import { useCandleChart } from './useCandleChart';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const chart = vi.hoisted(() => {
  const series = () => {
    const scale = { applyOptions: vi.fn() };
    return { setData: vi.fn(), update: vi.fn(), applyOptions: vi.fn(), priceScale: () => scale, scale };
  };
  return { scrollToRealTime: vi.fn(), candles: series(), volume: series() };
});

vi.mock('lightweight-charts', () => ({
  CandlestickSeries: 'Candlestick',
  HistogramSeries: 'Histogram',
  ColorType: { Solid: 'solid' },
  CrosshairMode: { Normal: 0 },
  createChart: () => ({
    addSeries: (kind: string) => (kind === 'Candlestick' ? chart.candles : chart.volume),
    timeScale: () => ({ scrollToRealTime: chart.scrollToRealTime }),
    applyOptions: vi.fn(),
    remove: vi.fn(),
  }),
}));

const candle = (ts: number, close: string): Candle => ({ ts, open: '100', high: '110', low: '90', close, vol: '5', volCcy: '500', confirm: true });

function Harness({ history, chartKey }: { history: Candle[] | undefined; chartKey: string }) {
  const container = useRef<HTMLDivElement | null>(null);
  useCandleChart(container, null, history, undefined, chartKey);
  return <div ref={container} />;
}

describe('useCandleChart', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    });
    chart.scrollToRealTime.mockClear();
    chart.candles.setData.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = (history: Candle[] | undefined, chartKey: string): Promise<void> =>
    act(async () => {
      root.render(<Harness history={history} chartKey={chartKey} />);
    });

  it('scrolls to the newest bar when the instrument or bar changes, not when the same history is refetched', async () => {
    await render([candle(60_000, '101')], 'BTC-USDT-SWAP|1m');
    expect(chart.scrollToRealTime).toHaveBeenCalledTimes(1);

    // a refetch after a connection gap: the data is replaced, the view stays where the user left it
    await render([candle(60_000, '102'), candle(120_000, '103')], 'BTC-USDT-SWAP|1m');
    expect(chart.candles.setData).toHaveBeenLastCalledWith([expect.objectContaining({ time: 60, close: 102 }), expect.objectContaining({ time: 120, close: 103 })]);
    expect(chart.scrollToRealTime).toHaveBeenCalledTimes(1);

    await render(undefined, 'BTC-USDT-SWAP|5m');
    await render([candle(300_000, '104')], 'BTC-USDT-SWAP|5m');
    expect(chart.scrollToRealTime).toHaveBeenCalledTimes(2);

    // straight to a cached history of another instrument
    await render([candle(300_000, '3000')], 'ETH-USDT-SWAP|5m');
    expect(chart.scrollToRealTime).toHaveBeenCalledTimes(3);
  });

  it('turns the price autoscale back on when the instrument or bar changes, not when the same history is refetched', async () => {
    const autoScaleOn = () => chart.candles.scale.applyOptions.mock.calls.filter(([o]) => (o as { autoScale?: boolean }).autoScale === true).length;
    const before = autoScaleOn();
    await render([candle(60_000, '0.27')], 'DOGE-USDT-SWAP|1D');
    expect(autoScaleOn()).toBe(before + 1);

    // the trader drags the price axis (the chart turns autoscale off); a refetch keeps their range
    await render([candle(60_000, '0.28')], 'DOGE-USDT-SWAP|1D');
    expect(autoScaleOn()).toBe(before + 1);

    // another coin: its candles must be in view, whatever range the axis was dragged to
    await render([candle(60_000, '2499')], 'ETH-USDT-SWAP|1D');
    expect(autoScaleOn()).toBe(before + 2);
  });
});
