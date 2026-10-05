import { useEffect, useState } from 'react';
import type { CampaignStatusReason, CampaignView } from '@pegasus/shared';
import { labelOf, useT, type Messages } from '../../i18n';
import { ACCEPTANCE_TARGET, acceptanceCounts, fmtMultiple, fmtUsdt, potMultiple } from '../../lib/campaign';
import { DASH, fmtPct, fmtPx, fmtUtcMinute, fmtUtcSecond } from '../../lib/format';

/** Reasons whose message from the API carries specifics worth reading (the file, the account, what to do): shown under the text. */
const REASON_DETAILS: ReadonlySet<string> = new Set(['LEDGER_UNREADABLE', 'ACCOUNT_NOT_DEDICATED', 'ACCOUNT_UNAVAILABLE']);

/** The reason in the page's language from its code; a code the dictionary does not know is shown with the API's English message. */
export function reasonText(reason: CampaignStatusReason, t: Messages): { text: string; detail: string | null } {
  const known = (t.campaign.reasons as Readonly<Record<string, string>>)[reason.code];
  if (known === undefined) return { text: reason.message, detail: null };
  return { text: known, detail: REASON_DETAILS.has(reason.code) ? reason.message : null };
}

/** The time left until `to`, ticking every second on its own: the rest of the page does not re-render with it. */
function Countdown({ to }: { to: number }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return <span className="campaign-countdown num">{t.campaign.countdown(to - now)}</span>;
}

export function StatusCard({ view }: { view: CampaignView }) {
  const t = useT();
  const reason = view.reason === null ? null : reasonText(view.reason, t);
  const detail = reason?.detail ?? null;
  const p = view.params;
  const rule = t.campaign.rule({
    instruments: p.instruments.length,
    potStart: fmtUsdt(p.potStart),
    minStake: fmtUsdt(p.minStake),
    structure: labelOf(t.campaign.structureLabel, p.structure),
    adds: p.structure === 'pyramid',
    leverage: p.leverage,
    entryChannel: p.entryChannel,
    exitChannel: p.exitChannel,
    addStep: fmtPct(p.addStep, 0),
    stakeFraction: fmtPct(p.stakeFraction, 0),
    bankFraction: fmtPct(p.bankFraction, 0),
    rungFactor: p.rungFactor,
  });
  return (
    <section className="campaign-card">
      <h4>{t.campaign.status}</h4>
      <div className="campaign-status-line">
        <span className={`campaign-badge campaign-status campaign-status-${view.status}`}>{labelOf(t.campaign.statusLabel, view.status)}</span>
        {reason !== null && view.reason !== null && (
          <span className="campaign-reason" title={`${view.reason.code}: ${view.reason.message}`}>
            {reason.text}
          </span>
        )}
      </div>
      {detail !== null && <div className="campaign-note campaign-reason-detail">{detail}</div>}
      <div className="campaign-note campaign-rule" title={p.instruments.join(', ')}>
        {rule}
      </div>
    </section>
  );
}

export function StepsCard({ view }: { view: CampaignView }) {
  const t = useT();
  const last = view.lastStep;
  const next = view.nextStep;
  return (
    <section className="campaign-card campaign-steps">
      <h4>{t.campaign.steps}</h4>
      <div className="campaign-field">
        <span className="k">{t.campaign.lastStep}</span>
        <span className="v num campaign-last-step">
          {last === null ? (
            <span className="dim">{t.campaign.noStepYet}</span>
          ) : (
            <>
              #{last.seq} · {fmtUtcMinute(last.closeTs)} · {labelOf(t.campaign.stepKind, last.kind)}
              <span className="sub">
                {last.endedAt === null ? t.campaign.stepRunning : t.campaign.stepEnded(fmtUtcSecond(last.endedAt))} ·{' '}
                <span className={last.errors > 0 ? 'neg' : ''}>{t.campaign.stepErrors(last.errors)}</span>
              </span>
            </>
          )}
        </span>
      </div>
      <div className="campaign-field">
        <span className="k">{t.campaign.nextStep}</span>
        <span className="v num campaign-next-step">
          {next === null ? (
            <span className="dim">{t.campaign.noNextStep}</span>
          ) : (
            <>
              {fmtUtcMinute(next.closeTs)} · <Countdown to={next.closeTs} />
              <span className="sub">{next.daily ? t.campaign.nextDaily : t.campaign.nextHalfDay}</span>
            </>
          )}
        </span>
      </div>
      <div className="campaign-field campaign-field-inline" title={t.campaign.missedTitle}>
        <span className="k">{t.campaign.missedCloses}</span>
        <span className={`v num campaign-missed${view.missedCloses > 0 ? ' warn' : ''}`}>{view.missedCloses}</span>
      </div>
      {view.foreign.length > 0 && <div className="notice notice-warn campaign-foreign">{t.campaign.foreign(view.foreign.join('; '))}</div>}
    </section>
  );
}

