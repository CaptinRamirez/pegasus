import type { FastifyInstance } from 'fastify';
import { ok } from '@pegasus/shared';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { disabledTraderView } from '../services/trader.js';

const logQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** The Claude auto trader's state and its decision log. They answer on every stack; where the trader is disabled the view says so. */
export async function registerTraderRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.get('/api/trader', async () => ok(deps.trader ? deps.trader.view() : disabledTraderView(deps.config.trader)));

  /** The newest records of TRADER_LOG_FILE, without their dossiers. */
  app.get('/api/trader/log', async (req) => {
    const q = logQuery.parse(req.query);
    return ok(deps.trader ? deps.trader.logPage(q.limit ?? 30) : { records: [] });
  });
}
