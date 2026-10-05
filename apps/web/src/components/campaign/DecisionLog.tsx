import { useState, type ReactNode } from 'react';
import type { CampaignLogPage, CampaignStepLog, CampaignView, Instrument } from '@pegasus/shared';
import { useCampaignLog } from '../../hooks/useCampaign';
import { labelOf, useT, type Messages } from '../../i18n';
import { fmtLogRecord, fmtUsdt, groupActions } from '../../lib/campaign';
import { DASH, fmtPx, fmtUtcMinute, fmtUtcSecond } from '../../lib/format';
import { LoadFailed } from '../LoadFailed';

/** Columns of a step's row; its details span them all. */
const LOG_COLUMNS = 8;

/** The steps of the pages loaded so far, newest first, each once. */
export function stepsOf(pages: readonly CampaignLogPage[]): CampaignStepLog[] {
  const seen = new Set<number>();
  const steps: CampaignStepLog[] = [];
  for (const page of pages) {
    for (const s of page.steps) {
      if (seen.has(s.seq)) continue;
      seen.add(s.seq);
      steps.push(s);
    }
  }
  return steps;
}

/** The actions of a step in one line: "enter ×1 · add (skipped) ×2". */
function actionsSummary(step: CampaignStepLog, t: Messages): string {
  const groups = groupActions(step.actions);
  if (groups.length === 0) return t.campaign.noActions;
  return groups
    .map((g) => t.campaign.group(labelOf(t.campaign.actionKind, g.kind), g.outcome === 'done' ? null : labelOf(t.campaign.outcomeLabel, g.outcome), g.count))
    .join(' · ');
}

