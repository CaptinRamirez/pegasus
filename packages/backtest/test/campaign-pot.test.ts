import { D, dailyBarsFromHalfDays, DEFAULT_POT_PARAMS, sameCloseOrder, type CampaignPotRecord, type CampaignRecord as LedgerCampaign, type Candle, type FundingRecord } from '@pegasus/shared';
import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../src/data/cache.js';
import type { Fetchers, HistoryBar } from '../src/data/load.js';
import { DEFAULT_RECONCILE_TOLERANCES, heldInBtc, parseLedger, reconcileCampaigns, replayPot, type PotReplay, type PotReplayInput } from '../src/campaign/pot.js';
import type { CampaignRecord } from '../src/campaign/types.js';
import { day, FLAT_DAY, halves, QUIET, RISE_AND_EXIT, SETUP, SHORT, SIGNAL_DAY, type Row } from './campaign-helpers.js';
import { DAY, HALF_DAY, HOUR, instrument } from './helpers.js';

const BTC = 'BTC-USDT-SWAP';
const ETH = 'ETH-USDT-SWAP';
const ADA = 'ADA-USDT-SWAP';
const XRP = 'XRP-USDT-SWAP';
const LTC = 'LTC-USDT-SWAP';

/** An exchange that has these 12-hour bars (daily bars made of them), the running bar opening at the last close at `running`. */
function exchange(rows: Record<string, readonly Row[]>, running: Record<string, string> = {}, funding: Record<string, FundingRecord[]> = {}): Fetchers & { pages: number } {
  const halfDay = new Map(Object.entries(rows).map(([instId, r]) => [instId, halves(r)]));
  const fetchers = {
    pages: 0,
    instrument: async (instId: string) => instrument(instId),
    candles: async (instId: string, bar: HistoryBar, after: number | undefined): Promise<Candle[]> => {
      fetchers.pages++;
      const bars = halfDay.get(instId) ?? [];
      const all = bar === '12Hutc' ? bars : dailyBarsFromHalfDays(bars, 0);
      return all.filter((c) => after === undefined || c.ts < after).slice(-100).reverse();
    },
    openInterest: async () => [],
    funding: async (instId: string, startTime: number) => (funding[instId] ?? []).filter((r) => r.fundingTime >= startTime),
    fundingPageSize: Number.POSITIVE_INFINITY,
    latest: async (instId: string): Promise<Candle[]> => {
      const last = (halfDay.get(instId) ?? []).at(-1);
      const open = running[instId];
      return last && open !== undefined ? [last, { ...last, ts: last.ts + HALF_DAY, open, high: open, low: open, close: open, confirm: false }] : last ? [last] : [];
    },
  };
  return fetchers;
}

/** The pot started three hours after the close of day 3: it looks at closes from day 3, 12:00 on. */
const POT: CampaignPotRecord = {
  startedAt: day(3) + 3 * HOUR,
  startValue: '56',
  btcMarkAtStart: '100',
  structure: 'noadd',
  start: '56',
  minStake: '5.6',
  banked: '0',
  rungs: 0,
  peak: null,
  finishedAt: null,
};

const at = (px: number): Row => [px, px + 1, px - 1, px];
/**
 * BTC: an entry at day 4 (it stakes first of the two of that close), the harvest at the close at 400 (day 5, 12:00)
 * sold at the next open, the exit at day 8. ADA: an entry at day 4 liquidated in its entry bar. XRP: an entry at
 * day 5, still open at the end (day 8, 12:00), part of it sold by the harvest.
 */
const WORLD: Record<string, readonly Row[]> = {
  [BTC]: RISE_AND_EXIT,
  [ADA]: [...SETUP, [100, 100.5, 90, 95], ...Array.from({ length: 8 }, () => at(95))],
  [XRP]: [...FLAT_DAY, ...FLAT_DAY, ...FLAT_DAY, ...FLAT_DAY, ...SIGNAL_DAY, ...Array.from({ length: 7 }, () => QUIET)],
};
const END = day(8) + HALF_DAY;

