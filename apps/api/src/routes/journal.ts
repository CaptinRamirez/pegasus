import type { FastifyInstance } from 'fastify';
import { instIdSchema, ok, type JournalPage } from '@pegasus/shared';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { AppError } from '../errors.js';
import type { JournalFilter } from '../services/journal-book.js';

const listQuery = z.object({
  status: z.enum(['open', 'closed']).optional(),
  instId: instIdSchema.optional(),
  source: z.enum(['manual', 'signal', 'campaign', 'external']).optional(),
  /** Trades older than this one (its seq): the `next` of the page before */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const idParams = z.object({ id: z.string().min(1).max(64) });

/** The trade journal (services/journal.ts): its trades newest first, and one trade with its fills and timeline. */
export async function registerJournalRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.get('/api/journal', async (req) => {
    const q = listQuery.parse(req.query);
    const filter: JournalFilter = {};
    if (q.status !== undefined) filter.status = q.status;
    if (q.instId !== undefined) filter.instId = q.instId;
    if (q.source !== undefined) filter.source = q.source;
    if (!deps.journal) {
      const page: JournalPage = { status: 'disabled', reason: { code: 'JOURNAL_DISABLED', message: 'this server keeps no trade journal' }, trades: [], total: 0, next: null, serverTime: Date.now() };
      return ok(page);
    }
    return ok(deps.journal.page(filter, q.before, q.limit ?? 50));
  });

  app.get('/api/journal/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const trade = deps.journal?.trade(id) ?? null;
    if (!trade) throw new AppError('TRADE_NOT_FOUND', `no trade ${id} in the journal`, 404, { id });
    return ok(trade);
  });
}
