/**
 * Who may talk to the API: the token check is decided on the matched route, and every
 * request (HTTP, the /ws upgrade, unknown paths) is checked for where it comes from.
 */
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import WebSocket from 'ws';
import type { ConnectionStatus } from '@pegasus/shared';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import type { Deps } from '../src/deps.js';
import { AUTH_FAIL_LIMIT, AUTH_FAIL_WINDOW_MS, AuthFailures, buildServer } from '../src/server.js';

const TOKEN = 'test-token';
const WEB = 'http://localhost:5174';
const log = pino({ level: 'silent' });

const fullStatus: ConnectionStatus = {
  okxPublic: 'connected',
  okxPrivate: 'connecting',
  okxBusiness: 'disconnected',
  account: { state: 'error', error: { code: '50105', message: 'Invalid OK-ACCESS-PASSPHRASE.', ts: 5 }, lastSyncAt: 7, readOnly: true },
  demo: false,
  dataAgeMs: 120,
  staleStreams: ['SOL-USDT-SWAP:book'],
};

async function build(env: Record<string, string> = {}, authFailures?: AuthFailures): Promise<FastifyInstance> {
  const config = loadConfig({ API_TOKEN: TOKEN, OKX_DEMO: '0', ...env });
  const hub = { size: 2, connectionStatus: () => fullStatus, attach: (socket: WebSocket) => socket.send('attached') };
  const account = { config: null, balance: null };
  const deps = { config, log, hub, account, store: { kind: 'memory' } } as unknown as Deps;
  return authFailures ? buildServer(deps, authFailures) : buildServer(deps);
}

async function listen(app: FastifyInstance): Promise<number> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

/** One request written by hand, so the request line and the Host header are exactly what the test says. */
function raw(port: number, lines: string[]): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (text += chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve({ status: Number(text.split(' ')[1]), body: text.slice(text.indexOf('\r\n\r\n') + 4) }));
    socket.write(`${[...lines, 'Connection: close'].join('\r\n')}\r\n\r\n`);
  });
}

/** 'open' once the handshake and the hub's first frame went through, otherwise the HTTP status of the refusal. */
function upgrade(port: number, path: string, opts: { origin?: string; host?: string } = {}): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      ...(opts.host !== undefined ? { headers: { host: opts.host } } : {}),
    });
    ws.on('message', () => {
      ws.close();
      resolve('open');
    });
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      resolve(`http:${res.statusCode}`);
    });
    ws.on('error', (err) => resolve(`error:${err.message}`));
  });
}

