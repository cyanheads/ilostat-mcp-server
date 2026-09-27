/**
 * @fileoverview `ilostat_get_country_profile` — headline labour-market figures for
 * one reference area. Each indicator carries its latest reported value (national
 * or institutional source) and, separately, its latest non-projected ILO modelled
 * estimate; a missing reported value stays missing and is never filled from the
 * model. Aggregates have modelled values only.
 * @module mcp-server/tools/definitions/get-country-profile
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  areaCodeInput,
  blankAsUnset,
  REF_AREA_MESSAGE,
  tableCell,
} from '@/mcp-server/tools/tool-helpers.js';
import { ATTRIBUTION } from '@/services/attribution.js';
import { normalizeSexCode } from '@/services/catalog/codes.js';
import { inlineText } from '@/services/catalog/text.js';
import { getIlostatServices } from '@/services/ilostat-services.js';

const CodeLabelSchema = (what: string) =>
  z
    .object({
      code: z.string().describe(`${what} code (X-coded).`),
      label: z.string().describe(`${what} label.`),
    })
    .describe(`${what} the area belongs to.`);

/**
 * The notice for keys with no reported value: the model-output sentence names
 * only the keys a modelled estimate stands in for, and keys with neither value
 * are said to have none.
 */
function reportedMissingNotice(missing: readonly string[], modelled: ReadonlySet<string>): string {
  const lead = `No reported value exists for ${missing.join(', ')}`;
  const withModel = missing.filter((key) => modelled.has(key));
  if (withModel.length === 0) {
    return `${lead}, and ${missing.length === 1 ? 'it has no' : 'none has an'} ILO modelled estimate either.`;
  }
  const withoutModel = missing.filter((key) => !modelled.has(key));
  const named =
    withoutModel.length > 0 ? withModel.join(', ') : withModel.length === 1 ? 'it' : 'them';
  const modelSentence =
    withModel.length === 1
      ? `the modelled estimate shown for ${named} is ILO model output, not a national observation.`
      : `the modelled estimates shown for ${named} are ILO model output, not national observations.`;
  const tail =
    withoutModel.length > 0
      ? ` ${withoutModel.join(', ')} ${withoutModel.length === 1 ? 'has' : 'have'} no modelled estimate either.`
      : '';
  return `${lead}; ${modelSentence}${tail}`;
}

