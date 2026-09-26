/**
 * @fileoverview Observation basis and projection cutoff rules. ILOSTAT rows carry
 * no projection flag; the edition an indicator label names (`… -- ILO modelled
 * estimates, Nov. 2025 (%)`) is the only machine-readable boundary ILO publishes,
 * and an edition year is itself projected, so the cutoff — the last year counted
 * as an estimate — is the year before the edition year. Each row's basis is then
 * decided from its own source label and year, never from its database. Pure
 * functions: the current year is a parameter.
 * @module services/basis/basis
 */

/** Source label of every ILO modelled-estimate row. */
export const MODELLED_SOURCE_LABEL = 'ILO - Modelled Estimates';

/** How an observation came to be: a national or institutional source, the ILO model, or the model past its cutoff. */
export type Basis = 'reported' | 'modelled_estimate' | 'projection';

export const BASES = [
  'reported',
  'modelled_estimate',
  'projection',
] as const satisfies readonly Basis[];

/**
 * A row's basis: `reported` unless its source label is `ILO - Modelled Estimates`;
 * a modelled row is a `projection` when its year is after `projectionAfterYear`.
 * A source code the dictionary cannot decode counts as reported, since only the
 * modelled label marks a row as model output.
 */
export function classifyRow(
  row: { sourceLabel: string | undefined; year: number },
  projectionAfterYear: number,
): Basis {
  if (row.sourceLabel !== MODELLED_SOURCE_LABEL) return 'reported';
  return row.year > projectionAfterYear ? 'projection' : 'modelled_estimate';
}

/** A published estimates edition named in an indicator label. */
export interface Edition {
  /** Whether the edition is an ILO modelled estimates edition (vs. e.g. UN population estimates). */
  ilo: boolean;
  /** As written in the label, e.g. `Nov. 2025`. */
  label: string;
  /** 1–12. */
  month: number;
  year: number;
}

/** How a dataset's projection cutoff was derived. */
export type ProjectionRule = 'edition' | 'catalog_edition' | 'current_year';

export interface ProjectionCutoff {
  /** The edition the cutoff derives from; absent under `current_year`. */
  edition?: string;
  /** Last year counted as an estimate; later modelled years are projections. */
  projectionAfterYear: number;
  rule: ProjectionRule;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** `-- <publisher> estimates…, <Month>[.] <YYYY>` after the label's double dash. */
const EDITION_PATTERN = /--\s*([^,()]*\bestimates\b[^,()]*),\s*([A-Za-z]+\.?)\s+(\d{4})\b/i;

/** The edition an indicator label names, if any. Labels such as `-- 19th ICLS (%)` name none. */
export function parseEdition(label: string): Edition | undefined {
  const match = EDITION_PATTERN.exec(label);
  if (!match) return;
  const [, publisher = '', monthText = '', yearText = ''] = match;
  const month = MONTHS[monthText.slice(0, 3).toLowerCase()];
  if (month === undefined) return;
  return {
    ilo: /\bILO modelled estimates\b/i.test(publisher),
    label: `${monthText} ${yearText}`,
    month,
    year: Number(yearText),
  };
}

/** The latest ILO modelled estimates edition named by any label, by year then month. */
export function latestCatalogEdition(labels: Iterable<string>): Edition | undefined {
  let latest: Edition | undefined;
  for (const label of labels) {
    const edition = parseEdition(label);
    if (!edition?.ilo) continue;
    if (
      !latest ||
      edition.year > latest.year ||
      (edition.year === latest.year && edition.month > latest.month)
    ) {
      latest = edition;
    }
  }
  return latest;
}

/**
 * The first rule that applies: the dataset label's own edition, else the catalog's
 * latest ILO modelled estimates edition (modelled rows outside ILOEST are that
 * edition's output), else the year before the current calendar year.
 */
export function projectionCutoff(
  labelEdition: Edition | undefined,
  catalogEdition: Edition | undefined,
  currentYear: number,
): ProjectionCutoff {
  if (labelEdition) {
    return {
      projectionAfterYear: labelEdition.year - 1,
      rule: 'edition',
      edition: labelEdition.label,
    };
  }
  if (catalogEdition) {
    return {
      projectionAfterYear: catalogEdition.year - 1,
      rule: 'catalog_edition',
      edition: catalogEdition.label,
    };
  }
  return { projectionAfterYear: currentYear - 1, rule: 'current_year' };
}
