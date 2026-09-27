/**
 * @fileoverview Builds a {@link CatalogSnapshot} from the raw tables of contents and
 * dictionaries: datasets grouped into indicators, the per-indicator search words,
 * reference areas with their region and income-group memberships, the area groups
 * `area_group` accepts, and every decoded code vocabulary. Pure.
 * @module services/catalog/snapshot
 */

import { latestCatalogEdition, parseEdition } from '@/services/basis/basis.js';
import type {
  DictionaryEntry,
  DictionaryVar,
  IndicatorTocRow,
  RefAreaTocRow,
} from '@/services/rplumber/types.js';
import { classificationTypeOf, FREQUENCY_ORDER, normalizeAreaCode } from './codes.js';
import { htmlToText, toIsoTimestamp, wordsOf } from './text.js';
import {
  AREA_GROUP_TYPES,
  type AreaGroup,
  type AreaGroupType,
  type CatalogSnapshot,
  type ClassificationCode,
  type CodeLabel,
  type CountedCode,
  type Dataset,
  type Indicator,
  type NoteCode,
  type NoteType,
  type RefArea,
  type SourceCode,
} from './types.js';

/** Everything one catalog load fetches. */
export interface RawCatalog {
  dictionaries: Record<DictionaryVar, DictionaryEntry[]>;
  indicatorToc: IndicatorTocRow[];
  refAreaToc: RefAreaTocRow[];
}

/**
 * Change signal over both ToCs. Upstream offers no ETag or Last-Modified, so the
 * ToCs' own `last.update` columns are what a refresh compares.
 */
export function catalogSignature(
  indicatorToc: IndicatorTocRow[],
  refAreaToc: RefAreaTocRow[],
): string {
  return [
    ...indicatorToc.map((row) => `i:${row.id}|${row['last.update']}`),
    ...refAreaToc.map((row) => `a:${row.id}|${row['last.update']}`),
  ]
    .sort()
    .join('\n');
}

const frequencyRank = (frequency: string): number => {
  const rank = FREQUENCY_ORDER.indexOf(frequency as (typeof FREQUENCY_ORDER)[number]);
  return rank === -1 ? FREQUENCY_ORDER.length : rank;
};

const byCode = <T extends { code: string }>(a: T, b: T): number => a.code.localeCompare(b.code);

/** `entries` keyed by code, in code order. */
const byCodeMap = <T extends { code: string }>(entries: Iterable<T>): Map<string, T> =>
  new Map([...entries].sort(byCode).map((entry) => [entry.code, entry]));

function toDataset(row: IndicatorTocRow): Dataset {
  return {
    id: row.id,
    indicator: row.indicator,
    label: row['indicator.label'],
    frequency: row.freq,
    measure: { code: row.rep_var, label: row['rep_var.label'] },
    ...(row.classification ? { classification: row.classification } : {}),
    dataStart: row['data.start'],
    dataEnd: row['data.end'],
    lastUpdate: toIsoTimestamp(row['last.update']),
    nRecords: row['n.records'],
    nRecordsAll: row['n.records.all'],
    nRefArea: row['n.ref_area'],
    hasAggregates: row['with.region'] === 'Y',
    subject: { code: row.subject, label: row['subject.label'] },
    database: { code: row.database, label: row['database.label'] },
  };
}

