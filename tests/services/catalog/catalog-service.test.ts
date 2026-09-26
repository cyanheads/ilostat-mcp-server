/**
 * @fileoverview Tests for the in-memory catalog lifecycle over a fetch fake: the
 * single-flight load, the readiness bound that fails `catalog_unavailable` while
 * the load carries on, the 15 s spacing between failed initial loads, refresh
 * (re-stamp when unchanged, rebuild when a `last.update` moved, stale-while-error
 * when it fails), the refresh timer, disposal, and the injected clock.
 * @module tests/services/catalog/catalog-service.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogService } from '@/services/catalog/catalog-service.js';
import { RplumberClient } from '@/services/rplumber/rplumber-client.js';
import type { FetchFn } from '@/services/upstream/upstream-http.js';
import {
  CATALOG_UNAVAILABLE_RECOVERY,
  type CatalogFixture,
  callUrls,
  catalogRoutes,
  clientOptions,
  FAST_PACING,
  hangingFetch,
  isRplumber,
  loadCatalogFixture,
  tocRow,
} from '../../helpers/ilostat-upstream.js';
import { guardNetwork } from '../../helpers/network-guard.js';

guardNetwork();

const CONTRACT = [
  {
    reason: 'catalog_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'The catalog could not be loaded in time.',
    recovery: CATALOG_UNAVAILABLE_RECOVERY,
    retryable: true,
  },
] as const;

const contractCtx = (signal?: AbortSignal) =>
  createMockContext({ errors: CONTRACT, ...(signal ? { signal } : {}) });

/** A clock tests move by hand. */
function manualClock(start = '2026-09-26T12:00:00Z') {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

const services: { dispose(): void }[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
});

interface Setup {
  fetch?: FetchFn;
  fixture?: CatalogFixture;
  now?: () => Date;
  readyTimeoutMs?: number;
  refreshIntervalMs?: number;
}

function setup(options: Setup = {}) {
  const fixture = options.fixture ?? loadCatalogFixture();
  const http = createFetchMock(catalogRoutes(fixture));
  const rplumber = new RplumberClient(clientOptions(options.fetch ?? http.fetch));
  const catalog = new CatalogService({
    rplumber,
    refreshIntervalMs: options.refreshIntervalMs ?? 0,
    ...(options.now ? { now: options.now } : {}),
    ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }),
  });
  services.push(catalog, rplumber);
  const tocCalls = () =>
    callUrls(http, (request) => isRplumber(request, '/metadata/toc/indicator')).length;
  const dictionaryCalls = () =>
    callUrls(http, (request) => isRplumber(request, '/metadata/dic')).length;
  return { catalog, fixture, http, tocCalls, dictionaryCalls };
}

/** Holds every request until `release()`, then passes it to `inner`. */
function gatedFetch(inner: FetchFn) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch: FetchFn = (input, init) => gate.then(() => inner(input, init));
  return { fetch, release };
}

async function rejection(promise: Promise<unknown>): Promise<McpError> {
  return (await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  )) as McpError;
}