export function AcceptanceCard({ view }: { view: CampaignView }) {
  const t = useT();
  const counts = acceptanceCounts(view.campaigns);
  // a count of campaigns, not money: plain numbers for the width of the bar
  const progress = Math.min(100, (counts.ranToEnd / ACCEPTANCE_TARGET) * 100);
  return (
    <section className="campaign-card campaign-acceptance">
      <h4>{t.campaign.acceptance}</h4>
      <div className="kv-list">
        <span className="k" title={t.campaign.ranToEndTitle}>
          {t.campaign.ranToEnd}
        </span>
        <span className="v num campaign-ran" title={t.campaign.ranToEndTitle}>
          {t.campaign.ofTarget(counts.ranToEnd, ACCEPTANCE_TARGET)}
        </span>
        <span className="k" title={t.campaign.errorCountTitle}>
          {t.campaign.errorCount}
        </span>
        <span className="v num campaign-errcount" title={t.campaign.errorCountTitle}>
          <b className={view.errorCount > 0 ? 'neg' : 'pos'}>{view.errorCount}</b> <span className="dim">({t.campaign.errorTarget})</span>
        </span>
      </div>
      <div className="bar pos">
        <div style={{ width: `${progress}%` }} />
      </div>
      {counts.open + counts.external + counts.unknown > 0 && (
        <div className="campaign-note dim campaign-not-counted">{t.campaign.notCounted(counts.open, counts.external, counts.unknown)}</div>
      )}
      {view.pot !== null && view.errorCount === 0 && <div className="campaign-note pos">{t.campaign.noErrors}</div>}
    </section>
  );
}

export function PotCard({ view }: { view: CampaignView }) {
  const t = useT();
  const pot = view.pot;
  if (pot === null) {
    return (
      <section className="campaign-card campaign-pot">
        <h4>{t.campaign.pot}</h4>
        <div className="dim">{t.campaign.notStarted}</div>
      </section>
    );
  }
  const unknown = <span className="dim">{t.common.na}</span>;
  const money = (v: string | null) => (v === null ? unknown : `${fmtUsdt(v)} USDT`);
  return (
    <section className="campaign-card campaign-pot">
      <h4>{t.campaign.pot}</h4>
      <div className="kv-list">
        <span className="k">{t.campaign.startValue}</span>
        <span className="v num">
          {fmtUsdt(pot.startValue)} USDT
          <span className="sub">{fmtUtcMinute(pot.startedAt)}</span>
        </span>
        <span className="k">{t.campaign.valueNow}</span>
        <span className="v num campaign-value" title={pot.value === null ? t.campaign.unknownNow : undefined}>
          {money(pot.value)}
        </span>
        <span className="k">{t.campaign.freeCash}</span>
        <span className="v num">{money(pot.freeCash)}</span>
        <span className="k">{t.campaign.openEquity}</span>
        <span className="v num">{money(pot.openEquity)}</span>
        <span className="k">{t.campaign.banked}</span>
        <span className="v num">{fmtUsdt(pot.banked)} USDT</span>
        <span className="k" title={t.campaign.potMultipleTitle}>
          {t.campaign.potMultiple}
        </span>
        <span className="v num campaign-pot-multiple" title={t.campaign.potMultipleTitle}>
          {fmtMultiple(potMultiple(pot))}
        </span>
        <span className="k">{t.campaign.nextRung}</span>
        <span className="v num">
          {fmtUsdt(pot.nextRung)} USDT <span className="dim">({t.campaign.rungsPassed(pot.rungs)})</span>
        </span>
        <span className="k">{t.campaign.peak}</span>
        <span className="v num">
          {pot.peak === null ? (
            <span className="dim">{t.campaign.noPeak}</span>
          ) : (
            <>
              {fmtUsdt(pot.peak.value)} USDT<span className="sub">{fmtUtcMinute(pot.peak.ts)}</span>
            </>
          )}
        </span>
        <span className="k">{t.campaign.structure}</span>
        <span className="v">{labelOf(t.campaign.structureLabel, pot.structure)}</span>
        <span className="k">{t.campaign.btcAtStart}</span>
        <span className="v num">{pot.btcMarkAtStart === '' ? DASH : fmtPx(pot.btcMarkAtStart)}</span>
        {pot.finishedAt !== null && (
          <>
            <span className="k">{t.campaign.finishedAt}</span>
            <span className="v num">{fmtUtcMinute(pot.finishedAt)}</span>
          </>
        )}
      </div>
    </section>
  );
}

/** Errors shown before "Show all". */
const FEW_ERRORS = 5;

/** The newest execution errors, a few at first: the API sends the last 50, newest first. */
export function ErrorsSection({ view }: { view: CampaignView }) {
  const t = useT();
  const [all, setAll] = useState(false);
  if (view.errors.length === 0) return null;
  const shown = all ? view.errors : view.errors.slice(0, FEW_ERRORS);
  return (
    <section className="campaign-section campaign-errors">
      <h4>
        {t.campaign.errors} <span className="dim">{t.campaign.errorsShown(shown.length, view.errorCount)}</span>
        {view.errors.length > FEW_ERRORS && (
          <button className="btn btn-sm" onClick={() => setAll((a) => !a)}>
            {all ? t.campaign.showFewer : t.campaign.showAll(view.errors.length)}
          </button>
        )}
      </h4>
      <div className="campaign-scroll">
        <table className="table campaign-table">
          <thead>
            <tr>
              <th>{t.common.time}</th>
              <th className="left">{t.campaign.code}</th>
              <th className="left">{t.common.instrument}</th>
              <th className="left">{t.campaign.action}</th>
              <th className="left">{t.campaign.message}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e, i) => (
              <tr key={`${e.ts}:${e.code}:${i}`} className="num campaign-error-row">
                <td className="left muted">{fmtUtcSecond(e.ts)}</td>
                <td className="left neg">{e.code}</td>
                <td className="left">{e.instId ?? DASH}</td>
                <td className="left">{e.action}</td>
                <td className="left campaign-wrap">{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
