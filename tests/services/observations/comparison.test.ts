/**
 * @fileoverview Tests for the cross-area comparison behind
 * `ilostat_compare_geographies`, over rows decoded against the recorded catalog:
 * the latest non-projected value per area (a reported value newer than the
 * modelled cutoff kept, modelled projections skipped unless asked), period mode,
 * the change over N years with its delta rounded, ranks shared by ties under
 * every sort, the missing-area reasons and their precedence, the comparability
 * summary, and the staged row form against its explicit column schema.
 * @module tests/services/observations/comparison.test
 */

import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { beforeAll, describe, expect, it } from 'vitest';
import { CatalogService } from '@/services/catalog/catalog-service.js';
import type { CatalogSnapshot } from '@/services/catalog/types.js';
import {
  type Candidate,
  COMPARISON_COLUMNS,
  type CompareInput,
  compareAreas,
  toComparisonRow,
} from '@/services/observations/comparison.js';
import {
  decodeObservation,
  type ResolvedDataset,
} from '@/services/observations/observation-rows.js';
import { type IndicatorDataParams, RplumberClient } from '@/services/rplumber/rplumber-client.js';
import type { RawObservation } from '@/services/rplumber/types.js';
import {
  catalogRoutes,
  clientOptions,
  FIXED_NOW,
  fixtureText,
  INDICATOR_CSV,
  indicatorDataRoute,
  observationCatalogFixture,
} from '../../helpers/ilostat-upstream.js';
import { guardNetwork } from '../../helpers/network-guard.js';

guardNetwork();

/** The areas the recorded UNE_DEAP_SEX_AGE_RT structure constrains REF_AREA to. */
const COVERED = new Set(['ABW', 'KEN', 'USA', 'X01', 'X06']);

let snapshot: CatalogSnapshot;
let resolved: ResolvedDataset;

beforeAll(async () => {
  const http = createFetchMock(catalogRoutes(observationCatalogFixture()));
  const catalog = new CatalogService({
    rplumber: new RplumberClient(clientOptions(http.fetch)),
    refreshIntervalMs: 0,
    now: () => FIXED_NOW,
  });
  try {
    snapshot = await catalog.ready(createMockContext());
    const dataset = snapshot.datasets.get('UNE_DEAP_SEX_AGE_RT_A');
    const indicator = snapshot.indicatorsByCode.get('UNE_DEAP_SEX_AGE_RT');
    if (!dataset || !indicator) throw new Error('fixture catalog lacks UNE_DEAP_SEX_AGE_RT_A');
    resolved = { dataset, cutoff: catalog.projectionCutoff(indicator, snapshot) };
  } finally {
    catalog.dispose();
  }
});

const decode = (raw: RawObservation) => decodeObservation(raw, snapshot, resolved);

/** The compare slice (SEX_T, 15+) of the recorded CSV, read through the client as the service reads it. */
async function upstreamRows(
  params: Omit<IndicatorDataParams, 'datasetIds'>,
): Promise<RawObservation[]> {
  const http = createFetchMock([indicatorDataRoute(fixtureText(INDICATOR_CSV.uneDeap))]);
  const client = new RplumberClient(clientOptions(http.fetch));
  try {
    const url = client.indicatorDataUrl({
      datasetIds: ['UNE_DEAP_SEX_AGE_RT_A'],
      sex: ['SEX_T'],
      classif1: ['AGE_YTHADULT_YGE15'],
      ...params,
    });
    const scope = requestContextService.createRequestContext({ operation: 'comparison-test' });
    const rows: RawObservation[] = [];
    for await (const raw of await client.streamIndicatorData(
      url,
      scope,
      new AbortController().signal,
    )) {
      rows.push(raw);
    }
    return rows;
  } finally {
    client.dispose();
  }
}

/** Rows with a value, per area, classed by basis — the service's candidate map. */
function candidatesOf(rows: readonly RawObservation[]): Map<string, Candidate[]> {
  const byArea = new Map<string, Candidate[]>();
  for (const raw of rows) {
    if (raw.value === undefined) continue;
    const list = byArea.get(raw.refArea) ?? [];
    list.push({ raw: { ...raw, value: raw.value }, basis: decode(raw).basis });
    byArea.set(raw.refArea, list);
  }
  return byArea;
}

