import type { CacheStore } from './cache.js';
import type { Fetchers } from './load.js';

/**
 * A run that must not go online (a frozen data set): loadData with these fetchers and a ReadOnlyCache
 * returns exactly what the cache holds. Every series ends where the cache ends; an instrument the
 * cache does not have is an error.
 */
export function offlineFetchers(fundingVenue?: string): Fetchers {
  const fetchers: Fetchers = {
    instrument: (instId) => Promise.reject(new Error(`${instId}: not in the cache, and an offline run does not download`)),
    candles: () => Promise.resolve([]),
    openInterest: () => Promise.resolve([]),
    funding: () => Promise.resolve([]),
    fundingPageSize: 1,
  };
  // The settlements of that venue's cache (see Fetchers.fundingVenue).
  if (fundingVenue !== undefined) fetchers.fundingVenue = fundingVenue;
  return fetchers;
}

/** A cache that is read and never written. */
export class ReadOnlyCache implements CacheStore {
  constructor(private readonly inner: CacheStore) {}

  read<T>(key: string): T | null {
    return this.inner.read<T>(key);
  }

  write(): void {
    // Nothing is kept: the files stay as they are.
  }
}
