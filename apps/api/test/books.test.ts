import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { D, type BookQuote } from '@pegasus/shared';
import { BooksService, type BooksSources } from '../src/services/books.js';

const log = pino({ level: 'silent' });
const H = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 5, 10, 0);

/** Flat markets: BTC 80,000, ETH 2,500, ZIL 0.02 (its perp pays longs 0.2% each 8 h), quotes one tick wide. */
function sources(over: Partial<BooksSources> = {}): BooksSources & { fundingCalls: string[] } {
  const q = (px: string, tick: string): BookQuote => ({ bid: px, ask: D(px).plus(tick).toFixed() });
  const quotes = new Map<string, BookQuote>([
    ['BTC-USDT', q('80000', '0.1')], ['BTC-USDT-SWAP', q('80000', '0.1')],
    ['ETH-USDT', q('2500', '0.01')], ['ETH-USDT-SWAP', q('2500', '0.01')],
    ['ZIL-USDT', q('0.02', '0.00001')], ['ZIL-USDT-SWAP', q('0.02', '0.00001')],
  ]);
  const fundingCalls: string[] = [];
  return {
    fundingCalls,
    quotes: async () => quotes,
    marks: async () => new Map([['BTC-USDT-SWAP', '80000'], ['ETH-USDT-SWAP', '2500'], ['ZIL-USDT-SWAP', '0.02']]),
    // rising closes: the last above both averages, so the regime is bull
    closes: async (_id, bar) => Array.from({ length: bar === '1Dutc' ? 260 : 80 }, (_, i) => String(50_000 + i * 100)),
    funding: async (instId) => {
      fundingCalls.push(instId);
      const day = Math.floor(T0 / DAY) * DAY;
      const rate = instId === 'ZIL-USDT-SWAP' ? '-0.002' : '0.0001';
      return [0, 8, 16, 24, 32, 40].map((h) => ({ ts: day - DAY + h * H, rate }));
    },
    swaps: async () => [{ coin: 'BTC', instId: 'BTC-USDT-SWAP' }, { coin: 'ZIL', instId: 'ZIL-USDT-SWAP' }],
    marginPairs: async () => new Set(['BTC-USDT', 'ZIL-USDT']),
    loanQuota: async () => new Map([['BTC', { rate: '0.0001', quota: '10' }], ['ZIL', { rate: '0.0024', quota: '50000' }]]),
    lendingRate: async () => '0.1',
    // flat bars with a small wiggle: no dip rule fires
    bars: async (_id, bar) => {
      const d = { '1H': H, '4H': 4 * H, '1Dutc': DAY, '1Wutc': 7 * DAY }[bar];
      const end = Math.floor(T0 / d) * d;
      return Array.from({ length: 300 }, (_, k): [number, string, string, string, string, string] => {
        const c = 80_000 + ((k % 7) - 3) * 10;
        return [end - (300 - k) * d, String(c - 5), String(c + 20), String(c - 20), String(c), '1000000'];
      });
    },
    ...over,
  };
}

