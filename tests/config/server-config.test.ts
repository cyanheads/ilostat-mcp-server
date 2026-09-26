/**
 * @fileoverview Tests for the server configuration parsed from the environment:
 * `ILOSTAT_CATALOG_REFRESH_HOURS` defaults to 6, reads a blank value (as a bundle
 * form sends one) as unset, and rejects values outside 1–168 hours with an error
 * that names the variable.
 * @module tests/config/server-config.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardNetwork } from '../helpers/network-guard.js';

guardNetwork();

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A fresh module instance, since the parsed config is cached per module. */
async function loadConfig(value: string | undefined) {
  vi.resetModules();
  vi.stubEnv('ILOSTAT_CATALOG_REFRESH_HOURS', value);
  const { getServerConfig } = await import('@/config/server-config.js');
  return getServerConfig;
}

describe('getServerConfig', () => {
  it('defaults the catalog refresh interval to 6 hours', async () => {
    expect((await loadConfig(undefined))().catalogRefreshHours).toBe(6);
  });

  it('reads a blank value as unset', async () => {
    expect((await loadConfig(''))().catalogRefreshHours).toBe(6);
  });

  it('accepts the bounds and coerces the string', async () => {
    expect((await loadConfig('1'))().catalogRefreshHours).toBe(1);
    expect((await loadConfig('168'))().catalogRefreshHours).toBe(168);
  });

  it.each(['0', '169', '1.5', 'daily'])(
    'rejects %j with a ConfigurationError naming the variable',
    async (value) => {
      const getServerConfig = await loadConfig(value);
      expect(getServerConfig).toThrow(
        expect.objectContaining({
          code: JsonRpcErrorCode.ConfigurationError,
          message: expect.stringContaining('ILOSTAT_CATALOG_REFRESH_HOURS'),
        }),
      );
    },
  );

  it('parses once and serves the cached value after the environment changes', async () => {
    const getServerConfig = await loadConfig('12');
    expect(getServerConfig().catalogRefreshHours).toBe(12);
    vi.stubEnv('ILOSTAT_CATALOG_REFRESH_HOURS', '24');
    expect(getServerConfig().catalogRefreshHours).toBe(12);
  });
});
