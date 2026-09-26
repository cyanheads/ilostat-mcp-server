/**
 * @fileoverview Tests for the per-indicator structure and unit cache over an
 * `SdmxClient` fetch fake: the unit probe walking up to three constrained areas
 * past "no data" answers, degradation to `unavailable` (cached only when SDMX said
 * so definitively), this server's own faults surfacing, the cache keyed by the ToC
 * `last.update` with its TTL and LRU bound, and single-flight lookups detached from
 * any one caller's cancellation.
 * @module tests/services/structure/structure-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
  isProbeRequest,
  isStructureRequest,
  probeRoute,
  SDMX_404_NO_DATA,
  SDMX_404_NO_STRUCTURE,
  SDMX_422_SHORT_KEY,
  SDMX_500_ORA,
  sdmxFixtureRoutes,
  sdmxText,
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
  const probeUrls = () =>
    callUrls(http, (request) => isProbeRequest(request)).map((url) => url.pathname);
  return { http, structure, structureCalls, probeUrls };
}

describe('StructureService.lookup', () => {
  it('returns the structure and the unit the first constrained area reports', async () => {
    const { structure, probeUrls } = setup();
    const lookup = await structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext());
    expect(lookup.status).toBe('complete');
    expect(lookup.structure?.classif1?.id).toBe('AGE');
    expect(lookup.unit).toEqual({
      measure: 'PT',
      measureLabel: 'Percentage',
      type: 'RT',
      typeLabel: 'Rate',
      multiplier: 0,
      multiplierLabel: 'Units',
    });
    expect(probeUrls()).toEqual(['/rest/data/ILO,DF_UNE_DEAP_SEX_AGE_RT,1.0/ABW....']);
  });

  it('probes the next area on a 404 or an ORA- 500, up to three areas', async () => {
    const { structure, probeUrls } = setup([
      probeRoute('UNE_DEAP_SEX_AGE_RT', 'ABW....', () => sdmxText(SDMX_404_NO_DATA, 404)),
      probeRoute('UNE_DEAP_SEX_AGE_RT', 'KEN....', () => sdmxText(SDMX_500_ORA, 500)),
      probeRoute('UNE_DEAP_SEX_AGE_RT', 'USA....'),
      ...sdmxFixtureRoutes(),
    ]);
    const lookup = await structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext());
    expect(lookup.unit?.measure).toBe('PT');
    expect(probeUrls()).toEqual([
      '/rest/data/ILO,DF_UNE_DEAP_SEX_AGE_RT,1.0/ABW....',
      '/rest/data/ILO,DF_UNE_DEAP_SEX_AGE_RT,1.0/KEN....',
      '/rest/data/ILO,DF_UNE_DEAP_SEX_AGE_RT,1.0/USA....',
    ]);
  });

  it('stops after three areas and caches a complete lookup with no unit', async () => {
    const { structure, probeUrls, structureCalls } = setup([
      {
        match: (request) => isProbeRequest(request, 'UNE_DEAP_SEX_AGE_RT'),
        respond: () => sdmxText(SDMX_404_NO_DATA, 404),
      },
      ...sdmxFixtureRoutes(),
    ]);
    const lookup = await structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext());
    expect(lookup.status).toBe('complete');
    expect(lookup.unit).toBeUndefined();
    expect(probeUrls()).toHaveLength(3);
    await structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext());
    expect(structureCalls()).toBe(1);
  });

  it('degrades to unavailable and caches it when SDMX has no dataflow', async () => {
    const { structure, structureCalls, probeUrls } = setup();
    const lookup = await structure.lookup('POP_2POP_SEX_NB', UPDATED, createMockContext());
    expect(lookup).toEqual({ status: 'unavailable' });
    await structure.lookup('POP_2POP_SEX_NB', UPDATED, createMockContext());
    expect(structureCalls()).toBe(1);
    expect(probeUrls()).toHaveLength(0);
  });

  it('degrades to unavailable without caching when SDMX fails transiently', async () => {
    const { structure, structureCalls } = setup([
      structureRoute('UNE_DEAP_SEX_AGE_RT', () => new Response('down', { status: 503 })),
      ...sdmxFixtureRoutes(),
    ]);
    await expect(
      structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext()),
    ).resolves.toEqual({ status: 'unavailable' });
    await structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext());
    expect(structureCalls()).toBe(2);
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

  it('keeps the structure but not the cache entry when the unit probe fails transiently', async () => {
    const { structure, structureCalls } = setup([
      probeRoute('UNE_DEAP_SEX_AGE_RT', 'ABW....', () => sdmxText('Internal Server Error', 500)),
      ...sdmxFixtureRoutes(),
    ]);
    const lookup = await structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext());
    expect(lookup.status).toBe('complete');
    expect(lookup.structure).toBeDefined();
    expect(lookup.unit).toBeUndefined();
    await structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext());
    expect(structureCalls()).toBe(2);
  });

  it("surfaces this server's own fault (a 422 on the probe key) instead of degrading", async () => {
    const { structure } = setup([
      probeRoute('UNE_DEAP_SEX_AGE_RT', 'ABW....', () => sdmxText(SDMX_422_SHORT_KEY, 422)),
      ...sdmxFixtureRoutes(),
    ]);
    await expect(
      structure.lookup('UNE_DEAP_SEX_AGE_RT', UPDATED, createMockContext()),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.InternalError });
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
