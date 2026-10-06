import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Instrument, JournalTradeSummary } from '@pegasus/shared';
import { explainError, labelOf, useT } from '../../i18n';
import { api } from '../../lib/api';
import { exitPlanText, eventSentence, feePaid, fmtR, takeProfitText, trailingText, utcLocal } from '../../lib/describe';
import { DASH, fmtContracts, fmtLocalMinute, fmtNum, fmtPx, fmtSigned, fmtUtcMinute, fmtUtcSecond, signOf } from '../../lib/format';
import { coinOf, signalCloseTs } from '../../lib/signals';
import { Drawer } from '../Overlay';
import { SourceBadge, StatusBadge } from './badges';

function Fig({ k, children, cls }: { k: string; children: ReactNode; cls?: string }) {
  return (
    <div className="jr-fig">
      <span className="k">{k}</span>
      <span className={`v num${cls === undefined ? '' : ` ${cls}`}`}>{children}</span>
    </div>
  );
}

interface Props {
  summary: JournalTradeSummary;
  inst: Instrument | undefined;
  onClose: () => void;
}

/**
 * One trade of the journal: its figures, the plan Pegasus placed it with and the signal it followed, every fill, every
 * exit and the timeline in words, with UTC and local times. Read again whenever the trade changes (its updatedAt).
 */
