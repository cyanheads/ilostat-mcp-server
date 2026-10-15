/**
 * @fileoverview Observation requests for `ilostat_query_indicator` and
 * `ilostat_compare_geographies`: validation against the catalog, the unfiltered
 * size preflight, the allowlisted `/data/indicator` request, the `latest_only`
 * reduction per series (falling back to upstream's latest year per area when the
 * full history is too large), row decoding and basis classification, running
 * summaries, the response cache, and routing rows inline or onto the canvas. The
 * upstream stream is always aborted once reading stops, so a refusal or an early
 * stop costs one bounded transfer.
 * @module services/observations/observation-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, timeout } from '@cyanheads/mcp-ts-core/errors';
import { ATTRIBUTION } from '@/services/attribution.js';
import { classifyRow } from '@/services/basis/basis.js';
import {
  type CanvasBridge,
  type Provenance,
  type RouteOutcome,
  routeRows,
} from '@/services/canvas-bridge/canvas-bridge.js';
import type { CatalogService } from '@/services/catalog/catalog-service.js';
import {
  breakdownsOf,
  periodFrequency,
  periodYear,
  periodYearsBefore,
} from '@/services/catalog/codes.js';
import type { AreaGroup, CatalogSnapshot, Dataset, Indicator } from '@/services/catalog/types.js';
import type { BestSource, RplumberClient } from '@/services/rplumber/rplumber-client.js';
import type { RawObservation } from '@/services/rplumber/types.js';
import type { IndicatorStructure } from '@/services/structure/sdmx-structure.js';
import type { StructureLookup, StructureService } from '@/services/structure/structure-service.js';
import {
  type Candidate,
  COMPARISON_COLUMNS,
  type CompareMode,
  type CompareSort,
  type Comparison,
  type ComparisonRow,
  compareAreas,
  marksBreak,
  toComparisonRow,
} from './comparison.js';
import { LatestBySeries } from './latest-series.js';
import {
  DatasetIndex,
  decodeObservation,
  OBSERVATION_COLUMNS,
  type ObservationRow,
  ObservationSummary,
  type ResolvedDataset,
  unitLabel,
} from './observation-rows.js';
import {
  assertAggregatesAvailable,
  type FailingContext,
  nameCodes,
  resolveAreaGroup,
  resolveDatasets,
  type ValidCodes,
  validateCodes,
} from './request-validation.js';
import { CACHEABLE_ROWS, type ResponseCache } from './response-cache.js';

export type SourceSelection = 'best' | 'all' | 'secondary';

const BEST_SOURCE: Record<SourceSelection, BestSource> = {
  best: 'yes',
  all: 'all',
  secondary: 'no',
};

/** The sex and breakdown filters, in the order checks and notices walk them. */
const BREAKDOWN_FIELDS = ['sex', 'classif1', 'classif2'] as const;
type BreakdownField = (typeof BREAKDOWN_FIELDS)[number];

/** The validated sex and breakdown codes of a request. */
type BreakdownCodes = Pick<ValidCodes, BreakdownField>;

/** `ilostat_query_indicator` inputs after schema validation; codes not yet normalized. */
export interface QueryRequest {
  areaGroup?: string;
  classif1?: string[];
  classif2?: string[];
  datasetIds: string[];
  latestOnly: boolean;
  refAreas?: string[];
  sex?: string[];
  sourceSelection?: SourceSelection;
  sources?: string[];
  time?: string;
  timeFrom?: string;
  timeTo?: string;
}

/** An area group as echoed: its code, label, and how many member countries it expanded to. */
export interface AreaGroupEcho {
  code: string;
  label: string;
  member_count: number;
}

/** Every parameter a query sent upstream, defaults included. */
export interface QueryAppliedFilters {
  area_group?: AreaGroupEcho;
  best_source: BestSource;
  classif1?: string[];
  classif2?: string[];
  dataset_ids: string[];
  /**
   * How `latest_only` was answered: each series' own latest period, or the
   * fallback to upstream's latest period per area and dataset. Absent without it.
   */
  latest_mode?: 'per_series' | 'latest_year';
  latest_only: boolean;
  /** Areas sent upstream: `ref_areas` plus the `area_group` members. */
  ref_area_count?: number;
  ref_areas?: string[];
  sex?: string[];
  source_selection: SourceSelection;
  sources?: string[];
  time?: string;
  time_from?: string;
  time_to?: string;
}

export type QueryFailReason =
  | 'unknown_dataset'
  | 'unknown_code'
  | 'unknown_area_group'
  | 'aggregates_unavailable'
  | 'invalid_period'
  | 'request_too_broad'
  | 'result_too_large';

export interface QueryResult {
  appliedFilters: QueryAppliedFilters;
  datasets: ResolvedDataset[];
  /** The deferred datasets, not-applicable filter disclosures, units left unresolved, and, on zero rows, the zero-row fragments. */
  notices: string[];
  outcome: Exclude<RouteOutcome<ObservationRow>, { kind: 'too_large' }>;
  /** True when the `latest_only` rows were reduced per series from the full history, read whole before routing. */
  perSeries: boolean;
  /** The inline preview budget applied, in serialized characters. */
  previewChars: number;
  /** Distinct datasets past the first {@link DATASETS_PER_CALL}, in request order; never fetched in this call. */
  remainingDatasetIds: string[];
  summary: ObservationSummary;
}

/** Distinct datasets one query sends upstream — the ILOSTAT API's documented `id` ceiling. */
export const DATASETS_PER_CALL = 3;

/** `ilostat_compare_geographies` inputs after schema validation; codes not yet normalized. */
export interface CompareRequest {
  areaGroup?: string;
  changeYears?: number;
  classif1?: string;
  classif2?: string;
  datasetId: string;
  includeProjections: boolean;
  lookbackYears: number;
  period?: string;
  refAreas?: string[];
  sex?: string;
  sort: CompareSort;
}

