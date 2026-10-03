import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyWsLogin } from './auth.js';
import type { Engine } from './engine/engine.js';
import { MOCK_UID } from './engine/engine.js';
import type { MockCredentials } from './types.js';
import { candleBar, checkArg, endpointOfPath, isPrivateChannel, parseArg, subKey, type Endpoint } from './ws-channels.js';
import type { OkxOrderAck, OkxWsArg } from './wire.js';

interface Conn {
  ws: WebSocket;
  endpoint: Endpoint;
  connId: string;
  loggedIn: boolean;
  subs: Map<string, OkxWsArg>;
}

const TRADE_OPS: ReadonlySet<string> = new Set(['order', 'batch-orders', 'cancel-order', 'batch-cancel-orders', 'amend-order', 'batch-amend-orders']);
const FUNDING_PUSH_EVERY = 40;

/** OKX-style WebSocket endpoints (public/private/business) sharing the HTTP server. */
export class MockWsServer {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly conns = new Set<Conn>();
  private readonly index = new Map<string, Set<Conn>>();
  private readonly offEngine: Array<() => void> = [];
  private readonly fundingCounter = new Map<string, number>();
  private readonly onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

  constructor(
    private readonly engine: Engine,
    private readonly server: Server,
    private readonly creds: MockCredentials | undefined,
    private readonly log: (msg: string) => void,
  ) {
    this.onUpgrade = (req, socket, head) => this.upgrade(req, socket, head);
    server.on('upgrade', this.onUpgrade);
    this.wireEngine();
  }

