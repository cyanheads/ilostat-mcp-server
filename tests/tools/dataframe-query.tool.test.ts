/**
 * @fileoverview Tests for `ilostat_dataframe_query` over a real in-memory
 * DuckDB canvas: a `register_as` name in any case is stored under the minted
 * `df_XXXXX_XXXXX` form, which describe and a later `register_as` then resolve;
 * a `df_` name in the SQL is read in any case, bare or double-quoted, for the
 * `missing_table` pre-check and a derived table's provenance; a canvas re-minted
 * after a restart leaves no stale name to clash with; a `register_as` result
 * larger than its inline rows reports an exact `row_count` and points at the
 * stored dataframe; `sql` is capped at 20,000 characters; the canvas-off
 * registration; zero rows, the `row_limit` and `preview` bounds (preview 0
 * included), and a blank `register_as`; every declared error reason with the
 * contract recovery, and a call with no canvas wired failing `InternalError`;
 * table-cell escaping; the severity pin — on both consumption paths
 * (`structuredContent` and `content[]`).
 * @module tests/tools/dataframe-query.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { buildToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { disposeIlostatServices } from '@/services/ilostat-services.js';
import {
  FIXED_NOW,
  faultyCanvas,
  memoryCanvas,
  sharingState,
  stageObservations,
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

type Args = Parameters<typeof dataframeQueryTool.input.parse>[0];
type Output = Awaited<ReturnType<typeof dataframeQueryTool.handler>>;
type ContractResult = Awaited<ReturnType<typeof runToolContract>>;

const UNE = 'UNE_DEAP_SEX_AGE_RT_A';
const HOUR_MS = 3_600_000;
const MISSING_TABLE_RECOVERY =
  'Call ilostat_dataframe_describe to list the staged dataframes, or re-run the producing tool to stage the data again.';
const ZERO_ROWS_NOTICE =
  'Query returned 0 rows. Verify dataframe names with ilostat_dataframe_describe and check the WHERE conditions.';
const NO_CANVAS_MESSAGE =
  'A dataframe tool ran with no DataCanvas wired; with the canvas off these tools are registered disabled.';
const CANVAS_UNAVAILABLE_MESSAGE =
  'Dataframes are unavailable in this deployment: the DataCanvas DuckDB engine could not be loaded.';

/** Dataframes on, over `canvas` (a fresh in-memory one by default). */
function wireCanvas(options: WireOptions = {}, canvas: DataCanvas = memoryCanvas()): DataCanvas {
  canvases.push(canvas);
  wireDataframes({ ...options, canvas });
  return canvas;
}

function newContext() {
  return createMockContext({ tenantId: TENANT, errors: dataframeQueryTool.errors });
}

/**
 * The three-area frame (52 rows: KEN 6, USA 18, X01 28) staged on a fresh
 * canvas, and a query context on the same tenant state whose enrichment holds
 * only the query's own.
 */
async function staged(options: WireOptions = {}) {
  const canvas = wireCanvas(options);
  const staging = newContext();
  const { name } = await stageObservations(staging);
  return { canvas, ctx: sharingState(newContext(), staging), name, staging };
}

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

async function runQuery(args: Args, ctx: Context): Promise<Output> {
  return await dataframeQueryTool.handler(
    dataframeQueryTool.input.parse(args),
    ctx as Parameters<typeof dataframeQueryTool.handler>[1],
  );
}

async function failure(args: Args, ctx: Context = newContext()): Promise<McpError> {
  try {
    await runQuery(args, ctx);
  } catch (error) {
    return error as McpError;
  }
  throw new Error('expected the handler to fail');
}

/** The recovery the contract declares for `reason`. */
function contractRecovery(reason: string): string {
  const entry = dataframeQueryTool.errors?.find((candidate) => candidate.reason === reason);
  if (!entry) throw new Error(`${reason} is not in the contract`);
  return entry.recovery;
}

