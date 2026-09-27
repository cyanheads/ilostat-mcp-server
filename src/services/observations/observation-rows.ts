/**
 * @fileoverview Observation rows as the tools carry them: decoded against the
 * catalog dictionaries and classed by basis. The staged form (codes and labels,
 * one column per field, the explicit DuckDB schema beside it) is what a
 * dataframe holds; the inline form keeps codes only and pairs with a legend.
 * @module services/observations/observation-rows
 */

import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { type Basis, classifyRow, type ProjectionCutoff } from '@/services/basis/basis.js';
import type { BasisCounts } from '@/services/canvas-bridge/canvas-bridge.js';
import { periodFrequency, periodSubperiod, periodYear } from '@/services/catalog/codes.js';
import type { CatalogSnapshot, Dataset } from '@/services/catalog/types.js';
import type { RawObservation } from '@/services/rplumber/types.js';
import type { UnitInfo } from '@/services/structure/sdmx-structure.js';

/** A requested dataset with what classifying and labelling its rows needs. */
export interface ResolvedDataset {
  cutoff: ProjectionCutoff;
  dataset: Dataset;
  /** Absent when the SDMX unit lookup did not resolve. */
  unit?: UnitInfo;
}

/** One observation in staged form — the column set of a staged query dataframe. */
export interface ObservationRow extends Record<string, unknown> {
  basis: Basis;
  /** Set only when secondary sources were requested. */
  best_source: boolean | null;
  classif1: string | null;
  classif1_label: string | null;
  classif2: string | null;
  classif2_label: string | null;
  dataset_id: string;
  indicator: string;
  indicator_label: string;
  /** `;`-joined note codes. */
  note_codes: string | null;
  /** ` | `-joined note labels. */
  note_labels: string | null;
  obs_status: string | null;
  obs_status_label: string | null;
  period: string;
  ref_area: string;
  ref_area_kind: 'country' | 'aggregate';
  ref_area_label: string | null;
  sex: string | null;
  sex_label: string | null;
  source: string;
  source_label: string | null;
  /** Quarter 1–4 or month 1–12; null for annual periods. */
  subperiod: number | null;
  /** Unit label (its code when unlabelled); null when unresolved. */
  unit: string | null;
  /** 0 units, 3 thousands, 6 millions; null when unresolved. */
  unit_multiplier: number | null;
  value: number | null;
  year: number;
}

/**
 * Explicit schema for staged observations — a value column sniffed from integral
 * first rows would truncate later decimals. Every column is nullable (the default).
 */
export const OBSERVATION_COLUMNS: ColumnSchema[] = [
  { name: 'dataset_id', type: 'VARCHAR' },
  { name: 'indicator', type: 'VARCHAR' },
  { name: 'indicator_label', type: 'VARCHAR' },
  { name: 'ref_area', type: 'VARCHAR' },
  { name: 'ref_area_label', type: 'VARCHAR' },
  { name: 'ref_area_kind', type: 'VARCHAR' },
  { name: 'source', type: 'VARCHAR' },
  { name: 'source_label', type: 'VARCHAR' },
  { name: 'sex', type: 'VARCHAR' },
  { name: 'sex_label', type: 'VARCHAR' },
  { name: 'classif1', type: 'VARCHAR' },
  { name: 'classif1_label', type: 'VARCHAR' },
  { name: 'classif2', type: 'VARCHAR' },
  { name: 'classif2_label', type: 'VARCHAR' },
  { name: 'period', type: 'VARCHAR' },
  { name: 'year', type: 'INTEGER' },
  { name: 'subperiod', type: 'INTEGER' },
  { name: 'value', type: 'DOUBLE' },
  { name: 'unit', type: 'VARCHAR' },
  { name: 'unit_multiplier', type: 'INTEGER' },
  { name: 'obs_status', type: 'VARCHAR' },
  { name: 'obs_status_label', type: 'VARCHAR' },
  { name: 'note_codes', type: 'VARCHAR' },
  { name: 'note_labels', type: 'VARCHAR' },
  { name: 'basis', type: 'VARCHAR' },
  { name: 'best_source', type: 'BOOLEAN' },
];

/** One observation inline: codes only, decoded through the response legend. */
export interface InlineRow {
  basis: Basis;
  best_source?: boolean;
  classif1?: string;
  classif2?: string;
  dataset_id: string;
  notes: string[];
  obs_status?: string;
  period: string;
  ref_area: string;
  sex?: string;
  source: string;
  value?: number;
}

/** Code → label maps for every code the inline rows carry. */
export interface Legend {
  classif1: Record<string, string>;
  classif2: Record<string, string>;
  notes: Record<string, string>;
  obs_status: Record<string, string>;
  ref_area: Record<string, string>;
  sex: Record<string, string>;
  source: Record<string, string>;
}

const NOTE_SEPARATOR = ';';

/** Label used when a code is not in the loaded dictionary. */
export const UNLABELLED = 'Not in the ILOSTAT dictionary';

export function unitLabel(unit: UnitInfo | undefined): string | null {
  return unit ? (unit.measureLabel ?? unit.measure) : null;
}

/** Looks requested datasets up by the indicator code and frequency a row carries. */
export class DatasetIndex {
  private readonly byKey = new Map<string, ResolvedDataset>();
  private readonly byIndicator = new Map<string, ResolvedDataset>();

  constructor(datasets: readonly ResolvedDataset[]) {
    for (const resolved of datasets) {
      this.byKey.set(`${resolved.dataset.indicator}|${resolved.dataset.frequency}`, resolved);
      if (!this.byIndicator.has(resolved.dataset.indicator)) {
        this.byIndicator.set(resolved.dataset.indicator, resolved);
      }
    }
  }

