/**
 * @fileoverview Domain types for the in-memory ILOSTAT catalog snapshot: datasets
 * and indicators from the indicator table of contents, reference areas and area
 * groups from the reference-area table of contents, and the decoded dictionaries.
 * @module services/catalog/types
 */

import type { Edition } from '@/services/basis/basis.js';

export interface CodeLabel {
  code: string;
  label: string;
}

/** One ToC row: an indicator at one frequency (`UNE_DEAP_SEX_AGE_RT_A`). */
export interface Dataset {
  classification?: string;
  database: CodeLabel;
  dataEnd: number;
  dataStart: number;
  /** `A`, `Q`, or `M`. */
  frequency: string;
  /** Whether this dataset carries World/regional/income-group rows (`with.region = Y`). Varies by frequency for some indicators. */
  hasAggregates: boolean;
  id: string;
  indicator: string;
  label: string;
  /** ISO 8601 without zone offset. */
  lastUpdate: string;
  measure: CodeLabel;
  nRecords: number;
  nRecordsAll: number;
  nRefArea: number;
  subject: CodeLabel;
}

/** Normalized words an indicator is searched on, by match scope. */
export interface SearchWords {
  /** Label plus metadata plus the definition text. */
  definition: string[];
  label: string[];
  /** Label, subject, database, breakdown names, and code. */
  metadata: string[];
}

/** An indicator with its datasets, one per available frequency. */
export interface Indicator {
  /** Human breakdown names from the ToC (`["sex", "age"]`); empty when none. */
  breakdowns: string[];
  classification?: string;
  /** Classification type codes the ToC classification names (`["SEX", "AGE"]`). */
  classificationTypes: string[];
  code: string;
  database: CodeLabel;
  /** Ordered A, Q, M. */
  datasets: Dataset[];
  /** Dictionary description as plain text. */
  definition?: string;
  /** The edition the label names, if any. */
  edition?: Edition;
  hasAggregates: boolean;
  label: string;
  /** Latest `lastUpdate` across the datasets — the structure cache key. */
  lastUpdate: string;
  measure: CodeLabel;
  search: SearchWords;
  subject: CodeLabel;
}

/** Grouping levels, in listing order; `world` is X01, whose members are every country. */
export const AREA_GROUP_TYPES = [
  'world',
  'region',
  'subregion_broad',
  'subregion_detailed',
  'income_group',
] as const;

export type AreaGroupType = (typeof AREA_GROUP_TYPES)[number];

export interface RefArea {
  code: string;
  dataEnd?: number;
  dataStart?: number;
  /** Datasets with data for this area, summed over frequencies. */
  datasetCount?: number;
  frequencies: string[];
  incomeGroup?: CodeLabel;
  kind: 'country' | 'aggregate';
  label: string;
  region?: CodeLabel;
  subregionBroad?: CodeLabel;
  subregionDetailed?: CodeLabel;
}

/** X01 (every country), a region, a subregion, or an income group `area_group` accepts, keyed by its X code. */
export interface AreaGroup {
  code: string;
  label: string;
  /** Member countries, sorted. */
  members: string[];
  types: AreaGroupType[];
}

export interface CountedCode extends CodeLabel {
  datasetCount: number;
}

export interface ClassificationCode extends CodeLabel {
  slot: 'classif1' | 'classif2' | 'both';
  /** Prefix before the first underscore (`AGE` for `AGE_YTHADULT_YGE15`). */
  type: string;
}

export interface SourceCode extends CodeLabel {
  refArea?: string;
  /** Label prefix before ` - ` (`LFS`, `ADM`, `ILO`, …). */
  sourceType: string;
}

export type NoteType = 'note_source' | 'note_indicator' | 'note_classif';

export interface NoteCode extends CodeLabel {
  type: NoteType;
}

/** An immutable, atomically swapped view of the ILOSTAT catalog. */
export interface CatalogSnapshot {
  areaGroups: Map<string, AreaGroup>;
  /** ISO timestamp the snapshot was last confirmed current against upstream. */
  asOf: string;
  /** The latest ILO modelled estimates edition named by any label. */
  catalogEdition?: Edition;
  classifications: Map<string, ClassificationCode>;
  classificationTypes: Map<string, CodeLabel>;
  databases: Map<string, CountedCode>;
  datasets: Map<string, Dataset>;
  frequencies: Map<string, CountedCode>;
  /** Sorted by code. */
  indicators: Indicator[];
  indicatorsByCode: Map<string, Indicator>;
  /** Indicators by measure (`rep_var`) code. */
  indicatorsByMeasure: Map<string, Indicator[]>;
  notes: Map<string, NoteCode>;
  obsStatus: Map<string, CodeLabel>;
  refAreas: Map<string, RefArea>;
  sexes: Map<string, CodeLabel>;
  /** Change signal: sorted `id|last.update` over both ToCs. */
  signature: string;
  sources: Map<string, SourceCode>;
  subjects: Map<string, CountedCode>;
}
