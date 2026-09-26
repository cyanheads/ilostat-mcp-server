/**
 * @fileoverview Input and rendering helpers shared by the tool definitions:
 * blank-as-unset wrappers for form clients; the dataset-ID, area-code, sex,
 * period, and year inputs, each normalized in the schema before its pattern or
 * enum runs, so every form a description promises is accepted; and the guards
 * for ILO-published text in `content[]` — blockquotes for multi-line text,
 * escaped table cells.
 * @module mcp-server/tools/tool-helpers
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  normalizeAreaCode,
  normalizeDatasetId,
  normalizeSexCode,
} from '@/services/catalog/codes.js';
import { inlineText } from '@/services/catalog/text.js';

/**
 * Optional string input: trimmed, and `''` or whitespace-only treated as unset
 * (form clients submit every optional field blank) before the inner schema runs.
 */
export const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }, schema);

/** Optional string-array input: elements trimmed and blank elements dropped before the inner schema runs. */
export const blankFreeArray = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) =>
      Array.isArray(value)
        ? value
            .map((item) => (typeof item === 'string' ? item.trim() : item))
            .filter((item) => item !== '')
        : value,
    schema,
  );

/**
 * Dataset-ID array input: an element holding `+`- or `,`-joined IDs is split,
 * then elements are trimmed and blanks dropped before the inner schema runs.
 */
export const splitIdArray = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) =>
      Array.isArray(value)
        ? value
            .flatMap((item) =>
              typeof item === 'string' ? item.split(/[+,]/).map((part) => part.trim()) : [item],
            )
            .filter((item) => item !== '')
        : value,
    schema,
  );

/** A normalized dataset ID or bare indicator code: letters, digits, and underscores. */
export const DATASET_ID_PATTERN = /^[A-Z0-9_]+$/;

const DATASET_ID_MESSAGE =
  'Expected a dataset ID such as UNE_DEAP_SEX_AGE_RT_A (letters, digits, and underscores); find one with ilostat_search_indicators.';

/**
 * Dataset-ID input: trimmed, uppercased, and an SDMX `DF_` prefix stripped
 * before `pattern` runs. Pass a wider pattern where the handler answers a
 * joined value itself.
 */
export const datasetIdInput = (pattern: RegExp = DATASET_ID_PATTERN) =>
  z.preprocess(
    (value) => (typeof value === 'string' ? normalizeDatasetId(value) : value),
    z.string().regex(pattern, DATASET_ID_MESSAGE),
  );

/** A normalized reference-area or area-group code: three letters or digits (`KEN`, `X01`, `XA1`). */
export const AREA_CODE_PATTERN = /^[A-Z0-9]{3}$/;

/**
 * Reference-area or area-group input: trimmed, uppercased, and the `ILO_GEO_`
 * and `ILO_GEO_WB_INC_` group prefixes stripped before the pattern runs.
 */
export const areaCodeInput = (message: string) =>
  z.preprocess(
    (value) => (typeof value === 'string' ? normalizeAreaCode(value) : value),
    z.string().regex(AREA_CODE_PATTERN, message),
  );

export const REF_AREA_MESSAGE =
  'Expected an ISO3 country code (KEN) or an X-coded aggregate (X01); ilostat_list_reference topic ref_areas lists them.';

export const AREA_GROUP_MESSAGE =
  'Expected an X-coded area group such as X06; ilostat_list_reference topic area_groups lists them.';

/** The ILOSTAT sex codes. */
export const SEX_CODES = ['SEX_T', 'SEX_M', 'SEX_F', 'SEX_O'] as const;

/** Sex input: `T`/`M`/`F`/`O` and `total`/`both`/`male`/`female`/`other` mapped onto the codes before the enum runs. */
export const sexCodeInput = () =>
  z.preprocess(
    (value) => (typeof value === 'string' ? normalizeSexCode(value) : value),
    z.enum(SEX_CODES),
  );

/** A staged dataframe name as the canvas mints it. */
export const DATAFRAME_NAME_PATTERN = /^df_[A-Z0-9]{5}_[A-Z0-9]{5}$/;

/**
 * Dataframe-name input: trimmed, and a `df_` prefix in any case folded to the
 * minted form (`df_` plus the rest uppercased) before the pattern runs, so a
 * name copied from SQL, where names are case-insensitive, resolves. `field`
 * names the parameter in the rejection message.
 */
export const dataframeNameInput = (field: string) =>
  z.preprocess(
    (value) => {
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      return /^df_/i.test(trimmed) ? `df_${trimmed.slice(3).toUpperCase()}` : trimmed;
    },
    z
      .string()
      .regex(
        DATAFRAME_NAME_PATTERN,
        `${field} must match df_XXXXX_XXXXX: letters and digits, five in each part.`,
      ),
  );

/** `YYYY`, `YYYYQn`, or `YYYYMmm`. */
export const PERIOD_PATTERN = /^\d{4}(Q[1-4]|M(0[1-9]|1[0-2]))?$/;

/**
 * Trim and uppercase; `2024-Q2` and `2024 Q2` → `2024Q2`; `2025-03` → `2025M03`.
 * Anything else is returned for the pattern to judge.
 */
export function normalizePeriod(value: string): string {
  const upper = value.trim().toUpperCase();
  const quarter = /^(\d{4})[-\s]?Q([1-4])$/.exec(upper);
  if (quarter) return `${quarter[1]}Q${quarter[2]}`;
  const month = /^(\d{4})-(\d{2})$/.exec(upper);
  if (month) return `${month[1]}M${month[2]}`;
  return upper;
}

/**
 * Optional period input: blank is unset, a bare number becomes its digits, the
 * {@link normalizePeriod} forms are applied, and then the pattern runs.
 */
export const periodInput = () =>
  blankAsUnset(
    z
      .preprocess(
        (value) =>
          typeof value === 'number'
            ? String(value)
            : typeof value === 'string'
              ? normalizePeriod(value)
              : value,
        z
          .string()
          .regex(
            PERIOD_PATTERN,
            'Expected a period YYYY, YYYYQn, or YYYYMmm (e.g. 2024, 2024Q2, 2025M03).',
          ),
      )
      .optional(),
  );

/** Optional four-digit year input: blank is unset and a bare number becomes its digits. */
export const yearInput = () =>
  blankAsUnset(
    z
      .preprocess(
        (value) => (typeof value === 'number' ? String(value) : value),
        z.string().regex(/^\d{4}$/, 'Expected a four-digit year such as 2015.'),
      )
      .optional(),
  );

/** Upstream text as a markdown blockquote, every line prefixed so none escapes the quote. */
export function blockquote(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => `> ${line}`)
    .join('\n');
}

/** Text for one markdown table cell: line breaks flattened, then `\` and `|` escaped. */
export function tableCell(text: string): string {
  return inlineText(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}
