/**
 * @fileoverview `ilostat_describe_indicator` — explain one ILOSTAT dataset before
 * comparing numbers: definition, unit and multiplier, frequency variants and
 * coverage, the sex and breakdown codes it uses (totals marked), covered areas,
 * aggregates, and how its observations are classed as reported, modelled, or
 * projected. Catalog metadata comes from memory; breakdown codes, default slice,
 * unit, and areas from the cached SDMX structure, which degrades to
 * `structure_status: 'unavailable'` rather than failing the call. A breakdown
 * lists only the SDMX codes `ilostat_query_indicator` accepts in that slot.
 * @module mcp-server/tools/definitions/describe-indicator
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { blockquote, datasetIdInput, FREQUENCY_NAMES } from '@/mcp-server/tools/tool-helpers.js';
import { ATTRIBUTION } from '@/services/attribution.js';
import { MODELLED_SOURCE_LABEL } from '@/services/basis/basis.js';
import { normalizeDatasetId } from '@/services/catalog/codes.js';
import { inlineText } from '@/services/catalog/text.js';
import type { CatalogSnapshot } from '@/services/catalog/types.js';
import { getIlostatServices } from '@/services/ilostat-services.js';
import { classificationInSlot } from '@/services/observations/request-validation.js';
import type { BreakdownDimension } from '@/services/structure/sdmx-structure.js';

const RELATED_LIMIT = 20;
const AREAS_PER_LINE = 20;

/**
 * Dataset IDs, also `+`- or `,`-joined with optional spaces around the separator
 * (`A, B`), so a joined value reaches the handler's describe-one-per-call guidance.
 * Spaces only: a line break still fails here, so it is never echoed.
 */
const JOINED_IDS_PATTERN = /^[A-Z0-9_]+( *[+,] *[A-Z0-9_]+)*$/;

const STRUCTURE_NOTICE =
  "Breakdown codes and units are unavailable from the ILOSTAT structure service; ilostat_list_reference topic classifications lists every breakdown code, and the label's parenthetical — (%) or (thousands) — gives the unit.";

const CodeLabelSchema = (what: string) =>
  z
    .object({
      code: z.string().describe(`${what} code.`),
      label: z.string().describe(`${what} label.`),
    })
    .describe(`${what} code and label.`);

const BreakdownSchema = (slot: string) =>
  z
    .object({
      type: z.string().describe(`Classification type of ${slot} (e.g. AGE, ECO, DCL).`),
      type_label: z.string().optional().describe('Classification type label.'),
      codes: z
        .array(
          z
            .object({
              code: z.string().describe(`Code to pass as ${slot}.`),
              label: z.string().describe('Code label.'),
              is_total: z.boolean().describe('Whether the code is the total of its breakdown.'),
            })
            .describe('One breakdown code.'),
        )
        .describe(
          `Codes ILOSTAT's structure service lists for this breakdown that ilostat_query_indicator accepts as ${slot}; classification group headers excluded. The list covers every frequency of the indicator, so a code may have no rows in one dataset.`,
        ),
    })
    .describe(`The ${slot} breakdown.`);