/** Human breakdown names: the ToC's `classif.labels`, else the classification types' dictionary labels. */
function breakdownNames(
  row: IndicatorTocRow,
  types: string[],
  typeLabels: Map<string, string>,
): string[] {
  const listed = (row['classif.labels'] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (listed.length > 0 || types.length === 0) return listed;
  return types.map((type) => (typeLabels.get(type) ?? type).toLowerCase());
}

function buildIndicators(
  toc: IndicatorTocRow[],
  descriptions: Map<string, string>,
  typeLabels: Map<string, string>,
): Indicator[] {
  const indicators: Indicator[] = [];
  for (const [code, rows] of Map.groupBy(toc, (row) => row.indicator)) {
    const first = rows[0];
    if (!first) continue;
    const datasets = rows
      .map(toDataset)
      .sort((a, b) => frequencyRank(a.frequency) - frequencyRank(b.frequency));
    const types = first.classification ? first.classification.split('_').filter(Boolean) : [];
    const breakdowns = breakdownNames(first, types, typeLabels);
    const label = first['indicator.label'];
    const definition = descriptions.get(code);
    const edition = parseEdition(label);
    const labelWords = wordsOf(label);
    const metadataWords = wordsOf(
      label,
      first['subject.label'],
      first.subject,
      first['database.label'],
      first.database,
      breakdowns.join(' '),
      code,
    );
    indicators.push({
      code,
      label,
      measure: { code: first.rep_var, label: first['rep_var.label'] },
      ...(first.classification ? { classification: first.classification } : {}),
      classificationTypes: types,
      breakdowns,
      subject: { code: first.subject, label: first['subject.label'] },
      database: { code: first.database, label: first['database.label'] },
      ...(definition ? { definition } : {}),
      ...(edition ? { edition } : {}),
      datasets,
      hasAggregates: datasets.some((dataset) => dataset.hasAggregates),
      lastUpdate: datasets.reduce(
        (latest, dataset) => (dataset.lastUpdate > latest ? dataset.lastUpdate : latest),
        '',
      ),
      search: {
        label: labelWords,
        metadata: metadataWords,
        definition: definition ? wordsOf(metadataWords.join(' '), definition) : metadataWords,
      },
    });
  }
  return indicators.sort(byCode);
}

const GROUP_FIELDS = [
  ['ilo_region', 'region'],
  ['ilo_subregion_broad', 'subregion_broad'],
  ['ilo_subregion_detailed', 'subregion_detailed'],
  ['wb_income_group', 'income_group'],
] as const satisfies readonly (readonly [keyof RefAreaTocRow, AreaGroupType])[];

/** The World aggregate's code, and the area group of every country. */
const WORLD_GROUP = 'X01';

function groupOf(
  row: RefAreaTocRow,
  field: (typeof GROUP_FIELDS)[number][0],
): CodeLabel | undefined {
  const code = row[field];
  const label = row[`${field}.label`];
  return code ? { code: normalizeAreaCode(code), label: label ?? code } : undefined;
}

function buildRefAreas(
  toc: RefAreaTocRow[],
  dictionary: DictionaryEntry[],
): { areaGroups: Map<string, AreaGroup>; refAreas: Map<string, RefArea> } {
  const refAreas = new Map<string, RefArea>();
  const groups = new Map<
    string,
    { label: string; members: Set<string>; types: Set<AreaGroupType> }
  >();

  for (const row of toc) {
    const code = row.ref_area;
    const existing = refAreas.get(code);
    if (existing) {
      existing.frequencies.push(row.freq);
      existing.dataStart = Math.min(existing.dataStart ?? row['data.start'], row['data.start']);
      existing.dataEnd = Math.max(existing.dataEnd ?? row['data.end'], row['data.end']);
      existing.datasetCount = (existing.datasetCount ?? 0) + row['n.indicator'];
      continue;
    }
    const incomeGroup = groupOf(row, 'wb_income_group');
    const region = groupOf(row, 'ilo_region');
    const subregionBroad = groupOf(row, 'ilo_subregion_broad');
    const subregionDetailed = groupOf(row, 'ilo_subregion_detailed');
    const kind = code.startsWith('X') && !region ? 'aggregate' : 'country';
    refAreas.set(code, {
      code,
      label: row['ref_area.label'],
      kind,
      frequencies: [row.freq],
      dataStart: row['data.start'],
      dataEnd: row['data.end'],
      datasetCount: row['n.indicator'],
      ...(incomeGroup ? { incomeGroup } : {}),
      ...(region ? { region } : {}),
      ...(subregionBroad ? { subregionBroad } : {}),
      ...(subregionDetailed ? { subregionDetailed } : {}),
    });
    if (kind !== 'country') continue;
    for (const [field, type] of GROUP_FIELDS) {
      const group = groupOf(row, field);
      if (!group) continue;
      const entry = groups.get(group.code) ?? {
        label: group.label,
        members: new Set<string>(),
        types: new Set<AreaGroupType>(),
      };
      entry.members.add(code);
      entry.types.add(type);
      groups.set(group.code, entry);
    }
  }

  // X01 (World) groups every country the ToC lists; aggregates are never members.
  const countries = [...refAreas.values()].filter((area) => area.kind === 'country');
  if (countries.length > 0) {
    groups.set(WORLD_GROUP, {
      label: refAreas.get(WORLD_GROUP)?.label ?? 'World',
      members: new Set(countries.map((area) => area.code)),
      types: new Set<AreaGroupType>(['world']),
    });
  }

  // Areas the dictionary knows that no ToC row lists still decode.
  for (const entry of dictionary) {
    if (refAreas.has(entry.code)) continue;
    refAreas.set(entry.code, {
      code: entry.code,
      label: entry.label,
      kind: entry.code.startsWith('X') ? 'aggregate' : 'country',
      frequencies: [],
    });
  }
  for (const area of refAreas.values()) {
    area.frequencies.sort((a, b) => frequencyRank(a) - frequencyRank(b));
  }

  const areaGroups = byCodeMap(
    [...groups].map(
      ([code, group]): AreaGroup => ({
        code,
        label: group.label,
        members: [...group.members].sort(),
        types: AREA_GROUP_TYPES.filter((type) => group.types.has(type)),
      }),
    ),
  );
  return { areaGroups, refAreas: byCodeMap(refAreas.values()) };
}

function codeLabelMap(entries: DictionaryEntry[]): Map<string, CodeLabel> {
  return byCodeMap(entries.map(({ code, label }) => ({ code, label })));
}

/** Counted vocabulary: dictionary entries plus codes only the ToC names, with the ToC's dataset counts. */
function countedMap(
  dictionary: DictionaryEntry[],
  datasets: Dataset[],
  pick: (dataset: Dataset) => CodeLabel,
): Map<string, CountedCode> {
  const counted = new Map<string, CountedCode>();
  for (const entry of dictionary) {
    counted.set(entry.code, { code: entry.code, label: entry.label, datasetCount: 0 });
  }
  for (const dataset of datasets) {
    const { code, label } = pick(dataset);
    const entry = counted.get(code) ?? { code, label, datasetCount: 0 };
    entry.datasetCount += 1;
    counted.set(code, entry);
  }
  return byCodeMap(counted.values());
}

function buildClassifications(
  classif1: DictionaryEntry[],
  classif2: DictionaryEntry[],
): Map<string, ClassificationCode> {
  const inClassif2 = new Set(classif2.map((entry) => entry.code));
  const merged = new Map<string, ClassificationCode>();
  for (const entry of classif1) {
    merged.set(entry.code, {
      code: entry.code,
      label: entry.label,
      slot: inClassif2.has(entry.code) ? 'both' : 'classif1',
      type: classificationTypeOf(entry.code),
    });
  }
  for (const entry of classif2) {
    if (merged.has(entry.code)) continue;
    merged.set(entry.code, {
      code: entry.code,
      label: entry.label,
      slot: 'classif2',
      type: classificationTypeOf(entry.code),
    });
  }
  return byCodeMap(merged.values());
}

/**
 * Classification types: the dictionary plus the components the ToC uses that it
 * lacks (`QTL`). A ToC-only type has no published label; it is named so.
 */
function buildClassificationTypes(
  dictionary: DictionaryEntry[],
  indicators: Indicator[],
): Map<string, CodeLabel> {
  const types = codeLabelMap(dictionary);
  for (const indicator of indicators) {
    for (const type of indicator.classificationTypes) {
      if (!types.has(type)) {
        types.set(type, { code: type, label: 'No label published in the ILOSTAT dictionary' });
      }
    }
  }
  return byCodeMap(types.values());
}

function buildSources(dictionary: DictionaryEntry[]): Map<string, SourceCode> {
  return byCodeMap(
    dictionary.map((entry): SourceCode => {
      const dash = entry.label.indexOf(' - ');
      return {
        code: entry.code,
        label: entry.label,
        sourceType: dash === -1 ? entry.label : entry.label.slice(0, dash),
        ...(entry.refArea ? { refArea: entry.refArea } : {}),
      };
    }),
  );
}

function buildNotes(dictionaries: Record<DictionaryVar, DictionaryEntry[]>): Map<string, NoteCode> {
  const types: NoteType[] = ['note_classif', 'note_indicator', 'note_source'];
  return byCodeMap(
    types.flatMap((type) =>
      dictionaries[type].map((entry): NoteCode => ({ code: entry.code, label: entry.label, type })),
    ),
  );
}

/** Builds the snapshot; `asOf` is when it was confirmed current against upstream. */
export function buildSnapshot(raw: RawCatalog, asOf: string): CatalogSnapshot {
  const { dictionaries } = raw;
  const descriptions = new Map<string, string>();
  for (const entry of dictionaries.indicator) {
    const text = entry.description ? htmlToText(entry.description) : '';
    if (text) descriptions.set(entry.code, text);
  }
  const typeLabels = new Map(dictionaries.classif_type.map((entry) => [entry.code, entry.label]));
  const indicators = buildIndicators(raw.indicatorToc, descriptions, typeLabels);
  const datasetList = indicators.flatMap((indicator) => indicator.datasets);

  const frequencies = new Map<string, CountedCode>();
  for (const row of raw.indicatorToc) {
    const entry = frequencies.get(row.freq) ?? {
      code: row.freq,
      label: row['freq.label'] ?? row.freq,
      datasetCount: 0,
    };
    entry.datasetCount += 1;
    frequencies.set(row.freq, entry);
  }

  const { areaGroups, refAreas } = buildRefAreas(raw.refAreaToc, dictionaries.ref_area);
  const catalogEdition = latestCatalogEdition(indicators.map((indicator) => indicator.label));

  return {
    asOf,
    signature: catalogSignature(raw.indicatorToc, raw.refAreaToc),
    ...(catalogEdition ? { catalogEdition } : {}),
    indicators,
    indicatorsByCode: new Map(indicators.map((indicator) => [indicator.code, indicator])),
    indicatorsByMeasure: Map.groupBy(indicators, (indicator) => indicator.measure.code),
    datasets: new Map(datasetList.map((dataset) => [dataset.id, dataset])),
    refAreas,
    areaGroups,
    databases: countedMap(dictionaries.database, datasetList, (dataset) => dataset.database),
    subjects: countedMap(dictionaries.subject, datasetList, (dataset) => dataset.subject),
    frequencies: new Map(
      [...frequencies.values()]
        .sort((a, b) => frequencyRank(a.code) - frequencyRank(b.code))
        .map((entry) => [entry.code, entry]),
    ),
    sexes: new Map(
      dictionaries.sex.map((entry) => [entry.code, { code: entry.code, label: entry.label }]),
    ),
    classifications: buildClassifications(dictionaries.classif1, dictionaries.classif2),
    classificationTypes: buildClassificationTypes(dictionaries.classif_type, indicators),
    sources: buildSources(dictionaries.source),
    obsStatus: codeLabelMap(dictionaries.obs_status),
    notes: buildNotes(dictionaries),
  };
}
