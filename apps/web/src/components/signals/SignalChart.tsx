import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useT } from '../../i18n';
import { api } from '../../lib/api';
import { CHANNEL_COLORS, useSignalChart } from '../../hooks/useSignalChart';

interface Props {
  instId: string;
  /** The tick the prices are shown to */
  tickSz: string | undefined;
  tracked: boolean;
  entryChannel: number;
  exitChannel: number;
}

/** The last daily bars of a coin with the two channels the rule reads (OKX 1Dutc bars, read over REST). */
export function SignalChart({ instId, tickSz, tracked, entryChannel, exitChannel }: Props) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const q = useQuery({
    queryKey: ['signal-candles', instId],
    queryFn: () => api.candles({ instId, bar: '1D', limit: 90 }),
    enabled: tracked,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
  useSignalChart(ref, q.data, entryChannel, exitChannel, tickSz);
  if (!tracked) return <div className="sig-chart-note dim">{t.signals.chartUntracked}</div>;
  return (
    <div className="sig-chart">
      <div className="sig-chart-legend">
        <span>
          <i className="sig-swatch" style={{ borderColor: CHANNEL_COLORS.entry }} />
          {t.signals.chartLine.entry(entryChannel)}
        </span>
        <span>
          <i className="sig-swatch" style={{ borderColor: CHANNEL_COLORS.exit }} />
          {t.signals.chartLine.exit(exitChannel)}
        </span>
        {q.isError && <span className="neg">{t.signals.chartFailed}</span>}
      </div>
      <div className="sig-chart-wrap">
        <div ref={ref} />
      </div>
    </div>
  );
}