export type CompareFailReason =
  | 'unknown_dataset'
  | 'unknown_code'
  | 'unknown_area_group'
  | 'aggregates_unavailable'
  | 'invalid_slice'
  | 'invalid_period'
  | 'structure_unavailable';

/** The slice compared: one sex code and one code per breakdown, with which were defaulted. */
export interface CompareSlice {
  classif1?: string;
  classif2?: string;
  defaulted: BreakdownField[];
  sex?: string;
}

/** Every parameter a comparison sent upstream. */
export interface CompareAppliedFilters {
  area_group?: AreaGroupEcho;
  /** Never sent: upstream applies its preferred-source default. */
  best_source: 'upstream default (yes)';
  classif1?: string;
  classif2?: string;
  dataset_id: string;
  ref_area_count: number;
  ref_areas?: string[];
  sex?: string;
  /** Exact periods requested: period mode without change_years, or its endpoint-only fallback. */
  time?: string[];
  /** First year requested: latest mode's window start, or period mode's change base year. */
  time_from?: number;
  /** Last year requested: the period's year, in period mode with change_years. */
  time_to?: number;
}

/** The time parameters of a comparison's request. */
type CompareTime = Pick<CompareAppliedFilters, 'time' | 'time_from' | 'time_to'>;

export interface CompareResult {
  appliedFilters: CompareAppliedFilters;
  comparison: Comparison;
  dataset: ResolvedDataset;
  mode: CompareMode;
  notices: string[];
  outcome: Exclude<RouteOutcome<ComparisonRow>, { kind: 'too_large' }>;
  /** The inline preview budget applied, in serialized characters. */
  previewChars: number;
  slice: CompareSlice;
  /** Latest mode: the first year the request covered. */
  windowFrom?: number;
}

export interface ObservationServiceOptions {
  /** Absent when dataframes are off; results then stop at the inline preview. */
  bridge?: CanvasBridge;
  cache: ResponseCache;
  catalog: CatalogService;
  /**
   * The time budget across every request one `latest_only` query, or one period
   * comparison with a change, chains. Defaults to {@link LATEST_DEADLINE_MS}.
   */
  latestDeadlineMs?: number;
  /** `ILOSTAT_MAX_ROWS`. */
  maxRows: number;
  now?: () => Date;
  /**
   * The share of that budget the wide first read may take: the per-series
   * full-history read, or a comparison's read of the years between. Defaults to
   * {@link PER_SERIES_READ_MS}.
   */
  perSeriesReadMs?: number;
  /** `ILOSTAT_PREVIEW_CHARS`. */
  previewChars: number;
  rplumber: RplumberClient;
  structure: StructureService;
}

/** A requested dataset resolved for decoding, with the structure lookup it was resolved from. */
interface LookedUpDataset {
  lookup: StructureLookup;
  resolved: ResolvedDataset;
}

/** An upstream row source and the switch that ends its transfer. */
interface RowSource {
  close: () => void;
  rows: AsyncIterable<RawObservation> | Iterable<RawObservation>;
}

/** Provenance datasets, each with the full unit its structure resolved; values are never rescaled. */
const fromCatalog = (datasets: ResolvedDataset[]): Provenance['datasets'] =>
  datasets.map(({ dataset, unit }) => {
    const label = unitLabel(unit);
    return {
      datasetId: dataset.id,
      label: dataset.label,
      lastUpdate: dataset.lastUpdate,
      ...(label ? { unit: label } : {}),
      ...(unit
        ? {
            unitMeasure: unit.measure,
            unitType: unit.type,
            ...(unit.typeLabel ? { unitTypeLabel: unit.typeLabel } : {}),
            unitMultiplier: unit.multiplier,
            ...(unit.multiplierLabel ? { unitMultiplierLabel: unit.multiplierLabel } : {}),
          }
        : {}),
    };
  });

/**
 * The time budget of a call that chains a fallback, under the 60 s request timeout
 * of MCP SDK clients: the wide first read — a `latest_only` query's per-series
 * read, or a period comparison's read of the years between — gets the first 35 s,
 * and the fallback (the latest year per area, or the two periods alone) what
 * remains of 55 s.
 */
const LATEST_DEADLINE_MS = 55_000;
const PER_SERIES_READ_MS = 35_000;

/**
 * `time_from` and `classif1` reliably shrink the history; `sex` turns off the
 * upfront estimate, and one area can hold several times the per-area average, so
 * either alone can still read too much and fall back.
 */
const LATEST_YEAR_NOTICE =
  "latest_only fell back to ILOSTAT's latest period per area and dataset, because this request's full history is too large or too slow to read series by series in one call: a series (one sex, classif1, or classif2 code) whose data ends before its dataset's newest period in an area may be missing. Narrow with time_from or classif1 to get each series' own latest period; sex or fewer ref_areas alone may still read too much and fall back again.";
const LATEST_TIMEOUT_HINT =
  'Narrow the request with time_from or classif1, then call again; sex or fewer ref_areas alone may still read too much.';

/**
 * One deadline across every request a call chains — a `latest_only` query's, or a
 * period comparison's read of the years between and its fallback; at expiry each
 * fails `Timeout`, naming `what` and carrying `hint`.
 */
class CallDeadline {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(ms: number, what: string, hint: string) {
    this.timer = setTimeout(() => {
      this.controller.abort(
        timeout(`${what} did not finish within this call's ${ms / 1000} s time budget.`, {
          recovery: { hint },
        }),
      );
    }, ms);
  }

  get expired(): boolean {
    return this.controller.signal.aborted;
  }

  /** `ctx` for an upstream request bound by the deadline, the caller's signal, and `extra`. */
  scope(ctx: Context, ...extra: AbortSignal[]): Context {
    return { ...ctx, signal: AbortSignal.any([ctx.signal, this.controller.signal, ...extra]) };
  }

