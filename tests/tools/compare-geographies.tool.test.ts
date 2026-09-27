/**
 * @fileoverview Tests for `ilostat_compare_geographies` against the recorded
 * catalog and `UNE_DEAP_SEX_AGE_RT_A` CSV (rplumber fetch seam, filtered by the
 * upstream emulator) and the recorded SDMX structures: latest mode keeping a
 * reported value newer than the cutoff while skipping projections, the request it
 * sends (`timefrom`, never `timeto`), period mode with both periods in one `time`
 * value, change over N years, ties, the three sorts, every missing reason, the
 * comparability flags and notices, the default slice from SDMX, `invalid_slice`
 * in both variants, `structure_unavailable` and the unit and area-list notices
 * of a partial SDMX failure, staging and the canvas-off preview, every declared error
 * reason, and both consumption paths (`structuredContent` and `content[]`).
 * @module tests/tools/compare-geographies.tool.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  type FetchMockRoute,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { compareGeographiesTool } from '@/mcp-server/tools/definitions/compare-geographies.tool.js';
import { disposeIlostatServices } from '@/services/ilostat-services.js';
import {
  CATALOG_UNAVAILABLE_RECOVERY,
  callUrls,
  csvResponse,
  fixtureText,
  INDICATOR_CSV,
  indicatorDataRoute,
  isIndicatorData,
  isRplumber,
  memoryCanvas,
  observationCatalogFixture,
  probeRoute,
  retiredDatasetResponse,
  SDMX_422_SHORT_KEY,
  sdmxText,
  structureRoute,
  tooManyRequests,
  upstreamParams,
  type WireOptions,
  wireServices,
} from '../helpers/ilostat-upstream.js';
import { guardNetwork } from '../helpers/network-guard.js';

guardNetwork();

const canvases: DataCanvas[] = [];

afterEach(async () => {
  disposeIlostatServices();
  for (const canvas of canvases.splice(0)) await canvas.shutdown(createMockContext());
});

type Args = Parameters<typeof compareGeographiesTool.input.parse>[0];
type Output = Awaited<ReturnType<typeof compareGeographiesTool.handler>>;
type ContractResult = Awaited<ReturnType<typeof runToolContract>>;

const UNE = 'UNE_DEAP_SEX_AGE_RT_A';
const ATTRIBUTION =
  'Source: ILOSTAT, International Labour Organization (CC BY 4.0) — https://ilostat.ilo.org';
const UPSTREAM_BUSY_RECOVERY =
  'The ILOSTAT API is throttling this server; wait the retry-after interval in the error data, then call again with the same arguments.';
const INVALID_SLICE_RECOVERY =
  'Pass sex, classif1, and classif2 only for breakdowns the dataset has, with explicit codes where it has no total; ilostat_describe_indicator lists them.';
const STRUCTURE_UNAVAILABLE_RECOVERY =
  "ILOSTAT's structure service could not supply the dataset's total codes; pass an explicit classif1 and classif2 code for each breakdown the dataset has — ilostat_list_reference topic classifications lists them.";
const UNE_COVERAGE_NOTICE = `The area list of ${UNE} is unavailable from the ILOSTAT structure service, so no missing area is marked not_covered, even one ${UNE} does not cover.`;
const UNE_UNIT_NOTICE = `The unit of ${UNE} is unavailable from the ILOSTAT structure service; the dataset label's parenthetical — (%) or (thousands) — gives it.`;

const CSV_HEADER =
  '"ref_area","source","indicator","sex","classif1","time","obs_value","obs_status"';

/** Two areas tied at 5 and one below, all in 2024. */
const TIES_CSV = [
  `﻿${CSV_HEADER}`,
  '"USA","BA:453","UNE_DEAP_SEX_AGE_RT","SEX_T","AGE_YTHADULT_YGE15","2024",5,',
  '"KEN","BA:7008","UNE_DEAP_SEX_AGE_RT","SEX_T","AGE_YTHADULT_YGE15","2024",5,',
  '"X01","XA:8405","UNE_DEAP_SEX_AGE_RT","SEX_T","AGE_YTHADULT_YGE15","2024",4.5,',
  '',
].join('\n');

const UNE_META = {
  dataset_id: UNE,
  label: 'Unemployment rate by sex and age (%)',
  frequency: 'A',
  database: { code: 'LFS', label: 'Labour Force Statistics (LFS)' },
  last_update: '2026-09-24T07:10:19',
  has_aggregates: true,
  projection_after_year: 2024,
  projection_rule: 'catalog_edition',
  edition: 'Nov. 2025',
  unit: {
    measure: 'PT',
    measure_label: 'Percentage',
    type: 'RT',
    type_label: 'Rate',
    multiplier: 0,
    multiplier_label: 'Units',
  },
};

const KEN_2021 = {
  ref_area: 'KEN',
  label: 'Kenya',
  kind: 'country',
  value: 5.585,
  period: '2021',
  basis: 'reported',
  source: 'BX:3465',
  source_label: 'HS - Continuous household survey',
  notes: ['R1:3513'],
};
const X01_2024 = {
  ref_area: 'X01',
  label: 'World',
  kind: 'aggregate',
  value: 4.883,
  period: '2024',
  basis: 'modelled_estimate',
  source: 'XA:8405',
  source_label: 'ILO - Modelled Estimates',
  notes: [],
};
const USA_2025 = {
  ref_area: 'USA',
  label: 'United States of America',
  kind: 'country',
  value: 4.282,
  period: '2025',
  basis: 'reported',
  source: 'BA:453',
  source_label: 'LFS - Current Population Survey',
  obs_status: 'B',
  notes: ['I11:264', 'R1:3513', 'R1:2803', 'T2:85'],
};
const USA_2025_LEGEND = {
  obs_status: { B: 'Break in series' },
  notes: {
    'I11:264': 'Break in series: Methodology revised',
    'R1:3513': 'Repository: ILO-STATISTICS - Micro data processing',
    'R1:2803':
      'Repository: Annual estimates for 2025 are 11-month averages that exclude October. Data for October 2025 were not collected due to the federal government shutdown',
    'T2:85': 'Age coverage - minimum age: 16 years old',
  },
};

/** The recorded catalog with the extras and the recorded UNE_DEAP CSV behind the emulator; extra routes win. */
function wire(options: WireOptions = {}) {
  return wireServices({
    ...options,
    fixture: options.fixture ?? observationCatalogFixture(),
    routes: [...(options.routes ?? []), indicatorDataRoute(fixtureText(INDICATOR_CSV.uneDeap))],
  });
}

