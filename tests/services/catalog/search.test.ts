/**
 * @fileoverview Tests for indicator search over the whole live catalog (fetched
 * 2026-10-15), loaded through `RplumberClient` over a fetch fake: parity with the
 * word-prefix rule over a 101-query corpus, the stem fallback for a term no catalog
 * word starts with, the catalog-wide fallback decision, the stem notice and its
 * composition with the zero-hit notice, and the fallback's CPU cost across the
 * term counts the query cap allows.
 * @module tests/services/catalog/search.test
 */

import { createHash } from 'node:crypto';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { CatalogService } from '@/services/catalog/catalog-service.js';
import {
  type SearchParams,
  type SearchResult,
  searchIndicators,
} from '@/services/catalog/search.js';
import type { CatalogSnapshot } from '@/services/catalog/types.js';
import { RplumberClient } from '@/services/rplumber/rplumber-client.js';
import {
  catalogRoutes,
  clientOptions,
  FIXED_NOW,
  fixtureText,
  loadFullCatalogFixture,
} from '../../helpers/ilostat-upstream.js';
import { guardNetwork } from '../../helpers/network-guard.js';

guardNetwork();

let snapshot: CatalogSnapshot;

beforeAll(async () => {
  const http = createFetchMock(catalogRoutes(loadFullCatalogFixture()));
  const catalog = new CatalogService({
    rplumber: new RplumberClient(clientOptions(http.fetch)),
    refreshIntervalMs: 0,
    now: () => FIXED_NOW,
  });
  try {
    snapshot = await catalog.ready(createMockContext());
  } finally {
    catalog.dispose();
  }
});

/** Every hit of `query` in ranked order, on one page. */
function searchAll(query: string, filters: Partial<SearchParams> = {}): SearchResult {
  return searchIndicators(snapshot, {
    query,
    limit: 10_000,
    offset: 0,
    aggregatesOnly: false,
    ...filters,
  });
}

const codes = (result: SearchResult) => result.hits.map((hit) => hit.indicator.code);
const digest = (list: string[]) => createHash('sha256').update(list.join('\n')).digest('hex');

/** The corpus with each query's total and ranked-code digest under the word-prefix rule alone. */
const GOLDEN = JSON.parse(fixtureText('rplumber/search-corpus-golden.json')) as {
  query: string;
  sha256: string;
  total: number;
}[];

const STEM_MARK = 'matched no catalog word or word prefix';

describe('the full catalog fixture', () => {
  it('loads every indicator and the catalog-wide vocabulary', () => {
    expect(snapshot.indicators).toHaveLength(1213);
    expect(snapshot.searchVocabulary).toHaveLength(1468);
  });
});

describe('parity with the word-prefix rule', () => {
  it('covers the 101-query corpus, 70 of whose queries return hits', () => {
    expect(GOLDEN).toHaveLength(101);
    expect(GOLDEN.filter((entry) => entry.total > 0)).toHaveLength(70);
  });

  it.each(GOLDEN.filter((entry) => entry.total > 0))(
    '"$query" returns the same $total hits in the same order, with no stem notice',
    ({ query, total, sha256 }) => {
      const result = searchAll(query);
      expect(result.total).toBe(total);
      expect(digest(codes(result))).toBe(sha256);
      expect(result.notice ?? '').not.toContain(STEM_MARK);
    },
  );

  it.each(GOLDEN.filter((entry) => entry.total === 0))(
    '"$query" either still matches nothing or names its stemmed terms',
    ({ query }) => {
      const result = searchAll(query);
      if (result.total > 0) expect(result.notice).toContain(STEM_MARK);
    },
  );

  it('unemployed keeps the word-prefix rule and gains no unemployment-only indicator', () => {
    const unemployed = searchAll('unemployed');
    expect(unemployed.total).toBeGreaterThan(0);
    for (const hit of unemployed.hits) {
      expect(hit.indicator.search.definition.some((word) => word.startsWith('unemployed'))).toBe(
        true,
      );
    }
    expect(unemployed.notice).toBeUndefined();
  });
});

