/**
 * @fileoverview Tests for the observation-row legend over rows decoded against
 * the recorded catalog: an upstream code named like an `Object.prototype` member
 * (`__proto__`, `constructor`, `toString`) is kept as an own key of its legend
 * map, and a code absent from a map reads back as undefined rather than a
 * prototype member.
 * @module tests/services/observations/observation-rows.test
 */

import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { CatalogService } from '@/services/catalog/catalog-service.js';
import type { CatalogSnapshot } from '@/services/catalog/types.js';
import {
  decodeObservation,
  legendOf,
  UNLABELLED,
} from '@/services/observations/observation-rows.js';
import { RplumberClient } from '@/services/rplumber/rplumber-client.js';
import type { RawObservation } from '@/services/rplumber/types.js';
import {
  catalogRoutes,
  clientOptions,
  FIXED_NOW,
  observationCatalogFixture,
} from '../../helpers/ilostat-upstream.js';
import { guardNetwork } from '../../helpers/network-guard.js';

guardNetwork();

let snapshot: CatalogSnapshot;

beforeAll(async () => {
  const http = createFetchMock(catalogRoutes(observationCatalogFixture()));
  const catalog = new CatalogService({
    rplumber: new RplumberClient(clientOptions(http.fetch)),
    refreshIntervalMs: 0,
    now: () => FIXED_NOW,
  });
  try {
    snapshot = await catalog.ready(createMockContext());
  } finally {
    catalog.dispose();
  }
});

const raw = (overrides: Partial<RawObservation>): RawObservation => ({
  indicator: 'UNE_DEAP_SEX_AGE_RT',
  refArea: 'USA',
  source: 'BA:453',
  period: '2024',
  value: 5,
  notes: [],
  ...overrides,
});

describe('legendOf', () => {
  it('keeps codes named like Object.prototype members as own keys, labelled as undictionaried', () => {
    const rows = [
      raw({ obsStatus: '__proto__' }),
      raw({ obsStatus: 'constructor', notes: ['toString'] }),
    ].map((row) => decodeObservation(row, snapshot, undefined));
    const legend = legendOf(rows, snapshot);
    for (const code of ['__proto__', 'constructor']) {
      expect(Object.hasOwn(legend.obs_status, code)).toBe(true);
      expect(legend.obs_status[code]).toBe(UNLABELLED);
    }
    expect(Object.hasOwn(legend.notes, 'toString')).toBe(true);
    expect(legend.notes.toString).toBe(UNLABELLED);
  });

  it('reads a code absent from a legend map as undefined, not a prototype member', () => {
    const legend = legendOf([decodeObservation(raw({}), snapshot, undefined)], snapshot);
    expect(legend.obs_status.toString).toBeUndefined();
    expect(legend.notes.constructor).toBeUndefined();
    expect(legend.ref_area).toEqual({ USA: 'United States of America' });
  });
});