  clear(): void {
    clearTimeout(this.timer);
  }
}

const isUpstreamTooLarge = (error: unknown): boolean =>
  error instanceof McpError && error.data?.reason === 'upstream_too_large';

const isTimeoutOrUnavailable = (error: unknown): boolean =>
  error instanceof McpError &&
  (error.code === JsonRpcErrorCode.Timeout || error.code === JsonRpcErrorCode.ServiceUnavailable);

/**
 * Rows a `latest_only` request's full history holds, estimated from the ToC:
 * `n.records` (`n.records.all` beyond the best source) per dataset, scaled by the
 * share of its areas requested and of its years the window keeps. `undefined`
 * when a sex, breakdown, or source filter is set: the ToC cannot size those, so
 * the per-series read itself decides.
 */
function fullHistoryEstimate(
  datasets: readonly Dataset[],
  request: QueryRequest,
  codes: ValidCodes,
  areas: readonly string[],
  bestSource: BestSource,
): number | undefined {
  const sized = [codes.sex, codes.classif1, codes.classif2, codes.sources].every(
    (list) => list.length === 0,
  );
  if (!sized) return;
  return datasets.reduce((sum, dataset) => {
    const rows = bestSource === 'yes' ? dataset.nRecords : dataset.nRecordsAll;
    const areaShare = areas.length > 0 ? Math.min(1, areas.length / dataset.nRefArea) : 1;
    const from = Math.max(dataset.dataStart, Number(request.timeFrom ?? dataset.dataStart));
    const to = Math.min(dataset.dataEnd, Number(request.timeTo ?? dataset.dataEnd));
    const yearShare = Math.max(0, to - from + 1) / (dataset.dataEnd - dataset.dataStart + 1);
    return sum + rows * areaShare * yearShare;
  }, 0);
}

export class ObservationService {
  private readonly latestDeadlineMs: number;
  private readonly now: () => Date;
  private readonly perSeriesReadMs: number;

  constructor(private readonly options: ObservationServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.latestDeadlineMs = options.latestDeadlineMs ?? LATEST_DEADLINE_MS;
    this.perSeriesReadMs = options.perSeriesReadMs ?? PER_SERIES_READ_MS;
  }

