import type { ReactNode } from 'react';
import type { TraderLastDecision, TraderLogRecord, TraderView } from '@pegasus/shared';
import { useTrader, useTraderLog } from '../hooks/useTrader';
import { labelOf, useT } from '../i18n';
import { DASH, fmtContracts, fmtLocalMinute, fmtNum, fmtPct, fmtPx, fmtSigned, fmtUtcMinute, signOf } from '../lib/format';
import { Countdown } from './campaign/CampaignSummary';
import { LoadFailed } from './LoadFailed';

const when = (ts: number): string => `${fmtLocalMinute(ts)} · ${fmtUtcMinute(ts)}`;
const hour = (h: number): string => `${String(h).padStart(2, '0')}:00`;

function Field({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="campaign-field">
      <span className="k">{k}</span>
      <span className="v num">{children}</span>
    </div>
  );
}

/** A signed PnL in the up / down colour. */
function Pnl({ v }: { v: string | null }) {
  return v === null ? <>{DASH}</> : <span className={signOf(v) === 'pos' ? 'pos' : signOf(v) === 'neg' ? 'neg' : ''}>{fmtSigned(v, 2)}</span>;
}

function StatusCard({ view }: { view: TraderView }) {
  const t = useT();
  const g = view.guardrails;
  const day = Date.UTC(new Date(view.serverTime).getUTCFullYear(), new Date(view.serverTime).getUTCMonth(), new Date(view.serverTime).getUTCDate());
  const local = (h: number): string => new Date(day + h * 3_600_000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return (
    <section className="campaign-card trader-status">
      <h4>{t.trader.status}</h4>
      <div className="campaign-status-line">
        <span className={`campaign-badge trader-status-${view.status}`}>{labelOf(t.trader.statusLabel, view.status)}</span>
        {view.reason !== null && <span className="campaign-reason" title={view.reason.code}>{view.reason.message}</span>}
      </div>
      <Field k={t.trader.session}>
        {t.trader.sessionLine(hour(view.session.startHour), hour(view.session.endHour))}
        <span className="sub">{t.trader.sessionLine(local(view.session.startHour), local(view.session.endHour))}</span>
      </Field>
      <Field k={t.trader.nextCall}>
        {view.nextCallAt === null ? (
          <span className="dim">{t.trader.noNextCall}</span>
        ) : (
          <>
            {when(view.nextCallAt)} · <Countdown to={view.nextCallAt} />
          </>
        )}
      </Field>
      <Field k={t.trader.model}>{view.model}</Field>
      <div className="campaign-note trader-guardrails" title={t.trader.guardrails}>
        {t.trader.guardrailsLine({
          risk: fmtPct(g.riskPct, 2),
          trades: g.maxTradesPerDay,
          daily: fmtPct(g.dailyLossPct, 2),
          losses: g.maxConsecutiveLosses,
          minStop: fmtPct(g.minStopPct, 2),
          maxStop: fmtPct(g.maxStopPct, 2),
          leverage: g.maxLeverage,
        })}
      </div>
    </section>
  );
}

function LastCard({ last }: { last: TraderLastDecision | null }) {
  const t = useT();
  const d = last?.decision ?? null;
  return (
    <section className="campaign-card trader-last">
      <h4>{t.trader.lastDecision}</h4>
      {last === null ? (
        <div className="campaign-note dim">{t.trader.noDecision}</div>
      ) : (
        <>
          <div className="campaign-status-line">
            {d !== null && <span className={`campaign-badge trader-action-${d.action}`}>{labelOf(t.trader.action, d.action)}</span>}
            <span className="num dim">{when(last.ts)}</span>
            <span className={`campaign-badge ${last.executed ? 'campaign-status-running' : 'campaign-status-finished'}`}>{last.executed ? t.trader.executed : t.trader.notExecuted}</span>
          </div>
          {d !== null && (
            <>
              <div className="trader-oneliner">{d.oneLiner}</div>
              <ul className="campaign-notes trader-reasons">
                {d.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
              <div className="campaign-note">
                {t.trader.invalidation}: {d.invalidation}
              </div>
              <div className="trader-prices">
                {d.limitPrice !== null && <Field k={t.trader.limit}>{fmtPx(d.limitPrice)}</Field>}
                {d.stopPx !== null && <Field k={t.trader.stop}>{fmtPx(d.stopPx)}</Field>}
                {d.targetPx !== null && <Field k={t.trader.target}>{fmtPx(d.targetPx)}</Field>}
                <Field k={t.trader.confidence}>{fmtPct(d.confidence, 0)}</Field>
              </div>
            </>
          )}
          {!last.executed && last.verdict !== '' && (
            <div className="campaign-note">
              {t.trader.verdict}: {last.verdict}
            </div>
          )}
          {last.triggers.length > 0 && (
            <div className="campaign-note dim">
              {t.trader.triggers}: {last.triggers.join(', ')}
            </div>
          )}
          {last.usage !== null && <div className="campaign-note dim num">{t.trader.callUsage(last.usage.inputTokens, last.usage.outputTokens, last.usage.ms)}</div>}
          {last.error !== null && (
            <div className="notice notice-warn">
              {t.trader.error}: {last.error}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function PositionCard({ position }: { position: NonNullable<TraderView['position']> }) {
  const t = useT();
  return (
    <section className="campaign-card trader-position">
      <h4>{t.trader.position}</h4>
      <Field k={t.trader.sideLabel}>{labelOf(t.trader.side, position.side)}</Field>
      <Field k={t.trader.contracts}>{fmtContracts(position.contracts)}</Field>
      <Field k={t.trader.entry}>{fmtPx(position.entryPx)}</Field>
      <Field k={t.trader.stop}>{fmtPx(position.stopPx)}</Field>
      <Field k={t.trader.target}>{position.targetPx === null ? DASH : fmtPx(position.targetPx)}</Field>
      <Field k={t.trader.unrealized}>
        <Pnl v={position.unrealizedPnl} />
      </Field>
      <Field k={t.trader.openedAt}>{when(position.openedAt)}</Field>
    </section>
  );
}

function TodayCard({ view }: { view: TraderView }) {
  const t = useT();
  const { today, usageToday } = view;
  return (
    <section className="campaign-card trader-today">
      <h4>{t.trader.today}</h4>
      <Field k={t.trader.date}>{today.date}</Field>
      <Field k={t.trader.trades}>{today.trades}</Field>
      <Field k={t.trader.pnl}>
        <Pnl v={today.pnl} />
      </Field>
      <Field k={t.trader.consecutiveLosses}>{today.consecutiveLosses}</Field>
      {today.cooldownUntil !== null && <Field k={t.trader.cooldownUntil}>{when(today.cooldownUntil)}</Field>}
      <Field k={t.trader.equityAtStart}>{today.equityAtStart === null ? DASH : fmtNum(today.equityAtStart, 2)}</Field>
      <Field k={t.trader.calls}>{t.trader.usage(usageToday.calls, usageToday.inputTokens, usageToday.outputTokens, fmtNum(usageToday.estimatedUsd, 4))}</Field>
    </section>
  );
}

function ControlCard({ control }: { control: NonNullable<TraderView['control']> }) {
  const t = useT();
  const p = control.position;
  return (
    <section className="campaign-card trader-control">
      <h4>{t.trader.control}</h4>
      <div className="campaign-note dim">{t.trader.controlNote}</div>
      <Field k={t.trader.trades}>{control.trades}</Field>
      <Field k={t.trader.wins}>{control.wins}</Field>
      <Field k={t.trader.losses}>{control.losses}</Field>
      <Field k={t.trader.pnl}>
        <Pnl v={control.pnlTotal} />
      </Field>
      <Field k={t.trader.controlPosition}>
        {p === null ? (
          <span className="dim">{t.trader.none}</span>
        ) : (
          `${labelOf(t.trader.side, p.side)} ${fmtContracts(p.contracts)} @ ${fmtPx(p.entryPx)} · ${t.trader.stop} ${fmtPx(p.stopPx)}`
        )}
      </Field>
    </section>
  );
}

function RecentTable({ recent }: { recent: TraderView['recent'] }) {
  const t = useT();
  return (
    <section className="campaign-section trader-recent">
      <h4>{t.trader.recent}</h4>
      {recent.length === 0 ? (
        <div className="empty">{t.trader.noRecent}</div>
      ) : (
        <div className="campaign-scroll">
          <table className="table campaign-table">
            <thead>
              <tr>
                <th className="left">{t.trader.time}</th>
                <th className="left">{t.trader.sideLabel}</th>
                <th>{t.trader.entry}</th>
                <th>{t.trader.exit}</th>
                <th>{t.trader.pnl}</th>
                <th className="left">{t.trader.end}</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={`${r.openedAt}-${r.closedAt}`}>
                  <td className="left">{when(r.closedAt)}</td>
                  <td className="left">{labelOf(t.trader.side, r.side)}</td>
                  <td>{fmtPx(r.entryPx)}</td>
                  <td>{r.exitPx === null ? DASH : fmtPx(r.exitPx)}</td>
                  <td>
                    <Pnl v={r.pnl} />
                  </td>
                  <td className="left">{labelOf(t.trader.endLabel, r.end)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function LogRow({ r }: { r: TraderLogRecord }) {
  const t = useT();
  const action = r.decision ? labelOf(t.trader.action, r.decision.action) : '';
  const text = r.verdict ?? r.decision?.oneLiner ?? '';
  return (
    <tr>
      <td className="left">{when(r.ts)}</td>
      <td className="left">{labelOf(t.trader.kind, r.kind)}</td>
      <td className="left">{action}</td>
      <td className="left">{r.error === undefined ? text : <span className="neg">{r.error}</span>}</td>
    </tr>
  );
}

function LogList() {
  const t = useT();
  const q = useTraderLog();
  const records = q.data?.records ?? [];
  return (
    <section className="campaign-section trader-log">
      <h4>{t.trader.log}</h4>
      {records.length === 0 ? (
        <div className="empty">{t.trader.noLog}</div>
      ) : (
        <div className="campaign-scroll">
          <table className="table campaign-table">
            <tbody>
              {records.map((r, i) => (
                <LogRow key={`${r.ts}-${i}`} r={r} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The TRADER tab: the Claude trader's state (GET /api/trader), its recent results and its decision log. */
export function TraderPanel() {
  const t = useT();
  const q = useTrader();
  const view = q.data;
  if (view === undefined) {
    return <div className="empty">{q.isError ? <LoadFailed what={t.trader.what} busy={q.isFetching} onRetry={() => void q.refetch()} /> : t.trader.loading}</div>;
  }
  if (!view.enabled) {
    return (
      <div className="campaign campaign-disabled trader-disabled">
        <div className="campaign-card">
          <h4>{t.trader.disabledTitle}</h4>
          <div className="campaign-note">{t.trader.disabledNote}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="campaign trader">
      <div className="campaign-cards">
        <StatusCard view={view} />
        <LastCard last={view.last} />
        {view.position !== null && <PositionCard position={view.position} />}
        <TodayCard view={view} />
        {view.control !== null && <ControlCard control={view.control} />}
      </div>
      <RecentTable recent={view.recent} />
      <LogList />
    </div>
  );
}
