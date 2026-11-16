/**
 * @fileoverview Server-specific configuration for ilostat-mcp-server, parsed lazily
 * from the environment through `parseEnvConfig` so validation errors name the
 * offending variable.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  catalogRefreshHours: z.coerce
    .number()
    .int()
    .min(1)
    .max(168)
    .default(6)
    .describe(
      'Hours between checks of the ILOSTAT tables of contents (1–168). The dictionaries are re-fetched only when a dataset was added, removed, or updated.',
    ),
  maxRows: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(1_000_000, 'At most 1,000,000, the staged rows one tenant may hold.')
    .default(500_000)
    .describe(
      'Ceiling on the rows one query reads or stages (1,000–1,000,000, the per-tenant staging row budget). An unfiltered request estimated above it is refused before any upstream call; a filtered result past it is paged but not staged, its partial dataframe dropped, and a page reaching past it is refused.',
    ),
  previewChars: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(40_000)
    .describe(
      'Staging trigger in serialized characters (about 10k tokens at the default). A query or comparison whose first page finds its result past it is staged as a dataframe; their pages are bounded by limit, not by it. A dataframe SQL result returns only the leading rows that fit.',
    ),
  cacheTtlSeconds: z.coerce
    .number()
    .int()
    .min(0)
    .default(900)
    .describe(
      'Seconds an upstream data response of up to 5,000 rows stays cached (0 disables the cache).',
    ),
  datasetTtlSeconds: z.coerce
    .number()
    .int()
    .min(60)
    .default(86_400)
    .describe('Per-table TTL for staged dataframes, in seconds (at least 60).'),
  dataframeDropEnabled: z
    .stringbool()
    .default(false)
    .describe(
      'Exposes ilostat_dataframe_drop. Off by default: staged dataframes expire on their own TTL, and drop is the only destructive tool.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Parsed server configuration; parsed once on first call. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    catalogRefreshHours: 'ILOSTAT_CATALOG_REFRESH_HOURS',
    maxRows: 'ILOSTAT_MAX_ROWS',
    previewChars: 'ILOSTAT_PREVIEW_CHARS',
    cacheTtlSeconds: 'ILOSTAT_CACHE_TTL_SECONDS',
    datasetTtlSeconds: 'ILOSTAT_DATASET_TTL_SECONDS',
    dataframeDropEnabled: 'ILOSTAT_DATAFRAME_DROP_ENABLED',
  });
  return _config;
}
