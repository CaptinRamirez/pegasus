import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ceilToStep, D, DEFAULT_TREND_PARAMS, floorToStep, isSignalReportError, phaseDayStart, toPlainString, type InstrumentSignalReport, type Side, type SignalPhase, type SignalReportRow, type TrendParams } from '@pegasus/shared';
import { api, type SignalsQuery } from '../lib/api';
import { errorMessage } from '../lib/http';
import { fmtAgeCoarse, fmtDateTime, fmtNum, fmtPct, fmtUtcMinute, safeDecimal } from '../lib/format';
import { useStore } from '../store/store';
import { SignalRow, cutLabel } from './signals/SignalRow';
import { RISK_CHOICES, readStoredRiskPct, writeStoredRiskPct, type RiskChoice } from './signals/riskPref';

const REFETCH_MS = 5 * 60_000;
const STALE_MS = 60_000;
/** A report older than this missed two refreshes in a row: it is no longer shown as current. */
const OUTDATED_MS = 2 * REFETCH_MS;
const CLOCK_MS = 30_000;
const DAY_MS = 86_400_000;
/** A daily bar that closed longer ago than this is not the latest one: a newer bar should exist by now. */
const BAR_STALE_MS = DAY_MS + 10 * 60_000;

/** One table row per instrument and cut. */
const rowKey = (row: SignalReportRow): string => `${row.instId}:${row.phase}`;