  /**
   * Validates and runs one observation query, routing its rows inline or onto
   * the canvas. Every dataset ID is validated; the first
   * {@link DATASETS_PER_CALL} distinct datasets are queried in one request and
   * the rest are returned unfetched. Raises the calling tool's declared reasons
   * through `ctx.fail`.
   */
  async query(
    snapshot: CatalogSnapshot,
    request: QueryRequest,
    ctx: FailingContext<QueryFailReason>,
  ): Promise<QueryResult> {
    const requested = resolveDatasets(snapshot, request.datasetIds, ctx);
    const datasets = requested.slice(0, DATASETS_PER_CALL);
    const remainingDatasetIds = requested.slice(DATASETS_PER_CALL).map((dataset) => dataset.id);
    const group = request.areaGroup
      ? resolveAreaGroup(snapshot, request.areaGroup, ctx)
      : undefined;
    const codes = validateCodes(
      snapshot,
      {
        refAreas: request.refAreas,
        sex: request.sex,
        classif1: request.classif1,
        classif2: request.classif2,
        sources: request.sources,
      },
      ctx,
    );
    // Deferred datasets too, so remaining_dataset_ids always works with the same filters.
    assertAggregatesAvailable(snapshot, codes.refAreas, requested, ctx);
    checkPeriodFrequency(request, requested, ctx);

    const sourceSelection = request.sourceSelection ?? (codes.sources.length > 0 ? 'all' : 'best');
    const bestSource = BEST_SOURCE[sourceSelection];
    const areas = [...new Set([...codes.refAreas, ...(group?.members ?? [])])];
    const unfiltered =
      areas.length === 0 &&
      codes.sex.length === 0 &&
      codes.classif1.length === 0 &&
      codes.classif2.length === 0 &&
      codes.sources.length === 0 &&
      !request.time &&
      !request.timeFrom &&
      !request.timeTo &&
      !request.latestOnly;
    if (unfiltered) {
      const estimate = datasets.reduce(
        (sum, dataset) => sum + (bestSource === 'yes' ? dataset.nRecords : dataset.nRecordsAll),
        0,
      );
      if (estimate > this.options.maxRows) {
        throw ctx.fail(
          'request_too_broad',
          `An unfiltered download of ${datasets.map((d) => d.id).join(', ')} holds ${estimate.toLocaleString('en-US')} rows, over the ${this.options.maxRows.toLocaleString('en-US')}-row ceiling.`,
          {
            estimatedRows: estimate,
            maxRows: this.options.maxRows,
            ...ctx.recoveryFor('request_too_broad'),
          },
        );
      }
    }

    const appliedFilters: QueryAppliedFilters = {
      dataset_ids: datasets.map((dataset) => dataset.id),
      ...(codes.refAreas.length > 0 ? { ref_areas: codes.refAreas } : {}),
      ...(group ? { area_group: echoGroup(group) } : {}),
      ...(areas.length > 0 ? { ref_area_count: areas.length } : {}),
      ...(codes.sex.length > 0 ? { sex: codes.sex } : {}),
      ...(codes.classif1.length > 0 ? { classif1: codes.classif1 } : {}),
      ...(codes.classif2.length > 0 ? { classif2: codes.classif2 } : {}),
      ...(codes.sources.length > 0 ? { sources: codes.sources } : {}),
      ...(request.time ? { time: request.time } : {}),
      ...(request.timeFrom ? { time_from: request.timeFrom } : {}),
      ...(request.timeTo ? { time_to: request.timeTo } : {}),
      latest_only: request.latestOnly,
      source_selection: sourceSelection,
      best_source: bestSource,
    };

    /** The request URL; `latestYear` sends upstream's latest-period-per-area filter. */
    const urlFor = (latestYear: boolean) =>
      this.options.rplumber.indicatorDataUrl({
        datasetIds: appliedFilters.dataset_ids,
        refAreas: areas,
        sex: codes.sex,
        classif1: codes.classif1,
        classif2: codes.classif2,
        sources: codes.sources,
        ...(request.time ? { time: [request.time] } : {}),
        ...(request.timeFrom ? { timeFrom: Number(request.timeFrom) } : {}),
        ...(request.timeTo ? { timeTo: Number(request.timeTo) } : {}),
        latestOnly: latestYear,
        bestSource,
      });
    // latest_only reduces the full history per series, unless the ToC already sizes that history past the ceiling.
    let latestYear =
      request.latestOnly &&
      (fullHistoryEstimate(datasets, request, codes, areas, bestSource) ?? 0) >
        this.options.maxRows;

    const resolving = this.resolveDatasets(snapshot, datasets, ctx);
    // Awaited once the rows open, so a rows failure reports first; handled now so an earlier lookup rejection never goes unhandled.
    resolving.catch(() => undefined);
    const deadline = request.latestOnly
      ? new CallDeadline(this.latestDeadlineMs, 'latest_only', LATEST_TIMEOUT_HINT)
      : undefined;
    const sources: RowSource[] = [];
    try {
      let rows: AsyncIterable<RawObservation> | Iterable<RawObservation> | undefined;
      if (deadline && !latestYear) {
        rows = await this.latestPerSeries(urlFor(false), ctx, deadline, sources);
        latestYear = rows === undefined;
      }
      if (!rows) {
        const source = await this.openRows(urlFor(latestYear), deadline?.scope(ctx) ?? ctx);
        sources.push(source);
        rows = source.rows;
      }
      if (request.latestOnly)
        appliedFilters.latest_mode = latestYear ? 'latest_year' : 'per_series';
      const lookedUp = await resolving;
      const resolved = lookedUp.map((entry) => entry.resolved);
      const index = new DatasetIndex(resolved);
      const summary = new ObservationSummary();
      const raws = rows;
      const decode = (raw: RawObservation) => {
        const row = decodeObservation(raw, snapshot, index.find(raw));
        summary.add(row);
        return row;
      };
      // Per-series rows are already held whole, so row_count and the summary count every one past a preview cut.
      const perSeries = request.latestOnly && !latestYear;
      const decoded =
        perSeries && Array.isArray(raws)
          ? raws.map(decode)
          : (async function* () {
              for await (const raw of raws) yield decode(raw);
            })();

      const outcome = await routeRows(this.options.bridge, {
        ctx,
        source: decoded,
        schema: OBSERVATION_COLUMNS,
        previewChars: this.options.previewChars,
        maxRows: this.options.maxRows,
        provenance: () => ({
          sourceTool: 'ilostat_query_indicator',
          queryParams: { ...appliedFilters },
          datasets: fromCatalog(resolved),
          coverage: {
            refAreas: summary.refAreas,
            ...(summary.periodMin ? { periodMin: summary.periodMin } : {}),
            ...(summary.periodMax ? { periodMax: summary.periodMax } : {}),
          },
          basisCounts: { ...summary.basisCounts },
          attribution: ATTRIBUTION,
        }),
      });
      if (outcome.kind === 'too_large') {
        throw ctx.fail(
          'result_too_large',
          `The result passed the ${this.options.maxRows.toLocaleString('en-US')}-row ceiling; nothing was staged.`,
          { maxRows: this.options.maxRows, ...ctx.recoveryFor('result_too_large') },
        );
      }

      const notices = [
        ...deferredNotices(remainingDatasetIds),
        ...(latestYear ? [LATEST_YEAR_NOTICE] : []),
        ...notApplicableNotices(datasets, codes),
        ...unitNotices(resolved),
      ];
      if (summary.rows === 0) {
        notices.push(...zeroRowFragments(lookedUp, codes, request, areas, sourceSelection));
      }
      return {
        appliedFilters,
        datasets: resolved,
        notices,
        outcome,
        perSeries,
        previewChars: this.options.previewChars,
        remainingDatasetIds,
        summary,
      };
    } finally {
      for (const source of sources) source.close();
      deadline?.clear();
    }
  }

  /**
   * The `latest_only` rows of `url`'s full history, reduced per series. Gives up
   * — `undefined`, and the caller falls back to upstream's latest year per area —
   * when more than `ILOSTAT_MAX_ROWS` rows arrive, the body passes its byte cap,
   * stalls or drops mid-response, or the read outlasts its share of the call's
   * time budget. The call deadline, the caller's cancellation, and every failure
   * before the body propagate.
   */
  private async latestPerSeries(
    url: string,
    ctx: Context,
    deadline: CallDeadline,
    sources: RowSource[],
  ): Promise<RawObservation[] | undefined> {
    const budget = AbortSignal.timeout(this.perSeriesReadMs);
    let source: RowSource | undefined;
    try {
      source = await this.openRows(url, deadline.scope(ctx, budget));
      sources.push(source);
      const latest = new LatestBySeries();
      for await (const raw of source.rows) {
        latest.add(raw);
        if (latest.read > this.options.maxRows) {
          source.close();
          return;
        }
      }
      return latest.rows();
    } catch (error) {
      if (deadline.expired || ctx.signal.aborted) throw error;
      // A body that stalls or drops is far more exposed on a full history than on the latestyear body.
      const failedMidBody = source !== undefined && isTimeoutOrUnavailable(error);
      if (!budget.aborted && !isUpstreamTooLarge(error) && !failedMidBody) throw error;
      source?.close();
      return;
    }
  }

