/**
 * @fileoverview Raw row schemas for the rplumber.ilo.org metadata endpoints, validated
 * at the network boundary. Field names mirror the upstream JSON verbatim, dots
 * included. Null fields are omitted upstream rather than sent as null, so every
 * field that is not on every row is optional.
 * @module services/rplumber/types
 */

import { z } from '@cyanheads/mcp-ts-core';

/** One row of `/metadata/toc/indicator` — a dataset (indicator at one frequency). */
export const IndicatorTocRowSchema = z.object({
  id: z.string(),
  indicator: z.string(),
  'indicator.label': z.string(),
  freq: z.string(),
  'freq.label': z.string().optional(),
  rep_var: z.string(),
  'rep_var.label': z.string(),
  /** Absent on datasets without breakdowns. */
  classification: z.string().optional(),
  'classif.labels': z.string().optional(),
  'data.start': z.number(),
  'data.end': z.number(),
  /** `dd/mm/yyyy HH:MM:SS`, no zone. */
  'last.update': z.string(),
  'n.records': z.number(),
  'n.records.all': z.number(),
  'n.ref_area': z.number(),
  /** `Y` when the dataset carries World/regional/income-group rows; absent otherwise. */
  'with.region': z.string().optional(),
  subject: z.string(),
  'subject.label': z.string(),
  database: z.string(),
  'database.label': z.string(),
});

export type IndicatorTocRow = z.infer<typeof IndicatorTocRowSchema>;

/** One row of `/metadata/toc/ref_area` — a reference area at one frequency. Group codes are absent on aggregates. */
export const RefAreaTocRowSchema = z.object({
  id: z.string(),
  ref_area: z.string(),
  'ref_area.label': z.string(),
  freq: z.string(),
  'data.start': z.number(),
  'data.end': z.number(),
  'last.update': z.string(),
  'n.records': z.number(),
  'n.records.all': z.number(),
  'n.indicator': z.number(),
  wb_income_group: z.string().optional(),
  'wb_income_group.label': z.string().optional(),
  ilo_region: z.string().optional(),
  'ilo_region.label': z.string().optional(),
  ilo_subregion_broad: z.string().optional(),
  'ilo_subregion_broad.label': z.string().optional(),
  ilo_subregion_detailed: z.string().optional(),
  'ilo_subregion_detailed.label': z.string().optional(),
});

export type RefAreaTocRow = z.infer<typeof RefAreaTocRowSchema>;

/** The `var` values `/metadata/dic` serves that the catalog loads. */
export const DICTIONARY_VARS = [
  'ref_area',
  'indicator',
  'sex',
  'classif1',
  'classif2',
  'obs_status',
  'note_classif',
  'note_indicator',
  'note_source',
  'source',
  'classif_type',
  'database',
  'subject',
] as const;

export type DictionaryVar = (typeof DICTIONARY_VARS)[number];

/**
 * One dictionary entry, normalized from `{<var>, <var>.label}`. The indicator
 * dictionary adds `indicator.description` (HTML); the source dictionary adds the
 * source's `ref_area`.
 */
export interface DictionaryEntry {
  code: string;
  description?: string;
  label: string;
  refArea?: string;
}

/**
 * One row of `/data/ref_area` (`format=.json`). Null fields are omitted upstream;
 * the breakdown and note columns exist only on indicators that carry them.
 */
export const RefAreaDataRowSchema = z.object({
  ref_area: z.string(),
  source: z.string(),
  indicator: z.string(),
  sex: z.string().nullish(),
  classif1: z.string().nullish(),
  classif2: z.string().nullish(),
  time: z.union([z.string(), z.number()]),
  obs_value: z.number().nullish(),
  obs_status: z.string().nullish(),
  note_classif: z.string().nullish(),
  note_indicator: z.string().nullish(),
  note_source: z.string().nullish(),
});

export type RefAreaDataRow = z.infer<typeof RefAreaDataRowSchema>;

/**
 * One observation as either data endpoint delivers it, normalized: codes only
 * (`type=code`), an absent cell left absent, compound notes split into codes.
 */
export interface RawObservation {
  /** Present only when the request asked for secondary sources (`best_source` `all` or `no`). */
  bestSource?: boolean;
  classif1?: string;
  classif2?: string;
  /** Indicator code without the frequency suffix. */
  indicator: string;
  /** Note codes from `note_classif`, `note_indicator`, and `note_source`, in that order. */
  notes: string[];
  obsStatus?: string;
  /** `YYYY`, `YYYYQn`, or `YYYYMmm`. */
  period: string;
  refArea: string;
  sex?: string;
  source: string;
  /** Absent when upstream sends no value (~4% of rows in large LFS datasets). */
  value?: number;
}
