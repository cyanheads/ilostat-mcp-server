/**
 * @fileoverview Tests for `buildToolDefinitions`: the registration list keeps all
 * nine tools in every deployment, and `tools/list` — served in-process by the
 * framework's own registry through `createWorkerHandler` — leaves out the three
 * dataframe tools when the canvas is off, and `ilostat_dataframe_drop` unless its
 * flag is on.
 * @module tests/tools/tool-definitions.test
 */

import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { describe, expect, it } from 'vitest';
import {
  buildToolDefinitions,
  type ToolDefinitionOptions,
} from '@/mcp-server/tools/definitions/index.js';
import { guardNetwork } from '../helpers/network-guard.js';

guardNetwork();

const PROTOCOL_VERSION = '2026-07-28';

const CORE_TOOLS = [
  'ilostat_search_indicators',
  'ilostat_describe_indicator',
  'ilostat_query_indicator',
  'ilostat_get_country_profile',
  'ilostat_compare_geographies',
  'ilostat_list_reference',
];

/** The tool names a client sees in `tools/list` for a deployment built with `options`. */
async function listedTools(options: ToolDefinitionOptions): Promise<string[]> {
  const handler = createWorkerHandler({
    name: 'ilostat-mcp-server',
    tools: buildToolDefinitions(options),
  });
  const response = await handler.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        'mcp-method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    }),
    { LOG_LEVEL: 'error' },
    {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
    } as unknown as Parameters<typeof handler.fetch>[2],
  );
  const body = (await response.json()) as { result: { tools: { name: string }[] } };
  return body.result.tools.map((tool) => tool.name).sort();
}

describe('buildToolDefinitions', () => {
  it.each([
    { canvasEnabled: true, dropEnabled: true },
    { canvasEnabled: true, dropEnabled: false },
    { canvasEnabled: false, dropEnabled: true },
    { canvasEnabled: false, dropEnabled: false },
  ])('registers all nine tools for %o, so the list length never varies', (options) => {
    expect(buildToolDefinitions(options)).toHaveLength(9);
  });

  it('lists every tool when the canvas and drop are both on', async () => {
    expect(await listedTools({ canvasEnabled: true, dropEnabled: true })).toEqual(
      [
        ...CORE_TOOLS,
        'ilostat_dataframe_query',
        'ilostat_dataframe_describe',
        'ilostat_dataframe_drop',
      ].sort(),
    );
  });

  it('leaves out ilostat_dataframe_drop when its flag is off', async () => {
    expect(await listedTools({ canvasEnabled: true, dropEnabled: false })).toEqual(
      [...CORE_TOOLS, 'ilostat_dataframe_query', 'ilostat_dataframe_describe'].sort(),
    );
  });

  it.each([true, false])(
    'leaves out all three dataframe tools when the canvas is off (drop flag %s)',
    async (dropEnabled) => {
      expect(await listedTools({ canvasEnabled: false, dropEnabled })).toEqual(
        [...CORE_TOOLS].sort(),
      );
    },
  );
});