const NO_PHASES: SignalPhase[] = [];

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

  /**
   * Close times of the daily bars behind the reports (open time plus one day): the newest one is the bar shown,
   * the oldest one decides whether some row is overdue. null without reports.
   */
  const barClosed = useMemo(() => {
    let oldest: number | null = null;
    let newest: number | null = null;
    for (const r of q.data?.reports ?? []) {
      if (isSignalReportError(r)) continue;
      if (oldest === null || r.indicators.asOf < oldest) oldest = r.indicators.asOf;
      if (newest === null || r.indicators.asOf > newest) newest = r.indicators.asOf;
    }
    return oldest === null || newest === null ? null : { oldest: oldest + DAY_MS, newest: newest + DAY_MS };
  }, [q.data]);

  /** The daily cuts the server computes. */
  const phases = q.data?.phases ?? NO_PHASES;

  /** The cut whose daily bar closed most recently before the report was generated; null when there is only one cut. */
  const latestPhase = useMemo(() => {
    if (q.data === undefined || q.data.phases.length < 2) return null;
    const generatedAt = q.data.generatedAt;
    return q.data.phases.reduce((a, b) => (phaseDayStart(generatedAt, b) > phaseDayStart(generatedAt, a) ? b : a));
  }, [q.data]);

  const params: TrendParams = useMemo(() => {
    const first = q.data?.reports.find((r) => !isSignalReportError(r));
    return first !== undefined && !isSignalReportError(first) ? first.params : DEFAULT_TREND_PARAMS;
  }, [q.data]);

  const shortsOff = params.allowShort === false;

  const orders = useMemo(() => Object.values(openOrders), [openOrders]);

  const toggle = (key: string) => setExpanded((e) => ({ ...e, [key]: !(e[key] ?? false) }));

  const apply = (r: InstrumentSignalReport, side: Side) => {
    if (r.sizing === null) return;
    // the row's own plan: one cut's lot, and each side has its own (shorts, crisis entries and crowded entries are sized down)
    const plan = side === 'buy' ? r.sizing.long : r.sizing.short;
    const inst = instruments.find((i) => i.instId === r.instId);
    const px = inst === undefined ? r.indicators.close : toPlainString(r.indicators.close, inst.tickSz);
    // the plan's stop for that side, on the tick towards the entry as the server would round it
    const rawStop = side === 'buy' ? plan.stopLong : plan.stopShort;
    const slTriggerPx = inst === undefined ? rawStop : toPlainString(side === 'buy' ? ceilToStep(rawStop, inst.tickSz) : floorToStep(rawStop, inst.tickSz), inst.tickSz);
    // a stop distance wider than the price leaves no stop to place
    const withStop = D(slTriggerPx).gt(0);
    applyTicketPrefill({ instId: r.instId, side, ordType: 'limit', px, sizeValue: plan.contracts, sizeUnit: 'contracts', ...(withStop ? { slTriggerPx } : {}) });
    const cut = phases.length > 1 ? ` (${cutLabel(r.phase)} cut)` : '';
    // the trader must not assume the plan's stop came along when it did not
    const stop = withStop ? '' : '. NO stop was carried into the ticket (the plan has no positive stop price): set the stop yourself';
    pushToast('info', `Ticket filled: ${side} ${plan.contracts} contracts ${r.instId} @ ${px}${cut}${stop}`);
  };

  const toolbar = (
    <div className="signals-toolbar">
      <button className="btn btn-sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
        {q.isFetching ? 'Refreshing…' : 'Refresh'}
      </button>
      <label
        title={`Risk per trade as a fraction of equity. The framework uses 0.5% for the first three months and 0.75% afterwards.${
          phases.length > 1 ? ` It is the risk of one unit, shared equally between the ${phases.length} daily cuts.` : ''
        }`}
      >
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
          {barClosed !== null && (
            <span
              className={`signals-bar num${Date.now() - barClosed.oldest > BAR_STALE_MS ? ' warn' : ''}`}
              title="The most recent daily candle the signals are computed from; every cut has its own (see the rows). Shown in the warning colour when a newer bar should already exist for one of the rows."
            >
              bar closed {fmtUtcMinute(barClosed.newest)}, {fmtAgeCoarse(Date.now() - barClosed.newest)} ago
            </span>
          )}
          <span>
            updated <span className="num">{fmtDateTime(q.data.generatedAt)}</span>
          </span>
          <span>
            equity <span className="num">{q.data.equity === null ? 'n/a' : fmtNum(q.data.equity, 2)}</span>
          </span>
          {phases.length > 1 ? (
            // sizingParams are those of one cut's lot; the unit the owner chose is the lots together
            <span title={`One cut's lot: risk ${fmtPct(q.data.sizingParams.riskPct, 3)} of equity, notional cap ${fmtPct(q.data.sizingParams.maxNotionalPct, 1)}. The lots of an instrument together are one unit.`}>
              risk {fmtPct(D(q.data.sizingParams.riskPct).mul(phases.length).toFixed(), 2)} of equity per unit · notional cap{' '}
              {fmtPct(D(q.data.sizingParams.maxNotionalPct).mul(phases.length).toFixed(), 0)} · each cut sized at 1/{phases.length} of a unit
            </span>
          ) : (
            <span>
              risk {fmtPct(q.data.sizingParams.riskPct, 2)} of equity per trade · notional cap {fmtPct(q.data.sizingParams.maxNotionalPct, 0)}
            </span>
          )}
        </>
      )}
      <span className="dim">
        {phases.length > 1 ? `daily closes at ${phases.map(cutLabel).join(' and ')}` : phases[0] === undefined || phases[0] === 0 ? 'UTC daily close' : `daily close at ${cutLabel(phases[0])}`} · {params.entryChannel}d breakout · MA{params.trendMaPeriod} · {params.atrStopMultiple}×ATR({params.atrPeriod}) stop{shortsOff ? ' · shorts off' : ''} · auto-refresh 5m
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
            <th title={shortsOff ? 'Size of a new long. Short entries are switched off (allowShort = false).' : 'Size of a new long; the sub line is the size of a new short (shorts are sized at half)'}>
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
              key={rowKey(row)}
              row={row}
              latest={latestPhase !== null && row.phase === latestPhase}
              cuts={phases.length}
              inst={instruments.find((i) => i.instId === row.instId)}
              positions={positions}
              orders={orders}
              outdated={outdated}
              expanded={expanded[rowKey(row)] ?? false}
              onToggle={() => toggle(rowKey(row))}
              onApply={apply}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
