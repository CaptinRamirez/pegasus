import { useEffect, useRef, type RefObject } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { D, decimalsOfStep, type Candle, type Instrument } from '@pegasus/shared';

const UP = '#2ebd85';
const DOWN = '#f6465d';
const UP_T = 'rgba(46, 189, 133, 0.45)';
const DOWN_T = 'rgba(246, 70, 93, 0.45)';

interface ChartRefs {
  chart: IChartApi;
  candles: ISeriesApi<'Candlestick'>;
  volume: ISeriesApi<'Histogram'>;
}

const toTime = (ts: number): UTCTimestamp => Math.floor(ts / 1000) as UTCTimestamp;

// Number() is used here only to produce chart coordinates, never for arithmetic.
const toCandle = (c: Candle): CandlestickData => ({
  time: toTime(c.ts),
  open: Number(c.open),
  high: Number(c.high),
  low: Number(c.low),
  close: Number(c.close),
});

const toVolume = (c: Candle): HistogramData => ({
  time: toTime(c.ts),
  value: Number(c.vol),
  color: D(c.close).gte(c.open) ? UP_T : DOWN_T,
});

/**
 * Owns a lightweight-charts instance: history is loaded with setData, live
 * candles (keyed by ts) are applied with update, never going back in time.
 * `key` identifies the (instId, bar) pair the data belongs to.
 */
export function useCandleChart(
  container: RefObject<HTMLDivElement | null>,
  inst: Instrument | null,
  history: Candle[] | undefined,
  live: Record<number, Candle> | undefined,
  key: string,
): void {
  const refs = useRef<ChartRefs | null>(null);
  const lastTs = useRef<number | null>(null);
  const loadedKey = useRef<string | null>(null);

  useEffect(() => {
    const el = container.current;
    if (el === null) return;
    const chart = createChart(el, {
      // Pin the locale: the default (navigator.language) can be an invalid BCP 47 tag on some systems and makes Intl throw.
      localization: { locale: 'en-US' },
      layout: {
        background: { type: ColorType.Solid, color: '#10141c' },
        textColor: '#8a93a3',
        fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
        fontSize: 11,
      },
      grid: { vertLines: { color: '#161b26' }, horzLines: { color: '#161b26' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#222a38' },
      timeScale: { borderColor: '#222a38', timeVisible: true, secondsVisible: false, rightOffset: 4 },
      width: el.clientWidth,
      height: el.clientHeight,
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.25 } });
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    refs.current = { chart, candles, volume };

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) chart.applyOptions({ width: Math.floor(width), height: Math.floor(height) });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      refs.current = null;
      loadedKey.current = null;
      lastTs.current = null;
    };
  }, [container]);

  const tickSz = inst?.tickSz;
  useEffect(() => {
    const r = refs.current;
    if (r === null || tickSz === undefined) return;
    r.candles.applyOptions({
      priceFormat: { type: 'price', precision: decimalsOfStep(tickSz), minMove: Number(tickSz) },
    });
  }, [tickSz]);

  useEffect(() => {
    const r = refs.current;
    if (r === null) return;
    if (history === undefined) {
      r.candles.setData([]);
      r.volume.setData([]);
      loadedKey.current = null;
      lastTs.current = null;
      return;
    }
    const sorted = [...history].sort((a, b) => a.ts - b.ts);
    r.candles.setData(sorted.map(toCandle));
    r.volume.setData(sorted.map(toVolume));
    lastTs.current = sorted[sorted.length - 1]?.ts ?? null;
    // A refetch of the same instrument and bar must not move the view away from where the user is looking.
    const switched = loadedKey.current !== key;
    loadedKey.current = key;
    applyLive(r, live, lastTs);
    if (switched) r.chart.timeScale().scrollToRealTime();
  }, [history, key]); // live candles are applied by the effect below

  useEffect(() => {
    const r = refs.current;
    if (r === null || loadedKey.current !== key) return;
    applyLive(r, live, lastTs);
  }, [live, key]);
}

function applyLive(r: ChartRefs, live: Record<number, Candle> | undefined, lastTs: { current: number | null }): void {
  if (live === undefined) return;
  const floor = lastTs.current ?? Number.NEGATIVE_INFINITY;
  const pending = Object.values(live)
    .filter((c) => c.ts >= floor)
    .sort((a, b) => a.ts - b.ts);
  for (const c of pending) {
    r.candles.update(toCandle(c));
    r.volume.update(toVolume(c));
    lastTs.current = c.ts;
  }
}
