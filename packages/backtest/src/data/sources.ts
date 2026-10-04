import { OKX_REST_URL, OkxApiError, OkxHttpError, OkxRestClient, OkxTransportError, type OkxCandleRow, type OkxInstrument } from '@pegasus/okx';
import type { Candle, FundingRecord, Instrument } from '@pegasus/shared';
import type { Fetchers } from './load.js';

/**
 * The real history sources: OKX public endpoints through the OkxRestClient (no key needed) and, for
 * funding, Binance. OKX keeps about three months of funding settlements, so docs/strategy.md section 5
 * names another venue's full history of the same pair as the proxy for a multi-year backtest.
 */

const BINANCE_FUNDING_URL = 'https://fapi.binance.com/fapi/v1/fundingRate';
const BINANCE_PAGE = 1000;
/** OKX returns at most this many history candles and open interest rows per call. */
const OKX_PAGE = 100;
// history-candles allows 20 requests per 2 seconds, the trading-statistics endpoints 5 per 2 seconds.
const CANDLE_GAP_MS = 150;
const OI_GAP_MS = 450;
const FUNDING_GAP_MS = 250;
const RETRY_BACKOFF_MS = [1_000, 3_000] as const;
const MINUTE_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs calls one at a time, at least `gapMs` apart. */
function throttled(gapMs: number): <T>(call: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return <T>(call: () => Promise<T>): Promise<T> => {
    const run = tail.then(call);
    tail = run.then(
      () => sleep(gapMs),
      () => sleep(gapMs),
    );
    return run;
  };
}

/** A failure that says nothing about the request: no answer, a rate limit, a server error. */
function isTransient(err: unknown): boolean {
  if (err instanceof OkxTransportError) return true;
  if (err instanceof OkxApiError) return err.isRateLimited;
  if (err instanceof OkxHttpError) return err.status === 429 || err.status >= 500;
  return err instanceof TransientError;
}

class TransientError extends Error {}

async function withRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const delay = RETRY_BACKOFF_MS[attempt];
      if (delay === undefined || !isTransient(err)) throw err;
      await sleep(delay);
    }
  }
}

function toCandle(row: OkxCandleRow): Candle {
  return { ts: Number(row[0]), open: row[1], high: row[2], low: row[3], close: row[4], vol: row[5], volCcy: row[6], confirm: row[8] === '1' };
}

function toInstrument(i: OkxInstrument): Instrument {
  const [base = '', quote = ''] = (i.uly || i.instFamily || i.instId.replace(/-SWAP$/, '')).split('-');
  return {
    instId: i.instId,
    instType: 'SWAP',
    uly: i.uly || i.instFamily,
    baseCcy: i.baseCcy || base,
    quoteCcy: i.quoteCcy || quote,
    settleCcy: i.settleCcy,
    ctVal: i.ctVal,
    ctValCcy: i.ctValCcy,
    ctMult: i.ctMult || '1',
    ctType: i.ctType === 'inverse' ? 'inverse' : 'linear',
    lotSz: i.lotSz,
    minSz: i.minSz,
    tickSz: i.tickSz,
    maxLmtSz: i.maxLmtSz || '0',
    maxMktSz: i.maxMktSz || '0',
    maxLever: i.lever || '1',
    state: i.state,
  };
}

/** BTC-USDT-SWAP -> BTCUSDT: the same pair's perpetual on Binance. */
export function binanceSymbol(instId: string): string {
  const [base = '', quote = ''] = instId.split('-');
  return `${base}${quote}`;
}

interface BinanceFundingRow {
  fundingTime: number;
  fundingRate: string;
}

export interface SourceOptions {
  okxBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function createFetchers(opts: SourceOptions = {}): Fetchers {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const rest = new OkxRestClient({ baseUrl: opts.okxBaseUrl ?? OKX_REST_URL, timeoutMs: 20_000, fetchImpl });
  const candleQueue = throttled(CANDLE_GAP_MS);
  const oiQueue = throttled(OI_GAP_MS);
  const fundingQueue = throttled(FUNDING_GAP_MS);
  return {
    async instrument(instId) {
      const [inst] = await withRetry(() => rest.getInstruments('SWAP', instId));
      if (!inst) throw new Error(`OKX lists no swap ${instId}`);
      return toInstrument(inst);
    },
    async candles(instId, bar, after) {
      const rows = await candleQueue(() => withRetry(() => rest.getHistoryCandles(instId, bar, after === undefined ? { limit: OKX_PAGE } : { limit: OKX_PAGE, after })));
      return rows.map(toCandle);
    },
    openInterest(instId, period, end) {
      return oiQueue(() => withRetry(() => rest.getOpenInterestHistory(instId, period, end === undefined ? { limit: OKX_PAGE } : { limit: OKX_PAGE, end })));
    },
    fundingPageSize: BINANCE_PAGE,
    funding(instId, startTime) {
      const url = `${BINANCE_FUNDING_URL}?symbol=${binanceSymbol(instId)}&startTime=${startTime}&limit=${BINANCE_PAGE}`;
      return fundingQueue(() =>
        withRetry(async (): Promise<FundingRecord[] | null> => {
          let res: Response;
          try {
            res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
          } catch (err) {
            const cause = (err as { cause?: { code?: unknown } }).cause;
            throw new TransientError(`could not reach Binance (${typeof cause?.code === 'string' ? cause.code : (err as Error).message})`);
          }
          const text = await res.text();
          // -1121 Invalid symbol: Binance does not list this pair.
          if (res.status === 400 && text.includes('-1121')) return null;
          if (res.status === 429 || res.status >= 500) throw new TransientError(`Binance HTTP ${res.status}`);
          if (!res.ok) throw new Error(`Binance HTTP ${res.status}: ${text.slice(0, 200)}`);
          const rows = JSON.parse(text) as BinanceFundingRow[];
          // Binance stamps a settlement a few milliseconds late; the settlement itself is on the minute.
          return rows.map((r) => ({ fundingRate: r.fundingRate, fundingTime: Math.round(r.fundingTime / MINUTE_MS) * MINUTE_MS }));
        }),
      );
    },
  };
}