function input(campaigns: LedgerCampaign[] = [], over: Partial<PotReplayInput> = {}): PotReplayInput {
  return { pot: POT, campaigns, instruments: [BTC, ADA, XRP], params: SHORT, potParams: DEFAULT_POT_PARAMS, now: END + HOUR, ...over };
}

/** A ledger campaign as a live service that traded exactly as the replay would have: its fills off by `off`, its multiple by 1%. */
function live(r: CampaignRecord, off = '0.002'): LedgerCampaign {
  const fill = { ts: r.entryTime + 5_000, ordId: `o-${r.instId}`, clOrdId: 'pc1', contracts: r.contracts, qty: '0', avgPx: D(r.entryPx).mul(D(1).plus(off)).toFixed(), fee: '0.01' };
  const sale = { ...fill, closeTs: day(5) + HALF_DAY, held: r.contracts, pnl: '1', proceeds: '1' };
  return {
    id: `${r.instId}@${r.entryTime}`,
    instId: r.instId,
    signalTs: r.signalTs,
    entry: { ...fill, closeTs: r.entryTime, price: '0', stake: r.stake, margin: '0' },
    adds: [],
    sales: Array.from({ length: r.sales }, () => sale),
    addRef: '0',
    addUnit: '0',
    stake: r.stake,
    basis: r.stake,
    harvested: r.harvested,
    peak: '1',
    pendingExit: null,
    end: r.open
      ? null
      : r.end === 'liquidated'
        ? { kind: 'liquidated', ts: r.endTime + 3 * HOUR, proceeds: '0', fill: null }
        : { kind: 'exit', ts: r.endTime + 5_000, proceeds: r.proceeds, fill: null, closeTs: r.endTime, delayMs: 5_000 },
    multiple: r.open ? null : D(r.multiple).mul('1.01').toSignificantDigits(15).toFixed(),
  };
}

const replay = async (campaigns: LedgerCampaign[] = [], over: Partial<PotReplayInput> = {}, running: Record<string, string> = {}): Promise<PotReplay> =>
  replayPot(input(campaigns, over), { fetchers: exchange(WORLD, running), cache: new MemoryCache() });

