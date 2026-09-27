/**
 * @fileoverview Tests for the DataCanvas adapter on a real in-memory DuckDB
 * canvas: `routeRows` on its four outcomes with the character and row
 * boundaries hit exactly, the `canvas_failed` preview when acquiring, appending,
 * or recording provenance fails (and a source failure that must not degrade),
 * the `df-meta` provenance record and its expiry, a `register_as` dataframe
 * recording its SQL and `derived_from` and inheriting its parents' datasets,
 * the per-tenant canvas and its re-mint, the lazy expiry sweep, the rewrap of
 * engine rejections, `initCanvasBridge`, and the failed-staging disclosure on
 * both producers and both consumption paths.
 * @module tests/services/canvas-bridge/canvas-bridge.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { CanvasInstance, type ColumnSchema, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import {
  databaseError,
  JsonRpcErrorCode,
  McpError,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { ErrorHandler } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareGeographiesTool } from '@/mcp-server/tools/definitions/compare-geographies.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { queryIndicatorTool } from '@/mcp-server/tools/definitions/query-indicator.tool.js';
import { ATTRIBUTION } from '@/services/attribution.js';
import {
  CanvasBridge,
  type DataframeMeta,
  getCanvasBridge,
  initCanvasBridge,
  type Provenance,
  routeRows,
} from '@/services/canvas-bridge/canvas-bridge.js';
import { disposeIlostatServices } from '@/services/ilostat-services.js';
import {
  type CanvasFault,
  FIXED_NOW,
  faultyCanvas,
  memoryCanvas,
  sharingState,
  wireDataframes,
} from '../../helpers/ilostat-upstream.js';
import { guardNetwork } from '../../helpers/network-guard.js';

guardNetwork();

const TENANT = 'default';
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

const TTL_MS = 3_600_000;
const TABLE_NAME = /^df_[A-Z0-9]{5}_[A-Z0-9]{5}$/;
const UNE_DATASET = {
  datasetId: 'UNE_DEAP_SEX_AGE_RT_A',
  label: 'Unemployment rate by sex and age (%)',
  lastUpdate: '2026-09-24T07:10:19',
  unit: 'Percentage',
};
const EMP_DATASET = {
  datasetId: 'EMP_TEMP_SEX_AGE_NB_A',
  label: 'Employment by sex and age (thousands)',
  lastUpdate: '2026-03-20T12:54:04',
};
const PROVENANCE: Provenance = {
  sourceTool: 'ilostat_query_indicator',
  queryParams: { dataset_ids: ['UNE_DEAP_SEX_AGE_RT_A'], ref_areas: ['USA'] },
  datasets: [UNE_DATASET],
  coverage: { refAreas: 1, periodMin: '2023', periodMax: '2025' },
  basisCounts: { reported: 5, modelled_estimate: 0, projection: 0 },
  attribution: ATTRIBUTION,
};

/** Every synthetic row serializes to exactly this many characters: `{"k":"r000"}`. */
const ROW_CHARS = 12;
const SCHEMA: ColumnSchema[] = [{ name: 'k', type: 'VARCHAR' }];
const rowAt = (index: number) => ({ k: `r${String(index).padStart(3, '0')}` });

/** A source of `count` rows recording how many were pulled and whether it was closed; `failAt` throws before that row. */
function rowSource(count: number, failAt?: { error: Error; row: number }) {
  const state = { closed: false, pulled: 0 };
  const rows = (async function* () {
    try {
      for (let index = 0; index < count; index++) {
        if (failAt?.row === index) throw failAt.error;
        state.pulled++;
        yield rowAt(index);
      }
    } finally {
      state.closed = true;
    }
  })();
  return { rows, state };
}

/** A settable clock for the bridge, starting at {@link FIXED_NOW}. */
function clock() {
  let now = FIXED_NOW.getTime();
  return {
    now: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
  };
}

function newBridge(canvas: DataCanvas, now: () => Date = () => FIXED_NOW, dropEnabled = false) {
  return new CanvasBridge(canvas, { tableTtlMs: TTL_MS, dropEnabled, listingEnabled: true, now });
}

function newContext() {
  return createMockContext({ tenantId: TENANT, errors: dataframeQueryTool.errors });
}

