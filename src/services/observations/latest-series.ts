/**
 * @fileoverview The `latest_only` reduction of `ilostat_query_indicator`: over a
 * stream of upstream rows, the latest period of each series — dataset (indicator
 * and frequency), reference area, sex, classif1, and classif2 — and every row at
 * that period (one per source when secondary sources were requested). Rows of a
 * series are not contiguous upstream, so the whole stream is read before any row
 * is kept; only the current latest rows of each series are held.
 * @module services/observations/latest-series
 */

import { periodFrequency, periodSubperiod, periodYear } from '@/services/catalog/codes.js';
import type { RawObservation } from '@/services/rplumber/types.js';

/** A period's position within its frequency: the year, then the quarter or month. */
const periodRank = (period: string): number =>
  periodYear(period) * 100 + (periodSubperiod(period) ?? 0);

const seriesKey = (row: RawObservation): string =>
  [
    row.indicator,
    periodFrequency(row.period),
    row.refArea,
    row.sex ?? '',
    row.classif1 ?? '',
    row.classif2 ?? '',
  ].join('\u0000');

/** Latest-period rows per series, fed one upstream row at a time. */
export class LatestBySeries {
  /** Rows offered so far, before the reduction. */
  read = 0;
  private readonly series = new Map<string, { rank: number; rows: RawObservation[] }>();

  add(row: RawObservation): void {
    this.read += 1;
    const key = seriesKey(row);
    const rank = periodRank(row.period);
    const latest = this.series.get(key);
    if (!latest || rank > latest.rank) this.series.set(key, { rank, rows: [row] });
    else if (rank === latest.rank) latest.rows.push(row);
  }

  /** The kept rows, series in the order first seen, rows within a series in stream order. */
  rows(): RawObservation[] {
    return [...this.series.values()].flatMap((entry) => entry.rows);
  }
}
