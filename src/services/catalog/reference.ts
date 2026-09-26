/**
 * @fileoverview The code vocabulary behind `ilostat_list_reference`: one flat entry
 * shape per topic, a strict word-prefix text filter over code and label, exact
 * code lookup with misses reported, and paging over the filtered list from a
 * decoded cursor offset.
 * @module services/catalog/reference
 */

import { normalizeAreaCode } from './codes.js';
import { pageOf } from './paging.js';
import { inlineText, matchesAllTerms, wordsOf } from './text.js';
import type { AreaGroupType, CatalogSnapshot } from './types.js';

export const REFERENCE_TOPICS = [
  'ref_areas',
  'area_groups',
  'databases',
  'subjects',
  'sexes',
  'classifications',
  'classification_types',
  'sources',
  'obs_status',
  'notes',
  'frequencies',
] as const;

export type ReferenceTopic = (typeof REFERENCE_TOPICS)[number];

/** One decoded code. Every topic carries `code` and `label`; the rest depend on the topic. */
export interface ReferenceEntry {
  classification_type?: string;
  code: string;
  data_end?: number;
  data_start?: number;
  dataset_count?: number;
  frequencies?: string[];
  group_types?: AreaGroupType[];
  ilo_region?: string;
  ilo_region_label?: string;
  ilo_subregion_broad?: string;
  ilo_subregion_broad_label?: string;
  ilo_subregion_detailed?: string;
  ilo_subregion_detailed_label?: string;
  income_group?: string;
  income_group_label?: string;
  kind?: 'country' | 'aggregate';
  label: string;
  member_count?: number;
  /** area_groups looked up by exact code only: the member countries. */
  members?: { code: string; label?: string }[];
  note_type?: string;
  ref_area?: string;
  slot?: 'classif1' | 'classif2' | 'both';
  source_type?: string;
}

/**
 * Validated inputs; `refArea` is a known reference area and only set with topic
 * `sources`, `classificationType` only with topic `classifications`.
 */
export interface ReferenceParams {
  classificationType?: string;
  codes?: string[];
  filter?: string;
  limit: number;
  /** Page start, from the decoded cursor; 0 for the first page. */
  offset: number;
  refArea?: string;
  topic: ReferenceTopic;
}

export interface ReferenceResult {
  entries: ReferenceEntry[];
  nextCursor?: string;
  notFound?: string[];
  notice?: string;
  total: number;
}

/** `withMembers` lists each area group's member countries; only an exact-code lookup sets it. */
function entriesFor(
  snapshot: CatalogSnapshot,
  topic: ReferenceTopic,
  withMembers: boolean,
): ReferenceEntry[] {
  switch (topic) {
    case 'ref_areas':
      return [...snapshot.refAreas.values()].map((area) => ({
        code: area.code,
        label: area.label,
        kind: area.kind,
        frequencies: area.frequencies,
        ...(area.dataStart === undefined ? {} : { data_start: area.dataStart }),
        ...(area.dataEnd === undefined ? {} : { data_end: area.dataEnd }),
        ...(area.datasetCount === undefined ? {} : { dataset_count: area.datasetCount }),
        ...(area.incomeGroup
          ? { income_group: area.incomeGroup.code, income_group_label: area.incomeGroup.label }
          : {}),
        ...(area.region
          ? { ilo_region: area.region.code, ilo_region_label: area.region.label }
          : {}),
        ...(area.subregionBroad
          ? {
              ilo_subregion_broad: area.subregionBroad.code,
              ilo_subregion_broad_label: area.subregionBroad.label,
            }
          : {}),
        ...(area.subregionDetailed
          ? {
              ilo_subregion_detailed: area.subregionDetailed.code,
              ilo_subregion_detailed_label: area.subregionDetailed.label,
            }
          : {}),
      }));
    case 'area_groups':
      return [...snapshot.areaGroups.values()].map((areaGroup) => ({
        code: areaGroup.code,
        label: areaGroup.label,
        group_types: areaGroup.types,
        member_count: areaGroup.members.length,
        ...(withMembers
          ? {
              members: areaGroup.members.map((code) => {
                const label = snapshot.refAreas.get(code)?.label;
                return { code, ...(label ? { label } : {}) };
              }),
            }
          : {}),
      }));
    case 'databases':
      return [...snapshot.databases.values()].map((entry) => ({
        code: entry.code,
        label: entry.label,
        dataset_count: entry.datasetCount,
      }));
    case 'subjects':
      return [...snapshot.subjects.values()].map((entry) => ({
        code: entry.code,
        label: entry.label,
        dataset_count: entry.datasetCount,
      }));
    case 'frequencies':
      return [...snapshot.frequencies.values()].map((entry) => ({
        code: entry.code,
        label: entry.label,
        dataset_count: entry.datasetCount,
      }));
    case 'sexes':
      return [...snapshot.sexes.values()].map(({ code, label }) => ({ code, label }));
    case 'classifications':
      return [...snapshot.classifications.values()].map((entry) => ({
        code: entry.code,
        label: entry.label,
        slot: entry.slot,
        classification_type: entry.type,
      }));
    case 'classification_types':
      return [...snapshot.classificationTypes.values()].map(({ code, label }) => ({ code, label }));
    case 'sources':
      return [...snapshot.sources.values()].map((entry) => ({
        code: entry.code,
        label: entry.label,
        source_type: entry.sourceType,
        ...(entry.refArea ? { ref_area: entry.refArea } : {}),
      }));
    case 'obs_status':
      return [...snapshot.obsStatus.values()].map(({ code, label }) => ({ code, label }));
    case 'notes':
      return [...snapshot.notes.values()].map((entry) => ({
        code: entry.code,
        label: entry.label,
        note_type: entry.type,
      }));
  }
}

