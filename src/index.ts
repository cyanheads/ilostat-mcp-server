#!/usr/bin/env node
/**
 * @fileoverview ilostat-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import { buildInstructions } from '@/mcp-server/server-instructions.js';
import { buildToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { disposeIlostatServices, initIlostatServices } from '@/services/ilostat-services.js';

// The framework reads ./.env only inside createApp(), but the canvas default and
// the drop gate below are read before it, so load the file first. A missing file
// is not an error: every variable has a default.
try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

// DataCanvas is on by default — DuckDB ships as a direct dependency. A blank value
// (what a bundle form sends when left empty) counts as unset; set
// CANVAS_PROVIDER_TYPE=none to turn dataframes off.
process.env.CANVAS_PROVIDER_TYPE ||= 'duckdb';
const canvasEnabled = process.env.CANVAS_PROVIDER_TYPE !== 'none';
const { dataframeDropEnabled } = getServerConfig();

await createApp({
  name: 'ilostat-mcp-server',
  title: 'ilostat-mcp-server',
  tools: buildToolDefinitions({ canvasEnabled, dropEnabled: dataframeDropEnabled }),
  resources: [],
  prompts: [],
  // No tool asks the caller for input mid-handler, so every HTTP request can land on
  // any instance. MCP_SESSION_MODE still overrides this when it carries a value.
  sessionMode: 'stateless',
  instructions: buildInstructions({ canvasEnabled }),
  setup(core) {
    initIlostatServices({ canvas: core.canvas }).catalog.start();
  },
  // Release the catalog refresh timer, in-flight loads, and both upstream pacers.
  teardown() {
    disposeIlostatServices();
  },
});
