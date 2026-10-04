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
