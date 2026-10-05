import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { CampaignReplayView, CampaignView } from '@pegasus/shared';
import { useLineChart, type LineChartSeries } from '../../hooks/useLineChart';
import { labelOf, useT, type Messages } from '../../i18n';
import { campaignChartLines, fmtUsdt, valueAt, type ChartLine, type ChartLineId } from '../../lib/campaign';
import { DASH, fmtUtcMinute } from '../../lib/format';

/**
 * A colour per entity, never per rank: the pot's own structure is blue (its value solid, its replay dashed), the
 * other structure orange (dashed), the start value held in BTC aqua, the banked total yellow. These are the dark
 * slots 1-4 of the dataviz reference palette, checked with its validator on the panel's surface #10141c: every check
 * passes, and the closest pair (yellow and aqua) carries the second encoding it needs in the legend's labels.
 */
export const LINE_STYLE: Record<ChartLineId, { color: string; dashed: boolean }> = {
  value: { color: '#3987e5', dashed: false },
  replaySame: { color: '#3987e5', dashed: true },
  replayOther: { color: '#d95926', dashed: true },
  heldBtc: { color: '#199e70', dashed: false },
  banked: { color: '#c98500', dashed: false },
};

/** A line's name in the legend; a replay line is named by the structure it ran. */
export function lineLabel(line: ChartLine, t: Messages): string {
  switch (line.id) {
    case 'value':
      return t.campaign.line.value;
    case 'banked':
      return t.campaign.line.banked;
    case 'heldBtc':
      return t.campaign.line.heldBtc;
    case 'replaySame':
    case 'replayOther':
      return t.campaign.replayLine(line.structure === null ? '' : labelOf(t.campaign.structureLabel, line.structure), line.id === 'replaySame');
  }
}

interface Props {
  view: CampaignView;
  /** The replay's result, also the earlier one a failed attempt keeps; null without one */
  replay: CampaignReplayView | null;
  /** What the page knows of the replay, under the chart */
  notice: ReactNode;
}

/**
 * The pot's value and its banked total at every 12-hour close processed, and beside them, when the replay has a
 * result, the start value held in BTC and the replay of both structures. Times in UTC. The legend gives the values
 * at the close under the crosshair, the latest ones otherwise.
 */
export function CampaignChart({ view, replay, notice }: Props) {
  const t = useT();
  const samples = view.samples;
  const lines = useMemo(() => campaignChartLines({ samples }, replay), [samples, replay]);
  const series = useMemo<LineChartSeries[]>(() => lines.map((l) => ({ id: l.id, points: l.points, ...LINE_STYLE[l.id] })), [lines]);
  const [hoverTs, setHoverTs] = useState<number | null>(null);
  const container = useRef<HTMLDivElement | null>(null);
  useLineChart(container, series, setHoverTs);

  return (
    <section className="campaign-section campaign-chart">
      <h4>{t.campaign.chart}</h4>
      <div className="campaign-legend">
        <span className="campaign-legend-time num dim">{hoverTs === null ? t.campaign.latest : fmtUtcMinute(hoverTs)}</span>
        {lines.map((l) => {
          const style = LINE_STYLE[l.id];
          const v = valueAt(l.points, hoverTs);
          return (
            <span key={l.id} className={`campaign-legend-item legend-${l.id}`}>
              <span className={`campaign-swatch${style.dashed ? ' dashed' : ''}`} style={{ borderTopColor: style.color }} />
              <span className="campaign-legend-label">{lineLabel(l, t)}</span> <b className="num">{v === null ? DASH : fmtUsdt(v)}</b>
            </span>
          );
        })}
      </div>
      {samples.length === 0 && <div className="campaign-note dim">{t.campaign.chartEmpty}</div>}
      <div className="campaign-chart-wrap">
        <div ref={container} />
      </div>
      {notice}
    </section>
  );
}
