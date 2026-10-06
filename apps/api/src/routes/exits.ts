import type { FastifyInstance } from 'fastify';
import { clearChannelTrailingRequestSchema, ok, placeTakeProfitsRequestSchema, placeTrailingStopRequestSchema, setChannelTrailingRequestSchema, type TdMode, type PosSide } from '@pegasus/shared';
import type { Deps } from '../deps.js';
import { AppError } from '../errors.js';
import { campaignOwns, type ChannelTrailingService } from '../services/channel-trailing.js';
import { ExitsUnavailableError } from '../services/order-service.js';

/**
 * Exits for an open position (paper trading and the local mock only): take-profit legs, the exchange's trailing stop,
 * channel trailing kept by the API. Each of them only reduces the position; they are listed and cancelled through
 * /api/algo-orders. docs/api.md, "Exits".
 */
export async function registerExitRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const trailing = (): ChannelTrailingService => {
    if (!deps.trailing?.enabled) throw new ExitsUnavailableError();
    return deps.trailing;
  };
  /** The campaign's positions are the rule's: their exits are never set by hand. */
  const notCampaign = (ref: { instId: string; mgnMode: TdMode; posSide?: PosSide | undefined }): void => {
    const posSide = ref.posSide ?? 'net';
    const position = deps.account.positionList().find((p) => p.instId === ref.instId && p.mgnMode === ref.mgnMode && p.posSide === posSide);
    if (position && campaignOwns(deps.campaign, position)) throw new AppError('CAMPAIGN_POSITION', `the ${ref.instId} position is the campaign's: its exits are the rule's and are not set by hand`, 409);
  };

  app.post('/api/positions/take-profits', async (req, reply) => {
    const body = placeTakeProfitsRequestSchema.parse(req.body);
    notCampaign(body);
    const result = await deps.orders.placeTakeProfits(body);
    reply.code(201);
    return ok(result);
  });

  app.post('/api/positions/trailing-stop', async (req, reply) => {
    const body = placeTrailingStopRequestSchema.parse(req.body);
    notCampaign(body);
    const result = await deps.orders.placeTrailingStop(body);
    reply.code(201);
    return ok(result);
  });

  app.post('/api/positions/channel-trailing', async (req) => {
    const body = setChannelTrailingRequestSchema.parse(req.body);
    return ok(await trailing().enable(body, { kind: 'route' }));
  });

  app.post('/api/positions/channel-trailing/clear', async (req) => {
    const body = clearChannelTrailingRequestSchema.parse(req.body);
    const cleared = await trailing().disable(body);
    return ok({ instId: body.instId, mgnMode: body.mgnMode, posSide: body.posSide ?? 'net', cleared });
  });

  app.get('/api/trailing', async () => {
    if (!deps.trailing) throw new ExitsUnavailableError();
    return ok(deps.trailing.view());
  });
}
