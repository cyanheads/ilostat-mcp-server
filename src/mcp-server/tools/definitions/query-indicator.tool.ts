/**
 * @fileoverview `ilostat_query_indicator` — observations for up to three ILOSTAT
 * datasets per call (up to 100 IDs are validated; those past the first three
 * distinct datasets are returned unfetched), filtered by area or area group, sex,
 * breakdown codes, source, and period. Every code is checked against the catalog
 * dictionaries before the request is sent; rows keep their source, status, notes,
 * and basis, and come back a page at a time (`limit` from `offset`, continued by
 * `next_offset`); a first page whose result passes the staging threshold
 * (`ILOSTAT_PREVIEW_CHARS`) is also staged in full as a `df_<id>` dataframe.
 * @module mcp-server/tools/definitions/query-indicator
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  AreaGroupEchoSchema,
  BasisCountsSchema,
  DataframeSchema,
  DatasetMetaSchema,
  datasetMeta,
  renderAreaGroup,
  renderBasisCounts,
  renderDataframe,
  renderDatasetMeta,
  stagedDataframe,
} from '@/mcp-server/tools/observation-output.js';
import {
  AREA_GROUP_MESSAGE,
  areaCodeInput,
  blankAsUnset,
  blankFreeArray,
  datasetIdInput,
  periodInput,
  REF_AREA_MESSAGE,
  sexCodeInput,
  splitIdArray,
  yearInput,
} from '@/mcp-server/tools/tool-helpers.js';
import { ATTRIBUTION } from '@/services/attribution.js';
import { BASES } from '@/services/basis/basis.js';
import { dataframeNotice } from '@/services/canvas-bridge/canvas-bridge.js';
import { inlineText } from '@/services/catalog/text.js';
import { getIlostatServices } from '@/services/ilostat-services.js';
import { legendOf, toInlineRow } from '@/services/observations/observation-rows.js';
import {
  AREA_WITHOUT_ROWS_REASONS,
  checkPeriodCombination,
  DATASETS_PER_CALL,
  type QueryAppliedFilters,
  type QueryRequest,
  type QueryResult,
} from '@/services/observations/observation-service.js';

/** Hard ceiling on dataset_ids, counted after the + and , split. */
const MAX_DATASET_IDS = 100;

/** Rows one page returns, about 1 MB of `structuredContent`; a larger `limit` is applied as this. */
const PAGE_CAP = 5_000;

const count = (n: number) => n.toLocaleString('en-US');

const CodeMapSchema = (what: string) =>
  z.record(z.string(), z.string()).describe(`${what} code → label, for every code in rows.`);

const AppliedFiltersSchema = z
  .object({
    dataset_ids: z.array(z.string()).describe('Datasets queried — at most 3.'),
    ref_areas: z.array(z.string()).optional().describe('Reference areas given, normalized.'),
    area_group: AreaGroupEchoSchema,
    ref_area_count: z
      .number()
      .optional()
      .describe('Areas sent upstream: ref_areas plus the area_group members.'),
    sex: z.array(z.string()).optional().describe('Sex codes sent.'),
    classif1: z.array(z.string()).optional().describe('classif1 codes sent.'),
    classif2: z.array(z.string()).optional().describe('classif2 codes sent.'),
    sources: z.array(z.string()).optional().describe('Source codes sent.'),
    time: z.string().optional().describe('Exact period sent.'),
    time_from: z.string().optional().describe('First year sent.'),
    time_to: z.string().optional().describe('Last year sent.'),
    latest_only: z.boolean().describe("Whether only each series' latest period was requested."),
    latest_mode: z
      .enum(['per_series', 'latest_year'])
      .optional()
      .describe(
        "How latest_only was answered: per_series, each series' own latest period; latest_year, the fallback to the latest period per area and dataset, which can miss a series that ends earlier. Absent without latest_only.",
      ),
    source_selection: z
      .enum(['best', 'all', 'secondary'])
      .describe('Source selection applied (all when sources were given without one).'),
    best_source: z.enum(['yes', 'all', 'no']).describe('The upstream best_source value sent.'),
  })
  .describe('Every parameter sent upstream, defaults included.');

