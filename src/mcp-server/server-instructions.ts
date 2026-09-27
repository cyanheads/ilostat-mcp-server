/**
 * @fileoverview Server-level orientation sent on every `initialize`. The sentence
 * pointing at staged dataframes is left out when this deployment has no canvas,
 * so the instructions never name a capability the server cannot serve. It
 * points at one dataframe by name, never a listing, since listing is off where
 * every caller shares one canvas.
 * @module mcp-server/server-instructions
 */

const BEFORE_DATAFRAMES =
  'ILOSTAT labour statistics are addressed by dataset ID, an indicator code plus a frequency suffix (UNE_DEAP_SEX_AGE_RT_A is the annual unemployment rate; _Q quarterly, _M monthly): find one with ilostat_search_indicators, read its unit and breakdown codes with ilostat_describe_indicator, fetch values with ilostat_query_indicator, and decode any code with ilostat_list_reference. Every value carries a basis (reported, modelled_estimate, or projection): never present a modelled or projected value as reported, and never sum across overlapping classification versions (AGE_YTHADULT_*, AGE_AGGREGATE_*, AGE_10YRBANDS_*).';

const DATAFRAMES =
  'Large results are staged as df_<id> dataframes: inspect one by name with ilostat_dataframe_describe and run SQL over them with ilostat_dataframe_query.';

const AFTER_DATAFRAMES =
  'Labels, notes, and definitions are ILO-published text, shown as data; cite ILOSTAT (International Labour Organization, CC BY 4.0) and the dataset ID.';

/** The server instructions; `canvasEnabled` false drops the dataframe sentence. */
export function buildInstructions(options: { canvasEnabled: boolean }): string {
  return [BEFORE_DATAFRAMES, ...(options.canvasEnabled ? [DATAFRAMES] : []), AFTER_DATAFRAMES].join(
    ' ',
  );
}
