/**
 * @fileoverview Tests for the `src/index.ts` entry point: `createApp()` is captured
 * instead of started, and `./.env` is never read (`process.loadEnvFile` is stubbed
 * in every test). The identity is `name` + `title`, both `ilostat-mcp-server`. For
 * each `CANVAS_PROVIDER_TYPE` value the entry point receives, the tool list and
 * the server instructions it passes must agree on whether dataframes are on —
 * unset and blank default to DuckDB, `none` turns them off. `.env` is loaded
 * before either gate is read, a missing file is ignored and any other read
 * failure stops startup, and `setup`/`teardown` wire and release the services.
 * @module tests/index.test
 */

import type { CoreServices, CreateAppOptions } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
/*
 * Loaded at collection, outside any test's timeout. The first import of this
 * graph (the framework barrel plus every tool, service, and config module the
 * entry point reaches) costs about 1.2 s on an idle machine and passed the 5 s
 * test timeout under a loaded parallel run; once loaded, an `import('@/index.js')`
 * after `vi.resetModules()` re-evaluates only the server's own modules, in ~15 ms.
 */
import '@/config/server-config.js';
import '@/mcp-server/server-instructions.js';
import '@/mcp-server/tools/definitions/index.js';
import '@/services/ilostat-services.js';
import { guardNetwork } from './helpers/network-guard.js';

guardNetwork();

const captured = vi.hoisted(() => ({ options: undefined as CreateAppOptions | undefined }));

vi.mock('@cyanheads/mcp-ts-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core')>()),
  createApp: vi.fn(async (options: CreateAppOptions) => {
    captured.options = options;
    return {};
  }),
}));

const ENV_KEYS = ['CANVAS_PROVIDER_TYPE', 'ILOSTAT_DATAFRAME_DROP_ENABLED'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

/** A `process.loadEnvFile` failure carrying a filesystem error code. */
function envFileError(code: string): Error {
  return Object.assign(new Error(`${code}: cannot open .env`), { code });
}

beforeEach(() => {
  captured.options = undefined;
  for (const key of ENV_KEYS) delete process.env[key];
  vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
    throw envFileError('ENOENT');
  });
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Runs the entry point under `canvasProviderType` and returns what it handed `createApp()`, with the builders it used. */
async function boot(canvasProviderType?: string) {
  if (canvasProviderType !== undefined) process.env.CANVAS_PROVIDER_TYPE = canvasProviderType;
  await import('@/index.js');
  const { buildToolDefinitions } = await import('@/mcp-server/tools/definitions/index.js');
  const { buildInstructions } = await import('@/mcp-server/server-instructions.js');
  if (!captured.options) throw new Error('src/index.ts did not call createApp()');
  return { options: captured.options, buildToolDefinitions, buildInstructions };
}

describe('src/index.ts', () => {
  it('hands createApp() the identity (name and title, both ilostat-mcp-server) and nothing more', async () => {
    const { options } = await boot();
    expect(Object.keys(options).sort()).toEqual(
      [
        'instructions',
        'name',
        'prompts',
        'resources',
        'sessionMode',
        'setup',
        'teardown',
        'title',
        'tools',
      ].sort(),
    );
    expect(options).toMatchObject({
      name: 'ilostat-mcp-server',
      title: 'ilostat-mcp-server',
      resources: [],
      prompts: [],
      sessionMode: 'stateless',
    });
  });

  it.each([
    ['unset', undefined, true],
    ['blank', '', true],
    ['duckdb', 'duckdb', true],
    ['none', 'none', false],
  ] as const)(
    'CANVAS_PROVIDER_TYPE %s (%o): tools and instructions both built with canvasEnabled %s',
    async (_label, value, canvasEnabled) => {
      const { options, buildToolDefinitions, buildInstructions } = await boot(value);
      expect(options.tools).toEqual(buildToolDefinitions({ canvasEnabled, dropEnabled: false }));
      expect(options.tools).not.toEqual(
        buildToolDefinitions({ canvasEnabled: !canvasEnabled, dropEnabled: false }),
      );
      expect(options.instructions).toBe(buildInstructions({ canvasEnabled }));
      expect(options.instructions?.includes('ilostat_dataframe_describe')).toBe(canvasEnabled);
    },
  );

  it('passes the drop flag through when it is on', async () => {
    process.env.ILOSTAT_DATAFRAME_DROP_ENABLED = 'true';
    const { options, buildToolDefinitions } = await boot();
    expect(options.tools).toEqual(buildToolDefinitions({ canvasEnabled: true, dropEnabled: true }));
  });
});

describe('.env', () => {
  it.each([
    [
      'the drop flag',
      { ILOSTAT_DATAFRAME_DROP_ENABLED: 'true' },
      { canvasEnabled: true, dropEnabled: true },
    ],
    [
      'the canvas switch',
      { CANVAS_PROVIDER_TYPE: 'none' },
      { canvasEnabled: false, dropEnabled: false },
    ],
  ])(
    'is loaded before the gates are read, so %s it sets takes effect',
    async (_label, vars, gates) => {
      vi.mocked(process.loadEnvFile).mockImplementation(() => {
        Object.assign(process.env, vars);
      });
      const { options, buildToolDefinitions, buildInstructions } = await boot();
      expect(process.loadEnvFile).toHaveBeenCalledOnce();
      expect(options.tools).toEqual(buildToolDefinitions(gates));
      expect(options.instructions).toBe(buildInstructions({ canvasEnabled: gates.canvasEnabled }));
    },
  );

  it('stops startup when the file exists but cannot be read, before createApp() runs', async () => {
    vi.mocked(process.loadEnvFile).mockImplementation(() => {
      throw envFileError('EACCES');
    });
    await expect(import('@/index.js')).rejects.toMatchObject({ code: 'EACCES' });
    expect(captured.options).toBeUndefined();
  });
});

describe('setup and teardown', () => {
  it.each([
    ['a canvas', {} as DataCanvas, true],
    ['no canvas', undefined, false],
  ] as const)(
    'setup(core) with %s wires the services and the bridge to match, then starts the catalog; teardown releases them',
    async (_label, canvas, bridged) => {
      const { options } = await boot();
      const { CatalogService } = await import('@/services/catalog/catalog-service.js');
      const { getIlostatServices } = await import('@/services/ilostat-services.js');
      const { getCanvasBridge } = await import('@/services/canvas-bridge/canvas-bridge.js');
      const start = vi.spyOn(CatalogService.prototype, 'start').mockImplementation(() => undefined);

      await options.setup?.({ canvas } as unknown as CoreServices);
      expect(start).toHaveBeenCalledOnce();
      expect(getIlostatServices().bridge !== undefined).toBe(bridged);
      expect(getCanvasBridge() !== undefined).toBe(bridged);

      await options.teardown?.({} as CoreServices);
      expect(() => getIlostatServices()).toThrow('ILOSTAT services not initialized');
    },
  );
});
