import { describe, expect, it } from 'vitest';
import { bookChecksum, LocalOrderBook, type OkxBookData } from '../src/index.js';

function data(bids: Array<[string, string]>, asks: Array<[string, string]>, extra: Partial<OkxBookData> = {}): OkxBookData {
  return {
    bids: bids.map(([p, s]) => [p, s, '0', '1']),
    asks: asks.map(([p, s]) => [p, s, '0', '1']),
    ts: '1700000000000',
    ...extra,
  };
}

describe('LocalOrderBook', () => {
  it('applies a snapshot and sorts both sides', () => {
    const b = new LocalOrderBook('BTC-USDT-SWAP');
    const err = b.apply('snapshot', data([['100', '1'], ['101', '2']], [['103', '1'], ['102', '5']], { seqId: 10, prevSeqId: -1 }));
    expect(err).toBeNull();
    expect(b.ready).toBe(true);
    expect(b.bestBid()).toEqual(['101', '2']);
    expect(b.bestAsk()).toEqual(['102', '5']);
    expect(b.seqId).toBe(10);
  });

  it('applies updates, deletes zero-size levels and checks sequence', () => {
    const b = new LocalOrderBook('BTC-USDT-SWAP');
    b.apply('snapshot', data([['100', '1'], ['101', '2']], [['102', '5']], { seqId: 10, prevSeqId: -1 }));
    expect(b.apply('update', data([['101', '0'], ['99', '3']], [['102', '4']], { seqId: 11, prevSeqId: 10 }))).toBeNull();
    expect(b.topBids(5)).toEqual([['100', '1'], ['99', '3']]);
    expect(b.topAsks(5)).toEqual([['102', '4']]);
    const gap = b.apply('update', data([], [['102', '1']], { seqId: 13, prevSeqId: 12 }));
    expect(gap).toMatch(/sequence gap/);
  });

  it('rejects updates before a snapshot', () => {
    const b = new LocalOrderBook('BTC-USDT-SWAP');
    expect(b.apply('update', data([['1', '1']], [], { seqId: 1, prevSeqId: 0 }))).toMatch(/before snapshot/);
  });

  it('verifies the checksum', () => {
    const b = new LocalOrderBook('BTC-USDT-SWAP');
    const bids: Array<[string, string]> = [['101', '2'], ['100', '1']];
    const asks: Array<[string, string]> = [['102', '5'], ['103', '1']];
    const good = bookChecksum(bids, asks);
    expect(b.apply('snapshot', data(bids, asks, { seqId: 1, prevSeqId: -1, checksum: good }))).toBeNull();
    expect(b.apply('update', data([['100', '0']], [], { seqId: 2, prevSeqId: 1, checksum: good }))).toMatch(/checksum mismatch/);
    b.reset();
    expect(b.ready).toBe(false);
  });

  it('ignores the retired checksum that OKX now fixes to 0, but still checks sequence', () => {
    const b = new LocalOrderBook('BTC-USDT-SWAP');
    expect(b.apply('snapshot', data([['101', '2'], ['100', '1']], [['102', '5']], { seqId: 1, prevSeqId: -1, checksum: 0 }))).toBeNull();
    expect(b.apply('update', data([['100', '0']], [['103', '1']], { seqId: 2, prevSeqId: 1, checksum: 0 }))).toBeNull();
    expect(b.topBids(5)).toEqual([['101', '2']]);
    expect(b.apply('update', data([], [['102', '1']], { seqId: 4, prevSeqId: 3, checksum: 0 }))).toMatch(/sequence gap/);
  });
});