function route(
  bridge: CanvasBridge | undefined,
  ctx: Context,
  source: AsyncIterable<{ k: string }>,
  options: { maxRows?: number; previewChars: number; provenance?: () => Provenance },
) {
  return routeRows(bridge, {
    ctx,
    source,
    schema: SCHEMA,
    previewChars: options.previewChars,
    ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
    provenance: options.provenance ?? (() => PROVENANCE),
  });
}

async function tableNames(bridge: CanvasBridge, ctx: Context): Promise<string[]> {
  return (await (await bridge.acquire(ctx)).describe()).map((table) => table.name);
}

async function metaKeys(ctx: Context): Promise<string[]> {
  return (await ctx.state.list('df-meta/')).items.map((item) => item.key);
}

function warnings(ctx: Context): string[] {
  return (ctx.log as MockContextLogger).calls
    .filter((call) => call.level === 'warning')
    .map((call) => call.msg);
}

/** Stages `count` synthetic rows under `provenance` and returns the table name. */
async function stage(
  bridge: CanvasBridge,
  ctx: Context,
  count: number,
  provenance: Provenance = PROVENANCE,
): Promise<string> {
  const outcome = await route(bridge, ctx, rowSource(count).rows, {
    previewChars: ROW_CHARS,
    provenance: () => provenance,
  });
  if (outcome.kind !== 'staged') throw new Error(`expected a staged outcome, got ${outcome.kind}`);
  return outcome.table.name;
}

describe('routeRows with dataframes off', () => {
  it('returns every row as complete when the rows fill the preview budget exactly', async () => {
    const source = rowSource(5);
    const outcome = await route(undefined, newContext(), source.rows, {
      previewChars: 5 * ROW_CHARS,
    });
    expect(outcome).toEqual({ kind: 'complete', rows: [0, 1, 2, 3, 4].map(rowAt) });
    expect(source.state).toEqual({ pulled: 5, closed: true });
  });

  it('stops one character short: the rows that fit, the source read one row past them and closed', async () => {
    const source = rowSource(500);
    const outcome = await route(undefined, newContext(), source.rows, {
      previewChars: 5 * ROW_CHARS - 1,
    });
    expect(outcome).toEqual({
      kind: 'preview',
      cause: 'canvas_off',
      rows: [0, 1, 2, 3].map(rowAt),
    });
    expect(source.state).toEqual({ pulled: 5, closed: true });
  });

  it('propagates a failure of the source itself', async () => {
    const error = new Error('upstream dropped the connection');
    const source = rowSource(10, { row: 2, error });
    await expect(
      route(undefined, newContext(), source.rows, { previewChars: 10 * ROW_CHARS }),
    ).rejects.toBe(error);
  });
});

