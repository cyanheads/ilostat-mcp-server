/**
 * @fileoverview `ilostat_dataframe_drop` — drop a staged `df_<id>` dataframe ahead
 * of its TTL, removing both the canvas table and its provenance. Idempotent.
 * Registered through `disabledTool()` unless `ILOSTAT_DATAFRAME_DROP_ENABLED=true`
 * and the canvas is on.
 * @module mcp-server/tools/definitions/dataframe-drop
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { dataframeNameInput } from '@/mcp-server/tools/tool-helpers.js';
import { requireCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

export const dataframeDropTool = tool('ilostat_dataframe_drop', {
  title: 'Drop a staged ILOSTAT dataframe',
  description:
    'Drop a staged df_<id> dataframe by name before its TTL expires: once an analysis with it is finished, to free the table, or to reuse its name as an ilostat_dataframe_query register_as target. Idempotent: dropped is false when nothing matched.',
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },

  input: z.object({
    name: dataframeNameInput('name').describe(
      'Dataframe name to drop (df_XXXXX_XXXXX: letters and digits, five in each part; case-insensitive, as in SQL), as ilostat_dataframe_describe lists it.',
    ),
  }),

  output: z.object({
    name: z.string().describe('The name requested.'),
    dropped: z
      .boolean()
      .describe('True when the dataframe existed and was removed; false when nothing matched.'),
  }),

  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The DataCanvas DuckDB engine cannot load in this deployment.',
      recovery:
        'Dataframes are off in this deployment; call ilostat_query_indicator or ilostat_compare_geographies with narrower filters so the result fits inline.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const dropped = await requireCanvasBridge().drop(ctx, input.name);
    ctx.log.info('Dataframe drop requested', { name: input.name, dropped });
    return { name: input.name, dropped };
  },

  format: (result) => [
    {
      type: 'text',
      text: result.dropped
        ? `Dropped ${result.name} (dropped: true).`
        : `${result.name} was not found (dropped: false).`,
    },
  ],
});
