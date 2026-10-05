import { useQuery } from '@tanstack/react-query';
import { CAMPAIGN_QUERY, useCampaignReplay } from '../hooks/useCampaign';
import { useT } from '../i18n';
import { replayResult, replayState } from '../lib/campaign';
import { useStore } from '../store/store';
import { CampaignChart } from './campaign/CampaignChart';
import { AcceptanceCard, ErrorsSection, PotCard, StatusCard, StepsCard } from './campaign/CampaignSummary';
import { BankingsTable, CampaignsTable } from './campaign/CampaignTables';
import { DecisionLog } from './campaign/DecisionLog';
import { Reconciliation, ReplayNotice } from './campaign/Reconciliation';
import { LoadFailed } from './LoadFailed';

/**
 * The CAMPAIGN tab: the scoreboard of the pot the API runs on the paper exchange. The view comes from the store
 * (the `campaign` message, or GET /api/campaign through useCampaignSeed); the replay and the decision log are read
 * here, over HTTP, when the view says they changed.
 */
export function CampaignPanel() {
  const t = useT();
  const view = useStore((s) => s.campaign);
  const instruments = useStore((s) => s.instruments);
  // The request that seeds the view: its failure is shown here, with a retry.
  const seed = useQuery(CAMPAIGN_QUERY);
  const replayQuery = useCampaignReplay(view);

  if (view === null) {
    return (
      <div className="empty">
        {seed.isError ? <LoadFailed what={t.campaign.what} busy={seed.isFetching} onRetry={() => void seed.refetch()} /> : t.campaign.loading}
      </div>
    );
  }

  const started = view.status !== 'disabled' && view.pot !== null;
  const replay = replayState(started, replayQuery.data, replayQuery.error);
  return (
    <div className="campaign">
      <div className="campaign-cards">
        <StatusCard view={view} />
        <StepsCard view={view} />
        <AcceptanceCard view={view} />
        <PotCard view={view} />
      </div>
      <ErrorsSection view={view} />
      {started && (
        <>
          <CampaignChart view={view} replay={replayResult(replay)} notice={<ReplayNotice state={replay} />} />
          <CampaignsTable campaigns={view.campaigns} instruments={instruments} />
          <BankingsTable bankings={view.bankings} />
          <Reconciliation state={replay} />
          <DecisionLog view={view} instruments={instruments} />
        </>
      )}
    </div>
  );
}
