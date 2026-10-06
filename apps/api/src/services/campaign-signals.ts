import {
  D,
  positionDirection,
  sumDecimals,
  utcDayStart,
  type CampaignParams,
  type CampaignParamsView,
  type CampaignServiceStatus,
  type CampaignSignalRow,
  type CampaignSignalsResponse,
  type CampaignView,
  type Candle,
  type CandleBar,
  type Instrument,
  type Position,
} from '@pegasus/shared';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { OkxClients } from '../okx/clients.js';
import { mapCandle, mapInstrument, toOkxBar } from '../okx/mappers.js';
import type { AccountService } from './account.js';
import { DAY_MS, DEFAULT_FOLLOW_RISK_PCT, evaluateCampaignSignal, FAR_ABOVE_PCT, HALF_DAY_MS, LIQ_BUFFER_PCT, NEAR_PCT, planCampaignFollow, STOP_NARROW_PCT, STOP_WIDE_PCT, type HeldLong } from './campaign-signals-plan.js';
import type { JournalService } from './journal.js';
import type { MarketDataService } from './market-data.js';
import type { RiskEngine } from './risk-engine.js';

/**
 * GET /api/campaign/signals: the campaign rule read per coin, for every instrument of the campaign's list
 * (CAMPAIGN_INSTRUMENTS, the ten of @pegasus/shared by default), whether the campaign is enabled or not, each signal
 * with a plan to follow it by hand. The states and the plan are campaign-signals-plan.ts's (its header gives the
 * rules). The rule's parameters are the campaign's: the pot's own while a pot runs, the settings otherwise.
 *
 * Inputs: the exchange's confirmed UTC bars (OKX 1Dutc and 12Hutc: through the market data service for a tracked
 * instrument, the public REST candles for the others), cached BAR_CACHE_MS and never across a 00:00 or 12:00 UTC close
 * (INCOMPLETE_CACHE_MS while the bar that closed there is not confirmed yet); the mark price (the live stream of a
 * tracked instrument, else the public REST mark price, cached MARK_CACHE_MS); the account's positions (a long held,
 * and the notionals the risk limits count); the trade journal (the add reference: the last opening order of the
 * held long); the equity (the request's, else the account's total equity); the risk limits and the kill switch.
 *
 * When the campaign service runs on this API (CAMPAIGN_ENABLED=1, `pnpm start --campaign`), the positions on its coins
 * are the pot's: the response says so (`campaign.ownAccount`) and every plan warns CAMPAIGN_ACCOUNT.
 */

export interface CampaignBarSource {
  /** Daily UTC bars, oldest first; the forming one may be included */
  daily(instId: string, limit: number): Promise<Candle[]>;
  /** 12-hour UTC bars, oldest first; the forming one may be included */
  halfDay(instId: string, limit: number): Promise<Candle[]>;
}

export interface CampaignSignalsDeps {
  config: Pick<AppConfig, 'campaign'>;
  clients: OkxClients;
  market: MarketDataService;
  account: AccountService;
  risk: RiskEngine;
  journal?: Pick<JournalService, 'lastOpening'> | undefined;
  /** The campaign service, while the campaign is enabled */
  campaign?: { view(): CampaignView } | undefined;
  /** The view of a disabled campaign: its settings */
  disabledView: () => CampaignView;
  log: Logger;
}

export interface CampaignSignalsOptions {
  now?: () => number;
  /** The exchange's bars by default */
  bars?: CampaignBarSource;
  /** Mark prices of instruments without a live stream; the public REST mark price by default */
  marks?: (instIds: string[]) => Promise<Map<string, string>>;
}

export const BAR_CACHE_MS = 5 * 60_000;
export const INCOMPLETE_CACHE_MS = 15_000;
export const MARK_CACHE_MS = 10_000;

interface BarCacheEntry {
  at: number;
  candles: Candle[];
}

/** The rule's parameters from the campaign view's. */
export function paramsOfView(view: CampaignParamsView, feeRate: string): CampaignParams {
  return { entryChannel: view.entryChannel, exitChannel: view.exitChannel, leverage: view.leverage, structure: view.structure, addStep: view.addStep, feeRate: view.feeRate || feeRate };
}

export class CampaignSignalsService {
  private readonly cache = new Map<string, BarCacheEntry>();
  private readonly specs = new Map<string, Instrument>();
  private marksCache: { at: number; marks: Map<string, string> } | null = null;
  private readonly now: () => number;
  private readonly bars: CampaignBarSource;
  private readonly marks: (instIds: string[]) => Promise<Map<string, string>>;

