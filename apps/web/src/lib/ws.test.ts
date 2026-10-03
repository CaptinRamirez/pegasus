import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@pegasus/shared';
import { MAX_BACKOFF_MS, WsClient, backoffDelay, wsUrl, type WsStatus } from './ws';

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  drop(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
  receive(msg: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const last = (): FakeSocket => {
  const s = FakeSocket.instances[FakeSocket.instances.length - 1];
  if (s === undefined) throw new Error('no socket');
  return s;
};

describe('backoffDelay', () => {
  it('grows exponentially from 1s and caps at 15s', () => {
    expect(backoffDelay(0)).toBe(1_000);
    expect(backoffDelay(1)).toBe(2_000);
    expect(backoffDelay(2)).toBe(4_000);
    expect(backoffDelay(3)).toBe(8_000);
    expect(backoffDelay(4)).toBe(MAX_BACKOFF_MS);
    expect(backoffDelay(20)).toBe(MAX_BACKOFF_MS);
  });
});

describe('wsUrl', () => {
  it('derives ws/wss from the page location and encodes the token', () => {
    expect(wsUrl('a b', { protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/ws?token=a%20b');
    expect(wsUrl('t', { protocol: 'https:', host: 'pegasus.example' })).toBe('wss://pegasus.example/ws?token=t');
  });
});

describe('WsClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function make() {
    const messages: ServerMessage[] = [];
    const statuses: WsStatus[] = [];
    const client = new WsClient({
      token: 'tok',
      url: 'ws://test/ws?token=tok',
      onMessage: (m) => messages.push(m),
      onStatus: (s) => statuses.push(s),
    });
    return { client, messages, statuses };
  }

  it('decodes messages, pings every 15s and reports status', () => {
    const { client, messages, statuses } = make();
    client.connect();
    expect(statuses).toEqual(['connecting']);
    last().open();
    expect(statuses).toEqual(['connecting', 'open']);
    last().receive({ type: 'pong', data: { ts: 1 } });
    expect(messages).toEqual([{ type: 'pong', data: { ts: 1 } }]);
    vi.advanceTimersByTime(15_000);
    expect(last().sent).toContain(JSON.stringify({ type: 'ping' }));
    client.close();
    expect(statuses[statuses.length - 1]).toBe('closed');
  });

  it('remembers the subscription and re-sends it after reconnecting with backoff', () => {
    const { client } = make();
    client.connect();
    expect(client.send({ type: 'subscribe', instId: 'BTC-USDT-SWAP', bar: '1m' })).toBe(false);
    const first = last();
    first.open();
    expect(first.sent).toEqual([JSON.stringify({ type: 'subscribe', instId: 'BTC-USDT-SWAP', bar: '1m' })]);

    client.send({ type: 'setBar', instId: 'BTC-USDT-SWAP', bar: '5m' });
    first.drop();
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(300);
    expect(FakeSocket.instances).toHaveLength(2);
    const second = last();
    second.open();
    expect(second.sent).toEqual([JSON.stringify({ type: 'subscribe', instId: 'BTC-USDT-SWAP', bar: '5m' })]);

    // a successful open resets the backoff: the next drop reconnects after ~1s again
    second.drop();
    vi.advanceTimersByTime(1_300);
    expect(FakeSocket.instances).toHaveLength(3);
    // a connection that never opens doubles the delay: ~2s, then ~4s
    last().drop();
    vi.advanceTimersByTime(1_500);
    expect(FakeSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.instances).toHaveLength(4);
    last().drop();
    vi.advanceTimersByTime(3_000);
    expect(FakeSocket.instances).toHaveLength(4);
    vi.advanceTimersByTime(1_500);
    expect(FakeSocket.instances).toHaveLength(5);
    client.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(5);
  });

  it('forgets the subscription after unsubscribe', () => {
    const { client } = make();
    client.connect();
    client.send({ type: 'subscribe', instId: 'ETH-USDT-SWAP' });
    client.send({ type: 'unsubscribe', instId: 'ETH-USDT-SWAP' });
    last().open();
    expect(last().sent).toEqual([]);
    client.close();
  });
});
