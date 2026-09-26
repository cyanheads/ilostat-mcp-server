/**
 * @fileoverview Output schemas and renderers shared by the observation tools
 * (`ilostat_query_indicator`, `ilostat_compare_geographies`): the per-dataset
 * meta block — label, frequency, database, last update, aggregates, the
 * projection cutoff, and the unit — plus basis counts and the staged-dataframe
 * handle.
 * @module mcp-server/tools/observation-output
 */

import { z } from '@cyanheads/mcp-ts-core';
import { BASES } from '@/services/basis/basis.js';
import { inlineText } from '@/services/catalog/text.js';
import type { ResolvedDataset } from '@/services/observations/observation-rows.js';

const FREQUENCY_NAMES: Record<string, string> = { A: 'annual', Q: 'quarterly', M: 'monthly' };

export const UnitSchema = z
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
  .describe('Unit of the values, already in the multiplier scale; absent when unresolved.');

export const DatasetMetaSchema = z
  .object({
    dataset_id: z.string().describe('Dataset ID.'),
    label: z.string().describe('Dataset label as ILOSTAT publishes it.'),
    frequency: z.string().describe('A (annual), Q (quarterly), or M (monthly).'),
    database: z
      .object({
        code: z.string().describe('Database code.'),
        label: z.string().describe('Database label.'),
      })
      .describe('Source database.'),
    last_update: z.string().describe('Last upstream update, ISO 8601 without zone offset.'),
    has_aggregates: z
      .boolean()
      .describe('Whether the dataset carries World, regional, or income-group rows.'),
    projection_after_year: z
      .number()
      .describe('Last year counted as an estimate; modelled rows after it are classed projection.'),
    projection_rule: z
      .enum(['edition', 'catalog_edition', 'current_year'])
      .describe(
        "How the cutoff was set: the label's edition, the catalog's latest ILO modelled estimates edition, or the year before the current year.",
      ),
    edition: z.string().optional().describe('The edition the cutoff derives from, e.g. Nov. 2025.'),
    unit: UnitSchema.optional(),
  })
  .describe('One requested dataset and how its values are classed.');

export type DatasetMeta = z.infer<typeof DatasetMetaSchema>;

export const BasisCountsSchema = z
  .object({
    reported: z.number().describe('Values from a national or institutional source.'),
    modelled_estimate: z.number().describe('ILO modelled estimates up to the cutoff.'),
    projection: z.number().describe('ILO modelled values after the cutoff.'),
  })
  .describe('Values per basis.');

export const DataframeSchema = z
  .object({
    name: z
      .string()
      .describe('Staged dataframe name (df_XXXXX_XXXXX) for ilostat_dataframe_query SQL.'),
    row_count: z.number().describe('Rows staged.'),
    expires_at: z.string().describe('ISO 8601 expiry of the staged dataframe.'),
  })
  .describe('The staged dataframe holding the full result; present only when staged.');

export function datasetMeta({ dataset, cutoff, unit }: ResolvedDataset): DatasetMeta {
  return {
    dataset_id: dataset.id,
    label: dataset.label,
    frequency: dataset.frequency,
    database: dataset.database,
    last_update: dataset.lastUpdate,
    has_aggregates: dataset.hasAggregates,
    projection_after_year: cutoff.projectionAfterYear,
    projection_rule: cutoff.rule,
    ...(cutoff.edition ? { edition: cutoff.edition } : {}),
    ...(unit
      ? {
          unit: {
            measure: unit.measure,
            ...(unit.measureLabel ? { measure_label: unit.measureLabel } : {}),
            type: unit.type,
            ...(unit.typeLabel ? { type_label: unit.typeLabel } : {}),
            multiplier: unit.multiplier,
            ...(unit.multiplierLabel ? { multiplier_label: unit.multiplierLabel } : {}),
          },
        }
      : {}),
  };
}

/** One dataset as markdown: ID, label, unit, database, update, aggregates, basis rule. */
export function renderDatasetMeta(meta: DatasetMeta, heading: string): string[] {
  const unit = meta.unit
    ? `${meta.unit.measure_label ?? meta.unit.measure} (${meta.unit.measure}) · type ${meta.unit.type_label ?? meta.unit.type} (${meta.unit.type}) · multiplier ${meta.unit.multiplier}${meta.unit.multiplier_label ? ` (${meta.unit.multiplier_label})` : ''}`
    : 'not resolved';
  return [
    `${heading} ${meta.dataset_id} — ${inlineText(meta.label)}`,
    `Frequency: ${FREQUENCY_NAMES[meta.frequency] ?? meta.frequency} (${meta.frequency}) · Database: ${inlineText(`${meta.database.label} (${meta.database.code})`)} · Updated ${inlineText(meta.last_update)} · Has aggregates: ${meta.has_aggregates}`,
    `Unit: ${inlineText(unit)}`,
    `Basis rule: ILO modelled rows through ${meta.projection_after_year} are modelled_estimate, later ones projection (rule ${meta.projection_rule}${meta.edition ? `, edition ${meta.edition}` : ''}); every other source is reported.`,
  ];
}

export function renderBasisCounts(counts: z.infer<typeof BasisCountsSchema>): string {
  return BASES.map((basis) => `${basis} ${counts[basis]}`).join(' · ');
}
