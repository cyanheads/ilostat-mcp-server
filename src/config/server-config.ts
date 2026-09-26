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
    .max(2_000_000)
    .default(500_000)
    .describe(
      'Ceiling on the rows one query may return or stage (1,000–2,000,000). An unfiltered request estimated above it is refused before any upstream call; a filtered one that streams past it is refused and its partial dataframe dropped.',
    ),
  previewChars: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(40_000)
    .describe(
      'Inline preview budget in serialized characters (about 10k tokens at the default); a larger result is staged as a dataframe.',
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