  /**
   * Validates and runs one comparison: one dataset, one slice (defaulted to the
   * dataset's totals), each area's value at a period or its latest non-projected
   * period, and the comparison rows routed inline or onto the canvas.
   */
  async compare(
    snapshot: CatalogSnapshot,
    request: CompareRequest,
    ctx: FailingContext<CompareFailReason>,
  ): Promise<CompareResult> {
    const [dataset] = resolveDatasets(snapshot, [request.datasetId], ctx);
    if (!dataset) throw new Error('resolveDatasets returned no dataset for one ID.');
    const group = request.areaGroup
      ? resolveAreaGroup(snapshot, request.areaGroup, ctx)
      : undefined;
    const codes = validateCodes(
      snapshot,
      {
        refAreas: request.refAreas,
        ...(request.sex ? { sex: [request.sex] } : {}),
        ...(request.classif1 ? { classif1: [request.classif1] } : {}),
        ...(request.classif2 ? { classif2: [request.classif2] } : {}),
      },
      ctx,
    );
    assertAggregatesAvailable(snapshot, codes.refAreas, [dataset], ctx);
    if (request.period && periodFrequency(request.period) !== dataset.frequency) {
      throw ctx.fail(
        'invalid_period',
        `period ${request.period} does not match ${dataset.id}, whose frequency is ${dataset.frequency}.`,
        {
          period: request.period,
          frequency: dataset.frequency,
          ...ctx.recoveryFor('invalid_period'),
        },
      );
    }

    checkSliceBreakdowns(dataset, codes, ctx);
    const lookup = await this.lookupStructure(snapshot, dataset, ctx);
    const slice = resolveSlice(dataset, codes, lookup, ctx);
    const areas = [...new Set([...codes.refAreas, ...(group?.members ?? [])])];

    const latestFrom = this.now().getUTCFullYear() - request.lookbackYears;
    const { period } = request;
    const mode: CompareMode = period
      ? { kind: 'period', period }
      : { kind: 'latest', includeProjections: request.includeProjections, fromYear: latestFrom };
    const changeBase =
      period && request.changeYears ? periodYearsBefore(period, request.changeYears) : undefined;
    // Latest mode reaches change_years further back for the change base; the latest value stays within fromYear.
    // Period mode with a change reads the years from the change base to the period, so breaks between them show.
    let time: CompareTime = !period
      ? { time_from: latestFrom - (request.changeYears ?? 0) }
      : changeBase
        ? { time_from: periodYear(changeBase), time_to: periodYear(period) }
        : { time: [period] };
    const windowFrom = period ? undefined : time.time_from;
    const urlFor = (filters: CompareTime) =>
      this.options.rplumber.indicatorDataUrl({
        datasetIds: [dataset.id],
        refAreas: areas,
        ...(slice.sex ? { sex: [slice.sex] } : {}),
        ...(slice.classif1 ? { classif1: [slice.classif1] } : {}),
        ...(slice.classif2 ? { classif2: [slice.classif2] } : {}),
        ...(filters.time ? { time: filters.time } : {}),
        ...(filters.time_from === undefined ? {} : { timeFrom: filters.time_from }),
        ...(filters.time_to === undefined ? {} : { timeTo: filters.time_to }),
      });

    const resolved = this.resolve(snapshot, dataset, lookup);
    // Period mode reads only the two endpoints and the break-marked rows between them.
    const keep = period
      ? (raw: RawObservation) =>
          raw.period === period || raw.period === changeBase || marksBreak(raw)
      : undefined;
    const read = (scope: Context) =>
      this.readCandidates(urlFor(time), snapshot, resolved, scope, keep);
    let candidates: Map<string, Candidate[]>;
    let endpointsOnly = false;
    if (changeBase && period) {
      // The years between get the first share of one deadline; the two periods alone, what remains.
      const deadline = new CallDeadline(
        this.latestDeadlineMs,
        'The comparison',
        'Narrow ref_areas or area_group, or lower change_years, then call again.',
      );
      try {
        const budget = AbortSignal.timeout(this.perSeriesReadMs);
        try {
          candidates = await read(deadline.scope(ctx, budget));
        } catch (error) {
          const outlasted = budget.aborted && !deadline.expired && !ctx.signal.aborted;
          if (!outlasted && !isUpstreamTooLarge(error)) throw error;
          time = { time: [period, changeBase] };
          endpointsOnly = true;
          candidates = await read(deadline.scope(ctx));
        }
      } finally {
        deadline.clear();
      }
    } else {
      candidates = await read(ctx);
    }
    const appliedFilters: CompareAppliedFilters = {
      dataset_id: dataset.id,
      ...(codes.refAreas.length > 0 ? { ref_areas: codes.refAreas } : {}),
      ...(group ? { area_group: echoGroup(group) } : {}),
      ref_area_count: areas.length,
      ...(slice.sex ? { sex: slice.sex } : {}),
      ...(slice.classif1 ? { classif1: slice.classif1 } : {}),
      ...(slice.classif2 ? { classif2: slice.classif2 } : {}),
      ...time,
      best_source: 'upstream default (yes)',
    };

    const coveredAreas =
      lookup.status === 'complete' && lookup.structure
        ? new Set(lookup.structure.refAreas)
        : undefined;
    const comparison = compareAreas({
      areas,
      candidates,
      mode,
      sort: request.sort,
      decode: (raw) => decodeObservation(raw, snapshot, resolved),
      ...(endpointsOnly ? { betweenRead: false } : {}),
      ...(request.changeYears === undefined ? {} : { changeYears: request.changeYears }),
      ...(coveredAreas ? { coveredAreas } : {}),
    });
    const notices = comparisonNotices(comparison);
    if (endpointsOnly) {
      notices.push(
        `The periods from ${changeBase} to ${period} were too many to read within this call's size and time limits, so only ${changeBase} and ${period} were read: break_in_series is true where the current value marks a break and null elsewhere, since a break between them is unknown. Narrow ref_areas or area_group, or lower change_years, to check the periods between.`,
      );
    }
    if (!coveredAreas) {
      notices.push(
        `The area list of ${dataset.id} is unavailable from the ILOSTAT structure service, so no missing area is marked not_covered, even one ${dataset.id} does not cover.`,
      );
    }
    notices.push(...unitNotices([resolved]));

    const stagedRows = comparison.entries.map(toComparisonRow);
    const outcome = await routeRows(this.options.bridge, {
      ctx,
      source: stagedRows,
      schema: COMPARISON_COLUMNS,
      previewChars: this.options.previewChars,
      provenance: () => ({
        sourceTool: 'ilostat_compare_geographies',
        queryParams: { ...appliedFilters },
        datasets: fromCatalog([resolved]),
        coverage: {
          refAreas: comparison.entries.length,
          ...(comparison.periods.length > 0
            ? {
                periodMin: comparison.periods[comparison.periods.length - 1],
                periodMax: comparison.periods[0],
              }
            : {}),
        },
        basisCounts: { ...comparison.basisCounts },
        attribution: ATTRIBUTION,
      }),
    });
    if (outcome.kind === 'too_large') {
      throw new Error(
        'A comparison has one row per area and never reaches the staging row budget.',
      );
    }

    return {
      appliedFilters,
      comparison,
      dataset: resolved,
      mode,
      notices,
      outcome,
      previewChars: this.options.previewChars,
      slice,
      ...(windowFrom === undefined ? {} : { windowFrom }),
    };
  }

