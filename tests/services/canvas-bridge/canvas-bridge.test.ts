/**
 * @fileoverview Tests for the DataCanvas adapter on a real in-memory DuckDB
 * canvas: `routeRows` paging by row count on every path, with the page, read
 * bound, row ceiling, and staging-trigger boundaries hit exactly, the
 * `canvas_failed` page when acquiring, appending, or recording provenance fails
 * (and a source failure or a cancellation at any of those steps, which must not
 * degrade), the `df-meta` provenance record
 * and its expiry, a `register_as` dataframe recording its SQL and `derived_from`
 * and inheriting its parents' datasets, a parent read inside a `query()` literal
 * in each form the real gate admits and at depths 1, 2, and 4 (depth 5 refused),
 * no parent from a staged name in a literal DuckDB never runs (a table aliased
 * `query` and its column list among them), `missing_table` naming an unstaged
 * one whatever the statement opens with, the per-tenant canvas and its re-mint
 * (calls racing a dead id, a cancelled holder, a refused id write, the purge
 * before the new id is stored, a bare id an earlier bridge stored), the lazy
 * expiry sweep, the rewrap of engine rejections (the gate's own recovery kept on
 * a refusal naming `current_schema`), `initCanvasBridge` (the
 * `ILOSTAT_PREVIEW_CHARS` budget it carries), the per-call row cap from
 * `CANVAS_DEFAULT_ROW_LIMIT`, and the failed-staging disclosure on both
 * producers and both consumption paths.
 * @module tests/services/canvas-bridge/canvas-bridge.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { CanvasInstance, type ColumnSchema, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { resetConfig } from '@cyanheads/mcp-ts-core/config';
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
  queryRowCap,
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
  return new CanvasBridge(canvas, {
    tableTtlMs: TTL_MS,
    dropEnabled,
    listingEnabled: true,
    now,
    previewChars: 40_000,
  });
}

function newContext(signal?: AbortSignal) {
  return createMockContext({
    tenantId: TENANT,
    errors: dataframeQueryTool.errors,
    ...(signal ? { signal } : {}),
  });
}

/** {@link routeRows} over the synthetic rows; a first page of 50 unless `offset` and `limit` say otherwise. */
function route(
  bridge: CanvasBridge | undefined,
  ctx: Context,
  source: AsyncIterable<{ k: string }>,
  options: {
    limit?: number;
    maxRows?: number;
    minRead?: number;
    offset?: number;
    previewChars: number;
    provenance?: () => Provenance;
  },
) {
  return routeRows(bridge, {
    ctx,
    source,
    schema: SCHEMA,
    offset: options.offset ?? 0,
    limit: options.limit ?? 50,
    previewChars: options.previewChars,
    ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
    ...(options.minRead === undefined ? {} : { minRead: options.minRead }),
    provenance: options.provenance ?? (() => PROVENANCE),
  });
}

/** Rows `from` to `to`, exclusive. */
const rowsFrom = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, index) => rowAt(from + index));

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

/** A preview budget no synthetic source here reaches, so only the page decides how far a read goes. */
const ROOMY = 1_000_000;