async function describedNames(name: string | undefined, source: Context): Promise<string[]> {
  const ctx = sharingState(
    createMockContext({ tenantId: TENANT, errors: dataframeDescribeTool.errors }),
    source,
  );
  const result = await dataframeDescribeTool.handler(
    dataframeDescribeTool.input.parse({ name }),
    ctx as Parameters<typeof dataframeDescribeTool.handler>[1],
  );
  return result.dataframes.map((frame) => frame.name);
}

function render(result: Output): string {
  return (dataframeQueryTool.format?.(result) ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
}

function contentText(result: ContractResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

describe('register_as name', () => {
  it('stores a result named in any case under the minted form, which describe then resolves', async () => {
    wireCanvas();
    const ctx = newContext();
    const { name } = await stageObservations(ctx);
    const result = await runQuery(
      {
        sql: `SELECT ref_area, period, value FROM ${name} WHERE ref_area = 'KEN'`,
        register_as: ' df_ken01_rates ',
      },
      ctx,
    );
    expect(result.registered_as).toBe('df_KEN01_RATES');
    expect(render(result)).toContain('Registered as df_KEN01_RATES');
    expect(await describedNames('DF_ken01_Rates', ctx)).toEqual(['df_KEN01_RATES']);
  });

  it('a register_as naming an existing dataframe in another case clashes with it', async () => {
    wireCanvas();
    const ctx = newContext();
    const { name } = await stageObservations(ctx);
    await runQuery({ sql: `SELECT * FROM ${name}`, register_as: 'df_COPY1_COPY1' }, ctx);
    const error = await runQuery(
      { sql: `SELECT * FROM ${name}`, register_as: 'df_copy1_copy1' },
      ctx,
    ).then(
      () => {
        throw new Error('expected register_as_clash');
      },
      (thrown: unknown) => thrown as McpError,
    );
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({ reason: 'register_as_clash', tableName: 'df_COPY1_COPY1' });
  });

  it('a lowercase register_as passes the schema and reaches both surfaces in the minted form', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT 42 AS answer',
      register_as: 'df_answr_00001',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      columns: ['answer'],
      row_count: 1,
      registered_as: 'df_ANSWR_00001',
    });
    expect(contentText(result)).toContain('Registered as df_ANSWR_00001');
  });

  it.each([
    ['a short part', 'df_ABCD_FGHIJ'],
    ['a missing prefix', 'ABCDE_FGHIJ'],
    ['an SQL payload', "df_ABCDE_FGHIJ'; DROP TABLE x --"],
  ])('rejects a register_as with %s at the schema', async (_label, register_as) => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT 42 AS answer',
      register_as,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(contentText(result)).toContain(
      'register_as must match df_XXXXX_XXXXX: letters and digits, five in each part.',
    );
  });
});

