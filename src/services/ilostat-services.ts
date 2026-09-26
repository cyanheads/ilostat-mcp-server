/**
 * @fileoverview Wiring for the ILOSTAT services: constructed once in `setup()`,
 * read at request time through {@link getIlostatServices}, released in
 * `teardown()`. Every network, canvas, and clock boundary is an injectable
 * option, so the test suite can hand in fakes.
 * @module services/ilostat-services
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { config } from '@cyanheads/mcp-ts-core/config';
import { getServerConfig } from '@/config/server-config.js';
import { type CanvasBridge, initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { CatalogService } from '@/services/catalog/catalog-service.js';
import { ObservationService } from '@/services/observations/observation-service.js';
import { ResponseCache } from '@/services/observations/response-cache.js';
import { ProfileService } from '@/services/profile/profile-service.js';
import { RplumberClient } from '@/services/rplumber/rplumber-client.js';
import { SdmxClient } from '@/services/sdmx/sdmx-client.js';
import { StructureService } from '@/services/structure/structure-service.js';

export interface IlostatServices {
  /** Absent when dataframes are off. */
  bridge?: CanvasBridge;
  catalog: CatalogService;
  observations: ObservationService;
  profiles: ProfileService;
  rplumber: RplumberClient;
  sdmx: SdmxClient;
  structure: StructureService;
}

export interface InitIlostatServicesOptions {
  /** `core.canvas`; `undefined` turns dataframes off. */
  canvas?: DataCanvas | undefined;
  catalog?: CatalogService;
  now?: () => Date;
  /** Defaults to `ILOSTAT_CATALOG_REFRESH_HOURS`. */
  refreshIntervalMs?: number;
  rplumber?: RplumberClient;
  sdmx?: SdmxClient;
}

const HOUR_MS = 3_600_000;

let services: IlostatServices | undefined;

/** Identifying User-Agent sent on every upstream request. */
function userAgent(): string {
  return `ilostat-mcp-server/${config.mcpServerVersion} (+https://github.com/cyanheads/ilostat-mcp-server)`;
}

/** Constructs the services; each option replaces its default. Does not start the catalog load. */
export function initIlostatServices(options: InitIlostatServicesOptions = {}): IlostatServices {
  const serverConfig = getServerConfig();
  const now = options.now ?? (() => new Date());
  const rplumber = options.rplumber ?? new RplumberClient({ userAgent: userAgent() });
  const sdmx = options.sdmx ?? new SdmxClient({ userAgent: userAgent() });
  const catalog =
    options.catalog ??
    new CatalogService({
      rplumber,
      now,
      refreshIntervalMs: options.refreshIntervalMs ?? serverConfig.catalogRefreshHours * HOUR_MS,
    });
  const structure = new StructureService({ sdmx, now });
  const cache = new ResponseCache({ ttlMs: serverConfig.cacheTtlSeconds * 1000, now });
  const bridge = initCanvasBridge(options.canvas, {
    tableTtlMs: serverConfig.datasetTtlSeconds * 1000,
    dropEnabled: serverConfig.dataframeDropEnabled,
    now,
  });
  services = {
    rplumber,
    sdmx,
    catalog,
    structure,
    ...(bridge ? { bridge } : {}),
    observations: new ObservationService({
      rplumber,
      structure,
      catalog,
      cache,
      maxRows: serverConfig.maxRows,
      previewChars: serverConfig.previewChars,
      now,
      ...(bridge ? { bridge } : {}),
    }),
    profiles: new ProfileService({ rplumber, catalog, cache }),
  };
  return services;
}

/** The initialized services. */
export function getIlostatServices(): IlostatServices {
  if (!services) {
    throw new Error('ILOSTAT services not initialized — call initIlostatServices() in setup()');
  }
  return services;
}

/** Stops the refresh timer, cancels in-flight work, and disposes both pacers. */
export function disposeIlostatServices(): void {
  if (!services) return;
  services.catalog.dispose();
  services.structure.dispose();
  services.rplumber.dispose();
  services.sdmx.dispose();
  services = undefined;
}
