/**
 * @fileoverview Tests for the per-tenant staging budget on a real in-memory
 * DuckDB canvas: a tenant holds at most 1,000,000 staged rows and 100
 * dataframes, a staging past either drops the oldest other dataframes first and
 * names them (the eviction log carries only their count), a single result past
 * the row budget is never kept (`too_large` from `routeRows`,
 * `register_as_too_large` from `ilostat_dataframe_query`), a `register_as` or a
 * named describe looks up one table rather than the whole canvas, concurrent
 * admissions on a tenant run one at a time (and a failed one does not stall the
 * next), and the evicted names reach both surfaces of the three tools that stage.
 * @module tests/services/canvas-bridge/staging-budget.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { CanvasInstance, type ColumnSchema, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareGeographiesTool } from '@/mcp-server/tools/definitions/compare-geographies.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { queryIndicatorTool } from '@/mcp-server/tools/definitions/query-indicator.tool.js';
import { ATTRIBUTION } from '@/services/attribution.js';
import {
  type CanvasBridge,
  getCanvasBridge,
  initCanvasBridge,
  type Provenance,
  routeRows,
} from '@/services/canvas-bridge/canvas-bridge.js';
import { disposeIlostatServices } from '@/services/ilostat-services.js';
import {
  FIXED_NOW,
  memoryCanvas,
  sharingState,
  wireDataframes,
} from '../../helpers/ilostat-upstream.js';
import { guardNetwork } from '../../helpers/network-guard.js';

guardNetwork();

const TENANT = 'default';
const TTL_MS = 3_600_000;
const ROW_BUDGET = 1_000_000;
const DATAFRAME_CAP = 100;
const EVICTION_LOG = 'Evicted dataframes to stay within the tenant staging budget';
const TOO_LARGE_RECOVERY =
  'Filter or aggregate the SELECT so it stores at most 1,000,000 rows, or omit register_as and read the rows inline under row_limit.';
const canvases: DataCanvas[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  disposeIlostatServices();
  initCanvasBridge(undefined);
  for (const canvas of canvases.splice(0)) {
    await canvas.shutdown(createMockContext({ tenantId: TENANT }));
  }
});

function tracked(canvas: DataCanvas): DataCanvas {
  canvases.push(canvas);
  return canvas;
}

/** A settable clock, starting at {@link FIXED_NOW}, so every dataframe gets its own `createdAt`. */
function clock() {
  let now = FIXED_NOW.getTime();
  return {
    now: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
  };
}

/** The dataframe tools' bridge over a fresh in-memory canvas and `now`. */
function wireBridge(now: () => Date): CanvasBridge {
  const bridge = initCanvasBridge(tracked(memoryCanvas()), {
    tableTtlMs: TTL_MS,
    dropEnabled: false,
    listingEnabled: true,
    now,
  });
  if (!bridge) throw new Error('expected a bridge');
  return bridge;
}

function queryContext() {
  return createMockContext({ tenantId: TENANT, errors: dataframeQueryTool.errors });
}

/** `SELECT` of `side` × `side` rows, built from list literals the SQL gate accepts. */
function squareSql(side: number): string {
  const values = Array.from({ length: side }, (_, index) => index).join(',');
  return `WITH v AS (SELECT unnest([${values}]) AS x) SELECT a.x AS x, b.x AS y FROM v a, v b`;
}

type QueryArgs = Parameters<typeof dataframeQueryTool.input.parse>[0];

async function runQuery(args: QueryArgs, ctx: Context) {
  return await dataframeQueryTool.handler(
    dataframeQueryTool.input.parse(args),
    ctx as Parameters<typeof dataframeQueryTool.handler>[1],
  );
}

