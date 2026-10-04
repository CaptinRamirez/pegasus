/**
 * Not a test: a manual check of the OKX sources against the real exchange (needs the network).
 * Run with `pnpm --filter @pegasus/paper exec tsx test/live-sources.manual.ts`.
 */
import { OkxRestClient, defaultEndpoints } from '@pegasus/okx';
import { okxBarSource, okxFundingSource } from '../src/index.js';

const rest = new OkxRestClient({ baseUrl: defaultEndpoints(false).rest });
const instId = process.argv[2] ?? 'BTC-USDT-SWAP';
const now = Date.now();

const funding = okxFundingSource(rest);
const settled = await funding.settlements(instId, now - 26 * 3_600_000, now);
console.log(`${instId}: ${settled.length} settlement(s) in the last 26 hours`);
for (const s of settled) {
  const mark = await funding.markAt(instId, s.fundingTime);
  console.log(`  ${new Date(s.fundingTime).toISOString()} rate ${s.rate} mark ${mark === null ? 'NOT FOUND' : mark.toFixed()}`);
}

const bars = okxBarSource(rest);
const from = now - 3 * 3_600_000;
const [trade, mark] = await Promise.all([bars.tradeBars(instId, '1m', from, now), bars.markBars(instId, '1m', from, now)]);
const span = (rows: { ts: number }[]): string => (rows.length === 0 ? 'none' : `${new Date(rows[0]?.ts ?? 0).toISOString()} .. ${new Date(rows[rows.length - 1]?.ts ?? 0).toISOString()}`);
console.log(`one-minute bars of the last 3 hours: ${trade.length} trade (${span(trade)}), ${mark.length} mark (${span(mark)})`);
const gaps = trade.filter((b, i) => i > 0 && b.ts - (trade[i - 1]?.ts ?? 0) !== 60_000).length;
console.log(`gaps between consecutive trade bars: ${gaps}`);
