/**
 * @fileoverview Tests for the process-wide response cache: least-recently-used
 * eviction (a read or a re-store refreshes recency), TTL expiry exactly at the
 * TTL, a TTL of 0 disabling the cache, and the 5,000-row storage ceiling.
 * @module tests/services/observations/response-cache.test
 */

import { describe, expect, it } from 'vitest';
import { CACHEABLE_ROWS, ResponseCache } from '@/services/observations/response-cache.js';
import type { RawObservation } from '@/services/rplumber/types.js';
import { guardNetwork } from '../../helpers/network-guard.js';

guardNetwork();

const row = (period: string): RawObservation => ({
  refArea: 'USA',
  source: 'BA:453',
  indicator: 'UNE_DEAP_SEX_AGE_RT',
  period,
  notes: [],
  value: 4.022,
});

const rows = (count: number): RawObservation[] =>
  Array.from({ length: count }, (_, index) => row(String(1_000 + index)));

/** A cache over a clock the test moves by hand. */
function cache(options: { maxEntries?: number; ttlMs: number }) {
  let now = Date.parse('2026-09-26T12:00:00Z');
  const instance = new ResponseCache({ ...options, now: () => new Date(now) });
  return {
    cache: instance,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('ResponseCache', () => {
  it('returns the stored rows for the same URL and misses any other', () => {
    const { cache: c } = cache({ ttlMs: 60_000 });
    const stored = [row('2024')];
    c.set('https://rplumber.ilo.org/data/indicator?id=A', stored);
    expect(c.get('https://rplumber.ilo.org/data/indicator?id=A')).toBe(stored);
    expect(c.get('https://rplumber.ilo.org/data/indicator?id=B')).toBeUndefined();
  });

  it('evicts the least recently used entry, a read refreshing recency', () => {
    const { cache: c } = cache({ ttlMs: 60_000, maxEntries: 2 });
    c.set('a', [row('2021')]);
    c.set('b', [row('2022')]);
    expect(c.get('a')).toBeDefined();
    c.set('c', [row('2023')]);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBeDefined();
    expect(c.get('c')).toBeDefined();
  });

  it('re-storing a URL replaces its rows and refreshes its recency', () => {
    const { cache: c } = cache({ ttlMs: 60_000, maxEntries: 2 });
    const replacement = [row('2025')];
    c.set('a', [row('2021')]);
    c.set('b', [row('2022')]);
    c.set('a', replacement);
    c.set('c', [row('2023')]);
    expect(c.get('a')).toBe(replacement);
    expect(c.get('b')).toBeUndefined();
  });

  it('serves an entry until its age reaches the TTL, and not at the TTL', () => {
    const { cache: c, advance } = cache({ ttlMs: 900_000 });
    c.set('a', [row('2024')]);
    advance(899_999);
    expect(c.get('a')).toBeDefined();
    advance(1);
    expect(c.get('a')).toBeUndefined();
  });

  it('dates an entry from its last store, not its last read', () => {
    const { cache: c, advance } = cache({ ttlMs: 1_000 });
    c.set('a', [row('2024')]);
    advance(600);
    expect(c.get('a')).toBeDefined();
    advance(400);
    expect(c.get('a')).toBeUndefined();
  });

  it('stores nothing when the TTL is 0', () => {
    const { cache: c } = cache({ ttlMs: 0 });
    c.set('a', [row('2024')]);
    expect(c.get('a')).toBeUndefined();
  });

  it(`stores a response of ${CACHEABLE_ROWS} rows, and never a larger one`, () => {
    expect(CACHEABLE_ROWS).toBe(5_000);
    const { cache: c } = cache({ ttlMs: 60_000 });
    c.set('at-ceiling', rows(CACHEABLE_ROWS));
    c.set('over-ceiling', rows(CACHEABLE_ROWS + 1));
    expect(c.get('at-ceiling')).toHaveLength(CACHEABLE_ROWS);
    expect(c.get('over-ceiling')).toBeUndefined();
  });

  it('caches a zero-row response', () => {
    const { cache: c } = cache({ ttlMs: 60_000 });
    c.set('empty', []);
    expect(c.get('empty')).toEqual([]);
  });
});
