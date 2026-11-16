/**
 * @fileoverview Tests for the unit line every tool prints: each code beside its
 * label, the code alone where its label is absent, and line breaks flattened.
 * @module tests/tools/observation-output.test
 */

import { describe, expect, it } from 'vitest';
import { renderUnit } from '@/mcp-server/tools/observation-output.js';
import { guardNetwork } from '../helpers/network-guard.js';

guardNetwork();

describe('renderUnit', () => {
  it.each([
    [
      'every label',
      {
        measure: 'PT',
        measure_label: 'Percentage',
        type: 'RT',
        type_label: 'Rate',
        multiplier: 0,
        multiplier_label: 'Units',
      },
      'Percentage (PT) · type Rate (RT) · multiplier 0 (Units)',
    ],
    [
      'no type label, as from the catalog while the structure service is down',
      { measure: 'PT', measure_label: '%', type: 'RT', multiplier: 0, multiplier_label: 'units' },
      '% (PT) · type RT · multiplier 0 (units)',
    ],
    [
      'no label at all',
      { measure: 'PS', type: 'NB', multiplier: 3 },
      'PS · type NB · multiplier 3',
    ],
  ])('%s', (_case, unit, expected) => {
    expect(renderUnit(unit)).toBe(expected);
  });

  it('flattens line breaks in every label', () => {
    expect(
      renderUnit({
        measure: 'PS',
        measure_label: 'persons\n## unit',
        type: 'NB',
        type_label: 'Number\r\n## type',
        multiplier: 3,
        multiplier_label: 'thousands\r## multiplier',
      }),
    ).toBe(
      'persons ## unit (PS) · type Number ## type (NB) · multiplier 3 (thousands ## multiplier)',
    );
  });
});
