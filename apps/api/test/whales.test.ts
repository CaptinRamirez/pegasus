import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { WhaleRecorder, type WhaleSources } from '../src/services/whales.js';

const log = pino({ level: 'silent' });
const SLOT = 4 * 3_600_000;
const T0 = Date.UTC(2026, 10, 5, 13, 0);

function sources(fail = false): WhaleSources & { calls: number } {
  const s = {
    calls: 0,
    async leaderboard() {
      if (fail) throw new Error('down');
      return [
        { address: '0xsmall', accountValue: '1000', pnlMonth: '10', pnlAllTime: '20' },
        { address: '0xbig', accountValue: '90000000', pnlMonth: '6000000', pnlAllTime: '50000000' },
        { address: '0xmid', accountValue: '5000000', pnlMonth: '-1', pnlAllTime: null },
      ];
    },
    async positions(address: string) {
      s.calls += 1;
      return address === '0xbig'
        ? [{ coin: 'BTC', szi: '-100', entryPx: '81000', positionValue: '8000000', unrealizedPnl: '100000', leverage: 5 }, { coin: 'ETH', szi: '200', entryPx: '2400', positionValue: '480000', unrealizedPnl: '0', leverage: 3 }]
        : [{ coin: 'BTC', szi: '10', entryPx: '80000', positionValue: '800000', unrealizedPnl: '0', leverage: 2 }];
    },
  };
  return s;
}

describe('the Hyperliquid whale recorder', () => {
  it('records the largest accounts once per 4-hour slot, with each coin totalled long and short', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pegasus-whales-')), 'whales.jsonl');
    const clock = { now: T0 };
    const src = sources();
    const rec = new WhaleRecorder({ enabled: true, file, top: 2 }, { sources: src, log }, { now: () => clock.now, checkEveryMs: 0 });
    await rec.start();
    await rec.tick();
    clock.now = T0 + SLOT;
    await rec.tick();
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { slot: number; accounts: Array<{ address: string }>; net: Record<string, { long: number; short: number }> });
    expect(lines).toHaveLength(2);
    expect(lines[0]?.slot).toBe(Math.floor(T0 / SLOT) * SLOT);
    expect(lines[0]?.accounts.map((a) => a.address)).toEqual(['0xbig', '0xmid']);
    expect(lines[0]?.net['BTC']).toEqual({ long: 800000, short: 8000000 });
    expect(src.calls).toBe(4);
    // a restart within the same slot does not take it again
    const again = new WhaleRecorder({ enabled: true, file, top: 2 }, { sources: src, log }, { now: () => clock.now, checkEveryMs: 0 });
    await again.start();
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
    rec.stop();
    again.stop();
  });

  it('writes nothing when the leaderboard cannot be read, and tries again', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pegasus-whales-')), 'whales.jsonl');
    const rec = new WhaleRecorder({ enabled: true, file, top: 2 }, { sources: sources(true), log }, { now: () => T0, checkEveryMs: 0 });
    await rec.start();
    expect(() => readFileSync(file, 'utf8')).toThrow();
    rec.stop();
  });
});
