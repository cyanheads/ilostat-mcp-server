/**
 * @fileoverview Tests for `ilostat_query_indicator` against the recorded catalog
 * and `/data/indicator` CSV bodies (rplumber fetch seam, filtered by the upstream
 * emulator) and the recorded SDMX structures: a multi-dataset header union,
 * compound notes, an empty value, `best_source` under `all`, every zero-row
 * fragment, the not-applicable-filter and unresolved-unit notices, the `sources` default, blank
 * form-client inputs and period normalization, the row routes (complete, staged
 * on a real in-memory DuckDB canvas, paged with dataframes off, a first page past
 * the row ceiling left unstaged, and a page reaching past it refused) with the
 * upstream stream cancelled once reading stops, paging by limit and offset with
 * its cache and read bounds, the response cache, every declared error reason, and both consumption
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
import type { FetchFn } from '@/services/upstream/upstream-http.js';
import {
  CATALOG_UNAVAILABLE_RECOVERY,
  type CatalogFixture,
  callUrls,
  challengePage,
  csvResponse,
  FAST_PACING,
  FAST_TIMEOUTS,
  FIXED_NOW,
  faultyCanvas,
  filterIndicatorCsv,
  fixtureText,
  INDICATOR_CSV,
  indicatorDataRoute,
  isIndicatorData,
  isRplumber,
  memoryCanvas,
  observationCatalogFixture,
  RPLUMBER_ORIGIN,
  retiredDatasetResponse,
  SDMX_ORIGIN,
  streamedCsv,
  structureRoute,
  tocRow,
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

type Args = Parameters<typeof queryIndicatorTool.input.parse>[0];
type Output = Awaited<ReturnType<typeof queryIndicatorTool.handler>>;
type ContractResult = Awaited<ReturnType<typeof runToolContract>>;

const UNE = 'UNE_DEAP_SEX_AGE_RT_A';
const UNE_CSV = fixtureText(INDICATOR_CSV.uneDeap);
/** The LAP_2GDP_NOC_RT_A + UNE_2EAP_SEX_AGE_RT_A capture (KEN, 2020), behind the emulator. */
const UNION_ROUTE = indicatorDataRoute(fixtureText(INDICATOR_CSV.multiDatasetUnion));
/**
 * A percent unit as the catalog's ToC row labels it: what a dataset reports when
 * its SDMX structure is unavailable, as for both union indicators, which have no
 * SDMX dataflow in the fixtures.
 */
const PERCENT_UNIT_FROM_TOC = {
  measure: 'PT',
  measure_label: '%',
  type: 'RT',
  multiplier: 0,
  multiplier_label: 'units',
};
const ATTRIBUTION =
  'Source: ILOSTAT, International Labour Organization (CC BY 4.0) — https://ilostat.ilo.org';
const UPSTREAM_BUSY_RECOVERY =
  'The ILOSTAT API is throttling this server; wait the retry-after interval in the error data, then call again with the same arguments.';

/** A header plus rows in the recorded column order, without note columns. */
const CSV_HEADER =
  '"ref_area","source","indicator","sex","classif1","time","obs_value","obs_status"';

/** `n` USA rows, one per year from 1000, streamed 100 rows a pull. */
const usaRows = (n: number) =>
  streamedCsv(
    CSV_HEADER,
    n,
    (index) =>
      `"USA","BA:453","UNE_DEAP_SEX_AGE_RT","SEX_T","AGE_YTHADULT_YGE15","${1000 + index}",${index % 10},`,
  );

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

