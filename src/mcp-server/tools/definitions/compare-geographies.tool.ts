/**
 * @fileoverview `ilostat_compare_geographies` — line reference areas up on one
 * slice of one ILOSTAT dataset: each area's value at a common period or at its
 * latest non-projected period, an optional change over N years, a rank by value,
 * the areas without a value and why, and flags for mixed periods and mixed bases.
 * The slice defaults to the dataset's totals.
 * @module mcp-server/tools/definitions/compare-geographies
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
  tableCell,
} from '@/mcp-server/tools/tool-helpers.js';
import { ATTRIBUTION } from '@/services/attribution.js';
import { BASES } from '@/services/basis/basis.js';
import { dataframeNotice } from '@/services/canvas-bridge/canvas-bridge.js';
import { inlineText } from '@/services/catalog/text.js';
import type { CatalogSnapshot } from '@/services/catalog/types.js';
import { getIlostatServices } from '@/services/ilostat-services.js';
import type { ComparisonRow } from '@/services/observations/comparison.js';
import { noteCodesOf, UNLABELLED } from '@/services/observations/observation-rows.js';
import type { CompareAppliedFilters } from '@/services/observations/observation-service.js';

const AppliedFiltersSchema = z
  .object({
    dataset_id: z.string().describe('Dataset compared.'),
    ref_areas: z.array(z.string()).optional().describe('Reference areas given, normalized.'),
    area_group: z
      .object({
        code: z.string().describe('Area group code.'),
        label: z.string().describe('Area group label.'),
        member_count: z.number().describe('Member countries it expanded to.'),
      })
      .optional()
      .describe('The area group and how many countries it expanded to.'),
    ref_area_count: z.number().describe('Areas compared: ref_areas plus the area_group members.'),
    sex: z.string().optional().describe('Sex code sent.'),
    classif1: z.string().optional().describe('classif1 code sent.'),
    classif2: z.string().optional().describe('classif2 code sent.'),
    time: z.array(z.string()).optional().describe('Exact periods sent (period mode).'),
    time_from: z
      .number()
      .optional()
      .describe('First year sent (latest mode); no end year is sent.'),
    best_source: z
      .literal('upstream default (yes)')
      .describe('best_source is never sent, so upstream returns the preferred source.'),
  })
  .describe('Every parameter sent upstream.');

/** Labels for the status flags and note codes the inline comparison rows carry. */
function comparisonLegend(rows: readonly ComparisonRow[], snapshot: CatalogSnapshot) {
  const legend: { notes: Record<string, string>; obs_status: Record<string, string> } = {
    obs_status: {},
    notes: {},
  };
  for (const row of rows) {
    if (row.obs_status !== null) {
      legend.obs_status[row.obs_status] = row.obs_status_label ?? UNLABELLED;
    }
    for (const code of noteCodesOf(row)) {
      legend.notes[code] = snapshot.notes.get(code)?.label ?? UNLABELLED;
    }
  }
  return legend;
}

function renderAppliedFilters(filters: CompareAppliedFilters): string {
  const parts = [`dataset ${filters.dataset_id}`];
  if (filters.ref_areas) parts.push(`ref_areas ${filters.ref_areas.join(', ')}`);
  if (filters.area_group) {
    parts.push(
      `area_group ${filters.area_group.code} (${inlineText(filters.area_group.label)}, ${filters.area_group.member_count} countries)`,
    );
  }
  parts.push(`${filters.ref_area_count} areas`);
  if (filters.sex) parts.push(`sex ${filters.sex}`);
  if (filters.classif1) parts.push(`classif1 ${filters.classif1}`);
  if (filters.classif2) parts.push(`classif2 ${filters.classif2}`);
  if (filters.time) parts.push(`time ${filters.time.join(', ')}`);
  if (filters.time_from !== undefined) parts.push(`time_from ${filters.time_from}`);
  parts.push(`best_source ${filters.best_source}`);
  return `**Applied filters:** ${parts.join(' · ')}`;
}

