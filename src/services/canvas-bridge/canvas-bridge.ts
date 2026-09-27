/**
 * @fileoverview Adapter between the ILOSTAT tools and the framework DataCanvas.
 * One shared canvas per tenant (its ID kept in `ctx.state`, re-minted when it
 * expires), `df_XXXXX_XXXXX` table names, per-table TTL, and provenance under
 * `df-meta/<name>` in `ctx.state`, lazily swept on every dataframe operation and
 * cleared when the canvas is re-minted.
 * Producers route their rows through {@link routeRows}: inline when they fit the
 * preview, staged in full through the framework's `spillover()` when they do not,
 * refused when they pass the row ceiling, and cut to the preview when the canvas
 * is off or staging fails. A tenant holds at most {@link STAGING_ROW_BUDGET} rows
 * in {@link STAGING_DATAFRAME_CAP} dataframes: a new table evicts the oldest
 * others until it fits, one admission per tenant at a time, and one larger than
 * the row budget is never kept.
 * SQL runs through the framework gate with system
 * catalogs denied; its rejections are rebuilt with the calling tool's contract
 * recovery, and a canvas whose DuckDB engine cannot load fails `canvas_unavailable`.
 * Engine and filesystem error text reaches the caller, in an error or a
 * `ctx.log` warning, only with its quoted paths redacted.
 * Where every caller shares one canvas (HTTP with auth `none`), listing every
 * dataframe is off; a dataframe is reached by its exact name only.
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
import { config } from '@cyanheads/mcp-ts-core/config';
import {
  internalError,
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { ErrorHandler, idGenerator } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { ATTRIBUTION } from '@/services/attribution.js';
import type { Basis } from '@/services/basis/basis.js';
import { mintedDataframeName, scanSql } from '@/services/canvas-bridge/scan-sql.js';

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
  /** Dataframes dropped, oldest first, to make room for this one. */
  evicted: string[];
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
  /**
   * Ceiling on staged rows, at most {@link STAGING_ROW_BUDGET} (the budget when
   * unset); passing it drops the table and reports `too_large`.
   */
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

/** Staged rows one tenant may hold across its dataframes. */
export const STAGING_ROW_BUDGET = 1_000_000;
/** Dataframes one tenant may hold. */
export const STAGING_DATAFRAME_CAP = 100;

const META_PREFIX = 'df-meta/';
const CANVAS_ID_KEY = 'canvas-id';
const TABLE_NAME_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
/** The `missing_table` recovery where listing is off, in place of the contract's pointer at a listing. */
const UNLISTED_MISSING_TABLE_HINT =
  'Check the name against the df_XXXXX_XXXXX name the producing tool returned, or re-run the producing tool to stage the data again.';

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

/** The sentence naming the dataframes a new one evicted; one helper for every tool that stages. */
export function evictionNotice(evicted: readonly string[]): string {
  return `Evicted ${evicted.join(', ')} (oldest first) to keep this tenant within ${STAGING_ROW_BUDGET.toLocaleString('en-US')} staged rows and ${STAGING_DATAFRAME_CAP} dataframes.`;
}

