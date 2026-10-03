import { decodeServerMessage, type CandleBar, type ClientMessage, type ServerMessage } from '@pegasus/shared';

export type WsStatus = 'connecting' | 'open' | 'closed';

export interface WsClientOptions {
  token: string;
  onMessage: (msg: ServerMessage) => void;
  onStatus: (status: WsStatus) => void;
  /** Overrides the URL derived from window.location (tests). */
  url?: string;
  pingIntervalMs?: number;
}

export const MIN_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 15_000;

/** Exponential backoff: 1s, 2s, 4s, 8s, 15s, 15s, ... */
export function backoffDelay(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.max(0, attempt));
}

export function wsUrl(token: string, loc: { protocol: string; host: string } = window.location): string {
  const scheme = loc.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${loc.host}/ws?token=${encodeURIComponent(token)}`;
}

interface Subscription {
  instId: string;
  bar: CandleBar | undefined;
}

/**
 * Reconnecting WebSocket client for the /ws endpoint. Remembers the current
 * subscription so it can be re-sent after a reconnect and pings every 15 s.
 */
export class WsClient {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscription: Subscription | null = null;
  private currentStatus: WsStatus = 'closed';

  constructor(private readonly opts: WsClientOptions) {}

  get status(): WsStatus {
    return this.currentStatus;
  }

  connect(): void {
    if (this.stopped || this.socket !== null) return;
    this.clearReconnect();
    this.setStatus('connecting');
    const socket = new WebSocket(this.opts.url ?? wsUrl(this.opts.token));
    this.socket = socket;

    socket.onopen = () => {
      if (socket !== this.socket) return;
      this.attempt = 0;
      this.setStatus('open');
      this.startPing();
      if (this.subscription !== null) this.sendRaw(subscribeMessage(this.subscription));
    };
    socket.onmessage = (ev: MessageEvent) => {
      if (socket !== this.socket || typeof ev.data !== 'string') return;
      let msg: ServerMessage;
      try {
        msg = decodeServerMessage(ev.data);
      } catch {
        return;
      }
      this.opts.onMessage(msg);
    };
    socket.onclose = () => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.stopPing();
      this.setStatus('closed');
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      // the browser always follows an error with a close event; reconnect is scheduled there
    };
  }

  /** Permanently closes the client; it will not reconnect. */
  close(): void {
    this.stopped = true;
    this.clearReconnect();
    this.stopPing();
    const s = this.socket;
    this.socket = null;
    if (s !== null) {
      s.onopen = null;
      s.onmessage = null;
      s.onclose = null;
      s.onerror = null;
      s.close();
    }
    this.setStatus('closed');
  }

  /** Sends a message; returns false when the socket is not open (subscriptions are still remembered). */
  send(msg: ClientMessage): boolean {
    this.remember(msg);
    return this.sendRaw(msg);
  }

  private remember(msg: ClientMessage): void {
    switch (msg.type) {
      case 'subscribe':
        this.subscription = { instId: msg.instId, bar: msg.bar };
        break;
      case 'unsubscribe':
        if (this.subscription?.instId === msg.instId) this.subscription = null;
        break;
      case 'setBar':
        if (this.subscription?.instId === msg.instId) this.subscription = { instId: msg.instId, bar: msg.bar };
        break;
      case 'ping':
        break;
    }
  }

  private sendRaw(msg: ClientMessage): boolean {
    const s = this.socket;
    if (s === null || s.readyState !== WebSocket.OPEN) return false;
    s.send(JSON.stringify(msg));
    return true;
  }

  private setStatus(status: WsStatus): void {
    if (status === this.currentStatus) return;
    this.currentStatus = status;
    this.opts.onStatus(status);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.sendRaw({ type: 'ping' }), this.opts.pingIntervalMs ?? 15_000);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const base = backoffDelay(this.attempt);
    this.attempt += 1;
    const jitter = Math.floor(Math.random() * 250);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, base + jitter);
  }
}

function subscribeMessage(sub: Subscription): ClientMessage {
  return sub.bar === undefined
    ? { type: 'subscribe', instId: sub.instId }
    : { type: 'subscribe', instId: sub.instId, bar: sub.bar };
}