function dataRoute(respond: () => Response | Promise<Response>): FetchMockRoute {
  return { method: 'GET', match: (request) => isIndicatorData(request), respond };
}

/** The SDMX structure of UNE_DEAP_SEX_AGE_RT made unreachable. */
const STRUCTURE_DOWN = structureRoute('UNE_DEAP_SEX_AGE_RT', () =>
  Promise.reject(new TypeError('fetch failed')),
);

/** The SDMX host rejecting the unit-probe key this server built for `indicator` (a server bug). */
const probe422 = (indicator: string, key: string) =>
  probeRoute(indicator, key, () => sdmxText(SDMX_422_SHORT_KEY, 422));

function canvasOn(): DataCanvas {
  const canvas = memoryCanvas();
  canvases.push(canvas);
  return canvas;
}

function newContext() {
  return createMockContext({ errors: compareGeographiesTool.errors });
}

async function compare(args: Args, ctx = newContext()) {
  const result = await compareGeographiesTool.handler(
    compareGeographiesTool.input.parse(args),
    ctx,
  );
  return { result, enrichment: getEnrichment(ctx) };
}

async function failure(args: Args): Promise<McpError> {
  try {
    await compareGeographiesTool.handler(compareGeographiesTool.input.parse(args), newContext());
  } catch (error) {
    return error as McpError;
  }
  throw new Error('expected the handler to fail');
}

