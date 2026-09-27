/**
 * @fileoverview `ilostat_search_indicators` — search the ILOSTAT indicator catalog by
 * plain-language terms and filters. One hit per indicator, carrying its datasets
 * (one per available frequency), breakdowns, coverage, and facets over the fully
 * filtered match set.
 * @module mcp-server/tools/definitions/search-indicators
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { blankAsUnset, FREQUENCY_NAMES } from '@/mcp-server/tools/tool-helpers.js';
import { cursorOffset } from '@/services/catalog/paging.js';
import { searchIndicators } from '@/services/catalog/search.js';
import { inlineText } from '@/services/catalog/text.js';
import { getIlostatServices } from '@/services/ilostat-services.js';

const CodeLabelSchema = (what: string) =>
  z
    .object({
      code: z.string().describe(`${what} code.`),
      label: z.string().describe(`${what} label.`),
    })
    .describe(`${what} code and label.`);

const HitDatasetSchema = z
  .object({
    dataset_id: z
      .string()
      .describe(
        'Dataset ID — the indicator code plus _A, _Q, or _M — to pass to ilostat_describe_indicator, ilostat_query_indicator, or ilostat_compare_geographies.',
      ),
    frequency: z.string().describe('A (annual), Q (quarterly), or M (monthly).'),
    data_start: z.number().describe('First year with data.'),
    data_end: z.number().describe('Last year with data (can include projection years).'),
    n_ref_area: z.number().describe('Reference areas with data.'),
    n_records: z.number().describe('Observations an unfiltered best-source download returns.'),
    last_update: z.string().describe('Last upstream update, ISO 8601 without zone offset.'),
    has_aggregates: z
      .boolean()
      .describe('Whether this dataset carries World, regional, or income-group rows.'),
  })
  .describe('One dataset of the indicator at one frequency.');

const FacetSchema = z
  .object({
    code: z.string().describe('Facet code.'),
    label: z.string().describe('Facet label.'),
    count: z.number().describe('Matching indicators with this value.'),
  })
  .describe('One facet value and its indicator count.');

export const searchIndicatorsTool = tool('ilostat_search_indicators', {
  title: 'Search ILOSTAT indicators',
  description:
    "Search ILOSTAT's catalog of labour-statistics indicators by plain-language terms and filters. Each hit is one indicator with its datasets — one per available frequency (annual, quarterly, monthly) — plus breakdowns, coverage years, number of reference areas, source database, and last update; pass a dataset ID to ilostat_describe_indicator for its units and breakdown codes, then to ilostat_query_indicator or ilostat_compare_geographies for values. Every search term must match a word or word prefix in the indicator's label, subject, database, breakdown names, code, or definition; British and American spellings (labour/labor) match alike. Facet counts reflect all applied filters.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    query: blankAsUnset(z.string().max(500).optional()).describe(
      'Plain-language terms, e.g. "youth unemployment" or "informal employment rate". Case, accents, and punctuation are ignored, labor matches labour, and a trailing plural s is tolerated. Omit to browse by filters (results then order by indicator code).',
    ),
    frequency: blankAsUnset(z.enum(['A', 'Q', 'M']).optional()).describe(
      "Keep only datasets of this frequency: A annual, Q quarterly, M monthly. Narrows each hit's datasets; an indicator with none left drops out.",
    ),
    database: blankAsUnset(z.string().max(32).optional()).describe(
      'Source database code, e.g. LFS or ILOEST (the ILO modelled estimates); case-insensitive. ilostat_list_reference topic databases lists them.',
    ),
    subject: blankAsUnset(z.string().max(32).optional()).describe(
      'Subject code, e.g. LUU (unemployment and labour underutilization); case-insensitive. ilostat_list_reference topic subjects lists them.',
    ),
    breakdown: blankAsUnset(z.string().max(32).optional()).describe(
      'Classification type the indicator is broken down by, e.g. AGE, ECO, GEO, SEX; case-insensitive. ilostat_list_reference topic classification_types lists them.',
    ),
    aggregates_only: z
      .boolean()
      .default(false)
      .describe(
        'Keep only datasets carrying World, regional, or income-group rows, dropping indicators with none.',
      ),
    limit: z.number().int().min(1).max(50).default(10).describe('Hits per page (1–50).'),
    cursor: blankAsUnset(z.string().max(256).optional()).describe(
      "Opaque continuation token: the previous page's next_cursor, passed unchanged.",
    ),
  }),

  output: z.object({
    hits: z
      .array(
        z
          .object({
            indicator: z.string().describe('Indicator code (dataset IDs add _A, _Q, or _M).'),
            label: z.string().describe('Indicator label as ILOSTAT publishes it.'),
            subject: CodeLabelSchema('Subject'),
            database: CodeLabelSchema('Source database'),
            classification: z
              .string()
              .optional()
              .describe(
                'Breakdown classification (e.g. SEX_AGE); absent when the indicator has none.',
              ),
            breakdowns: z
              .array(z.string())
              .describe('Breakdown names (e.g. ["sex", "age"]); empty when none.'),
            has_aggregates: z
              .boolean()
              .describe(
                'Whether any listed dataset carries World, regional, or income-group rows.',
              ),
            match_scope: z
              .enum(['label', 'metadata', 'definition'])
              .optional()
              .describe(
                'Where every term matched: label (tier 1), label plus subject, database, breakdowns, and code (tier 2), or the definition text too (tier 3). Absent when browsing without a query.',
              ),
            datasets: z
              .array(HitDatasetSchema)
              .describe('The datasets that pass the filters, annual first.'),
          })
          .describe('One indicator hit.'),
      )
      .describe(
        'This page of hits. With a query: tier, then more reference areas first, then code. Without: by code.',
      ),
    total: z.number().describe('Indicators matched after all filters.'),
    facets: z
      .object({
        databases: z.array(FacetSchema).describe('Matching indicators per source database.'),
        frequencies: z
          .array(
            z
              .object({
                code: z.string().describe('Frequency code (A, Q, M).'),
                count: z.number().describe('Matching indicators with a dataset at this frequency.'),
              })
              .describe('One frequency and its indicator count.'),
          )
          .describe('Matching indicators per frequency.'),
        subjects: z.array(FacetSchema).describe('Matching indicators per subject.'),
      })
      .describe('Counts over the fully filtered match set, not just this page.'),
    next_cursor: z
      .string()
      .optional()
      .describe('Pass as cursor to get the next page; absent on the last page.'),
    catalog_as_of: z
      .string()
      .describe('ISO timestamp the searched catalog was last confirmed current.'),
  }),

  enrichment: {
    truncated: z.boolean().describe('True when more hits remain beyond this page.'),
    shown: z.number().describe('Hits returned on this page.'),
    cap: z.number().describe('The limit applied to this page.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Why the query was browsed by filters alone, how to widen a search that matched nothing, that the cursor starts past the last match, and how to reach the remaining pages — whichever apply, joined.',
      ),
  },

  errors: [
    {
      reason: 'unknown_filter_code',
      code: JsonRpcErrorCode.ValidationError,
      when: 'database, subject, or breakdown is not an ILOSTAT code.',
      recovery:
        'Call ilostat_list_reference with topic databases, subjects, or classification_types to see the valid codes.',
      severity: 'notice',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'cursor does not decode.',
      recovery:
        'Omit cursor to start from the first page, or pass next_cursor from the previous response unchanged.',
      severity: 'notice',
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
    const offset = cursorOffset(input.cursor, ctx);
    const snapshot = await getIlostatServices().catalog.ready(ctx);
    const database = input.database?.toUpperCase();
    const subject = input.subject?.toUpperCase();
    const breakdown = input.breakdown?.toUpperCase();
    const invalid = [
      database && !snapshot.databases.has(database) ? `database ${database}` : undefined,
      subject && !snapshot.subjects.has(subject) ? `subject ${subject}` : undefined,
      breakdown && !snapshot.classificationTypes.has(breakdown)
        ? `breakdown ${breakdown}`
        : undefined,
    ].filter((entry) => entry !== undefined);
    if (invalid.length > 0) {
      throw ctx.fail(
        'unknown_filter_code',
        `Not an ILOSTAT code: ${inlineText(invalid.join(', '))}.`,
        { ...ctx.recoveryFor('unknown_filter_code') },
      );
    }

    const result = searchIndicators(snapshot, {
      aggregatesOnly: input.aggregates_only,
      limit: input.limit,
      offset,
      ...(input.query ? { query: input.query } : {}),
      ...(input.frequency ? { frequency: input.frequency } : {}),
      ...(database ? { database } : {}),
      ...(subject ? { subject } : {}),
      ...(breakdown ? { breakdown } : {}),
    });

    ctx.enrich({ truncated: false, shown: result.hits.length, cap: input.limit });
    // The page guidance replaces the notice slot, so a paged result carries both in it.
    if (result.nextCursor) {
      const pageGuidance = `Showing ${result.hits.length} of ${result.total} matching indicators; pass next_cursor as cursor for the next page.`;
      ctx.enrich.truncated({
        shown: result.hits.length,
        cap: input.limit,
        guidance: result.notice ? `${result.notice} ${pageGuidance}` : pageGuidance,
      });
    } else if (result.notice) {
      ctx.enrich.notice(result.notice);
    }
    ctx.log.info('Searched ILOSTAT indicators', { total: result.total, shown: result.hits.length });

    return {
      hits: result.hits.map(({ indicator, datasets, scope }) => ({
        indicator: indicator.code,
        label: indicator.label,
        subject: indicator.subject,
        database: indicator.database,
        ...(indicator.classification ? { classification: indicator.classification } : {}),
        breakdowns: indicator.breakdowns,
        has_aggregates: datasets.some((dataset) => dataset.hasAggregates),
        ...(scope ? { match_scope: scope } : {}),
        datasets: datasets.map((dataset) => ({
          dataset_id: dataset.id,
          frequency: dataset.frequency,
          data_start: dataset.dataStart,
          data_end: dataset.dataEnd,
          n_ref_area: dataset.nRefArea,
          n_records: dataset.nRecords,
          last_update: dataset.lastUpdate,
          has_aggregates: dataset.hasAggregates,
        })),
      })),
      total: result.total,
      facets: result.facets,
      ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}),
      catalog_as_of: snapshot.asOf,
    };
  },

  format: (result) => {
    const lines = [
      `**${result.total} matching indicator${result.total === 1 ? '' : 's'}** · catalog as of ${result.catalog_as_of}`,
    ];
    for (const hit of result.hits) {
      const breakdowns =
        hit.breakdowns.length > 0 ? hit.breakdowns.map(inlineText).join(', ') : 'none';
      lines.push(
        '',
        `### ${inlineText(hit.indicator)} — ${inlineText(hit.label)}`,
        [
          `Database: ${inlineText(hit.database.label)} (${inlineText(hit.database.code)})`,
          `Subject: ${inlineText(hit.subject.label)} (${inlineText(hit.subject.code)})`,
          `Breakdowns: ${breakdowns}${hit.classification ? ` (${inlineText(hit.classification)})` : ''}`,
          `Has aggregates: ${hit.has_aggregates}`,
          ...(hit.match_scope ? [`Matched on: ${hit.match_scope}`] : []),
        ].join(' · '),
      );
      for (const dataset of hit.datasets) {
        lines.push(
          `- ${inlineText(dataset.dataset_id)} · ${inlineText(FREQUENCY_NAMES.get(dataset.frequency) ?? dataset.frequency)} · ${dataset.data_start}–${dataset.data_end} · ${dataset.n_ref_area} ${dataset.n_ref_area === 1 ? 'area' : 'areas'} · ${dataset.n_records.toLocaleString('en-US')} records · updated ${inlineText(dataset.last_update)} · has aggregates: ${dataset.has_aggregates}`,
        );
      }
    }
    const facetLine = (facets: { code: string; count: number; label?: string }[]) =>
      facets.length > 0
        ? facets
            .map(
              (facet) =>
                `${inlineText(facet.code)}${facet.label ? ` (${inlineText(facet.label)})` : ''}: ${facet.count}`,
            )
            .join(', ')
        : 'none';
    lines.push(
      '',
      '**Facets**',
      `- Databases: ${facetLine(result.facets.databases)}`,
      `- Frequencies: ${facetLine(result.facets.frequencies)}`,
      `- Subjects: ${facetLine(result.facets.subjects)}`,
    );
    if (result.next_cursor) lines.push('', `**next_cursor:** ${result.next_cursor}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