function renderAppliedFilters(filters: QueryAppliedFilters): string {
  const parts = [`datasets ${filters.dataset_ids.join(', ')}`];
  if (filters.ref_areas) parts.push(`ref_areas ${filters.ref_areas.join(', ')}`);
  if (filters.area_group) parts.push(renderAreaGroup(filters.area_group));
  if (filters.ref_area_count !== undefined) {
    parts.push(`${filters.ref_area_count} ${filters.ref_area_count === 1 ? 'area' : 'areas'} sent`);
  }
  for (const field of ['sex', 'classif1', 'classif2', 'sources'] as const) {
    const codes = filters[field];
    if (codes) parts.push(`${field} ${codes.join(', ')}`);
  }
  if (filters.time) parts.push(`time ${filters.time}`);
  if (filters.time_from) parts.push(`time_from ${filters.time_from}`);
  if (filters.time_to) parts.push(`time_to ${filters.time_to}`);
  parts.push(`latest_only ${filters.latest_only}`);
  if (filters.latest_mode) parts.push(`latest_mode ${filters.latest_mode}`);
  parts.push(`source_selection ${filters.source_selection} (best_source=${filters.best_source})`);
  return `**Applied filters:** ${parts.join(' · ')}`;
}

/**
 * How to reach the next page. When the read passed the row ceiling, a next page
 * reaching past it is refused as `result_too_large`, so the guidance names the
 * ceiling instead: the limit that still reads up to it, or narrowing.
 */
function nextPageGuidance(next: number, limit: number, total: number, maxRows: number): string {
  if (total <= maxRows || next + limit <= maxRows) {
    return 'Pass next_offset as offset, with the same other arguments, for the next page.';
  }
  const narrow = `narrow the request (fewer reference areas, a shorter time window, or specific sex or classif1 codes) to read rows past ${count(maxRows)}.`;
  return next < maxRows
    ? `The next page would reach past the ${count(maxRows)}-row ceiling: pass next_offset as offset with limit ${count(maxRows - next)} for the rows up to it, or ${narrow}`
    : `Rows past the ${count(maxRows)}-row ceiling are not read; ${narrow}`;
}

/**
 * Which rows a page holds, why a first page whose result passes the staging
 * threshold was not staged, and how to reach the next page; absent when a first
 * page holds the whole result. `total` is the result's row count, a lower bound
 * unless `complete`.
 */
function pageNotice(
  outcome: QueryResult['outcome'],
  offset: number,
  limit: number,
  total: number,
  complete: boolean,
  maxRows: number,
): string | undefined {
  const shown = outcome.rows.length;
  if (shown === 0) {
    return offset > 0 && total > 0
      ? `offset ${offset} is past the end of the result, which holds ${count(total)} ${total === 1 ? 'row' : 'rows'}.`
      : undefined;
  }
  const cause = outcome.kind === 'page' ? outcome.cause : undefined;
  if (offset === 0 && outcome.nextOffset === undefined && !cause) return;
  return [
    `Showing rows ${count(offset + 1)}–${count(offset + shown)} of ${complete ? '' : 'at least '}${count(total)}.`,
    ...(cause === 'canvas_off'
      ? ['Dataframes are off in this deployment, so the result is not staged for SQL.']
      : []),
    ...(cause === 'canvas_failed'
      ? ['Staging the full result as a dataframe failed; call again with offset 0 to retry it.']
      : []),
    ...(cause === 'past_ceiling'
      ? [
          `The result passes the ${count(maxRows)}-row ceiling, so it is not staged for SQL; narrow the request (fewer reference areas, a shorter time window, or specific sex or classif1 codes) to stage it.`,
        ]
      : []),
    ...(outcome.nextOffset === undefined
      ? []
      : [nextPageGuidance(outcome.nextOffset, limit, total, maxRows)]),
  ].join(' ');
}

