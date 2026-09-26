/**
 * @fileoverview Headline labour-market profile for one reference area. Two
 * `/data/ref_area` calls in parallel — the latest reported values (countries
 * only) and the latest modelled values bounded by the modelled cutoff — sliced
 * locally, so one cached response per area serves every sex. The reported and
 * modelled slots stay separate: a missing reported value is never filled from
 * the model. `/data/ref_area` takes indicator codes without the frequency
 * suffix; a suffixed dataset ID silently returns an empty array.
 * @module services/profile/profile-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { logger, requestContextService, withExtra } from '@cyanheads/mcp-ts-core/utils';
import { type Basis, classifyRow, type ProjectionCutoff } from '@/services/basis/basis.js';
import type { CatalogService } from '@/services/catalog/catalog-service.js';
import { periodYear } from '@/services/catalog/codes.js';
import type { CatalogSnapshot, Dataset, RefArea } from '@/services/catalog/types.js';
import type { ResponseCache } from '@/services/observations/response-cache.js';
import type { RplumberClient } from '@/services/rplumber/rplumber-client.js';
import type { RawObservation } from '@/services/rplumber/types.js';

export type ProfileSex = 'SEX_T' | 'SEX_M' | 'SEX_F';

/** One headline indicator: a reported and a modelled annual dataset, one slice. */
interface Headline {
  classif1?: string;
  key: string;
  label: string;
  modelled: string;
  reported?: string;
  unit: string;
}

/** The headline set, annual datasets only. */
const HEADLINES: readonly Headline[] = [
  {
    key: 'labour_force_participation_rate',
    label: 'Labour force participation rate, 15+',
    reported: 'EAP_DWAP_SEX_AGE_RT_A',
    modelled: 'EAP_2WAP_SEX_AGE_RT_A',
    classif1: 'AGE_YTHADULT_YGE15',
    unit: '%',
  },
  {
    key: 'employment_to_population_ratio',
    label: 'Employment-to-population ratio, 15+',
    reported: 'EMP_DWAP_SEX_AGE_RT_A',
    modelled: 'EMP_2WAP_SEX_AGE_RT_A',
    classif1: 'AGE_YTHADULT_YGE15',
    unit: '%',
  },
  {
    key: 'unemployment_rate',
    label: 'Unemployment rate, 15+',
    reported: 'UNE_DEAP_SEX_AGE_RT_A',
    modelled: 'UNE_2EAP_SEX_AGE_RT_A',
    classif1: 'AGE_YTHADULT_YGE15',
    unit: '%',
  },
  {
    key: 'youth_unemployment_rate',
    label: 'Unemployment rate, 15–24',
    reported: 'UNE_DEAP_SEX_AGE_RT_A',
    modelled: 'UNE_2EAP_SEX_AGE_RT_A',
    classif1: 'AGE_YTHADULT_Y15-24',
    unit: '%',
  },
  {
    key: 'youth_neet_rate',
    label: 'Youth NEET rate',
    reported: 'EIP_NEET_SEX_RT_A',
    modelled: 'EIP_2EET_SEX_RT_A',
    unit: '%',
  },
  {
    key: 'informal_employment_rate',
    label: 'Informal employment rate',
    reported: 'EMP_NIFL_SEX_RT_A',
    modelled: 'EMP_2IFL_SEX_RT_A',
    unit: '%',
  },
  {
    key: 'employment',
    label: 'Employment, 15+',
    reported: 'EMP_TEMP_SEX_AGE_NB_A',
    modelled: 'EMP_2EMP_SEX_AGE_NB_A',
    classif1: 'AGE_YTHADULT_YGE15',
    unit: 'thousands',
  },
  {
    key: 'labour_income_share',
    label: 'Labour income share of GDP',
    modelled: 'LAP_2GDP_NOC_RT_A',
    unit: '%',
  },
  {
    key: 'working_poverty_rate',
    label: 'Working poverty rate, 15+',
    modelled: 'SDG_0111_SEX_AGE_RT_A',
    classif1: 'AGE_YTHADULT_YGE15',
    unit: '%',
  },
];

/** A headline whose datasets are in the current catalog. */
interface ActiveHeadline extends Headline {
  modelledCutoff: ProjectionCutoff;
  modelledDataset: Dataset;
  reportedDataset?: Dataset;
}

