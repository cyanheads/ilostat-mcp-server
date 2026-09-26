# ilostat-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `ilostat_search_indicators` | Search the ILOSTAT indicator catalog by plain-language terms and filters; one hit per indicator with its annual/quarterly/monthly dataset IDs, breakdowns, coverage, and facets. | `query`, `frequency`, `database`, `subject`, `breakdown`, `aggregates_only`, `limit`, `cursor` | readOnly, idempotent, openWorld: false |
| `ilostat_describe_indicator` | Explain one dataset: definition, unit and multiplier, frequency variants, codes actually used per breakdown (totals marked), covered areas, aggregates, and the basis rule. Unknown ID → `found: false`. | `dataset_id` | readOnly, idempotent, openWorld: true |
| `ilostat_query_indicator` | Observations for 1–3 datasets filtered by area, sex, classif1/classif2, source, and period; rows keep source, status, decoded notes, and basis. Large results stage as a `df_<id>` dataframe. | `dataset_ids`, `ref_areas`, `area_group`, `sex`, `classif1`, `classif2`, `sources`, `time`, `time_from`, `time_to`, `latest_only`, `source_selection` | readOnly, idempotent, openWorld: true |
| `ilostat_get_country_profile` | Headline labour-market figures for one area, each with its latest reported value and, separately, its latest non-projected ILO modelled estimate. | `ref_area`, `sex` | readOnly, idempotent, openWorld: true |
| `ilostat_compare_geographies` | Line areas up on one slice of one dataset: value at a common or latest period, optional change, rank, missingness, and mixed-period / mixed-basis flags. | `dataset_id`, `ref_areas`, `area_group`, `sex`, `classif1`, `classif2`, `period`, `lookback_years`, `change_years`, `include_projections`, `sort` | readOnly, idempotent, openWorld: true |
| `ilostat_list_reference` | Decode every code the surface takes: areas, area groups, databases, subjects, sexes, classifications, classification types, sources, status flags, notes, frequencies. | `topic`, `filter`, `codes`, `ref_area`, `classification_type`, `limit`, `cursor` | readOnly, idempotent, openWorld: false |
| `ilostat_dataframe_query` | Single-statement read-only SQL over staged `df_<id>` dataframes. | `sql`, `register_as`, `preview`, `row_limit` | readOnly, idempotent, openWorld: false |
| `ilostat_dataframe_describe` | List staged dataframes with provenance, units, coverage, basis counts, attribution, and column schema. | `name` | readOnly, idempotent, openWorld: false |
| `ilostat_dataframe_drop` | Drop a staged dataframe before its TTL. Registered through `disabledTool()` unless `ILOSTAT_DATAFRAME_DROP_ENABLED=true`. | `name` | readOnly: false, idempotent, openWorld: false |

### Resources

None. Every capability is a tool; see Design Decisions.

### Prompts

None.

## Overview

ILOSTAT is the International Labour Organization's statistical database: employment, unemployment, labour force participation, earnings, working time, informality, labour income, occupational safety, social protection, and more, for ~230 countries and territories plus World, regional, and income-group aggregates. The server wraps two keyless ILO APIs:

- **`rplumber.ilo.org`** — the data path. Tables of contents, code dictionaries, and server-side filtered observation downloads.
- **`sdmx.ilo.org/rest`** — structure only. Per-dataflow dimensions, the codes each dataset actually uses, the explorer's default slice, and units (from a one-observation probe).

The tables of contents and dictionaries (~2,000 datasets, ~9,000 codes) are held in memory and refreshed on a timer; observations are fetched live per query (the corpus is ~400M records). Audience: labour economists, policy researchers, journalists, development teams, unions and employers' organizations, and agents comparing labour markets.

The server's job beyond transport is vocabulary and honesty: dataset IDs and breakdown codes are dense, so discovery and decoding come first; and national observations, ILO modelled estimates, and projections are kept distinct on every row instead of merged into one seamless series.

## Requirements

- Read-only. Published ILOSTAT aggregate statistics and referential metadata only; restricted labour-force-survey microdata is out of scope.
- Keyless upstream, no credentials of any kind. No published rate limit and no rate-limit headers (both hosts sit behind Cloudflare); the server paces itself and caches.
- Identifying `User-Agent` on every upstream request: `ilostat-mcp-server/<version> (+https://github.com/cyanheads/ilostat-mcp-server)`, version from `package.json`.
- Deployment: stdio and Streamable HTTP. `sessionMode: 'stateless'` (no tool asks the caller for input). Hostable: one process serves every caller from one IP, so pacing, caching, and the exhausted-budget behavior below are designed for shared use. Cloudflare Workers is not a target (DataCanvas needs DuckDB).
- DataCanvas on by default: `src/index.ts` sets `process.env.CANVAS_PROVIDER_TYPE ||= 'duckdb'` (a blank value, as a bundle form sends, counts as unset); an operator sets `CANVAS_PROVIDER_TYPE=none` to turn it off.
- Every third-party dependency boots under plain Node ESM (`node dist/index.js`) as well as Bun.
- Terms: ILO databases, datasets, and referential metadata released under the ILO Open Access policy (from 3 May 2023) are CC BY 4.0 — cite ILOSTAT/ILO and keep attribution; older standalone artifacts need an item-specific rights check. No ILO name or emblem as endorsement. Data outputs carry an `attribution` string; the server instructions ask agents to cite ILOSTAT and the dataset ID.
- `ilostat.ilo.org` (the website) is linked in attribution but never fetched — it sits behind a bot challenge.

## User Goals

1. Find the right dataset (indicator + frequency) and its breakdown codes from a plain-language labour question.
2. Read a dataset's definition, unit, frequency variants, breakdowns, coverage, and whether its values are reported or modelled before comparing numbers.
3. Pull time series for countries, groups of countries, or aggregates, with sources, status flags, and notes intact.
4. Get a compact labour-market profile for one country or aggregate.
5. Compare areas on one dataset and slice — levels, change, rank — with missingness and basis exposed.
6. Run SQL over large pulls without re-fetching.

| Goal | Tools |
|:-----|:------|
| 1 | `ilostat_search_indicators`, `ilostat_list_reference` |
| 2 | `ilostat_describe_indicator` |
| 3 | `ilostat_query_indicator` |
| 4 | `ilostat_get_country_profile` |
| 5 | `ilostat_compare_geographies` |
| 6 | `ilostat_dataframe_query`, `ilostat_dataframe_describe`, `ilostat_dataframe_drop` |

## Shared conventions

These apply to every tool below; the per-tool sections refer back to them.

### Identifiers and normalization

Normalize what is certain; reject the rest with a recovery naming `ilostat_list_reference`. Never fuzzy-match a code.

