import type { CampaignBankingRecord, CampaignRecordView, Instrument } from '@pegasus/shared';
import { labelOf, useT } from '../../i18n';
import { campaignState, fmtMultiple, fmtUsdt } from '../../lib/campaign';
import { DASH, fmtContracts, fmtPct, fmtPx, fmtUtcMinute, fmtUtcSecond } from '../../lib/format';

function CampaignRow({ c, inst }: { c: CampaignRecordView; inst: Instrument | undefined }) {
  const t = useT();
  const state = campaignState(c);
  const adds = c.adds.map((a) => t.campaign.addLine(fmtUtcMinute(a.closeTs), fmtContracts(a.contracts, inst), fmtPx(a.avgPx, inst))).join('\n');
  return (
    <tr className={`num campaign-row campaign-row-${state}`}>
      <td className="left">{c.instId}</td>
      <td>{fmtUtcMinute(c.entry.closeTs)}</td>
      <td title={t.campaign.entryTitle(fmtUtcSecond(c.entry.ts), fmtContracts(c.entry.contracts, inst), fmtPx(c.entry.price, inst))}>
        {fmtPx(c.entry.avgPx, inst)}
        <span className="sub">{fmtUsdt(c.stake)} USDT</span>
      </td>
      <td title={adds === '' ? undefined : adds}>{c.adds.length}</td>
      <td>{fmtUsdt(c.harvested)}</td>
      <td>{c.end === null ? DASH : c.end.proceeds === '' ? <span className="dim">{t.campaign.notMeasured}</span> : fmtUsdt(c.end.proceeds)}</td>
      <td className="left">
        <span className={`campaign-badge campaign-state campaign-state-${state}`} title={labelOf(t.campaign.stateTitle, state)}>
          {labelOf(t.campaign.stateLabel, state)}
        </span>
        {c.end === null && c.pendingExit !== null && (
          <span className="campaign-badge campaign-state-pending" title={t.campaign.exitPendingTitle(fmtUtcMinute(c.pendingExit.closeTs))}>
            {t.campaign.exitPending}
          </span>
        )}
      </td>
      {c.end === null ? (
        <td className="campaign-multiple" title={t.campaign.stateTitle.open}>
          {fmtMultiple(c.valueMultiple)}
          <span className="sub">{t.campaign.now}</span>
        </td>
      ) : (
        <td className="campaign-multiple">{fmtMultiple(c.multiple)}</td>
      )}
      <td>{c.end === null ? fmtPx(c.position?.liqPx, inst) : DASH}</td>
    </tr>
  );
}

/** Every campaign of the pot, newest first as the API sends them. */
export function CampaignsTable({ campaigns, instruments }: { campaigns: CampaignRecordView[]; instruments: Instrument[] }) {
  const t = useT();
  return (
    <section className="campaign-section campaign-campaigns">
      <h4>
        {t.campaign.campaigns} <span className="dim">{campaigns.length}</span>
      </h4>
      {campaigns.length === 0 ? (
        <div className="empty">{t.campaign.noCampaigns}</div>
      ) : (
        <div className="campaign-scroll">
          <table className="table campaign-table">
            <thead>
              <tr>
                <th>{t.common.instrument}</th>
                <th>{t.campaign.signalClose}</th>
                <th>
                  {t.campaign.entryFill}
                  <span className="sub">{t.campaign.stake}</span>
                </th>
                <th>{t.campaign.adds}</th>
                <th>{t.campaign.harvested}</th>
                <th>{t.campaign.proceeds}</th>
                <th className="left">{t.campaign.state}</th>
                <th>{t.campaign.multiple}</th>
                <th>{t.campaign.liqPx}</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <CampaignRow key={c.id} c={c} inst={instruments.find((i) => i.instId === c.instId)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The harvests of the ladder, newest first. */
export function BankingsTable({ bankings }: { bankings: CampaignBankingRecord[] }) {
  const t = useT();
  return (
    <section className="campaign-section campaign-bankings">
      <h4>{t.campaign.bankings}</h4>
      {bankings.length === 0 ? (
        <div className="empty">{t.campaign.noBankings}</div>
      ) : (
        <div className="campaign-scroll">
          <table className="table campaign-table">
            <thead>
              <tr>
                <th>{t.campaign.close}</th>
                <th>{t.campaign.rungs}</th>
                <th>{t.campaign.value}</th>
                <th>{t.campaign.target}</th>
                <th>{t.campaign.fromCash}</th>
                <th>{t.campaign.sold}</th>
                <th>{t.campaign.fromSales}</th>
                <th>{t.campaign.amount}</th>
              </tr>
            </thead>
            <tbody>
              {[...bankings].reverse().map((b) => (
                <tr key={`${b.closeTs}:${b.rungs}`} className="num campaign-banking-row">
                  <td>{fmtUtcMinute(b.closeTs)}</td>
                  <td>{b.rungs}</td>
                  <td>{fmtUsdt(b.value)}</td>
                  <td>{fmtUsdt(b.target)}</td>
                  <td>{fmtUsdt(b.fromCash)}</td>
                  <td>{fmtPct(b.fraction, 1)}</td>
                  <td>{fmtUsdt(b.fromSales)}</td>
                  <td>
                    <b>{fmtUsdt(b.amount)}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