  /** A comparison's rows with a value, per area, classed by basis; `keep` drops rows it never reads. */
  private async readCandidates(
    url: string,
    snapshot: CatalogSnapshot,
    resolved: ResolvedDataset,
    ctx: Context,
    keep?: (raw: RawObservation) => boolean,
  ): Promise<Map<string, Candidate[]>> {
    const candidates = new Map<string, Candidate[]>();
    const source = await this.openRows(url, ctx);
    try {
      for await (const raw of source.rows) {
        if (raw.value === undefined || (keep && !keep(raw))) continue;
        const basis = classifyRow(
          { sourceLabel: snapshot.sources.get(raw.source)?.label, year: periodYear(raw.period) },
          resolved.cutoff.projectionAfterYear,
        );
        const list = candidates.get(raw.refArea) ?? [];
        list.push({ basis, raw: { ...raw, value: raw.value } });
        candidates.set(raw.refArea, list);
      }
    } finally {
      source.close();
    }
    return candidates;
  }

  /**
   * Cutoff and unit per dataset, with the structure lookup they came from, looked
   * up in parallel; a unit that does not resolve is left absent. Rejects as
   * `lookupStructure` does.
   */
  private resolveDatasets(
    snapshot: CatalogSnapshot,
    datasets: readonly Dataset[],
    ctx: Context,
  ): Promise<LookedUpDataset[]> {
    return Promise.all(
      datasets.map(async (dataset) => {
        const lookup = await this.lookupStructure(snapshot, dataset, ctx);
        return { lookup, resolved: this.resolve(snapshot, dataset, lookup) };
      }),
    );
  }

  private resolve(
    snapshot: CatalogSnapshot,
    dataset: Dataset,
    lookup: StructureLookup,
  ): ResolvedDataset {
    return {
      dataset,
      cutoff: this.options.catalog.projectionCutoff(indicatorOf(snapshot, dataset), snapshot),
      ...(lookup.unit ? { unit: lookup.unit } : {}),
    };
  }

  /**
   * The cached SDMX structure of a dataset's indicator. An SDMX outage or a
   * missing dataflow comes back `unavailable`; the lookup rejects only for this
   * server's own fault (an SDMX 422 on the probe key), the caller's cancellation,
   * or shutdown, and those fail the call.
   */
  private lookupStructure(
    snapshot: CatalogSnapshot,
    dataset: Dataset,
    ctx: Context,
  ): Promise<StructureLookup> {
    const indicator = indicatorOf(snapshot, dataset);
    return this.options.structure.lookup(indicator.code, indicator.lastUpdate, ctx);
  }

  /**
   * Rows for `url`: from the response cache, or streamed from upstream and
   * cached when the whole response was read and held at most 5,000 rows.
   */
  private async openRows(url: string, ctx: Context): Promise<RowSource> {
    const cached = this.options.cache.get(url);
    if (cached) return { rows: cached, close: () => undefined };
    const controller = new AbortController();
    const upstream = await this.options.rplumber.streamIndicatorData(
      url,
      ctx,
      controller.signal,
      this.options.maxRows,
    );
    const cache = this.options.cache;
    return {
      rows: (async function* () {
        let buffer: RawObservation[] | undefined = [];
        for await (const raw of upstream) {
          if (buffer) {
            buffer.push(raw);
            if (buffer.length > CACHEABLE_ROWS) buffer = undefined;
          }
          yield raw;
        }
        if (buffer) cache.set(url, buffer);
      })(),
      close: () => controller.abort(),
    };
  }
}

/** The indicator a catalog dataset belongs to — every dataset is grouped under one. */
function indicatorOf(snapshot: CatalogSnapshot, dataset: Dataset): Indicator {
  const indicator = snapshot.indicatorsByCode.get(dataset.indicator);
  if (!indicator) throw new Error(`Catalog dataset ${dataset.id} has no indicator entry.`);
  return indicator;
}

/**
 * The period checks that need no catalog: `time` excludes a range and
 * `latest_only`, and a range runs forward. Run before the catalog wait, so a
 * caller's conflicting periods are never answered with a catalog outage. A
 * malformed period never gets here — the schema pattern rejects it first.
 */