function renderQuery(result: Awaited<ReturnType<typeof runQuery>>): string {
  return (dataframeQueryTool.format?.(result) ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
}

/** Stores a `side` × `side` result under `name` through `ilostat_dataframe_query`. */
async function registerSquare(ctx: Context, name: string, side: number): Promise<void> {
  const result = await runQuery({ sql: squareSql(side), register_as: name, preview: 0 }, ctx);
  expect(result).toMatchObject({ registered_as: name, row_count: side * side });
}

const INT_SCHEMA: ColumnSchema[] = [{ name: 'k', type: 'INTEGER' }];
const PROVENANCE: Provenance = {
  sourceTool: 'ilostat_query_indicator',
  queryParams: {},
  datasets: [],
  attribution: ATTRIBUTION,
};

/** A source of `count` integer rows recording how many were pulled and whether it was closed. */
function intSource(count: number) {
  const state = { closed: false, pulled: 0 };
  const rows = (function* () {
    try {
      for (let index = 0; index < count; index++) {
        state.pulled++;
        yield { k: index };
      }
    } finally {
      state.closed = true;
    }
  })();
  return { rows, state };
}

function stageRows(bridge: CanvasBridge, ctx: Context, count: number) {
  return routeRows(bridge, {
    ctx,
    source: intSource(count).rows,
    schema: INT_SCHEMA,
    previewChars: 10,
    provenance: () => PROVENANCE,
  });
}

/** A one-row table on `instance` under `name`, as a staging leaves it before admission. */
async function registerOneRow(instance: CanvasInstance, name: string) {
  await instance.registerTable(name, [{ k: 1 }], { schema: INT_SCHEMA });
  return { tableName: name, rowCount: 1, columnSchema: INT_SCHEMA };
}

async function canvasTables(bridge: CanvasBridge, ctx: Context): Promise<string[]> {
  return (await (await bridge.acquire(ctx)).describe()).map((table) => table.name).sort();
}

function evictionLogs(ctx: Context) {
  return (ctx.log as MockContextLogger).calls.filter((call) => call.msg === EVICTION_LOG);
}

describe('the row budget', () => {
  it('evicts the oldest dataframe when a third 400,000-row staging passes 1,000,000 rows, and names it', async () => {
    const time = clock();
    const bridge = wireBridge(time.now);
    const ctx = queryContext();
    const staged: string[] = [];
    const evicted: unknown[] = [];
    for (let call = 0; call < 3; call++) {
      const outcome = await stageRows(bridge, ctx, 400_000);
      if (outcome.kind !== 'staged') throw new Error(`expected staged, got ${outcome.kind}`);
      staged.push(outcome.table.name);
      evicted.push(outcome.table.evicted);
      time.advance(1_000);
    }
    expect(evicted).toEqual([[], [], [staged[0]]]);
    const listed = await bridge.describe(ctx);
    expect(listed.map((meta) => meta.tableName)).toEqual([staged[2], staged[1]]);
    expect(listed.reduce((sum, meta) => sum + meta.rowCount, 0)).toBe(800_000);
    expect(await canvasTables(bridge, ctx)).toEqual([staged[1], staged[2]].sort());
    expect(await ctx.state.get(`df-meta/${staged[0]}`)).toBeNull();
  }, 30_000);

  it('keeps a result of exactly the budget, then logs an eviction with its count only', async () => {
    const time = clock();
    wireBridge(time.now);
    const ctx = queryContext();
    await registerSquare(ctx, 'df_BIGGE_ST001', 1_000);
    expect(evictionLogs(ctx)).toEqual([]);
    time.advance(1_000);

    const result = await runQuery({ sql: 'SELECT 1 AS n', register_as: 'df_SMALL_00001' }, ctx);
    expect(result.evicted).toEqual(['df_BIGGE_ST001']);
    // the count alone: no dataframe name and no SQL
    expect(evictionLogs(ctx)).toEqual([{ level: 'info', msg: EVICTION_LOG, data: { count: 1 } }]);
  }, 30_000);

  it('refuses a register_as past the budget as register_as_too_large, storing and listing nothing', async () => {
    const bridge = wireBridge(() => FIXED_NOW);
    const ctx = queryContext();
    const error = await runQuery(
      { sql: squareSql(2_000), register_as: 'df_CROSS_00001', row_limit: 1, preview: 0 },
      ctx,
    ).then(
      () => undefined,
      (caught: unknown) => caught as McpError,
    );
    expect(error?.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error?.message).toBe(
      'register_as would store 4,000,000 rows, past the 1,000,000-row staging budget; nothing was stored.',
    );
    expect(error?.data).toMatchObject({
      reason: 'register_as_too_large',
      rowCount: 4_000_000,
      rowBudget: ROW_BUDGET,
      recovery: { hint: TOO_LARGE_RECOVERY },
    });
    expect(await bridge.describe(ctx)).toEqual([]);
    expect(await canvasTables(bridge, ctx)).toEqual([]);
    expect(await ctx.state.get('df-meta/df_CROSS_00001')).toBeNull();
  }, 30_000);

  it('reports register_as_too_large on both surfaces', async () => {
    wireBridge(() => FIXED_NOW);
    const result = await runToolContract(dataframeQueryTool, {
      sql: squareSql(1_001),
      register_as: 'df_CROSS_00002',
      preview: 0,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'register_as_too_large', recovery: { hint: TOO_LARGE_RECOVERY } },
      },
    });
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain(
      'register_as would store 1,002,001 rows, past the 1,000,000-row staging budget; nothing was stored.',
    );
    expect(text).toContain(TOO_LARGE_RECOVERY);
  }, 30_000);

  it('stops a producer that sets no maxRows at the budget as too_large', async () => {
    const bridge = wireBridge(() => FIXED_NOW);
    const ctx = queryContext();
    const source = intSource(ROW_BUDGET + 1);
    const outcome = await routeRows(bridge, {
      ctx,
      source: source.rows,
      schema: INT_SCHEMA,
      previewChars: 10,
      provenance: () => ({
        sourceTool: 'ilostat_query_indicator',
        queryParams: {},
        datasets: [],
        attribution: ATTRIBUTION,
      }),
    });
    expect(outcome).toEqual({ kind: 'too_large' });
    expect(source.state).toEqual({ pulled: ROW_BUDGET + 1, closed: true });
    expect(await canvasTables(bridge, ctx)).toEqual([]);
    expect(await bridge.describe(ctx)).toEqual([]);
  }, 30_000);
});

