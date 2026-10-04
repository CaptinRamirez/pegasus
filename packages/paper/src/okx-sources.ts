import { d } from '@pegasus/mock-okx/engine';
import type { OkxRestClient } from '@pegasus/okx';
import { BAR_MS, fetchBars, type BarSource } from './bars.js';
import type { FundingSource } from './funding.js';

/** Pause between history pages: the history endpoints allow 20 requests per 2 seconds per IP. */
const PAGE_PAUSE_MS = 120;
const FUNDING_PAGE = 100;

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
