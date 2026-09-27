/**
 * @fileoverview The cross-area comparison behind `ilostat_compare_geographies`,
 * as pure functions over rows already fetched for one dataset and one slice:
 * each area's value at the requested period or its latest non-projected period,
 * the change over N years, a rank by value (ties share a rank), the areas with no
 * value and why, and the comparability flags. The staged comparison — one row
 * per area — has its own explicit column schema.
 * @module services/observations/comparison
 */

import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import type { Basis } from '@/services/basis/basis.js';
import type { BasisCounts } from '@/services/canvas-bridge/canvas-bridge.js';
import { periodYear, periodYearsBefore } from '@/services/catalog/codes.js';
import type { RawObservation } from '@/services/rplumber/types.js';
import { emptyBasisCounts, type ObservationRow } from './observation-rows.js';

export type CompareSort = 'value_desc' | 'value_asc' | 'ref_area';

export type MissingReason = 'no_value_in_window' | 'no_value_for_period' | 'not_covered';

/** An upstream row with a value, classed by basis. */
export interface Candidate {
  basis: Basis;
  raw: RawObservation & { value: number };
}

export type CompareMode =
  | {
      /** Earliest year a latest value may fall in: current year − lookback_years, never widened by change_years. */
      fromYear: number;
      includeProjections: boolean;
      kind: 'latest';
    }
  | { kind: 'period'; period: string };

export interface Change {
  delta: number;
  fromPeriod: string;
  fromValue: number;
}

export interface ComparisonEntry {
  change?: Change;
  rank: number;
  /** The chosen observation, decoded. `value` is always set. */
  row: ObservationRow & { value: number };
}

export interface Comparison {
  basisCounts: BasisCounts;
  distinctSources: number;
  /** Ordered by the requested sort. */
  entries: ComparisonEntry[];
  missing: { reason: MissingReason; refArea: string }[];
  mixedPeriods: boolean;
  /** Distinct periods of the chosen values, newest first. */
  periods: string[];
}

export interface CompareInput {
  /** Every requested area, in request order. */
  areas: readonly string[];
  /** Rows with a value, per area. */
  candidates: ReadonlyMap<string, readonly Candidate[]>;
  changeYears?: number;
  /** Areas the dataset covers, when its SDMX structure is known. */
  coveredAreas?: ReadonlySet<string>;
  decode: (raw: RawObservation) => ObservationRow;
  mode: CompareMode;
  sort: CompareSort;
}

/** Rounds away binary noise from a difference of decimal values (4.022 − 6.168). */
const roundDelta = (delta: number): number => Math.round(delta * 1e6) / 1e6;

function choose(candidates: readonly Candidate[], mode: CompareMode): Candidate | undefined {
  if (mode.kind === 'period') return candidates.find((c) => c.raw.period === mode.period);
  let latest: Candidate | undefined;
  for (const candidate of candidates) {
    if (candidate.basis === 'projection' && !mode.includeProjections) continue;
    if (periodYear(candidate.raw.period) < mode.fromYear) continue;
    if (!latest || candidate.raw.period > latest.raw.period) latest = candidate;
  }
  return latest;
}

const ORDER: Record<CompareSort, (a: ComparisonEntry, b: ComparisonEntry) => number> = {
  value_desc: (a, b) => b.row.value - a.row.value || a.row.ref_area.localeCompare(b.row.ref_area),
  value_asc: (a, b) => a.row.value - b.row.value || a.row.ref_area.localeCompare(b.row.ref_area),
  ref_area: (a, b) => a.row.ref_area.localeCompare(b.row.ref_area),
};