describe('routeRows with a canvas', () => {
  it('keeps an exact fit inline: complete, no table, no provenance', async () => {
    const bridge = newBridge(tracked(memoryCanvas()));
    const ctx = newContext();
    const provenance = vi.fn(() => PROVENANCE);
    const outcome = await route(bridge, ctx, rowSource(5).rows, {
      previewChars: 5 * ROW_CHARS,
      provenance,
    });
    expect(outcome).toEqual({ kind: 'complete', rows: [0, 1, 2, 3, 4].map(rowAt) });
    expect(provenance).not.toHaveBeenCalled();
    expect(await tableNames(bridge, ctx)).toEqual([]);
    expect(await metaKeys(ctx)).toEqual([]);
  });

  it('stages one character past the budget: the preview inline, every row staged, provenance recorded', async () => {
    const canvas = tracked(memoryCanvas());
    const bridge = newBridge(canvas);
    const ctx = newContext();
    const source = rowSource(5);
    const pulledAtProvenance: number[] = [];
    const outcome = await route(bridge, ctx, source.rows, {
      previewChars: 5 * ROW_CHARS - 1,
      provenance: () => {
        pulledAtProvenance.push(source.state.pulled);
        return PROVENANCE;
      },
    });
    if (outcome.kind !== 'staged') throw new Error(`expected staged, got ${outcome.kind}`);
    const expiresAt = new Date(FIXED_NOW.getTime() + TTL_MS).toISOString();
    expect(outcome.rows).toEqual([0, 1, 2, 3].map(rowAt));
    expect(outcome.table).toEqual({
      name: outcome.table.name,
      rowCount: 5,
      expiresAt,
      evicted: [],
    });
    expect(outcome.table.name).toMatch(TABLE_NAME);
    // provenance is read once, after the whole source was consumed
    expect(pulledAtProvenance).toEqual([5]);
    expect(source.state.closed).toBe(true);

    const instance = await bridge.acquire(ctx);
    const staged = await instance.query(`SELECT k FROM ${outcome.table.name} ORDER BY k`);
    expect(staged.rows).toEqual([0, 1, 2, 3, 4].map(rowAt));
    const [table] = await instance.describe();
    expect(table).toMatchObject({ name: outcome.table.name, rowCount: 5 });
    // registered with a per-table TTL on the canvas as well
    expect(table?.expiresAt).toEqual(expect.any(String));

    const meta = await ctx.state.get<DataframeMeta>(`df-meta/${outcome.table.name}`);
    expect(meta).toEqual({
      ...PROVENANCE,
      tableName: outcome.table.name,
      rowCount: 5,
      columnSchema: SCHEMA,
      createdAt: FIXED_NOW.toISOString(),
      expiresAt,
    });
  });

  it('stages a source of exactly maxRows rows', async () => {
    const bridge = newBridge(tracked(memoryCanvas()));
    const outcome = await route(bridge, newContext(), rowSource(5).rows, {
      previewChars: ROW_CHARS,
      maxRows: 5,
    });
    expect(outcome).toMatchObject({ kind: 'staged', table: { rowCount: 5 } });
  });

  it('refuses one row past maxRows as too_large: the partial table dropped, nothing recorded, the source closed', async () => {
    const bridge = newBridge(tracked(memoryCanvas()));
    const ctx = newContext();
    const source = rowSource(500);
    const provenance = vi.fn(() => PROVENANCE);
    const outcome = await route(bridge, ctx, source.rows, {
      previewChars: ROW_CHARS,
      maxRows: 4,
      provenance,
    });
    expect(outcome).toEqual({ kind: 'too_large' });
    expect(provenance).not.toHaveBeenCalled();
    expect(await tableNames(bridge, ctx)).toEqual([]);
    expect(await metaKeys(ctx)).toEqual([]);
    // the fifth row proved the source passed the ceiling; nothing after it was read
    expect(source.state).toEqual({ pulled: 5, closed: true });
  });

  it('propagates a source failure mid-spill instead of degrading, leaving no table behind', async () => {
    const bridge = newBridge(tracked(memoryCanvas()));
    const ctx = newContext();
    const error = new Error('upstream dropped the connection');
    await expect(
      route(bridge, ctx, rowSource(50, { row: 20, error }).rows, { previewChars: ROW_CHARS }),
    ).rejects.toBe(error);
    expect(await tableNames(bridge, ctx)).toEqual([]);
    expect(await metaKeys(ctx)).toEqual([]);
  });
});

