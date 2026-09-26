/**
 * @fileoverview Adapter between the ILOSTAT tools and the framework DataCanvas.
 * One shared canvas per tenant (its ID kept in `ctx.state`, re-minted when it
 * expires), `df_XXXXX_XXXXX` table names, per-table TTL, and provenance under
 * `df-meta/<name>` in `ctx.state`, lazily swept on every dataframe operation and
 * cleared when the canvas is re-minted.
 * Producers route their rows through {@link routeRows}: inline when they fit the
 * preview, staged in full through the framework's `spillover()` when they do not,
 * refused when they pass the row ceiling, and cut to the preview when the canvas
 * is off or staging fails. SQL runs through the framework gate with system
 * catalogs denied; its rejections are rebuilt with the calling tool's contract
 * recovery, and a canvas whose DuckDB engine cannot load fails `canvas_unavailable`.
 * @module services/canvas-bridge/canvas-bridge
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  type CanvasInstance,
  type ColumnSchema,
  type DataCanvas,
  type QueryResult,
  type SpilloverResult,
  spillover,
} from '@cyanheads/mcp-ts-core/canvas';
import {
  internalError,
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { idGenerator } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { ATTRIBUTION } from '@/services/attribution.js';
import type { Basis } from '@/services/basis/basis.js';

/** One dataset a staged dataframe holds. */
export interface DataframeDataset {
  datasetId: string;
  label: string;
  lastUpdate: string;
  unit?: string;
}

/** Row counts per basis. */
export type BasisCounts = Record<Basis, number>;

/** Provenance a producer supplies once its rows have been read. */
export interface Provenance {
  attribution: string;
  basisCounts?: BasisCounts;
  coverage?: { periodMax?: string; periodMin?: string; refAreas: number };
  datasets: DataframeDataset[];
  queryParams: Record<string, unknown>;
  sourceTool: string;
}

/** Per-table provenance and TTL, persisted in `ctx.state` under `df-meta/<name>`. */
export interface DataframeMeta extends Provenance {
  columnSchema: ColumnSchema[];
  createdAt: string;
  expiresAt: string;
  rowCount: number;
  tableName: string;
}

/** A staged table as producers report it. */
export interface StagedTable {
  expiresAt: string;
  name: string;
  rowCount: number;
}

/** Where a producer's rows ended up. */
export type RouteOutcome<T> =
  /** Every row fit the inline preview. */
  | { kind: 'complete'; rows: T[] }
  /** The preview is inline and every row is staged. */
  | { kind: 'staged'; rows: T[]; table: StagedTable }
  /** Reading stopped at the preview: the canvas is off, or staging failed. */
  | { kind: 'preview'; rows: T[]; cause: 'canvas_off' | 'canvas_failed' }
  /** The source passed `maxRows`; the partial table was dropped. */
  | { kind: 'too_large' };

export interface RouteOptions<T> {
  ctx: Context;
  /** Ceiling on staged rows; passing it drops the table and reports `too_large`. */
  maxRows?: number;
  /** Inline preview budget in serialized characters, measured on the rows as given. */
  previewChars: number;
  /** Called once the rows are staged, to record the table's provenance. */
  provenance: () => Provenance;
  /** Explicit column schema, so a value column never sniffs as an integer type. */
  schema: ColumnSchema[];
  source: AsyncIterable<T> | Iterable<T>;
}

export interface BridgeQueryOptions {
  preview?: number;
  registerAs?: string;
  rowLimit: number;
  sourceTool: string;
}

const META_PREFIX = 'df-meta/';
const CANVAS_ID_KEY = 'canvas-id';
const TABLE_NAME_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const TABLE_NAME_PATTERN = /\bdf_[A-Za-z0-9]{5}_[A-Za-z0-9]{5}\b/gi;

/** Framework SQL-gate and engine reasons the dataframe tools declare, rebuilt with their contract recovery. */
const DECLARED_CANVAS_REASONS = new Set([
  'system_catalog_access',
  'missing_table',
  'invalid_sql',
  'sql_execution_error',
  'register_as_clash',
  'non_select_statement',
  'multi_statement',
  'denied_function',
  'plan_operator_not_allowed',
]);

