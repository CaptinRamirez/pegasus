import type { FastifyInstance } from 'fastify';
import { instIdSchema, ok } from '@pegasus/shared';
import { z } from 'zod';
import type { Deps } from '../deps.js';

const query = z.object({
  instId: instIdSchema.optional(),
  equity: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  riskPct: z.string().regex(/^0?\.\d+$/).optional(),
  maxNotionalPct: z.string().regex(/^0?\.\d+$/).optional(),
});

export async function registerSignalRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.get('/api/signals', async (req) => {
    const q = query.parse(req.query);
    const instIds = q.instId ? [q.instId] : [...deps.market.instruments.keys()];
    const opts: { equity?: string; riskPct?: string; maxNotionalPct?: string } = {};
    if (q.equity !== undefined) opts.equity = q.equity;
    if (q.riskPct !== undefined) opts.riskPct = q.riskPct;
    if (q.maxNotionalPct !== undefined) opts.maxNotionalPct = q.maxNotionalPct;
    return ok(await deps.signals.report(instIds, opts));
  });
}