const raw = (
  refArea: string,
  period: string,
  value: number,
  source = 'BA:453',
): RawObservation => ({
  refArea,
  source,
  indicator: 'UNE_DEAP_SEX_AGE_RT',
  sex: 'SEX_T',
  classif1: 'AGE_YTHADULT_YGE15',
  period,
  notes: [],
  value,
});

function compare(overrides: Partial<CompareInput> & Pick<CompareInput, 'areas' | 'candidates'>) {
  return compareAreas({
    decode,
    mode: { kind: 'latest', includeProjections: false },
    sort: 'value_desc',
    ...overrides,
  });
}

const summary = (result: ReturnType<typeof compareAreas>) =>
  result.entries.map(({ rank, row, change }) => ({
    rank,
    area: row.ref_area,
    period: row.period,
    value: row.value,
    basis: row.basis,
    ...(change ? { change } : {}),
  }));

describe('latest mode', () => {
  it('keeps a reported value newer than the cutoff and skips modelled projections', async () => {
    expect(resolved.cutoff).toMatchObject({ projectionAfterYear: 2024, rule: 'catalog_edition' });
    const rows = await upstreamRows({
      refAreas: ['USA', 'X01', 'KEN', 'ABW', 'JOR'],
      timeFrom: 2016,
    });
    const result = compare({
      areas: ['USA', 'X01', 'KEN', 'ABW', 'JOR'],
      candidates: candidatesOf(rows),
      coveredAreas: COVERED,
    });
    expect(summary(result)).toEqual([
      { rank: 1, area: 'KEN', period: '2021', value: 5.585, basis: 'reported' },
      { rank: 2, area: 'X01', period: '2024', value: 4.883, basis: 'modelled_estimate' },
      { rank: 3, area: 'USA', period: '2025', value: 4.282, basis: 'reported' },
    ]);
    expect(result.missing).toEqual([
      { refArea: 'ABW', reason: 'no_value_in_window' },
      { refArea: 'JOR', reason: 'not_covered' },
    ]);
    expect(result.periods).toEqual(['2025', '2024', '2021']);
    expect(result.mixedPeriods).toBe(true);
    expect(result.basisCounts).toEqual({ reported: 2, modelled_estimate: 1, projection: 0 });
    expect(result.distinctSources).toBe(3);
  });

  it('takes the latest projection when projections are included', async () => {
    const rows = await upstreamRows({ refAreas: ['X01'], timeFrom: 2016 });
    const result = compare({
      areas: ['X01'],
      candidates: candidatesOf(rows),
      mode: { kind: 'latest', includeProjections: true },
    });
    expect(summary(result)).toEqual([
      { rank: 1, area: 'X01', period: '2027', value: 4.842, basis: 'projection' },
    ]);
    expect(result.basisCounts).toEqual({ reported: 0, modelled_estimate: 0, projection: 1 });
  });

  it('reports an area whose window holds only projections as having no value in it', async () => {
    const rows = await upstreamRows({ refAreas: ['X01'], timeFrom: 2025 });
    const result = compare({
      areas: ['X01'],
      candidates: candidatesOf(rows),
      coveredAreas: COVERED,
    });
    expect(result.entries).toEqual([]);
    expect(result.missing).toEqual([{ refArea: 'X01', reason: 'no_value_in_window' }]);
    expect(result.periods).toEqual([]);
    expect(result.mixedPeriods).toBe(false);
    expect(result.distinctSources).toBe(0);
  });
});

describe('period mode', () => {
  it('takes the exact period whatever its basis, with the change from N years before', async () => {
    const rows = await upstreamRows({ refAreas: ['USA', 'X01', 'KEN'], time: ['2023', '2025'] });
    const result = compare({
      areas: ['USA', 'X01', 'KEN'],
      candidates: candidatesOf(rows),
      coveredAreas: COVERED,
      mode: { kind: 'period', period: '2025' },
      changeYears: 2,
    });
    expect(summary(result)).toEqual([
      {
        rank: 1,
        area: 'X01',
        period: '2025',
        value: 4.869,
        basis: 'projection',
        change: { fromPeriod: '2023', fromValue: 4.896, delta: -0.027 },
      },
      {
        rank: 2,
        area: 'USA',
        period: '2025',
        value: 4.282,
        basis: 'reported',
        change: { fromPeriod: '2023', fromValue: 3.638, delta: 0.644 },
      },
    ]);
    expect(result.missing).toEqual([{ refArea: 'KEN', reason: 'no_value_for_period' }]);
    expect(result.mixedPeriods).toBe(false);
  });

  it('shifts a sub-annual period by whole years for the change', () => {
    const result = compare({
      areas: ['USA'],
      candidates: candidatesOf([raw('USA', '2024Q2', 4.1), raw('USA', '2023Q2', 3.6)]),
      mode: { kind: 'period', period: '2024Q2' },
      changeYears: 1,
    });
    expect(result.entries[0]?.change).toEqual({ fromPeriod: '2023Q2', fromValue: 3.6, delta: 0.5 });
  });

  it('omits the change when the base period has no value', () => {
    const result = compare({
      areas: ['USA'],
      candidates: candidatesOf([raw('USA', '2025', 4.282)]),
      changeYears: 10,
    });
    expect(result.entries[0]).not.toHaveProperty('change');
  });
});