describe('the dataframe cap', () => {
  it('evicts and names the oldest of 101 one-row dataframes, leaving exactly 100', async () => {
    const time = clock();
    const bridge = wireBridge(time.now);
    const ctx = queryContext();
    const names = Array.from(
      { length: DATAFRAME_CAP + 1 },
      (_, index) => `df_ON${String(index).padStart(3, '0')}_ROW00`,
    );
    let last: Awaited<ReturnType<typeof runQuery>> | undefined;
    for (const name of names) {
      last = await runQuery({ sql: 'SELECT 1 AS n', register_as: name }, ctx);
      time.advance(1_000);
    }
    expect(last?.evicted).toEqual([names[0]]);
    const listed = await bridge.describe(ctx);
    expect(listed).toHaveLength(DATAFRAME_CAP);
    expect(listed.map((meta) => meta.tableName)).not.toContain(names[0]);
    expect(await canvasTables(bridge, ctx)).toHaveLength(DATAFRAME_CAP);
  }, 60_000);

  it('admits two concurrent stagings on a tenant holding 99 dataframes one at a time, leaving exactly 100', async () => {
    const time = clock();
    const bridge = wireBridge(time.now);
    const ctx = queryContext();
    const instance = await bridge.acquire(ctx);
    const names = Array.from(
      { length: DATAFRAME_CAP + 1 },
      (_, index) => `df_AD${String(index).padStart(3, '0')}_MIT00`,
    );
    for (const name of names.slice(0, DATAFRAME_CAP - 1)) {
      await bridge.admitTable(ctx, instance, await registerOneRow(instance, name), PROVENANCE);
      time.advance(1_000);
    }
    const pending = [];
    for (const name of names.slice(DATAFRAME_CAP - 1)) {
      pending.push(await registerOneRow(instance, name));
    }
    const admitted = await Promise.all(
      pending.map((table) => bridge.admitTable(ctx, instance, table, PROVENANCE)),
    );
    expect(await bridge.describe(ctx)).toHaveLength(DATAFRAME_CAP);
    expect(await canvasTables(bridge, ctx)).toHaveLength(DATAFRAME_CAP);
    expect(admitted.map((result) => result.evicted)).toEqual([[], [names[0]]]);
  }, 60_000);

  it('keeps admitting on a tenant after an admission fails', async () => {
    const bridge = wireBridge(() => FIXED_NOW);
    const ctx = queryContext();
    const instance = await bridge.acquire(ctx);
    const failing = await registerOneRow(instance, 'df_FAILS_00001');
    const next = await registerOneRow(instance, 'df_AFTER_00001');
    vi.spyOn(ctx.state, 'set').mockRejectedValueOnce(new Error('storage quota exceeded'));
    const [failed, admitted] = await Promise.allSettled([
      bridge.admitTable(ctx, instance, failing, PROVENANCE),
      bridge.admitTable(ctx, instance, next, PROVENANCE),
    ]);
    expect(failed).toMatchObject({
      status: 'rejected',
      reason: { message: 'storage quota exceeded' },
    });
    expect(admitted).toMatchObject({ status: 'fulfilled', value: { evicted: [] } });
    expect((await bridge.describe(ctx)).map((meta) => meta.tableName)).toEqual(['df_AFTER_00001']);
  });

  it('looks up one table, not the whole canvas, for a register_as and a named describe', async () => {
    const bridge = wireBridge(() => FIXED_NOW);
    const ctx = queryContext();
    await runQuery({ sql: 'SELECT 1 AS n', register_as: 'df_FIRST_00001' }, ctx);
    const describe = vi.spyOn(CanvasInstance.prototype, 'describe');
    await runQuery({ sql: 'SELECT 2 AS n', register_as: 'df_SECON_D0001' }, ctx);
    const [meta] = await bridge.describe(ctx, 'df_FIRST_00001');
    expect(meta?.tableName).toBe('df_FIRST_00001');
    expect(describe.mock.calls).toEqual([
      [{ tableName: 'df_SECON_D0001' }],
      [{ tableName: 'df_FIRST_00001' }],
    ]);
  });
});

