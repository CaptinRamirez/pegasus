import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toLineData, useLineChart, type LineChartSeries } from './useLineChart';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeLine {
  setData: ReturnType<typeof vi.fn>;
  applyOptions: ReturnType<typeof vi.fn>;
}

const chart = vi.hoisted(() => ({
  lines: [] as FakeLine[],
  removed: [] as FakeLine[],
  fitContent: vi.fn(),
  hover: null as ((param: { time?: unknown }) => void) | null,
  remove: vi.fn(),
}));

vi.mock('lightweight-charts', () => ({
  LineSeries: 'Line',
  LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
  ColorType: { Solid: 'solid' },
  CrosshairMode: { Normal: 0 },
  createChart: () => ({
    addSeries: () => {
      const line = { setData: vi.fn(), applyOptions: vi.fn() };
      chart.lines.push(line);
      return line;
    },
    removeSeries: (line: FakeLine) => chart.removed.push(line),
    timeScale: () => ({ fitContent: chart.fitContent }),
    subscribeCrosshairMove: (fn: (param: { time?: unknown }) => void) => {
      chart.hover = fn;
    },
    unsubscribeCrosshairMove: () => {
      chart.hover = null;
    },
    applyOptions: vi.fn(),
    remove: chart.remove,
  }),
}));

function Harness({ series, onHover }: { series: LineChartSeries[]; onHover?: (ts: number | null) => void }) {
  const container = useRef<HTMLDivElement | null>(null);
  useLineChart(container, series, onHover);
  return <div ref={container} />;
}

const value: LineChartSeries = { id: 'value', color: '#3987e5', dashed: false, points: [{ ts: 86_400_000, value: '56' }, { ts: 129_600_000, value: '58.5' }] };
const replay: LineChartSeries = { id: 'replaySame', color: '#3987e5', dashed: true, points: [{ ts: 86_400_000, value: '56' }] };

describe('toLineData', () => {
  it('sorts by time, keeps the last point of a time and drops values that are not numbers', () => {
    expect(
      toLineData([
        { ts: 2_000, value: '2' },
        { ts: 1_000, value: '1' },
        { ts: 2_000, value: '2.5' },
        { ts: 3_000, value: '' },
        { ts: 4_000, value: 'x' },
      ]),
    ).toEqual([
      { time: 1, value: 1 },
      { time: 2, value: 2.5 },
    ]);
  });
});

describe('useLineChart', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    });
    chart.lines = [];
    chart.removed = [];
    chart.fitContent.mockClear();
    chart.remove.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = (series: LineChartSeries[], onHover?: (ts: number | null) => void): Promise<void> =>
    act(async () => {
      root.render(<Harness series={series} {...(onHover === undefined ? {} : { onHover })} />);
    });

  it('draws a line per series with its colour and dash, in seconds of UTC; fits the view once', async () => {
    await render([value, replay]);
    expect(chart.lines).toHaveLength(2);
    expect(chart.lines[0]?.applyOptions).toHaveBeenLastCalledWith({ color: '#3987e5', lineStyle: 0 });
    expect(chart.lines[1]?.applyOptions).toHaveBeenLastCalledWith({ color: '#3987e5', lineStyle: 2 });
    expect(chart.lines[0]?.setData).toHaveBeenLastCalledWith([
      { time: 86_400, value: 56 },
      { time: 129_600, value: 58.5 },
    ]);
    expect(chart.fitContent).toHaveBeenCalledTimes(1);

    // new data: the same lines get it, the view stays where the user looks
    await render([{ ...value, points: [...value.points, { ts: 172_800_000, value: '61' }] }, replay]);
    expect(chart.lines).toHaveLength(2);
    expect(chart.lines[0]?.setData).toHaveBeenLastCalledWith([
      { time: 86_400, value: 56 },
      { time: 129_600, value: 58.5 },
      { time: 172_800, value: 61 },
    ]);
    expect(chart.fitContent).toHaveBeenCalledTimes(1);
  });

  it('removes a line that is no longer given (the replay became unavailable)', async () => {
    await render([value, replay]);
    const replayLine = chart.lines[1];
    await render([value]);
    expect(chart.removed).toEqual([replayLine]);
    await render([value, replay]);
    expect(chart.lines).toHaveLength(3);
  });

  it('tells the time under the crosshair in epoch ms, and null when it leaves', async () => {
    const onHover = vi.fn();
    await render([value], onHover);
    chart.hover?.({ time: 129_600 });
    expect(onHover).toHaveBeenLastCalledWith(129_600_000);
    chart.hover?.({});
    expect(onHover).toHaveBeenLastCalledWith(null);
  });
});
