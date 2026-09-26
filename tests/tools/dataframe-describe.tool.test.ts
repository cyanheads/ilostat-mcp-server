/**
 * @fileoverview Tests for `ilostat_dataframe_describe` on a real in-memory DuckDB
 * canvas, over dataframes staged by `ilostat_query_indicator` and
 * `ilostat_compare_geographies`: the provenance listing (newest first), the name
 * lookup and its miss notice, blank and padded names, the expiry sweep, tables
 * that are gone (a canvas re-minted after a restart, a table dropped off a live
 * canvas), the `DATAFRAME_NAME_PATTERN` schema rejections, `canvas_unavailable`
 * from an engine that cannot load (a call with no canvas wired is a server bug,
 * since the tool is unlisted with the canvas off) and its severity, CR/LF in ILO text, update
 * times, periods, and caller column names, and both consumption paths
 * (`structuredContent` and `content[]`).
 * @module tests/tools/dataframe-describe.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { compareGeographiesTool } from '@/mcp-server/tools/definitions/compare-geographies.tool.js';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { disposeIlostatServices } from '@/services/ilostat-services.js';
import {
  csvResponse,
  FIXED_NOW,
  faultyCanvas,
  fixtureText,
  INDICATOR_CSV,
  isIndicatorData,
  memoryCanvas,
  observationCatalogFixture,
  sharingState,
  stageObservations,
  tocRow,
  type WireOptions,
  wireDataframes,
} from '../helpers/ilostat-upstream.js';
import { guardNetwork } from '../helpers/network-guard.js';

guardNetwork();

const TENANT = 'default';
const canvases: DataCanvas[] = [];

afterEach(async () => {
  disposeIlostatServices();
  for (const canvas of canvases.splice(0)) {
    await canvas.shutdown(createMockContext({ tenantId: TENANT }));
  }
});

type Output = Awaited<ReturnType<typeof dataframeDescribeTool.handler>>;
type ContractResult = Awaited<ReturnType<typeof runToolContract>>;

const UNE = 'UNE_DEAP_SEX_AGE_RT_A';
const HOUR_MS = 3_600_000;
const ATTRIBUTION =
  'Source: ILOSTAT, International Labour Organization (CC BY 4.0) — https://ilostat.ilo.org';
const CANVAS_UNAVAILABLE_RECOVERY =
  'Dataframes are off in this deployment; call ilostat_query_indicator or ilostat_compare_geographies with narrower filters so the result fits inline.';
const CANVAS_UNAVAILABLE_MESSAGE =
  'Dataframes are unavailable in this deployment: the DataCanvas DuckDB engine could not be loaded.';
const NO_CANVAS_MESSAGE =
  'A dataframe tool ran with no DataCanvas wired; with the canvas off these tools are registered disabled.';
const UNE_DATASET = {
  dataset_id: UNE,
  label: 'Unemployment rate by sex and age (%)',
  unit: 'Percentage',
  last_update: '2026-09-24T07:10:19',
};
/** The staged observation columns, as describe reports them. */
const OBSERVATION_SCHEMA = [
  ...[
    'dataset_id',
    'indicator',
    'indicator_label',
    'ref_area',
    'ref_area_label',
    'ref_area_kind',
    'source',
    'source_label',
    'sex',
    'sex_label',
    'classif1',
    'classif1_label',
    'classif2',
    'classif2_label',
    'period',
  ].map((name) => ({ name, type: 'VARCHAR' })),
  { name: 'year', type: 'INTEGER' },
  { name: 'subperiod', type: 'INTEGER' },
  { name: 'value', type: 'DOUBLE' },
  { name: 'unit', type: 'VARCHAR' },
  { name: 'unit_multiplier', type: 'INTEGER' },
  ...['obs_status', 'obs_status_label', 'note_codes', 'note_labels', 'basis'].map((name) => ({
    name,
    type: 'VARCHAR',
  })),
  { name: 'best_source', type: 'BOOLEAN' },
].map((column) => ({ ...column, nullable: true }));

/** A settable clock, starting at {@link FIXED_NOW}. */
function clock() {
  let now = FIXED_NOW.getTime();
  return {
    now: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
  };
}

/** Dataframes on, over a fresh in-memory canvas. */
function wireCanvas(options: WireOptions = {}): DataCanvas {
  const canvas = memoryCanvas();
  canvases.push(canvas);
  wireDataframes({ ...options, canvas });
  return canvas;
}

function newContext() {
  return createMockContext({ tenantId: TENANT, errors: dataframeDescribeTool.errors });
}