describe('df_ names in SQL', () => {
  it('reads a DF_-prefixed name as the dataframe it names, so a register_as table inherits its datasets', async () => {
    wireCanvas();
    const ctx = newContext();
    const { name } = await stageObservations(ctx);
    const sql = `SELECT ref_area, period, value FROM ${name.toUpperCase()} WHERE ref_area = 'KEN'`;
    const result = await runQuery({ sql, register_as: 'df_UPPER_CASE1' }, ctx);
    expect(result.registered_as).toBe('df_UPPER_CASE1');

    const describeCtx = sharingState(
      createMockContext({ tenantId: TENANT, errors: dataframeDescribeTool.errors }),
      ctx,
    );
    const described = await dataframeDescribeTool.handler(
      dataframeDescribeTool.input.parse({ name: 'df_UPPER_CASE1' }),
      describeCtx as Parameters<typeof dataframeDescribeTool.handler>[1],
    );
    expect(described.dataframes).toHaveLength(1);
    expect(described.dataframes[0]).toMatchObject({
      query_params: { sql, derived_from: [name] },
      datasets: [{ dataset_id: UNE }],
    });
    const text = (dataframeDescribeTool.format?.(described) ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain(`"derived_from":["${name}"]`);
    expect(text).toContain(`- Dataset: ${UNE} — `);
  });

  it('fails missing_table for a DF_-prefixed name that matches nothing, before the SQL runs, on both surfaces', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT * FROM DF_NOPE0_NOPE0',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message: 'Dataframe df_NOPE0_NOPE0 does not exist or has expired.',
        data: {
          reason: 'missing_table',
          tableName: 'df_NOPE0_NOPE0',
          recovery: { hint: MISSING_TABLE_RECOVERY },
        },
      },
    });
    const text = contentText(result);
    expect(text).toContain('Dataframe df_NOPE0_NOPE0 does not exist or has expired.');
    expect(text).toContain(`Recovery: ${MISSING_TABLE_RECOVERY}`);
  });

  it.each([
    [
      'a double-quoted table name',
      (name: string) => `SELECT ref_area, value FROM "${name}" WHERE ref_area = 'KEN'`,
    ],
    [
      'an apostrophe inside a double-quoted alias, before a single-quoted literal',
      (name: string) => `SELECT value AS "women's share" FROM ${name} WHERE ref_area = 'KEN'`,
    ],
  ])(
    'reads the dataframe named in SQL with %s, so the stored table inherits its datasets',
    async (_label, sqlFor) => {
      wireCanvas();
      const ctx = newContext();
      const { name } = await stageObservations(ctx);
      const sql = sqlFor(name);
      await runQuery({ sql, register_as: 'df_QUOTE_IDENT' }, ctx);

      const describeCtx = sharingState(
        createMockContext({ tenantId: TENANT, errors: dataframeDescribeTool.errors }),
        ctx,
      );
      const described = await dataframeDescribeTool.handler(
        dataframeDescribeTool.input.parse({ name: 'df_QUOTE_IDENT' }),
        describeCtx as Parameters<typeof dataframeDescribeTool.handler>[1],
      );
      expect(described.dataframes[0]).toMatchObject({
        query_params: { sql, derived_from: [name] },
        datasets: [{ dataset_id: UNE }],
      });
      const text = (dataframeDescribeTool.format?.(described) ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      expect(text).toContain(`"derived_from":["${name}"]`);
      expect(text).toContain(`- Dataset: ${UNE} — `);
    },
  );

  it('fails missing_table for a double-quoted name that matches nothing, before the SQL runs, on both surfaces', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT * FROM "DF_NOPE0_NOPE0"',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message: 'Dataframe df_NOPE0_NOPE0 does not exist or has expired.',
        data: { reason: 'missing_table', tableName: 'df_NOPE0_NOPE0' },
      },
    });
    const text = contentText(result);
    expect(text).toContain('Dataframe df_NOPE0_NOPE0 does not exist or has expired.');
    expect(text).toContain(`Recovery: ${MISSING_TABLE_RECOVERY}`);
  });
});

describe('sql length', () => {
  /** `SELECT 1 AS one` padded inside with spaces to exactly `length` characters. */
  const paddedSql = (length: number) =>
    `SELECT${' '.repeat(length - 'SELECT1 AS one'.length)}1 AS one`;

  it('accepts exactly 20,000 characters on both surfaces', async () => {
    wireCanvas();
    const sql = paddedSql(20_000);
    expect(sql).toHaveLength(20_000);
    const result = await runToolContract(dataframeQueryTool, { sql });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ columns: ['one'], row_count: 1 });
    expect(contentText(result)).toContain('| one |');
  });

  it('rejects 20,001 characters at the schema on both surfaces', async () => {
    wireCanvas();
    const sql = paddedSql(20_001);
    expect(sql).toHaveLength(20_001);
    const result = await runToolContract(dataframeQueryTool, { sql });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(contentText(result)).toContain('sql must be at most 20,000 characters');
  });
});

describe('a canvas that is gone', () => {
  it('a register_as reusing the name of a dataframe lost with its canvas is not a clash', async () => {
    const ctx = newContext();
    wireCanvas();
    const { name } = await stageObservations(ctx);
    // The restart: fresh services over a fresh canvas that never saw the stored canvas ID.
    disposeIlostatServices();
    wireCanvas();

    const result = await runQuery({ sql: 'SELECT 42 AS answer', register_as: name }, ctx);
    expect(result).toMatchObject({ columns: ['answer'], row_count: 1, registered_as: name });
    expect(render(result)).toContain(`Registered as ${name}`);
    expect(await describedNames(name, ctx)).toEqual([name]);
  });
});