describe('routeRows when the canvas fails', () => {
  it.each([
    [
      'acquire rejects (an engine that cannot load)',
      {
        at: 'acquire',
        error: new McpError(
          JsonRpcErrorCode.ConfigurationError,
          'The DuckDB native binding could not be loaded.',
        ),
      },
      'Dataframe canvas unavailable; returning the inline preview only',
    ],
    [
      'the append fails after three rows',
      { at: 'registerTable', afterRows: 3, error: new Error('Out of Memory Error: failed') },
      'Staging the full result failed; returning the inline preview only',
    ],
  ] satisfies [string, CanvasFault, string][])(
    'falls back to the preview when %s, leaving nothing staged',
    async (_label, fault, warning) => {
      const canvas = tracked(faultyCanvas(fault));
      const bridge = newBridge(canvas);
      const ctx = newContext();
      const source = rowSource(500);
      const outcome = await route(bridge, ctx, source.rows, { previewChars: 5 * ROW_CHARS - 1 });
      expect(outcome).toEqual({
        kind: 'preview',
        cause: 'canvas_failed',
        rows: [0, 1, 2, 3].map(rowAt),
      });
      expect(warnings(ctx)).toEqual([warning]);
      expect(await metaKeys(ctx)).toEqual([]);
      expect(source.state.closed).toBe(true);
      expect(source.state.pulled).toBeLessThan(10);
      if (fault.at === 'registerTable') expect(await tableNames(bridge, ctx)).toEqual([]);
    },
  );

  it('still reports a result that fits as complete when the canvas cannot be acquired', async () => {
    const bridge = newBridge(
      tracked(faultyCanvas({ at: 'acquire', error: new Error('engine failed to start') })),
    );
    const outcome = await route(bridge, newContext(), rowSource(5).rows, {
      previewChars: 5 * ROW_CHARS,
    });
    expect(outcome).toEqual({ kind: 'complete', rows: [0, 1, 2, 3, 4].map(rowAt) });
  });

  it('falls back to the preview and drops the table when recording provenance fails', async () => {
    const bridge = newBridge(tracked(memoryCanvas()));
    const ctx = newContext();
    const set = ctx.state.set.bind(ctx.state);
    vi.spyOn(ctx.state, 'set').mockImplementation((key, value, options) =>
      key.startsWith('df-meta/')
        ? Promise.reject(new Error('storage quota exceeded'))
        : set(key, value, options),
    );
    const outcome = await route(bridge, ctx, rowSource(5).rows, {
      previewChars: 5 * ROW_CHARS - 1,
    });
    expect(outcome).toEqual({
      kind: 'preview',
      cause: 'canvas_failed',
      rows: [0, 1, 2, 3].map(rowAt),
    });
    expect(warnings(ctx)).toEqual([
      'Recording dataframe provenance failed; returning the inline preview only',
    ]);
    expect(await tableNames(bridge, ctx)).toEqual([]);
  });

  it.each([
    [
      'a spill file DuckDB cannot open',
      {
        at: 'registerTable',
        afterRows: 3,
        error: new Error(
          'IO Error: Cannot open file "/srv/canvas-tmp/duckdb_temp_storage_DEFAULT-0.tmp": Permission denied',
        ),
      },
      'IO Error: Cannot open file "[path]": Permission denied',
    ],
    [
      'a temp root that cannot be created',
      { at: 'acquire', error: new Error("EACCES: permission denied, mkdir '/srv/canvas-tmp'") },
      "EACCES: permission denied, mkdir '[path]'",
    ],
  ] satisfies [string, CanvasFault, string][])(
    'keeps the path of %s out of the client-visible warning',
    async (_label, fault, redacted) => {
      const ctx = newContext();
      await route(newBridge(tracked(faultyCanvas(fault))), ctx, rowSource(500).rows, {
        previewChars: 5 * ROW_CHARS - 1,
      });
      const logged = (ctx.log as MockContextLogger).calls.filter(
        (call) => call.level === 'warning',
      );
      expect(logged.map((call) => call.data)).toEqual([{ error: redacted }]);
      expect(JSON.stringify(logged)).not.toContain('/srv/canvas-tmp');
    },
  );
});