describe('the paper books service', () => {
  it('opens the once-only books, decides the day, books funding and interest, and keeps its file', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pegasus-books-')), 'books.json');
    const clock = { now: T0 };
    const src = sources();
    const svc = new BooksService({ enabled: true, file, start: '10000' }, { sources: src, log }, { now: () => clock.now, checkEveryMs: 0 });
    await svc.start();
    let view = svc.view();
    expect(view.status).toBe('running');
    const book = (k: string) => view.books.find((b) => b.key === k);
    // buy and hold: 10,000 of BTC spot at the ask, its fee included; the positive carry: half in each coin, spot long and perp short
    expect(book('hold')?.positions[0]?.legs[0]).toMatchObject({ kind: 'spot', instId: 'BTC-USDT', entryPx: '80000.1' });
    expect(D(book('hold')?.cash ?? '-1').gte(0)).toBe(true);
    expect(book('carryPos')?.positions.map((p) => p.legs.map((l) => `${l.kind} ${D(l.qty).isPositive() ? '+' : '-'}`))).toEqual([['spot +', 'perp -'], ['spot +', 'perp -']]);
    // the regime read bull at the first look: long
    expect(view.regime?.bull).toBe(true);
    expect(book('regime')?.positions).toHaveLength(1);
    // the negative carry: ZIL paid -0.6% over 24 h (three settlements of -0.2%): long perp, borrowed ZIL sold; 20% of the
    // book would be 2,000, but OKX lends 50,000 ZIL, 1,000 at the bid
    const zil = book('carryNeg')?.positions[0];
    expect(zil?.coin).toBe('ZIL');
    expect(D(zil?.legs[0]?.qty ?? '0').mul('0.02001').toFixed(2)).toBe('1000.00');
    expect(zil?.legs[1]?.qty.startsWith('-')).toBe(true);
    // nothing settled after the positions opened yet: no funding booked
    expect(book('carryNeg')?.positions[0]?.funding).toBe('0');

    // three hours later: the 16:00 settlement of today is after the opening (10:00) and before the clock; interest for 3 h
    clock.now = T0 + 6 * H + 60_000;
    await svc.tick();
    view = svc.view();
    expect(D(book('carryNeg')?.positions[0]?.funding ?? '0').gt(0)).toBe(true);
    expect(D(book('carryPos')?.positions[0]?.funding ?? '0').gt(0)).toBe(true);
    // spot pays no funding
    expect(book('hold')?.positions[0]?.funding).toBe('0');
    expect(D(book('carryNeg')?.positions[0]?.interest ?? '0').gt(0)).toBe(true);
    expect(book('hold')?.curve.length).toBe(2);

    // a restart reads the file back: nothing is opened twice
    const again = new BooksService({ enabled: true, file, start: '10000' }, { sources: src, log }, { now: () => clock.now, checkEveryMs: 0 });
    await again.start();
    expect(again.view().books.find((b) => b.key === 'hold')?.positions).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1);
    svc.stop();
    again.stop();
  });

  it('the dip book sells a long after five days, and a file without the book gets it', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pegasus-books-')), 'books.json');
    const clock = { now: T0 };
    const svc = new BooksService({ enabled: true, file, start: '10000' }, { sources: sources(), log }, { now: () => clock.now, checkEveryMs: 0 });
    await svc.start();
    expect(svc.view().books.map((b) => b.key)).toContain('dipLong');
    // flat bars meet no rule: nothing bought
    expect(svc.view().books.find((b) => b.key === 'dipLong')?.positions).toEqual([]);
    svc.stop();
    // a long bought six days ago, and a file written before the fifth book existed
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { books: Array<{ key: string; positions: unknown[] }> };
    const dip = saved.books.find((b) => b.key === 'dipLong') as { positions: unknown[] };
    dip.positions.push({ coin: 'BTC', openedAt: T0 - 6 * DAY, legs: [{ kind: 'perp', instId: 'BTC-USDT-SWAP', qty: '0.01', entryPx: '79000' }], funding: '0', interest: '0', fees: '0' });
    writeFileSync(file, JSON.stringify(saved));
    clock.now = T0 + DAY;
    const again = new BooksService({ enabled: true, file, start: '10000' }, { sources: sources(), log }, { now: () => clock.now, checkEveryMs: 0 });
    await again.start();
    const book = again.view().books.find((b) => b.key === 'dipLong');
    expect(book?.positions).toEqual([]);
    expect(book?.events.some((e) => e.kind === 'close' && e.text.startsWith('held five days'))).toBe(true);
    again.stop();
    const old = JSON.parse(readFileSync(file, 'utf8')) as { books: Array<{ key: string }> };
    writeFileSync(file, JSON.stringify({ ...old, books: old.books.filter((b) => b.key !== 'dipLong') }));
    const third = new BooksService({ enabled: true, file, start: '10000' }, { sources: sources(), log }, { now: () => clock.now, checkEveryMs: 0 });
    await third.start();
    expect(third.view().books.map((b) => b.key)).toEqual(['regime', 'hold', 'carryPos', 'carryNeg', 'dipLong']);
    third.stop();
  });

  it('closes the regime long when the close falls under the averages, and says a failed look in the view', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pegasus-books-')), 'books.json');
    const clock = { now: T0 };
    let bull = true;
    const src = sources({ closes: async (_id, bar) => Array.from({ length: bar === '1Dutc' ? 260 : 80 }, (_, i) => String(bull ? 50_000 + i * 100 : 90_000 - i * 100)) });
    const svc = new BooksService({ enabled: true, file, start: '10000' }, { sources: src, log }, { now: () => clock.now, checkEveryMs: 0 });
    await svc.start();
    expect(svc.view().books.find((b) => b.key === 'regime')?.positions).toHaveLength(1);
    bull = false;
    clock.now = T0 + DAY;
    await svc.tick();
    const regime = svc.view().books.find((b) => b.key === 'regime');
    expect(regime?.positions).toHaveLength(0);
    expect(regime?.events.some((e) => e.kind === 'close')).toBe(true);
    svc.stop();

    const broken = new BooksService({ enabled: true, file: join(mkdtempSync(join(tmpdir(), 'pegasus-books-')), 'b.json'), start: '10000' }, { sources: sources({ quotes: async () => { throw new Error('OKX did not answer'); } }), log }, { now: () => clock.now, checkEveryMs: 0 });
    await broken.start();
    expect(broken.view()).toMatchObject({ status: 'starting', error: 'OKX did not answer' });
    broken.stop();
  });
});
