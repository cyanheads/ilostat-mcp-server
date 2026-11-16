/**
 * @fileoverview Tests for the per-indicator structure cache over an `SdmxClient`
 * fetch fake: one structure request per lookup and no data request, degradation
 * to `unavailable` (cached for its TTL when SDMX said so definitively, for a
 * minute when SDMX failed), shutdown and a caller's cancellation rejecting rather
 * than degrading and never remembered, the cache keyed by the ToC `last.update`
 * with its TTL and LRU bound, and single-flight lookups detached from any one
 * caller's cancellation.
 * @module tests/services/structure/structure-service.test
 */

import {
  createFetchMock,
  createMockContext,
  type FetchMockRoute,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { SdmxClient } from '@/services/sdmx/sdmx-client.js';
import { StructureService } from '@/services/structure/structure-service.js';
import type { FetchFn } from '@/services/upstream/upstream-http.js';
import {
  callUrls,
  clientOptions,
  hangingFetch,
  isStructureRequest,
  SDMX_404_NO_STRUCTURE,
  sdmxFixtureRoutes,
  sdmxText,
  structureDocument,
  structureResponse,
  structureRoute,
  tooManyRequests,
} from '../../helpers/ilostat-upstream.js';
import { guardNetwork } from '../../helpers/network-guard.js';

guardNetwork();

const UPDATED = '2026-09-24T07:11:06';
const disposables: { dispose(): void }[] = [];

afterEach(() => {
  for (const item of disposables.splice(0)) item.dispose();
});

function manualClock() {
  let current = new Date('2026-09-26T12:00:00Z').getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function setup(
  routes: FetchMockRoute[] = sdmxFixtureRoutes(),
  options: { fetch?: FetchFn; maxEntries?: number; now?: () => Date; ttlMs?: number } = {},
) {
  const http = createFetchMock(routes);
  const sdmx = new SdmxClient(clientOptions(options.fetch ?? http.fetch));
  const structure = new StructureService({
    sdmx,
    ...(options.now ? { now: options.now } : {}),
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  });
  disposables.push(structure, sdmx);
  const structureCalls = () => callUrls(http, (request) => isStructureRequest(request)).length;
  return { http, structure, structureCalls };
}

describe('StructureService.lookup', () => {
  it('returns the structure, with its unit codelists, from one request and no data request', async () => {
    const { http, structure } = setup();
    const lookup = await structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext());
    expect(lookup).toEqual({ status: 'complete', structure: expect.any(Object) });
    expect(lookup.structure?.classif1?.id).toBe('AGE');
    expect(lookup.structure?.unitCodelists.measure.get('PT')).toBe('Percentage');
    expect(callUrls(http).map((url) => url.pathname)).toEqual([
      '/rest/dataflow/ILO/DF_UNE_DEAP_SEX_AGE_RT/latest',
    ]);
  });

  it('degrades to unavailable and caches it when SDMX has no dataflow', async () => {
    const { structure, structureCalls } = setup();
    const lookup = await structure.lookup('POP_2POP_SEX_NB', UPDATED, createMockContext());
    expect(lookup).toEqual({ status: 'unavailable' });
    await structure.lookup('POP_2POP_SEX_NB', UPDATED, createMockContext());
    expect(structureCalls()).toBe(1);
  });

  it('remembers a transient SDMX failure for a minute, so a lookup inside it degrades with no request', async () => {
    const clock = manualClock();
    const { structure, structureCalls } = setup(
      [
        structureRoute('UNE_DEAP_SEX_AGE_RT', () => new Response('down', { status: 503 })),
        ...sdmxFixtureRoutes(),
      ],
      { now: clock.now },
    );
    await expect(
      structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext()),
    ).resolves.toEqual({ status: 'unavailable' });
    clock.advance(59_999);
    await expect(
      structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext()),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(structureCalls()).toBe(1);
    clock.advance(1);
    await structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext());
    expect(structureCalls()).toBe(2);
  });

  it('serves a recovered SDMX once the failure minute passes, then caches the structure', async () => {
    const clock = manualClock();
    let down = true;
    const { structure, structureCalls } = setup(
      [
        structureRoute('UNE_DEAP_SEX_AGE_RT', () =>
          down
            ? new Response('down', { status: 503 })
            : structureResponse(structureDocument('UNE_DEAP_SEX_AGE_RT')),
        ),
        ...sdmxFixtureRoutes(),
      ],
      { now: clock.now },
    );
    await structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext());
    down = false;
    clock.advance(30_000);
    await expect(
      structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext()),
    ).resolves.toEqual({ status: 'unavailable' });
    clock.advance(30_000);
    const recovered = await structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext());
    expect(recovered.status).toBe('complete');
    expect(recovered.structure?.classif1?.id).toBe('AGE');
    // the structure replaced the failure: served for its own TTL, well past a minute
    clock.advance(10 * 60_000);
    await expect(
      structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext()),
    ).resolves.toBe(recovered);
    expect(structureCalls()).toBe(2);
  });

  it("re-asks inside the failure minute once the indicator's last.update moves", async () => {
    const { structure, structureCalls } = setup([
      structureRoute('UNE_DEAP_SEX_AGE_RT', () => new Response('down', { status: 503 })),
      ...sdmxFixtureRoutes(),
    ]);
    await structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext());
    await structure.lookup('UNE_DEAP_SEX_AGE_RT', '2026-09-25T07:00:00', createMockContext());
    expect(structureCalls()).toBe(2);
  });

  it("never remembers a caller's cancellation as a failure", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const upstream = createFetchMock(sdmxFixtureRoutes());
    const { structure } = setup(undefined, {
      fetch: (input, init) => gate.then(() => upstream.fetch(input, init)),
    });
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    await expect(
      structure.lookup(
        'UNE_DEAP_SEX_AGE_RT',
        UPDATED,
        createMockContext({ signal: controller.signal }),
      ),
    ).rejects.toThrow('caller cancelled');

    release();
    const later = await structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext());
    expect(later.status).toBe('complete');
    expect(callUrls(upstream, (request) => isStructureRequest(request))).toHaveLength(1);
  });

  it('degrades a throttled SDMX (429) and a malformed structure to unavailable', async () => {
    const { structure } = setup([
      structureRoute('UNE_DEAP_SEX_AGE_RT', () => tooManyRequests('30')),
      structureRoute(
        'SDG_0552_NOC_RT',
        () => new Response(JSON.stringify({ data: { dataflows: [] } }), { status: 200 }),
      ),
      ...sdmxFixtureRoutes(),
    ]);
    await expect(
      structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext()),
    ).resolves.toEqual({ status: 'unavailable' });
    await expect(
      structure.lookup('SDG_0552_NOC_RT', UPDATED, createMockContext()),
    ).resolves.toEqual({ status: 'unavailable' });
  });

  it('rejects waiting lookups once disposed mid-fetch, rather than degrading them, and never remembers it', async () => {
    const { fetch } = hangingFetch();
    const { structure } = setup(undefined, { fetch });
    const pending = structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext());
    structure.dispose();
    await expect(pending).rejects.toBeDefined();
    // a remembered failure would answer `unavailable` here; the shutdown rejects again instead
    await expect(
      structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext()),
    ).rejects.toBeDefined();
  });
});

