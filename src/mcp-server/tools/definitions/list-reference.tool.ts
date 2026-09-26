/**
 * @fileoverview `ilostat_list_reference` — decode every code the ILOSTAT surface
 * takes: reference areas, area groups, databases, subjects, sexes, breakdown
 * codes and their classification types, sources, status flags, notes, and
 * frequencies, from the in-memory catalog.
 * @module mcp-server/tools/definitions/list-reference
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  areaCodeInput,
  blankAsUnset,
  blankFreeArray,
  REF_AREA_MESSAGE,
} from '@/mcp-server/tools/tool-helpers.js';
import { normalizeAreaCode } from '@/services/catalog/codes.js';
import { cursorOffset } from '@/services/catalog/paging.js';
import { listReference, REFERENCE_TOPICS } from '@/services/catalog/reference.js';
import { inlineText } from '@/services/catalog/text.js';
import { AREA_GROUP_TYPES } from '@/services/catalog/types.js';
import { getIlostatServices } from '@/services/ilostat-services.js';

const EntrySchema = z
  .object({
    code: z.string().describe('The code other ILOSTAT tools take.'),
    label: z.string().describe('English label published by ILOSTAT.'),
    kind: z
      .enum(['country', 'aggregate'])
      .optional()
      .describe('ref_areas: country, or an X-coded aggregate (World, region, income group).'),
    frequencies: z
      .array(z.string())
      .optional()
      .describe(
        'ref_areas: frequencies with data for the area (A annual, Q quarterly, M monthly).',
      ),
    data_start: z.number().optional().describe('ref_areas: first year with data, any frequency.'),
    data_end: z.number().optional().describe('ref_areas: last year with data, any frequency.'),
    dataset_count: z
      .number()
      .optional()
      .describe(
        'Datasets using the code: per database, subject, or frequency; for ref_areas, datasets with data for the area summed over frequencies.',
      ),
    income_group: z
      .string()
      .optional()
      .describe('ref_areas: World Bank income group, as its X code.'),
    income_group_label: z.string().optional().describe('ref_areas: income group label.'),
    ilo_region: z.string().optional().describe('ref_areas: ILO region, as its X code.'),
    ilo_region_label: z.string().optional().describe('ref_areas: ILO region label.'),
    ilo_subregion_broad: z
      .string()
      .optional()
      .describe('ref_areas: broad ILO subregion, as its X code.'),
    ilo_subregion_broad_label: z
      .string()
      .optional()
      .describe('ref_areas: broad ILO subregion label.'),
    ilo_subregion_detailed: z
      .string()
      .optional()
      .describe('ref_areas: detailed ILO subregion, as its X code.'),
    ilo_subregion_detailed_label: z
      .string()
      .optional()
      .describe('ref_areas: detailed ILO subregion label.'),
    group_types: z
      .array(z.enum(AREA_GROUP_TYPES))
      .optional()
      .describe(
        'area_groups: which grouping levels use the code (world is X01, every country); one code can serve several.',
      ),
    member_count: z.number().optional().describe('area_groups: member countries.'),
    members: z
      .array(
        z
          .object({
            code: z.string().describe('ISO3 code of the member country.'),
            label: z.string().optional().describe('Country name published by ILOSTAT.'),
          })
          .describe('One member country.'),
      )
      .optional()
      .describe(
        'area_groups looked up by exact codes only: the member countries, by code. A listing without codes gives member_count alone.',
      ),
    slot: z
      .enum(['classif1', 'classif2', 'both'])
      .optional()
      .describe('classifications: the query parameter slot the code is used in.'),
    classification_type: z
      .string()
      .optional()
      .describe('classifications: the code prefix naming its classification type (AGE, ECO, …).'),
    ref_area: z.string().optional().describe('sources: the reference area the source belongs to.'),
    source_type: z
      .string()
      .optional()
      .describe('sources: the label prefix before " - " (LFS, PC, ADM, ILO, OE, …).'),
    note_type: z
      .string()
      .optional()
      .describe('notes: note_source, note_indicator, or note_classif.'),
  })
  .describe('One decoded code; fields beyond code and label depend on the topic.');

export const listReferenceTool = tool('ilostat_list_reference', {
  title: 'List ILOSTAT reference codes',
  description:
    "Decode ILOSTAT's code vocabulary: reference areas (ISO3 countries and X-coded aggregates, with World Bank income group and ILO region), the groups that area_group accepts (X01 for every country, ILO regions and subregions, World Bank income groups; exact-code lookups list their member countries), databases, subjects, sex codes, breakdown codes for classif1/classif2 with their classification types, per-country data sources, observation status flags, note codes, and frequencies. Filter by text or look up exact codes; long topics page with a cursor. These are ILOSTAT-wide vocabularies; ilostat_describe_indicator lists the sex and breakdown codes one dataset actually uses.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    topic: z
      .enum(REFERENCE_TOPICS)
      .describe(
        'Vocabulary to list: ref_areas, area_groups (the X codes area_group accepts), databases, subjects, sexes, classifications (classif1/classif2 codes), classification_types, sources, obs_status, notes, or frequencies.',
      ),
    filter: blankAsUnset(z.string().optional()).describe(
      'Text filter: every word must match a word or word prefix of the code or label (case, accents, and punctuation ignored; labor matches labour). Omit to list the whole topic.',
    ),
    codes: blankFreeArray(z.array(z.string()).max(100).optional()).describe(
      'Exact codes to look up (up to 100; case-insensitive, and ILO_GEO_ forms accepted for ref_areas and area_groups). Codes the topic lacks are listed in not_found. With topic area_groups, each group found also lists its member countries.',
    ),
    ref_area: blankAsUnset(areaCodeInput(REF_AREA_MESSAGE).optional()).describe(
      'Topic sources only: list the sources of this reference area (ISO3 or X code; case-insensitive, ILO_GEO_ forms accepted).',
    ),
    classification_type: blankAsUnset(z.string().optional()).describe(
      'Topic classifications only: keep codes of this classification type, the code prefix (AGE, ECO, EDU, …).',
    ),
    limit: z.number().int().min(1).max(500).default(50).describe('Entries per page (1–500).'),
    cursor: blankAsUnset(z.string().optional()).describe(
      "Opaque continuation token: the previous page's next_cursor, passed unchanged.",
    ),
  }),

  output: z.object({
    topic: z.enum(REFERENCE_TOPICS).describe('The topic listed.'),
    entries: z
      .array(EntrySchema)
      .describe(
        "This page of decoded codes, ordered by code — except sexes, which keep the ILOSTAT dictionary's order (SEX_T first), and frequencies, listed annual, quarterly, monthly.",
      ),
    total: z.number().describe('Entries matching the filters, across all pages.'),
    next_cursor: z
      .string()
      .optional()
      .describe('Pass as cursor to get the next page; absent on the last page.'),
    not_found: z
      .array(z.string())
      .optional()
      .describe('Requested codes the topic does not contain; present only when codes missed.'),
    catalog_as_of: z
      .string()
      .describe('ISO timestamp the in-memory catalog was last confirmed current.'),
  }),

  enrichment: {
    truncated: z.boolean().describe('True when more entries remain beyond this page.'),
    shown: z.number().describe('Entries returned on this page.'),
    cap: z.number().describe('The limit applied to this page.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Why a filter with no searchable word was not applied, why nothing matched, and how to reach the remaining pages — whichever apply, joined.',
      ),
  },

  errors: [
    {
      reason: 'unknown_code',
      code: JsonRpcErrorCode.ValidationError,
      when: 'ref_area is not an ILOSTAT reference area.',
      recovery:
        'Call ilostat_list_reference with topic ref_areas and a name filter to find the area code.',
      severity: 'notice',
    },
    {
      reason: 'param_not_for_topic',
      code: JsonRpcErrorCode.ValidationError,
      when: 'ref_area with a topic other than sources, or classification_type with a topic other than classifications.',
      recovery:
        'Pass ref_area only with topic sources and classification_type only with topic classifications, or drop it.',
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
    if (input.ref_area && input.topic !== 'sources') {
      throw ctx.fail(
        'param_not_for_topic',
        `ref_area applies to topic sources, not ${input.topic}.`,
        {
          ...ctx.recoveryFor('param_not_for_topic'),
        },
      );
    }
    if (input.classification_type && input.topic !== 'classifications') {
      throw ctx.fail(
        'param_not_for_topic',
        `classification_type applies to topic classifications, not ${input.topic}.`,
        { ...ctx.recoveryFor('param_not_for_topic') },
      );
    }

    const offset = cursorOffset(input.cursor, ctx);
    const snapshot = await getIlostatServices().catalog.ready(ctx);
    const refArea = input.ref_area ? normalizeAreaCode(input.ref_area) : undefined;
    if (refArea && !snapshot.refAreas.has(refArea)) {
      throw ctx.fail('unknown_code', `${inlineText(refArea)} is not an ILOSTAT reference area.`, {
        field: 'ref_area',
        ...ctx.recoveryFor('unknown_code'),
      });
    }

    const result = listReference(snapshot, {
      topic: input.topic,
      limit: input.limit,
      offset,
      ...(input.filter ? { filter: input.filter } : {}),
      ...(input.codes?.length ? { codes: input.codes } : {}),
      ...(refArea ? { refArea } : {}),
      ...(input.classification_type
        ? { classificationType: input.classification_type.toUpperCase() }
        : {}),
    });

    ctx.enrich({ truncated: false, shown: result.entries.length, cap: input.limit });
    // The page guidance replaces the notice slot, so a paged result carries both in it.
    if (result.nextCursor) {
      const pageGuidance = `Showing ${result.entries.length} of ${result.total} ${input.topic} entries; pass next_cursor as cursor for the next page.`;
      ctx.enrich.truncated({
        shown: result.entries.length,
        cap: input.limit,
        guidance: result.notice ? `${result.notice} ${pageGuidance}` : pageGuidance,
      });
    } else if (result.notice) {
      ctx.enrich.notice(result.notice);
    }
    ctx.log.info('Listed ILOSTAT reference codes', {
      topic: input.topic,
      total: result.total,
      shown: result.entries.length,
    });

    return {
      topic: input.topic,
      entries: result.entries,
      total: result.total,
      ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}),
      ...(result.notFound ? { not_found: result.notFound } : {}),
      catalog_as_of: snapshot.asOf,
    };
  },

  format: (result) => {
    const lines = [
      `## ${result.topic} — ${result.total} entr${result.total === 1 ? 'y' : 'ies'}`,
      `Catalog as of ${result.catalog_as_of}`,
      '',
      ...result.entries.map(renderEntry),
    ];
    if (result.not_found?.length) {
      lines.push('', `**Not found:** ${result.not_found.map(inlineText).join(', ')}`);
    }
    if (result.next_cursor) lines.push('', `**next_cursor:** ${result.next_cursor}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function renderEntry(entry: z.infer<typeof EntrySchema>): string {
  const details: string[] = [];
  if (entry.kind) details.push(entry.kind);
  if (entry.frequencies?.length) details.push(`frequencies ${entry.frequencies.join('/')}`);
  if (entry.data_start !== undefined || entry.data_end !== undefined) {
    details.push(`${entry.data_start ?? '?'}–${entry.data_end ?? '?'}`);
  }
  if (entry.dataset_count !== undefined) details.push(`${entry.dataset_count} datasets`);
  if (entry.income_group) {
    details.push(
      `income ${entry.income_group} ${inlineText(entry.income_group_label ?? '')}`.trim(),
    );
  }
  if (entry.ilo_region) {
    details.push(`region ${entry.ilo_region} ${inlineText(entry.ilo_region_label ?? '')}`.trim());
  }
  if (entry.ilo_subregion_broad) {
    details.push(
      `subregion ${entry.ilo_subregion_broad} ${inlineText(entry.ilo_subregion_broad_label ?? '')}`.trim(),
    );
  }
  if (entry.ilo_subregion_detailed) {
    details.push(
      `detailed subregion ${entry.ilo_subregion_detailed} ${inlineText(entry.ilo_subregion_detailed_label ?? '')}`.trim(),
    );
  }
  if (entry.group_types?.length) details.push(`group ${entry.group_types.join(', ')}`);
  if (entry.member_count !== undefined) details.push(`${entry.member_count} members`);
  if (entry.slot) details.push(`slot ${entry.slot}`);
  if (entry.classification_type) details.push(`type ${entry.classification_type}`);
  if (entry.ref_area) details.push(`area ${entry.ref_area}`);
  if (entry.source_type) details.push(`source type ${inlineText(entry.source_type)}`);
  if (entry.note_type) details.push(entry.note_type);
  const suffix = details.length > 0 ? ` · ${details.join(' · ')}` : '';
  const line = `- **${inlineText(entry.code)}** — ${inlineText(entry.label)}${suffix}`;
  if (!entry.members) return line;
  const members = entry.members.map((member) =>
    `${inlineText(member.code)} ${inlineText(member.label ?? '')}`.trim(),
  );
  return `${line}\n  - members: ${members.join(', ')}`;
}
