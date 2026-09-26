/**
 * @fileoverview Tests for the projection-cutoff rules — the edition an indicator
 * label names, the catalog's latest ILO modelled estimates edition, and the three
 * rules that set a dataset's cutoff (edition, catalog_edition, current_year) — and
 * for each row's basis, decided from its own source label and year.
 * @module tests/services/basis/basis.test
 */

import { describe, expect, it } from 'vitest';
import {
  classifyRow,
  latestCatalogEdition,
  MODELLED_SOURCE_LABEL,
  parseEdition,
  projectionCutoff,
} from '@/services/basis/basis.js';
import { guardNetwork } from '../../helpers/network-guard.js';

guardNetwork();

const NOV_2025 = 'Unemployment rate by sex and age -- ILO modelled estimates, Nov. 2025 (%)';
const SEPT_2025 = 'Labour income distribution by decile -- ILO modelled estimates, Sept. 2025 (%)';
const NOV_2023 = 'Hours worked by sex -- ILO modelled estimates, Nov. 2023 (thousands)';
const UN_JULY_2024 = 'Population by sex -- UN estimates and projections, July 2024 (thousands)';

describe('parseEdition', () => {
  it('reads an ILO modelled estimates edition', () => {
    expect(parseEdition(NOV_2025)).toEqual({
      ilo: true,
      label: 'Nov. 2025',
      month: 11,
      year: 2025,
    });
  });

  it('reads a four-letter month abbreviation', () => {
    expect(parseEdition(SEPT_2025)).toEqual({
      ilo: true,
      label: 'Sept. 2025',
      month: 9,
      year: 2025,
    });
  });

  it('reads an edition with no unit parenthetical after it', () => {
    expect(parseEdition('Labour income share -- ILO modelled estimates, Nov. 2025')?.year).toBe(
      2025,
    );
  });

  it('marks an edition from another publisher as not ILO', () => {
    expect(parseEdition(UN_JULY_2024)).toEqual({
      ilo: false,
      label: 'July 2024',
      month: 7,
      year: 2024,
    });
  });

  it('finds no edition in a label that names none', () => {
    expect(parseEdition('Unemployment rate by sex and age (%)')).toBeUndefined();
    expect(parseEdition('Employment by sex and age -- 19th ICLS (thousands)')).toBeUndefined();
  });

  it('finds no edition when the month word is not a month', () => {
    expect(parseEdition('Rate -- ILO modelled estimates, Autumn 2025 (%)')).toBeUndefined();
  });
});

describe('latestCatalogEdition', () => {
  it('picks the latest ILO edition by year', () => {
    expect(latestCatalogEdition([NOV_2023, NOV_2025, 'Unemployment rate (%)'])?.label).toBe(
      'Nov. 2025',
    );
  });

  it('breaks a same-year tie by month', () => {
    expect(latestCatalogEdition([NOV_2025, SEPT_2025])?.label).toBe('Nov. 2025');
    expect(latestCatalogEdition([SEPT_2025, NOV_2025])?.label).toBe('Nov. 2025');
  });

  it('ignores editions from other publishers, however recent', () => {
    const unLater = 'Population -- UN estimates and projections, July 2026 (thousands)';
    expect(latestCatalogEdition([unLater, NOV_2023])?.label).toBe('Nov. 2023');
  });

  it('is undefined when no label names an ILO edition', () => {
    expect(latestCatalogEdition([UN_JULY_2024, 'Unemployment rate (%)'])).toBeUndefined();
    expect(latestCatalogEdition([])).toBeUndefined();
  });
});

describe('projectionCutoff', () => {
  const nov2025 = parseEdition(NOV_2025);
  const july2024 = parseEdition(UN_JULY_2024);

  it('edition: the year before the edition the label names', () => {
    expect(projectionCutoff(july2024, nov2025, 2026)).toEqual({
      projectionAfterYear: 2023,
      rule: 'edition',
      edition: 'July 2024',
    });
  });

  it("catalog_edition: the year before the catalog's latest ILO edition", () => {
    expect(projectionCutoff(undefined, nov2025, 2031)).toEqual({
      projectionAfterYear: 2024,
      rule: 'catalog_edition',
      edition: 'Nov. 2025',
    });
  });

  it('current_year: the year before the current year, on both sides of a year boundary', () => {
    expect(projectionCutoff(undefined, undefined, 2026)).toEqual({
      projectionAfterYear: 2025,
      rule: 'current_year',
    });
    expect(projectionCutoff(undefined, undefined, 2027)).toEqual({
      projectionAfterYear: 2026,
      rule: 'current_year',
    });
  });

  it('never consults the current year while an edition applies', () => {
    expect(projectionCutoff(nov2025, undefined, 1990).projectionAfterYear).toBe(2024);
    expect(projectionCutoff(undefined, nov2025, 1990).projectionAfterYear).toBe(2024);
  });
});

describe('classifyRow', () => {
  const modelled = (year: number) => ({ sourceLabel: MODELLED_SOURCE_LABEL, year });

  it('marks as modelled only the ILO modelled estimates source label', () => {
    expect(MODELLED_SOURCE_LABEL).toBe('ILO - Modelled Estimates');
  });

  it('a modelled row up to and including the cutoff year is an estimate', () => {
    expect(classifyRow(modelled(2024), 2024)).toBe('modelled_estimate');
    expect(classifyRow(modelled(1991), 2024)).toBe('modelled_estimate');
  });

  it('a modelled row after the cutoff year is a projection', () => {
    expect(classifyRow(modelled(2025), 2024)).toBe('projection');
    expect(classifyRow(modelled(2027), 2024)).toBe('projection');
  });

  it('a row from any other source is reported, even past the cutoff', () => {
    expect(classifyRow({ sourceLabel: 'LFS - Current Population Survey', year: 2025 }, 2024)).toBe(
      'reported',
    );
    expect(classifyRow({ sourceLabel: 'HS - Continuous household survey', year: 2021 }, 2024)).toBe(
      'reported',
    );
  });

  it('a source the dictionary cannot decode counts as reported', () => {
    expect(classifyRow({ sourceLabel: undefined, year: 2027 }, 2024)).toBe('reported');
  });
});