/** The one `/data/indicator` request a call sent, as its query parameters, read as upstream reads them. */
function sentParams(wired: ReturnType<typeof wire>): Record<string, string> {
  const urls = dataUrls(wired);
  expect(urls).toHaveLength(1);
  return Object.fromEntries(urls[0] ? upstreamParams(urls[0]) : []);
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

/** The observation catalog with twelve more X36 members, copies of JOR's row: thirteen areas UNE_DEAP's structure leaves out. */
function x36Fixture() {
  const fixture = observationCatalogFixture();
  const jordan = fixture.refAreaToc.find((row) => row.ref_area === 'JOR');
  const added = 'ABCDEFGHIJKL'.split('').map((letter) => `Q${letter}${letter}`);
  for (const code of added) {
    fixture.refAreaToc.push({
      ...jordan,
      id: `${code}_A`,
      ref_area: code,
      'ref_area.label': code,
    });
  }
  return { fixture, members: ['JOR', ...added] };
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
    // neither indicator has an SDMX dataflow in the fixtures, so each unit keeps the catalog's labels
    expect(result.datasets).toEqual([
      {
        dataset_id: 'LAP_2GDP_NOC_RT_A',
        label: 'Labour income share as a percent of GDP -- ILO modelled estimates, Nov. 2025 (%)',
        last_update: '2026-03-20T12:54:04',
        ...modelledMeta,
        unit: PERCENT_UNIT_FROM_TOC,
      },
      {
        dataset_id: 'UNE_2EAP_SEX_AGE_RT_A',
        label: 'Unemployment rate by sex and age -- ILO modelled estimates, Nov. 2025 (%)',
        last_update: '2025-12-02T12:33:47',
        ...modelledMeta,
        unit: PERCENT_UNIT_FROM_TOC,
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
      areas_without_rows: [],
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
      cap: 50,
      notice:
        'classif1 does not apply to LAP_2GDP_NOC_RT_A, which has no classif1 breakdown; its rows are not narrowed by it.',
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

  it('joins the dataset IDs with a literal + on the wire and returns rows for each, on both surfaces', async () => {
    const wired = wire({ routes: [UNION_ROUTE] });
    const result = await runToolContract(queryIndicatorTool, {
      dataset_ids: ['LAP_2GDP_NOC_RT_A', 'UNE_2EAP_SEX_AGE_RT_A'],
      ref_areas: ['KEN'],
      sex: ['SEX_T'],
      time: '2020',
    });
    expect(result.isError).toBeFalsy();
    // upstream reads `id=A%2BB` as the one dataset ID `A+B` and answers 400
    expect(dataUrls(wired)[0]?.search).toMatch(/[?&]id=LAP_2GDP_NOC_RT_A\+UNE_2EAP_SEX_AGE_RT_A&/);
    const structured = result.structuredContent as Output & Record<string, unknown>;
    expect(structured.rows.map((row) => [row.dataset_id, row.value])).toEqual([
      ['LAP_2GDP_NOC_RT_A', 36.723],
      ['UNE_2EAP_SEX_AGE_RT_A', 5.613],
    ]);
    expect(structured.datasets.map((dataset) => dataset.dataset_id)).toEqual([
      'LAP_2GDP_NOC_RT_A',
      'UNE_2EAP_SEX_AGE_RT_A',
    ]);
    const text = contentText(result);
    for (const fragment of ['LAP_2GDP_NOC_RT_A', 'UNE_2EAP_SEX_AGE_RT_A', '36.723', '5.613']) {
      expect(text).toContain(fragment);
    }
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

describe('unit from the catalog', () => {
  const STRUCTURE_DOWN = structureRoute('UNE_DEAP_SEX_AGE_RT', () =>
    Promise.reject(new TypeError('fetch failed')),
  );
  const sdmxPaths = (wired: ReturnType<typeof wire>) =>
    callUrls(wired.http, (request) => new URL(request.url).origin === SDMX_ORIGIN).map(
      (url) => url.pathname,
    );

  /** The observation catalog with the four ToC unit fields removed from `ids`' rows. */
  function withoutUnits(...ids: string[]): CatalogFixture {
    const fixture = observationCatalogFixture();
    for (const id of ids) {
      const row = tocRow(fixture, id);
      for (const key of ['unit_measure', 'unit_measure.label', 'unit_mult', 'unit_mult.label']) {
        delete row[key];
      }
    }
    return fixture;
  }

  it('labels the unit from the structure and sends SDMX no data request', async () => {
    const wired = wire();
    const { result, enrichment } = await query({
      dataset_ids: [UNE],
      ref_areas: ['USA'],
      time: '2025',
    });
    expect(sdmxPaths(wired)).toEqual(['/rest/dataflow/ILO/DF_UNE_DEAP_SEX_AGE_RT/latest']);
    expect(result.datasets[0]?.unit).toEqual({
      measure: 'PT',
      measure_label: 'Percentage',
      type: 'RT',
      type_label: 'Rate',
      multiplier: 0,
      multiplier_label: 'Units',
    });
    expect(enrichment.notice).toBeUndefined();
  });

  it("keeps the catalog's unit when the structure service is down: inline, rendered, and staged", async () => {
    const canvas = canvasOn();
    wire({ canvas, observations: { previewChars: 3_000 }, routes: [STRUCTURE_DOWN] });
    const ctx = newContext();
    const { result, enrichment } = await query(
      { dataset_ids: [UNE], ref_areas: ['USA', 'X01', 'KEN'] },
      ctx,
    );
    expect(result.datasets[0]?.unit).toEqual(PERCENT_UNIT_FROM_TOC);
    expect(enrichment.notice ?? '').not.toMatch(/\bunit\b/);
    expect(render(result)).toContain('Unit: % (PT) · type RT · multiplier 0 (units)');
    const name = result.dataframe?.name ?? '';
    expect(name).toMatch(/^df_/);
    expect(
      await canvasRows(
        canvas,
        ctx,
        `SELECT unit, unit_multiplier, count(*)::INTEGER AS n FROM ${name} GROUP BY ALL`,
      ),
    ).toEqual([{ unit: '%', unit_multiplier: 0, n: 52 }]);
    const meta = await ctx.state.get<DataframeMeta>(`df-meta/${name}`);
    expect(meta?.datasets).toEqual([
      expect.objectContaining({
        datasetId: UNE,
        unit: '%',
        unitMeasure: 'PT',
        unitType: 'RT',
        unitMultiplier: 0,
        unitMultiplierLabel: 'units',
      }),
    ]);
    expect(meta?.datasets[0]).not.toHaveProperty('unitTypeLabel');
  });

  it('names only the datasets whose catalog row lists no unit, without pointing at the label, on both surfaces', async () => {
    const fixture = withoutUnits('UNE_2EAP_SEX_AGE_RT_A');
    wire({ fixture });
    const args = { dataset_ids: [UNE, 'UNE_2EAP_SEX_AGE_RT_A'], ref_areas: ['USA'], time: '2025' };
    const { result, enrichment } = await query(args);
    expect(result.datasets.map((dataset) => Boolean(dataset.unit))).toEqual([true, false]);
    // The sentences naming USA, which has no UNE_2EAP rows here, follow the unit sentence.
    const notice =
      'The ILOSTAT catalog lists no unit for UNE_2EAP_SEX_AGE_RT_A. USA returned no UNE_2EAP_SEX_AGE_RT_A rows for these filters and period. The area list of UNE_2EAP_SEX_AGE_RT_A is unavailable from the ILOSTAT structure service, so no area is marked not_covered.';
    expect(enrichment.notice).toBe(notice);
    expect(render(result)).toContain('Unit: not resolved');

    const contract = await runToolContract(queryIndicatorTool, args);
    expect(contract.isError).toBeFalsy();
    expect(contract.structuredContent).toMatchObject({ notice });
    expect(contentText(contract)).toContain(notice);
    expect(contentText(contract)).not.toContain('parenthetical');
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
      'sex does not apply to LAP_2GDP_NOC_RT_A, which has no sex breakdown; its rows are not narrowed by it. classif1 does not apply to LAP_2GDP_NOC_RT_A, which has no classif1 breakdown; its rows are not narrowed by it.',
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
    const sent = sentParams(wired);
    expect(sent).toMatchObject({ ref_area: 'USA+KEN', sex: 'SEX_T' });
    // latest_only reduces the full history per series, so upstream's latest-year filter is not sent
    expect(sent).not.toHaveProperty('latestyear');
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

describe('dataset batch', () => {
  const EMP_TEMP = 'EMP_TEMP_SEX_AGE_NB_A';
  const EAP_DWAP = 'EAP_DWAP_SEX_AGE_RT_A';
  const EMP_DWAP = 'EMP_DWAP_SEX_AGE_RT_A';
  const deferredNotice = (named: string, count: number) =>
    `Queried the first 3 distinct datasets; ${count} more ${count === 1 ? 'was' : 'were'} not fetched: ${named}. Call ilostat_query_indicator again with dataset_ids set to remaining_dataset_ids and the same filters to get ${count === 1 ? 'it' : 'them'}.`;

  it('queries the first three of four distinct datasets and names the fourth on both surfaces', async () => {
    const wired = wire();
    const result = await runToolContract(queryIndicatorTool, {
      dataset_ids: [UNE, EMP_TEMP, EAP_DWAP, EMP_DWAP],
      ref_areas: ['USA'],
      sex: ['SEX_T'],
      classif1: ['AGE_YTHADULT_YGE15'],
      time: '2023',
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Output & Record<string, unknown>;
    expect(structured.remaining_dataset_ids).toEqual([EMP_DWAP]);
    expect(structured.datasets.map((dataset) => dataset.dataset_id)).toEqual([
      UNE,
      EMP_TEMP,
      EAP_DWAP,
    ]);
    expect(structured.applied_filters).toMatchObject({ dataset_ids: [UNE, EMP_TEMP, EAP_DWAP] });
    // each unit from its catalog row; only UNE_DEAP has an SDMX structure here, so the others keep the ToC labels
    expect(structured.datasets.map((dataset) => dataset.unit)).toEqual([
      {
        measure: 'PT',
        measure_label: 'Percentage',
        type: 'RT',
        type_label: 'Rate',
        multiplier: 0,
        multiplier_label: 'Units',
      },
      {
        measure: 'PS',
        measure_label: 'persons',
        type: 'NB',
        multiplier: 3,
        multiplier_label: 'thousands',
      },
      PERCENT_UNIT_FROM_TOC,
    ]);
    expect(structured.rows.map((row) => [row.dataset_id, row.period, row.value])).toEqual([
      [UNE, '2023', 3.638],
    ]);
    const notice = deferredNotice(EMP_DWAP, 1);
    expect(structured.notice).toContain(notice);
    expect(structured.notice).not.toContain('lists no unit');
    // one request, for the queried three only
    expect(sentParams(wired).id).toBe(`${UNE}+${EMP_TEMP}+${EAP_DWAP}`);
    const text = contentText(result);
    expect(text).toContain(`**Remaining dataset IDs (not queried):** ${EMP_DWAP}`);
    expect(text).toContain(notice);
    expect(text).toContain(`**Applied filters:** datasets ${UNE}, ${EMP_TEMP}, ${EAP_DWAP} ·`);
    expect(text).toContain('Unit: persons (PS) · type NB · multiplier 3 (thousands)');
    expect(text).not.toContain('Unit: not resolved');
  });

  it('dedupes before counting, so four spellings of two datasets defer nothing', async () => {
    const wired = wire();
    const result = await runToolContract(queryIndicatorTool, {
      dataset_ids: [UNE, 'une_deap_sex_age_rt_a', `DF_${UNE}`, EMP_TEMP],
      ref_areas: ['USA'],
      time: '2023',
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Output & Record<string, unknown>;
    expect(structured).not.toHaveProperty('remaining_dataset_ids');
    expect(structured.applied_filters).toMatchObject({ dataset_ids: [UNE, EMP_TEMP] });
    expect(structured.applied_filters).not.toHaveProperty('latest_mode');
    expect(String(structured.notice ?? '')).not.toContain('not fetched');
    expect(contentText(result)).not.toContain('Remaining dataset IDs');
    expect(sentParams(wired).id).toBe(`${UNE}+${EMP_TEMP}`);
  });

  it('returns the remainder as canonical IDs in request order, deduplicated, across joined elements', async () => {
    const wired = wire();
    const { result, enrichment } = await query({
      dataset_ids: [
        `${UNE}+df_eap_dwap_sex_age_rt_a`,
        'emp_dwap_sex_age_rt',
        `lap_2gdp_noc_rt_a,${UNE}`,
        'DF_EMP_TEMP_SEX_AGE_NB_A',
        'lap_2gdp_noc_rt',
      ],
      ref_areas: ['KEN'],
    });
    expect(result.remaining_dataset_ids).toEqual(['LAP_2GDP_NOC_RT_A', EMP_TEMP]);
    expect(enrichment.applied_filters).toMatchObject({ dataset_ids: [UNE, EAP_DWAP, EMP_DWAP] });
    expect(enrichment.notice).toContain(deferredNotice(`LAP_2GDP_NOC_RT_A, ${EMP_TEMP}`, 2));
    expect(sentParams(wired).id).toBe(`${UNE}+${EAP_DWAP}+${EMP_DWAP}`);
  });

  it('runs the unfiltered preflight over the queried datasets only', async () => {
    // SDG_0552 1,830 + LAP_2GDP 6,329 + POP_2POP 34,440 = 42,599 rows; with UNE_DEAP it would be 364,827
    const wired = wire({ observations: { maxRows: 50_000 } });
    const { result } = await query({
      dataset_ids: ['SDG_0552_NOC_RT_A', 'LAP_2GDP_NOC_RT_A', 'POP_2POP_SEX_NB_A', UNE],
    });
    expect(result.remaining_dataset_ids).toEqual([UNE]);
    expect(sentParams(wired).id).toBe('SDG_0552_NOC_RT_A+LAP_2GDP_NOC_RT_A+POP_2POP_SEX_NB_A');
  });

  it('stages provenance for the queried datasets only', async () => {
    const canvas = canvasOn();
    wire({ canvas, observations: { previewChars: 1_000 } });
    const ctx = newContext();
    const { result } = await query(
      { dataset_ids: [UNE, EMP_TEMP, EAP_DWAP, EMP_DWAP], ref_areas: ['USA', 'KEN'] },
      ctx,
    );
    const name = result.dataframe?.name ?? '';
    expect(name).toMatch(/^df_/);
    const meta = await ctx.state.get<DataframeMeta>(`df-meta/${name}`);
    expect(meta?.queryParams).toMatchObject({ dataset_ids: [UNE, EMP_TEMP, EAP_DWAP] });
    expect(meta?.datasets.map((dataset) => dataset.datasetId)).toEqual([UNE, EMP_TEMP, EAP_DWAP]);
    expect(result.remaining_dataset_ids).toEqual([EMP_DWAP]);
  });

  it('fails unknown_dataset for an unknown ID in fifth place, before any upstream request', async () => {
    const wired = wire();
    const error = await failure({
      dataset_ids: [UNE, EMP_TEMP, EAP_DWAP, EMP_DWAP, 'NOPE_NOT_REAL_A'],
    });
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({
      reason: 'unknown_dataset',
      datasetIds: ['NOPE_NOT_REAL_A'],
    });
    expect(dataUrls(wired)).toHaveLength(0);
  });

  it('fails a several-frequency bare code in fifth place as unknown_dataset', async () => {
    const wired = wire();
    const error = await failure({
      dataset_ids: [UNE, EMP_TEMP, EAP_DWAP, EMP_DWAP, 'une_deap_sex_age_rt'],
    });
    expect(error.data).toMatchObject({
      reason: 'unknown_dataset',
      indicator: 'UNE_DEAP_SEX_AGE_RT',
    });
    expect(dataUrls(wired)).toHaveLength(0);
  });

  it('checks a sub-annual time against a deferred dataset too, before any upstream request', async () => {
    const fixture = observationCatalogFixture();
    fixture.indicatorToc.push({
      ...tocRow(fixture, 'EMP_TEMP_SEX_INS_DSB_NB_Q'),
      id: 'LUU_XLU2_SEX_RT_Q',
      indicator: 'LUU_XLU2_SEX_RT',
      'indicator.label':
        'Combined rate of unemployment and time-related underemployment by sex (%)',
    });
    const wired = wire({ fixture });
    const error = await failure({
      dataset_ids: ['UNE_DEAP_SEX_AGE_RT_Q', 'EMP_TEMP_SEX_INS_DSB_NB_Q', 'LUU_XLU2_SEX_RT_Q', UNE],
      ref_areas: ['USA'],
      sex: ['SEX_T'],
      time: '2024Q1',
    });
    expect(error.data).toMatchObject({ reason: 'invalid_period' });
    expect(error.message).toBe(
      `time 2024Q1 is a quarterly period, but ${UNE} (A) is not at that frequency.`,
    );
    expect(dataUrls(wired)).toHaveLength(0);
  });

  it('checks an aggregate against a deferred dataset too, before any upstream request', async () => {
    const wired = wire();
    const error = await failure({
      dataset_ids: [UNE, EMP_DWAP, EAP_DWAP, EMP_TEMP],
      ref_areas: ['X01'],
    });
    expect(error.data).toMatchObject({ reason: 'aggregates_unavailable', datasetIds: [EMP_TEMP] });
    expect(dataUrls(wired)).toHaveLength(0);
  });

  it('names at most ten unknown IDs in the message and counts the rest, every one kept in data', async () => {
    wire();
    const unknown = Array.from({ length: 12 }, (_, index) => `NOPE_${index}_A`);
    const error = await failure({ dataset_ids: [UNE, ...unknown] });
    expect(error.message).toBe(
      `No ILOSTAT dataset has the ID ${unknown.slice(0, 10).join(', ')} and 2 more.`,
    );
    expect(error.data).toMatchObject({ reason: 'unknown_dataset', datasetIds: unknown });
  });
});

describe('latest_only', () => {
  /** CHN's recorded full history behind the emulator: 133 rows over 84 series ending in 2000, 2021, and 2022. */
  const CHN_ROUTE = indicatorDataRoute(fixtureText(INDICATOR_CSV.chnUneDeap));
  const LATEST_YEAR_NOTICE =
    "latest_only fell back to ILOSTAT's latest period per area and dataset, because this request's full history is too large or too slow to read series by series in one call: a series (one sex, classif1, or classif2 code) whose data ends before its dataset's newest period in an area may be missing. Narrow with time_from or classif1 to get each series' own latest period; sex or fewer ref_areas alone may still read too much and fall back again.";
  const LATEST_TIMEOUT_HINT =
    'Narrow the request with time_from or classif1, then call again; sex or fewer ref_areas alone may still read too much.';
  const TWO_SLICES = {
    dataset_ids: [UNE],
    ref_areas: ['CHN'],
    sex: ['SEX_T'],
    classif1: ['AGE_YTHADULT_Y15-24', 'AGE_YTHADULT_YGE15'],
    latest_only: true,
  };
  /** One USA SEX_T 15+ row per year from 1000, the shape of the recorded bodies. */
  const usaYear = (index: number) =>
    `"USA","BA:453","UNE_DEAP_SEX_AGE_RT","SEX_T","AGE_YTHADULT_YGE15","${1000 + index}",${index % 10},`;
  const isLatestYear = (request: Request) =>
    upstreamParams(new URL(request.url)).get('latestyear') === 'TRUE';
  /** `/data/indicator`: the recorded USA rows behind the emulator under `latestyear=TRUE`, `full` otherwise. */
  const fullOrLatest = (full: () => Response): FetchMockRoute => ({
    method: 'GET',
    match: (request) => isIndicatorData(request),
    respond: (request) =>
      isLatestYear(request)
        ? csvResponse(filterIndicatorCsv(UNE_CSV, new URL(request.url)))
        : full(),
  });

  /**
   * {@link wire} with every `/data/indicator` request answered by `respond`, which is
   * handed the request's own abort signal — a body built on it fails with the abort
   * reason, as a real fetch body does. Other requests go to the fixture routes.
   */
  function wireIndicatorFetch(
    respond: (url: URL, signal: AbortSignal) => Response,
    options: WireOptions = {},
  ) {
    const urls: URL[] = [];
    let fixtures: FetchFn | undefined;
    const fetch: FetchFn = (input, init) => {
      const url = new URL(input);
      if (url.origin !== RPLUMBER_ORIGIN || url.pathname !== '/data/indicator') {
        if (!fixtures) throw new Error('fetch before wiring');
        return fixtures(input, init);
      }
      urls.push(url);
      return Promise.resolve(respond(url, init?.signal ?? new AbortController().signal));
    };
    const wired = wire({ ...options, rplumber: { ...options.rplumber, fetch } });
    fixtures = wired.http.fetch;
    return urls;
  }

  /** A 200 whose body sends the CSV header, then nothing until its request is aborted. */
  function hangingBody(signal: AbortSignal): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${CSV_HEADER}\n`));
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  }

  const latestYearSent = (url: URL) => upstreamParams(url).get('latestyear') === 'TRUE';
  /** Stall and body timeouts past the test timeout, so they never end a hanging read in a timer's place. */
  const SLOW_BODY_TIMEOUTS = { ...FAST_TIMEOUTS, stallMs: 60_000, bodyMs: 60_000 };

  it("keeps each slice's own latest period — youth 2021 beside 15+ 2022 — in one request, on both surfaces", async () => {
    const wired = wire({ routes: [CHN_ROUTE] });
    const result = await runToolContract(queryIndicatorTool, TWO_SLICES);
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Output & Record<string, unknown>;
    expect(
      structured.rows.map(({ classif1, period, value, source, basis }) => ({
        classif1,
        period,
        value,
        source,
        basis,
      })),
    ).toEqual([
      {
        classif1: 'AGE_YTHADULT_YGE15',
        period: '2022',
        value: 4.569,
        source: 'BA:16044',
        basis: 'reported',
      },
      {
        classif1: 'AGE_YTHADULT_Y15-24',
        period: '2021',
        value: 14.25,
        source: 'BA:16044',
        basis: 'reported',
      },
    ]);
    expect(structured).toMatchObject({
      row_count: 2,
      summary: { period_min: '2021', period_max: '2022', complete: true },
    });
    expect(structured).not.toHaveProperty('notice');
    expect(structured.applied_filters).toMatchObject({
      latest_only: true,
      latest_mode: 'per_series',
    });
    const sent = sentParams(wired);
    expect(sent).not.toHaveProperty('latestyear');
    expect(sent).toMatchObject({ ref_area: 'CHN', sex: 'SEX_T' });
    const text = contentText(result);
    expect(text).toContain('latest_only true · latest_mode per_series ·');
    expect(text).toContain(
      '#### UNE_DEAP_SEX_AGE_RT_A · CHN · SEX_T · AGE_YTHADULT_Y15-24 · BA:16044',
    );
    expect(text).toContain('- 2021: 14.25');
    expect(text).toContain('- 2022: 4.569');
    expect(text).not.toContain(LATEST_YEAR_NOTICE);
  });

  it('returns one row per series with no breakdown filter: all 84 of CHN, each at its own latest year', async () => {
    const wired = wire({ routes: [CHN_ROUTE] });
    const { result, enrichment } = await query({
      dataset_ids: [UNE],
      ref_areas: ['CHN'],
      latest_only: true,
      limit: 100,
    });
    const seriesOf = (row: { sex?: string | undefined; classif1?: string | undefined }) =>
      `${row.sex}|${row.classif1}`;
    expect(result.row_count).toBe(84);
    expect(new Set(result.rows.map(seriesOf)).size).toBe(84);
    // the recorded history: 82 series end in 2000, youth total in 2021, 15+ total in 2022
    const byYear = Map.groupBy(result.rows, (row) => row.period);
    expect(byYear.get('2000')).toHaveLength(82);
    expect(byYear.get('2021')?.map(seriesOf)).toEqual(['SEX_T|AGE_YTHADULT_Y15-24']);
    expect(byYear.get('2022')?.map(seriesOf)).toEqual(['SEX_T|AGE_YTHADULT_YGE15']);
    expect(result.rows.find((row) => seriesOf(row) === 'SEX_F|AGE_YTHADULT_YGE15')).toMatchObject({
      period: '2000',
      value: 3.841,
      source: 'AA:992',
    });
    // the 84 rows pass the default preview budget, so the first page says why nothing was staged
    expect(enrichment.notice).toBe(
      'Showing rows 1–84 of 84. Dataframes are off in this deployment, so the result is not staged for SQL.',
    );
    expect(sentParams(wired)).not.toHaveProperty('latestyear');
  });

  it('keeps every source at the latest period under source_selection all, bounded by time_to', async () => {
    const wired = wire({ routes: [indicatorDataRoute(fixtureText(INDICATOR_CSV.bestSourceAll))] });
    const { result } = await query({
      dataset_ids: [UNE],
      ref_areas: ['KEN'],
      sex: ['SEX_T'],
      source_selection: 'all',
      time_to: '2019',
      latest_only: true,
    });
    expect(
      result.rows.map(({ period, source, best_source }) => ({ period, source, best_source })),
    ).toEqual([
      { period: '2019', source: 'BX:3465', best_source: true },
      { period: '2019', source: 'AA:1311', best_source: false },
    ]);
    expect(sentParams(wired)).toMatchObject({ best_source: 'all', timeto: '2019' });
  });

  it('returns an empty result whole when no series has a row in the window', async () => {
    wire({ routes: [CHN_ROUTE] });
    const { result } = await query({ ...TWO_SLICES, time_from: '2023' });
    expect(result).toMatchObject({ rows: [], row_count: 0, summary: { complete: true } });
  });

  it('falls back to the latest period per area when the full-history estimate passes the ceiling, disclosed on both surfaces', async () => {
    const wired = wire({ observations: { maxRows: 100_000 } });
    const result = await runToolContract(queryIndicatorTool, {
      dataset_ids: [UNE],
      latest_only: true,
    });
    expect(result.isError).toBeFalsy();
    const urls = dataUrls(wired);
    expect(urls).toHaveLength(1);
    expect(urls[0] && latestYearSent(urls[0])).toBe(true);
    const structured = result.structuredContent as Output & Record<string, unknown>;
    expect(structured.notice).toBe(LATEST_YEAR_NOTICE);
    expect(structured.applied_filters).toMatchObject({ latest_mode: 'latest_year' });
    expect(contentText(result)).toContain('latest_only true · latest_mode latest_year ·');
    // the emulated latestyear: one period per area — KEN 2021, USA 2025, X01 2027
    expect(new Set(structured.rows.map((row) => `${row.ref_area} ${row.period}`))).toEqual(
      new Set(['KEN 2021', 'USA 2025', 'X01 2027']),
    );
    expect(contentText(result)).toContain(LATEST_YEAR_NOTICE);
  });

  it('reads per series once ref_areas and time_from bring the estimate under the ceiling', async () => {
    // UNE_DEAP holds 322,228 rows over 312 areas and 1947–2027: one area is about 1,033 rows, from 2000 about 357
    const one = wire({ observations: { maxRows: 1_000 } });
    const area = await query({ dataset_ids: [UNE], ref_areas: ['USA'], latest_only: true });
    expect(area.enrichment.notice).toBe(LATEST_YEAR_NOTICE);
    expect(dataUrls(one).map(latestYearSent)).toEqual([true]);

    disposeIlostatServices();
    const narrowed = wire({ observations: { maxRows: 1_000 } });
    const windowed = await query({
      dataset_ids: [UNE],
      ref_areas: ['USA'],
      time_from: '2000',
      latest_only: true,
    });
    expect(windowed.enrichment.notice).toBeUndefined();
    expect(dataUrls(narrowed).map(latestYearSent)).toEqual([false]);
  });

  it('falls back with a second request once the per-series read passes the row ceiling, cancelling the first', async () => {
    const stream = streamedCsv(CSV_HEADER, 1_001, usaYear);
    const wired = wire({
      routes: [fullOrLatest(() => stream.response())],
      observations: { maxRows: 1_000 },
    });
    const result = await runToolContract(queryIndicatorTool, {
      dataset_ids: [UNE],
      ref_areas: ['USA'],
      sex: ['SEX_T'],
      latest_only: true,
    });
    expect(result.isError).toBeFalsy();
    expect(dataUrls(wired).map(latestYearSent)).toEqual([false, true]);
    expect(stream.cancelled).toBe(true);
    const structured = result.structuredContent as Output & Record<string, unknown>;
    expect(structured.notice).toBe(LATEST_YEAR_NOTICE);
    expect(structured.applied_filters).toMatchObject({ latest_mode: 'latest_year' });
    // the recorded USA SEX_T rows at upstream's latest period
    expect(new Set(structured.rows.map((row) => row.period))).toEqual(new Set(['2025']));
    expect(contentText(result)).toContain(LATEST_YEAR_NOTICE);
  });

  it('sends a later page of a fallen-back request straight to the fallback, with no full-history request', async () => {
    const stream = streamedCsv(CSV_HEADER, 1_001, usaYear);
    const wired = wire({
      routes: [fullOrLatest(() => stream.response())],
      observations: { maxRows: 1_000 },
    });
    const args = { ...USA_SEX_T, limit: 1 };
    const first = await query(args);
    expect(dataUrls(wired).map(latestYearSent)).toEqual([false, true]);
    expect(first.result.next_offset).toBe(1);

    const pulledByFirst = stream.pulled;
    const second = await query({ ...args, offset: 1 });
    // the latestyear rows were cached on the first page, so the second sends no request at all
    expect(dataUrls(wired).map(latestYearSent)).toEqual([false, true]);
    expect(stream.pulled).toBe(pulledByFirst);
    expect(second.enrichment.applied_filters).toMatchObject({ latest_mode: 'latest_year' });
    expect(String(second.enrichment.notice).startsWith(LATEST_YEAR_NOTICE)).toBe(true);
    expect(second.result.row_count).toBe(first.result.row_count);
    expect(second.result.rows).toHaveLength(1);
    expect(second.result.rows[0]).not.toEqual(first.result.rows[0]);
    expect(second.result.rows[0]?.period).toBe('2025');

    // a repeat call of the same request skips the doomed read too
    await query(args);
    expect(dataUrls(wired).map(latestYearSent)).toEqual([false, true]);
  });

  it('forgets a fallback with the response cache TTL, then reads per series again', async () => {
    let current = FIXED_NOW.getTime();
    const stream = streamedCsv(CSV_HEADER, 1_001, usaYear);
    const wired = wire({
      routes: [fullOrLatest(() => stream.response())],
      observations: { maxRows: 1_000, cacheTtlMs: 1_000 },
      now: () => new Date(current),
    });
    const args = { ...USA_SEX_T, limit: 1 };
    await query(args);
    current += 999;
    await query({ ...args, offset: 1 });
    expect(dataUrls(wired).map(latestYearSent)).toEqual([false, true]);
    current += 1;
    const expired = await query({ ...args, offset: 1 });
    expect(dataUrls(wired).map(latestYearSent)).toEqual([false, true, false, true]);
    expect(expired.enrichment.applied_filters).toMatchObject({ latest_mode: 'latest_year' });
  });

  it('remembers no fallback with the response cache off', async () => {
    const stream = streamedCsv(CSV_HEADER, 1_001, usaYear);
    const wired = wire({
      routes: [fullOrLatest(() => stream.response())],
      observations: { maxRows: 1_000, cacheTtlMs: 0 },
    });
    await query(USA_SEX_T);
    await query(USA_SEX_T);
    expect(dataUrls(wired).map(latestYearSent)).toEqual([false, true, false, true]);
  });

  it('stays per series when the full history holds exactly the row ceiling', async () => {
    const stream = streamedCsv(CSV_HEADER, 1_000, usaYear);
    const wired = wire({
      routes: [fullOrLatest(() => stream.response())],
      observations: { maxRows: 1_000 },
    });
    const { result, enrichment } = await query({
      dataset_ids: [UNE],
      ref_areas: ['USA'],
      sex: ['SEX_T'],
      latest_only: true,
    });
    expect(dataUrls(wired).map(latestYearSent)).toEqual([false]);
    expect(enrichment.notice).toBeUndefined();
    expect(result.rows.map(({ period, value }) => ({ period, value }))).toEqual([
      { period: '1999', value: 9 },
    ]);
  });

  it('falls back when the full-history body passes its byte cap before the row ceiling', async () => {
    // 700 rows of about 2 KiB each pass the body cap of 1 KiB per allowed row long before the last
    const padded = (index: number) => `${usaYear(index)},"${'n'.repeat(2_000)}"`;
    const stream = streamedCsv(`${CSV_HEADER},"note_source"`, 700, padded);
    const wired = wire({
      routes: [fullOrLatest(() => stream.response())],
      observations: { maxRows: 1_000 },
    });
    const { enrichment } = await query({
      dataset_ids: [UNE],
      ref_areas: ['USA'],
      sex: ['SEX_T'],
      latest_only: true,
    });
    expect(dataUrls(wired).map(latestYearSent)).toEqual([false, true]);
    expect(stream.pulled).toBeLessThan(700);
    expect(enrichment.notice).toBe(LATEST_YEAR_NOTICE);
  });

  it('falls back when the per-series read outlasts its share of the time budget', async () => {
    const urls = wireIndicatorFetch(
      (url, signal) =>
        latestYearSent(url) ? csvResponse(filterIndicatorCsv(UNE_CSV, url)) : hangingBody(signal),
      { observations: { perSeriesReadMs: 50 }, rplumber: { timeouts: SLOW_BODY_TIMEOUTS } },
    );
    const { result, enrichment } = await query({
      dataset_ids: [UNE],
      ref_areas: ['USA'],
      sex: ['SEX_T'],
      latest_only: true,
    });
    expect(urls.map(latestYearSent)).toEqual([false, true]);
    expect(enrichment.notice).toBe(LATEST_YEAR_NOTICE);
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('fails Timeout with a narrowing hint when the whole call outlasts its deadline, on both surfaces', async () => {
    // The deadline sits well past the per-series budget, so the fallback request is sent before it fires even under load
    const urls = wireIndicatorFetch((_url, signal) => hangingBody(signal), {
      observations: { perSeriesReadMs: 50, latestDeadlineMs: 600 },
      rplumber: { timeouts: SLOW_BODY_TIMEOUTS },
    });
    const args = { dataset_ids: [UNE], ref_areas: ['USA'], sex: ['SEX_T'], latest_only: true };
    const error = await failure(args);
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.message).toBe("latest_only did not finish within this call's 0.6 s time budget.");
    expect(error.data).toMatchObject({ recovery: { hint: LATEST_TIMEOUT_HINT } });
    expect(urls.map(latestYearSent)).toEqual([false, true]);

    const result = await runToolContract(queryIndicatorTool, args);
    expect(result.isError).toBe(true);
    expect(contentText(result)).toContain(LATEST_TIMEOUT_HINT);
  });

  it("propagates the caller's cancellation of the per-series read, with no fallback request", async () => {
    const controller = new AbortController();
    const urls = wireIndicatorFetch((_url, signal) => {
      setTimeout(() => controller.abort(new Error('caller went away')), 20);
      return hangingBody(signal);
    });
    const ctx = createMockContext({ errors: queryIndicatorTool.errors, signal: controller.signal });
    await expect(
      query({ dataset_ids: [UNE], ref_areas: ['USA'], sex: ['SEX_T'], latest_only: true }, ctx),
    ).rejects.toThrow('caller went away');
    expect(urls.map(latestYearSent)).toEqual([false]);
  });

  /** A 200 whose body sends the CSV header and one row, then fails as a dropped connection does. */
  function droppedBody(): Response {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.error(new TypeError('terminated'));
          return;
        }
        sent = true;
        controller.enqueue(new TextEncoder().encode(`${CSV_HEADER}\n${usaYear(0)}\n`));
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  }

  const USA_SEX_T = { dataset_ids: [UNE], ref_areas: ['USA'], sex: ['SEX_T'], latest_only: true };

  it('falls back when the per-series body stalls mid-response', async () => {
    const urls = wireIndicatorFetch(
      (url, signal) =>
        latestYearSent(url) ? csvResponse(filterIndicatorCsv(UNE_CSV, url)) : hangingBody(signal),
      { rplumber: { timeouts: { ...SLOW_BODY_TIMEOUTS, stallMs: 50 } } },
    );
    const { result, enrichment } = await query(USA_SEX_T);
    expect(urls.map(latestYearSent)).toEqual([false, true]);
    expect(enrichment.notice).toBe(LATEST_YEAR_NOTICE);
    expect(enrichment.applied_filters).toMatchObject({ latest_mode: 'latest_year' });
    expect(new Set(result.rows.map((row) => row.period))).toEqual(new Set(['2025']));
  });

  it('falls back when the per-series body drops mid-response', async () => {
    const urls = wireIndicatorFetch((url) =>
      latestYearSent(url) ? csvResponse(filterIndicatorCsv(UNE_CSV, url)) : droppedBody(),
    );
    const { result, enrichment } = await query(USA_SEX_T);
    expect(urls.map(latestYearSent)).toEqual([false, true]);
    expect(enrichment.notice).toBe(LATEST_YEAR_NOTICE);
    expect(new Set(result.rows.map((row) => row.period))).toEqual(new Set(['2025']));
  });

  it('propagates a failure before the per-series body, with no fallback request', async () => {
    const urls = wireIndicatorFetch((url) =>
      latestYearSent(url)
        ? csvResponse(filterIndicatorCsv(UNE_CSV, url))
        : new Response('unavailable', { status: 503 }),
    );
    const error = await failure(USA_SEX_T);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(urls.map(latestYearSent)).toEqual([false]);
  });

  it.each([
    ['a failure before the per-series body', 'unavailable'],
    ["the caller's cancellation of the per-series read", 'cancelled'],
  ] as const)(
    'records no fallback for %s: the next call reads per series',
    async (_case, first) => {
      const controller = new AbortController();
      let fullHistoryReads = 0;
      const urls = wireIndicatorFetch((url, signal) => {
        if (latestYearSent(url)) return csvResponse(filterIndicatorCsv(UNE_CSV, url));
        fullHistoryReads += 1;
        if (fullHistoryReads > 1) return csvResponse(filterIndicatorCsv(UNE_CSV, url));
        if (first === 'unavailable') return new Response('unavailable', { status: 503 });
        setTimeout(() => controller.abort(new Error('caller went away')), 20);
        return hangingBody(signal);
      });
      const ctx = createMockContext({
        errors: queryIndicatorTool.errors,
        signal: controller.signal,
      });
      await expect(query(USA_SEX_T, ctx)).rejects.toBeDefined();

      const { enrichment } = await query(USA_SEX_T);
      expect(urls.map(latestYearSent)).toEqual([false, false]);
      expect(enrichment.applied_filters).toMatchObject({ latest_mode: 'per_series' });
    },
  );

  it('fails Timeout when the deadline passes during a retry backoff, with no fallback request', async () => {
    // A backoff of 22.5 s or more that the deadline failed to cut would outlast the test timeout
    const urls = wireIndicatorFetch(() => new Response('unavailable', { status: 503 }), {
      rplumber: { retry: { maxRetries: 2, baseDelayMs: 30_000, deadlineMs: 600_000 } },
      observations: { latestDeadlineMs: 150 },
    });
    const error = await failure(USA_SEX_T);
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.message).toBe("latest_only did not finish within this call's 0.15 s time budget.");
    expect(error.data).toMatchObject({ recovery: { hint: LATEST_TIMEOUT_HINT } });
    expect(urls.map(latestYearSent)).toEqual([false]);
  });

  it('fails Timeout with no fallback when the deadline passes before the per-series read budget', async () => {
    const urls = wireIndicatorFetch((_url, signal) => hangingBody(signal), {
      observations: { perSeriesReadMs: 10_000, latestDeadlineMs: 100 },
    });
    const error = await failure(USA_SEX_T);
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.message).toBe("latest_only did not finish within this call's 0.1 s time budget.");
    expect(urls.map(latestYearSent)).toEqual([false]);
  });

  it.each([
    ['best', false],
    ['all', true],
  ] as const)(
    'sizes the upfront estimate from n.records under best, n.records.all beyond it: %s',
    async (source_selection, fallsBack) => {
      // UNE_DEAP_SEX_AGE_RT_A: n.records 322,228 and n.records.all 365,493, either side of the ceiling
      const wired = wire({ observations: { maxRows: 340_000 } });
      const { enrichment } = await query({
        dataset_ids: [UNE],
        source_selection,
        latest_only: true,
      });
      expect(dataUrls(wired).map(latestYearSent)).toEqual([fallsBack]);
      expect(enrichment.applied_filters).toMatchObject({
        latest_mode: fallsBack ? 'latest_year' : 'per_series',
      });
    },
  );

  it('serves a repeat per-series call from the cache', async () => {
    const wired = wire({ routes: [CHN_ROUTE] });
    const first = await query(TWO_SLICES);
    const second = await query(TWO_SLICES);
    expect(second.result).toEqual(first.result);
    expect(dataUrls(wired)).toHaveLength(1);
  });

  it('with dataframes off, pages the per-series rows, every held row counted on each page', async () => {
    const wired = wire({ routes: [CHN_ROUTE], observations: { previewChars: 2_000 } });
    const args = { dataset_ids: [UNE], ref_areas: ['CHN'], latest_only: true };
    const first = await query(args);
    expect(first.result.rows).toHaveLength(50);
    expect(first.result.next_offset).toBe(50);
    // every held row is counted, not only the page's
    expect(first.result.row_count).toBe(84);
    expect(Object.values(first.result.summary.basis_counts).reduce((sum, n) => sum + n, 0)).toBe(
      84,
    );
    expect(first.result.summary).toMatchObject({
      period_min: '2000',
      period_max: '2022',
      complete: true,
    });
    expect(render(first.result)).toContain('**Summary:** 84 rows ·');
    expect(first.enrichment).toMatchObject({
      truncated: true,
      shown: 50,
      cap: 50,
      notice:
        'Showing rows 1–50 of 84. Dataframes are off in this deployment, so the result is not staged for SQL. Pass next_offset as offset, with the same other arguments, for the next page.',
    });

    const second = await query({ ...args, offset: 50 });
    expect(second.result.rows).toHaveLength(34);
    expect(second.result).not.toHaveProperty('next_offset');
    expect(second.result).toMatchObject({ row_count: 84, summary: { complete: true } });
    expect(second.enrichment).toMatchObject({
      truncated: false,
      shown: 34,
      notice: 'Showing rows 51–84 of 84.',
      applied_filters: { latest_mode: 'per_series' },
    });
    const seriesOf = (row: { sex?: string | undefined; classif1?: string | undefined }) =>
      `${row.sex}|${row.classif1}`;
    expect(new Set([...first.result.rows, ...second.result.rows].map(seriesOf)).size).toBe(84);
    // the full history was read whole and cached on the first page; the second sends no request
    expect(dataUrls(wired)).toHaveLength(1);
  });

  it('with dataframes off, counts per-series rows past the 5,001 a page reads as exact: complete, its areas without rows named', async () => {
    // 6,000 USA series, one row each (a classif2 code apiece), all held before the page is cut
    const series = 6_000;
    const stream = streamedCsv(
      '"ref_area","source","indicator","sex","classif1","classif2","time","obs_value","obs_status"',
      series,
      (index) =>
        `"USA","BA:453","UNE_DEAP_SEX_AGE_RT","SEX_T","AGE_YTHADULT_YGE15","SYN_${index}","2024",${index % 10},`,
    );
    const wired = wire({ routes: [dataRoute(() => stream.response())] });
    const { result, enrichment } = await query({
      dataset_ids: [UNE],
      ref_areas: ['USA', 'KEN'],
      latest_only: true,
    });
    expect(dataUrls(wired).map(latestYearSent)).toEqual([false]);
    expect(enrichment.applied_filters).toMatchObject({ latest_mode: 'per_series' });
    expect(result.rows).toHaveLength(50);
    expect(result.next_offset).toBe(50);
    expect(result.row_count).toBe(series);
    expect(result.summary).toMatchObject({
      complete: true,
      areas_without_rows: [{ dataset_id: UNE, ref_area: 'KEN', reason: 'no_rows' }],
    });
    expect(enrichment.notice).toBe(
      `KEN returned no ${UNE} rows for these filters and period. Showing rows 1–50 of 6,000. Dataframes are off in this deployment, so the result is not staged for SQL. Pass next_offset as offset, with the same other arguments, for the next page.`,
    );
    const text = render(result);
    expect(text).toContain('**Summary:** 6000 rows ·');
    expect(text).toContain('· complete: true');
    expect(text).toContain(`- ${UNE} · KEN: no_rows`);
  });

  it('when staging fails, says so of the per-series rows', async () => {
    const canvas = faultyCanvas({ at: 'acquire', error: new Error('engine down') });
    canvases.push(canvas);
    wire({ canvas, routes: [CHN_ROUTE], observations: { previewChars: 2_000 } });
    const { enrichment } = await query({
      dataset_ids: [UNE],
      ref_areas: ['CHN'],
      latest_only: true,
    });
    expect(enrichment.notice).toBe(
      'Showing rows 1–50 of 84. Staging the full result as a dataframe failed; call again with offset 0 to retry it. Pass next_offset as offset, with the same other arguments, for the next page.',
    );
  });

  it('pages the latest_year fallback like any stream, its notice ahead of the page notice', async () => {
    const wired = wire({ observations: { maxRows: 100_000, previewChars: 1_000 } });
    const args = { dataset_ids: [UNE], latest_only: true, limit: 3 };
    const first = await query(args);
    // the recorded rows at each area's latest period: KEN 2021, six of USA 2025, X01 2027
    expect(first.result.rows.map((row) => row.ref_area)).toEqual(['KEN', 'USA', 'USA']);
    expect(first.result).toMatchObject({
      row_count: 8,
      next_offset: 3,
      summary: { complete: true },
    });
    expect(first.enrichment.notice).toBe(
      `${LATEST_YEAR_NOTICE} Showing rows 1–3 of 8. Dataframes are off in this deployment, so the result is not staged for SQL. Pass next_offset as offset, with the same other arguments, for the next page.`,
    );

    const second = await query({ ...args, offset: 3 });
    expect(second.result.rows.map((row) => row.ref_area)).toEqual(['USA', 'USA', 'USA']);
    expect(second.result).toMatchObject({ row_count: 8, next_offset: 6 });
    expect(second.enrichment).toMatchObject({
      notice: `${LATEST_YEAR_NOTICE} Showing rows 4–6 of 8. Pass next_offset as offset, with the same other arguments, for the next page.`,
      applied_filters: { latest_mode: 'latest_year' },
    });
    // one latestyear request, read whole and cached on the first page
    expect(dataUrls(wired).map(latestYearSent)).toEqual([true]);
  });
});

describe('zero rows', () => {
  const COVERAGE = `${UNE} covers 1947–2027; widen time_from/time_to or drop time.`;
  const BEST_SOURCE =
    'source_selection best keeps only the preferred source of each area and period, so a secondary source named in sources returns nothing; use source_selection all.';
  /** USA's 15+ total: every code in the UNE_DEAP structure, with rows in 2023–2025 only. */
  const USA_TOTAL = {
    dataset_ids: [UNE],
    ref_areas: ['USA'],
    sex: ['SEX_T'],
    classif1: ['AGE_YTHADULT_YGE15'],
  };

  it('names only the causes it can check, with the zero-row shape', async () => {
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
    // SEX_F and AGE_YTHADULT_Y15-24 are in the structure, and 2020–2021 is inside 1947–2027
    expect(enrichment.notice).toBe(
      [
        `JOR has no ${UNE} data — ilostat_describe_indicator lists the areas it covers.`,
        'No secondary sources exist for this request; use source_selection best or all.',
      ].join(' '),
    );
  });

  it.each([
    ['a range before it', { time_from: '1900', time_to: '1905' }],
    ['a range after it', { time_from: '2030' }],
    ['an end year before it, with latest_only', { time_to: '1946', latest_only: true }],
    ['an exact period outside it', { time: '1946' }],
  ] as const)('names the coverage for %s, and nothing else', async (_, window) => {
    wire();
    const { result, enrichment } = await query({ ...USA_TOTAL, ...window });
    expect(result.row_count).toBe(0);
    expect(enrichment.notice).toBe(COVERAGE);
  });

  it('adds no past-the-end sentence when the result is empty at a later offset, on both surfaces', async () => {
    wire();
    const result = await runToolContract(queryIndicatorTool, {
      ...USA_TOTAL,
      time_from: '1900',
      time_to: '1905',
      offset: 5,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ rows: [], row_count: 0, notice: COVERAGE });
    expect(result.structuredContent).not.toHaveProperty('next_offset');
    const text = contentText(result);
    expect(text).toContain(COVERAGE);
    expect(text).not.toContain('past the end');
  });

  it('leaves the coverage out when the window touches it, even at one end year', async () => {
    wire();
    const { result, enrichment } = await query({
      ...USA_TOTAL,
      time_from: '1900',
      time_to: '1947',
    });
    expect(result.row_count).toBe(0);
    expect(enrichment.notice).toBe('The request matched no observations.');
  });

  it('names a code the structure does not list, not the codes it does', async () => {
    wire();
    const { result, enrichment } = await query({
      ...USA_TOTAL,
      classif1: ['EDU_AGGREGATE_TOTAL'],
      time: '2024',
    });
    expect(result.row_count).toBe(0);
    expect(enrichment.notice).toBe(
      `${UNE} does not use EDU_AGGREGATE_TOTAL — ilostat_describe_indicator ${UNE} lists the codes it uses.`,
    );
  });

  it('names a source under source_selection best, and not under the all it defaults to', async () => {
    wire();
    const best = await query({
      ...USA_TOTAL,
      time: '2024',
      sources: ['BA:829'],
      source_selection: 'best',
    });
    expect(best.result.row_count).toBe(0);
    expect(best.enrichment.notice).toBe(BEST_SOURCE);
    const all = await query({ ...USA_TOTAL, time: '2024', sources: ['BA:829'] });
    expect(all.enrichment.applied_filters).toMatchObject({ source_selection: 'all' });
    expect(all.result.row_count).toBe(0);
    expect(all.enrichment.notice).toBe('The request matched no observations.');
  });

  it('names the areas the structure does not cover — up to 10, then a count — and never a covered one', async () => {
    const { fixture, members } = x36Fixture();
    wire({ fixture });
    const { result, enrichment } = await query({
      dataset_ids: [UNE],
      area_group: 'X36',
      ref_areas: ['USA'],
      time: '1990',
    });
    expect(result.row_count).toBe(0);
    expect(enrichment.applied_filters).toMatchObject({ ref_area_count: 14 });
    expect(enrichment.notice).toBe(
      `${members.slice(0, 10).join(', ')} and 3 more have no ${UNE} data — ilostat_describe_indicator lists the areas it covers.`,
    );
  });

  it('keeps the possible-cause wording for a dataset whose structure is unavailable', async () => {
    wire();
    const { result, enrichment } = await query({
      dataset_ids: [UNE, 'UNE_2EAP_SEX_AGE_RT_A'],
      ref_areas: ['JOR'],
      sex: ['SEX_F'],
    });
    expect(result.row_count).toBe(0);
    expect(enrichment.notice).toBe(
      [
        `JOR has no ${UNE} data — ilostat_describe_indicator lists the areas it covers.`,
        'UNE_2EAP_SEX_AGE_RT_A may not use SEX_F — ilostat_describe_indicator UNE_2EAP_SEX_AGE_RT_A lists the codes it uses.',
        'Some requested areas have no UNE_2EAP_SEX_AGE_RT_A data — ilostat_describe_indicator lists the areas it covers.',
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

describe('areas without rows', () => {
  const COVERS = 'ilostat_describe_indicator lists the areas it covers.';
  const UNE_2EAP = 'UNE_2EAP_SEX_AGE_RT_A';
  const STRUCTURE_DOWN = structureRoute('UNE_DEAP_SEX_AGE_RT', () =>
    Promise.reject(new TypeError('fetch failed')),
  );
  /** KEN (6 rows) and USA (3) have 15+ total rows; ABW is in UNE_DEAP's structure area list with none, JOR outside it. */
  const MIXED = {
    dataset_ids: [UNE],
    ref_areas: ['KEN', 'JOR', 'ABW', 'USA'],
    sex: ['SEX_T'],
    classif1: ['AGE_YTHADULT_YGE15'],
  };
  const MIXED_LIST = [
    { dataset_id: UNE, ref_area: 'JOR', reason: 'not_covered' },
    { dataset_id: UNE, ref_area: 'ABW', reason: 'no_rows' },
  ];
  const MIXED_NOTICE = `JOR has no ${UNE} data — ${COVERS} ABW returned no ${UNE} rows for these filters and period.`;

  it('names each requested area without rows and why, in the order sent, on both surfaces', async () => {
    wire();
    const result = await runToolContract(queryIndicatorTool, MIXED);
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Output & Record<string, unknown>;
    expect(structured.summary).toMatchObject({ ref_areas: 2, complete: true });
    expect(structured.summary.areas_without_rows).toEqual(MIXED_LIST);
    expect(structured.notice).toBe(MIXED_NOTICE);
    const text = contentText(result);
    expect(text).toContain(MIXED_NOTICE);
    const lines = text.split('\n');
    expect(lines).toContain('**Areas without rows:**');
    expect(lines.filter((line) => line.startsWith(`- ${UNE} · `))).toEqual([
      `- ${UNE} · JOR: not_covered`,
      `- ${UNE} · ABW: no_rows`,
    ]);
  });

  it('covers every row read, not the page: a later page and an offset past the end carry the same list', async () => {
    wire();
    const pages = [];
    for (const offset of [0, 4, 100]) {
      pages.push((await query({ ...MIXED, limit: 2, offset })).result);
    }
    // USA's rows sit past the pages that hold rows
    expect(pages.map((page) => page.rows.map((row) => row.ref_area))).toEqual([
      ['KEN', 'KEN'],
      ['KEN', 'KEN'],
      [],
    ]);
    for (const page of pages) {
      expect(page.row_count).toBe(9);
      expect(page.summary).toMatchObject({ complete: true, areas_without_rows: MIXED_LIST });
    }
  });

  it('lists an area under each dataset it has no rows in, and only that one', async () => {
    const csv = [
      CSV_HEADER,
      '"KEN","BA:7008","UNE_DEAP_SEX_AGE_RT","SEX_T","AGE_YTHADULT_YGE15","2020",5.1,',
      '"USA","XA:1909","UNE_2EAP_SEX_AGE_RT","SEX_T","AGE_YTHADULT_YGE15","2020",8.1,',
      '',
    ].join('\n');
    wire({ routes: [indicatorDataRoute(csv)] });
    const { result, enrichment } = await query({
      dataset_ids: [UNE, UNE_2EAP],
      ref_areas: ['KEN', 'USA'],
    });
    expect(result.summary.ref_areas).toBe(2);
    // UNE_2EAP has no SDMX dataflow in the fixtures, so its area list is unavailable
    expect(result.summary.areas_without_rows).toEqual([
      { dataset_id: UNE, ref_area: 'USA', reason: 'no_rows' },
      { dataset_id: UNE_2EAP, ref_area: 'KEN', reason: 'no_rows' },
    ]);
    expect(enrichment.notice).toBe(
      [
        `USA returned no ${UNE} rows for these filters and period.`,
        `KEN returned no ${UNE_2EAP} rows for these filters and period.`,
        `The area list of ${UNE_2EAP} is unavailable from the ILOSTAT structure service, so no area is marked not_covered.`,
      ].join(' '),
    );
  });

  it('names ten areas outside the structure and counts the rest, the list holding every one', async () => {
    const { fixture, members } = x36Fixture();
    wire({ fixture });
    const { result, enrichment } = await query({
      dataset_ids: [UNE],
      area_group: 'X36',
      ref_areas: ['USA'],
    });
    expect(result.summary.ref_areas).toBe(1);
    expect(result.summary.areas_without_rows).toEqual(
      members.map((area) => ({ dataset_id: UNE, ref_area: area, reason: 'not_covered' })),
    );
    expect(enrichment.notice).toBe(
      `${members.slice(0, 10).join(', ')} and 3 more have no ${UNE} data — ${COVERS}`,
    );
  });

  it('marks every area no_rows when the structure is unavailable, and says why', async () => {
    const { fixture, members } = x36Fixture();
    wire({ fixture, routes: [STRUCTURE_DOWN] });
    const { result, enrichment } = await query({
      dataset_ids: [UNE],
      area_group: 'X36',
      ref_areas: ['USA'],
    });
    expect(result.summary.areas_without_rows).toEqual(
      members.map((area) => ({ dataset_id: UNE, ref_area: area, reason: 'no_rows' })),
    );
    expect(enrichment.notice).toBe(
      `${members.slice(0, 10).join(', ')} and 3 more returned no ${UNE} rows for these filters and period. The area list of ${UNE} is unavailable from the ILOSTAT structure service, so no area is marked not_covered.`,
    );
  });

  it('carries the list on a staged result and a per-series latest_only result', async () => {
    const canvas = canvasOn();
    wire({ canvas, observations: { previewChars: 3_000 } });
    const staged = await query({ dataset_ids: [UNE], ref_areas: ['USA', 'X01', 'KEN', 'JOR'] });
    expect(staged.result.dataframe?.row_count).toBe(52);
    expect(staged.result.summary).toMatchObject({
      complete: true,
      areas_without_rows: [{ dataset_id: UNE, ref_area: 'JOR', reason: 'not_covered' }],
    });
    const latest = await query({ ...MIXED, latest_only: true });
    expect(latest.enrichment.applied_filters).toMatchObject({ latest_mode: 'per_series' });
    expect(latest.result.summary.areas_without_rows).toEqual(MIXED_LIST);
  });

  it('is empty, with no sentence, when every requested area returned rows', async () => {
    wire();
    const { result, enrichment } = await query({ ...MIXED, ref_areas: ['KEN', 'USA'] });
    expect(result.summary.areas_without_rows).toEqual([]);
    expect(enrichment.notice).toBeUndefined();
    expect(render(result).split('\n')).toContain('**Areas without rows:** none');
  });

  it('is left out when no area is named, and on zero rows, whose notice is unchanged', async () => {
    wire();
    const unnamed = await query({ dataset_ids: [UNE], sex: ['SEX_T'], time: '2024' });
    expect(unnamed.result.row_count).toBeGreaterThan(0);
    expect(unnamed.result.summary).not.toHaveProperty('areas_without_rows');
    expect(render(unnamed.result)).not.toContain('Areas without rows');
    const empty = await query({ ...MIXED, ref_areas: ['JOR', 'ABW'] });
    expect(empty.result.row_count).toBe(0);
    expect(empty.result.summary).not.toHaveProperty('areas_without_rows');
    expect(empty.enrichment.notice).toBe(`JOR has no ${UNE} data — ${COVERS}`);
  });

  it('is left out of a read that stopped before the end of the result', async () => {
    const stream = streamedCsv(
      CSV_HEADER,
      10_000,
      (index) =>
        `"USA","BA:453","UNE_DEAP_SEX_AGE_RT","SEX_T","AGE_YTHADULT_YGE15","${1000 + index}",${index % 10},`,
    );
    wire({ routes: [dataRoute(() => stream.response())] });
    const { result, enrichment } = await query({
      dataset_ids: [UNE],
      ref_areas: ['USA', 'KEN'],
      limit: 10,
    });
    // KEN has no rows in the part read, which says nothing about the rest
    expect(result.summary.complete).toBe(false);
    expect(result.summary).not.toHaveProperty('areas_without_rows');
    expect(enrichment.notice).not.toMatch(/KEN (returned|has) no/);
    expect(render(result)).not.toContain('Areas without rows');
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
    // the page is limit rows, not what fits the preview
    expect(result.rows).toHaveLength(50);
    expect(result.next_offset).toBe(50);
    expect(result.summary).toEqual({
      ref_areas: 3,
      period_min: '1999',
      period_max: '2027',
      basis_counts: { reported: 24, modelled_estimate: 25, projection: 3 },
      complete: true,
      areas_without_rows: [],
    });
    expect(enrichment).toMatchObject({
      truncated: true,
      shown: 50,
      cap: 50,
      notice: `Full result staged as ${name} (52 rows) — use ilostat_dataframe_describe to inspect its columns, then ilostat_dataframe_query to analyze it with SQL. Showing rows 1–50 of 52. Pass next_offset as offset, with the same other arguments, for the next page.`,
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

  it('with dataframes off, returns limit rows, reads 5,001 rows past the cache limit, and cancels the upstream body', async () => {
    const stream = usaRows(10_000);
    wire({ routes: [dataRoute(() => stream.response())], observations: { previewChars: 3_000 } });
    const { result, enrichment } = await query({ dataset_ids: [UNE], ref_areas: ['USA'] });
    expect(result.rows.map((row) => row.period)).toEqual(
      Array.from({ length: 50 }, (_, index) => String(1000 + index)),
    );
    expect(result.next_offset).toBe(50);
    expect(result).not.toHaveProperty('dataframe');
    // row_count is the rows read, not the rows upstream holds
    expect(result.row_count).toBe(5_001);
    expect(result.summary.complete).toBe(false);
    expect(enrichment).toMatchObject({
      truncated: true,
      shown: 50,
      cap: 50,
      notice:
        'Showing rows 1–50 of at least 5,001. Dataframes are off in this deployment, so the result is not staged for SQL. Pass next_offset as offset, with the same other arguments, for the next page.',
    });
    expect(stream.cancelled).toBe(true);
    expect(stream.pulled).toBeGreaterThanOrEqual(5_001);
    expect(stream.pulled).toBeLessThan(10_000);
  });

  it('returns the first page of a result past the row ceiling unstaged, drops the partial table, and stops the transfer', async () => {
    const canvas = canvasOn();
    const stream = usaRows(10_000);
    wire({
      canvas,
      routes: [dataRoute(() => stream.response())],
      observations: { maxRows: 250, previewChars: 2_000 },
    });
    const ctx = newContext();
    const { result, enrichment } = await query({ dataset_ids: [UNE], ref_areas: ['USA'] }, ctx);
    expect(result.rows.map((row) => row.period)).toEqual(
      Array.from({ length: 50 }, (_, index) => String(1000 + index)),
    );
    expect(result.next_offset).toBe(50);
    expect(result).not.toHaveProperty('dataframe');
    // the rows read: the ceiling plus the one that proved the result passes it
    expect(result.row_count).toBe(251);
    expect(result.summary.complete).toBe(false);
    expect(enrichment).toMatchObject({
      truncated: true,
      shown: 50,
      cap: 50,
      notice:
        'Showing rows 1–50 of at least 251. The result passes the 250-row ceiling, so it is not staged for SQL; narrow the request (fewer reference areas, a shorter time window, or specific sex or classif1 codes) to stage it. Pass next_offset as offset, with the same other arguments, for the next page.',
    });
    expect(render(result)).toContain('**next_offset:** 50');
    expect(stream.cancelled).toBe(true);
    expect(stream.pulled).toBeLessThan(1_000);
    expect(await canvasTables(canvas, ctx)).toEqual([]);
    expect((await ctx.state.list('df-meta/')).items).toEqual([]);
  });

  it.each([
    ['a first page staging with dataframes on', true, 0, 300, '1–300'],
    ['a later page with dataframes off', false, 220, 50, '221–270'],
  ])(
    'refuses %s that reaches past the row ceiling as result_too_large, stopping the transfer',
    async (_label, withCanvas, offset, limit, rows) => {
      const canvas = withCanvas ? canvasOn() : undefined;
      const stream = usaRows(10_000);
      wire({
        ...(canvas ? { canvas } : {}),
        routes: [dataRoute(() => stream.response())],
        observations: { maxRows: 250, previewChars: 2_000 },
      });
      const ctx = newContext();
      const error = await query(
        { dataset_ids: [UNE], ref_areas: ['USA'], offset, limit },
        ctx,
      ).then(
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
      expect(error?.message).toBe(
        `The result passes the 250-row ceiling, and rows ${rows} reach past it; no page is read beyond the ceiling.`,
      );
      expect(stream.cancelled).toBe(true);
      expect(stream.pulled).toBeLessThan(1_000);
      if (canvas) expect(await canvasTables(canvas, ctx)).toEqual([]);
      expect((await ctx.state.list('df-meta/')).items).toEqual([]);
    },
  );

  it('names the row ceiling instead of offering a next page the ceiling refuses', async () => {
    wire({
      routes: [dataRoute(() => usaRows(10_000).response())],
      observations: { maxRows: 250, previewChars: 2_000 },
    });
    const narrow =
      'narrow the request (fewer reference areas, a shorter time window, or specific sex or classif1 codes) to read rows past 250.';

    const last = await query({ dataset_ids: [UNE], ref_areas: ['USA'], offset: 200 });
    expect(last.result.next_offset).toBe(250);
    expect(last.enrichment.notice).toBe(
      `Showing rows 201–250 of at least 251. Rows past the 250-row ceiling are not read; ${narrow}`,
    );

    const short = await query({ dataset_ids: [UNE], ref_areas: ['USA'], offset: 150, limit: 80 });
    expect(short.result.next_offset).toBe(230);
    expect(short.enrichment.notice).toBe(
      `Showing rows 151–230 of at least 251. The next page would reach past the 250-row ceiling: pass next_offset as offset with limit 20 for the rows up to it, or ${narrow}`,
    );
    // the advertised short page is served
    const tail = await query({ dataset_ids: [UNE], ref_areas: ['USA'], offset: 230, limit: 20 });
    expect(tail.result.rows.map((row) => row.period)).toEqual(
      Array.from({ length: 20 }, (_, index) => String(1230 + index)),
    );

    // a page whose successor stays under the ceiling keeps the plain guidance
    const early = await query({ dataset_ids: [UNE], ref_areas: ['USA'], offset: 50 });
    expect(early.enrichment.notice).toBe(
      'Showing rows 51–100 of at least 251. Pass next_offset as offset, with the same other arguments, for the next page.',
    );
  });
});

describe('paging', () => {
  /** The recorded USA, X01, and KEN rows: 52 in all. */
  const THREE_AREAS = { dataset_ids: [UNE], ref_areas: ['USA', 'X01', 'KEN'] };

  it('reads a result the cache holds whole on its first page: disjoint pages, the whole result in order, one request', async () => {
    const wired = wire();
    const pages: Output['rows'][] = [];
    // 52 rows at 20 a page take 3 pages; a walk still going after one more never ends
    const maxPages = Math.ceil(52 / 20) + 1;
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      if (pages.length === maxPages) {
        throw new Error(`next_offset still set after ${maxPages} pages`);
      }
      const { result } = await query({ ...THREE_AREAS, limit: 20, offset });
      // read whole on the first page, so every page counts the result exactly
      expect(result).toMatchObject({ row_count: 52, summary: { complete: true } });
      pages.push(result.rows);
      offset = result.next_offset;
    }
    expect(pages.map((page) => page.length)).toEqual([20, 20, 12]);
    const { result: whole } = await query({ ...THREE_AREAS, limit: 5_000 });
    expect(whole.rows).toHaveLength(52);
    expect(pages.flat()).toEqual(whole.rows);
    expect(dataUrls(wired)).toHaveLength(1);
  });

  it.each([
    [5_000, 5_000, true, 1],
    [5_001, 5_001, false, 2],
  ])(
    'caches a result of %i rows only when read to its end within the cache limit',
    async (rows, rowCount, complete, requests) => {
      const stream = usaRows(rows);
      const wired = wire({ routes: [dataRoute(() => stream.response())] });
      const { result } = await query({ dataset_ids: [UNE], ref_areas: ['USA'] });
      expect(result).toMatchObject({ row_count: rowCount, next_offset: 50, summary: { complete } });
      await query({ dataset_ids: [UNE], ref_areas: ['USA'], offset: 50 });
      expect(dataUrls(wired)).toHaveLength(requests);
    },
  );

  it.each([
    ['past 5,000 rows', 5_000, 100, 5_101, 5_100],
    ['at the end of the result', 9_950, 50, 10_000, undefined],
  ])(
    'reads one row past a page %s, in one request',
    async (_label, offset, limit, rowCount, nextOffset) => {
      const stream = usaRows(10_000);
      const wired = wire({ routes: [dataRoute(() => stream.response())] });
      const { result } = await query({ dataset_ids: [UNE], ref_areas: ['USA'], offset, limit });
      expect(result.rows.map((row) => row.period)).toEqual(
        Array.from({ length: limit }, (_, index) => String(1000 + offset + index)),
      );
      expect(result.next_offset).toBe(nextOffset);
      expect(result.row_count).toBe(rowCount);
      expect(result.summary.complete).toBe(nextOffset === undefined);
      expect(stream.pulled).toBeGreaterThanOrEqual(rowCount);
      expect(dataUrls(wired)).toHaveLength(1);
    },
  );

  it.each([
    [5_001, '5001'],
    [10_000, '10000'],
    [1e20, '100000000000000000000'],
  ])('applies a limit of %d as the 5,000-row page cap and says so', async (limit, sent) => {
    const stream = usaRows(10_000);
    wire({ routes: [dataRoute(() => stream.response())] });
    const { result, enrichment } = await query({ dataset_ids: [UNE], ref_areas: ['USA'], limit });
    expect(result.rows).toHaveLength(5_000);
    expect(result.next_offset).toBe(5_000);
    expect(enrichment).toMatchObject({ truncated: true, shown: 5_000, cap: 5_000 });
    expect(enrichment.notice).toMatch(
      new RegExp(
        `^limit ${sent} was applied as 5000, the per-call page cap\\. Showing rows 1–5,000 of at least 5,001\\.`,
      ),
    );
  });

  it('applies a limit of exactly the 5,000-row page cap as asked, with no cap sentence', async () => {
    const stream = usaRows(10_000);
    wire({ routes: [dataRoute(() => stream.response())] });
    const { result, enrichment } = await query({
      dataset_ids: [UNE],
      ref_areas: ['USA'],
      limit: 5_000,
    });
    expect(result.rows).toHaveLength(5_000);
    expect(result.next_offset).toBe(5_000);
    expect(enrichment).toMatchObject({ truncated: true, shown: 5_000, cap: 5_000 });
    expect(enrichment.notice).toMatch(/^Showing rows 1–5,000 of at least 5,001\./);
    expect(enrichment.notice).not.toContain('was applied as');
  });

  it.each([52, 60])(
    'returns no rows and a notice, not an error, for offset %i at or past the end',
    async (offset) => {
      wire();
      const result = await runToolContract(queryIndicatorTool, { ...THREE_AREAS, offset });
      expect(result.isError).toBeFalsy();
      const notice = `offset ${offset} is past the end of the result, which holds 52 rows.`;
      expect(result.structuredContent).toMatchObject({
        rows: [],
        row_count: 52,
        truncated: false,
        shown: 0,
        notice,
      });
      expect(result.structuredContent).not.toHaveProperty('next_offset');
      expect(contentText(result)).toContain(notice);
    },
  );

  it('with dataframes on, stages nothing for a later page', async () => {
    const canvas = canvasOn();
    wire({ canvas, observations: { previewChars: 3_000 } });
    const ctx = newContext();
    const { result, enrichment } = await query({ ...THREE_AREAS, offset: 50 }, ctx);
    expect(result.rows).toHaveLength(2);
    expect(result).not.toHaveProperty('next_offset');
    expect(result).not.toHaveProperty('dataframe');
    expect(enrichment.notice).toBe('Showing rows 51–52 of 52.');
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

  it('never caches a response whose reading stopped before its end', async () => {
    const stream = usaRows(10_000);
    const wired = wire({ routes: [dataRoute(() => stream.response())] });
    const args = { dataset_ids: [UNE], ref_areas: ['USA'] };
    expect((await query(args)).result.summary.complete).toBe(false);
    await query({ ...args, offset: 50 });
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

  it('unknown_code: names 10 codes per field then counts the rest, every code kept in data.rejected, on both surfaces', async () => {
    const wired = wire();
    /** 100 distinct 64-character codes, the most each field accepts. */
    const codes = (prefix: string) =>
      Array.from({ length: 100 }, (_, index) => `${prefix}${index}`.padEnd(64, 'X'));
    const named = (prefix: string) => `${codes(prefix).slice(0, 10).join(', ')} and 90 more`;
    const result = await runToolContract(queryIndicatorTool, {
      dataset_ids: [UNE],
      classif1: codes('C1_'),
      classif2: codes('C2_'),
      sources: codes('S_'),
    });
    expect(result.isError).toBe(true);
    const message = `Not ILOSTAT codes — classif1: ${named('C1_')}; classif2: ${named('C2_')}; sources: ${named('S_')}.`;
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message,
        data: {
          reason: 'unknown_code',
          rejected: { classif1: codes('C1_'), classif2: codes('C2_'), sources: codes('S_') },
        },
      },
    });
    const text = contentText(result);
    expect(text).toContain(message);
    expect(text.length).toBeLessThan(8 * 1024);
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

  it.each([
    ['a dataset ID with a space', { dataset_ids: ['UNE DEAP'] }],
    [
      '102 dataset IDs after splitting',
      { dataset_ids: [...Array.from({ length: 50 }, () => `${UNE}+${UNE}`), 'A_A,B_A'] },
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
      'Frequency: annual (A) · Database: Labour Force Statistics (LFS) · Updated 2026-09-24T07:10:19 · Has aggregates: true',
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
      'Frequency: annual (A) · Database: Labour Force Statistics (LFS) · Updated 24/09/2026 ## update · Has aggregates: true',
    );
    expect(lines.some((line) => line.startsWith('## update'))).toBe(false);
  });

  it('appends the database code to a database label that does not end with it, on both surfaces', async () => {
    const fixture: CatalogFixture = observationCatalogFixture();
    tocRow(fixture, UNE)['database.label'] = 'Labour Force Statistics';
    wire({ fixture });
    const result = await runToolContract(queryIndicatorTool, {
      dataset_ids: [UNE],
      ref_areas: ['USA'],
      time: '2024',
    });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as Output).datasets[0]?.database).toEqual({
      code: 'LFS',
      label: 'Labour Force Statistics',
    });
    expect(contentText(result)).toContain(
      'Frequency: annual (A) · Database: Labour Force Statistics (LFS) · Updated',
    );
  });

  it('flattens a line terminator in the ToC frequency, verbatim in structuredContent', async () => {
    const fixture: CatalogFixture = observationCatalogFixture();
    tocRow(fixture, UNE).freq = 'A\u2028## frequency';
    wire({ fixture });
    const result = await runToolContract(queryIndicatorTool, {
      dataset_ids: [UNE],
      ref_areas: ['USA'],
    });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as Output).datasets[0]?.frequency).toBe('A\u2028## frequency');
    const text = contentText(result);
    expect(text).not.toMatch(/[\u0085\u2028\u2029]/);
    expect(text).toContain('Frequency: A ## frequency (A ## frequency) · Database: ');
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

  it('counts a single row in the singular on content[]', async () => {
    wire();
    const result = await runToolContract(queryIndicatorTool, {
      dataset_ids: [UNE],
      ref_areas: ['USA'],
      sex: ['SEX_T'],
      classif1: ['AGE_YTHADULT_Y15-24'],
      time: '2024',
    });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as Output).row_count).toBe(1);
    const lines = contentText(result).split('\n');
    expect(lines).toContain('### Observations (1 of 1 row shown)');
    expect(lines.filter((line) => line.startsWith('**Summary:** 1 row · 1 area ·'))).toHaveLength(
      1,
    );
  });

  it('renders status and note codes named like Object.prototype members as codes, verbatim in structuredContent', async () => {
    const csv = [
      `${CSV_HEADER},"note_source"`,
      '"USA","BA:453","UNE_DEAP_SEX_AGE_RT","SEX_T","AGE_YTHADULT_YGE15","2024",5,"__proto__",',
      '"USA","BA:453","UNE_DEAP_SEX_AGE_RT","SEX_T","AGE_YTHADULT_YGE15","2023",4,"constructor","toString"',
      '',
    ].join('\n');
    wire({ routes: [dataRoute(() => csvResponse(csv))] });
    const result = await runToolContract(queryIndicatorTool, {
      dataset_ids: [UNE],
      ref_areas: ['USA'],
    });
    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as Output;
    expect(output.rows.map((row) => [row.obs_status, row.notes])).toEqual([
      ['__proto__', []],
      ['constructor', ['toString']],
    ]);
    // The output schema's record parse drops a __proto__ key, so that code has no label.
    expect(Object.keys(output.legend.obs_status)).toEqual(['constructor']);
    expect(Object.keys(output.legend.notes)).toEqual(['toString']);
    const text = contentText(result);
    expect(text).not.toMatch(/function|\[object Object\]/);
    const lines = text.split('\n');
    expect(lines).toContain('- 2024: 5 [__proto__] · reported');
    expect(lines).toContain(
      '- 2023: 4 [constructor Not in the ILOSTAT dictionary] · reported · notes toString',
    );
    expect(lines).toContain('- constructor — Not in the ILOSTAT dictionary');
    expect(lines).toContain('- toString — Not in the ILOSTAT dictionary');
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
      cap: 50,
      applied_filters: { dataset_ids: ['LAP_2GDP_NOC_RT_A', 'UNE_2EAP_SEX_AGE_RT_A'] },
    });
    expect(structured).not.toHaveProperty('next_offset');
    expect(contentText(result)).not.toContain('next_offset');
    const text = contentText(result);
    for (const row of structured.rows) {
      expect(text).toContain(`- ${row.period}: ${row.value}`);
    }
    for (const fragment of [
      '## LAP_2GDP_NOC_RT_A — Labour income share as a percent of GDP -- ILO modelled estimates, Nov. 2025 (%)',
      '## UNE_2EAP_SEX_AGE_RT_A — Unemployment rate by sex and age -- ILO modelled estimates, Nov. 2025 (%)',
      'Unit: % (PT) · type RT · multiplier 0 (units)',
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
    const notice = `JOR has no ${UNE} data — ilostat_describe_indicator lists the areas it covers.`;
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

  it('a zero-row page names each checked cause on both surfaces', async () => {
    wire();
    const result = await runToolContract(queryIndicatorTool, {
      dataset_ids: [UNE],
      ref_areas: ['JOR', 'X02', 'USA'],
      classif1: ['EDU_AGGREGATE_TOTAL', 'AGE_YTHADULT_YGE15'],
      sources: ['BA:829'],
      source_selection: 'best',
      time_from: '1900',
      time_to: '1905',
    });
    expect(result.isError).toBeFalsy();
    const notice = [
      `${UNE} does not use EDU_AGGREGATE_TOTAL — ilostat_describe_indicator ${UNE} lists the codes it uses.`,
      `${UNE} covers 1947–2027; widen time_from/time_to or drop time.`,
      `JOR, X02 have no ${UNE} data — ilostat_describe_indicator lists the areas it covers.`,
      'source_selection best keeps only the preferred source of each area and period, so a secondary source named in sources returns nothing; use source_selection all.',
    ].join(' ');
    expect(result.structuredContent).toMatchObject({ row_count: 0, notice });
    expect(contentText(result)).toContain(notice);
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
    expect(text).toContain('### Observations (50 of 52 rows shown)');
    expect(structured.next_offset).toBe(50);
    expect(text).toContain('**next_offset:** 50');
  });

  it('a paged result validates as truncated: the same rows, next_offset, and notice on both surfaces', async () => {
    wire({ observations: { previewChars: 3_000 } });
    const result = await runToolContract(queryIndicatorTool, {
      dataset_ids: [UNE],
      ref_areas: ['USA', 'X01', 'KEN'],
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Output & Record<string, unknown>;
    const notice =
      'Showing rows 1–50 of 52. Dataframes are off in this deployment, so the result is not staged for SQL. Pass next_offset as offset, with the same other arguments, for the next page.';
    expect(structured).toMatchObject({
      row_count: 52,
      next_offset: 50,
      truncated: true,
      shown: 50,
      cap: 50,
      summary: { complete: true },
      notice,
    });
    expect(structured.rows).toHaveLength(50);
    expect(structured).not.toHaveProperty('dataframe');
    const text = contentText(result);
    for (const row of structured.rows) {
      expect(text).toContain(`- ${row.period}: ${row.value ?? 'no value'}`);
    }
    expect(text).toContain('### Observations (50 of 52 rows shown)');
    expect(text).toContain('**next_offset:** 50');
    expect(text).toContain(notice);
    expect(text).toContain('complete: true');
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