| Input | Accepted forms | Normalization | Rejected |
|:------|:---------------|:--------------|:---------|
| Dataset ID | `UNE_DEAP_SEX_AGE_RT_A` | Trim, uppercase. `DF_` prefix (the SDMX dataflow form) stripped. A bare indicator code (`UNE_DEAP_SEX_AGE_RT`) resolves to its dataset when exactly one frequency exists; with several, the error lists them. In the `dataset_ids` array, an element holding `+`- or `,`-joined IDs is split. | Anything not in the table of contents |
| Reference area | `USA`, `X01` | Uppercase. `ILO_GEO_X06` → `X06`, `ILO_GEO_WB_INC_X02` → `X02` (the ToC's group codes map one-to-one onto the X-coded areas). | ISO2 codes, country names |
| Area group | `X01`, `X06`, `X56`, `X02`, … and the `ILO_GEO_` forms | Same as reference area. `X01` = every country. | Any X code that is not a region, subregion, or income group in the ref_area ToC |
| Sex | `SEX_T`, `SEX_M`, `SEX_F`, `SEX_O` | Uppercase; `T`/`M`/`F`/`O` and `total`/`both`/`male`/`female`/`other` map to the codes. | Anything else |
| classif1 / classif2 | `AGE_YTHADULT_Y15-24`, `ECO_SECTOR_AGR`, … | Uppercase, trim. | Codes absent from the matching dictionary |
| Source | `BA:453` | Uppercase, trim. | Codes absent from the source dictionary |
| Period (`time`, `period`) | `2024`, `2024Q2`, `2025M03` | `2024-Q2`, `2024 Q2` → `2024Q2`; `2025-03` → `2025M03`. | Other shapes; a sub-annual period on a dataset of another frequency |
| Year (`time_from`, `time_to`) | `2010` | — | Anything but four digits (upstream reads the year only) |

Array inputs drop blank elements. Optional string and enum inputs treat `""` as unset (`blankAsUnset` from the `add-tool` skill); an unset filter is left off the upstream request, never sent as `param=` — upstream reads a blank `ref_area=` as "every area".

Period and year inputs are checked in the schema. A `z.preprocess` inside `blankAsUnset` applies the normalizations above (trim, uppercase, `2024-Q2`/`2024 Q2` → `2024Q2`, `2025-03` → `2025M03`), and the pattern runs on its result: `time` and `period` `^\d{4}(Q[1-4]|M(0[1-9]|1[0-2]))?$`, `time_from` and `time_to` `^\d{4}$`. A malformed period is therefore an argument rejection (`invalid_arguments`), and each tool's `invalid_period` covers only what a pattern cannot see (frequency mismatch, conflicting combinations, reversed ranges). Code inputs carry no pattern: they are normalized at the head of the handler and validated against the dictionaries.

Array caps per call: `dataset_ids` 3, `ref_areas` 300, `sex` 4, `classif1`/`classif2`/`sources` 100 each, `codes` 100.

### Basis of an observation

Every observation row carries `basis`:

| basis | Rule |
|:------|:-----|
| `reported` | The row's source label is anything other than `ILO - Modelled Estimates` — a national survey, census, administrative record, or another institution's published figure. |
| `modelled_estimate` | Source label `ILO - Modelled Estimates`, period year at or before the projection cutoff. |
| `projection` | Source label `ILO - Modelled Estimates`, period year after the projection cutoff. |

Projection cutoff per dataset — the last year counted as an estimate — from the first rule that applies:

| `projection_rule` | Cutoff |
|:------------------|:-------|
| `edition` | The label names an edition (`… -- ILO modelled estimates, Nov. 2025 (%)`, `… -- UN estimates and projections, July 2024 …`): the year before the edition year (2024, 2023). |
| `catalog_edition` | No edition in the label: the year before the latest ILO modelled estimates edition named by any label in the catalog (Nov. 2025 → 2024). Modelled rows outside ILOEST are that edition's output — the World unemployment rates in `UNE_DEAP_SEX_AGE_RT_A` and `SDG_0852_SEX_AGE_RT_A` match `UNE_2EAP_SEX_AGE_RT_A` year for year. |
| `current_year` | No label in the catalog names an edition: the year before the current calendar year. |

An edition year is itself projected: the edition is compiled before that year's data exist (see Design Decisions). The cutoff and the rule that produced it are echoed per dataset (`projection_after_year`, `projection_rule`).

`obs_status` is surfaced verbatim with its label and never reinterpreted: in the ILOEST labour-force series `R` (Real value) marks years anchored on reported national data and a blank marks modelled years, but other modelled series use the flags differently — the labour income share carries `I` and `M` (model-based extrapolation), SDG 1.1.1 `A`/`R` — so no row-level "imputed" flag is derived.

### Untrusted text in `content[]`

ILO-published text (indicator labels and definitions, area/source/classification/note labels) is data, and so is caller text echoed back (the search `query`, the reference `filter`, rejected codes in error messages). `format()` and every composed notice blockquote multi-line text (the indicator definition) and flatten CR/LF to a space in every inline slot (headings, bold labels, list items, table cells, quoted echoes — table cells also escape `|` and `\`). `structuredContent` carries values verbatim. The server instructions say this text is data.

### Canvas staging

Producers (`ilostat_query_indicator`, `ilostat_compare_geographies`) stage a result on the tenant's shared canvas when it exceeds the inline preview:

- One shared canvas per tenant, its ID kept in `ctx.state` (`canvas-id`) and re-minted when expired. Tables are named `df_XXXXX_XXXXX` (5 + 5 uppercase letters/digits) and registered with a per-table TTL (`ILOSTAT_DATASET_TTL_SECONDS`).
- Provenance per table in `ctx.state` under `df-meta/<name>`: source tool, query params, created/expires, row count, column schema, the datasets it holds (ID, label, unit, last update), coverage (area count, period min/max), basis counts, attribution. Every dataframe op lazily sweeps expired entries first.
- The producer's output carries `dataframe: { name, row_count, expires_at }` (not `dataset` — in ILOSTAT a dataset is an indicator at one frequency) and a notice composed by one helper so wording never drifts: `Full result staged as df_… (N rows) — use ilostat_dataframe_describe to inspect its columns, then ilostat_dataframe_query to analyze it with SQL.` Emitted only on the branch that actually registered a table.
- Registration is best-effort: a canvas failure logs a warning and the response falls back to the inline preview plus a truncation notice.
- Staged rows use an explicit column schema (a value column whose first rows look integral would otherwise sniff as `BIGINT` and truncate every later decimal). Staged observation columns:

| Column | Type | Notes |
|:-------|:-----|:------|
| `dataset_id`, `indicator`, `indicator_label` | VARCHAR | |
| `ref_area`, `ref_area_label`, `ref_area_kind` | VARCHAR | kind = `country` \| `aggregate` |
| `source`, `source_label` | VARCHAR | |
| `sex`, `sex_label`, `classif1`, `classif1_label`, `classif2`, `classif2_label` | VARCHAR | NULL when the dataset lacks the breakdown |
| `period` | VARCHAR | Upstream period string |
| `year`, `subperiod` | INTEGER | `subperiod` = quarter 1–4 or month 1–12, NULL for annual |
| `value` | DOUBLE | NULL when upstream sends none (~4% of rows in large LFS datasets) |
| `unit`, `unit_multiplier` | VARCHAR, INTEGER | Dataset unit (NULL when unresolved); multiplier 0/3/6 = units/thousands/millions |
| `obs_status`, `obs_status_label` | VARCHAR | |
| `note_codes`, `note_labels` | VARCHAR | `;`-joined codes; ` \| `-joined labels |
| `basis` | VARCHAR | `reported` \| `modelled_estimate` \| `projection` |
| `best_source` | BOOLEAN | Set only when `source_selection` is `all` or `secondary` |

A staged comparison (`ilostat_compare_geographies`) holds one row per area: `dataset_id, rank, ref_area, ref_area_label, ref_area_kind, period, year, subperiod, value, unit, unit_multiplier, basis, source, source_label, obs_status, obs_status_label, note_codes, note_labels, change_from_period, change_from_value, change_delta`, typed as above (`rank` INTEGER, `change_*` VARCHAR/DOUBLE/DOUBLE).

### Catalog-dependent failure

Every tool except the dataframe trio awaits the in-memory catalog. When no snapshot has loaded and the load attempt fails, or the first load has not finished within 30 s of the call, the tool fails with `catalog_unavailable` (`ServiceUnavailable`, retryable, `thrownBy: 'service'`); recovery: `The ILOSTAT catalog could not be loaded from the upstream API; wait about a minute and call the tool again.` Each tool below lists it once in its error table.

### Result shapes

Enrichment keys are declared optional unless every path writes them (`applied_filters` on query and compare is always written). Every search, list, and query result defines its zero-result shape — arrays empty, counts zero, min/max fields absent, a composed `notice` — and a result cut short (a page cap, the canvas-off preview cut, a failed canvas registration) sets `truncated`/`shown`/`cap` and never presents a partial summary as complete.

## Tools — detail

### `ilostat_search_indicators`

**Description:** Search ILOSTAT's catalog of labour-statistics indicators by plain-language terms and filters. Each hit is one indicator with its datasets — one per available frequency (annual, quarterly, monthly) — plus breakdowns, coverage years, number of reference areas, source database, and last update; pass a dataset ID to ilostat_describe_indicator or ilostat_query_indicator. Every search term must match a word or word prefix in the indicator's label, subject, database, breakdown names, code, or definition; British and American spellings (labour/labor) match alike. Facet counts reflect all applied filters.

| Param | Type | Maps to | Notes |
|:------|:-----|:--------|:------|
| `query` | string, optional | local index | Normalized: lowercase, diacritics stripped, punctuation → space, `labor` → `labour`, a trailing plural `s` tolerated. Omit to browse by filters (results then order by indicator code). |
| `frequency` | enum `A` \| `Q` \| `M`, optional | ToC `freq` | Narrows each hit's `datasets`; an indicator with no dataset left drops out. |
| `database` | string, optional | ToC `database` | Uppercased; validated against the database codes in the ToC (17, e.g. `LFS`, `ILOEST`). |
| `subject` | string, optional | ToC `subject` | Uppercased; validated against the subject codes in the ToC. |
| `breakdown` | string, optional | ToC `classification` components | A classification type code (`AGE`, `ECO`, `GEO`, `SEX`, …); validated against the `classif_type` dictionary plus the components the ToC uses (the ToC names one type, `QTL`, that the dictionary lacks). |
| `aggregates_only` | boolean, default `false` | ToC `with.region = "Y"` | Keeps indicators that carry World/regional/income-group rows. |
| `limit` | int 1–50, default 10 | — | Hits per page. |
| `cursor` | string, optional | — | Opaque; from the previous page's `next_cursor`. |

**Ranking rule (transparent, no score exposed):** tier 1 — every term matches the label; tier 2 — every term matches across label, subject, database, breakdown names, and code; tier 3 — the definition text is needed. Within a tier, more reference areas first, then indicator code. Each hit reports its tier as `match_scope: 'label' | 'metadata' | 'definition'`.

**Output**

| Field | Type | Notes |
|:------|:-----|:------|
| `hits[]` | object | `indicator`, `label`, `subject {code,label}`, `database {code,label}`, `classification` (e.g. `SEX_AGE`), `breakdowns` (e.g. `["sex","age"]`; empty when none), `has_aggregates`, `match_scope`, `datasets[] {dataset_id, frequency, data_start, data_end, n_ref_area, n_records, last_update}` |
| `total` | number | Indicators matched after all filters |
| `facets` | object | `databases[] {code,label,count}`, `frequencies[] {code,count}`, `subjects[] {code,label,count}` over the fully filtered match set — every filter narrows the facets as well as the hits |
| `next_cursor` | string, optional | Present while more hits remain |
| `catalog_as_of` | string | ISO timestamp of the snapshot searched |

`last_update` is converted from upstream `dd/mm/yyyy HH:MM:SS` to ISO 8601 without a zone offset (upstream publishes none). Truncation via `ctx.enrich.truncated({ shown, cap })` when `total > limit`.

**Zero-hit notice** (`enrichment.notice`), composed from whichever conditions hold — each relaxation is computed locally:

| Condition | Fragment |
|:----------|:---------|
| Dropping one filter would yield hits | `N indicators match without the {filter} filter — drop it or pick another value.` |
| The terms match nothing even unfiltered | `No indicator matched every term. Use fewer or broader terms (for example "youth unemployment"), or browse subjects with ilostat_list_reference topic subjects and search by subject.` |
| `aggregates_only` removed every hit | `None of these indicators carries regional aggregates; the ILO modelled estimates (database ILOEST) do.` |

**Errors**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `unknown_filter_code` | ValidationError | `database`, `subject`, or `breakdown` is not an ILOSTAT code | `Call ilostat_list_reference with topic databases, subjects, or classification_types to see the valid codes.` |
| `invalid_cursor` | InvalidParams | `cursor` does not decode (the framework's `decodeCursor` rejection, rewrapped with this recovery; `thrownBy: 'service'`) | `Omit cursor to start from the first page, or pass next_cursor from the previous response unchanged.` |
| `catalog_unavailable` | ServiceUnavailable | see Shared conventions | see Shared conventions |

Zero hits: `hits` empty, `total` 0, each facet array empty, no `next_cursor`, plus the notice.

**format():** per hit, `### {indicator} — {label}` (label CR/LF-flattened), a line with database, subject, breakdowns, aggregates flag, match scope, then one line per dataset (`- UNE_DEAP_SEX_AGE_RT_Q · quarterly · 1948–2026 · 122 areas · 658,738 records · updated 2026-…`). Facets as three compact lines; `next_cursor` last.

### `ilostat_describe_indicator`

**Description:** Explain one ILOSTAT dataset before comparing numbers: its definition, unit and multiplier, frequency variants and coverage, the sex and breakdown codes it actually uses (the total code of each breakdown marked), the reference areas it covers, whether it carries World/regional/income-group aggregates, and how its observations are classed as reported, modelled, or projected. Accepts a dataset ID (UNE_DEAP_SEX_AGE_RT_A) or a bare indicator code (UNE_DEAP_SEX_AGE_RT), which describes every frequency. An unknown code returns found: false with guidance.

| Param | Type | Maps to | Notes |
|:------|:-----|:--------|:------|
| `dataset_id` | string, required | ToC `id` / `indicator`; SDMX `DF_{indicator}` | Dataset-ID normalization (Shared conventions). A bare indicator code describes every frequency. One ID per call: a `+`/`,`-joined value is a miss whose guidance says to describe one dataset per call. |

**Output**

| Field | Type | Notes |
|:------|:-----|:------|
| `found` | boolean | `false` on a miss |
| `guidance` | string, optional | Miss only: `No ILOSTAT dataset or indicator has the code {X}. Dataset IDs are an indicator code plus _A, _Q, or _M (for example UNE_DEAP_SEX_AGE_RT_A); find one with ilostat_search_indicators.` A miss carries only `found`, `guidance`, and `catalog_as_of`; every other field is optional in the schema and present only on a hit. |
| `indicator`, `label` | string | |
| `definition` | string | Indicator dictionary description, HTML stripped (`<a href>` → `text (url)`; `<strong>`, `<i>`, `<p>`, `<br>` dropped; `&gt; &lt; &nbsp; &ndash;` decoded) |
| `measure` | `{code, label}` | ToC `rep_var` — the quantity measured, shared by breakdown variants |
| `database`, `subject` | `{code, label}` | |
| `datasets[]` | object | `dataset_id, frequency, data_start, data_end, n_ref_area, n_records, n_records_all, last_update` (`n_records` counts the best-source rows an unfiltered download returns; `n_records_all` adds secondary sources) |
| `breakdowns` | object | `sex: boolean`; `sex_codes[]`; `classif1?` / `classif2?` `{ type, type_label, codes[] {code, label, is_total} }` |
| `default_slice` | object | `sex?`, `classif1?`, `classif2?` — the dataset's total codes (see below); what `ilostat_compare_geographies` uses when a slice is omitted |
| `unit` | object, optional | `measure` (`PT`, `PS`, `LC`, …), `measure_label`, `type` (`RT`, `NB`, …), `type_label`, `multiplier` (0/3/6), `multiplier_label`. Values are already in the multiplier's scale. |
| `has_aggregates` | boolean | ToC `with.region = "Y"` |
| `ref_areas` | object | `countries[]`, `aggregates[]` (codes), `count` |
| `basis_rule` | object | `modelled_source_label` (`ILO - Modelled Estimates`), `projection_after_year`, `projection_rule` (`edition` \| `catalog_edition` \| `current_year`), `edition?` (e.g. `Nov. 2025`; the catalog's latest edition under `catalog_edition`), `database_is_modelled` (ILOEST) |
| `related_datasets[]` | object | Up to 20 other ToC indicators sharing this `measure` — the same quantity under other breakdowns: `{indicator, label, classification}` |
| `structure_status` | `'complete' \| 'unavailable'` | `unavailable` when SDMX has no dataflow for the indicator or is unreachable; breakdown codes, default slice, unit, and area lists are then absent |
| `catalog_as_of`, `attribution` | string | |

Breakdown mapping: SDMX dimensions after `MEASURE`, in position order, excluding `SEX`, become `classif1` then `classif2` (verified on a two-breakdown dataset: `INS` at position 4 arrives as `classif1`, `DSB` at 5 as `classif2`) — the ToC `classification` field is not used for this, because its component names do not always match the codes (`LAP_2LID_QTL_RT` is classified `QTL` but its codes are `DCL_DECILE_*`). Codes in use come from the content constraint's key values; a dimension the constraint omits (`DCL` on `LAP_2LID_QTL_RT`) takes its codes from the partial codelist, which `detail=referencepartial` already limits to codes in use. Classification group headers — codes that are another code's `parent`, such as `AGE_YTHADULT` — are dropped; a parentless leaf such as `DCL_DECILE_01` stays. `is_total` comes from the SDMX `IS_TOTAL` annotation (`Y`/`N` in its title). `default_slice` takes, per dimension ID, the first code the dataflow's `DEFAULT` annotation lists for it (`…,AGE=AGE_YTHADULT_YGE15+…,SEX=SEX_T,…`; entries are keyed by dimension ID, not in dimension order) that carries `IS_TOTAL = Y`; a dimension whose default codes include no total (deciles) is left out.

Unit: one SDMX data probe `…/{AREA}{.…}?lastNObservations=1` using the first `REF_AREA` of the dataflow's content constraint (frequency wildcarded, since units attach to `MEASURE`); on `404 No data` the next area is tried, up to three. `UNIT_*` codes are decoded with the dataflow's codelists.

`enrichment.notice` when `structure_status` is `unavailable` or the unit did not resolve: `Breakdown codes and units are unavailable from the ILOSTAT structure service right now; ilostat_list_reference topic classifications lists every breakdown code, and the label's parenthetical — (%) or (thousands) — gives the unit.`

**Errors**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `catalog_unavailable` | ServiceUnavailable | see Shared conventions | see Shared conventions |

A miss is `found: false`, not an error. SDMX failures degrade to `structure_status: 'unavailable'` with the notice above.

**format():** `## {dataset_id} — {label}`, then database / subject / measure / unit / aggregates / basis rule lines, the definition as a blockquote, a per-frequency coverage list, per-breakdown code lists (`code — label` with `(total)` marks), `default_slice`, area counts plus the aggregate codes and country codes on wrapped lines, related datasets, and the attribution line.

### `ilostat_query_indicator`

**Description:** Fetch observations for up to 3 ILOSTAT datasets, filtered by reference area or area group, sex, breakdown codes (classif1, classif2), source, and period. Rows keep their source, observation status, decoded notes, and a basis — reported, modelled_estimate, or projection — and the response echoes every filter applied, including the best-source default. Codes are checked against ILOSTAT's dictionaries before the request is sent: ilostat_list_reference lists valid codes and ilostat_describe_indicator lists the codes a dataset actually uses. A result larger than the inline preview is staged in full as a df_<id> dataframe for SQL through ilostat_dataframe_describe and ilostat_dataframe_query when this deployment enables dataframes. A request with no filters at all is refused when the dataset exceeds the row ceiling, and a filtered request that still exceeds it is refused with guidance to narrow it.

| Param | Type | Maps to | Notes |
|:------|:-----|:--------|:------|
| `dataset_ids` | string[] 1–3 | `id` (`+`-joined) | Dataset-ID normalization. The API documents a three-dataset cap per call; the schema enforces it. |
| `ref_areas` | string[] 0–300, optional | `ref_area` (`+`-joined) | Validated against the `ref_area` dictionary. |
| `area_group` | string, optional | expands into `ref_area` | Member countries from the ref_area ToC (union with `ref_areas`); the upstream `region` parameter is never used. |
| `sex` | string[] ≤4, optional | `sex` | |
| `classif1` | string[] ≤100, optional | `classif1` | Validated against the classif1 dictionary. |
| `classif2` | string[] ≤100, optional | `classif2` | Validated against the classif2 dictionary. |
| `sources` | string[] ≤100, optional | `source` | Validated against the source dictionary. When set and `source_selection` is omitted, `source_selection` becomes `all` (echoed) — under the upstream default a secondary source code matches nothing. |
| `time` | string, optional | `time` | Exact period: `YYYY` (on a sub-annual dataset, every period of that year), `YYYYQn`, `YYYYMmm`; schema pattern after normalization. Excludes `time_from`/`time_to` and `latest_only`. |
| `time_from`, `time_to` | string `YYYY`, optional | `timefrom`, `timeto` | Year-granular upstream. `time_from ≤ time_to`. |
| `latest_only` | boolean, default `false` | `latestyear=TRUE` | Latest period per reference area and dataset (the latest quarter or month on sub-annual datasets); combines with `time_from`/`time_to`, not with `time`. |
| `source_selection` | enum `best` \| `all` \| `secondary`, default `best` | `best_source` = `yes` \| `all` \| `no` | `best` returns the preferred source per area and period; `all` adds secondary sources with a `best_source` flag per row. |

**Request build:** only the allowlisted parameters above plus `format=.csv` and `type=code` are sent (see API Reference); upstream silently ignores unknown parameters, which would widen a result instead of failing. Rows are streamed and parsed as they arrive; labels come from the in-memory dictionaries, not from upstream `type=label`.

**Filters on a dataset without that breakdown:** upstream applies `sex`, `classif1`, and `classif2` only to rows that carry the column, so a dataset lacking the breakdown comes back unfiltered by it (verified: `sex=SEX_T` on `LAP_2GDP_NOC_RT_A` returns all its rows; in a two-dataset call a `classif1` filter keeps the no-breakdown dataset's rows). Whenever such a filter is set, `notice` says `{filter} does not apply to {dataset_id}, which has no {breakdown} breakdown; its rows are not narrowed by it.` — decided from the ToC classification before the request.

**Preflight:** a request with none of `ref_areas`, `area_group`, `sex`, `classif1`, `classif2`, `sources`, `time`, `time_from`, `time_to`, `latest_only` is estimated from the ToC — `n.records` (or `n.records.all` when `source_selection` is not `best`) summed over the requested datasets, which is the exact row count of an unfiltered download (verified on two datasets for both counts); above `ILOSTAT_MAX_ROWS` it fails with `request_too_broad` before any upstream call.

**Row routing:** the first rows fill the inline preview (`ILOSTAT_PREVIEW_CHARS`); on overflow, the full stream is registered on the canvas through the framework's `spillover()` with the minted `df_` name (`tableName`), the explicit `schema`, the table `ttlMs`, and `caps.maxRows = ILOSTAT_MAX_ROWS`. `spillover()` reports `truncated: true` exactly when the source held more rows than the cap; the bridge then drops the table (`CanvasInstance.drop`) and the call fails with `result_too_large`. `spillover()` stops pulling at the cap but never closes its source, so the row stream is backed by an `AbortController` the service aborts in a `finally` once `spillover()` returns — which is what keeps the refusal to one bounded transfer; the canvas-off path aborts the same way when it stops at the preview.

Summary counts are accumulated over every row read. `row_count` and `summary` are exact when the result is inline or staged. When reading stopped early — the canvas is off, or canvas registration failed and the bridge fell back to the preview — `row_count` is the rows read, `summary.complete` is `false`, and `truncated`/`shown` disclose it.

**Output**

| Field | Type | Notes |
|:------|:-----|:------|
| `datasets[]` | object | `dataset_id, label, frequency, database, last_update, has_aggregates, projection_after_year, projection_rule, edition?, unit?` (unit from the cached SDMX lookup, resolved in parallel with the data request; absent when unresolved) |
| `row_count` | number | Rows the request returned. Exact whenever the result is inline or staged; when reading stopped early (Row routing), it is the rows read and `enrichment.truncated` says more exist |
| `rows[]` | object | Preview rows: `dataset_id, ref_area, source, sex?, classif1?, classif2?, period, value?, obs_status?, notes[]` (codes), `basis`, `best_source?` |
| `legend` | object | Code → label maps for every code in `rows`: `ref_area, source, sex, classif1, classif2, obs_status, notes` |
| `summary` | object | Over all rows read: `ref_areas` (count), `period_min?`, `period_max?` (absent on zero rows), `basis_counts {reported, modelled_estimate, projection}`, `complete` (false when reading stopped early — see Row routing) |
| `dataframe` | object, optional | `{ name, row_count, expires_at }` when staged |
| `attribution` | string | `Source: ILOSTAT, International Labour Organization (CC BY 4.0) — https://ilostat.ilo.org` |

**Enrichment:** `applied_filters` (echo of every parameter sent upstream, defaults included: `best_source`, the area list an `area_group` expanded to as a count plus the group code), `notice`, `truncated`/`shown`/`cap`.

**Zero-row notice** (zero rows: `rows` empty, `legend` maps empty, `summary.ref_areas` 0, no period bounds), composed from whichever conditions hold:

| Condition | Fragment |
|:----------|:---------|
| sex/classif1/classif2 filter set on a dataset that has that breakdown | `{dataset_id} may not use {codes} — ilostat_describe_indicator {dataset_id} lists the codes it uses.` |
| time window set | `{dataset_id} covers {data_start}–{data_end}; widen time_from/time_to or drop time.` |
| areas set | `Some requested areas have no {dataset_id} data — ilostat_describe_indicator lists the areas it covers.` |
| `source_selection: secondary` | `No secondary sources exist for this request; use source_selection best or all.` |

**Errors**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `unknown_dataset` | NotFound | A dataset ID is not in the catalog, or a bare indicator code has several frequencies | `Call ilostat_search_indicators to find a dataset ID — an indicator code plus _A, _Q, or _M, such as UNE_DEAP_SEX_AGE_RT_A.` (dynamic override lists the frequency variants when ambiguous) |
| `unknown_code` | ValidationError | A `ref_areas`, `sex`, `classif1`, `classif2`, or `sources` value is not in the dictionaries | `Call ilostat_list_reference with the topic for that field (ref_areas, sexes, classifications, or sources) to find valid codes.` (dynamic override names the field, the rejected codes, and the topic) |
| `unknown_area_group` | ValidationError | `area_group` is not a region, subregion, or income group | `Call ilostat_list_reference with topic area_groups to see the group codes area_group accepts.` |
| `aggregates_unavailable` | ValidationError | An X-coded aggregate was requested and a requested dataset has no aggregates (the message names the dataset) | `Request countries only, or use a dataset whose ilostat_describe_indicator output shows has_aggregates true, such as the ILO modelled estimates in database ILOEST.` |
| `invalid_period` | ValidationError | A sub-annual `time` on a dataset of another frequency, `time` combined with a range or `latest_only`, or `time_from` after `time_to` (a malformed period fails the schema pattern first) | `Use YYYY for time_from and time_to, and YYYY, YYYYQn, or YYYYMmm matching the dataset frequency for time, never time together with a range or latest_only.` |
| `request_too_broad` | ValidationError | No filters and the unfiltered size exceeds `ILOSTAT_MAX_ROWS` | `Add ref_areas or area_group, a time_from/time_to window, latest_only, or sex/classif1 filters; ilostat_describe_indicator lists the codes this dataset uses.` |
| `result_too_large` | ValidationError | The filtered result passed `ILOSTAT_MAX_ROWS` while streaming | `Narrow the request with fewer reference areas, a shorter time window, or specific sex/classif1 codes, then call again.` |
| `dataset_retired` | NotFound | Upstream answers 400 "deprecated or invalid dataset id" for a catalog ID (`thrownBy: 'service'`) | `The dataset was withdrawn upstream after the last catalog refresh; call ilostat_search_indicators for its current equivalent.` |
| `upstream_busy` | RateLimited, retryable | Pacer shed (`pacer_shed` rewrapped, its `retryAfter` kept), upstream 429, or a Cloudflare challenge page (`thrownBy: 'service'`) | `The ILOSTAT API is throttling this server; wait the retry-after interval in the error data, then call again with the same arguments.` |
| `catalog_unavailable` | ServiceUnavailable | see Shared conventions | see Shared conventions |

**format():** a dataset block per dataset (ID, label, unit, database, last update, basis rule); the applied-filter echo; rows grouped by `dataset · ref_area · sex · classif1 · classif2 · source` as `#### USA · SEX_T · AGE_YTHADULT_YGE15 · BA:453` followed by `- 2025: {value} [B Break in series] · reported · notes R1:3513, T2:85` lines; the legend (`code — label`, flattened); the summary line; the dataframe pointer when staged; attribution.

### `ilostat_get_country_profile`

**Description:** Build a headline labour-market profile for one reference area: labour force participation, employment-to-population ratio, unemployment and youth unemployment rates, youth NEET rate, informal employment rate, employment level, labour income share, and working poverty rate. Each indicator shows its latest reported value (from a national or institutional source) and, separately, its latest ILO modelled estimate that is not a projection, each with period, source, and status — a missing reported value stays missing and is never filled from the model. Accepts a country (ISO3, e.g. KEN) or an X-coded aggregate (X01 World, regions, income groups), for which only modelled values exist.

| Param | Type | Maps to | Notes |
|:------|:-----|:--------|:------|
| `ref_area` | string, required | `/data/ref_area` `id={AREA}_A` | Reference-area normalization; validated against the ref_area ToC (annual rows). |
| `sex` | enum `SEX_T` \| `SEX_M` \| `SEX_F`, default `SEX_T` | local slice | Aliases per Shared conventions. Applied locally, so one cached upstream response per area serves every `sex` value. |

**Headline set** (annual; static table in the service):

| key | Label | Reported dataset | Modelled dataset | Slice | Unit |
|:----|:------|:-----------------|:-----------------|:------|:-----|
| `labour_force_participation_rate` | Labour force participation rate, 15+ | `EAP_DWAP_SEX_AGE_RT_A` | `EAP_2WAP_SEX_AGE_RT_A` | `AGE_YTHADULT_YGE15` | % |
| `employment_to_population_ratio` | Employment-to-population ratio, 15+ | `EMP_DWAP_SEX_AGE_RT_A` | `EMP_2WAP_SEX_AGE_RT_A` | `AGE_YTHADULT_YGE15` | % |
| `unemployment_rate` | Unemployment rate, 15+ | `UNE_DEAP_SEX_AGE_RT_A` | `UNE_2EAP_SEX_AGE_RT_A` | `AGE_YTHADULT_YGE15` | % |
| `youth_unemployment_rate` | Unemployment rate, 15–24 | `UNE_DEAP_SEX_AGE_RT_A` | `UNE_2EAP_SEX_AGE_RT_A` | `AGE_YTHADULT_Y15-24` | % |
| `youth_neet_rate` | Youth NEET rate | `EIP_NEET_SEX_RT_A` | `EIP_2EET_SEX_RT_A` | — | % |
| `informal_employment_rate` | Informal employment rate | `EMP_NIFL_SEX_RT_A` | `EMP_2IFL_SEX_RT_A` | — | % |
| `employment` | Employment, 15+ | `EMP_TEMP_SEX_AGE_NB_A` | `EMP_2EMP_SEX_AGE_NB_A` | `AGE_YTHADULT_YGE15` | thousands |
| `labour_income_share` | Labour income share of GDP | — | `LAP_2GDP_NOC_RT_A` | no sex breakdown | % |
| `working_poverty_rate` | Working poverty rate, 15+ | — | `SDG_0111_SEX_AGE_RT_A` | `AGE_YTHADULT_YGE15` | % |

Each dataset ID is checked whenever a catalog snapshot loads; an entry whose dataset has left the catalog is dropped from the profile with a logged warning rather than failing every call.

**Upstream:** two `/data/ref_area` calls in parallel (Workflow Analysis). That endpoint's `indicator` parameter takes indicator codes without the frequency suffix (`UNE_DEAP_SEX_AGE_RT`) — the frequency rides on `id={AREA}_A`, and `_A`-suffixed IDs return `200 []` — so the service strips the suffix from the table's dataset IDs when building the call. For an X-coded aggregate the reported call is skipped — national datasets carry aggregate rows only as ILO modelled estimates, which the basis rule would exclude from the reported slot anyway. Both calls must succeed: a failed reported call fails the profile (`upstream_busy` or a baseline upstream error) rather than rendering every key as `reported_missing`, which would state an absence the server never observed.

**Output**

| Field | Type | Notes |
|:------|:-----|:------|
| `ref_area` | object | `code, label, kind, income_group? {code,label}, region? {code,label}, subregion? {code,label}` |
| `sex` | string | Echo |
| `indicators[]` | object | `key, label, unit, reported?, modelled?` — `reported {dataset_id, period, value?, source, source_label, obs_status?, obs_status_label?, notes[] {code,label}}`; `modelled {dataset_id, period, value?, basis, obs_status?, obs_status_label?, edition?}` |
| `reported_missing` | string[] | Keys with no reported value |
| `modelled_cutoff_year` | number | Latest year the modelled call admitted (the smallest projection cutoff across the modelled headline datasets — 2024 under the Nov. 2025 edition) |
| `catalog_as_of`, `attribution` | string | |

`enrichment.notice` when any key is in `reported_missing`: `No reported value exists for {keys}; the modelled estimates shown for them are ILO model output, not national observations.`

**Errors**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `unknown_area` | ValidationError | `ref_area` is not an ILOSTAT reference area with annual data | `Call ilostat_list_reference with topic ref_areas and a name filter to find the ISO3 or X-coded area code.` |
| `upstream_busy` | RateLimited, retryable | as in `ilostat_query_indicator` (`thrownBy: 'service'`) | same text as in `ilostat_query_indicator` |
| `catalog_unavailable` | ServiceUnavailable | see Shared conventions | see Shared conventions |

**format():** `## {label} ({code})` with income group and region, then a table: indicator · reported (value, period, status) · modelled (value, period, basis) · unit; then per-indicator source and note lines (flattened); the missing-reported line; attribution.

### `ilostat_compare_geographies`

**Description:** Compare reference areas on one ILOSTAT dataset and one slice — a sex code plus breakdown codes, defaulting to the dataset's totals — giving each area's value at a common period or at its latest non-projected period, optional change over N years, and a rank, with each value's period, source, status, and basis (reported, modelled_estimate, or projection). Areas without a value are listed separately with the reason, and the response flags mixed periods and mixed bases rather than hiding them. Select areas by code list, by group (an ILO region or subregion, or a World Bank income group), or both; X-coded aggregates require a dataset with aggregates.

| Param | Type | Maps to | Notes |
|:------|:-----|:--------|:------|
| `dataset_id` | string, required | `id` | Dataset-ID normalization; one dataset. |
| `ref_areas` | string[] 0–300, optional | `ref_area` | At least one of `ref_areas` / `area_group`. |
| `area_group` | string, optional | expands into `ref_area` | Member countries; the group's own aggregate is included only when listed in `ref_areas`. |
| `sex` | string, optional | `sex` | Default `SEX_T` when the dataset has a sex breakdown; a value on a dataset without one fails with `invalid_slice`. |
| `classif1`, `classif2` | string, optional | `classif1`, `classif2` | Default from `default_slice` (SDMX, cached). A breakdown with no total code and no value given, or a value for a breakdown the dataset lacks, fails with `invalid_slice`. |
| `period` | string, optional | `time` | `YYYY`, `YYYYQn`, `YYYYMmm` matching the dataset frequency; schema pattern after normalization. Omitted → latest mode. |
| `lookback_years` | int 1–50, default 10 | `timefrom` | Latest mode: an area's latest value must fall within this many years of the current year. |
| `change_years` | int 1–30, optional | widens `timefrom` | Adds `change {from_period, from_value, delta}`: the same sub-period N years earlier; `delta = value − from_value` in the dataset unit. |
| `include_projections` | boolean, default `false` | local | Latest mode skips `projection` rows unless true. |
| `sort` | enum `value_desc` \| `value_asc` \| `ref_area`, default `value_desc` | local | Orders rows only; `rank` is always by value descending, ties sharing a rank. |

Latest mode requests `timefrom = current year − lookback_years − (change_years ?? 0)` with no `timeto`, classifies every row's basis, drops `projection` rows unless `include_projections`, then keeps each area's latest remaining period. The projection cutoff is never sent as `timeto`: it bounds modelled rows only, and a reported national value can be newer than it (quarterly national series already run to 2026Q2 while the modelled cutoff is 2024). Period mode requests `time = period` plus, with `change_years`, the earlier period. `best_source` stays at the upstream default; the echo says so.

Rows beyond the inline preview are staged (below). With the canvas off, or when registration fails, the inline rows stop at the preview budget with `truncated`/`shown` set; ranks, `missing`, and `comparability` are still computed over every area.

**Output**

| Field | Type | Notes |
|:------|:-----|:------|
| `dataset` | object | Same per-dataset meta as `ilostat_query_indicator.datasets[]` |
| `slice` | object | `sex?, classif1?, classif2?, defaulted[]` (which were filled from the dataset's totals) |
| `mode` | `'latest' \| 'period'` | plus `period?`, `window_from?`, `change_years?`, `include_projections` |
| `rows[]` | object | `rank, ref_area, label, kind, value, period, basis, source, source_label, obs_status?, notes[], change?` |
| `missing[]` | object | `{ref_area, label, reason: 'no_value_in_window' \| 'no_value_for_period' \| 'not_covered'}` (`not_covered` = absent from the dataset's area list when structure is known) |
| `comparability` | object | `periods[]` (distinct), `mixed_periods`, `basis_counts`, `distinct_sources` |
| `dataframe` | object, optional | `{ name, row_count, expires_at }` when rows exceed the inline preview (staged-comparison schema in Shared conventions) |
| `attribution` | string | |

**Enrichment:** `applied_filters`, `notice` composed from: mixed periods (`Values span {periods}; pass period for a like-for-like comparison.`), mixed bases (`{n} values are ILO modelled estimates and {m} are reported; they are not directly comparable.`), missing areas (`{k} areas have no value; see missing.`).

**Errors**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `unknown_dataset` | NotFound | as in `ilostat_query_indicator` | same text |
| `unknown_code` | ValidationError | as in `ilostat_query_indicator` | same text |
| `unknown_area_group` | ValidationError | as in `ilostat_query_indicator` | same text |
| `areas_required` | ValidationError | Neither `ref_areas` nor `area_group` given | `Pass ref_areas (ISO3 or X codes) or an area_group such as X06 for every African country; ilostat_list_reference topic area_groups lists the groups.` |
| `aggregates_unavailable` | ValidationError | as in `ilostat_query_indicator` | same text |
| `invalid_slice` | ValidationError | A breakdown has no total code (or structure is unavailable) and no value was given, or `sex`/`classif1`/`classif2` names a breakdown the dataset lacks | `Pass sex, classif1, and classif2 only for breakdowns the dataset has, with explicit codes where it has no total; ilostat_describe_indicator lists them.` (dynamic override when the structure service is unavailable: the dataset's total codes could not be read, so pass `classif1`/`classif2` explicitly) |
| `invalid_period` | ValidationError | `period` of a frequency other than the dataset's (a malformed period fails the schema pattern first) | `Use YYYY, YYYYQn, or YYYYMmm matching the dataset frequency for period, or omit it to compare each area's latest value.` |
| `dataset_retired` | NotFound | as in `ilostat_query_indicator` (`thrownBy: 'service'`) | same text |
| `upstream_busy` | RateLimited, retryable | as in `ilostat_query_indicator` | same text |
| `catalog_unavailable` | ServiceUnavailable | see Shared conventions | see Shared conventions |

**format():** dataset and slice header, mode line, a markdown table `rank | area | value | period | basis | status | change` (cells escaped), the `missing` list, the comparability line, the dataframe pointer when staged, attribution.

### `ilostat_list_reference`

**Description:** Decode ILOSTAT's code vocabulary: reference areas (ISO3 countries and X-coded aggregates, with World Bank income group and ILO region), the region and income groups that area_group accepts, databases, subjects, sex codes, breakdown codes for classif1/classif2 with their classification types, per-country data sources, observation status flags, note codes, and frequencies. Filter by text or look up exact codes; long topics page with a cursor.

| Param | Type | Notes |
|:------|:-----|:------|
| `topic` | enum `ref_areas` \| `area_groups` \| `databases` \| `subjects` \| `sexes` \| `classifications` \| `classification_types` \| `sources` \| `obs_status` \| `notes` \| `frequencies`, required | |
| `filter` | string, optional | Every token must match a word or word prefix of the code or label (normalized as in search). |
| `codes` | string[] ≤100, optional | Exact lookup (uppercased); misses listed in `not_found`. |
| `ref_area` | string, optional | `sources` only: that area's sources. Validated. |
| `classification_type` | string, optional | `classifications` only: code prefix (`AGE`, `ECO`, …). |
| `limit` | int 1–500, default 50 | |
| `cursor` | string, optional | |

**Topics:** `ref_areas` (327: code, label, kind, frequencies, data_start/data_end, indicator count, income group, ILO region/subregions), `area_groups` (regions, subregions, income groups with `member_count`), `databases` (17 with dataset counts; `ILOSECTOR` is in the ToC but not the database dictionary, so its label comes from the ToC), `subjects` (28), `sexes` (4), `classifications` (classif1 ∪ classif2, each with `slot` = `classif1` \| `classif2` \| `both` and `classification_type`), `classification_types` (47), `sources` (3,767; each source code belongs to one area; `source_type` = the label prefix before ` - `, e.g. `LFS`, `PC`, `ADM`, `ILO`, `OE`), `obs_status` (A, B, I, M, R, U), `notes` (note_source/note_indicator/note_classif codes with `note_type`), `frequencies` (A/Q/M with dataset counts).

**Output:** `topic`, `entries[]` (flat object: `code, label` plus the topic's optional fields above), `total` (after filtering), `next_cursor?`, `not_found?`, `catalog_as_of`. Truncation via `ctx.enrich.truncated`.

**Zero-hit notice:** `No {topic} entry matched "{filter}". Every filter term must appear in the code or label; try one distinctive word, or omit filter to page the full list.` With `ref_area` on `sources`: `{ref_area} has no sources in the dictionary.`

**Errors**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `unknown_code` | ValidationError | `ref_area` is not a reference area | `Call ilostat_list_reference with topic ref_areas and a name filter to find the area code.` |
| `param_not_for_topic` | ValidationError | `ref_area` with a topic other than `sources`, or `classification_type` with a topic other than `classifications` — a scoping parameter the topic cannot apply | `Pass ref_area only with topic sources and classification_type only with topic classifications, or drop it.` |
| `invalid_cursor` | InvalidParams | `cursor` does not decode (as in `ilostat_search_indicators`; `thrownBy: 'service'`) | `Omit cursor to start from the first page, or pass next_cursor from the previous response unchanged.` |
| `catalog_unavailable` | ServiceUnavailable | see Shared conventions | see Shared conventions |

**format():** `code — label` lines with the topic's extra fields inline (flattened), `not_found`, `next_cursor`.

### `ilostat_dataframe_query`

**Description:** Run a single-statement SELECT against the df_<id> dataframes staged by ilostat_query_indicator and ilostat_compare_geographies. Inspect a dataframe with ilostat_dataframe_describe first; its column schema is what the SQL has to match. Read-only: writes, DDL, DROP, COPY, PRAGMA, ATTACH, and file-reading table functions are rejected, and system catalogs (information_schema, pg_catalog, sqlite_master, duckdb_*) are denied. Breakdown versions overlap (AGE_YTHADULT_*, AGE_AGGREGATE_*, AGE_10YRBANDS_*), so filter to one version before summing. Optional register_as stores the result as a new dataframe with a fresh TTL.

| Param | Type | Notes |
|:------|:-----|:------|
| `sql` | string, required | Single SELECT over `df_<id>` tables. BIGINT results (COUNT/SUM of integers) serialize as strings; CAST to DOUBLE for inline arithmetic. |
| `register_as` | string, optional | Must match `^df_[A-Z0-9]{5}_[A-Z0-9]{5}$`; blank = unset. |
| `preview` | int 0–10000, optional | Rows returned inline; defaults to the row limit. |
| `row_limit` | int 1–10000, default 1000 | Hard cap on materialized rows. |

**Output:** `columns[]`, `row_count`, `row_count_capped`, `rows[]`, `registered_as?`, `expires_at?`. Enrichment: `notice`, `truncated`, `shown`, `cap` — zero rows (`Query returned 0 rows. Verify dataframe names with ilostat_dataframe_describe and check the WHERE conditions.`) and the two cap disclosures (row_limit reached vs. preview shorter than the result).

**Errors** (framework gate reasons are rebuilt with these recovery strings; all but the first `thrownBy: 'service'`)

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `canvas_unavailable` | ServiceUnavailable | DataCanvas is off in this deployment, or its DuckDB engine cannot load (the framework's `ConfigurationError` from the lazy import, rewrapped by the bridge — the case in the `.mcpb` bundle, which ships without the native binding) | `Dataframes are unavailable in this deployment; use ilostat_query_indicator results inline, or ask the operator to set CANVAS_PROVIDER_TYPE=duckdb with @duckdb/node-api installed.` |
| `system_catalog_access` | ValidationError | SQL references a system catalog | `Query only df_<id> tables; ilostat_dataframe_describe lists the staged dataframes.` |
| `missing_table` | NotFound | A referenced `df_<id>` does not exist or expired (pre-checked against `ctx.state` before the gate) | `Call ilostat_dataframe_describe to list the staged dataframes, or re-run the producing tool to stage the data again.` |
| `invalid_sql` | ValidationError | The SELECT fails to prepare (unknown column, bad expression) | `Check column names and syntax against the schema ilostat_dataframe_describe reports.` |
| `sql_execution_error` | ValidationError | The SELECT prepared but failed on the data | `Wrap the failing cast in TRY_CAST, or filter out the rows the error message names before converting them.` |
| `register_as_clash` | ValidationError | `register_as` names an existing dataframe | Resolved from config: with drop enabled, `Drop the existing dataframe with ilostat_dataframe_drop, choose another df_XXXXX_XXXXX name, or omit register_as.`; otherwise `Choose another df_XXXXX_XXXXX name or omit register_as.` |
| `non_select_statement` | ValidationError | Not a SELECT | `Send only a SELECT statement against df_<id> tables; ilostat_dataframe_describe lists them.` |
| `multi_statement` | ValidationError | More than one statement | `Send exactly one SELECT statement per call and split multi-statement SQL into separate calls.` |
| `denied_function` | ValidationError | A file-reading or external table function | `Remove the file-reading function and query only the df_<id> tables ilostat_dataframe_describe lists.` |
| `plan_operator_not_allowed` | ValidationError | A plan operator outside the read-only allowlist (e.g. `range()`) | `Rewrite with read-only SELECT constructs — joins, aggregates, window functions, CTEs, and unnest() are supported.` |

**format():** registered line when set, a row-count header that says when `row_limit` capped the result, then a markdown table (cells escaped: `\` then `|`, line breaks → `<br>`).

### `ilostat_dataframe_describe`

**Description:** List the df_<id> dataframes staged by ilostat_query_indicator and ilostat_compare_geographies, with the tool and parameters that produced each, the datasets it holds (label, unit, last update), coverage, basis counts, attribution, creation and expiry times, row count, and column schema. Read the schema here before writing SQL for ilostat_dataframe_query.

| Param | Type | Notes |
|:------|:-----|:------|
| `name` | string, optional | One `df_<id>`; blank = list all. |

**Output:** `dataframes[]` — `name, source_tool, query_params, created_at, expires_at, row_count, datasets[] {dataset_id, label, unit?, last_update}, coverage {ref_areas, period_min, period_max}, basis_counts, attribution, column_schema[] {name, type, nullable}`; newest first; empty when none. A `name` that matches nothing returns an empty list with the notice `No staged dataframe is named {name}; call ilostat_dataframe_describe without name to list them, or re-run the producing tool.` Errors: `canvas_unavailable` (as above). **format():** one `### df_…` block per dataframe (labels flattened).

### `ilostat_dataframe_drop`

**Description:** Drop a staged df_<id> dataframe by name ahead of its TTL. Idempotent: dropped is false when nothing matched.

| Param | Type | Notes |
|:------|:-----|:------|
| `name` | string, required | `df_<id>` |

**Output:** `name`, `dropped`. Errors: `canvas_unavailable`. Annotations: `readOnlyHint: false, idempotentHint: true, openWorldHint: false` (destructive by default — it removes staged state, recoverable by re-running the producer). Off by default: registered through `disabledTool()` (reason `Dropping dataframes is turned off in this deployment; staged tables expire on their own TTL.`, hint `ILOSTAT_DATAFRAME_DROP_ENABLED=true`), so it stays visible on the landing page but absent from `tools/list`. Nothing else routes to it unless the flag is on.

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `RplumberClient` | `rplumber.ilo.org`: ToCs, dictionaries, `/data/indicator` (CSV stream), `/data/ref_area` (JSON). Owns the rplumber pacer, retry, the parameter allowlist, HTML/challenge detection, and 400 mapping. | CatalogService, ObservationService, ProfileService |
| `SdmxClient` | `sdmx.ilo.org/rest`: dataflow structure (`references=all&detail=referencepartial`, SDMX-JSON) and the one-observation unit probe (SDMX-CSV). Owns the SDMX pacer. | StructureService |
| `CatalogService` | In-memory snapshot: both ToCs, 13 dictionaries, derived indexes (search index, code sets, area groups, dataset → projection cutoff). Load, refresh, readiness, validation, decoding. | every non-dataframe tool |
| `StructureService` | Per-indicator SDMX structure + unit, cached (LRU 500 entries, keyed by indicator and its ToC `last.update`, 24 h ceiling). Single-flight per indicator. | describe, query (unit), compare (default slice) |
| `ObservationService` | Builds allowlisted requests, validates codes and periods, preflights size, streams and classifies rows, accumulates summaries, holds the response cache. | query, compare |
| `ProfileService` | Headline table, the two `/data/ref_area` calls, local slicing. | profile |
| `basis` (pure functions) | `parseEdition(label)`, `latestCatalogEdition(labels)`, `projectionCutoff(dataset, catalogEdition, currentYear)`, `classifyRow(row, cutoff)`. | ObservationService, ProfileService, compare |
| `CanvasBridge` | DataCanvas adapter: shared per-tenant canvas, `df_` naming, provenance in `ctx.state`, spill/register/query/describe/drop, gate-error rewrap. | query, compare, dataframe trio |

### Catalog lifecycle

- **Cold start.** `setup()` constructs the services and calls `catalog.start()`, which begins loading without blocking startup and arms the refresh timer (`unref()`'d). Load = both ToCs + 13 dictionaries (15 requests, ~0.25 MB gzip on the wire, ~3.8 MB parsed; about 10 s through the pacer). Tools `await catalog.ready()` — a single-flight promise, so the first call after boot may wait for the load; concurrent callers share it. A tool waits at most 30 s (`readyTimeoutMs`): past that it fails `catalog_unavailable` while the load continues in the background, so a load held up by a pacer cooldown never outlasts a client's request timeout.
- **Failed initial load.** `ready()` rejects with `catalog_unavailable`; the next call starts a fresh attempt, at most one attempt per 15 s.
- **Refresh.** Every `ILOSTAT_CATALOG_REFRESH_HOURS`: re-fetch both ToCs (2 requests). When the dataset set or any `last.update` changed, re-fetch the dictionaries too, then swap the snapshot atomically. Upstream offers no ETag or Last-Modified, so the ToC's own `last.update` column is the change signal.
- **Failed refresh.** The previous snapshot keeps serving (it is still valid published metadata); the failure is logged at warning, and `catalog_as_of` on every output shows its age.
- **Invalidation.** StructureService entries key on the ToC `last.update`, so a dataset update evicts its structure/unit on the next lookup.
- `teardown()` clears the refresh timer and disposes both pacers.

### Resilience and pacing

| Concern | Decision |
|:--------|:---------|
| Fetch boundary | Plain `fetch` (injectable) in both clients, not `fetchWithTimeout`: streaming bodies, and some non-2xx statuses are results. Accept-lists: SDMX structure `{200, 404}` (404 = no dataflow → `structure_status: 'unavailable'`); SDMX data probe `{200, 404}` (404 = no data for that area → try the next); rplumber `{200}`. Everything else goes through `httpErrorFromResponse` or the mappings below. |
| rplumber 400 | Body `{"error":"deprecated or invalid dataset id=…"}` → `dataset_retired` (NotFound). |
| SDMX 500 `ORA-…` | Unknown key member; treated as "no data for this key" (next area, else unit unresolved). The Oracle text is never relayed. SDMX 422 (key arity) is a server bug → `InternalError`. |
| HTML where data is expected | `content-type: text/html` or a `cf-mitigated: challenge` header → `upstream_busy` (RateLimited, retryable) and a pacer cooldown. Data and metadata legitimately arrive as `application/octet-stream` (JSON and CSV alike), so parsing keys on the requested format, never on the content type. The 429/challenge check runs inside the pacer task: the pacer closes its cooldown gate only when the task itself throws `RateLimited`. |
| Timeouts | Per attempt: 30 s to response headers; a data stream additionally fails when no bytes arrive for 30 s. Composed via `AbortSignal.any` with `ctx.signal`. |
| Retry | `withRetry` around request + headers (+ full parse for non-streamed JSON), `maxRetries: 2`, `baseDelayMs: 1000`, `deadlineMs: 45_000`, `attempt.signal` threaded into the fetch. `isTransient: (e) => !isUpstreamBusy(e) && defaultIsTransient(e)` — an upstream 429 or challenge is not retried in-call, so a throttling upstream is never re-hit from a shared IP; the pacer cooldown handles the wait. A stream that fails after rows were consumed is not retried: the call fails `ServiceUnavailable` and any partial table is dropped. |
| Pacing | One `createPacer` per host, retry outside, pacer inside. rplumber: `limits: [{ requests: 60, perMs: 60_000 }]`, `maxConcurrent: 2`, `minStartGapMs: 500`, `cooldown { baseMs: 60_000, maxMs: 600_000 }`. SDMX: `limits: [{ requests: 20, perMs: 60_000 }]`, `maxConcurrent: 1`, `minStartGapMs: 1_000`, same cooldown. Tool-initiated calls pass `maxWaitMs: 15_000`; the catalog loader waits without a cap. A pacer shed (`pacer_shed`) is rewrapped as `upstream_busy` with its `retryAfter`. Basis in Design Decisions. |
| Response cache | Upstream data responses of ≤ 5,000 rows, keyed by the canonical request URL, TTL `ILOSTAT_CACHE_TTL_SECONDS`, LRU 256 entries, process-wide (public data). Serves profile, compare, and small queries. Larger results are never cached — the caller holds the staged dataframe. |

**When the shared budget runs out** (hosted): a call whose pacer wait would exceed 15 s, or that meets an upstream 429 or challenge page, fails fast with `upstream_busy` — `RateLimited`, `retryable: true`, `data.retryAfter` in seconds — and the pacer holds further upstream calls for the cooldown (60 s doubling to 10 min, reset by the first success). Meanwhile `ilostat_search_indicators`, `ilostat_list_reference`, cached describes, cached small queries, and the dataframe tools keep answering. The budget is per process: a hosted deployment runs one replica per egress IP, since N replicas behind one address would present N times the budget.

## Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `ILOSTAT_CATALOG_REFRESH_HOURS` | no | `6` | Hours between table-of-contents checks (1–168). |
| `ILOSTAT_MAX_ROWS` | no | `500000` | Ceiling on rows one query may return or stage (1,000–2,000,000). |
| `ILOSTAT_PREVIEW_CHARS` | no | `40000` | Inline preview budget in serialized characters (≈10k tokens), passed to `spillover()` as `previewChars`. |
| `ILOSTAT_CACHE_TTL_SECONDS` | no | `900` | TTL of the upstream response cache (0 disables). |
| `ILOSTAT_DATASET_TTL_SECONDS` | no | `86400` | Per-table TTL for staged dataframes (≥ 60). |
| `ILOSTAT_DATAFRAME_DROP_ENABLED` | no | `false` | `z.stringbool()`. Exposes `ilostat_dataframe_drop`. |
| `CANVAS_PROVIDER_TYPE` | no | `duckdb` (set in `src/index.ts` when unset) | Framework var; `none` turns dataframes off. |
| `MCP_TRANSPORT_TYPE`, `MCP_HTTP_PORT`, `MCP_HTTP_HOST`, `MCP_SESSION_MODE`, `MCP_LOG_LEVEL`, … | no | framework defaults | Framework transport/logging config. |

All server vars parse through `parseEnvConfig` in `src/config/server-config.ts`; every one goes into both `server.json` `environmentVariables[]` and `manifest.json` (`mcp_config.env` + `user_config`), and the plugin manifests. No credentials exist.

## Server Setup

```ts
process.env.CANVAS_PROVIDER_TYPE ||= 'duckdb';
const { dataframeDropEnabled } = getServerConfig();

await createApp({
  name: 'ilostat-mcp-server',
  title: 'ilostat-mcp-server',
  tools: buildToolDefinitions({ dropEnabled: dataframeDropEnabled }),
  resources: [],
  prompts: [],
  sessionMode: 'stateless',
  instructions: buildInstructions({ canvasEnabled: process.env.CANVAS_PROVIDER_TYPE !== 'none' }),
  setup(core) { initIlostatServices({ canvas: core.canvas }); },
  async teardown() { await disposeIlostatServices(); },
});
```

No other identity fields. `buildToolDefinitions` returns a constant-length list (drop gated through `disabledTool()`); `buildInstructions` omits the dataframe sentence when the canvas is off. The canvas default line lands in wave 2 with the DuckDB dependency.

## Server Instructions

Canvas-on text (1,877 characters; the canvas-off variant drops the "Large results…" sentence):

> Labour statistics from ILOSTAT, the International Labour Organization's database. A dataset ID is an indicator code plus a frequency suffix: UNE_DEAP_SEX_AGE_RT_A is the annual unemployment rate by sex and age (_Q quarterly, _M monthly). Find one with ilostat_search_indicators (plain-language terms), read its definition, unit, breakdown codes, and coverage with ilostat_describe_indicator, then fetch observations with ilostat_query_indicator. ilostat_get_country_profile returns headline labour-market figures for one area; ilostat_compare_geographies lines areas up on one slice of one dataset. Reference areas are ISO3 codes (USA) or X-coded aggregates (X01 World, regions, income groups), and aggregates exist only on datasets whose describe output shows has_aggregates. Sex codes are SEX_T, SEX_M, SEX_F; breakdown codes go in classif1 and classif2. ilostat_list_reference decodes every code the other tools take. Each observation carries a basis: reported (a national or institutional source), modelled_estimate (ILO modelled estimates), or projection (a modelled value for its edition year or later). Do not present a modelled or projected value as a reported one. Status flags (B break in series, U unreliable, R real value, I imputation) and source notes stay attached to values. One breakdown can appear in several classification versions (AGE_YTHADULT_*, AGE_AGGREGATE_*, AGE_10YRBANDS_*) whose bands overlap, so never sum across versions. Large results are staged as a df_<id> dataframe: list staged tables and columns with ilostat_dataframe_describe, then run SQL with ilostat_dataframe_query. Labels, notes, and descriptions are ILO-published text, shown as data. Data: ILOSTAT, International Labour Organization, CC BY 4.0; cite ILOSTAT and the dataset ID. The upstream API is shared and paced, so a busy upstream returns a rate-limit error with a retry-after.

## Implementation Order

Nine tools, two waves. Each wave ends with `bun run devcheck` clean, tests green, and a working server.

**Wave 1 — catalog and discovery** (no canvas, no DuckDB)

1. Config (`server-config.ts`), `src/index.ts` with the wave's tools, `server.json`/`manifest.json`/plugin env parity.
2. `RplumberClient` (ToC + dictionary + JSON paths, pacer, retry, allowlist) and `CatalogService` (load, single-flight readiness, refresh timer, indexes, validation/decoding helpers).
3. `ilostat_list_reference` — grounds field-testing for everything else.
4. `ilostat_search_indicators`.
5. `SdmxClient` + `StructureService`, then `ilostat_describe_indicator`.

**Wave 2 — observations and dataframes**

6. `basis` functions, the CSV stream parser (BOM, quoted fields, header-driven columns), `ObservationService` (validation, preflight, stream, summaries, response cache).
7. `@duckdb/node-api` dependency, the `CANVAS_PROVIDER_TYPE` default in `src/index.ts`, `CanvasBridge`, and the dataframe trio (`ilostat_dataframe_describe`, `ilostat_dataframe_query`, `ilostat_dataframe_drop` via `disabledTool()`), plus the Dockerfile changes in Packaging.
8. `ilostat_query_indicator`.
9. `ilostat_compare_geographies`.
10. `ProfileService` and `ilostat_get_country_profile`.
11. Server instructions switch to the full text; README and field test.

## Workflow Analysis

**`ilostat_query_indicator`**

| # | Call | Purpose | Gate |
|:--|:-----|:--------|:-----|
| 0 | `catalog.ready()` | Validate IDs, codes, periods; expand `area_group`; preflight size | always |
| 1 | `GET /data/indicator?id=…&…&type=code&format=.csv` (streamed) | Observations | always (cache hit skips) |
| 1′ | StructureService unit lookup (≤ 2 SDMX calls per indicator, cached) | Unit per dataset, in parallel with 1 via `Promise.allSettled` | per dataset, cache miss |
| 2 | `spillover()` → canvas | Stage beyond the preview | preview overflow + canvas on |

**`ilostat_describe_indicator`**

| # | Call | Purpose | Gate |
|:--|:-----|:--------|:-----|
| 0 | catalog lookup | ToC rows, definition, labels, related datasets | always |
| 1 | `GET /rest/dataflow/ILO/DF_{indicator}/latest?references=all&detail=referencepartial` | Dimensions, used codes, totals, default slice, covered areas, unit codelists | cache miss |
| 2 | `GET /rest/data/ILO,DF_{indicator},{version}/{AREA}{dots}?lastNObservations=1` | Unit attributes | cache miss; up to 3 areas on 404 |

**`ilostat_compare_geographies`**

| # | Call | Purpose | Gate |
|:--|:-----|:--------|:-----|
| 0 | catalog | Validate, expand group, projection cutoff | always |
| 1 | StructureService structure | Default slice, covered areas | a breakdown omitted, or `missing` reasons |
| 2 | `GET /data/indicator?id={one}&ref_area=…&sex=…&classif1=…&(timefrom or time)&format=.csv` | Values | always (cache) |
| 3 | local | Basis per row, projection rows dropped (latest mode), latest per area, change, rank, missing, comparability | always |

**`ilostat_get_country_profile`**

| # | Call | Purpose | Gate |
|:--|:-----|:--------|:-----|
| 1 | `GET /data/ref_area?id={AREA}_A&indicator={reported indicator codes}&latestyear=TRUE&format=.json` | Latest reported values | country only |
| 2 | `GET /data/ref_area?id={AREA}_A&indicator={modelled indicator codes}&timeto={cutoff}&latestyear=TRUE&format=.json` | Latest non-projected modelled values | always |
| 3 | local | Pick the headline slice rows, classify basis, pair slots | always |

Calls 1 and 2 run in parallel; `indicator` lists `+`-joined indicator codes without the `_A` suffix. No upstream `sex`/`classif1` filter: slicing locally lets one cached response per area serve every `sex` value.

## API Reference

### Endpoints and parameter allowlist

The service sends only these parameters; anything else is a code bug, not a caller option.

| Endpoint | Parameters sent | Response |
|:---------|:----------------|:---------|
| `GET rplumber.ilo.org/metadata/toc/indicator` | `lang=en`, `format=.json` | JSON array, 1,964 rows: `id, indicator, indicator.label, freq, freq.label, rep_var, rep_var.label, classification, classif.labels, data.start, data.end, last.update, n.records, n.records.all, n.ref_area, with.region, subject, subject.label, database, database.label` — `classification` is absent on the 27 datasets without breakdowns and `with.region` is absent unless `Y` |
| `GET …/metadata/toc/ref_area` | `lang=en`, `format=.json` | 741 rows (327 areas × A/Q/M): `id, ref_area, ref_area.label, freq, data.start, data.end, last.update, n.records, n.records.all, n.indicator, wb_income_group(.label), ilo_region(.label), ilo_subregion_broad(.label), ilo_subregion_detailed(.label)` (group codes absent on the 93 aggregates; null fields are omitted, never sent as null) |
| `GET …/metadata/dic` | `var`, `lang=en`, `format=.json` | `[{<var>, <var>.label}]`; `indicator` adds `indicator.description` (HTML); `source` adds `ref_area`. Vars: `ref_area, indicator, sex, classif1, classif2, obs_status, note_classif, note_indicator, note_source, source, classif_type, database, subject`. |
| `GET …/data/indicator` | `id`, `ref_area`, `sex`, `classif1`, `classif2`, `source`, `time`, `timefrom`, `timeto`, `latestyear=TRUE`, `best_source` (`yes`/`all`/`no`), `type=code`, `format=.csv` | UTF-8 CSV with BOM, quoted strings, header = union of the requested datasets' columns: `ref_area, source, indicator, sex?, classif1?, classif2?, time, obs_value, obs_status, note_classif?, note_indicator?, note_source?[, best_source]` — the note columns appear only for datasets that carry notes, so the parser is header-driven. `best_source` (`1`/`0`) appears only under `all`/`no`. Gzip `content-encoding` when requested. |
| `GET …/data/ref_area` | `id={AREA}_A`, `indicator` (`+`-joined indicator codes without the frequency suffix, any count), `timeto`, `latestyear=TRUE`, `format=.json` | JSON array, null fields omitted |
| `GET sdmx.ilo.org/rest/dataflow/ILO/DF_{indicator}/latest` | `references=all`, `detail=referencepartial`; `Accept: application/vnd.sdmx.structure+json;version=1.0` | dataflows (annotations incl. `LAST_UPDATE`, `DEFAULT`), dataStructures (dimensions, attributes), codelists (partial for dimensions; `CL_UNIT_*` complete), contentConstraints (codes in use per dimension) |
| `GET sdmx.ilo.org/rest/data/ILO,DF_{indicator},{version}/{key}` | `lastNObservations=1`; `Accept: application/vnd.sdmx.data+csv;version=1.0.0` | CSV with `UNIT_MEASURE_TYPE, UNIT_MEASURE, UNIT_MULT, DECIMALS` per series |

Never sent: `region` (documented, but live requests return every area regardless), `mode`, `channel`, `title`, `cmd` (internal/deprecated), `lang` on data endpoints, and any blank value.

### Verified upstream behavior

| Behavior | Consequence in the design |
|:---------|:--------------------------|
| Unknown parameter silently ignored (`ref_areaa=USA` returned 201 areas) | Strict allowlist |
| Blank value widens (`ref_area=` returned every area) | Blank = unset, never sent |
| Unknown code → `200` with a header-only CSV (`[]` in JSON) | Dictionary validation before the request; designed zero-row notice |
| `/data/ref_area` with `_A`-suffixed `indicator` values → `200 []`; bare indicator codes return data | Profile strips the suffix |
| Every response is `application/octet-stream` with `content-disposition: attachment`, whatever the format | Parse by requested format |
| Unknown dataset ID → `400 {"error":"deprecated or invalid dataset id=…","documentation":…}` | Catalog validation; `dataset_retired` mapping |
| `id` accepts more than 3 datasets (8 worked) though documented "up to 3" | Server enforces 3 |
| `region=AFRICA` does not filter; `ILO_GEO_X06` as a `ref_area` matches nothing; a 234-code `ref_area` list works | Area groups expanded locally from the ToC into X-free `ref_area` lists |
| `timefrom`/`timeto` read the year only; `time` accepts `YYYY`, `YYYYQn`, `YYYYMmm` | Separate year and period inputs |
| `latestyear=TRUE` = latest period per area and indicator; honors `timeto` | `latest_only`; profile modelled call bounded by the cutoff |
| `best_source=yes` hides secondary sources, and a secondary `source` filter under it returns nothing | `sources` defaults `source_selection` to `all` |
| A `sex`/`classif1`/`classif2` filter leaves rows of a dataset lacking that column unfiltered (`sex=SEX_T` on `LAP_2GDP_NOC_RT_A` returns every row) | Query notice that the filter did not apply to that dataset |
| Upstream is case-insensitive for `id` and `ref_area` | Uppercasing is safe and needed for dictionary lookup |
| `HEAD` → 405; no ETag, Last-Modified, or rate-limit headers | GET only; ToC `last.update` is the change signal |
| Unfiltered download row count equals ToC `n.records` (322,228 rows, ~1.9 MB gzip, ~4 s for a median-large dataset); filtered calls on the 4.75M-row dataset return in 3–4 s | ToC-based preflight; per-attempt timeouts |
| Compound notes `_`-joined (`R1:3513_T2:85`); every part and every source code decodes against the dictionaries (full check over a 322k-row dataset) | Split on `_`, decode locally |
| `obs_value` empty on ~4% of rows | `value` optional |
| X-coded aggregates only on `with.region = "Y"` datasets (106); those rows are sourced `ILO - Modelled Estimates` and run to projection years even inside national LFS datasets | Row-level basis; `aggregates_unavailable` |
| SDMX: DSD declares `UNIT_*` attributes but values arrive only on data responses; `detail=nodata` still returns every observation (tens of MB) | One-observation probe per indicator, cached |
| SDMX: unknown dataflow → `404 Could not find requested structures`; valid area without data → `404 No data is found…`; unknown area in key → `500 ORA-00936`; short key → `422` | Accept-lists and mappings above |
| SDMX dimension ids can differ from ToC classification components (`QTL` vs `DCL`) | Breakdowns from SDMX dimensions |
| SDMX: group headers (`AGE_YTHADULT`) are parents of other codes, but decile codes are parentless leaves; a content constraint can omit a dimension (`DCL`); the `DEFAULT` annotation lists dimensions by ID in its own order | Header, used-code, and default-slice rules in `ilostat_describe_indicator` |

## Packaging & Deployment

- **`@duckdb/node-api` `^1.5.5-r.5`** as a regular dependency (the framework declares it an optional peer at `^1.5.5-r.1`). It is CommonJS; the server never imports it — the framework's DuckDB provider loads it with a dynamic `import()`, which resolves the CJS module under both Node ESM and Bun. Its native binary ships as per-platform packages (`@duckdb/node-bindings-linux-x64`, `-linux-arm64`, …) selected by `os`/`cpu` at install time.
- **Dockerfile:** keep the scaffold's shape. The build stage stays pinned to `$BUILDPLATFORM` (`bun run build` aborts under QEMU) and only `dist/` crosses into the production stage. The production stage runs on the target platform and installs production dependencies itself (`bun install --production --omit=peer --frozen-lockfile --ignore-scripts`) — an install completes under QEMU, only the build does not — which is what resolves the DuckDB binding for each architecture: the bindings are `optionalDependencies` of `@duckdb/node-bindings` gated by `os`/`cpu` with no install scripts, so `--ignore-scripts` loses nothing, and the glibc `oven/bun` slim image takes `linux-x64`/`linux-arm64` rather than the `-musl` variants. `@duckdb/node-api` survives `--omit=peer` because it is a direct dependency. Never copy `node_modules` forward from the build stage: that tree holds the build machine's binding. Remove the scaffold's `.cache`/`.mirror` directories and the commented mirror-CLI block (no on-disk store). DuckDB spill files use `CANVAS_TEMP_PATH`, which defaults to the OS temp dir (writable by the `bun` user); no export tool exists, so `CANVAS_EXPORT_PATH` needs no directory.
- **`.mcpb` bundle:** stdio only; the bundle cleaner strips native bindings, so dataframe tools report the install hint there while every other tool works.

## Test Boundary

Every network, process, and time boundary has a seam the test suite injects directly — a constructor option or function parameter, never an env var.

| Boundary | Seam | Test double |
|:---------|:---------|:------------|
| rplumber HTTP | `new RplumberClient({ fetch, userAgent, pacing, timeouts, retry })` — `fetch` defaults to `globalThis.fetch` | `createFetchMock` routes serving small synthetic ToC/dictionary JSON and CSV bodies (BOM, quoted fields, empty cells, compound notes, a multi-dataset header union, a header without note columns), a header-only CSV, a 400 retired-dataset body, an HTML challenge page, a 429 with `Retry-After`, and a stream that stalls mid-body |
| SDMX HTTP | `new SdmxClient({ fetch, userAgent, pacing, timeouts, retry })` | Synthetic SDMX-JSON structure (dimensions incl. a non-`SEX` first classification, group-header codes, parentless leaf codes, `IS_TOTAL`, a `DEFAULT` annotation out of dimension order, a content constraint omitting one dimension), SDMX-CSV unit rows, 404 (both bodies), 500 `ORA-…`, 422 |
| Pacing clocks | `pacing` option on both clients (`{ limits: [], minStartGapMs: 0, maxConcurrent: n, maxWaitMs }`) | Zero gaps for unit tests; a tight `maxWaitMs` to exercise `upstream_busy` |
| Request timers | `timeouts: { headersMs, stallMs }` and `retry: { maxRetries, baseDelayMs, deadlineMs }` options on both clients | Millisecond timeouts and zero retry delay, so the stalled-stream and retry-exhaustion cases run fast |
| Current year (projection cutoff) and wall clock (cache TTL, catalog age) | `now: () => Date` option on `CatalogService`, `ObservationService`, `ProfileService`; `projectionCutoff(dataset, catalogEdition, currentYear)` takes both as parameters | Fixed dates on both sides of a year boundary; a catalog with and without an edition in any label |
| Refresh timer and cold-start wait | `CatalogService` options `refreshIntervalMs` (`0` = no timer) and `readyTimeoutMs`, plus a public `refresh()` | Tests call `refresh()` directly, including against a failing fetch to prove stale-while-error; a short `readyTimeoutMs` against a hanging fetch to prove `catalog_unavailable` |
| DuckDB / DataCanvas | `initCanvasBridge(canvas: DataCanvas \| undefined)` — `undefined` exercises the canvas-off path | A framework DuckDB canvas instance in integration tests; a stub `DataCanvas` in unit tests; `undefined` for canvas-off |
| Service wiring for handler tests | `initIlostatServices({ rplumber, sdmx, catalog, canvas, now })` | Handlers run via `createMockContext({ errors: tool.errors })` against injected services; `runToolContract` for envelopes |

Tests pin: every error reason's code and recovery on the wire; blank optional inputs and the period normalizations the schema promises; the zero-row and zero-hit notices; format parity; basis classification (the three cutoff rules, reported rows inside a modelled-heavy dataset, aggregate rows in a national dataset); the allowlist (a request never contains a parameter outside it, and `/data/ref_area` never carries a suffixed code); preflight, `result_too_large`, and the aborted upstream stream after a capped spill; compare's latest mode keeping a reported value newer than the cutoff; flattening of CR/LF in labels and echoed caller text.

## Design Decisions

1. **Nine tools, each traced to a user goal.** `ilostat_search_indicators` returns one hit per indicator with its frequency variants (the same indicator appears as up to three dataset IDs, so per-dataset hits would triple the noise); `ilostat_get_country_profile` accepts X-coded aggregates as well as countries (the modelled headline datasets carry them); `ilostat_list_reference` has an `area_groups` topic because `area_group` values need a decoder; query and compare accept `area_group` so a region is one argument rather than a hand-built code list.
2. **rplumber is the data path; SDMX is structure only.** An SDMX-CSV pull is far larger and slower than rplumber's filtered CSV for the same data, while SDMX alone exposes the codes a dataset uses, total codes, the explorer's default slice, and structured units.
3. **Three datasets per query call, enforced here.** The API documents "up to 3" but accepted eight in a live test; staying inside the documented contract protects a shared hosted IP and survives the day the cap is enforced.
4. **Strict parameter allowlist, blank never sent, `region` never used.** Upstream ignores unknown parameters and treats a blank value as "all", and `region` does not filter at all — each would silently widen a result.
5. **Codes validated against the global dictionaries, not per-dataset prefixes.** A prefix check keyed on the ToC `classification` would reject valid codes (`QTL` datasets use `DCL_*` codes); a globally valid code the dataset does not use returns zero rows with a notice routing to describe, which lists the codes the dataset actually uses.
6. **Basis is decided per row from the source, not from the database.** Modelled values also live outside ILOEST — SDG 1.1.1 is sourced entirely to ILO modelled estimates, and national LFS datasets carry modelled aggregate rows into projection years — so a dataset-level flag would mislabel them.
7. **Projection cutoff: the year before the edition year.** Rows carry no projection flag; the edition in a dataset label is the only machine-readable boundary ILO publishes, and an edition year is itself projected. ILO's methodological overview for the Nov. 2025 edition takes 2024 as the last year with reported information and projects 2025–2027 for labour force participation, unemployment, and LU2 (2025–2026 for informality); live ILOEST unemployment rows carry `R` through 2024 and none after; the labour income share flags 2025–2026 `M` (model-based extrapolation); and UN WPP 2024 estimates end in 2023. The hours-worked model calls its 2025 values estimates, which this rule labels projections — the conservative error. A dataset whose label names no edition takes the catalog's latest ILO modelled estimates edition, because its modelled rows are that edition's output (verified value for value); the calendar-year fallback drifts between editions, so it applies only when no label in the catalog parses. Cutoff and rule are echoed so a reader can see the basis.
8. **`obs_status` is shown, never reinterpreted.** `R` marks national-data years inside ILOEST, but other modelled series use `A`/`I`/`M`/`R`/blank differently, so deriving an "imputed" flag would claim a finer split than the data supports.
9. **Units from a one-observation SDMX probe, cached.** The DSD declares unit attributes without values, and `detail=nodata` still returns every observation; one small data call per indicator is the cheapest structured source. Label parentheticals are shown as text, never parsed into units.
10. **Breakdown slots from SDMX dimension order.** The ToC `classification` names do not always match code prefixes, while the SDMX dimension order is exactly the `classif1`/`classif2` order upstream uses.
11. **Profile makes two area-sliced calls and slices locally.** One cached response per area serves every `sex` value, and pairing reported and modelled slots makes the "never fill a gap from the model" rule visible in the output shape. `/data/ref_area` takes bare indicator codes; suffixed dataset IDs return an empty array rather than an error, so the suffix is stripped in the service.
12. **Compare defaults its slice to the dataset's totals and skips projections unless asked.** Comparable values need one series per area; totals from SDMX `IS_TOTAL` + `DEFAULT` are the upstream's own choice, and a breakdown without a total (deciles) requires an explicit code rather than a guess.
13. **Rank is always by value descending; mixed periods and bases are flagged, not suppressed.** A transparent ordering plus explicit comparability flags serves the agent better than refusing to rank or silently ranking across different years.
14. **Too-large results fail instead of staging a partial table.** Upstream rows arrive sorted by area, so a truncated table is a biased subset that SQL aggregates would treat as complete; streaming stops at the ceiling, so the refusal costs one bounded transfer.
15. **Inline rows carry codes plus a legend; staged rows carry codes and labels.** A legend keeps the inline preview compact without losing decoding; SQL users need labels in-table to filter and group.
16. **DataCanvas on by default with a shared per-tenant canvas and `df_` handles.** One canvas per tenant keeps every staged table joinable in one SQL namespace; `df_XXXXX_XXXXX` names and `ctx.state` provenance let `ilostat_dataframe_describe` explain where each table came from. The handle field is `dataframe`, since "dataset" already names an ILOSTAT indicator-at-a-frequency. Drop is opt-in because TTL reclaims tables and drop is the only destructive operation.
17. **In-memory catalog, refreshed on a timer, stale-while-error.** ~2,000 datasets and ~9,000 codes fit comfortably in memory and change at most daily; a failed refresh leaves still-valid published metadata in service, with its age echoed.
18. **Plain `fetch` with per-endpoint accept-lists.** SDMX 404s are results (no dataflow, no data for an area), data responses stream, and `fetchWithTimeout` throws on every non-2xx.
19. **English only.** Codes are language-neutral and search runs on English labels; carrying French and Spanish triples the catalog for a use no current goal needs.
20. **No resources or prompts.** Every data path is a tool; a describe-by-URI resource would duplicate `ilostat_describe_indicator` without reaching tool-only clients.
21. **No CSV, HTML, or streaming-JSON dependency.** The data CSV holds codes and numbers only, and indicator definitions use five tags and four entities; small in-house parsers are less surface than a library.
22. **Upstream `/data/search` is not used.** It ranks server-side (a youth-unemployment probe put retired-definition series first) and is English-only with a default of five hits; the local catalog index is authoritative and filterable.
23. **Pacing budget: about one request a second.** ILO publishes no rate limit for either host and sends no rate-limit headers; both sit behind Cloudflare bot management with unpublished thresholds, and ILO steers automated bulk use to its bulk-download files. The rplumber budget therefore sits at the conservative end of what keyless public-data APIs publish when they publish one — one request a second (MusicBrainz and Nominatim publish exactly that; NCBI allows three a second without a key) — as a hard 60-per-minute window, two in flight so the profile's parallel pair overlaps, and a 500 ms gap against bursts. SDMX calls are fewer and heavier (50–130 KB structure documents in 1–2 s, a unit probe up to 4 s), so SDMX runs one at a time at 20 a minute. Neither host sends `Retry-After`, so a 429 or challenge closes the gate for 60 s — enough to clear a per-minute window, the most common granularity — doubling to 10 minutes.
24. **Staging goes through the framework's `spillover()` as is.** In mcp-ts-core 0.13.8 it accepts the explicit `schema`, the minted `tableName`, `ttlMs`, and `caps.maxRows`, and reports `truncated` exactly when the source outran the cap; `CanvasInstance.drop` removes the over-ceiling table. It does not close a source it stops reading, so the service owns the abort of the upstream stream.
25. **Compare's latest mode drops projections locally instead of sending `timeto`.** The cutoff describes modelled rows; as `timeto` it would also discard reported national values newer than the cutoff (quarterly national data reach 2026Q2 while the modelled cutoff is 2024). The lookback window is anchored on the current year for the same reason.
26. **A breakdown filter that cannot apply is disclosed in query, rejected in compare.** Upstream passes a dataset without the breakdown through the filter unchanged. A multi-dataset query legitimately mixes datasets with and without it, so a notice names the datasets the filter did not narrow; compare takes one dataset and one slice, so a mismatch there is `invalid_slice`.
27. **Periods are validated by schema pattern, normalized first.** The pattern makes the format machine-checkable in `inputSchema`, and the `z.preprocess` ahead of it applies the promised normalizations so `2024-Q2` still passes. `invalid_period` keeps only the checks a pattern cannot express, so no declared reason sits behind a schema rejection that always fires first.

## Known Limitations

- **No projection flag upstream.** The edition rule is the best available boundary, and it is deliberately conservative: a model that calls its edition-year values estimates (the hours-worked model's 2025) has them labelled `projection`, and a dataset whose label names no edition inherits the catalog's latest ILO modelled estimates edition.
- **Latest means latest per area and indicator**, not per series: a sub-series (e.g. youth) missing in an area's latest year is absent from `latest_only` and profile results rather than taken from an earlier year.
- **Breakdown versions overlap** (`AGE_YTHADULT_*`, `AGE_AGGREGATE_*`, `AGE_10YRBANDS_*` each include 15+); summing across versions double-counts. The instructions and the dataframe-query description say so; the server does not prevent it.
- **One indicator in the catalog has no SDMX dataflow** (and SDMX may be unreachable): describe then returns no breakdown codes, unit, or default slice, and compare needs an explicit slice.
- **Result ceiling.** A query returning more than `ILOSTAT_MAX_ROWS` rows (default 500,000) is refused; the largest datasets (~4.8M rows) need filters.
- **Custom aggregates are out of scope.** Upstream's `/aggregate/*` endpoints compute regional aggregates for arbitrary country groups on ~70 indicators; not exposed.
- **Freshness.** New datasets and codes appear after the next catalog refresh (default 6 h); small upstream responses are cached up to 15 min.
- **Hosted, no-auth deployments share one canvas.** Tenant `default` means every caller can list and query every staged table — acceptable for public statistics, but nothing staged is private.
- **English labels only.**
- **Restricted microdata and the ILOSTAT website** are not reachable through this server.
