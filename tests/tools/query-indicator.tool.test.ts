/**
 * @fileoverview Tests for `ilostat_query_indicator` against the recorded catalog
 * and `/data/indicator` CSV bodies (rplumber fetch seam, filtered by the upstream
 * emulator) and the recorded SDMX structures: a multi-dataset header union,
 * compound notes, an empty value, `best_source` under `all`, every zero-row
 * fragment, the not-applicable-filter and unresolved-unit notices, the `sources` default, blank
 * form-client inputs and period normalization, the four row routes (complete,
 * staged on a real in-memory DuckDB canvas, the canvas-off preview, and the
 * refused over-ceiling result) with the upstream stream cancelled once reading
 * stops, the response cache, every declared error reason, and both consumption
 * paths (`structuredContent` and `content[]`).
 * @module tests/tools/query-indicator.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  type FetchMockRoute,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { queryIndicatorTool } from '@/mcp-server/tools/definitions/query-indicator.tool.js';
import type { DataframeMeta } from '@/services/canvas-bridge/canvas-bridge.js';
import { disposeIlostatServices } from '@/services/ilostat-services.js';
import {
  CATALOG_UNAVAILABLE_RECOVERY,
  type CatalogFixture,
  callUrls,
  challengePage,
  csvResponse,
  FAST_PACING,
  FIXED_NOW,
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
  streamedCsv,
  structureRoute,
  tocRow,
  tooManyRequests,
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

type Args = Parameters<typeof queryIndicatorTool.input.parse>[0];
type Output = Awaited<ReturnType<typeof queryIndicatorTool.handler>>;
type ContractResult = Awaited<ReturnType<typeof runToolContract>>;

const UNE = 'UNE_DEAP_SEX_AGE_RT_A';
const UNE_CSV = fixtureText(INDICATOR_CSV.uneDeap);
/** The LAP_2GDP_NOC_RT_A + UNE_2EAP_SEX_AGE_RT_A capture (KEN, 2020), behind the emulator. */
const UNION_ROUTE = indicatorDataRoute(fixtureText(INDICATOR_CSV.multiDatasetUnion));
/** Neither union indicator has an SDMX dataflow in the fixtures, so neither unit resolves. */
const UNION_UNIT_NOTICE =
  "The unit of LAP_2GDP_NOC_RT_A, UNE_2EAP_SEX_AGE_RT_A is unavailable from the ILOSTAT structure service; the dataset label's parenthetical — (%) or (thousands) — gives it.";
const ATTRIBUTION =
  'Source: ILOSTAT, International Labour Organization (CC BY 4.0) — https://ilostat.ilo.org';
const UPSTREAM_BUSY_RECOVERY =
  'The ILOSTAT API is throttling this server; wait the retry-after interval in the error data, then call again with the same arguments.';
const PROBE_422_MESSAGE =
  'ILOSTAT SDMX API (sdmx.ilo.org) rejected the series key built for UNE_DEAP_SEX_AGE_RT (HTTP 422).';
const CANVAS_OFF_NOTICE = (shown: number) =>
  `Showing the first ${shown} rows: dataframes are off in this deployment, so reading stopped at the inline preview and the rest of the result was not fetched. Narrow the request — fewer areas, a shorter time window, or specific sex/classif1 codes — to see all of it.`;

/** A header plus rows in the recorded column order, without note columns. */
const CSV_HEADER =
  '"ref_area","source","indicator","sex","classif1","time","obs_value","obs_status"';

/**
 * The recorded catalog with the observation extras, the recorded UNE_DEAP CSV
 * behind the upstream emulator, and the SDMX fixtures. Extra routes win over the
 * emulator; `observations` rebuilds the service over the given limits.
 */
function wire(options: WireOptions = {}) {
  return wireServices({
    ...options,
    fixture: options.fixture ?? observationCatalogFixture(),
    routes: [...(options.routes ?? []), indicatorDataRoute(UNE_CSV)],
  });
}

/** A route answering every `/data/indicator` request with `respond`. */
function dataRoute(respond: () => Response | Promise<Response>): FetchMockRoute {
  return { method: 'GET', match: (request) => isIndicatorData(request), respond };
}

function canvasOn(): DataCanvas {
  const canvas = memoryCanvas();
  canvases.push(canvas);
  return canvas;
}

function newContext() {
  return createMockContext({ errors: queryIndicatorTool.errors });
}

async function query(args: Args, ctx = newContext()) {
  const result = await queryIndicatorTool.handler(queryIndicatorTool.input.parse(args), ctx);
  return { result, enrichment: getEnrichment(ctx) };
}

async function failure(args: Args): Promise<McpError> {
  try {
    await queryIndicatorTool.handler(queryIndicatorTool.input.parse(args), newContext());
  } catch (error) {
    return error as McpError;
  }
  throw new Error('expected the handler to fail');
}