describe('register_as provenance (derived dataframes)', () => {
  it('records the SQL and derived_from, inherits the parents’ datasets once each, and leaves coverage and basis absent', async () => {
    const time = clock();
    const bridge = newBridge(tracked(memoryCanvas()), time.now);
    const ctx = newContext();
    const first = await stage(bridge, ctx, 5);
    time.advance(1_000);
    const second = await stage(bridge, ctx, 3, {
      ...PROVENANCE,
      sourceTool: 'ilostat_compare_geographies',
      datasets: [EMP_DATASET, UNE_DATASET],
    });
    time.advance(59_000);

    // the first parent is named in lowercase, and a df_ name inside a string literal is no reference
    const sql = `SELECT a.k FROM ${first.toLowerCase()} a JOIN ${second} b USING (k) WHERE a.k <> 'df_ZZZZZ_ZZZZZ' ORDER BY a.k`;
    const { result, meta } = await bridge.query(ctx, sql, {
      rowLimit: 100,
      registerAs: 'df_DERIV_ED001',
      sourceTool: 'ilostat_dataframe_query',
    });
    expect(result).toMatchObject({ tableName: 'df_DERIV_ED001', rowCount: 3 });
    const expected = {
      sourceTool: 'ilostat_dataframe_query',
      queryParams: { sql, derived_from: [first, second] },
      datasets: [UNE_DATASET, EMP_DATASET],
      attribution: ATTRIBUTION,
      tableName: 'df_DERIV_ED001',
      rowCount: 3,
      columnSchema: [expect.objectContaining({ name: 'k', type: 'VARCHAR' })],
      createdAt: '2026-09-26T12:01:00.000Z',
      expiresAt: '2026-09-26T13:01:00.000Z',
    };
    expect(meta).toEqual(expected);
    expect(meta).not.toHaveProperty('coverage');
    expect(meta).not.toHaveProperty('basisCounts');
    expect(await ctx.state.get('df-meta/df_DERIV_ED001')).toEqual(expected);

    const listed = await bridge.describe(ctx);
    expect(listed.map((entry) => entry.tableName)).toEqual(['df_DERIV_ED001', second, first]);
  });

  it('records an empty lineage for a result that read no dataframe', async () => {
    const bridge = newBridge(tracked(memoryCanvas()));
    const { meta } = await bridge.query(newContext(), 'SELECT 42 AS answer', {
      rowLimit: 10,
      registerAs: 'df_CONST_ANT01',
      sourceTool: 'ilostat_dataframe_query',
    });
    expect(meta).toMatchObject({
      queryParams: { sql: 'SELECT 42 AS answer', derived_from: [] },
      datasets: [],
      rowCount: 1,
    });
  });

  it('refuses register_as over a recorded name with the drop-aware hint, before the engine runs', async () => {
    const canvas = tracked(memoryCanvas());
    const ctx = newContext();
    const name = await stage(newBridge(canvas), ctx, 5);
    const run = vi.spyOn(CanvasInstance.prototype, 'query');
    for (const [dropEnabled, hint] of [
      [false, 'Choose another df_XXXXX_XXXXX name or omit register_as.'],
      [
        true,
        'Drop the existing dataframe with ilostat_dataframe_drop, choose another df_XXXXX_XXXXX name, or omit register_as.',
      ],
    ] as const) {
      const error = await newBridge(canvas, () => FIXED_NOW, dropEnabled)
        .query(ctx, 'SELECT 1 AS one', { rowLimit: 10, registerAs: name, sourceTool: 'test' })
        .catch((caught: unknown) => caught as McpError);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: `Dataframe ${name} already exists; register_as needs an unused name.`,
        data: { reason: 'register_as_clash', tableName: name, recovery: { hint } },
      });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('rebuilds the engine’s own clash (a table with no provenance) with the same hint', async () => {
    const bridge = newBridge(tracked(memoryCanvas()), () => FIXED_NOW, true);
    const ctx = newContext();
    const name = await stage(bridge, ctx, 5);
    await ctx.state.delete(`df-meta/${name}`);
    const error = await bridge
      .query(ctx, 'SELECT 1 AS one', { rowLimit: 10, registerAs: name, sourceTool: 'test' })
      .catch((caught: unknown) => caught as McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'register_as_clash',
        recovery: {
          hint: 'Drop the existing dataframe with ilostat_dataframe_drop, choose another df_XXXXX_XXXXX name, or omit register_as.',
        },
      },
    });
  });
});