describe('evicted names on both surfaces', () => {
  it('ilostat_dataframe_query names what storing its result evicted', async () => {
    const time = clock();
    wireBridge(time.now);
    const ctx = queryContext();
    await registerSquare(ctx, 'df_BIGGE_ST002', 1_000);
    time.advance(1_000);
    const result = await runQuery({ sql: 'SELECT 1 AS n', register_as: 'df_SMALL_00002' }, ctx);
    expect(result).toMatchObject({ registered_as: 'df_SMALL_00002', evicted: ['df_BIGGE_ST002'] });
    expect(renderQuery(result)).toContain(
      'Evicted df_BIGGE_ST002 (oldest first) to keep this tenant within 1,000,000 staged rows and 100 dataframes.',
    );
  }, 30_000);

  it('ilostat_query_indicator names what staging its result evicted', async () => {
    const time = clock();
    wireDataframes({ canvas: tracked(memoryCanvas()), now: time.now });
    const staging = queryContext();
    await registerSquare(staging, 'df_BIGGE_ST003', 1_000);
    time.advance(1_000);
    const ctx = sharingState(
      createMockContext({ tenantId: TENANT, errors: queryIndicatorTool.errors }),
      staging,
    );
    const result = await queryIndicatorTool.handler(
      queryIndicatorTool.input.parse({
        dataset_ids: ['UNE_DEAP_SEX_AGE_RT_A'],
        ref_areas: ['USA', 'X01', 'KEN'],
      }),
      ctx,
    );
    expect(result.dataframe).toMatchObject({ row_count: 52, evicted: ['df_BIGGE_ST003'] });
    const text = (queryIndicatorTool.format?.(result) ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain(
      'Evicted df_BIGGE_ST003 (oldest first) to keep this tenant within 1,000,000 staged rows and 100 dataframes.',
    );
    expect(await getCanvasBridge()?.describe(staging)).toHaveLength(1);
  }, 30_000);

  it('ilostat_compare_geographies names what staging its comparison evicted', async () => {
    const time = clock();
    wireDataframes({ canvas: tracked(memoryCanvas()), now: time.now });
    const staging = queryContext();
    await registerSquare(staging, 'df_BIGGE_ST004', 1_000);
    time.advance(1_000);
    const ctx = sharingState(
      createMockContext({ tenantId: TENANT, errors: compareGeographiesTool.errors }),
      staging,
    );
    const result = await compareGeographiesTool.handler(
      compareGeographiesTool.input.parse({
        dataset_id: 'UNE_DEAP_SEX_AGE_RT_A',
        ref_areas: ['USA', 'X01', 'KEN'],
      }),
      ctx,
    );
    expect(result.dataframe).toMatchObject({ row_count: 3, evicted: ['df_BIGGE_ST004'] });
    const text = (compareGeographiesTool.format?.(result) ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain(
      'Evicted df_BIGGE_ST004 (oldest first) to keep this tenant within 1,000,000 staged rows and 100 dataframes.',
    );
  }, 30_000);
});
