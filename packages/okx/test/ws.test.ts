import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { OkxWsClient, type OkxWsData } from '../src/index.js';

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
