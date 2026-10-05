import { useEffect, useRef, type RefObject } from 'react';
import {
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type MouseEventParams,
  type UTCTimestamp,
} from 'lightweight-charts';
import { safeDecimal } from '../lib/format';

/** One line of the chart: its points are decimal strings at epoch-ms times. */
export interface LineChartSeries {
  id: string;
  color: string;
  dashed: boolean;
  points: ReadonlyArray<{ ts: number; value: string }>;
}

const toTime = (ts: number): UTCTimestamp => Math.floor(ts / 1000) as UTCTimestamp;

/**
 * The points as the chart takes them: sorted by time, one per time (the last one given), without values that are
 * not numbers. Decimal.toNumber() is used here only to produce chart coordinates, never for arithmetic.
 */
export function toLineData(points: LineChartSeries['points']): LineData[] {
  const byTime = new Map<number, number>();
  for (const p of points) {
    const d = safeDecimal(p.value);
    if (d !== null) byTime.set(toTime(p.ts), d.toNumber());
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time: time as UTCTimestamp, value }));
}

/**
 * Owns a lightweight-charts instance of line series. The time axis is in UTC: the library shows the timestamps it is
 * given as they are, without the browser's time zone. The view is fitted to the data once, on the first data; later
 * data keeps where the user looks. `onHover` hears the time under the crosshair (epoch ms), null when it leaves.
 */
export function useLineChart(container: RefObject<HTMLDivElement | null>, series: readonly LineChartSeries[], onHover?: (ts: number | null) => void): void {
  const chartRef = useRef<IChartApi | null>(null);
  const lines = useRef(new Map<string, ISeriesApi<'Line'>>());
  const fitted = useRef(false);
  const hover = useRef(onHover);
  hover.current = onHover;

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
      timeScale: { borderColor: '#222a38', timeVisible: true, secondsVisible: false },
      width: el.clientWidth,
      height: el.clientHeight,
    });
    chartRef.current = chart;
    const onMove = (param: MouseEventParams): void => hover.current?.(typeof param.time === 'number' ? param.time * 1000 : null);
    chart.subscribeCrosshairMove(onMove);

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) chart.applyOptions({ width: Math.floor(width), height: Math.floor(height) });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      lines.current = new Map();
      fitted.current = false;
    };
  }, [container]);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null) return;
    const live = lines.current;
    const wanted = new Set(series.map((s) => s.id));
    for (const [id, line] of live) {
      if (wanted.has(id)) continue;
      chart.removeSeries(line);
      live.delete(id);
    }
    let points = 0;
    for (const s of series) {
      let line = live.get(s.id);
      if (line === undefined) {
        line = chart.addSeries(LineSeries, { lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true });
        live.set(s.id, line);
      }
      line.applyOptions({ color: s.color, lineStyle: s.dashed ? LineStyle.Dashed : LineStyle.Solid });
      const data = toLineData(s.points);
      line.setData(data);
      points += data.length;
    }
    if (!fitted.current && points > 0) {
      chart.timeScale().fitContent();
      fitted.current = true;
    }
  }, [series]);
}
