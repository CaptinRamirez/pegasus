import { errorText, labelOf, useT, type Messages } from '../../i18n';
import { replayResult, type ReplayState } from '../../lib/campaign';
import { DASH, fmtPct, fmtUtcMinute, fmtUtcSecond } from '../../lib/format';

const DAY_MS = 86_400_000;

/** What the page can say about the replay, and whether it is a warning; null when there is nothing to add. */
export function replayNotice(state: ReplayState, t: Messages): { text: string; warn: boolean } | null {
  switch (state.kind) {
    case 'off':
      return { text: t.campaign.replayOff, warn: false };
    case 'loading':
      return { text: t.campaign.replayLoading, warn: false };
    case 'missing':
      return { text: t.campaign.replayMissing, warn: true };
    case 'error':
      return { text: t.campaign.replayError(errorText(state.error, t)), warn: true };
    case 'loaded': {
      const r = state.replay;
      const label = labelOf(t.campaign.replayStatus, r.status);
      const why = r.reason === null ? label : t.campaign.replayWhy(label, r.reason.message);
      if (r.status === 'failed') return { text: r.same !== null ? t.campaign.replayEarlier(r.reason?.message ?? '') : why, warn: true };
      if (r.status === 'unavailable') return { text: why, warn: true };
      if (r.status === 'running' && r.computedAt === null) return { text: why, warn: false };
      if (r.through === null || r.computedAt === null) return null;
      return { text: t.campaign.replayThrough(fmtUtcMinute(r.through), fmtUtcSecond(r.computedAt)), warn: false };
    }
  }
}

export function ReplayNotice({ state }: { state: ReplayState }) {
  const t = useT();
  const notice = replayNotice(state, t);
  if (notice === null) return null;
  return <div className={`campaign-note campaign-replay-note ${notice.warn ? 'warn' : 'dim'}`}>{notice.text}</div>;
}

/** The ledger against the replay of the same structure: the counts by verdict, and every row that is not a match. */
export function Reconciliation({ state }: { state: ReplayState }) {
  const t = useT();
  const recon = replayResult(state)?.reconciliation ?? null;
  const rows = recon?.rows.filter((r) => r.verdict !== 'match') ?? [];
  const tolerances = recon === null ? [] : Object.entries(recon.tolerances).map(([field, v]) => `${field} ±${fmtPct(v, 2)}`);
  return (
    <section className="campaign-section campaign-recon">
      <h4>{t.campaign.reconciliation}</h4>
      <ReplayNotice state={state} />
      {recon !== null && (
        <>
          <div className="campaign-recon-counts">
            <span className="campaign-badge campaign-verdict-match">
              {t.campaign.verdict.match} {recon.matched}
            </span>
            <span className="campaign-badge campaign-verdict-differs">
              {t.campaign.verdict.differs} {recon.differing}
            </span>
            <span className="campaign-badge campaign-verdict-live-only">
              {t.campaign.verdict['live-only']} {recon.liveOnly}
            </span>
            <span className="campaign-badge campaign-verdict-replay-only">
              {t.campaign.verdict['replay-only']} {recon.replayOnly}
            </span>
          </div>
          {tolerances.length > 0 && <div className="campaign-note dim">{t.campaign.tolerances(tolerances.join(', '))}</div>}
          {recon.rows.length === 0 ? (
            <div className="campaign-note dim">{t.campaign.reconNone}</div>
          ) : rows.length === 0 ? (
            <div className="campaign-note pos">{t.campaign.reconAllMatch}</div>
          ) : (
            <div className="campaign-scroll">
              <table className="table campaign-table">
                <thead>
                  <tr>
                    <th>{t.common.instrument}</th>
                    <th>{t.campaign.signalClose}</th>
                    <th className="left">{t.campaign.campaign}</th>
                    <th className="left">{t.campaign.verdictCol}</th>
                    <th className="left">{t.campaign.differences}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.instId}:${r.signalTs}`} className="num campaign-recon-row">
                      <td className="left">{r.instId}</td>
                      {/* signalTs: the open time of the daily bar whose close gave the signal, as CampaignRecord.signalTs */}
                      <td>{fmtUtcMinute(r.signalTs + DAY_MS)}</td>
                      <td className="left dim">{r.campaignId ?? DASH}</td>
                      <td className="left">
                        <span className={`campaign-badge campaign-verdict-${r.verdict}`}>{labelOf(t.campaign.verdict, r.verdict)}</span>
                      </td>
                      <td className="left campaign-wrap">
                        {r.differences.map((d) => (
                          <div key={d.field} className="campaign-diff">
                            {t.campaign.diff(d.field, d.live ?? DASH, d.replay ?? DASH)}
                          </div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