describe('routeRows with dataframes off', () => {
  it('returns every row when they fit the page exactly, ended, with no next offset', async () => {
    const source = rowSource(5);
    const outcome = await route(undefined, newContext(), source.rows, {
      limit: 5,
      previewChars: ROOMY,
    });
    expect(outcome).toEqual({ kind: 'page', rows: rowsFrom(0, 5), ended: true });
    expect(source.state).toEqual({ pulled: 5, closed: true });
  });

  it('pages by row count, not by the preview budget: limit rows, the source read one row past them and closed', async () => {
    const source = rowSource(500);
    // four rows fit this budget; the page still holds limit rows
    const outcome = await route(undefined, newContext(), source.rows, {
      limit: 50,
      previewChars: 5 * ROW_CHARS - 1,
    });
    expect(outcome).toEqual({
      kind: 'page',
      cause: 'canvas_off',
      rows: rowsFrom(0, 50),
      nextOffset: 50,
      ended: false,
    });
    expect(source.state).toEqual({ pulled: 51, closed: true });
  });

  it('returns limit rows from offset, reading one row past them', async () => {
    const source = rowSource(500);
    const outcome = await route(undefined, newContext(), source.rows, {
      offset: 120,
      limit: 7,
      previewChars: ROOMY,
    });
    expect(outcome).toEqual({
      kind: 'page',
      rows: rowsFrom(120, 127),
      nextOffset: 127,
      ended: false,
    });
    expect(source.state).toEqual({ pulled: 128, closed: true });
  });

  it('reads at least minRead rows when the source holds them, and to its end when it holds fewer', async () => {
    const long = rowSource(10_000);
    expect(
      await route(undefined, newContext(), long.rows, {
        limit: 5,
        minRead: 5_001,
        previewChars: ROOMY,
      }),
    ).toEqual({
      kind: 'page',
      cause: 'canvas_off',
      rows: rowsFrom(0, 5),
      nextOffset: 5,
      ended: false,
    });
    expect(long.state).toEqual({ pulled: 5_001, closed: true });

    const short = rowSource(300);
    expect(
      await route(undefined, newContext(), short.rows, {
        limit: 5,
        minRead: 5_001,
        previewChars: ROOMY,
      }),
    ).toEqual({ kind: 'page', rows: rowsFrom(0, 5), nextOffset: 5, ended: true });
    expect(short.state).toEqual({ pulled: 300, closed: true });
  });

  it.each([
    ['at the end', 5],
    ['past the end', 9],
  ])('returns no rows and no next offset for an offset %s', async (_label, offset) => {
    const outcome = await route(undefined, newContext(), rowSource(5).rows, {
      offset,
      limit: 3,
      previewChars: ROOMY,
    });
    expect(outcome).toEqual({ kind: 'page', rows: [], ended: true });
  });

  it('covers every row exactly once, in order, following nextOffset from offset 0', async () => {
    const pages: { k: string }[][] = [];
    // 50 rows at 7 a page take 8 pages; a walk still going after one more never ends
    const maxPages = Math.ceil(50 / 7) + 1;
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      if (pages.length === maxPages) {
        throw new Error(`nextOffset still set after ${maxPages} pages`);
      }
      const outcome = await route(undefined, newContext(), rowSource(50).rows, {
        offset,
        limit: 7,
        previewChars: ROOMY,
      });
      if (outcome.kind !== 'page') throw new Error(`expected a page, got ${outcome.kind}`);
      pages.push(outcome.rows);
      offset = outcome.nextOffset;
    }
    expect(pages.map((page) => page.length)).toEqual([7, 7, 7, 7, 7, 7, 7, 1]);
    expect(pages.flat()).toEqual(rowsFrom(0, 50));
  });

  it('reads no further than maxRows plus the row proving the source holds more, even past minRead', async () => {
    const source = rowSource(100);
    const outcome = await route(undefined, newContext(), source.rows, {
      offset: 10,
      limit: 10,
      maxRows: 20,
      minRead: 5_001,
      previewChars: ROOMY,
    });
    expect(outcome).toEqual({ kind: 'page', rows: rowsFrom(10, 20), nextOffset: 20, ended: false });
    expect(source.state).toEqual({ pulled: 21, closed: true });
  });

  it('refuses a page reaching past maxRows of a source that holds more as too_large', async () => {
    const source = rowSource(100);
    const outcome = await route(undefined, newContext(), source.rows, {
      offset: 15,
      limit: 10,
      maxRows: 20,
      previewChars: ROOMY,
    });
    expect(outcome).toEqual({ kind: 'too_large' });
    expect(source.state).toEqual({ pulled: 21, closed: true });
  });

  it('returns a short last page reaching past maxRows when the source ends within it', async () => {
    const outcome = await route(undefined, newContext(), rowSource(20).rows, {
      offset: 15,
      limit: 10,
      maxRows: 20,
      previewChars: ROOMY,
    });
    expect(outcome).toEqual({ kind: 'page', rows: rowsFrom(15, 20), ended: true });
  });

  it('marks a first page canvas_off when reading stopped before the end, or its rows passed the budget', async () => {
    const source = rowSource(500);
    expect(
      await route(undefined, newContext(), source.rows, { limit: 2, previewChars: ROOMY }),
    ).toEqual({
      kind: 'page',
      cause: 'canvas_off',
      rows: rowsFrom(0, 2),
      nextOffset: 2,
      ended: false,
    });
    // reading stops one row past the page, never on to weigh the result against the budget
    expect(source.state).toEqual({ pulled: 3, closed: true });
    expect(
      await route(undefined, newContext(), rowSource(5).rows, {
        limit: 5,
        previewChars: 5 * ROW_CHARS - 1,
      }),
    ).toEqual({ kind: 'page', cause: 'canvas_off', rows: rowsFrom(0, 5), ended: true });
  });

  it('gives no cause to a first page read to its end within the preview budget, or to a later page', async () => {
    expect(
      await route(undefined, newContext(), rowSource(5).rows, {
        limit: 2,
        minRead: 100,
        previewChars: 5 * ROW_CHARS,
      }),
    ).toEqual({ kind: 'page', rows: rowsFrom(0, 2), nextOffset: 2, ended: true });
    const later = rowSource(500);
    expect(
      await route(undefined, newContext(), later.rows, {
        offset: 2,
        limit: 2,
        previewChars: ROW_CHARS,
      }),
    ).toEqual({ kind: 'page', rows: rowsFrom(2, 4), nextOffset: 4, ended: false });
    expect(later.state.pulled).toBe(5);
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
  it('stages nothing for an exact fit of the budget: no table, no provenance, every row read', async () => {
    const bridge = newBridge(tracked(memoryCanvas()));
    const ctx = newContext();
    const provenance = vi.fn(() => PROVENANCE);
    const outcome = await route(bridge, ctx, rowSource(5).rows, {
      limit: 2,
      previewChars: 5 * ROW_CHARS,
      provenance,
    });
    // the result fits the budget, so it pages inline without a dataframe
    expect(outcome).toEqual({ kind: 'page', rows: rowsFrom(0, 2), nextOffset: 2, ended: true });
    expect(provenance).not.toHaveBeenCalled();
    expect(await tableNames(bridge, ctx)).toEqual([]);
    expect(await metaKeys(ctx)).toEqual([]);
  });

  it('stages one character past the budget: the first page inline, every row staged, provenance recorded', async () => {
    const canvas = tracked(memoryCanvas());
    const bridge = newBridge(canvas);
    const ctx = newContext();
    const source = rowSource(5);
    const pulledAtProvenance: number[] = [];
    const outcome = await route(bridge, ctx, source.rows, {
      limit: 3,
      previewChars: 5 * ROW_CHARS - 1,
      provenance: () => {
        pulledAtProvenance.push(source.state.pulled);
        return PROVENANCE;
      },
    });
    if (outcome.kind !== 'staged') throw new Error(`expected staged, got ${outcome.kind}`);
    const expiresAt = new Date(FIXED_NOW.getTime() + TTL_MS).toISOString();
    // the page is limit rows, not the rows that fit the budget
    expect(outcome.rows).toEqual(rowsFrom(0, 3));
    expect(outcome).toMatchObject({ nextOffset: 3, ended: true });
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

  it('stages a result whose every row fits the page with no next offset', async () => {
    const outcome = await route(
      newBridge(tracked(memoryCanvas())),
      newContext(),
      rowSource(5).rows,
      {
        limit: 5,
        previewChars: ROW_CHARS,
      },
    );
    expect(outcome).toMatchObject({ kind: 'staged', rows: rowsFrom(0, 5), ended: true });
    expect(outcome).not.toHaveProperty('nextOffset');
  });

  it('stages nothing on a later page: no table, no provenance, the source read one row past the page', async () => {
    const bridge = newBridge(tracked(memoryCanvas()));
    const ctx = newContext();
    const source = rowSource(500);
    const provenance = vi.fn(() => PROVENANCE);
    const outcome = await route(bridge, ctx, source.rows, {
      offset: 2,
      limit: 2,
      previewChars: ROW_CHARS,
      provenance,
    });
    expect(outcome).toEqual({ kind: 'page', rows: rowsFrom(2, 4), nextOffset: 4, ended: false });
    expect(source.state).toEqual({ pulled: 5, closed: true });
    expect(provenance).not.toHaveBeenCalled();
    expect(await tableNames(bridge, ctx)).toEqual([]);
    expect(await metaKeys(ctx)).toEqual([]);
  });

  it('stages a source of exactly maxRows rows', async () => {
    const bridge = newBridge(tracked(memoryCanvas()));
    const outcome = await route(bridge, newContext(), rowSource(5).rows, {
      previewChars: ROW_CHARS,
      maxRows: 5,
    });
    expect(outcome).toMatchObject({ kind: 'staged', table: { rowCount: 5 } });
  });

  it.each([
    ['inside', 2],
    ['ending at', 4],
  ])(
    'returns a first page %s maxRows of a result one row past it, unstaged: the partial table dropped, nothing recorded, the source closed',
    async (_label, limit) => {
      const bridge = newBridge(tracked(memoryCanvas()));
      const ctx = newContext();
      const source = rowSource(500);
      const provenance = vi.fn(() => PROVENANCE);
      const outcome = await route(bridge, ctx, source.rows, {
        limit,
        previewChars: ROW_CHARS,
        maxRows: 4,
        provenance,
      });
      expect(outcome).toEqual({
        kind: 'page',
        cause: 'past_ceiling',
        rows: rowsFrom(0, limit),
        nextOffset: limit,
        ended: false,
      });
      expect(provenance).not.toHaveBeenCalled();
      expect(await tableNames(bridge, ctx)).toEqual([]);
      expect(await metaKeys(ctx)).toEqual([]);
      // the fifth row proved the source passed the ceiling; nothing after it was read
      expect(source.state).toEqual({ pulled: 5, closed: true });
    },
  );

  it('refuses a first page reaching past maxRows of a result that passes it as too_large, dropping the partial table', async () => {
    const bridge = newBridge(tracked(memoryCanvas()));
    const ctx = newContext();
    const source = rowSource(500);
    const outcome = await route(bridge, ctx, source.rows, {
      limit: 5,
      previewChars: ROW_CHARS,
      maxRows: 4,
    });
    expect(outcome).toEqual({ kind: 'too_large' });
    expect(await tableNames(bridge, ctx)).toEqual([]);
    expect(await metaKeys(ctx)).toEqual([]);
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
      'Dataframe canvas unavailable; returning the page inline only',
    ],
    [
      'the append fails after three rows',
      { at: 'registerTable', afterRows: 3, error: new Error('Out of Memory Error: failed') },
      'Staging the full result failed; returning the page inline only',
    ],
  ] satisfies [string, CanvasFault, string][])(
    'falls back to the page when %s, leaving nothing staged',
    async (_label, fault, warning) => {
      const canvas = tracked(faultyCanvas(fault));
      const bridge = newBridge(canvas);
      const ctx = newContext();
      const source = rowSource(500);
      const outcome = await route(bridge, ctx, source.rows, {
        limit: 4,
        previewChars: 5 * ROW_CHARS - 1,
      });
      expect(outcome).toEqual({
        kind: 'page',
        cause: 'canvas_failed',
        rows: rowsFrom(0, 4),
        nextOffset: 4,
        ended: false,
      });
      expect(warnings(ctx)).toEqual([warning]);
      expect(await metaKeys(ctx)).toEqual([]);
      expect(source.state.closed).toBe(true);
      expect(source.state.pulled).toBeLessThan(10);
      if (fault.at === 'registerTable') expect(await tableNames(bridge, ctx)).toEqual([]);
    },
  );

  it('reads the rest of the page from the source after an append fails short of it', async () => {
    const bridge = newBridge(
      tracked(
        faultyCanvas({
          at: 'registerTable',
          afterRows: 1,
          error: new Error('IO Error: disk full'),
        }),
      ),
    );
    const source = rowSource(500);
    // one row fills the budget, so staging starts on the second and fails after one appended row
    const outcome = await route(bridge, newContext(), source.rows, {
      limit: 10,
      previewChars: ROW_CHARS,
    });
    expect(outcome).toEqual({
      kind: 'page',
      cause: 'canvas_failed',
      rows: rowsFrom(0, 10),
      nextOffset: 10,
      ended: false,
    });
    expect(source.state).toEqual({ pulled: 11, closed: true });
  });

  it('gives no cause to a result that fits the budget when the canvas cannot be acquired', async () => {
    const bridge = newBridge(
      tracked(faultyCanvas({ at: 'acquire', error: new Error('engine failed to start') })),
    );
    const outcome = await route(bridge, newContext(), rowSource(5).rows, {
      limit: 5,
      previewChars: 5 * ROW_CHARS,
    });
    expect(outcome).toEqual({ kind: 'page', rows: rowsFrom(0, 5), ended: true });
  });

  it('falls back to the page and drops the table when recording provenance fails', async () => {
    const bridge = newBridge(tracked(memoryCanvas()));
    const ctx = newContext();
    const set = ctx.state.set.bind(ctx.state);
    vi.spyOn(ctx.state, 'set').mockImplementation((key, value, options) =>
      key.startsWith('df-meta/')
        ? Promise.reject(new Error('storage quota exceeded'))
        : set(key, value, options),
    );
    const outcome = await route(bridge, ctx, rowSource(5).rows, {
      limit: 4,
      previewChars: 5 * ROW_CHARS - 1,
    });
    expect(outcome).toEqual({
      kind: 'page',
      cause: 'canvas_failed',
      rows: rowsFrom(0, 4),
      nextOffset: 4,
      ended: true,
    });
    expect(warnings(ctx)).toEqual([
      'Recording dataframe provenance failed; returning the page inline only',
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

  it('rejects with the abort, logging no warning, when the call is cancelled while the canvas resolves', async () => {
    const { canvas, hold } = gatedCanvas();
    const bridge = newBridge(tracked(canvas));
    const controller = new AbortController();
    const ctx = newContext(controller.signal);
    const mint = hold((maybeId) => maybeId === undefined);
    const routed = route(bridge, ctx, rowSource(500).rows, {
      limit: 4,
      previewChars: 5 * ROW_CHARS - 1,
    });
    await mint.reached; // the call holds the resolution, minting the tenant's canvas
    controller.abort();
    mint.open();
    await expect(routed).rejects.toMatchObject({ name: 'AbortError' });
    expect(warnings(ctx)).toEqual([]);
  });

  it('rejects with the abort, logging no warning, when the call is cancelled while staging', async () => {
    const bridge = newBridge(tracked(memoryCanvas()));
    const controller = new AbortController();
    const ctx = newContext(controller.signal);
    // the budget holds five rows, so staging is under way when the twentieth cancels the call
    const rows = (async function* () {
      for (let index = 0; index < 500; index++) {
        if (index === 20) controller.abort();
        yield rowAt(index);
      }
    })();
    await expect(
      route(bridge, ctx, rows, { limit: 4, previewChars: 5 * ROW_CHARS - 1 }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(warnings(ctx)).toEqual([]);
  });

  it('rejects with the abort, logging no warning and leaving no table, when the call is cancelled while recording provenance', async () => {
    const bridge = newBridge(tracked(memoryCanvas()));
    const controller = new AbortController();
    const ctx = newContext(controller.signal);
    const set = ctx.state.set.bind(ctx.state);
    let canvasId: unknown;
    vi.spyOn(ctx.state, 'set').mockImplementation((key, value, options) => {
      if (key === 'canvas-id') canvasId = value;
      if (!key.startsWith('df-meta/')) return set(key, value, options);
      controller.abort();
      return Promise.reject(controller.signal.reason);
    });
    await expect(
      route(bridge, ctx, rowSource(5).rows, { limit: 4, previewChars: 5 * ROW_CHARS - 1 }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(warnings(ctx)).toEqual([]);
    // a table with no provenance record would sit outside the staging budget until its TTL
    const after = newContext();
    await after.state.set('canvas-id', canvasId);
    expect(await tableNames(bridge, after)).toEqual([]);
  });
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

describe('the SQL of a query() call over one string literal', () => {
  const MISSING = 'df_NOSUC_HTBL1';
  const MISSING_TABLE_HINT =
    'Call ilostat_dataframe_describe to list the staged dataframes, or re-run the producing tool to stage the data again.';
  const DENIED_FUNCTION_HINT =
    'Remove the denied function and query only df_<id> tables directly, by the names the producing tools returned.';

  /** `sql` wrapped in `depth` query() calls, each a '…' literal with its quotes doubled. */
  function nested(sql: string, depth: number): string {
    let wrapped = sql;
    for (let level = 0; level < depth; level++) {
      wrapped = `SELECT * FROM query('${wrapped.replaceAll("'", "''")}')`;
    }
    return wrapped;
  }

  /** Stages a parent holding {@link UNE_DATASET}, then stores `sqlFor(parent)` with register_as. */
  async function derive(sqlFor: (parent: string) => string) {
    const bridge = newBridge(tracked(memoryCanvas()));
    const ctx = newContext();
    const parent = await stage(bridge, ctx, 5);
    const { meta, result } = await bridge.query(ctx, sqlFor(parent), {
      rowLimit: 10,
      registerAs: 'df_DERIV_ED001',
      sourceTool: 'ilostat_dataframe_query',
    });
    return { parent, meta, result };
  }

  /** The rejection of `sql` over a canvas holding one staged parent, which `sqlFor` may name. */
  async function failure(sqlFor: (parent: string) => string) {
    const bridge = newBridge(tracked(memoryCanvas()));
    const ctx = newContext();
    const parent = await stage(bridge, ctx, 5);
    return bridge
      .query(ctx, sqlFor(parent), { rowLimit: 10, sourceTool: 'test' })
      .catch((caught: unknown) => caught as McpError);
  }

  // Each form runs through the real gate and engine: what the scanner reads is what DuckDB runs.
  it.each([
    ["a '…' literal", (p: string) => `SELECT count(*) AS n FROM query('SELECT * FROM ${p}')`],
    [
      'doubled quotes holding an apostrophe before the name',
      (p: string) => `SELECT count(*) AS n FROM query('SELECT ''it''''s'' AS s, * FROM ${p}')`,
    ],
    [
      "an E'…' literal naming it in hex escapes",
      (p: string) =>
        `SELECT count(*) AS n FROM query(E'SELECT \\'a\\' AS s, * FROM \\x64\\x66${p.slice(2)}')`,
    ],
    ['a $$ literal', (p: string) => `SELECT count(*) AS n FROM query($$SELECT * FROM ${p}$$)`],
    ['a $tag$ literal', (p: string) => `SELECT count(*) AS n FROM query($q$SELECT * FROM ${p}$q$)`],
    [
      'a literal in parentheses',
      (p: string) => `SELECT count(*) AS n FROM query((('SELECT * FROM ${p}')))`,
    ],
    [
      'literals joined across a line comment and a break',
      (p: string) => `SELECT count(*) AS n FROM query('SELECT * FROM ' -- x\n'${p}')`,
    ],
    [
      "an E'…' joined to a '…' that keeps its escapes",
      (p: string) => `SELECT count(*) AS n FROM query(E'SELECT * FROM '\r\n'\\x64${p.slice(1)}')`,
    ],
    [
      'QUERY spaced from its parenthesis',
      (p: string) => `SELECT count(*) AS n FROM QUERY ( 'SELECT * FROM ${p}' )`,
    ],
    ['main.query', (p: string) => `SELECT count(*) AS n FROM main.query('SELECT * FROM ${p}')`],
    ['"query"', (p: string) => `SELECT count(*) AS n FROM "query"('SELECT * FROM ${p}')`],
    [
      'a call after a comma in a FROM list',
      (p: string) => `SELECT count(*) AS n FROM (SELECT 1 AS j) x, query('SELECT * FROM ${p}')`,
    ],
    [
      'a call after JOIN … ON',
      (p: string) =>
        `SELECT count(*) AS n FROM (SELECT 1 AS j) x JOIN query('SELECT * FROM ${p}') ON true`,
    ],
    [
      'a call after JOIN LATERAL',
      (p: string) =>
        `SELECT count(*) AS n FROM (SELECT 1 AS j) x JOIN LATERAL query('SELECT * FROM ${p}') ON true`,
    ],
    [
      'a FROM-first statement',
      (p: string) => `FROM query('SELECT * FROM ${p}') SELECT count(*) AS n`,
    ],
    [
      'a comment-led statement',
      (p: string) => `/* lead */ SELECT count(*) AS n FROM query('SELECT * FROM ${p}')`,
    ],
  ])(
    'reads the dataframe in %s, so the stored table inherits its datasets',
    async (_label, sqlFor) => {
      const { parent, meta, result } = await derive(sqlFor);
      expect(result.rows).toEqual([{ n: '5' }]);
      expect(meta).toMatchObject({
        queryParams: { derived_from: [parent] },
        datasets: [UNE_DATASET],
      });
    },
  );

  it.each([1, 2, 4])(
    'reads the dataframe %i query() levels deep, so the stored table inherits its datasets',
    async (depth) => {
      const { parent, meta, result } = await derive((p) =>
        nested(`SELECT count(*) AS n FROM ${p}`, depth),
      );
      expect(result.rows).toEqual([{ n: '5' }]);
      expect(meta).toMatchObject({
        queryParams: { derived_from: [parent] },
        datasets: [UNE_DATASET],
      });
    },
  );

  it('stores an empty result read through query() with its parent’s provenance', async () => {
    const { parent, meta, result } = await derive(
      (p) => `SELECT * FROM query('SELECT * FROM ${p} WHERE k = ''none''')`,
    );
    expect(result.rowCount).toBe(0);
    expect(meta).toMatchObject({
      rowCount: 0,
      queryParams: { derived_from: [parent] },
      datasets: [UNE_DATASET],
    });
  });

  it('refuses a fifth query() level as denied_function, the gate’s limit, with this tool’s recovery', async () => {
    const error = await failure((p) => nested(`SELECT * FROM ${p}`, 5));
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'Canvas query nests query() more than 4 levels deep.',
      data: { reason: 'denied_function', recovery: { hint: DENIED_FUNCTION_HINT } },
    });
  });

  it.each([
    [
      'another function’s string argument',
      (p: string, d: string) => `upper('SELECT * FROM ${d}') AS s FROM query('SELECT * FROM ${p}')`,
    ],
    [
      'an ordinary literal',
      (p: string, d: string) => `k FROM query('SELECT * FROM ${p}') WHERE k <> '${d}'`,
    ],
    [
      'a comment inside the query() body',
      (p: string, d: string) => `k FROM query('SELECT * FROM ${p} -- ${d}')`,
    ],
    [
      'a literal inside the query() body',
      (p: string, d: string) => `k FROM query('SELECT * FROM ${p} WHERE k <> ''${d}''')`,
    ],
  ])('takes no parent from a df_ name in %s', async (_label, sqlFor) => {
    const bridge = newBridge(tracked(memoryCanvas()));
    const ctx = newContext();
    const parent = await stage(bridge, ctx, 5);
    // A name with no provenance never becomes a parent, so the decoy is a staged dataframe.
    const decoy = await stage(bridge, ctx, 3);
    const { meta } = await bridge.query(ctx, `SELECT ${sqlFor(parent, decoy)}`, {
      rowLimit: 10,
      registerAs: 'df_DERIV_ED001',
      sourceTool: 'ilostat_dataframe_query',
    });
    expect(meta).toMatchObject({ queryParams: { derived_from: [parent] } });
  });

  it.each([
    ['AS query', (a: string, b: string) => `SELECT count(*) AS n FROM ${a} AS query ('${b}')`],
    [
      'query, implicitly',
      (a: string, b: string) => `SELECT count(*) AS n FROM ${a} query ('${b}')`,
    ],
    ['AS "query"', (a: string, b: string) => `SELECT count(*) AS n FROM ${a} AS "query" ('${b}')`],
  ])(
    'takes no parent from the column list of a table aliased %s, which DuckDB runs as an alias',
    async (_label, sqlFor) => {
      const bridge = newBridge(tracked(memoryCanvas()));
      const ctx = newContext();
      const parent = await stage(bridge, ctx, 5);
      const named = await stage(bridge, ctx, 3, { ...PROVENANCE, datasets: [EMP_DATASET] });
      const { meta, result } = await bridge.query(ctx, sqlFor(parent, named), {
        rowLimit: 10,
        registerAs: 'df_DERIV_ED001',
        sourceTool: 'ilostat_dataframe_query',
      });
      // The parent's five rows, not the named table's three: the literal names a column.
      expect(result.rows).toEqual([{ n: '5' }]);
      expect(meta).toMatchObject({
        queryParams: { derived_from: [parent] },
        datasets: [UNE_DATASET],
      });
    },
  );

  it.each([
    ['opening with SELECT', `SELECT * FROM query('SELECT * FROM ${MISSING}')`],
    ['two levels deep', nested(`SELECT * FROM ${MISSING}`, 2)],
    ['opening with a comment', `/* c */ SELECT * FROM query('SELECT * FROM ${MISSING}')`],
    ['opening with (', "(SELECT * FROM query('SELECT * FROM df_nosuc_htbl1'))"],
    ['opening with a comment, four levels deep', `-- c\n${nested(`SELECT * FROM ${MISSING}`, 4)}`],
  ])(
    'fails missing_table for an unstaged dataframe read inside query(), %s',
    async (_label, sql) => {
      const error = await failure(() => sql);
      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        message: `Dataframe ${MISSING} does not exist or has expired.`,
        data: {
          reason: 'missing_table',
          tableName: MISSING,
          recovery: { hint: MISSING_TABLE_HINT },
        },
      });
    },
  );

  it.each([
    ['over a concatenation', (p: string) => `SELECT * FROM query('SELECT * FROM ' || '${p}')`],
    ['over a cast', (p: string) => `SELECT * FROM query('SELECT * FROM ${p}'::VARCHAR)`],
    ['as query_table()', (p: string) => `SELECT * FROM query_table('${p}')`],
  ])('refuses query() %s as denied_function with this tool’s recovery', async (_label, sqlFor) => {
    const error = await failure(sqlFor);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'denied_function', recovery: { hint: DENIED_FUNCTION_HINT } },
    });
  });
});

describe('an unqualified current_schema', () => {
  const QUALIFY_HINT =
    'Qualify a column named current_schema with its table (<table>.current_schema), or remove the reference — the current_schema() function is not available.';

  /** A bridge and context holding df_CURSC_HEMA1, whose columns are current_schema and k. */
  async function withColumn() {
    const bridge = newBridge(tracked(memoryCanvas()));
    const ctx = newContext();
    await bridge.query(ctx, 'SELECT 1 AS current_schema, 2 AS k', {
      rowLimit: 10,
      registerAs: 'df_CURSC_HEMA1',
      sourceTool: 'ilostat_dataframe_query',
    });
    return { bridge, ctx };
  }

  async function failure(sql: string) {
    const { bridge, ctx } = await withColumn();
    return bridge
      .query(ctx, sql, { rowLimit: 10, sourceTool: 'test' })
      .catch((caught: unknown) => caught as McpError);
  }

  it.each([
    ['bare', 'SELECT current_schema FROM df_CURSC_HEMA1'],
    ['double-quoted', 'SELECT "current_schema" FROM df_CURSC_HEMA1'],
  ])(
    'keeps the framework’s qualify-the-column recovery on a %s reference to a staged column of that name',
    async (_label, sql) => {
      expect(await failure(sql)).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message:
          'Canvas query references current_schema unqualified. DuckDB reads that as the current_schema() function unless a column of that name is in scope, so the canvas refuses it either way.',
        data: {
          reason: 'denied_function',
          function: 'current_schema',
          recovery: { hint: QUALIFY_HINT },
        },
      });
    },
  );

  it('reads the column qualified with its table', async () => {
    const { bridge, ctx } = await withColumn();
    const { result } = await bridge.query(ctx, 'SELECT t.current_schema FROM df_CURSC_HEMA1 t', {
      rowLimit: 10,
      sourceTool: 'test',
    });
    expect(result.rows).toEqual([{ current_schema: 1 }]);
  });

  it('keeps the framework’s recovery on a called current_schema(), which names the function', async () => {
    expect(await failure('SELECT current_schema() AS s')).toMatchObject({
      data: {
        reason: 'denied_function',
        function: 'current_schema',
        recovery: {
          hint: 'Remove the function the message names — only the staged tables are queryable.',
        },
      },
    });
  });

  it('gives every other denied function this tool’s recovery', async () => {
    expect(await failure("SELECT current_setting('threads') AS t")).toMatchObject({
      data: {
        reason: 'denied_function',
        function: 'current_setting',
        recovery: {
          hint: 'Remove the denied function and query only df_<id> tables directly, by the names the producing tools returned.',
        },
      },
    });
  });
});

/** One turn of the event loop: every promise already settling has settled. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A {@link memoryCanvas} whose next `acquire` a test's predicate accepts (a
 * lookup of one id, or a mint: `undefined`) waits until the test opens it, so
 * calls on one tenant interleave in the order the test sets.
 */
function gatedCanvas() {
  const canvas = memoryCanvas();
  const acquire = canvas.acquire.bind(canvas);
  let gate:
    | {
        matches: (maybeId: string | undefined) => boolean;
        open: Promise<void>;
        reached: () => void;
      }
    | undefined;
  canvas.acquire = async (maybeId, context, options) => {
    const held = gate;
    if (held?.matches(maybeId)) {
      gate = undefined;
      held.reached();
      await held.open;
    }
    return await acquire(maybeId, context, options);
  };
  return {
    canvas,
    /** Holds the next acquire `matches` accepts; `reached` settles once one is waiting. */
    hold(matches: (maybeId: string | undefined) => boolean) {
      const reached = Promise.withResolvers<void>();
      const open = Promise.withResolvers<void>();
      gate = { matches, open: open.promise, reached: reached.resolve };
      return { reached: reached.promise, open: () => open.resolve() };
    },
  };
}

/**
 * A call on `base`'s tenant state whose state operations each check this call's
 * own signal first, as production `ctx.state` does: calls on one tenant share
 * the store, never a cancellation. `set` and `list` stand in for those operations.
 */
function callOn(
  base: Context,
  options: {
    list?: Context['state']['list'];
    set?: Context['state']['set'];
    signal?: AbortSignal;
  } = {},
): Context {
  const signal = options.signal ?? new AbortController().signal;
  const ctx = createMockContext({ tenantId: TENANT, signal });
  const overrides: Record<string | symbol, unknown> = { list: options.list, set: options.set };
  const state = new Proxy(base.state, {
    get(target, property) {
      const op = overrides[property] ?? Reflect.get(target, property);
      if (typeof op !== 'function') return op;
      return async (...args: unknown[]) => {
        signal.throwIfAborted();
        return await op.apply(target, args);
      };
    },
  });
  Object.defineProperty(ctx, 'state', { value: state });
  return ctx;
}

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

  it('lands two calls racing a dead stored id on one canvas, keeping the dataframe either one staged', async () => {
    const { canvas, hold } = gatedCanvas();
    const bridge = newBridge(tracked(canvas));
    const base = newContext();
    const dead = await bridge.acquire(base);
    await canvas.drop(dead.canvasId, base);

    const lookup = hold((maybeId) => maybeId === dead.canvasId);
    const first = bridge.acquire(callOn(base));
    await lookup.reached; // the first call read the dead id; its lookup waits
    const second = await bridge.acquire(callOn(base)); // the second finds it dead and mints
    const staged = await stage(bridge, callOn(base), 5);
    lookup.open();

    expect((await first).canvasId).toBe(second.canvasId);
    expect(canvas.countForTenant(base)).toBe(1);
    expect(await base.state.get('canvas-id')).toBe(second.canvasId);
    expect(await tableNames(bridge, base)).toEqual([staged]);
    expect(await metaKeys(base)).toEqual([`df-meta/${staged}`]);
  });

  it('fails only the call cancelled while it holds the resolution; the call queued behind it gets the one canvas', async () => {
    const { canvas, hold } = gatedCanvas();
    const bridge = newBridge(tracked(canvas));
    const base = newContext();
    const holder = new AbortController();

    const mint = hold((maybeId) => maybeId === undefined);
    const cancelled = bridge.acquire(callOn(base, { signal: holder.signal }));
    await mint.reached; // the first call holds the resolution, minting
    const queued = bridge.acquire(callOn(base));
    await tick(); // the second call found no canvas and waits its turn
    holder.abort();
    mint.open();

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    const instance = await queued;
    expect(canvas.countForTenant(base)).toBe(1);
    expect(await base.state.get('canvas-id')).toBe(instance.canvasId);
  });

  it('fails a call whose canvas-id write is refused, leaving the tenant no canvas and no stored id', async () => {
    const canvas = tracked(memoryCanvas());
    const bridge = newBridge(canvas);
    const base = newContext();
    const refusing = callOn(base, {
      set: async (key, value, options) => {
        if (key === 'canvas-id') throw new Error('write refused');
        await base.state.set(key, value, options);
      },
    });

    await expect(bridge.acquire(refusing)).rejects.toThrow('write refused');
    expect(canvas.countForTenant(base)).toBe(0);
    expect(await base.state.get('canvas-id')).toBeNull();

    const next = await bridge.acquire(callOn(base));
    expect(canvas.countForTenant(base)).toBe(1);
    expect(await base.state.get('canvas-id')).toBe(next.canvasId);
  });

  it('clears every df-meta/ record, past the first listing page, before a re-minted canvas id is stored', async () => {
    const canvas = tracked(memoryCanvas());
    const bridge = newBridge(canvas);
    const base = newContext();
    const gone = await bridge.acquire(base);
    const stale = Array.from(
      { length: 101 },
      (_, index) => `df_STALE_${String(index).padStart(5, '0')}`,
    );
    await base.state.setMany(
      new Map(stale.map((name) => [`df-meta/${name}`, { tableName: name }])),
    );
    await canvas.drop(gone.canvasId, base);

    let recordsAtIdWrite: string[] | undefined;
    const watched = callOn(base, {
      // a store that serves at most three records a page, whatever page size the bridge asks for
      list: (prefix, options) =>
        base.state.list(prefix, { ...options, limit: Math.min(options?.limit ?? 3, 3) }),
      set: async (key, value, options) => {
        if (key === 'canvas-id') recordsAtIdWrite = await metaKeys(base);
        await base.state.set(key, value, options);
      },
    });
    const minted = await bridge.acquire(watched);
    expect(minted.canvasId).not.toBe(gone.canvasId);
    expect(recordsAtIdWrite).toEqual([]);
  });

  it('resolves a bare canvas id an earlier bridge stored, with no TTL, without a re-mint', async () => {
    const canvas = tracked(memoryCanvas());
    const bridge = newBridge(canvas);
    const ctx = newContext();
    const earlier = await canvas.acquire(undefined, ctx);
    await ctx.state.set('canvas-id', earlier.canvasId);
    await ctx.state.set('df-meta/df_KEPT0_00000', { tableName: 'df_KEPT0_00000' });

    const instance = await bridge.acquire(ctx);
    expect(instance.canvasId).toBe(earlier.canvasId);
    expect(instance.isNew).toBe(false);
    expect(await ctx.state.get('canvas-id')).toBe(earlier.canvasId);
    expect(await metaKeys(ctx)).toEqual(['df-meta/df_KEPT0_00000']);
    expect(canvas.countForTenant(ctx)).toBe(1);
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
          hint: 'Remove the denied function and query only df_<id> tables directly, by the names the producing tools returned.',
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
          hint: 'Dataframes are off in this deployment; call ilostat_query_indicator or ilostat_compare_geographies and page through their rows inline with next_offset.',
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
  it('leaves dataframes off without a canvas: no bridge, and producers page without staging', async () => {
    initCanvasBridge(tracked(memoryCanvas()));
    expect(initCanvasBridge(undefined)).toBeUndefined();
    expect(getCanvasBridge()).toBeUndefined();
    const outcome = await route(getCanvasBridge(), newContext(), rowSource(50).rows, {
      limit: 3,
      previewChars: ROW_CHARS,
    });
    expect(outcome).toEqual({
      kind: 'page',
      cause: 'canvas_off',
      rows: rowsFrom(0, 3),
      nextOffset: 3,
      ended: false,
    });
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

  it('carries ILOSTAT_PREVIEW_CHARS to the dataframe query budget, through the services and with no options', async () => {
    vi.resetModules();
    vi.stubEnv('ILOSTAT_PREVIEW_CHARS', '1500');
    try {
      const services = await import('@/services/ilostat-services.js');
      const bridgeModule = await import('@/services/canvas-bridge/canvas-bridge.js');
      try {
        const wired = services.initIlostatServices({ canvas: tracked(memoryCanvas()) });
        expect(wired.bridge?.previewChars).toBe(1500);
        expect(bridgeModule.initCanvasBridge(tracked(memoryCanvas()))?.previewChars).toBe(1500);
      } finally {
        services.disposeIlostatServices();
        bridgeModule.initCanvasBridge(undefined);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('queryRowCap', () => {
  afterEach(() => {
    resetConfig();
  });

  it.each([
    ['unset', undefined, 10_000],
    ['500', '500', 500],
    ['20000', '20000', 10_000],
  ])('applies CANVAS_DEFAULT_ROW_LIMIT %s', (_label, value, cap) => {
    resetConfig(value === undefined ? {} : { CANVAS_DEFAULT_ROW_LIMIT: value });
    expect(queryRowCap()).toBe(cap);
  });

  it('never sees a fractional CANVAS_DEFAULT_ROW_LIMIT: the config refuses it', () => {
    expect(() => resetConfig({ CANVAS_DEFAULT_ROW_LIMIT: '500.5' })).toThrow(
      /CANVAS_DEFAULT_ROW_LIMIT/,
    );
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
    'query: when %s, the page says so and pages on, on both surfaces',
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
      const notice =
        'Showing rows 1–50 of 52. Staging the full result as a dataframe failed; call again with offset 0 to retry it. Pass next_offset as offset, with the same other arguments, for the next page.';
      // the 52-row result is read whole, so its counts are complete
      expect(result.structuredContent).toMatchObject({
        truncated: true,
        shown: 50,
        cap: 50,
        row_count: 52,
        next_offset: 50,
        summary: { complete: true },
        notice,
      });
      expect(result.structuredContent).not.toHaveProperty('dataframe');
      const text = contentText(result);
      expect(text).toContain(notice);
      expect(text).toContain('**next_offset:** 50');
    },
  );

  it.each(FAULTS)('compare: when %s, the page says so on both surfaces', async (_label, fault) => {
    // A staged comparison row with its change columns runs to ~800 characters, so three pass the budget
    wireDataframes({
      canvas: tracked(faultyCanvas(fault)),
      observations: { previewChars: 1_200 },
    });
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
    const notice =
      'Showing areas 1–3 of 3; ranks, missing, and comparability cover every area. Staging the full comparison as a dataframe failed; call again with offset 0 to retry it.';
    expect(structured.rows).toHaveLength(3);
    expect(structured).toMatchObject({ truncated: false, shown: 3, cap: 50 });
    expect(structured).not.toHaveProperty('next_offset');
    expect(structured.notice).toContain(notice);
    expect(structured).not.toHaveProperty('dataframe');
    expect(structured.comparability.basis_counts).toEqual({
      reported: 2,
      modelled_estimate: 1,
      projection: 0,
    });
    expect(contentText(result)).toContain(notice);
  });
});
