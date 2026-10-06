import type { FastifyInstance } from 'fastify';
import { D, ok } from '@pegasus/shared';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { disabledCampaignView } from '../services/campaign.js';
import { CampaignSignalsService } from '../services/campaign-signals.js';

const query = z.object({
  /** Risk of one plan, a fraction of the equity below 1 (0.01 = 1%); DEFAULT_FOLLOW_RISK_PCT when absent */
  riskPct: z
    .string()
    .regex(/^0?\.\d+$/, 'must be a fraction below 1, e.g. 0.01')
    .refine((s) => D(s).gt(0), 'must be above 0')
    .optional(),
  /** Equity to size with; the account's total equity when absent */
  equity: z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'must be a decimal, e.g. 1000')
    .refine((s) => D(s).gt(0), 'must be positive')
    .optional(),
});

/** The campaign rule read per coin, each signal with a plan to follow it by hand (services/campaign-signals.ts). */
export async function registerCampaignSignalRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.get('/api/campaign/signals', async (req) => {
    const q = query.parse(req.query);
    deps.campaignSignals ??= new CampaignSignalsService({
      config: deps.config,
      clients: deps.clients,
      market: deps.market,
      account: deps.account,
      risk: deps.risk,
      journal: deps.journal,
      campaign: deps.campaign,
      disabledView: () => disabledCampaignView(deps.config.campaign),
      log: deps.log,
    });
    const opts: { riskPct?: string; equity?: string } = {};
    if (q.riskPct !== undefined) opts.riskPct = q.riskPct;
    if (q.equity !== undefined) opts.equity = q.equity;
    return ok(await deps.campaignSignals.report(opts));
  });
}
