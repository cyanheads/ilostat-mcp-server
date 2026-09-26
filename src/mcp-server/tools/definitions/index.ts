/**
 * @fileoverview The tool registration list handed to `createApp()` — every
 * ilostat tool, including the ones a deployment gates off. A gated tool stays in
 * the list through `disabledTool()`: absent from `tools/list` and uncallable, but
 * visible with its enable hint on the HTTP landing page, so the list length never
 * varies by deployment. With the canvas off (`CANVAS_PROVIDER_TYPE=none`) all three
 * dataframe tools are gated; otherwise `ilostat_dataframe_drop` alone is, unless
 * `ILOSTAT_DATAFRAME_DROP_ENABLED` is on.
 * @module mcp-server/tools/definitions/index
 */

import { disabledTool } from '@cyanheads/mcp-ts-core';
import { compareGeographiesTool } from './compare-geographies.tool.js';
import { dataframeDescribeTool } from './dataframe-describe.tool.js';
import { dataframeDropTool } from './dataframe-drop.tool.js';
import { dataframeQueryTool } from './dataframe-query.tool.js';
import { describeIndicatorTool } from './describe-indicator.tool.js';
import { getCountryProfileTool } from './get-country-profile.tool.js';
import { listReferenceTool } from './list-reference.tool.js';
import { queryIndicatorTool } from './query-indicator.tool.js';
import { searchIndicatorsTool } from './search-indicators.tool.js';

/** Deployment gates that decide how a tool enters the registration list. */
export interface ToolDefinitionOptions {
  /** False when `CANVAS_PROVIDER_TYPE=none`; registers the three dataframe tools disabled. */
  canvasEnabled: boolean;
  /** `ILOSTAT_DATAFRAME_DROP_ENABLED`; off registers `ilostat_dataframe_drop` disabled. */
  dropEnabled: boolean;
}

const CANVAS_OFF = {
  reason: 'Dataframes are turned off in this deployment.',
  hint: 'CANVAS_PROVIDER_TYPE=duckdb',
};

const DROP_OFF = {
  reason:
    'Dropping dataframes is turned off in this deployment; staged tables expire on their own TTL.',
  hint: 'ILOSTAT_DATAFRAME_DROP_ENABLED=true',
};

/** The tool list for `createApp({ tools })`, constant in length across deployments. */
export function buildToolDefinitions(options: ToolDefinitionOptions) {
  const dataframeTools = options.canvasEnabled
    ? [
        dataframeQueryTool,
        dataframeDescribeTool,
        options.dropEnabled ? dataframeDropTool : disabledTool(dataframeDropTool, DROP_OFF),
      ]
    : [dataframeQueryTool, dataframeDescribeTool, dataframeDropTool].map((definition) =>
        disabledTool(definition, CANVAS_OFF),
      );
  return [
    searchIndicatorsTool,
    describeIndicatorTool,
    queryIndicatorTool,
    getCountryProfileTool,
    compareGeographiesTool,
    listReferenceTool,
    ...dataframeTools,
  ];
}