describe('the replay beside the pot', () => {
  it('replays from the first close after the start to the last close, with its own structure and the other one beside it', async () => {
    const r = await replay();
    expect(r).toMatchObject({ from: day(3) + HALF_DAY, through: END });
    expect(r.same).toMatchObject({ structure: 'noadd', finished: false });
    expect(r.other.structure).toBe('pyramid');
    // one sample per 12-hour close from the start on
    expect(r.same.samples.map((s) => s.ts)).toEqual(Array.from({ length: 11 }, (_, i) => day(3) + HALF_DAY + i * HALF_DAY));
    expect(r.same.samples[0]).toEqual({ ts: day(3) + HALF_DAY, value: '56', banked: '0' });
    const byInst = new Map(r.same.campaigns.map((c) => [c.instId, c]));
    expect(byInst.get(BTC)).toMatchObject({ signalTs: day(3), entryTs: day(4), entryPx: '100.05', adds: 0, end: 'exit', endTs: day(8) });
    expect(byInst.get(ADA)).toMatchObject({ entryTs: day(4), entryPx: '100.1', end: 'liquidated', endTs: day(4), multiple: '0' });
    expect(byInst.get(XRP)).toMatchObject({ signalTs: day(4), entryTs: day(5), entryPx: '100.1', end: 'open', endTs: null, multiple: null });
    // signalTs is the open time of the daily bar whose close gave the signal, as in the ledger: the signal close, a day
    // later, is the open the entry was filled at
    for (const c of r.same.campaigns) expect(c.signalTs + DAY).toBe(c.entryTs);
    // oldest first; BTC staked first at day 4, half the pot
    expect(r.same.campaigns.map((c) => c.instId)).toEqual([ADA, BTC, XRP]);
    expect(sameCloseOrder([BTC, ADA], day(4))).toEqual([BTC, ADA]);
    expect(byInst.get(BTC)?.stake).toBe(D('2.78').mul('100.05').mul('0.1005').toFixed());
    // the harvest at the close at 400, what it banked, and the pot at the end
    expect(r.same.bankings).toHaveLength(1);
    expect(r.same.bankings[0]?.closeTs).toBe(day(5) + HALF_DAY);
    expect(r.same.banked).toBe(r.same.bankings[0]?.amount);
    expect(r.same.value).toBe(r.same.samples.at(-1)?.value);
    // pyramided, the campaign at 400 adds
    expect(r.other.campaigns.find((c) => c.instId === BTC)?.adds).toBeGreaterThan(0);
    expect(r.results.same.campaigns.map((c) => [c.instId, c.sales])).toEqual([[ADA, 0], [BTC, 1], [XRP, 1]]);
  });

  it('holds the start value in BTC from the mark at the start, or the close before it', async () => {
    const r = await replay();
    // 56 x close / 100 at every close from day 3, 12:00 on: 100.5, 103, 100, 100, 400, ...
    expect(r.heldBtc.slice(0, 5)).toEqual([
      { ts: day(3) + HALF_DAY, value: '56.28' },
      { ts: day(4), value: '57.68' },
      { ts: day(4) + HALF_DAY, value: '56' },
      { ts: day(5), value: '56' },
      { ts: day(5) + HALF_DAY, value: '224' },
    ]);
    expect(r.heldBtc.at(-1)).toEqual({ ts: END, value: '196' });
    // without the mark, the close of the last bar before the start (day 3, 00:00: 100)
    const halfDay = halves(WORLD[BTC] as Row[]);
    expect(heldInBtc(halfDay, { ...POT, btcMarkAtStart: '' }, '56', day(3) + HALF_DAY, END)).toEqual(r.heldBtc);
    expect(heldInBtc(halfDay, { ...POT, btcMarkAtStart: '200' }, '56', day(3) + HALF_DAY, END)[0]).toEqual({ ts: day(3) + HALF_DAY, value: '28.14' });
  });

  it('starts the free cash at the start value and keeps the rungs on the start', async () => {
    const r = await replay([], { pot: { ...POT, startValue: '55.6' } });
    expect(r.same.samples[0]).toEqual({ ts: day(3) + HALF_DAY, value: '55.6', banked: '0' });
    expect(r.heldBtc[0]).toEqual({ ts: day(3) + HALF_DAY, value: D('55.6').mul('1.005').toFixed() });
  });

  it('fills what the last close decided at the open of the running bar (C14)', async () => {
    // The data ends with the signal close of day 3: the entry is filled at the running bar's open, 104.
    const rows = { [BTC]: SETUP, [ETH]: SETUP.map((): Row => QUIET) };
    const now = day(4) + 60_000;
    const without = await replayPot(input([], { now, instruments: [BTC, ETH] }), { fetchers: exchange(rows), cache: new MemoryCache() });
    expect(without.through).toBe(day(4));
    expect(without.same.campaigns).toEqual([]);
    const withRunning = await replayPot(input([], { now, instruments: [BTC, ETH] }), { fetchers: exchange(rows, { [BTC]: '104', [ETH]: '100' }), cache: new MemoryCache() });
    expect(withRunning.same.campaigns).toMatchObject([{ instId: BTC, entryTs: day(4), entryPx: '104.052', end: 'open' }]);
  });

  it('ends at the last close every instrument has, unless one lags by more than a day', async () => {
    const lagging = { ...WORLD, [XRP]: (WORLD[XRP] as Row[]).slice(0, -1) };
    const r = await replayPot(input(), { fetchers: exchange(lagging), cache: new MemoryCache() });
    expect(r.through).toBe(END - HALF_DAY);
    const stale = { ...WORLD, [XRP]: (WORLD[XRP] as Row[]).slice(0, -4) };
    const s = await replayPot(input(), { fetchers: exchange(stale), cache: new MemoryCache() });
    expect(s.through).toBe(END);
    expect(s.notes.some((n) => n.startsWith(`${XRP}: its bars end at`))).toBe(true);
  });

  it('reads only the span of the pot and keeps it in the cache', async () => {
    const cache = new MemoryCache();
    const fetchers = exchange(WORLD);
    await replayPot(input(), { fetchers, cache });
    const pages = fetchers.pages;
    expect(cache.read<Candle[]>(`${BTC}.candles-12Hutc`)).toHaveLength(17);
    await replayPot(input(), { fetchers, cache });
    // one page per series (three instruments, daily and 12-hour), the newest: nothing older is asked for again
    expect(fetchers.pages - pages).toBe(6);
  });
});

