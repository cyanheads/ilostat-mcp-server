/**
 * @fileoverview Tests for indicator search over the whole live catalog (fetched
 * 2026-10-15), loaded through `RplumberClient` over a fetch fake: parity with the
 * word-prefix rule over a 101-query corpus, the stem fallback for a term no catalog
 * word starts with, the catalog-wide fallback decision, the stem notice and its
 * composition with the zero-hit notice, the sex words indexed beside a sex
 * breakdown, a sex word beside other terms ranking as those terms rank, the
 * sex-filter notice, and the fallback's CPU cost across the term
 * counts the query cap allows.
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
    expect(snapshot.searchVocabulary).toHaveLength(1469);
  });
});

describe('parity with the word-prefix rule', () => {
  it('covers the 101-query corpus, 71 of whose queries return hits', () => {
    expect(GOLDEN).toHaveLength(101);
    expect(GOLDEN.filter((entry) => entry.total > 0)).toHaveLength(71);
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

  it('the queries it misses return these totals with the stem fallback', () => {
    const totals = Object.fromEntries(
      GOLDEN.filter((entry) => entry.total === 0).map(({ query }) => [
        query,
        searchAll(query).total,
      ]),
    );
    expect(totals).toEqual({
      informality: 243,
      unionization: 1,
      productive: 9,
      fatalities: 12,
      inactive: 26,
      underemployed: 65,
      unionised: 1,
      disabled: 145,
      agriculture: 0,
      'working poor': 0,
      'economically active': 0,
      'vulnerable employment': 0,
      'employment growth': 0,
      'mean monthly earnings': 0,
      commuting: 0,
      informally: 243,
      unionized: 1,
      unionisation: 1,
      formalization: 162,
      informalization: 243,
      casualization: 7,
      employability: 0,
      flexibility: 0,
      seasonality: 9,
      precarity: 0,
      'informality rate': 57,
      'youth informality': 1,
      'unionization rate': 1,
      'productive employment': 2,
      'inactive population': 26,
    });
  });

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

  it.each(['disabled', 'disable', 'disables', 'disabling'])(
    '%s returns the indicators disability or disabilities name',
    (derived) => {
      const expected = new Set([
        ...codes(searchAll('disability')),
        ...codes(searchAll('disabilities')),
      ]);
      expect(expected.size).toBeGreaterThanOrEqual(144);
      const result = searchAll(derived);
      expect(result.total).toBe(expected.size);
      expect(new Set(codes(result))).toEqual(expected);
    },
  );

  it.each([
    ['capable', ['capabilities'], 2],
    ['comparable', ['comparability'], 1006],
    ['possibly', ['possibility', 'possible'], 88],
    ['dense', ['density'], 1],
    ['secure', ['securing', 'security'], 303],
  ])(
    '%s, an adjective or adverb no catalog word starts with, reaches %j',
    (derived, words, total) => {
      const expected = new Set(words.flatMap((word) => codes(searchAll(word))));
      const result = searchAll(derived);
      expect(result.total).toBe(total);
      expect(new Set(codes(result))).toEqual(expected);
      expect(result.notice).toBe(stemSentence(derived, words.join(', ')));
    },
  );

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

const TIER_RANK = { label: 0, metadata: 1, definition: 2 } as const;

describe('indicators whose own text holds a sex word', () => {
  // What each word matched through the indicators' own text on the 2026-10-15 catalog.
  it.each([
    [
      'female',
      {
        EAR_XFLS_NOC_RT: 'label',
        SDG_T552_NOC_RT: 'definition',
        SDG_0552_NOC_RT: 'definition',
        SDG_U552_NOC_RT: 'definition',
        SDG_B552_NOC_RT: 'definition',
        EAR_XTLP_SEX_NB: 'definition',
      },
    ],
    [
      'women',
      {
        SDG_T552_NOC_RT: 'label',
        SDG_0552_NOC_RT: 'label',
        SDG_U552_NOC_RT: 'label',
        SDG_B552_NOC_RT: 'label',
        EAR_GGAP_OCU_RT: 'definition',
        LAP_2FTM_NOC_RT: 'definition',
      },
    ],
  ] as const)('%s still matches each of them, in the same tier or a higher one', (term, tiers) => {
    const scopes = new Map(searchAll(term).hits.map((hit) => [hit.indicator.code, hit.scope]));
    for (const [code, tier] of Object.entries(tiers)) {
      const scope = scopes.get(code);
      expect(scope, code).toBeDefined();
      expect(TIER_RANK[scope ?? 'definition'], code).toBeLessThanOrEqual(TIER_RANK[tier]);
    }
  });

  it('female matches EAR_XFLS_NOC_RT alone in the label tier', () => {
    const labelHits = searchAll('female').hits.filter((hit) => hit.scope === 'label');
    expect(labelHits.map((hit) => hit.indicator.code)).toEqual(['EAR_XFLS_NOC_RT']);
  });

  it('matches an indicator without a sex breakdown only through its own text', () => {
    const unbroken = (term: string) =>
      codes(searchAll(term))
        .filter((code) => !snapshot.indicatorsByCode.get(code)?.classificationTypes.includes('SEX'))
        .sort();
    expect(unbroken('female')).toEqual([
      'EAR_XFLS_NOC_RT',
      'SDG_0552_NOC_RT',
      'SDG_B552_NOC_RT',
      'SDG_T552_NOC_RT',
      'SDG_U552_NOC_RT',
    ]);
    expect(unbroken('male')).toEqual([]);
  });
});

/** The notice sentence for a sex word `term` that names `code`. */
const sexSentence = (term: string, code: 'SEX_F' | 'SEX_M') =>
  `${term} matched indicators broken down by sex; pass sex: ["${code}"] to ilostat_query_indicator for ${code === 'SEX_F' ? 'female' : 'male'} values.`;

