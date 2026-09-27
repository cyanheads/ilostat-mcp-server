/**
 * @fileoverview `ilostat_dataframe_query` — one read-only SELECT over the `df_<id>`
 * dataframes staged by the observation tools or stored by an earlier
 * `register_as`. The framework SQL gate enforces a
 * single SELECT, a read-only plan, and no file-reading functions; system catalogs
 * are denied, so the shared canvas cannot be enumerated from SQL. Gate rejections
 * carry this tool's recovery. A `register_as` result is held to the tenant's
 * staging budget, and the dataframes it evicts are named in the output.
 * @module mcp-server/tools/definitions/dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { blankAsUnset, dataframeNameInput, tableCell } from '@/mcp-server/tools/tool-helpers.js';
import { evictionNotice, requireCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

/** One result cell or column name, each line break kept as `<br>`. */
const resultCell = (text: string) => tableCell(text, '<br>');

export const dataframeQueryTool = tool('ilostat_dataframe_query', {
  title: 'Query staged ILOSTAT dataframes',
  description:
    'Run a single-statement SELECT against the df_<id> dataframes staged by ilostat_query_indicator and ilostat_compare_geographies or stored by an earlier register_as. Inspect a dataframe with ilostat_dataframe_describe first; its column schema is what the SQL has to match. Read-only: writes, DDL, DROP, COPY, PRAGMA, ATTACH, and file-reading table functions are rejected, and system catalogs (information_schema, pg_catalog, sqlite_master, duckdb_*) are denied. Breakdown versions overlap (AGE_YTHADULT_*, AGE_AGGREGATE_*, AGE_10YRBANDS_*), so filter to one version before summing. Optional register_as stores the result as a new dataframe with a fresh TTL.',
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
      .max(10_000)
      .optional()
      .describe(
        'Rows returned inline; defaults to row_limit. Set lower when register_as keeps the full result.',
      ),
    row_limit: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(1000)
      .describe(
        'Hard cap on rows materialized (1–10,000). A query matching more stops at the cap and row_count_capped is true; register_as keeps the full result.',
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
        'Result rows keyed by the names in columns, bounded by preview and row_limit; BIGINT values arrive as strings.',
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
      .describe('Guidance when the query returned no rows or a cap withheld some.'),
    truncated: z.boolean().describe('True when a cap withheld rows from this response.'),
    shown: z.number().describe('Rows returned inline.'),
    cap: z
      .number()
      .describe('The row cap that bound: preview when lower than row_limit, else row_limit.'),
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
      when: 'The SQL calls a file-reading or external table function.',
      recovery:
        'Remove the file-reading function and query only df_<id> tables, by the names the producing tools returned.',
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
    const preview =
      input.preview === undefined ? undefined : Math.min(input.preview, input.row_limit);
    const { result, meta, evicted } = await bridge.query(ctx, input.sql, {
      rowLimit: input.row_limit,
      sourceTool: 'ilostat_dataframe_query',
      ...(preview === undefined ? {} : { preview }),
      ...(input.register_as ? { registerAs: input.register_as } : {}),
    });

    const shown = result.rows.length;
    const previewBinds = preview !== undefined && preview < input.row_limit;
    const cap = previewBinds ? preview : input.row_limit;
    const lever = previewBinds ? 'raise preview' : 'raise row_limit (max 10,000)';
    ctx.enrich({ truncated: false, shown, cap });
    if (result.rowCount === 0) {
      ctx.enrich.notice(
        'Query returned 0 rows. Verify dataframe names with ilostat_dataframe_describe and check the WHERE conditions.',
      );
    } else if (result.truncated === true) {
      ctx.enrich.truncated({
        shown,
        cap,
        guidance: `Showing ${shown} ${shown === 1 ? 'row' : 'rows'}. The query matched more than row_limit (${input.row_limit}), so row_count is that cap, not a total. Use register_as to keep the whole result — its row_count is then exact — or ${lever}.`,
      });
    } else if (result.rowCount > shown) {
      const one = result.rowCount === 1;
      const page = `Showing ${shown} of ${result.rowCount} ${one ? 'row' : 'rows'}.`;
      ctx.enrich.truncated({
        shown,
        cap,
        guidance: meta
          ? `${page} ${one ? 'The row is' : `All ${result.rowCount} are`} stored as ${meta.tableName}; query that dataframe with ilostat_dataframe_query, or ${lever} to see more inline.`
          : `${page} Use register_as to keep the full result, or ${lever}.`,
      });
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
      rows: result.rows,
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
    for (const row of result.rows) {
      const cells = result.columns.map((column) => {
        const value = row[column];
        if (value == null) return '';
        if (typeof value === 'string') return resultCell(value);
        if (typeof value === 'object') return resultCell(JSON.stringify(value));
        return String(value);
      });
      lines.push(`| ${cells.join(' | ')} |`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
