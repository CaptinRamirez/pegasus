import type { IncomingHttpHeaders } from 'node:http';
import { verifyRestAuth } from './auth.js';
import { BAR_MS, barStart, isBar } from './engine/candles.js';
import type { Engine } from './engine/engine.js';
import { d, isDecimalString } from './num.js';
import type { MockCredentials } from './types.js';
import type { OkxResponse } from './wire.js';

export interface RestRequest {
  method: string;
  /** Exact path + query as received; it is part of the signature prehash. */
  rawPath: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface RestReply {
  status: number;
  json: unknown;
}

type Handler = (q: URLSearchParams, body: unknown) => OkxResponse<unknown>;

/** Deliberately generic: the code OKX uses for a key without the permission is not in docs/okx-api-notes.md, so clients must not rely on one. */
export const NO_PERMISSION = { code: '1', msg: 'This API key does not have the permission for this operation.' } as const;

interface Route {
  auth: boolean;
  handler: Handler;
}

function ok<T>(data: T[]): OkxResponse<T> {
  return { code: '0', msg: '', data };
}

function err(code: string, msg: string): OkxResponse<never> {
  return { code, msg, data: [] };
}

function limitOf(q: URLSearchParams, def: number, max: number): number {
  const n = Number(q.get('limit') ?? def);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : def;
}

function cursor(q: URLSearchParams, key: string): number | undefined {
  const v = q.get(key);
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function acksResponse<T extends { sCode: string }>(acks: T[], single: boolean): OkxResponse<T> & { inTime: string; outTime: string } {
  const failed = acks.filter((a) => a.sCode !== '0').length;
  let code = '0';
  let msg = '';
  if (failed === acks.length && acks.length > 0) {
    code = '1';
    msg = single ? 'Operation failed.' : 'All operations failed';
  } else if (failed > 0) {
    code = '2';
    msg = 'Bulk operation partially succeeded.';
  }
  const t = String(Date.now() * 1000);
  return { code, msg, data: acks, inTime: t, outTime: t };
}

/** Maps OKX v5 REST paths onto the engine, including signature verification. */
export class RestRouter {
  private readonly routes = new Map<string, Route>();

  constructor(
    private readonly engine: Engine,
    private readonly creds: MockCredentials | undefined,
  ) {
    this.registerPublic();
    this.registerAccount();
    this.registerTrade();
  }

  handle(req: RestRequest): RestReply {
    const url = new URL(req.rawPath, 'http://mock');
    const route = this.routes.get(`${req.method} ${url.pathname}`);
    if (!route) return { status: 404, json: err('404', 'Not Found') };
    if (route.auth && this.creds) {
      const authErr = verifyRestAuth(this.creds, req.headers, req.method, req.rawPath, req.body);
      if (authErr) return { status: 401, json: err(authErr.code, authErr.msg) };
    }
    // Every POST route writes (orders, cancels, amends, close-position, set-leverage).
    if (req.method === 'POST' && !this.engine.canTrade) return { status: 200, json: err(NO_PERMISSION.code, NO_PERMISSION.msg) };
    let body: unknown = undefined;
    if (req.method === 'POST' && req.body !== '') {
      try {
        body = JSON.parse(req.body);
      } catch {
        return { status: 200, json: err('50014', 'Request body is not valid JSON.') };
      }
    }
    return { status: 200, json: route.handler(url.searchParams, body) };
  }

  private get(path: string, auth: boolean, handler: Handler): void {
    this.routes.set(`GET ${path}`, { auth, handler });
  }

  private post(path: string, handler: Handler): void {
    this.routes.set(`POST ${path}`, { auth: true, handler });
  }

  private registerPublic(): void {
    const e = this.engine;
    this.get('/api/v5/public/time', false, () => ok([{ ts: String(e.now()) }]));
    this.get('/api/v5/public/instruments', false, (q) => {
      const instType = q.get('instType');
      if (!instType) return err('50014', 'Parameter instType cannot be empty.');
      if (instType !== 'SWAP') return ok([]);
      return ok(e.instrumentList(q.get('instId') ?? undefined));
    });
    this.get('/api/v5/market/ticker', false, (q) => {
      const instId = q.get('instId');
      if (!instId) return err('50014', 'Parameter instId cannot be empty.');
      const t = e.ticker(instId);
      return t ? ok([t]) : err('51001', 'Instrument ID does not exist.');
    });
    this.get('/api/v5/market/tickers', false, (q) => {
      const instType = q.get('instType');
      if (!instType) return err('50014', 'Parameter instType cannot be empty.');
      return ok(instType === 'SWAP' ? e.tickers() : []);
    });
    this.get('/api/v5/market/books', false, (q) => {
      const instId = q.get('instId');
      if (!instId) return err('50014', 'Parameter instId cannot be empty.');
      const sz = Math.max(1, Math.min(400, Number(q.get('sz') ?? 1) || 1));
      const b = e.books(instId, sz);
      return b ? ok([b]) : err('51001', 'Instrument ID does not exist.');
    });
    const candles = (history: boolean): Handler => (q) => {
      const instId = q.get('instId');
      if (!instId) return err('50014', 'Parameter instId cannot be empty.');
      const bar = q.get('bar') ?? '1m';
      if (!isBar(bar)) return err('51000', 'Parameter bar error');
      const limit = history ? limitOf(q, 100, 100) : limitOf(q, 100, 300);
      const query = { limit, includeLive: !history } as Parameters<Engine['candles']>[2];
      const after = cursor(q, 'after');
      const before = cursor(q, 'before');
      if (after !== undefined) query.after = after;
      if (before !== undefined) query.before = before;
      const rows = e.candles(instId, bar, query);
      return rows ? ok(rows) : err('51001', 'Instrument ID does not exist.');
    };
    this.get('/api/v5/market/candles', false, candles(false));
    this.get('/api/v5/market/history-candles', false, candles(true));
    this.get('/api/v5/public/mark-price', false, (q) => {
      const instType = q.get('instType');
      if (!instType) return err('50014', 'Parameter instType cannot be empty.');
      if (instType !== 'SWAP') return ok([]);
      const instId = q.get('instId') ?? undefined;
      const rows = e.markPrices(instId);
      return instId && rows.length === 0 ? err('51001', 'Instrument ID does not exist.') : ok(rows);
    });
    this.get('/api/v5/public/funding-rate', false, (q) => {
      const instId = q.get('instId');
      if (!instId) return err('50014', 'Parameter instId cannot be empty.');
      const f = e.fundingRate(instId);
      return f ? ok([f]) : err('51001', 'Instrument ID does not exist.');
    });
    // One tier per instrument family: the engine liquidates every position by the tier-1 rate, whatever its size.
    // The refusals are the ones OKX answered with on 2026-10-05.
    this.get('/api/v5/public/position-tiers', false, (q) => {
      const instType = q.get('instType');
      if (!instType) return err('50014', 'Parameter instType can not be empty.');
      const tdMode = q.get('tdMode');
      if (!tdMode) return err('50014', 'Parameter tdMode can not be empty.');
      if (tdMode !== 'cross' && tdMode !== 'isolated') return err('51000', 'Parameter tdMode error');
      if (instType !== 'SWAP') return err('51000', 'Parameter instType error');
      const families = (q.get('instFamily') ?? q.get('uly') ?? '').split(',').filter((f) => f !== '');
      if (families.length === 0) return err('50015', 'Either parameter instFamily or uly is required');
      if (families.length > 5) return err('50025', 'Parameter instFamily count exceeds the limit 5.');
      const listed = e.instrumentList().filter((inst) => families.includes(inst.instFamily));
      if (listed.length === 0) return err('51000', 'Parameter instFamily error');
      const tier = q.get('tier');
      if (tier && tier !== '1') return ok([]);
      return ok(listed.map((inst) => ({
        baseMaxLoan: '',
        imr: d(1).div(d(inst.lever)).toDecimalPlaces(4).toFixed(),
        instFamily: inst.instFamily,
        instId: '',
        maxLever: inst.lever,
        maxSz: inst.maxLmtSz,
        minSz: '0',
        mmr: (e.mmr.get(inst.instId) ?? d(0)).toFixed(),
        optMgnFactor: '0',
        quoteMaxLoan: '',
        tier: '1',
        uly: inst.uly,
      })));
    });
    this.get('/api/v5/public/open-interest', false, (q) => {
      const instType = q.get('instType');
      if (!instType) return err('50014', 'Parameter instType cannot be empty.');
      if (instType !== 'SWAP') return ok([]);
      const instId = q.get('instId') ?? undefined;
      const insts = e.instrumentList(instId);
      if (instId && insts.length === 0) return err('51001', 'Instrument ID does not exist.');
      const now = String(e.now());
      return ok(insts.map((inst) => {
        // Synthetic open interest: a fixed base per instrument plus whatever the user holds.
        const base = inst.instId.startsWith('BTC') ? 250000 : 400000;
        const held = e.positions(inst.instId).reduce((acc, p) => acc + Math.abs(Number(p.pos)), 0);
        const oi = base + held;
        const ticker = e.ticker(inst.instId);
        const px = ticker ? Number(ticker.last) : 0;
        const ctVal = Number(inst.ctVal);
        return { instType: 'SWAP', instId: inst.instId, oi: String(oi), oiCcy: String(oi * ctVal), oiUsd: String(oi * ctVal * px), ts: now };
      }));
    });
    // Deterministic synthetic history per instrument, newest first: [ts, contracts, coin, USD]. One level
    // function of time serves every period, by OKX's END convention for recent data: the row labelled T
    // holds the level at the end of its period and the newest row, still forming, the current level, so
    // 1Dutc(D) equals 12Hutc(D + 12h). The level swings 12% over 30 days with a small fixed wobble, so
    // the 1d and 10d changes are non-zero.
    const oiLevel = (base: number, t: number) => {
      const cycle = 60 * BAR_MS['1D'];
      const phase = d(((t % cycle) + cycle) % cycle).div(BAR_MS['1D']);
      const swing = phase.gt(30) ? d(60).minus(phase) : phase;
      const wobble = ((Math.floor(t / BAR_MS['12Hutc']) % 11) + 11) % 11 * 100;
      return d(base).mul(d(1).plus(d('0.004').mul(swing))).plus(wobble).toDecimalPlaces(0);
    };
    this.get('/api/v5/rubik/stat/contracts/open-interest-history', false, (q) => {
      const instId = q.get('instId');
      if (!instId) return err('50014', 'Parameter instId cannot be empty.');
      const [inst] = e.instrumentList(instId);
      if (!inst) return err('51001', 'Instrument ID does not exist.');
      const period = q.get('period') ?? '5m';
      if (!isBar(period)) return err('51000', 'Parameter period error');
      const limit = limitOf(q, 100, 100);
      const base = inst.instId.startsWith('BTC') ? 250000 : 400000;
      const px = e.ticker(inst.instId)?.last ?? '0';
      const now = e.now();
      const newest = barStart(period, now);
      const rows: Array<[string, string, string, string]> = [];
      for (let i = 0; i < limit; i++) {
        const label = newest - i * BAR_MS[period];
        const oi = oiLevel(base, i === 0 ? now : label + BAR_MS[period]);
        const oiCcy = oi.mul(d(inst.ctVal));
        rows.push([String(label), oi.toFixed(), oiCcy.toFixed(), oiCcy.mul(d(px)).toFixed()]);
      }
      return ok(rows);
    });
    // Settled records, newest first, at the regular 8h cadence ending with the last settlement before now.
    this.get('/api/v5/public/funding-rate-history', false, (q) => {
      const instId = q.get('instId');
      if (!instId) return err('50014', 'Parameter instId cannot be empty.');
      const f = e.fundingRate(instId);
      if (!f) return err('51001', 'Instrument ID does not exist.');
      const interval = Number(f.nextFundingTime) - Number(f.fundingTime);
      const limit = Math.min(100, Math.max(1, Number(q.get('limit') ?? '100') || 100));
      const before = q.get('before');
      const after = q.get('after');
      const rows: Array<{ instType: 'SWAP'; instId: string; fundingRate: string; realizedRate: string; fundingTime: string; method: string }> = [];
      let t = Number(f.fundingTime) - interval; // last settled time
      while (rows.length < limit && t > 0) {
        const inAfter = after === null || t < Number(after);
        const inBefore = before === null || t > Number(before);
        if (inAfter && inBefore) rows.push({ instType: 'SWAP', instId, fundingRate: f.fundingRate, realizedRate: f.fundingRate, fundingTime: String(t), method: 'next_period' });
        t -= interval;
        if (before !== null && t <= Number(before)) break;
      }
      return ok(rows);
    });
  }

  private registerAccount(): void {
    const e = this.engine;
    this.get('/api/v5/account/config', true, () => ok([e.config()]));
    this.get('/api/v5/account/balance', true, (q) => {
      const ccy = q.get('ccy');
      const b = e.balance();
      if (ccy && !ccy.split(',').includes('USDT')) b.details = [];
      return ok([b]);
    });
    this.get('/api/v5/account/positions', true, (q) => {
      const instType = q.get('instType');
      if (instType && instType !== 'SWAP' && instType !== 'ANY') return ok([]);
      return ok(e.positions(q.get('instId') ?? undefined));
    });
    this.get('/api/v5/account/leverage-info', true, (q) => {
      const instId = q.get('instId');
      const mgnMode = q.get('mgnMode');
      if (!instId || !e.instruments.has(instId)) return err('51001', 'Instrument ID does not exist.');
      if (mgnMode !== 'cross' && mgnMode !== 'isolated') return err('51000', 'Parameter mgnMode error');
      return ok(e.leverageInfo(instId, mgnMode));
    });
    this.post('/api/v5/account/set-leverage', (_q, body) => {
      const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
      const instId = typeof raw['instId'] === 'string' ? raw['instId'] : '';
      const inst = e.instruments.get(instId);
      if (!inst) return err('51001', 'Instrument ID does not exist.');
      const mgnMode = raw['mgnMode'];
      if (mgnMode !== 'cross' && mgnMode !== 'isolated') return err('51000', 'Parameter mgnMode error');
      const leverRaw = raw['lever'];
      const leverStr = typeof leverRaw === 'number' ? String(leverRaw) : typeof leverRaw === 'string' ? leverRaw : '';
      if (!isDecimalString(leverStr)) return err('51000', 'Parameter lever error');
      const lever = d(leverStr);
      if (!lever.isInteger() || lever.lt(1) || lever.gt(d(inst.lever))) return err('51000', 'Parameter lever error');
      const posSideRaw = raw['posSide'];
      let posSide: 'long' | 'short' | undefined;
      if (posSideRaw === 'long' || posSideRaw === 'short') posSide = posSideRaw;
      else if (posSideRaw !== undefined && posSideRaw !== '' && posSideRaw !== 'net') return err('51000', 'Parameter posSide error');
      if (e.posMode === 'long_short_mode' && mgnMode === 'isolated' && !posSide) return err('51000', 'Parameter posSide error');
      // An open isolated position takes the new leverage with the margin it moves; a change that cannot be made is refused.
      const refused = mgnMode === 'isolated' ? e.changeIsolatedLeverage(instId, lever, posSide) : null;
      if (refused) return err(refused.sCode, refused.sMsg);
      return ok(e.setLeverage(instId, mgnMode, lever, posSide));
    });
    this.post('/api/v5/account/position/margin-balance', (_q, body) => e.adjustMargin(body));
  }

  private registerTrade(): void {
    const e = this.engine;
    const m = e.matcher;
    const batch = <T extends { sCode: string }>(body: unknown, fn: (item: unknown) => T, max = 20): OkxResponse<unknown> => {
      if (!Array.isArray(body)) return err('51000', 'Parameter error: array body expected');
      if (body.length === 0 || body.length > max) return err('51000', `Parameter error: 1-${max} items expected`);
      return acksResponse(body.map((item: unknown) => fn(item)), false);
    };
    this.post('/api/v5/trade/order', (_q, body) => acksResponse([m.place(body)], true));
    this.post('/api/v5/trade/batch-orders', (_q, body) => batch(body, (item) => m.place(item)));
    this.post('/api/v5/trade/cancel-order', (_q, body) => acksResponse([m.cancelRequest(body)], true));
    this.post('/api/v5/trade/cancel-batch-orders', (_q, body) => batch(body, (item) => m.cancelRequest(item)));
    this.post('/api/v5/trade/amend-order', (_q, body) => acksResponse([m.amendRequest(body)], true));
    this.post('/api/v5/trade/amend-batch-orders', (_q, body) => batch(body, (item) => m.amendRequest(item)));
    this.post('/api/v5/trade/close-position', (_q, body) => m.closePosition(body));
    // Algo orders: only the stop-losses generated from attachAlgoOrds exist here, all of type `conditional`.
    this.get('/api/v5/trade/orders-algo-pending', true, (q) => {
      const ordType = q.get('ordType');
      if (!ordType) return err('50014', 'Parameter ordType cannot be empty.');
      const instType = q.get('instType');
      if (!ordType.split(',').includes('conditional') || (instType && instType !== 'SWAP')) return ok([]);
      const algoId = q.get('algoId');
      // `after`: only the algo orders older than that algoId.
      const afterRaw = q.get('after') ?? '';
      const after = /^\d+$/.test(afterRaw) ? BigInt(afterRaw) : null;
      const rows = e
        .algoOrdersPending(q.get('instId') ?? undefined)
        .filter((a) => (!algoId || a.algoId === algoId) && (after === null || BigInt(a.algoId) < after));
      return ok(rows.slice(0, limitOf(q, 100, 100)));
    });
    this.post('/api/v5/trade/order-algo', (_q, body) => acksResponse([m.placeAlgoRequest(body)], true));
    this.post('/api/v5/trade/cancel-algos', (_q, body) => batch(body, (item) => m.cancelAlgoRequest(item), 10));
    this.post('/api/v5/trade/amend-algos', (_q, body) => acksResponse([m.amendAlgoRequest(body)], true));
    this.get('/api/v5/trade/order', true, (q) => {
      const instId = q.get('instId');
      if (!instId) return err('50014', 'Parameter instId cannot be empty.');
      const ordId = q.get('ordId') ?? undefined;
      const clOrdId = q.get('clOrdId') ?? undefined;
      if (!ordId && !clOrdId) return err('51000', 'Either ordId or clOrdId is required');
      const o = e.orderDetail(instId, ordId, clOrdId);
      return o ? ok([o]) : err('51603', 'Order does not exist');
    });
    this.get('/api/v5/trade/orders-pending', true, (q) => ok(e.ordersPending(q.get('instId') ?? undefined).slice(0, limitOf(q, 100, 100))));
    const history: Handler = (q) => ok(e.ordersHistory(q.get('instId') ?? undefined, limitOf(q, 100, 100)));
    this.get('/api/v5/trade/orders-history', true, history);
    this.get('/api/v5/trade/orders-history-archive', true, history);
    const fills: Handler = (q) => ok(e.fills(q.get('instId') ?? undefined, limitOf(q, 100, 100)));
    this.get('/api/v5/trade/fills', true, fills);
    this.get('/api/v5/trade/fills-history', true, fills);
  }
}