/** A quoted absolute filesystem path, as DuckDB (`"…"`) and Node's fs errors (`'…'`) print one. */
const QUOTED_PATH = /(["'])(?:[A-Za-z]:)?[\\/][^"'\r\n]+\1/g;

/**
 * `text` with every quoted absolute path replaced by `[path]`. A DuckDB I/O error
 * names its spill file under `CANVAS_TEMP_PATH`, and a failed `mkdir` of that
 * root names the directory; neither reaches the caller.
 */
export function redactPaths(text: string): string {
  return text.replace(QUOTED_PATH, '$1[path]$1');
}

/** A thrown value's message for the client-visible `ctx.log`, paths redacted. */
function logText(error: unknown): string {
  return redactPaths(error instanceof Error ? error.message : String(error));
}

/**
 * `error` with the paths redacted from the message a caller would see; the same
 * value when it names none. The code is the one the framework gives the thrown
 * value (an McpError's own; a raw engine or filesystem error's, classified from
 * its name and message), an McpError keeps its data, and `error` is the cause.
 */
function withoutPaths(error: unknown): unknown {
  const { code, message } = ErrorHandler.classifyOnly(error);
  const redacted = redactPaths(message);
  if (redacted === message) return error;
  const data = error instanceof McpError ? error.data : undefined;
  return new McpError(code, redacted, data, { cause: error });
}

/** Rethrows `error` through {@link withoutPaths}; the `.catch()` of an engine call. */
function rethrowWithoutPaths(error: unknown): never {
  throw withoutPaths(error);
}

/** `canvas_unavailable`, carrying the calling tool's recovery. */
function canvasUnavailable(ctx: Context, cause?: unknown): McpError {
  return serviceUnavailable(
    'Dataframes are unavailable in this deployment: the DataCanvas DuckDB engine could not be loaded.',
    { reason: 'canvas_unavailable', ...ctx.recoveryFor('canvas_unavailable') },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Whether a caller may list every dataframe on its tenant's canvas, from the
 * framework config. False on HTTP with auth `none`: every caller resolves to
 * tenant `default` there, so all of them share one canvas, and a listing would
 * show each caller the others' dataframes and the SQL behind them.
 */
export function dataframeListingAllowed(): boolean {
  return !(config.mcpTransportType === 'http' && config.mcpAuthMode === 'none');
}

export interface CanvasBridgeOptions {
  dropEnabled: boolean;
  /** Whether describe may list every dataframe; see {@link dataframeListingAllowed}. */
  listingEnabled: boolean;
  now?: () => Date;
  /** Per-table TTL for staged dataframes. */
  tableTtlMs: number;
}

export class CanvasBridge {
  /** The last admission queued per tenant; settles, never rejects, once it has run. */
  private readonly admissions = new Map<string | undefined, Promise<void>>();
  /** The mint in flight per tenant. */
  private readonly mints = new Map<string | undefined, Promise<CanvasInstance>>();
  private readonly now: () => Date;

  constructor(
    private readonly canvas: DataCanvas,
    private readonly options: CanvasBridgeOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** Whether describe may list every dataframe; off where every caller shares one canvas. */
  get listingEnabled(): boolean {
    return this.options.listingEnabled;
  }

  /**
   * The tenant's shared canvas, minting one when the stored ID is unknown or
   * expired. One mint per tenant runs at a time, and it re-reads the stored ID
   * first, so concurrent calls that find no live canvas all land on the one
   * minted; a second mint would orphan a canvas that counts toward the
   * framework's per-tenant cap until it expires, and clear the provenance of
   * tables the first call had already staged.
   */
  async acquire(ctx: Context): Promise<CanvasInstance> {
    const live = await this.acquireStored(ctx);
    if (live) return live;
    const pending = this.mints.get(ctx.tenantId);
    if (pending) return await this.canvas.acquire((await pending).canvasId, ctx);
    const mint = this.mint(ctx).finally(() => this.mints.delete(ctx.tenantId));
    this.mints.set(ctx.tenantId, mint);
    return await mint;
  }

  /** The canvas the stored ID names, or `undefined` once an unknown or expired ID is cleared. */
  private async acquireStored(ctx: Context): Promise<CanvasInstance | undefined> {
    const stored = await ctx.state.get<string>(CANVAS_ID_KEY);
    if (!stored) return undefined;
    try {
      return await this.canvas.acquire(stored, ctx);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      await ctx.state.delete(CANVAS_ID_KEY);
      return undefined;
    }
  }

  /**
   * A new canvas for the tenant, unless one minted since {@link acquire} read the
   * stored ID. A minted canvas starts empty, so every provenance record left in
   * `ctx.state` names a table that is gone: they are cleared before the new ID
   * is stored.
   */
  private async mint(ctx: Context): Promise<CanvasInstance> {
    const live = await this.acquireStored(ctx);
    if (live) return live;
    const instance = await this.canvas.acquire(undefined, ctx);
    const staleKeys: string[] = [];
    for await (const { key } of this.iterateMeta(ctx)) staleKeys.push(key);
    await Promise.all(staleKeys.map((key) => ctx.state.delete(key)));
    await ctx.state.set(CANVAS_ID_KEY, instance.canvasId);
    return instance;
  }

  /**
   * {@link acquire}, with an engine that cannot load reported as
   * `canvas_unavailable` and any other failure's paths redacted: a temp root
   * the canvas cannot create is named in the `mkdir` error.
   */
  async acquireForTool(ctx: Context): Promise<CanvasInstance> {
    try {
      return await this.acquire(ctx);
    } catch (error) {
      if (error instanceof McpError && error.code === JsonRpcErrorCode.ConfigurationError) {
        throw canvasUnavailable(ctx, error);
      }
      throw withoutPaths(error);
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
   * {@link recordTable} once the tenant has room for the new table: its other
   * dataframes are dropped, oldest first, until the new one fits within
   * {@link STAGING_ROW_BUDGET} rows and {@link STAGING_DATAFRAME_CAP} dataframes,
   * totalled from the `df-meta/` records. The caller keeps a single table within
   * the row budget. The log carries only the eviction count, never a name.
   * Admissions on a tenant run one at a time, each once the one before it has
   * settled, so each totals the records the others wrote: run side by side, two
   * admissions read the same records, each found room, and together they passed
   * the budget.
   */
  async admitTable(
    ctx: Context,
    instance: CanvasInstance,
    table: { columnSchema: ColumnSchema[]; rowCount: number; tableName: string },
    provenance: Provenance,
  ): Promise<{ evicted: string[]; meta: DataframeMeta }> {
    const tenant = ctx.tenantId;
    const admission = (this.admissions.get(tenant) ?? Promise.resolve()).then(() =>
      this.admitNow(ctx, instance, table, provenance),
    );
    const settled: Promise<void> = admission
      .catch(() => undefined)
      .then(() => {
        if (this.admissions.get(tenant) === settled) this.admissions.delete(tenant);
      });
    this.admissions.set(tenant, settled);
    return await admission;
  }

  /** {@link admitTable}'s eviction and record, run while no other admission on the tenant is. */
  private async admitNow(
    ctx: Context,
    instance: CanvasInstance,
    table: { columnSchema: ColumnSchema[]; rowCount: number; tableName: string },
    provenance: Provenance,
  ): Promise<{ evicted: string[]; meta: DataframeMeta }> {
    const others: DataframeMeta[] = [];
    for await (const { meta } of this.iterateMeta(ctx)) others.push(meta);
    others.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let rows = others.reduce((sum, meta) => sum + meta.rowCount, table.rowCount);
    let count = others.length + 1;
    const evicted: string[] = [];
    for (const meta of others) {
      if (rows <= STAGING_ROW_BUDGET && count <= STAGING_DATAFRAME_CAP) break;
      await instance.drop(meta.tableName);
      await ctx.state.delete(`${META_PREFIX}${meta.tableName}`);
      rows -= meta.rowCount;
      count--;
      evicted.push(meta.tableName);
    }
    if (evicted.length > 0) {
      ctx.log.info('Evicted dataframes to stay within the tenant staging budget', {
        count: evicted.length,
      });
    }
    return { evicted, meta: await this.recordTable(ctx, table, provenance) };
  }

  /**
   * Provenance of the staged dataframes, newest first; one name, or all. Expired
   * entries are swept first, and a record whose table is no longer on the canvas
   * is deleted rather than listed. A named lookup reads that one table from the
   * canvas, never the whole listing.
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
    const onCanvas = await instance
      .describe(tableName ? { tableName } : {})
      .catch(rethrowWithoutPaths);
    const tables = new Set(onCanvas.map((table) => table.name));
    const live: DataframeMeta[] = [];
    for (const { key, meta } of entries) {
      if (tables.has(meta.tableName)) live.push(meta);
      else await ctx.state.delete(key);
    }
    return live.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * One read-only SELECT over the shared canvas, system catalogs denied. The
   * engine decides which tables exist; the `df_` identifiers {@link scanSql}
   * finds outside comments and string literals serve for provenance and for
   * naming a missing dataframe when the gate rejects a statement that reads
   * without naming one itself (see {@link rewrap}). A statement that does not
   * read keeps the gate's statement-type rejection (a write target is an unused
   * name by design). `register_as` stores the result as a new dataframe with a
   * fresh TTL and provenance inherited from the recorded dataframes the SQL
   * names, evicting the oldest others as {@link admitTable} does; a result past
   * {@link STAGING_ROW_BUDGET} rows is dropped and fails `register_as_too_large`.
   */
  async query(
    ctx: Context,
    sql: string,
    options: BridgeQueryOptions,
  ): Promise<{ evicted: string[]; meta?: DataframeMeta; result: QueryResult }> {
    const instance = await this.acquireForTool(ctx);
    await this.sweepExpired(ctx);
    const scan = scanSql(sql);
    const parents: DataframeMeta[] = [];
    const unrecorded: string[] = [];
    for (const name of scan.dataframes) {
      const meta = await ctx.state.get<DataframeMeta>(`${META_PREFIX}${name}`);
      if (meta) parents.push(meta);
      else unrecorded.push(name);
    }
    const { registerAs } = options;
    if (registerAs && (await ctx.state.get(`${META_PREFIX}${registerAs}`)) !== null) {
      throw validationError(
        `Dataframe ${registerAs} already exists; register_as needs an unused name.`,
        {
          reason: 'register_as_clash',
          tableName: registerAs,
          ...this.recoveryFor(ctx, 'register_as_clash'),
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
      throw this.rewrap(ctx, error, scan.reads ? unrecorded : undefined);
    }
    const { tableName } = result;
    if (!registerAs || !tableName) return { result, evicted: [] };
    if (result.rowCount > STAGING_ROW_BUDGET) {
      await instance.drop(tableName).catch(rethrowWithoutPaths);
      throw validationError(
        `register_as would store ${result.rowCount.toLocaleString('en-US')} rows, past the ${STAGING_ROW_BUDGET.toLocaleString('en-US')}-row staging budget; nothing was stored.`,
        {
          reason: 'register_as_too_large',
          rowCount: result.rowCount,
          rowBudget: STAGING_ROW_BUDGET,
          ...ctx.recoveryFor('register_as_too_large'),
        },
      );
    }

    const [table] = await instance.describe({ tableName }).catch(rethrowWithoutPaths);
    const columnSchema =
      table?.columns ??
      result.columns.map((name): ColumnSchema => ({ name, type: 'VARCHAR', nullable: true }));
    const datasets = new Map<string, DataframeDataset>();
    for (const parent of parents) {
      for (const dataset of parent.datasets) datasets.set(dataset.datasetId, dataset);
    }
    try {
      const { evicted, meta } = await this.admitTable(
        ctx,
        instance,
        { tableName, rowCount: result.rowCount, columnSchema },
        {
          sourceTool: options.sourceTool,
          queryParams: { sql, derived_from: parents.map((parent) => parent.tableName) },
          datasets: [...datasets.values()],
          attribution: ATTRIBUTION,
        },
      );
      return { result, meta, evicted };
    } catch (error) {
      // A table left without provenance would sit outside the budget.
      await instance.drop(tableName).catch(() => false);
      throw withoutPaths(error);
    }
  }

  /**
   * Idempotent drop of the table, then its provenance; true when either existed.
   * A failed table drop propagates, its paths redacted, with the provenance still
   * recorded, so the dataframe stays listed rather than reported dropped while its
   * table remains.
   */
  async drop(ctx: Context, tableName: string): Promise<boolean> {
    const instance = await this.acquireForTool(ctx);
    await this.sweepExpired(ctx);
    const key = `${META_PREFIX}${tableName}`;
    const hadMeta = (await ctx.state.get(key)) !== null;
    const dropped = await instance.drop(tableName).catch(rethrowWithoutPaths);
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
          error: logText(error),
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

  /**
   * The calling tool's recovery for `reason`, resolved for this deployment where
   * the contract's static text would mislead: the drop-aware clash hint, and a
   * `missing_table` hint that points at no listing when listing is off.
   */
  private recoveryFor(ctx: Context, reason: string) {
    if (reason === 'register_as_clash') return { recovery: { hint: this.registerAsClashHint() } };
    if (reason === 'missing_table' && !this.options.listingEnabled) {
      return { recovery: { hint: UNLISTED_MISSING_TABLE_HINT } };
    }
    return ctx.recoveryFor(reason);
  }

  /** `missing_table` naming dataframe `tableName`, in the minted form. */
  private missingTable(ctx: Context, tableName: string, cause: unknown): McpError {
    return notFound(
      `Dataframe ${tableName} does not exist or has expired.`,
      { reason: 'missing_table', tableName, ...this.recoveryFor(ctx, 'missing_table') },
      { cause },
    );
  }

  /**
   * Rebuilds a declared gate or engine rejection with the calling tool's
   * recovery. The gate tells a missing table or a bind error apart only for a
   * statement opening with SELECT, WITH, or FROM, and rejects any other read
   * that fails to prepare (one opening with a comment, `(`, VALUES, PIVOT,
   * SUMMARIZE, …) as `non_select_statement`. Such a read is reported as
   * `missing_table` for the first of `unrecorded`, the `df_` names it reads that
   * have no provenance, and otherwise as `invalid_sql`. `unrecorded` is
   * `undefined` for a statement that does not read. Any other rejection leaves
   * with the paths in its message redacted: an engine I/O failure names a spill
   * file under `CANVAS_TEMP_PATH`.
   */
  private rewrap(ctx: Context, error: unknown, unrecorded: readonly string[] | undefined): unknown {
    if (!(error instanceof McpError)) return withoutPaths(error);
    if (error.code === JsonRpcErrorCode.ConfigurationError) return canvasUnavailable(ctx, error);
    const data: Record<string, unknown> = error.data ?? {};
    const unpreparedRead =
      unrecorded !== undefined &&
      data.reason === 'non_select_statement' &&
      data.statementType === 'UNKNOWN';
    const missing =
      data.reason === 'missing_table' && typeof data.tableName === 'string'
        ? mintedDataframeName(data.tableName)
        : unpreparedRead
          ? unrecorded[0]
          : undefined;
    if (missing) return this.missingTable(ctx, missing, error);
    if (unpreparedRead) {
      return validationError(
        'Canvas query failed to prepare.',
        { reason: 'invalid_sql', ...this.recoveryFor(ctx, 'invalid_sql') },
        { cause: error },
      );
    }
    const reason = data.reason === 'denied_function_in_plan' ? 'denied_function' : data.reason;
    if (typeof reason !== 'string' || !DECLARED_CANVAS_REASONS.has(reason)) {
      return withoutPaths(error);
    }
    return new McpError(
      error.code,
      redactPaths(error.message),
      { ...data, reason, ...this.recoveryFor(ctx, reason) },
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
 * when they do not and a canvas is available, evicting the tenant's oldest
 * dataframes as {@link CanvasBridge.admitTable} does; refused as `too_large` past
 * `maxRows`. With no canvas, or when staging fails, reading stops at the
 * preview. A failure of the source
 * itself (the upstream stream) propagates; a canvas failure only degrades. The
 * source is always closed before this returns.
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
        error: logText(error),
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
        caps: { maxRows: options.maxRows ?? STAGING_ROW_BUDGET },
      });
    } catch (error) {
      if (sourceFailed || ctx.signal.aborted) throw error;
      ctx.log.warning('Staging the full result failed; returning the inline preview only', {
        error: logText(error),
      });
      return await previewOnly('canvas_failed');
    }

    if (!spilled.spilled) return { kind: 'complete', rows: spilled.previewRows };
    if (spilled.truncated) {
      await instance.drop(tableName).catch(() => false);
      return { kind: 'too_large' };
    }
    try {
      const { evicted, meta } = await bridge.admitTable(
        ctx,
        instance,
        { tableName, rowCount: spilled.handle.rowCount, columnSchema: options.schema },
        options.provenance(),
      );
      return {
        kind: 'staged',
        rows: spilled.previewRows,
        table: {
          name: meta.tableName,
          rowCount: meta.rowCount,
          expiresAt: meta.expiresAt,
          evicted,
        },
      };
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      await instance.drop(tableName).catch(() => false);
      ctx.log.warning('Recording dataframe provenance failed; returning the inline preview only', {
        error: logText(error),
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
          listingEnabled: dataframeListingAllowed(),
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