async function describeFrames(name: string | undefined, ctx: Context = newContext()) {
  const result = await dataframeDescribeTool.handler(
    dataframeDescribeTool.input.parse(name === undefined ? {} : { name }),
    ctx as Parameters<typeof dataframeDescribeTool.handler>[1],
  );
  return { result, enrichment: getEnrichment(ctx) };
}

async function failure(ctx: Context = newContext()): Promise<McpError> {
  try {
    await dataframeDescribeTool.handler(
      dataframeDescribeTool.input.parse({}),
      ctx as Parameters<typeof dataframeDescribeTool.handler>[1],
    );
  } catch (error) {
    return error as McpError;
  }
  throw new Error('expected the handler to fail');
}

/** Stages a four-area comparison (three with a value) through `ilostat_compare_geographies`. */
async function stageComparison(ctx: Context): Promise<string> {
  const result = await compareGeographiesTool.handler(
    compareGeographiesTool.input.parse({
      dataset_id: UNE,
      ref_areas: ['USA', 'X01', 'KEN', 'JOR'],
    }),
    ctx as unknown as Parameters<typeof compareGeographiesTool.handler>[1],
  );
  if (!result.dataframe) throw new Error('The comparison was not staged');
  return result.dataframe.name;
}

function render(result: Output): string {
  return (dataframeDescribeTool.format?.(result) ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
}

function contentText(result: ContractResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

describe('listing', () => {
  it('lists every staged dataframe newest first, with the provenance each producer recorded', async () => {
    const time = clock();
    wireCanvas({ now: time.now });
    const ctx = newContext();
    const observations = await stageObservations(ctx);
    time.advance(HOUR_MS);
    const comparison = await stageComparison(ctx);

    const { result } = await describeFrames(undefined, ctx);
    expect(result.dataframes.map((frame) => frame.name)).toEqual([comparison, observations.name]);

    const [compared, queried] = result.dataframes;
    expect(queried).toEqual({
      name: observations.name,
      source_tool: 'ilostat_query_indicator',
      query_params: {
        dataset_ids: [UNE],
        ref_areas: ['USA', 'X01', 'KEN'],
        ref_area_count: 3,
        latest_only: false,
        source_selection: 'best',
        best_source: 'yes',
      },
      created_at: FIXED_NOW.toISOString(),
      expires_at: '2026-09-27T12:00:00.000Z',
      row_count: 52,
      datasets: [UNE_DATASET],
      coverage: { ref_areas: 3, period_min: '1999', period_max: '2027' },
      basis_counts: { reported: 24, modelled_estimate: 25, projection: 3 },
      attribution: ATTRIBUTION,
      column_schema: OBSERVATION_SCHEMA,
    });
    expect(observations).toEqual({
      name: observations.name,
      row_count: 52,
      expires_at: '2026-09-27T12:00:00.000Z',
    });
    expect(compared).toMatchObject({
      name: comparison,
      source_tool: 'ilostat_compare_geographies',
      query_params: {
        dataset_id: UNE,
        ref_areas: ['USA', 'X01', 'KEN', 'JOR'],
        ref_area_count: 4,
        sex: 'SEX_T',
        classif1: 'AGE_YTHADULT_YGE15',
      },
      created_at: '2026-09-26T13:00:00.000Z',
      expires_at: '2026-09-27T13:00:00.000Z',
      row_count: 3,
      datasets: [UNE_DATASET],
      coverage: { ref_areas: 3, period_min: '2021', period_max: '2025' },
      basis_counts: { reported: 2, modelled_estimate: 1, projection: 0 },
      attribution: ATTRIBUTION,
    });
    expect(compared?.column_schema.slice(0, 3)).toEqual([
      { name: 'dataset_id', type: 'VARCHAR', nullable: true },
      { name: 'rank', type: 'INTEGER', nullable: true },
      { name: 'ref_area', type: 'VARCHAR', nullable: true },
    ]);
  });

  it('lists nothing, with no notice, before anything is staged', async () => {
    wireCanvas();
    const { result, enrichment } = await describeFrames(undefined);
    expect(result).toEqual({ dataframes: [] });
    expect(enrichment).toEqual({});
    expect(render(result)).toBe('No staged dataframes.');
  });

  it('sweeps a dataframe once its TTL passes, dropping its table before listing', async () => {
    const time = clock();
    const canvas = wireCanvas({ now: time.now });
    const ctx = newContext();
    const { name } = await stageObservations(ctx);
    time.advance(24 * HOUR_MS - 1);
    expect((await describeFrames(undefined, ctx)).result.dataframes).toHaveLength(1);

    time.advance(1);
    expect((await describeFrames(undefined, ctx)).result.dataframes).toEqual([]);
    expect(await ctx.state.get(`df-meta/${name}`)).toBeNull();
    const instance = await canvas.acquire((await ctx.state.get<string>('canvas-id')) ?? '', ctx);
    expect(await instance.describe()).toEqual([]);
  });
});

describe('tables that are gone', () => {
  it('lists nothing once the canvas is gone (a restart that kept ctx.state), and clears its provenance', async () => {
    const ctx = newContext();
    wireCanvas();
    const { name } = await stageObservations(ctx);
    // The restart: fresh services over a fresh canvas that never saw the stored canvas ID.
    disposeIlostatServices();
    wireCanvas();

    const { result } = await describeFrames(undefined, ctx);
    expect(result).toEqual({ dataframes: [] });
    expect(render(result)).toBe('No staged dataframes.');
    expect((await ctx.state.list('df-meta/')).items).toEqual([]);
    expect((await describeFrames(name, ctx)).result).toEqual({ dataframes: [] });
  });

  it('never lists a dataframe whose table left a live canvas, and forgets its provenance', async () => {
    const time = clock();
    const canvas = wireCanvas({ now: time.now });
    const ctx = newContext();
    const kept = await stageObservations(ctx, ['USA', 'X01', 'KEN']);
    time.advance(HOUR_MS);
    const lookedUp = await stageObservations(ctx, ['X01', 'KEN']);
    time.advance(HOUR_MS);
    const listed = await stageObservations(ctx, ['USA', 'X01', 'KEN']);
    const instance = await canvas.acquire((await ctx.state.get<string>('canvas-id')) ?? '', ctx);
    expect(await instance.drop(lookedUp.name)).toBe(true);
    expect(await instance.drop(listed.name)).toBe(true);

    const byName = await describeFrames(lookedUp.name, ctx);
    expect(byName.result).toEqual({ dataframes: [] });
    expect(byName.enrichment.notice).toBe(
      `No staged dataframe is named ${lookedUp.name}; call ilostat_dataframe_describe without name to list them, or re-run the producing tool.`,
    );
    expect(await ctx.state.get(`df-meta/${lookedUp.name}`)).toBeNull();

    const { result } = await describeFrames(undefined, ctx);
    expect(result.dataframes.map((frame) => frame.name)).toEqual([kept.name]);
    const text = render(result);
    expect(text).toContain(`### ${kept.name}`);
    expect(text).not.toContain(listed.name);
    expect(await ctx.state.get(`df-meta/${listed.name}`)).toBeNull();
  });
});

describe('name', () => {
  it('looks one dataframe up by name, trimmed; a blank name lists them all', async () => {
    const time = clock();
    wireCanvas({ now: time.now });
    const ctx = newContext();
    const first = await stageObservations(ctx, ['USA', 'X01', 'KEN']);
    time.advance(HOUR_MS);
    const second = await stageObservations(ctx, ['X01', 'KEN']);

    const names = async (name?: string) =>
      (await describeFrames(name, ctx)).result.dataframes.map((frame) => frame.name);
    expect(await names(first.name)).toEqual([first.name]);
    expect(await names(`  ${second.name}\n`)).toEqual([second.name]);
    expect(await names('')).toEqual([second.name, first.name]);
    expect(await names('   ')).toEqual([second.name, first.name]);
  });

  it('answers a well-formed name that matches nothing with an empty list and a notice', async () => {
    wireCanvas();
    const ctx = newContext();
    await stageObservations(ctx);
    const { result, enrichment } = await describeFrames('df_NOPE0_NOPE0', ctx);
    expect(result).toEqual({ dataframes: [] });
    // the shared context also holds the producer's enrichment; the notice is describe's
    expect(enrichment.notice).toBe(
      'No staged dataframe is named df_NOPE0_NOPE0; call ilostat_dataframe_describe without name to list them, or re-run the producing tool.',
    );
  });

  it('resolves a name in any case, as SQL does, to the minted df_XXXXX_XXXXX form', async () => {
    wireCanvas();
    const ctx = newContext();
    const { name } = await stageObservations(ctx);
    const rest = name.slice(3);
    for (const variant of [
      `df_${rest.toLowerCase()}`,
      `DF_${rest}`,
      `Df_${rest.toLowerCase()}`,
      ` df_${rest.toLowerCase()} `,
    ]) {
      const { result } = await describeFrames(variant, ctx);
      expect(result.dataframes.map((frame) => frame.name)).toEqual([name]);
      expect(render(result)).toContain(`### ${name}`);
    }
  });

  it('a lowercase name passes the schema on both surfaces, echoed in the minted form', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeDescribeTool, { name: 'df_nope0_nope0' });
    expect(result.isError).toBeFalsy();
    const notice =
      'No staged dataframe is named df_NOPE0_NOPE0; call ilostat_dataframe_describe without name to list them, or re-run the producing tool.';
    expect(result.structuredContent).toEqual({ dataframes: [], notice });
    expect(contentText(result)).toContain(notice);
  });

  it.each([
    ['a short part', 'df_ABCD_FGHIJ'],
    ['a missing prefix', 'ABCDE_FGHIJ'],
    ['a line break inside', 'df_ABCDE\n_FGHIJ'],
    ['an SQL payload', "df_ABCDE_FGHIJ'; DROP TABLE x --"],
  ])('rejects a name with %s at the schema, before the canvas is touched', async (_label, name) => {
    wireDataframes();
    const result = await runToolContract(dataframeDescribeTool, { name });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(contentText(result)).toContain(
      'name must match df_XXXXX_XXXXX: letters and digits, five in each part.',
    );
  });
});

