/**
 * @fileoverview `ilostat_dataframe_query` — one read-only SELECT over the `df_<id>`
 * dataframes staged by the observation tools or stored by an earlier
 * `register_as`. The framework SQL gate enforces a
 * single SELECT, a read-only plan, and no file access or settings reads; system catalogs
 * are denied, so the shared canvas cannot be enumerated from SQL. Gate rejections
 * carry this tool's recovery. A `register_as` result is held to the tenant's
 * staging budget, and the dataframes it evicts are named in the output.
 * @module mcp-server/tools/definitions/dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { blankAsUnset, dataframeNameInput, tableCell } from '@/mcp-server/tools/tool-helpers.js';
import {
  evictionNotice,
  queryRowCap,
  requireCanvasBridge,
  STAGING_ROW_BUDGET,
} from '@/services/canvas-bridge/canvas-bridge.js';

type ResultRow = Record<string, unknown>;

/** One result cell or column name, each line break kept as `<br>`. */
const resultCell = (text: string) => tableCell(text, '<br>');

/** Where a size-cut notice points for the rows left out. */
const SELECTIVE_SQL =
  'selective SQL: fewer columns, LIMIT … OFFSET over an ORDER BY, or aggregates.';

const grouped = (n: number) => n.toLocaleString('en-US');

/** The `row_limit` a call that sends none runs under, before the per-call cap. */
const DEFAULT_ROW_LIMIT = 1000;

/** A value as its table cell renders it. */
function cellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return resultCell(value);
  if (typeof value === 'object') return resultCell(JSON.stringify(value));
  return String(value);
}

/** One result row as a markdown table line. */
function tableRow(columns: readonly string[], row: ResultRow): string {
  return `| ${columns.map((column) => cellText(row[column])).join(' | ')} |`;
}

/** A row's cost on the larger surface: its JSON form or its table line. */
function rowChars(columns: readonly string[], row: ResultRow): number {
  return Math.max(JSON.stringify(row).length, tableRow(columns, row).length);
}

/** Room left in a part for the alias it is selected under. */
const PART_ALIAS_HEADROOM = 100;

/**
 * A row that alone passes the inline budget: its size, its widest column, and
 * `partChars` when that column alone still passes it — the `substr()` part
 * size that column fits inline at, scaled by its rendered width.
 */
interface OversizedRow {
  chars: number;
  column: string;
  columnChars: number;
  partChars?: number;
  text: boolean;
}

function oversizedRow(
  columns: readonly string[],
  row: ResultRow,
  chars: number,
  budget: number,
): OversizedRow {
  let widest = { column: '', columnChars: -1 };
  for (const column of columns) {
    const value = row[column];
    const columnChars =
      value == null ? 0 : typeof value === 'string' ? value.length : JSON.stringify(value).length;
    if (columnChars > widest.columnChars) widest = { column, columnChars };
  }
  const { column, columnChars } = widest;
  const aloneChars = rowChars([column], { [column]: row[column] });
  return {
    chars,
    column,
    columnChars,
    text: typeof row[column] === 'string',
    ...(aloneChars > budget
      ? { partChars: Math.floor(((budget - PART_ALIAS_HEADROOM) * columnChars) / aloneChars) }
      : {}),
  };
}

/** The size sentence for a withheld row: fewer columns, or the column read in `substr()` parts. */
function oversizedNote({ chars, column, columnChars, partChars, text }: OversizedRow): string {
  const lead = `the next row alone is ${grouped(chars)} characters, and its widest column, ${column}, holds ${grouped(columnChars)}`;
  if (partChars === undefined) return `${lead} and fits inline alone — select fewer columns`;
  const quoted = `"${column.replaceAll('"', '""')}"`;
  const ref = text ? quoted : `CAST(${quoted} AS VARCHAR)`;
  return `${lead} — select it alone in parts of ${grouped(partChars)} characters: substr(${ref}, 1, ${partChars}), then substr(${ref}, ${partChars + 1}, ${partChars}), and on to length(${ref})`;
}

/**
 * The leading rows that fit `budget`, each costing the larger of its JSON form
 * and its table line, plus one character for the separator before it (the
 * comma in `rows`, the line break in the table), so neither surface passes it.
 * The cut falls before the first row that does not fit, never inside a value;
 * that row is described when it alone passes the budget.
 */
