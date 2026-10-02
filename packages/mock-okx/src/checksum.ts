import { crc32 } from 'node:zlib';

/**
 * OKX order book checksum: CRC32 (signed 32-bit) over
 * "bid1Px:bid1Sz:ask1Px:ask1Sz:bid2Px:bid2Sz:..." for the top 25 levels of
 * each side; when one side is shorter the other side's remaining levels are
 * appended in order. Mirrors packages/okx/src/checksum.ts byte for byte.
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
  return crc32(bookChecksumString(bids, asks)) | 0;
}
