/**
 * @fileoverview Per-indicator SDMX structure and unit, cached. Entries are keyed by
 * indicator and its ToC `last.update`, so a dataset update evicts its structure on
 * the next lookup; an LRU of 500 entries with a 24 h ceiling bounds the rest.
 * Concurrent lookups of one indicator share one fetch, which runs detached from any
 * single caller's cancellation. SDMX failures degrade to `unavailable` rather than
 * failing the caller; only definitive answers — a structure, or SDMX saying it has
 * no such dataflow — are cached.
 * @module services/structure/structure-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { logger, requestContextService, withExtra } from '@cyanheads/mcp-ts-core/utils';
import type { SdmxClient } from '@/services/sdmx/sdmx-client.js';
import type { UpstreamScope } from '@/services/upstream/upstream-http.js';
import { waitFor } from '@/services/wait.js';
import {
  type IndicatorStructure,
  parseStructure,
  probeKey,
  type UnitInfo,
  unitFromRow,
} from './sdmx-structure.js';

/** Areas the unit probe tries, in content-constraint order, before giving up. */
const PROBE_AREAS = 3;

export interface StructureLookup {
  /** `unavailable` when SDMX has no dataflow for the indicator or could not be reached. */
  status: 'complete' | 'unavailable';
  structure?: IndicatorStructure;
  /** Absent when no probed area returned unit attributes. */
  unit?: UnitInfo;
}

export interface StructureServiceOptions {
  maxEntries?: number;
  now?: () => Date;
  sdmx: SdmxClient;
  ttlMs?: number;
}

interface CacheEntry {
  lastUpdate: string;
  storedAt: number;
  value: StructureLookup;
}

interface FetchOutcome {
  cacheable: boolean;
  value: StructureLookup;
}

const UNAVAILABLE: StructureLookup = { status: 'unavailable' };

/** An error that must reach the caller rather than degrade: this server's own bug. */
const isServerFault = (error: unknown): boolean =>
  error instanceof McpError && error.code === JsonRpcErrorCode.InternalError;

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
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  }

  /** Cancels in-flight fetches. */
  dispose(): void {
    this.lifetime.abort();
  }

  /** Structure and unit for `indicator` as of its ToC `lastUpdate`. */
  async lookup(indicator: string, lastUpdate: string, ctx: Context): Promise<StructureLookup> {
    const cached = this.cache.get(indicator);
    if (
      cached &&
      cached.lastUpdate === lastUpdate &&
      this.now().getTime() - cached.storedAt < this.ttlMs
    ) {
      this.cache.delete(indicator);
      this.cache.set(indicator, cached);
      return cached.value;
    }

    const flightKey = `${indicator}|${lastUpdate}`;
    let flight = this.inFlight.get(flightKey);
    if (!flight) {
      flight = this.fetch(indicator).then((outcome) => {
        if (outcome.cacheable) this.store(indicator, lastUpdate, outcome.value);
        return outcome;
      });
      this.inFlight.set(flightKey, flight);
      flight.finally(() => this.inFlight.delete(flightKey)).catch(() => undefined);
    }
    return (await waitFor(flight, { signal: ctx.signal })).value;
  }

  private store(indicator: string, lastUpdate: string, value: StructureLookup): void {
    this.cache.delete(indicator);
    this.cache.set(indicator, { lastUpdate, storedAt: this.now().getTime(), value });
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
    /** Rethrows this server's own faults and shutdown aborts; logs anything else as a degraded lookup. */
    const noteFailure = (stage: string, error: unknown): void => {
      if (isServerFault(error) || this.lifetime.signal.aborted) throw error;
      logger.warning(
        `ILOSTAT SDMX ${stage} failed; describe falls back to catalog metadata.`,
        withExtra(scope, {
          indicator,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    };

    let structure: IndicatorStructure;
    try {
      const document = await this.options.sdmx.getDataflowStructure(indicator, scope);
      if (document === undefined) return { value: UNAVAILABLE, cacheable: true };
      structure = parseStructure(document);
    } catch (error) {
      noteFailure('structure lookup', error);
      return { value: UNAVAILABLE, cacheable: false };
    }

    for (const area of structure.refAreas.slice(0, PROBE_AREAS)) {
      let row: Record<string, string> | undefined;
      try {
        row = await this.options.sdmx.probeSeries(
          indicator,
          structure.version,
          probeKey(structure, area),
          scope,
        );
      } catch (error) {
        noteFailure('unit probe', error);
        return { value: { status: 'complete', structure }, cacheable: false };
      }
      if (!row) continue;
      const unit = unitFromRow(row, structure.unitCodelists);
      return {
        value: { status: 'complete', structure, ...(unit ? { unit } : {}) },
        cacheable: true,
      };
    }
    return { value: { status: 'complete', structure }, cacheable: true };
  }
}
