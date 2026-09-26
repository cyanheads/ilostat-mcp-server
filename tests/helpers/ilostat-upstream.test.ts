/**
 * @fileoverview Tests for the observation test infrastructure in
 * `ilostat-upstream.ts`: the catalog extras load into a snapshot, the
 * `/data/indicator` emulator filters a recorded CSV by exactly the URL the client
 * builds (a code filter skipping rows without that cell, as upstream does), the
 * pull-based CSV body counts what was read and sees a cancel, and the in-memory
 * DuckDB canvas stages and queries rows without touching the network.
 * @module tests/helpers/ilostat-upstream.test
 */

import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { CatalogService } from '@/services/catalog/catalog-service.js';
import { type IndicatorDataParams, RplumberClient } from '@/services/rplumber/rplumber-client.js';
import {
  catalogRoutes,
  clientOptions,
  FIXED_NOW,
  filterIndicatorCsv,
  fixtureText,
  INDICATOR_CSV,
  loadCatalogFixture,
  memoryCanvas,
  observationCatalogFixture,
  refAreaRows,
  streamedCsv,
} from './ilostat-upstream.js';
import { guardNetwork } from './network-guard.js';

guardNetwork();

const urlBuilder = new RplumberClient(clientOptions(createFetchMock([]).fetch));
afterAll(() => urlBuilder.dispose());

/** The kept data lines, as `ref_area|sex|classif1|time`, for the URL the client builds from `params`. */
function kept(csv: string, params: Partial<IndicatorDataParams>) {
  const url = new URL(
    urlBuilder.indicatorDataUrl({ datasetIds: ['UNE_DEAP_SEX_AGE_RT_A'], ...params }),
  );
  const [, ...lines] = filterIndicatorCsv(fixtureText(csv), url).trimEnd().split('\n');
  return lines.map((line) => {
    const cells = line.split(',').map((cell) => cell.replaceAll('"', ''));
    return [cells[0], cells[3], cells[4], cells[5]].join('|');
  });
}

describe('observationCatalogFixture', () => {
  it('adds the headline datasets, modelled sources, and note codes to the recorded catalog', async () => {
    const http = createFetchMock(catalogRoutes(observationCatalogFixture()));
    const catalog = new CatalogService({
      rplumber: new RplumberClient(clientOptions(http.fetch)),
      refreshIntervalMs: 0,
      now: () => FIXED_NOW,
    });
    try {
      const snapshot = await catalog.ready(createMockContext());
      for (const id of ['EAP_2WAP_SEX_AGE_RT_A', 'EMP_2IFL_SEX_RT_A', 'SDG_0111_SEX_AGE_RT_A']) {
        expect(snapshot.datasets.has(id), id).toBe(true);
      }
      expect(snapshot.sources.get('XA:8405')?.label).toBe('ILO - Modelled Estimates');
      expect(snapshot.sources.get('BX:3465')?.label).toBe('HS - Continuous household survey');
      expect(snapshot.notes.get('T2:85')?.label).toBe('Age coverage - minimum age: 16 years old');
      expect(snapshot.notes.get('C6:1058')?.label).toBe('Nonstandard age group: Excluding age 15');
    } finally {
      catalog.dispose();
    }
  });

  it('leaves the recorded catalog the Wave 1 tests count untouched', () => {
    expect(loadCatalogFixture().indicatorToc).toHaveLength(13);
    expect(observationCatalogFixture().indicatorToc).toHaveLength(23);
  });

  it('serves the modelled profile captures at the 2024 cutoff, and one verbatim at 2025', () => {
    expect(new Set(refAreaRows('kenModelled').map((row) => row.time))).toEqual(new Set(['2024']));
    expect(new Set(refAreaRows('x01Modelled').map((row) => row.time))).toEqual(new Set(['2024']));
    expect(new Set(refAreaRows('kenModelled2025').map((row) => row.time))).toEqual(
      new Set(['2025']),
    );
  });
});