/** Whether the indicator is broken down by sex. */
const bySex = (code: string) =>
  snapshot.indicatorsByCode.get(code)?.classificationTypes.includes('SEX') ?? false;

describe('sex words match the sex breakdown', () => {
  it('1,133 of the 1,213 indicators are broken down by sex', () => {
    expect(snapshot.indicators.filter((indicator) => bySex(indicator.code))).toHaveLength(1133);
  });

  it.each(['female', 'females', 'women', 'male', 'males', 'men'])(
    '"%s labour force participation" returns the 61 labour force participation indicators',
    (term) => {
      const base = codes(searchAll('labour force participation'));
      expect(base).toHaveLength(61);
      expect(base.every(bySex)).toBe(true);
      const result = searchAll(`${term} labour force participation`);
      expect(result.total).toBe(61);
      expect(codes(result).sort()).toEqual([...base].sort());
    },
  );

  it('"female unemployment rate" returns the 135 unemployment rate indicators', () => {
    const base = codes(searchAll('unemployment rate'));
    expect(base).toHaveLength(135);
    const result = searchAll('female unemployment rate');
    expect(result.total).toBe(135);
    expect(codes(result).sort()).toEqual([...base].sort());
  });

  it('"female employment" adds every sex-disaggregated employment indicator to the four that say women', () => {
    const result = searchAll('female employment');
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        'SDG_T552_NOC_RT',
        'SDG_0552_NOC_RT',
        'SDG_U552_NOC_RT',
        'SDG_B552_NOC_RT',
      ]),
    );
    const sexDisaggregated = codes(searchAll('employment')).filter(bySex);
    expect(codes(result)).toEqual(expect.arrayContaining(sexDisaggregated));
    expect(result.total).toBe(sexDisaggregated.length + 4);
  });

  it('male, a word no indicator text holds, matches every indicator broken down by sex in the metadata tier', () => {
    const result = searchAll('male');
    expect(result.total).toBe(1133);
    expect(result.hits.every((hit) => bySex(hit.indicator.code))).toBe(true);
    expect(new Set(result.hits.map((hit) => hit.scope))).toEqual(new Set(['metadata']));
  });

  it('adds male to the catalog vocabulary; female, women, and men were already words', () => {
    expect(snapshot.searchVocabulary).toEqual(
      expect.arrayContaining(['female', 'male', 'men', 'women']),
    );
  });
});

