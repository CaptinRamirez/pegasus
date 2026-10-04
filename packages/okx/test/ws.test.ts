import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { OkxWsClient, type OkxWsData, type OkxWsLogger } from '../src/index.js';

interface ServerState {
  wss: WebSocketServer;
  url: string;
  sockets: WebSocket[];
  received: unknown[];
  logins: unknown[];
}

function startServer(): Promise<ServerState> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    const state: ServerState = { wss, url: '', sockets: [], received: [], logins: [] };
    wss.on('connection', (socket) => {
      state.sockets.push(socket);
      socket.on('message', (raw) => {
        const text = raw.toString();
        if (text === 'ping') {
          socket.send('pong');
          return;
        }
        const msg = JSON.parse(text) as { op: string; args: Array<Record<string, string>>; id?: string };
        state.received.push(msg);
        if (msg.op === 'login') {
          state.logins.push(msg.args[0]);
          socket.send(JSON.stringify({ event: 'login', code: '0', msg: '', connId: 'c1' }));
        } else if (msg.op === 'subscribe') {
          for (const arg of msg.args) {
            socket.send(JSON.stringify({ event: 'subscribe', arg, connId: 'c1' }));
            socket.send(JSON.stringify({ arg, data: [{ instId: arg['instId'], last: '1' }] }));
          }
        } else if (msg.op === 'order') {
          socket.send(JSON.stringify({ id: msg.id, op: 'order', code: '0', msg: '', data: [{ ordId: '42', clOrdId: 'x', sCode: '0', sMsg: '' }] }));
        }
      });
    });
    wss.on('listening', () => {
      const { port } = wss.address() as AddressInfo;
      state.url = `ws://127.0.0.1:${port}`;
      resolve(state);
    });
  });
}

