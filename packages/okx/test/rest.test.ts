import { once } from 'node:events';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { OkxApiError, OkxRestClient, OkxTransportError } from '../src/index.js';

describe('OkxRestClient transport failures', () => {
  let server: Server | null = null;
  const open: ServerResponse[] = [];

  async function listen(handler: (res: ServerResponse) => void): Promise<string> {
    server = createServer((_req, res) => {
      open.push(res);
      handler(res);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    for (const res of open.splice(0)) res.destroy();
    const s = server;
    server = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  it('times out a response whose body stalls after the headers', async () => {
    const baseUrl = await listen((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"code":"0",'); // headers and a first chunk, then silence
    });
    const rest = new OkxRestClient({ baseUrl, timeoutMs: 150 });
    const err = await rest.getTime().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OkxTransportError);
    expect(err).not.toBeInstanceOf(OkxApiError);
    expect(err).toMatchObject({ name: 'OkxTransportError', timedOut: true, requestPath: '/api/v5/public/time' });
    expect((err as Error).message).toMatch(/did not answer within 150 ms/);
  }, 5_000);

  it('times out when no response arrives at all', async () => {
    const baseUrl = await listen(() => undefined);
    const rest = new OkxRestClient({ baseUrl, timeoutMs: 100 });
    const err = await rest.getTime().catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'OkxTransportError', timedOut: true });
  }, 5_000);

  it('reports a network failure as a transport error with a plain message', async () => {
    const baseUrl = await listen(() => undefined);
    const s = server;
    server = null;
    await new Promise<void>((resolve) => s?.close(() => resolve())); // nothing listens on that port any more
    const rest = new OkxRestClient({ baseUrl, timeoutMs: 2_000 });
    const err = await rest.getTime().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OkxTransportError);
    expect(err).toMatchObject({ timedOut: false, requestPath: '/api/v5/public/time' });
    expect((err as Error).message).toMatch(/could not reach OKX/);
    expect((err as Error).message).not.toMatch(/fetch failed/);
  }, 5_000);

  it('still parses a complete response', async () => {
    const baseUrl = await listen((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: '0', msg: '', data: [{ ts: '1700000000000' }] }));
    });
    const rest = new OkxRestClient({ baseUrl, timeoutMs: 2_000 });
    expect(await rest.getTime()).toBe(1700000000000);
  });
});

describe('OkxRestClient with a separate private base URL (paper trading)', () => {
  const servers: Server[] = [];
  const seen: Array<{ server: string; method: string; url: string; signed: boolean }> = [];

  async function listen(name: string, reply: unknown): Promise<string> {
    const server = createServer((req, res) => {
      seen.push({ server: name, method: req.method ?? '', url: req.url ?? '', signed: req.headers['ok-access-sign'] !== undefined });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    seen.length = 0;
    for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  it('sends market data requests to the base URL and everything signed to the private one', async () => {
    const market = await listen('market', { code: '0', msg: '', data: [{ ts: '1700000000000' }] });
    const account = await listen('account', { code: '0', msg: '', data: [{ ordId: '1', clOrdId: 'c1', tag: '', sCode: '0', sMsg: '' }] });
    const rest = new OkxRestClient({ baseUrl: market, privateBaseUrl: `${account}/`, credentials: { apiKey: 'paper', apiSecret: 'paper', passphrase: 'paper' } });
    await rest.getTime();
    await rest.getMarkPriceCandles('BTC-USDT-SWAP', '1m', { after: 1700000060000, limit: 1 });
    await rest.placeOrder({ instId: 'BTC-USDT-SWAP', tdMode: 'cross', side: 'buy', ordType: 'market', sz: '1' });
    await rest.getOrdersPending({ instType: 'SWAP' });
    expect(seen).toEqual([
      { server: 'market', method: 'GET', url: '/api/v5/public/time', signed: false },
      { server: 'market', method: 'GET', url: '/api/v5/market/mark-price-candles?instId=BTC-USDT-SWAP&bar=1m&after=1700000060000&limit=1', signed: false },
      { server: 'account', method: 'POST', url: '/api/v5/trade/order', signed: true },
      { server: 'account', method: 'GET', url: '/api/v5/trade/orders-pending?instType=SWAP', signed: true },
    ]);
  });

  it('without one, everything goes to the base URL as before', async () => {
    const only = await listen('okx', { code: '0', msg: '', data: [] });
    const rest = new OkxRestClient({ baseUrl: only, credentials: { apiKey: 'k', apiSecret: 's', passphrase: 'p' } });
    await rest.getOrdersPending();
    await rest.getHistoryMarkPriceCandles('BTC-USDT-SWAP', '1m');
    expect(seen.map((s) => [s.server, s.signed])).toEqual([['okx', true], ['okx', false]]);
  });
});
