import { d, isDecimalString, type OkxInstrument } from '@pegasus/mock-okx/engine';
import type { OkxRestClient } from '@pegasus/okx';
import { BAR_MS, fetchBars, type BarSource } from './bars.js';
import type { FundingSource } from './funding.js';

/** Pause between history pages: the history endpoints allow 20 requests per 2 seconds per IP. */
const PAGE_PAUSE_MS = 120;
const FUNDING_PAGE = 100;
/** The position tiers endpoint takes "no more than 5" instrument families per request (10 requests per 2 seconds per IP). */
const TIER_FAMILIES = 5;

/**
 * The tier-1 maintenance margin rate of each instrument, from OKX's position tiers for isolated margin
 * (GET /api/v5/public/position-tiers?instType=SWAP&tdMode=isolated&tier=1): the rate an isolated position of the
 * paper account is liquidated by. An instrument whose rate cannot be read, or is not a rate, is left out and
 * named in the log: the engine then uses its fallback, half the initial margin rate of the instrument's highest
 * leverage (1 / (2 x lever)), which is never below OKX's tier-1 rate, so nothing is liquidated later than there.
 */
export async function okxTier1Mmr(rest: OkxRestClient, instruments: readonly OkxInstrument[], log: (msg: string) => void = () => {}): Promise<Record<string, string>> {
  const familyOf = (inst: { instFamily: string; uly: string }): string => inst.instFamily || inst.uly;
  const families = [...new Set(instruments.map(familyOf))];
  const rates: Record<string, string> = {};
  for (let i = 0; i < families.length; i += TIER_FAMILIES) {
    const batch = families.slice(i, i + TIER_FAMILIES);
    try {
      if (i > 0) await new Promise((r) => setTimeout(r, PAGE_PAUSE_MS));
      const res = await rest.request<{ instFamily: string; uly: string; tier: string; mmr: string }>('GET', '/api/v5/public/position-tiers', { query: { instType: 'SWAP', tdMode: 'isolated', instFamily: batch.join(','), tier: '1' } });
      for (const row of res.data) {
        if (row.tier !== '1' || !isDecimalString(row.mmr) || d(row.mmr).lte(0) || d(row.mmr).gte(1)) continue;
        for (const inst of instruments) if (familyOf(inst) === familyOf(row)) rates[inst.instId] = row.mmr;
      }
    } catch (err) {
      log(`the position tiers of ${batch.join(', ')} could not be read (${(err as Error).message})`);
    }
  }
  const missing = instruments.filter((inst) => rates[inst.instId] === undefined).map((inst) => inst.instId);
  if (missing.length > 0) log(`no tier-1 maintenance margin rate from OKX for ${missing.join(', ')}: isolated positions there are liquidated by half the initial margin rate of the highest leverage, which is not below OKX's rate`);
  return rates;
}

/** Candles of the real exchange: traded prices and mark prices, each from its recent and its history endpoint. */
export function okxBarSource(rest: OkxRestClient): BarSource {
  return {
    tradeBars: (instId, bar, from, to) =>
      fetchBars(
        ({ limit }) => rest.getCandles(instId, bar, { limit }),
        ({ after, limit }) => rest.getHistoryCandles(instId, bar, after === undefined ? { limit } : { after, limit }),
        BAR_MS[bar],
        from,
        to,
        { recentLimit: 300, historyLimit: 100, pauseMs: PAGE_PAUSE_MS },
      ),
    markBars: (instId, bar, from, to) =>
      fetchBars(
        ({ limit }) => rest.getMarkPriceCandles(instId, bar, { limit }),
        ({ after, limit }) => rest.getHistoryMarkPriceCandles(instId, bar, after === undefined ? { limit } : { after, limit }),
        BAR_MS[bar],
        from,
        to,
        { recentLimit: 100, historyLimit: 100, pauseMs: PAGE_PAUSE_MS },
      ),
  };
}

/** Settled funding of the real exchange, with the rate that was actually charged, and the mark price of a settlement time. */
export function okxFundingSource(rest: OkxRestClient): FundingSource {
  return {
    async settlements(instId, after, now) {
      const rows: Array<{ fundingTime: number; rate: string }> = [];
      let cursor: number | undefined;
      for (let page = 0; page < 50; page++) {
        const opts: { after?: number; limit: number } = { limit: FUNDING_PAGE };
        if (cursor !== undefined) opts.after = cursor;
        const batch = await rest.getFundingRateHistory(instId, opts);
        let oldest = Infinity;
        for (const r of batch) {
          const fundingTime = Number(r.fundingTime);
          if (fundingTime < oldest) oldest = fundingTime;
          if (fundingTime > after && fundingTime <= now) rows.push({ fundingTime, rate: r.realizedRate || r.fundingRate });
        }
        if (batch.length < FUNDING_PAGE || oldest <= after) break;
        cursor = oldest;
      }
      return rows.sort((a, b) => a.fundingTime - b.fundingTime);
    },
    async markAt(instId, ts) {
      // `after` returns the bars older than it, newest first: the first row is the bar that opens at `ts`.
      const opts = { after: ts + BAR_MS['1m'], limit: 1 };
      for (const read of [() => rest.getMarkPriceCandles(instId, '1m', opts), () => rest.getHistoryMarkPriceCandles(instId, '1m', opts)]) {
        const [row] = await read();
        if (row && Number(row[0]) === ts && d(row[1]).gt(0)) return d(row[1]);
      }
      return null;
    },
  };
}