  async close(): Promise<void> {
    this.server.off('upgrade', this.onUpgrade);
    for (const off of this.offEngine) off();
    for (const c of this.conns) c.ws.terminate();
    this.conns.clear();
    this.index.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://mock');
    const endpoint = endpointOfPath(url.pathname);
    if (!endpoint) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const conn: Conn = { ws, endpoint, connId: randomBytes(4).toString('hex'), loggedIn: false, subs: new Map() };
      this.conns.add(conn);
      ws.on('message', (raw) => this.onMessage(conn, raw.toString()));
      ws.on('close', () => this.drop(conn));
      ws.on('error', (err) => this.log(`ws ${endpoint} error: ${err.message}`));
    });
  }

  private drop(conn: Conn): void {
    this.conns.delete(conn);
    for (const key of conn.subs.keys()) this.index.get(key)?.delete(conn);
  }

  private send(conn: Conn, payload: unknown): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  private broadcast(key: string, build: () => unknown): void {
    const set = this.index.get(key);
    if (!set || set.size === 0) return;
    const text = JSON.stringify(build());
    for (const c of set) this.send(c, text);
  }

  private onMessage(conn: Conn, text: string): void {
    if (text === 'ping') {
      this.send(conn, 'pong');
      return;
    }
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      msg = parsed as Record<string, unknown>;
    } catch {
      this.send(conn, { event: 'error', code: '60012', msg: `Illegal request: ${text.slice(0, 100)}`, connId: conn.connId });
      return;
    }
    const op = msg['op'];
    const args = Array.isArray(msg['args']) ? (msg['args'] as unknown[]) : [];
    switch (op) {
      case 'login':
        return this.login(conn, args);
      case 'subscribe':
        return this.subscribe(conn, args);
      case 'unsubscribe':
        return this.unsubscribe(conn, args);
      default:
        if (typeof op === 'string' && TRADE_OPS.has(op)) return this.tradeOp(conn, typeof msg['id'] === 'string' ? msg['id'] : '', op, args);
        this.send(conn, { event: 'error', code: '60012', msg: `Illegal request: ${text.slice(0, 100)}`, connId: conn.connId });
    }
  }

  private login(conn: Conn, args: unknown[]): void {
    const arg = typeof args[0] === 'object' && args[0] !== null ? (args[0] as Record<string, unknown>) : {};
    const authErr = this.creds ? verifyWsLogin(this.creds, arg) : null;
    if (authErr) {
      this.send(conn, { event: 'error', code: authErr.code, msg: authErr.msg, connId: conn.connId });
      return;
    }
    conn.loggedIn = true;
    this.send(conn, { event: 'login', code: '0', msg: '', connId: conn.connId });
  }

  private subscribe(conn: Conn, args: unknown[]): void {
    for (const raw of args) {
      const arg = parseArg(raw);
      if (!arg) {
        this.send(conn, { event: 'error', code: '60012', msg: 'Illegal request', connId: conn.connId });
        continue;
      }
      if (isPrivateChannel(arg.channel) && !conn.loggedIn) {
        this.send(conn, { event: 'error', code: '60011', msg: 'Please log in', connId: conn.connId });
        continue;
      }
      const check = checkArg(conn.endpoint, arg, this.engine);
      if (!check.ok) {
        this.send(conn, { event: 'error', code: check.code, msg: check.msg, connId: conn.connId });
        continue;
      }
      conn.subs.set(check.key, check.arg);
      let set = this.index.get(check.key);
      if (!set) {
        set = new Set();
        this.index.set(check.key, set);
      }
      set.add(conn);
      this.send(conn, { event: 'subscribe', arg, connId: conn.connId });
      this.initialPush(conn, check.arg);
    }
  }

  private unsubscribe(conn: Conn, args: unknown[]): void {
    for (const raw of args) {
      const arg = parseArg(raw);
      if (!arg) continue;
      const check = checkArg(conn.endpoint, arg, this.engine);
      if (check.ok) {
        conn.subs.delete(check.key);
        this.index.get(check.key)?.delete(conn);
      }
      this.send(conn, { event: 'unsubscribe', arg, connId: conn.connId });
    }
  }

  private privateArg(arg: OkxWsArg): OkxWsArg {
    return { ...arg, uid: MOCK_UID };
  }

  /** Current state sent right after a subscription is acknowledged. */
  private initialPush(conn: Conn, arg: OkxWsArg): void {
    const e = this.engine;
    const instId = arg.instId ?? '';
    const market = e.markets.get(instId);
    switch (arg.channel) {
      case 'tickers': {
        const t = e.ticker(instId);
        if (t) this.send(conn, { arg, data: [t] });
        return;
      }
      case 'books':
        if (market) this.send(conn, { arg, action: 'snapshot', data: [market.book.snapshot(e.now())] });
        return;
      case 'books5':
      case 'bbo-tbt':
        if (market) this.send(conn, { arg, data: [this.topOfBook(instId, arg.channel === 'books5' ? 5 : 1)] });
        return;
      case 'mark-price':
        this.send(conn, { arg, data: e.markPrices(instId) });
        return;
      case 'funding-rate': {
        const f = e.fundingRate(instId);
        if (f) this.send(conn, { arg, data: [f] });
        return;
      }
      case 'instruments':
        this.send(conn, { arg, data: arg.instType === 'SWAP' ? e.instrumentList() : [] });
        return;
      case 'positions':
        this.send(conn, { arg: this.privateArg(arg), data: e.positions() });
        return;
      case 'account':
        this.send(conn, { arg: this.privateArg(arg), data: [e.balance()] });
        return;
      case 'balance_and_position':
        this.send(conn, { arg: this.privateArg(arg), data: [this.balanceAndPosition('snapshot')] });
        return;
      default: {
        const bar = candleBar(arg.channel);
        const row = bar ? market?.candles.get(bar)?.liveRow() : null;
        if (row) this.send(conn, { arg, data: [row] });
      }
    }
  }

  private topOfBook(instId: string, depth: number): unknown {
    const market = this.engine.markets.get(instId);
    if (!market) return {};
    const { asks, bids } = market.book.levels(depth);
    return { asks, bids, ts: String(this.engine.now()), seqId: market.book.seqId };
  }

  private balanceAndPosition(eventType: string): unknown {
    const e = this.engine;
    const b = e.balance();
    const now = String(e.now());
    return {
      pTime: now,
      eventType,
      balData: [{ ccy: 'USDT', cashBal: b.details[0]?.cashBal ?? '0', uTime: now }],
      posData: e.positions().map((p) => ({
        posId: p.posId,
        tradeId: p.tradeId,
        instId: p.instId,
        instType: p.instType,
        mgnMode: p.mgnMode,
        posSide: p.posSide,
        pos: p.pos,
        ccy: p.ccy,
        posCcy: '',
        avgPx: p.avgPx,
        uTime: p.uTime,
      })),
    };
  }

  private tradeOp(conn: Conn, id: string, op: string, args: unknown[]): void {
    const respond = (code: string, msg: string, data: unknown[]): void => {
      const t = String(Date.now() * 1000);
      this.send(conn, { id, op, code, msg, data, inTime: t, outTime: t });
    };
    if (conn.endpoint !== 'private') return respond('60012', 'Illegal request', []);
    if (!conn.loggedIn) return respond('60011', 'Please log in', []);
    const m = this.engine.matcher;
    const fn: (item: unknown) => OkxOrderAck = op.includes('cancel') ? (i) => m.cancelRequest(i) : op.includes('amend') ? (i) => m.amendRequest(i) : (i) => m.place(i);
    const batch = op.startsWith('batch-');
    if (args.length === 0 || (!batch && args.length !== 1) || args.length > 20) return respond('60012', 'Illegal request: bad args', []);
    const acks = args.map((item) => fn(item));
    const failed = acks.filter((a) => a.sCode !== '0').length;
    if (failed === 0) return respond('0', '', acks);
    if (failed === acks.length) return respond('1', batch ? 'All operations failed' : 'Operation failed.', acks);
    return respond('2', 'Bulk operation partially succeeded.', acks);
  }

  private wireEngine(): void {
    const e = this.engine;
    this.offEngine.push(
      e.on('tick', ({ instId }) => {
        this.broadcast(subKey('tickers', instId), () => ({ arg: { channel: 'tickers', instId }, data: [e.ticker(instId)] }));
        this.broadcast(subKey('books5', instId), () => ({ arg: { channel: 'books5', instId }, data: [this.topOfBook(instId, 5)] }));
        this.broadcast(subKey('bbo-tbt', instId), () => ({ arg: { channel: 'bbo-tbt', instId }, data: [this.topOfBook(instId, 1)] }));
        this.broadcast(subKey('mark-price', instId), () => ({ arg: { channel: 'mark-price', instId }, data: e.markPrices(instId) }));
        const n = (this.fundingCounter.get(instId) ?? 0) + 1;
        this.fundingCounter.set(instId, n % FUNDING_PUSH_EVERY);
        if (n % FUNDING_PUSH_EVERY === 0) this.broadcast(subKey('funding-rate', instId), () => ({ arg: { channel: 'funding-rate', instId }, data: [e.fundingRate(instId)] }));
      }),
      e.on('books', ({ instId, push }) => this.broadcast(subKey('books', instId), () => ({ arg: { channel: 'books', instId }, action: 'update', data: [push] }))),
      e.on('trades', ({ instId, trades }) => {
        if (trades.length > 0) this.broadcast(subKey('trades', instId), () => ({ arg: { channel: 'trades', instId }, data: trades }));
      }),
      e.on('candles', ({ instId, candles }) => {
        for (const c of candles) {
          const channel = `candle${c.bar}`;
          if (c.closed) this.broadcast(subKey(channel, instId), () => ({ arg: { channel, instId }, data: [c.closed] }));
          this.broadcast(subKey(channel, instId), () => ({ arg: { channel, instId }, data: [c.live] }));
        }
      }),
      e.on('order', (order) => {
        for (const instType of ['SWAP', 'ANY']) {
          this.broadcast(subKey('orders', instType), () => ({ arg: { channel: 'orders', instType, uid: MOCK_UID }, data: [order] }));
        }
      }),
      e.on('positions', ({ positions }) => {
        for (const instType of ['SWAP', 'ANY']) {
          this.broadcast(subKey('positions', instType), () => ({ arg: { channel: 'positions', instType, uid: MOCK_UID }, data: positions }));
        }
      }),
      e.on('account', (balance) => {
        this.broadcast(subKey('account', ''), () => ({ arg: { channel: 'account', uid: MOCK_UID }, data: [balance] }));
        this.broadcast(subKey('balance_and_position', ''), () => ({ arg: { channel: 'balance_and_position', uid: MOCK_UID }, data: [this.balanceAndPosition('filled')] }));
      }),
    );
  }
}