function render(result: Output): string {
  return (compareGeographiesTool.format?.(result) ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
}

function contentText(result: ContractResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

const dataUrls = (wired: ReturnType<typeof wire>) => callUrls(wired.http, isIndicatorData);

/** The one `/data/indicator` request a call sent, as its query parameters, read as upstream reads them. */
function sentParams(wired: ReturnType<typeof wire>): Record<string, string> {
  const urls = dataUrls(wired);
  expect(urls).toHaveLength(1);
  return Object.fromEntries(urls[0] ? upstreamParams(urls[0]) : []);
}

const areasOf = (result: Output) => result.rows.map((row) => row.ref_area);

describe('latest mode', () => {
  it("keeps a reported value newer than the cutoff, skips projections, and flags what isn't comparable", async () => {
    const wired = wire();
    const { result, enrichment } = await compare({
      dataset_id: UNE,
      ref_areas: ['USA', 'X01', 'KEN', 'JOR', 'ABW'],
    });
    expect(result).toEqual({
      dataset: UNE_META,
      slice: { sex: 'SEX_T', classif1: 'AGE_YTHADULT_YGE15', defaulted: ['sex', 'classif1'] },
      mode: 'latest',
      window_from: 2016,
      include_projections: false,
      rows: [
        { rank: 1, ...KEN_2021 },
        // X01 2025–2027 are projections past the 2024 cutoff, so 2024 is its latest
        { rank: 2, ...X01_2024 },
        // USA 2025 is reported: the cutoff bounds modelled rows only
        { rank: 3, ...USA_2025 },
      ],
      legend: USA_2025_LEGEND,
      missing: [
        { ref_area: 'JOR', label: 'Jordan', reason: 'not_covered' },
        { ref_area: 'ABW', label: 'Aruba', reason: 'no_value_in_window' },
      ],
      comparability: {
        periods: ['2025', '2024', '2021'],
        mixed_periods: true,
        basis_counts: { reported: 2, modelled_estimate: 1, projection: 0 },
        distinct_sources: 3,
      },
      attribution: ATTRIBUTION,
    });
    expect(enrichment).toEqual({
      applied_filters: {
        dataset_id: UNE,
        ref_areas: ['USA', 'X01', 'KEN', 'JOR', 'ABW'],
        ref_area_count: 5,
        sex: 'SEX_T',
        classif1: 'AGE_YTHADULT_YGE15',
        time_from: 2016,
        best_source: 'upstream default (yes)',
      },
      truncated: false,
      shown: 3,
      cap: 40_000,
      notice:
        'Values span 3 periods, 2021 to 2025; pass period for a like-for-like comparison. 1 value is an ILO modelled estimate and 2 are reported; they are not directly comparable. 2 areas have no value; see missing.',
    });
    // timefrom = current year (2026) − lookback (10); the cutoff is never sent as timeto
    expect(sentParams(wired)).toEqual({
      id: UNE,
      ref_area: 'USA+X01+KEN+JOR+ABW',
      sex: 'SEX_T',
      classif1: 'AGE_YTHADULT_YGE15',
      timefrom: '2016',
      type: 'code',
      format: '.csv',
    });
  });

  it('lets a projection be the latest value only with include_projections', async () => {
    wire();
    const { result } = await compare({
      dataset_id: UNE,
      ref_areas: ['X01'],
      include_projections: true,
    });
    expect(result.include_projections).toBe(true);
    expect(result.rows).toEqual([
      { rank: 1, ...X01_2024, value: 4.842, period: '2027', basis: 'projection' },
    ]);
    expect(result.comparability.basis_counts).toEqual({
      reported: 0,
      modelled_estimate: 0,
      projection: 1,
    });
  });

  it('bounds the window by lookback_years: an area whose only recent rows are projections has no value', async () => {
    const wired = wire();
    const { result } = await compare({
      dataset_id: UNE,
      ref_areas: ['USA', 'KEN', 'X01'],
      lookback_years: 1,
    });
    expect(sentParams(wired).timefrom).toBe('2025');
    expect(areasOf(result)).toEqual(['USA']);
    expect(result.missing).toEqual([
      { ref_area: 'KEN', label: 'Kenya', reason: 'no_value_in_window' },
      { ref_area: 'X01', label: 'World', reason: 'no_value_in_window' },
    ]);
    expect(result.window_from).toBe(2025);
  });

  it('keeps the lookback_years bound when change_years widens timefrom: older rows are change bases only', async () => {
    const wired = wire();
    const { result } = await compare({
      dataset_id: UNE,
      ref_areas: ['USA', 'KEN', 'X01'],
      lookback_years: 1,
      change_years: 1,
    });
    // timefrom reaches back one more year for the change base; a latest value still needs 2025+
    expect(sentParams(wired).timefrom).toBe('2024');
    expect(result.window_from).toBe(2024);
    expect(result.rows).toEqual([
      { rank: 1, ...USA_2025, change: { from_period: '2024', from_value: 4.022, delta: 0.26 } },
    ]);
    // X01's 2024 modelled value is inside timefrom but outside lookback_years
    expect(result.missing).toEqual([
      { ref_area: 'KEN', label: 'Kenya', reason: 'no_value_in_window' },
      { ref_area: 'X01', label: 'World', reason: 'no_value_in_window' },
    ]);
    const text = render(result);
    expect(text).toContain(
      '| 1 | USA — United States of America (country) | 4.282 | 2025 | reported |',
    );
    expect(text).not.toContain('X01 — World (aggregate)');
    expect(text).toContain('- X01 — World: no_value_in_window');
  });

  it('adds change over change_years from the same period earlier, delta rounded, widening timefrom', async () => {
    const wired = wire();
    const { result } = await compare({
      dataset_id: UNE,
      ref_areas: ['USA', 'X01', 'KEN'],
      change_years: 1,
    });
    expect(sentParams(wired).timefrom).toBe('2015');
    expect(result.window_from).toBe(2015);
    expect(result.change_years).toBe(1);
    const byArea = Object.fromEntries(result.rows.map((row) => [row.ref_area, row.change]));
    expect(byArea).toEqual({
      // 4.282 − 4.022 and 4.883 − 4.896 carry binary noise before rounding
      USA: { from_period: '2024', from_value: 4.022, delta: 0.26 },
      X01: { from_period: '2023', from_value: 4.896, delta: -0.013 },
      // KEN has no 2020 value, so no change
      KEN: undefined,
    });
  });

  it('compares an explicit slice, with nothing defaulted', async () => {
    const wired = wire();
    const { result } = await compare({
      dataset_id: UNE,
      ref_areas: ['USA'],
      sex: 'f',
      classif1: 'age_ythadult_y15-24',
    });
    expect(result.slice).toEqual({
      sex: 'SEX_F',
      classif1: 'AGE_YTHADULT_Y15-24',
      defaulted: [],
    });
    expect(sentParams(wired)).toMatchObject({ sex: 'SEX_F', classif1: 'AGE_YTHADULT_Y15-24' });
    expect(result.rows).toEqual([
      {
        ...USA_2025,
        rank: 1,
        value: 9.002,
        notes: ['C6:1058', 'I11:264', 'R1:3513', 'R1:2803', 'T2:85'],
      },
    ]);
    expect(result.legend.notes['C6:1058']).toBe('Nonstandard age group: Excluding age 15');
  });

  it('expands an area group to its members, leaving the group aggregate out unless listed', async () => {
    const wired = wire();
    const { result, enrichment } = await compare({ dataset_id: UNE, area_group: 'X06' });
    expect(sentParams(wired).ref_area).toBe('KEN');
    expect(areasOf(result)).toEqual(['KEN']);
    expect(enrichment.applied_filters).toMatchObject({
      area_group: { code: 'X06', label: 'Africa', member_count: 1 },
      ref_area_count: 1,
    });
    expect(enrichment.applied_filters).not.toHaveProperty('ref_areas');
    disposeIlostatServices();

    const listed = wire();
    const withAggregate = await compare({
      dataset_id: UNE,
      area_group: 'ILO_GEO_X06',
      ref_areas: ['X06'],
    });
    expect(sentParams(listed).ref_area).toBe('X06+KEN');
    expect(withAggregate.result.missing).toEqual([
      { ref_area: 'X06', label: 'Africa', reason: 'no_value_in_window' },
    ]);
  });

  it('expands area_group X01 to every country, the World aggregate left out, on both surfaces', async () => {
    const wired = wire();
    const result = await runToolContract(compareGeographiesTool, {
      dataset_id: UNE,
      area_group: 'x01',
    });
    expect(result.isError).toBeFalsy();
    expect(sentParams(wired).ref_area).toBe('ABW+JOR+KEN+USA');
    const structured = result.structuredContent as Output & Record<string, unknown>;
    expect(structured.applied_filters).toMatchObject({
      area_group: { code: 'X01', label: 'World', member_count: 4 },
      ref_area_count: 4,
    });
    expect(structured.rows.map((row) => row.ref_area).sort()).toEqual(['KEN', 'USA']);
    expect(structured.missing.map((entry) => entry.ref_area).sort()).toEqual(['ABW', 'JOR']);
    expect(contentText(result)).toContain(
      `**Applied filters:** dataset ${UNE} · area_group X01 (World, 4 countries) · 4 areas`,
    );
  });

  it('reads blank form-client values as unset and applies the defaults', async () => {
    const wired = wire();
    const { result } = await compare({
      dataset_id: ' une_deap_sex_age_rt_a ',
      ref_areas: ['', ' usa '],
      area_group: '  ',
      sex: '',
      classif1: '',
      classif2: ' ',
      period: '',
      change_years: '',
      sort: '',
    });
    expect(result).toMatchObject({
      mode: 'latest',
      window_from: 2016,
      include_projections: false,
      slice: { sex: 'SEX_T', classif1: 'AGE_YTHADULT_YGE15', defaulted: ['sex', 'classif1'] },
    });
    expect(result).not.toHaveProperty('change_years');
    expect(Object.keys(sentParams(wired)).sort()).toEqual(
      ['classif1', 'format', 'id', 'ref_area', 'sex', 'timefrom', 'type'].sort(),
    );
  });
});

describe('period mode', () => {
  it('sends the period and its change base in one time value, with no timefrom', async () => {
    const wired = wire();
    const { result, enrichment } = await compare({
      dataset_id: UNE,
      ref_areas: ['USA', 'X01', 'KEN'],
      period: 2025,
      change_years: 2,
    });
    const sent = sentParams(wired);
    expect(sent.time).toBe('2025+2023');
    expect(sent).not.toHaveProperty('timefrom');
    expect(sent).not.toHaveProperty('timeto');
    expect(result).toMatchObject({ mode: 'period', period: '2025', change_years: 2 });
    expect(result).not.toHaveProperty('window_from');
    expect(result.rows).toEqual([
      // period mode takes the value at the period, a projection included
      {
        rank: 1,
        ...X01_2024,
        value: 4.869,
        period: '2025',
        basis: 'projection',
        change: { from_period: '2023', from_value: 4.896, delta: -0.027 },
      },
      {
        rank: 2,
        ...USA_2025,
        change: { from_period: '2023', from_value: 3.638, delta: 0.644 },
      },
    ]);
    expect(result.missing).toEqual([
      { ref_area: 'KEN', label: 'Kenya', reason: 'no_value_for_period' },
    ]);
    expect(result.comparability).toMatchObject({ periods: ['2025'], mixed_periods: false });
    expect(enrichment.applied_filters).toMatchObject({ time: ['2025', '2023'] });
    expect(enrichment.applied_filters).not.toHaveProperty('time_from');
    expect(enrichment.notice).toBe(
      '1 value is an ILO modelled estimate and 1 is reported; they are not directly comparable. 1 area has no value; see missing.',
    );
  });

  it('joins the two periods and the areas with a literal + on the wire, change on both surfaces', async () => {
    const wired = wire();
    const result = await runToolContract(compareGeographiesTool, {
      dataset_id: UNE,
      ref_areas: ['USA', 'X01'],
      period: 2025,
      change_years: 2,
    });
    expect(result.isError).toBeFalsy();
    const search = dataUrls(wired)[0]?.search ?? '';
    expect(search).toMatch(/[?&]time=2025\+2023(&|$)/);
    expect(search).toMatch(/[?&]ref_area=USA\+X01&/);
    const structured = result.structuredContent as Output & Record<string, unknown>;
    expect(structured.rows.map((row) => [row.ref_area, row.change])).toEqual([
      ['X01', { from_period: '2023', from_value: 4.896, delta: -0.027 }],
      ['USA', { from_period: '2023', from_value: 3.638, delta: 0.644 }],
    ]);
    const text = contentText(result);
    for (const fragment of ['4.896', '3.638', '0.644']) expect(text).toContain(fragment);
  });

  it('normalizes a period and fails invalid_period on a frequency mismatch', async () => {
    const wired = wire();
    const error = await failure({ dataset_id: UNE, ref_areas: ['USA'], period: '2024-q2' });
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_period',
      period: '2024Q2',
      frequency: 'A',
      recovery: {
        hint: "Use YYYY, YYYYQn, or YYYYMmm matching the dataset frequency for period, or omit it to compare each area's latest value.",
      },
    });
    expect(error.message).toBe(`period 2024Q2 does not match ${UNE}, whose frequency is A.`);
    expect(dataUrls(wired)).toHaveLength(0);
  });
});

