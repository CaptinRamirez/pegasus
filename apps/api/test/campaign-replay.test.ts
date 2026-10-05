/**
 * The replay beside the pot (services/campaign-replay.ts): computed in the background from injected data, one
 * computation at a time, given up after its timeout, a failure reported with the last result kept, and its summary
 * pushed when it changes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { MemoryCache, type Fetchers } from '@pegasus/backtest/campaign';
import { dailyBarsFromHalfDays, DEFAULT_CAMPAIGN_PARAMS, type CampaignPotRecord, type CampaignReplaySummary, type Candle, type Instrument } from '@pegasus/shared';
import { CampaignReplayService, type CampaignReplaySource } from '../src/services/campaign-replay.js';

const log = pino({ level: 'silent' });
const BTC = 'BTC-USDT-SWAP';
const T0 = Date.UTC(2022, 0, 1);
const DAY = 86_400_000;
const HALF = DAY / 2;
const HOUR = 3_600_000;
const day = (n: number): number => T0 + n * DAY;

type Row = readonly [number, number, number, number];
const FLAT: Row = [100, 101, 99, 100];
const QUIET: Row = [100, 100.5, 99.5, 100];
/** Three flat days, then a day that closes at 103 above them (an entry at the open of day 4), then a quiet day. */
const ROWS: Row[] = [FLAT, FLAT, FLAT, FLAT, FLAT, FLAT, [100, 100.8, 99.5, 100.5], [100.5, 103.5, 100, 103], QUIET, QUIET];
const HALVES: Candle[] = ROWS.map(([o, h, l, c], i) => ({ ts: T0 + i * HALF, open: String(o), high: String(h), low: String(l), close: String(c), vol: '1', volCcy: '1', confirm: true }));

const SPEC: Instrument = {
  instId: BTC, instType: 'SWAP', uly: 'BTC-USDT', baseCcy: 'BTC', quoteCcy: 'USDT', settleCcy: 'USDT', ctVal: '0.01', ctValCcy: 'BTC', ctMult: '1',
  ctType: 'linear', lotSz: '1', minSz: '1', tickSz: '0.1', maxLmtSz: '0', maxMktSz: '0', maxLever: '100', state: 'live',
};

const POT: CampaignPotRecord = { startedAt: day(3) + HOUR, startValue: '56', btcMarkAtStart: '100', structure: 'pyramid', start: '56', minStake: '5.6', banked: '0', rungs: 0, peak: null, finishedAt: null };

/** The exchange's data; its candles can be made to fail or to hang. */
class Data {
  calls = 0;
  fail: string | null = null;
  hang: Promise<void> | null = null;

  fetchers(): Fetchers {
    return {
      instrument: async () => SPEC,
      candles: async (_instId, bar, after) => {
        this.calls++;
        if (this.hang) await this.hang;
        if (this.fail !== null) throw new Error(this.fail);
        const rows = bar === '12Hutc' ? HALVES : dailyBarsFromHalfDays(HALVES, 0);
        return rows.filter((c) => after === undefined || c.ts < after).reverse();
      },
      openInterest: async () => [],
      funding: async () => [],
      fundingPageSize: Number.POSITIVE_INFINITY,
    };
  }
}

interface Setup {
  data: Data;
  replay: CampaignReplayService;
  changes: CampaignReplaySummary[];
  pot: { started: boolean };
}

let running: CampaignReplayService[] = [];

function setup(timeoutMs = 60_000): Setup {
  const data = new Data();
  const pot = { started: true };
  const source: CampaignReplaySource = {
    unavailable: () => (pot.started ? null : { code: 'POT_NOT_STARTED', message: 'the pot has not started: there is nothing to replay yet' }),
    input: () => ({ pot: POT, campaigns: [], instruments: [BTC], params: { ...DEFAULT_CAMPAIGN_PARAMS, entryChannel: 3, exitChannel: 2 }, now: day(5) + HOUR }),
  };
  const replay = new CampaignReplayService(source, { sources: { fetchers: data.fetchers(), cache: new MemoryCache() }, timeoutMs }, log, () => day(5) + 2 * HOUR);
  const changes: CampaignReplaySummary[] = [];
  replay.on('change', (s) => changes.push(s));
  running.push(replay);
  return { data, replay, changes, pot };
}