export interface NoteLabel {
  code: string;
  label?: string;
}

export interface ReportedValue {
  datasetId: string;
  notes: NoteLabel[];
  obsStatus?: string;
  obsStatusLabel?: string;
  period: string;
  source: string;
  sourceLabel?: string;
  value?: number;
}

export interface ModelledValue {
  basis: Basis;
  datasetId: string;
  edition?: string;
  obsStatus?: string;
  obsStatusLabel?: string;
  period: string;
  value?: number;
}

export interface ProfileIndicator {
  key: string;
  label: string;
  modelled?: ModelledValue;
  reported?: ReportedValue;
  unit: string;
}

export interface Profile {
  area: RefArea;
  indicators: ProfileIndicator[];
  /** Latest year the modelled call admitted: the smallest cutoff across the modelled headline datasets. */
  modelledCutoffYear: number;
  /** Keys with no reported value — including those with no reported dataset. */
  reportedMissing: string[];
}

export interface ProfileServiceOptions {
  cache: ResponseCache;
  catalog: CatalogService;
  rplumber: RplumberClient;
}

export class ProfileService {
  /** Headlines whose datasets are in each snapshot, computed once per snapshot. */
  private readonly active = new WeakMap<CatalogSnapshot, ActiveHeadline[]>();

  constructor(private readonly options: ProfileServiceOptions) {}

  /**
   * The profile of `area` for `sex`. Both upstream calls must succeed — a failed
   * reported call fails the profile rather than reporting every key missing. With
   * no headline dataset left in the catalog it fails `ServiceUnavailable` before
   * any call: an empty profile would report nothing missing, and the modelled
   * cutoff would have no year to take.
   */
  async profile(
    snapshot: CatalogSnapshot,
    area: RefArea,
    sex: ProfileSex,
    ctx: Context,
  ): Promise<Profile> {
    const headlines = this.headlines(snapshot);
    if (headlines.length === 0) {
      throw serviceUnavailable(
        "None of the country profile's headline datasets is in the current ILOSTAT catalog, so no profile can be built.",
        {
          recovery: {
            hint: 'Find labour-market datasets with ilostat_search_indicators and read the area from them with ilostat_query_indicator.',
          },
        },
      );
    }
    const modelledCutoffYear = Math.min(
      ...headlines.map((headline) => headline.modelledCutoff.projectionAfterYear),
    );
    const indicatorsOf = (datasets: (Dataset | undefined)[]) => [
      ...new Set(datasets.flatMap((dataset) => (dataset ? [dataset.indicator] : []))),
    ];
    const reportedCodes =
      area.kind === 'country' ? indicatorsOf(headlines.map((h) => h.reportedDataset)) : [];
    const [reportedRows, modelledRows] = await Promise.all([
      reportedCodes.length > 0
        ? this.fetch({ area: area.code, indicators: reportedCodes, latestOnly: true }, ctx)
        : Promise.resolve([]),
      this.fetch(
        {
          area: area.code,
          indicators: indicatorsOf(headlines.map((h) => h.modelledDataset)),
          latestOnly: true,
          timeTo: modelledCutoffYear,
        },
        ctx,
      ),
    ]);

    const indicators = headlines.map((headline): ProfileIndicator => {
      const reported = headline.reportedDataset
        ? this.pick(snapshot, reportedRows, headline, headline.reportedDataset, sex, 'reported')
        : undefined;
      const modelled = this.pick(
        snapshot,
        modelledRows,
        headline,
        headline.modelledDataset,
        sex,
        'modelled_estimate',
      );
      return {
        key: headline.key,
        label: headline.label,
        unit: headline.unit,
        ...(reported && headline.reportedDataset
          ? { reported: reportedValue(snapshot, reported, headline.reportedDataset) }
          : {}),
        ...(modelled ? { modelled: modelledValue(snapshot, modelled, headline) } : {}),
      };
    });

    return {
      area,
      indicators,
      modelledCutoffYear,
      reportedMissing: indicators.filter((entry) => !entry.reported).map((entry) => entry.key),
    };
  }

