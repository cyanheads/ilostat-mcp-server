/**
 * @fileoverview Process-wide cache of small upstream data responses, keyed by the
 * canonical request URL. ILOSTAT data is public, so one entry serves every
 * caller. Only responses of at most {@link CACHEABLE_ROWS} rows are stored —
 * larger results live on in the caller's staged dataframe instead. LRU over
 * `maxEntries` with a fixed TTL; a TTL of 0 disables the cache.
 * @module services/observations/response-cache
 */

import type { RawObservation } from '@/services/rplumber/types.js';

/** Largest response, in rows, the cache stores. */
export const CACHEABLE_ROWS = 5_000;

export interface ResponseCacheOptions {
  maxEntries?: number;
  now?: () => Date;
  /** `0` disables the cache. */
  ttlMs: number;
}

interface Entry {
  rows: readonly RawObservation[];
  storedAt: number;
}

export class ResponseCache {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(options: ResponseCacheOptions) {
    this.maxEntries = options.maxEntries ?? 256;
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs;
  }

  /** The cached rows for `url`, refreshing its recency; `undefined` on a miss or an expired entry. */
  get(url: string): readonly RawObservation[] | undefined {
    const entry = this.entries.get(url);
    if (!entry) return;
    this.entries.delete(url);
    if (this.now().getTime() - entry.storedAt >= this.ttlMs) return;
    this.entries.set(url, entry);
    return entry.rows;
  }

  /** Stores `rows` for `url` when the cache is on and the response is small enough. */
  set(url: string, rows: readonly RawObservation[]): void {
    if (this.ttlMs <= 0 || rows.length > CACHEABLE_ROWS) return;
    this.entries.delete(url);
    this.entries.set(url, { rows, storedAt: this.now().getTime() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
