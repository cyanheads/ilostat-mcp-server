/**
 * @fileoverview Per-indicator SDMX structure, cached. Entries are keyed by
 * indicator and its ToC `last.update`, so a dataset update evicts its structure on
 * the next lookup; an LRU of 500 entries with a 24 h ceiling bounds the rest.
 * Concurrent lookups of one indicator share one fetch, which runs detached from any
 * single caller's cancellation. SDMX failures degrade to `unavailable` rather than
 * failing the caller. Definitive answers — a structure, or SDMX saying it has no
 * such dataflow — are cached for the full TTL; a failed lookup is remembered for
 * {@link FAILURE_TTL_MS}, so calls during an SDMX outage degrade at once instead of
 * each waiting out the lookup's retries. A shutdown is never remembered.
 * @module services/structure/structure-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { logger, requestContextService, withExtra } from '@cyanheads/mcp-ts-core/utils';
import type { SdmxClient } from '@/services/sdmx/sdmx-client.js';
import type { UpstreamScope } from '@/services/upstream/upstream-http.js';
import { waitFor } from '@/services/wait.js';
import { type IndicatorStructure, parseStructure } from './sdmx-structure.js';

export interface StructureLookup {
  /** `unavailable` when SDMX has no dataflow for the indicator or could not be reached. */
  status: 'complete' | 'unavailable';
  structure?: IndicatorStructure;
}

export interface StructureServiceOptions {
  maxEntries?: number;
  now?: () => Date;
  sdmx: SdmxClient;
  ttlMs?: number;
}

interface CacheEntry {
  expiresAt: number;
  lastUpdate: string;
  value: StructureLookup;
}

interface FetchOutcome {
  /** Whether SDMX answered; a failed lookup is remembered only for {@link FAILURE_TTL_MS}. */
  definitive: boolean;
  value: StructureLookup;
}

/** How long a definitive answer is cached, unless `ttlMs` overrides it. */
const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a failed lookup is remembered: short, so a recovered SDMX is picked up within a minute. */
const FAILURE_TTL_MS = 60_000;

const UNAVAILABLE: StructureLookup = { status: 'unavailable' };

export class StructureService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<FetchOutcome>>();
  private readonly lifetime = new AbortController();
  private readonly maxEntries: number;
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(private readonly options: StructureServiceOptions) {
    this.maxEntries = options.maxEntries ?? 500;
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? SUCCESS_TTL_MS;
  }

  /** Cancels in-flight fetches. */
  dispose(): void {
    this.lifetime.abort();
  }

  /** The structure of `indicator` as of its ToC `lastUpdate`. */
  async lookup(indicator: string, lastUpdate: string, ctx: Context): Promise<StructureLookup> {
    const cached = this.cache.get(indicator);
    if (cached && cached.lastUpdate === lastUpdate && this.now().getTime() < cached.expiresAt) {
      this.cache.delete(indicator);
      this.cache.set(indicator, cached);
      return cached.value;
    }

    const flightKey = `${indicator}|${lastUpdate}`;
    let flight = this.inFlight.get(flightKey);
    if (!flight) {
      // A shutdown rejects here and is never stored; the caller's cancellation never reaches the fetch.
      flight = this.fetch(indicator).then((outcome) => {
        this.store(
          indicator,
          lastUpdate,
          outcome.value,
          outcome.definitive ? this.ttlMs : FAILURE_TTL_MS,
        );
        return outcome;
      });
      this.inFlight.set(flightKey, flight);
      flight.finally(() => this.inFlight.delete(flightKey)).catch(() => undefined);
    }
    return (await waitFor(flight, { signal: ctx.signal })).value;
  }

  private store(
    indicator: string,
    lastUpdate: string,
    value: StructureLookup,
    ttlMs: number,
  ): void {
    this.cache.delete(indicator);
    this.cache.set(indicator, { lastUpdate, expiresAt: this.now().getTime() + ttlMs, value });
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async fetch(indicator: string): Promise<FetchOutcome> {
    const scope: UpstreamScope = {
      ...requestContextService.createRequestContext({ operation: 'ilostat-structure-lookup' }),
      signal: this.lifetime.signal,
    };
    try {
      const document = await this.options.sdmx.getDataflowStructure(indicator, scope);
      if (document === undefined) return { value: UNAVAILABLE, definitive: true };
      return {
        value: { status: 'complete', structure: parseStructure(document) },
        definitive: true,
      };
    } catch (error) {
      // A shutdown abort reaches the waiting callers; any other failure degrades the lookup.
      if (this.lifetime.signal.aborted) throw error;
      logger.warning(
        'ILOSTAT SDMX structure lookup failed; the tools fall back to catalog metadata.',
        withExtra(scope, {
          indicator,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return { value: UNAVAILABLE, definitive: false };
    }
  }
}
