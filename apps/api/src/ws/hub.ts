import type { WebSocket } from 'ws';
import {
  clientMessageSchema,
  encodeServerMessage,
  type CampaignView,
  type CandleBar,
  type ConnectionStatus,
  type HelloPayload,
  type ServerMessage,
  type ServerPush,
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
  /** Answered the last protocol ping, or connected since. */
  alive: boolean;
}

/** Every sweep pings each client and terminates the ones that did not answer the previous ping. */
const SWEEP_MS = 15_000;
/** The connection status is re-sent this often; terminals also read it as proof that the server is alive. */
const STATUS_MS = 5_000;

/**
 * Fans market and account updates out to connected terminal clients and
 * handles their subscription requests.
 */
export class Hub {
  private readonly clients = new Set<ClientCtx>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  /** The campaign's state for a terminal that connects; set while the campaign is enabled. */
  private campaignView: (() => CampaignView) | null = null;

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
    // Tickers go to every client so the instrument list shows prices for all tracked instruments.
    this.market.on('ticker', (t) => this.broadcast({ type: 'ticker', data: t }));
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
    this.account.on('algoOrders', (a) => this.broadcast({ type: 'algoOrders', data: a }));
    this.account.on('balance', (b) => this.broadcast({ type: 'balance', data: b }));
    this.account.on('config', (c) => this.broadcast({ type: 'account', data: c }));
    this.account.on('status', () => this.broadcast({ type: 'connection', data: this.connectionStatus() }));
    this.risk.on('state', (s) => this.broadcast({ type: 'risk', data: { ...s } }));
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweepTimer.unref();
    this.statusTimer = setInterval(() => this.broadcast({ type: 'connection', data: this.connectionStatus() }), STATUS_MS);
    this.statusTimer.unref();
  }

  connectionStatus(): ConnectionStatus {
    const m = this.market.connection();
    return {
      okxPublic: m.public,
      okxBusiness: m.business,
      okxPrivate: this.account.connection(),
      account: this.account.status(),
      demo: this.config.okx.demo,
      dataAgeMs: m.dataAgeMs,
      staleStreams: m.staleStreams,
    };
  }

  hello(): HelloPayload {
    return {
      demo: this.config.okx.demo,
      paper: this.config.okx.paper,
      instruments: [...this.market.instruments.values()],
      account: this.account.config,
      riskConfig: this.risk.config,
      risk: { ...this.risk.state },
      connection: this.connectionStatus(),
      balance: this.account.balance,
      positions: this.account.positionList(),
      openOrders: this.account.openOrderList(),
      algoOrders: this.account.algoOrders,
      serverTime: Date.now(),
    };
  }

  /** While the campaign is enabled: its state goes to every terminal right after `hello` (the `campaign` message). */
  setCampaignView(view: (() => CampaignView) | null): void {
    this.campaignView = view;
  }

  /** Attach an authenticated socket. */
  attach(socket: WebSocket): void {
    const ctx: ClientCtx = { socket, instId: null, bar: '1m', alive: true };
    this.clients.add(ctx);
    this.log.info({ clients: this.clients.size }, 'terminal client connected');
    this.send(ctx, { type: 'hello', data: this.hello() });
    if (this.campaignView) this.send(ctx, { type: 'campaign', data: this.campaignView() });
    for (const instId of this.market.instruments.keys()) {
      const t = this.market.ticker(instId);
      if (t) this.send(ctx, { type: 'ticker', data: t });
    }
    socket.on('message', (raw) => {
      ctx.alive = true;
      void this.onMessage(ctx, raw.toString());
    });
    socket.on('pong', () => {
      ctx.alive = true;
    });
    socket.on('close', () => {
      this.clients.delete(ctx);
      if (ctx.instId) void this.market.unsubscribeCandles(ctx.instId, ctx.bar);
      this.log.info({ clients: this.clients.size }, 'terminal client disconnected');
    });
    socket.on('error', (err) => this.log.warn({ err: err.message }, 'terminal client socket error'));
  }

  broadcast(msg: ServerPush): void {
    if (this.clients.size === 0) return;
    const text = encodeServerMessage(msg);
    for (const ctx of this.clients) this.sendText(ctx, text);
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
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

  private send(ctx: ClientCtx, msg: ServerPush): void {
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
          // ctx changes before the await: the subscribe that follows in the same tick must not see the old instrument and release it again.
          ctx.instId = null;
          await this.market.unsubscribeCandles(msg.instId, ctx.bar);
        }
        return;
    }
  }

  private async subscribe(ctx: ClientCtx, instId: string, bar: CandleBar): Promise<void> {
    if (!this.market.getInstrument(instId)) {
      this.send(ctx, { type: 'error', data: { code: 'UNKNOWN_INSTRUMENT', message: `instrument ${instId} is not tracked` } });
      return;
    }
    if (!this.clients.has(ctx)) return;
    const prevInstId = ctx.instId;
    const prevBar = ctx.bar;
    if (prevInstId !== instId || prevBar !== bar) {
      // ctx and the candle reference counts move together, before any await: the next message of this
      // client and its close handler then always see exactly what it holds.
      ctx.instId = instId;
      ctx.bar = bar;
      const released = prevInstId ? this.market.unsubscribeCandles(prevInstId, prevBar) : null;
      const acquired = this.market.subscribeCandles(instId, bar);
      await Promise.all([released, acquired]);
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

  /**
   * Liveness through the WebSocket protocol's own ping/pong: a browser answers those even for a
   * hidden tab, whose timers (and with them the application-level ping) are throttled to about one a minute.
   */
  private sweep(): void {
    for (const ctx of this.clients) {
      if (!ctx.alive) {
        this.log.info('terminating unresponsive terminal client');
        ctx.socket.terminate();
        continue;
      }
      if (ctx.socket.readyState !== ctx.socket.OPEN) continue;
      ctx.alive = false;
      ctx.socket.ping();
    }
  }
}