const AREA_TOPICS: ReadonlySet<ReferenceTopic> = new Set(['ref_areas', 'area_groups']);

/**
 * Scopes, looks up, filters, and pages one topic. The zero-hit notice names the
 * step that removed the last entries; an exact lookup that finds nothing sets
 * none, since `notFound` already lists the misses.
 */
export function listReference(snapshot: CatalogSnapshot, params: ReferenceParams): ReferenceResult {
  let entries = entriesFor(snapshot, params.topic, Boolean(params.codes?.length));
  let notFound: string[] | undefined;
  let emptiedBy: string | undefined;
  const narrow = (keep: (entry: ReferenceEntry) => boolean, notice?: string) => {
    if (entries.length === 0) return;
    entries = entries.filter(keep);
    if (entries.length === 0) emptiedBy = notice;
  };

  if (params.refArea) {
    narrow(
      (entry) => entry.ref_area === params.refArea,
      `${params.refArea} has no sources in the dictionary.`,
    );
  }
  if (params.classificationType) {
    narrow(
      (entry) => entry.classification_type === params.classificationType,
      `No classification code has type ${inlineText(params.classificationType)}; ilostat_list_reference topic classification_types lists the types.`,
    );
  }
  if (params.codes?.length) {
    const wanted = params.codes.map((code) =>
      AREA_TOPICS.has(params.topic) ? normalizeAreaCode(code) : code.trim().toUpperCase(),
    );
    const present = new Set(entries.map((entry) => entry.code.toUpperCase()));
    notFound = wanted.filter((code) => !present.has(code));
    const wantedSet = new Set(wanted);
    narrow((entry) => wantedSet.has(entry.code.toUpperCase()));
  }
  const terms = params.filter ? wordsOf(params.filter) : [];
  if (params.filter && terms.length > 0) {
    narrow(
      (entry) => matchesAllTerms(terms, wordsOf(entry.code, entry.label)),
      `No ${params.topic} entry matched "${inlineText(params.filter)}". Every filter term must appear in the code or label; try one distinctive word, or omit filter to page the full list.`,
    );
  }

  const notices = [
    params.filter && terms.length === 0
      ? 'filter held no searchable word (letters or digits), so it was not applied.'
      : undefined,
    emptiedBy,
  ].filter((notice) => notice !== undefined);
  const page = pageOf(entries, params.offset, params.limit);

  return {
    entries: page.items,
    total: entries.length,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    ...(notFound?.length ? { notFound } : {}),
    ...(notices.length > 0 ? { notice: notices.join(' ') } : {}),
  };
}