describe('StructureService cache', () => {
  it('serves a repeat lookup from cache and refetches when last.update changes', async () => {
    const { structure, structureCalls } = setup();
    await structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext());
    await structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext());
    expect(structureCalls()).toBe(1);
    await structure.lookup('UNE_DEAP_SEX_AGE_RT', '2026-09-25T07:00:00', createMockContext());
    expect(structureCalls()).toBe(2);
  });

  it('expires an entry after its TTL', async () => {
    const clock = manualClock();
    const { structure, structureCalls } = setup(undefined, { now: clock.now, ttlMs: 1_000 });
    await structure.lookup('SDG_0552_NOC_RT', UPDATED, createMockContext());
    clock.advance(999);
    await structure.lookup('SDG_0552_NOC_RT', UPDATED, createMockContext());
    expect(structureCalls()).toBe(1);
    clock.advance(1);
    await structure.lookup('SDG_0552_NOC_RT', UPDATED, createMockContext());
    expect(structureCalls()).toBe(2);
  });

  it('evicts the least recently used entry past maxEntries', async () => {
    const { structure, http } = setup(undefined, { maxEntries: 2 });
    const calls = (indicator: string) =>
      callUrls(http, (request) => isStructureRequest(request, indicator)).length;
    await structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext());
    await structure.lookup('SDG_0552_NOC_RT', UPDATED, createMockContext());
    await structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext()); // now most recent
    await structure.lookup('LAP_2LID_QTL_RT', UPDATED, createMockContext()); // evicts SDG_0552
    await structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext());
    await structure.lookup('SDG_0552_NOC_RT', UPDATED, createMockContext());
    expect(calls('UNE_DEAP_SEX_AGE_RT')).toBe(1);
    expect(calls('SDG_0552_NOC_RT')).toBe(2);
  });

  it('shares one fetch between concurrent lookups of an indicator', async () => {
    const { structure, structureCalls } = setup();
    const [a, b] = await Promise.all([
      structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext()),
      structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext()),
    ]);
    expect(a).toBe(b);
    expect(structureCalls()).toBe(1);
  });

  it("detaches the fetch from a caller's cancellation and still caches the result", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const upstream = createFetchMock(sdmxFixtureRoutes());
    const { structure } = setup(undefined, {
      fetch: (input, init) => gate.then(() => upstream.fetch(input, init)),
    });
    const controller = new AbortController();
    const cancelled = structure.lookup(
      'UNE_DEAP_SEX_AGE_RT',
      UPDATED,
      createMockContext({ signal: controller.signal }),
    );
    controller.abort(new Error('caller cancelled'));
    await expect(cancelled).rejects.toThrow('caller cancelled');

    release();
    const later = await structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext());
    expect(later.status).toBe('complete');
    expect(callUrls(upstream, (request) => isStructureRequest(request))).toHaveLength(1);
  });

  it("re-checks a cached no-dataflow answer once the indicator's last.update moves", async () => {
    const { structure, structureCalls } = setup([
      structureRoute('EMP_TEMP_SEX_IND_NB', () => sdmxText(SDMX_404_NO_STRUCTURE, 404)),
      ...sdmxFixtureRoutes(),
    ]);
    await structure.lookup('EMP_TEMP_SEX_IND_NB', UPDATED, createMockContext());
    await structure.lookup('EMP_TEMP_SEX_IND_NB', '2026-09-25T00:00:00', createMockContext());
    expect(structureCalls()).toBe(2);
  });
});
