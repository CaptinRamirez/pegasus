import type { FastifyInstance } from 'fastify';
import { amendAlgoOrderRequestSchema, cancelAlgoOrderRequestSchema, placeStopRequestSchema, cancelAllRequestSchema, cancelOrderRequestSchema, closePositionRequestSchema, fillsQuerySchema, ok, ordersHistoryQuerySchema, placeOrderRequestSchema } from '@pegasus/shared';
import type { Deps } from '../deps.js';

export async function registerTradingRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.get('/api/orders/open', async () => ok(deps.account.openOrderList()));

  app.get('/api/orders/history', async (req) => {
    const q = ordersHistoryQuerySchema.parse(req.query);
    return ok(await deps.account.orderHistory(q.instId, q.limit ?? 50));
  });

  app.get('/api/fills', async (req) => {
    const q = fillsQuerySchema.parse(req.query);
    return ok(await deps.account.recentFills(q.instId, q.limit ?? 50));
  });

  app.post('/api/orders/preview', async (req) => {
    const body = placeOrderRequestSchema.parse(req.body);
    return ok(await deps.orders.preview(body));
  });

  app.post('/api/orders', async (req, reply) => {
    const body = placeOrderRequestSchema.parse(req.body);
    const result = await deps.orders.place(body);
    reply.code(201);
    return ok(result);
  });

  app.post('/api/orders/cancel', async (req) => {
    const body = cancelOrderRequestSchema.parse(req.body);
    const ack = await deps.orders.cancel(body);
    return ok({ ordId: ack.ordId, clOrdId: ack.clOrdId });
  });

  app.post('/api/orders/cancel-all', async (req) => {
    const body = cancelAllRequestSchema.parse(req.body ?? {});
    const canceled = await deps.orders.cancelAll(body.instId);
    return ok({ canceled });
  });

  // Always a fresh read of the exchange: this is the check that the stops are still there.
  app.get('/api/algo-orders', async () => ok(await deps.account.refreshAlgoOrders()));

  app.post('/api/algo-orders', async (req, reply) => {
    const body = placeStopRequestSchema.parse(req.body);
    const result = await deps.orders.placeStop(body);
    reply.code(201);
    return ok(result);
  });

  app.post('/api/algo-orders/amend', async (req) => {
    const body = amendAlgoOrderRequestSchema.parse(req.body);
    return ok(await deps.orders.amendStop(body));
  });

  app.post('/api/algo-orders/cancel', async (req) => {
    const body = cancelAlgoOrderRequestSchema.parse(req.body);
    return ok(await deps.orders.cancelStop(body));
  });

  app.get('/api/positions', async () => ok(deps.account.positionList()));

  app.post('/api/positions/close', async (req) => {
    const body = closePositionRequestSchema.parse(req.body);
    return ok(await deps.orders.closePosition(body));
  });
}
