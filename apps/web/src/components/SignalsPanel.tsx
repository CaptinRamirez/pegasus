import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_TREND_PARAMS, toPlainString, type InstrumentSignalReport, type Side, type TrendParams } from '@pegasus/shared';
import { api, isSignalReportError, type SignalsQuery } from '../lib/api';
import { errorMessage } from '../lib/http';
import { fmtNum, fmtTime, safeDecimal } from '../lib/format';
import { useStore } from '../store/store';
import { SignalRow } from './signals/SignalRow';

const REFETCH_MS = 5 * 60_000;
const STALE_MS = 60_000;

/** Live equity as the API accepts it (plain positive decimal), or undefined to let the server pick. */
function equityParam(totalEq: string | null): string | undefined {
  const d = safeDecimal(totalEq);
  return d !== null && d.gt(0) ? d.toFixed() : undefined;
}

export function SignalsPanel() {
  const totalEq = useStore((s) => s.balance?.totalEq ?? null);
  const instruments = useStore((s) => s.instruments);
  const applyTicketPrefill = useStore((s) => s.applyTicketPrefill);
  const pushToast = useStore((s) => s.pushToast);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const equity = equityParam(totalEq);
  const q = useQuery({
    queryKey: ['signals'],
    queryFn: () => {
      const query: SignalsQuery = {};
      if (equity !== undefined) query.equity = equity;
      return api.signals(query);
    },
    refetchInterval: REFETCH_MS,
    staleTime: STALE_MS,
  });

  const params: TrendParams = useMemo(() => {
    const first = q.data?.reports.find((r) => !isSignalReportError(r));
    return first !== undefined && !isSignalReportError(first) ? first.params : DEFAULT_TREND_PARAMS;
  }, [q.data]);

  const toggle = (instId: string) => setExpanded((e) => ({ ...e, [instId]: !(e[instId] ?? false) }));

  const apply = (r: InstrumentSignalReport, side: Side) => {
    if (r.sizing === null) return;
    const inst = instruments.find((i) => i.instId === r.instId);
    const px = inst === undefined ? r.indicators.close : toPlainString(r.indicators.close, inst.tickSz);
    applyTicketPrefill({ instId: r.instId, side, ordType: 'limit', px, sizeValue: r.sizing.contracts, sizeUnit: 'contracts' });
    pushToast('info', `Ticket filled: ${side} ${r.sizing.contracts} contracts ${r.instId} @ ${px}`);
  };

  const toolbar = (
    <div className="signals-toolbar">
      <button className="btn btn-sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
        {q.isFetching ? 'Refreshing…' : 'Refresh'}
      </button>
      {q.data !== undefined && (
        <>
          <span>
            as of <span className="num">{fmtTime(q.data.generatedAt)}</span>
          </span>
          <span>
            equity <span className="num">{q.data.equity === null ? 'n/a' : fmtNum(q.data.equity, 2)}</span>
          </span>
        </>
      )}
      <span className="dim">
        daily close · {params.entryChannel}d breakout · MA{params.trendMaPeriod} · {params.atrStopMultiple}×ATR({params.atrPeriod}) stop · auto-refresh 5m
      </span>
      {q.isError && <span className="neg">{errorMessage(q.error)}</span>}
    </div>
  );

  if (q.data === undefined) {
    return (
      <div className="signals">
        {toolbar}
        <div className="empty">{q.isError ? 'Signals unavailable' : 'Loading signals…'}</div>
      </div>
    );
  }
  if (q.data.reports.length === 0) {
    return (
      <div className="signals">
        {toolbar}
        <div className="empty">No instruments to report on</div>
      </div>
    );
  }

  return (
    <div className="signals">
      {toolbar}
      <table className="table signals-table">
        <thead>
          <tr>
            <th>Instrument</th>
            <th className="left">Regime</th>
            <th>Close</th>
            <th>
              MA{params.trendMaPeriod}
              <span className="sub">dist (ATR)</span>
            </th>
            <th>
              ATR({params.atrPeriod})
              <span className="sub">ATR %</span>
            </th>
            <th>
              {params.entryChannel}d high
              <span className="sub">{params.entryChannel}d low</span>
            </th>
            <th>
              {params.exitChannel}d high
              <span className="sub">{params.exitChannel}d low</span>
            </th>
            <th title={`Efficiency ratio over ${params.efficiencyPeriod} days: |net move| / path length`}>ER</th>
            <th title={`${params.volShortPeriod}d / ${params.volLongPeriod}d realised vol`}>Vol ratio</th>
            <th>
              Funding 3d
              <span className="sub">annualised</span>
            </th>
            <th title="Depth imbalance (bid − ask) / (bid + ask) over the visible book; execution context only, not a direction signal">
              Book
              <span className="sub">spread · depth</span>
            </th>
            <th title="Open interest: current level, 10-day change (1-day change)">
              OI
              <span className="sub">10d chg (1d)</span>
            </th>
            <th className="left">Signals</th>
            <th>
              Stop long
              <span className="sub">stop short</span>
            </th>
            <th>Stop %</th>
            <th>Contracts</th>
            <th>Coin</th>
            <th>Notional</th>
            <th>Risk</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {q.data.reports.map((row) => (
            <SignalRow
              key={row.instId}
              row={row}
              inst={instruments.find((i) => i.instId === row.instId)}
              expanded={expanded[row.instId] ?? false}
              onToggle={() => toggle(row.instId)}
              onApply={apply}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