/**
 * The describe-then-query pointer for a staged table. One helper so every
 * producer names both dataframe tools the same way; emit it only on the branch
 * that actually staged a table.
 */
export function dataframeNotice(table: StagedTable): string {
  return `Full result staged as ${table.name} (${table.rowCount} rows) — use ilostat_dataframe_describe to inspect its columns, then ilostat_dataframe_query to analyze it with SQL.`;
}

/** `canvas_unavailable`, carrying the calling tool's recovery. */
function canvasUnavailable(ctx: Context, cause?: unknown): McpError {
  return serviceUnavailable(
    'Dataframes are unavailable in this deployment: the DataCanvas DuckDB engine could not be loaded.',
    { reason: 'canvas_unavailable', ...ctx.recoveryFor('canvas_unavailable') },
    cause === undefined ? undefined : { cause },
  );
}

/** A single-quoted string literal or a double-quoted identifier, whichever opens first. */
const QUOTED_PATTERN = /'(?:[^']|'')*'|"(?:[^"]|"")*"/g;

/**
 * Blanks single-quoted string literals so a `df_` name inside one is never read
 * as a table reference. A double-quoted identifier names a table, so it is kept;
 * it is matched in the same left-to-right pass so an apostrophe inside it cannot
 * open a literal. An opening quote with a like quote anywhere after it always
 * matches, so at most one opening of each kind scans to the end unmatched: the
 * pass stays linear in the SQL's length.
 */
function stripStringLiterals(sql: string): string {
  return sql.replace(QUOTED_PATTERN, (quoted) => (quoted.startsWith("'") ? "''" : quoted));
}

/**
 * Minted dataframe names the SQL references, in any case, folded to the minted
 * `df_XXXXX_XXXXX` form (DuckDB identifiers are case-insensitive).
 */
function referencedDataframes(sql: string): string[] {
  const names = stripStringLiterals(sql).match(TABLE_NAME_PATTERN) ?? [];
  return [...new Set(names.map((name) => `df_${name.slice(3).toUpperCase()}`))];
}

export interface CanvasBridgeOptions {
  dropEnabled: boolean;
  now?: () => Date;
  /** Per-table TTL for staged dataframes. */
  tableTtlMs: number;
}

export class CanvasBridge {
  private readonly now: () => Date;

  constructor(
    private readonly canvas: DataCanvas,
    private readonly options: CanvasBridgeOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * The tenant's shared canvas, minting one when the stored ID is unknown or
   * expired. A minted canvas starts empty, so every provenance record left in
   * `ctx.state` names a table that is gone: they are cleared before the new ID
   * is stored.
   */
  async acquire(ctx: Context): Promise<CanvasInstance> {
    const stored = await ctx.state.get<string>(CANVAS_ID_KEY);
    if (stored) {
      try {
        return await this.canvas.acquire(stored, ctx);
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        await ctx.state.delete(CANVAS_ID_KEY);
      }
    }
    const instance = await this.canvas.acquire(undefined, ctx);
    const staleKeys: string[] = [];
    for await (const { key } of this.iterateMeta(ctx)) staleKeys.push(key);
    await Promise.all(staleKeys.map((key) => ctx.state.delete(key)));
    await ctx.state.set(CANVAS_ID_KEY, instance.canvasId);
    return instance;
  }

  /** {@link acquire}, with an engine that cannot load reported as `canvas_unavailable`. */
  async acquireForTool(ctx: Context): Promise<CanvasInstance> {
    try {
      return await this.acquire(ctx);
    } catch (error) {
      if (error instanceof McpError && error.code === JsonRpcErrorCode.ConfigurationError) {
        throw canvasUnavailable(ctx, error);
      }
      throw error;
    }
  }

  /** A fresh `df_XXXXX_XXXXX` name (~3.7×10^15 keyspace). */
  mintTableName(): string {
    const left = idGenerator.generateRandomString(5, TABLE_NAME_CHARSET);
    const right = idGenerator.generateRandomString(5, TABLE_NAME_CHARSET);
    return `df_${left}_${right}`;
  }

  get tableTtlMs(): number {
    return this.options.tableTtlMs;
  }

  /** Records a staged table's provenance; returns what producers report. */
  async recordTable(
    ctx: Context,
    table: { columnSchema: ColumnSchema[]; rowCount: number; tableName: string },
    provenance: Provenance,
  ): Promise<DataframeMeta> {
    const now = this.now().getTime();
    const meta: DataframeMeta = {
      ...provenance,
      tableName: table.tableName,
      rowCount: table.rowCount,
      columnSchema: table.columnSchema,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.options.tableTtlMs).toISOString(),
    };
    await ctx.state.set(`${META_PREFIX}${table.tableName}`, meta);
    return meta;
  }