export function checkPeriodCombination(
  request: Pick<QueryRequest, 'latestOnly' | 'time' | 'timeFrom' | 'timeTo'>,
  ctx: FailingContext<'invalid_period'>,
): void {
  if (request.time && (request.timeFrom || request.timeTo || request.latestOnly)) {
    throw ctx.fail(
      'invalid_period',
      'time names one exact period, so it cannot be combined with time_from, time_to, or latest_only.',
      { ...ctx.recoveryFor('invalid_period') },
    );
  }
  if (request.timeFrom && request.timeTo && request.timeFrom > request.timeTo) {
    throw ctx.fail(
      'invalid_period',
      `time_from ${request.timeFrom} is after time_to ${request.timeTo}.`,
      { ...ctx.recoveryFor('invalid_period') },
    );
  }
}

/** A sub-annual `time` needs every requested dataset at that frequency. */
function checkPeriodFrequency(
  request: QueryRequest,
  datasets: readonly Dataset[],
  ctx: FailingContext<'invalid_period'>,
): void {
  if (!request.time) return;
  const frequency = periodFrequency(request.time);
  const mismatched = datasets.filter((dataset) => dataset.frequency !== frequency);
  if (frequency !== 'A' && mismatched.length > 0) {
    throw ctx.fail(
      'invalid_period',
      `time ${request.time} is a ${frequency === 'Q' ? 'quarterly' : 'monthly'} period, but ${mismatched.map((d) => `${d.id} (${d.frequency})`).join(', ')} ${mismatched.length === 1 ? 'is' : 'are'} not at that frequency.`,
      { ...ctx.recoveryFor('invalid_period') },
    );
  }
}

/**
 * A code for a breakdown the dataset lacks fails `invalid_slice`. Needs no SDMX
 * structure, so it runs before the lookup starts.
 */
function checkSliceBreakdowns(
  dataset: Dataset,
  codes: BreakdownCodes,
  ctx: FailingContext<'invalid_slice'>,
): void {
  const has = breakdownsOf(dataset.classification);
  const lacking = BREAKDOWN_FIELDS.filter((field) => codes[field].length > 0 && !has[field]);
  if (lacking.length > 0) {
    throw ctx.fail(
      'invalid_slice',
      `${dataset.id} has no ${lacking.join(' or ')} breakdown, so ${lacking.join(' and ')} cannot be set.`,
      { datasetId: dataset.id, fields: lacking, ...ctx.recoveryFor('invalid_slice') },
    );
  }
}

/**
 * The compared slice. `sex` defaults to SEX_T on a dataset with a sex breakdown;
 * `classif1`/`classif2` default to the dataset's total codes from its SDMX default
 * view. A breakdown needing a default while the structure is unavailable fails
 * `structure_unavailable`, naming every such breakdown; one with no total and no
 * code given fails `invalid_slice`.
 */
function resolveSlice(
  dataset: Dataset,
  codes: BreakdownCodes,
  lookup: StructureLookup,
  ctx: FailingContext<'invalid_slice' | 'structure_unavailable'>,
): CompareSlice {
  const has = breakdownsOf(dataset.classification);
  const slice: CompareSlice = { defaulted: [] };
  const sex = codes.sex[0];
  if (sex) slice.sex = sex;
  else if (has.sex) {
    slice.sex = 'SEX_T';
    slice.defaulted.push('sex');
  }
  for (const slot of ['classif1', 'classif2'] as const) {
    const code = codes[slot][0];
    if (code) slice[slot] = code;
  }
  const undefaulted = (['classif1', 'classif2'] as const).filter(
    (slot) => has[slot] && !slice[slot],
  );
  if (undefaulted.length === 0) return slice;

  const structure = lookup.status === 'complete' ? lookup.structure : undefined;
  if (!structure) {
    throw ctx.fail(
      'structure_unavailable',
      `The total codes of ${dataset.id} could not be read from the ILOSTAT structure service, so ${undefaulted.join(' and ')} ${undefaulted.length > 1 ? 'have' : 'has'} no default.`,
      { datasetId: dataset.id, fields: undefaulted, ...ctx.recoveryFor('structure_unavailable') },
    );
  }
  for (const slot of undefaulted) {
    const total = structure.defaultSlice[slot];
    if (!total) {
      throw ctx.fail(
        'invalid_slice',
        `The ${slot} breakdown of ${dataset.id} has no total code, so a ${slot} code must be given.`,
        { datasetId: dataset.id, field: slot, ...ctx.recoveryFor('invalid_slice') },
      );
    }
    slice[slot] = total;
    slice.defaulted.push(slot);
  }
  return slice;
}

function echoGroup(group: AreaGroup): AreaGroupEcho {
  return { code: group.code, label: group.label, member_count: group.members.length };
}

/** Names the datasets left for another call, up to ten and then a count. */
function deferredNotices(remaining: readonly string[]): string[] {
  const count = remaining.length;
  if (count === 0) return [];
  return [
    `Queried the first ${DATASETS_PER_CALL} distinct datasets; ${count} more ${count === 1 ? 'was' : 'were'} not fetched: ${nameCodes(remaining)}. Call ilostat_query_indicator again with dataset_ids set to remaining_dataset_ids and the same filters to get ${count === 1 ? 'it' : 'them'}.`,
  ];
}

/** Discloses each breakdown filter a requested dataset cannot apply — upstream returns its rows unfiltered. */
function notApplicableNotices(datasets: readonly Dataset[], codes: BreakdownCodes): string[] {
  const notices: string[] = [];
  for (const field of BREAKDOWN_FIELDS) {
    if (codes[field].length === 0) continue;
    for (const dataset of datasets) {
      if (breakdownsOf(dataset.classification)[field]) continue;
      notices.push(
        `${field} does not apply to ${dataset.id}, which has no ${field} breakdown; its rows are not narrowed by it.`,
      );
    }
  }
  return notices;
}

