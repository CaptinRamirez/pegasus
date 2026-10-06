import { EventEmitter } from 'node:events';
import type { OkxFill, OkxPosition } from '@pegasus/okx';
import { D, positionDirection, sourceOfClOrdId, type AlgoOrderList, type Fill, type Instrument, type JournalPage, type JournalStatus, type JournalStatusReason, type JournalTrade, type JournalUpdate, type MarkPrice, type Order, type Position, type PosSide, type TdMode, type TradeSource } from '@pegasus/shared';
import type { Logger } from '../logger.js';
import type { OkxClients } from '../okx/clients.js';
import { mapFill, mapInstrument, mapOrder, mapPosition } from '../okx/mappers.js';
import type { AccountService } from './account.js';
import { JournalBook, lastOpeningOf, orderFacts, type JournalFilter, type OrderFacts } from './journal-book.js';
import { loadJournal, saveJournal, type TradeRecord } from './journal-file.js';
import type { OrderPlacedEvent } from './order-service.js';

/**
 * The trade journal service: records every trade of the account in its own file (JOURNAL_FILE, journal-file.ts), the
 * trades assembled by journal-book.ts (whose header gives the rules: what a trade is, the source, the exit reasons,
 * the arithmetic).
 *
 * Inputs: the account service's events (orders, fills, positions, the algo orders it reads), the plans of the orders
 * Pegasus places (OrderService.onPlaced), and its own reads of the exchange: the fills (GET /api/v5/trade/fills, the
 * last three days on OKX, with the mark price when each filled), the orders they belong to, the positions'
 * accumulated funding (fundingFee). A closing fill that says nothing of its reason (no client order id of Pegasus, no
 * liquidation) has its mark price read from the list of fills before it is classified.
 *
 * Start. The file is read (one that cannot be read is never written over: status `blocked`). While the journal is
 * `starting`, what the account reports is held back; the exchange's fills since the newest one the file recorded
 * (less FILL_OVERLAP_MS) are read and applied in the order they happened, so trades closed while the API was not
 * running (a stop the paper exchange's replay triggered) are there; then what was held back is applied and the status
 * is `ready`. A new file reads no history: the exchange's fills before it cannot say where a position started; the
 * positions open then are adopted. A failed read is tried again every RETRY_MS.
 *
 * Consistency. Every CHECK_MS the open trades are compared with the account's positions, a leg only once neither has
 * changed for QUIET_MS (a fill and its position push arrive apart). A difference is first looked for in the exchange's
 * fills (pushes can be lost); one that is still there is settled from the position: a trade whose position is gone is
 * closed with reason unknown, one whose size differs takes the exchange's size, and a position without a trade is
 * adopted (its source from the newest fill of its leg). An order that the account reports filled beyond what the
 * journal recorded is looked for in the fills CATCH_UP_DELAY_MS later.
 *
 * Output: the file, written after every change (debounced, FLUSH_MS); a `change` event with the trades that changed,
 * which index.ts sends as the `journal` WebSocket message; GET /api/journal and GET /api/journal/:id.
 */

export interface JournalServiceDeps {
  clients: OkxClients;
  market: { specOf(instId: string): Instrument | undefined; markPrice?(instId: string): MarkPrice | null };
  account: AccountService;
  /** OrderService.onPlaced: the plans of the orders Pegasus places */
  onPlaced?: (listener: (e: OrderPlacedEvent) => void) => void;
  log: Logger;
}

export interface JournalServiceOptions {
  /** JOURNAL_FILE */
  file: string;
  /** Server clock; Date.now by default */
  now?: () => number;
  /** How often open trades are compared with the positions; 0: never by itself. Default CHECK_MS */
  checkEveryMs?: number;
  /** How often the funding of open positions is read; 0: never by itself. Default FUNDING_MS */
  fundingEveryMs?: number;
  /** Wait between attempts to read the fills at start. Default RETRY_MS */
  retryMs?: number;
  /** Debounce of the writes and of the change events. Default FLUSH_MS */
  flushMs?: number;
  /** How long a leg must be unchanged before it is compared. Default QUIET_MS */
  quietMs?: number;
}