describe('the reconciliation of the ledger with the replay', () => {
  it('matches a ledger that traded as the replay: the exit, the liquidation, the harvest sale, the campaign still open', async () => {
    const first = await replay();
    const ledger = first.results.same.campaigns.map((c) => live(c));
    const r = await replay(ledger);
    expect(r.reconciliation).toMatchObject({ tolerances: DEFAULT_RECONCILE_TOLERANCES, matched: 3, differing: 0, liveOnly: 0, replayOnly: 0 });
    expect(r.reconciliation.rows.map((x) => [x.instId, x.verdict, x.campaignId])).toEqual([
      [ADA, 'match', `${ADA}@${day(4)}`],
      [BTC, 'match', `${BTC}@${day(4)}`],
      [XRP, 'match', `${XRP}@${day(5)}`],
    ]);
  });

  it('says what differs: the adds, the harvest sales, the entry price beyond its tolerance, the multiple, the end', async () => {
    const replayed = (await replay()).results.same.campaigns;
    const btc = replayed.find((c) => c.instId === BTC) as CampaignRecord;
    const base = live(btc);
    const add = { ...base.entry, closeTs: day(6) };
    const cases: Array<[LedgerCampaign, Array<{ field: string; live: string | null; replay: string | null }>]> = [
      [{ ...base, adds: [add] }, [{ field: 'adds', live: '1', replay: '0' }]],
      // an add after `through` is not made yet
      [{ ...base, adds: [{ ...add, closeTs: END + HALF_DAY }] }, []],
      [{ ...base, sales: [] }, [{ field: 'sales', live: '0', replay: '1' }]],
      [live(btc, '0.011'), [{ field: 'entryPx', live: D(btc.entryPx).mul('1.011').toFixed(), replay: btc.entryPx }]],
      [{ ...base, multiple: D(btc.multiple).mul('1.2').toFixed() }, [{ field: 'multiple', live: D(btc.multiple).mul('1.2').toFixed(), replay: btc.multiple }]],
      [
        { ...base, end: { kind: 'exit', ts: day(7) + 5_000, proceeds: '1', fill: null, closeTs: day(7) } },
        [{ field: 'endClose', live: String(day(7)), replay: String(day(8)) }],
      ],
      [
        { ...base, end: { kind: 'external', ts: day(7) + HOUR, proceeds: '', fill: null }, multiple: null },
        [
          { field: 'end', live: 'external', replay: 'exit' },
          { field: 'endClose', live: String(day(7)), replay: String(day(8)) },
        ],
      ],
    ];
    for (const [ledger, expected] of cases) {
      const row = reconcileCampaigns([ledger], [btc], END).rows[0];
      expect(row).toMatchObject({ instId: BTC, signalTs: day(3), campaignId: base.id, verdict: expected.length === 0 ? 'match' : 'differs' });
      expect(row?.differences).toEqual(expected);
    }
  });

  it('lists the campaigns one side has and the other has not, and leaves out what the replay cannot have yet', async () => {
    const replayed = (await replay()).results.same.campaigns;
    const ledger = replayed.filter((c) => c.instId !== XRP).map((c) => live(c));
    const ltc: LedgerCampaign = { ...live(replayed[0] as CampaignRecord), id: `${LTC}@${day(4)}`, instId: LTC };
    // entered at a close after `through`: not replayed yet
    const later: LedgerCampaign = { ...live(replayed[0] as CampaignRecord), id: `${ETH}@${END + HALF_DAY}`, instId: ETH, signalTs: END - HALF_DAY, entry: { ...live(replayed[0] as CampaignRecord).entry, closeTs: END + HALF_DAY } };
    const r = reconcileCampaigns([...ledger, ltc, later], replayed, END);
    expect(r).toMatchObject({ matched: 2, differing: 0, liveOnly: 1, replayOnly: 1 });
    expect(r.rows.find((x) => x.instId === LTC)).toEqual({ instId: LTC, signalTs: day(3), campaignId: `${LTC}@${day(4)}`, verdict: 'live-only', differences: [] });
    expect(r.rows.find((x) => x.instId === XRP)).toEqual({ instId: XRP, signalTs: day(4), campaignId: null, verdict: 'replay-only', differences: [] });
    expect(r.rows.map((x) => x.signalTs)).toEqual([...r.rows.map((x) => x.signalTs)].sort((a, b) => a - b));
  });

  it("takes a liquidation by the bar it happened in, and one in the bar running after `through` as not seen yet", async () => {
    const replayed = (await replay()).results.same.campaigns;
    const ada = replayed.find((c) => c.instId === ADA) as CampaignRecord;
    const xrp = replayed.find((c) => c.instId === XRP) as CampaignRecord;
    // ADA: liquidated by the exchange late in its entry bar; the replay on that bar's low
    expect(reconcileCampaigns([live(ada)], [ada], END).rows[0]?.verdict).toBe('match');
    // a bar later on the exchange
    const late: LedgerCampaign = { ...live(ada), end: { kind: 'liquidated', ts: day(4) + HALF_DAY + HOUR, proceeds: '0', fill: null } };
    expect(reconcileCampaigns([late], [ada], END).rows[0]?.differences).toEqual([{ field: 'endClose', live: String(day(4) + HALF_DAY), replay: String(day(4)) }]);
    // XRP liquidated on the exchange after the last close replayed: still open as far as the replay goes
    const after: LedgerCampaign = { ...live(xrp), end: { kind: 'liquidated', ts: END + HOUR, proceeds: '0', fill: null }, multiple: '0' };
    expect(reconcileCampaigns([after], [xrp], END).rows[0]).toMatchObject({ verdict: 'match', differences: [] });
    // and once the replay has that bar: liquidated live, not in the replay
    expect(reconcileCampaigns([after], [xrp], END + HALF_DAY).rows[0]?.differences).toEqual([{ field: 'end', live: 'liquidated', replay: 'open' }]);
  });

  it('applies the tolerances it is given', async () => {
    const replayed = (await replay()).results.same.campaigns;
    const btc = replayed.find((c) => c.instId === BTC) as CampaignRecord;
    expect(reconcileCampaigns([live(btc)], [btc], END, { entryPx: '0.001', multiple: '0.001' }).rows[0]?.differences.map((d) => d.field)).toEqual(['entryPx', 'multiple']);
  });
});

describe('a ledger file', () => {
  it('gives the pot and the campaigns of the ledger the API writes, and refuses anything else', () => {
    const ledger = { version: 1, pot: POT, campaigns: [], bankings: [], samples: [], steps: [], stepSeq: 0, errors: [], errorCount: 0, missedCloses: 0, lastClose: null, foreign: [] };
    expect(parseLedger(ledger)).toEqual({ pot: POT, campaigns: [] });
    expect(() => parseLedger({ ...ledger, pot: null })).toThrow(/has not started/);
    expect(() => parseLedger({ ...ledger, pot: { ...POT, structure: 'martingale' } })).toThrow(/structure/);
    expect(() => parseLedger({ ...ledger, campaigns: [{ id: 'x' }] })).toThrow(/not complete/);
    expect(() => parseLedger([])).toThrow(/JSON object/);
  });
});

