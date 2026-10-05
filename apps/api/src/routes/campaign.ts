import type { FastifyInstance } from 'fastify';
import { ok, type CampaignLogPage } from '@pegasus/shared';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { disabledCampaignView } from '../services/campaign.js';
import { CAMPAIGN_DISABLED_REPLAY, unavailableReplayView } from '../services/campaign-replay.js';

const logQuery = z.object({
  /** Steps older than this one (its seq): the `next` of the page before */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * The campaign's scoreboard: its state, its decision log and the replay beside the pot. They answer while the
 * campaign is disabled too, with status `disabled` (the replay `unavailable`).
 */
export async function registerCampaignRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.get('/api/campaign', async () => ok(deps.campaign ? deps.campaign.view() : disabledCampaignView(deps.config.campaign)));

  app.get('/api/campaign/log', async (req) => {
    const q = logQuery.parse(req.query);
    const empty: CampaignLogPage = { steps: [], total: 0, next: null };
    return ok(deps.campaign ? deps.campaign.logPage(q.before, q.limit ?? 20) : empty);
  });

  /** The last result of the replay beside the pot; it is recomputed in the background. */
  app.get('/api/campaign/replay', async () => ok(deps.campaign ? deps.campaign.replayView() : unavailableReplayView(CAMPAIGN_DISABLED_REPLAY)));

  /** Asks for the replay to be computed again, in the background: 202 with the result there is now, 200 when there is nothing to replay. */
  app.post('/api/campaign/replay', async (_req, reply) => {
    if (!deps.campaign) return ok(unavailableReplayView(CAMPAIGN_DISABLED_REPLAY));
    const started = deps.campaign.refreshReplay();
    return reply.code(started ? 202 : 200).send(ok(deps.campaign.replayView()));
  });
}
