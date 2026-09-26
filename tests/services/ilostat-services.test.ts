/**
 * @fileoverview Tests for the ILOSTAT service wiring: the accessor refuses before
 * `initIlostatServices()` and after disposal, injected clients and clock reach the
 * services built around them, the default clients identify themselves with the
 * server's User-Agent, and disposal releases both pacers.
 * @module tests/services/ilostat-services.test
 */

import { config } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogService } from '@/services/catalog/catalog-service.js';
import {
  disposeIlostatServices,
  getIlostatServices,
  initIlostatServices,
} from '@/services/ilostat-services.js';
import { RplumberClient } from '@/services/rplumber/rplumber-client.js';
import { SdmxClient } from '@/services/sdmx/sdmx-client.js';
import {
  callUrls,
  catalogRoutes,
  clientOptions,
  isRplumber,
  isStructureRequest,
  loadCatalogFixture,
  rplumberBody,
  sdmxFixtureRoutes,
} from '../helpers/ilostat-upstream.js';
import { guardNetwork } from '../helpers/network-guard.js';

guardNetwork();

afterEach(() => {
  disposeIlostatServices();
});

const NOT_INITIALIZED = 'ILOSTAT services not initialized — call initIlostatServices() in setup()';

describe('ILOSTAT service wiring', () => {
  it('refuses access before initialization and after disposal', () => {
    expect(() => getIlostatServices()).toThrow(NOT_INITIALIZED);
    initIlostatServices({
      catalog: new CatalogService({
        rplumber: new RplumberClient(clientOptions(createFetchMock().fetch)),
        refreshIntervalMs: 0,
      }),
    });
    expect(getIlostatServices()).toBeDefined();
    disposeIlostatServices();
    expect(() => getIlostatServices()).toThrow(NOT_INITIALIZED);
    expect(() => disposeIlostatServices()).not.toThrow();
  });

  it('hands out the injected clients and builds the structure service on the injected SDMX client', async () => {
    const http = createFetchMock([...catalogRoutes(loadCatalogFixture()), ...sdmxFixtureRoutes()]);
    const rplumber = new RplumberClient(clientOptions(http.fetch));
    const sdmx = new SdmxClient(clientOptions(http.fetch));
    const catalog = new CatalogService({ rplumber, refreshIntervalMs: 0 });
    const services = initIlostatServices({ rplumber, sdmx, catalog });
    expect(getIlostatServices()).toBe(services);
    expect(services).toMatchObject({ rplumber, sdmx, catalog });

    const lookup = await services.structure.lookup(
      'UNE_DEAP_SEX_AGE_RT',
      '2026-09-24T07:11:06',
      createMockContext(),
    );
    expect(lookup.status).toBe('complete');
    expect(callUrls(http, (request) => isStructureRequest(request))).toHaveLength(1);
  });

  it('builds a catalog on the injected client and clock when none is given', async () => {
    const http = createFetchMock(catalogRoutes(loadCatalogFixture()));
    const services = initIlostatServices({
      rplumber: new RplumberClient(clientOptions(http.fetch)),
      sdmx: new SdmxClient(clientOptions(http.fetch)),
      now: () => new Date('2030-01-02T03:04:05Z'),
      refreshIntervalMs: 0,
    });
    const snapshot = await services.catalog.ready(createMockContext());
    expect(snapshot.asOf).toBe('2030-01-02T03:04:05.000Z');
    expect(
      callUrls(http, (request) => isRplumber(request, '/metadata/toc/indicator')),
    ).toHaveLength(1);
  });

  it('identifies default clients with the server User-Agent and Accept-Language en', async () => {
    const upstream = createFetchMock([
      {
        match: (request) => isRplumber(request, '/metadata/dic'),
        respond: () => rplumberBody([{ sex: 'SEX_T', 'sex.label': 'Total' }]),
      },
    ]);
    upstream.install();
    try {
      const services = initIlostatServices({ refreshIntervalMs: 0 });
      await services.rplumber.getDictionary(
        'sex',
        requestContextService.createRequestContext({ operation: 'test' }),
      );
    } finally {
      upstream.restore();
    }
    const headers = upstream.calls[0]?.request.headers;
    expect(headers?.get('user-agent')).toBe(
      `ilostat-mcp-server/${config.mcpServerVersion} (+https://github.com/cyanheads/ilostat-mcp-server)`,
    );
    expect(headers?.get('accept-language')).toBe('en');
  });

  it('disposal releases both pacers', async () => {
    const http = createFetchMock([...catalogRoutes(loadCatalogFixture()), ...sdmxFixtureRoutes()]);
    const services = initIlostatServices({
      rplumber: new RplumberClient(clientOptions(http.fetch)),
      sdmx: new SdmxClient(clientOptions(http.fetch)),
      refreshIntervalMs: 0,
    });
    disposeIlostatServices();
    const scope = requestContextService.createRequestContext({ operation: 'test' });
    await expect(services.rplumber.getDictionary('sex', scope)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
    await expect(
      services.sdmx.getDataflowStructure('UNE_DEAP_SEX_AGE_RT', scope),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
    expect(http.calls).toHaveLength(0);
  });
});