  constructor(
    private readonly deps: CampaignSignalsDeps,
    opts: CampaignSignalsOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.bars = opts.bars ?? this.exchangeBars();
    this.marks = opts.marks ?? ((ids) => this.restMarks(ids));
  }

  async report(opts: { riskPct?: string | undefined; equity?: string | undefined } = {}): Promise<CampaignSignalsResponse> {
    const now = this.now();
    const view = this.deps.campaign?.view() ?? this.deps.disabledView();
    const params = paramsOfView(view.params, this.deps.config.campaign.feeRate);
    const instIds = this.deps.config.campaign.instruments;
    const accountEq = this.deps.account.balance?.totalEq;
    const equity = opts.equity ?? (accountEq !== undefined && accountEq !== '' && D(accountEq).gt(0) ? accountEq : null);
    const equitySource: CampaignSignalsResponse['equitySource'] = opts.equity !== undefined ? 'request' : equity !== null ? 'account' : null;
    const riskPct = opts.riskPct ?? DEFAULT_FOLLOW_RISK_PCT;
    const campaignAccount = this.deps.campaign !== undefined;
    const positions = this.deps.account.positionList().filter((p) => !D(p.pos || '0').isZero());
    const totalNotional = this.deps.account.totalPositionNotional();
    const untracked = instIds.filter((id) => this.deps.market.liveMarkPrice(id) === undefined);
    const restMarks = untracked.length > 0 ? await this.cachedMarks(untracked, now) : new Map<string, string>();
    const rows = await Promise.all(
      instIds.map(async (instId): Promise<CampaignSignalRow> => {
        const tracked = this.deps.market.getInstrument(instId) !== undefined;
        try {
          const [daily, halfDay] = await Promise.all([this.cachedBars(instId, '1D', Math.max(60, params.entryChannel + 5), now), this.cachedBars(instId, '12H', 10, now)]);
          const markPx = this.deps.market.liveMarkPrice(instId) ?? restMarks.get(instId) ?? null;
          const held = this.heldLong(instId, positions);
          const short = positions.filter((p) => p.instId === instId && positionDirection(p) === 'short');
          const evaluated = evaluateCampaignSignal({ instId, daily, halfDay, markPx, params, held, shortContracts: short.length > 0 ? sumDecimals(short.map((p) => D(p.pos).abs())).toFixed() : null });
          const row: CampaignSignalRow = { ...evaluated, tracked, plan: null };
          const signal = row.signal;
          const stopPx = row.levels.nextExit;
          if (signal !== null && row.markPx !== null && stopPx !== null && (row.state === 'entry' || row.state === 'add')) {
            const inst = await this.spec(instId);
            if (inst) {
              const instrumentNotional = sumDecimals(positions.filter((p) => p.instId === instId).map((p) => D(p.notionalUsd || '0').abs())).toFixed();
              row.plan = planCampaignFollow({
                kind: row.state,
                inst,
                markPx: row.markPx,
                stopPx,
                signal,
                signalCloseTs: signal.barTs + (row.state === 'entry' ? DAY_MS : HALF_DAY_MS),
                barMs: row.state === 'entry' ? DAY_MS : HALF_DAY_MS,
                equity,
                riskPct,
                params,
                risk: this.deps.risk.config,
                instrumentNotional,
                totalNotional,
                held: row.state === 'add' ? held : null,
                now,
                tracked,
                campaignAccount,
                killSwitch: this.deps.risk.state.killSwitch,
              });
            }
          }
          return row;
        } catch (err) {
          this.deps.log.warn({ instId, err: (err as Error).message }, 'campaign signals: the bars could not be read');
          return {
            instId,
            state: 'unavailable',
            reasons: [{ code: 'BARS_UNAVAILABLE', params: { message: (err as Error).message } }],
            tracked,
            daily: null,
            halfDay: null,
            levels: { entry: null, exit: null, nextEntry: null, nextExit: null },
            markPx: null,
            entryDistancePct: null,
            holding: null,
            signal: null,
            plan: null,
          };
        }
      }),
    );
    const status: CampaignServiceStatus = view.status;
    return {
      generatedAt: now,
      params: { entryChannel: params.entryChannel, exitChannel: params.exitChannel, addStep: params.addStep, structure: params.structure, leverage: params.leverage, feeRate: params.feeRate },
      thresholds: { nearPct: NEAR_PCT, stopWidePct: STOP_WIDE_PCT, stopNarrowPct: STOP_NARROW_PCT, farAbovePct: FAR_ABOVE_PCT, liqBufferPct: LIQ_BUFFER_PCT },
      riskPct,
      equity,
      equitySource,
      campaign: { enabled: campaignAccount, status, ownAccount: campaignAccount },
      rows,
    };
  }

