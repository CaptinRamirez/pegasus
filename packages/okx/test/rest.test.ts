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

describe('OkxRestClient margin of an isolated position', () => {
  let server: Server | null = null;
  const seen: Array<{ method: string; url: string; signed: boolean; body: unknown }> = [];

  async function listen(reply: unknown): Promise<OkxRestClient> {
    server = createServer((req, res) => {
      let text = '';
      req.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', signed: req.headers['ok-access-sign'] !== undefined, body: JSON.parse(text) as unknown });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return new OkxRestClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, credentials: { apiKey: 'k', apiSecret: 's', passphrase: 'p' } });
  }

  afterEach(async () => {
    seen.length = 0;
    const s = server;
    server = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  it('posts the adjustment signed, with the position side, and returns the row OKX answers with', async () => {
    const row = { instId: 'BTC-USDT-SWAP', posSide: 'net', amt: '22.5', type: 'add', leverage: '10', ccy: 'USDT' };
    const rest = await listen({ code: '0', msg: '', data: [row] });
    expect(await rest.adjustMargin({ instId: 'BTC-USDT-SWAP', posSide: 'net', type: 'add', amt: '22.5' })).toEqual(row);
    expect(seen).toEqual([{ method: 'POST', url: '/api/v5/account/position/margin-balance', signed: true, body: { instId: 'BTC-USDT-SWAP', posSide: 'net', type: 'add', amt: '22.5' } }]);
  });

  it('a refusal is an OkxApiError with the code of the exchange; an answer without a row is one too', async () => {
    const refused = await listen({ code: '59301', msg: 'Margin adjustment failed for exceeding the max limit.', data: [] });
    const err = await refused.adjustMargin({ instId: 'BTC-USDT-SWAP', posSide: 'long', type: 'reduce', amt: '5' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OkxApiError);
    expect(err).toMatchObject({ code: '59301', okxMessage: 'Margin adjustment failed for exceeding the max limit.', isOutcomeUnknown: false });
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const empty = await listen({ code: '0', msg: '', data: [] });
    await expect(empty.adjustMargin({ instId: 'BTC-USDT-SWAP', posSide: 'net', type: 'add', amt: '1' })).rejects.toMatchObject({ code: 'EMPTY' });
  });
});

describe('OkxRestClient algo orders: take-profits, trailing stops, batch cancel', () => {
  let server: Server | null = null;
  const seen: Array<{ method: string; url: string; signed: boolean; body: unknown }> = [];

  async function listen(reply: (url: string) => unknown): Promise<OkxRestClient> {
    server = createServer((req, res) => {
      let text = '';
      req.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', signed: req.headers['ok-access-sign'] !== undefined, body: text === '' ? undefined : (JSON.parse(text) as unknown) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply(req.url ?? '')));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return new OkxRestClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, credentials: { apiKey: 'k', apiSecret: 's', passphrase: 'p' } });
  }

  afterEach(async () => {
    seen.length = 0;
    const s = server;
    server = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  it('places a trailing stop and a take-profit with exactly the fields given, signed', async () => {
    const rest = await listen(() => ({ code: '0', msg: '', data: [{ algoId: '9', algoClOrdId: 'trx', sCode: '0', sMsg: '' }] }));
    await rest.placeAlgoOrder({ instId: 'BTC-USDT-SWAP', tdMode: 'cross', side: 'sell', ordType: 'move_order_stop', sz: '10', callbackRatio: '0.05', activePx: '61000', reduceOnly: true, algoClOrdId: 'trx' });
    await rest.placeAlgoOrder({ instId: 'BTC-USDT-SWAP', tdMode: 'cross', side: 'sell', posSide: 'long', ordType: 'conditional', sz: '4', tpTriggerPx: '65000', tpOrdPx: '-1', tpTriggerPxType: 'mark' });
    expect(seen).toEqual([
      { method: 'POST', url: '/api/v5/trade/order-algo', signed: true, body: { instId: 'BTC-USDT-SWAP', tdMode: 'cross', side: 'sell', ordType: 'move_order_stop', sz: '10', callbackRatio: '0.05', activePx: '61000', reduceOnly: true, algoClOrdId: 'trx' } },
      { method: 'POST', url: '/api/v5/trade/order-algo', signed: true, body: { instId: 'BTC-USDT-SWAP', tdMode: 'cross', side: 'sell', posSide: 'long', ordType: 'conditional', sz: '4', tpTriggerPx: '65000', tpOrdPx: '-1', tpTriggerPxType: 'mark' } },
    ]);
  });

  it('a refused algo order is an OkxApiError with the per-item code', async () => {
    const rest = await listen(() => ({ code: '1', msg: '', data: [{ algoId: '', sCode: '51257', sMsg: 'Trailing stop order callback rate error.' }] }));
    const err = await rest.placeAlgoOrder({ instId: 'BTC-USDT-SWAP', tdMode: 'cross', side: 'sell', ordType: 'move_order_stop', sz: '1', callbackRatio: '2' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OkxApiError);
    expect(err).toMatchObject({ code: '51257', okxMessage: 'Trailing stop order callback rate error.' });
  });

  it('reads the trailing stops on their own and amends a take-profit trigger', async () => {
    const rest = await listen((url) =>
      url.startsWith('/api/v5/trade/orders-algo-pending')
        ? { code: '0', msg: '', data: [{ algoId: '9', ordType: 'move_order_stop', callbackRatio: '0.05', moveTriggerPx: '57000' }] }
        : { code: '0', msg: '', data: [{ algoId: '7', sCode: '0', sMsg: '' }] },
    );
    const rows = await rest.getAlgoOrdersPending({ ordType: 'move_order_stop', instType: 'SWAP', limit: 100 });
    expect(rows).toMatchObject([{ algoId: '9', callbackRatio: '0.05', moveTriggerPx: '57000' }]);
    await rest.amendAlgoOrder({ instId: 'BTC-USDT-SWAP', algoId: '7', newTpTriggerPx: '66000' });
    expect(seen.map((s) => [s.method, s.url, s.body])).toEqual([
      ['GET', '/api/v5/trade/orders-algo-pending?ordType=move_order_stop&instType=SWAP&limit=100', undefined],
      ['POST', '/api/v5/trade/amend-algos', { instId: 'BTC-USDT-SWAP', algoId: '7', newTpTriggerPx: '66000' }],
    ]);
  });

  it('cancels several algo orders in one call and returns every item, the refused ones included', async () => {
    const rest = await listen(() => ({ code: '2', msg: 'Bulk operation partially succeeded.', data: [{ algoId: '1', sCode: '0', sMsg: '' }, { algoId: '2', sCode: '51400', sMsg: 'does not exist' }] }));
    const acks = await rest.cancelAlgoOrders([{ instId: 'BTC-USDT-SWAP', algoId: '1' }, { instId: 'BTC-USDT-SWAP', algoId: '2' }]);
    expect(acks.map((a) => a.sCode)).toEqual(['0', '51400']);
    expect(seen[0]?.body).toEqual([{ instId: 'BTC-USDT-SWAP', algoId: '1' }, { instId: 'BTC-USDT-SWAP', algoId: '2' }]);
    // more than the endpoint takes is refused before anything is sent
    expect(() => rest.cancelAlgoOrders(Array.from({ length: 11 }, (_, i) => ({ instId: 'BTC-USDT-SWAP', algoId: String(i) })))).toThrow(OkxApiError);
    expect(seen).toHaveLength(1);
  });
});
