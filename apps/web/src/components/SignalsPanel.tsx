import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_TREND_PARAMS, isSignalReportError, toPlainString, type InstrumentSignalReport, type Side, type TrendParams } from '@pegasus/shared';
import { api, type SignalsQuery } from '../lib/api';
import { errorMessage } from '../lib/http';
import { fmtAgeCoarse, fmtDateTime, fmtNum, fmtPct, fmtUtcMinute, safeDecimal } from '../lib/format';
import { useStore } from '../store/store';
import { SignalRow } from './signals/SignalRow';
import { RISK_CHOICES, readStoredRiskPct, writeStoredRiskPct, type RiskChoice } from './signals/riskPref';

const REFETCH_MS = 5 * 60_000;
const STALE_MS = 60_000;
/** A report older than this missed two refreshes in a row: it is no longer shown as current. */
const OUTDATED_MS = 2 * REFETCH_MS;
const CLOCK_MS = 30_000;
const DAY_MS = 86_400_000;
/** A daily bar that closed longer ago than this is not the latest one: a newer bar should exist by now. */
const BAR_STALE_MS = DAY_MS + 10 * 60_000;

/** Live equity as the API accepts it (plain positive decimal), or undefined to let the server pick. */
function equityParam(totalEq: string | null): string | undefined {
  const d = safeDecimal(totalEq);
  return d !== null && d.gt(0) ? d.toFixed() : undefined;
}

export function SignalsPanel() {
  const totalEq = useStore((s) => s.balance?.totalEq ?? null);
  const instruments = useStore((s) => s.instruments);
  const positions = useStore((s) => s.positions);
  const openOrders = useStore((s) => s.orders);
  const applyTicketPrefill = useStore((s) => s.applyTicketPrefill);
  const pushToast = useStore((s) => s.pushToast);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [riskPct, setRiskPct] = useState<RiskChoice>(readStoredRiskPct);

  const equity = equityParam(totalEq);
  const q = useQuery({
    queryKey: ['signals', riskPct],
    queryFn: () => {
      const query: SignalsQuery = { riskPct };
      if (equity !== undefined) query.equity = equity;
      return api.signals(query);
    },
    refetchInterval: REFETCH_MS,
    staleTime: STALE_MS,
    // The page stays open for hours in a background tab; coming back to it must show the current bar.
    refetchOnWindowFocus: 'always',
  });

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  // A failed refresh keeps the previous table on screen; it must not look live or be acted on.
  const outdated = q.data !== undefined && (q.isError || now - q.dataUpdatedAt > OUTDATED_MS);

  const chooseRisk = (value: string) => {
    const choice = RISK_CHOICES.find((c) => c === value);
    if (choice === undefined) return;
    writeStoredRiskPct(choice);
    setRiskPct(choice);
  };

  /** Close time of the oldest daily bar among the reports (open time plus one day), or null without reports. */
  const barClosedAt = useMemo(() => {
    let oldest: number | null = null;
    for (const r of q.data?.reports ?? []) {
      if (!isSignalReportError(r) && (oldest === null || r.indicators.asOf < oldest)) oldest = r.indicators.asOf;
    }
    return oldest === null ? null : oldest + DAY_MS;
  }, [q.data]);

  const params: TrendParams = useMemo(() => {
    const first = q.data?.reports.find((r) => !isSignalReportError(r));
    return first !== undefined && !isSignalReportError(first) ? first.params : DEFAULT_TREND_PARAMS;
  }, [q.data]);

  const orders = useMemo(() => Object.values(openOrders), [openOrders]);

  const toggle = (instId: string) => setExpanded((e) => ({ ...e, [instId]: !(e[instId] ?? false) }));

  const apply = (r: InstrumentSignalReport, side: Side) => {
    if (r.sizing === null) return;
    // each side has its own plan: shorts, crisis entries and crowded entries are sized down
    const plan = side === 'buy' ? r.sizing.long : r.sizing.short;
    const inst = instruments.find((i) => i.instId === r.instId);
    const px = inst === undefined ? r.indicators.close : toPlainString(r.indicators.close, inst.tickSz);
    applyTicketPrefill({ instId: r.instId, side, ordType: 'limit', px, sizeValue: plan.contracts, sizeUnit: 'contracts' });
    pushToast('info', `Ticket filled: ${side} ${plan.contracts} contracts ${r.instId} @ ${px}`);
  };

  const toolbar = (
    <div className="signals-toolbar">
      <button className="btn btn-sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
        {q.isFetching ? 'Refreshing…' : 'Refresh'}
      </button>
      <label title="Risk per trade as a fraction of equity. The framework uses 0.5% for the first three months and 0.75% afterwards.">
        risk{' '}
        <select value={riskPct} onChange={(e) => chooseRisk(e.target.value)}>
          {RISK_CHOICES.map((c) => (
            <option key={c} value={c}>
              {fmtPct(c, 2)}
            </option>
          ))}
        </select>
      </label>
      {q.data !== undefined && (
        <>
          {barClosedAt !== null && (
            <span
              className={`signals-bar num${Date.now() - barClosedAt > BAR_STALE_MS ? ' warn' : ''}`}
              title="The daily candle (UTC day) the signals are computed from. Shown in the warning colour when a newer bar should already exist."
            >
              bar closed {fmtUtcMinute(barClosedAt)}, {fmtAgeCoarse(Date.now() - barClosedAt)} ago
            </span>
          )}
          <span>
            updated <span className="num">{fmtDateTime(q.data.generatedAt)}</span>
          </span>
          <span>
            equity <span className="num">{q.data.equity === null ? 'n/a' : fmtNum(q.data.equity, 2)}</span>
          </span>
          <span>
            risk {fmtPct(q.data.sizingParams.riskPct, 2)} of equity per trade · notional cap {fmtPct(q.data.sizingParams.maxNotionalPct, 0)}
          </span>
        </>
      )}
      <span className="dim">
        UTC daily close · {params.entryChannel}d breakout · MA{params.trendMaPeriod} · {params.atrStopMultiple}×ATR({params.atrPeriod}) stop · auto-refresh 5m
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
    <div className={`signals${outdated ? ' signals-stale' : ''}`}>
      {toolbar}
      {outdated && (
        <div className="notice notice-warn signals-outdated">
          Signals not updated since {fmtDateTime(q.dataUpdatedAt)}. The table below may be out of date; Apply is disabled.
          <br />
          信号自该时间起未更新，下方数据可能已过期
        </div>
      )}
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
            <th title="The exit channel the last close was tested against. The level for the next session is in the expanded row.">
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
            <th title="Open interest of the instrument: current level; change over the last 10 completed UTC days (over the last completed day), measured in coin">
              OI
              <span className="sub">10d chg (1d)</span>
            </th>
            <th className="left">Signals</th>
            <th>
              Stop long
              <span className="sub">stop short</span>
            </th>
            <th>Stop %</th>
            <th title="Size of a new long; the sub line is the size of a new short (shorts are sized at half)">
              Contracts long
              <span className="sub">short</span>
            </th>
            <th>
              Coin long
              <span className="sub">short</span>
            </th>
            <th title="Notional of the contracts shown, after rounding down to whole lots">
              Notional long
              <span className="sub">short</span>
            </th>
            <th>
              Risk long
              <span className="sub">short</span>
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          {q.data.reports.map((row) => (
            <SignalRow
              key={row.instId}
              row={row}
              inst={instruments.find((i) => i.instId === row.instId)}
              positions={positions}
              orders={orders}
              outdated={outdated}
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