afterEach(async () => {
  for (const r of running) r.stop();
  running = [];
});

describe('the replay beside the pot', () => {
  it('is unavailable without a pot; with one it is computed in the background when asked, and its summary is pushed', async () => {
    const s = setup();
    s.pot.started = false;
    expect(s.replay.summary()).toEqual({ status: 'unavailable', computedAt: null, mismatches: null });
    expect(s.replay.view()).toEqual({ status: 'unavailable', reason: { code: 'POT_NOT_STARTED', message: 'the pot has not started: there is nothing to replay yet' }, computedAt: null, through: null, same: null, other: null, heldBtc: [], reconciliation: null });
    expect(s.replay.refresh()).toBe(false);
    expect(s.data.calls).toBe(0);

    s.pot.started = true;
    expect(s.replay.summary().status).toBe('running');
    expect(s.replay.refresh()).toBe(true);
    await s.replay.idle();
    const view = s.replay.view();
    expect(view).toMatchObject({ status: 'ready', reason: null, computedAt: day(5) + 2 * HOUR, through: day(5) });
    // the entry of day 4 is the replay's alone: the ledger has none
    expect(view.same?.campaigns).toMatchObject([{ instId: BTC, signalTs: day(3), entryTs: day(4), entryPx: '100.05', end: 'open' }]);
    expect(view.reconciliation).toMatchObject({ matched: 0, differing: 0, liveOnly: 0, replayOnly: 1 });
    expect(view.heldBtc.at(-1)).toEqual({ ts: day(5), value: '56' });
    expect(s.changes).toEqual([
      { status: 'running', computedAt: null, mismatches: null },
      { status: 'ready', computedAt: day(5) + 2 * HOUR, mismatches: 1 },
    ]);
  });

  it('keeps the last result when a computation fails and says why; the next one that succeeds clears it', async () => {
    const s = setup();
    s.replay.refresh();
    await s.replay.idle();
    const ready = s.replay.view();
    s.data.fail = 'OKX could not be reached';
    s.replay.refresh();
    await s.replay.idle();
    expect(s.replay.view()).toEqual({ ...ready, status: 'failed', reason: { code: 'REPLAY_FAILED', message: 'OKX could not be reached' } });
    expect(s.replay.summary()).toEqual({ status: 'failed', computedAt: ready.computedAt, mismatches: 1 });
    s.data.fail = null;
    s.replay.refresh();
    await s.replay.idle();
    expect(s.replay.view()).toEqual(ready);
    expect(s.changes.map((c) => c.status)).toEqual(['running', 'ready', 'failed', 'ready']);
  });

  it('computes one at a time: one asked for meanwhile follows once, and one that takes too long is given up and waited for', async () => {
    const s = setup(50);
    let release = (): void => undefined;
    s.data.hang = new Promise((resolve) => {
      release = resolve;
    });
    expect(s.replay.refresh()).toBe(true);
    expect(s.replay.refresh()).toBe(true);
    expect(s.replay.refresh()).toBe(true);
    await new Promise((r) => setTimeout(r, 120));
    // given up after 50 ms; the one asked for meanwhile waits for it to end
    expect(s.replay.view()).toMatchObject({ status: 'failed', reason: { code: 'REPLAY_TIMEOUT' }, computedAt: null });
    expect(s.data.calls).toBe(1);
    s.data.hang = null;
    release();
    await s.replay.idle();
    expect(s.replay.view()).toMatchObject({ status: 'ready', reason: null, through: day(5) });
    // the two asked for meanwhile made one; the next one reads the newest page of each series from the cache
    const calls = s.data.calls;
    s.replay.refresh();
    await s.replay.idle();
    expect(s.data.calls - calls).toBe(2);
  });

  it('joins the computation that runs when asked without `again`, and does nothing once stopped', async () => {
    const s = setup();
    s.replay.refresh();
    expect(s.replay.refresh(false)).toBe(true);
    await s.replay.idle();
    // a cold cache: two pages of each series, one computation
    expect(s.data.calls).toBe(4);
    s.replay.stop();
    expect(s.replay.refresh()).toBe(false);
    expect(s.data.calls).toBe(4);
  });
});