describe('API access control', () => {
  let app: FastifyInstance;
  let port: number;
  const auth = { authorization: `Bearer ${TOKEN}` };

  beforeAll(async () => {
    app = await build();
    port = await listen(app);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('token', () => {
    it('is required on the matched route, however the path was spelled', async () => {
      for (const url of ['/api/account', '/%61pi/account', '/a%70i/account', '/api/%61ccount', '/api/account?x=1']) {
        const res = await app.inject({ method: 'GET', url });
        expect([url, res.statusCode]).toEqual([url, 401]);
        expect(res.json()).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
      }
      for (const url of ['/%61pi/orders', '/api/orders', '/%61pi/risk/kill-switch']) {
        const res = await app.inject({ method: 'POST', url, payload: {} });
        expect([url, res.statusCode]).toEqual([url, 401]);
      }
    });

    it('is required for an absolute-form request line', async () => {
      const res = await raw(port, [`GET http://127.0.0.1:${port}/api/account HTTP/1.1`, `Host: 127.0.0.1:${port}`]);
      expect(res.status).toBe(401);
      expect(res.body).toContain('UNAUTHORIZED');
      const encoded = await raw(port, [`GET /%61pi/account HTTP/1.1`, `Host: 127.0.0.1:${port}`]);
      expect(encoded.status).toBe(401);
    });

    it('opens the route, and only health and unknown paths answer without it', async () => {
      const withToken = await app.inject({ method: 'GET', url: '/api/account', headers: auth });
      expect(withToken.statusCode).toBe(200);
      expect(withToken.json()).toEqual({ ok: true, data: { config: null, balance: null } });
      expect((await app.inject({ method: 'GET', url: '/%61pi/account', headers: auth })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
      const unknown = await app.inject({ method: 'GET', url: '/api/nope' });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect((await app.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(404);
    });

    it('still guards /ws through its query token', async () => {
      expect(await upgrade(port, '/ws?token=wrong')).toBe('http:401');
      expect(await upgrade(port, '/ws')).toBe('http:401');
      expect(await upgrade(port, `/ws?token=${TOKEN}`)).toBe('open');
    });
  });

  describe('failed token attempts', () => {
    const wrong = { authorization: 'Bearer wrong' };

    it('after AUTH_FAIL_LIMIT wrong tokens the address is refused with 429, the right token included, until the window has passed', async () => {
      let now = 1_700_000_000_000;
      const limited = await build({}, new AuthFailures(AUTH_FAIL_LIMIT, AUTH_FAIL_WINDOW_MS, () => now));
      const limitedPort = await listen(limited);
      for (let i = 0; i < AUTH_FAIL_LIMIT; i++) {
        const res = await limited.inject({ method: 'GET', url: '/api/account', headers: wrong });
        expect([i, res.statusCode]).toEqual([i, 401]);
      }
      const blocked = await limited.inject({ method: 'GET', url: '/api/account', headers: wrong });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toMatchObject({ ok: false, error: { code: 'TOO_MANY_ATTEMPTS' } });
      // guessing right inside the window is not rewarded, on the routes and on the WebSocket upgrade alike
      expect((await limited.inject({ method: 'GET', url: '/api/account', headers: auth })).statusCode).toBe(429);
      expect((await limited.inject({ method: 'POST', url: '/api/orders', headers: auth, payload: {} })).statusCode).toBe(429);
      expect(await upgrade(limitedPort, `/ws?token=${TOKEN}`)).toBe('http:429');
      // what never needed the token is not blocked
      expect((await limited.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
      now += AUTH_FAIL_WINDOW_MS - 1;
      expect((await limited.inject({ method: 'GET', url: '/api/account', headers: auth })).statusCode).toBe(429);
      now += 1;
      expect((await limited.inject({ method: 'GET', url: '/api/account', headers: auth })).statusCode).toBe(200);
      expect(await upgrade(limitedPort, `/ws?token=${TOKEN}`)).toBe('open');
      await limited.close();
    });

    it('a request with the right token clears the count, and a wrong /ws token counts like a wrong header', async () => {
      const limited = await build({}, new AuthFailures(AUTH_FAIL_LIMIT, AUTH_FAIL_WINDOW_MS));
      const limitedPort = await listen(limited);
      for (let i = 0; i < AUTH_FAIL_LIMIT - 1; i++) {
        expect((await limited.inject({ method: 'GET', url: '/api/account', headers: wrong })).statusCode).toBe(401);
      }
      expect((await limited.inject({ method: 'GET', url: '/api/account', headers: auth })).statusCode).toBe(200);
      for (let i = 0; i < AUTH_FAIL_LIMIT - 1; i++) {
        expect(await upgrade(limitedPort, '/ws?token=wrong')).toBe('http:401');
      }
      expect((await limited.inject({ method: 'GET', url: '/api/account', headers: wrong })).statusCode).toBe(401);
      expect((await limited.inject({ method: 'GET', url: '/api/account', headers: wrong })).statusCode).toBe(429);
      expect(await upgrade(limitedPort, '/ws?token=wrong')).toBe('http:429');
      await limited.close();
    });

    it('the shared server of this file is never close to the limit', () => {
      expect(AUTH_FAIL_LIMIT).toBeGreaterThanOrEqual(20);
    });
  });

  describe('CORS', () => {
    it('answers no preflight and grants no origin', async () => {
      const preflight = await app.inject({ method: 'OPTIONS', url: '/api/account', headers: { origin: WEB, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
      expect(preflight.statusCode).toBe(404);
      expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
      const get = await app.inject({ method: 'GET', url: '/api/account', headers: { ...auth, origin: WEB } });
      expect(get.statusCode).toBe(200);
      expect(get.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('Host', () => {
    it('must be this machine', async () => {
      for (const host of ['evil.example', 'evil.example:8787', '127.0.0.1.evil.example', 'localhost.evil.example:5174', '0.0.0.0:8787', '[::2]:8787', '192.168.1.5:8787', '[::1]evil.example', 'localhost:8787:1']) {
        for (const url of ['/api/health', '/api/account', '/nope']) {
          const res = await app.inject({ method: 'GET', url, headers: { ...auth, host } });
          expect([host, url, res.statusCode]).toEqual([host, url, 403]);
          expect(res.json()).toMatchObject({ ok: false, error: { code: 'FORBIDDEN_HOST' } });
        }
      }
    });

    it('is refused when empty', async () => {
      const res = await raw(port, ['GET /api/health HTTP/1.1', 'Host:']);
      expect(res.status).toBe(403);
      expect(res.body).toContain('FORBIDDEN_HOST');
    });

    it('passes for every local spelling, whatever the port', async () => {
      // inject's own default, the Vite /api proxy (changeOrigin), the Vite /ws proxy, IPv6 loopback
      for (const host of ['localhost:80', '127.0.0.1:8787', `127.0.0.1:${port}`, 'localhost:5174', 'LOCALHOST:5174', 'localhost', '127.0.0.1', '[::1]:8787', '[::1]']) {
        const res = await app.inject({ method: 'GET', url: '/api/account', headers: { ...auth, host } });
        expect([host, res.statusCode]).toEqual([host, 200]);
      }
    });

    it('also passes for the configured API host, but never for a wildcard', async () => {
      const lan = await build({ API_HOST: '192.168.1.5' });
      expect((await lan.inject({ method: 'GET', url: '/api/health', headers: { host: '192.168.1.5:8787' } })).statusCode).toBe(200);
      expect((await lan.inject({ method: 'GET', url: '/api/health', headers: { host: '192.168.1.6:8787' } })).statusCode).toBe(403);
      await lan.close();
      const v6 = await build({ API_HOST: 'FD00::1' });
      expect((await v6.inject({ method: 'GET', url: '/api/health', headers: { host: '[fd00::1]:8787' } })).statusCode).toBe(200);
      await v6.close();
      for (const [wildcard, host] of [['0.0.0.0', '0.0.0.0:8787'], ['::', '[::]:8787']] as const) {
        const any = await build({ API_HOST: wildcard });
        expect((await any.inject({ method: 'GET', url: '/api/health', headers: { host } })).statusCode).toBe(403);
        expect((await any.inject({ method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:8787' } })).statusCode).toBe(200);
        await any.close();
      }
    });
  });

  describe('Origin', () => {
    it('must be the terminal page when a browser sends one', async () => {
      for (const origin of ['http://evil.example', 'null', 'http://localhost:5173', 'https://localhost:5174', 'http://localhost:5174.evil.example', `http://127.0.0.1:${port}`, '']) {
        const get = await app.inject({ method: 'GET', url: '/api/account', headers: { ...auth, origin } });
        expect([origin, get.statusCode]).toEqual([origin, 403]);
        expect(get.json()).toMatchObject({ ok: false, error: { code: 'FORBIDDEN_ORIGIN' } });
        const post = await app.inject({ method: 'POST', url: '/api/orders/preview', headers: { ...auth, origin }, payload: {} });
        expect([origin, post.statusCode]).toEqual([origin, 403]);
        const health = await app.inject({ method: 'GET', url: '/api/health', headers: { origin } });
        expect([origin, health.statusCode]).toEqual([origin, 403]);
      }
    });

    it('is refused on the WebSocket upgrade even with the right token', async () => {
      expect(await upgrade(port, `/ws?token=${TOKEN}`, { origin: 'http://evil.example' })).toBe('http:403');
      expect(await upgrade(port, `/ws?token=${TOKEN}`, { origin: 'null' })).toBe('http:403');
      // a page on another site going through the Vite port
      expect(await upgrade(port, `/ws?token=${TOKEN}`, { origin: 'http://evil.example', host: 'localhost:5174' })).toBe('http:403');
      // DNS rebinding: the page's own origin is the attacker's name
      expect(await upgrade(port, `/ws?token=${TOKEN}`, { host: 'evil.example:8787' })).toBe('http:403');
    });

    it('lets the terminal page and non-browser clients through', async () => {
      // proxied /api calls: Host rewritten by the proxy, no Origin on GET, the page's Origin on POST
      expect((await app.inject({ method: 'GET', url: '/api/account', headers: { ...auth, host: '127.0.0.1:8787' } })).statusCode).toBe(200);
      for (const origin of [WEB, 'http://127.0.0.1:5174']) {
        const post = await app.inject({ method: 'POST', url: '/api/orders/preview', headers: { ...auth, host: '127.0.0.1:8787', origin }, payload: {} });
        // past both gates: the empty body is what is refused
        expect([origin, post.statusCode]).toEqual([origin, 400]);
        expect(post.json()).toMatchObject({ error: { code: 'VALIDATION' } });
      }
      // the proxied /ws upgrade keeps the page's Host
      expect(await upgrade(port, `/ws?token=${TOKEN}`, { origin: WEB, host: 'localhost:5174' })).toBe('open');
      // the launcher's probe
      const probe = await raw(port, ['GET /api/health HTTP/1.1', `Host: 127.0.0.1:${port}`]);
      expect(probe.status).toBe(200);
    });

    it('follows WEB_ORIGINS', async () => {
      const other = await build({ WEB_ORIGINS: ' http://localhost:3000 , http://terminal.lan:5174/ ' });
      const get = (origin: string) => other.inject({ method: 'GET', url: '/api/account', headers: { ...auth, origin } });
      expect((await get('http://localhost:3000')).statusCode).toBe(200);
      expect((await get('http://terminal.lan:5174')).statusCode).toBe(200);
      expect((await get(WEB)).statusCode).toBe(403);
      await other.close();
    });
  });

  describe('GET /api/health', () => {
    it('says only whether the server and its three sockets are up', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      const body = res.json() as { serverTime: number };
      expect(body).toEqual({ ok: true, version: 'unknown', demo: false, paper: false, connection: { okxPublic: 'connected', okxPrivate: 'connecting', okxBusiness: 'disconnected' }, serverTime: body.serverTime });
      expect(typeof body.serverTime).toBe('number');
      expect(res.body).not.toMatch(/50105|PASSPHRASE|readOnly|lastSyncAt|SOL-USDT-SWAP/);
    });
  });
});
