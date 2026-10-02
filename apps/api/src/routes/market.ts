import type { FastifyInstance } from 'fastify';
import { candlesQuerySchema, instIdSchema, ok } from '@pegasus/shared';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { AppError } from '../errors.js';

const instQuery = z.object({ instId: instIdSchema });

export async function registerMarketRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.get('/api/health', async () => ({
    ok: true,
    demo: deps.config.okx.demo,
    connection: deps.hub.connectionStatus(),
    clients: deps.hub.size,
    store: deps.store.kind,
    serverTime: Date.now(),
  }));

  app.get('/api/instruments', async () => ok([...deps.market.instruments.values()]));

  app.get('/api/ticker', async (req) => {
    const { instId } = instQuery.parse(req.query);
    deps.market.requireInstrument(instId);
    const t = deps.market.ticker(instId);
    if (!t) throw new AppError('NO_DATA', `no ticker yet for ${instId}`, 503);
    return ok(t);
  });

  app.get('/api/book', async (req) => {
    const { instId } = instQuery.parse(req.query);
    deps.market.requireInstrument(instId);
    const b = deps.market.book(instId);
    if (!b) throw new AppError('NO_DATA', `no order book yet for ${instId}`, 503);
    return ok(b);
  });

  app.get('/api/candles', async (req) => {
    const q = candlesQuerySchema.parse(req.query);
    const candles = await deps.market.fetchCandles(q.instId, q.bar, q.limit ?? 300, q.before);
    return ok(candles);
  });
}
