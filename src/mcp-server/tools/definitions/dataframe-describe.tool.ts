/**
 * @fileoverview `ilostat_dataframe_describe` — the `df_<id>` dataframes staged on
 * this tenant's canvas, with the tool and parameters that produced each, the
 * datasets it holds, coverage, basis counts, attribution, timestamps, row count,
 * and column schema. Expired dataframes are swept first. Where every caller
 * shares one canvas (HTTP with auth `none`), a call without `name` fails
 * `listing_unavailable`, so a dataframe is described by its exact name only.
 * @module mcp-server/tools/definitions/dataframe-describe
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { BasisCountsSchema, renderBasisCounts } from '@/mcp-server/tools/observation-output.js';
import { blankAsUnset, dataframeNameInput } from '@/mcp-server/tools/tool-helpers.js';
import { requireCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { inlineText } from '@/services/catalog/text.js';

export const dataframeDescribeTool = tool('ilostat_dataframe_describe', {
  title: 'Describe staged ILOSTAT dataframes',
  description:
    'Describe the df_<id> dataframes staged by ilostat_query_indicator and ilostat_compare_geographies or stored by ilostat_dataframe_query register_as: the tool and parameters that produced each, the datasets it holds (label, unit, last update), coverage, basis counts, attribution, creation and expiry times, row count, and column schema. Pass name for one dataframe. Without it, every staged dataframe is listed, except on a deployment whose callers share one canvas, where listing is off and only the exact name works. Read the schema here before writing SQL for ilostat_dataframe_query.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    name: blankAsUnset(dataframeNameInput('name').optional()).describe(
      'One dataframe name as the producing tool returned it (df_XXXXX_XXXXX: letters and digits, five in each part; case-insensitive, as in SQL). Omit to list every staged dataframe; a deployment whose callers share one canvas refuses the listing and needs the name.',
    ),
  }),

  output: z.object({
    dataframes: z
      .array(
        z
          .object({
            name: z.string().describe('Dataframe name, the table to use in SQL.'),
            source_tool: z.string().describe('Tool that produced it.'),
            query_params: z
              .record(z.string(), z.unknown())
              .describe(
                "How the dataframe was produced: the producing tool's applied_filters, or {sql, derived_from} for a dataframe stored by ilostat_dataframe_query register_as.",
              ),
            created_at: z.string().describe('ISO 8601 creation time.'),
            expires_at: z.string().describe('ISO 8601 expiry.'),
            row_count: z.number().describe('Rows staged.'),
            datasets: z
              .array(
                z
                  .object({
                    dataset_id: z.string().describe('Dataset ID.'),
                    label: z.string().describe('Dataset label.'),
                    unit: z.string().optional().describe('Unit label, when resolved.'),
                    last_update: z.string().describe('Last upstream update of the dataset.'),
                  })
                  .describe('One dataset the dataframe holds.'),
              )
              .describe('Datasets the rows come from.'),
            coverage: z
              .object({
                ref_areas: z.number().describe('Distinct reference areas.'),
                period_min: z.string().optional().describe('Earliest period.'),
                period_max: z.string().optional().describe('Latest period.'),
              })
              .optional()
              .describe('Areas and periods covered; absent for a dataframe derived by SQL.'),
            basis_counts: BasisCountsSchema.optional().describe(
              'Rows per basis; absent for a dataframe derived by SQL.',
            ),
            attribution: z.string().describe('Citation to keep with any use of the data.'),
            column_schema: z
              .array(
                z
                  .object({
                    name: z.string().describe('Column name.'),
                    type: z
                      .string()
                      .describe('Column type (VARCHAR, INTEGER, DOUBLE, BOOLEAN, …).'),
                    nullable: z.boolean().describe('Whether the column permits NULL.'),
                  })
                  .describe('One column.'),
              )
              .describe('Columns the SQL can reference.'),
          })
          .describe('One staged dataframe.'),
      )
      .describe('Staged dataframes, newest first; empty when none.'),
  }),

  enrichment: {
    notice: z.string().optional().describe('Guidance when the named dataframe does not exist.'),
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
      reason: 'listing_unavailable',
      code: JsonRpcErrorCode.Forbidden,
      when: 'name is omitted where every caller shares one canvas (HTTP with auth none).',
      recovery:
        'Pass the exact df_XXXXX_XXXXX name that ilostat_query_indicator, ilostat_compare_geographies, or register_as returned; listing every dataframe is off on this shared deployment.',
      severity: 'notice',
    },
  ],

  async handler(input, ctx) {
    const bridge = requireCanvasBridge();
    if (!input.name && !bridge.listingEnabled) {
      throw ctx.fail(
        'listing_unavailable',
        'Listing staged dataframes is off: every caller of this deployment shares one canvas.',
        { ...ctx.recoveryFor('listing_unavailable') },
      );
    }
    const entries = await bridge.describe(ctx, input.name);
    if (input.name && entries.length === 0) {
      const next = bridge.listingEnabled
        ? 'call ilostat_dataframe_describe without name to list them'
        : 'check it against the name the producing tool returned';
      ctx.enrich.notice(
        `No staged dataframe is named ${inlineText(input.name)}; ${next}, or re-run the producing tool.`,
      );
    }
    return {
      dataframes: entries.map((meta) => ({
        name: meta.tableName,
        source_tool: meta.sourceTool,
        query_params: meta.queryParams,
        created_at: meta.createdAt,
        expires_at: meta.expiresAt,
        row_count: meta.rowCount,
        datasets: meta.datasets.map((dataset) => ({
          dataset_id: dataset.datasetId,
          label: dataset.label,
          ...(dataset.unit ? { unit: dataset.unit } : {}),
          last_update: dataset.lastUpdate,
        })),
        ...(meta.coverage
          ? {
              coverage: {
                ref_areas: meta.coverage.refAreas,
                ...(meta.coverage.periodMin ? { period_min: meta.coverage.periodMin } : {}),
                ...(meta.coverage.periodMax ? { period_max: meta.coverage.periodMax } : {}),
              },
            }
          : {}),
        ...(meta.basisCounts ? { basis_counts: meta.basisCounts } : {}),
        attribution: meta.attribution,
        column_schema: meta.columnSchema.map((column) => ({
          name: column.name,
          type: column.type,
          nullable: column.nullable ?? true,
        })),
      })),
    };
  },

  format: (result) => {
    if (result.dataframes.length === 0) {
      return [{ type: 'text', text: 'No staged dataframes.' }];
    }
    const count = result.dataframes.length;
    const lines = [`**${count} staged ${count === 1 ? 'dataframe' : 'dataframes'}**`];
    for (const frame of result.dataframes) {
      lines.push(
        '',
        `### ${frame.name}`,
        `- Source: ${frame.source_tool} · ${frame.row_count} ${frame.row_count === 1 ? 'row' : 'rows'} · created ${frame.created_at} · expires ${frame.expires_at}`,
        `- Params: ${inlineText(JSON.stringify(frame.query_params))}`,
      );
      for (const dataset of frame.datasets) {
        lines.push(
          `- Dataset: ${dataset.dataset_id} — ${inlineText(dataset.label)}${dataset.unit ? ` · unit ${inlineText(dataset.unit)}` : ''} · updated ${inlineText(dataset.last_update)}`,
        );
      }
      if (frame.coverage) {
        const areas = frame.coverage.ref_areas;
        lines.push(
          `- Coverage: ${areas} ${areas === 1 ? 'area' : 'areas'}${frame.coverage.period_min ? ` · ${inlineText(`${frame.coverage.period_min}–${frame.coverage.period_max}`)}` : ''}`,
        );
      }
      if (frame.basis_counts) lines.push(`- Basis: ${renderBasisCounts(frame.basis_counts)}`);
      lines.push(
        `- Columns: ${frame.column_schema.map((column) => `${inlineText(column.name)} ${column.type} (nullable: ${column.nullable})`).join(', ')}`,
        `- ${frame.attribution}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