  /** The requested dataset a row belongs to: its indicator at the frequency its period names. */
  find(raw: RawObservation): ResolvedDataset | undefined {
    return (
      this.byKey.get(`${raw.indicator}|${periodFrequency(raw.period)}`) ??
      this.byIndicator.get(raw.indicator)
    );
  }
}

/** Decodes and classifies one upstream row against the snapshot and the requested dataset it belongs to. */
export function decodeObservation(
  raw: RawObservation,
  snapshot: CatalogSnapshot,
  resolved: ResolvedDataset | undefined,
): ObservationRow {
  const year = periodYear(raw.period);
  const sourceLabel = snapshot.sources.get(raw.source)?.label;
  const area = snapshot.refAreas.get(raw.refArea);
  const cutoff = resolved?.cutoff.projectionAfterYear ?? year;
  const label = (code: string | undefined, lookup: Map<string, { label: string }>) =>
    code === undefined ? null : (lookup.get(code)?.label ?? null);
  return {
    dataset_id: resolved?.dataset.id ?? `${raw.indicator}_${periodFrequency(raw.period)}`,
    indicator: raw.indicator,
    indicator_label: resolved?.dataset.label ?? raw.indicator,
    ref_area: raw.refArea,
    ref_area_label: area?.label ?? null,
    ref_area_kind: area?.kind ?? (raw.refArea.startsWith('X') ? 'aggregate' : 'country'),
    source: raw.source,
    source_label: sourceLabel ?? null,
    sex: raw.sex ?? null,
    sex_label: label(raw.sex, snapshot.sexes),
    classif1: raw.classif1 ?? null,
    classif1_label: label(raw.classif1, snapshot.classifications),
    classif2: raw.classif2 ?? null,
    classif2_label: label(raw.classif2, snapshot.classifications),
    period: raw.period,
    year,
    subperiod: periodSubperiod(raw.period) ?? null,
    value: raw.value ?? null,
    unit: unitLabel(resolved?.unit),
    unit_multiplier: resolved?.unit?.multiplier ?? null,
    obs_status: raw.obsStatus ?? null,
    obs_status_label: label(raw.obsStatus, snapshot.obsStatus),
    note_codes: raw.notes.length > 0 ? raw.notes.join(NOTE_SEPARATOR) : null,
    note_labels:
      raw.notes.length > 0
        ? raw.notes.map((code) => snapshot.notes.get(code)?.label ?? UNLABELLED).join(' | ')
        : null,
    basis: classifyRow({ sourceLabel, year }, cutoff),
    best_source: raw.bestSource ?? null,
  };
}

/** Note codes of a staged row. */
export function noteCodesOf(row: { note_codes: string | null }): string[] {
  return row.note_codes ? row.note_codes.split(NOTE_SEPARATOR) : [];
}

export function toInlineRow(row: ObservationRow): InlineRow {
  return {
    dataset_id: row.dataset_id,
    ref_area: row.ref_area,
    source: row.source,
    ...(row.sex === null ? {} : { sex: row.sex }),
    ...(row.classif1 === null ? {} : { classif1: row.classif1 }),
    ...(row.classif2 === null ? {} : { classif2: row.classif2 }),
    period: row.period,
    ...(row.value === null ? {} : { value: row.value }),
    ...(row.obs_status === null ? {} : { obs_status: row.obs_status }),
    notes: noteCodesOf(row),
    basis: row.basis,
    ...(row.best_source === null ? {} : { best_source: row.best_source }),
  };
}

/**
 * An empty code → label map with no prototype, so an upstream code named like an
 * `Object.prototype` member (`__proto__`, `constructor`) is stored as an own key
 * and an absent code reads back undefined.
 */
export function codeLabels(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

/** The legend for a set of staged rows, labels from the snapshot dictionaries. */
export function legendOf(rows: readonly ObservationRow[], snapshot: CatalogSnapshot): Legend {
  const legend: Legend = {
    ref_area: codeLabels(),
    source: codeLabels(),
    sex: codeLabels(),
    classif1: codeLabels(),
    classif2: codeLabels(),
    obs_status: codeLabels(),
    notes: codeLabels(),
  };
  const put = (map: Record<string, string>, code: string | null, label: string | null) => {
    if (code !== null) map[code] = label ?? UNLABELLED;
  };
  for (const row of rows) {
    put(legend.ref_area, row.ref_area, row.ref_area_label);
    put(legend.source, row.source, row.source_label);
    put(legend.sex, row.sex, row.sex_label);
    put(legend.classif1, row.classif1, row.classif1_label);
    put(legend.classif2, row.classif2, row.classif2_label);
    put(legend.obs_status, row.obs_status, row.obs_status_label);
    for (const code of noteCodesOf(row)) {
      legend.notes[code] = snapshot.notes.get(code)?.label ?? UNLABELLED;
    }
  }
  return legend;
}

export function emptyBasisCounts(): BasisCounts {
  return { reported: 0, modelled_estimate: 0, projection: 0 };
}

/** Running summary over every row read: row count, distinct areas, period bounds, basis counts. */
export class ObservationSummary {
  readonly basisCounts: BasisCounts = emptyBasisCounts();
  periodMax: string | undefined;
  periodMin: string | undefined;
  rows = 0;
  private readonly areas = new Set<string>();

  add(row: ObservationRow): void {
    this.rows += 1;
    this.areas.add(row.ref_area);
    this.basisCounts[row.basis] += 1;
    if (this.periodMin === undefined || row.period < this.periodMin) this.periodMin = row.period;
    if (this.periodMax === undefined || row.period > this.periodMax) this.periodMax = row.period;
  }

  get refAreas(): number {
    return this.areas.size;
  }
}