  /** The headlines this snapshot can serve; an entry whose dataset left the catalog is dropped with a warning. */
  private headlines(snapshot: CatalogSnapshot): ActiveHeadline[] {
    const cached = this.active.get(snapshot);
    if (cached) return cached;
    const active: ActiveHeadline[] = [];
    for (const headline of HEADLINES) {
      const modelledDataset = snapshot.datasets.get(headline.modelled);
      const reportedDataset = headline.reported
        ? snapshot.datasets.get(headline.reported)
        : undefined;
      const modelledIndicator = modelledDataset
        ? snapshot.indicatorsByCode.get(modelledDataset.indicator)
        : undefined;
      if (!modelledDataset || !modelledIndicator || (headline.reported && !reportedDataset)) {
        logger.warning(
          'ILOSTAT profile headline dropped: a dataset it reads is no longer in the catalog.',
          withExtra(requestContextService.createRequestContext({ operation: 'ilostat-profile' }), {
            key: headline.key,
            reported: headline.reported,
            modelled: headline.modelled,
          }),
        );
        continue;
      }
      active.push({
        ...headline,
        modelledDataset,
        modelledCutoff: this.options.catalog.projectionCutoff(modelledIndicator, snapshot),
        ...(reportedDataset ? { reportedDataset } : {}),
      });
    }
    this.active.set(snapshot, active);
    return active;
  }

  private async fetch(
    params: { area: string; indicators: string[]; latestOnly: boolean; timeTo?: number },
    ctx: Context,
  ): Promise<readonly RawObservation[]> {
    const url = this.options.rplumber.refAreaDataUrl(params);
    const cached = this.options.cache.get(url);
    if (cached) return cached;
    const rows = await this.options.rplumber.getRefAreaData(url, ctx);
    this.options.cache.set(url, rows);
    return rows;
  }

  /**
   * The headline slice of one dataset, at its latest period among rows of the
   * wanted basis. Sex applies only to rows that carry it (the labour income share
   * has no sex breakdown).
   */
  private pick(
    snapshot: CatalogSnapshot,
    rows: readonly RawObservation[],
    headline: ActiveHeadline,
    dataset: Dataset,
    sex: ProfileSex,
    basis: 'reported' | 'modelled_estimate',
  ): RawObservation | undefined {
    const cutoff =
      dataset === headline.modelledDataset
        ? headline.modelledCutoff.projectionAfterYear
        : Number.POSITIVE_INFINITY;
    let latest: RawObservation | undefined;
    for (const row of rows) {
      if (row.indicator !== dataset.indicator) continue;
      if (row.sex !== undefined && row.sex !== sex) continue;
      if (row.classif1 !== headline.classif1) continue;
      const rowBasis = classifyRow(
        { sourceLabel: snapshot.sources.get(row.source)?.label, year: periodYear(row.period) },
        cutoff,
      );
      if (rowBasis !== basis) continue;
      if (!latest || row.period > latest.period) latest = row;
    }
    return latest;
  }
}

function statusFields(snapshot: CatalogSnapshot, row: RawObservation) {
  const label = row.obsStatus ? snapshot.obsStatus.get(row.obsStatus)?.label : undefined;
  return {
    ...(row.obsStatus ? { obsStatus: row.obsStatus } : {}),
    ...(label ? { obsStatusLabel: label } : {}),
  };
}

function reportedValue(
  snapshot: CatalogSnapshot,
  row: RawObservation,
  dataset: Dataset,
): ReportedValue {
  const sourceLabel = snapshot.sources.get(row.source)?.label;
  return {
    datasetId: dataset.id,
    period: row.period,
    ...(row.value === undefined ? {} : { value: row.value }),
    source: row.source,
    ...(sourceLabel ? { sourceLabel } : {}),
    ...statusFields(snapshot, row),
    notes: row.notes.map((code) => {
      const label = snapshot.notes.get(code)?.label;
      return { code, ...(label ? { label } : {}) };
    }),
  };
}

function modelledValue(
  snapshot: CatalogSnapshot,
  row: RawObservation,
  headline: ActiveHeadline,
): ModelledValue {
  return {
    datasetId: headline.modelledDataset.id,
    period: row.period,
    ...(row.value === undefined ? {} : { value: row.value }),
    basis: 'modelled_estimate',
    ...statusFields(snapshot, row),
    ...(headline.modelledCutoff.edition ? { edition: headline.modelledCutoff.edition } : {}),
  };
}