export const getCountryProfileTool = tool('ilostat_get_country_profile', {
  title: 'Get an ILOSTAT labour-market profile',
  description:
    'Build a headline labour-market profile for one reference area: labour force participation, employment-to-population ratio, unemployment and youth unemployment rates, youth NEET rate, informal employment rate, employment level, labour income share, and working poverty rate. Each indicator shows its latest reported value (from a national or institutional source, with its source and notes) and, separately, its latest ILO modelled estimate that is not a projection, each with its dataset, period, and status — a missing reported value stays missing and is never filled from the model. Accepts a country (ISO3, e.g. KEN) or an X-coded aggregate (X01 World, regions, income groups), for which only modelled values exist.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    ref_area: areaCodeInput(REF_AREA_MESSAGE).describe(
      'One reference area with annual data: an ISO3 country code (KEN) or an X-coded aggregate (X01 World, X06, X02); ILO_GEO_ forms accepted, case-insensitive. ilostat_list_reference topic ref_areas lists them.',
    ),
    sex: blankAsUnset(
      z.preprocess(
        (value) => (typeof value === 'string' ? normalizeSexCode(value) : value),
        z.enum(['SEX_T', 'SEX_M', 'SEX_F']).default('SEX_T'),
      ),
    ).describe(
      'SEX_T (default), SEX_M, or SEX_F; T/M/F and total/both/male/female are accepted. Indicators without a sex breakdown (labour income share) are unaffected.',
    ),
  }),

  output: z.object({
    ref_area: z
      .object({
        code: z.string().describe('Reference area code.'),
        label: z.string().describe('Reference area label.'),
        kind: z.enum(['country', 'aggregate']).describe('country or X-coded aggregate.'),
        income_group: CodeLabelSchema('World Bank income group').optional(),
        region: CodeLabelSchema('ILO region').optional(),
        subregion: CodeLabelSchema('ILO broad subregion').optional(),
      })
      .describe('The area profiled.'),
    sex: z.string().describe('Sex code profiled.'),
    indicators: z
      .array(
        z
          .object({
            key: z.string().describe('Headline key, e.g. unemployment_rate.'),
            label: z.string().describe('Headline label.'),
            unit: z.string().describe('Unit of both values (% or thousands).'),
            reported: z
              .object({
                dataset_id: z.string().describe('Dataset the value comes from.'),
                period: z.string().describe('Period of the value.'),
                value: z.number().optional().describe('Value; absent when upstream sent none.'),
                source: z.string().describe('Source code.'),
                source_label: z.string().optional().describe('Source label.'),
                obs_status: z.string().optional().describe('Observation status flag.'),
                obs_status_label: z.string().optional().describe('Status flag label.'),
                notes: z
                  .array(
                    z
                      .object({
                        code: z.string().describe('Note code.'),
                        label: z.string().optional().describe('Note label.'),
                      })
                      .describe('One note attached to the value.'),
                  )
                  .describe('Notes attached to the value.'),
              })
              .optional()
              .describe('Latest reported value; absent when none exists.'),
            modelled: z
              .object({
                dataset_id: z.string().describe('Modelled dataset the value comes from.'),
                period: z.string().describe('Period of the value.'),
                value: z.number().optional().describe('Value; absent when upstream sent none.'),
                basis: z
                  .literal('modelled_estimate')
                  .describe('Always modelled_estimate: projections are excluded.'),
                obs_status: z.string().optional().describe('Observation status flag.'),
                obs_status_label: z.string().optional().describe('Status flag label.'),
                edition: z
                  .string()
                  .optional()
                  .describe('Modelled estimates edition, e.g. Nov. 2025.'),
              })
              .optional()
              .describe('Latest non-projected ILO modelled estimate; absent when none exists.'),
          })
          .describe('One headline indicator.'),
      )
      .describe('The headline indicators, in a fixed order.'),
    reported_missing: z
      .array(z.string())
      .describe('Keys with no reported value, including those that have no reported dataset.'),
    modelled_cutoff_year: z
      .number()
      .describe(
        'Latest year the modelled values could come from; later modelled years are projections.',
      ),
    catalog_as_of: z.string().describe('ISO timestamp the catalog was last confirmed current.'),
    attribution: z.string().describe('Citation to keep with any use of the data.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Which indicators have no reported value, and which of those have an ILO modelled estimate instead.',
      ),
  },

  errors: [
    {
      reason: 'unknown_area',
      code: JsonRpcErrorCode.ValidationError,
      when: 'ref_area is not an ILOSTAT reference area with annual data.',
      recovery:
        'Call ilostat_list_reference with topic ref_areas and a name filter to find the ISO3 or X-coded area code.',
      severity: 'notice',
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
    const { catalog, profiles } = getIlostatServices();
    const snapshot = await catalog.ready(ctx);
    const area = snapshot.refAreas.get(input.ref_area);
    if (!area?.frequencies.includes('A')) {
      throw ctx.fail(
        'unknown_area',
        `${input.ref_area} is not an ILOSTAT reference area with annual data.`,
        { refArea: input.ref_area, ...ctx.recoveryFor('unknown_area') },
      );
    }

    const profile = await profiles.profile(snapshot, area, input.sex, ctx);
    if (profile.reportedMissing.length > 0) {
      const modelled = new Set(
        profile.indicators.filter((entry) => entry.modelled).map((entry) => entry.key),
      );
      ctx.enrich.notice(reportedMissingNotice(profile.reportedMissing, modelled));
    }
    ctx.log.info('Built ILOSTAT profile', {
      refArea: area.code,
      sex: input.sex,
      reportedMissing: profile.reportedMissing.length,
    });

    return {
      ref_area: {
        code: area.code,
        label: area.label,
        kind: area.kind,
        ...(area.incomeGroup ? { income_group: area.incomeGroup } : {}),
        ...(area.region ? { region: area.region } : {}),
        ...(area.subregionBroad ? { subregion: area.subregionBroad } : {}),
      },
      sex: input.sex,
      indicators: profile.indicators.map((entry) => ({
        key: entry.key,
        label: entry.label,
        unit: entry.unit,
        ...(entry.reported
          ? {
              reported: {
                dataset_id: entry.reported.datasetId,
                period: entry.reported.period,
                ...(entry.reported.value === undefined ? {} : { value: entry.reported.value }),
                source: entry.reported.source,
                ...(entry.reported.sourceLabel ? { source_label: entry.reported.sourceLabel } : {}),
                ...(entry.reported.obsStatus ? { obs_status: entry.reported.obsStatus } : {}),
                ...(entry.reported.obsStatusLabel
                  ? { obs_status_label: entry.reported.obsStatusLabel }
                  : {}),
                notes: entry.reported.notes,
              },
            }
          : {}),
        ...(entry.modelled
          ? {
              modelled: {
                dataset_id: entry.modelled.datasetId,
                period: entry.modelled.period,
                ...(entry.modelled.value === undefined ? {} : { value: entry.modelled.value }),
                basis: 'modelled_estimate' as const,
                ...(entry.modelled.obsStatus ? { obs_status: entry.modelled.obsStatus } : {}),
                ...(entry.modelled.obsStatusLabel
                  ? { obs_status_label: entry.modelled.obsStatusLabel }
                  : {}),
                ...(entry.modelled.edition ? { edition: entry.modelled.edition } : {}),
              },
            }
          : {}),
      })),
      reported_missing: profile.reportedMissing,
      modelled_cutoff_year: profile.modelledCutoffYear,
      catalog_as_of: snapshot.asOf,
      attribution: ATTRIBUTION,
    };
  },

  format: (result) => {
    const area = result.ref_area;
    const groups = [
      area.income_group
        ? `Income group: ${inlineText(`${area.income_group.label} (${area.income_group.code})`)}`
        : undefined,
      area.region
        ? `Region: ${inlineText(`${area.region.label} (${area.region.code})`)}`
        : undefined,
      area.subregion
        ? `Subregion: ${inlineText(`${area.subregion.label} (${area.subregion.code})`)}`
        : undefined,
    ].filter(Boolean);
    const lines = [
      `## ${inlineText(area.label)} (${area.code})`,
      `Kind: ${area.kind} · Sex: ${result.sex}${groups.length > 0 ? ` · ${groups.join(' · ')}` : ''}`,
      `Modelled values through ${result.modelled_cutoff_year} (later years are projections and are excluded).`,
      '',
      '| indicator | reported | modelled | unit |',
      '| --- | --- | --- | --- |',
    ];
    for (const entry of result.indicators) {
      const reported = entry.reported
        ? `${entry.reported.value ?? 'no value'} (${entry.reported.period}${entry.reported.obs_status ? `, ${entry.reported.obs_status}${entry.reported.obs_status_label ? ` ${entry.reported.obs_status_label}` : ''}` : ''})`
        : '—';
      const modelled = entry.modelled
        ? `${entry.modelled.value ?? 'no value'} (${entry.modelled.period}, ${entry.modelled.basis}${entry.modelled.obs_status ? `, ${entry.modelled.obs_status}${entry.modelled.obs_status_label ? ` ${entry.modelled.obs_status_label}` : ''}` : ''})`
        : '—';
      lines.push(
        `| ${tableCell(`${entry.label} (${entry.key})`)} | ${tableCell(reported)} | ${tableCell(modelled)} | ${entry.unit} |`,
      );
    }
    lines.push('', '**Sources and notes:**');
    for (const entry of result.indicators) {
      const parts: string[] = [];
      if (entry.reported) {
        parts.push(
          `reported ${entry.reported.dataset_id} from ${inlineText(entry.reported.source)}${entry.reported.source_label ? ` (${inlineText(entry.reported.source_label)})` : ''}`,
        );
        for (const note of entry.reported.notes) {
          parts.push(
            `note ${inlineText(note.code)}${note.label ? `: ${inlineText(note.label)}` : ''}`,
          );
        }
      }
      if (entry.modelled) {
        parts.push(
          `modelled ${entry.modelled.dataset_id}${entry.modelled.edition ? ` (${entry.modelled.edition} edition)` : ''}`,
        );
      }
      lines.push(`- ${entry.key}: ${parts.length > 0 ? parts.join(' · ') : 'no values'}`);
    }
    if (result.reported_missing.length > 0) {
      lines.push('', `**No reported value:** ${result.reported_missing.join(', ')}`);
    }
    lines.push('', `Catalog as of ${result.catalog_as_of}`, result.attribution);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