describe('a register_as result larger than its inline rows', () => {
  it.each([
    [
      'preview',
      { preview: 2 },
      2,
      'Showing 2 of 52 rows. All 52 are stored as df_PART1_ROWS1; query that dataframe with ilostat_dataframe_query, or raise preview to see more inline.',
    ],
    [
      'row_limit',
      { row_limit: 10 },
      10,
      'Showing 10 of 52 rows. All 52 are stored as df_PART1_ROWS1; query that dataframe with ilostat_dataframe_query, or raise row_limit (max 10,000) to see more inline.',
    ],
  ])(
    'bounded by %s, counts every stored row and points at the stored dataframe, not at register_as',
    async (_bound, bounds, shown, guidance) => {
      wireCanvas();
      const stageCtx = newContext();
      const { name } = await stageObservations(stageCtx);
      const ctx = sharingState(newContext(), stageCtx);
      const result = await runQuery(
        { sql: `SELECT * FROM ${name}`, register_as: 'df_part1_rows1', ...bounds },
        ctx,
      );
      // register_as stores every row, so row_count is exact even past row_limit
      expect(result).toMatchObject({
        row_count: 52,
        row_count_capped: false,
        registered_as: 'df_PART1_ROWS1',
      });
      expect(result.rows).toHaveLength(shown);
      const enrichment = getEnrichment(ctx);
      expect(enrichment).toMatchObject({ truncated: true, shown, notice: guidance });
      expect(enrichment.notice).not.toContain('register_as');
      expect(render(result)).toContain(`**52 rows** (showing ${shown} of 52)`);
    },
  );

  it('reaches both surfaces', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3',
      register_as: 'df_THREE_ROWS1',
      preview: 1,
    });
    const guidance =
      'Showing 1 of 3 rows. All 3 are stored as df_THREE_ROWS1; query that dataframe with ilostat_dataframe_query, or raise preview to see more inline.';
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      row_count: 3,
      row_count_capped: false,
      registered_as: 'df_THREE_ROWS1',
      truncated: true,
      shown: 1,
      notice: guidance,
    });
    const text = contentText(result);
    expect(text).toContain(guidance);
    expect(text).not.toContain('Use register_as');
    expect(text).toContain('**3 rows** (showing 1 of 3)');
  });
});

describe('registration', () => {
  it('is registered disabled, naming the variable that enables it, when the canvas is off', () => {
    for (const dropEnabled of [true, false]) {
      const definition = buildToolDefinitions({ canvasEnabled: false, dropEnabled }).find(
        (candidate) => candidate.name === dataframeQueryTool.name,
      );
      expect((definition as { __mcpDisabled?: unknown } | undefined)?.__mcpDisabled).toEqual({
        reason: 'Dataframes are turned off in this deployment.',
        hint: 'CANVAS_PROVIDER_TYPE=duckdb',
      });
      expect(buildToolDefinitions({ canvasEnabled: true, dropEnabled })).toContain(
        dataframeQueryTool,
      );
    }
  });
});

