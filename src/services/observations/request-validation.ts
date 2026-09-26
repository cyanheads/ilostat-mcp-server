/**
 * @fileoverview Validation of observation-request inputs against the in-memory
 * catalog, before anything is sent upstream: dataset IDs, reference areas and
 * area groups, sex and breakdown codes, and sources. Upstream answers an unknown
 * code with an empty result rather than an error, so every code is checked here
 * and a miss fails with the calling tool's declared reason and recovery. Only
 * certain normalizations apply; nothing is fuzzy-matched.
 * @module services/observations/request-validation
 */

import type { Context, TypedFail } from '@cyanheads/mcp-ts-core';
import {
  normalizeAreaCode,
  normalizeCode,
  normalizeDatasetId,
  normalizeSexCode,
} from '@/services/catalog/codes.js';
import { inlineText } from '@/services/catalog/text.js';
import type { AreaGroup, CatalogSnapshot, Dataset } from '@/services/catalog/types.js';

/** A handler context whose contract declares the reasons `R`; services raise them through its `fail`. */
export type FailingContext<R extends string> = Context & { fail: TypedFail<R> };

const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)];

/**
 * Dataset IDs to catalog datasets, deduplicated. A bare indicator code resolves
 * when it has exactly one frequency; with several, the failure lists them.
 */
export function resolveDatasets(
  snapshot: CatalogSnapshot,
  ids: readonly string[],
  ctx: FailingContext<'unknown_dataset'>,
): Dataset[] {
  const resolved = new Map<string, Dataset>();
  const unknown: string[] = [];
  const ambiguous: { code: string; variants: string[] }[] = [];
  for (const raw of ids) {
    const id = normalizeDatasetId(raw);
    const dataset = snapshot.datasets.get(id);
    const indicator = dataset ? undefined : snapshot.indicatorsByCode.get(id);
    const found = dataset ?? (indicator?.datasets.length === 1 ? indicator.datasets[0] : undefined);
    if (found) {
      resolved.set(found.id, found);
    } else if (indicator) {
      ambiguous.push({ code: id, variants: indicator.datasets.map((variant) => variant.id) });
    } else {
      unknown.push(id);
    }
  }
  if (unknown.length > 0) {
    throw ctx.fail(
      'unknown_dataset',
      `No ILOSTAT dataset has the ID ${inlineText(unknown.join(', '))}.`,
      { datasetIds: unknown, ...ctx.recoveryFor('unknown_dataset') },
    );
  }
  const [first] = ambiguous;
  if (first) {
    const variants = first.variants.join(', ');
    throw ctx.fail(
      'unknown_dataset',
      `${first.code} is an indicator code with several frequencies (${variants}); name one dataset.`,
      {
        indicator: first.code,
        variants: first.variants,
        recovery: {
          hint: `Pass one of ${variants} — the indicator code plus _A, _Q, or _M for the frequency you want.`,
        },
      },
    );
  }
  return [...resolved.values()];
}

/** The area group `area_group` names; fails `unknown_area_group` for any other code. */
export function resolveAreaGroup(
  snapshot: CatalogSnapshot,
  code: string,
  ctx: FailingContext<'unknown_area_group'>,
): AreaGroup {
  const normalized = normalizeAreaCode(code);
  const group = snapshot.areaGroups.get(normalized);
  if (!group) {
    throw ctx.fail(
      'unknown_area_group',
      `${inlineText(normalized)} is not X01, an ILO region or subregion, or a World Bank income group.`,
      { areaGroup: normalized, ...ctx.recoveryFor('unknown_area_group') },
    );
  }
  return group;
}

/** Code filters as given, before normalization. */
export interface CodeFilters {
  classif1?: readonly string[] | undefined;
  classif2?: readonly string[] | undefined;
  refAreas?: readonly string[] | undefined;
  sex?: readonly string[] | undefined;
  sources?: readonly string[] | undefined;
}

/** Code filters normalized, deduplicated, and checked against the dictionaries. */
export interface ValidCodes {
  classif1: string[];
  classif2: string[];
  refAreas: string[];
  sex: string[];
  sources: string[];
}

const FIELD_TOPICS = {
  ref_areas: 'ref_areas',
  sex: 'sexes',
  classif1: 'classifications',
  classif2: 'classifications',
  sources: 'sources',
} as const;

/**
 * Normalizes each code filter and checks it against its dictionary: reference
 * areas, sexes, the classif1 or classif2 codes (by the slot the code may fill),
 * and sources. Every rejected code is named in one `unknown_code` failure.
 */
export function validateCodes(
  snapshot: CatalogSnapshot,
  filters: CodeFilters,
  ctx: FailingContext<'unknown_code'>,
): ValidCodes {
  const valid: ValidCodes = {
    refAreas: unique((filters.refAreas ?? []).map(normalizeAreaCode)),
    sex: unique((filters.sex ?? []).map(normalizeSexCode)),
    classif1: unique((filters.classif1 ?? []).map(normalizeCode)),
    classif2: unique((filters.classif2 ?? []).map(normalizeCode)),
    sources: unique((filters.sources ?? []).map(normalizeCode)),
  };
  const slotAccepts = (code: string, slot: 'classif1' | 'classif2') => {
    const entry = snapshot.classifications.get(code);
    return entry !== undefined && (entry.slot === slot || entry.slot === 'both');
  };
  const rejected: [keyof typeof FIELD_TOPICS, string[]][] = [
    ['ref_areas', valid.refAreas.filter((code) => !snapshot.refAreas.has(code))],
    ['sex', valid.sex.filter((code) => !snapshot.sexes.has(code))],
    ['classif1', valid.classif1.filter((code) => !slotAccepts(code, 'classif1'))],
    ['classif2', valid.classif2.filter((code) => !slotAccepts(code, 'classif2'))],
    ['sources', valid.sources.filter((code) => !snapshot.sources.has(code))],
  ];
  const failing = rejected.filter(([, codes]) => codes.length > 0);
  if (failing.length > 0) {
    const detail = failing.map(([field, codes]) => `${field}: ${codes.join(', ')}`).join('; ');
    const topics = failing.map(([field]) => `topic ${FIELD_TOPICS[field]} for ${field}`).join(', ');
    throw ctx.fail('unknown_code', `Not ILOSTAT codes — ${inlineText(detail)}.`, {
      rejected: Object.fromEntries(failing),
      recovery: { hint: `Call ilostat_list_reference with ${topics} to find valid codes.` },
    });
  }
  return valid;
}

/**
 * Fails `aggregates_unavailable` when an X-coded aggregate is requested from a
 * dataset that carries no World, regional, or income-group rows.
 */
export function assertAggregatesAvailable(
  snapshot: CatalogSnapshot,
  areas: readonly string[],
  datasets: readonly Dataset[],
  ctx: FailingContext<'aggregates_unavailable'>,
): void {
  const aggregates = areas.filter((code) => snapshot.refAreas.get(code)?.kind === 'aggregate');
  if (aggregates.length === 0) return;
  const without = datasets.filter((dataset) => !dataset.hasAggregates).map((dataset) => dataset.id);
  if (without.length === 0) return;
  throw ctx.fail(
    'aggregates_unavailable',
    `${without.join(', ')} ${without.length === 1 ? 'has' : 'have'} no aggregate rows, so ${aggregates.join(', ')} cannot be served from ${without.length === 1 ? 'it' : 'them'}.`,
    { datasetIds: without, aggregates, ...ctx.recoveryFor('aggregates_unavailable') },
  );
}
