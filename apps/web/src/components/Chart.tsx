import { useRef } from 'react';
import { skipToken, useQuery } from '@tanstack/react-query';
import type { CandleBar } from '@pegasus/shared';
import { api } from '../lib/api';
import { fmtCoin, fmtPct, fmtPx, signOf } from '../lib/format';
import { useCandleChart } from '../hooks/useCandleChart';
import { changeBar } from '../store/session';
import { getSelectedInstrument, getSelectedMarket, useStore } from '../store/store';
import { Panel } from './Panel';

const BARS: readonly CandleBar[] = ['1m', '5m', '15m', '1H', '4H', '1D'];

export function Chart() {
  const inst = useStore(getSelectedInstrument);
  const bar = useStore((s) => s.bar);
  const instId = inst?.instId ?? null;
  const live = useStore((s) => (instId === null ? undefined : s.market[instId]?.candles));
  const ticker = useStore((s) => getSelectedMarket(s).ticker);
  const mark = useStore((s) => getSelectedMarket(s).markPrice);
  const funding = useStore((s) => getSelectedMarket(s).fundingRate);
  const container = useRef<HTMLDivElement | null>(null);

  const key = `${instId ?? ''}|${bar}`;
  const history = useQuery({
    queryKey: ['candles', instId, bar],
    queryFn: instId === null ? skipToken : () => api.candles({ instId, bar, limit: 300 }),
    staleTime: 15_000,
  });

  useCandleChart(container, inst, history.data, live, key);

  const title = (
    <span className="row">
      <span>{inst?.instId ?? 'Chart'}</span>
      <span className="btn-group">
        {BARS.map((b) => (
          <button key={b} className={`btn btn-sm${b === bar ? ' active' : ''}`} onClick={() => changeBar(b)}>
            {b}
          </button>
        ))}
      </span>
    </span>
  );

  const extra = (
    <span className="chart-info num">
      <span>
        Last <b className={signOf(ticker !== null ? ticker.last : null)}>{fmtPx(ticker?.last, inst)}</b>
      </span>
      <span>
        Mark <b>{fmtPx(mark?.markPx, inst)}</b>
      </span>
      <span>
        Funding <b className={signOf(funding?.fundingRate)}>{fmtPct(funding?.fundingRate, 4, true)}</b>
      </span>
      <span>
        24h vol <b>{fmtCoin(ticker?.vol24h, inst, ticker?.last)}</b>
      </span>
      {history.isError && <span className="neg">history failed</span>}
      {history.isFetching && <span className="dim">loading…</span>}
    </span>
  );

  return (
    <Panel title={title} extra={extra} className="panel-chart">
      <div className="chart-wrap">
        <div ref={container} />
      </div>
    </Panel>
  );
}