describe('ranking and order', () => {
  it.each([
    ['value_desc', ['KEN', 'USA', 'X01']],
    ['value_asc', ['X01', 'KEN', 'USA']],
    ['ref_area', ['KEN', 'USA', 'X01']],
  ] as const)(
    'sort %s orders rows; rank stays by value with ties sharing it',
    async (sort, order) => {
      wire({ routes: [indicatorDataRoute(TIES_CSV)] });
      const { result } = await compare({ dataset_id: UNE, ref_areas: ['USA', 'KEN', 'X01'], sort });
      expect(areasOf(result)).toEqual(order);
      expect(Object.fromEntries(result.rows.map((row) => [row.ref_area, row.rank]))).toEqual({
        KEN: 1,
        USA: 1,
        X01: 3,
      });
    },
  );
});

describe('slice', () => {
  it('fails invalid_slice for a breakdown the dataset lacks, with the contract recovery', async () => {
    const wired = wire();
    const error = await failure({
      dataset_id: 'SDG_0552_NOC_RT_A',
      ref_areas: ['KEN'],
      sex: 'T',
      classif1: 'AGE_YTHADULT_YGE15',
    });
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_slice',
      datasetId: 'SDG_0552_NOC_RT_A',
      fields: ['sex', 'classif1'],
      recovery: { hint: INVALID_SLICE_RECOVERY },
    });
    expect(error.message).toBe(
      'SDG_0552_NOC_RT_A has no sex or classif1 breakdown, so sex and classif1 cannot be set.',
    );
    expect(dataUrls(wired)).toHaveLength(0);
  });

  it('fails invalid_slice for a classif2 code on a dataset with one breakdown', async () => {
    wire();
    const error = await failure({
      dataset_id: UNE,
      ref_areas: ['USA'],
      classif2: 'DSB_STATUS_TOTAL',
    });
    expect(error.data).toMatchObject({ reason: 'invalid_slice', fields: ['classif2'] });
  });

  it('fails invalid_slice when a breakdown has no total and no code was given (deciles)', async () => {
    const wired = wire();
    const error = await failure({ dataset_id: 'LAP_2LID_QTL_RT_A', ref_areas: ['KEN'] });
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_slice',
      datasetId: 'LAP_2LID_QTL_RT_A',
      field: 'classif1',
      recovery: { hint: INVALID_SLICE_RECOVERY },
    });
    expect(error.message).toBe(
      'The classif1 breakdown of LAP_2LID_QTL_RT_A has no total code, so a classif1 code must be given.',
    );
    expect(dataUrls(wired)).toHaveLength(0);
  });

  it('fails structure_unavailable, an upstream fault, when a defaulted breakdown needs the unreachable structure', async () => {
    const wired = wire({ routes: [STRUCTURE_DOWN] });
    const args = { dataset_id: UNE, ref_areas: ['USA'] };
    const message = `The total codes of ${UNE} could not be read from the ILOSTAT structure service, so classif1 has no default.`;
    const error = await failure(args);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'structure_unavailable',
      datasetId: UNE,
      fields: ['classif1'],
      recovery: { hint: STRUCTURE_UNAVAILABLE_RECOVERY },
    });
    expect(error.message).toBe(message);
    expect(dataUrls(wired)).toHaveLength(0);

    const result = await runToolContract(compareGeographiesTool, args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'structure_unavailable', fields: ['classif1'] },
      },
    });
    const text = contentText(result);
    expect(text).toContain(message);
    expect(text).toContain(`Recovery: ${STRUCTURE_UNAVAILABLE_RECOVERY}`);
    expect(text).toContain('reason structure_unavailable');
  });

  it('structure_unavailable names every breakdown left without a default', async () => {
    wire({
      routes: [
        structureRoute('EMP_TEMP_SEX_INS_DSB_NB', () =>
          Promise.reject(new TypeError('fetch failed')),
        ),
      ],
    });
    const error = await failure({ dataset_id: 'EMP_TEMP_SEX_INS_DSB_NB_A', ref_areas: ['USA'] });
    expect(error.data).toMatchObject({
      reason: 'structure_unavailable',
      fields: ['classif1', 'classif2'],
    });
    expect(error.message).toBe(
      'The total codes of EMP_TEMP_SEX_INS_DSB_NB_A could not be read from the ILOSTAT structure service, so classif1 and classif2 have no default.',
    );
  });

  it('compares an explicit slice without the structure service, and says the unit and area coverage are unknown', async () => {
    wire({ routes: [STRUCTURE_DOWN] });
    const args = { dataset_id: UNE, ref_areas: ['USA', 'JOR'], classif1: 'AGE_YTHADULT_YGE15' };
    const { result, enrichment } = await compare(args);
    expect(result.dataset).not.toHaveProperty('unit');
    expect(result.slice).toEqual({
      sex: 'SEX_T',
      classif1: 'AGE_YTHADULT_YGE15',
      defaulted: ['sex'],
    });
    expect(areasOf(result)).toEqual(['USA']);
    // JOR's absence from the dataset cannot be read without the structure
    expect(result.missing).toEqual([
      { ref_area: 'JOR', label: 'Jordan', reason: 'no_value_in_window' },
    ]);
    const notice = `1 area has no value; see missing. ${UNE_COVERAGE_NOTICE} ${UNE_UNIT_NOTICE}`;
    expect(enrichment.notice).toBe(notice);
    expect(render(result)).toContain('Unit: not resolved');

    const contract = await runToolContract(compareGeographiesTool, args);
    expect(contract.isError).toBeFalsy();
    expect(contract.structuredContent).toMatchObject({ notice });
    expect(contentText(contract)).toContain(notice);
  });

  it('says only the unit is unknown when the unit probe fails but the area list was read', async () => {
    wire({
      routes: [
        probeRoute('UNE_DEAP_SEX_AGE_RT', 'ABW....', () =>
          Promise.reject(new TypeError('fetch failed')),
        ),
      ],
    });
    const args = { dataset_id: UNE, ref_areas: ['USA', 'JOR'] };
    const { result, enrichment } = await compare(args);
    expect(result.dataset).not.toHaveProperty('unit');
    expect(result.missing).toEqual([{ ref_area: 'JOR', label: 'Jordan', reason: 'not_covered' }]);
    const notice = `1 area has no value; see missing. ${UNE_UNIT_NOTICE}`;
    expect(enrichment.notice).toBe(notice);

    const contract = await runToolContract(compareGeographiesTool, args);
    expect(contract.structuredContent).toMatchObject({ notice });
    expect(contentText(contract)).toContain(notice);
  });
});

