/**
 * @fileoverview Indicator search over the catalog snapshot. Every term must match a
 * word or word prefix; a term that matches no word or word prefix anywhere in the
 * catalog is matched by its light suffix stem instead, decided against the whole
 * catalog so a filter never changes how a term matches, and named in the notice.
 * The ranking is a transparent three-tier rule with no score:
 * tier 1 when every term matches the label, tier 2 when every term matches across
 * label, subject, database, breakdown names, and code, tier 3 when the definition
 * text is needed. Within a tier, indicators covering more reference areas come
 * first, then indicator code. Facets and the zero-hit notice are computed over the
 * fully filtered match set, locally.
 * @module services/catalog/search
 */

import { pageOf } from './paging.js';
import { stemOf, termMatches, wordsOf } from './text.js';
import type { CatalogSnapshot, CodeLabel, Dataset, Indicator } from './types.js';

/** Validated search inputs; codes already uppercased and checked against the catalog, the cursor already decoded. */
export interface SearchParams {
  aggregatesOnly: boolean;
  breakdown?: string;
  database?: string;
  frequency?: string;
  limit: number;
  /** Measure (`rep_var`) code: keeps the indicators measuring that quantity. */
  measure?: string;
  /** Page start, from the decoded cursor; 0 for the first page. */
  offset: number;
  query?: string;
  subject?: string;
}

export type MatchScope = 'label' | 'metadata' | 'definition';

export interface SearchHit {
  /** The indicator's datasets that survive the frequency and aggregates filters. */
  datasets: Dataset[];
  indicator: Indicator;
  /** Absent when browsing without a query. */
  scope?: MatchScope;
}

export interface FacetCount extends CodeLabel {
  count: number;
}

export interface SearchFacets {
  databases: FacetCount[];
  frequencies: { code: string; count: number }[];
  subjects: FacetCount[];
}

export interface SearchResult {
  facets: SearchFacets;
  hits: SearchHit[];
  nextCursor?: string;
  /** Zero-hit guidance, a note that the query held no searchable word, the terms matched by stem, or that the cursor starts past the last match. */
  notice?: string;
  total: number;
}

type Filters = Omit<SearchParams, 'limit' | 'offset' | 'query'>;

const SCOPE_RANK: Record<MatchScope, number> = { label: 0, metadata: 1, definition: 2 };

/** Whether one search term matches among an indicator's words. */
type TermMatcher = (words: readonly string[]) => boolean;

/** A term matched by stem, with the catalog words that share its stem. */
interface StemmedTerm {
  term: string;
  words: string[];
}

/**
 * One matcher per term. A term that is a word or word prefix of any catalog word
 * keeps that rule; any other term matches the catalog words sharing its stem, and
 * the catalog word its stem spells.
 */
function termMatchers(
  snapshot: CatalogSnapshot,
  terms: string[],
): { matchers: TermMatcher[]; stemmed: StemmedTerm[] } {
  const matchers: TermMatcher[] = [];
  const stemmed: StemmedTerm[] = [];
  for (const term of terms) {
    if (termMatches(term, snapshot.searchVocabulary)) {
      matchers.push((words) => termMatches(term, words));
      continue;
    }
    const forms = snapshot.searchStems.get(stemOf(term)) ?? [];
    const formSet = new Set(forms);
    matchers.push((words) => words.some((word) => formSet.has(word)));
    if (forms.length > 0) stemmed.push({ term, words: forms });
  }
  return { matchers, stemmed };
}

const matchesAll = (matchers: TermMatcher[], words: readonly string[]) =>
  matchers.every((matches) => matches(words));

function matchScope(indicator: Indicator, matchers: TermMatcher[]): MatchScope | undefined {
  if (matchesAll(matchers, indicator.search.label)) return 'label';
  if (matchesAll(matchers, indicator.search.metadata)) return 'metadata';
  if (matchesAll(matchers, indicator.search.definition)) return 'definition';
  return;
}