describe('canvas_unavailable', () => {
  it('is the only declared reason, logged at error', () => {
    const severities = Object.fromEntries(
      (dataframeDescribeTool.errors ?? []).map((entry: { reason: string; severity?: string }) => [
        entry.reason,
        entry.severity ?? 'error',
      ]),
    );
    expect(severities).toEqual({ canvas_unavailable: 'error' });
  });

  it('is not what a call without a wired canvas gets: the tool is unlisted then, so reaching it is a server bug', async () => {
    wireDataframes();
    const error = await failure();
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(JsonRpcErrorCode.InternalError);
    expect(error.message).toBe(NO_CANVAS_MESSAGE);
    expect(error.data?.reason).toBeUndefined();
  });

  it('fails when the DuckDB engine cannot load, rather than listing nothing', async () => {
    const engineError = new McpError(
      JsonRpcErrorCode.ConfigurationError,
      'The DuckDB native binding could not be loaded.',
    );
    const canvas = faultyCanvas({ at: 'acquire', error: engineError });
    canvases.push(canvas);
    wireDataframes({ canvas });
    const error = await failure();
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toBe(CANVAS_UNAVAILABLE_MESSAGE);
    expect(error.data).toEqual({
      reason: 'canvas_unavailable',
      recovery: { hint: CANVAS_UNAVAILABLE_RECOVERY },
    });
    expect(error.cause).toBe(engineError);
  });
});

