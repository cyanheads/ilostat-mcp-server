/**
 * @fileoverview Tests for reading a recorded SDMX-JSON dataflow structure: breakdown
 * slots from dimension order (SEX excluded, whatever its position), codes in use
 * from the content constraint with classification group headers dropped and
 * parentless leaves kept, the partial-codelist fallback for a dimension the
 * constraint omits, the default slice read by dimension ID from the `DEFAULT`
 * annotation, covered areas, the probe key, and unit decoding.
 * @module tests/services/structure/sdmx-structure.test
 */

import { describe, expect, it } from 'vitest';
import {
  type IndicatorStructure,
  parseStructure,
  probeKey,
  unitFromRow,
} from '@/services/structure/sdmx-structure.js';
import { structureDocument } from '../../helpers/ilostat-upstream.js';
import { guardNetwork } from '../../helpers/network-guard.js';

guardNetwork();

interface MutableDocument {
  data: {
    codelists: {
      codes: { annotations?: { title?: string; type?: string }[]; id: string; parent?: string }[];
      id: string;
    }[];
    contentConstraints?: {
      cubeRegions: { isIncluded?: boolean; keyValues: { id: string; values: string[] }[] }[];
    }[];
    dataflows: { annotations: { title: string; type: string }[] }[];
    dataStructures: {
      dataStructureComponents: {
        dimensionList: {
          dimensions: {
            id: string;
            localRepresentation?: { enumeration?: string };
            position: number;
          }[];
        };
      };
    }[];
  };
}

const document = (indicator: string) => structureDocument(indicator) as unknown as MutableDocument;

describe('parseStructure: sex and one breakdown (UNE_DEAP_SEX_AGE_RT)', () => {
  const structure = parseStructure(structureDocument('UNE_DEAP_SEX_AGE_RT'));

  it('reads version, last update, and the key dimensions in position order', () => {
    expect(structure.version).toBe('1.0');
    expect(structure.lastUpdate).toBe('2026-09-20T07:33:33');
    expect(structure.keyDimensions).toEqual(['REF_AREA', 'FREQ', 'MEASURE', 'SEX', 'AGE']);
  });

  it('keeps sex out of the breakdown slots and lists its codes in use', () => {
    expect(structure.sexCodes).toEqual(['SEX_T', 'SEX_M', 'SEX_F', 'SEX_O']);
    expect(structure.classif1?.id).toBe('AGE');
    expect(structure.classif2).toBeUndefined();
  });

  it('drops classification group headers — codes that are another code’s parent', () => {
    const codes = structure.classif1?.codes.map((code) => code.code);
    expect(codes).toEqual([
      'AGE_YTHADULT_YGE15',
      'AGE_YTHADULT_Y15-64',
      'AGE_YTHADULT_Y15-24',
      'AGE_YTHADULT_YGE25',
      'AGE_AGGREGATE_YGE15',
      'AGE_AGGREGATE_Y15-24',
      'AGE_AGGREGATE_Y25-54',
    ]);
    expect(codes).not.toContain('AGE_YTHADULT');
    expect(codes).not.toContain('AGE_AGGREGATE');
  });

  it('marks totals from the IS_TOTAL annotation and keeps each SDMX code name', () => {
    expect(structure.classif1?.codes[0]).toEqual({
      code: 'AGE_YTHADULT_YGE15',
      name: '15+',
      isTotal: true,
    });
    expect(
      structure.classif1?.codes.filter((code) => code.isTotal).map((code) => code.code),
    ).toEqual(['AGE_YTHADULT_YGE15', 'AGE_AGGREGATE_YGE15']);
  });

  it('takes the default slice from the first total the DEFAULT annotation lists', () => {
    expect(structure.defaultSlice).toEqual({ sex: 'SEX_T', classif1: 'AGE_YTHADULT_YGE15' });
  });

  it('lists covered areas from the content constraint, in constraint order', () => {
    expect(structure.refAreas).toEqual(['ABW', 'KEN', 'USA', 'X06', 'X01']);
  });

  it('decodes the unit attributes with their codelists', () => {
    expect(structure.unitCodelists.measure.get('PT')).toBe('Percentage');
    expect(structure.unitCodelists.type.get('RT')).toBe('Rate');
    expect(structure.unitCodelists.multiplier.get('3')).toBe('Thousands');
  });
});

describe('parseStructure: deciles (LAP_2LID_QTL_RT)', () => {
  const structure = parseStructure(structureDocument('LAP_2LID_QTL_RT'));

  it('reads codes from the partial codelist when the constraint omits the dimension', () => {
    expect(structure.classif1?.id).toBe('DCL');
    expect(structure.classif1?.codes.map((code) => code.code)).toEqual(
      Array.from({ length: 10 }, (_, i) => `DCL_DECILE_${String(i + 1).padStart(2, '0')}`),
    );
  });

  it('keeps every parentless decile and leaves the slot out of the default slice (no total)', () => {
    expect(structure.classif1?.codes.every((code) => !code.isTotal)).toBe(true);
    expect(structure.defaultSlice).toEqual({});
  });

  it('has no sex breakdown', () => {
    expect(structure.sexCodes).toBeUndefined();
  });
});

