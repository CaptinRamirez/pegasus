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
  /** The reconnect backoff starts over only after a connection has stayed ready for this long. */
  stableAfterMs?: number;
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
  /** The server refused a subscription. The arg stays registered and is requested again on the next connection. */
  subscribeRejected: [arg: OkxWsArg, code: string | undefined, msg: string | undefined];
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
  private stableTimer: NodeJS.Timeout | null = null;
  private lastMessageAt = 0;
  private readonly desired = new Map<string, OkxWsArg>();
  /** Keys the server has confirmed / refused on the current connection. */
  private readonly confirmed = new Set<string>();
  private readonly rejected = new Set<string>();
  /** An error event arrived on this connection that could not be tied to a login or a pending subscription. */
  private unattributedError = false;
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
      pingIntervalMs: options.pingIntervalMs ?? 15_000,
      idleTimeoutMs: options.idleTimeoutMs ?? 30_000,
      reconnectMinMs: options.reconnectMinMs ?? 1_000,
      reconnectMaxMs: options.reconnectMaxMs ?? 30_000,
      stableAfterMs: options.stableAfterMs ?? 30_000,
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
    this.failPending(new OkxWsError('client closed', undefined, true));
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

  /** Drop the current connection; the normal reconnect path (backoff, login, resubscribe) opens a new one. */
  reconnect(reason: string): void {
    const ws = this.ws;
    if (!ws || this.closing) return;
    this.opts.logger.warn(`${this.opts.name} ws reconnect requested`, { reason });
    ws.terminate();
  }

  /** Register channels; they are (re)subscribed whenever the socket is ready. */
  async subscribe(args: OkxWsArg[]): Promise<void> {
    const fresh: OkxWsArg[] = [];
    for (const arg of args) {
      const key = argKey(arg);
      if (!this.desired.has(key)) {
        this.desired.set(key, arg);
        fresh.push(arg);
      } else if (!this.confirmed.has(key) && !this.pendingSubs.has(key)) {
        // Registered but never confirmed on this connection (ack lost or refused): ask again instead of silently doing nothing.
        fresh.push(arg);
      }
    }
    if (fresh.length === 0) return;
    if (this.readyFlag && this.socketOpen()) {
      for (const arg of fresh) this.rejected.delete(argKey(arg));
      await this.sendSubscribe(fresh);
    }
  }

  private socketOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  async unsubscribe(args: OkxWsArg[]): Promise<void> {
    const present: OkxWsArg[] = [];
    for (const arg of args) {
      const key = argKey(arg);
      if (this.desired.delete(key)) present.push(arg);
      this.confirmed.delete(key);
      this.rejected.delete(key);
    }
    if (present.length === 0 || !this.readyFlag || !this.socketOpen()) return;
    for (let i = 0; i < present.length; i += this.opts.subscribeBatchSize) {
      this.sendRaw({ op: 'unsubscribe', args: present.slice(i, i + this.opts.subscribeBatchSize) });
    }
  }

  /** Send a trade operation (order / cancel-order / amend-order / batch-*) and await its response. */
  /**
   * Send a trade operation (order / cancel-order / amend-order / batch-*) and await its response.
   * Rejects with an OkxWsError whose `sent` flag says whether the frame reached the socket:
   * `sent === false` means the operation can be retried elsewhere; `sent === true` (timeout or
   * socket loss after sending) means the outcome is unknown and must be looked up, never resent blindly.
   */
  request<T = unknown>(op: string, args: unknown[], opts: { timeoutMs?: number } = {}): Promise<OkxWsOpResponse<T>> {
    if (!this.readyFlag || !this.socketOpen()) return Promise.reject(new OkxWsError(`${this.opts.name} socket not ready`, undefined, false));
    const id = `${Date.now().toString(36)}${(++this.opSeq).toString(36)}`.slice(-32);
    return new Promise<OkxWsOpResponse<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOps.delete(id);
        reject(new OkxWsError(`${op} timed out after ${opts.timeoutMs ?? this.opts.ackTimeoutMs}ms`, undefined, true));
      }, opts.timeoutMs ?? this.opts.ackTimeoutMs);
      this.pendingOps.set(id, { resolve: (r) => resolve(r as OkxWsOpResponse<T>), reject, timer });
      try {
        this.sendRaw({ id, op, args });
      } catch (err) {
        clearTimeout(timer);
        this.pendingOps.delete(id);
        reject(new OkxWsError((err as Error).message, undefined, false));
      }
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
    this.resetSession();
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
      this.resetSession();
      this.clearTimers();
      this.failPending(new OkxWsError(`${this.opts.name} socket closed (${code})`, undefined, true));
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
      // A connection that drops again right away must keep backing off, so the attempt counter survives until this one has proven stable.
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null;
        this.reconnectAttempt = 0;
      }, this.opts.stableAfterMs);
      this.stableTimer.unref();
      const all = [...this.desired.values()];
      if (all.length > 0) void this.resubscribe(ws, all);
      this.emit('ready');
    } catch (err) {
      this.opts.logger.error(`${this.opts.name} post-connect setup failed`, { error: (err as Error).message });
      this.emit('error', err as Error);
      ws.terminate();
    }
  }

  private resetSession(): void {
    this.confirmed.clear();
    this.rejected.clear();
    this.unattributedError = false;
  }

  /** Desired args the server has neither confirmed nor refused and that are not awaiting an ack right now. */
  private unconfirmed(): OkxWsArg[] {
    const out: OkxWsArg[] = [];
    for (const [key, arg] of this.desired) {
      if (!this.confirmed.has(key) && !this.rejected.has(key) && !this.pendingSubs.has(key)) out.push(arg);
    }
    return out;
  }

  /**
   * Re-request every desired channel on a new connection. Args the server never
   * acknowledges are sent once more; if some are still missing after that the socket
   * is terminated so the reconnect path (with its backoff) starts a clean session.
   * An explicit refusal is reported through `subscribeRejected` and never causes a reconnect.
   */
  private async resubscribe(ws: WebSocket, args: OkxWsArg[]): Promise<void> {
    for (let resent = false; ; resent = true) {
      if (this.ws !== ws || !this.socketOpen()) return;
      // Settled means every ack has arrived, been refused or timed out.
      await Promise.allSettled(this.subscribeWaits(args));
      if (this.ws !== ws || !this.socketOpen()) return;
      const missing = this.unconfirmed();
      if (missing.length === 0) return;
      const channels = missing.map(argKey);
      if (resent) {
        if (this.unattributedError) {
          // The exchange answered with an error we could not match to an arg: reconnecting would only repeat it.
          this.opts.logger.warn(`${this.opts.name} subscriptions not acknowledged after an exchange error; not reconnecting`, { channels });
          return;
        }
        this.opts.logger.warn(`${this.opts.name} subscriptions still unacknowledged after a re-send; reconnecting`, { channels });
        ws.terminate();
        return;
      }
      this.opts.logger.warn(`${this.opts.name} subscriptions not acknowledged; sending them again`, { channels });
      args = missing;
    }
  }

  /** Mark the desired arg a server message refers to as confirmed. Private channels echo extra fields such as `uid`. */
  private confirm(arg: OkxWsArg): void {
    const key = argKey(arg);
    if (this.desired.has(key)) {
      this.confirmed.add(key);
      return;
    }
    for (const [k, want] of this.desired) {
      if (Object.keys(want).every((f) => want[f] === undefined || want[f] === arg[f])) this.confirmed.add(k);
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
      this.sendRaw({ op: 'login', args: [wsLoginArgs(creds, Date.now() + this.opts.clockOffsetMs())] }, true);
    });
  }

  /**
   * Send subscribe frames and resolve once every arg is acknowledged. Every promise
   * registered in pendingSubs gets a handler before anything can reject it, so a
   * socket closing mid-call can never surface as an unhandled rejection.
   */
  private sendSubscribe(args: OkxWsArg[]): Promise<void> {
    if (!this.socketOpen()) return Promise.reject(new OkxWsError(`${this.opts.name} socket not open`));
    return Promise.all(this.subscribeWaits(args)).then(() => undefined);
  }

  /** One promise per arg, settled by its ack, its refusal, the ack timeout or the socket closing. */
  private subscribeWaits(args: OkxWsArg[]): Promise<void>[] {
    const waits: Promise<void>[] = [];
    for (let i = 0; i < args.length; i += this.opts.subscribeBatchSize) {
      const batch = args.slice(i, i + this.opts.subscribeBatchSize);
      const created: string[] = [];
      for (const arg of batch) {
        const key = argKey(arg);
        const p = new Promise<void>((resolve, reject) => {
          // A previous waiter for the same key is settled together with this one instead of dangling.
          const existing = this.pendingSubs.get(key);
          if (existing) clearTimeout(existing.timer);
          const timer = setTimeout(() => {
            this.pendingSubs.delete(key);
            const err = new OkxWsError(`subscribe ${key} not acknowledged within ${this.opts.ackTimeoutMs}ms`);
            existing?.reject(err);
            reject(err);
          }, this.opts.ackTimeoutMs);
          this.pendingSubs.set(key, {
            resolve: () => {
              existing?.resolve();
              resolve();
            },
            reject: (e) => {
              existing?.reject(e);
              reject(e);
            },
            timer,
          });
        });
        p.catch(() => undefined); // handled: callers observe the outcome through Promise.all below
        waits.push(p);
        created.push(key);
      }
      try {
        this.sendRaw({ op: 'subscribe', args: batch });
      } catch (err) {
        for (const key of created) {
          const entry = this.pendingSubs.get(key);
          if (!entry) continue;
          clearTimeout(entry.timer);
          this.pendingSubs.delete(key);
          entry.reject(err as Error);
        }
        return waits;
      }
    }
    return waits;
  }

  private sendRaw(payload: unknown, secret = false): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new OkxWsError(`${this.opts.name} socket not open`);
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    // The login frame carries the API key and the plaintext passphrase: only its op reaches the log.
    const shown = secret ? '{"op":"login"}' : text.length > 500 ? `${text.slice(0, 500)}…` : text;
    this.opts.logger.debug(`${this.opts.name} ws send`, { text: shown });
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
      // Data flowing on a channel proves the subscription is live even if its ack was lost.
      if (this.confirmed.size < this.desired.size) this.confirm(msg.arg);
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
          this.confirm(msg.arg);
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
        // The arg stays desired: it is not asked again on this connection but is on the next one.
        let matched = false;
        for (const [key, p] of this.pendingSubs) {
          const arg = this.desired.get(key);
          if (arg && msg.msg && (msg.msg.includes(arg.channel) && (arg.instId === undefined || msg.msg.includes(arg.instId)))) {
            matched = true;
            clearTimeout(p.timer);
            this.pendingSubs.delete(key);
            this.rejected.add(key);
            p.reject(new OkxWsError(`subscribe rejected: ${detail}`, msg.code));
            this.emit('subscribeRejected', arg, msg.code, msg.msg);
          }
        }
        if (!matched) this.unattributedError = true;
        return;
      }
      case 'notice':
        // e.g. 64008: the exchange is about to close this connection for an upgrade.
        this.opts.logger.warn(`${this.opts.name} ws notice`, { code: msg.code, msg: msg.msg });
        return;
      case 'channel-conn-count-error':
        this.opts.logger.warn(`${this.opts.name} ws channel-conn-count-error`, { code: msg.code, msg: msg.msg, channel: msg.channel, connCount: msg.connCount });
        return;
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
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = null;
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
