/**
 * @fileoverview The in-memory ILOSTAT catalog: both tables of contents and 13
 * dictionaries, loaded without blocking startup and refreshed on a timer.
 * Readiness is single-flight — concurrent callers share one load — and a tool waits
 * for it at most `readyTimeoutMs` before failing `catalog_unavailable` while the
 * load carries on in the background. A failed initial load is retried by the next
 * call, at most once per 15 s. A failed refresh leaves the previous snapshot
 * serving; its `asOf` shows its age.
 * @module services/catalog/catalog-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { type McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { logger, requestContextService, withExtra } from '@cyanheads/mcp-ts-core/utils';
import { type ProjectionCutoff, projectionCutoff } from '@/services/basis/basis.js';
import type { RplumberClient } from '@/services/rplumber/rplumber-client.js';
import {
  DICTIONARY_VARS,
  type DictionaryEntry,
  type DictionaryVar,
} from '@/services/rplumber/types.js';
import type { UpstreamScope } from '@/services/upstream/upstream-http.js';
import { WAIT_TIMEOUT, waitFor } from '@/services/wait.js';
import { buildSnapshot, catalogSignature } from './snapshot.js';
import type { CatalogSnapshot, Indicator } from './types.js';

/** Minimum spacing between load attempts while no snapshot has loaded. */
const RETRY_SPACING_MS = 15_000;

export interface CatalogServiceOptions {
  now?: () => Date;
  /** Longest a tool waits for the first load. Default 30 s. */
  readyTimeoutMs?: number;
  /** Interval between ToC checks; `0` arms no timer. */
  refreshIntervalMs: number;
  rplumber: RplumberClient;
}

