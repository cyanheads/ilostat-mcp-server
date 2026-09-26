/**
 * @fileoverview Tests for `ilostat_dataframe_drop` over a real in-memory DuckDB
 * canvas: its registration under the drop flag and the canvas switch; a name in
 * any case drops the dataframe minted under the `df_XXXXX_XXXXX` form, a second
 * drop and an unknown name find nothing, and a record whose table already left
 * the canvas still drops and frees the name for `register_as`; malformed and
 * blank names fail at the schema; a canvas drop that fails fails the call with
 * the dataframe still listed; `canvas_unavailable` from an engine that cannot
 * load, and a call with no canvas wired failing `InternalError`; the severity
 * pin — on both consumption paths (`structuredContent` and `content[]`).
 * @module tests/tools/dataframe-drop.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { buildToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { disposeIlostatServices, getIlostatServices } from '@/services/ilostat-services.js';
import {
  faultyCanvas,
  memoryCanvas,
  sharingState,
  stageObservations,
  wireDataframes,
} from '../helpers/ilostat-upstream.js';
import { guardNetwork } from '../helpers/network-guard.js';

guardNetwork();

const TENANT = 'default';
const canvases: DataCanvas[] = [];

afterEach(async () => {
  disposeIlostatServices();
  for (const canvas of canvases.splice(0)) {
    await canvas.shutdown(createMockContext({ tenantId: TENANT }));
  }
});

type Output = Awaited<ReturnType<typeof dataframeDropTool.handler>>;
type ContractResult = Awaited<ReturnType<typeof runToolContract>>;

const CANVAS_UNAVAILABLE_RECOVERY =
  'Dataframes are off in this deployment; call ilostat_query_indicator or ilostat_compare_geographies with narrower filters so the result fits inline.';
const CANVAS_UNAVAILABLE_MESSAGE =
  'Dataframes are unavailable in this deployment: the DataCanvas DuckDB engine could not be loaded.';
const NO_CANVAS_MESSAGE =
  'A dataframe tool ran with no DataCanvas wired; with the canvas off these tools are registered disabled.';

/** Dataframes on, over `canvas` (a fresh in-memory one by default). */
function wireCanvas(canvas: DataCanvas = memoryCanvas()): DataCanvas {
  canvases.push(canvas);
  wireDataframes({ canvas });
  return canvas;
}

function newContext() {
  return createMockContext({ tenantId: TENANT, errors: dataframeDropTool.errors });
}

async function drop(name: string, ctx: Context): Promise<Output> {
  return await dataframeDropTool.handler(
    dataframeDropTool.input.parse({ name }),
    ctx as Parameters<typeof dataframeDropTool.handler>[1],
  );
}

/** The table names on `ctx`'s tenant canvas, read from the engine, not from provenance. */
async function canvasTables(canvas: DataCanvas, ctx: Context): Promise<string[]> {
  const instance = await canvas.acquire((await ctx.state.get<string>('canvas-id')) ?? '', ctx);
  return (await instance.describe()).map((table) => table.name);
}