function StepDetails({ step, instruments }: { step: CampaignStepLog; instruments: Instrument[] }) {
  const t = useT();
  const instOf = (instId: string | null): Instrument | undefined => (instId === null ? undefined : instruments.find((i) => i.instId === instId));
  return (
    <div className="campaign-step-body">
      {step.closes.length > 1 && <div className="campaign-note">{t.campaign.closesLooked(step.closes.map(fmtUtcMinute).join(', '))}</div>}
      {step.before !== null && (
        <div className="campaign-note num">
          {t.campaign.potBeforeLine(fmtUsdt(step.before.value), fmtUsdt(step.before.freeCash), fmtUsdt(step.before.openEquity), fmtUsdt(step.before.banked), step.before.rungs)}
        </div>
      )}
      <h5>{t.campaign.inputs}</h5>
      {step.inputs.length === 0 ? (
        <div className="campaign-note dim">{DASH}</div>
      ) : (
        <table className="table campaign-table campaign-inputs">
          <thead>
            <tr>
              <th>{t.common.instrument}</th>
              <th>{t.campaign.close}</th>
              <th>{t.campaign.halfDayBar}</th>
              <th>{t.campaign.price}</th>
              <th>{t.campaign.daily}</th>
              <th>{t.campaign.entryHigh}</th>
              <th>{t.campaign.exitLow}</th>
              <th className="left">{t.campaign.signals}</th>
              <th className="left">{t.campaign.note}</th>
            </tr>
          </thead>
          <tbody>
            {step.inputs.map((input, n) => {
              const inst = instOf(input.instId);
              const bar = input.halfDay;
              return (
                <tr key={`${input.instId}:${input.closeTs}:${n}`} className="num campaign-input">
                  <td className="left">{input.instId}</td>
                  <td>{fmtUtcMinute(input.closeTs)}</td>
                  <td>{bar === null ? <span className="dim">{t.campaign.notConfirmed}</span> : [bar.open, bar.high, bar.low, bar.close].map((v) => fmtPx(v, inst)).join(' / ')}</td>
                  <td>{fmtPx(input.price, inst)}</td>
                  <td>{input.daily === null ? DASH : fmtPx(input.daily.close, inst)}</td>
                  <td>{input.daily === null ? DASH : fmtPx(input.daily.entryHigh, inst)}</td>
                  <td>{input.daily === null ? DASH : fmtPx(input.daily.exitLow, inst)}</td>
                  <td className="left">
                    {input.daily?.entry === true && <span className="campaign-badge campaign-signal-entry">{t.campaign.entrySignal}</span>}
                    {input.daily?.exit === true && <span className="campaign-badge campaign-signal-exit">{t.campaign.exitSignal}</span>}
                  </td>
                  <td className="left dim campaign-wrap">{input.note ?? ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <h5>{t.campaign.actions}</h5>
      {step.actions.length === 0 ? (
        <div className="campaign-note dim">{t.campaign.noActions}</div>
      ) : (
        <table className="table campaign-table campaign-actions">
          <thead>
            <tr>
              <th>{t.campaign.kind}</th>
              <th>{t.campaign.close}</th>
              <th className="left">{t.common.instrument}</th>
              <th className="left">{t.campaign.outcome}</th>
              <th className="left">{t.campaign.reason}</th>
              <th className="left">{t.campaign.plan}</th>
              <th className="left">{t.campaign.result}</th>
              <th>{t.campaign.attempts}</th>
              <th>{t.common.time}</th>
            </tr>
          </thead>
          <tbody>
            {step.actions.map((a, n) => (
              <tr key={`${a.kind}:${a.instId ?? ''}:${n}`} className={`num campaign-action campaign-action-${a.outcome}`}>
                <td className="left">{labelOf(t.campaign.actionKind, a.kind)}</td>
                <td>{fmtUtcMinute(a.closeTs)}</td>
                <td className="left" title={a.campaignId ?? undefined}>
                  {a.instId ?? DASH}
                </td>
                <td className="left">
                  <span className={`campaign-badge campaign-outcome-${a.outcome}`}>{labelOf(t.campaign.outcomeLabel, a.outcome)}</span>
                  {a.error && <span className="campaign-badge campaign-error-tag">{t.campaign.errorTag}</span>}
                </td>
                <td className="left">{a.reason === '' ? DASH : labelOf(t.campaign.skipReason, a.reason)}</td>
                <td className="left campaign-record">{fmtLogRecord(a.plan)}</td>
                <td className="left campaign-record">{fmtLogRecord(a.result)}</td>
                <td>{a.attempts}</td>
                <td>{fmtUtcSecond(a.ts)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {step.notes.length > 0 && (
        <>
          <h5>{t.campaign.notes}</h5>
          <ul className="campaign-notes">
            {step.notes.map((note, n) => (
              <li key={n}>{note}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function StepRows({ step, expanded, onToggle, instruments }: { step: CampaignStepLog; expanded: boolean; onToggle: () => void; instruments: Instrument[] }) {
  const t = useT();
  return (
    <>
      <tr className={`num campaign-step${step.errors > 0 ? ' campaign-step-error' : ''}`} onClick={onToggle} aria-expanded={expanded}>
        <td className="left">
          <span className="chev">{expanded ? '▾' : '▸'}</span> {step.seq}
        </td>
        <td>{fmtUtcMinute(step.closeTs)}</td>
        <td className="left">{labelOf(t.campaign.stepKind, step.kind)}</td>
        <td>{fmtUtcSecond(step.startedAt)}</td>
        <td>{step.endedAt === null ? <span className="warn">{t.campaign.stepRunning}</span> : fmtUtcSecond(step.endedAt)}</td>
        <td>{step.before === null ? <span className="dim">{t.campaign.accountUnread}</span> : fmtUsdt(step.before.value)}</td>
        <td className="left campaign-wrap">{actionsSummary(step, t)}</td>
        <td className={step.errors > 0 ? 'neg' : 'dim'}>{step.errors}</td>
      </tr>
      {expanded && (
        <tr className="campaign-step-details">
          <td colSpan={LOG_COLUMNS}>
            <StepDetails step={step} instruments={instruments} />
          </td>
        </tr>
      )}
    </>
  );
}

/** The decision log, newest first, a page at a time; every step expands to its inputs and actions. */
export function DecisionLog({ view, instruments }: { view: CampaignView; instruments: Instrument[] }) {
  const t = useT();
  const log = useCampaignLog(view);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const steps = stepsOf(log.data?.pages ?? []);
  const total = log.data?.pages[0]?.total ?? 0;
  const toggle = (seq: number) => setOpen((o) => ({ ...o, [seq]: !(o[seq] ?? false) }));

  let body: ReactNode;
  if (steps.length === 0) {
    body = (
      <div className="empty">
        {log.isError ? <LoadFailed what={t.campaign.logWhat} busy={log.isFetching} onRetry={() => void log.refetch()} /> : log.isPending ? t.campaign.logLoading : t.campaign.logEmpty}
      </div>
    );
  } else {
    body = (
      <>
        <div className="campaign-scroll">
          <table className="table campaign-table campaign-log">
            <thead>
              <tr>
                <th>{t.campaign.seq}</th>
                <th>{t.campaign.close}</th>
                <th className="left">{t.campaign.kind}</th>
                <th>{t.campaign.started}</th>
                <th>{t.campaign.ended}</th>
                <th>{t.campaign.potBefore}</th>
                <th className="left">{t.campaign.actions}</th>
                <th>{t.campaign.errorsCol}</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s) => (
                <StepRows key={s.seq} step={s} expanded={open[s.seq] ?? false} onToggle={() => toggle(s.seq)} instruments={instruments} />
              ))}
            </tbody>
          </table>
        </div>
        <div className="campaign-more">
          <span className="dim">{t.campaign.logCount(steps.length, total)}</span>
          {log.hasNextPage && (
            <button className="btn btn-sm" onClick={() => void log.fetchNextPage()} disabled={log.isFetchingNextPage}>
              {log.isFetchingNextPage ? t.campaign.loadingOlder : t.campaign.loadOlder}
            </button>
          )}
          {log.isFetchNextPageError && <LoadFailed what={t.campaign.logWhat} busy={log.isFetchingNextPage} onRetry={() => void log.fetchNextPage()} />}
        </div>
      </>
    );
  }
  return (
    <section className="campaign-section campaign-log-section">
      <h4>{t.campaign.log}</h4>
      {body}
    </section>
  );
}
