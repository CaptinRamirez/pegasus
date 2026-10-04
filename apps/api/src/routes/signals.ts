import type { FastifyInstance } from 'fastify';
import { instIdSchema, ok } from '@pegasus/shared';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import type { SignalsOptions } from '../services/signals.js';

const query = z.object({
  instId: instIdSchema.optional(),
  equity: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  riskPct: z.string().regex(/^0?\.\d+$/).optional(),
  maxNotionalPct: z.string().regex(/^0?\.\d+$/).optional(),
  /** One daily cut only (UTC hour of its close) */
  phase: z.enum(['0', '12']).optional(),
  /** Language of the texts in the reports (reasons, sizing notes); English when absent */
  lang: z.enum(['en', 'zh']).optional(),
});

export async function registerSignalRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.get('/api/signals', async (req) => {
    const q = query.parse(req.query);
    const instIds = q.instId ? [q.instId] : [...deps.market.instruments.keys()];
    const opts: SignalsOptions = {};
    if (q.equity !== undefined) opts.equity = q.equity;
    if (q.riskPct !== undefined) opts.riskPct = q.riskPct;
    if (q.maxNotionalPct !== undefined) opts.maxNotionalPct = q.maxNotionalPct;
    if (q.phase !== undefined) opts.phase = q.phase === '0' ? 0 : 12;
    if (q.lang !== undefined) opts.lang = q.lang;
    return ok(await deps.signals.report(instIds, opts));
  });
}