  /**
   * Provenance of the staged dataframes, newest first; one name, or all. Expired
   * entries are swept first, and a record whose table is no longer on the canvas
   * is deleted rather than listed.
   */
  async describe(ctx: Context, tableName?: string): Promise<DataframeMeta[]> {
    const instance = await this.acquireForTool(ctx);
    await this.sweepExpired(ctx);
    const entries: { key: string; meta: DataframeMeta }[] = [];
    if (tableName) {
      const key = `${META_PREFIX}${tableName}`;
      const meta = await ctx.state.get<DataframeMeta>(key);
      if (meta) entries.push({ key, meta });
    } else {
      for await (const entry of this.iterateMeta(ctx)) entries.push(entry);
    }
    const tables = new Set((await instance.describe()).map((table) => table.name));
    const live: DataframeMeta[] = [];
    for (const { key, meta } of entries) {
      if (tables.has(meta.tableName)) live.push(meta);
      else await ctx.state.delete(key);
    }
    return live.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * One read-only SELECT over the shared canvas, system catalogs denied. A
   * referenced `df_` name with no provenance fails `missing_table` before the
   * gate; `register_as` stores the result as a new dataframe with a fresh TTL
   * and provenance inherited from the dataframes it read.
   */
  async query(
    ctx: Context,
    sql: string,
    options: BridgeQueryOptions,
  ): Promise<{ meta?: DataframeMeta; result: QueryResult }> {
    const instance = await this.acquireForTool(ctx);
    await this.sweepExpired(ctx);
    const parents: DataframeMeta[] = [];
    for (const name of referencedDataframes(sql)) {
      const meta = await ctx.state.get<DataframeMeta>(`${META_PREFIX}${name}`);
      if (!meta) {
        throw notFound(`Dataframe ${name} does not exist or has expired.`, {
          reason: 'missing_table',
          tableName: name,
          ...ctx.recoveryFor('missing_table'),
        });
      }
      parents.push(meta);
    }
    const { registerAs } = options;
    if (registerAs && (await ctx.state.get(`${META_PREFIX}${registerAs}`)) !== null) {
      throw validationError(
        `Dataframe ${registerAs} already exists; register_as needs an unused name.`,
        {
          reason: 'register_as_clash',
          tableName: registerAs,
          recovery: { hint: this.registerAsClashHint() },
        },
      );
    }

    let result: QueryResult;
    try {
      result = await instance.query(sql, {
        rowLimit: options.rowLimit,
        ...(options.preview === undefined ? {} : { preview: options.preview }),
        ...(registerAs ? { registerAs, ttlMs: this.options.tableTtlMs } : {}),
        denySystemCatalogs: true,
        signal: ctx.signal,
      });
    } catch (error) {
      throw this.rewrap(ctx, error);
    }
    if (!registerAs || !result.tableName) return { result };

    const tables = await instance.describe();
    const columnSchema =
      tables.find((table) => table.name === result.tableName)?.columns ??
      result.columns.map((name): ColumnSchema => ({ name, type: 'VARCHAR', nullable: true }));
    const datasets = new Map<string, DataframeDataset>();
    for (const parent of parents) {
      for (const dataset of parent.datasets) datasets.set(dataset.datasetId, dataset);
    }
    const meta = await this.recordTable(
      ctx,
      { tableName: result.tableName, rowCount: result.rowCount, columnSchema },
      {
        sourceTool: options.sourceTool,
        queryParams: { sql, derived_from: parents.map((parent) => parent.tableName) },
        datasets: [...datasets.values()],
        attribution: ATTRIBUTION,
      },
    );
    return { result, meta };
  }

  /**
   * Idempotent drop of the table, then its provenance; true when either existed.
   * A failed table drop propagates with the provenance still recorded, so the
   * dataframe stays listed rather than reported dropped while its table remains.
   */
  async drop(ctx: Context, tableName: string): Promise<boolean> {
    const instance = await this.acquireForTool(ctx);
    await this.sweepExpired(ctx);
    const key = `${META_PREFIX}${tableName}`;
    const hadMeta = (await ctx.state.get(key)) !== null;
    const dropped = await instance.drop(tableName);
    await ctx.state.delete(key);
    return dropped || hadMeta;
  }

  /** Drops tables whose provenance has expired and clears the entries. Best-effort per table. */
  async sweepExpired(ctx: Context): Promise<void> {
    const nowIso = this.now().toISOString();
    let instance: CanvasInstance | undefined;
    for await (const { key, meta } of this.iterateMeta(ctx)) {
      if (meta.expiresAt > nowIso) continue;
      instance ??= await this.acquire(ctx).catch(() => undefined);
      await instance?.drop(meta.tableName).catch((error: unknown) => {
        ctx.log.warning('Expired dataframe drop failed', {
          tableName: meta.tableName,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      await ctx.state.delete(key);
    }
  }

  private registerAsClashHint(): string {
    return this.options.dropEnabled
      ? 'Drop the existing dataframe with ilostat_dataframe_drop, choose another df_XXXXX_XXXXX name, or omit register_as.'
      : 'Choose another df_XXXXX_XXXXX name or omit register_as.';
  }

  /** Rebuilds a declared gate or engine rejection with the calling tool's recovery. */
  private rewrap(ctx: Context, error: unknown): unknown {
    if (!(error instanceof McpError)) return error;
    if (error.code === JsonRpcErrorCode.ConfigurationError) return canvasUnavailable(ctx, error);
    const data = (error.data ?? {}) as Record<string, unknown>;
    const reason = data.reason === 'denied_function_in_plan' ? 'denied_function' : data.reason;
    if (typeof reason !== 'string' || !DECLARED_CANVAS_REASONS.has(reason)) return error;
    const recovery =
      reason === 'register_as_clash'
        ? { recovery: { hint: this.registerAsClashHint() } }
        : ctx.recoveryFor(reason);
    return new McpError(
      error.code,
      error.message,
      { ...data, reason, ...recovery },
      { cause: error },
    );
  }

  private async *iterateMeta(ctx: Context): AsyncGenerator<{ key: string; meta: DataframeMeta }> {
    let cursor: string | undefined;
    do {
      const page = await ctx.state.list(META_PREFIX, {
        ...(cursor === undefined ? {} : { cursor }),
        limit: 100,
      });
      for (const item of page.items) {
        if (item.value) yield { key: item.key, meta: item.value as DataframeMeta };
      }
      cursor = page.cursor;
    } while (cursor);
  }
}

/**
 * Tracks the inline preview exactly as `spillover()` measures it: rows are kept
 * while their summed `JSON.stringify` length stays within the budget; the first
 * row past it marks the preview full.
 */
class PreviewTap<T> {
  full = false;
  readonly rows: T[] = [];
  private chars = 0;

  constructor(private readonly budget: number) {}

  offer(row: T): void {
    if (this.full) return;
    const size = JSON.stringify(row).length;
    if (this.chars + size > this.budget) {
      this.full = true;
      return;
    }
    this.rows.push(row);
    this.chars += size;
  }
}

/**
 * Routes a producer's rows: inline when they fit `previewChars`; staged in full
 * when they do not and a canvas is available; refused as `too_large` past
 * `maxRows`. With no canvas, or when staging fails, reading stops at the preview.
 * A failure of the source itself (the upstream stream) propagates; a canvas
 * failure only degrades. The source is always closed before this returns.
 */
export async function routeRows<T extends Record<string, unknown>>(
  bridge: CanvasBridge | undefined,
  options: RouteOptions<T>,
): Promise<RouteOutcome<T>> {
  const { ctx } = options;
  const tap = new PreviewTap<T>(options.previewChars);
  let sourceFailed = false;
  const tapped = (async function* () {
    try {
      for await (const row of options.source) {
        tap.offer(row);
        yield row;
      }
    } catch (error) {
      sourceFailed = true;
      throw error;
    }
  })();

  const previewOnly = async (cause: 'canvas_off' | 'canvas_failed'): Promise<RouteOutcome<T>> => {
    if (!tap.full) {
      for await (const _row of tapped) {
        if (tap.full) break;
      }
    }
    return tap.full
      ? { kind: 'preview', rows: tap.rows, cause }
      : { kind: 'complete', rows: tap.rows };
  };

  try {
    if (!bridge) return await previewOnly('canvas_off');

    let instance: CanvasInstance;
    try {
      await bridge.sweepExpired(ctx);
      instance = await bridge.acquire(ctx);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      ctx.log.warning('Dataframe canvas unavailable; returning the inline preview only', {
        error: error instanceof Error ? error.message : String(error),
      });
      return await previewOnly('canvas_failed');
    }

    const tableName = bridge.mintTableName();
    let spilled: SpilloverResult<T>;
    try {
      spilled = await spillover({
        canvas: instance,
        source: tapped,
        previewChars: options.previewChars,
        schema: options.schema,
        tableName,
        ttlMs: bridge.tableTtlMs,
        signal: ctx.signal,
        ...(options.maxRows === undefined ? {} : { caps: { maxRows: options.maxRows } }),
      });
    } catch (error) {
      if (sourceFailed || ctx.signal.aborted) throw error;
      ctx.log.warning('Staging the full result failed; returning the inline preview only', {
        error: error instanceof Error ? error.message : String(error),
      });
      return await previewOnly('canvas_failed');
    }

    if (!spilled.spilled) return { kind: 'complete', rows: spilled.previewRows };
    if (spilled.truncated) {
      await instance.drop(tableName).catch(() => false);
      return { kind: 'too_large' };
    }
    try {
      const meta = await bridge.recordTable(
        ctx,
        { tableName, rowCount: spilled.handle.rowCount, columnSchema: options.schema },
        options.provenance(),
      );
      return {
        kind: 'staged',
        rows: spilled.previewRows,
        table: { name: meta.tableName, rowCount: meta.rowCount, expiresAt: meta.expiresAt },
      };
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      await instance.drop(tableName).catch(() => false);
      ctx.log.warning('Recording dataframe provenance failed; returning the inline preview only', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { kind: 'preview', rows: tap.rows, cause: 'canvas_failed' };
    }
  } finally {
    await tapped.return(undefined).catch(() => undefined);
  }
}

let bridge: CanvasBridge | undefined;

/**
 * Wires the bridge during `setup()`. `canvas` is `undefined` when the framework
 * built no DataCanvas (`CANVAS_PROVIDER_TYPE=none`); producers then return their
 * inline preview only, and the dataframe tools are registered disabled.
 */
export function initCanvasBridge(
  canvas: DataCanvas | undefined,
  options?: CanvasBridgeOptions,
): CanvasBridge | undefined {
  bridge = canvas
    ? new CanvasBridge(
        canvas,
        options ?? {
          tableTtlMs: getServerConfig().datasetTtlSeconds * 1000,
          dropEnabled: getServerConfig().dataframeDropEnabled,
        },
      )
    : undefined;
  return bridge;
}

/** The canvas bridge, or `undefined` when dataframes are off. */
export function getCanvasBridge(): CanvasBridge | undefined {
  return bridge;
}

/**
 * The canvas bridge for the dataframe tools. With the canvas off they are
 * registered through `disabledTool()`, so a call that reaches one without a
 * bridge is a wiring bug, not a deployment state a caller can act on.
 */
export function requireCanvasBridge(): CanvasBridge {
  if (!bridge) {
    throw internalError(
      'A dataframe tool ran with no DataCanvas wired; with the canvas off these tools are registered disabled.',
    );
  }
  return bridge;
}