describe('CatalogService readiness', () => {
  it('loads both ToCs and all 13 dictionaries on first use, stamped with the clock', async () => {
    const clock = manualClock();
    const { catalog, http } = setup({ now: clock.now });
    const snapshot = await catalog.ready(contractCtx());
    expect(snapshot.asOf).toBe('2026-09-26T12:00:00.000Z');
    expect(snapshot.indicators.length).toBeGreaterThan(0);
    expect(http.calls).toHaveLength(15);
    await expect(catalog.ready(contractCtx())).resolves.toBe(snapshot);
    expect(http.calls).toHaveLength(15);
  });

  it('shares one load between concurrent callers and with start()', async () => {
    const { catalog, http } = setup();
    catalog.start();
    const [a, b, c] = await Promise.all([
      catalog.ready(contractCtx()),
      catalog.ready(contractCtx()),
      catalog.ready(contractCtx()),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(http.calls).toHaveLength(15);
  });

  it('fails catalog_unavailable past readyTimeoutMs while the load carries on', async () => {
    const fixture = loadCatalogFixture();
    const inner = createFetchMock(catalogRoutes(fixture));
    const gated = gatedFetch(inner.fetch);
    const { catalog } = setup({ fetch: gated.fetch, fixture, readyTimeoutMs: 30 });

    const error = await rejection(catalog.ready(contractCtx()));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'catalog_unavailable',
      retryable: true,
      recovery: { hint: CATALOG_UNAVAILABLE_RECOVERY },
    });
    expect(error.message).toBe(
      'The ILOSTAT catalog is still loading from the upstream API after 0.03 s.',
    );

    gated.release();
    await expect(catalog.ready(contractCtx())).resolves.toMatchObject({
      indicators: expect.any(Array),
    });
    expect(inner.calls).toHaveLength(15);
  });

  it('fails catalog_unavailable against an upstream that never answers', async () => {
    const upstream = hangingFetch();
    const { catalog } = setup({ fetch: upstream.fetch, readyTimeoutMs: 20 });
    const error = await rejection(catalog.ready(contractCtx()));
    expect(error.data?.reason).toBe('catalog_unavailable');
    // the pacer holds the rest of the load behind its concurrency cap
    expect(upstream.urls).toHaveLength(FAST_PACING.maxConcurrent);
  });

  it('rejects with the abort reason, not catalog_unavailable, when the caller cancels', async () => {
    const fixture = loadCatalogFixture();
    const inner = createFetchMock(catalogRoutes(fixture));
    const gated = gatedFetch(inner.fetch);
    const { catalog } = setup({ fetch: gated.fetch, fixture });
    const controller = new AbortController();
    const waiting = catalog.ready(contractCtx(controller.signal));
    controller.abort(new Error('client went away'));
    await expect(waiting).rejects.toThrow('client went away');
    gated.release();
    await expect(catalog.ready(contractCtx())).resolves.toBeDefined();
  });

  it('fails catalog_unavailable with the cause when the load fails, retrying at most every 15 s', async () => {
    const clock = manualClock();
    const fixture = loadCatalogFixture();
    let upstreamDown = true;
    const healthy = createFetchMock(catalogRoutes(fixture));
    const calls: string[] = [];
    const fetch: FetchFn = (input, init) => {
      calls.push(input);
      return upstreamDown
        ? Promise.resolve(new Response('unavailable', { status: 503 }))
        : healthy.fetch(input, init);
    };
    const { catalog } = setup({ fetch, fixture, now: clock.now });

    const first = await rejection(catalog.ready(contractCtx()));
    expect(first.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(first.data).toMatchObject({
      reason: 'catalog_unavailable',
      recovery: { hint: CATALOG_UNAVAILABLE_RECOVERY },
    });
    expect(first.message).toBe('The ILOSTAT catalog could not be loaded from the upstream API.');
    expect((first.cause as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    const attempted = calls.length;

    upstreamDown = false;
    clock.advance(14_999);
    const spaced = await rejection(catalog.ready(contractCtx()));
    expect(spaced.data?.reason).toBe('catalog_unavailable');
    expect(calls).toHaveLength(attempted);

    clock.advance(1);
    await expect(catalog.ready(contractCtx())).resolves.toBeDefined();
    expect(calls.length).toBeGreaterThan(attempted);
  });
});

describe('CatalogService refresh', () => {
  it('re-stamps catalog_as_of without re-fetching dictionaries when nothing changed', async () => {
    const clock = manualClock();
    const { catalog, tocCalls, dictionaryCalls } = setup({ now: clock.now });
    const loaded = await catalog.ready(contractCtx());
    clock.advance(3_600_000);
    await catalog.refresh();
    const refreshed = await catalog.ready(contractCtx());
    expect(refreshed.asOf).toBe('2026-09-26T13:00:00.000Z');
    expect(refreshed.indicators).toBe(loaded.indicators);
    expect(tocCalls()).toBe(2);
    expect(dictionaryCalls()).toBe(13);
  });

  it('rebuilds from fresh dictionaries when a dataset was added or updated', async () => {
    const { catalog, fixture, dictionaryCalls } = setup();
    await catalog.ready(contractCtx());
    fixture.indicatorToc.push({
      ...tocRow(fixture, 'UNE_DEAP_SEX_EDU_RT_A'),
      id: 'UNE_DEAP_SEX_EDU_RT_Q',
      freq: 'Q',
      'freq.label': 'Quarterly',
    });
    await catalog.refresh();
    const refreshed = await catalog.ready(contractCtx());
    expect(refreshed.datasets.has('UNE_DEAP_SEX_EDU_RT_Q')).toBe(true);
    expect(dictionaryCalls()).toBe(26);
  });

  it('keeps serving the previous snapshot when a refresh fails', async () => {
    const clock = manualClock();
    const fixture = loadCatalogFixture();
    const healthy = createFetchMock(catalogRoutes(fixture));
    let failing: ((input: string) => boolean) | undefined;
    const fetch: FetchFn = (input, init) =>
      failing?.(input)
        ? Promise.resolve(new Response('unavailable', { status: 503 }))
        : healthy.fetch(input, init);
    const { catalog } = setup({ fetch, fixture, now: clock.now });
    const loaded = await catalog.ready(contractCtx());

    clock.advance(60_000);
    failing = (input) => input.includes('/metadata/toc/');
    await expect(catalog.refresh()).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
    await expect(catalog.ready(contractCtx())).resolves.toBe(loaded);

    // The ToC moved but the dictionaries fail: the old snapshot still serves.
    tocRow(fixture, 'UNE_DEAP_SEX_AGE_RT_A')['last.update'] = '26/09/2026 07:00:00';
    failing = (input) => input.includes('/metadata/dic');
    await expect(catalog.refresh()).rejects.toBeDefined();
    const serving = await catalog.ready(contractCtx());
    expect(serving).toBe(loaded);
    expect(serving.asOf).toBe('2026-09-26T12:00:00.000Z');
  });

  it('runs a full load when no snapshot exists yet, and shares one refresh between callers', async () => {
    const { catalog, tocCalls } = setup();
    await Promise.all([catalog.refresh(), catalog.refresh()]);
    expect(tocCalls()).toBe(1);
    await catalog.ready(contractCtx());
    await Promise.all([catalog.refresh(), catalog.refresh()]);
    expect(tocCalls()).toBe(2);
  });

  it('refreshes on the timer start() arms, and stops when disposed', async () => {
    const { catalog, tocCalls } = setup({ refreshIntervalMs: 25 });
    catalog.start();
    await catalog.ready(contractCtx());
    await vi.waitFor(() => expect(tocCalls()).toBeGreaterThanOrEqual(3), { timeout: 2_000 });
    catalog.dispose();
    const after = tocCalls();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(tocCalls()).toBe(after);
  });

  it('keeps serving when a timer refresh fails', async () => {
    const fixture = loadCatalogFixture();
    const healthy = createFetchMock(catalogRoutes(fixture));
    let tocDown = false;
    let failures = 0;
    const fetch: FetchFn = (input, init) => {
      if (tocDown && input.includes('/metadata/toc/')) {
        failures += 1;
        return Promise.resolve(new Response('unavailable', { status: 503 }));
      }
      return healthy.fetch(input, init);
    };
    const { catalog } = setup({ fetch, fixture, refreshIntervalMs: 20 });
    catalog.start();
    const loaded = await catalog.ready(contractCtx());
    tocDown = true;
    await vi.waitFor(() => expect(failures).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
    await expect(catalog.ready(contractCtx())).resolves.toBe(loaded);
  });
});

describe('CatalogService disposal and clock', () => {
  it('dispose() cancels an in-flight load', async () => {
    const upstream = hangingFetch();
    const { catalog } = setup({ fetch: upstream.fetch });
    catalog.start();
    await vi.waitFor(() => expect(upstream.signals).toHaveLength(FAST_PACING.maxConcurrent));
    catalog.dispose();
    for (const signal of upstream.signals) expect(signal.aborted).toBe(true);
  });

  it('computes the current_year cutoff from the injected clock, across a year boundary', async () => {
    const fixture = loadCatalogFixture();
    // No label that names an ILO edition: only the current_year rule is left.
    fixture.indicatorToc = fixture.indicatorToc.filter(
      (row) => !String(row['indicator.label']).includes('ILO modelled estimates'),
    );
    const clock = manualClock('2026-12-31T23:59:59Z');
    const { catalog } = setup({ fixture, now: clock.now });
    const snapshot = await catalog.ready(contractCtx());
    const indicator = snapshot.indicatorsByCode.get('UNE_DEAP_SEX_AGE_RT');
    if (!indicator) throw new Error('fixture indicator missing');

    expect(snapshot.catalogEdition).toBeUndefined();
    expect(catalog.projectionCutoff(indicator, snapshot)).toEqual({
      projectionAfterYear: 2025,
      rule: 'current_year',
    });
    clock.advance(1_000);
    expect(catalog.projectionCutoff(indicator, snapshot)).toEqual({
      projectionAfterYear: 2026,
      rule: 'current_year',
    });
  });
});