describe('df_ names in comments, strings, and aliases', () => {
  const MISSING = 'df_NOSUC_HTBL1';

  /** Stages a parent holding {@link UNE_DATASET}, then stores `sqlFor(parent)` with register_as. */
  async function derive(sqlFor: (parent: string) => string) {
    const bridge = newBridge(tracked(memoryCanvas()));
    const ctx = newContext();
    const parent = await stage(bridge, ctx, 5);
    const { meta } = await bridge.query(ctx, sqlFor(parent), {
      rowLimit: 10,
      registerAs: 'df_DERIV_ED001',
      sourceTool: 'ilostat_dataframe_query',
    });
    return { parent, meta };
  }

  it.each([
    ['an apostrophe in a line comment', (p: string) => `-- it's\nSELECT * FROM ${p} -- isn't`],
    [
      'an apostrophe in a block comment',
      (p: string) => `/* it's */ SELECT * FROM ${p} /* isn't */`,
    ],
    [
      'an apostrophe in a nested block comment',
      (p: string) => `/* a /* it's */ b */ SELECT * FROM ${p} WHERE 'a' = 'a'`,
    ],
    [
      'a backslash-escaped quote in an E-string',
      (p: string) => `SELECT k, E'it\\'s' AS s FROM ${p} WHERE 'a' = 'a'`,
    ],
    [
      'an apostrophe in a dollar-quoted string',
      (p: string) => `SELECT k, $$it's$$ AS s FROM ${p} WHERE 'a' = 'a'`,
    ],
  ])(
    'reads the dataframe past %s, so the stored table inherits its datasets',
    async (_label, sqlFor) => {
      const { parent, meta } = await derive(sqlFor);
      expect(meta).toMatchObject({
        queryParams: { derived_from: [parent] },
        datasets: [UNE_DATASET],
      });
    },
  );

  it.each([
    ['a line comment', (p: string) => `SELECT 42 AS answer -- ${p}`],
    ['a block comment', (p: string) => `SELECT 42 AS answer /* ${p} */`],
    ['a dollar-quoted string', (p: string) => `SELECT $$${p}$$ AS s`],
    ['an E-string after an escaped quote', (p: string) => `SELECT E'\\'${p}' AS s`],
  ])('never takes a name that appears only in %s as a parent', async (_label, sqlFor) => {
    const { meta } = await derive(sqlFor);
    expect(meta).toMatchObject({ queryParams: { derived_from: [] }, datasets: [] });
  });

  it.each([
    ['a line comment', `SELECT 42 AS answer -- ${MISSING}`],
    ['a dollar-quoted string', `SELECT $$${MISSING}$$ AS s`],
    ['a tagged dollar-quoted string', `SELECT $t$${MISSING}$t$ AS s`],
    ['a double-quoted alias', `SELECT 1 AS "${MISSING}"`],
    ['a bare alias', `SELECT 1 AS ${MISSING}`],
    ['a CTE name', `WITH ${MISSING} AS (SELECT 1 AS one) SELECT one FROM ${MISSING}`],
  ])('runs valid SQL that names an unstaged df_ only in %s', async (_label, sql) => {
    const bridge = newBridge(tracked(memoryCanvas()));
    const { result } = await bridge.query(newContext(), sql, { rowLimit: 10, sourceTool: 'test' });
    expect(result.rowCount).toBe(1);
  });

  it.each([
    ['in a plain SELECT', `SELECT * FROM ${MISSING}`],
    ['after a comment holding apostrophes', `-- it's\nSELECT * FROM ${MISSING} -- '`],
    [
      'after a comment, double-quoted and in another case',
      '/* x */ SELECT * FROM "DF_nosuc_htbl1"',
    ],
    ['inside parentheses', `(SELECT * FROM ${MISSING})`],
  ])('fails missing_table for an unstaged dataframe read %s', async (_label, sql) => {
    const bridge = newBridge(tracked(memoryCanvas()));
    const error = await bridge
      .query(newContext(), sql, { rowLimit: 10, sourceTool: 'test' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: `Dataframe ${MISSING} does not exist or has expired.`,
      data: {
        reason: 'missing_table',
        tableName: MISSING,
        recovery: {
          hint: 'Call ilostat_dataframe_describe to list the staged dataframes, or re-run the producing tool to stage the data again.',
        },
      },
    });
  });
});

describe('the tenant canvas and the expiry sweep', () => {
  it('keeps one canvas per tenant in ctx.state and re-mints it once the stored one is gone', async () => {
    const canvas = tracked(memoryCanvas());
    const bridge = newBridge(canvas);
    const ctx = newContext();
    const first = await bridge.acquire(ctx);
    expect(first.isNew).toBe(true);
    expect(await ctx.state.get('canvas-id')).toBe(first.canvasId);
    expect((await bridge.acquire(ctx)).canvasId).toBe(first.canvasId);

    await canvas.drop(first.canvasId, ctx);
    const second = await bridge.acquire(ctx);
    expect(second.canvasId).not.toBe(first.canvasId);
    expect(await ctx.state.get('canvas-id')).toBe(second.canvasId);
  });

  it('mints one canvas for two concurrent first calls on a tenant, and keeps both calls’ dataframes', async () => {
    const bridge = newBridge(tracked(memoryCanvas()));
    const first = newContext();
    const second = sharingState(newContext(), first);
    const [a, b] = await Promise.all([bridge.acquire(first), bridge.acquire(second)]);
    expect(b.canvasId).toBe(a.canvasId);
    expect(await first.state.get('canvas-id')).toBe(a.canvasId);

    const fresh = newContext();
    const other = sharingState(newContext(), fresh);
    const names = await Promise.all([stage(bridge, fresh, 5), stage(bridge, other, 5)]);
    expect((await tableNames(bridge, fresh)).sort()).toEqual([...names].sort());
    expect((await metaKeys(fresh)).sort()).toEqual(names.map((name) => `df-meta/${name}`).sort());
  });

  it('sweeps a dataframe exactly at its expiry, dropping the table and its provenance', async () => {
    const time = clock();
    const bridge = newBridge(tracked(memoryCanvas()), time.now);
    const ctx = newContext();
    const older = await stage(bridge, ctx, 5);
    time.advance(TTL_MS / 2);
    const newer = await stage(bridge, ctx, 5);

    time.advance(TTL_MS / 2 - 1);
    await bridge.sweepExpired(ctx);
    expect((await tableNames(bridge, ctx)).sort()).toEqual([newer, older].sort());

    time.advance(1);
    await bridge.sweepExpired(ctx);
    expect(await tableNames(bridge, ctx)).toEqual([newer]);
    expect(await metaKeys(ctx)).toEqual([`df-meta/${newer}`]);
  });
});