export const CHECK_MS = 60_000;
export const FUNDING_MS = 5 * 60_000;
export const RETRY_MS = 15_000;
export const FLUSH_MS = 250;
export const QUIET_MS = 10_000;
/** The fills read at start reach back this far before the newest one recorded (clock differences, a fill recorded late). */
export const FILL_OVERLAP_MS = 5 * 60_000;
export const CATCH_UP_DELAY_MS = 5_000;
/** Pages of fills read at most (100 each). */
const MAX_FILL_PAGES = 20;
const FILL_PAGE = 100;
/** Inputs held back while starting; the oldest go first (the fills read at start bring them back). */
const MAX_BUFFER = 10_000;
const MAX_ORDERS = 5_000;

type Input =
  | { kind: 'order'; order: Order }
  | { kind: 'fill'; fill: Fill }
  | { kind: 'positions'; positions: Position[] }
  | { kind: 'algos'; list: AlgoOrderList }
  | { kind: 'placed'; event: OrderPlacedEvent };

const compareIds = (a: string, b: string): number => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0);

export class JournalService extends EventEmitter<{ change: [JournalUpdate] }> {
  private book: JournalBook | null = null;
  private state: JournalStatus = 'starting';
  private reason: JournalStatusReason | null = { code: 'JOURNAL_STARTING', message: 'reading what happened while the API was not running' };
  private buffer: Input[] = [];
  private queue: Promise<void> = Promise.resolve();
  /** Orders as last reported, by ordId: what a fill needs to know about its order */
  private readonly orders = new Map<string, Order>();
  /** Specs read from the exchange for instruments the market data service does not know */
  private readonly specs = new Map<string, Instrument>();
  /** Orders to look for in the fills: the account reported them filled beyond what the journal has */
  private readonly unmatched = new Set<string>();
  private catchUpTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private checkTimer: NodeJS.Timeout | null = null;
  private fundingTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  private dirty = false;
  private stopped = false;
  private subscribed = false;
  private readonly now: () => number;

  constructor(
    private readonly deps: JournalServiceDeps,
    private readonly opts: JournalServiceOptions,
  ) {
    super();
    this.now = opts.now ?? Date.now;
  }

  get status(): { status: JournalStatus; reason: JournalStatusReason | null } {
    return { status: this.state, reason: this.reason };
  }

