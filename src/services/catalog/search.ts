/**
 * @fileoverview Indicator search over the catalog snapshot. Every term must match a
 * word or word prefix; the ranking is a transparent three-tier rule with no score:
 * tier 1 when every term matches the label, tier 2 when every term matches across
 * label, subject, database, breakdown names, and code, tier 3 when the definition
 * text is needed. Within a tier, indicators covering more reference areas come
 * first, then indicator code. Facets and the zero-hit notice are computed over the
 * fully filtered match set, locally.
 * @module services/catalog/search
 */

import { pageOf } from './paging.js';
import { matchesAllTerms, wordsOf } from './text.js';
import type { CatalogSnapshot, CodeLabel, Dataset, Indicator } from './types.js';

/** Validated search inputs; codes already uppercased and checked against the catalog, the cursor already decoded. */
export interface SearchParams {
  aggregatesOnly: boolean;
  breakdown?: string;
  database?: string;
  frequency?: string;
  limit: number;
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
  /** Zero-hit guidance, a note that the query held no searchable word, or that the cursor starts past the last match. */
  notice?: string;
  total: number;
}

type Filters = Omit<SearchParams, 'limit' | 'offset' | 'query'>;

const SCOPE_RANK: Record<MatchScope, number> = { label: 0, metadata: 1, definition: 2 };

function matchScope(indicator: Indicator, terms: string[]): MatchScope | undefined {
  if (matchesAllTerms(terms, indicator.search.label)) return 'label';
  if (matchesAllTerms(terms, indicator.search.metadata)) return 'metadata';
  if (matchesAllTerms(terms, indicator.search.definition)) return 'definition';
  return;
}

function matching(snapshot: CatalogSnapshot, terms: string[], filters: Filters): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const indicator of snapshot.indicators) {
    if (filters.database && indicator.database.code !== filters.database) continue;
    if (filters.subject && indicator.subject.code !== filters.subject) continue;
    if (filters.breakdown && !indicator.classificationTypes.includes(filters.breakdown)) continue;
    const datasets = indicator.datasets.filter(
      (dataset) =>
        (!filters.frequency || dataset.frequency === filters.frequency) &&
        (!filters.aggregatesOnly || dataset.hasAggregates),
    );
    if (datasets.length === 0) continue;
    if (terms.length === 0) {
      hits.push({ indicator, datasets });
      continue;
    }
    const scope = matchScope(indicator, terms);
    if (scope) hits.push({ indicator, datasets, scope });
  }
  if (terms.length > 0) {
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

const RELAXABLE = ['frequency', 'database', 'subject', 'breakdown'] as const;

function without(filters: Filters, key: (typeof RELAXABLE)[number]): Filters {
  const { [key]: _omitted, ...rest } = filters;
  return rest;
}

/** Composes the zero-hit notice from whichever relaxations would yield hits, each computed locally. */
function zeroHitNotice(snapshot: CatalogSnapshot, terms: string[], filters: Filters): string {
  const fragments: string[] = [];
  for (const key of RELAXABLE) {
    if (!filters[key]) continue;
    const count = matching(snapshot, terms, without(filters, key)).length;
    if (count > 0) {
      fragments.push(
        `${indicatorCount(count)} without the ${key} filter — drop it or pick another value.`,
      );
    }
  }
  if (
    filters.aggregatesOnly &&
    matching(snapshot, terms, { ...filters, aggregatesOnly: false }).length > 0
  ) {
    fragments.push(
      'None of these indicators carries regional aggregates; the ILO modelled estimates (database ILOEST) do.',
    );
  }
  if (terms.length > 0 && matching(snapshot, terms, { aggregatesOnly: false }).length === 0) {
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
  const hits = matching(snapshot, terms, filters);
  const page = pageOf(hits, offset, limit);
  const notices: string[] = [];
  if (query && terms.length === 0) {
    notices.push(
      'query held no searchable word (letters or digits), so indicators were browsed by filters alone.',
    );
  }
  if (hits.length === 0) notices.push(zeroHitNotice(snapshot, terms, filters));
  if (page.notice) notices.push(page.notice);
  return {
    hits: page.items,
    total: hits.length,
    facets: facetsOf(hits),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    ...(notices.length > 0 ? { notice: notices.join(' ') } : {}),
  };
}
