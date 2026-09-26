/**
 * @fileoverview Tests for the catalog snapshot built from the recorded tables of
 * contents and dictionaries, loaded end to end through `RplumberClient` over a
 * fetch fake: datasets grouped into indicators, per-dataset aggregates, breakdown
 * names, definitions, editions, reference areas and area groups, and every
 * decoded vocabulary including the ToC-only codes the dictionaries lack.
 * @module tests/services/catalog/snapshot.test
 */

import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { CatalogService } from '@/services/catalog/catalog-service.js';
import type { CatalogSnapshot } from '@/services/catalog/types.js';
import { RplumberClient } from '@/services/rplumber/rplumber-client.js';
import {
  type CatalogFixture,
  catalogRoutes,
  clientOptions,
  FIXED_NOW,
  loadCatalogFixture,
  tocRow,
} from '../../helpers/ilostat-upstream.js';
import { guardNetwork } from '../../helpers/network-guard.js';

guardNetwork();

async function loadSnapshot(
  fixture: CatalogFixture = loadCatalogFixture(),
): Promise<CatalogSnapshot> {
  const http = createFetchMock(catalogRoutes(fixture));
  const catalog = new CatalogService({
    rplumber: new RplumberClient(clientOptions(http.fetch)),
    refreshIntervalMs: 0,
    now: () => FIXED_NOW,
  });
  try {
    return await catalog.ready(createMockContext());
  } finally {
    catalog.dispose();
  }
}

