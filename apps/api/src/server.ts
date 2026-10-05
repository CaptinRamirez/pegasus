import { timingSafeEqual } from 'node:crypto';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { SizingError, err as apiErr } from '@pegasus/shared';
import { OkxApiError, OkxTransportError } from '@pegasus/okx';
import { ZodError } from 'zod';
import type { Deps } from './deps.js';
import { AppError, ExchangeUnreachableError } from './errors.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerCampaignRoutes } from './routes/campaign.js';
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

const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];
const WILDCARD_HOSTS = ['0.0.0.0', '::'];

/** The hostname of a Host header, lower-cased, without the port and with IPv6 kept in brackets; '' when it is not a plain host[:port]. */
function hostnameOf(host: string | undefined): string {
  const m = /^(\[[^\]]+\]|[^:[\]]+)(?::\d*)?$/.exec((host ?? '').trim().toLowerCase());
  return m?.[1] ?? '';
}

export async function buildServer(deps: Deps): Promise<FastifyInstance> {
  // The pino logger generic makes FastifyInstance incompatible with the default type used by the route modules; the cast is type-only.
  const app = Fastify({ loggerInstance: deps.log.child({ component: 'http' }), disableRequestLogging: true, trustProxy: false }) as unknown as FastifyInstance;

  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  const apiHost = deps.config.server.host.toLowerCase();
  const allowedHostnames = [...LOCAL_HOSTNAMES];
  if (!WILDCARD_HOSTS.includes(apiHost)) allowedHostnames.push(apiHost.includes(':') ? `[${apiHost}]` : apiHost);
  const allowedOrigins = deps.config.server.webOrigins;

  // Registered first so it covers every request: the routes, the /ws upgrade, /api/health and unknown paths.
  // Host: a page that re-points its own domain at 127.0.0.1 (DNS rebinding) still sends its own name here.
  // Origin: browsers do not apply CORS to WebSockets, but they send Origin on every upgrade and every non-GET
  // request; clients that are not browsers (the launcher's probe, scripts) send none.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!allowedHostnames.includes(hostnameOf(req.headers.host))) {
      return reply.code(403).send(apiErr('FORBIDDEN_HOST', 'this server only answers requests addressed to localhost, 127.0.0.1 or its configured API_HOST'));
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.includes(origin)) {
      return reply.code(403).send(apiErr('FORBIDDEN_ORIGIN', 'requests from this web origin are not allowed (see WEB_ORIGINS)'));
    }
  });

  // Decided on the route the router matched, never on the raw URL: the router decodes the path
  // (/%61pi/account is /api/account) and accepts an absolute-form request line. Deny by default.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.is404) return;
    const route = req.routeOptions.url;
    // /ws checks its own query token below.
    if (route === '/api/health' || route === '/ws') return;
    if (!tokenMatches(deps.config.server.token, bearer(req))) {
      return reply.code(401).send(apiErr('UNAUTHORIZED', 'missing or invalid API token'));
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
    if (error instanceof OkxTransportError) {
      const unreachable = new ExchangeUnreachableError(error);
      deps.log.warn({ path: error.requestPath, err: error.message }, 'exchange unreachable');
      return reply.code(unreachable.status).send(apiErr(unreachable.code, unreachable.message, unreachable.details));
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
  await registerCampaignRoutes(app, deps);

  return app;
}
