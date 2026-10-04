import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ceilToStep, D, DEFAULT_TREND_PARAMS, floorToStep, isSignalReportError, phaseDayStart, toPlainString, type InstrumentSignalReport, type Side, type SignalPhase, type SignalReportRow, type TrendParams } from '@pegasus/shared';
import { errorText, useLang, useT } from '../i18n';
import { api, type SignalsQuery } from '../lib/api';
import { fmtDateTime, fmtNum, fmtPct, fmtUtcMinute, safeDecimal } from '../lib/format';
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
  const t = useT();
  const lang = useLang();
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
    // The reasons and sizing notes of a report are written by the server, in the language asked for.
    queryKey: ['signals', riskPct, lang],
    queryFn: () => {
      const query: SignalsQuery = { riskPct };
      if (equity !== undefined) query.equity = equity;
      if (lang !== 'en') query.lang = lang;
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
    // the trader must not assume the plan's stop came along when it did not
    pushToast('info', t.signals.ticketFilled(side, plan.contracts, r.instId, px, phases.length > 1 ? cutLabel(r.phase) : null, !withStop));
  };

  const toolbar = (
    <div className="signals-toolbar">
      <button className="btn btn-sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
        {q.isFetching ? t.signals.refreshing : t.common.refresh}
      </button>
      <label title={t.signals.riskTitle(phases.length)}>
        {t.signals.risk}{' '}
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
              title={t.signals.barClosedTitle}
            >
              {t.signals.barClosed(fmtUtcMinute(barClosed.newest), Date.now() - barClosed.newest)}
            </span>
          )}
          <span>
            {t.signals.updated} <span className="num">{fmtDateTime(q.data.generatedAt)}</span>
          </span>
          <span>
            {t.signals.equity} <span className="num">{q.data.equity === null ? t.common.na : fmtNum(q.data.equity, 2)}</span>
          </span>
          {phases.length > 1 ? (
            // sizingParams are those of one cut's lot; the unit the owner chose is the lots together
            <span title={t.signals.lotTitle(fmtPct(q.data.sizingParams.riskPct, 3), fmtPct(q.data.sizingParams.maxNotionalPct, 1))}>
              {t.signals.perUnit(fmtPct(D(q.data.sizingParams.riskPct).mul(phases.length).toFixed(), 2), fmtPct(D(q.data.sizingParams.maxNotionalPct).mul(phases.length).toFixed(), 0), phases.length)}
            </span>
          ) : (
            <span>{t.signals.perTrade(fmtPct(q.data.sizingParams.riskPct, 2), fmtPct(q.data.sizingParams.maxNotionalPct, 0))}</span>
          )}
        </>
      )}
      <span className="dim">{t.signals.summary(phases.map(cutLabel), phases[0] === undefined || phases[0] === 0, params, shortsOff)}</span>
      {q.isError && <span className="neg">{errorText(q.error, t)}</span>}
    </div>
  );

  if (q.data === undefined) {
    return (
      <div className="signals">
        {toolbar}
        <div className="empty">{q.isError ? t.signals.unavailable : t.signals.loading}</div>
      </div>
    );
  }
  if (q.data.reports.length === 0) {
    return (
      <div className="signals">
        {toolbar}
        <div className="empty">{t.signals.noInstruments}</div>
      </div>
    );
  }

  return (
    <div className={`signals${outdated ? ' signals-stale' : ''}`}>
      {toolbar}
      {outdated && <div className="notice notice-warn signals-outdated">{t.signals.outdated(fmtDateTime(q.dataUpdatedAt))}</div>}
      <table className="table signals-table">
        <thead>
          <tr>
            <th>{t.common.instrument}</th>
            <th className="left">{t.signals.regime}</th>
            <th>{t.signals.close}</th>
            <th>
              MA{params.trendMaPeriod}
              <span className="sub">{t.signals.distAtr}</span>
            </th>
            <th>
              ATR({params.atrPeriod})
              <span className="sub">{t.signals.atrPct}</span>
            </th>
            <th>
              {t.signals.dHigh(params.entryChannel)}
              <span className="sub">{t.signals.dLow(params.entryChannel)}</span>
            </th>
            <th title={t.signals.exitTitle}>
              {t.signals.dHigh(params.exitChannel)}
              <span className="sub">{t.signals.dLow(params.exitChannel)}</span>
            </th>
            <th title={t.signals.erTitle(params.efficiencyPeriod)}>ER</th>
            <th title={t.signals.volRatioTitle(params.volShortPeriod, params.volLongPeriod)}>{t.signals.volRatio}</th>
            <th>
              {t.signals.funding3d}
              <span className="sub">{t.signals.annualised}</span>
            </th>
            <th title={t.signals.bookTitle}>
              {t.signals.book}
              <span className="sub">{t.signals.spreadDepth}</span>
            </th>
            <th title={t.signals.oiTitle}>
              {t.signals.oi}
              <span className="sub">{t.signals.oiSub}</span>
            </th>
            <th className="left">{t.signals.signals}</th>
            <th>
              {t.signals.stopLong}
              <span className="sub">{t.signals.stopShort}</span>
            </th>
            <th>{t.signals.stopPct}</th>
            <th title={t.signals.contractsTitle(shortsOff)}>
              {t.signals.contractsLong}
              <span className="sub">{t.signals.short}</span>
            </th>
            <th>
              {t.signals.coinLong}
              <span className="sub">{t.signals.short}</span>
            </th>
            <th title={t.signals.notionalTitle}>
              {t.signals.notionalLong}
              <span className="sub">{t.signals.short}</span>
            </th>
            <th>
              {t.signals.riskLong}
              <span className="sub">{t.signals.short}</span>
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