describe('engine rejections are rebuilt with the calling tool’s contract', () => {
  async function queryFailure(engineError: unknown) {
    const bridge = newBridge(tracked(memoryCanvas()));
    vi.spyOn(CanvasInstance.prototype, 'query').mockRejectedValueOnce(engineError);
    return bridge
      .query(newContext(), 'SELECT 1 AS one', { rowLimit: 10, sourceTool: 'test' })
      .catch((caught: unknown) => caught);
  }

  it('reports the plan-level denied function as denied_function with this tool’s recovery', async () => {
    const engineError = validationError('Denied function in plan: read_csv', {
      reason: 'denied_function_in_plan',
      recovery: { hint: 'framework hint' },
    });
    const error = (await queryFailure(engineError)) as McpError;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'Denied function in plan: read_csv',
      data: {
        reason: 'denied_function',
        recovery: {
          hint: 'Remove the file-reading function and query only df_<id> tables, by the names the producing tools returned.',
        },
      },
    });
    expect(error.cause).toBe(engineError);
  });

  it('reports an engine that cannot load as canvas_unavailable, naming only the engine failure', async () => {
    const error = (await queryFailure(
      new McpError(JsonRpcErrorCode.ConfigurationError, 'DuckDB is not installed.'),
    )) as McpError;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message:
        'Dataframes are unavailable in this deployment: the DataCanvas DuckDB engine could not be loaded.',
      data: {
        reason: 'canvas_unavailable',
        recovery: {
          hint: 'Dataframes are off in this deployment; call ilostat_query_indicator or ilostat_compare_geographies with narrower filters so the result fits inline.',
        },
      },
    });
  });

  it.each([
    [
      'an undeclared framework reason',
      validationError('bad bounds', { reason: 'invalid_query_bounds' }),
    ],
    ['a plain error', new Error('socket hang up')],
  ])('passes %s through untouched', async (_label, engineError) => {
    expect(await queryFailure(engineError)).toBe(engineError);
  });

  const SPILL_FAILURE =
    'IO Error: Cannot open file "/srv/canvas-tmp/duckdb_temp_storage_DEFAULT-0.tmp": Permission denied';
  const UNCLASSIFIED_SPILL_FAILURE = new Error(SPILL_FAILURE);
  it.each([
    ['an engine I/O failure', databaseError(SPILL_FAILURE), JsonRpcErrorCode.DatabaseError],
    [
      'an engine failure the framework left unclassified',
      UNCLASSIFIED_SPILL_FAILURE,
      ErrorHandler.classifyOnly(UNCLASSIFIED_SPILL_FAILURE).code,
    ],
    [
      'a spill failure the engine classed read-only',
      validationError(`Canvas SQL rejected: ${SPILL_FAILURE}`, {
        reason: 'sql_read_only',
        recovery: { hint: 'Send a read-only SELECT.' },
      }),
      JsonRpcErrorCode.ValidationError,
    ],
    [
      'a declared reason',
      validationError(`Canvas query failed: ${SPILL_FAILURE}`, {
        reason: 'sql_execution_error',
        recovery: { hint: 'framework hint' },
      }),
      JsonRpcErrorCode.ValidationError,
    ],
  ])('keeps the spill path of %s out of the message', async (_label, engineError, code) => {
    const error = (await queryFailure(engineError)) as McpError;
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(code);
    expect(error.message).toContain('IO Error: Cannot open file "[path]": Permission denied');
    expect(JSON.stringify({ message: error.message, data: error.data })).not.toContain(
      '/srv/canvas-tmp',
    );
    expect(error.cause).toBe(engineError);
  });
});