describe('routing', () => {
  it('stages a comparison larger than the preview; ranks, missing, and comparability cover every area', async () => {
    const canvas = canvasOn();
    wire({ canvas, observations: { previewChars: 600 } });
    const ctx = newContext();
    const { result, enrichment } = await compare(
      { dataset_id: UNE, ref_areas: ['USA', 'X01', 'KEN', 'JOR'], change_years: 1 },
      ctx,
    );
    const name = result.dataframe?.name ?? '';
    expect(name).toMatch(/^df_[A-Z0-9]{5}_[A-Z0-9]{5}$/);
    expect(result.dataframe).toEqual({
      name,
      row_count: 3,
      expires_at: '2026-09-27T12:00:00.000Z',
    });
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.length).toBeLessThan(3);
    expect(result.missing).toHaveLength(1);
    expect(result.comparability.basis_counts).toEqual({
      reported: 2,
      modelled_estimate: 1,
      projection: 0,
    });
    // The inline rows stop before the last area, so truncated is true; the dataframe holds the rest
    expect(enrichment).toMatchObject({ truncated: true, shown: result.rows.length, cap: 600 });
    expect(enrichment.notice).toContain(
      `Showing ${result.rows.length} of 3 areas inline; ranks, missing, and comparability cover every area. Full result staged as ${name} (3 rows) — use ilostat_dataframe_describe to inspect its columns, then ilostat_dataframe_query to analyze it with SQL.`,
    );

    const canvasId = await ctx.state.get<string>('canvas-id');
    const instance = await canvas.acquire(canvasId ?? undefined, ctx);
    const staged = await instance.query(
      `SELECT ref_area, rank, value, basis, source_label, change_from_period, change_delta FROM ${name} ORDER BY rank`,
    );
    expect(staged.rows).toEqual([
      {
        ref_area: 'KEN',
        rank: 1,
        value: 5.585,
        basis: 'reported',
        source_label: 'HS - Continuous household survey',
        change_from_period: null,
        change_delta: null,
      },
      {
        ref_area: 'X01',
        rank: 2,
        value: 4.883,
        basis: 'modelled_estimate',
        source_label: 'ILO - Modelled Estimates',
        change_from_period: '2023',
        change_delta: -0.013,
      },
      {
        ref_area: 'USA',
        rank: 3,
        value: 4.282,
        basis: 'reported',
        source_label: 'LFS - Current Population Survey',
        change_from_period: '2024',
        change_delta: 0.26,
      },
    ]);
  });

  it('with dataframes off, cuts the inline rows at the preview and says so', async () => {
    wire({ observations: { previewChars: 600 } });
    const { result, enrichment } = await compare({
      dataset_id: UNE,
      ref_areas: ['USA', 'X01', 'KEN'],
    });
    const shown = result.rows.length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(3);
    expect(result).not.toHaveProperty('dataframe');
    expect(result.comparability.basis_counts).toEqual({
      reported: 2,
      modelled_estimate: 1,
      projection: 0,
    });
    expect(enrichment).toMatchObject({ truncated: true, shown, cap: 600 });
    expect(enrichment.notice).toContain(
      `Showing ${shown} of 3 areas inline: dataframes are off in this deployment. Ranks, missing, and comparability cover every area; narrow ref_areas or area_group to see the rest.`,
    );
  });

  it('serves a repeat comparison from the response cache', async () => {
    const wired = wire();
    const args = { dataset_id: UNE, ref_areas: ['USA', 'KEN'] };
    const first = await compare(args);
    const second = await compare(args);
    expect(second.result).toEqual(first.result);
    expect(dataUrls(wired)).toHaveLength(1);
  });
});