/** Names the datasets whose unit the SDMX lookup could not supply, as describe's structure notice does. */
function unitNotices(datasets: readonly ResolvedDataset[]): string[] {
  const ids = datasets.filter((entry) => !entry.unit).map((entry) => entry.dataset.id);
  return ids.length > 0
    ? [
        `The unit of ${ids.join(', ')} is unavailable from the ILOSTAT structure service; the dataset label's parenthetical — (%) or (thousands) — gives it.`,
      ]
    : [];
}

/** The codes a structure lists for one filter; `undefined` when it has no such dimension. */
function structureCodes(
  structure: IndicatorStructure,
  field: BreakdownField,
): Set<string> | undefined {
  const codes =
    field === 'sex' ? structure.sexCodes : structure[field]?.codes.map((code) => code.code);
  return codes ? new Set(codes) : undefined;
}

/** The years a request's period filters span; `undefined` when it sets none. */
function requestedYears(request: QueryRequest): { from: number; to: number } | undefined {
  if (request.time) return { from: periodYear(request.time), to: periodYear(request.time) };
  if (!request.timeFrom && !request.timeTo) return;
  return {
    from: request.timeFrom ? Number(request.timeFrom) : Number.NEGATIVE_INFINITY,
    to: request.timeTo ? Number(request.timeTo) : Number.POSITIVE_INFINITY,
  };
}

/**
 * Why a query matched nothing, naming only causes that can hold: a code or area
 * the dataset's SDMX structure does not list, a window outside its coverage, a
 * named source under `best`, and `secondary` with no secondary source. Without a
 * structure, a code or area filter is named as a possible cause, since it cannot
 * be checked.
 */
function zeroRowFragments(
  datasets: readonly LookedUpDataset[],
  codes: ValidCodes,
  request: QueryRequest,
  areas: readonly string[],
  sourceSelection: SourceSelection,
): string[] {
  const fragments: string[] = [];
  const years = requestedYears(request);
  for (const {
    lookup: { structure },
    resolved: { dataset },
  } of datasets) {
    const has = breakdownsOf(dataset.classification);
    const unused: string[] = [];
    const unchecked: string[] = [];
    for (const field of BREAKDOWN_FIELDS) {
      if (!has[field]) continue;
      const inUse = structure && structureCodes(structure, field);
      if (inUse) unused.push(...codes[field].filter((code) => !inUse.has(code)));
      else unchecked.push(...codes[field]);
    }
    const listsCodes = `ilostat_describe_indicator ${dataset.id} lists the codes it uses.`;
    if (unused.length > 0) {
      fragments.push(`${dataset.id} does not use ${unused.join(', ')} — ${listsCodes}`);
    }
    if (unchecked.length > 0) {
      fragments.push(`${dataset.id} may not use ${unchecked.join(', ')} — ${listsCodes}`);
    }
    if (years && (years.to < dataset.dataStart || years.from > dataset.dataEnd)) {
      fragments.push(
        `${dataset.id} covers ${dataset.dataStart}–${dataset.dataEnd}; widen time_from/time_to or drop time.`,
      );
    }
    if (areas.length > 0) {
      const listsAreas = 'ilostat_describe_indicator lists the areas it covers.';
      const covered = structure && new Set(structure.refAreas);
      const uncovered = covered ? areas.filter((area) => !covered.has(area)) : [];
      if (!covered) {
        fragments.push(`Some requested areas have no ${dataset.id} data — ${listsAreas}`);
      } else if (uncovered.length > 0) {
        fragments.push(
          `${nameCodes(uncovered)} ${uncovered.length === 1 ? 'has' : 'have'} no ${dataset.id} data — ${listsAreas}`,
        );
      }
    }
  }
  if (codes.sources.length > 0 && sourceSelection === 'best') {
    fragments.push(
      'source_selection best keeps only the preferred source of each area and period, so a secondary source named in sources returns nothing; use source_selection all.',
    );
  }
  if (sourceSelection === 'secondary') {
    fragments.push(
      'No secondary sources exist for this request; use source_selection best or all.',
    );
  }
  if (fragments.length === 0) {
    fragments.push('The request matched no observations.');
  }
  return fragments;
}

/** Mixed periods, mixed bases, changes across a source, basis, or series change, and missing areas — flagged, not hidden. */
function comparisonNotices(comparison: Comparison): string[] {
  const notices: string[] = [];
  if (comparison.mixedPeriods) {
    const newest = comparison.periods[0];
    const oldest = comparison.periods[comparison.periods.length - 1];
    notices.push(
      `Values span ${comparison.periods.length} periods, ${oldest} to ${newest}; pass period for a like-for-like comparison.`,
    );
  }
  const modelled = comparison.basisCounts.modelled_estimate + comparison.basisCounts.projection;
  const { reported } = comparison.basisCounts;
  if (modelled > 0 && reported > 0) {
    notices.push(
      `${modelled} ${modelled === 1 ? 'value is an ILO modelled estimate' : 'values are ILO modelled estimates'} and ${reported} ${reported === 1 ? 'is' : 'are'} reported; they are not directly comparable.`,
    );
  }
  const changes = comparison.entries.flatMap((entry) => (entry.change ? [entry.change] : []));
  const flagged = changes.filter(
    (change) => change.sourceChanged || change.basisChanged || change.breakInSeries,
  );
  if (flagged.length > 0) {
    const count = (flag: 'sourceChanged' | 'basisChanged' | 'breakInSeries') =>
      flagged.filter((change) => change[flag]).length;
    notices.push(
      `${flagged.length} of ${changes.length} ${changes.length === 1 ? 'change' : 'changes'} ${flagged.length === 1 ? 'is' : 'are'} not like-for-like (source changed ${count('sourceChanged')}, basis changed ${count('basisChanged')}, break in series ${count('breakInSeries')}); each row's change says which.`,
    );
  }
  const missing = comparison.missing.length;
  if (missing > 0) {
    notices.push(`${missing} ${missing === 1 ? 'area has' : 'areas have'} no value; see missing.`);
  }
  return notices;
}
