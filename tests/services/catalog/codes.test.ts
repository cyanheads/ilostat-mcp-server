/**
 * @fileoverview Tests for the certain code normalizations: reference-area and
 * area-group codes (the ToC's `ILO_GEO_` forms), dataset IDs (the SDMX `DF_`
 * form), and a classification code's type prefix.
 * @module tests/services/catalog/codes.test
 */

import { describe, expect, it } from 'vitest';
import {
  classificationTypeOf,
  normalizeAreaCode,
  normalizeDatasetId,
} from '@/services/catalog/codes.js';
import { guardNetwork } from '../../helpers/network-guard.js';

guardNetwork();

describe('normalizeAreaCode', () => {
  it('trims and uppercases', () => {
    expect(normalizeAreaCode('  usa ')).toBe('USA');
  });

  it('maps the ToC group forms onto the X-coded areas', () => {
    expect(normalizeAreaCode('ILO_GEO_X06')).toBe('X06');
    expect(normalizeAreaCode('ilo_geo_wb_inc_x02')).toBe('X02');
  });

  it('leaves an ISO2 code or a name as it is, for validation to reject', () => {
    expect(normalizeAreaCode('us')).toBe('US');
    expect(normalizeAreaCode('Kenya')).toBe('KENYA');
  });
});

describe('normalizeDatasetId', () => {
  it('trims, uppercases, and strips the SDMX DF_ prefix', () => {
    expect(normalizeDatasetId(' df_une_deap_sex_age_rt_a ')).toBe('UNE_DEAP_SEX_AGE_RT_A');
    expect(normalizeDatasetId('UNE_DEAP_SEX_AGE_RT')).toBe('UNE_DEAP_SEX_AGE_RT');
  });
});

describe('classificationTypeOf', () => {
  it('is the prefix before the first underscore', () => {
    expect(classificationTypeOf('AGE_YTHADULT_YGE15')).toBe('AGE');
    expect(classificationTypeOf('SEX')).toBe('SEX');
  });
});