describe('errors', () => {
  it('logs the reasons a caller’s input causes at notice, a retired dataset at warning, outages at error', () => {
    const severities = Object.fromEntries(
      (compareGeographiesTool.errors ?? []).map((entry: { reason: string; severity?: string }) => [
        entry.reason,
        entry.severity ?? 'error',
      ]),
    );
    expect(severities).toEqual({
      unknown_dataset: 'notice',
      unknown_code: 'notice',
      unknown_area_group: 'notice',
      areas_required: 'notice',
      aggregates_unavailable: 'notice',
      invalid_slice: 'notice',
      invalid_period: 'notice',
      dataset_retired: 'warning',
      structure_unavailable: 'error',
      upstream_busy: 'error',
      catalog_unavailable: 'error',
    });
  });

  it('unknown_dataset: a well-formed ID the catalog lacks', async () => {
    const wired = wire();
    const error = await failure({ dataset_id: 'NOPE_A', ref_areas: ['USA'] });
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({
      reason: 'unknown_dataset',
      datasetIds: ['NOPE_A'],
      recovery: {
        hint: 'Call ilostat_search_indicators to find a dataset ID — an indicator code plus _A, _Q, or _M, such as UNE_DEAP_SEX_AGE_RT_A.',
      },
    });
    expect(dataUrls(wired)).toHaveLength(0);
  });

  it('unknown_code: names the rejected area and breakdown codes', async () => {
    const wired = wire();
    const error = await failure({
      dataset_id: UNE,
      ref_areas: ['ZZZ', 'USA'],
      classif1: 'nope',
    });
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'unknown_code',
      rejected: { ref_areas: ['ZZZ'], classif1: ['NOPE'] },
      recovery: {
        hint: 'Call ilostat_list_reference with topic ref_areas for ref_areas, topic classifications for classif1 to find valid codes.',
      },
    });
    expect(dataUrls(wired)).toHaveLength(0);
  });

  it('unknown_area_group: a well-formed X code that is no group', async () => {
    wire();
    const error = await failure({ dataset_id: UNE, area_group: 'X99' });
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'unknown_area_group',
      recovery: {
        hint: 'Call ilostat_list_reference with topic area_groups to see the group codes area_group accepts.',
      },
    });
  });

  it.each([
    ['no areas', {}],
    ['only blank areas', { ref_areas: ['', ' '], area_group: '' }],
  ])('areas_required: %s', async (_label, areas) => {
    const wired = wire();
    const error = await failure({ dataset_id: UNE, ...areas });
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'areas_required',
      recovery: {
        hint: 'Pass ref_areas (ISO3 or X codes) or an area_group such as X06 for every African country; ilostat_list_reference topic area_groups lists the groups.',
      },
    });
    expect(error.message).toBe('Name the areas to compare.');
    expect(wired.http.calls.some((call) => isIndicatorData(call.request))).toBe(false);
  });

  it('aggregates_unavailable: an aggregate from a dataset without aggregate rows', async () => {
    const wired = wire();
    const error = await failure({ dataset_id: 'UNE_DEAP_SEX_AGE_RT_Q', ref_areas: ['X01'] });
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'aggregates_unavailable',
      datasetIds: ['UNE_DEAP_SEX_AGE_RT_Q'],
      aggregates: ['X01'],
      recovery: {
        hint: 'Request countries only, or use a dataset whose ilostat_describe_indicator output shows has_aggregates true, such as the ILO modelled estimates in database ILOEST.',
      },
    });
    expect(dataUrls(wired)).toHaveLength(0);
  });

  it('dataset_retired: the upstream 400 for a withdrawn catalog ID, with this tool’s recovery', async () => {
    wire({ routes: [dataRoute(() => retiredDatasetResponse())] });
    const error = await failure({ dataset_id: UNE, ref_areas: ['USA'] });
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({
      reason: 'dataset_retired',
      recovery: {
        hint: 'The dataset was withdrawn upstream after the last catalog refresh; call ilostat_search_indicators for its current equivalent.',
      },
    });
  });

  it('upstream_busy: a 429 from the data endpoint', async () => {
    wire({ routes: [dataRoute(() => tooManyRequests('45'))] });
    const error = await failure({ dataset_id: UNE, ref_areas: ['USA'] });
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({
      reason: 'upstream_busy',
      retryable: true,
      retryAfter: 45,
      recovery: { hint: UPSTREAM_BUSY_RECOVERY },
    });
  });

  it('catalog_unavailable: the catalog could not be loaded', async () => {
    wire({
      routes: [
        {
          match: (request) => isRplumber(request, '/metadata/toc/ref_area'),
          respond: () => new Response('unavailable', { status: 503 }),
        },
      ],
    });
    const error = await failure({ dataset_id: UNE, ref_areas: ['USA'] });
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'catalog_unavailable',
      retryable: true,
      recovery: { hint: CATALOG_UNAVAILABLE_RECOVERY },
    });
  });

  it('areas_required is answered during a catalog outage, not catalog_unavailable', async () => {
    wire({
      routes: [
        {
          match: (request) => isRplumber(request, '/metadata/toc/ref_area'),
          respond: () => new Response('unavailable', { status: 503 }),
        },
      ],
    });
    const error = await failure({ dataset_id: UNE });
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({ reason: 'areas_required' });
  });

  it.each([
    ['a defaulted slice', {}],
    ['an explicit slice', { classif1: 'AGE_YTHADULT_YGE15' }],
  ])(
    "InternalError: a unit-probe key the SDMX host rejects (422) is this server's bug, under %s",
    async (_label, slice) => {
      const wired = wire({ routes: [probe422('UNE_DEAP_SEX_AGE_RT', 'ABW....')] });
      const args = { dataset_id: UNE, ref_areas: ['USA'], ...slice };
      const error = await failure(args);
      expect(error.code).toBe(JsonRpcErrorCode.InternalError);
      expect(error.message).toBe(
        'ILOSTAT SDMX API (sdmx.ilo.org) rejected the series key built for UNE_DEAP_SEX_AGE_RT (HTTP 422).',
      );
      expect(dataUrls(wired)).toHaveLength(0);

      const result = await runToolContract(compareGeographiesTool, args);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InternalError },
      });
      expect(contentText(result)).toContain('rejected the series key');
    },
  );

  it('invalid_slice for a breakdown the dataset lacks wins over a structure lookup that would fail', async () => {
    wire({ routes: [probe422('SDG_0552_NOC_RT', 'KEN..')] });
    const error = await failure({ dataset_id: 'SDG_0552_NOC_RT_A', ref_areas: ['KEN'], sex: 'T' });
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({ reason: 'invalid_slice', fields: ['sex'] });
  });

  it.each([
    ['a dataset ID with a space', { dataset_id: 'UNE DEAP', ref_areas: ['USA'] }],
    ['a joined dataset ID', { dataset_id: `${UNE}+UNE_DEAP_SEX_AGE_RT_Q`, ref_areas: ['USA'] }],
    ['a malformed area code', { dataset_id: UNE, ref_areas: ['U\nS'] }],
    ['a malformed area group', { dataset_id: UNE, area_group: 'AFRICA' }],
    ['an unknown sex alias', { dataset_id: UNE, ref_areas: ['USA'], sex: 'X' }],
    ['a malformed period', { dataset_id: UNE, ref_areas: ['USA'], period: '2024-13' }],
    ['lookback_years 0', { dataset_id: UNE, ref_areas: ['USA'], lookback_years: 0 }],
    ['change_years 31', { dataset_id: UNE, ref_areas: ['USA'], change_years: 31 }],
    ['an unknown sort', { dataset_id: UNE, ref_areas: ['USA'], sort: 'rank' }],
  ])('invalid_arguments: %s fails the schema before any request', async (_label, args) => {
    const wired = wire();
    const result = await runToolContract(compareGeographiesTool, args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(wired.http.calls).toHaveLength(0);
  });
});