  /** Reads the file and starts recording; resolves once the file is read (the fills of the time the API was down are read in the background). */
  start(): Promise<void> {
    if (!this.deps.account.enabled) {
      this.setStatus('disabled', { code: 'JOURNAL_DISABLED', message: 'no account to record: no OKX API key is configured' });
      return Promise.resolve();
    }
    const load = loadJournal(this.opts.file);
    if (!load.ok) {
      this.deps.log.error({ file: this.opts.file, err: load.error }, 'the trade journal cannot be read: nothing is recorded and the file is left as it is');
      this.setStatus('blocked', { code: 'JOURNAL_UNREADABLE', message: load.error });
      return Promise.resolve();
    }
    this.book = new JournalBook(load.data, { specOf: (id) => this.specOf(id), now: this.now });
    this.subscribe();
    this.deps.log.info({ file: this.opts.file, trades: load.data.trades.length, lastFillTs: load.data.lastFillTs, existed: load.existed }, 'trade journal read');
    void this.startUp(load.existed && load.data.lastFillTs !== null);
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of [this.catchUpTimer, this.flushTimer, this.checkTimer, this.fundingTimer, this.retryTimer]) if (timer) clearTimeout(timer);
    this.wake?.();
    await this.queue.catch(() => undefined);
    this.flush();
  }

  // ---- queries ----

  page(filter: JournalFilter, before: number | undefined, limit: number): JournalPage {
    const base = { status: this.state, reason: this.reason, serverTime: this.now() };
    if (!this.book) return { ...base, trades: [], total: 0, next: null };
    return { ...base, ...this.book.list(filter, before, limit) };
  }

  trade(id: string): JournalTrade | null {
    return this.book?.find(id)?.trade ?? null;
  }

  /** The open trades. */
  openTrades(): TradeRecord[] {
    return this.book?.openTrades() ?? [];
  }

  /** The open trade of a leg and the average price and time of its last opening order (the entry or the last add); null when there is none. */
  lastOpening(instId: string, mgnMode: TdMode, posSide: PosSide): { tradeId: string; px: string; ts: number } | null {
    const rec = this.book?.openTrade(instId, mgnMode, posSide);
    if (!rec) return null;
    const last = lastOpeningOf(rec, this.specOf(instId));
    return last === null ? null : { tradeId: rec.trade.id, ...last };
  }

  // ---- inputs ----

  private subscribe(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    const a = this.deps.account;
    a.on('order', (order) => this.input({ kind: 'order', order }));
    a.on('fill', (fill) => this.input({ kind: 'fill', fill }));
    a.on('positions', (positions) => this.input({ kind: 'positions', positions }));
    a.on('algoOrders', (list) => this.input({ kind: 'algos', list }));
    this.deps.onPlaced?.((event) => this.input({ kind: 'placed', event }));
  }

  private input(i: Input): void {
    if (this.stopped) return;
    if (this.state === 'starting') {
      // Only the newest list of positions and of algo orders matters.
      if (i.kind === 'positions' || i.kind === 'algos') this.buffer = this.buffer.filter((b) => b.kind !== i.kind);
      this.buffer.push(i);
      if (this.buffer.length > MAX_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
      return;
    }
    if (this.state !== 'ready') return;
    this.enqueue(() => this.apply(i));
  }

  private enqueue(task: () => Promise<void> | void): void {
    this.queue = this.queue.then(task).catch((err: unknown) => this.deps.log.warn({ err: (err as Error).message }, 'trade journal: an update failed'));
  }

  private async apply(i: Input): Promise<void> {
    const book = this.book;
    if (!book) return;
    switch (i.kind) {
      case 'order': {
        this.remember(i.order);
        book.order(i.order);
        // Filled beyond what the journal recorded: its fill push may still come; looked for in the fills if not.
        if (D(i.order.accFillSz || '0').gt(book.filledOf(i.order.ordId))) {
          this.unmatched.add(i.order.ordId);
          this.scheduleCatchUp();
        }
        break;
      }
      case 'fill':
        await this.applyFill(i.fill);
        break;
      case 'positions':
        book.positions(i.positions);
        break;
      case 'algos':
        book.algoOrders(i.list.orders, i.list.ts);
        break;
      case 'placed':
        this.remember(i.event.order);
        book.placed(i.event.request, i.event.order);
        break;
    }
    this.dirty = true;
    this.flushSoon();
  }

  /** `markPx`: the mark price when it filled, when the caller has it (the exchange's list of fills); looked up for a close the fill does not explain. */
  private async applyFill(fill: Fill, markPx?: string): Promise<boolean> {
    const book = this.book;
    if (!book || book.hasFill(fill)) return false;
    await this.ensureSpec(fill.instId);
    const facts = await this.factsOf(fill);
    const mark = markPx ?? (book.closesUnexplained(fill, facts) ? await this.markWhenFilled(fill) : null);
    const recorded = book.fill(fill, facts, mark);
    this.dirty = true;
    return recorded;
  }

  /**
   * The mark price when a fill happened, from the exchange's list of fills (fillMarkPx; the account's push does not
   * carry it): a stop triggers on the mark and its order may fill away from it. The mark now when the list cannot be
   * read.
   */
  private async markWhenFilled(fill: Fill): Promise<string | null> {
    try {
      const rows: Array<OkxFill & { fillMarkPx?: string }> = await this.deps.clients.rest.getFills({ instType: 'SWAP', instId: fill.instId, limit: FILL_PAGE });
      const row = rows.find((r) => r.ordId === fill.ordId && (r.tradeId === fill.tradeId || fill.tradeId === '0'));
      if (row?.fillMarkPx) return row.fillMarkPx;
    } catch (err) {
      this.deps.log.debug({ ordId: fill.ordId, err: (err as Error).message }, 'trade journal: the mark price of a fill could not be read');
    }
    return this.deps.market.markPrice?.(fill.instId)?.markPx ?? null;
  }

  // ---- start-up ----

  private async startUp(readHistory: boolean): Promise<void> {
    for (let attempt = 1; !this.stopped; attempt++) {
      try {
        if (readHistory) {
          const since = this.book?.data.lastFillTs ?? 0;
          const n = await this.catchUp(since);
          this.deps.log.info({ since: new Date(since).toISOString(), recorded: n }, 'trade journal: fills since the last one recorded read');
        } else {
          await this.markHistoryRead();
        }
        break;
      } catch (err) {
        const message = `the exchange's fills could not be read (${(err as Error).message}); trying again in ${Math.round((this.opts.retryMs ?? RETRY_MS) / 1000)} s`;
        this.deps.log.warn({ attempt, err: (err as Error).message }, 'trade journal: reading the fills at start failed');
        this.setStatus('starting', { code: 'JOURNAL_STARTING', message });
        await this.sleep(this.opts.retryMs ?? RETRY_MS);
      }
    }
    if (this.stopped) return;
    this.setStatus('ready', null);
    const held = this.buffer;
    this.buffer = [];
    for (const i of held) this.enqueue(() => this.apply(i));
    this.dirty = true;
    this.flushSoon();
    this.startTimers();
  }

  /** A new journal: the exchange's fills so far are not replayed; the newest one's time is where the journal starts. */
  private async markHistoryRead(): Promise<void> {
    const book = this.book;
    if (!book) return;
    const [newest] = await this.deps.clients.rest.getFills({ instType: 'SWAP', limit: 1 });
    book.data.lastFillTs = newest ? Number(newest.ts) : this.exchangeNow();
    this.dirty = true;
  }

  private startTimers(): void {
    const check = this.opts.checkEveryMs ?? CHECK_MS;
    if (check > 0) {
      const run = (delay: number): void => {
        this.checkTimer = setTimeout(() => {
          this.enqueue(() => this.check());
          if (!this.stopped) run(check);
        }, delay);
        this.checkTimer.unref();
      };
      // The first soon after start: the positions open then are adopted.
      run(Math.min(check, QUIET_MS));
    }
    const funding = this.opts.fundingEveryMs ?? FUNDING_MS;
    if (funding > 0) {
      const run = (delay: number): void => {
        this.fundingTimer = setTimeout(() => {
          void this.readFunding();
          if (!this.stopped) run(funding);
        }, delay);
        this.fundingTimer.unref();
      };
      run(Math.min(funding, QUIET_MS));
    }
  }

  // ---- the exchange's fills ----

  private scheduleCatchUp(): void {
    if (this.catchUpTimer || this.stopped) return;
    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = null;
      this.enqueue(async () => {
        const book = this.book;
        if (!book) return;
        const missing = [...this.unmatched].filter((ordId) => D(this.orders.get(ordId)?.accFillSz || '0').gt(book.filledOf(ordId)));
        this.unmatched.clear();
        if (missing.length === 0) return;
        const n = await this.catchUp(book.data.lastFillTs ?? 0).catch((err: unknown) => {
          this.deps.log.warn({ err: (err as Error).message }, 'trade journal: reading the fills of an order failed');
          return 0;
        });
        if (n > 0) this.deps.log.info({ orders: missing, recorded: n }, 'trade journal: fills the account did not push were read from the exchange');
      });
    }, CATCH_UP_DELAY_MS);
    this.catchUpTimer.unref();
  }

  /** Reads the exchange's fills since `since` (less the overlap) and applies the ones not recorded yet, oldest first; returns how many were recorded. */
  async catchUp(since: number): Promise<number> {
    const rows = await this.readFillsSince(since - FILL_OVERLAP_MS);
    rows.sort((a, b) => Number(a.ts) - Number(b.ts) || compareIds(a.billId, b.billId));
    await this.loadOrdersOf(rows);
    let recorded = 0;
    for (const row of rows as Array<OkxFill & { fillMarkPx?: string }>) if (await this.applyFill(mapFill(row), row.fillMarkPx || undefined)) recorded++;
    if (recorded > 0) this.flushSoon();
    return recorded;
  }

  private async readFillsSince(since: number): Promise<OkxFill[]> {
    const out = new Map<string, OkxFill>();
    let after: string | undefined;
    let firstOfLastPage = '';
    for (let page = 0; page < MAX_FILL_PAGES; page++) {
      const params: { instType: 'SWAP'; limit: number; after?: string } = { instType: 'SWAP', limit: FILL_PAGE };
      if (after !== undefined) params.after = after;
      const batch = await this.deps.clients.rest.getFills(params);
      const first = batch[0];
      const last = batch[batch.length - 1];
      // The same page again: the exchange does not page (the paper exchange keeps its fills in one list).
      if (!first || !last || first.billId === firstOfLastPage) break;
      firstOfLastPage = first.billId;
      for (const row of batch) if (Number(row.ts) >= since) out.set(`${row.billId}:${row.tradeId}:${row.ordId}`, row);
      if (batch.length < FILL_PAGE || Number(last.ts) < since) break;
      after = last.billId;
    }
    return [...out.values()];
  }

  /** The orders of the fills, from the exchange's order history where it has them. */
  private async loadOrdersOf(rows: readonly OkxFill[]): Promise<void> {
    const unknown = new Set(rows.filter((r) => !this.orders.has(r.ordId)).map((r) => r.instId));
    for (const instId of unknown) {
      try {
        for (const raw of await this.deps.clients.rest.getOrdersHistory({ instType: 'SWAP', instId, limit: 100 })) this.remember(mapOrder(raw));
      } catch (err) {
        this.deps.log.warn({ instId, err: (err as Error).message }, 'trade journal: the order history could not be read');
      }
    }
  }

  /** What a fill needs to know about its order: as reported, else read from the exchange, else guessed from the trade on its leg. */
  private async factsOf(fill: Fill): Promise<OrderFacts> {
    const known = this.orders.get(fill.ordId);
    if (known) return orderFacts(known);
    try {
      const order = mapOrder(await this.deps.clients.rest.getOrder({ instId: fill.instId, ordId: fill.ordId }));
      this.remember(order);
      return orderFacts(order);
    } catch (err) {
      this.deps.log.warn({ ordId: fill.ordId, instId: fill.instId, err: (err as Error).message }, 'trade journal: the order of a fill could not be read; its margin mode is taken from the open trade');
      const open = this.book?.openTrades().find((r) => r.trade.instId === fill.instId && r.trade.posSide === fill.posSide);
      const exchangeClose = fill.clOrdId === '' && (fill.tradeId === '0' || fill.tradeId.startsWith('-'));
      const facts: OrderFacts = { ordId: fill.ordId, clOrdId: fill.clOrdId, tdMode: open?.trade.mgnMode ?? 'cross', reduceOnly: false, lever: '' };
      if (exchangeClose) facts.category = 'full_liquidation';
      return facts;
    }
  }

  private remember(order: Order): void {
    this.orders.delete(order.ordId);
    this.orders.set(order.ordId, order);
    if (this.orders.size > MAX_ORDERS) this.orders.delete(this.orders.keys().next().value as string);
  }

  // ---- consistency with the positions ----

  /** Compares the open trades with the account's positions and settles what the fills do not explain (see the header). */
  async check(): Promise<void> {
    const book = this.book;
    const account = this.deps.account;
    if (!book || this.state !== 'ready' || account.config === null || account.status().lastSyncAt === null) return;
    if (this.differences(book).length === 0) return;
    await this.catchUp(book.data.lastFillTs ?? 0).catch((err: unknown) => {
      this.deps.log.warn({ err: (err as Error).message }, 'trade journal: reading the fills for the consistency check failed');
    });
    for (const d of this.differences(book)) {
      if (d.kind === 'gone') {
        this.deps.log.warn({ trade: d.rec.trade.id }, 'trade journal: the position of an open trade is gone and the fills do not say how; closed as unknown');
        book.closeGone(d.rec);
      } else if (d.kind === 'size') {
        this.deps.log.warn({ trade: d.rec.trade.id, journal: d.rec.trade.size, exchange: d.p.pos }, 'trade journal: the exchange shows another size than the fills add up to; the exchange is followed');
        book.correctSize(d.rec, d.p);
      } else {
        const source = await this.sourceOfPosition(d.p);
        const rec = book.adopt(d.p, source);
        if (rec) this.deps.log.info({ trade: rec.trade.id, instId: d.p.instId, pos: d.p.pos, source }, 'trade journal: a position opened before the journal saw it is adopted');
      }
    }
    this.dirty = true;
    this.flushSoon();
  }

  private differences(book: JournalBook): Array<{ kind: 'gone'; rec: TradeRecord } | { kind: 'size'; rec: TradeRecord; p: Position } | { kind: 'missing'; p: Position }> {
    const now = this.now();
    const exchangeNow = this.exchangeNow();
    const quiet = this.opts.quietMs ?? QUIET_MS;
    const positions = this.deps.account.positionList().filter((p) => !D(p.pos || '0').isZero());
    const out: Array<{ kind: 'gone'; rec: TradeRecord } | { kind: 'size'; rec: TradeRecord; p: Position } | { kind: 'missing'; p: Position }> = [];
    for (const rec of book.openTrades()) {
      const t = rec.trade;
      if (now - rec.book.lastActivity < quiet) continue;
      const p = positions.find((x) => x.instId === t.instId && x.mgnMode === t.mgnMode && x.posSide === t.posSide);
      if (!p) out.push({ kind: 'gone', rec });
      else if (!D(p.pos).abs().eq(t.size) && exchangeNow - p.uTime >= quiet) out.push({ kind: 'size', rec, p });
    }
    for (const p of positions) {
      if (book.openTrade(p.instId, p.mgnMode, p.posSide) || exchangeNow - p.uTime < quiet) continue;
      out.push({ kind: 'missing', p });
    }
    return out;
  }

  /** The source of a position the journal did not see open: the client order id of the newest fill that opened on its leg. */
  private async sourceOfPosition(p: Position): Promise<TradeSource> {
    const direction = positionDirection(p);
    try {
      const fills = (await this.deps.clients.rest.getFills({ instType: 'SWAP', instId: p.instId, limit: FILL_PAGE })).map(mapFill);
      const opening = fills.find((f) => f.posSide === p.posSide && (f.side === 'buy') === (direction === 'long'));
      return opening ? sourceOfClOrdId(opening.clOrdId) : 'external';
    } catch {
      return 'external';
    }
  }

  // ---- funding ----

  /** The positions' accumulated funding (fundingFee), where the exchange reports it. */
  private async readFunding(): Promise<void> {
    const book = this.book;
    if (!book || this.state !== 'ready' || book.openTrades().length === 0) return;
    let rows: Array<OkxPosition & { fundingFee?: string }>;
    try {
      rows = await this.deps.clients.rest.getPositions('SWAP');
    } catch (err) {
      this.deps.log.debug({ err: (err as Error).message }, 'trade journal: the funding of the positions could not be read');
      return;
    }
    this.enqueue(() => {
      for (const row of rows) {
        if (row.fundingFee === undefined || row.fundingFee === '') continue;
        const p = mapPosition(row);
        book.funding(p.instId, p.mgnMode, p.posSide, row.fundingFee);
      }
      if (book.hasChanges) {
        this.dirty = true;
        this.flushSoon();
      }
    });
  }

  // ---- output ----

  private flushSoon(): void {
    if (this.flushTimer || this.stopped) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.opts.flushMs ?? FLUSH_MS);
    this.flushTimer.unref();
  }

  private flush(): void {
    const book = this.book;
    if (!book || this.state === 'blocked') return;
    if (this.dirty) {
      this.dirty = false;
      try {
        saveJournal(this.opts.file, book.data);
      } catch (err) {
        this.dirty = true;
        this.deps.log.error({ file: this.opts.file, err: (err as Error).message }, 'trade journal: the file could not be written');
      }
    }
    const trades = book.takeChanged();
    if (trades.length > 0) this.emit('change', { status: this.state, reason: this.reason, trades, serverTime: this.now() });
  }

  private setStatus(status: JournalStatus, reason: JournalStatusReason | null): void {
    const same = this.state === status && this.reason?.code === reason?.code && this.reason?.message === reason?.message;
    this.state = status;
    this.reason = reason;
    if (!same) this.emit('change', { status, reason, trades: [], serverTime: this.now() });
  }

  // ---- helpers ----

  private specOf(instId: string): Instrument {
    const known = this.deps.market.specOf(instId) ?? this.specs.get(instId);
    if (known) return known;
    // Never expected: every SWAP is known at start and ensureSpec reads the others. Contracts then count as coins.
    this.deps.log.error({ instId }, 'trade journal: no contract spec for the instrument; its contracts are counted as one coin each');
    const fallback: Instrument = { instId, instType: 'SWAP', uly: '', baseCcy: '', quoteCcy: 'USDT', settleCcy: 'USDT', ctVal: '1', ctValCcy: '', ctMult: '1', ctType: 'linear', lotSz: '1', minSz: '1', tickSz: '0.0001', maxLmtSz: '0', maxMktSz: '0', maxLever: '1', state: 'live' };
    this.specs.set(instId, fallback);
    return fallback;
  }

  private async ensureSpec(instId: string): Promise<void> {
    if (this.deps.market.specOf(instId) || this.specs.has(instId)) return;
    try {
      const [raw] = await this.deps.clients.rest.getInstruments('SWAP', instId);
      if (raw) this.specs.set(instId, mapInstrument(raw));
    } catch (err) {
      this.deps.log.warn({ instId, err: (err as Error).message }, 'trade journal: the contract spec could not be read');
    }
  }

  private exchangeNow(): number {
    return Date.now() + this.deps.clients.clock.offsetMs;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
      this.retryTimer = setTimeout(resolve, ms);
      this.retryTimer.unref();
    });
  }
}