function render(result: Output): string {
  return (dataframeDropTool.format?.(result) ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
}

function contentText(result: ContractResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

describe('name', () => {
  it('drops a dataframe named in any case, table and provenance both', async () => {
    wireCanvas();
    const ctx = createMockContext({ tenantId: TENANT, errors: dataframeDropTool.errors });
    const { name } = await stageObservations(ctx);
    const result = await dataframeDropTool.handler(
      dataframeDropTool.input.parse({ name: ` ${name.toLowerCase()} ` }),
      ctx,
    );
    expect(result).toEqual({ name, dropped: true });
    expect(render(result)).toBe(`Dropped ${name} (dropped: true).`);
    const bridge = getIlostatServices().bridge;
    expect(await bridge?.describe(ctx)).toEqual([]);
  });

  it('a lowercase name passes the schema on both surfaces, echoed in the minted form', async () => {
    wireCanvas();
    const result = await runToolContract(dataframeDropTool, { name: 'df_nope0_nope0' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ name: 'df_NOPE0_NOPE0', dropped: false });
    expect(contentText(result)).toBe('df_NOPE0_NOPE0 was not found (dropped: false).');
  });

  it.each([
    ['a short part', 'df_ABCD_FGHIJ'],
    ['a missing prefix', 'ABCDE_FGHIJ'],
    ['an SQL payload', "df_ABCDE_FGHIJ'; DROP TABLE x --"],
    ['nothing but spaces', '   '],
  ])('rejects a name with %s at the schema', async (_label, name) => {
    wireCanvas();
    const result = await runToolContract(dataframeDropTool, { name });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(contentText(result)).toContain(
      'name must match df_XXXXX_XXXXX: letters and digits, five in each part.',
    );
  });
});

describe('a canvas drop that fails', () => {
  const DROP_ERROR = 'IO Error: could not drop the table';

  function wireFaultyDrop(): void {
    const canvas = faultyCanvas({ at: 'drop', error: new Error(DROP_ERROR) });
    canvases.push(canvas);
    wireDataframes({ canvas });
  }

  it('fails the call and keeps the dataframe, table and provenance both', async () => {
    wireFaultyDrop();
    const ctx = createMockContext({ tenantId: TENANT, errors: dataframeDropTool.errors });
    const { name } = await stageObservations(ctx);
    await expect(
      dataframeDropTool.handler(dataframeDropTool.input.parse({ name }), ctx),
    ).rejects.toThrow(DROP_ERROR);
    const listed = await getIlostatServices().bridge?.describe(ctx);
    expect(listed?.map((meta) => meta.tableName)).toEqual([name]);
  });

  it('is an error on both surfaces, never dropped: true', async () => {
    wireFaultyDrop();
    const result = await runToolContract(dataframeDropTool, { name: 'df_GONE0_GONE0' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { message: DROP_ERROR } });
    expect(result.structuredContent).not.toHaveProperty('dropped');
    expect(contentText(result)).toContain(DROP_ERROR);
  });
});

describe('registration', () => {
  const CANVAS_OFF = {
    reason: 'Dataframes are turned off in this deployment.',
    hint: 'CANVAS_PROVIDER_TYPE=duckdb',
  };

  it.each([
    [
      'enabled with the canvas and the flag on',
      { canvasEnabled: true, dropEnabled: true },
      undefined,
    ],
    [
      'disabled by its flag with the canvas on',
      { canvasEnabled: true, dropEnabled: false },
      {
        reason:
          'Dropping dataframes is turned off in this deployment; staged tables expire on their own TTL.',
        hint: 'ILOSTAT_DATAFRAME_DROP_ENABLED=true',
      },
    ],
    [
      'disabled by the canvas with the flag on',
      { canvasEnabled: false, dropEnabled: true },
      CANVAS_OFF,
    ],
    [
      'disabled by the canvas with the flag off',
      { canvasEnabled: false, dropEnabled: false },
      CANVAS_OFF,
    ],
  ])('is registered %s', (_label, options, disabled) => {
    const definition = buildToolDefinitions(options).find(
      (candidate) => candidate.name === dataframeDropTool.name,
    );
    if (disabled === undefined) {
      expect(definition).toBe(dataframeDropTool);
    } else {
      expect((definition as { __mcpDisabled?: unknown } | undefined)?.__mcpDisabled).toEqual(
        disabled,
      );
    }
  });
});

describe('staged dataframes', () => {
  it('a second drop finds nothing: the first removed the table and its record', async () => {
    const canvas = wireCanvas();
    const ctx = newContext();
    const { name } = await stageObservations(ctx);
    expect(await canvasTables(canvas, ctx)).toContain(name);

    expect(await drop(name, ctx)).toEqual({ name, dropped: true });
    expect(await canvasTables(canvas, ctx)).not.toContain(name);
    expect(await ctx.state.get(`df-meta/${name}`)).toBeNull();

    const again = await drop(name, ctx);
    expect(again).toEqual({ name, dropped: false });
    expect(render(again)).toBe(`${name} was not found (dropped: false).`);
  });

  it('drops a record whose table already left the canvas, freeing its name for register_as', async () => {
    const canvas = wireCanvas();
    const ctx = newContext();
    const { name } = await stageObservations(ctx);
    const instance = await canvas.acquire((await ctx.state.get<string>('canvas-id')) ?? '', ctx);
    expect(await instance.drop(name)).toBe(true);

    expect(await drop(name, ctx)).toEqual({ name, dropped: true });
    expect(await ctx.state.get(`df-meta/${name}`)).toBeNull();

    const reused = await dataframeQueryTool.handler(
      dataframeQueryTool.input.parse({ sql: 'SELECT 42 AS answer', register_as: name }),
      sharingState(
        createMockContext({ tenantId: TENANT, errors: dataframeQueryTool.errors }),
        ctx,
      ) as Parameters<typeof dataframeQueryTool.handler>[1],
    );
    expect(reused).toMatchObject({ registered_as: name, rows: [{ answer: 42 }] });
  });
});

describe('errors', () => {
  it('logs canvas_unavailable, its only declared reason, at error', () => {
    const severities = Object.fromEntries(
      (dataframeDropTool.errors ?? []).map((entry: { reason: string; severity?: string }) => [
        entry.reason,
        entry.severity ?? 'error',
      ]),
    );
    expect(severities).toEqual({ canvas_unavailable: 'error' });
  });

  it('is not canvas_unavailable without a wired canvas: the tool is unlisted then, so reaching it is a server bug', async () => {
    wireDataframes();
    const error = await drop('df_GONE0_GONE0', newContext()).then(
      () => {
        throw new Error('expected the handler to fail');
      },
      (thrown: unknown) => thrown as McpError,
    );
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(JsonRpcErrorCode.InternalError);
    expect(error.message).toBe(NO_CANVAS_MESSAGE);
    expect(error.data?.reason).toBeUndefined();
  });

  it('fails canvas_unavailable on both surfaces when the DuckDB engine cannot load', async () => {
    const engineError = new McpError(
      JsonRpcErrorCode.ConfigurationError,
      'The DuckDB native binding could not be loaded.',
    );
    wireCanvas(faultyCanvas({ at: 'acquire', error: engineError }));
    const error = await drop('df_GONE0_GONE0', newContext()).then(
      () => {
        throw new Error('expected the handler to fail');
      },
      (thrown: unknown) => thrown as McpError,
    );
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toEqual({
      reason: 'canvas_unavailable',
      recovery: { hint: CANVAS_UNAVAILABLE_RECOVERY },
    });
    expect(error.cause).toBe(engineError);

    const result = await runToolContract(dataframeDropTool, { name: 'df_GONE0_GONE0' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: CANVAS_UNAVAILABLE_MESSAGE,
        data: { reason: 'canvas_unavailable', recovery: { hint: CANVAS_UNAVAILABLE_RECOVERY } },
      },
    });
    const text = contentText(result);
    expect(text).toContain(CANVAS_UNAVAILABLE_MESSAGE);
    expect(text).toContain(`Recovery: ${CANVAS_UNAVAILABLE_RECOVERY}`);
  });
});
