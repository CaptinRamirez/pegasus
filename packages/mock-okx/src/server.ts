import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Engine } from './engine/engine.js';
import { DEFAULT_PRICES, resolveInstruments } from './instruments.js';
import { RestRouter } from './rest-routes.js';
import type { MockOkxHandle, MockOkxOptions } from './types.js';
import { MockWsServer } from './ws-server.js';

const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** Starts an in-process OKX v5 simulator (REST + WebSocket) on a local port. */
export async function startMockOkx(opts: MockOkxOptions = {}): Promise<MockOkxHandle> {
  const host = opts.host ?? '127.0.0.1';
  const tickIntervalMs = opts.tickIntervalMs ?? 250;
  const log = opts.log ?? (() => {});
  const instruments = resolveInstruments(opts.instruments);
  const engine = new Engine({
    posMode: opts.posMode ?? 'net_mode',
    instruments,
    initialPrices: { ...DEFAULT_PRICES, ...(opts.initialPrices ?? {}) },
    seed: opts.seed ?? 42,
    volatility: opts.volatility ?? 0.0004,
    tickIntervalMs,
    initialBalanceUsdt: opts.initialBalanceUsdt ?? '100000',
    takerFeeRate: opts.takerFeeRate ?? '0.0005',
    makerFeeRate: opts.makerFeeRate ?? '0.0002',
    log,
  });
  const router = new RestRouter(engine, opts.credentials);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let body = '';
      try {
        body = await readBody(req);
      } catch (err) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: '50014', msg: (err as Error).message, data: [] }));
        return;
      }
      let reply: { status: number; json: unknown };
      try {
        reply = router.handle({ method: (req.method ?? 'GET').toUpperCase(), rawPath: req.url ?? '/', headers: req.headers, body });
      } catch (err) {
        log(`REST ${req.method ?? ''} ${req.url ?? ''} failed: ${(err as Error).stack ?? String(err)}`);
        reply = { status: 500, json: { code: '50001', msg: 'Service temporarily unavailable, please try again later.', data: [] } };
      }
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.json));
    })();
  });
  const wss = new MockWsServer(engine, server, opts.credentials, log);
  await listen(server, opts.port ?? 0, host);
  const port = (server.address() as AddressInfo).port;
  const timer = tickIntervalMs > 0 ? setInterval(() => engine.tick(), tickIntervalMs) : null;
  log(`mock-okx listening on http://${host}:${port}`);

  let closed = false;
  return {
    port,
    restUrl: `http://${host}:${port}`,
    wsPublicUrl: `ws://${host}:${port}/ws/v5/public`,
    wsPrivateUrl: `ws://${host}:${port}/ws/v5/private`,
    wsBusinessUrl: `ws://${host}:${port}/ws/v5/business`,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      await wss.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
    setPrice: (instId, px) => engine.setPrice(instId, px),
    getState: () => engine.state(),
    tick: () => engine.tick(),
  };
}
