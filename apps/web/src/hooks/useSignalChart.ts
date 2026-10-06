import { useEffect, useRef, type RefObject } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from 'lightweight-charts';
import { D, decimalsOfStep, type Candle, type Decimal } from '@pegasus/shared';

const DAY_MS = 86_400_000;
const toTime = (ts: number): UTCTimestamp => Math.floor(ts / 1000) as UTCTimestamp;

export interface ChannelPoint {
  ts: number;
  value: Decimal;
}

/**
 * The two channels of the campaign rule over confirmed daily bars, one point per bar: the highest high of the
 * `entry` bars before it (what its close was tested against for an entry) and the lowest low of the `exit` bars before
 * it; the last point is at the bar after the last confirmed one, the levels the next close is tested against.
 */
export function channelLines(candles: readonly Candle[], entry: number, exit: number): { entry: ChannelPoint[]; exit: ChannelPoint[] } {
  const bars = candles.filter((c) => c.confirm).sort((a, b) => a.ts - b.ts);
  const out = { entry: [] as ChannelPoint[], exit: [] as ChannelPoint[] };
  for (let i = 1; i <= bars.length; i++) {
    const ts = i < bars.length ? (bars[i]?.ts ?? 0) : (bars[bars.length - 1]?.ts ?? 0) + DAY_MS;
    if (i >= entry) {
      let high: Decimal | null = null;
      for (const b of bars.slice(i - entry, i)) if (high === null || D(b.high).gt(high)) high = D(b.high);
      if (high !== null) out.entry.push({ ts, value: high });
    }
    if (i >= exit) {
      let low: Decimal | null = null;
      for (const b of bars.slice(i - exit, i)) if (low === null || D(b.low).lt(low)) low = D(b.low);
      if (low !== null) out.exit.push({ ts, value: low });
    }
  }
  return out;
}

// Decimal.toNumber() and Number() are used here only to produce chart coordinates, never for arithmetic.
const toCandle = (c: Candle): CandlestickData => ({ time: toTime(c.ts), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) });
const toLine = (points: readonly ChannelPoint[]): LineData[] => points.map((p) => ({ time: toTime(p.ts), value: p.value.toNumber() }));

export const CHANNEL_COLORS = { entry: '#2ebd85', exit: '#f6465d' } as const;

/** A compact chart of daily bars with the entry and exit channels of the campaign rule (UTC time axis), its prices to the instrument's tick. */
export function useSignalChart(container: RefObject<HTMLDivElement | null>, candles: readonly Candle[] | undefined, entry: number, exit: number, tickSz?: string): void {
  const chartRef = useRef<IChartApi | null>(null);
  const series = useRef<{ bars: ISeriesApi<'Candlestick'>; entry: ISeriesApi<'Line'>; exit: ISeriesApi<'Line'> } | null>(null);

  useEffect(() => {
    const el = container.current;
    if (el === null) return;
    const chart = createChart(el, {
      localization: { locale: 'en-US' },
      layout: { background: { type: ColorType.Solid, color: '#0b0e14' }, textColor: '#8a93a3', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 10 },
      grid: { vertLines: { color: '#131824' }, horzLines: { color: '#131824' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#222a38' },
      timeScale: { borderColor: '#222a38', timeVisible: false },
      handleScroll: false,
      handleScale: false,
      width: el.clientWidth,
      height: el.clientHeight,
    });
    chartRef.current = chart;
    series.current = {
      bars: chart.addSeries(CandlestickSeries, { upColor: '#2ebd85', downColor: '#f6465d', borderVisible: false, wickUpColor: '#2ebd85', wickDownColor: '#f6465d', priceLineVisible: false }),
      entry: chart.addSeries(LineSeries, { color: CHANNEL_COLORS.entry, lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false }),
      exit: chart.addSeries(LineSeries, { color: CHANNEL_COLORS.exit, lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false }),
    };
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box !== undefined && box.width > 0 && box.height > 0) chart.applyOptions({ width: Math.floor(box.width), height: Math.floor(box.height) });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      series.current = null;
    };
  }, [container]);

  useEffect(() => {
    const s = series.current;
    if (s === null || tickSz === undefined) return;
    // Number() only for the chart's own scale, never for arithmetic.
    const priceFormat = { type: 'price' as const, precision: decimalsOfStep(tickSz), minMove: Number(tickSz) };
    for (const line of [s.bars, s.entry, s.exit]) line.applyOptions({ priceFormat });
  }, [tickSz]);

  useEffect(() => {
    const s = series.current;
    if (s === null || candles === undefined) return;
    const sorted = [...candles].sort((a, b) => a.ts - b.ts);
    s.bars.setData(sorted.map(toCandle));
    const lines = channelLines(sorted, entry, exit);
    s.entry.setData(toLine(lines.entry));
    s.exit.setData(toLine(lines.exit));
    chartRef.current?.timeScale().fitContent();
  }, [candles, entry, exit]);
}
