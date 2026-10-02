import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { OkxWsError } from './errors.js';
import { wsLoginArgs, type OkxCredentials } from './sign.js';
import { isWsData, isWsEvent, isWsOpResponse, type OkxWsArg, type OkxWsData, type OkxWsEvent, type OkxWsMessage, type OkxWsOpResponse } from './types.js';

export type OkxWsStatus = 'connecting' | 'connected' | 'disconnected';

export interface OkxWsLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface OkxWsClientOptions {
  url: string;
  /** Label used in logs, e.g. 'public' | 'private' | 'business' */
  name: string;
  /** When provided the client logs in after every (re)connect before subscribing. */
  credentials?: OkxCredentials | undefined;
  pingIntervalMs?: number;
  /** Terminate and reconnect when nothing (not even pong) arrived for this long. */
  idleTimeoutMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** Timeout for login / subscribe / trade-op acknowledgements. */
  ackTimeoutMs?: number;
  logger?: OkxWsLogger;
  clockOffsetMs?: () => number;
  /** Max subscription args per subscribe message. */
  subscribeBatchSize?: number;
}

export interface OkxWsClientEvents {
  status: [status: OkxWsStatus, detail?: string];
  /** Connected, logged in (when private) and all desired subscriptions re-sent. */
  ready: [];
  data: [msg: OkxWsData];
  event: [msg: OkxWsEvent];
  error: [err: Error];
  /** Emitted when the server confirms a subscription (after a resubscribe too). */
  subscribed: [arg: OkxWsArg];
}