describe('initCanvasBridge', () => {
  it('leaves dataframes off without a canvas: no bridge, and producers stop at the preview', async () => {
    initCanvasBridge(tracked(memoryCanvas()));
    expect(initCanvasBridge(undefined)).toBeUndefined();
    expect(getCanvasBridge()).toBeUndefined();
    const outcome = await route(getCanvasBridge(), newContext(), rowSource(50).rows, {
      previewChars: ROW_CHARS,
    });
    expect(outcome).toEqual({ kind: 'preview', cause: 'canvas_off', rows: [rowAt(0)] });
  });

  it('reads the TTL and the drop gate from the server config when no options are given', async () => {
    const bridge = initCanvasBridge(tracked(memoryCanvas()));
    expect(getCanvasBridge()).toBe(bridge);
    if (!bridge) throw new Error('expected a bridge');
    expect(bridge.tableTtlMs).toBe(86_400_000);
    const ctx = newContext();
    const name = await stage(bridge, ctx, 5);
    const meta = await ctx.state.get<DataframeMeta>(`df-meta/${name}`);
    expect(Date.parse(meta?.expiresAt ?? '') - Date.parse(meta?.createdAt ?? '')).toBe(86_400_000);
    await expect(
      bridge.query(ctx, 'SELECT 1 AS one', { rowLimit: 10, registerAs: name, sourceTool: 'test' }),
    ).rejects.toMatchObject({
      data: {
        reason: 'register_as_clash',
        recovery: { hint: 'Choose another df_XXXXX_XXXXX name or omit register_as.' },
      },
    });
  });
});

describe('a failed staging, as the producers disclose it', () => {
  const FAULTS: [string, CanvasFault][] = [
    [
      'the engine cannot load',
      {
        at: 'acquire',
        error: new McpError(JsonRpcErrorCode.ConfigurationError, 'DuckDB is not installed.'),
      },
    ],
    ['the append fails', { at: 'registerTable', afterRows: 1, error: new Error('IO Error') }],
  ];

  function contentText(result: Awaited<ReturnType<typeof runToolContract>>): string {
    return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  }

  it.each(FAULTS)(
    'query: when %s, the preview is marked incomplete on both surfaces',
    async (_label, fault) => {
      wireDataframes({
        canvas: tracked(faultyCanvas(fault)),
        observations: { previewChars: 3_000 },
      });
      const result = await runToolContract(queryIndicatorTool, {
        dataset_ids: ['UNE_DEAP_SEX_AGE_RT_A'],
        ref_areas: ['USA', 'X01', 'KEN'],
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        notice: string;
        rows: unknown[];
        shown: number;
      };
      const shown = structured.rows.length;
      expect(shown).toBeGreaterThan(0);
      const notice = `Showing the first ${shown} rows: staging the full result as a dataframe failed, so reading stopped at the inline preview. Call again, or narrow the request to see all of it.`;
      expect(structured).toMatchObject({
        truncated: true,
        shown,
        cap: 3_000,
        summary: { complete: false },
        notice,
      });
      expect(structured).not.toHaveProperty('dataframe');
      const text = contentText(result);
      expect(text).toContain(notice);
      expect(text).toContain('complete: false');
    },
  );

  it.each(FAULTS)(
    'compare: when %s, the inline rows are cut and say why on both surfaces',
    async (_label, fault) => {
      wireDataframes({ canvas: tracked(faultyCanvas(fault)) });
      const result = await runToolContract(compareGeographiesTool, {
        dataset_id: 'UNE_DEAP_SEX_AGE_RT_A',
        ref_areas: ['USA', 'X01', 'KEN'],
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        comparability: { basis_counts: Record<string, number> };
        notice: string;
        rows: unknown[];
      };
      const shown = structured.rows.length;
      expect(shown).toBeGreaterThan(0);
      expect(shown).toBeLessThan(3);
      const notice = `Showing ${shown} of 3 areas inline: staging the full comparison as a dataframe failed. Ranks, missing, and comparability cover every area; narrow ref_areas or area_group to see the rest.`;
      expect(structured).toMatchObject({ truncated: true, shown, cap: 600 });
      expect(structured.notice).toContain(notice);
      expect(structured).not.toHaveProperty('dataframe');
      expect(structured.comparability.basis_counts).toEqual({
        reported: 2,
        modelled_estimate: 1,
        projection: 0,
      });
      expect(contentText(result)).toContain(notice);
    },
  );
});
