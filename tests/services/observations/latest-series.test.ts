/**
 * @fileoverview Tests for `LatestBySeries`, the per-series `latest_only`
 * reduction: quarters and months ranked within their year, ties kept (one row per
 * source), each breakdown and the frequency its own series, rows out of period
 * order, and the order rows come back in.
 * @module tests/services/observations/latest-series.test
 */

import { describe, expect, it } from 'vitest';
import { LatestBySeries } from '@/services/observations/latest-series.js';
import type { RawObservation } from '@/services/rplumber/types.js';

const row = (overrides: Partial<RawObservation>): RawObservation => ({
  indicator: 'UNE_DEAP_SEX_AGE_RT',
  refArea: 'USA',
  source: 'BA:453',
  sex: 'SEX_T',
  classif1: 'AGE_YTHADULT_YGE15',
  period: '2024',
  notes: [],
  ...overrides,
});

function reduce(rows: RawObservation[]): { read: number; kept: RawObservation[] } {
  const latest = new LatestBySeries();
  for (const entry of rows) latest.add(entry);
  return { read: latest.read, kept: latest.rows() };
}

const periods = (rows: RawObservation[]) => rows.map((entry) => entry.period);

describe('LatestBySeries', () => {
  it('ranks quarters and months within their year, whatever order they arrive in', () => {
    expect(
      periods(
        reduce(['2024Q3', '2024Q4', '2023Q4', '2024Q1'].map((period) => row({ period }))).kept,
      ),
    ).toEqual(['2024Q4']);
    expect(
      periods(
        reduce(['2024M09', '2024M10', '2023M12', '2024M02'].map((period) => row({ period }))).kept,
      ),
    ).toEqual(['2024M10']);
    expect(periods(reduce(['2019', '2022', '2021'].map((period) => row({ period }))).kept)).toEqual(
      ['2022'],
    );
  });

  it('keeps every row at the latest period — one per source — and drops the earlier ones it replaced', () => {
    const { kept } = reduce([
      row({ period: '2019', source: 'BX:3465' }),
      row({ period: '2019', source: 'AA:1311' }),
      row({ period: '2021', source: 'BX:3465' }),
      row({ period: '2021', source: 'AA:1311' }),
      row({ period: '2016', source: 'BB:7021' }),
    ]);
    expect(kept.map(({ period, source }) => `${period} ${source}`)).toEqual([
      '2021 BX:3465',
      '2021 AA:1311',
    ]);
  });

  it('treats each area, sex, classif1, classif2, indicator, and frequency as its own series', () => {
    const { read, kept } = reduce([
      row({ period: '2022' }),
      row({ period: '2021', classif1: 'AGE_YTHADULT_Y15-24' }),
      row({ period: '2000', sex: 'SEX_F' }),
      row({ period: '2010', refArea: 'CHN' }),
      row({ period: '2015', classif2: 'EDU_AGGREGATE_LTB' }),
      row({ period: '2018', indicator: 'EMP_DWAP_SEX_AGE_RT' }),
      row({ period: '2024Q2' }),
      row({ period: '2024M05' }),
      {
        indicator: 'UNE_DEAP_SEX_AGE_RT',
        refArea: 'USA',
        source: 'BA:453',
        period: '2020',
        notes: [],
      },
    ]);
    expect(read).toBe(9);
    expect(periods(kept)).toEqual([
      '2022',
      '2021',
      '2000',
      '2010',
      '2015',
      '2018',
      '2024Q2',
      '2024M05',
      '2020',
    ]);
  });

  it('returns series in the order first seen, even when a later row replaces the latest', () => {
    const { kept } = reduce([
      row({ period: '2019', classif1: 'A' }),
      row({ period: '2019', classif1: 'B' }),
      row({ period: '2023', classif1: 'A' }),
    ]);
    expect(kept.map(({ classif1, period }) => `${classif1} ${period}`)).toEqual([
      'A 2023',
      'B 2019',
    ]);
  });

  it('counts every row read and keeps nothing from an empty stream', () => {
    expect(reduce([])).toEqual({ read: 0, kept: [] });
    const { read, kept } = reduce(
      Array.from({ length: 1_000 }, (_, index) => row({ period: String(1000 + index) })),
    );
    expect(read).toBe(1_000);
    expect(periods(kept)).toEqual(['1999']);
  });
});
