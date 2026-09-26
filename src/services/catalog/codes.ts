/**
 * @fileoverview Code normalization shared by the catalog and the tools — the
 * certain mappings only; nothing here fuzzy-matches a code.
 * @module services/catalog/codes
 */

/** Frequency order datasets are listed in. */
export const FREQUENCY_ORDER = ['A', 'Q', 'M'] as const;

/**
 * Reference-area and area-group codes: trim, uppercase, and map the ToC's group
 * forms onto the X-coded areas they name one-to-one
 * (`ILO_GEO_X06` → `X06`, `ILO_GEO_WB_INC_X02` → `X02`).
 */
export function normalizeAreaCode(code: string): string {
  return code
    .trim()
    .toUpperCase()
    .replace(/^ILO_GEO_(?:WB_INC_)?/, '');
}

/** Dataset-ID and indicator-code input: trim, uppercase, and strip the SDMX `DF_` dataflow prefix. */
export function normalizeDatasetId(id: string): string {
  return id.trim().toUpperCase().replace(/^DF_/, '');
}

/** Prefix before the first underscore — a classification code's type (`AGE` for `AGE_YTHADULT_YGE15`). */
export function classificationTypeOf(code: string): string {
  return code.split('_', 1)[0] ?? code;
}

const SEX_ALIASES: Record<string, string> = {
  T: 'SEX_T',
  TOTAL: 'SEX_T',
  BOTH: 'SEX_T',
  M: 'SEX_M',
  MALE: 'SEX_M',
  F: 'SEX_F',
  FEMALE: 'SEX_F',
  O: 'SEX_O',
  OTHER: 'SEX_O',
};

/** Sex input: trim, uppercase, and map `T`/`M`/`F`/`O` and `total`/`both`/`male`/`female`/`other` onto the `SEX_*` codes. */
export function normalizeSexCode(code: string): string {
  const upper = code.trim().toUpperCase();
  return SEX_ALIASES[upper] ?? upper;
}

/** Breakdown and classification input: trim and uppercase. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

/** The frequency a period string names: `2024` annual, `2024Q2` quarterly, `2024M03` monthly. */
export function periodFrequency(period: string): 'A' | 'Q' | 'M' {
  if (/^\d{4}Q/.test(period)) return 'Q';
  if (/^\d{4}M/.test(period)) return 'M';
  return 'A';
}

/** The year of a period string. */
export function periodYear(period: string): number {
  return Number(period.slice(0, 4));
}

/** Quarter (1–4) or month (1–12) of a sub-annual period; `undefined` for an annual one. */
export function periodSubperiod(period: string): number | undefined {
  const sub = /^\d{4}[QM](\d{1,2})$/.exec(period)?.[1];
  return sub === undefined ? undefined : Number(sub);
}

/** The same sub-period `years` earlier: `2024Q2` → `2014Q2` for 10 years. */
export function periodYearsBefore(period: string, years: number): string {
  return `${periodYear(period) - years}${period.slice(4)}`;
}

/** Which breakdowns a dataset has, read from its ToC classification (`SEX_AGE_GEO`). */
export function breakdownsOf(classification: string | undefined): {
  classif1: boolean;
  classif2: boolean;
  sex: boolean;
} {
  const components = classification ? classification.split('_').filter(Boolean) : [];
  const others = components.filter((component) => component !== 'SEX').length;
  return { sex: components.includes('SEX'), classif1: others >= 1, classif2: others >= 2 };
}