function render(result: Output): string {
  return (queryIndicatorTool.format?.(result) ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
}

/** The `content[]` text a format()-only client reads. */
function contentText(result: ContractResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

const dataUrls = (wired: ReturnType<typeof wire>) => callUrls(wired.http, isIndicatorData);

/** The one `/data/indicator` request a call sent, as its query parameters. */
function sentParams(wired: ReturnType<typeof wire>): Record<string, string> {
  const urls = dataUrls(wired);
  expect(urls).toHaveLength(1);
  return Object.fromEntries(urls[0]?.searchParams ?? []);
}

/** The tenant canvas the call staged into. */
async function tenantCanvas(canvas: DataCanvas, ctx: Context) {
  const canvasId = await ctx.state.get<string>('canvas-id');
  return canvas.acquire(canvasId ?? undefined, ctx);
}

/** Rows of `sql` on the tenant canvas. */
async function canvasRows(canvas: DataCanvas, ctx: Context, sql: string) {
  return (await (await tenantCanvas(canvas, ctx)).query(sql)).rows;
}

/** Names of the tables on the tenant canvas. */
async function canvasTables(canvas: DataCanvas, ctx: Context) {
  return (await (await tenantCanvas(canvas, ctx)).describe()).map((table) => table.name);
}

describe('rows', () => {
  it('reads a two-dataset header union: request-order metas, sparse rows, legend, and summary', async () => {
    const wired = wire({ routes: [UNION_ROUTE] });
    const { result, enrichment } = await query({
      dataset_ids: ['LAP_2GDP_NOC_RT_A', 'UNE_2EAP_SEX_AGE_RT_A'],
      ref_areas: ['KEN'],
      classif1: ['AGE_YTHADULT_YGE15'],
      time: '2020',
    });
    const modelledMeta = {
      frequency: 'A',
      database: { code: 'ILOEST', label: 'ILO Modelled Estimates (ILOEST)' },
      has_aggregates: true,
      projection_after_year: 2024,
      projection_rule: 'edition',
      edition: 'Nov. 2025',
    };
    // neither indicator has an SDMX dataflow in the fixtures, so no unit resolves
    expect(result.datasets).toEqual([
      {
        dataset_id: 'LAP_2GDP_NOC_RT_A',
        label: 'Labour income share as a percent of GDP -- ILO modelled estimates, Nov. 2025 (%)',
        last_update: '2026-03-20T12:54:04',
        ...modelledMeta,
      },
      {
        dataset_id: 'UNE_2EAP_SEX_AGE_RT_A',
        label: 'Unemployment rate by sex and age -- ILO modelled estimates, Nov. 2025 (%)',
        last_update: '2025-12-02T12:33:47',
        ...modelledMeta,
      },
    ]);
    const une = { dataset_id: 'UNE_2EAP_SEX_AGE_RT_A', ref_area: 'KEN', source: 'XA:1909' };
    expect(result.rows).toEqual([
      {
        dataset_id: 'LAP_2GDP_NOC_RT_A',
        ref_area: 'KEN',
        source: 'XA:1909',
        period: '2020',
        value: 36.723,
        notes: [],
        basis: 'modelled_estimate',
      },
      ...[
        ['SEX_T', 5.613],
        ['SEX_M', 4.706],
        ['SEX_F', 6.64],
      ].map(([sex, value]) => ({
        ...une,
        sex,
        classif1: 'AGE_YTHADULT_YGE15',
        period: '2020',
        value,
        notes: [],
        basis: 'modelled_estimate',
      })),
    ]);
    expect(result.row_count).toBe(4);
    expect(result.legend).toEqual({
      ref_area: { KEN: 'Kenya' },
      source: { 'XA:1909': 'ILO - Modelled Estimates' },
      sex: { SEX_T: 'Total', SEX_M: 'Male', SEX_F: 'Female' },
      classif1: { AGE_YTHADULT_YGE15: 'Age (Youth, adults): 15+' },
      classif2: {},
      obs_status: {},
      notes: {},
    });
    expect(result.summary).toEqual({
      ref_areas: 1,
      period_min: '2020',
      period_max: '2020',
      basis_counts: { reported: 0, modelled_estimate: 4, projection: 0 },
      complete: true,
    });
    expect(result).not.toHaveProperty('dataframe');
    expect(result.attribution).toBe(ATTRIBUTION);
    expect(enrichment).toEqual({
      applied_filters: {
        dataset_ids: ['LAP_2GDP_NOC_RT_A', 'UNE_2EAP_SEX_AGE_RT_A'],
        ref_areas: ['KEN'],
        ref_area_count: 1,
        classif1: ['AGE_YTHADULT_YGE15'],
        time: '2020',
        latest_only: false,
        source_selection: 'best',
        best_source: 'yes',
      },
      truncated: false,
      shown: 4,
      cap: 40_000,
      notice: `classif1 does not apply to LAP_2GDP_NOC_RT_A, which has no classif1 breakdown; its rows are not narrowed by it. ${UNION_UNIT_NOTICE}`,
    });
    expect(sentParams(wired)).toEqual({
      id: 'LAP_2GDP_NOC_RT_A+UNE_2EAP_SEX_AGE_RT_A',
      ref_area: 'KEN',
      classif1: 'AGE_YTHADULT_YGE15',
      time: '2020',
      best_source: 'yes',
      type: 'code',
      format: '.csv',
    });
  });

  it('splits compound notes into codes, classif note first, and decodes each in the legend', async () => {
    wire();
    const { result } = await query({
      dataset_ids: [UNE],
      ref_areas: ['USA'],
      sex: ['SEX_T'],
      time: '2025',
    });
    expect(result.rows).toEqual([
      {
        dataset_id: UNE,
        ref_area: 'USA',
        source: 'BA:453',
        sex: 'SEX_T',
        classif1: 'AGE_YTHADULT_YGE15',
        period: '2025',
        value: 4.282,
        obs_status: 'B',
        notes: ['I11:264', 'R1:3513', 'R1:2803', 'T2:85'],
        basis: 'reported',
      },
      expect.objectContaining({
        classif1: 'AGE_YTHADULT_Y15-24',
        value: 9.981,
        notes: ['C6:1058', 'I11:264', 'R1:3513', 'R1:2803', 'T2:85'],
      }),
    ]);
    expect(result.legend.notes).toEqual({
      'I11:264': 'Break in series: Methodology revised',
      'R1:3513': 'Repository: ILO-STATISTICS - Micro data processing',
      'R1:2803':
        'Repository: Annual estimates for 2025 are 11-month averages that exclude October. Data for October 2025 were not collected due to the federal government shutdown',
      'T2:85': 'Age coverage - minimum age: 16 years old',
      'C6:1058': 'Nonstandard age group: Excluding age 15',
    });
    expect(result.legend.obs_status).toEqual({ B: 'Break in series' });
    expect(result.datasets[0]?.unit).toEqual({
      measure: 'PT',
      measure_label: 'Percentage',
      type: 'RT',
      type_label: 'Rate',
      multiplier: 0,
      multiplier_label: 'Units',
    });
  });

  it('classes rows per source and year: reported, modelled up to the cutoff, projections after it', async () => {
    wire();
    const { result } = await query({ dataset_ids: [UNE], ref_areas: ['KEN', 'X01'] });
    const basisOf = (area: string, period: string) =>
      result.rows.find((row) => row.ref_area === area && row.period === period)?.basis;
    expect(basisOf('KEN', '2021')).toBe('reported');
    expect(basisOf('X01', '2024')).toBe('modelled_estimate');
    expect(basisOf('X01', '2025')).toBe('projection');
    expect(result.summary.basis_counts).toEqual({
      reported: 6,
      modelled_estimate: 25,
      projection: 3,
    });
    expect(result.summary).toMatchObject({ ref_areas: 2, period_min: '1999', period_max: '2027' });
  });

  it('leaves value absent for an empty obs_value and still counts the row (sparse payload)', async () => {
    const sparse = [
      `﻿${CSV_HEADER}`,
      '"KEN","BA:7008","UNE_DEAP_SEX_AGE_RT","SEX_T","AGE_YTHADULT_YGE15","2020",,"U"',
      '"KEN","BA:7008","UNE_DEAP_SEX_AGE_RT","SEX_T","AGE_YTHADULT_YGE15","2019",5.1,',
    ].join('\n');
    wire({ routes: [dataRoute(() => csvResponse(`${sparse}\n`))] });
    const { result } = await query({ dataset_ids: [UNE], ref_areas: ['KEN'] });
    expect(result.rows).toEqual([
      {
        dataset_id: UNE,
        ref_area: 'KEN',
        source: 'BA:7008',
        sex: 'SEX_T',
        classif1: 'AGE_YTHADULT_YGE15',
        period: '2020',
        obs_status: 'U',
        notes: [],
        basis: 'reported',
      },
      expect.objectContaining({ period: '2019', value: 5.1, notes: [] }),
    ]);
    expect(result.row_count).toBe(2);
    expect(result.legend.obs_status).toEqual({ U: 'Unreliable' });
    const lines = render(result).split('\n');
    expect(lines).toContain('- 2020: no value [U Unreliable] · reported');
    expect(lines).toContain('- 2019: 5.1 · reported');
  });

  it('flags best_source per row under source_selection all, and labels an undictionaried note', async () => {
    const wired = wire({
      routes: [dataRoute(() => csvResponse(fixtureText(INDICATOR_CSV.bestSourceAll)))],
    });
    const { result, enrichment } = await query({
      dataset_ids: [UNE],
      ref_areas: ['KEN'],
      source_selection: 'all',
    });
    expect(sentParams(wired).best_source).toBe('all');
    expect(result.rows.map((row) => [row.period, row.source, row.best_source])).toEqual([
      ['2021', 'BX:3465', true],
      ['2019', 'BX:3465', true],
      ['2019', 'AA:1311', false],
      ['2016', 'BB:7021', true],
      ['2009', 'AA:1311', true],
      ['2005', 'BB:7021', true],
      ['1999', 'BA:7008', true],
      ['1999', 'AA:1311', false],
    ]);
    expect(result.legend.notes['T5:1429']).toBe('Not in the ILOSTAT dictionary');
    expect(enrichment.applied_filters).toMatchObject({
      source_selection: 'all',
      best_source: 'all',
    });
    expect(render(result)).toContain(
      '- 2019: 3.171 · reported · best source: false · notes T5:1429, R1:3513',
    );
  });
});

describe('unit from the structure service', () => {
  const unitNotice = (ids: string) =>
    `The unit of ${ids} is unavailable from the ILOSTAT structure service; the dataset label's parenthetical — (%) or (thousands) — gives it.`;

  it('says the unit could not be read when the structure service is down, on both surfaces', async () => {
    wire({
      routes: [
        structureRoute('UNE_DEAP_SEX_AGE_RT', () => Promise.reject(new TypeError('fetch failed'))),
      ],
    });
    const args = { dataset_ids: [UNE], ref_areas: ['USA'], time: '2025' };
    const { result, enrichment } = await query(args);
    expect(result.datasets[0]).not.toHaveProperty('unit');
    expect(result.row_count).toBeGreaterThan(0);
    expect(enrichment.notice).toBe(unitNotice(UNE));
    expect(render(result)).toContain('Unit: not resolved');

    const contract = await runToolContract(queryIndicatorTool, args);
    expect(contract.isError).toBeFalsy();
    expect(contract.structuredContent).toMatchObject({ notice: unitNotice(UNE) });
    expect(contentText(contract)).toContain(unitNotice(UNE));
  });

  it('names only the datasets whose unit is missing', async () => {
    wire();
    const { result, enrichment } = await query({
      dataset_ids: [UNE, 'UNE_2EAP_SEX_AGE_RT_A'],
      ref_areas: ['USA'],
      time: '2025',
    });
    expect(result.datasets.map((dataset) => Boolean(dataset.unit))).toEqual([true, false]);
    expect(enrichment.notice).toBe(unitNotice('UNE_2EAP_SEX_AGE_RT_A'));
  });
});

describe('filters', () => {
  it('discloses each breakdown filter a requested dataset cannot apply', async () => {
    wire({ routes: [UNION_ROUTE] });
    const { result, enrichment } = await query({
      dataset_ids: ['LAP_2GDP_NOC_RT_A', 'UNE_2EAP_SEX_AGE_RT_A'],
      ref_areas: ['KEN'],
      sex: ['SEX_M'],
      classif1: ['AGE_YTHADULT_YGE15'],
    });
    // upstream passes the dataset without the breakdown through unfiltered
    expect(result.rows.map((row) => [row.dataset_id, row.sex])).toEqual([
      ['LAP_2GDP_NOC_RT_A', undefined],
      ['UNE_2EAP_SEX_AGE_RT_A', 'SEX_M'],
    ]);
    expect(enrichment.notice).toBe(
      `sex does not apply to LAP_2GDP_NOC_RT_A, which has no sex breakdown; its rows are not narrowed by it. classif1 does not apply to LAP_2GDP_NOC_RT_A, which has no classif1 breakdown; its rows are not narrowed by it. ${UNION_UNIT_NOTICE}`,
    );
  });

  it('switches source_selection to all when sources is set without one, and echoes it', async () => {
    const wired = wire();
    const { result, enrichment } = await query({
      dataset_ids: [UNE],
      ref_areas: ['usa'],
      sources: [' ba:453 '],
    });
    expect(sentParams(wired)).toMatchObject({
      ref_area: 'USA',
      source: 'BA:453',
      best_source: 'all',
    });
    expect(result.row_count).toBe(18);
    expect(enrichment.applied_filters).toMatchObject({
      sources: ['BA:453'],
      source_selection: 'all',
      best_source: 'all',
    });
  });

  it('keeps an explicit source_selection alongside sources', async () => {
    const wired = wire();
    const { enrichment } = await query({
      dataset_ids: [UNE],
      ref_areas: ['USA'],
      sources: ['BA:453'],
      source_selection: 'best',
    });
    expect(sentParams(wired).best_source).toBe('yes');
    expect(enrichment.applied_filters).toMatchObject({
      source_selection: 'best',
      best_source: 'yes',
    });
  });

  it('expands an area group to its members, unioned with ref_areas and counted', async () => {
    const wired = wire();
    const { result, enrichment } = await query({
      dataset_ids: [UNE],
      ref_areas: ['USA'],
      area_group: 'ilo_geo_x06',
      sex: ['total'],
      latest_only: true,
    });
    expect(sentParams(wired)).toMatchObject({
      ref_area: 'USA+KEN',
      sex: 'SEX_T',
      latestyear: 'TRUE',
    });
    expect(enrichment.applied_filters).toMatchObject({
      ref_areas: ['USA'],
      area_group: { code: 'X06', label: 'Africa', member_count: 1 },
      ref_area_count: 2,
      sex: ['SEX_T'],
      latest_only: true,
    });
    expect(new Set(result.rows.map((row) => row.ref_area))).toEqual(new Set(['USA', 'KEN']));
  });

  it('expands area_group X01 to every country, never to an aggregate, on both surfaces', async () => {
    const wired = wire();
    const result = await runToolContract(queryIndicatorTool, {
      dataset_ids: [UNE],
      area_group: 'ilo_geo_x01',
      time: '2021',
    });
    expect(result.isError).toBeFalsy();
    expect(sentParams(wired).ref_area).toBe('ABW+JOR+KEN+USA');
    const structured = result.structuredContent as Output & Record<string, unknown>;
    expect(structured.applied_filters).toMatchObject({
      area_group: { code: 'X01', label: 'World', member_count: 4 },
      ref_area_count: 4,
    });
    expect(structured.rows.map((row) => row.ref_area)).toEqual(['KEN']);
    expect(contentText(result)).toContain(
      `**Applied filters:** datasets ${UNE} · area_group X01 (World, 4 countries) · 4 areas sent · time 2021`,
    );
  });

  it('dedupes dataset IDs, splits joined elements, and resolves a single-frequency bare code', async () => {
    const wired = wire();
    const { enrichment } = await query({
      dataset_ids: [`${UNE}+df_une_deap_sex_age_rt_a`, 'une_2eap_sex_age_rt'],
      ref_areas: ['KEN'],
    });
    expect(enrichment.applied_filters).toMatchObject({
      dataset_ids: [UNE, 'UNE_2EAP_SEX_AGE_RT_A'],
    });
    expect(sentParams(wired).id).toBe(`${UNE}+UNE_2EAP_SEX_AGE_RT_A`);
  });

  it('reads blank form-client values as unset and sends only the filters given', async () => {
    const wired = wire();
    const { enrichment } = await query({
      dataset_ids: [' une_deap_sex_age_rt_a ', ''],
      ref_areas: ['', ' usa '],
      area_group: '  ',
      sex: ['', 't'],
      classif1: ['  '],
      classif2: [''],
      sources: [''],
      time: '',
      time_from: '2023',
      time_to: 2024,
      source_selection: '',
    });
    expect(sentParams(wired)).toEqual({
      id: UNE,
      ref_area: 'USA',
      sex: 'SEX_T',
      timefrom: '2023',
      timeto: '2024',
      best_source: 'yes',
      type: 'code',
      format: '.csv',
    });
    expect(enrichment.applied_filters).toEqual({
      dataset_ids: [UNE],
      ref_areas: ['USA'],
      ref_area_count: 1,
      sex: ['SEX_T'],
      time_from: '2023',
      time_to: '2024',
      latest_only: false,
      source_selection: 'best',
      best_source: 'yes',
    });
  });

  it.each([
    ['UNE_DEAP_SEX_AGE_RT_Q', '2024-q2', '2024Q2'],
    ['UNE_DEAP_SEX_AGE_RT_Q', ' 2024 Q2 ', '2024Q2'],
    ['UNE_DEAP_SEX_AGE_RT_M', '2025-03', '2025M03'],
    ['UNE_DEAP_SEX_AGE_RT_A', 2024, '2024'],
    // a year on a sub-annual dataset asks for every period of that year
    ['UNE_DEAP_SEX_AGE_RT_Q', '2024', '2024'],
  ] as const)('%s: time %j is sent as %s', async (dataset, time, sent) => {
    const wired = wire();
    const { enrichment } = await query({ dataset_ids: [dataset], ref_areas: ['USA'], time });
    expect(sentParams(wired).time).toBe(sent);
    expect(enrichment.applied_filters).toMatchObject({ time: sent });
  });
});

describe('zero rows', () => {
  it('composes every fragment that holds, with the zero-row shape', async () => {
    const wired = wire();
    const { result, enrichment } = await query({
      dataset_ids: [UNE],
      ref_areas: ['JOR'],
      sex: ['SEX_F'],
      classif1: ['AGE_YTHADULT_Y15-24'],
      time_from: '2020',
      time_to: '2021',
      source_selection: 'secondary',
    });
    expect(sentParams(wired).best_source).toBe('no');
    expect(result.rows).toEqual([]);
    expect(result.row_count).toBe(0);
    expect(result.legend).toEqual({
      ref_area: {},
      source: {},
      sex: {},
      classif1: {},
      classif2: {},
      obs_status: {},
      notes: {},
    });
    expect(result.summary).toEqual({
      ref_areas: 0,
      basis_counts: { reported: 0, modelled_estimate: 0, projection: 0 },
      complete: true,
    });
    expect(enrichment).toMatchObject({ truncated: false, shown: 0 });
    expect(enrichment.notice).toBe(
      [
        `${UNE} may not use SEX_F, AGE_YTHADULT_Y15-24 — ilostat_describe_indicator ${UNE} lists the codes it uses.`,
        `${UNE} covers 1947–2027; widen time_from/time_to or drop time.`,
        `Some requested areas have no ${UNE} data — ilostat_describe_indicator lists the areas it covers.`,
        'No secondary sources exist for this request; use source_selection best or all.',
      ].join(' '),
    );
  });

  it('falls back to a plain notice when no condition holds, after an unfiltered request under the ceiling', async () => {
    const wired = wire();
    const { result, enrichment } = await query({ dataset_ids: ['SDG_0552_NOC_RT_A'] });
    expect(sentParams(wired)).toEqual({
      id: 'SDG_0552_NOC_RT_A',
      best_source: 'yes',
      type: 'code',
      format: '.csv',
    });
    expect(result.rows).toEqual([]);
    expect(enrichment.notice).toBe('The request matched no observations.');
  });
});

describe('routing', () => {
  it('stages a result larger than the preview on the canvas, labels and decimals included', async () => {
    const canvas = canvasOn();
    wire({ canvas, observations: { previewChars: 3_000 } });
    const ctx = newContext();
    const { result, enrichment } = await query(
      { dataset_ids: [UNE], ref_areas: ['USA', 'X01', 'KEN'] },
      ctx,
    );
    const name = result.dataframe?.name ?? '';
    expect(name).toMatch(/^df_[A-Z0-9]{5}_[A-Z0-9]{5}$/);
    expect(result.dataframe).toEqual({
      name,
      row_count: 52,
      expires_at: '2026-09-27T12:00:00.000Z',
    });
    expect(result.row_count).toBe(52);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.length).toBeLessThan(52);
    expect(result.summary).toEqual({
      ref_areas: 3,
      period_min: '1999',
      period_max: '2027',
      basis_counts: { reported: 24, modelled_estimate: 25, projection: 3 },
      complete: true,
    });
    expect(enrichment).toMatchObject({
      truncated: false,
      shown: result.rows.length,
      cap: 3_000,
      notice: `Full result staged as ${name} (52 rows) — use ilostat_dataframe_describe to inspect its columns, then ilostat_dataframe_query to analyze it with SQL.`,
    });

    expect(await canvasTables(canvas, ctx)).toEqual([name]);
    const [usa] = await canvasRows(
      canvas,
      ctx,
      `SELECT value, ref_area_label, ref_area_kind, note_codes, note_labels, unit, unit_multiplier, year, subperiod, basis, best_source FROM ${name} WHERE ref_area = 'USA' AND period = '2025' AND sex = 'SEX_T' AND classif1 = 'AGE_YTHADULT_YGE15'`,
    );
    expect(usa).toEqual({
      value: 4.282,
      ref_area_label: 'United States of America',
      ref_area_kind: 'country',
      note_codes: 'I11:264;R1:3513;R1:2803;T2:85',
      note_labels:
        'Break in series: Methodology revised | Repository: ILO-STATISTICS - Micro data processing | Repository: Annual estimates for 2025 are 11-month averages that exclude October. Data for October 2025 were not collected due to the federal government shutdown | Age coverage - minimum age: 16 years old',
      unit: 'Percentage',
      unit_multiplier: 0,
      year: 2025,
      subperiod: null,
      basis: 'reported',
      best_source: null,
    });
    expect(
      await canvasRows(
        canvas,
        ctx,
        `SELECT basis, count(*)::INTEGER AS n FROM ${name} GROUP BY basis ORDER BY basis`,
      ),
    ).toEqual([
      { basis: 'modelled_estimate', n: 25 },
      { basis: 'projection', n: 3 },
      { basis: 'reported', n: 24 },
    ]);

    const meta = await ctx.state.get<DataframeMeta>(`df-meta/${name}`);
    expect(meta).toMatchObject({
      sourceTool: 'ilostat_query_indicator',
      tableName: name,
      rowCount: 52,
      queryParams: { dataset_ids: [UNE], ref_areas: ['USA', 'X01', 'KEN'], ref_area_count: 3 },
      datasets: [
        {
          datasetId: UNE,
          label: 'Unemployment rate by sex and age (%)',
          lastUpdate: '2026-09-24T07:10:19',
          unit: 'Percentage',
        },
      ],
      coverage: { refAreas: 3, periodMin: '1999', periodMax: '2027' },
      basisCounts: { reported: 24, modelled_estimate: 25, projection: 3 },
      attribution: ATTRIBUTION,
      createdAt: FIXED_NOW.toISOString(),
      expiresAt: '2026-09-27T12:00:00.000Z',
    });
  });

  it('with dataframes off, stops at the preview, discloses it, and cancels the upstream body', async () => {
    const stream = streamedCsv(
      CSV_HEADER,
      10_000,
      (index) =>
        `"USA","BA:453","UNE_DEAP_SEX_AGE_RT","SEX_T","AGE_YTHADULT_YGE15","${1000 + index}",${index % 10},`,
    );
    wire({ routes: [dataRoute(() => stream.response())], observations: { previewChars: 3_000 } });
    const { result, enrichment } = await query({ dataset_ids: [UNE], ref_areas: ['USA'] });
    const shown = result.rows.length;
    expect(shown).toBeGreaterThan(0);
    expect(result).not.toHaveProperty('dataframe');
    expect(result.summary.complete).toBe(false);
    // row_count is the rows read, not the rows upstream holds
    expect(result.row_count).toBeGreaterThanOrEqual(shown);
    expect(result.row_count).toBeLessThan(10_000);
    expect(enrichment).toMatchObject({
      truncated: true,
      shown,
      cap: 3_000,
      notice: CANVAS_OFF_NOTICE(shown),
    });
    expect(stream.cancelled).toBe(true);
    expect(stream.pulled).toBeLessThan(1_000);
  });

  it('refuses a result past the row ceiling as result_too_large, drops the partial table, and stops the transfer', async () => {
    const canvas = canvasOn();
    const stream = streamedCsv(
      CSV_HEADER,
      10_000,
      (index) =>
        `"USA","BA:453","UNE_DEAP_SEX_AGE_RT","SEX_T","AGE_YTHADULT_YGE15","${1000 + index}",${index % 10},`,
    );
    wire({
      canvas,
      routes: [dataRoute(() => stream.response())],
      observations: { maxRows: 250, previewChars: 2_000 },
    });
    const ctx = newContext();
    const error = await query({ dataset_ids: [UNE], ref_areas: ['USA'] }, ctx).then(
      () => undefined,
      (caught: unknown) => caught as McpError,
    );
    expect(error?.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error?.data).toMatchObject({
      reason: 'result_too_large',
      maxRows: 250,
      recovery: {
        hint: 'Narrow the request with fewer reference areas, a shorter time window, or specific sex/classif1 codes, then call again.',
      },
    });
    expect(error?.message).toBe('The result passed the 250-row ceiling; nothing was staged.');
    expect(stream.cancelled).toBe(true);
    expect(stream.pulled).toBeLessThan(1_000);
    expect(await canvasTables(canvas, ctx)).toEqual([]);
    expect((await ctx.state.list('df-meta/')).items).toEqual([]);
  });
});

describe('response cache', () => {
  it('serves a repeat of the same request from the cache', async () => {
    const wired = wire();
    const args = { dataset_ids: [UNE], ref_areas: ['USA'], time: '2024' };
    const first = await query(args);
    const second = await query(args);
    expect(second.result).toEqual(first.result);
    expect(dataUrls(wired)).toHaveLength(1);
  });

  it('fetches again when the cache is off', async () => {
    const wired = wire({ observations: { cacheTtlMs: 0 } });
    const args = { dataset_ids: [UNE], ref_areas: ['USA'], time: '2024' };
    await query(args);
    await query(args);
    expect(dataUrls(wired)).toHaveLength(2);
  });

  it('never caches a response whose reading stopped at the preview', async () => {
    const wired = wire({ observations: { previewChars: 2_000 } });
    const args = { dataset_ids: [UNE], ref_areas: ['USA'] };
    expect((await query(args)).result.summary.complete).toBe(false);
    await query(args);
    expect(dataUrls(wired)).toHaveLength(2);
  });
});

describe('errors', () => {
  it('logs the reasons a caller’s input causes at notice, a retired dataset at warning, outages at error', () => {
    const severities = Object.fromEntries(
      (queryIndicatorTool.errors ?? []).map((entry: { reason: string; severity?: string }) => [
        entry.reason,
        entry.severity ?? 'error',
      ]),
    );
    expect(severities).toEqual({
      unknown_dataset: 'notice',
      unknown_code: 'notice',
      unknown_area_group: 'notice',
      aggregates_unavailable: 'notice',
      invalid_period: 'notice',
      request_too_broad: 'notice',
      result_too_large: 'notice',
      dataset_retired: 'warning',
      upstream_busy: 'error',
      catalog_unavailable: 'error',
    });
  });

  it('unknown_dataset: a well-formed ID the catalog lacks, before any data request', async () => {
    const wired = wire();
    const error = await failure({ dataset_ids: ['NOPE_NOT_REAL_A'] });
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({
      reason: 'unknown_dataset',
      datasetIds: ['NOPE_NOT_REAL_A'],
      recovery: {
        hint: 'Call ilostat_search_indicators to find a dataset ID — an indicator code plus _A, _Q, or _M, such as UNE_DEAP_SEX_AGE_RT_A.',
      },
    });
    expect(error.message).toBe('No ILOSTAT dataset has the ID NOPE_NOT_REAL_A.');
    expect(dataUrls(wired)).toHaveLength(0);
  });

  it('unknown_dataset: a bare indicator code with several frequencies lists them', async () => {
    wire();
    const error = await failure({ dataset_ids: ['une_deap_sex_age_rt'] });
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    const variants = ['UNE_DEAP_SEX_AGE_RT_A', 'UNE_DEAP_SEX_AGE_RT_Q', 'UNE_DEAP_SEX_AGE_RT_M'];
    expect(error.data).toMatchObject({
      reason: 'unknown_dataset',
      indicator: 'UNE_DEAP_SEX_AGE_RT',
    });
    expect([...((error.data as { variants: string[] }).variants ?? [])].sort()).toEqual(
      [...variants].sort(),
    );
    expect((error.data as { recovery: { hint: string } }).recovery.hint).toMatch(
      /^Pass one of UNE_DEAP_SEX_AGE_RT_[AQM], UNE_DEAP_SEX_AGE_RT_[AQM], UNE_DEAP_SEX_AGE_RT_[AQM] — the indicator code plus _A, _Q, or _M for the frequency you want\.$/,
    );
  });

  it('unknown_code: names every rejected code by field, a classif1-only code in classif2 included', async () => {
    const wired = wire();
    const error = await failure({
      dataset_ids: [UNE],
      ref_areas: ['ZZZ', 'USA'],
      classif1: ['nope', 'AGE_YTHADULT_YGE15'],
      classif2: ['AGE_YTHADULT_YGE15'],
      sources: ['xx:1'],
    });
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'unknown_code',
      rejected: {
        ref_areas: ['ZZZ'],
        classif1: ['NOPE'],
        classif2: ['AGE_YTHADULT_YGE15'],
        sources: ['XX:1'],
      },
      recovery: {
        hint: 'Call ilostat_list_reference with topic ref_areas for ref_areas, topic classifications for classif1, topic classifications for classif2, topic sources for sources to find valid codes.',
      },
    });
    expect(error.message).toBe(
      'Not ILOSTAT codes — ref_areas: ZZZ; classif1: NOPE; classif2: AGE_YTHADULT_YGE15; sources: XX:1.',
    );
    expect(dataUrls(wired)).toHaveLength(0);
  });

  it('unknown_area_group: a well-formed X code that is not a region, subregion, or income group', async () => {
    wire();
    const error = await failure({ dataset_ids: [UNE], area_group: 'X99' });
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'unknown_area_group',
      areaGroup: 'X99',
      recovery: {
        hint: 'Call ilostat_list_reference with topic area_groups to see the group codes area_group accepts.',
      },
    });
  });

  it('aggregates_unavailable: names only the requested dataset without aggregate rows', async () => {
    const wired = wire();
    const error = await failure({
      dataset_ids: [UNE, 'UNE_DEAP_SEX_AGE_RT_Q'],
      ref_areas: ['X01', 'USA'],
    });
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'aggregates_unavailable',
      datasetIds: ['UNE_DEAP_SEX_AGE_RT_Q'],
      aggregates: ['X01'],
      recovery: {
        hint: 'Request countries only, or use a dataset whose ilostat_describe_indicator output shows has_aggregates true, such as the ILO modelled estimates in database ILOEST.',
      },
    });
    expect(error.message).toBe(
      'UNE_DEAP_SEX_AGE_RT_Q has no aggregate rows, so X01 cannot be served from it.',
    );
    expect(dataUrls(wired)).toHaveLength(0);
  });

  it.each([
    [
      { time: '2024', time_from: '2020' },
      'time names one exact period, so it cannot be combined with time_from, time_to, or latest_only.',
    ],
    [
      { time: '2024', latest_only: true },
      'time names one exact period, so it cannot be combined with time_from, time_to, or latest_only.',
    ],
    [{ time_from: '2024', time_to: '2020' }, 'time_from 2024 is after time_to 2020.'],
    [
      { time: '2024Q2' },
      `time 2024Q2 is a quarterly period, but ${UNE} (A) is not at that frequency.`,
    ],
  ] as const)('invalid_period: %o', async (period, message) => {
    const wired = wire();
    const error = await failure({ dataset_ids: [UNE], ref_areas: ['USA'], ...period });
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_period',
      recovery: {
        hint: 'Use YYYY for time_from and time_to, and YYYY, YYYYQn, or YYYYMmm matching the dataset frequency for time, never time together with a range or latest_only.',
      },
    });
    expect(error.message).toBe(message);
    expect(dataUrls(wired)).toHaveLength(0);
  });

  it.each([
    ['best', 716_055],
    ['all', 764_252],
  ] as const)(
    'request_too_broad: no filters at all, sized from the ToC counts under %s',
    async (source_selection, estimate) => {
      const wired = wire();
      const error = await failure({
        dataset_ids: [UNE, 'UNE_DEAP_SEX_AGE_RT_M'],
        source_selection,
      });
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({
        reason: 'request_too_broad',
        estimatedRows: estimate,
        maxRows: 500_000,
        recovery: {
          hint: 'Add ref_areas or area_group, a time_from/time_to window, latest_only, or sex/classif1 filters; ilostat_describe_indicator lists the codes this dataset uses.',
        },
      });
      expect(error.message).toBe(
        `An unfiltered download of ${UNE}, UNE_DEAP_SEX_AGE_RT_M holds ${estimate.toLocaleString('en-US')} rows, over the 500,000-row ceiling.`,
      );
      expect(dataUrls(wired)).toHaveLength(0);
    },
  );

  it('dataset_retired: the upstream 400 for a withdrawn catalog ID, with this tool’s recovery', async () => {
    wire({ routes: [dataRoute(() => retiredDatasetResponse())] });
    const error = await failure({ dataset_ids: [UNE], ref_areas: ['USA'] });
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({
      reason: 'dataset_retired',
      datasetId: 'FOO_BAR_A',
      recovery: {
        hint: 'The dataset was withdrawn upstream after the last catalog refresh; call ilostat_search_indicators for its current equivalent.',
      },
    });
  });

  it.each([
    ['a 429 with Retry-After', () => tooManyRequests('30'), { retryAfter: 30 }],
    ['a challenge page', () => challengePage(), {}],
  ] as const)('upstream_busy: %s', async (_label, respond, extra) => {
    wire({ routes: [dataRoute(respond)] });
    const error = await failure({ dataset_ids: [UNE], ref_areas: ['USA'] });
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({
      reason: 'upstream_busy',
      retryable: true,
      ...extra,
      recovery: { hint: UPSTREAM_BUSY_RECOVERY },
    });
  });

  it('upstream_busy: a pacer shed while every slot is in flight reports a wait of at least 1 s, on both surfaces', async () => {
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const wired = wire({
      rplumber: { pacing: { ...FAST_PACING, maxConcurrent: 1, maxWaitMs: 0 } },
      routes: [
        dataRoute(() => {
          signalStarted();
          return held;
        }),
      ],
    });
    const args = { dataset_ids: [UNE], ref_areas: ['USA'] };
    const first = query(args);
    try {
      await started;
      const error = await failure(args);
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect((error.cause as McpError).data?.reason).toBe('pacer_shed');
      expect(error.data).toMatchObject({
        reason: 'upstream_busy',
        retryable: true,
        retryAfter: 1,
        recovery: { hint: UPSTREAM_BUSY_RECOVERY },
      });
      expect(error.message).toBe(
        'ILOSTAT API (rplumber.ilo.org) is throttling this server; retry in about 1 s.',
      );

      const result = await runToolContract(queryIndicatorTool, args);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.RateLimited,
          data: { reason: 'upstream_busy', retryAfter: 1 },
        },
      });
      expect(contentText(result)).toContain('retry in about 1 s');
      expect(dataUrls(wired)).toHaveLength(1);
    } finally {
      release(csvResponse(`${CSV_HEADER}\n`));
      await first;
    }
  });

  it('catalog_unavailable: the catalog could not be loaded', async () => {
    const wired = wire({
      routes: [
        {
          match: (request) => isRplumber(request, '/metadata/toc/indicator'),
          respond: () => new Response('unavailable', { status: 503 }),
        },
      ],
    });
    const error = await failure({ dataset_ids: [UNE], ref_areas: ['USA'] });
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'catalog_unavailable',
      retryable: true,
      recovery: { hint: CATALOG_UNAVAILABLE_RECOVERY },
    });
    expect(dataUrls(wired)).toHaveLength(0);
  });

  it.each([
    ['time with latest_only', { time: '2024', latest_only: true }],
    ['time with a range', { time: '2024', time_from: '2020' }],
    ['a reversed range', { time_from: '2024', time_to: '2020' }],
  ])(
    'invalid_period for %s is answered during a catalog outage, not catalog_unavailable',
    async (_label, periods) => {
      wire({
        routes: [
          {
            match: (request) => isRplumber(request, '/metadata/toc/indicator'),
            respond: () => new Response('unavailable', { status: 503 }),
          },
        ],
      });
      const error = await failure({ dataset_ids: [UNE], ref_areas: ['USA'], ...periods });
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({ reason: 'invalid_period' });
    },
  );

  it("InternalError: a unit-probe key the SDMX host rejects (422) is this server's bug, on both surfaces", async () => {
    const probe422 = probeRoute('UNE_DEAP_SEX_AGE_RT', 'ABW....', () =>
      sdmxText(SDMX_422_SHORT_KEY, 422),
    );
    wire({ routes: [probe422] });
    const args = { dataset_ids: [UNE], ref_areas: ['USA'] };
    const error = await failure(args);
    expect(error.code).toBe(JsonRpcErrorCode.InternalError);
    expect(error.message).toBe(PROBE_422_MESSAGE);

    const result = await runToolContract(queryIndicatorTool, args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InternalError },
    });
    expect(contentText(result)).toContain(PROBE_422_MESSAGE);
  });

  it.each([
    ['a dataset ID with a space', { dataset_ids: ['UNE DEAP'] }],
    [
      'four dataset IDs after splitting',
      { dataset_ids: [`${UNE}+UNE_DEAP_SEX_AGE_RT_Q`, 'A_A,B_A'] },
    ],
    ['a malformed area code', { dataset_ids: [UNE], ref_areas: ['U\nS'] }],
    ['a malformed area group', { dataset_ids: [UNE], area_group: 'AFRICA' }],
    ['an unknown sex alias', { dataset_ids: [UNE], sex: ['X'] }],
    ['a malformed period', { dataset_ids: [UNE], time: '2024-13' }],
    ['a two-digit year', { dataset_ids: [UNE], time_from: '24' }],
  ])('invalid_arguments: %s fails the schema before any request', async (_label, args) => {
    const wired = wire();
    const result = await runToolContract(queryIndicatorTool, args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(wired.http.calls).toHaveLength(0);
  });
});

