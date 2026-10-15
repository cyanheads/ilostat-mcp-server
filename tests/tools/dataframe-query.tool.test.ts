/**
 * @fileoverview Tests for `ilostat_dataframe_query` over a real in-memory
 * DuckDB canvas: a `register_as` name in any case is stored under the minted
 * `df_XXXXX_XXXXX` form, which describe and a later `register_as` then resolve;
 * a `df_` name in the SQL is read in any case, bare or double-quoted, for the
 * `missing_table` name the engine's rejection is rebuilt with and a derived
 * table's provenance; `missing_table` points at no listing where every caller
 * shares one canvas; a canvas re-minted
 * after a restart leaves no stale name to clash with; a `register_as` result
 * larger than its inline rows reports an exact `row_count` and points at the
 * stored dataframe; `sql` is capped at 20,000 characters; the canvas-off
 * registration; zero rows, the `row_limit` and `preview` bounds (preview 0
 * included), and a blank `register_as`; a `row_limit` or `preview` past the
 * per-call cap (10,000, or a lower `CANVAS_DEFAULT_ROW_LIMIT`) applied as it and
 * echoed in `applied_limits`, with the 1,000,000 ceiling still rejected; the
 * inline size budget, which cuts whole rows in order by the larger of their JSON
 * and table-line lengths plus their separators, and names the widest column of a
 * lone oversized row with a `substr()` part size that reads it whole, or fewer
 * columns when that column fits alone; every declared error reason with the
 * contract recovery, and a call with no canvas wired failing `InternalError`;
 * a path in an engine failure, from the query or from storing its
 * `register_as` result, redacted to `[path]`; table-cell escaping; the
 * severity pin — on both consumption paths
 * (`structuredContent` and `content[]`).
 * @module tests/tools/dataframe-query.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { CanvasInstance, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { resetConfig } from '@cyanheads/mcp-ts-core/config';
import { databaseError, JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { ErrorHandler } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { buildToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { CanvasBridge, initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
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
  vi.restoreAllMocks();
  resetConfig();
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

/** The `applied_limits` enrichment of a call that ran under these limits. */
function appliedLimits(rowLimit: number, preview = rowLimit) {
  return { row_limit: rowLimit, preview, preview_chars: 40_000 };
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

  it('fails missing_table for a DF_-prefixed name that matches nothing, named in the minted form, on both surfaces', async () => {
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

  it('keeps the spill path of an engine I/O failure off both surfaces', async () => {
    wireCanvas();
    const query = vi
      .spyOn(CanvasInstance.prototype, 'query')
      .mockRejectedValueOnce(
        databaseError(
          'IO Error: Cannot open file "/srv/canvas-tmp/duckdb_temp_storage_DEFAULT-0.tmp": Permission denied',
        ),
      );
    const result = await runToolContract(dataframeQueryTool, { sql: 'SELECT 1 AS one' });
    query.mockRestore();
    const redacted = 'IO Error: Cannot open file "[path]": Permission denied';
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.DatabaseError, message: redacted },
    });
    expect(contentText(result)).toContain(redacted);
    expect(JSON.stringify(result)).not.toContain('/srv/canvas-tmp');
  });

  it.each([
    [
      'looking up the stored table',
      (error: Error) => {
        vi.spyOn(CanvasInstance.prototype, 'describe').mockRejectedValueOnce(error);
      },
    ],
    [
      'admitting it to the tenant budget',
      (error: Error) => {
        vi.spyOn(CanvasBridge.prototype, 'admitTable').mockRejectedValueOnce(error);
      },
    ],
  ])('keeps the path of a register_as that fails %s off both surfaces', async (_label, arrange) => {
    wireCanvas();
    const engineError = new Error(
      'IO Error: Cannot open file "/srv/canvas-tmp/duckdb_temp_storage_DEFAULT-0.tmp": Permission denied',
    );
    arrange(engineError);
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT 1 AS one',
      register_as: 'df_STORE_D0001',
    });
    const redacted = 'IO Error: Cannot open file "[path]": Permission denied';
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: ErrorHandler.classifyOnly(engineError).code, message: redacted },
    });
    expect(contentText(result)).toContain(redacted);
    expect(JSON.stringify(result)).not.toContain('/srv/canvas-tmp');
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

  it('points missing_table at the returned name, not a listing, where every caller shares one canvas, on both surfaces', async () => {
    resetConfig({ MCP_TRANSPORT_TYPE: 'http', MCP_AUTH_MODE: 'none' });
    wireCanvas();
    const hint =
      'Check the name against the df_XXXXX_XXXXX name the producing tool returned, or re-run the producing tool to stage the data again.';
    const result = await runToolContract(dataframeQueryTool, {
      sql: '/* shared */ SELECT * FROM df_NOPE0_NOPE0',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'missing_table', tableName: 'df_NOPE0_NOPE0', recovery: { hint } },
      },
    });
    const text = contentText(result);
    expect(text).toContain(`Recovery: ${hint}`);
    expect(text).not.toContain('to list the staged dataframes');
  });

  it.each([
    ['system_catalog_access', 'SELECT table_name FROM information_schema.tables'],
    ['non_select_statement', 'DELETE FROM df_NOPE0_NOPE0'],
    ['denied_function', "SELECT * FROM read_csv('/etc/hosts')"],
    ['sql_read_only', "SELECT * FROM 'data.csv'"],
  ])(
    'points the %s recovery at no listing where every caller shares one canvas, on both surfaces',
    async (reason, sql) => {
      resetConfig({ MCP_TRANSPORT_TYPE: 'http', MCP_AUTH_MODE: 'none' });
      wireCanvas();
      const result = await runToolContract(dataframeQueryTool, { sql });
      expect(result.isError).toBe(true);
      const hint = contractRecovery(reason);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason, recovery: { hint } } },
      });
      expect(hint).not.toMatch(/\blists?\b/);
      expect(contentText(result)).toContain(`Recovery: ${hint}`);
    },
  );

  it('fails missing_table for a double-quoted name that matches nothing, named in the minted form, on both surfaces', async () => {
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
      'Showing 10 of 52 rows. All 52 are stored as df_PART1_ROWS1; query that dataframe with ilostat_dataframe_query, or raise row_limit (up to 10,000) to see more inline.',
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
    expect(getEnrichment(ctx)).toEqual({
      truncated: false,
      shown: 3,
      cap: 1000,
      applied_limits: appliedLimits(1000),
    });
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
      applied_limits: appliedLimits(1000),
      notice: ZERO_ROWS_NOTICE,
    });
    expect(render(result)).toBe('**0 rows**\n\n_No rows._ Columns: ref_area, value');
  });

  it('holds all 52 rows uncapped at row_limit 52', async () => {
    const { ctx, name } = await staged();
    const result = await runQuery({ sql: `SELECT * FROM ${name}`, row_limit: 52 }, ctx);
    expect(result).toMatchObject({ row_count: 52, row_count_capped: false });
    expect(result.rows).toHaveLength(52);
    expect(getEnrichment(ctx)).toEqual({
      truncated: false,
      shown: 52,
      cap: 52,
      applied_limits: appliedLimits(52),
    });
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
      applied_limits: appliedLimits(51),
      notice:
        'Showing 51 rows. The query matched more than row_limit (51), so row_count is that cap, not a total. Use register_as to keep the whole result — its row_count is then exact — or raise row_limit (up to 10,000).',
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
      applied_limits: appliedLimits(1000, 2),
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
    expect(getEnrichment(ctx)).toMatchObject({
      truncated: true,
      shown: 10,
      cap: 10,
      applied_limits: appliedLimits(10),
    });
    expect(getEnrichment(ctx).notice).toMatch(
      /^preview 100 was applied as 10, since preview never exceeds row_limit\. .*or raise row_limit \(up to 10,000\)\.$/,
    );
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
      applied_limits: appliedLimits(1000, 0),
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
    expect(getEnrichment(ctx)).toEqual({
      truncated: false,
      shown: 24,
      cap: 1000,
      applied_limits: appliedLimits(1000),
    });
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

describe('row_limit and preview past the per-call cap', () => {
  const ROW_LIMIT_CLAMP = 'row_limit 10001 was applied as 10000, the per-call row cap.';

  /** The row cap below the 10,000 default, as `CANVAS_DEFAULT_ROW_LIMIT` sets it. */
  function wireLowCap(cap: number): void {
    resetConfig({ CANVAS_DEFAULT_ROW_LIMIT: String(cap) });
    wireCanvas({}, memoryCanvas({ defaultRowLimit: cap }));
  }

  it('applies a row_limit and preview past 10,000 as the cap, naming both clamps on both surfaces', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT 1 AS x',
      row_limit: 10_001,
      preview: 10_001,
    });
    expect(result.isError).toBeFalsy();
    const notice = `${ROW_LIMIT_CLAMP} preview 10001 was applied as 10000, since preview never exceeds row_limit.`;
    expect(result.structuredContent).toMatchObject({
      row_count: 1,
      row_count_capped: false,
      rows: [{ x: 1 }],
      truncated: false,
      shown: 1,
      cap: 10_000,
      applied_limits: { row_limit: 10_000, preview: 10_000 },
      notice,
    });
    const text = contentText(result);
    expect(text).toContain(notice);
    expect(text).toContain('**Applied limits:** row_limit 10000 · preview 10000');
  });

  it('applies row_limit 1,000,000 as the cap and rejects 1,000,001 naming row_limit and 1,000,000', async () => {
    wireCanvas();
    const applied = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT 1 AS x',
      row_limit: 1_000_000,
    });
    expect(applied.isError).toBeFalsy();
    expect(applied.structuredContent).toMatchObject({
      applied_limits: { row_limit: 10_000, preview: 10_000 },
      notice: 'row_limit 1000000 was applied as 10000, the per-call row cap.',
    });

    const rejected = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT 1 AS x',
      row_limit: 1_000_001,
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    const text = contentText(rejected);
    expect(text).toContain('row_limit');
    expect(text).toContain('1,000,000');
  });

  it('applies a preview past row_limit as row_limit', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT 1 AS x',
      row_limit: 10,
      preview: 50_000,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      applied_limits: { row_limit: 10, preview: 10 },
      notice: 'preview 50000 was applied as 10, since preview never exceeds row_limit.',
    });
  });

  it.each([
    ['row_limit 0', { row_limit: 0 }],
    ['row_limit -1', { row_limit: -1 }],
    ['preview -1', { preview: -1 }],
    ['row_limit 10.5', { row_limit: 10.5 }],
    ['row_limit "10.5"', { row_limit: '10.5' }],
    ['preview 10.5', { preview: 10.5 }],
    ['row_limit "abc"', { row_limit: 'abc' }],
    ['row_limit true', { row_limit: true }],
    ['preview "abc"', { preview: 'abc' }],
  ])('still rejects %s as invalid arguments naming the field', async (_label, bounds) => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT 1 AS x',
      ...bounds,
    } as never);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(contentText(result)).toContain(Object.keys(bounds)[0] ?? 'missing');
  });

  it.each([
    ['"500"', '500', 500, undefined],
    ['"10001"', '10001', 10_000, ROW_LIMIT_CLAMP],
  ])(
    'repairs row_limit %s to the number it spells, then applies the cap',
    async (_label, sent, applied, notice) => {
      wireCanvas();
      const result = await runToolContract(dataframeQueryTool, {
        sql: 'SELECT 1 AS x',
        row_limit: sent,
      } as never);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        applied_limits: { row_limit: applied, preview: applied },
      });
      expect((result.structuredContent as { notice?: string }).notice).toBe(notice);
    },
  );

  it('applies a lower CANVAS_DEFAULT_ROW_LIMIT as the default row_limit, with no clamp notice for a value never sent', async () => {
    wireLowCap(500);
    const result = await runToolContract(dataframeQueryTool, { sql: 'SELECT 1 AS x' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      row_count: 1,
      applied_limits: { row_limit: 500, preview: 500 },
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(contentText(result)).not.toContain('was applied as');
  });

  it('names the clamp of a row_limit 1000 the caller sent under a lower cap', async () => {
    wireLowCap(500);
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT 1 AS x',
      row_limit: 1000,
    });
    expect(result.structuredContent).toMatchObject({
      applied_limits: { row_limit: 500, preview: 500 },
      notice: 'row_limit 1000 was applied as 500, the per-call row cap.',
    });
    expect(contentText(result)).toContain(
      'row_limit 1000 was applied as 500, the per-call row cap.',
    );
  });

  it('applies a fractional CANVAS_DEFAULT_ROW_LIMIT as the whole rows below it instead of failing', async () => {
    wireLowCap(500.5);
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT unnest(generate_series(1, 2000)) AS n',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      row_count: 500,
      row_count_capped: true,
      applied_limits: { row_limit: 500, preview: 500 },
    });
  });

  it('caps a larger result at the applied cap and names register_as, never raising row_limit, on both surfaces', async () => {
    wireLowCap(500);
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT unnest(generate_series(1, 2000)) AS n',
      row_limit: 5_000,
    });
    expect(result.isError).toBeFalsy();
    const notice =
      'row_limit 5000 was applied as 500, the per-call row cap. Showing 500 rows. The query matched more than row_limit (500), so row_count is that cap, not a total. Use register_as to keep the whole result; its row_count is then exact.';
    expect(result.structuredContent).toMatchObject({
      row_count: 500,
      row_count_capped: true,
      truncated: true,
      shown: 500,
      cap: 500,
      applied_limits: { row_limit: 500, preview: 500 },
      notice,
    });
    const text = contentText(result);
    expect(text).toContain(notice);
    expect(text).not.toContain('raise row_limit');
  });

  it('names the cap as the most row_limit can be raised to while it sits below it', async () => {
    wireLowCap(500);
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT unnest(generate_series(1, 2000)) AS n',
      row_limit: 100,
    });
    expect(result.structuredContent).toMatchObject({
      row_count: 100,
      row_count_capped: true,
      notice:
        'Showing 100 rows. The query matched more than row_limit (100), so row_count is that cap, not a total. Use register_as to keep the whole result — its row_count is then exact — or raise row_limit (up to 500).',
    });
  });

  it('stores a register_as result past the cap in full, its inline rows at the cap, pointing only at the stored dataframe', async () => {
    wireLowCap(500);
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT unnest(generate_series(1, 2000)) AS n',
      register_as: 'df_ATCAP_ROWS1',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      row_count: 2000,
      row_count_capped: false,
      registered_as: 'df_ATCAP_ROWS1',
      truncated: true,
      shown: 500,
      notice:
        'Showing 500 of 2000 rows. All 2000 are stored as df_ATCAP_ROWS1; query that dataframe with ilostat_dataframe_query.',
    });
  });
});