/** Chooses a value per area, ranks, and flags what makes the values hard to compare. */
export function compareAreas(input: CompareInput): Comparison {
  const entries: ComparisonEntry[] = [];
  const missing: Comparison['missing'] = [];
  for (const area of input.areas) {
    const candidates = input.candidates.get(area) ?? [];
    const chosen = choose(candidates, input.mode);
    if (!chosen) {
      missing.push({
        refArea: area,
        reason:
          input.coveredAreas && !input.coveredAreas.has(area)
            ? 'not_covered'
            : input.mode.kind === 'period'
              ? 'no_value_for_period'
              : 'no_value_in_window',
      });
      continue;
    }
    const fromPeriod =
      input.changeYears === undefined
        ? undefined
        : periodYearsBefore(chosen.raw.period, input.changeYears);
    const from = fromPeriod ? candidates.find((c) => c.raw.period === fromPeriod) : undefined;
    const row = { ...input.decode(chosen.raw), value: chosen.raw.value };
    entries.push({
      rank: 0,
      row,
      ...(from && fromPeriod
        ? {
            change: {
              fromPeriod,
              fromValue: from.raw.value,
              delta: roundDelta(chosen.raw.value - from.raw.value),
            },
          }
        : {}),
    });
  }

  const byValue = entries.toSorted(ORDER.value_desc);
  byValue.forEach((entry, index) => {
    const previous = byValue[index - 1];
    entry.rank = previous && previous.row.value === entry.row.value ? previous.rank : index + 1;
  });

  const basisCounts = emptyBasisCounts();
  for (const entry of entries) basisCounts[entry.row.basis] += 1;
  const periods = [...new Set(entries.map((entry) => entry.row.period))].sort().reverse();
  return {
    entries: entries.sort(ORDER[input.sort]),
    missing,
    periods,
    mixedPeriods: periods.length > 1,
    basisCounts,
    distinctSources: new Set(entries.map((entry) => entry.row.source)).size,
  };
}

/** One area of a staged comparison. */
export interface ComparisonRow extends Record<string, unknown> {
  basis: Basis;
  change_delta: number | null;
  change_from_period: string | null;
  change_from_value: number | null;
  dataset_id: string;
  note_codes: string | null;
  note_labels: string | null;
  obs_status: string | null;
  obs_status_label: string | null;
  period: string;
  rank: number;
  ref_area: string;
  ref_area_kind: 'country' | 'aggregate';
  ref_area_label: string | null;
  source: string;
  source_label: string | null;
  subperiod: number | null;
  unit: string | null;
  unit_multiplier: number | null;
  value: number;
  year: number;
}

/** Explicit schema for a staged comparison; every column nullable (the default). */
export const COMPARISON_COLUMNS: ColumnSchema[] = [
  { name: 'dataset_id', type: 'VARCHAR' },
  { name: 'rank', type: 'INTEGER' },
  { name: 'ref_area', type: 'VARCHAR' },
  { name: 'ref_area_label', type: 'VARCHAR' },
  { name: 'ref_area_kind', type: 'VARCHAR' },
  { name: 'period', type: 'VARCHAR' },
  { name: 'year', type: 'INTEGER' },
  { name: 'subperiod', type: 'INTEGER' },
  { name: 'value', type: 'DOUBLE' },
  { name: 'unit', type: 'VARCHAR' },
  { name: 'unit_multiplier', type: 'INTEGER' },
  { name: 'basis', type: 'VARCHAR' },
  { name: 'source', type: 'VARCHAR' },
  { name: 'source_label', type: 'VARCHAR' },
  { name: 'obs_status', type: 'VARCHAR' },
  { name: 'obs_status_label', type: 'VARCHAR' },
  { name: 'note_codes', type: 'VARCHAR' },
  { name: 'note_labels', type: 'VARCHAR' },
  { name: 'change_from_period', type: 'VARCHAR' },
  { name: 'change_from_value', type: 'DOUBLE' },
  { name: 'change_delta', type: 'DOUBLE' },
];

export function toComparisonRow(entry: ComparisonEntry): ComparisonRow {
  const { row, change } = entry;
  return {
    dataset_id: row.dataset_id,
    rank: entry.rank,
    ref_area: row.ref_area,
    ref_area_label: row.ref_area_label,
    ref_area_kind: row.ref_area_kind,
    period: row.period,
    year: row.year,
    subperiod: row.subperiod,
    value: row.value,
    unit: row.unit,
    unit_multiplier: row.unit_multiplier,
    basis: row.basis,
    source: row.source,
    source_label: row.source_label,
    obs_status: row.obs_status,
    obs_status_label: row.obs_status_label,
    note_codes: row.note_codes,
    note_labels: row.note_labels,
    change_from_period: change?.fromPeriod ?? null,
    change_from_value: change?.fromValue ?? null,
    change_delta: change?.delta ?? null,
  };
}
