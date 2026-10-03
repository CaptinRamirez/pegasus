import { timingSafeEqual } from 'node:crypto';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { SizingError, err as apiErr } from '@pegasus/shared';
import { OkxApiError } from '@pegasus/okx';
import { ZodError } from 'zod';
import type { Deps } from './deps.js';
import { AppError } from './errors.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerMarketRoutes } from './routes/market.js';
import { registerSignalRoutes } from './routes/signals.js';
import { registerTradingRoutes } from './routes/trading.js';

function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return undefined;
  return h.slice('Bearer '.length).trim();
}

export async function buildServer(deps: Deps): Promise<FastifyInstance> {
  // The pino logger generic makes FastifyInstance incompatible with the default type used by the route modules; the cast is type-only.
  const app = Fastify({ loggerInstance: deps.log.child({ component: 'http' }), disableRequestLogging: true, trustProxy: false }) as unknown as FastifyInstance;

  await app.register(cors, { origin: true });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.split('?')[0] ?? req.url;
    if (!url.startsWith('/api/') || url === '/api/health') return;
    if (!tokenMatches(deps.config.server.token, bearer(req))) {
      await reply.code(401).send(apiErr('UNAUTHORIZED', 'missing or invalid API token'));
    }
  });

  app.setErrorHandler((error: unknown, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send(apiErr('VALIDATION', 'invalid request', { issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }));
    }
    if (error instanceof AppError) {
      return reply.code(error.status).send(apiErr(error.code, error.message, error.details));
    }
    if (error instanceof SizingError) {
      return reply.code(400).send(apiErr('SIZING', error.message, { code: error.code }));
    }
    if (error instanceof OkxApiError) {
      return reply.code(error.isRateLimited ? 429 : 502).send(apiErr('EXCHANGE', error.okxMessage, { okxCode: error.code, okxMsg: error.okxMessage }));
    }
    const e = error as { statusCode?: number; message?: string };
    const status = typeof e.statusCode === 'number' ? e.statusCode : 500;
    if (status >= 500) deps.log.error({ err: error }, 'unhandled error');
    return reply.code(status).send(apiErr(status === 404 ? 'NOT_FOUND' : 'INTERNAL', e.message ?? 'internal error'));
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send(apiErr('NOT_FOUND', 'route not found')));

  app.get('/ws', {
    websocket: true,
    preValidation: async (req, reply) => {
      const token = (req.query as { token?: string }).token;
      if (!tokenMatches(deps.config.server.token, token)) {
        await reply.code(401).send(apiErr('UNAUTHORIZED', 'missing or invalid API token'));
      }
    },
  }, (socket) => {
    deps.hub.attach(socket);
  });

  await registerMarketRoutes(app, deps);
  await registerTradingRoutes(app, deps);
  await registerAccountRoutes(app, deps);
  await registerSignalRoutes(app, deps);

  return app;
}