describe('a SELECT over a staged dataframe', () => {
  it('aggregates a dataframe named in lowercase, BIGINT counts as strings, on both surfaces', async () => {
    const { ctx, name } = await staged();
    const result = await runQuery(
      {
        sql: `SELECT ref_area, count(*) AS n FROM ${name.toLowerCase()} GROUP BY ref_area ORDER BY ref_area`,
      },
      ctx,
    );
    expect(result).toEqual({
      columns: ['ref_area', 'n'],
      row_count: 3,
      row_count_capped: false,
      rows: [
        { ref_area: 'KEN', n: '6' },
        { ref_area: 'USA', n: '18' },
        { ref_area: 'X01', n: '28' },
      ],
    });
    expect(getEnrichment(ctx)).toEqual({ truncated: false, shown: 3, cap: 1000 });
    expect(render(result)).toBe(
      [
        '**3 rows**',
        '',
        '| ref_area | n |',
        '| --- | --- |',
        '| KEN | 6 |',
        '| USA | 18 |',
        '| X01 | 28 |',
      ].join('\n'),
    );
  });

  it('answers a filter that matches nothing with zero rows, the columns, and a notice', async () => {
    const { ctx, name } = await staged();
    const result = await runQuery(
      { sql: `SELECT ref_area, value FROM ${name} WHERE ref_area = 'FRA'` },
      ctx,
    );
    expect(result).toEqual({
      columns: ['ref_area', 'value'],
      row_count: 0,
      row_count_capped: false,
      rows: [],
    });
    expect(getEnrichment(ctx)).toEqual({
      truncated: false,
      shown: 0,
      cap: 1000,
      notice: ZERO_ROWS_NOTICE,
    });
    expect(render(result)).toBe('**0 rows**\n\n_No rows._ Columns: ref_area, value');
  });

  it('holds all 52 rows uncapped at row_limit 52', async () => {
    const { ctx, name } = await staged();
    const result = await runQuery({ sql: `SELECT * FROM ${name}`, row_limit: 52 }, ctx);
    expect(result).toMatchObject({ row_count: 52, row_count_capped: false });
    expect(result.rows).toHaveLength(52);
    expect(getEnrichment(ctx)).toEqual({ truncated: false, shown: 52, cap: 52 });
    expect(render(result).split('\n')[0]).toBe('**52 rows**');
  });

  it('stops at row_limit 51, says row_count is the cap, and names row_limit as the lever', async () => {
    const { ctx, name } = await staged();
    const result = await runQuery({ sql: `SELECT * FROM ${name}`, row_limit: 51 }, ctx);
    expect(result).toMatchObject({ row_count: 51, row_count_capped: true });
    expect(result.rows).toHaveLength(51);
    expect(getEnrichment(ctx)).toEqual({
      truncated: true,
      shown: 51,
      cap: 51,
      notice:
        'Showing 51 rows. The query matched more than row_limit (51), so row_count is that cap, not a total. Use register_as to keep the whole result — its row_count is then exact — or raise row_limit (max 10,000).',
    });
    expect(render(result).split('\n')[0]).toBe(
      '**51 rows** — capped at row_limit; more rows matched',
    );
  });

  it('returns preview rows inline, counts all 52, and names preview as the lever', async () => {
    const { ctx, name } = await staged();
    const result = await runQuery({ sql: `SELECT * FROM ${name}`, preview: 2 }, ctx);
    expect(result).toMatchObject({ row_count: 52, row_count_capped: false });
    expect(result.rows).toHaveLength(2);
    expect(getEnrichment(ctx)).toEqual({
      truncated: true,
      shown: 2,
      cap: 2,
      notice: 'Showing 2 of 52 rows. Use register_as to keep the full result, or raise preview.',
    });
    expect(render(result).split('\n')[0]).toBe('**52 rows** (showing 2 of 52)');
  });

  it('clamps a preview above row_limit to row_limit, so row_limit is the lever', async () => {
    const { ctx, name } = await staged();
    const result = await runQuery(
      { sql: `SELECT * FROM ${name}`, preview: 100, row_limit: 10 },
      ctx,
    );
    expect(result).toMatchObject({ row_count: 10, row_count_capped: true });
    expect(result.rows).toHaveLength(10);
    expect(getEnrichment(ctx)).toMatchObject({ truncated: true, shown: 10, cap: 10 });
    expect(getEnrichment(ctx).notice).toContain('or raise row_limit (max 10,000).');
  });

  it('returns no rows inline at preview 0 while counting all 52, without calling the result empty', async () => {
    const { ctx, name } = await staged();
    const result = await runQuery({ sql: `SELECT ref_area, value FROM ${name}`, preview: 0 }, ctx);
    expect(result).toEqual({
      columns: ['ref_area', 'value'],
      row_count: 52,
      row_count_capped: false,
      rows: [],
    });
    expect(getEnrichment(ctx)).toEqual({
      truncated: true,
      shown: 0,
      cap: 0,
      notice: 'Showing 0 of 52 rows. Use register_as to keep the full result, or raise preview.',
    });
    expect(render(result)).toBe(
      '**52 rows** (showing 0 of 52)\n\n_No rows shown inline._ Columns: ref_area, value',
    );
  });

  it('stores a register_as result with its expiry, which describe lists as derived by SQL', async () => {
    const { ctx, name, staging } = await staged();
    const sql = `SELECT * FROM ${name} WHERE basis = 'reported'`;
    const result = await runQuery({ sql, register_as: 'df_REPOR_TED01' }, ctx);
    expect(result).toMatchObject({
      row_count: 24,
      row_count_capped: false,
      registered_as: 'df_REPOR_TED01',
      expires_at: '2026-09-27T12:00:00.000Z',
    });
    expect(result.rows).toHaveLength(24);
    expect(getEnrichment(ctx)).toEqual({ truncated: false, shown: 24, cap: 1000 });
    expect(render(result).split('\n').slice(0, 2)).toEqual([
      'Registered as df_REPOR_TED01 (expires 2026-09-27T12:00:00.000Z).',
      '**24 rows**',
    ]);

    const described = await dataframeDescribeTool.handler(
      dataframeDescribeTool.input.parse({ name: 'df_REPOR_TED01' }),
      sharingState(
        createMockContext({ tenantId: TENANT, errors: dataframeDescribeTool.errors }),
        staging,
      ) as Parameters<typeof dataframeDescribeTool.handler>[1],
    );
    expect(described.dataframes).toHaveLength(1);
    const [frame] = described.dataframes;
    expect(frame).toMatchObject({
      name: 'df_REPOR_TED01',
      source_tool: 'ilostat_dataframe_query',
      query_params: { sql, derived_from: [name] },
      row_count: 24,
      expires_at: '2026-09-27T12:00:00.000Z',
    });
    expect(frame).not.toHaveProperty('coverage');
    expect(frame).not.toHaveProperty('basis_counts');
  });

  it('reads a blank register_as as unset: nothing is stored', async () => {
    const { ctx, name, staging } = await staged();
    const result = await runQuery(
      { sql: `SELECT count(*) AS n FROM ${name}`, register_as: '   ' },
      ctx,
    );
    expect(result).toEqual({
      columns: ['n'],
      row_count: 1,
      row_count_capped: false,
      rows: [{ n: '52' }],
    });
    expect(render(result)).not.toContain('Registered as');
    expect(await describedNames(undefined, staging)).toEqual([name]);
  });
});