function matching(
  snapshot: CatalogSnapshot,
  matchers: TermMatcher[],
  filters: Filters,
): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const indicator of snapshot.indicators) {
    if (filters.database && indicator.database.code !== filters.database) continue;
    if (filters.subject && indicator.subject.code !== filters.subject) continue;
    if (filters.breakdown && !indicator.classificationTypes.includes(filters.breakdown)) continue;
    if (filters.measure && indicator.measure.code !== filters.measure) continue;
    const datasets = indicator.datasets.filter(
      (dataset) =>
        (!filters.frequency || dataset.frequency === filters.frequency) &&
        (!filters.aggregatesOnly || dataset.hasAggregates),
    );
    if (datasets.length === 0) continue;
    if (matchers.length === 0) {
      hits.push({ indicator, datasets });
      continue;
    }
    const scope = matchScope(indicator, matchers);
    if (scope) hits.push({ indicator, datasets, scope });
  }
  if (matchers.length > 0) {
    const reach = (hit: SearchHit) => Math.max(...hit.datasets.map((dataset) => dataset.nRefArea));
    hits.sort(
      (a, b) =>
        SCOPE_RANK[a.scope ?? 'definition'] - SCOPE_RANK[b.scope ?? 'definition'] ||
        reach(b) - reach(a) ||
        a.indicator.code.localeCompare(b.indicator.code),
    );
  }
  return hits;
}

/** Hits per key, most first, then by code. */
function countBy<T extends { code: string }>(
  hits: SearchHit[],
  keys: (hit: SearchHit) => T[],
): (T & { count: number })[] {
  const counts = new Map<string, T & { count: number }>();
  for (const hit of hits) {
    for (const key of keys(hit)) {
      const entry = counts.get(key.code) ?? { ...key, count: 0 };
      entry.count += 1;
      counts.set(key.code, entry);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

function facetsOf(hits: SearchHit[]): SearchFacets {
  return {
    databases: countBy(hits, (hit) => [hit.indicator.database]),
    frequencies: countBy(hits, (hit) =>
      [...new Set(hit.datasets.map((dataset) => dataset.frequency))].map((code) => ({ code })),
    ),
    subjects: countBy(hits, (hit) => [hit.indicator.subject]),
  };
}

const indicatorCount = (n: number) =>
  `${n} indicator${n === 1 ? '' : 's'} match${n === 1 ? 'es' : ''}`;

const RELAXABLE = ['frequency', 'database', 'subject', 'breakdown', 'measure'] as const;

function without(filters: Filters, key: (typeof RELAXABLE)[number]): Filters {
  const { [key]: _omitted, ...rest } = filters;
  return rest;
}

/** Composes the zero-hit notice from whichever relaxations would yield hits, each computed locally. */
function zeroHitNotice(
  snapshot: CatalogSnapshot,
  matchers: TermMatcher[],
  filters: Filters,
): string {
  const fragments: string[] = [];
  for (const key of RELAXABLE) {
    if (!filters[key]) continue;
    const count = matching(snapshot, matchers, without(filters, key)).length;
    if (count > 0) {
      fragments.push(
        `${indicatorCount(count)} without the ${key} filter — drop it or pick another value.`,
      );
    }
  }
  if (
    filters.aggregatesOnly &&
    matching(snapshot, matchers, { ...filters, aggregatesOnly: false }).length > 0
  ) {
    fragments.push(
      'None of these indicators carries regional aggregates; the ILO modelled estimates (database ILOEST) do.',
    );
  }
  if (matchers.length > 0 && matching(snapshot, matchers, { aggregatesOnly: false }).length === 0) {
    fragments.push(
      'No indicator matched every term. Use fewer or broader terms (for example "youth unemployment"), or browse subjects with ilostat_list_reference topic subjects and search by subject.',
    );
  }
  if (fragments.length === 0) {
    fragments.push(
      'No indicator matches these terms and filters together; drop filters one at a time to widen the search.',
    );
  }
  return fragments.join(' ');
}

/** Searches the snapshot and returns the page starting at `offset`. */
export function searchIndicators(snapshot: CatalogSnapshot, params: SearchParams): SearchResult {
  const { query, offset, limit, ...filters } = params;
  const terms = query ? wordsOf(query) : [];
  const { matchers, stemmed } = termMatchers(snapshot, terms);
  const hits = matching(snapshot, matchers, filters);
  const page = pageOf(hits, offset, limit);
  const notices: string[] = [];
  if (query && terms.length === 0) {
    notices.push(
      'query held no searchable word (letters or digits), so indicators were browsed by filters alone.',
    );
  }
  for (const { term, words } of stemmed) {
    notices.push(
      `${term} matched no catalog word or word prefix, so it was matched by stem: ${words.join(', ')}. Check the hits are about ${term}; if those words mean something else, search a synonym instead.`,
    );
  }
  if (hits.length === 0) notices.push(zeroHitNotice(snapshot, matchers, filters));
  if (page.notice) notices.push(page.notice);
  return {
    hits: page.items,
    total: hits.length,
    facets: facetsOf(hits),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    ...(notices.length > 0 ? { notice: notices.join(' ') } : {}),
  };
}
