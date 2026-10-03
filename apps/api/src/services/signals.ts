import { OkxApiError } from '@pegasus/okx';
import { buildSignalReport, DEFAULT_SIZING, DEFAULT_TREND_PARAMS, type FundingRecord, type InstrumentSignalReport, type SizingParams, type TrendParams } from '@pegasus/shared';
import type { Logger } from '../logger.js';
import type { OkxClients } from '../okx/clients.js';
import { mapCandle } from '../okx/mappers.js';
import type { AccountService } from './account.js';
import type { MarketDataService } from './market-data.js';

export interface SignalsOptions {
  /** Equity used for sizing; defaults to the account's total equity when available */
  equity?: string | undefined;
  riskPct?: string | undefined;
  maxNotionalPct?: string | undefined;
}

export interface SignalsResponse {
  generatedAt: number;
  equity: string | null;
  reports: Array<InstrumentSignalReport | { instId: string; error: { code: string; message: string } }>;
}

interface CacheEntry {
  at: number;
  candles: ReturnType<typeof mapCandle>[];
  funding: FundingRecord[] | null;
}

const CANDLE_CACHE_MS = 5 * 60_000;

/**
 * Daily signal reports: confirmed 1D candles (forming bar excluded) and the
 * recent funding history from the exchange, run through the pure signal
 * arithmetic in @pegasus/shared.
 */
export class SignalsService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly clients: OkxClients,
    private readonly market: MarketDataService,
    private readonly account: AccountService,
    private readonly log: Logger,
    private readonly params: TrendParams = DEFAULT_TREND_PARAMS,
  ) {}

  async report(instIds: string[], opts: SignalsOptions = {}): Promise<SignalsResponse> {
    const now = Date.now();
    const equity = opts.equity ?? this.account.balance?.totalEq ?? null;
    const sizing: SizingParams = {
      riskPct: opts.riskPct ?? DEFAULT_SIZING.riskPct,
      maxNotionalPct: opts.maxNotionalPct ?? DEFAULT_SIZING.maxNotionalPct,
      atrStopMultiple: this.params.atrStopMultiple,
    };
    const reports = await Promise.all(
      instIds.map(async (instId) => {
        try {
          const inst = this.market.requireInstrument(instId);
          const data = await this.load(instId, now);
          return buildSignalReport(instId, data.candles, data.funding, now, inst, equity, this.params, sizing);
        } catch (err) {
          const code = err instanceof OkxApiError ? 'EXCHANGE' : ((err as { code?: string }).code ?? 'INTERNAL');
          this.log.warn({ instId, err: (err as Error).message }, 'signal report failed');
          return { instId, error: { code, message: (err as Error).message } };
        }
      }),
    );
    return { generatedAt: now, equity, reports };
  }

  private async load(instId: string, now: number): Promise<CacheEntry> {
    const cached = this.cache.get(instId);
    if (cached && now - cached.at < CANDLE_CACHE_MS) return cached;
    // 300 is the maximum per call; the newest row is the forming bar and is dropped downstream (confirm=false).
    const rows = await this.clients.rest.getCandles(instId, '1D', { limit: 300 });
    const candles = rows.map(mapCandle).sort((a, b) => a.ts - b.ts);
    let funding: FundingRecord[] | null = null;
    try {
      const hist = await this.clients.rest.getFundingRateHistory(instId, { limit: 30 });
      funding = hist.map((h) => ({ fundingRate: h.fundingRate, fundingTime: Number(h.fundingTime) }));
    } catch (err) {
      this.log.warn({ instId, err: (err as Error).message }, 'funding history unavailable; signals computed without the funding filter');
    }
    const entry: CacheEntry = { at: now, candles, funding };
    this.cache.set(instId, entry);
    return entry;
  }
}