interface PendingOp {
  resolve: (r: OkxWsOpResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingSub {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export function argKey(arg: OkxWsArg): string {
  const keys = Object.keys(arg).filter((k) => arg[k] !== undefined).sort();
  return keys.map((k) => `${k}=${arg[k] as string}`).join('&');
}

const noopLogger: OkxWsLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * One OKX WebSocket connection with automatic login, keepalive, reconnect
 * and resubscription. Public, private and business endpoints each get their
 * own instance.
 */
export class OkxWsClient extends EventEmitter<OkxWsClientEvents> {
  private readonly opts: Required<Omit<OkxWsClientOptions, 'credentials' | 'logger' | 'clockOffsetMs'>> & {
    credentials: OkxCredentials | undefined;
    logger: OkxWsLogger;
    clockOffsetMs: () => number;
  };
  private ws: WebSocket | null = null;
  private status: OkxWsStatus = 'disconnected';
  private closing = false;
  private loggedIn = false;
  private readyFlag = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastMessageAt = 0;
  private readonly desired = new Map<string, OkxWsArg>();
  private readonly pendingSubs = new Map<string, PendingSub>();
  private readonly pendingOps = new Map<string, PendingOp>();
  private loginWaiter: { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private opSeq = 0;

  constructor(options: OkxWsClientOptions) {
    super();
    this.opts = {
      url: options.url,
      name: options.name,
      credentials: options.credentials,
      pingIntervalMs: options.pingIntervalMs ?? 20_000,
      idleTimeoutMs: options.idleTimeoutMs ?? 35_000,
      reconnectMinMs: options.reconnectMinMs ?? 1_000,
      reconnectMaxMs: options.reconnectMaxMs ?? 30_000,
      ackTimeoutMs: options.ackTimeoutMs ?? 10_000,
      logger: options.logger ?? noopLogger,
      clockOffsetMs: options.clockOffsetMs ?? (() => 0),
      subscribeBatchSize: options.subscribeBatchSize ?? 10,
    };
  }

  get currentStatus(): OkxWsStatus {
    return this.status;
  }

  get isReady(): boolean {
    return this.readyFlag;
  }

  get lastMessageAgeMs(): number {
    return this.lastMessageAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - this.lastMessageAt;
  }

  get subscriptions(): OkxWsArg[] {
    return [...this.desired.values()];
  }

  connect(): void {
    this.closing = false;
    if (this.ws) return;
    this.open();
  }

  async close(): Promise<void> {
    this.closing = true;
    this.clearTimers();
    this.failPending(new OkxWsError('client closed'));
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        ws.once('close', done);
        try {
          ws.close(1000, 'bye');
        } catch {
          ws.terminate();
        }
        setTimeout(() => {
          ws.terminate();
          done();
        }, 1_000).unref();
      });
    }
    this.setStatus('disconnected', 'closed by client');
  }

  /** Register channels; they are (re)subscribed whenever the socket is ready. */
  async subscribe(args: OkxWsArg[]): Promise<void> {
    const fresh: OkxWsArg[] = [];
    for (const arg of args) {
      const key = argKey(arg);
      if (!this.desired.has(key)) {
        this.desired.set(key, arg);
        fresh.push(arg);
      }
    }
    if (fresh.length === 0) return;
    if (this.readyFlag) await this.sendSubscribe(fresh);
  }

  async unsubscribe(args: OkxWsArg[]): Promise<void> {
    const present: OkxWsArg[] = [];
    for (const arg of args) {
      const key = argKey(arg);
      if (this.desired.delete(key)) present.push(arg);
    }
    if (present.length === 0 || !this.readyFlag) return;
    for (let i = 0; i < present.length; i += this.opts.subscribeBatchSize) {
      this.sendRaw({ op: 'unsubscribe', args: present.slice(i, i + this.opts.subscribeBatchSize) });
    }
  }

  /** Send a trade operation (order / cancel-order / amend-order / batch-*) and await its response. */
  request<T = unknown>(op: string, args: unknown[], opts: { timeoutMs?: number } = {}): Promise<OkxWsOpResponse<T>> {
    if (!this.readyFlag) return Promise.reject(new OkxWsError(`${this.opts.name} socket not ready`));
    const id = `${Date.now().toString(36)}${(++this.opSeq).toString(36)}`.slice(-32);
    return new Promise<OkxWsOpResponse<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOps.delete(id);
        reject(new OkxWsError(`${op} timed out after ${opts.timeoutMs ?? this.opts.ackTimeoutMs}ms`));
      }, opts.timeoutMs ?? this.opts.ackTimeoutMs);
      this.pendingOps.set(id, { resolve: (r) => resolve(r as OkxWsOpResponse<T>), reject, timer });
      this.sendRaw({ id, op, args });
    });
  }

  // ---- internals ----

  private setStatus(status: OkxWsStatus, detail?: string): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status, detail);
  }

  private open(): void {
    this.setStatus('connecting');
    this.loggedIn = false;
    this.readyFlag = false;
    const ws = new WebSocket(this.opts.url, { handshakeTimeout: 10_000 });
    this.ws = ws;
    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.opts.logger.info(`${this.opts.name} ws connected`, { url: this.opts.url });
      this.lastMessageAt = Date.now();
      this.setStatus('connected');
      this.startPing();
      void this.afterOpen(ws);
    });
    ws.on('message', (raw) => {
      if (this.ws !== ws) return;
      this.lastMessageAt = Date.now();
      this.handleRaw(raw.toString());
    });
    ws.on('error', (err) => {
      if (this.ws !== ws) return;
      this.opts.logger.warn(`${this.opts.name} ws error`, { error: err.message });
      this.emit('error', err);
    });
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.readyFlag = false;
      this.loggedIn = false;
      this.clearTimers();
      this.failPending(new OkxWsError(`${this.opts.name} socket closed (${code})`));
      this.setStatus('disconnected', `${code} ${reason.toString()}`);
      this.opts.logger.warn(`${this.opts.name} ws closed`, { code, reason: reason.toString() });
      if (!this.closing) this.scheduleReconnect();
    });
  }

  private async afterOpen(ws: WebSocket): Promise<void> {
    try {
      if (this.opts.credentials) await this.login();
      if (this.ws !== ws) return;
      this.readyFlag = true;
      this.reconnectAttempt = 0;
      const all = [...this.desired.values()];
      if (all.length > 0) {
        this.sendSubscribe(all).catch((err: Error) => this.opts.logger.warn(`${this.opts.name} resubscribe failed`, { error: err.message }));
      }
      this.emit('ready');
    } catch (err) {
      this.opts.logger.error(`${this.opts.name} post-connect setup failed`, { error: (err as Error).message });
      this.emit('error', err as Error);
      ws.terminate();
    }
  }

  private login(): Promise<void> {
    const creds = this.opts.credentials;
    if (!creds) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.loginWaiter = null;
        reject(new OkxWsError('login timed out'));
      }, this.opts.ackTimeoutMs);
      this.loginWaiter = { resolve, reject, timer };
      this.sendRaw({ op: 'login', args: [wsLoginArgs(creds, Date.now() + this.opts.clockOffsetMs())] });
    });
  }

  private sendSubscribe(args: OkxWsArg[]): Promise<void> {
    const waits: Promise<void>[] = [];
    for (let i = 0; i < args.length; i += this.opts.subscribeBatchSize) {
      const batch = args.slice(i, i + this.opts.subscribeBatchSize);
      for (const arg of batch) {
        const key = argKey(arg);
        waits.push(
          new Promise<void>((resolve, reject) => {
            const existing = this.pendingSubs.get(key);
            if (existing) clearTimeout(existing.timer);
            const timer = setTimeout(() => {
              this.pendingSubs.delete(key);
              reject(new OkxWsError(`subscribe ${key} not acknowledged within ${this.opts.ackTimeoutMs}ms`));
            }, this.opts.ackTimeoutMs);
            this.pendingSubs.set(key, { resolve, reject, timer });
          }),
        );
      }
      this.sendRaw({ op: 'subscribe', args: batch });
    }
    return Promise.all(waits).then(() => undefined);
  }

  private sendRaw(payload: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new OkxWsError(`${this.opts.name} socket not open`);
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.opts.logger.debug(`${this.opts.name} ws send`, { text: text.length > 500 ? `${text.slice(0, 500)}…` : text });
    ws.send(text);
  }

  private handleRaw(text: string): void {
    if (text === 'pong') return;
    let msg: OkxWsMessage;
    try {
      msg = JSON.parse(text) as OkxWsMessage;
    } catch {
      this.opts.logger.warn(`${this.opts.name} ws non-JSON message`, { text: text.slice(0, 200) });
      return;
    }
    if (isWsOpResponse(msg)) {
      const pending = this.pendingOps.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingOps.delete(msg.id);
        pending.resolve(msg);
      }
      return;
    }
    if (isWsEvent(msg)) {
      this.handleEvent(msg);
      this.emit('event', msg);
      return;
    }
    if (isWsData(msg)) {
      this.emit('data', msg);
      return;
    }
    this.opts.logger.debug(`${this.opts.name} ws unrecognised message`, { text: text.slice(0, 200) });
  }

  private handleEvent(msg: OkxWsEvent): void {
    switch (msg.event) {
      case 'login': {
        const w = this.loginWaiter;
        this.loginWaiter = null;
        if (w) clearTimeout(w.timer);
        if (msg.code === undefined || msg.code === '0') {
          this.loggedIn = true;
          w?.resolve();
        } else {
          w?.reject(new OkxWsError(`login failed: ${msg.msg ?? ''}`, msg.code));
        }
        return;
      }
      case 'subscribe': {
        if (msg.arg) {
          const key = argKey(msg.arg);
          const p = this.pendingSubs.get(key);
          if (p) {
            clearTimeout(p.timer);
            this.pendingSubs.delete(key);
            p.resolve();
          }
          this.emit('subscribed', msg.arg);
        }
        return;
      }
      case 'error': {
        const detail = `${msg.code ?? ''} ${msg.msg ?? ''}`.trim();
        this.opts.logger.warn(`${this.opts.name} ws error event`, { code: msg.code, msg: msg.msg });
        if (this.loginWaiter) {
          const w = this.loginWaiter;
          this.loginWaiter = null;
          clearTimeout(w.timer);
          w.reject(new OkxWsError(`login rejected: ${detail}`, msg.code));
          return;
        }
        // Subscription errors echo the offending request inside msg; fail matching pending subs.
        for (const [key, p] of this.pendingSubs) {
          const arg = this.desired.get(key);
          if (arg && msg.msg && (msg.msg.includes(arg.channel) && (arg.instId === undefined || msg.msg.includes(arg.instId)))) {
            clearTimeout(p.timer);
            this.pendingSubs.delete(key);
            this.desired.delete(key);
            p.reject(new OkxWsError(`subscribe rejected: ${detail}`, msg.code));
          }
        }
        return;
      }
      default:
        return;
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastMessageAt > this.opts.idleTimeoutMs) {
        this.opts.logger.warn(`${this.opts.name} ws idle for ${this.opts.idleTimeoutMs}ms, reconnecting`);
        ws.terminate();
        return;
      }
      try {
        ws.send('ping');
      } catch (err) {
        this.opts.logger.warn(`${this.opts.name} ping failed`, { error: (err as Error).message });
      }
    }, this.opts.pingIntervalMs);
    this.pingTimer.unref();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private clearTimers(): void {
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closing) return;
    const delay = Math.min(this.opts.reconnectMaxMs, this.opts.reconnectMinMs * 2 ** this.reconnectAttempt) * (0.8 + Math.random() * 0.4);
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 10);
    this.opts.logger.info(`${this.opts.name} ws reconnecting in ${Math.round(delay)}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closing && !this.ws) this.open();
    }, delay);
  }

  private failPending(err: Error): void {
    for (const [, p] of this.pendingOps) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pendingOps.clear();
    for (const [, p] of this.pendingSubs) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pendingSubs.clear();
    if (this.loginWaiter) {
      clearTimeout(this.loginWaiter.timer);
      this.loginWaiter.reject(err);
      this.loginWaiter = null;
    }
  }
}
