import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Engine } from './engine/engine.js';
import { DEFAULT_MMR, DEFAULT_PRICES, resolveInstruments } from './instruments.js';
import { RestRouter } from './rest-routes.js';
import type { MockCredentials, MockOkxHandle, MockOkxOptions } from './types.js';
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

export interface ExchangeServerOptions {
  /** 0 (default) picks a free port. */
  port?: number;
  host?: string;
  /** When set, private REST and WS calls must carry a valid OKX signature. */
  credentials?: MockCredentials | undefined;
  log?: (msg: string) => void;
  /** Called after every POST that was routed: the request may have changed the exchange's state. */
  onWrite?: () => void;
}

export interface ExchangeServerHandle {
  port: number;
  restUrl: string;
  wsPublicUrl: string;
  wsPrivateUrl: string;
  wsBusinessUrl: string;
  close(): Promise<void>;
}

/** Serves an engine over the OKX v5 REST and WebSocket protocol on a local port. */
export async function startExchangeServer(engine: Engine, opts: ExchangeServerOptions = {}): Promise<ExchangeServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const log = opts.log ?? (() => {});
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
      const method = (req.method ?? 'GET').toUpperCase();
      try {
        reply = router.handle({ method, rawPath: req.url ?? '/', headers: req.headers, body });
        if (method === 'POST') opts.onWrite?.();
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
      await wss.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

/** Starts an in-process OKX v5 simulator (REST + WebSocket) on a local port. */
export async function startMockOkx(opts: MockOkxOptions = {}): Promise<MockOkxHandle> {
  const tickIntervalMs = opts.tickIntervalMs ?? 250;
  const log = opts.log ?? (() => {});
  const instruments = resolveInstruments(opts.instruments);
  const engine = new Engine({
    posMode: opts.posMode ?? 'net_mode',
    perm: opts.perm ?? 'read_only,trade',
    instruments,
    initialPrices: { ...DEFAULT_PRICES, ...(opts.initialPrices ?? {}) },
    seed: opts.seed ?? 42,
    volatility: opts.volatility ?? 0.0004,
    tickIntervalMs,
    initialBalanceUsdt: opts.initialBalanceUsdt ?? '100000',
    takerFeeRate: opts.takerFeeRate ?? '0.0005',
    makerFeeRate: opts.makerFeeRate ?? '0.0002',
    mmr: { ...DEFAULT_MMR, ...(opts.mmr ?? {}) },
    log,
  });
  const serverOpts: ExchangeServerOptions = { log };
  if (opts.port !== undefined) serverOpts.port = opts.port;
  if (opts.host !== undefined) serverOpts.host = opts.host;
  if (opts.credentials !== undefined) serverOpts.credentials = opts.credentials;
  const server = await startExchangeServer(engine, serverOpts);
  const timer = tickIntervalMs > 0 ? setInterval(() => engine.tick(), tickIntervalMs) : null;
  log(`mock-okx listening on ${server.restUrl}`);

  return {
    ...server,
    async close(): Promise<void> {
      if (timer) clearInterval(timer);
      await server.close();
    },
    setPrice: (instId, px) => engine.setPrice(instId, px),
    setMarkPrice: (instId, px) => engine.setMarkPrice(instId, px),
    getState: () => engine.state(),
    tick: () => engine.tick(),
  };
}