export class CatalogService {
  private lastFailureAt: number | undefined;
  private readonly lifetime = new AbortController();
  private loading: Promise<CatalogSnapshot> | undefined;
  private readonly now: () => Date;
  private readonly readyTimeoutMs: number;
  private refreshing: Promise<void> | undefined;
  private snapshot: CatalogSnapshot | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: CatalogServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
  }

  /** Begins the first load without blocking and arms the refresh timer. */
  start(): void {
    this.beginLoad();
    if (this.options.refreshIntervalMs > 0) {
      this.timer = setInterval(() => {
        this.refresh().catch((error: unknown) => {
          if (this.lifetime.signal.aborted) return;
          logger.warning(
            'ILOSTAT catalog refresh failed; the previous snapshot keeps serving.',
            withExtra(this.backgroundScope('ilostat-catalog-refresh'), {
              error: error instanceof Error ? error.message : String(error),
              snapshotAsOf: this.snapshot?.asOf,
            }),
          );
        });
      }, this.options.refreshIntervalMs);
      this.timer.unref?.();
    }
  }

  /** An indicator's projection cutoff under the snapshot's catalog edition and this service's clock. */
  projectionCutoff(indicator: Indicator, snapshot: CatalogSnapshot): ProjectionCutoff {
    return projectionCutoff(
      indicator.edition,
      snapshot.catalogEdition,
      this.now().getUTCFullYear(),
    );
  }

  /** Stops the timer and cancels any in-flight load. */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.lifetime.abort();
  }

  /**
   * The loaded snapshot. Waits for an in-flight load at most `readyTimeoutMs`;
   * throws `catalog_unavailable` when none has loaded in time or the load failed.
   */
  async ready(ctx: Context): Promise<CatalogSnapshot> {
    if (this.snapshot) return this.snapshot;
    const load = this.loading ?? this.beginLoadUnlessRecentFailure();
    if (!load) {
      throw this.unavailable(ctx, 'The ILOSTAT catalog could not be loaded from the upstream API.');
    }
    try {
      return await waitFor(load, { signal: ctx.signal, timeoutMs: this.readyTimeoutMs });
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      if (this.snapshot) return this.snapshot;
      if (error === WAIT_TIMEOUT) {
        throw this.unavailable(
          ctx,
          `The ILOSTAT catalog is still loading from the upstream API after ${this.readyTimeoutMs / 1000} s.`,
        );
      }
      throw this.unavailable(
        ctx,
        'The ILOSTAT catalog could not be loaded from the upstream API.',
        error,
      );
    }
  }

  /**
   * Re-checks both tables of contents; when a dataset was added, removed, or
   * updated, re-fetches the dictionaries and swaps in a new snapshot. With no
   * snapshot yet, runs (or joins) a full load. Rejects on failure, leaving the
   * current snapshot in place.
   */
  refresh(): Promise<void> {
    this.refreshing ??= this.runRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async runRefresh(): Promise<void> {
    const current = this.snapshot;
    if (!current) {
      await (this.loading ?? this.beginLoad());
      return;
    }
    const scope = this.backgroundScope('ilostat-catalog-refresh');
    const [indicatorToc, refAreaToc] = await Promise.all([
      this.options.rplumber.getIndicatorToc(scope),
      this.options.rplumber.getRefAreaToc(scope),
    ]);
    const checkedAt = this.now().toISOString();
    if (catalogSignature(indicatorToc, refAreaToc) === current.signature) {
      this.snapshot = { ...current, asOf: checkedAt };
      return;
    }
    const dictionaries = await this.loadDictionaries(scope);
    this.snapshot = buildSnapshot({ indicatorToc, refAreaToc, dictionaries }, checkedAt);
    logger.info(
      'ILOSTAT catalog refreshed',
      withExtra(scope, {
        datasets: this.snapshot.datasets.size,
        indicators: this.snapshot.indicators.length,
      }),
    );
  }

  private beginLoadUnlessRecentFailure(): Promise<CatalogSnapshot> | undefined {
    if (
      this.lastFailureAt !== undefined &&
      this.now().getTime() - this.lastFailureAt < RETRY_SPACING_MS
    ) {
      return;
    }
    return this.beginLoad();
  }

  private beginLoad(): Promise<CatalogSnapshot> {
    const scope = this.backgroundScope('ilostat-catalog-load');
    const startedAt = Date.now();
    const load = this.load(scope).then(
      (snapshot) => {
        this.snapshot = snapshot;
        this.lastFailureAt = undefined;
        logger.info(
          'ILOSTAT catalog loaded',
          withExtra(scope, {
            datasets: snapshot.datasets.size,
            indicators: snapshot.indicators.length,
            refAreas: snapshot.refAreas.size,
            durationMs: Date.now() - startedAt,
          }),
        );
        return snapshot;
      },
      (error: unknown) => {
        this.lastFailureAt = this.now().getTime();
        if (this.lifetime.signal.aborted) throw error;
        logger.warning(
          'ILOSTAT catalog load failed',
          withExtra(scope, { error: error instanceof Error ? error.message : String(error) }),
        );
        throw error;
      },
    );
    this.loading = load;
    load
      .finally(() => {
        if (this.loading === load) this.loading = undefined;
      })
      .catch(() => undefined);
    return load;
  }

  private async load(scope: UpstreamScope): Promise<CatalogSnapshot> {
    const [indicatorToc, refAreaToc, dictionaries] = await Promise.all([
      this.options.rplumber.getIndicatorToc(scope),
      this.options.rplumber.getRefAreaToc(scope),
      this.loadDictionaries(scope),
    ]);
    return buildSnapshot({ indicatorToc, refAreaToc, dictionaries }, this.now().toISOString());
  }

  private async loadDictionaries(
    scope: UpstreamScope,
  ): Promise<Record<DictionaryVar, DictionaryEntry[]>> {
    const entries = await Promise.all(
      DICTIONARY_VARS.map(
        async (dictionary) =>
          [dictionary, await this.options.rplumber.getDictionary(dictionary, scope)] as const,
      ),
    );
    return Object.fromEntries(entries) as Record<DictionaryVar, DictionaryEntry[]>;
  }

  private backgroundScope(operation: string): UpstreamScope {
    return {
      ...requestContextService.createRequestContext({ operation }),
      signal: this.lifetime.signal,
    };
  }

  private unavailable(ctx: Context, message: string, cause?: unknown): McpError {
    return serviceUnavailable(
      message,
      { reason: 'catalog_unavailable', retryable: true, ...ctx.recoveryFor('catalog_unavailable') },
      cause === undefined ? undefined : { cause },
    );
  }
}