describe('format()', () => {
  it('renders the dataset block, grouped rows, legend, summary, and attribution', async () => {
    wire();
    const { result } = await query({
      dataset_ids: [UNE],
      ref_areas: ['USA'],
      sex: ['SEX_T'],
      time_from: '2024',
    });
    const lines = render(result).split('\n');
    for (const line of [
      `## ${UNE} — Unemployment rate by sex and age (%)`,
      'Frequency: annual (A) · Database: Labour Force Statistics (LFS) (LFS) · Updated 2026-09-24T07:10:19 · Has aggregates: true',
      'Unit: Percentage (PT) · type Rate (RT) · multiplier 0 (Units)',
      'Basis rule: ILO modelled rows through 2024 are modelled_estimate, later ones projection (rule catalog_edition, edition Nov. 2025); every other source is reported.',
      '### Observations (4 of 4 rows shown)',
      `#### ${UNE} · USA · SEX_T · AGE_YTHADULT_YGE15 · BA:453`,
      '- 2025: 4.282 [B Break in series] · reported · notes I11:264, R1:3513, R1:2803, T2:85',
      '- 2024: 4.022 · reported · notes R1:3513, T2:85',
      `#### ${UNE} · USA · SEX_T · AGE_YTHADULT_Y15-24 · BA:453`,
      '- 2024: 8.929 · reported · notes C6:1058, R1:3513, T2:85',
      '### Legend',
      '**Reference areas:**',
      '- USA — United States of America',
      '**Sources:**',
      '- BA:453 — LFS - Current Population Survey',
      '**Sex:**',
      '- SEX_T — Total',
      '**classif1:**',
      '- AGE_YTHADULT_Y15-24 — Age (Youth, adults): 15-24',
      '**Status flags:**',
      '- B — Break in series',
      '**Notes:**',
      '- T2:85 — Age coverage - minimum age: 16 years old',
      '**Summary:** 4 rows · 1 area · periods 2024–2025 · reported 4 · modelled_estimate 0 · projection 0 · complete: true',
      ATTRIBUTION,
    ]) {
      expect(lines).toContain(line);
    }
    expect(lines).not.toContain('**classif2:**');
  });

  it('flattens CR/LF in labels so none escapes its line', async () => {
    const fixture: CatalogFixture = observationCatalogFixture();
    const note = fixture.dictionaries.note_source?.find((row) => row.note_source === 'T2:85');
    if (note) note['note_source.label'] = 'Age coverage\r\n# injected';
    const source = fixture.dictionaries.source?.find((row) => row.source === 'BA:453');
    if (source) source['source.label'] = 'LFS\n## Current Population Survey';
    wire({ fixture });
    const { result } = await query({
      dataset_ids: [UNE],
      ref_areas: ['USA'],
      sex: ['SEX_T'],
      time: '2024',
    });
    expect(result.legend.notes['T2:85']).toBe('Age coverage\r\n# injected');
    const lines = render(result).split('\n');
    expect(lines).toContain('- T2:85 — Age coverage # injected');
    expect(lines).toContain('- BA:453 — LFS ## Current Population Survey');
    expect(lines.some((line) => line.startsWith('#') && line.includes('injected'))).toBe(false);
  });

  it('flattens CR/LF in the ToC update time, verbatim in structuredContent', async () => {
    const fixture: CatalogFixture = observationCatalogFixture();
    tocRow(fixture, UNE)['last.update'] = '24/09/2026\n## update';
    wire({ fixture });
    const { result } = await query({ dataset_ids: [UNE], ref_areas: ['USA'], time: '2024' });
    expect(result.datasets[0]?.last_update).toBe('24/09/2026\n## update');
    const lines = render(result).split('\n');
    expect(lines).toContain(
      'Frequency: annual (A) · Database: Labour Force Statistics (LFS) (LFS) · Updated 24/09/2026 ## update · Has aggregates: true',
    );
    expect(lines.some((line) => line.startsWith('## update'))).toBe(false);
  });

  it('flattens line breaks in upstream codes, verbatim in structuredContent', async () => {
    const csv = [
      `${CSV_HEADER},"note_source"`,
      '"USA","BA:453","UNE_DEAP_SEX_AGE_RT","SEX_T","AGE_YTHADULT_YGE15\n## c|d","2024\n## p|q",5,"B\n## s|t","R1:3513\n## n|m"',
      '',
    ].join('\n');
    wire({ routes: [dataRoute(() => csvResponse(csv))] });
    const result = await runToolContract(queryIndicatorTool, {
      dataset_ids: [UNE],
      ref_areas: ['USA'],
    });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as Output).rows[0]).toMatchObject({
      classif1: 'AGE_YTHADULT_YGE15\n## c|d',
      period: '2024\n## p|q',
      obs_status: 'B\n## s|t',
      notes: ['R1:3513\n## n|m'],
    });
    const lines = contentText(result).split('\n');
    expect(lines).toContain(`#### ${UNE} · USA · SEX_T · AGE_YTHADULT_YGE15 ## c|d · BA:453`);
    expect(lines.filter((line) => line.startsWith('- 2024'))).toEqual([
      '- 2024 ## p|q: 5 [B ## s|t Not in the ILOSTAT dictionary] · reported · notes R1:3513 ## n|m',
    ]);
    expect(
      lines.some(
        (line) =>
          line.startsWith('**Summary:**') && line.includes('periods 2024 ## p|q–2024 ## p|q'),
      ),
    ).toBe(true);
    expect(lines.filter((line) => /^## [a-z]\|/.test(line))).toEqual([]);
  });
});