describe('inline size budget', () => {
  const BUDGET = 40_000;
  const SELECTIVE = 'selective SQL: fewer columns, LIMIT … OFFSET over an ORDER BY, or aggregates.';
  /** 100 rows of about 1,000 characters each, numbered from 1. */
  const PADDED = (rows: number) =>
    `SELECT n, repeat('a', 1000) AS pad FROM (SELECT unnest(generate_series(1, ${rows})) AS n) ORDER BY n`;

  type Row = Record<string, unknown>;

  /**
   * The rows on each surface as the caller receives them: the `rows` array body
   * (its brackets aside, separators included) and the table's data lines in
   * content[] joined as rendered.
   */
  function surfaces(result: ContractResult) {
    const rows = (result.structuredContent as { rows: Row[] }).rows;
    const lines = contentText(result)
      .split('\n')
      .filter((line) => line.startsWith('| ') && !line.startsWith('| ---'))
      .slice(1);
    return {
      rows,
      jsonChars: JSON.stringify(rows).length - 2,
      lines,
      textChars: lines.join('\n').length,
    };
  }

  /** The notice of a contract result. */
  function noticeOf(result: ContractResult): string {
    return (result.structuredContent as { notice: string }).notice;
  }

  /** The `substr()` part size a withheld-column notice gives, read off its recipe. */
  function partSize(notice: string): number {
    const match = /substr\("[^"]+", 1, (\d+)\)/.exec(notice);
    if (!match?.[1]) throw new Error(`no substr() recipe in: ${notice}`);
    return Number(match[1]);
  }

  /** The dataframe bridge over `canvas` with an inline budget of `previewChars`. */
  function lowerBudget(canvas: DataCanvas, previewChars: number): void {
    initCanvasBridge(canvas, {
      tableTtlMs: 24 * HOUR_MS,
      dropEnabled: false,
      listingEnabled: true,
      now: () => FIXED_NOW,
      previewChars,
    });
  }

  it('withholds a lone row past the budget, naming its widest column, its length, and substr(), on both surfaces', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT 7 AS id, repeat(chr(120), 60000) AS wide',
      row_limit: 1,
    });
    expect(result.isError).toBeFalsy();
    const notice =
      'Showing 0 of 1 row. Inline rows are held to 40,000 characters; the next row alone is 60,018 characters, and its widest column, wide, holds 60,000 — select it alone in parts of 39,892 characters: substr("wide", 1, 39892), then substr("wide", 39893, 39892), and on to length("wide"). Use register_as to keep the full result and read it with selective SQL: fewer columns, LIMIT … OFFSET over an ORDER BY, or aggregates.';
    expect(result.structuredContent).toMatchObject({
      columns: ['id', 'wide'],
      row_count: 1,
      row_count_capped: false,
      rows: [],
      truncated: true,
      shown: 0,
      notice,
    });
    const text = contentText(result);
    expect(text).toContain(notice);
    expect(text).toContain(
      '**1 row** (showing 0 of 1)\n\n_No rows shown inline._ Columns: id, wide',
    );
    expect(JSON.stringify(result.structuredContent)).not.toContain('xxxxxxxxxx');
    expect(text).not.toContain('xxxxxxxxxx');
  });

  it('withholds a row whose JSON fits but whose escaped table row does not', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT repeat(chr(124), 30000) AS pipes',
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify({ pipes: '|'.repeat(30_000) }).length).toBeLessThan(BUDGET);
    expect(result.structuredContent).toMatchObject({ rows: [], shown: 0, truncated: true });
    const { notice } = result.structuredContent as { notice: string };
    expect(notice).toContain(
      'the next row alone is 60,004 characters, and its widest column, pipes, holds 30,000',
    );
    expect(contentText(result)).not.toContain('\\|\\|\\|\\|');
  });

  it.each([
    ['plain', 'repeat(chr(120), 60000)', 'x'.repeat(60_000)],
    ['pipe', 'repeat(chr(124), 30000)', '|'.repeat(30_000)],
    ['line-break', 'repeat(chr(10), 30000)', '\n'.repeat(30_000)],
  ])(
    'gives a withheld %s column a part size whose substr() recipe, run verbatim, reads it whole',
    async (_label, expression, value) => {
      wireCanvas();
      const source = `(SELECT ${expression} AS cell)`;
      const withheld = await runToolContract(dataframeQueryTool, {
        sql: `SELECT cell FROM ${source}`,
      });
      expect(withheld.structuredContent).toMatchObject({ rows: [], shown: 0, truncated: true });
      const notice = noticeOf(withheld);
      const part = partSize(notice);
      expect(notice).toContain(
        `then substr("cell", ${part + 1}, ${part}), and on to length("cell")`,
      );
      let read = '';
      for (let start = 1; start <= value.length; start += part) {
        const result = await runToolContract(dataframeQueryTool, {
          sql: `SELECT substr("cell", ${start}, ${part}) AS part FROM ${source}`,
        });
        expect(result.structuredContent).toMatchObject({
          row_count: 1,
          shown: 1,
          truncated: false,
        });
        const { rows, jsonChars, textChars } = surfaces(result);
        expect(jsonChars).toBeLessThanOrEqual(BUDGET);
        expect(textChars).toBeLessThanOrEqual(BUDGET);
        read += String(rows[0]?.part);
      }
      expect(read).toBe(value);
    },
  );

  it('gives a withheld non-text column a recipe that casts it to text first', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT generate_series(1, 20000) AS ids',
    });
    const notice = noticeOf(result);
    expect(notice).toContain('substr(CAST("ids" AS VARCHAR), 1, ');
    const part = /substr\(CAST\("ids" AS VARCHAR\), 1, (\d+)\)/.exec(notice)?.[1];
    const read = await runToolContract(dataframeQueryTool, {
      sql: `SELECT substr(CAST("ids" AS VARCHAR), 1, ${part}) AS part FROM (SELECT generate_series(1, 20000) AS ids)`,
    });
    expect(read.structuredContent).toMatchObject({ row_count: 1, shown: 1 });
  });

  it('points a withheld row whose widest column fits alone at fewer columns, not substr()', async () => {
    wireCanvas();
    const columns = Array.from({ length: 8 }, (_, i) => `repeat(chr(${97 + i}), 6000) AS c${i}`);
    const result = await runToolContract(dataframeQueryTool, {
      sql: `SELECT ${columns.join(', ')}`,
    });
    expect(result.structuredContent).toMatchObject({ rows: [], shown: 0, truncated: true });
    const notice = noticeOf(result);
    expect(notice).toContain(
      'the next row alone is 48,065 characters, and its widest column, c0, holds 6,000 and fits inline alone — select fewer columns.',
    );
    expect(notice).not.toContain('substr');
    const fewer = await runToolContract(dataframeQueryTool, {
      sql: `SELECT c0, c1, c2 FROM (SELECT ${columns.join(', ')})`,
    });
    expect(fewer.structuredContent).toMatchObject({ row_count: 1, shown: 1, truncated: false });
  });

  it('holds narrow rows to the budget with their separators counted, on both surfaces', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT unnest(generate_series(1, 20000)) AS x',
      row_limit: 20_000,
    });
    expect(result.isError).toBeFalsy();
    const { rows, jsonChars, lines, textChars } = surfaces(result);
    expect(rows.length).toBeGreaterThan(3_000);
    expect(lines).toHaveLength(rows.length);
    expect(jsonChars).toBeLessThanOrEqual(BUDGET);
    expect(textChars).toBeLessThanOrEqual(BUDGET);
    const next = JSON.stringify({ x: String(rows.length + 1) }).length;
    expect(jsonChars + 1 + next).toBeGreaterThan(BUDGET);
    expect(result.structuredContent).toMatchObject({
      row_count: 10_000,
      row_count_capped: true,
      shown: rows.length,
    });
  });

  it('stops at the first row that does not fit, keeping order and every value whole, within the budget on both surfaces', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, { sql: PADDED(100) });
    expect(result.isError).toBeFalsy();
    const { rows, jsonChars, lines, textChars } = surfaces(result);
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.length).toBeLessThan(100);
    // generate_series yields BIGINT, which arrives as a string
    expect(rows.map((row) => row.n)).toEqual(
      Array.from({ length: rows.length }, (_, i) => String(i + 1)),
    );
    expect(rows.every((row) => row.pad === 'a'.repeat(1000))).toBe(true);
    expect(lines).toHaveLength(rows.length);
    expect(jsonChars).toBeLessThanOrEqual(BUDGET);
    expect(textChars).toBeLessThanOrEqual(BUDGET);
    const next = JSON.stringify({ n: String(rows.length + 1), pad: 'a'.repeat(1000) }).length;
    expect(jsonChars + 1 + next).toBeGreaterThan(BUDGET);
    const shown = rows.length;
    expect(result.structuredContent).toMatchObject({
      row_count: 100,
      row_count_capped: false,
      truncated: true,
      shown,
      cap: 1000,
      applied_limits: { row_limit: 1000, preview: 1000, preview_chars: BUDGET },
    });
    const { notice } = result.structuredContent as { notice: string };
    expect(notice).toBe(
      `Showing ${shown} of 100 rows. Inline rows are held to 40,000 characters. Use register_as to keep the full result and read it with ${SELECTIVE}`,
    );
    expect(contentText(result)).toContain(`**100 rows** (showing ${shown} of 100)`);
  });

  it('cuts a result capped at row_limit without changing row_count or row_count_capped', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, { sql: PADDED(2000) });
    expect(result.isError).toBeFalsy();
    const { rows, jsonChars, textChars } = surfaces(result);
    expect(jsonChars).toBeLessThanOrEqual(BUDGET);
    expect(textChars).toBeLessThanOrEqual(BUDGET);
    expect(result.structuredContent).toMatchObject({
      row_count: 1000,
      row_count_capped: true,
      truncated: true,
      shown: rows.length,
      notice: `Showing ${rows.length} of the first 1000 rows. Inline rows are held to 40,000 characters. The query matched more than row_limit, so row_count is that cap, not a total. Use register_as to keep the whole result — its row_count is then exact — and read it with ${SELECTIVE}`,
    });
  });

  it('counts preview rows against the first row_limit rows of a capped result, on both surfaces', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT unnest(generate_series(1, 20000)) AS x',
      row_limit: 10_000,
      preview: 3,
    });
    const notice =
      'Showing 3 of the first 10000 rows. The query matched more than row_limit, so row_count is that cap, not a total. Use register_as to keep the whole result — its row_count is then exact — or raise preview.';
    expect(result.structuredContent).toMatchObject({
      row_count: 10_000,
      row_count_capped: true,
      shown: 3,
      notice,
    });
    expect(contentText(result)).toContain(notice);
  });

  it('stores every row under register_as, row_count exact, the notice naming the stored dataframe', async () => {
    wireCanvas();
    const ctx = newContext();
    const result = await runQuery({ sql: PADDED(100), register_as: 'df_SIZED_ROWS1' }, ctx);
    expect(result).toMatchObject({ row_count: 100, registered_as: 'df_SIZED_ROWS1' });
    expect(result.rows.length).toBeLessThan(100);
    expect(getEnrichment(ctx).notice).toBe(
      `Showing ${result.rows.length} of 100 rows. Inline rows are held to 40,000 characters. All 100 are stored as df_SIZED_ROWS1; query that dataframe with ${SELECTIVE}`,
    );
    const stored = await runQuery(
      { sql: 'SELECT count(*) AS n, sum(length(pad)) AS chars FROM df_SIZED_ROWS1' },
      sharingState(newContext(), ctx),
    );
    expect(stored.rows).toEqual([{ n: '100', chars: '100000' }]);
  });

  it('names the widest column of a lone oversized row that follows rows that fit', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, {
      sql: "SELECT 1 AS n, 'small' AS note UNION ALL SELECT 2, repeat('b', 50000) ORDER BY n",
    });
    expect(result.structuredContent).toMatchObject({
      rows: [{ n: 1, note: 'small' }],
      shown: 1,
      truncated: true,
    });
    expect((result.structuredContent as { notice: string }).notice).toContain(
      'its widest column, note, holds 50,000 — select it alone in parts of 39,891 characters: substr("note", 1, 39891), then substr("note", 39892, 39891), and on to length("note").',
    );
  });

  it('reads a withheld value in parts with length() and substr()', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT length(wide) AS chars, substr(wide, 1, 5) AS head FROM (SELECT repeat(chr(120), 60000) AS wide)',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ rows: [{ chars: '60000', head: 'xxxxx' }] });
  });

  it('applies a lower budget, echoed as applied_limits.preview_chars', async () => {
    const canvas = wireCanvas();
    lowerBudget(canvas, 1_000);
    const result = await runToolContract(dataframeQueryTool, {
      sql: "SELECT n, repeat('c', 90) AS pad FROM (SELECT unnest(generate_series(1, 30)) AS n) ORDER BY n",
    });
    const { rows, jsonChars } = surfaces(result);
    expect(jsonChars).toBeLessThanOrEqual(1_000);
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.length).toBeLessThan(30);
    expect(result.structuredContent).toMatchObject({
      row_count: 30,
      applied_limits: { row_limit: 1000, preview: 1000, preview_chars: 1_000 },
    });
    expect((result.structuredContent as { notice: string }).notice).toContain(
      'Inline rows are held to 1,000 characters.',
    );
    expect(contentText(result)).toContain(
      '**Applied limits:** row_limit 1000 · preview 1000 · preview_chars 1000',
    );
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
      register_as_too_large: 'notice',
      non_select_statement: 'notice',
      multi_statement: 'notice',
      denied_function: 'notice',
      sql_read_only: 'notice',
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
    ['current_setting()', () => "SELECT current_setting('threads') AS t", 'denied_function'],
    ['query_table()', (name: string) => `SELECT * FROM query_table('${name}')`, 'denied_function'],
    ['a file named as a table', () => "SELECT * FROM 'data.csv'", 'sql_read_only'],
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

  it.each([
    ['CREATE TABLE', (name: string) => `CREATE TABLE df_AAAAA_BBBBB AS SELECT * FROM ${name}`],
    ['INSERT INTO', (name: string) => `INSERT INTO df_NEWNA_MEXXX SELECT * FROM ${name}`],
    ['a comment-led DROP', () => '/* tidy */ -- up\nDROP TABLE df_GONE0_GONE0'],
  ])(
    'fails %s naming an unused df_ name non_select_statement, not missing_table, on both surfaces',
    async (_label, sqlFor) => {
      const { ctx, name } = await staged();
      const error = await failure({ sql: sqlFor(name) }, ctx);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({
        reason: 'non_select_statement',
        recovery: { hint: contractRecovery('non_select_statement') },
      });

      wireCanvas();
      const result = await runToolContract(dataframeQueryTool, { sql: sqlFor('df_OTHER_TABLE') });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'non_select_statement' } },
      });
      const text = contentText(result);
      expect(text).toContain('Canvas query must be SELECT');
      expect(text).toContain(`Recovery: ${contractRecovery('non_select_statement')}`);
      expect(text).not.toContain('does not exist');
    },
  );

  it('still fails a comment-led SELECT of an unused df_ name missing_table', async () => {
    const { ctx } = await staged();
    const error = await failure({ sql: '-- first\n/* then */ SELECT * FROM df_NOPE0_NOPE0' }, ctx);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.message).toBe('Dataframe df_NOPE0_NOPE0 does not exist or has expired.');
    expect(error.data).toMatchObject({ reason: 'missing_table', tableName: 'df_NOPE0_NOPE0' });
  });

  /** Reads that open with neither SELECT, WITH, FROM, nor `(`, each run over `name`. */
  const READ_OPENERS: [string, (name: string) => string][] = [
    ['VALUES', (name) => `VALUES ((SELECT count(*) FROM ${name}))`],
    ['PIVOT … IN', (name) => `PIVOT ${name} ON sex IN ('SEX_F', 'SEX_M') USING max(value)`],
    [
      'UNPIVOT',
      (name) => `UNPIVOT (SELECT ref_area, value FROM ${name}) ON value INTO NAME k VALUE v`,
    ],
    ['SUMMARIZE', (name) => `SUMMARIZE ${name}`],
    ['DESCRIBE', (name) => `DESCRIBE ${name}`],
    ['SHOW', (name) => `SHOW ${name}`],
    ['TABLE', (name) => `TABLE ${name}`],
  ];

  it.each(READ_OPENERS)(
    'runs a %s over a staged dataframe through the gate',
    async (_label, sqlFor) => {
      const { ctx, name } = await staged();
      const result = await runQuery({ sql: sqlFor(name) }, ctx);
      expect(result.row_count).toBeGreaterThan(0);
    },
  );

  it.each(READ_OPENERS)(
    'fails a %s of an unused df_ name missing_table, not non_select_statement, on both surfaces',
    async (_label, sqlFor) => {
      const { ctx } = await staged();
      const error = await failure({ sql: sqlFor('df_nope0_nope0') }, ctx);
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.message).toBe('Dataframe df_NOPE0_NOPE0 does not exist or has expired.');
      expect(error.data).toMatchObject({
        reason: 'missing_table',
        tableName: 'df_NOPE0_NOPE0',
        recovery: { hint: MISSING_TABLE_RECOVERY },
      });

      const result = await runToolContract(dataframeQueryTool, { sql: sqlFor('df_nope0_nope0') });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'missing_table' } },
      });
      expect(contentText(result)).toContain(
        'Dataframe df_NOPE0_NOPE0 does not exist or has expired.',
      );
    },
  );

  it('fails a PIVOT … IN naming an unknown column invalid_sql, not non_select_statement, on both surfaces', async () => {
    const { ctx, name } = await staged();
    const sql = `PIVOT ${name} ON nope IN ('x') USING max(value)`;
    const error = await failure({ sql }, ctx);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_sql',
      recovery: { hint: contractRecovery('invalid_sql') },
    });

    const result = await runToolContract(dataframeQueryTool, {
      sql: "PIVOT (SELECT 'x' AS sex, 1 AS value) ON nope IN ('x') USING max(value)",
    });
    expect(result.structuredContent).toMatchObject({ error: { data: { reason: 'invalid_sql' } } });
    expect(contentText(result)).toContain(`Recovery: ${contractRecovery('invalid_sql')}`);
  });

  it.each([
    ['a PIVOT with no IN list', (name: string) => `PIVOT ${name} ON sex USING max(value)`],
    [
      'a PIVOT with no IN list in a subquery',
      (name: string) => `SELECT * FROM (PIVOT ${name} ON sex USING max(value))`,
    ],
  ])('fails %s multi_statement with a recovery that names the IN list', async (_label, sqlFor) => {
    const { ctx, name } = await staged();
    const error = await failure({ sql: sqlFor(name) }, ctx);
    expect(error.data).toMatchObject({
      reason: 'multi_statement',
      recovery: { hint: contractRecovery('multi_statement') },
    });
    expect(contractRecovery('multi_statement')).toContain('ON <column> IN (');
  });

  it.each([
    [
      'SUMMARIZE of a system catalog',
      () => 'SUMMARIZE information_schema.tables',
      'system_catalog_access',
    ],
    [
      'VALUES over read_csv()',
      () => "VALUES ((SELECT count(*) FROM read_csv('/etc/hosts')))",
      'denied_function',
    ],
    ['SHOW TABLES', () => 'SHOW TABLES', 'plan_operator_not_allowed'],
    ['a bare DESCRIBE', () => 'DESCRIBE', 'plan_operator_not_allowed'],
    ['SHOW ALL TABLES', () => 'SHOW ALL TABLES', 'plan_operator_not_allowed'],
  ])('still gates %s', async (_label, sql, reason) => {
    const { ctx } = await staged();
    const error = await failure({ sql: sql() }, ctx);
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
      initCanvasBridge(canvas, {
        tableTtlMs: 24 * HOUR_MS,
        dropEnabled,
        listingEnabled: true,
        now: () => FIXED_NOW,
        previewChars: 40_000,
      });
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
      applied_limits: appliedLimits(1000),
    });
    const text = contentText(result);
    expect(text).toContain('**1 row**\n\n| n | s |\n| --- | --- |\n| 1 | a |');
    expect(text).toContain('**Applied limits:** row_limit 1000 · preview 1000');
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
      applied_limits: appliedLimits(1000),
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
      'Showing 2 rows. The query matched more than row_limit (2), so row_count is that cap, not a total. Use register_as to keep the whole result — its row_count is then exact — or raise row_limit (up to 10,000).';
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

  it('a page capped at one row counts it in the singular on both surfaces', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3',
      row_limit: 1,
    });
    const guidance =
      'Showing 1 row. The query matched more than row_limit (1), so row_count is that cap, not a total. Use register_as to keep the whole result — its row_count is then exact — or raise row_limit (up to 10,000).';
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      row_count: 1,
      row_count_capped: true,
      truncated: true,
      shown: 1,
      cap: 1,
      notice: guidance,
    });
    const text = contentText(result);
    expect(text).toContain('**1 row** — capped at row_limit; more rows matched');
    expect(text).toContain(guidance);
  });

  it.each([
    [
      'registered',
      { register_as: 'df_SINGL_ROW01' },
      'Showing 0 of 1 row. The row is stored as df_SINGL_ROW01; query that dataframe with ilostat_dataframe_query, or raise preview to see more inline.',
    ],
    [
      'unregistered',
      {},
      'Showing 0 of 1 row. Use register_as to keep the full result, or raise preview.',
    ],
  ])(
    'a one-row result at preview 0, %s, counts it in the singular on both surfaces',
    async (_, extra, guidance) => {
      wireCanvas();
      const result = await runToolContract(dataframeQueryTool, {
        sql: 'SELECT 1 AS n',
        preview: 0,
        ...extra,
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        row_count: 1,
        rows: [],
        truncated: true,
        shown: 0,
        notice: guidance,
      });
      const text = contentText(result);
      expect(text).toContain('**1 row** (showing 0 of 1)');
      expect(text).toContain(guidance);
    },
  );

  it('a cell holding NEL, LS, or PS gets one <br> per break, verbatim in structuredContent', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeQueryTool, {
      sql: "SELECT 'a' || chr(8232) || '| forged |' || chr(8233) || 'b' || chr(133) || 'c' AS note",
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      rows: [{ note: 'a\u2028| forged |\u2029b\u0085c' }],
    });
    const text = contentText(result);
    expect(text).toContain('| a<br>\\| forged \\|<br>b<br>c |');
    expect(text).not.toMatch(/[\u0085\u2028\u2029]/);
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
    ['row_limit 1,000,001', { sql: 'SELECT 1 AS n', row_limit: 1_000_001 }],
    ['preview -1', { sql: 'SELECT 1 AS n', preview: -1 }],
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
