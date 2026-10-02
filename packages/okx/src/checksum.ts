import { crc32 } from 'node:zlib';

/**
 * OKX order book checksum: CRC32 (as a signed 32-bit integer) over the string
 * "bid1Px:bid1Sz:ask1Px:ask1Sz:bid2Px:bid2Sz:ask2Px:ask2Sz:..." built from the
 * top 25 levels of each side. When one side has fewer levels the remaining
 * levels of the other side are appended in order.
 */
export function bookChecksumString(bids: ReadonlyArray<readonly [string, string, ...unknown[]]>, asks: ReadonlyArray<readonly [string, string, ...unknown[]]>): string {
  const parts: string[] = [];
  for (let i = 0; i < 25; i++) {
    const b = bids[i];
    const a = asks[i];
    if (b) parts.push(b[0], b[1]);
    if (a) parts.push(a[0], a[1]);
  }
  return parts.join(':');
}

export function bookChecksum(bids: ReadonlyArray<readonly [string, string, ...unknown[]]>, asks: ReadonlyArray<readonly [string, string, ...unknown[]]>): number {
  // crc32 returns an unsigned 32-bit number; OKX publishes the signed form.
  return crc32(bookChecksumString(bids, asks)) | 0;
}