  /** The long the account holds on the coin: the contracts of every long leg together, the figures of the largest, the add reference from the journal. */
  private heldLong(instId: string, positions: readonly Position[]): HeldLong | null {
    const longs = positions.filter((p) => p.instId === instId && positionDirection(p) === 'long').sort((a, b) => D(b.pos).abs().cmp(D(a.pos).abs()));
    const main = longs[0];
    if (!main) return null;
    const last = this.deps.journal?.lastOpening(main.instId, main.mgnMode, main.posSide) ?? null;
    return {
      contracts: sumDecimals(longs.map((p) => D(p.pos).abs())).toFixed(),
      avgPx: main.avgPx,
      mgnMode: main.mgnMode,
      lever: main.lever,
      margin: main.margin,
      liqPx: main.liqPx,
      addRef: last?.px ?? main.avgPx,
      addRefTs: last?.ts ?? null,
      addRefSource: last ? 'journal' : 'position',
      tradeId: last?.tradeId ?? null,
    };
  }

  /** Bars cached BAR_CACHE_MS, never across a 00:00 or 12:00 UTC close, and only INCOMPLETE_CACHE_MS while the bar that closed last is not confirmed. */
  private async cachedBars(instId: string, bar: '1D' | '12H', limit: number, now: number): Promise<Candle[]> {
    const key = `${instId}:${bar}`;
    const cached = this.cache.get(key);
    if (cached && this.fresh(cached, bar, now)) return cached.candles;
    const candles = bar === '1D' ? await this.bars.daily(instId, limit) : await this.bars.halfDay(instId, limit);
    this.cache.set(key, { at: now, candles });
    return candles;
  }

  private fresh(entry: BarCacheEntry, bar: '1D' | '12H', now: number): boolean {
    const period = Math.floor(now / HALF_DAY_MS);
    if (Math.floor(entry.at / HALF_DAY_MS) !== period) return false;
    const length = bar === '1D' ? DAY_MS : HALF_DAY_MS;
    const lastClose = bar === '1D' ? utcDayStart(now) : period * HALF_DAY_MS;
    const newest = entry.candles.filter((c) => c.confirm).reduce((max, c) => Math.max(max, c.ts), Number.NEGATIVE_INFINITY);
    const complete = newest + length >= lastClose;
    return now - entry.at < (complete ? BAR_CACHE_MS : INCOMPLETE_CACHE_MS);
  }

  private async cachedMarks(instIds: string[], now: number): Promise<Map<string, string>> {
    if (this.marksCache && now - this.marksCache.at < MARK_CACHE_MS && instIds.every((id) => this.marksCache?.marks.has(id))) return this.marksCache.marks;
    try {
      const marks = await this.marks(instIds);
      this.marksCache = { at: now, marks };
      return marks;
    } catch (err) {
      this.deps.log.warn({ err: (err as Error).message }, 'campaign signals: the mark prices could not be read');
      return this.marksCache?.marks ?? new Map();
    }
  }

  private async spec(instId: string): Promise<Instrument | undefined> {
    const known = this.deps.market.specOf(instId) ?? this.specs.get(instId);
    if (known) return known;
    try {
      const [raw] = await this.deps.clients.rest.getInstruments('SWAP', instId);
      if (!raw) return undefined;
      const inst = mapInstrument(raw);
      this.specs.set(instId, inst);
      return inst;
    } catch (err) {
      this.deps.log.warn({ instId, err: (err as Error).message }, 'campaign signals: the contract spec could not be read');
      return undefined;
    }
  }

  /** The exchange's UTC bars: through the market data service for a tracked instrument (which maps 1D and 12H to OKX's UTC bars), the public REST candles otherwise. */
  private exchangeBars(): CampaignBarSource {
    const read = async (instId: string, bar: CandleBar, limit: number): Promise<Candle[]> => {
      if (this.deps.market.getInstrument(instId)) return this.deps.market.fetchCandles(instId, bar, limit);
      const rows = await this.deps.clients.rest.getCandles(instId, toOkxBar(bar), { limit: Math.min(limit, 300) });
      return rows.map(mapCandle).sort((a, b) => a.ts - b.ts);
    };
    return { daily: (instId, limit) => read(instId, '1D', limit), halfDay: (instId, limit) => read(instId, '12H', limit) };
  }

  /** The public mark prices of the SWAPs, one request for all of them. */
  private async restMarks(instIds: string[]): Promise<Map<string, string>> {
    const wanted = new Set(instIds);
    const out = new Map<string, string>();
    for (const m of await this.deps.clients.rest.getMarkPrice('SWAP')) if (wanted.has(m.instId) && m.markPx !== '' && D(m.markPx).gt(0)) out.set(m.instId, m.markPx);
    return out;
  }
}