/** Each hit as `code:scope`, in ranked order. */
const rankedScopes = (result: SearchResult) =>
  result.hits.map((hit) => `${hit.indicator.code}:${hit.scope}`);

/** Hits per tier. */
const tierCounts = (result: SearchResult) =>
  Object.fromEntries(
    Object.entries(Object.groupBy(result.hits, (hit) => hit.scope ?? 'none')).map(
      ([scope, hits]) => [scope, hits?.length],
    ),
  );

describe('a query of sex words alone ranks by them', () => {
  it.each([
    [
      'female',
      1138,
      { label: 1, metadata: 1133, definition: 4 },
      '9891faa8c2a3bb186ef5616c7b9d52943b969ec76863a6199d8db6606c0a4f5a',
    ],
    [
      'male',
      1133,
      { metadata: 1133 },
      '3740df0bae13bd4968c0ca862f15349f49b3cecea0ab90e70e23a7358bc30351',
    ],
    [
      'women men',
      1135,
      { metadata: 1133, definition: 2 },
      'f2e12247629b974aa37bf2960912cb881081a336494bb90043bf685a146406ff',
    ],
  ] as const)(
    '"%s" returns %i hits in its tiers, in the same order',
    (query, total, tiers, sha256) => {
      const result = searchAll(query);
      expect(result.total).toBe(total);
      expect(tierCounts(result)).toEqual(tiers);
      expect(digest(rankedScopes(result))).toBe(sha256);
    },
  );
});

describe('a query with no sex word keeps its tiers and order', () => {
  it.each([
    ['informality', 243, '3f11e51ccabdcd115308fcb675c5491c722b5dc77c593d1eaa0464f268eedb98'],
    ['unionization', 1, '43fb1c62611d427dfddebe8a787641e8f6bf65377581a250ca686af36d3b6e72'],
    ['productive', 9, 'fa1cbb4a89100847bfc364585b48aee3967e1da6465c80b9e079a180cf0fd331'],
    ['underemployed', 65, '9f29686b9d8f6b3b9d48c02f7a016f73f5df3a1287e083a167e57ca73913d333'],
    ['inactive', 26, 'efd7889b53b4e0f46fa0f797dd2f26901c642449940667b95e9985bb6458ab48'],
    ['families', 15, '642d2858c19e8a00c681e36193389b822bc050045ed81522ad183461da194ae9'],
    ['disabled', 145, '0d4f429a716b68a12ab6329658ebfb3ab4ef002dfb0569475b4aed52406f811f'],
  ] as const)('"%s" returns %i hits, each in the same tier and place', (query, total, sha256) => {
    const result = searchAll(query);
    expect(result.total).toBe(total);
    expect(digest(rankedScopes(result))).toBe(sha256);
  });
});

describe('a sex word beside other terms', () => {
  // [query, the query without its sex word, hits, digest of the sorted hit codes]
  const QUERIES = [
    [
      'female unemployment rate',
      'unemployment rate',
      135,
      'bc5204dac15e1663ec99400455c1dbd3415d7ed8c2a16c4d1c2e5b5c3c0f44cf',
    ],
    [
      'women unemployment rate',
      'unemployment rate',
      135,
      'bc5204dac15e1663ec99400455c1dbd3415d7ed8c2a16c4d1c2e5b5c3c0f44cf',
    ],
    [
      'male labour force participation',
      'labour force participation',
      61,
      '7e85a4b57277b2f3d453f1ba83c011b75504ce6144bbb7bd99eb3e931443efc7',
    ],
    [
      'female employment',
      'employment',
      687,
      '63a5b7f568941080806458cecd23b6ea0d956682cb110182743dabb6a2b29c2d',
    ],
    [
      'men youth unemployment',
      'youth unemployment',
      44,
      '5a8d9070323b0297241a415a948d9dbb5475447f8dd9951306d27d41b40aea97',
    ],
    [
      'female informality',
      'informality',
      231,
      '0f3c4e8371d6abcf2275171d2ab62ab8c37d6d377ac863b20da84bc8db4a64b5',
    ],
  ] as const;

  it.each(QUERIES)(
    '"%s" still has to match the sex word: the same %i hits',
    (query, _base, total, sha256) => {
      const result = searchAll(query);
      expect(result.total).toBe(total);
      expect(digest(codes(result).sort())).toBe(sha256);
    },
  );

  it.each(QUERIES)('"%s" ranks its hits in the tier and order "%s" gives them', (query, base) => {
    const result = searchAll(query);
    const matched = new Set(codes(result));
    const expected = rankedScopes(searchAll(base)).filter((entry) =>
      matched.has(entry.slice(0, entry.indexOf(':'))),
    );
    expect(rankedScopes(result)).toEqual(expected);
  });

  it('"female unemployment rate" puts the unemployment-rate labels first, as "unemployment rate" does', () => {
    const top = searchAll('female unemployment rate').hits.slice(0, 3);
    expect(top.map((hit) => [hit.indicator.code, hit.scope])).toEqual([
      ['UNE_DEAP_SEX_AGE_RT', 'label'],
      ['SDG_0852_SEX_AGE_RT', 'label'],
      ['LUU_2LU2_SEX_AGE_RT', 'label'],
    ]);
  });
});

