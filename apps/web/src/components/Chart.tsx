import { useEffect, useRef } from 'react';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CandleBar, ConnState } from '@pegasus/shared';
import { api } from '../lib/api';
import { fmtCoin, fmtPct, fmtPx, signOf } from '../lib/format';
import { useCandleChart } from '../hooks/useCandleChart';
import { isStreamStale } from '../store/alerts';
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
  // Dimmed like the instrument list: a frozen figure must not read as the current price.
  const tickerStale = useStore((s) => isStreamStale(s, s.selectedInstId, 'ticker')) && ticker !== null;
  const markStale = useStore((s) => isStreamStale(s, s.selectedInstId, 'mark')) && mark !== null;
  const staleTicker = tickerStale ? { className: 'stale', title: 'Price stopped updating' } : {};
  const container = useRef<HTMLDivElement | null>(null);

  const key = `${instId ?? ''}|${bar}`;
  const history = useQuery({
    queryKey: ['candles', instId, bar],
    queryFn: instId === null ? skipToken : () => api.candles({ instId, bar, limit: 300 }),
    staleTime: 15_000,
  });

  // Live candles resume after the last bar the page saw: without a refetch the bars of a gap are missing for good
  // and the bar that was forming when it began keeps its partial values.
  const queryClient = useQueryClient();
  const helloSeq = useStore((s) => s.helloSeq);
  useEffect(() => {
    if (helloSeq < 2) return; // the first hello is covered by the initial fetch
    void queryClient.invalidateQueries({ queryKey: ['candles'] });
  }, [helloSeq, queryClient]);
  const business = useStore((s) => s.connection?.okxBusiness ?? null);
  const lastBusiness = useRef<ConnState | null>(null);
  useEffect(() => {
    const before = lastBusiness.current;
    lastBusiness.current = business;
    // null is "not heard yet" (page start, or the socket to the server was down: the hello above covers that)
    if (business === 'connected' && before !== null && before !== 'connected') void queryClient.invalidateQueries({ queryKey: ['candles'] });
  }, [business, queryClient]);

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
      <span {...staleTicker}>
        Last <b className={signOf(ticker !== null ? ticker.last : null)}>{fmtPx(ticker?.last, inst)}</b>
      </span>
      <span {...(markStale ? { className: 'stale', title: 'Mark price stopped updating' } : {})}>
        Mark <b>{fmtPx(mark?.markPx, inst)}</b>
      </span>
      <span>
        Funding <b className={signOf(funding?.fundingRate)}>{fmtPct(funding?.fundingRate, 4, true)}</b>
      </span>
      <span {...staleTicker}>
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