export const compareGeographiesTool = tool('ilostat_compare_geographies', {
  title: 'Compare areas on an ILOSTAT dataset',
  description:
    "Compare reference areas on one ILOSTAT dataset and one slice — a sex code plus breakdown codes, defaulting to the dataset's totals — giving each area's value at a common period or at its latest non-projected period, optional change over N years, and a rank, with each value's period, source, status, and basis (reported, modelled_estimate, or projection). Areas without a value are listed separately with the reason, and the response flags mixed periods and mixed bases rather than hiding them. Select areas by code list, by group (X01 for every country, an ILO region or subregion, or a World Bank income group), or both; X-coded aggregates require a dataset with aggregates.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    dataset_id: datasetIdInput().describe(
      'One dataset ID (UNE_DEAP_SEX_AGE_RT_A), as ilostat_search_indicators returns it; case-insensitive, a DF_ prefix (the SDMX dataflow form) stripped, a bare indicator code resolved when it has one frequency.',
    ),
    ref_areas: blankFreeArray(
      z.array(areaCodeInput(REF_AREA_MESSAGE)).max(300).optional(),
    ).describe(
      'Reference areas (up to 300): ISO3 codes (USA) or X-coded aggregates (X01 World); case-insensitive, ILO_GEO_ forms accepted. At least one of ref_areas or area_group is required.',
    ),
    area_group: blankAsUnset(areaCodeInput(AREA_GROUP_MESSAGE).optional()).describe(
      "X01 for every country, an ILO region or subregion, or a World Bank income group (X06, X56, X02, …); expands to its member countries. The group's own aggregate is compared only when listed in ref_areas. ilostat_list_reference topic area_groups lists the codes.",
    ),
    sex: blankAsUnset(sexCodeInput().optional()).describe(
      'Sex code SEX_T, SEX_M, SEX_F, or SEX_O; T/M/F/O and total/both/male/female/other are accepted. Defaults to SEX_T on a dataset with a sex breakdown; refused on one without.',
    ),
    classif1: blankAsUnset(z.string().optional()).describe(
      "First breakdown code, case-insensitive. Defaults to the dataset's total code; required when the breakdown has no total (deciles); refused on a dataset without the breakdown. ilostat_describe_indicator lists the dataset's codes and marks its totals.",
    ),
    classif2: blankAsUnset(z.string().optional()).describe(
      'Second breakdown code; same defaults and rules as classif1.',
    ),
    period: periodInput().describe(
      'A common period, YYYY, YYYYQn, or YYYYMmm matching the dataset frequency (2024-Q2 and 2025-03 are normalized). Omit to compare each area at its latest period.',
    ),
    lookback_years: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe(
        "Latest mode: an area's latest value must fall within this many years of the current year.",
      ),
    change_years: blankAsUnset(z.number().int().min(1).max(30).optional()).describe(
      "Adds each value's change from the same sub-period this many years earlier, in the dataset unit.",
    ),
    include_projections: z
      .boolean()
      .default(false)
      .describe(
        "Latest mode: let projections (ILO modelled values after the cutoff) be an area's latest value.",
      ),
    sort: blankAsUnset(
      z.enum(['value_desc', 'value_asc', 'ref_area']).default('value_desc'),
    ).describe(
      'Row order: value_desc (default), value_asc, or ref_area. rank is always by value, highest first.',
    ),
  }),

  output: z.object({
    dataset: DatasetMetaSchema,
    slice: z
      .object({
        sex: z.string().optional().describe('Sex code compared.'),
        classif1: z.string().optional().describe('classif1 code compared.'),
        classif2: z.string().optional().describe('classif2 code compared.'),
        defaulted: z
          .array(z.enum(['sex', 'classif1', 'classif2']))
          .describe("Which slice codes were filled from the dataset's totals."),
      })
      .describe('The one series compared per area.'),
    mode: z
      .enum(['latest', 'period'])
      .describe("latest: each area's latest value; period: every area at one period."),
    period: z.string().optional().describe('Period mode: the period compared.'),
    window_from: z.number().optional().describe('Latest mode: the first year requested.'),
    change_years: z
      .number()
      .optional()
      .describe('Years the change is measured over, when requested.'),
    include_projections: z
      .boolean()
      .describe("Whether a projection could be an area's latest value."),
    rows: z
      .array(
        z
          .object({
            rank: z.number().describe('Rank by value, highest first; ties share a rank.'),
            ref_area: z.string().describe('Reference area code.'),
            label: z.string().optional().describe('Reference area label.'),
            kind: z.enum(['country', 'aggregate']).describe('country or X-coded aggregate.'),
            value: z.number().describe('Value in the dataset unit.'),
            period: z.string().describe('Period of the value.'),
            basis: z.enum(BASES).describe('reported, modelled_estimate, or projection.'),
            source: z.string().describe('Source code.'),
            source_label: z.string().optional().describe('Source label.'),
            obs_status: z
              .string()
              .optional()
              .describe('Observation status flag (legend.obs_status decodes it).'),
            notes: z.array(z.string()).describe('Note codes (legend.notes decodes them).'),
            change: z
              .object({
                from_period: z.string().describe('The earlier period.'),
                from_value: z.number().describe('The value at the earlier period.'),
                delta: z.number().describe('value − from_value, in the dataset unit.'),
              })
              .optional()
              .describe('Change over change_years; absent when the earlier value is missing.'),
          })
          .describe('One area with a value.'),
      )
      .describe(
        'Areas with a value, in the requested order; the staged dataframe holds all when larger.',
      ),
    legend: z
      .object({
        obs_status: z
          .record(z.string(), z.string())
          .describe('Observation status code → label, for every status flag in rows.'),
        notes: z
          .record(z.string(), z.string())
          .describe('Note code → label, for every note code in rows.'),
      })
      .describe('Labels for the status flags and note codes in rows.'),
    missing: z
      .array(
        z
          .object({
            ref_area: z.string().describe('Reference area code.'),
            label: z.string().optional().describe('Reference area label.'),
            reason: z
              .enum(['no_value_in_window', 'no_value_for_period', 'not_covered'])
              .describe(
                "no_value_in_window (latest mode), no_value_for_period (period mode), or not_covered (absent from the dataset's area list; never given when that list is unavailable, which notice says).",
              ),
          })
          .describe('One area without a value.'),
      )
      .describe('Requested areas with no value, and why.'),
    comparability: z
      .object({
        periods: z.array(z.string()).describe('Distinct periods of the values, newest first.'),
        mixed_periods: z.boolean().describe('True when the values span more than one period.'),
        basis_counts: BasisCountsSchema,
        distinct_sources: z.number().describe('Distinct sources behind the values.'),
      })
      .describe('What makes the values more or less comparable, over every area.'),
    dataframe: DataframeSchema.optional(),
    attribution: z.string().describe('Citation to keep with any use of the data.'),
  }),

  enrichment: {
    applied_filters: AppliedFiltersSchema,
    notice: z
      .string()
      .optional()
      .describe(
        'Mixed periods, mixed bases, missing areas, a unit or area list the structure service could not supply, where the full comparison is staged, or why the inline rows stop early.',
      ),
    truncated: z.boolean().describe('True when the inline rows stop before the last area.'),
    shown: z.number().describe('Rows returned inline.'),
    cap: z.number().describe('Inline preview budget, in serialized characters.'),
  },
  enrichmentTrailer: { applied_filters: { render: renderAppliedFilters } },

  errors: [
    {
      reason: 'unknown_dataset',
      code: JsonRpcErrorCode.NotFound,
      when: 'dataset_id is not in the catalog, or a bare indicator code has several frequencies.',
      recovery:
        'Call ilostat_search_indicators to find a dataset ID — an indicator code plus _A, _Q, or _M, such as UNE_DEAP_SEX_AGE_RT_A.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'unknown_code',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A ref_areas, sex, classif1, or classif2 value is not in the ILOSTAT dictionaries.',
      recovery:
        'Call ilostat_list_reference with the topic for that field (ref_areas, sexes, or classifications) to find valid codes.',
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
      reason: 'areas_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither ref_areas nor area_group was given.',
      recovery:
        'Pass ref_areas (ISO3 or X codes) or an area_group such as X06 for every African country; ilostat_list_reference topic area_groups lists the groups.',
      severity: 'notice',
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
      reason: 'invalid_slice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A breakdown has no total code and no value was given, or sex/classif1/classif2 names a breakdown the dataset lacks.',
      recovery:
        'Pass sex, classif1, and classif2 only for breakdowns the dataset has, with explicit codes where it has no total; ilostat_describe_indicator lists them.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_period',
      code: JsonRpcErrorCode.ValidationError,
      when: "period is of a frequency other than the dataset's.",
      recovery:
        "Use YYYY, YYYYQn, or YYYYMmm matching the dataset frequency for period, or omit it to compare each area's latest value.",
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
      reason: 'structure_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'classif1 or classif2 was left to its default and the ILOSTAT structure service could not supply the dataset total codes.',
      recovery:
        "ILOSTAT's structure service could not supply the dataset's total codes; pass an explicit classif1 and classif2 code for each breakdown the dataset has — ilostat_list_reference topic classifications lists them.",
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
    if (!input.ref_areas?.length && !input.area_group) {
      throw ctx.fail('areas_required', 'Name the areas to compare.', {
        ...ctx.recoveryFor('areas_required'),
      });
    }
    const { catalog, observations } = getIlostatServices();
    const snapshot = await catalog.ready(ctx);
    const result = await observations.compare(
      snapshot,
      {
        datasetId: input.dataset_id,
        lookbackYears: input.lookback_years,
        includeProjections: input.include_projections,
        sort: input.sort,
        ...(input.ref_areas?.length ? { refAreas: input.ref_areas } : {}),
        ...(input.area_group ? { areaGroup: input.area_group } : {}),
        ...(input.sex ? { sex: input.sex } : {}),
        ...(input.classif1 ? { classif1: input.classif1 } : {}),
        ...(input.classif2 ? { classif2: input.classif2 } : {}),
        ...(input.period ? { period: input.period } : {}),
        ...(input.change_years === undefined ? {} : { changeYears: input.change_years }),
      },
      ctx,
    );

    const { comparison, outcome } = result;
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
        `Showing ${shown} of ${comparison.entries.length} areas inline: ${outcome.cause === 'canvas_off' ? 'dataframes are off in this deployment' : 'staging the full comparison as a dataframe failed'}. Ranks, missing, and comparability cover every area; narrow ref_areas or area_group to see the rest.`,
      );
      ctx.enrich.truncated({ shown, cap: result.previewChars, guidance: notices.join(' ') });
    } else if (notices.length > 0) {
      ctx.enrich.notice(notices.join(' '));
    }
    ctx.log.info('Compared ILOSTAT areas', {
      dataset: result.dataset.dataset.id,
      areas: result.appliedFilters.ref_area_count,
      withValue: comparison.entries.length,
      outcome: outcome.kind,
    });

    return {
      dataset: datasetMeta(result.dataset),
      slice: {
        ...(result.slice.sex ? { sex: result.slice.sex } : {}),
        ...(result.slice.classif1 ? { classif1: result.slice.classif1 } : {}),
        ...(result.slice.classif2 ? { classif2: result.slice.classif2 } : {}),
        defaulted: result.slice.defaulted,
      },
      mode: result.mode.kind,
      ...(result.mode.kind === 'period' ? { period: result.mode.period } : {}),
      ...(result.windowFrom === undefined ? {} : { window_from: result.windowFrom }),
      ...(input.change_years === undefined ? {} : { change_years: input.change_years }),
      include_projections: input.include_projections,
      rows: outcome.rows.map((row) => ({
        rank: row.rank,
        ref_area: row.ref_area,
        ...(row.ref_area_label ? { label: row.ref_area_label } : {}),
        kind: row.ref_area_kind,
        value: row.value,
        period: row.period,
        basis: row.basis,
        source: row.source,
        ...(row.source_label ? { source_label: row.source_label } : {}),
        ...(row.obs_status ? { obs_status: row.obs_status } : {}),
        notes: noteCodesOf(row),
        ...(row.change_from_period !== null &&
        row.change_from_value !== null &&
        row.change_delta !== null
          ? {
              change: {
                from_period: row.change_from_period,
                from_value: row.change_from_value,
                delta: row.change_delta,
              },
            }
          : {}),
      })),
      legend: comparisonLegend(outcome.rows, snapshot),
      missing: comparison.missing.map(({ refArea, reason }) => {
        const label = snapshot.refAreas.get(refArea)?.label;
        return { ref_area: refArea, ...(label ? { label } : {}), reason };
      }),
      comparability: {
        periods: comparison.periods,
        mixed_periods: comparison.mixedPeriods,
        basis_counts: { ...comparison.basisCounts },
        distinct_sources: comparison.distinctSources,
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
    const lines = renderDatasetMeta(result.dataset, '##');
    const slice = [
      result.slice.sex ? `sex ${result.slice.sex}` : undefined,
      result.slice.classif1 ? `classif1 ${result.slice.classif1}` : undefined,
      result.slice.classif2 ? `classif2 ${result.slice.classif2}` : undefined,
    ].filter(Boolean);
    lines.push(
      `Slice: ${slice.length > 0 ? inlineText(slice.join(' · ')) : 'no breakdowns'}${result.slice.defaulted.length > 0 ? ` (defaulted: ${result.slice.defaulted.join(', ')})` : ''}`,
      `Mode: ${result.mode}${result.period ? ` · period ${result.period}` : ''}${result.window_from === undefined ? '' : ` · from ${result.window_from}`}${result.change_years === undefined ? '' : ` · change over ${result.change_years} years`} · include_projections: ${result.include_projections}`,
      '',
      '| rank | area | value | period | basis | status | source | notes | change |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const row of result.rows) {
      const area = `${row.ref_area}${row.label ? ` — ${row.label}` : ''} (${row.kind})`;
      const source = `${row.source}${row.source_label ? ` — ${row.source_label}` : ''}`;
      const change = row.change
        ? `${row.change.delta} since ${row.change.from_period} (${row.change.from_value})`
        : '';
      lines.push(
        `| ${row.rank} | ${tableCell(area)} | ${row.value} | ${tableCell(row.period)} | ${row.basis} | ${tableCell(row.obs_status ?? '')} | ${tableCell(source)} | ${tableCell(row.notes.join(', '))} | ${tableCell(change)} |`,
      );
    }
    for (const [title, map] of [
      ['Status flags', result.legend.obs_status],
      ['Notes', result.legend.notes],
    ] as const) {
      const entries = Object.entries(map);
      if (entries.length === 0) continue;
      lines.push('', `**${title}:**`);
      for (const [code, label] of entries) {
        lines.push(`- ${inlineText(code)} — ${inlineText(label)}`);
      }
    }
    if (result.missing.length > 0) {
      lines.push('', '**Missing:**');
      for (const entry of result.missing) {
        lines.push(
          `- ${inlineText(entry.ref_area)}${entry.label ? ` — ${inlineText(entry.label)}` : ''}: ${entry.reason}`,
        );
      }
    }
    const { comparability } = result;
    lines.push(
      '',
      `**Comparability:** periods ${inlineText(comparability.periods.join(', ')) || 'none'} · mixed_periods: ${comparability.mixed_periods} · ${renderBasisCounts(comparability.basis_counts)} · ${comparability.distinct_sources} distinct sources`,
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