export const queryIndicatorTool = tool('ilostat_query_indicator', {
  title: 'Query ILOSTAT observations',
  description:
    "Fetch observations for up to 3 ILOSTAT datasets per call, filtered by reference area or area group, sex, breakdown codes (classif1, classif2), source, and period; datasets past the first 3 come back as remaining_dataset_ids for another call. Rows keep their source, observation status, decoded notes, and a basis — reported, modelled_estimate, or projection — and the response echoes every filter applied, including the best-source default. Codes are checked against ILOSTAT's dictionaries before the request is sent: ilostat_list_reference lists valid codes and ilostat_describe_indicator lists the codes a dataset actually uses. Rows come back limit at a time from offset, and next_offset continues the same request; on the first page, a result past the staging threshold is also staged in full as a df_<id> dataframe for SQL through ilostat_dataframe_describe and ilostat_dataframe_query when this deployment enables dataframes. A request with no filters at all is refused when the dataset exceeds the row ceiling; a filtered result past the ceiling is paged but not staged, and a page reaching past the ceiling is refused with guidance to narrow the request.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    dataset_ids: splitIdArray(
      z
        .array(datasetIdInput())
        .min(1)
        .max(MAX_DATASET_IDS, {
          message: `dataset_ids holds at most ${MAX_DATASET_IDS} IDs; each call queries the first ${DATASETS_PER_CALL} distinct datasets and returns the rest as remaining_dataset_ids.`,
        }),
    ).describe(
      `Dataset IDs, up to ${MAX_DATASET_IDS} — an indicator code plus _A, _Q, or _M (UNE_DEAP_SEX_AGE_RT_A), as ilostat_search_indicators returns them. Case-insensitive; a DF_ prefix (the SDMX dataflow form) is stripped, a bare indicator code resolves when it has one frequency, an element holding + or , joined IDs is split, and duplicates are dropped. Every ID is checked; the first ${DATASETS_PER_CALL} distinct datasets are queried and the rest come back as remaining_dataset_ids for another call.`,
    ),
    ref_areas: blankFreeArray(
      z.array(areaCodeInput(REF_AREA_MESSAGE)).max(300).optional(),
    ).describe(
      'Reference areas (up to 300): ISO3 country codes (USA) or X-coded aggregates (X01 World); case-insensitive, ILO_GEO_ forms accepted. Aggregates need a dataset with has_aggregates true. Omit for every area.',
    ),
    area_group: blankAsUnset(areaCodeInput(AREA_GROUP_MESSAGE).optional()).describe(
      'X01 for every country, an ILO region or subregion, or a World Bank income group (X06, X56, X02, …); expands to its member countries, unioned with ref_areas. ilostat_list_reference topic area_groups lists the codes.',
    ),
    sex: blankFreeArray(z.array(sexCodeInput()).max(4).optional()).describe(
      'Sex codes SEX_T, SEX_M, SEX_F, SEX_O; T/M/F/O and total/both/male/female/other are accepted.',
    ),
    classif1: blankFreeArray(z.array(z.string().max(64)).max(100).optional()).describe(
      'Codes of the first breakdown (e.g. AGE_YTHADULT_YGE15); case-insensitive. ilostat_describe_indicator lists the codes a dataset uses.',
    ),
    classif2: blankFreeArray(z.array(z.string().max(64)).max(100).optional()).describe(
      'Codes of the second breakdown, for datasets that have one; case-insensitive. ilostat_describe_indicator lists them.',
    ),
    sources: blankFreeArray(z.array(z.string().max(64)).max(100).optional()).describe(
      "Source codes (e.g. BA:453); ilostat_list_reference topic sources with ref_area lists an area's sources. Without source_selection, setting sources switches it to all, since a secondary source matches nothing under best.",
    ),
    time: periodInput().describe(
      'One exact period: YYYY (on a quarterly or monthly dataset, every period of that year), YYYYQn, or YYYYMmm; 2024-Q2, 2024 Q2, and 2025-03 are normalized. Not combinable with time_from, time_to, or latest_only.',
    ),
    time_from: yearInput().describe('First year (YYYY); upstream filters by year only.'),
    time_to: yearInput().describe('Last year (YYYY), not before time_from.'),
    latest_only: z
      .boolean()
      .default(false)
      .describe(
        "Only each series' latest period — a series is one dataset, reference area, sex, classif1, and classif2 code — with every row at that period (one per source under source_selection all or secondary; the latest quarter or month on sub-annual datasets); combines with time_from/time_to. When the request's full history is too large or too slow to read in one call, it falls back to the latest period per area and dataset, which can miss a series that ends earlier; applied_filters.latest_mode says which ran, and the notice says so. time_from or classif1 narrow it back under; sex or fewer ref_areas alone may still read too much and fall back.",
      ),
    source_selection: blankAsUnset(z.enum(['best', 'all', 'secondary']).optional()).describe(
      'best (default): the preferred source per area and period; all: secondary sources too, each row flagged best_source; secondary: secondary sources only. Defaults to all when sources is set.',
    ),
    limit: z
      .number()
      .min(1)
      // Not .int(): it enforces the safe-integer maximum it advertises, and any larger count is applied as the cap.
      .check((ctx) => {
        if (!Number.isInteger(ctx.value)) {
          ctx.issues.push({ code: 'invalid_type', expected: 'int', input: ctx.value });
        }
      })
      .meta({ type: 'integer' })
      .default(50)
      .describe(
        `Rows per page, at most ${count(PAGE_CAP)}; a larger value is applied as ${count(PAGE_CAP)} and the notice says so.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "Rows to skip: 0 for the first page, else the previous page's next_offset, with the same other arguments. Each page re-reads the request upstream; under latest_only, combine pages only when their applied_filters.latest_mode matches.",
      ),
  }),

  output: z.object({
    datasets: z.array(DatasetMetaSchema).describe('The queried datasets, in request order.'),
    remaining_dataset_ids: z
      .array(z.string())
      .optional()
      .describe(
        `Requested datasets past the first ${DATASETS_PER_CALL}, as canonical IDs in request order; not fetched in this call. Pass them as dataset_ids with the same filters to get them. Absent when every requested dataset was queried.`,
      ),
    row_count: z
      .number()
      .describe(
        'Rows in the result — exact when summary.complete is true; otherwise the rows read before reading stopped past this page, which the result holds at least.',
      ),
    rows: z
      .array(
        z
          .object({
            dataset_id: z.string().describe('Dataset ID.'),
            ref_area: z.string().describe('Reference area code (legend.ref_area decodes it).'),
            source: z.string().describe('Source code (legend.source decodes it).'),
            sex: z
              .string()
              .optional()
              .describe('Sex code; absent when the dataset has no sex breakdown.'),
            classif1: z
              .string()
              .optional()
              .describe('First breakdown code, when the dataset has one.'),
            classif2: z
              .string()
              .optional()
              .describe('Second breakdown code, when the dataset has one.'),
            period: z.string().describe('Period: YYYY, YYYYQn, or YYYYMmm.'),
            value: z
              .number()
              .optional()
              .describe('Value in the dataset unit; absent when upstream sent none.'),
            obs_status: z
              .string()
              .optional()
              .describe('Observation status flag (legend.obs_status decodes it).'),
            notes: z.array(z.string()).describe('Note codes (legend.notes decodes them).'),
            basis: z
              .enum(BASES)
              .describe(
                'reported (national or institutional source), modelled_estimate (ILO modelled, up to the cutoff), or projection (ILO modelled, after it).',
              ),
            best_source: z
              .boolean()
              .optional()
              .describe(
                'Whether this is the preferred source; set only when secondary sources were requested.',
              ),
          })
          .describe('One observation.'),
      )
      .describe(
        "This page: at most limit rows from offset, in upstream's order (under per-series latest_only, each series' latest rows, series in the order first seen). A staged dataframe holds every row.",
      ),
    next_offset: z
      .number()
      .optional()
      .describe(
        'Offset of the next page, set when rows remain past this one; pass it as offset with the same other arguments.',
      ),
    legend: z
      .object({
        ref_area: CodeMapSchema('Reference area'),
        source: CodeMapSchema('Source'),
        sex: CodeMapSchema('Sex'),
        classif1: CodeMapSchema('classif1'),
        classif2: CodeMapSchema('classif2'),
        obs_status: CodeMapSchema('Observation status'),
        notes: CodeMapSchema('Note'),
      })
      .describe('Labels for every code in rows.'),
    summary: z
      .object({
        ref_areas: z.number().describe('Distinct reference areas in the rows read.'),
        period_min: z.string().optional().describe('Earliest period; absent on zero rows.'),
        period_max: z.string().optional().describe('Latest period; absent on zero rows.'),
        basis_counts: BasisCountsSchema,
        complete: z
          .boolean()
          .describe(
            'True when the read reached the end of the result (always under per-series latest_only, whose history is read whole); false when reading stopped past this page, so the counts cover only the rows read.',
          ),
        areas_without_rows: z
          .array(
            z
              .object({
                dataset_id: z.string().describe('Queried dataset the area returned no rows from.'),
                ref_area: z.string().describe('Requested reference area code.'),
                reason: z
                  .enum(AREA_WITHOUT_ROWS_REASONS)
                  .describe(
                    "not_covered: absent from the dataset's area list in its SDMX structure. no_rows: listed there, but no rows for these filters and period; every entry is no_rows when that list is unavailable, which notice says.",
                  ),
              })
              .describe('One requested area with no rows from one queried dataset.'),
          )
          .optional()
          .describe(
            'Every requested area (ref_areas plus area_group members) that returned no rows, per queried dataset, in the order sent; empty when each returned rows. Absent when complete is false, no area was requested, or the result has no rows.',
          ),
      })
      .describe('Summary over every row read, not just the page.'),
    dataframe: DataframeSchema.optional(),
    attribution: z.string().describe('Citation to keep with any use of the data.'),
  }),

  enrichment: {
    applied_filters: AppliedFiltersSchema,
    notice: z
      .string()
      .optional()
      .describe(
        'A limit past the page cap applied as the cap, datasets left for another call, a latest_only fallback to the latest period per area and dataset, filters that could not narrow a dataset, a unit the catalog does not list, the requested areas that returned no rows and why, why nothing matched, where the full result is staged, which rows the page holds and how to reach the next, or why a first page whose result passes the staging threshold was not staged (dataframes off, staging failed, or the result passes the row ceiling).',
      ),
    truncated: z.boolean().describe('True when rows remain past this page; next_offset continues.'),
    shown: z.number().describe('Rows returned inline.'),
    cap: z.number().describe('The limit applied to this page.'),
  },
  enrichmentTrailer: { applied_filters: { render: renderAppliedFilters } },

  errors: [
    {
      reason: 'unknown_dataset',
      code: JsonRpcErrorCode.NotFound,
      when: 'Any dataset ID in dataset_ids, queried or not, is not in the catalog, or a bare indicator code has several frequencies.',
      recovery:
        'Call ilostat_search_indicators to find a dataset ID — an indicator code plus _A, _Q, or _M, such as UNE_DEAP_SEX_AGE_RT_A.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'unknown_code',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A ref_areas, sex, classif1, classif2, or sources value is not in the ILOSTAT dictionaries.',
      recovery:
        'Call ilostat_list_reference with the topic for that field (ref_areas, sexes, classifications, or sources) to find valid codes.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'unknown_area_group',
      code: JsonRpcErrorCode.ValidationError,
      when: 'area_group is not X01, an ILO region or subregion, or a World Bank income group.',
      recovery:
        'Call ilostat_list_reference with topic area_groups to see the group codes area_group accepts.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'aggregates_unavailable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An X-coded aggregate was requested from a dataset that has no aggregate rows.',
      recovery:
        'Request countries only, or use a dataset whose ilostat_describe_indicator output shows has_aggregates true, such as the ILO modelled estimates in database ILOEST.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_period',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A sub-annual time on a dataset of another frequency, time combined with a range or latest_only, or time_from after time_to.',
      recovery:
        'Use YYYY for time_from and time_to, and YYYY, YYYYQn, or YYYYMmm matching the dataset frequency for time, never time together with a range or latest_only.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'request_too_broad',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No filters at all and the unfiltered size exceeds the row ceiling.',
      recovery:
        'Add ref_areas or area_group, a time_from/time_to window, latest_only, or sex/classif1 filters; ilostat_describe_indicator lists the codes this dataset uses.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'result_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The page (offset plus limit) reaches past the row ceiling of a result that holds more rows than the ceiling.',
      recovery:
        'Narrow the request with fewer reference areas, a shorter time window, or specific sex/classif1 codes, then call again.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'dataset_retired',
      code: JsonRpcErrorCode.NotFound,
      when: 'Upstream reports a catalog dataset ID as deprecated or invalid.',
      recovery:
        'The dataset was withdrawn upstream after the last catalog refresh; call ilostat_search_indicators for its current equivalent.',
      severity: 'warning',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_busy',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The server-side pacer shed the call, or the ILOSTAT API answered 429 or a challenge page.',
      recovery:
        'The ILOSTAT API is throttling this server; wait the retry-after interval in the error data, then call again with the same arguments.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'catalog_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'No catalog snapshot has loaded and the load failed, or the first load has not finished within 30 s.',
      recovery:
        'The ILOSTAT catalog could not be loaded from the upstream API; wait about a minute and call the tool again.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const limit = Math.min(input.limit, PAGE_CAP);
    const request: QueryRequest = {
      datasetIds: input.dataset_ids,
      latestOnly: input.latest_only,
      limit,
      offset: input.offset,
      ...(input.ref_areas?.length ? { refAreas: input.ref_areas } : {}),
      ...(input.area_group ? { areaGroup: input.area_group } : {}),
      ...(input.sex?.length ? { sex: input.sex } : {}),
      ...(input.classif1?.length ? { classif1: input.classif1 } : {}),
      ...(input.classif2?.length ? { classif2: input.classif2 } : {}),
      ...(input.sources?.length ? { sources: input.sources } : {}),
      ...(input.time ? { time: input.time } : {}),
      ...(input.time_from ? { timeFrom: input.time_from } : {}),
      ...(input.time_to ? { timeTo: input.time_to } : {}),
      ...(input.source_selection ? { sourceSelection: input.source_selection } : {}),
    };
    checkPeriodCombination(request, ctx);
    const { catalog, observations } = getIlostatServices();
    const snapshot = await catalog.ready(ctx);
    const result = await observations.query(snapshot, request, ctx);

    const { complete, outcome, summary } = result;
    const shown = outcome.rows.length;
    ctx.enrich({ applied_filters: result.appliedFilters, truncated: false, shown, cap: limit });
    const notices = [
      ...(limit < input.limit
        ? [`limit ${input.limit} was applied as ${limit}, the per-call page cap.`]
        : []),
      ...result.notices,
    ];
    if (outcome.kind === 'staged') notices.push(dataframeNotice(outcome.table));
    const paging = pageNotice(outcome, input.offset, limit, summary.rows, complete, result.maxRows);
    if (paging) notices.push(paging);
    if (outcome.nextOffset !== undefined) {
      ctx.enrich.truncated({ shown, cap: limit, guidance: notices.join(' ') });
    } else if (notices.length > 0) {
      ctx.enrich.notice(notices.join(' '));
    }
    ctx.log.info('Queried ILOSTAT observations', {
      datasets: result.appliedFilters.dataset_ids,
      rows: summary.rows,
      outcome: outcome.kind,
    });

    return {
      datasets: result.datasets.map(datasetMeta),
      ...(result.remainingDatasetIds.length > 0
        ? { remaining_dataset_ids: result.remainingDatasetIds }
        : {}),
      row_count: summary.rows,
      rows: outcome.rows.map(toInlineRow),
      ...(outcome.nextOffset === undefined ? {} : { next_offset: outcome.nextOffset }),
      legend: legendOf(outcome.rows, snapshot),
      summary: {
        ref_areas: summary.refAreas,
        ...(summary.periodMin ? { period_min: summary.periodMin } : {}),
        ...(summary.periodMax ? { period_max: summary.periodMax } : {}),
        basis_counts: { ...summary.basisCounts },
        complete,
        ...(result.areasWithoutRows ? { areas_without_rows: result.areasWithoutRows } : {}),
      },
      ...(outcome.kind === 'staged' ? { dataframe: stagedDataframe(outcome.table) } : {}),
      attribution: ATTRIBUTION,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    for (const meta of result.datasets) lines.push(...renderDatasetMeta(meta, '##'), '');
    if (result.remaining_dataset_ids) {
      lines.push(
        `**Remaining dataset IDs (not queried):** ${inlineText(result.remaining_dataset_ids.join(', '))}`,
        '',
      );
    }

    const groups = Map.groupBy(result.rows, (row) =>
      [row.dataset_id, row.ref_area, row.sex, row.classif1, row.classif2, row.source]
        .filter((part) => part !== undefined)
        .join(' · '),
    );
    lines.push(
      `### Observations (${result.rows.length} of ${result.row_count} ${result.row_count === 1 ? 'row' : 'rows'} shown)`,
    );
    for (const [key, rows] of groups) {
      lines.push(`#### ${inlineText(key)}`);
      for (const row of rows) {
        // Own keys only: the parsed legend is a plain object, so a code like toString would hit its prototype.
        const statusLabel =
          row.obs_status && Object.hasOwn(result.legend.obs_status, row.obs_status)
            ? result.legend.obs_status[row.obs_status]
            : undefined;
        const status = row.obs_status
          ? ` [${inlineText(row.obs_status)}${statusLabel ? ` ${inlineText(statusLabel)}` : ''}]`
          : '';
        const best = row.best_source === undefined ? '' : ` · best source: ${row.best_source}`;
        const notes = row.notes.length > 0 ? ` · notes ${inlineText(row.notes.join(', '))}` : '';
        lines.push(
          `- ${inlineText(row.period)}: ${row.value ?? 'no value'}${status} · ${row.basis}${best}${notes}`,
        );
      }
    }

    const legendSections = [
      ['Reference areas', result.legend.ref_area],
      ['Sources', result.legend.source],
      ['Sex', result.legend.sex],
      ['classif1', result.legend.classif1],
      ['classif2', result.legend.classif2],
      ['Status flags', result.legend.obs_status],
      ['Notes', result.legend.notes],
    ] as const;
    lines.push('', '### Legend');
    for (const [title, map] of legendSections) {
      const entries = Object.entries(map);
      if (entries.length === 0) continue;
      lines.push(`**${title}:**`);
      for (const [code, label] of entries)
        lines.push(`- ${inlineText(code)} — ${inlineText(label)}`);
    }

    const { summary } = result;
    lines.push(
      '',
      `**Summary:** ${result.row_count} ${result.row_count === 1 ? 'row' : 'rows'} · ${summary.ref_areas} ${summary.ref_areas === 1 ? 'area' : 'areas'}${summary.period_min ? ` · periods ${inlineText(`${summary.period_min}–${summary.period_max}`)}` : ''} · ${renderBasisCounts(summary.basis_counts)} · complete: ${summary.complete}`,
    );
    const withoutRows = summary.areas_without_rows;
    if (withoutRows) {
      lines.push(`**Areas without rows:**${withoutRows.length === 0 ? ' none' : ''}`);
      for (const entry of withoutRows) {
        lines.push(
          `- ${inlineText(entry.dataset_id)} · ${inlineText(entry.ref_area)}: ${entry.reason}`,
        );
      }
    }
    if (result.next_offset !== undefined) lines.push(`**next_offset:** ${result.next_offset}`);
    if (result.dataframe) lines.push(renderDataframe(result.dataframe));
    lines.push(result.attribution);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