describe('parseStructure: two breakdowns (EMP_TEMP_SEX_INS_DSB_NB)', () => {
  it('fills classif1 then classif2 in dimension order', () => {
    const structure = parseStructure(structureDocument('EMP_TEMP_SEX_INS_DSB_NB'));
    expect(structure.classif1?.id).toBe('INS');
    expect(structure.classif2?.id).toBe('DSB');
  });

  it('reads the DEFAULT annotation by dimension ID, not in dimension order', () => {
    const structure = parseStructure(structureDocument('EMP_TEMP_SEX_INS_DSB_NB'));
    // the annotation lists DSB=…,INS=…,SEX=… — the reverse of the dimension order
    expect(structure.defaultSlice).toEqual({
      sex: 'SEX_T',
      classif1: 'INS_SECTOR_TOTAL',
      classif2: 'DSB_STATUS_TOTAL',
    });
  });

  it('keeps SEX out of the slots when a classification comes before it', () => {
    const doc = document('EMP_TEMP_SEX_INS_DSB_NB');
    const dimensions = doc.data.dataStructures[0]?.dataStructureComponents.dimensionList.dimensions;
    for (const dimension of dimensions ?? []) {
      if (dimension.id === 'INS') dimension.position = 3;
      if (dimension.id === 'SEX') dimension.position = 4;
    }
    const structure = parseStructure(doc);
    expect(structure.keyDimensions).toEqual(['REF_AREA', 'FREQ', 'MEASURE', 'INS', 'SEX', 'DSB']);
    expect(structure.classif1?.id).toBe('INS');
    expect(structure.classif2?.id).toBe('DSB');
    expect(structure.sexCodes).toEqual(['SEX_T', 'SEX_M', 'SEX_F', 'SEX_O']);
  });

  it('fills at most two slots', () => {
    const doc = document('EMP_TEMP_SEX_INS_DSB_NB');
    doc.data.dataStructures[0]?.dataStructureComponents.dimensionList.dimensions.push({
      id: 'GEO',
      position: 6,
    });
    const structure = parseStructure(doc);
    expect([structure.classif1?.id, structure.classif2?.id]).toEqual(['INS', 'DSB']);
    expect(structure.keyDimensions).toContain('GEO');
  });
});

describe('parseStructure: no breakdowns (SDG_0552_NOC_RT)', () => {
  it('has no slots and ignores DEFAULT entries for dimensions it lacks', () => {
    const structure = parseStructure(structureDocument('SDG_0552_NOC_RT'));
    expect(structure.classif1).toBeUndefined();
    expect(structure.sexCodes).toBeUndefined();
    expect(structure.defaultSlice).toEqual({});
    expect(structure.keyDimensions).toEqual(['REF_AREA', 'FREQ', 'MEASURE']);
  });
});

describe('parseStructure: sparse documents', () => {
  it('falls back to the codelists when there is no content constraint', () => {
    const doc = document('UNE_DEAP_SEX_AGE_RT');
    delete doc.data.contentConstraints;
    const structure = parseStructure(doc);
    expect(structure.refAreas).toEqual(['ABW', 'KEN', 'USA', 'X01', 'X06']);
    expect(structure.classif1?.codes.map((code) => code.code)).not.toContain('AGE_YTHADULT');
  });

  it('ignores an excluded cube region', () => {
    const doc = document('UNE_DEAP_SEX_AGE_RT');
    const region = doc.data.contentConstraints?.[0]?.cubeRegions[0];
    if (region) region.isIncluded = false;
    const structure = parseStructure(doc);
    expect(structure.refAreas).toEqual(['ABW', 'KEN', 'USA', 'X01', 'X06']);
  });

  it('leaves the default slice empty when the dataflow has no DEFAULT annotation', () => {
    const doc = document('UNE_DEAP_SEX_AGE_RT');
    const flow = doc.data.dataflows[0];
    if (flow) flow.annotations = flow.annotations.filter((entry) => entry.type !== 'DEFAULT');
    const structure = parseStructure(doc);
    expect(structure.defaultSlice).toEqual({});
    expect(structure.lastUpdate).toBe('2026-09-20T07:33:33');
  });

  it('throws on a document without a dataflow or data structure', () => {
    expect(() => parseStructure({ data: { dataflows: [], dataStructures: [] } })).toThrow();
    expect(() => parseStructure('Could not find requested structures')).toThrow();
  });
});

describe('probeKey', () => {
  it('selects one area with every other dimension wildcarded', () => {
    const structure = parseStructure(structureDocument('UNE_DEAP_SEX_AGE_RT'));
    expect(probeKey(structure, 'ABW')).toBe('ABW....');
    const decile: IndicatorStructure = parseStructure(structureDocument('LAP_2LID_QTL_RT'));
    expect(probeKey(decile, 'KEN')).toBe('KEN...');
  });
});

describe('unitFromRow', () => {
  const { unitCodelists } = parseStructure(structureDocument('UNE_DEAP_SEX_AGE_RT'));

  it('decodes the unit attributes of a probed series row', () => {
    expect(
      unitFromRow({ UNIT_MEASURE_TYPE: 'NB', UNIT_MEASURE: 'PS', UNIT_MULT: '3' }, unitCodelists),
    ).toEqual({
      measure: 'PS',
      measureLabel: 'Persons',
      type: 'NB',
      typeLabel: 'Number',
      multiplier: 3,
      multiplierLabel: 'Thousands',
    });
  });

  it('keeps codes the codelists lack without inventing labels', () => {
    expect(
      unitFromRow({ UNIT_MEASURE_TYPE: 'GR', UNIT_MEASURE: 'US', UNIT_MULT: '0' }, unitCodelists),
    ).toEqual({ measure: 'US', type: 'GR', multiplier: 0, multiplierLabel: 'Units' });
  });

  it('is undefined when a row lacks an attribute or the multiplier is not a number', () => {
    expect(unitFromRow({ UNIT_MEASURE_TYPE: 'RT', UNIT_MULT: '0' }, unitCodelists)).toBeUndefined();
    expect(
      unitFromRow({ UNIT_MEASURE_TYPE: 'RT', UNIT_MEASURE: 'PT', UNIT_MULT: 'x' }, unitCodelists),
    ).toBeUndefined();
  });
});
