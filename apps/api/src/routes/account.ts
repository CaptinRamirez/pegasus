import type { FastifyInstance } from 'fastify';
import { D, instIdSchema, killSwitchRequestSchema, ok, setLeverageRequestSchema, tdModeSchema } from '@pegasus/shared';
import { z } from 'zod';
import type { OkxSetLeverageParams } from '@pegasus/okx';
import type { Deps } from '../deps.js';
import { RiskRejectedError } from '../errors.js';
import { exchangeError } from '../services/order-service.js';

const leverageQuery = z.object({ instId: instIdSchema, mgnMode: tdModeSchema });

export async function registerAccountRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.get('/api/account', async () => ok({ config: deps.account.config, balance: deps.account.balance }));

  app.get('/api/account/leverage', async (req) => {
    const q = leverageQuery.parse(req.query);
    deps.market.requireInstrument(q.instId);
    // A plain REST read: credentials and a loaded account, not the private stream.
    deps.account.requireConfig();
    try {
      return ok(await deps.account.getLeverage(q.instId, q.mgnMode));
    } catch (err) {
      throw exchangeError(err);
    }
  });

  app.post('/api/account/leverage', async (req) => {
    const body = setLeverageRequestSchema.parse(req.body);
    deps.market.requireInstrument(body.instId);
    const config = deps.account.requireRestTrading();
    // The same cap the risk engine applies to orders, enforced where the leverage is set.
    const limit = deps.risk.config.maxLeverage;
    if (D(body.lever).gt(limit)) {
      throw new RiskRejectedError({ ok: false, code: 'MAX_LEVERAGE', message: `leverage ${body.lever}x exceeds the limit ${limit}x`, details: { lever: body.lever, limit } });
    }
    const params: OkxSetLeverageParams = { instId: body.instId, lever: body.lever, mgnMode: body.mgnMode };
    if (config.posMode === 'long_short_mode' && body.posSide) params.posSide = body.posSide;
    try {
      const info = await deps.account.setLeverage(params);
      deps.log.info({ ...params }, 'leverage changed');
      return ok(info);
    } catch (err) {
      throw exchangeError(err);
    }
  });

  app.get('/api/risk', async () => ok({ config: deps.risk.config, state: { ...deps.risk.state } }));

  app.post('/api/risk/kill-switch', async (req) => {
    const body = killSwitchRequestSchema.parse(req.body);
    // A release while the daily loss limit is still breached answers DAILY_LOSS_ACTIVE (409) unless it carries rebase.
    const state = deps.risk.setKillSwitch(body.enabled, body.reason ?? 'MANUAL', body.rebase ?? false);
    return ok({ ...state });
  });
}