describe('errors', () => {
  it('logs the reasons a caller’s SQL causes at notice, the canvas outage at error', () => {
    const severities = Object.fromEntries(
      (dataframeQueryTool.errors ?? []).map((entry: { reason: string; severity?: string }) => [
        entry.reason,
        entry.severity ?? 'error',
      ]),
    );
    expect(severities).toEqual({
      canvas_unavailable: 'error',
      system_catalog_access: 'notice',
      missing_table: 'notice',
      invalid_sql: 'notice',
      sql_execution_error: 'notice',
      register_as_clash: 'notice',
      non_select_statement: 'notice',
      multi_statement: 'notice',
      denied_function: 'notice',
      plan_operator_not_allowed: 'notice',
    });
  });

  it('is not canvas_unavailable without a wired canvas: the tool is unlisted then, so reaching it is a server bug', async () => {
    wireDataframes();
    const error = await failure({ sql: 'SELECT 1 AS n' });
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(JsonRpcErrorCode.InternalError);
    expect(error.message).toBe(NO_CANVAS_MESSAGE);
    expect(error.data?.reason).toBeUndefined();
  });

  it('fails canvas_unavailable when the DuckDB engine cannot load', async () => {
    const engineError = new McpError(
      JsonRpcErrorCode.ConfigurationError,
      'The DuckDB native binding could not be loaded.',
    );
    wireCanvas({}, faultyCanvas({ at: 'acquire', error: engineError }));
    const error = await failure({ sql: 'SELECT 1 AS n' });
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toBe(CANVAS_UNAVAILABLE_MESSAGE);
    expect(error.data).toEqual({
      reason: 'canvas_unavailable',
      recovery: { hint: contractRecovery('canvas_unavailable') },
    });
    expect(error.cause).toBe(engineError);
  });

  it.each([
    ['a table that is not a staged dataframe', () => 'SELECT * FROM some_table', 'missing_table'],
    [
      'information_schema',
      () => 'SELECT table_name FROM information_schema.tables',
      'system_catalog_access',
    ],
    ['duckdb_tables()', () => 'SELECT * FROM duckdb_tables()', 'system_catalog_access'],
    ['an unknown column', (name: string) => `SELECT nope FROM ${name}`, 'invalid_sql'],
    [
      'a cast the data fails',
      (name: string) => `SELECT CAST(ref_area AS INTEGER) AS n FROM ${name}`,
      'sql_execution_error',
    ],
    ['a DELETE', (name: string) => `DELETE FROM ${name}`, 'non_select_statement'],
    [
      'a CREATE TABLE',
      (name: string) => `CREATE TABLE copied AS SELECT * FROM ${name}`,
      'non_select_statement',
    ],
    ['two statements', () => 'SELECT 1; SELECT 2', 'multi_statement'],
    ['read_csv()', () => "SELECT * FROM read_csv('/etc/hosts')", 'denied_function'],
    ['range()', () => 'SELECT * FROM range(10)', 'plan_operator_not_allowed'],
  ])('fails %s with its declared reason and the contract recovery', async (_label, sql, reason) => {
    const { ctx, name } = await staged();
    const error = await failure({ sql: sql(name) }, ctx);
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(
      reason === 'missing_table' ? JsonRpcErrorCode.NotFound : JsonRpcErrorCode.ValidationError,
    );
    expect(error.data).toMatchObject({ reason, recovery: { hint: contractRecovery(reason) } });
  });

  it('leaves the dataframe whole after a rejected DELETE', async () => {
    const { ctx, name } = await staged();
    await failure({ sql: `DELETE FROM ${name}` }, ctx);
    const result = await runQuery({ sql: `SELECT count(*) AS n FROM ${name}` }, ctx);
    expect(result.rows).toEqual([{ n: '52' }]);
  });

  it('fails missing_table for a dataframe whose TTL has passed', async () => {
    const time = clock();
    const { ctx, name } = await staged({ now: time.now });
    time.advance(24 * HOUR_MS);
    const error = await failure({ sql: `SELECT * FROM ${name}` }, ctx);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.message).toBe(`Dataframe ${name} does not exist or has expired.`);
    expect(error.data).toMatchObject({
      reason: 'missing_table',
      tableName: name,
      recovery: { hint: MISSING_TABLE_RECOVERY },
    });
  });

  it.each([
    [false, 'Choose another df_XXXXX_XXXXX name or omit register_as.'],
    [
      true,
      'Drop the existing dataframe with ilostat_dataframe_drop, choose another df_XXXXX_XXXXX name, or omit register_as.',
    ],
  ])(
    'register_as_clash with drop enabled %s carries the matching hint',
    async (dropEnabled, hint) => {
      const { canvas, ctx, name } = await staged();
      initCanvasBridge(canvas, { tableTtlMs: 24 * HOUR_MS, dropEnabled, now: () => FIXED_NOW });
      await runQuery({ sql: `SELECT * FROM ${name}`, register_as: 'df_TWICE_TWICE' }, ctx);
      const error = await failure(
        { sql: `SELECT * FROM ${name}`, register_as: 'df_TWICE_TWICE' },
        ctx,
      );
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toBe(
        'Dataframe df_TWICE_TWICE already exists; register_as needs an unused name.',
      );
      expect(error.data).toEqual({
        reason: 'register_as_clash',
        tableName: 'df_TWICE_TWICE',
        recovery: { hint },
      });
    },
  );
});

