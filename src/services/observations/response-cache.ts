/**
 * @fileoverview Process-wide cache of small upstream data responses, keyed by the
 * canonical request URL. ILOSTAT data is public, so one entry serves every
 * caller. Only responses of at most {@link CACHEABLE_ROWS} rows are stored —
 * larger results live on in the caller's staged dataframe instead. LRU over
 * `maxEntries` and a total-row budget, with a fixed TTL; a TTL of 0 disables the
 * cache.
 * @module services/observations/response-cache
 */

import type { RawObservation } from '@/services/rplumber/types.js';

/** Largest response, in rows, the cache stores. */
export const CACHEABLE_ROWS = 5_000;

/**
 * Rows held across every entry, about 128 MiB of heap. Measured under Node 26
 * (2026-10-15): entries of 5,000 `/data/indicator` rows decoded through the
 * streamed CSV path cost about 650 bytes a row (3.1 MiB an entry), so 200,000
 * rows hold about 124 MiB, where 256 full entries would hold about 790 MiB.
 */
export const CACHE_ROW_BUDGET = 200_000;

export interface ResponseCacheOptions {
  maxEntries?: number;
  now?: () => Date;
  /** Rows held across every entry; defaults to {@link CACHE_ROW_BUDGET}. */
  rowBudget?: number;
  /** `0` disables the cache. */
  ttlMs: number;
}

interface Entry {
  rows: readonly RawObservation[];
  storedAt: number;
}

export class ResponseCache {
  private readonly entries = new Map<string, Entry>();
  private heldRows = 0;
  private readonly maxEntries: number;
  private readonly now: () => Date;
  private readonly rowBudget: number;
  private readonly ttlMs: number;

  constructor(options: ResponseCacheOptions) {
    this.maxEntries = options.maxEntries ?? 256;
    this.now = options.now ?? (() => new Date());
    this.rowBudget = options.rowBudget ?? CACHE_ROW_BUDGET;
    this.ttlMs = options.ttlMs;
  }

  /** The cached rows for `url`, refreshing its recency; `undefined` on a miss or an expired entry. */
  get(url: string): readonly RawObservation[] | undefined {
    const entry = this.entries.get(url);
    if (!entry) return;
    this.remove(url, entry);
    if (this.now().getTime() - entry.storedAt >= this.ttlMs) return;
    this.add(url, entry);
    return entry.rows;
  }

  /**
   * Stores `rows` for `url` when the cache is on and the response is small
   * enough, then evicts the least recently used entries until both the entry
   * count and the rows held fit.
   */
  set(url: string, rows: readonly RawObservation[]): void {
    if (this.ttlMs <= 0 || rows.length > CACHEABLE_ROWS) return;
    const previous = this.entries.get(url);
    if (previous) this.remove(url, previous);
    this.add(url, { rows, storedAt: this.now().getTime() });
    for (const [oldest, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.heldRows <= this.rowBudget) break;
      this.remove(oldest, entry);
    }
  }

  private add(url: string, entry: Entry): void {
    this.entries.set(url, entry);
    this.heldRows += entry.rows.length;
  }

  private remove(url: string, entry: Entry): void {
    this.entries.delete(url);
    this.heldRows -= entry.rows.length;
  }
}