describe('stem fallback', () => {
  it.each([
    ['informality', 'informal'],
    ['underemployed', 'underemployment'],
    ['inactive', 'inactivity'],
    ['fatalities', 'fatal'],
    ['families', 'family'],
    ['supplies', 'supplying'],
  ])('%s returns the indicators %s does, in the same order', (derived, indexed) => {
    const expected = codes(searchAll(indexed));
    expect(expected.length).toBeGreaterThan(0);
    expect(codes(searchAll(derived))).toEqual(expected);
  });

  it('informality finds the informal-employment indicators', () => {
    expect(codes(searchAll('informality'))).toEqual(
      expect.arrayContaining(['EMP_NIFL_SEX_RT', 'SDG_0831_SEX_ECO_RT']),
    );
  });

  it.each(['unionization', 'unionized', 'unionisation', 'unionised'])(
    '%s returns the trade-union density indicator',
    (query) => {
      expect(codes(searchAll(query))).toEqual(['ILR_TUMT_NOC_RT']);
    },
  );

  it('productive includes every labour productivity (LPY) indicator', () => {
    const lpy = snapshot.indicators
      .filter((indicator) => indicator.subject.code === 'LPY')
      .map((indicator) => indicator.code);
    expect(lpy).toHaveLength(6);
    expect(codes(searchAll('productive'))).toEqual(expect.arrayContaining(lpy));
  });

  it('applies per term: a stemmed term combines with a word-prefix term', () => {
    const result = searchAll('informality rate');
    expect(result.total).toBe(searchAll('informal rate').total);
    expect(codes(result)).toEqual(codes(searchAll('informal rate')));
  });
});

describe('the fallback is decided against the whole catalog', () => {
  it('a filter never turns a word-prefix term into a stemmed one', () => {
    // No EES indicator has a word starting with "employed", but 52 have "employment",
    // which shares its stem; catalog-wide "employed" is a word, so it stays strict.
    const result = searchAll('employed', { subject: 'EES' });
    expect(result.total).toBe(0);
    expect(result.notice).not.toContain(STEM_MARK);
    expect(searchAll('employment', { subject: 'EES' }).total).toBe(52);
  });

  it('a stemmed term matches the same way under a filter as without one', () => {
    expect(codes(searchAll('informality', { subject: 'IFL' }))).toEqual(
      codes(searchAll('informal', { subject: 'IFL' })),
    );
    expect(searchAll('informality', { subject: 'IFL' }).total).toBe(223);
  });
});

describe('the measure filter', () => {
  it('returns exactly the indicators of the measure: EMP_TEMP_NB has 125', () => {
    const members = snapshot.indicatorsByMeasure.get('EMP_TEMP_NB')?.map((entry) => entry.code);
    expect(members).toHaveLength(125);
    const result = searchIndicators(snapshot, {
      measure: 'EMP_TEMP_NB',
      limit: 10_000,
      offset: 0,
      aggregatesOnly: false,
    });
    expect(codes(result)).toEqual(members);
  });

  it('narrows a query to the measure; the same words alone reach indicators outside it', () => {
    const byWords = searchAll('emp temp nb');
    expect(byWords.total).toBe(174);
    const byMeasure = searchAll('emp temp nb', { measure: 'EMP_TEMP_NB' });
    expect(byMeasure.total).toBe(125);
    expect(byMeasure.hits.every((hit) => hit.indicator.measure.code === 'EMP_TEMP_NB')).toBe(true);
  });
});

/** The notice sentence for `term` matched by stem as `words`. */
const stemSentence = (term: string, words: string) =>
  `${term} matched no catalog word or word prefix, so it was matched by stem: ${words}. Check the hits are about ${term}; if those words mean something else, search a synonym instead.`;