describe('format()', () => {
  it('escapes pipes and backslashes, turns line breaks into <br>, leaves null empty, and renders lists and structs as JSON', async () => {
    wireCanvas();
    const result = await runQuery(
      {
        sql: [
          `SELECT 'a|b' AS "pipe|col", 'c\\d' AS backslash,`,
          `'e' || chr(10) || 'f' AS lf, 'g' || chr(13) || chr(10) || 'h' AS crlf, 'i' || chr(13) || 'j' AS cr,`,
          `NULL AS nothing, [1, 2] AS list, {'k': 'v|w'} AS struct, CAST(1.5 AS DOUBLE) AS num`,
        ].join(' '),
      },
      newContext(),
    );
    expect(result.rows).toEqual([
      {
        'pipe|col': 'a|b',
        backslash: 'c\\d',
        lf: 'e\nf',
        crlf: 'g\r\nh',
        cr: 'i\rj',
        nothing: null,
        list: [1, 2],
        struct: { k: 'v|w' },
        num: 1.5,
      },
    ]);
    expect(render(result)).toBe(
      [
        '**1 row**',
        '',
        '| pipe\\|col | backslash | lf | crlf | cr | nothing | list | struct | num |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        '| a\\|b | c\\\\d | e<br>f | g<br>h | i<br>j |  | [1,2] | {"k":"v\\|w"} | 1.5 |',
      ].join('\n'),
    );
  });
});