describe('missing reasons', () => {
  it('names an area outside the dataset not_covered ahead of any other reason', () => {
    const result = compare({
      areas: ['JOR'],
      candidates: new Map(),
      coveredAreas: COVERED,
      mode: { kind: 'period', period: '2025' },
    });
    expect(result.missing).toEqual([{ refArea: 'JOR', reason: 'not_covered' }]);
  });

  it('never claims not_covered when the structure is unknown', () => {
    const result = compare({ areas: ['JOR'], candidates: new Map() });
    expect(result.missing).toEqual([{ refArea: 'JOR', reason: 'no_value_in_window' }]);
  });
});

describe('ranking and sorting', () => {
  const tied = () =>
    candidatesOf([
      raw('KEN', '2024', 5),
      raw('ABW', '2024', 5),
      raw('USA', '2024', 3),
      raw('JOR', '2024', 7, 'BA:682'),
    ]);
  const areas = ['KEN', 'ABW', 'USA', 'JOR'];
  const order = (result: ReturnType<typeof compareAreas>) =>
    result.entries.map((entry) => `${entry.row.ref_area}#${entry.rank}`);

  it('ranks by value descending, ties sharing a rank and the next rank skipping', () => {
    expect(order(compare({ areas, candidates: tied(), sort: 'value_desc' }))).toEqual([
      'JOR#1',
      'ABW#2',
      'KEN#2',
      'USA#4',
    ]);
  });

  it('keeps the value ranks under value_asc, ties ordered by area code', () => {
    expect(order(compare({ areas, candidates: tied(), sort: 'value_asc' }))).toEqual([
      'USA#4',
      'ABW#2',
      'KEN#2',
      'JOR#1',
    ]);
  });

  it('keeps the value ranks under ref_area order', () => {
    expect(order(compare({ areas, candidates: tied(), sort: 'ref_area' }))).toEqual([
      'ABW#2',
      'JOR#1',
      'KEN#2',
      'USA#4',
    ]);
  });

  it('counts the distinct sources of the chosen values', () => {
    expect(compare({ areas, candidates: tied() }).distinctSources).toBe(2);
  });
});

describe('toComparisonRow', () => {
  it('fills every staged column, the change columns null when no change was asked', () => {
    const [entry] = compare({
      areas: ['USA'],
      candidates: candidatesOf([raw('USA', '2025', 4.282)]),
    }).entries;
    if (!entry) throw new Error('expected an entry');
    const row = toComparisonRow(entry);
    expect(Object.keys(row)).toEqual(COMPARISON_COLUMNS.map((column) => column.name));
    expect(row).toMatchObject({
      dataset_id: 'UNE_DEAP_SEX_AGE_RT_A',
      rank: 1,
      ref_area: 'USA',
      ref_area_kind: 'country',
      period: '2025',
      year: 2025,
      subperiod: null,
      value: 4.282,
      basis: 'reported',
      source: 'BA:453',
      source_label: 'LFS - Current Population Survey',
      change_from_period: null,
      change_from_value: null,
      change_delta: null,
    });
  });

  it('carries the change when one was computed', () => {
    const [entry] = compare({
      areas: ['X01'],
      candidates: candidatesOf([
        raw('X01', '2024', 4.883, 'XA:8405'),
        raw('X01', '2014', 5.956, 'XA:8405'),
      ]),
      changeYears: 10,
    }).entries;
    if (!entry) throw new Error('expected an entry');
    expect(toComparisonRow(entry)).toMatchObject({
      ref_area: 'X01',
      ref_area_kind: 'aggregate',
      basis: 'modelled_estimate',
      change_from_period: '2014',
      change_from_value: 5.956,
      change_delta: -1.073,
    });
  });
});