export const describeIndicatorTool = tool('ilostat_describe_indicator', {
  title: 'Describe an ILOSTAT dataset',
  description:
    'Explain one ILOSTAT dataset before comparing numbers: its definition, unit and multiplier, frequency variants and coverage, the sex and breakdown codes in use across its frequencies (the total code of each breakdown marked), the reference areas it covers, whether it carries World/regional/income-group aggregates, and how its observations are classed as reported, modelled, or projected. Accepts a dataset ID (UNE_DEAP_SEX_AGE_RT_A) or a bare indicator code (UNE_DEAP_SEX_AGE_RT), which describes every frequency. An unknown code returns found: false with guidance.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    dataset_id: datasetIdInput(JOINED_IDS_PATTERN, 200).describe(
      'One dataset ID (indicator code plus _A, _Q, or _M, e.g. UNE_DEAP_SEX_AGE_RT_A) or a bare indicator code (UNE_DEAP_SEX_AGE_RT), as ilostat_search_indicators returns them. Case-insensitive; a DF_ prefix (the SDMX dataflow form) is stripped.',
    ),
  }),

  output: z.object({
    found: z.boolean().describe('False when no dataset or indicator has the code.'),
    guidance: z.string().optional().describe('On a miss: how to find a valid dataset ID.'),
    dataset_id: z
      .string()
      .optional()
      .describe('The dataset requested, when a dataset ID (not a bare indicator code) was given.'),
    indicator: z.string().optional().describe('Indicator code.'),
    label: z.string().optional().describe('Indicator label as ILOSTAT publishes it.'),
    definition: z
      .string()
      .optional()
      .describe('ILOSTAT definition of the indicator, HTML stripped; links kept as "text (url)".'),
    measure: CodeLabelSchema(
      'Measure (the quantity measured, shared by breakdown variants)',
    ).optional(),
    database: CodeLabelSchema('Source database').optional(),
    subject: CodeLabelSchema('Subject').optional(),
    datasets: z
      .array(
        z
          .object({
            dataset_id: z.string().describe('Dataset ID.'),
            frequency: z.string().describe('A (annual), Q (quarterly), or M (monthly).'),
            data_start: z.number().describe('First year with data.'),
            data_end: z.number().describe('Last year with data (can include projection years).'),
            n_ref_area: z.number().describe('Reference areas with data.'),
            n_records: z
              .number()
              .describe('Best-source observations an unfiltered download returns.'),
            n_records_all: z.number().describe('Observations including secondary sources.'),
            last_update: z.string().describe('Last upstream update, ISO 8601 without zone offset.'),
            has_aggregates: z
              .boolean()
              .describe('Whether this dataset carries World, regional, or income-group rows.'),
          })
          .describe('One frequency variant of the indicator.'),
      )
      .optional()
      .describe('Every frequency variant of the indicator, annual first.'),
    breakdowns: z
      .object({
        sex: z.boolean().describe('Whether the dataset has a sex breakdown.'),
        sex_codes: z.array(z.string()).describe('Sex codes the dataset uses (SEX_T total).'),
        classif1: BreakdownSchema('classif1').optional(),
        classif2: BreakdownSchema('classif2').optional(),
      })
      .optional()
      .describe(
        "Breakdown codes in use, from ILOSTAT's structure service; absent when structure_status is unavailable.",
      ),
    default_slice: z
      .object({
        sex: z.string().optional().describe('Default sex code.'),
        classif1: z.string().optional().describe('Default classif1 code.'),
        classif2: z.string().optional().describe('Default classif2 code.'),
      })
      .optional()
      .describe(
        "The dataset's total codes from its default view — the slice ilostat_compare_geographies uses when sex, classif1, or classif2 is omitted; a breakdown with no total (deciles) is left out.",
      ),
    unit: z
      .object({
        measure: z.string().describe('Unit code (PT percent, PS persons, LC local currency, …).'),
        measure_label: z.string().optional().describe('Unit label.'),
        type: z.string().describe('Unit type code (RT rate, NB number, …).'),
        type_label: z.string().optional().describe('Unit type label.'),
        multiplier: z
          .number()
          .describe('Power of ten values are expressed in: 0 units, 3 thousands, 6 millions.'),
        multiplier_label: z.string().optional().describe('Multiplier label.'),
      })
      .optional()
      .describe('Unit of the values, already in the multiplier scale; absent when unresolved.'),
    has_aggregates: z
      .boolean()
      .optional()
      .describe(
        'Whether the requested dataset (or, for an indicator code, any of its datasets) carries World, regional, or income-group rows.',
      ),
    ref_areas: z
      .object({
        countries: z.array(z.string()).describe('Country codes with data.'),
        aggregates: z.array(z.string()).describe('X-coded aggregate codes with data.'),
        count: z.number().describe('Reference areas with data.'),
      })
      .optional()
      .describe(
        "Reference areas the indicator covers across its frequencies, from ILOSTAT's structure service; absent when structure_status is unavailable.",
      ),
    basis_rule: z
      .object({
        modelled_source_label: z
          .string()
          .describe('Source label that marks an observation as an ILO modelled estimate.'),
        projection_after_year: z
          .number()
          .describe('Last year counted as an estimate; later modelled years are projections.'),
        projection_rule: z
          .enum(['edition', 'catalog_edition', 'current_year'])
          .describe(
            "How the cutoff was set: the label's edition, the catalog's latest ILO modelled estimates edition, or the year before the current year.",
          ),
        edition: z
          .string()
          .optional()
          .describe('The edition the cutoff derives from, e.g. Nov. 2025.'),
        database_is_modelled: z
          .boolean()
          .describe('Whether the whole database is the ILO modelled estimates (ILOEST).'),
      })
      .optional()
      .describe('How observations are classed reported, modelled_estimate, or projection.'),
    related_datasets: z
      .array(
        z
          .object({
            indicator: z.string().describe('Indicator code.'),
            label: z.string().describe('Indicator label.'),
            classification: z.string().optional().describe('Its breakdown classification.'),
          })
          .describe('An indicator measuring the same quantity.'),
      )
      .optional()
      .describe(
        `Up to ${RELATED_LIMIT} other indicators sharing this measure under other breakdowns.`,
      ),
    structure_status: z
      .enum(['complete', 'unavailable'])
      .optional()
      .describe(
        "unavailable when ILOSTAT's structure service has no entry for the indicator or cannot be reached; breakdowns, default_slice, unit, and ref_areas are then absent.",
      ),
    catalog_as_of: z.string().describe('ISO timestamp the catalog was last confirmed current.'),
    attribution: z.string().optional().describe('Citation to keep with any use of the data.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Where to find breakdown codes and units when the structure service did not supply them.',
      ),
  },

  errors: [
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
    const { catalog, structure } = getIlostatServices();
    const snapshot = await catalog.ready(ctx);
    const requested = normalizeDatasetId(input.dataset_id);

    if (/[+,]/.test(requested)) {
      return miss(
        snapshot,
        `${inlineText(requested)} names several codes; describe one dataset per call, for example UNE_DEAP_SEX_AGE_RT_A, and call again for each of the others.`,
      );
    }
    const dataset = snapshot.datasets.get(requested);
    const indicator = snapshot.indicatorsByCode.get(dataset?.indicator ?? requested);
    if (!indicator) {
      return miss(
        snapshot,
        `No ILOSTAT dataset or indicator has the code ${inlineText(requested)}. Dataset IDs are an indicator code plus _A, _Q, or _M (for example UNE_DEAP_SEX_AGE_RT_A); find one with ilostat_search_indicators.`,
      );
    }

    const lookup = await structure.lookup(indicator.code, indicator.lastUpdate, ctx);
    const shape = lookup.structure;
    const cutoff = catalog.projectionCutoff(indicator, snapshot);
    if (lookup.status === 'unavailable' || !lookup.unit) ctx.enrich.notice(STRUCTURE_NOTICE);
    ctx.log.info('Described ILOSTAT dataset', {
      indicator: indicator.code,
      structureStatus: lookup.status,
      unitResolved: Boolean(lookup.unit),
    });

    /** The SDMX codes the query's slot filter accepts; the rest could only be rejected there. */
    const breakdown = (dimension: BreakdownDimension, slot: 'classif1' | 'classif2') => {
      const typeLabel = snapshot.classificationTypes.get(dimension.id)?.label;
      return {
        type: dimension.id,
        ...(typeLabel ? { type_label: typeLabel } : {}),
        codes: dimension.codes.flatMap((code) => {
          const entry = classificationInSlot(snapshot, code.code, slot);
          return entry ? [{ code: code.code, label: entry.label, is_total: code.isTotal }] : [];
        }),
      };
    };
    const isAggregate = (code: string) =>
      (snapshot.refAreas.get(code)?.kind ?? (code.startsWith('X') ? 'aggregate' : 'country')) ===
      'aggregate';
    const areas = shape ? [...shape.refAreas].sort() : [];
    const related = (snapshot.indicatorsByMeasure.get(indicator.measure.code) ?? [])
      .filter((other) => other.code !== indicator.code)
      .slice(0, RELATED_LIMIT);

    return {
      found: true,
      ...(dataset ? { dataset_id: dataset.id } : {}),
      indicator: indicator.code,
      label: indicator.label,
      ...(indicator.definition ? { definition: indicator.definition } : {}),
      measure: indicator.measure,
      database: indicator.database,
      subject: indicator.subject,
      datasets: indicator.datasets.map((variant) => ({
        dataset_id: variant.id,
        frequency: variant.frequency,
        data_start: variant.dataStart,
        data_end: variant.dataEnd,
        n_ref_area: variant.nRefArea,
        n_records: variant.nRecords,
        n_records_all: variant.nRecordsAll,
        last_update: variant.lastUpdate,
        has_aggregates: variant.hasAggregates,
      })),
      ...(shape
        ? {
            breakdowns: {
              sex: shape.sexCodes !== undefined,
              sex_codes: shape.sexCodes ?? [],
              ...(shape.classif1 ? { classif1: breakdown(shape.classif1, 'classif1') } : {}),
              ...(shape.classif2 ? { classif2: breakdown(shape.classif2, 'classif2') } : {}),
            },
            default_slice: { ...shape.defaultSlice },
            ref_areas: {
              countries: areas.filter((code) => !isAggregate(code)),
              aggregates: areas.filter(isAggregate),
              count: areas.length,
            },
          }
        : {}),
      ...(lookup.unit
        ? {
            unit: {
              measure: lookup.unit.measure,
              ...(lookup.unit.measureLabel ? { measure_label: lookup.unit.measureLabel } : {}),
              type: lookup.unit.type,
              ...(lookup.unit.typeLabel ? { type_label: lookup.unit.typeLabel } : {}),
              multiplier: lookup.unit.multiplier,
              ...(lookup.unit.multiplierLabel
                ? { multiplier_label: lookup.unit.multiplierLabel }
                : {}),
            },
          }
        : {}),
      has_aggregates: dataset ? dataset.hasAggregates : indicator.hasAggregates,
      basis_rule: {
        modelled_source_label: MODELLED_SOURCE_LABEL,
        projection_after_year: cutoff.projectionAfterYear,
        projection_rule: cutoff.rule,
        ...(cutoff.edition ? { edition: cutoff.edition } : {}),
        database_is_modelled: indicator.database.code === 'ILOEST',
      },
      related_datasets: related.map((other) => ({
        indicator: other.code,
        label: other.label,
        ...(other.classification ? { classification: other.classification } : {}),
      })),
      structure_status: lookup.status,
      catalog_as_of: snapshot.asOf,
      attribution: ATTRIBUTION,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    if (!result.found) lines.push('**No match.**');
    if (result.guidance) lines.push(result.guidance);
    if (result.indicator) {
      lines.push(
        `## ${inlineText(result.dataset_id ?? result.indicator)} — ${inlineText(result.label ?? '')}`,
      );
    }
    if (result.dataset_id && result.indicator) {
      lines.push(`Indicator: ${inlineText(result.indicator)}`);
    }
    if (result.database) {
      lines.push(
        `Database: ${inlineText(result.database.label)} (${inlineText(result.database.code)})`,
      );
    }
    if (result.subject) {
      lines.push(
        `Subject: ${inlineText(result.subject.label)} (${inlineText(result.subject.code)})`,
      );
    }
    if (result.measure) {
      lines.push(
        `Measure: ${inlineText(result.measure.label)} (${inlineText(result.measure.code)})`,
      );
    }
    if (result.unit) {
      const { unit } = result;
      lines.push(
        `Unit: ${inlineText(unit.measure_label ?? unit.measure)} (${inlineText(unit.measure)}) · type ${inlineText(unit.type_label ?? unit.type)} (${inlineText(unit.type)}) · multiplier ${unit.multiplier}${unit.multiplier_label ? ` (${inlineText(unit.multiplier_label)})` : ''}`,
      );
    } else if (result.found) {
      lines.push('Unit: not resolved');
    }
    if (result.has_aggregates !== undefined) lines.push(`Has aggregates: ${result.has_aggregates}`);
    if (result.basis_rule) {
      const rule = result.basis_rule;
      lines.push(
        `Basis rule: rows sourced "${rule.modelled_source_label}" are modelled estimates through ${rule.projection_after_year} and projections after it (rule ${rule.projection_rule}${rule.edition ? `, edition ${rule.edition}` : ''}); every other source is reported · database is modelled: ${rule.database_is_modelled}`,
      );
    }
    if (result.structure_status) lines.push(`Structure: ${result.structure_status}`);
    if (result.definition) lines.push('', blockquote(result.definition));

    if (result.datasets?.length) {
      lines.push('', '### Frequency variants');
      for (const variant of result.datasets) {
        lines.push(
          `- ${inlineText(variant.dataset_id)} · ${inlineText(FREQUENCY_NAMES.get(variant.frequency) ?? variant.frequency)} · ${variant.data_start}–${variant.data_end} · ${variant.n_ref_area} ${variant.n_ref_area === 1 ? 'area' : 'areas'} · ${variant.n_records.toLocaleString('en-US')} records (${variant.n_records_all.toLocaleString('en-US')} with secondary sources) · updated ${inlineText(variant.last_update)} · has aggregates: ${variant.has_aggregates}`,
        );
      }
    }

    if (result.breakdowns) {
      const { breakdowns } = result;
      lines.push(
        '',
        '### Breakdowns',
        `Sex breakdown: ${breakdowns.sex}${breakdowns.sex_codes.length > 0 ? ` — ${breakdowns.sex_codes.map(inlineText).join(', ')}` : ''}`,
      );
      for (const [slot, dimension] of [
        ['classif1', breakdowns.classif1],
        ['classif2', breakdowns.classif2],
      ] as const) {
        if (!dimension) continue;
        lines.push(
          `**${slot}** — ${inlineText(dimension.type)}${dimension.type_label ? ` (${inlineText(dimension.type_label)})` : ''}:`,
        );
        for (const code of dimension.codes) {
          lines.push(
            `- ${inlineText(code.code)} — ${inlineText(code.label)}${code.is_total ? ' · is_total: true' : ''}`,
          );
        }
      }
    }
    if (result.default_slice) {
      const slice = result.default_slice;
      const parts = [
        slice.sex ? `sex ${slice.sex}` : undefined,
        slice.classif1 ? `classif1 ${slice.classif1}` : undefined,
        slice.classif2 ? `classif2 ${slice.classif2}` : undefined,
      ].filter(Boolean);
      lines.push(
        `Default slice: ${parts.length > 0 ? inlineText(parts.join(' · ')) : 'no total codes'}`,
      );
    }

    if (result.ref_areas) {
      const areas = result.ref_areas;
      lines.push(
        '',
        '### Reference areas',
        `${areas.count} ${areas.count === 1 ? 'area' : 'areas'}: ${areas.countries.length} ${areas.countries.length === 1 ? 'country' : 'countries'}, ${areas.aggregates.length} ${areas.aggregates.length === 1 ? 'aggregate' : 'aggregates'}`,
      );
      if (areas.aggregates.length > 0) lines.push(`Aggregates: ${areas.aggregates.join(', ')}`);
      for (let i = 0; i < areas.countries.length; i += AREAS_PER_LINE) {
        const chunk = areas.countries.slice(i, i + AREAS_PER_LINE).join(', ');
        lines.push(i === 0 ? `Countries: ${chunk}` : chunk);
      }
    }

    if (result.related_datasets?.length) {
      lines.push('', '### Related indicators (same measure)');
      for (const other of result.related_datasets) {
        lines.push(
          `- ${inlineText(other.indicator)} — ${inlineText(other.label)}${other.classification ? ` (${inlineText(other.classification)})` : ''}`,
        );
      }
    }

    lines.push('', `Catalog as of ${result.catalog_as_of} · found: ${result.found}`);
    if (result.attribution) lines.push(result.attribution);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function miss(snapshot: CatalogSnapshot, guidance: string) {
  return { found: false, guidance, catalog_as_of: snapshot.asOf };
}