describe('the sex notice', () => {
  it.each([
    ['female labour force participation', 'female', 'SEX_F'],
    ['women labour force participation', 'women', 'SEX_F'],
    ['females labour force participation', 'females', 'SEX_F'],
    ['male labour force participation', 'male', 'SEX_M'],
    ['men unemployment rate', 'men', 'SEX_M'],
    ['Males unemployment rate', 'males', 'SEX_M'],
  ] as const)('"%s" names the sex filter for %s', (query, term, code) => {
    expect(searchAll(query).notice).toBe(sexSentence(term, code));
  });

  it('names each sex word once, in query order', () => {
    expect(searchAll('women and men employment').notice).toBe(
      `${sexSentence('women', 'SEX_F')} ${sexSentence('men', 'SEX_M')}`,
    );
  });

  it('follows the stem notice when a stemmed term combines with a sex word', () => {
    expect(searchAll('informality female').notice).toBe(
      `${stemSentence('informality', 'informal')} ${sexSentence('female', 'SEX_F')}`,
    );
  });

  it('is absent when nothing matched; the zero-hit notice stands alone', () => {
    const result = searchAll('female astronauts');
    expect(result.total).toBe(0);
    expect(result.notice).toBe(
      'No indicator matched every term. Use fewer or broader terms (for example "youth unemployment"), or browse subjects with ilostat_list_reference topic subjects and search by subject.',
    );
  });

  it('precedes the past-the-end notice on a cursor past the last match', () => {
    const result = searchIndicators(snapshot, {
      query: 'female unemployment rate',
      limit: 10,
      offset: 500,
      aggregatesOnly: false,
    });
    expect(result.hits).toEqual([]);
    expect(result.total).toBe(135);
    expect(
      result.notice?.startsWith(`${sexSentence('female', 'SEX_F')} The cursor starts past`),
    ).toBe(true);
  });

  it('names the sex filter only when an indicator broken down by sex matched', () => {
    const lowPay = searchAll('female low pay');
    expect(codes(lowPay)).toEqual(codes(searchAll('low pay')));
    expect(codes(lowPay)).toEqual(['EAR_XTLP_SEX_RT', 'EAR_XFLS_NOC_RT', 'EAR_XTLP_SEX_NB']);
    expect(lowPay.notice).toBe(sexSentence('female', 'SEX_F'));
    // Women in managerial positions (SDG 5.5.2) is published without a sex breakdown.
    const managerial = searchAll('women managerial');
    expect(codes(managerial)).toEqual([
      'SDG_T552_NOC_RT',
      'SDG_U552_NOC_RT',
      'SDG_0552_NOC_RT',
      'SDG_B552_NOC_RT',
    ]);
    expect(managerial.notice).toBeUndefined();
  });

  it('is absent for a term that only starts a sex word, and for queries with no sex word', () => {
    expect(searchAll('fem labour force participation').notice).toBeUndefined();
    expect(searchAll('labour force participation').notice).toBeUndefined();
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

  it('names the disability words for disabled', () => {
    expect(searchAll('disabled').notice).toBe(stemSentence('disabled', 'disabilities, disability'));
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
