/**
 * @fileoverview `ilostat_query_indicator` — observations for up to three ILOSTAT
 * datasets, filtered by area or area group, sex, breakdown codes, source, and
 * period. Every code is checked against the catalog dictionaries before the
 * request is sent; rows keep their source, status, notes, and basis, and a result
 * larger than the inline preview is staged in full as a `df_<id>` dataframe.
 * @module mcp-server/tools/definitions/query-indicator
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  BasisCountsSchema,
  DataframeSchema,
  DatasetMetaSchema,
  datasetMeta,
  renderBasisCounts,
  renderDatasetMeta,
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
  checkPeriodCombination,
  type QueryAppliedFilters,
  type QueryRequest,
} from '@/services/observations/observation-service.js';

const CodeMapSchema = (what: string) =>
  z.record(z.string(), z.string()).describe(`${what} code → label, for every code in rows.`);

const AppliedFiltersSchema = z
  .object({
    dataset_ids: z.array(z.string()).describe('Datasets requested.'),
    ref_areas: z.array(z.string()).optional().describe('Reference areas given, normalized.'),
    area_group: z
      .object({
        code: z.string().describe('Area group code.'),
        label: z.string().describe('Area group label.'),
        member_count: z.number().describe('Member countries it expanded to.'),
      })
      .optional()
      .describe('The area group and how many countries it expanded to.'),
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
    latest_only: z.boolean().describe('Whether only the latest period per area was requested.'),
    source_selection: z
      .enum(['best', 'all', 'secondary'])
      .describe('Source selection applied (all when sources were given without one).'),
    best_source: z.enum(['yes', 'all', 'no']).describe('The upstream best_source value sent.'),
  })
  .describe('Every parameter sent upstream, defaults included.');

function renderAppliedFilters(filters: QueryAppliedFilters): string {
  const parts = [`datasets ${filters.dataset_ids.join(', ')}`];
  if (filters.ref_areas) parts.push(`ref_areas ${filters.ref_areas.join(', ')}`);
  if (filters.area_group) {
    parts.push(
      `area_group ${filters.area_group.code} (${inlineText(filters.area_group.label)}, ${filters.area_group.member_count} countries)`,
    );
  }
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
  parts.push(`source_selection ${filters.source_selection} (best_source=${filters.best_source})`);
  return `**Applied filters:** ${parts.join(' · ')}`;
}

export const queryIndicatorTool = tool('ilostat_query_indicator', {
  title: 'Query ILOSTAT observations',
  description:
    "Fetch observations for up to 3 ILOSTAT datasets, filtered by reference area or area group, sex, breakdown codes (classif1, classif2), source, and period. Rows keep their source, observation status, decoded notes, and a basis — reported, modelled_estimate, or projection — and the response echoes every filter applied, including the best-source default. Codes are checked against ILOSTAT's dictionaries before the request is sent: ilostat_list_reference lists valid codes and ilostat_describe_indicator lists the codes a dataset actually uses. A result larger than the inline preview is staged in full as a df_<id> dataframe for SQL through ilostat_dataframe_describe and ilostat_dataframe_query when this deployment enables dataframes. A request with no filters at all is refused when the dataset exceeds the row ceiling, and a filtered request that still exceeds it is refused with guidance to narrow it.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    dataset_ids: splitIdArray(z.array(datasetIdInput()).min(1).max(3)).describe(
      'One to three dataset IDs — an indicator code plus _A, _Q, or _M (UNE_DEAP_SEX_AGE_RT_A), as ilostat_search_indicators returns them. Case-insensitive; a DF_ prefix (the SDMX dataflow form) is stripped, a bare indicator code resolves when it has one frequency, and an element holding + or , joined IDs is split.',
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
    classif1: blankFreeArray(z.array(z.string()).max(100).optional()).describe(
      'Codes of the first breakdown (e.g. AGE_YTHADULT_YGE15); case-insensitive. ilostat_describe_indicator lists the codes a dataset uses.',
    ),
    classif2: blankFreeArray(z.array(z.string()).max(100).optional()).describe(
      'Codes of the second breakdown, for datasets that have one; case-insensitive. ilostat_describe_indicator lists them.',
    ),
    sources: blankFreeArray(z.array(z.string()).max(100).optional()).describe(
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
        'Only the latest period per reference area and dataset (the latest quarter or month on sub-annual datasets); combines with time_from/time_to.',
      ),
    source_selection: blankAsUnset(z.enum(['best', 'all', 'secondary']).optional()).describe(
      'best (default): the preferred source per area and period; all: secondary sources too, each row flagged best_source; secondary: secondary sources only. Defaults to all when sources is set.',
    ),
  }),

  output: z.object({
    datasets: z.array(DatasetMetaSchema).describe('The requested datasets, in request order.'),
    row_count: z
      .number()
      .describe(
        'Rows the request returned — exact when the result is inline or staged; when reading stopped early (truncated), the rows read.',
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
        'Inline preview rows; the staged dataframe holds every row when the result is larger.',
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
          .describe('False when reading stopped early, so the counts cover only the rows read.'),
      })
      .describe('Summary over every row read, not just the preview.'),
    dataframe: DataframeSchema.optional(),
    attribution: z.string().describe('Citation to keep with any use of the data.'),
  }),

  enrichment: {
    applied_filters: AppliedFiltersSchema,
    notice: z
      .string()
      .optional()
      .describe(
        'Filters that could not narrow a dataset, a unit the structure service could not supply, why nothing matched, where the full result is staged, or why reading stopped early.',
      ),
    truncated: z
      .boolean()
      .describe('True when reading stopped at the inline preview and more rows exist.'),
    shown: z.number().describe('Rows returned inline.'),
    cap: z.number().describe('Inline preview budget, in serialized characters.'),
  },
  enrichmentTrailer: { applied_filters: { render: renderAppliedFilters } },

  errors: [
    {
      reason: 'unknown_dataset',
      code: JsonRpcErrorCode.NotFound,
      when: 'A dataset ID is not in the catalog, or a bare indicator code has several frequencies.',
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
      when: 'The filtered result passed the row ceiling while streaming.',
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
    const request: QueryRequest = {
      datasetIds: input.dataset_ids,
      latestOnly: input.latest_only,
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

    const { outcome, summary } = result;
    const shown = outcome.rows.length;
    ctx.enrich({
      applied_filters: result.appliedFilters,
      truncated: false,
      shown,
      cap: result.previewChars,
    });
    const notices = [...result.notices];
    if (outcome.kind === 'staged') notices.push(dataframeNotice(outcome.table));
    if (outcome.kind === 'preview') {
      notices.push(
        outcome.cause === 'canvas_off'
          ? `Showing the first ${shown} rows: dataframes are off in this deployment, so reading stopped at the inline preview and the rest of the result was not fetched. Narrow the request — fewer areas, a shorter time window, or specific sex/classif1 codes — to see all of it.`
          : `Showing the first ${shown} rows: staging the full result as a dataframe failed, so reading stopped at the inline preview. Call again, or narrow the request to see all of it.`,
      );
      ctx.enrich.truncated({ shown, cap: result.previewChars, guidance: notices.join(' ') });
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
      row_count: summary.rows,
      rows: outcome.rows.map(toInlineRow),
      legend: legendOf(outcome.rows, snapshot),
      summary: {
        ref_areas: summary.refAreas,
        ...(summary.periodMin ? { period_min: summary.periodMin } : {}),
        ...(summary.periodMax ? { period_max: summary.periodMax } : {}),
        basis_counts: { ...summary.basisCounts },
        complete: outcome.kind !== 'preview',
      },
      ...(outcome.kind === 'staged'
        ? {
            dataframe: {
              name: outcome.table.name,
              row_count: outcome.table.rowCount,
              expires_at: outcome.table.expiresAt,
            },
          }
        : {}),
      attribution: ATTRIBUTION,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    for (const meta of result.datasets) lines.push(...renderDatasetMeta(meta, '##'), '');

    const groups = new Map<string, (typeof result.rows)[number][]>();
    for (const row of result.rows) {
      const key = [row.dataset_id, row.ref_area, row.sex, row.classif1, row.classif2, row.source]
        .filter((part) => part !== undefined)
        .join(' · ');
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }
    lines.push(`### Observations (${result.rows.length} of ${result.row_count} rows shown)`);
    for (const [key, rows] of groups) {
      lines.push(`#### ${inlineText(key)}`);
      for (const row of rows) {
        const statusLabel = row.obs_status ? result.legend.obs_status[row.obs_status] : undefined;
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
      `**Summary:** ${result.row_count} rows · ${summary.ref_areas} ${summary.ref_areas === 1 ? 'area' : 'areas'}${summary.period_min ? ` · periods ${inlineText(`${summary.period_min}–${summary.period_max}`)}` : ''} · ${renderBasisCounts(summary.basis_counts)} · complete: ${summary.complete}`,
    );
    if (result.dataframe) {
      lines.push(
        `**Dataframe:** ${result.dataframe.name} (${result.dataframe.row_count} rows, expires ${result.dataframe.expires_at})`,
      );
    }
    lines.push(result.attribution);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