describe('format()', () => {
  it('renders every field of a staged dataframe', async () => {
    wireCanvas();
    const ctx = newContext();
    const { name } = await stageObservations(ctx);
    const { result } = await describeFrames(undefined, ctx);
    const text = render(result);
    for (const fragment of [
      '**1 staged dataframe(s)**',
      `### ${name}`,
      `- Source: ilostat_query_indicator · 52 rows · created ${FIXED_NOW.toISOString()} · expires 2026-09-27T12:00:00.000Z`,
      '- Params: {"dataset_ids":["UNE_DEAP_SEX_AGE_RT_A"],"ref_areas":["USA","X01","KEN"],"ref_area_count":3,"latest_only":false,"source_selection":"best","best_source":"yes"}',
      '- Dataset: UNE_DEAP_SEX_AGE_RT_A — Unemployment rate by sex and age (%) · unit Percentage · updated 2026-09-24T07:10:19',
      '- Coverage: 3 areas · 1999–2027',
      '- Basis: reported 24 · modelled_estimate 25 · projection 3',
      `- ${ATTRIBUTION}`,
    ]) {
      expect(text).toContain(fragment);
    }
    for (const column of OBSERVATION_SCHEMA) {
      expect(text).toContain(`${column.name} ${column.type} (nullable: true)`);
    }
  });

  it('flattens CR/LF in an ILO label so it cannot open a block; structuredContent keeps it verbatim', async () => {
    const fixture = observationCatalogFixture();
    tocRow(fixture, UNE)['indicator.label'] = 'Unemployment rate\r\n## injected';
    wireCanvas({ fixture });
    const ctx = newContext();
    await stageObservations(ctx);
    const { result } = await describeFrames(undefined, ctx);
    expect(result.dataframes[0]?.datasets[0]?.label).toBe('Unemployment rate\r\n## injected');
    const text = render(result);
    expect(text).toContain(`- Dataset: ${UNE} — Unemployment rate ## injected · unit Percentage`);
    expect(text.split('\n').some((line) => line.startsWith('## injected'))).toBe(false);
  });

  it('flattens CR/LF in the update time, the period range, and a column named in SQL; structuredContent keeps them verbatim', async () => {
    const fixture = observationCatalogFixture();
    tocRow(fixture, UNE)['last.update'] = '24/09/2026\n## update';
    // KEN's 2021 row, now the earliest period
    const csv = fixtureText(INDICATOR_CSV.uneDeap).replace(
      '"2021",5.585',
      '"1990\n## period",5.585',
    );
    wireCanvas({
      fixture,
      routes: [{ method: 'GET', match: isIndicatorData, respond: () => csvResponse(csv) }],
    });
    const ctx = newContext();
    const { name } = await stageObservations(ctx);
    const derived = 'df_ALIAS_CRLF1';
    const queryCtx = sharingState(
      createMockContext({ tenantId: TENANT, errors: dataframeQueryTool.errors }),
      ctx,
    );
    await dataframeQueryTool.handler(
      dataframeQueryTool.input.parse({
        sql: `SELECT ref_area AS "a\n## column" FROM ${name}`,
        register_as: derived,
      }),
      queryCtx as Parameters<typeof dataframeQueryTool.handler>[1],
    );

    const { result } = await describeFrames(undefined, ctx);
    const staged = result.dataframes.find((frame) => frame.name === name);
    const stored = result.dataframes.find((frame) => frame.name === derived);
    expect(staged?.datasets[0]?.last_update).toBe('24/09/2026\n## update');
    expect(staged?.coverage).toEqual({
      ref_areas: 3,
      period_min: '1990\n## period',
      period_max: '2027',
    });
    expect(stored?.column_schema).toEqual([
      { name: 'a\n## column', type: 'VARCHAR', nullable: true },
    ]);

    const text = render(result);
    expect(text).toContain(' · updated 24/09/2026 ## update');
    expect(text).toContain('- Coverage: 3 areas · 1990 ## period–2027');
    expect(text).toContain('- Columns: a ## column VARCHAR (nullable: true)');
    // both frames can be created in the same millisecond, so their order is not asserted
    expect(
      text
        .split('\n')
        .filter((line) => line.startsWith('#'))
        .sort(),
    ).toEqual([`### ${derived}`, `### ${name}`].sort());
  });

  it('says 1 area for a dataframe covering one reference area', async () => {
    wireCanvas();
    const ctx = newContext();
    await stageObservations(ctx, ['USA']);
    const { result } = await describeFrames(undefined, ctx);
    expect(result.dataframes[0]?.coverage).toMatchObject({ ref_areas: 1 });
    expect(render(result)).toContain('- Coverage: 1 area · 2023–2025');
  });
});

