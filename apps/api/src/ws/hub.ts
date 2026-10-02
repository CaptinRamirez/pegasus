import type { WebSocket } from 'ws';
import {
  clientMessageSchema,
  encodeServerMessage,
  type CandleBar,
  type ConnectionStatus,
  type HelloPayload,
  type ServerMessage,
} from '@pegasus/shared';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { AccountService } from '../services/account.js';
import type { MarketDataService } from '../services/market-data.js';
import type { RiskEngine } from '../services/risk-engine.js';

interface ClientCtx {
  socket: WebSocket;
  instId: string | null;
  bar: CandleBar;
  lastSeen: number;
}

const IDLE_MS = 60_000;
const SWEEP_MS = 15_000;

/**
 * Fans market and account updates out to connected terminal clients and
 * handles their subscription requests.
 */
export class Hub {
  private readonly clients = new Set<ClientCtx>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly market: MarketDataService,
    private readonly account: AccountService,
    private readonly risk: RiskEngine,
    private readonly log: Logger,
  ) {}

  get size(): number {
    return this.clients.size;
  }

  /** Subscribe to service events; call once at startup. */
  wire(): void {
    this.market.on('ticker', (t) => this.sendToInstrument(t.instId, { type: 'ticker', data: t }));
    this.market.on('book', (b) => this.sendToInstrument(b.instId, { type: 'book', data: b }));
    this.market.on('trades', (trades) => {
      const instId = trades[0]?.instId;
      if (instId) this.sendToInstrument(instId, { type: 'trades', data: trades });
    });
    this.market.on('markPrice', (m) => this.sendToInstrument(m.instId, { type: 'markPrice', data: m }));
    this.market.on('fundingRate', (f) => this.sendToInstrument(f.instId, { type: 'fundingRate', data: f }));
    this.market.on('candle', (c) => {
      const msg: ServerMessage = { type: 'candle', data: c };
      for (const ctx of this.clients) if (ctx.instId === c.instId && ctx.bar === c.bar) this.send(ctx, msg);
    });
    this.market.on('status', () => this.broadcast({ type: 'connection', data: this.connectionStatus() }));
    this.account.on('order', (o) => this.broadcast({ type: 'order', data: o }));
    this.account.on('fill', (f) => this.broadcast({ type: 'fill', data: f }));
    this.account.on('positions', (p) => this.broadcast({ type: 'positions', data: p }));
    this.account.on('balance', (b) => this.broadcast({ type: 'balance', data: b }));
    this.account.on('status', () => this.broadcast({ type: 'connection', data: this.connectionStatus() }));
    this.risk.on('state', (s) => this.broadcast({ type: 'risk', data: { ...s } }));
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweepTimer.unref();
  }

  connectionStatus(): ConnectionStatus {
    const m = this.market.connection();
    return {
      okxPublic: m.public,
      okxBusiness: m.business,
      okxPrivate: this.account.connection(),
      demo: this.config.okx.demo,
      lastMessageAgeMs: m.lastMessageAgeMs,
    };
  }

  hello(): HelloPayload {
    return {
      demo: this.config.okx.demo,
      instruments: [...this.market.instruments.values()],
      account: this.account.config,
      riskConfig: this.risk.config,
      risk: { ...this.risk.state },
      connection: this.connectionStatus(),
      balance: this.account.balance,
      positions: this.account.positionList(),
      openOrders: this.account.openOrderList(),
      serverTime: Date.now(),
    };
  }

  /** Attach an authenticated socket. */
  attach(socket: WebSocket): void {
    const ctx: ClientCtx = { socket, instId: null, bar: '1m', lastSeen: Date.now() };
    this.clients.add(ctx);
    this.log.info({ clients: this.clients.size }, 'terminal client connected');
    this.send(ctx, { type: 'hello', data: this.hello() });
    socket.on('message', (raw) => {
      ctx.lastSeen = Date.now();
      void this.onMessage(ctx, raw.toString());
    });
    socket.on('close', () => {
      this.clients.delete(ctx);
      if (ctx.instId) void this.market.unsubscribeCandles(ctx.instId, ctx.bar);
      this.log.info({ clients: this.clients.size }, 'terminal client disconnected');
    });
    socket.on('error', (err) => this.log.warn({ err: err.message }, 'terminal client socket error'));
  }

  broadcast(msg: ServerMessage): void {
    if (this.clients.size === 0) return;
    const text = encodeServerMessage(msg);
    for (const ctx of this.clients) this.sendText(ctx, text);
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const ctx of this.clients) ctx.socket.close(1001, 'server shutting down');
    this.clients.clear();
  }

  // ---- internals ----

  private sendToInstrument(instId: string, msg: ServerMessage): void {
    let text: string | null = null;
    for (const ctx of this.clients) {
      if (ctx.instId !== instId) continue;
      text ??= encodeServerMessage(msg);
      this.sendText(ctx, text);
    }
  }

  private send(ctx: ClientCtx, msg: ServerMessage): void {
    this.sendText(ctx, encodeServerMessage(msg));
  }

  private sendText(ctx: ClientCtx, text: string): void {
    if (ctx.socket.readyState !== ctx.socket.OPEN) return;
    // Drop slow consumers rather than buffering unboundedly.
    if (ctx.socket.bufferedAmount > 4 * 1024 * 1024) {
      this.log.warn('terminal client too slow; closing');
      ctx.socket.close(1008, 'slow consumer');
      return;
    }
    ctx.socket.send(text);
  }

  private async onMessage(ctx: ClientCtx, text: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.send(ctx, { type: 'error', data: { code: 'BAD_JSON', message: 'malformed message' } });
      return;
    }
    const result = clientMessageSchema.safeParse(parsed);
    if (!result.success) {
      this.send(ctx, { type: 'error', data: { code: 'VALIDATION', message: result.error.issues.map((i) => i.message).join('; ') } });
      return;
    }
    const msg = result.data;
    switch (msg.type) {
      case 'ping':
        this.send(ctx, { type: 'pong', data: { ts: Date.now() } });
        return;
      case 'subscribe':
        await this.subscribe(ctx, msg.instId, msg.bar ?? ctx.bar);
        return;
      case 'setBar':
        await this.subscribe(ctx, msg.instId, msg.bar);
        return;
      case 'unsubscribe':
        if (ctx.instId === msg.instId) {
          await this.market.unsubscribeCandles(ctx.instId, ctx.bar);
          ctx.instId = null;
        }
        return;
    }
  }

  private async subscribe(ctx: ClientCtx, instId: string, bar: CandleBar): Promise<void> {
    if (!this.market.getInstrument(instId)) {
      this.send(ctx, { type: 'error', data: { code: 'UNKNOWN_INSTRUMENT', message: `instrument ${instId} is not tracked` } });
      return;
    }
    const changed = ctx.instId !== instId || ctx.bar !== bar;
    if (changed) {
      if (ctx.instId) await this.market.unsubscribeCandles(ctx.instId, ctx.bar);
      ctx.instId = instId;
      ctx.bar = bar;
      await this.market.subscribeCandles(instId, bar);
    }
    this.send(ctx, { type: 'subscribed', data: { instId, bar } });
    const ticker = this.market.ticker(instId);
    if (ticker) this.send(ctx, { type: 'ticker', data: ticker });
    const book = this.market.book(instId);
    if (book) this.send(ctx, { type: 'book', data: book });
    const trades = this.market.trades(instId);
    if (trades.length > 0) this.send(ctx, { type: 'trades', data: trades.slice(-60) });
    const mark = this.market.markPrice(instId);
    if (mark) this.send(ctx, { type: 'markPrice', data: mark });
    const funding = this.market.fundingRate(instId);
    if (funding) this.send(ctx, { type: 'fundingRate', data: funding });
  }

  private sweep(): void {
    const cutoff = Date.now() - IDLE_MS;
    for (const ctx of this.clients) {
      if (ctx.lastSeen < cutoff) {
        this.log.info('closing idle terminal client');
        ctx.socket.close(1000, 'idle');
      }
    }
  }
}