describe('format()', () => {
  it('renders the header, the comparison table, legend, missing, comparability, and attribution', async () => {
    wire();
    const { result } = await compare({
      dataset_id: UNE,
      ref_areas: ['USA', 'X01', 'KEN', 'JOR', 'ABW'],
    });
    const lines = render(result).split('\n');
    for (const line of [
      `## ${UNE} — Unemployment rate by sex and age (%)`,
      'Unit: Percentage (PT) · type Rate (RT) · multiplier 0 (Units)',
      'Slice: sex SEX_T · classif1 AGE_YTHADULT_YGE15 (defaulted: sex, classif1)',
      'Mode: latest · from 2016 · include_projections: false',
      '| rank | area | value | period | basis | status | source | notes | change |',
      '| 1 | KEN — Kenya (country) | 5.585 | 2021 | reported |  | BX:3465 — HS - Continuous household survey | R1:3513 |  |',
      '| 2 | X01 — World (aggregate) | 4.883 | 2024 | modelled_estimate |  | XA:8405 — ILO - Modelled Estimates |  |  |',
      '| 3 | USA — United States of America (country) | 4.282 | 2025 | reported | B | BA:453 — LFS - Current Population Survey | I11:264, R1:3513, R1:2803, T2:85 |  |',
      '**Status flags:**',
      '- B — Break in series',
      '**Notes:**',
      '- T2:85 — Age coverage - minimum age: 16 years old',
      '**Missing:**',
      '- JOR — Jordan: not_covered',
      '- ABW — Aruba: no_value_in_window',
      '**Comparability:** periods 2025, 2024, 2021 · mixed_periods: true · reported 2 · modelled_estimate 1 · projection 0 · 3 distinct sources',
      ATTRIBUTION,
    ]) {
      expect(lines).toContain(line);
    }
  });

  it('renders the period-mode line and the change cell', async () => {
    wire();
    const { result } = await compare({
      dataset_id: UNE,
      ref_areas: ['USA'],
      period: '2025',
      change_years: 2,
    });
    const lines = render(result).split('\n');
    expect(lines).toContain(
      'Mode: period · period 2025 · change over 2 years · include_projections: false',
    );
    expect(lines).toContain(
      '| 1 | USA — United States of America (country) | 4.282 | 2025 | reported | B | BA:453 — LFS - Current Population Survey | I11:264, R1:3513, R1:2803, T2:85 | 0.644 since 2023 (3.638) |',
    );
  });

  it('escapes pipes and flattens line breaks in upstream labels inside table cells', async () => {
    const fixture = observationCatalogFixture();
    const source = fixture.dictionaries.source?.find((row) => row.source === 'BA:453');
    if (source) source['source.label'] = 'LFS | Current\nPopulation Survey';
    wire({ fixture });
    const { result } = await compare({ dataset_id: UNE, ref_areas: ['USA'] });
    expect(result.rows[0]?.source_label).toBe('LFS | Current\nPopulation Survey');
    expect(render(result)).toContain('| BA:453 — LFS \\| Current Population Survey |');
  });
});

describe('format() with hostile upstream codes', () => {
  it('flattens line breaks and escapes pipes in upstream codes, verbatim in structuredContent', async () => {
    const csv = [
      `${CSV_HEADER},"note_source"`,
      '"USA","BA:453","UNE_DEAP_SEX_AGE_RT","SEX_T","AGE_YTHADULT_YGE15","2024\n## p|q",5,"B\n## s|t","R1:3513\n## n|m"',
      '"USA","BA:453","UNE_DEAP_SEX_AGE_RT","SEX_T","AGE_YTHADULT_YGE15","2023\n## p|q",4,,',
      '',
    ].join('\n');
    wire({ routes: [dataRoute(() => csvResponse(csv))] });
    const result = await runToolContract(compareGeographiesTool, {
      dataset_id: UNE,
      ref_areas: ['USA'],
      change_years: 1,
    });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as Output).rows[0]).toMatchObject({
      period: '2024\n## p|q',
      obs_status: 'B\n## s|t',
      notes: ['R1:3513\n## n|m'],
      change: { from_period: '2023\n## p|q', from_value: 4, delta: 1 },
    });
    const lines = contentText(result).split('\n');
    expect(lines).toContain(
      '| 1 | USA — United States of America (country) | 5 | 2024 ## p\\|q | reported | B ## s\\|t | BA:453 — LFS - Current Population Survey | R1:3513 ## n\\|m | 1 since 2023 ## p\\|q (4) |',
    );
    expect(lines.some((line) => line.startsWith('**Comparability:** periods 2024 ## p|q ·'))).toBe(
      true,
    );
    expect(lines.filter((line) => /^## [a-z]\|/.test(line))).toEqual([]);
  });

  it('renders status and note codes named like Object.prototype members as codes, verbatim in structuredContent', async () => {
    const csv = [
      `${CSV_HEADER},"note_source"`,
      '"USA","BA:453","UNE_DEAP_SEX_AGE_RT","SEX_T","AGE_YTHADULT_YGE15","2024",5,"__proto__",',
      '"KEN","BA:7008","UNE_DEAP_SEX_AGE_RT","SEX_T","AGE_YTHADULT_YGE15","2024",4,"constructor","toString"',
      '',
    ].join('\n');
    wire({ routes: [dataRoute(() => csvResponse(csv))] });
    const result = await runToolContract(compareGeographiesTool, {
      dataset_id: UNE,
      ref_areas: ['USA', 'KEN'],
    });
    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as Output;
    expect(output.rows.map((row) => [row.ref_area, row.obs_status, row.notes])).toEqual([
      ['USA', '__proto__', []],
      ['KEN', 'constructor', ['toString']],
    ]);
    // The output schema's record parse drops a __proto__ key, so that code has no label.
    expect(Object.keys(output.legend.obs_status)).toEqual(['constructor']);
    expect(Object.keys(output.legend.notes)).toEqual(['toString']);
    const text = contentText(result);
    expect(text).not.toMatch(/function|\[object Object\]/);
    const lines = text.split('\n');
    expect(lines.filter((line) => line.startsWith('| 1 | USA'))[0]).toContain(' | __proto__ | ');
    expect(lines.filter((line) => line.startsWith('| 2 | KEN'))[0]).toContain(
      ' | constructor | BA:7008',
    );
    expect(lines).toContain('- constructor — Not in the ILOSTAT dictionary');
    expect(lines).toContain('- toString — Not in the ILOSTAT dictionary');
  });
});