describe('contract envelope (runToolContract)', () => {
  it('a complete page validates and carries the same data on both surfaces', async () => {
    wire({ routes: [UNION_ROUTE] });
    const result = await runToolContract(queryIndicatorTool, {
      dataset_ids: ['LAP_2GDP_NOC_RT_A', 'UNE_2EAP_SEX_AGE_RT_A'],
      ref_areas: ['KEN'],
      classif1: ['AGE_YTHADULT_YGE15'],
      time: '2020',
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Output & Record<string, unknown>;
    expect(structured).toMatchObject({
      row_count: 4,
      truncated: false,
      shown: 4,
      cap: 40_000,
      applied_filters: { dataset_ids: ['LAP_2GDP_NOC_RT_A', 'UNE_2EAP_SEX_AGE_RT_A'] },
    });
    const text = contentText(result);
    for (const row of structured.rows) {
      expect(text).toContain(`- ${row.period}: ${row.value}`);
    }
    for (const fragment of [
      '## LAP_2GDP_NOC_RT_A — Labour income share as a percent of GDP -- ILO modelled estimates, Nov. 2025 (%)',
      '## UNE_2EAP_SEX_AGE_RT_A — Unemployment rate by sex and age -- ILO modelled estimates, Nov. 2025 (%)',
      'Unit: not resolved',
      '#### LAP_2GDP_NOC_RT_A · KEN · XA:1909',
      '#### UNE_2EAP_SEX_AGE_RT_A · KEN · SEX_M · AGE_YTHADULT_YGE15 · XA:1909',
      '- 2020: 36.723 · modelled_estimate',
      '- XA:1909 — ILO - Modelled Estimates',
      '**Summary:** 4 rows · 1 area · periods 2020–2020 · reported 0 · modelled_estimate 4 · projection 0 · complete: true',
      '**Applied filters:** datasets LAP_2GDP_NOC_RT_A, UNE_2EAP_SEX_AGE_RT_A · ref_areas KEN · 1 area sent · classif1 AGE_YTHADULT_YGE15 · time 2020 · latest_only false · source_selection best (best_source=yes)',
      'classif1 does not apply to LAP_2GDP_NOC_RT_A, which has no classif1 breakdown; its rows are not narrowed by it.',
      ATTRIBUTION,
    ]) {
      expect(text).toContain(fragment);
    }
  });

  it('a zero-row page validates, its notice on both surfaces', async () => {
    wire();
    const result = await runToolContract(queryIndicatorTool, {
      dataset_ids: [UNE],
      ref_areas: ['JOR'],
    });
    expect(result.isError).toBeFalsy();
    const notice = `Some requested areas have no ${UNE} data — ilostat_describe_indicator lists the areas it covers.`;
    expect(result.structuredContent).toMatchObject({
      rows: [],
      row_count: 0,
      summary: { ref_areas: 0, complete: true },
      truncated: false,
      shown: 0,
      notice,
    });
    const text = contentText(result);
    expect(text).toContain('### Observations (0 of 0 rows shown)');
    expect(text).toContain(
      '**Summary:** 0 rows · 0 areas · reported 0 · modelled_estimate 0 · projection 0 · complete: true',
    );
    expect(text).toContain(notice);
  });

  it('a staged page validates and names the dataframe on both surfaces', async () => {
    const canvas = canvasOn();
    wire({ canvas, observations: { previewChars: 3_000 } });
    const result = await runToolContract(queryIndicatorTool, {
      dataset_ids: [UNE],
      ref_areas: ['USA', 'X01', 'KEN'],
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Output;
    const name = structured.dataframe?.name ?? '';
    expect(name).toMatch(/^df_/);
    const text = contentText(result);
    expect(text).toContain(`**Dataframe:** ${name} (52 rows, expires 2026-09-27T12:00:00.000Z)`);
    expect(text).toContain(`Full result staged as ${name} (52 rows)`);
    expect(text).toContain(`### Observations (${structured.rows.length} of 52 rows shown)`);
  });

  it('a preview page validates as truncated, the disclosure on both surfaces', async () => {
    wire({ observations: { previewChars: 3_000 } });
    const result = await runToolContract(queryIndicatorTool, {
      dataset_ids: [UNE],
      ref_areas: ['USA', 'X01', 'KEN'],
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Output & { shown: number };
    expect(structured).toMatchObject({
      truncated: true,
      cap: 3_000,
      summary: { complete: false },
    });
    expect(structured).not.toHaveProperty('dataframe');
    const text = contentText(result);
    expect(text).toContain(CANVAS_OFF_NOTICE(structured.shown));
    expect(text).toContain('complete: false');
  });

  it('a declared failure reaches both surfaces with its reason and recovery', async () => {
    wire();
    const result = await runToolContract(queryIndicatorTool, {
      dataset_ids: [UNE],
      ref_areas: ['ZZZ'],
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'unknown_code', rejected: { ref_areas: ['ZZZ'] } },
      },
    });
    const text = contentText(result);
    expect(text).toContain('Not ILOSTAT codes — ref_areas: ZZZ.');
    expect(text).toContain(
      'Recovery: Call ilostat_list_reference with topic ref_areas for ref_areas to find valid codes.',
    );
    expect(text).toContain('reason unknown_code');
  });
});