describe('filterIndicatorCsv', () => {
  it('filters by ref_area, sex, classif1, and +-joined periods, as the client sends them', () => {
    expect(
      kept(INDICATOR_CSV.uneDeap, {
        refAreas: ['USA'],
        sex: ['SEX_F'],
        classif1: ['AGE_YTHADULT_Y15-24'],
        time: ['2023', '2025'],
      }),
    ).toEqual(['USA|SEX_F|AGE_YTHADULT_Y15-24|2025', 'USA|SEX_F|AGE_YTHADULT_Y15-24|2023']);
  });

  it('bounds by timefrom and timeto years', () => {
    expect(
      kept(INDICATOR_CSV.uneDeap, { refAreas: ['KEN', 'X01'], timeFrom: 2016, timeTo: 2019 }),
    ).toEqual([
      'KEN|SEX_T|AGE_YTHADULT_YGE15|2019',
      'KEN|SEX_T|AGE_YTHADULT_YGE15|2016',
      'X01|SEX_T|AGE_YTHADULT_YGE15|2019',
      'X01|SEX_T|AGE_YTHADULT_YGE15|2018',
      'X01|SEX_T|AGE_YTHADULT_YGE15|2017',
      'X01|SEX_T|AGE_YTHADULT_YGE15|2016',
    ]);
  });

  it('leaves a row without the filtered breakdown unfiltered, and selects datasets by id', () => {
    const union = { datasetIds: ['LAP_2GDP_NOC_RT_A', 'UNE_2EAP_SEX_AGE_RT_A'] };
    expect(kept(INDICATOR_CSV.multiDatasetUnion, { ...union, sex: ['SEX_M'] })).toEqual([
      'KEN|||2020',
      'KEN|SEX_M|AGE_YTHADULT_YGE15|2020',
    ]);
    expect(
      kept(INDICATOR_CSV.multiDatasetUnion, { datasetIds: ['UNE_2EAP_SEX_AGE_RT_A'] }),
    ).toHaveLength(3);
  });

  it('answers a request nothing matches with the header row alone, BOM kept', () => {
    const url = new URL(
      urlBuilder.indicatorDataUrl({ datasetIds: ['UNE_DEAP_SEX_AGE_RT_A'], refAreas: ['JOR'] }),
    );
    const body = filterIndicatorCsv(fixtureText(INDICATOR_CSV.uneDeap), url);
    expect(body.startsWith('﻿"ref_area"')).toBe(true);
    expect(body.trimEnd().split('\n')).toHaveLength(1);
  });
});

describe('streamedCsv', () => {
  it('produces rows only as they are read, and records a cancel', async () => {
    const stream = streamedCsv('"ref_area","time"', 10_000, (index) => `"USA","${index}"`, 50);
    const reader = stream.response().body?.getReader();
    if (!reader) throw new Error('expected a body');
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

    const header = await reader.read();
    expect(decoder.decode(header.value)).toBe('﻿"ref_area","time"\n');
    expect(stream.pulled).toBe(0);

    const first = await reader.read();
    expect(decoder.decode(first.value).split('\n')[0]).toBe('"USA","0"');
    expect(stream.pulled).toBe(50);

    await reader.cancel();
    expect(stream.cancelled).toBe(true);
    expect(stream.pulled).toBe(50);
  });
});

describe('memoryCanvas', () => {
  it('stages rows under an explicit schema and queries them, offline', async () => {
    const canvas = memoryCanvas();
    const context = createMockContext({ tenantId: 'canvas-test' });
    try {
      const instance = await canvas.acquire(undefined, context);
      const registered = await instance.registerTable(
        'df_probe',
        [
          { ref_area: 'USA', value: 4 },
          { ref_area: 'KEN', value: 5.585 },
        ],
        {
          schema: [
            { name: 'ref_area', type: 'VARCHAR' },
            { name: 'value', type: 'DOUBLE' },
          ],
        },
      );
      expect(registered.rowCount).toBe(2);
      const result = await instance.query('SELECT sum(value) AS total FROM df_probe');
      expect(result.rows).toEqual([{ total: 9.585 }]);
    } finally {
      await canvas.shutdown(context);
    }
  });
});