describe('contract envelope (runToolContract)', () => {
  it('a one-row page validates and carries the same row on both surfaces', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, { sql: "SELECT 1 AS n, 'a' AS s" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      columns: ['n', 's'],
      row_count: 1,
      row_count_capped: false,
      rows: [{ n: 1, s: 'a' }],
      truncated: false,
      shown: 1,
      cap: 1000,
    });
    expect(contentText(result)).toContain('**1 row**\n\n| n | s |\n| --- | --- |\n| 1 | a |');
  });

  it('a zero-row page validates, its notice on both surfaces', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, { sql: 'SELECT 1 AS n WHERE 1 = 0' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      columns: ['n'],
      row_count: 0,
      row_count_capped: false,
      rows: [],
      truncated: false,
      shown: 0,
      cap: 1000,
      notice: ZERO_ROWS_NOTICE,
    });
    const text = contentText(result);
    expect(text).toContain('**0 rows**\n\n_No rows._ Columns: n');
    expect(text).toContain(ZERO_ROWS_NOTICE);
  });

  it('a capped page validates, its cap disclosed on both surfaces', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3',
      row_limit: 2,
    });
    const guidance =
      'Showing 2 rows. The query matched more than row_limit (2), so row_count is that cap, not a total. Use register_as to keep the whole result — its row_count is then exact — or raise row_limit (max 10,000).';
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      row_count: 2,
      row_count_capped: true,
      truncated: true,
      shown: 2,
      cap: 2,
      notice: guidance,
    });
    const text = contentText(result);
    expect(text).toContain('**2 rows** — capped at row_limit; more rows matched');
    expect(text).toContain(guidance);
  });

  it('a gate rejection reaches both surfaces with its reason and recovery', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT table_name FROM information_schema.tables',
    });
    const recovery = contractRecovery('system_catalog_access');
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'system_catalog_access', recovery: { hint: recovery } },
      },
    });
    expect(contentText(result)).toContain(`Recovery: ${recovery}`);
  });

  it.each([
    ['a blank sql', { sql: '   ' }],
    ['row_limit 0', { sql: 'SELECT 1 AS n', row_limit: 0 }],
    ['row_limit 10,001', { sql: 'SELECT 1 AS n', row_limit: 10_001 }],
    ['preview -1', { sql: 'SELECT 1 AS n', preview: -1 }],
    ['preview 10,001', { sql: 'SELECT 1 AS n', preview: 10_001 }],
  ])('rejects %s at the schema on both surfaces', async (_label, args) => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(contentText(result)).toContain(Object.keys(args).at(-1) ?? 'sql');
  });
});