describe('catalog snapshot', () => {
  it('groups datasets into indicators sorted by code, frequencies annual first', async () => {
    const snapshot = await loadSnapshot();
    expect(snapshot.indicators.map((indicator) => indicator.code)).toEqual([
      'EAP_DWAP_SEX_AGE_RT',
      'EMP_TEMP_SEX_IND_NB',
      'EMP_TEMP_SEX_INS_DSB_NB',
      'LAP_2GDP_NOC_RT',
      'LAP_2LID_QTL_RT',
      'POP_2POP_SEX_NB',
      'SDG_0552_NOC_RT',
      'UNE_2EAP_SEX_AGE_RT',
      'UNE_DEAP_SEX_AGE_RT',
      'UNE_DEAP_SEX_EDU_RT',
    ]);
    const une = snapshot.indicatorsByCode.get('UNE_DEAP_SEX_AGE_RT');
    expect(une?.datasets.map((dataset) => dataset.id)).toEqual([
      'UNE_DEAP_SEX_AGE_RT_A',
      'UNE_DEAP_SEX_AGE_RT_Q',
      'UNE_DEAP_SEX_AGE_RT_M',
    ]);
    expect(snapshot.datasets.size).toBe(13);
  });

  it('keeps has_aggregates per dataset: with.region differs between frequencies', async () => {
    const snapshot = await loadSnapshot();
    const une = snapshot.indicatorsByCode.get('UNE_DEAP_SEX_AGE_RT');
    expect(une?.datasets.map((dataset) => [dataset.frequency, dataset.hasAggregates])).toEqual([
      ['A', true],
      ['Q', false],
      ['M', false],
    ]);
    expect(une?.hasAggregates).toBe(true);
    expect(snapshot.indicatorsByCode.get('UNE_DEAP_SEX_EDU_RT')?.hasAggregates).toBe(false);
  });

  it('converts last.update to ISO 8601 and keys the indicator on its latest dataset update', async () => {
    const snapshot = await loadSnapshot();
    expect(snapshot.datasets.get('UNE_DEAP_SEX_AGE_RT_A')?.lastUpdate).toBe('2026-09-24T07:10:19');
    expect(snapshot.indicatorsByCode.get('UNE_DEAP_SEX_AGE_RT')?.lastUpdate).toBe(
      '2026-09-24T07:11:06',
    );
  });

  it('names breakdowns from classif.labels, else from the classification-type dictionary', async () => {
    const fixture = loadCatalogFixture();
    tocRow(fixture, 'EMP_TEMP_SEX_INS_DSB_NB_A')['classif.labels'] = '';
    tocRow(fixture, 'EMP_TEMP_SEX_INS_DSB_NB_Q')['classif.labels'] = '';
    const snapshot = await loadSnapshot(fixture);
    expect(snapshot.indicatorsByCode.get('UNE_DEAP_SEX_AGE_RT')?.breakdowns).toEqual([
      'sex',
      'age',
    ]);
    expect(snapshot.indicatorsByCode.get('EMP_TEMP_SEX_INS_DSB_NB')).toMatchObject({
      classificationTypes: ['SEX', 'INS', 'DSB'],
      breakdowns: ['sex', 'public/private sector', 'disability status'],
    });
    // QTL is a ToC-only type with no dictionary label and an empty classif.labels.
    expect(snapshot.indicatorsByCode.get('LAP_2LID_QTL_RT')).toMatchObject({
      classificationTypes: ['QTL'],
      breakdowns: ['qtl'],
    });
    const sdg = snapshot.indicatorsByCode.get('SDG_0552_NOC_RT');
    expect(sdg?.classification).toBeUndefined();
    expect(sdg?.classificationTypes).toEqual([]);
    expect(sdg?.breakdowns).toEqual([]);
  });

  it('strips definition HTML, entity-escaped anchors included, and leaves a missing one absent', async () => {
    const snapshot = await loadSnapshot();
    expect(snapshot.indicatorsByCode.get('EMP_TEMP_SEX_INS_DSB_NB')?.definition).toBe(
      'The employed comprise all persons of working age who were in paid employment or self-employment. For more information, refer to the Labour Force Statistics (LFS) database description (https://ilostat.ilo.org/methods/concepts-and-definitions/description-labour-force-statistics/).',
    );
    expect(snapshot.indicatorsByCode.get('UNE_DEAP_SEX_AGE_RT')?.definition).not.toMatch(/[<>]/);
    expect(snapshot.indicatorsByCode.get('EAP_DWAP_SEX_AGE_RT')?.definition).toBeUndefined();
  });

  it("records each label's edition and the catalog's latest ILO edition", async () => {
    const snapshot = await loadSnapshot();
    expect(snapshot.indicatorsByCode.get('LAP_2LID_QTL_RT')?.edition?.label).toBe('Sept. 2025');
    expect(snapshot.indicatorsByCode.get('POP_2POP_SEX_NB')?.edition).toMatchObject({
      ilo: false,
      label: 'July 2024',
    });
    expect(snapshot.indicatorsByCode.get('UNE_DEAP_SEX_AGE_RT')?.edition).toBeUndefined();
    expect(snapshot.catalogEdition).toMatchObject({ ilo: true, label: 'Nov. 2025', year: 2025 });
  });

  it('builds reference areas with their groups normalized to X codes', async () => {
    const snapshot = await loadSnapshot();
    expect(snapshot.refAreas.get('KEN')).toEqual({
      code: 'KEN',
      label: 'Kenya',
      kind: 'country',
      frequencies: ['A', 'Q'],
      dataStart: 1969,
      dataEnd: 2030,
      datasetCount: 1050 + 486,
      incomeGroup: { code: 'X03', label: 'Lower-middle income' },
      region: { code: 'X06', label: 'Africa' },
      subregionBroad: { code: 'X13', label: 'Sub-Saharan Africa' },
      subregionDetailed: { code: 'X18', label: 'Eastern Africa' },
    });
    expect(snapshot.refAreas.get('USA')?.frequencies).toEqual(['A', 'Q', 'M']);
    expect(snapshot.refAreas.get('X01')).toMatchObject({ kind: 'aggregate', label: 'World' });
    expect(snapshot.refAreas.get('X01')?.region).toBeUndefined();
  });

  it('decodes a dictionary-only area that no ToC row lists', async () => {
    const snapshot = await loadSnapshot();
    expect(snapshot.refAreas.get('ANT')).toEqual({
      code: 'ANT',
      label: 'Netherlands Antilles',
      kind: 'country',
      frequencies: [],
    });
    expect([...snapshot.refAreas.keys()]).toEqual([...snapshot.refAreas.keys()].sort());
  });

  it('derives area groups from member countries, one code serving several levels', async () => {
    const snapshot = await loadSnapshot();
    expect(snapshot.areaGroups.get('X36')).toEqual({
      code: 'X36',
      label: 'Arab States',
      members: ['JOR'],
      types: ['region', 'subregion_broad', 'subregion_detailed'],
    });
    expect(snapshot.areaGroups.get('X34')?.types).toEqual([
      'subregion_broad',
      'subregion_detailed',
    ]);
    expect(snapshot.areaGroups.get('X05')).toMatchObject({
      label: 'High income',
      members: ['ABW', 'USA'],
      types: ['income_group'],
    });
    // aggregates never become group members
    expect([...snapshot.areaGroups.values()].flatMap((group) => group.members)).not.toContain(
      'X01',
    );
  });

  it('builds X01 as every country the reference-area ToC lists, labelled as the World area', async () => {
    const snapshot = await loadSnapshot();
    expect(snapshot.areaGroups.get('X01')).toEqual({
      code: 'X01',
      label: 'World',
      // aggregates and the dictionary-only ANT (no ToC row) are not members
      members: ['ABW', 'JOR', 'KEN', 'USA'],
      types: ['world'],
    });
    expect([...snapshot.areaGroups.keys()]).toEqual([...snapshot.areaGroups.keys()].sort());
  });

  it('counts datasets per database and subject, adding ToC-only codes with the ToC label', async () => {
    const snapshot = await loadSnapshot();
    expect(snapshot.databases.get('ILOSECTOR')).toEqual({
      code: 'ILOSECTOR',
      label: 'Sectoral employment statistics (ILOSECTOR)',
      datasetCount: 1,
    });
    expect(snapshot.databases.get('LFS')?.datasetCount).toBe(4);
    expect(snapshot.databases.get('CHILD')?.datasetCount).toBe(0);
    expect(snapshot.subjects.get('LUU')?.datasetCount).toBe(5);
    expect(snapshot.subjects.get('CLD')?.datasetCount).toBe(0);
    expect([...snapshot.frequencies.values()]).toEqual([
      { code: 'A', label: 'Annual', datasetCount: 10 },
      { code: 'Q', label: 'Quarterly', datasetCount: 2 },
      { code: 'M', label: 'Monthly', datasetCount: 1 },
    ]);
  });

  it('lists ToC-only classification types with an explicit no-label marker', async () => {
    const snapshot = await loadSnapshot();
    expect(snapshot.classificationTypes.get('QTL')).toEqual({
      code: 'QTL',
      label: 'No label published in the ILOSTAT dictionary',
    });
    expect(snapshot.classificationTypes.get('AGE')?.label).toBe('Age');
  });

  it('merges classif1 and classif2 codes with the slot each is used in', async () => {
    const snapshot = await loadSnapshot();
    expect(snapshot.classifications.get('DSB_STATUS_TOTAL')).toMatchObject({
      slot: 'both',
      type: 'DSB',
    });
    expect(snapshot.classifications.get('GEO_COV_NAT')?.slot).toBe('classif2');
    expect(snapshot.classifications.get('AGE_YTHADULT_YGE15')).toMatchObject({
      slot: 'classif1',
      type: 'AGE',
    });
  });

  it('skips dictionary rows without a code, types sources and notes', async () => {
    const snapshot = await loadSnapshot();
    expect([...snapshot.obsStatus.keys()]).toEqual(['A', 'B', 'I', 'M', 'R', 'U']);
    expect(snapshot.sources.get('BA:453')).toEqual({
      code: 'BA:453',
      label: 'LFS - Current Population Survey',
      sourceType: 'LFS',
      refArea: 'USA',
    });
    expect(snapshot.sources.get('XA:9001')?.sourceType).toBe('Administrative records');
    expect(snapshot.notes.get('R1:3513')?.type).toBe('note_source');
    expect(snapshot.notes.get('I20:4077')?.type).toBe('note_indicator');
    expect(snapshot.notes.get('C30:6542')?.type).toBe('note_classif');
  });

  it('indexes indicators by the measure they share', async () => {
    const snapshot = await loadSnapshot();
    expect(
      snapshot.indicatorsByMeasure.get('UNE_DEAP_RT')?.map((indicator) => indicator.code),
    ).toEqual(['UNE_DEAP_SEX_AGE_RT', 'UNE_DEAP_SEX_EDU_RT']);
  });

  it('changes its signature when a last.update changes, and only then', async () => {
    const first = await loadSnapshot();
    expect((await loadSnapshot()).signature).toBe(first.signature);
    const fixture = loadCatalogFixture();
    tocRow(fixture, 'UNE_DEAP_SEX_AGE_RT_A')['last.update'] = '25/09/2026 07:00:00';
    expect((await loadSnapshot(fixture)).signature).not.toBe(first.signature);
  });
});