describe('OkxWsClient', () => {
  let server: ServerState;
  let client: OkxWsClient | null = null;

  beforeEach(async () => {
    server = await startServer();
  });

  afterEach(async () => {
    if (client) await client.close();
    client = null;
    await new Promise<void>((resolve) => server.wss.close(() => resolve()));
  });

  it('logs in, subscribes and receives data', async () => {
    client = new OkxWsClient({ url: server.url, name: 'private', credentials: { apiKey: 'k', apiSecret: 's', passphrase: 'p' }, ackTimeoutMs: 2000 });
    const ready = once(client, 'ready');
    client.connect();
    await ready;
    expect(server.logins).toHaveLength(1);
    expect(server.logins[0]).toMatchObject({ apiKey: 'k', passphrase: 'p' });
    const dataP = once(client, 'data');
    await client.subscribe([{ channel: 'tickers', instId: 'BTC-USDT-SWAP' }]);
    const [msg] = (await dataP) as [OkxWsData];
    expect(msg.arg).toEqual({ channel: 'tickers', instId: 'BTC-USDT-SWAP' });
    expect(msg.data[0]).toMatchObject({ instId: 'BTC-USDT-SWAP' });
  });

  it('never writes the login frame to the log: only its op', async () => {
    const lines: string[] = [];
    const capture = (msg: string, meta?: Record<string, unknown>): void => void lines.push(`${msg} ${JSON.stringify(meta ?? {})}`);
    const creds = { apiKey: 'key-0123456789', apiSecret: 'secret-abcdef', passphrase: 'Passphrase#42' };
    client = new OkxWsClient({ url: server.url, name: 'private', credentials: creds, ackTimeoutMs: 2000, logger: { debug: capture, info: capture, warn: capture, error: capture } });
    const ready = once(client, 'ready');
    client.connect();
    await ready;
    await client.subscribe([{ channel: 'orders', instType: 'SWAP' }]);
    // the frame itself still carries them
    expect(server.logins[0]).toMatchObject({ apiKey: creds.apiKey, passphrase: creds.passphrase });
    const log = lines.join('\n');
    expect(log).toContain('private ws send {"text":"{\\"op\\":\\"login\\"}"}');
    expect(log).toContain('\\"op\\":\\"subscribe\\"');
    expect(log).not.toContain(creds.apiKey);
    expect(log).not.toContain(creds.passphrase);
    expect(log).not.toContain(creds.apiSecret);
    expect(log).not.toMatch(/sign/);
  });

  it('round-trips trade operations by id', async () => {
    client = new OkxWsClient({ url: server.url, name: 'private', ackTimeoutMs: 2000 });
    const ready = once(client, 'ready');
    client.connect();
    await ready;
    const res = await client.request<{ ordId: string }>('order', [{ instId: 'BTC-USDT-SWAP' }]);
    expect(res.code).toBe('0');
    expect(res.data[0]?.ordId).toBe('42');
  });

  it('reconnects and resubscribes after the server drops the socket', async () => {
    client = new OkxWsClient({ url: server.url, name: 'public', reconnectMinMs: 50, reconnectMaxMs: 100, ackTimeoutMs: 2000 });
    const ready = once(client, 'ready');
    client.connect();
    await ready;
    await client.subscribe([{ channel: 'trades', instId: 'ETH-USDT-SWAP' }]);
    const subsBefore = server.received.filter((m) => (m as { op: string }).op === 'subscribe').length;
    expect(subsBefore).toBe(1);
    const readyAgain = once(client, 'ready');
    server.sockets[0]?.terminate();
    await readyAgain;
    // wait for the resubscribe to be acknowledged
    await new Promise((r) => setTimeout(r, 100));
    const subsAfter = server.received.filter((m) => (m as { op: string }).op === 'subscribe');
    expect(subsAfter).toHaveLength(2);
    expect(client.subscriptions).toEqual([{ channel: 'trades', instId: 'ETH-USDT-SWAP' }]);
    expect(server.sockets).toHaveLength(2);
  });

  it('reconnect() drops the connection and comes back with its subscriptions', async () => {
    client = new OkxWsClient({ url: server.url, name: 'public', reconnectMinMs: 50, reconnectMaxMs: 100, ackTimeoutMs: 2000 });
    const ready = once(client, 'ready');
    client.connect();
    await ready;
    await client.subscribe([{ channel: 'mark-price', instId: 'ETH-USDT-SWAP' }]);
    const statuses: string[] = [];
    client.on('status', (s) => statuses.push(s));
    const readyAgain = once(client, 'ready');
    client.reconnect('test');
    await readyAgain;
    await new Promise((r) => setTimeout(r, 100));
    expect(statuses).toEqual(['disconnected', 'connecting', 'connected']);
    expect(server.sockets).toHaveLength(2);
    expect(server.received.filter((m) => (m as { op: string }).op === 'subscribe')).toHaveLength(2);
  });

  it('terminates an idle connection and reconnects', async () => {
    // Server that never answers pings
    server.wss.removeAllListeners('connection');
    let connections = 0;
    server.wss.on('connection', () => {
      connections++;
    });
    client = new OkxWsClient({ url: server.url, name: 'public', pingIntervalMs: 30, idleTimeoutMs: 60, reconnectMinMs: 20, reconnectMaxMs: 40 });
    client.connect();
    await new Promise((r) => setTimeout(r, 400));
    expect(connections).toBeGreaterThanOrEqual(2);
  });
});