describe('contract envelope (runToolContract)', () => {
  it('an empty listing validates on both surfaces', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeDescribeTool, {});
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ dataframes: [] });
    expect(contentText(result)).toContain('No staged dataframes.');
  });

  it('a name miss validates, its notice on both surfaces', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeDescribeTool, { name: 'df_NOPE0_NOPE0' });
    expect(result.isError).toBeFalsy();
    const notice =
      'No staged dataframe is named df_NOPE0_NOPE0; call ilostat_dataframe_describe without name to list them, or re-run the producing tool.';
    expect(result.structuredContent).toEqual({ dataframes: [], notice });
    expect(contentText(result)).toContain(notice);
  });

  it('canvas_unavailable reaches both surfaces with its reason and recovery', async () => {
    const canvas = faultyCanvas({
      at: 'acquire',
      error: new McpError(JsonRpcErrorCode.ConfigurationError, 'DuckDB is not installed.'),
    });
    canvases.push(canvas);
    wireDataframes({ canvas });
    const result = await runToolContract(dataframeDescribeTool, {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: CANVAS_UNAVAILABLE_MESSAGE,
        data: { reason: 'canvas_unavailable', recovery: { hint: CANVAS_UNAVAILABLE_RECOVERY } },
      },
    });
    const text = contentText(result);
    expect(text).toContain(CANVAS_UNAVAILABLE_MESSAGE);
    expect(text).toContain(`Recovery: ${CANVAS_UNAVAILABLE_RECOVERY}`);
  });
});