function fitToBudget(
  columns: readonly string[],
  rows: ResultRow[],
  budget: number,
): { cut: boolean; oversized?: OversizedRow; rows: ResultRow[] } {
  let used = 0;
  for (const [index, row] of rows.entries()) {
    const chars = rowChars(columns, row);
    const cost = index === 0 ? chars : chars + 1;
    if (used + cost > budget) {
      return {
        cut: true,
        rows: rows.slice(0, index),
        ...(chars > budget ? { oversized: oversizedRow(columns, row, chars, budget) } : {}),
      };
    }
    used += cost;
  }
  return { cut: false, rows };
}

export const dataframeQueryTool = tool('ilostat_dataframe_query', {
  title: 'Query staged ILOSTAT dataframes',
  description:
    'Run a single-statement SELECT against the df_<id> dataframes staged by ilostat_query_indicator and ilostat_compare_geographies or stored by an earlier register_as. Inspect a dataframe with ilostat_dataframe_describe first; its column schema is what the SQL has to match. Read-only: writes, DDL, DROP, COPY, PRAGMA, ATTACH, file references, file-reading table functions, and functions that read engine settings or name a table from a string are rejected, and system catalogs (information_schema, pg_catalog, sqlite_master, duckdb_*) are denied. Breakdown versions overlap (AGE_YTHADULT_*, AGE_AGGREGATE_*, AGE_10YRBANDS_*, AGE_5YRBANDS_*; ECO_SECTOR_*, ECO_AGGREGATE_*, ECO_ISIC4_*, ECO_ISIC3_*), so filter to one version before summing. Optional register_as stores the result as a new dataframe with a fresh TTL.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    sql: z
      .string()
      .trim()
      .min(1)
      .max(20_000, {
        message:
          'sql must be at most 20,000 characters; shorten it, or split the analysis into steps chained with register_as.',
      })
      .describe(
        'One SELECT over df_<id> tables (DuckDB SQL: joins, aggregates, window functions, CTEs), at most 20,000 characters. BIGINT results such as COUNT or SUM of integers serialize as strings; CAST to DOUBLE for inline arithmetic.',
      ),
    register_as: blankAsUnset(dataframeNameInput('register_as').optional()).describe(
      'Store the result as a new dataframe under this name (df_XXXXX_XXXXX: letters and digits, five in each part; stored uppercased after df_) with a fresh TTL, to chain analyses. A result over 1,000,000 rows is refused, and storing one can evict the oldest dataframes, which evicted names.',
    ),
    preview: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Rows returned inline; defaults to row_limit, and a larger value is applied as row_limit. Inline rows also stop at a size budget (applied_limits.preview_chars). Set lower when register_as keeps the full result.',
      ),
    row_limit: z
      .number()
      .int()
      .min(1)
      .max(STAGING_ROW_BUDGET, {
        message:
          'row_limit must be at most 1,000,000; any value past the per-call row cap is applied as that cap.',
      })
      .optional()
      .describe(
        `Cap on rows materialized; defaults to ${grouped(DEFAULT_ROW_LIMIT)}, or the per-call cap when that is lower. The per-call cap is 10,000, or the lower cap the deployment sets; a larger value, up to 1,000,000, is applied as that cap. A query matching more stops at the cap and row_count_capped is true; register_as keeps the full result.`,
      ),
  }),

  output: z.object({
    columns: z.array(z.string()).describe('Column names in projection order.'),
    row_count: z
      .number()
      .describe(
        'Rows the query produced. With register_as this is the exact count of the stored dataframe, which row_limit does not bound; otherwise at most row_limit, and when row_count_capped is true it is the cap, not a total.',
      ),
    row_count_capped: z
      .boolean()
      .describe(
        'True when the query matched more rows than row_limit; never true with register_as, which stores every row.',
      ),
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Result rows keyed by the names in columns, bounded by preview, row_limit, and an inline size budget; rows stop before the first that would pass the budget, and a value is never clipped. BIGINT values arrive as strings.',
      ),
    registered_as: z
      .string()
      .optional()
      .describe('The new dataframe name, when register_as stored the result.'),
    expires_at: z.string().optional().describe('ISO 8601 expiry of the new dataframe.'),
    evicted: z
      .array(z.string())
      .optional()
      .describe(
        'Dataframes dropped, oldest first, to keep this tenant within 1,000,000 staged rows and 100 dataframes; present only when storing the result evicted any.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the query returned no rows, a cap withheld some, or a limit was applied below the value sent.',
      ),
    truncated: z.boolean().describe('True when a cap withheld rows from this response.'),
    shown: z.number().describe('Rows returned inline.'),
    cap: z
      .number()
      .describe('The row cap that bound: preview when lower than row_limit, else row_limit.'),
    applied_limits: z
      .object({
        row_limit: z
          .number()
          .describe(
            'Row cap applied: row_limit (default 1,000), or the per-call cap when that is lower. With register_as it bounds the inline rows, never the stored result.',
          ),
        preview: z
          .number()
          .describe('Inline rows applied: preview, at most the applied row_limit.'),
        preview_chars: z
          .number()
          .describe(
            'Inline size budget applied, in characters; rows stop before the first that would pass it.',
          ),
      })
      .optional()
      .describe('The limits this call ran under, after any clamp.'),
  },

  enrichmentTrailer: {
    applied_limits: {
      render: (limits: { preview: number; preview_chars: number; row_limit: number }) =>
        `**Applied limits:** row_limit ${limits.row_limit} · preview ${limits.preview} · preview_chars ${limits.preview_chars}`,
    },
  },

  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The DataCanvas DuckDB engine cannot load in this deployment.',
      recovery:
        'Dataframes are off in this deployment; call ilostat_query_indicator or ilostat_compare_geographies with narrower filters so the result fits inline.',
      thrownBy: 'service',
    },
    {
      reason: 'system_catalog_access',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL references a system catalog.',
      recovery: 'Query only df_<id> tables, by the names the producing tools returned.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      when: 'A referenced df_<id> does not exist or has expired.',
      recovery:
        'Call ilostat_dataframe_describe to list the staged dataframes, or re-run the producing tool to stage the data again.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_sql',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SELECT fails to prepare: an unknown column or an invalid expression.',
      recovery:
        'Check column names and syntax against the schema ilostat_dataframe_describe reports.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'sql_execution_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SELECT prepared but failed on the data.',
      recovery:
        'Wrap the failing cast in TRY_CAST, or filter out the rows the error message names before converting them.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'register_as_clash',
      code: JsonRpcErrorCode.ValidationError,
      when: 'register_as names an existing dataframe.',
      recovery: 'Choose another df_XXXXX_XXXXX name or omit register_as.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'register_as_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The register_as result holds more than 1,000,000 rows.',
      recovery:
        'Filter or aggregate the SELECT so it stores at most 1,000,000 rows, or omit register_as and read the rows inline under row_limit.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'non_select_statement',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL is not a SELECT.',
      recovery:
        'Send only a SELECT statement against df_<id> tables, by the names the producing tools returned.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'multi_statement',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL holds more than one statement, or a PIVOT with no IN list, which DuckDB expands into several.',
      recovery:
        'Send exactly one SELECT statement per call and split multi-statement SQL into separate calls; give a PIVOT its values as ON <column> IN (...).',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'denied_function',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL calls a file-reading or external table function, a function that reads engine settings (current_setting, current_schema, which an unqualified column of that name also reads as), or one that runs SQL or names a table from a string (query_table, query() over anything but one string literal, query() nested more than 4 deep).',
      recovery:
        'Remove the denied function and query only df_<id> tables directly, by the names the producing tools returned.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'sql_read_only',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL names a file in place of a table, or attempts a write the engine refuses.',
      recovery:
        'Read only df_<id> tables, by the names the producing tools returned; this tool reads no files and writes nothing.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'plan_operator_not_allowed',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The plan uses an operator outside the read-only allowlist, such as range().',
      recovery:
        'Rewrite with read-only SELECT constructs — joins, aggregates, window functions, CTEs, and unnest() are supported.',
      severity: 'notice',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const bridge = requireCanvasBridge();
    const rowCap = queryRowCap();
    const rowLimit = Math.min(input.row_limit ?? DEFAULT_ROW_LIMIT, rowCap);
    const preview = Math.min(input.preview ?? rowLimit, rowLimit);
    const clamps: string[] = [];
    if (input.row_limit !== undefined && rowLimit < input.row_limit) {
      clamps.push(`row_limit ${input.row_limit} was applied as ${rowLimit}, the per-call row cap.`);
    }
    if (input.preview !== undefined && preview < input.preview) {
      clamps.push(
        `preview ${input.preview} was applied as ${preview}, since preview never exceeds row_limit.`,
      );
    }
    const { result, meta, evicted } = await bridge.query(ctx, input.sql, {
      rowLimit,
      preview,
      sourceTool: 'ilostat_dataframe_query',
      ...(input.register_as ? { registerAs: input.register_as } : {}),
    });

    const budget = bridge.previewChars;
    const fit = fitToBudget(result.columns, result.rows, budget);
    const rows = fit.rows;
    const shown = rows.length;
    const previewBinds = preview < rowLimit;
    const cap = previewBinds ? preview : rowLimit;
    const lever = previewBinds
      ? 'raise preview'
      : rowLimit < rowCap
        ? `raise row_limit (up to ${grouped(rowCap)})`
        : undefined;
    ctx.enrich({
      truncated: false,
      shown,
      cap,
      applied_limits: { row_limit: rowLimit, preview, preview_chars: budget },
    });
    const sizeNote = fit.cut
      ? ` Inline rows are held to ${grouped(budget)} characters${fit.oversized ? `; ${oversizedNote(fit.oversized)}` : ''}.`
      : '';
    let guidance: string | undefined;
    if (result.truncated === true) {
      const keep = fit.cut
        ? `Use register_as to keep the whole result — its row_count is then exact — and read it with ${SELECTIVE_SQL}`
        : lever
          ? `Use register_as to keep the whole result — its row_count is then exact — or ${lever}.`
          : 'Use register_as to keep the whole result; its row_count is then exact.';
      const page =
        shown < result.rowCount
          ? `Showing ${shown} of the first ${result.rowCount} ${result.rowCount === 1 ? 'row' : 'rows'}.${sizeNote} The query matched more than row_limit,`
          : `Showing ${shown} ${shown === 1 ? 'row' : 'rows'}.${sizeNote} The query matched more than row_limit (${rowLimit}),`;
      guidance = `${page} so row_count is that cap, not a total. ${keep}`;
    } else if (result.rowCount > shown) {
      const one = result.rowCount === 1;
      const page = `Showing ${shown} of ${result.rowCount} ${one ? 'row' : 'rows'}.${sizeNote}`;
      if (meta) {
        const stored = `${one ? 'The row is' : `All ${result.rowCount} are`} stored as ${meta.tableName}`;
        guidance = fit.cut
          ? `${page} ${stored}; query that dataframe with ${SELECTIVE_SQL}`
          : `${page} ${stored}; query that dataframe with ilostat_dataframe_query${lever ? `, or ${lever} to see more inline` : ''}.`;
      } else {
        guidance = fit.cut
          ? `${page} Use register_as to keep the full result and read it with ${SELECTIVE_SQL}`
          : `${page} Use register_as to keep the full result${lever ? `, or ${lever}` : ''}.`;
      }
    }
    if (guidance) {
      ctx.enrich.truncated({ shown, cap, guidance: [...clamps, guidance].join(' ') });
    } else if (result.rowCount === 0) {
      ctx.enrich.notice(
        [
          ...clamps,
          'Query returned 0 rows. Verify dataframe names with ilostat_dataframe_describe and check the WHERE conditions.',
        ].join(' '),
      );
    } else if (clamps.length > 0) {
      ctx.enrich.notice(clamps.join(' '));
    }
    ctx.log.info('Dataframe query ran', {
      rowCount: result.rowCount,
      returned: shown,
      registeredAs: meta?.tableName,
    });

    return {
      columns: result.columns,
      row_count: result.rowCount,
      row_count_capped: result.truncated === true,
      rows,
      ...(meta ? { registered_as: meta.tableName, expires_at: meta.expiresAt } : {}),
      ...(evicted.length > 0 ? { evicted } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    if (result.registered_as) {
      lines.push(
        `Registered as ${result.registered_as} (expires ${result.expires_at ?? 'unknown'}).`,
      );
    }
    if (result.evicted) lines.push(evictionNotice(result.evicted));
    const partial = result.rows.length < result.row_count;
    const count = `**${result.row_count} ${result.row_count === 1 ? 'row' : 'rows'}**`;
    const header = result.row_count_capped
      ? `${count} — capped at row_limit${partial ? `, showing ${result.rows.length}` : ''}; more rows matched`
      : `${count}${partial ? ` (showing ${result.rows.length} of ${result.row_count})` : ''}`;
    lines.push(header, '');
    if (result.rows.length === 0) {
      const empty = result.row_count === 0 ? '_No rows._' : '_No rows shown inline._';
      lines.push(`${empty} Columns: ${result.columns.map(resultCell).join(', ')}`);
      return [{ type: 'text', text: lines.join('\n') }];
    }
    lines.push(
      `| ${result.columns.map(resultCell).join(' | ')} |`,
      `| ${result.columns.map(() => '---').join(' | ')} |`,
    );
    for (const row of result.rows) lines.push(tableRow(result.columns, row));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