describe('contract envelope (runToolContract)', () => {
  it('a full page validates and carries the same data on both surfaces', async () => {
    wire();
    const result = await runToolContract(compareGeographiesTool, {
      dataset_id: UNE,
      ref_areas: ['USA', 'X01', 'KEN', 'JOR'],
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Output & Record<string, unknown>;
    expect(structured).toMatchObject({ truncated: false, shown: 3, cap: 40_000 });
    const text = contentText(result);
    for (const row of structured.rows) {
      expect(text).toContain(
        `| ${row.rank} | ${row.ref_area} — ${row.label} (${row.kind}) | ${row.value} | ${row.period} | ${row.basis} |`,
      );
    }
    for (const fragment of [
      '- JOR — Jordan: not_covered',
      '**Applied filters:** dataset UNE_DEAP_SEX_AGE_RT_A · ref_areas USA, X01, KEN, JOR · 4 areas · sex SEX_T · classif1 AGE_YTHADULT_YGE15 · time_from 2016 · best_source upstream default (yes)',
      'Values span 3 periods, 2021 to 2025; pass period for a like-for-like comparison.',
      ATTRIBUTION,
    ]) {
      expect(text).toContain(fragment);
    }
  });

  it('an all-missing page validates with empty rows and the missing list on both surfaces', async () => {
    wire();
    const result = await runToolContract(compareGeographiesTool, {
      dataset_id: UNE,
      ref_areas: ['JOR', 'ABW'],
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      rows: [],
      legend: { obs_status: {}, notes: {} },
      missing: [
        { ref_area: 'JOR', reason: 'not_covered' },
        { ref_area: 'ABW', reason: 'no_value_in_window' },
      ],
      comparability: {
        periods: [],
        mixed_periods: false,
        basis_counts: { reported: 0, modelled_estimate: 0, projection: 0 },
        distinct_sources: 0,
      },
      truncated: false,
      shown: 0,
      notice: '2 areas have no value; see missing.',
    });
    const text = contentText(result);
    expect(text).toContain('**Comparability:** periods none · mixed_periods: false');
    expect(text).toContain('- ABW — Aruba: no_value_in_window');
    expect(text).toContain('2 areas have no value; see missing.');
  });

  it('counts one modelled and one reported value in the singular on both surfaces', async () => {
    wire();
    const result = await runToolContract(compareGeographiesTool, {
      dataset_id: UNE,
      ref_areas: ['USA', 'X01', 'KEN'],
      period: 2025,
      change_years: 2,
    });
    const notice =
      '1 value is an ILO modelled estimate and 1 is reported; they are not directly comparable. 1 area has no value; see missing.';
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ notice });
    expect(contentText(result)).toContain(notice);
  });

  it('says 1 area, change over 1 year, and 1 distinct source in the singular on both surfaces', async () => {
    wire();
    const result = await runToolContract(compareGeographiesTool, {
      dataset_id: UNE,
      ref_areas: ['USA'],
      period: 2025,
      change_years: 1,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      change_years: 1,
      comparability: { distinct_sources: 1 },
      applied_filters: { ref_area_count: 1 },
    });
    const lines = contentText(result).split('\n');
    expect(lines).toContain(
      'Mode: period · period 2025 · change over 1 year · include_projections: false',
    );
    expect(lines).toContain(
      '**Comparability:** periods 2025 · mixed_periods: false · reported 1 · modelled_estimate 0 · projection 0 · 1 distinct source',
    );
    expect(lines.find((line) => line.startsWith('**Applied filters:**'))).toContain(
      ' · ref_areas USA · 1 area · ',
    );
  });

  it('a partial page validates as truncated, the disclosure on both surfaces', async () => {
    wire({ observations: { previewChars: 600 } });
    const result = await runToolContract(compareGeographiesTool, {
      dataset_id: UNE,
      ref_areas: ['USA', 'X01', 'KEN'],
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Output & { shown: number };
    expect(structured).toMatchObject({ truncated: true, cap: 600 });
    expect(structured.rows).toHaveLength(structured.shown);
    expect(contentText(result)).toContain(
      `Showing ${structured.shown} of 3 areas inline: dataframes are off in this deployment.`,
    );
  });

  it('a staged page validates as truncated and names the dataframe on both surfaces', async () => {
    const canvas = canvasOn();
    wire({ canvas, observations: { previewChars: 600 } });
    const result = await runToolContract(compareGeographiesTool, {
      dataset_id: UNE,
      ref_areas: ['USA', 'X01', 'KEN'],
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Output & { notice: string; shown: number };
    const name = structured.dataframe?.name ?? '';
    expect(name).toMatch(/^df_/);
    expect(structured).toMatchObject({ truncated: true, cap: 600 });
    expect(structured.rows).toHaveLength(structured.shown);
    expect(structured.shown).toBeLessThan(3);
    const disclosure = `Showing ${structured.shown} of 3 areas inline; ranks, missing, and comparability cover every area. Full result staged as ${name} (3 rows)`;
    expect(structured.notice).toContain(disclosure);
    const text = contentText(result);
    expect(text).toContain(disclosure);
    expect(text).toContain(`**Dataframe:** ${name} (3 rows, expires 2026-09-27T12:00:00.000Z)`);
  });

  it('a declared failure reaches both surfaces with its reason and recovery', async () => {
    wire();
    const result = await runToolContract(compareGeographiesTool, { dataset_id: UNE });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'areas_required' } },
    });
    const text = contentText(result);
    expect(text).toContain('Name the areas to compare.');
    expect(text).toContain(
      'Recovery: Pass ref_areas (ISO3 or X codes) or an area_group such as X06 for every African country; ilostat_list_reference topic area_groups lists the groups.',
    );
    expect(text).toContain('reason areas_required');
  });
});
