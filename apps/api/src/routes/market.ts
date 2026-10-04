import type { FastifyInstance } from 'fastify';
import { candlesQuerySchema, instIdSchema, ok } from '@pegasus/shared';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { AppError } from '../errors.js';

const instQuery = z.object({ instId: instIdSchema });

export async function registerMarketRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  // No token is needed here, so it says only that the server is up: the account status
  // (OKX's error text, the read-only flag) and the stale streams stay behind the token.
  app.get('/api/health', async () => {
    const { okxPublic, okxPrivate, okxBusiness } = deps.hub.connectionStatus();
    return {
      ok: true,
      // The commit this process was started from: a page built from another commit is talking to an older or newer API.
      version: deps.config.version,
      demo: deps.config.okx.demo,
      paper: deps.config.okx.paper,
      connection: { okxPublic, okxPrivate, okxBusiness },
      serverTime: Date.now(),
    };
  });

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
