import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { bookChecksum, bookChecksumString } from '../src/index.js';

describe('book checksum', () => {
  it('interleaves bid/ask levels', () => {
    const bids: Array<[string, string]> = [['3366.1', '7'], ['3366', '6']];
    const asks: Array<[string, string]> = [['3366.8', '9'], ['3368', '8']];
    expect(bookChecksumString(bids, asks)).toBe('3366.1:7:3366.8:9:3366:6:3368:8');
  });
  it('appends the longer side when misaligned', () => {
    const bids: Array<[string, string]> = [['3366.1', '7'], ['3366', '6']];
    const asks: Array<[string, string]> = [['3366.8', '9'], ['3368', '8'], ['3369', '1']];
    expect(bookChecksumString(bids, asks)).toBe('3366.1:7:3366.8:9:3366:6:3368:8:3369:1');
  });
  it('uses only the top 25 levels per side', () => {
    const bids = Array.from({ length: 30 }, (_, i) => [`${1000 - i}`, '1'] as [string, string]);
    const asks = Array.from({ length: 30 }, (_, i) => [`${1001 + i}`, '1'] as [string, string]);
    const s = bookChecksumString(bids, asks);
    expect(s.split(':').length).toBe(100);
    expect(s.includes('975:')).toBe(false);
  });
  it('returns the signed 32-bit crc32', () => {
    const bids: Array<[string, string]> = [['3366.1', '7']];
    const asks: Array<[string, string]> = [['3366.8', '9']];
    const unsigned = crc32('3366.1:7:3366.8:9');
    expect(bookChecksum(bids, asks)).toBe(unsigned | 0);
    expect(Number.isInteger(bookChecksum(bids, asks))).toBe(true);
  });
});