describe('the stem notice', () => {
  it('names the stemmed term and the catalog words it matched', () => {
    expect(searchAll('informality').notice).toBe(stemSentence('informality', 'informal'));
    expect(searchAll('productive').notice).toBe(
      stemSentence('productive', 'product, productivity'),
    );
  });

  it('asks for a relevance check, since a shared stem can join unrelated words', () => {
    // nationality shares its stem with national, which nearly every indicator's text holds.
    const result = searchAll('nationality');
    expect(result.total).toBe(1167);
    expect(result.notice).toBe(stemSentence('nationality', 'national, nationally, nationals'));
  });

  it('names each stemmed term, and leaves word-prefix terms out of it', () => {
    const notice = searchAll('youth informality unionized').notice ?? '';
    expect(
      notice.startsWith(
        `${stemSentence('informality', 'informal')} ${stemSentence('unionized', 'union')} `,
      ),
    ).toBe(true);
  });

  it('precedes the zero-hit notice when the stemmed terms together match nothing', () => {
    expect(searchAll('informality unionization').notice).toBe(
      `${stemSentence('informality', 'informal')} ${stemSentence('unionization', 'union')} No indicator matched every term. Use fewer or broader terms (for example "youth unemployment"), or browse subjects with ilostat_list_reference topic subjects and search by subject.`,
    );
  });

  it('is absent for a term whose stem matches no catalog word either', () => {
    const result = searchAll('astronauts');
    expect(result.total).toBe(0);
    expect(result.notice).not.toContain(STEM_MARK);
  });
});

/** CPU microseconds (user + system, this thread) of `calls` calls of `run`. */
function cpuMicros(run: () => void, calls: number): number {
  const start = process.threadCpuUsage();
  for (let call = 0; call < calls; call += 1) run();
  const used = process.threadCpuUsage(start);
  return used.user + used.system;
}

/**
 * Fewest CPU microseconds per call of `one` and of `many`, over seven rounds that each
 * run three calls of both, in alternating order, so the two are measured under the
 * same core, clock, and heap conditions.
 */
function perCallCpuMicros(one: () => void, many: () => void): { many: number; one: number } {
  one();
  many();
  let oneBest = Number.POSITIVE_INFINITY;
  let manyBest = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 7; round += 1) {
    const oneFirst = round % 2 === 0;
    const first = cpuMicros(oneFirst ? one : many, 3);
    const second = cpuMicros(oneFirst ? many : one, 3);
    oneBest = Math.min(oneBest, oneFirst ? first : second);
    manyBest = Math.min(manyBest, oneFirst ? second : first);
  }
  return { one: oneBest / 3, many: manyBest / 3 };
}

describe('cost on caller-sized queries', () => {
  /** `count` distinct four-letter `qz…` terms, space-joined. */
  const unmatchedTerms = (count: number) => {
    const letter = (n: number) => String.fromCharCode(97 + (n % 26));
    return Array.from(
      { length: count },
      (_, index) => `qz${letter(index)}${letter(Math.floor(index / 26))}`,
    ).join(' ');
  };

  it('each of up to 100 terms that fall back adds a small, fixed CPU cost', () => {
    // No catalog word starts with qz, so every term falls back; the 500-character
    // query cap bounds such terms near 100.
    expect(snapshot.searchVocabulary.some((word) => word.startsWith('qz'))).toBe(false);
    const [one, many] = [unmatchedTerms(1), unmatchedTerms(100)];
    expect(many.length).toBeLessThanOrEqual(500);
    const cost = perCallCpuMicros(
      () => searchAll(one),
      () => searchAll(many),
    );
    // 100× the terms: about 2× the cost measured, since the catalog pass every query makes dominates.
    expect(cost.many / cost.one).toBeLessThan(256);
    // Each further term: about 14 µs measured, one vocabulary pass and a stem lookup; 170 µs or
    // more when it re-stems the vocabulary, 450 µs when it rescans every indicator.
    expect((cost.many - cost.one) / 99).toBeLessThan(60);
  }, 60_000);
});