export function TradeDrawer({ summary, inst, onClose }: Props) {
  const t = useT();
  const q = useQuery({
    queryKey: ['journal', 'trade', summary.id, summary.updatedAt],
    queryFn: () => api.journalTrade(summary.id),
    staleTime: Infinity,
  });
  const trade = q.data ?? null;
  const s = trade ?? summary;
  const ccy = s.ccy;
  const base = inst?.baseCcy ?? coinOf(s.instId);
  const money = (v: string | null) => (v === null ? DASH : `${fmtSigned(v, 2)} ${ccy}`);
  const plan = s.plan;
  const lastLeg = s.exits[s.exits.length - 1]?.leg ?? null;
  const closedBy = s.closeReason === null ? DASH : s.closeReason === 'take_profit' && lastLeg !== null ? t.journal.exitReasonLeg(lastLeg) : labelOf(t.journal.exitReason, s.closeReason);

  return (
    <Drawer
      title={
        <span className="jr-title">
          <span className="num">{s.instId}</span>
          <span className={s.direction === 'long' ? 'pos' : 'neg'}>{t.enums.posSide[s.direction]}</span>
          <SourceBadge source={s.source} />
          <StatusBadge status={s.status} />
        </span>
      }
      onClose={onClose}
      className="jr-drawer"
    >
      <section className="jr-section">
        <h5>{t.journal.figures}</h5>
        <div className="jr-figs">
          <Fig k={t.journal.opened}>{utcLocal(s.openedAt, t)}</Fig>
          <Fig k={t.journal.closed}>{s.closedAt === null ? DASH : utcLocal(s.closedAt, t)}</Fig>
          <Fig k={t.journal.held}>{s.durationMs === null ? t.journal.openFor(t.common.duration(Date.now() - s.openedAt)) : t.common.duration(s.durationMs)}</Fig>
          <Fig k={t.journal.col.entry}>{fmtPx(s.entry.avgPx, inst)}</Fig>
          <Fig k={t.journal.col.size}>{`${t.common.ct(fmtContracts(s.entry.contracts, inst))} · ${fmtNum(s.entry.coin, 4)} ${base}`}</Fig>
          <Fig k={t.journal.maxSize}>{t.common.ct(fmtContracts(s.entry.maxContracts, inst))}</Fig>
          <Fig k={t.journal.sizeNow}>{t.common.ct(fmtContracts(s.size, inst))}</Fig>
          <Fig k={t.journal.col.notional}>{`${fmtNum(s.entry.notional, 2)} ${ccy}`}</Fig>
          <Fig k={t.journal.col.leverage}>{`${s.entry.leverage === null ? DASH : `${fmtNum(s.entry.leverage, 2)}×`} ${labelOf(t.enums.mgnMode, s.entry.mgnMode)}`}</Fig>
          <Fig k={t.journal.margin}>{s.entry.margin === null ? DASH : `${fmtNum(s.entry.margin, 2)} ${ccy}`}</Fig>
          <Fig k={t.journal.col.stop}>{fmtPx(s.initialStop, inst)}</Fig>
          <Fig k={t.journal.initialRisk}>{s.initialRisk === null ? DASH : `${fmtNum(s.initialRisk, 2)} ${ccy}`}</Fig>
          <Fig k={t.journal.col.exit}>{fmtPx(s.exitPx, inst)}</Fig>
          <Fig k={t.journal.realised} cls={signOf(s.realisedPnl)}>
            {money(s.realisedPnl)}
          </Fig>
          <Fig k={t.journal.fees}>{`${fmtNum(s.fees, 4)} ${ccy}`}</Fig>
          <Fig k={t.journal.funding} cls={signOf(s.funding)}>
            {money(s.funding)}
          </Fig>
          <Fig k={t.journal.net} cls={signOf(s.netPnl)}>
            {money(s.netPnl)}
          </Fig>
          <Fig k={t.journal.col.r} cls={signOf(s.rMultiple)}>
            {fmtR(s.rMultiple) === '' ? DASH : fmtR(s.rMultiple)}
          </Fig>
          <Fig k={t.journal.closeReason}>{closedBy}</Fig>
        </div>
        {s.adopted && <div className="jr-note warn">{t.journal.adoptedTitle}</div>}
      </section>

      <section className="jr-section">
        <h5>{t.journal.plan}</h5>
        {plan === null ? (
          <div className="dim">{t.journal.noPlan}</div>
        ) : (
          <div className="jr-figs">
            <Fig k={t.journal.planStop}>{plan.slTriggerPx === null ? DASH : fmtPx(plan.slTriggerPx, inst)}</Fig>
            <Fig k={t.journal.planTps}>{takeProfitText(plan.takeProfits, inst, t, true, true)}</Fig>
            <Fig k={t.journal.planBreakeven}>{plan.breakevenAfterTp1 ? t.journal.yes : t.journal.no}</Fig>
            <Fig k={t.journal.planTrailing}>{trailingText(plan.trailing, inst, t)}</Fig>
          </div>
        )}
        {plan !== null && plan.signal !== null && (
          <div className="jr-signal">
            <span className="k">{t.journal.signal}</span>{' '}
            <span className="num">
              {t.journal.signalLine(
                t.journal.signalKind[plan.signal.kind],
                fmtPx(plan.signal.close, inst),
                utcLocal(signalCloseTs(plan.signal), t),
                fmtPx(plan.signal.entryLevel, inst),
                fmtPx(plan.signal.exitLevel, inst),
              )}
            </span>
          </div>
        )}
        {plan !== null && <div className="jr-note dim">{exitPlanText(plan, inst, t)}</div>}
      </section>

      {trade === null ? (
        <div className="dim jr-section">{q.isError ? explainError(q.error, t) : t.journal.loadingTrade}</div>
      ) : (
        <>
          <section className="jr-section">
            <h5>{t.journal.fills}</h5>
            {trade.fills.length === 0 ? (
              <div className="dim">{t.journal.noFills}</div>
            ) : (
              <div className="jr-scroll">
                <table className="table jr-table">
                  <thead>
                    <tr>
                      <th>{t.common.time}</th>
                      <th className="left">{t.journal.colRole}</th>
                      <th className="left">{t.common.side}</th>
                      <th>{t.common.price}</th>
                      <th>{t.common.size}</th>
                      <th>{t.common.fee}</th>
                      <th>{t.journal.colPnl}</th>
                      <th>{t.journal.colAfter}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trade.fills.map((f) => (
                      <tr key={`${f.ordId}:${f.tradeId}:${f.ts}`} className="num">
                        <td title={fmtUtcSecond(f.ts)}>
                          {fmtUtcMinute(f.ts)}
                          <span className="sub">{fmtLocalMinute(f.ts)}</span>
                        </td>
                        <td className="left">{t.journal.role[f.role]}</td>
                        <td className={`left ${f.side === 'buy' ? 'pos' : 'neg'}`}>{t.enums.side[f.side]}</td>
                        <td>{fmtPx(f.px, inst)}</td>
                        <td>{t.common.ct(fmtContracts(f.contracts, inst))}</td>
                        <td>{feePaid(f.fee)}</td>
                        <td className={signOf(f.pnl)}>{f.role === 'open' || f.role === 'add' ? DASH : fmtSigned(f.pnl, 2)}</td>
                        <td>{fmtContracts(f.posAfter, inst)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {trade.exits.length > 0 && (
            <section className="jr-section">
              <h5>{t.journal.exits}</h5>
              <div className="jr-scroll">
                <table className="table jr-table">
                  <thead>
                    <tr>
                      <th>{t.common.time}</th>
                      <th className="left">{t.journal.colReason}</th>
                      <th>{t.common.price}</th>
                      <th>{t.common.size}</th>
                      <th>{t.journal.colPnl}</th>
                      <th>{t.common.fee}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trade.exits.map((x) => (
                      <tr key={`${x.ordId}:${x.ts}`} className="num">
                        <td title={fmtUtcSecond(x.ts)}>
                          {fmtUtcMinute(x.ts)}
                          <span className="sub">{fmtLocalMinute(x.ts)}</span>
                        </td>
                        <td className="left">{x.reason === 'take_profit' && x.leg !== null ? t.journal.exitReasonLeg(x.leg) : labelOf(t.journal.exitReason, x.reason)}</td>
                        <td>{fmtPx(x.px, inst)}</td>
                        <td>{t.common.ct(fmtContracts(x.contracts, inst))}</td>
                        <td className={signOf(x.pnl)}>{fmtSigned(x.pnl, 2)}</td>
                        <td>{fmtNum(x.fee, 4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="jr-section">
            <h5>{t.journal.timeline}</h5>
            {trade.timeline.length === 0 ? (
              <div className="dim">{t.journal.noTimeline}</div>
            ) : (
              <ol className="jr-timeline">
                {trade.timeline.map((e, i) => (
                  <li key={i} className={`jr-event jr-event-${e.kind}`}>
                    <span className="jr-when num">
                      {fmtUtcMinute(e.ts)}
                      <span className="sub">{fmtLocalMinute(e.ts)}</span>
                    </span>
                    <span className="jr-what">{eventSentence(e, inst, ccy, t)}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </Drawer>
  );
}