describe('OkxWsClient failure semantics', () => {
  it('rejects never-sent requests with sent=false and in-flight ones with sent=true', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(wss, 'listening');
    const { port } = wss.address() as AddressInfo;
    const sockets: WebSocket[] = [];
    wss.on('connection', (s) => {
      sockets.push(s);
      s.on('message', (raw) => {
        if (raw.toString() === 'ping') s.send('pong');
        // never answer ops
      });
    });
    const client = new OkxWsClient({ url: `ws://127.0.0.1:${port}`, name: 'private', ackTimeoutMs: 300, reconnectMinMs: 50, reconnectMaxMs: 60 });
    const notReady = await client.request('order', []).catch((e: unknown) => e);
    expect(notReady).toMatchObject({ name: 'OkxWsError', sent: false });
    client.connect();
    await once(client, 'ready');
    const timedOut = await client.request('order', [{}], { timeoutMs: 100 }).catch((e: unknown) => e);
    expect(timedOut).toMatchObject({ name: 'OkxWsError', sent: true });
    const inflight = client.request('order', [{}], { timeoutMs: 5000 }).catch((e: unknown) => e);
    sockets[0]?.terminate();
    expect(await inflight).toMatchObject({ name: 'OkxWsError', sent: true });
    await client.close();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('does not leave unhandled rejections when the socket closes during a subscribe', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(wss, 'listening');
    const { port } = wss.address() as AddressInfo;
    const sockets: WebSocket[] = [];
    wss.on('connection', (s) => {
      sockets.push(s);
      s.on('message', (raw) => {
        if (raw.toString() === 'ping') s.send('pong');
      });
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    const client = new OkxWsClient({ url: `ws://127.0.0.1:${port}`, name: 'public', ackTimeoutMs: 200, reconnectMinMs: 50, reconnectMaxMs: 60 });
    client.connect();
    await once(client, 'ready');
    // Subscribe while the server never acks, then drop the socket: the pending subs are rejected.
    const sub = client.subscribe([{ channel: 'tickers', instId: 'A' }, { channel: 'tickers', instId: 'B' }]).catch((e: unknown) => e);
    sockets[0]?.terminate();
    const err = await sub;
    expect(err).toMatchObject({ name: 'OkxWsError' });
    await new Promise((r) => setTimeout(r, 300));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toHaveLength(0);
    // the desired set survives for the resubscribe after reconnect
    expect(client.subscriptions).toHaveLength(2);
    await client.close();
    await new Promise<void>((r) => wss.close(() => r()));
  });
});

type Arg = Record<string, string>;

interface ScriptedConn {
  socket: WebSocket;
  /** args of every subscribe frame received on this connection, in order */
  subscribes: Arg[][];
}

/** Server whose reaction to each subscribe arg is scripted by the test: 'ack', 'ignore' or an error event to send. */
async function startScripted(react: (arg: Arg, conn: number) => 'ack' | 'ignore' | { code: string; msg: string }): Promise<{ wss: WebSocketServer; url: string; conns: ScriptedConn[] }> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const conns: ScriptedConn[] = [];
  wss.on('connection', (socket) => {
    const index = conns.length;
    const conn: ScriptedConn = { socket, subscribes: [] };
    conns.push(conn);
    socket.on('message', (raw) => {
      const text = raw.toString();
      if (text === 'ping') {
        socket.send('pong');
        return;
      }
      const msg = JSON.parse(text) as { op: string; args: Arg[] };
      if (msg.op !== 'subscribe') return;
      conn.subscribes.push(msg.args);
      for (const arg of msg.args) {
        const r = react(arg, index);
        if (r === 'ack') socket.send(JSON.stringify({ event: 'subscribe', arg, connId: 'c1' }));
        else if (r !== 'ignore') socket.send(JSON.stringify({ event: 'error', code: r.code, msg: r.msg, connId: 'c1' }));
      }
    });
  });
  return { wss, url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, conns };
}

async function waitUntil(fn: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function recordingLogger(): { logger: OkxWsLogger; warnings: Array<{ msg: string; meta: Record<string, unknown> | undefined }> } {
  const warnings: Array<{ msg: string; meta: Record<string, unknown> | undefined }> = [];
  return { warnings, logger: { debug() {}, info() {}, error() {}, warn: (msg, meta) => void warnings.push({ msg, meta }) } };
}

/** The delays the client announces before each reconnect, in ms: what it decided, independent of how fast this machine runs. */
function recordingDelays(): { logger: OkxWsLogger; delays: number[] } {
  const delays: number[] = [];
  const info = (msg: string): void => {
    const m = /reconnecting in (\d+)ms/.exec(msg);
    if (m) delays.push(Number(m[1]));
  };
  return { delays, logger: { debug() {}, info, warn() {}, error() {} } };
}

describe('OkxWsClient subscription recovery', () => {
  const A = { channel: 'tickers', instId: 'A' };
  const B = { channel: 'trades', instId: 'B' };
  let wss: WebSocketServer | null = null;
  let client: OkxWsClient | null = null;

  afterEach(async () => {
    if (client) await client.close();
    client = null;
    const s = wss;
    wss = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  });

  it('re-sends a resubscription that was never acknowledged once, then reconnects for a clean session', async () => {
    // The first connection never acknowledges B; later ones behave.
    const server = await startScripted((arg, conn) => (conn === 0 && arg['channel'] === 'trades' ? 'ignore' : 'ack'));
    wss = server.wss;
    const { logger, warnings } = recordingLogger();
    client = new OkxWsClient({ url: server.url, name: 'public', ackTimeoutMs: 80, reconnectMinMs: 20, reconnectMaxMs: 40, logger });
    await client.subscribe([A, B]);
    client.connect();
    await waitUntil(() => server.conns.length === 2 && (server.conns[1]?.subscribes.length ?? 0) > 0, 'reconnect after the unacknowledged subscription');
    // exactly one re-send, and only of the arg that was not confirmed
    expect(server.conns[0]?.subscribes).toEqual([[A, B], [B]]);
    expect(warnings.some((w) => /still unacknowledged/.test(w.msg))).toBe(true);
    // the clean session is acknowledged in full and left alone
    await new Promise((r) => setTimeout(r, 300));
    expect(server.conns).toHaveLength(2);
    expect(server.conns[1]?.subscribes).toEqual([[A, B]]);
    expect(client.subscriptions).toEqual([A, B]);
  });

  it('keeps an explicitly rejected subscription, reports it and does not reconnect because of it', async () => {
    const reject = { code: '60018', msg: "Wrong URL or channel:trades,instId:B doesn't exist. Please use the correct URL, channel and parameters referring to API document." };
    const server = await startScripted((arg) => (arg['channel'] === 'trades' ? reject : 'ack'));
    wss = server.wss;
    client = new OkxWsClient({ url: server.url, name: 'public', ackTimeoutMs: 80, reconnectMinMs: 20, reconnectMaxMs: 40 });
    const rejected: Array<[unknown, unknown, unknown]> = [];
    client.on('subscribeRejected', (arg, code, msg) => rejected.push([arg, code, msg]));
    await client.subscribe([A, B]);
    client.connect();
    await waitUntil(() => rejected.length > 0, 'subscribeRejected event');
    expect(rejected[0]).toEqual([B, '60018', reject.msg]);
    await new Promise((r) => setTimeout(r, 300)); // well past two ack timeouts
    expect(server.conns).toHaveLength(1);
    expect(server.conns[0]?.subscribes).toEqual([[A, B]]);
    // not silently dropped: still desired, so it is requested again on the next connection
    expect(client.subscriptions).toEqual([A, B]);
    server.conns[0]?.socket.terminate();
    await waitUntil(() => (server.conns[1]?.subscribes.length ?? 0) > 0, 'resubscribe on the next connection');
    expect(server.conns[1]?.subscribes[0]).toEqual([A, B]);
  });

  it('rejects the caller of subscribe() when the exchange refuses the channel', async () => {
    const server = await startScripted((arg) => (arg['channel'] === 'trades' ? { code: '60018', msg: 'Wrong URL or channel:trades,instId:B' } : 'ack'));
    wss = server.wss;
    client = new OkxWsClient({ url: server.url, name: 'public', ackTimeoutMs: 80 });
    client.connect();
    await once(client, 'ready');
    const err = await client.subscribe([B]).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'OkxWsError', code: '60018' });
    expect(client.subscriptions).toEqual([B]);
  });

  it('subscribe() sends again a desired key that was never confirmed', async () => {
    let answer: 'ack' | 'ignore' = 'ignore';
    const server = await startScripted(() => answer);
    wss = server.wss;
    client = new OkxWsClient({ url: server.url, name: 'public', ackTimeoutMs: 80 });
    client.connect();
    await once(client, 'ready');
    const first = await client.subscribe([A]).catch((e: unknown) => e);
    expect(first).toMatchObject({ name: 'OkxWsError' });
    answer = 'ack';
    await client.subscribe([A]);
    expect(server.conns[0]?.subscribes).toEqual([[A], [A]]);
    // confirmed now: asking again is a no-op
    await client.subscribe([A]);
    expect(server.conns[0]?.subscribes).toHaveLength(2);
    expect(server.conns).toHaveLength(1);
  });

  it('logs notice and channel-conn-count-error events at warn', async () => {
    const server = await startScripted(() => 'ack');
    wss = server.wss;
    const { logger, warnings } = recordingLogger();
    client = new OkxWsClient({ url: server.url, name: 'private', logger });
    client.connect();
    await once(client, 'ready');
    server.conns[0]?.socket.send(JSON.stringify({ event: 'notice', code: '64008', msg: 'The connection will soon be closed for a service upgrade. Please reconnect.', connId: 'c1' }));
    server.conns[0]?.socket.send(JSON.stringify({ event: 'channel-conn-count-error', channel: 'orders', connCount: '20', connId: 'c1' }));
    await waitUntil(() => warnings.length >= 2, 'both warnings');
    expect(warnings[0]).toMatchObject({ msg: 'private ws notice', meta: { code: '64008' } });
    expect(String(warnings[0]?.meta?.['msg'])).toMatch(/service upgrade/);
    expect(warnings[1]).toMatchObject({ msg: 'private ws channel-conn-count-error', meta: { channel: 'orders', connCount: '20' } });
  });

  it('keeps backing off while connections drop before they have been stable', async () => {
    // Every connection is accepted and dropped right away.
    const flap = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(flap, 'listening');
    wss = flap;
    flap.on('connection', (socket) => {
      setTimeout(() => socket.terminate(), 5);
    });
    const { logger, delays } = recordingDelays();
    client = new OkxWsClient({ url: `ws://127.0.0.1:${(flap.address() as AddressInfo).port}`, name: 'public', reconnectMinMs: 20, reconnectMaxMs: 5_000, logger });
    client.connect();
    await waitUntil(() => delays.length >= 5, 'five reconnects');
    // 20, 40, 80, 160, 320 ms, each ±20 %
    for (const [i, delay] of delays.slice(0, 5).entries()) {
      expect(delay).toBeGreaterThanOrEqual(Math.floor(20 * 2 ** i * 0.8));
      expect(delay).toBeLessThanOrEqual(Math.ceil(20 * 2 ** i * 1.2));
    }
  });

  it('starts from the minimum delay again once a connection has been stable', async () => {
    const flap = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(flap, 'listening');
    wss = flap;
    // Each connection lives 150 ms, well past the 20 ms it needs to count as stable.
    flap.on('connection', (socket) => {
      setTimeout(() => socket.terminate(), 150);
    });
    const { logger, delays } = recordingDelays();
    client = new OkxWsClient({ url: `ws://127.0.0.1:${(flap.address() as AddressInfo).port}`, name: 'public', reconnectMinMs: 20, reconnectMaxMs: 5_000, stableAfterMs: 20, logger });
    client.connect();
    await waitUntil(() => delays.length >= 4, 'four reconnects');
    // a growing backoff would announce 20, 40, 80, 160 ms
    for (const delay of delays.slice(0, 4)) expect(delay).toBeLessThanOrEqual(24);
  });
});
