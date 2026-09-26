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
| `ilostat_dataframe_query` | Single-statement read-only SQL over staged `df_<id>` dataframes. Registered through `disabledTool()` when `CANVAS_PROVIDER_TYPE=none`. | `sql`, `register_as`, `preview`, `row_limit` | readOnly, idempotent, openWorld: false |
| `ilostat_dataframe_describe` | List staged dataframes with provenance, units, coverage, basis counts, attribution, and column schema. Registered through `disabledTool()` when `CANVAS_PROVIDER_TYPE=none`. | `name` | readOnly, idempotent, openWorld: false |
| `ilostat_dataframe_drop` | Drop a staged dataframe before its TTL. Registered through `disabledTool()` unless `ILOSTAT_DATAFRAME_DROP_ENABLED=true` and the canvas is on. | `name` | readOnly: false, idempotent, openWorld: false |

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
| Reference area | `USA`, `X01` | Trim, uppercase. `ILO_GEO_X06` → `X06`, `ILO_GEO_WB_INC_X02` → `X02` (the ToC's group codes map one-to-one onto the X-coded areas). | ISO2 codes, country names |
| Area group | `X01`, `X06`, `X56`, `X02`, … and the `ILO_GEO_` forms | Same as reference area. `X01` = every country the ref_area ToC lists (aggregates excluded). | Any X code that is not `X01` or a region, subregion, or income group in the ref_area ToC |
| Sex | `SEX_T`, `SEX_M`, `SEX_F`, `SEX_O` | Uppercase; `T`/`M`/`F`/`O` and `total`/`both`/`male`/`female`/`other` map to the codes. | Anything else |
| classif1 / classif2 | `AGE_YTHADULT_Y15-24`, `ECO_SECTOR_AGR`, … | Uppercase, trim. | Codes absent from the matching dictionary |
| Source | `BA:453` | Uppercase, trim. | Codes absent from the source dictionary |
| Period (`time`, `period`) | `2024`, `2024Q2`, `2025M03` | `2024-Q2`, `2024 Q2` → `2024Q2`; `2025-03` → `2025M03`; a bare number (`2024`) → its digits. | Other shapes; a sub-annual period on a dataset of another frequency |
| Year (`time_from`, `time_to`) | `2010` | A bare number (`2010`) → its digits. | Anything but four digits (upstream reads the year only) |
| Dataframe name (describe and drop `name`, query `register_as`) | `df_ABCDE_FGHIJ` | Trim; a `df_` prefix in any case → `df_` plus the rest uppercased, the minted form (SQL resolves names case-insensitively, so a name copied from SQL in any case resolves). | Anything else not matching `^df_[A-Z0-9]{5}_[A-Z0-9]{5}$` after the fold |

Array inputs drop blank elements. Optional string and enum inputs treat `""` as unset (`blankAsUnset` from the `add-tool` skill); an unset filter is left off the upstream request, never sent as `param=` — upstream reads a blank `ref_area=` as "every area".

Period and year inputs are checked in the schema. A `z.preprocess` inside `blankAsUnset` applies the normalizations above (trim, uppercase, `2024-Q2`/`2024 Q2` → `2024Q2`, `2025-03` → `2025M03`), and the pattern runs on its result: `time` and `period` `^\d{4}(Q[1-4]|M(0[1-9]|1[0-2]))?$`, `time_from` and `time_to` `^\d{4}$`. A malformed period is therefore an argument rejection (`invalid_arguments`), and each tool's `invalid_period` covers only what a pattern cannot see (frequency mismatch, conflicting combinations, reversed ranges).

Dataset IDs, area codes, and sex codes are checked in the schema the same way, through the shared input helpers in `tool-helpers.ts`. The preprocess applies the normalizations in the table (trim, uppercase, `DF_` / `ILO_GEO_` / `ILO_GEO_WB_INC_` prefixes stripped, sex aliases mapped), then a dataset ID must match `^[A-Z0-9_]+$` (every live dataset and indicator code does; describe's `dataset_id` also admits `+`/`,`-joined IDs, so its one-per-call guidance still answers them), a reference area or area group `^[A-Z0-9]{3}$` (every live area code is three characters), and a sex code must be one of `SEX_T | SEX_M | SEX_F | SEX_O` (`SEX_T | SEX_M | SEX_F` on the profile). A malformed code is therefore `invalid_arguments`; a well-formed code the catalog lacks still fails the tool's dictionary check (`unknown_dataset`, `unknown_code`, `unknown_area_group`, `unknown_area`; describe answers `found: false`). Every other code input (`classif1`/`classif2`, `sources`, `database`, `subject`, `breakdown`, `classification_type`, the reference `codes`) carries no pattern: it is trimmed and uppercased in the handler or service and validated against the dictionaries.

Array caps per call: `dataset_ids` 3, `ref_areas` 300, `sex` 4, `classif1`/`classif2`/`sources` 100 each, `codes` 100. The `dataset_ids` split of `+`/`,`-joined elements runs in the schema preprocess, so the cap of 3 applies to the IDs after splitting.

Validation shared by query and compare (dataset IDs, area groups, codes, aggregates, periods, the size preflight, the row ceiling, the slice) lives in `ObservationService`, which raises each failure through the calling tool's own `ctx.fail`, so the reason, code, and recovery come from that tool's contract; those contract entries carry `thrownBy: 'service'`.

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

ILO-published text (indicator labels and definitions, area/source/classification/note labels, the ToC update time, which passes through unchanged when it is not in the expected shape, and the codes upstream sends — area, source, breakdown, period, status, note, unit, and area-group codes) is data, and so is caller text echoed back (the search `query`, the reference `filter`, rejected codes in error messages, column names a `register_as` SQL alias sets). `format()` and every composed notice blockquote multi-line text (the indicator definition) and flatten CR/LF to a space in every inline slot (headings, bold labels, list items, table cells, quoted echoes — table cells also escape `|` and `\`). `structuredContent` carries values verbatim. The server instructions say this text is data.

### Canvas staging

Producers (`ilostat_query_indicator`, `ilostat_compare_geographies`) stage a result on the tenant's shared canvas when it exceeds the inline preview:

- One shared canvas per tenant, its ID kept in `ctx.state` (`canvas-id`) and re-minted when the stored ID no longer resolves (expired, or lost to a restart that kept `ctx.state`). Tables are named `df_XXXXX_XXXXX` (5 + 5 uppercase letters/digits) and registered with a per-table TTL (`ILOSTAT_DATASET_TTL_SECONDS`).
- Provenance per table in `ctx.state` under `df-meta/<name>`: source tool, query params, created/expires, row count, column schema, the datasets it holds (ID, label, unit, last update), coverage (area count, period min/max), basis counts, attribution. A dataframe derived by `ilostat_dataframe_query`'s `register_as` records its SQL and the dataframes it read (`derived_from`) as query params and inherits their datasets; its coverage and basis counts are unknown and left absent. Every dataframe op lazily sweeps expired entries first. A re-minted canvas starts empty, so minting one deletes every `df-meta/` record before the new ID is stored; `ilostat_dataframe_describe` also deletes, rather than lists, any record whose table is no longer on the canvas.
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
| `unit`, `unit_multiplier` | VARCHAR, INTEGER | Dataset unit label, e.g. `Percentage` (its code when unlabelled; NULL when unresolved); multiplier 0/3/6 = units/thousands/millions |
| `obs_status`, `obs_status_label` | VARCHAR | |
| `note_codes`, `note_labels` | VARCHAR | `;`-joined codes; ` \| `-joined labels |
| `basis` | VARCHAR | `reported` \| `modelled_estimate` \| `projection` |
| `best_source` | BOOLEAN | Set only when `source_selection` is `all` or `secondary` |

A staged comparison (`ilostat_compare_geographies`) holds one row per area: `dataset_id, rank, ref_area, ref_area_label, ref_area_kind, period, year, subperiod, value, unit, unit_multiplier, basis, source, source_label, obs_status, obs_status_label, note_codes, note_labels, change_from_period, change_from_value, change_delta`, typed as above (`rank` INTEGER, `change_*` VARCHAR/DOUBLE/DOUBLE).

### Catalog-dependent failure

Every tool except the dataframe trio awaits the in-memory catalog. When no snapshot has loaded and the load attempt fails, or the first load has not finished within 30 s of the call, the tool fails with `catalog_unavailable` (`ServiceUnavailable`, retryable, `thrownBy: 'service'`); recovery: `The ILOSTAT catalog could not be loaded from the upstream API; wait about a minute and call the tool again.` Each tool below lists it once in its error table. Checks that need no catalog — a `cursor` that does not decode, `ilostat_list_reference`'s `param_not_for_topic`, `ilostat_query_indicator`'s `invalid_period` for `time` combined with a range or `latest_only` and for a reversed range, `ilostat_compare_geographies`'s `areas_required` — run before the wait, so a caller's malformed input is never answered with a retry-later outage.

### Error severity

Each declared reason sets the level its `Error in tool:<name>` log record is written at (the contract's `severity`); the wire envelope is the same at every level. Reasons a caller's input causes log at `notice`: `unknown_filter_code`, `invalid_cursor`, `unknown_dataset`, `unknown_code`, `unknown_area_group`, `unknown_area`, `areas_required`, `aggregates_unavailable`, `invalid_period`, `invalid_slice`, `request_too_broad`, `result_too_large`, `param_not_for_topic`, and the nine SQL-gate and table reasons of `ilostat_dataframe_query`. `dataset_retired` logs at `warning`: the caller did nothing wrong, but the catalog is behind upstream until the next refresh. `upstream_busy`, `catalog_unavailable`, `structure_unavailable`, and `canvas_unavailable` declare no severity and keep `error`.

### Result shapes

Enrichment keys are declared optional unless every path writes them (`applied_filters` on query and compare, and `truncated`/`shown`/`cap` on search, list, query, compare, and dataframe query, are always written — `truncated: false` first, overwritten where a cap bites). Every search, list, and query result defines its zero-result shape — arrays empty, counts zero, min/max fields absent, a composed `notice` — and a result cut short (a page cap, the canvas-off preview cut, a failed canvas registration) sets `truncated: true` with `shown`/`cap` and never presents a partial summary as complete. On query and compare, `cap` is the inline preview budget in serialized characters, measured — as `spillover()` measures it — over the staged row form, labels included.

## Tools — detail

### `ilostat_search_indicators`

**Description:** Search ILOSTAT's catalog of labour-statistics indicators by plain-language terms and filters. Each hit is one indicator with its datasets — one per available frequency (annual, quarterly, monthly) — plus breakdowns, coverage years, number of reference areas, source database, and last update; pass a dataset ID to ilostat_describe_indicator for its units and breakdown codes, then to ilostat_query_indicator or ilostat_compare_geographies for values. Every search term must match a word or word prefix in the indicator's label, subject, database, breakdown names, code, or definition; British and American spellings (labour/labor) match alike. Facet counts reflect all applied filters.

| Param | Type | Maps to | Notes |
|:------|:-----|:--------|:------|
| `query` | string, optional | local index | Normalized: lowercase, diacritics stripped, punctuation → space, `labor` → `labour`, a trailing plural `s` tolerated. Omit to browse by filters (results then order by indicator code); a query with no letter or digit browses the same way and says so in `notice`. |
| `frequency` | enum `A` \| `Q` \| `M`, optional | ToC `freq` | Narrows each hit's `datasets`; an indicator with no dataset left drops out. |
| `database` | string, optional | ToC `database` | Uppercased; validated against the database codes in the ToC (17, e.g. `LFS`, `ILOEST`). |
| `subject` | string, optional | ToC `subject` | Uppercased; validated against the subject codes in the ToC. |
| `breakdown` | string, optional | ToC `classification` components | A classification type code (`AGE`, `ECO`, `GEO`, `SEX`, …); validated against the `classif_type` dictionary plus the components the ToC uses (the ToC names one type, `QTL`, that the dictionary lacks). |
| `aggregates_only` | boolean, default `false` | ToC `with.region = "Y"` | Keeps the datasets that carry World/regional/income-group rows; an indicator with none left drops out (`with.region` is per dataset — Design Decisions). |
| `limit` | int 1–50, default 10 | — | Hits per page. |
| `cursor` | string, optional | — | Opaque; from the previous page's `next_cursor`. |

**Ranking rule (transparent, no score exposed):** tier 1 — every term matches the label; tier 2 — every term matches across label, subject, database, breakdown names, and code; tier 3 — the definition text is needed. Within a tier, more reference areas first, then indicator code. Each hit reports its tier as `match_scope: 'label' | 'metadata' | 'definition'`.

**Output**

| Field | Type | Notes |
|:------|:-----|:------|
| `hits[]` | object | `indicator`, `label`, `subject {code,label}`, `database {code,label}`, `classification?` (e.g. `SEX_AGE`; absent when none), `breakdowns` (e.g. `["sex","age"]`; empty when none), `has_aggregates` (any listed dataset), `match_scope?` (absent when browsing without a query), `datasets[] {dataset_id, frequency, data_start, data_end, n_ref_area, n_records, last_update, has_aggregates}` |
| `total` | number | Indicators matched after all filters |
| `facets` | object | `databases[] {code,label,count}`, `frequencies[] {code,count}`, `subjects[] {code,label,count}` over the fully filtered match set — every filter narrows the facets as well as the hits |
| `next_cursor` | string, optional | Present while more hits remain |
| `catalog_as_of` | string | ISO timestamp of the snapshot searched |

`last_update` is converted from upstream `dd/mm/yyyy HH:MM:SS` to ISO 8601 without a zone offset (upstream publishes none). Truncation via `ctx.enrich.truncated({ shown, cap, guidance })` when `total > limit`. The framework keeps one notice, and the truncation guidance replaces it, so a paged result composes its guidance as the service notice (the no-searchable-word explanation) followed by the paging line; an unpaged result sets the service notice alone.

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
| `invalid_cursor` | InvalidParams | `cursor` does not decode, checked before the catalog wait (the framework's `decodeCursor` rejection, rewrapped with this recovery; `thrownBy: 'service'`) | `Omit cursor to start from the first page, or pass next_cursor from the previous response unchanged.` |
| `catalog_unavailable` | ServiceUnavailable | see Shared conventions | see Shared conventions |

Zero hits: `hits` empty, `total` 0, each facet array empty, no `next_cursor`, plus the notice.

**format():** per hit, `### {indicator} — {label}` (label CR/LF-flattened), a line with database, subject, breakdowns, aggregates flag, match scope, then one line per dataset (`- UNE_DEAP_SEX_AGE_RT_Q · quarterly · 1948–2026 · 122 areas · 658,738 records · updated 2026-…`; `1 area` for one, the update time flattened). Facets as three compact lines; `next_cursor` last.

### `ilostat_describe_indicator`

**Description:** Explain one ILOSTAT dataset before comparing numbers: its definition, unit and multiplier, frequency variants and coverage, the sex and breakdown codes it actually uses (the total code of each breakdown marked), the reference areas it covers, whether it carries World/regional/income-group aggregates, and how its observations are classed as reported, modelled, or projected. Accepts a dataset ID (UNE_DEAP_SEX_AGE_RT_A) or a bare indicator code (UNE_DEAP_SEX_AGE_RT), which describes every frequency. An unknown code returns found: false with guidance.

| Param | Type | Maps to | Notes |
|:------|:-----|:--------|:------|
| `dataset_id` | string, required | ToC `id` / `indicator`; SDMX `DF_{indicator}` | Dataset-ID normalization (Shared conventions). A dataset ID describes that dataset and lists its frequency variants; a bare indicator code describes every frequency. One ID per call: a `+`/`,`-joined value is a miss whose guidance says to describe one dataset per call. |

**Output**

| Field | Type | Notes |
|:------|:-----|:------|
| `found` | boolean | `false` on a miss |
| `guidance` | string, optional | Miss only: `No ILOSTAT dataset or indicator has the code {X}. Dataset IDs are an indicator code plus _A, _Q, or _M (for example UNE_DEAP_SEX_AGE_RT_A); find one with ilostat_search_indicators.` A miss carries only `found`, `guidance`, and `catalog_as_of`; every other field is optional in the schema and present only on a hit. |
| `dataset_id` | string, optional | The requested dataset, when a dataset ID (not a bare indicator code) was given |
| `indicator`, `label` | string | |
| `definition` | string | Indicator dictionary description, HTML stripped (`<a href>` → `text (url)`; `<strong>`, `<i>`, `<p>`, `<br>` dropped; `&gt; &lt; &nbsp; &ndash;` decoded — `&lt;`/`&gt;` first, since some anchors arrive entity-escaped) |
| `measure` | `{code, label}` | ToC `rep_var` — the quantity measured, shared by breakdown variants |
| `database`, `subject` | `{code, label}` | |
| `datasets[]` | object | Every frequency variant of the indicator, annual first: `dataset_id, frequency, data_start, data_end, n_ref_area, n_records, n_records_all, last_update, has_aggregates` (`n_records` counts the best-source rows an unfiltered download returns; `n_records_all` adds secondary sources) |
| `breakdowns` | object | `sex: boolean`; `sex_codes[]`; `classif1?` / `classif2?` `{ type, type_label, codes[] {code, label, is_total} }` |
| `default_slice` | object | `sex?`, `classif1?`, `classif2?` — the dataset's total codes (see below); what `ilostat_compare_geographies` uses when a slice is omitted |
| `unit` | object, optional | `measure` (`PT`, `PS`, `LC`, …), `measure_label`, `type` (`RT`, `NB`, …), `type_label`, `multiplier` (0/3/6), `multiplier_label`. Values are already in the multiplier's scale. |
| `has_aggregates` | boolean | ToC `with.region = "Y"` of the requested dataset; for a bare indicator code, of any of its datasets |
| `ref_areas` | object | `countries[]`, `aggregates[]` (codes), `count` |
| `basis_rule` | object | `modelled_source_label` (`ILO - Modelled Estimates`), `projection_after_year`, `projection_rule` (`edition` \| `catalog_edition` \| `current_year`), `edition?` (e.g. `Nov. 2025`; the catalog's latest edition under `catalog_edition`), `database_is_modelled` (ILOEST) |
| `related_datasets[]` | object | Up to 20 other ToC indicators sharing this `measure` — the same quantity under other breakdowns: `{indicator, label, classification}` |
| `structure_status` | `'complete' \| 'unavailable'` | `unavailable` when SDMX has no dataflow for the indicator or is unreachable; breakdown codes, default slice, unit, and area lists are then absent |
| `catalog_as_of`, `attribution` | string | |

Breakdown mapping: SDMX dimensions after `MEASURE`, in position order, excluding `SEX`, become `classif1` then `classif2` (verified on a two-breakdown dataset: `INS` at position 4 arrives as `classif1`, `DSB` at 5 as `classif2`) — the ToC `classification` field is not used for this, because its component names do not always match the codes (`LAP_2LID_QTL_RT` is classified `QTL` but its codes are `DCL_DECILE_*`). Codes in use come from the content constraint's key values; a dimension the constraint omits (`DCL` on `LAP_2LID_QTL_RT`) takes its codes from the partial codelist, which `detail=referencepartial` already limits to codes in use. Classification group headers — codes that are another code's `parent`, such as `AGE_YTHADULT` — are dropped; a parentless leaf such as `DCL_DECILE_01` stays. `is_total` comes from the SDMX `IS_TOTAL` annotation (`Y`/`N` in its title). `default_slice` takes, per dimension ID, the first code the dataflow's `DEFAULT` annotation lists for it (`…,AGE=AGE_YTHADULT_YGE15+…,SEX=SEX_T,…`; entries are keyed by dimension ID, not in dimension order) that carries `IS_TOTAL = Y`; a dimension whose default codes include no total (deciles) is left out.

Unit: one SDMX data probe `…/{AREA}{.…}?lastNObservations=1` using the first `REF_AREA` of the dataflow's content constraint (frequency wildcarded, since units attach to `MEASURE`); on `404 No data` the next area is tried, up to three. `UNIT_*` codes are decoded with the dataflow's codelists.

`enrichment.notice` when `structure_status` is `unavailable` or the unit did not resolve: `Breakdown codes and units are unavailable from the ILOSTAT structure service; ilostat_list_reference topic classifications lists every breakdown code, and the label's parenthetical — (%) or (thousands) — gives the unit.`

**Errors**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `catalog_unavailable` | ServiceUnavailable | see Shared conventions | see Shared conventions |

A miss is `found: false`, not an error. SDMX failures degrade to `structure_status: 'unavailable'` with the notice above.

**format():** `## {dataset_id} — {label}`, then database / subject / measure / unit / aggregates / basis rule lines, the definition as a blockquote, a per-frequency coverage list (area count singular for one area, update time flattened), per-breakdown code lists (`code — label`, each total marked `is_total: true`), `default_slice`, area counts plus the aggregate codes and country codes on wrapped lines, related datasets, and the attribution line.

### `ilostat_query_indicator`

**Description:** Fetch observations for up to 3 ILOSTAT datasets, filtered by reference area or area group, sex, breakdown codes (classif1, classif2), source, and period. Rows keep their source, observation status, decoded notes, and a basis — reported, modelled_estimate, or projection — and the response echoes every filter applied, including the best-source default. Codes are checked against ILOSTAT's dictionaries before the request is sent: ilostat_list_reference lists valid codes and ilostat_describe_indicator lists the codes a dataset actually uses. A result larger than the inline preview is staged in full as a df_<id> dataframe for SQL through ilostat_dataframe_describe and ilostat_dataframe_query when this deployment enables dataframes. A request with no filters at all is refused when the dataset exceeds the row ceiling, and a filtered request that still exceeds it is refused with guidance to narrow it.

| Param | Type | Maps to | Notes |
|:------|:-----|:--------|:------|
| `dataset_ids` | string[] 1–3 | `id` (`+`-joined) | Dataset-ID normalization. The API documents a three-dataset cap per call; the schema enforces it. |
| `ref_areas` | string[] 0–300, optional | `ref_area` (`+`-joined) | Validated against the `ref_area` dictionary. |
| `area_group` | string, optional | expands into `ref_area` | `X01` for every country, an ILO region or subregion, or a World Bank income group. Member countries from the ref_area ToC (union with `ref_areas`); the upstream `region` parameter is never used. |
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

**Unresolved unit:** whenever a dataset's unit does not resolve — SDMX unreachable, no dataflow, or a unit probe that failed or found no unit attributes — `notice` says `The unit of {dataset_ids} is unavailable from the ILOSTAT structure service; the dataset label's parenthetical — (%) or (thousands) — gives it.`, naming only the datasets without one. The rows are unchanged; the notice keeps an absent `unit` from reading as a unitless value.

**Preflight:** a request with none of `ref_areas`, `area_group`, `sex`, `classif1`, `classif2`, `sources`, `time`, `time_from`, `time_to`, `latest_only` is estimated from the ToC — `n.records` (or `n.records.all` when `source_selection` is not `best`) summed over the requested datasets, which is the exact row count of an unfiltered download (verified on two datasets for both counts); above `ILOSTAT_MAX_ROWS` it fails with `request_too_broad` before any upstream call. An `area_group` counts as a filter, so `X01` never trips the preflight; its expansion (every country, aggregates left out) streams like any filtered request and fails `result_too_large` only if it still passes the row ceiling.

**Row routing:** the first rows fill the inline preview (`ILOSTAT_PREVIEW_CHARS`); on overflow, the full stream is registered on the canvas through the framework's `spillover()` with the minted `df_` name (`tableName`), the explicit `schema`, the table `ttlMs`, and `caps.maxRows = ILOSTAT_MAX_ROWS`. `spillover()` reports `truncated: true` exactly when the source held more rows than the cap; the bridge then drops the table (`CanvasInstance.drop`) and the call fails with `result_too_large`. `spillover()` stops pulling at the cap but never closes its source, so the row stream is backed by an `AbortController` the service aborts in a `finally` once `spillover()` returns — which is what keeps the refusal to one bounded transfer; the canvas-off path aborts the same way when it stops at the preview.

Summary counts are accumulated over every row read. `row_count` and `summary` are exact when the result is inline or staged. When reading stopped early — the canvas is off, or canvas registration failed and the bridge fell back to the preview — `row_count` is the rows read, `summary.complete` is `false`, and `truncated`/`shown` disclose it.

**Output**

| Field | Type | Notes |
|:------|:-----|:------|
| `datasets[]` | object | `dataset_id, label, frequency, database, last_update, has_aggregates, projection_after_year, projection_rule, edition?, unit?` (unit from the cached SDMX lookup, resolved in parallel with the data request; absent when unresolved, and `notice` then names the dataset (Unresolved unit). A lookup that fails for this server's own fault — an SDMX 422 on the probe key — fails the call `InternalError`, as describe does) |
| `row_count` | number | Rows the request returned. Exact whenever the result is inline or staged; when reading stopped early (Row routing), it is the rows read and `enrichment.truncated` says more exist |
| `rows[]` | object | Preview rows: `dataset_id, ref_area, source, sex?, classif1?, classif2?, period, value?, obs_status?, notes[]` (codes), `basis`, `best_source?` |
| `legend` | object | Code → label maps for every code in `rows`: `ref_area, source, sex, classif1, classif2, obs_status, notes` |
| `summary` | object | Over all rows read: `ref_areas` (count), `period_min?`, `period_max?` (absent on zero rows), `basis_counts {reported, modelled_estimate, projection}`, `complete` (false when reading stopped early — see Row routing) |
| `dataframe` | object, optional | `{ name, row_count, expires_at }` when staged |
| `attribution` | string | `Source: ILOSTAT, International Labour Organization (CC BY 4.0) — https://ilostat.ilo.org` |

**Enrichment:** `applied_filters` (echo of every parameter sent upstream, defaults included: `best_source` and the `source_selection` it came from, the area list an `area_group` expanded to as a count plus the group code, and the total areas sent as `ref_area_count`), `notice` (not-applicable filters, the unresolved-unit sentence, the zero-row fragments, and the dataframe pointer or the preview-cut disclosure, in that order), `truncated`/`shown`/`cap` (`cap` = the preview budget in characters; see Result shapes).

**Zero-row notice** (zero rows: `rows` empty, `legend` maps empty, `summary.ref_areas` 0, no period bounds), composed from whichever conditions hold:

| Condition | Fragment |
|:----------|:---------|
| sex/classif1/classif2 filter set on a dataset that has that breakdown | `{dataset_id} may not use {codes} — ilostat_describe_indicator {dataset_id} lists the codes it uses.` |
| time window set | `{dataset_id} covers {data_start}–{data_end}; widen time_from/time_to or drop time.` |
| areas set | `Some requested areas have no {dataset_id} data — ilostat_describe_indicator lists the areas it covers.` |
| `source_selection: secondary` | `No secondary sources exist for this request; use source_selection best or all.` |
| none of the above | `The request matched no observations.` |

**Errors**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `unknown_dataset` | NotFound | A dataset ID is not in the catalog, or a bare indicator code has several frequencies | `Call ilostat_search_indicators to find a dataset ID — an indicator code plus _A, _Q, or _M, such as UNE_DEAP_SEX_AGE_RT_A.` (dynamic override lists the frequency variants when ambiguous) |
| `unknown_code` | ValidationError | A `ref_areas`, `sex`, `classif1`, `classif2`, or `sources` value is not in the dictionaries | `Call ilostat_list_reference with the topic for that field (ref_areas, sexes, classifications, or sources) to find valid codes.` (dynamic override names the field, the rejected codes, and the topic) |
| `unknown_area_group` | ValidationError | `area_group` is not `X01`, a region or subregion, or an income group | `Call ilostat_list_reference with topic area_groups to see the group codes area_group accepts.` |
| `aggregates_unavailable` | ValidationError | An X-coded aggregate was requested and a requested dataset has no aggregates (the message names the dataset) | `Request countries only, or use a dataset whose ilostat_describe_indicator output shows has_aggregates true, such as the ILO modelled estimates in database ILOEST.` |
| `invalid_period` | ValidationError | A sub-annual `time` on a dataset of another frequency, `time` combined with a range or `latest_only`, or `time_from` after `time_to` (a malformed period fails the schema pattern first) | `Use YYYY for time_from and time_to, and YYYY, YYYYQn, or YYYYMmm matching the dataset frequency for time, never time together with a range or latest_only.` |
| `request_too_broad` | ValidationError | No filters and the unfiltered size exceeds `ILOSTAT_MAX_ROWS` | `Add ref_areas or area_group, a time_from/time_to window, latest_only, or sex/classif1 filters; ilostat_describe_indicator lists the codes this dataset uses.` |
| `result_too_large` | ValidationError | The filtered result passed `ILOSTAT_MAX_ROWS` while streaming | `Narrow the request with fewer reference areas, a shorter time window, or specific sex/classif1 codes, then call again.` |
| `dataset_retired` | NotFound | Upstream answers 400 "deprecated or invalid dataset id" for a catalog ID (`thrownBy: 'service'`) | `The dataset was withdrawn upstream after the last catalog refresh; call ilostat_search_indicators for its current equivalent.` |
| `upstream_busy` | RateLimited, retryable | Pacer shed (`pacer_shed` rewrapped, its `retryAfter` kept, floored at 1 s), upstream 429, or a Cloudflare challenge page (`thrownBy: 'service'`) | `The ILOSTAT API is throttling this server; wait the retry-after interval in the error data, then call again with the same arguments.` |
| `catalog_unavailable` | ServiceUnavailable | see Shared conventions | see Shared conventions |

**format():** a dataset block per dataset (ID, label, unit, database, last update, basis rule); the applied-filter echo; rows grouped by `dataset · ref_area · sex · classif1 · classif2 · source` as `#### USA · SEX_T · AGE_YTHADULT_YGE15 · BA:453` followed by `- 2025: {value} [B Break in series] · reported · notes R1:3513, T2:85` lines; the legend (`code — label`, flattened); the summary line (area count singular for one area); the dataframe pointer when staged; attribution.

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

Each dataset ID is checked whenever a catalog snapshot loads; an entry whose dataset has left the catalog is dropped from the profile with a logged warning rather than failing every call. When every entry has left, the call fails `ServiceUnavailable` before any upstream call (`None of the country profile's headline datasets is in the current ILOSTAT catalog, so no profile can be built.`, recovery: `Find labour-market datasets with ilostat_search_indicators and read the area from them with ilostat_query_indicator.`).

**Upstream:** two `/data/ref_area` calls in parallel (Workflow Analysis). That endpoint's `indicator` parameter takes indicator codes without the frequency suffix (`UNE_DEAP_SEX_AGE_RT`) — the frequency rides on `id={AREA}_A`, and `_A`-suffixed IDs return `200 []` — so the service strips the suffix from the table's dataset IDs when building the call. For an X-coded aggregate the reported call is skipped — national datasets carry aggregate rows only as ILO modelled estimates, which the basis rule would exclude from the reported slot anyway. Both calls must succeed: a failed reported call fails the profile (`upstream_busy` or a baseline upstream error) rather than rendering every key as `reported_missing`, which would state an absence the server never observed.

**Output**

| Field | Type | Notes |
|:------|:-----|:------|
| `ref_area` | object | `code, label, kind, income_group? {code,label}, region? {code,label}, subregion? {code,label}` (`subregion` is the ILO broad subregion) |
| `sex` | string | Echo |
| `indicators[]` | object | `key, label, unit, reported?, modelled?` — `reported {dataset_id, period, value?, source, source_label?, obs_status?, obs_status_label?, notes[] {code,label?}}`; `modelled {dataset_id, period, value?, basis, obs_status?, obs_status_label?, edition?}` |
| `reported_missing` | string[] | Keys with no reported value, including the keys that have no reported dataset (labour income share, working poverty rate) |
| `modelled_cutoff_year` | number | Latest year the modelled call admitted (the smallest projection cutoff across the modelled headline datasets — 2024 under the Nov. 2025 edition) |
| `catalog_as_of`, `attribution` | string | |

`enrichment.notice` when any key is in `reported_missing`: `No reported value exists for {keys}; the modelled estimates shown for them are ILO model output, not national observations.`, followed by `{keys} have no modelled estimate either.` when some keys have neither value (the modelled informality series covers 87 areas; World working poverty is published for `SEX_T` only).

**Errors**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `unknown_area` | ValidationError | `ref_area` is not an ILOSTAT reference area with annual data | `Call ilostat_list_reference with topic ref_areas and a name filter to find the ISO3 or X-coded area code.` |
| `upstream_busy` | RateLimited, retryable | as in `ilostat_query_indicator` (`thrownBy: 'service'`) | same text as in `ilostat_query_indicator` |
| `catalog_unavailable` | ServiceUnavailable | see Shared conventions | see Shared conventions |

**format():** `## {label} ({code})` with income group and region, then a table: indicator · reported (value, period, status) · modelled (value, period, basis) · unit; then per-indicator source and note lines (flattened); the missing-reported line; attribution.

### `ilostat_compare_geographies`

**Description:** Compare reference areas on one ILOSTAT dataset and one slice — a sex code plus breakdown codes, defaulting to the dataset's totals — giving each area's value at a common period or at its latest non-projected period, optional change over N years, and a rank, with each value's period, source, status, and basis (reported, modelled_estimate, or projection). Areas without a value are listed separately with the reason, and the response flags mixed periods and mixed bases rather than hiding them. Select areas by code list, by group (X01 for every country, an ILO region or subregion, or a World Bank income group), or both; X-coded aggregates require a dataset with aggregates.

| Param | Type | Maps to | Notes |
|:------|:-----|:--------|:------|
| `dataset_id` | string, required | `id` | Dataset-ID normalization; one dataset. |
| `ref_areas` | string[] 0–300, optional | `ref_area` | At least one of `ref_areas` / `area_group`. |
| `area_group` | string, optional | expands into `ref_area` | `X01` for every country, an ILO region or subregion, or a World Bank income group. Member countries; the group's own aggregate is included only when listed in `ref_areas`. |
| `sex` | string, optional | `sex` | Default `SEX_T` when the dataset has a sex breakdown; a value on a dataset without one fails with `invalid_slice`. |
| `classif1`, `classif2` | string, optional | `classif1`, `classif2` | Default from `default_slice` (SDMX, cached). A breakdown with no total code and no value given, or a value for a breakdown the dataset lacks, fails with `invalid_slice`; a breakdown left to its default while the structure is unavailable fails with `structure_unavailable`. |
| `period` | string, optional | `time` | `YYYY`, `YYYYQn`, `YYYYMmm` matching the dataset frequency; schema pattern after normalization. Omitted → latest mode. |
| `lookback_years` | int 1–50, default 10 | `timefrom` | Latest mode: an area's latest value must fall within this many years of the current year. |
| `change_years` | int 1–30, optional | widens `timefrom` | Adds `change {from_period, from_value, delta}`: the same sub-period N years earlier; `delta = value − from_value` in the dataset unit. |
| `include_projections` | boolean, default `false` | local | Latest mode skips `projection` rows unless true. |
| `sort` | enum `value_desc` \| `value_asc` \| `ref_area`, default `value_desc` | local | Orders rows only; `rank` is always by value descending, ties sharing a rank. |

Latest mode requests `timefrom = current year − lookback_years − (change_years ?? 0)` with no `timeto`, classifies every row's basis, drops `projection` rows unless `include_projections`, then keeps each area's latest remaining period. The projection cutoff is never sent as `timeto`: it bounds modelled rows only, and a reported national value can be newer than it (quarterly national series already run to 2026Q2 while the modelled cutoff is 2024). Period mode requests `time = period` plus, with `change_years`, the earlier period, `+`-joined in one `time` value (`time=2014+2024`). Only rows with a value are candidates; `delta` is rounded to six decimals to drop binary noise. `best_source` stays at the upstream default; the echo says so.

Rows beyond the inline preview are staged (below). With the canvas off, or when registration fails, the inline rows stop at the preview budget with `truncated`/`shown` set; ranks, `missing`, and `comparability` are still computed over every area.

**Output**

| Field | Type | Notes |
|:------|:-----|:------|
| `dataset` | object | Same per-dataset meta as `ilostat_query_indicator.datasets[]` |
| `slice` | object | `sex?, classif1?, classif2?, defaulted[]` (which were filled from the dataset's totals) |
| `mode` | `'latest' \| 'period'` | plus `period?`, `window_from?`, `change_years?`, `include_projections` |
| `rows[]` | object | `rank, ref_area, label?, kind, value, period, basis, source, source_label?, obs_status?, notes[], change?` (labels absent only for a code the loaded dictionaries lack) |
| `legend` | object | Code → label maps for the codes in `rows`: `obs_status`, `notes` (the area and source labels ride on each row) |
| `missing[]` | object | `{ref_area, label?, reason: 'no_value_in_window' \| 'no_value_for_period' \| 'not_covered'}` (`not_covered` = absent from the dataset's area list when structure is known; with the area list unavailable, an uncovered area reads as one of the other two and `notice` says so) |
| `comparability` | object | `periods[]` (distinct, newest first), `mixed_periods`, `basis_counts`, `distinct_sources` (a count) |
| `dataframe` | object, optional | `{ name, row_count, expires_at }` when rows exceed the inline preview (staged-comparison schema in Shared conventions) |
| `attribution` | string | |

**Enrichment:** `applied_filters`, `truncated`/`shown`/`cap` (as in query), `notice` composed from: mixed periods (`Values span {n} periods, {oldest} to {newest}; pass period for a like-for-like comparison.`), mixed bases (`{n} values are ILO modelled estimates and {m} are reported; they are not directly comparable.`, each count in the singular for one: `1 value is an ILO modelled estimate`, `1 is reported`), missing areas (`{k} areas have no value; see missing.`, or `1 area has no value; see missing.`), an unavailable area list (`The area list of {dataset_id} is unavailable from the ILOSTAT structure service, so no missing area is marked not_covered, even one {dataset_id} does not cover.`), an unresolved unit (the query's Unresolved unit sentence), and the dataframe pointer or the preview-cut disclosure. Both structure sentences appear when the structure is unavailable and the call still succeeds (an explicit slice, or a dataset without classif breakdowns); the unit sentence appears alone when the area list was read but the unit was not (a failed unit probe, or no unit attributes).

**Errors**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `unknown_dataset` | NotFound | as in `ilostat_query_indicator` | same text |
| `unknown_code` | ValidationError | as in `ilostat_query_indicator` | same text |
| `unknown_area_group` | ValidationError | as in `ilostat_query_indicator` | same text |
| `areas_required` | ValidationError | Neither `ref_areas` nor `area_group` given | `Pass ref_areas (ISO3 or X codes) or an area_group such as X06 for every African country; ilostat_list_reference topic area_groups lists the groups.` |
| `aggregates_unavailable` | ValidationError | as in `ilostat_query_indicator` | same text |
| `invalid_slice` | ValidationError | A breakdown has no total code and no value was given, or `sex`/`classif1`/`classif2` names a breakdown the dataset lacks | `Pass sex, classif1, and classif2 only for breakdowns the dataset has, with explicit codes where it has no total; ilostat_describe_indicator lists them.` |
| `structure_unavailable` | ServiceUnavailable | `classif1` or `classif2` was left to its default and the SDMX structure is unavailable (unreachable, or no dataflow), so no total code can be read; `fields` names every such breakdown (`thrownBy: 'service'`) | `ILOSTAT's structure service could not supply the dataset's total codes; pass an explicit classif1 and classif2 code for each breakdown the dataset has — ilostat_list_reference topic classifications lists them.` |
| `invalid_period` | ValidationError | `period` of a frequency other than the dataset's (a malformed period fails the schema pattern first) | `Use YYYY, YYYYQn, or YYYYMmm matching the dataset frequency for period, or omit it to compare each area's latest value.` |
| `dataset_retired` | NotFound | as in `ilostat_query_indicator` (`thrownBy: 'service'`) | same text |
| `upstream_busy` | RateLimited, retryable | as in `ilostat_query_indicator` | same text |
| `catalog_unavailable` | ServiceUnavailable | see Shared conventions | see Shared conventions |

**format():** dataset and slice header, mode line, a markdown table `rank | area | value | period | basis | status | source | notes | change` (cells escaped), the status-flag and note legend (`code — label`, flattened), the `missing` list, the comparability line, the dataframe pointer when staged, attribution.

### `ilostat_list_reference`

**Description:** Decode ILOSTAT's code vocabulary: reference areas (ISO3 countries and X-coded aggregates, with World Bank income group and ILO region), the groups that area_group accepts (X01 for every country, ILO regions and subregions, World Bank income groups; exact-code lookups list their member countries), databases, subjects, sex codes, breakdown codes for classif1/classif2 with their classification types, per-country data sources, observation status flags, note codes, and frequencies. Filter by text or look up exact codes; long topics page with a cursor.

| Param | Type | Notes |
|:------|:-----|:------|
| `topic` | enum `ref_areas` \| `area_groups` \| `databases` \| `subjects` \| `sexes` \| `classifications` \| `classification_types` \| `sources` \| `obs_status` \| `notes` \| `frequencies`, required | |
| `filter` | string, optional | Every token must match a word or word prefix of the code or label (normalized as in search). A filter with no letter or digit is not applied, and `notice` says so. |
| `codes` | string[] ≤100, optional | Exact lookup (uppercased); misses listed in `not_found`. With `area_groups`, each group found also carries `members`. |
| `ref_area` | string, optional | `sources` only: that area's sources. Validated. |
| `classification_type` | string, optional | `classifications` only: code prefix (`AGE`, `ECO`, …). |
| `limit` | int 1–500, default 50 | |
| `cursor` | string, optional | |

**Topics:** `ref_areas` (327: code, label, kind, frequencies, data_start/data_end, `dataset_count` — datasets with data for the area, summed over frequencies — income group, ILO region/subregions, each group as its X code plus label), `area_groups` (`X01` as the `world` group — every country the ToC lists — then regions, subregions, and income groups, each with `member_count` and `group_types` — one code can serve several levels: X36 Arab States is region, broad and detailed subregion; an exact `codes` lookup adds `members`, each member country's code and label, while a listing without `codes` keeps `member_count` alone so the full topic stays small), `databases` (17 with dataset counts; `ILOSECTOR` is in the ToC but not the database dictionary, so its label comes from the ToC), `subjects` (28, with dataset counts), `sexes` (4), `classifications` (classif1 ∪ classif2, each with `slot` = `classif1` \| `classif2` \| `both` and `classification_type`), `classification_types` (47 from the dictionary, plus the ToC-only `QTL`, labelled `No label published in the ILOSTAT dictionary`, so every code `breakdown` accepts is listed), `sources` (3,767; each source code belongs to one area; `source_type` = the label prefix before ` - `, e.g. `LFS`, `PC`, `ADM`, `ILO`, `OE`), `obs_status` (A, B, I, M, R, U; the dictionary's empty row for the blank status is skipped), `notes` (note_source/note_indicator/note_classif codes with `note_type`), `frequencies` (A/Q/M with dataset counts).

**Output:** `topic`, `entries[]` (flat object: `code, label` plus the topic's optional fields above; ordered by code, except `sexes`, which keep the dictionary's order with `SEX_T` first, and `frequencies`, listed A, Q, M), `total` (after filtering), `next_cursor?`, `not_found?`, `catalog_as_of`. Truncation via `ctx.enrich.truncated`.

**Zero-hit notice** — names the step that removed the last entries, applied in the order `ref_area`, `classification_type`, `codes`, `filter`:

| Step | Notice |
|:-----|:-------|
| `ref_area` on `sources` | `{ref_area} has no sources in the dictionary.` |
| `classification_type` | `No classification code has type {classification_type}; ilostat_list_reference topic classification_types lists the types.` |
| `codes` | none — `not_found` lists the misses |
| `filter` | `No {topic} entry matched "{filter}". Every filter term must appear in the code or label; try one distinctive word, or omit filter to page the full list.` |

A filter with no letter or digit puts `filter held no searchable word (letters or digits), so it was not applied.` ahead of any other notice; on a paged result the notice precedes the paging line, as in search. Echoed `classification_type` and `filter` text is CR/LF-flattened.

**Errors**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `unknown_code` | ValidationError | `ref_area` is not a reference area | `Call ilostat_list_reference with topic ref_areas and a name filter to find the area code.` |
| `param_not_for_topic` | ValidationError | `ref_area` with a topic other than `sources`, or `classification_type` with a topic other than `classifications` — a scoping parameter the topic cannot apply | `Pass ref_area only with topic sources and classification_type only with topic classifications, or drop it.` |
| `invalid_cursor` | InvalidParams | `cursor` does not decode (as in `ilostat_search_indicators`, checked before the catalog wait; `thrownBy: 'service'`) | `Omit cursor to start from the first page, or pass next_cursor from the previous response unchanged.` |
| `catalog_unavailable` | ServiceUnavailable | see Shared conventions | see Shared conventions |

**format():** `code — label` lines with the topic's extra fields inline (flattened), an indented `members:` line (`code label`, comma-separated) under an area group that carries them, `not_found`, `next_cursor`.

### `ilostat_dataframe_query`

**Description:** Run a single-statement SELECT against the df_<id> dataframes staged by ilostat_query_indicator and ilostat_compare_geographies or stored by an earlier register_as. Inspect a dataframe with ilostat_dataframe_describe first; its column schema is what the SQL has to match. Read-only: writes, DDL, DROP, COPY, PRAGMA, ATTACH, and file-reading table functions are rejected, and system catalogs (information_schema, pg_catalog, sqlite_master, duckdb_*) are denied. Breakdown versions overlap (AGE_YTHADULT_*, AGE_AGGREGATE_*, AGE_10YRBANDS_*), so filter to one version before summing. Optional register_as stores the result as a new dataframe with a fresh TTL.

| Param | Type | Notes |
|:------|:-----|:------|
| `sql` | string, required, 1–20,000 characters after trimming | Single SELECT over `df_<id>` tables. BIGINT results (COUNT/SUM of integers) serialize as strings; CAST to DOUBLE for inline arithmetic. Longer SQL fails at the schema (decision 64). |
| `register_as` | string, optional | Dataframe-name normalization (the `df_` fold), then must match `^df_[A-Z0-9]{5}_[A-Z0-9]{5}$`; blank = unset. |
| `preview` | int 0–10000, optional | Rows returned inline; defaults to the row limit. |
| `row_limit` | int 1–10000, default 1000 | Hard cap on materialized rows. |

**Output:** `columns[]`, `row_count` (with `register_as`, the exact row count of the stored dataframe, which `row_limit` does not bound; otherwise at most `row_limit`), `row_count_capped` (never true with `register_as`), `rows[]`, `registered_as?`, `expires_at?`. Enrichment: `notice`, `truncated`, `shown`, `cap` — zero rows (`Query returned 0 rows. Verify dataframe names with ilostat_dataframe_describe and check the WHERE conditions.`) and the two cap disclosures: `row_limit` reached, and inline rows short of `row_count`. The second reads `Showing {n} of {total} rows. Use register_as to keep the full result, or {lever}.`, or with `register_as` `Showing {n} of {total} rows. All {total} are stored as {name}; query that dataframe with ilostat_dataframe_query, or {lever} to see more inline.` (decision 61); `{lever}` is `raise preview` when `preview` binds, else `raise row_limit (max 10,000)`.

**Errors** (framework gate reasons are rebuilt with these recovery strings; every entry `thrownBy: 'service'`, since the bridge raises all of them. A dataframe tool reached with no canvas wired fails `InternalError`: with the canvas off the tools are unlisted, so that call is a wiring bug — decision 60)

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `canvas_unavailable` | ServiceUnavailable | `The DataCanvas DuckDB engine cannot load in this deployment.` — the framework's `ConfigurationError` from the lazy import, rewrapped by the bridge; the case in the `.mcpb` bundle, which ships without the native binding. With the canvas off (`CANVAS_PROVIDER_TYPE=none`) the three dataframe tools are not listed at all (decision 47), so the contract describes only the engine failure | `Dataframes are off in this deployment; call ilostat_query_indicator or ilostat_compare_geographies with narrower filters so the result fits inline.` |
| `system_catalog_access` | ValidationError | SQL references a system catalog | `Query only df_<id> tables; ilostat_dataframe_describe lists the staged dataframes.` |
| `missing_table` | NotFound | A referenced `df_<id>` does not exist or expired (pre-checked against `ctx.state` before the gate). A `df_` name outside single-quoted string literals is matched in any case and folded to the minted form first, so `DF_…` and `df_…` resolve alike; a double-quoted identifier is a table reference like a bare name (decision 62) | `Call ilostat_dataframe_describe to list the staged dataframes, or re-run the producing tool to stage the data again.` |
| `invalid_sql` | ValidationError | The SELECT fails to prepare (unknown column, bad expression) | `Check column names and syntax against the schema ilostat_dataframe_describe reports.` |
| `sql_execution_error` | ValidationError | The SELECT prepared but failed on the data | `Wrap the failing cast in TRY_CAST, or filter out the rows the error message names before converting them.` |
| `register_as_clash` | ValidationError | `register_as` names an existing dataframe | Resolved from config at the throw site: with drop enabled, `Drop the existing dataframe with ilostat_dataframe_drop, choose another df_XXXXX_XXXXX name, or omit register_as.`; otherwise `Choose another df_XXXXX_XXXXX name or omit register_as.` — the contract's static text, since it names no gated tool |
| `non_select_statement` | ValidationError | Not a SELECT | `Send only a SELECT statement against df_<id> tables; ilostat_dataframe_describe lists them.` |
| `multi_statement` | ValidationError | More than one statement | `Send exactly one SELECT statement per call and split multi-statement SQL into separate calls.` |
| `denied_function` | ValidationError | A file-reading or external table function | `Remove the file-reading function and query only the df_<id> tables ilostat_dataframe_describe lists.` |
| `plan_operator_not_allowed` | ValidationError | A plan operator outside the read-only allowlist (e.g. `range()`) | `Rewrite with read-only SELECT constructs — joins, aggregates, window functions, CTEs, and unnest() are supported.` |

**format():** registered line when set, a row-count header that says when `row_limit` capped the result, then a markdown table (cells escaped: `\` then `|`, line breaks → `<br>`). With no rows inline, the column names follow `_No rows._` when the result is empty, or `_No rows shown inline._` when `preview` 0 withheld them.

### `ilostat_dataframe_describe`

**Description:** List the df_<id> dataframes staged by ilostat_query_indicator and ilostat_compare_geographies or stored by ilostat_dataframe_query register_as, with the tool and parameters that produced each, the datasets it holds (label, unit, last update), coverage, basis counts, attribution, creation and expiry times, row count, and column schema. Read the schema here before writing SQL for ilostat_dataframe_query.

| Param | Type | Notes |
|:------|:-----|:------|
| `name` | string, optional | One `df_<id>`; dataframe-name normalization (trim, the `df_` fold), then must match `^df_[A-Z0-9]{5}_[A-Z0-9]{5}$` (the form the canvas mints); blank = list all. |

**Output:** `dataframes[]` — `name, source_tool, query_params, created_at, expires_at, row_count, datasets[] {dataset_id, label, unit?, last_update}, coverage? {ref_areas, period_min?, period_max?}, basis_counts?, attribution, column_schema[] {name, type, nullable}` (`query_params` holds the producer's `applied_filters`, or `{sql, derived_from}` for a `register_as` dataframe; coverage and basis counts absent on a dataframe derived by SQL); newest first; empty when none. A record whose table is no longer on the canvas is never listed: describe deletes it, whether it was asked for by `name` or met in the full list. A `name` that matches nothing returns an empty list with the notice `No staged dataframe is named {name}; call ilostat_dataframe_describe without name to list them, or re-run the producing tool.` Errors: `canvas_unavailable` (as above) — describe acquires the tenant's canvas first, so an engine that cannot load fails here rather than listing nothing. **format():** one `### df_…` block per dataframe, with the labels, unit, update time, period range, and column names flattened (a `register_as` column name is the caller's SQL alias; column types are the framework's closed set) and the area count singular for one area.

### `ilostat_dataframe_drop`

**Description:** Drop a staged df_<id> dataframe by name before its TTL expires: once an analysis with it is finished, to free the table, or to reuse its name as an ilostat_dataframe_query register_as target. Idempotent: dropped is false when nothing matched.

| Param | Type | Notes |
|:------|:-----|:------|
| `name` | string, required | `df_<id>`; dataframe-name normalization (trim, the `df_` fold), then must match `^df_[A-Z0-9]{5}_[A-Z0-9]{5}$` |

**Output:** `name`, `dropped`. Errors: `canvas_unavailable`; a table drop that fails on the canvas fails the call with the engine's error and leaves the provenance recorded, so the dataframe is still listed (decision 63). Annotations: `readOnlyHint: false, idempotentHint: true, openWorldHint: false` (destructive by default — it removes staged state, recoverable by re-running the producer). Off by default: registered through `disabledTool()` (reason `Dropping dataframes is turned off in this deployment; staged tables expire on their own TTL.`, hint `ILOSTAT_DATAFRAME_DROP_ENABLED=true`), so it stays visible on the landing page but absent from `tools/list`. With the canvas off it is disabled like query and describe, whatever the flag says (reason `Dataframes are turned off in this deployment.`, hint `CANVAS_PROVIDER_TYPE=duckdb`). Nothing else routes to it unless the flag is on.

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `RplumberClient` | `rplumber.ilo.org`: ToCs, dictionaries, `/data/indicator` (CSV stream), `/data/ref_area` (JSON). Owns the rplumber pacer, retry, the parameter allowlist, HTML/challenge detection, and 400 mapping. | CatalogService, ObservationService, ProfileService |
| `SdmxClient` | `sdmx.ilo.org/rest`: dataflow structure (`references=all&detail=referencepartial`, SDMX-JSON) and the one-observation unit probe (SDMX-CSV). Owns the SDMX pacer. | StructureService |
| `CatalogService` | In-memory snapshot: both ToCs, 13 dictionaries, derived indexes (search index, code sets, area groups, dataset → projection cutoff). Load, refresh, readiness, validation, decoding. | every non-dataframe tool |
| `StructureService` | Per-indicator SDMX structure + unit, cached (LRU 500 entries, keyed by indicator and its ToC `last.update`, 24 h ceiling). Single-flight per indicator. | describe, query (unit), compare (default slice, covered areas, unit) |
| `ObservationService` | Builds allowlisted requests, validates codes and periods, preflights size, streams and classifies rows, accumulates summaries, holds the response cache. | query, compare |
| `ProfileService` | Headline table, the two `/data/ref_area` calls, local slicing. | profile |
| `basis` (pure functions) | `parseEdition(label)`, `latestCatalogEdition(labels)`, `projectionCutoff(dataset, catalogEdition, currentYear)`, `classifyRow(row, cutoff)`. | ObservationService, ProfileService, compare |
| `CanvasBridge` | DataCanvas adapter: shared per-tenant canvas, `df_` naming, provenance in `ctx.state`, spill/register/query/describe/drop, gate-error rewrap. | query, compare, dataframe trio |

### Catalog lifecycle

- **Cold start.** `setup()` constructs the services and calls `catalog.start()`, which begins loading without blocking startup and arms the refresh timer (`unref()`'d). Load = both ToCs + 13 dictionaries (15 requests, ~0.25 MB gzip on the wire, ~3.8 MB parsed; about 10 s through the pacer). Tools `await catalog.ready()` — a single-flight promise, so the first call after boot may wait for the load; concurrent callers share it. A tool waits at most 30 s (`readyTimeoutMs`): past that it fails `catalog_unavailable` while the load continues in the background, so a load held up by a pacer cooldown never outlasts a client's request timeout.
- **Failed initial load.** `ready()` rejects with `catalog_unavailable`; the next call starts a fresh attempt, at most one attempt per 15 s.
- **Refresh.** Every `ILOSTAT_CATALOG_REFRESH_HOURS`: re-fetch both ToCs (2 requests). When the dataset set or any `last.update` changed, re-fetch the dictionaries too, then swap the snapshot atomically. Upstream offers no ETag or Last-Modified, so the ToC's own `last.update` column is the change signal.
- **Failed refresh.** The previous snapshot keeps serving (it is still valid published metadata); the failure is logged at warning, and `catalog_as_of` on every output shows its age. A refresh that finds nothing changed re-stamps `catalog_as_of`, since the snapshot was just confirmed current.
- **Invalidation.** StructureService entries key on the ToC `last.update`, so a dataset update evicts its structure/unit on the next lookup.
- `teardown()` clears the refresh timer and disposes both pacers.

### Resilience and pacing

| Concern | Decision |
|:--------|:---------|
| Fetch boundary | Plain `fetch` (injectable) in both clients, not `fetchWithTimeout`: streaming bodies, and some non-2xx statuses are results. Accept-lists: SDMX structure `{200, 404}` (404 = no dataflow → `structure_status: 'unavailable'`); SDMX data probe `{200, 404}` (404 = no data for that area → try the next); rplumber `{200}`. Everything else goes through `httpErrorFromResponse` or the mappings below. Every request sends `Accept-Language: en`: Node's fetch sends `Accept-Language: *` by default, which the SDMX host answers with HTTP 500 (`languageTag1`). |
| rplumber 400 | Body `{"error":"deprecated or invalid dataset id=…"}` → `dataset_retired` (NotFound). |
| SDMX 500 `ORA-…` | Unknown key member; treated as "no data for this key" (next area, else unit unresolved). The Oracle text is never relayed. SDMX 422 (key arity) is a server bug → `InternalError`. |
| HTML where data is expected | `content-type: text/html` or a `cf-mitigated: challenge` header → `upstream_busy` (RateLimited, retryable) and a pacer cooldown. Data and metadata legitimately arrive as `application/octet-stream` (JSON and CSV alike), so parsing keys on the requested format, never on the content type. The 429/challenge check runs inside the pacer task: the pacer closes its cooldown gate only when the task itself throws `RateLimited`. |
| Timeouts | Per attempt: 30 s to response headers; a data stream additionally fails when no bytes arrive for 30 s. Composed via `AbortSignal.any` with `ctx.signal`. |
| Retry | `withRetry` around request + headers (+ full parse for non-streamed JSON), `maxRetries: 2`, `baseDelayMs: 1000`, `deadlineMs: 45_000`, `attempt.signal` threaded into the fetch. `isTransient: (e) => !isUpstreamBusy(e) && defaultIsTransient(e)` — an upstream 429 or challenge is not retried in-call, so a throttling upstream is never re-hit from a shared IP; the pacer cooldown handles the wait. A streamed request is retried only up to its response headers; a stream that fails after that is not retried: the call fails — `Timeout` on a stall, `ServiceUnavailable` on a dropped connection — and any partial table is dropped. The body is locked the moment the headers arrive (see Verified upstream behavior). |
| Pacing | One `createPacer` per host, retry outside, pacer inside. rplumber: `limits: [{ requests: 60, perMs: 60_000 }]`, `maxConcurrent: 2`, `minStartGapMs: 500`, `cooldown { baseMs: 60_000, maxMs: 600_000 }`. SDMX: `limits: [{ requests: 20, perMs: 60_000 }]`, `maxConcurrent: 1`, `minStartGapMs: 1_000`, same cooldown. Tool-initiated calls pass `maxWaitMs: 15_000`; the catalog loader waits without a cap. A pacer shed (`pacer_shed`) is rewrapped as `upstream_busy` with its `retryAfter`. The reported `retryAfter` is never below 1 s; after a 429 or challenge it is `max(Retry-After, ⌈min(baseMs · 2^(n−1), maxMs) / 1000⌉)` for the n-th busy answer in a row, the gate the pacer closes for it. `UpstreamHttp` keeps n itself (`consecutiveBusy`, reset when a paced request succeeds), since the pacer exposes neither its gate nor its count. Basis in Design Decisions. |
| Response cache | Upstream data responses of ≤ 5,000 rows, keyed by the canonical request URL, TTL `ILOSTAT_CACHE_TTL_SECONDS`, LRU 256 entries, process-wide (public data). Serves profile, compare, and small queries. Larger results are never cached — the caller holds the staged dataframe. |

**When the shared budget runs out** (hosted): a call whose pacer wait would exceed 15 s, or that meets an upstream 429 or challenge page, fails fast with `upstream_busy` — `RateLimited`, `retryable: true`, `data.retryAfter` in seconds (never below 1 s, and after a 429 or challenge never shorter than the cooldown it starts) — and the pacer holds further upstream calls for the cooldown (60 s doubling to 10 min, reset by the first success). Meanwhile `ilostat_search_indicators`, `ilostat_list_reference`, cached describes, cached small queries, and the dataframe tools keep answering. The budget is per process: a hosted deployment runs one replica per egress IP, since N replicas behind one address would present N times the budget.

## Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `ILOSTAT_CATALOG_REFRESH_HOURS` | no | `6` | Hours between table-of-contents checks (1–168). |
| `ILOSTAT_MAX_ROWS` | no | `500000` | Ceiling on rows one query may return or stage (1,000–2,000,000). |
| `ILOSTAT_PREVIEW_CHARS` | no | `40000` | Inline preview budget in serialized characters (≈10k tokens), passed to `spillover()` as `previewChars` (≥ 1,000). |
| `ILOSTAT_CACHE_TTL_SECONDS` | no | `900` | TTL of the upstream response cache (≥ 0; 0 disables). |
| `ILOSTAT_DATASET_TTL_SECONDS` | no | `86400` | Per-table TTL for staged dataframes (≥ 60). |
| `ILOSTAT_DATAFRAME_DROP_ENABLED` | no | `false` | `z.stringbool()`. Exposes `ilostat_dataframe_drop`. |
| `CANVAS_PROVIDER_TYPE` | no | `duckdb` (set in `src/index.ts` when unset) | Framework var; `none` turns dataframes off. |
| `MCP_TRANSPORT_TYPE`, `MCP_HTTP_PORT`, `MCP_HTTP_HOST`, `MCP_SESSION_MODE`, `MCP_LOG_LEVEL`, … | no | framework defaults | Framework transport/logging config. |

All server vars parse through `parseEnvConfig` in `src/config/server-config.ts`; every one goes into both `server.json` `environmentVariables[]` and `manifest.json` (`mcp_config.env` + `user_config`), and the plugin manifests. `CANVAS_PROVIDER_TYPE` is advertised in `server.json` and forwarded by the Codex plugin, but not offered in the `.mcpb` bundle, which ships without the DuckDB binding. No credentials exist.

## Server Setup

```ts
try { process.loadEnvFile(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
process.env.CANVAS_PROVIDER_TYPE ||= 'duckdb';
const canvasEnabled = process.env.CANVAS_PROVIDER_TYPE !== 'none';
const { dataframeDropEnabled } = getServerConfig();

await createApp({
  name: 'ilostat-mcp-server',
  title: 'ilostat-mcp-server',
  tools: buildToolDefinitions({ canvasEnabled, dropEnabled: dataframeDropEnabled }),
  resources: [],
  prompts: [],
  sessionMode: 'stateless',
  instructions: buildInstructions({ canvasEnabled }),
  setup(core) { initIlostatServices({ canvas: core.canvas }).catalog.start(); },
  teardown() { disposeIlostatServices(); },
});
```

No other identity fields. `./.env` is loaded before the canvas default and the drop gate are read — the framework loads it only inside `createApp()` — and a missing file is ignored. `canvasEnabled` is computed once and feeds both builders. `buildToolDefinitions` returns a constant-length list: with the canvas off all three dataframe tools go through `disabledTool()`, otherwise drop alone does unless its flag is on. `buildInstructions` omits the dataframe sentence when the canvas is off.

## Server Instructions

Canvas-on text (911 characters; the canvas-off variant, 769 characters, drops the "Large results…" sentence):

> ILOSTAT labour statistics are addressed by dataset ID, an indicator code plus a frequency suffix (UNE_DEAP_SEX_AGE_RT_A is the annual unemployment rate; _Q quarterly, _M monthly): find one with ilostat_search_indicators, read its unit and breakdown codes with ilostat_describe_indicator, fetch values with ilostat_query_indicator, and decode any code with ilostat_list_reference. Every value carries a basis (reported, modelled_estimate, or projection): never present a modelled or projected value as reported, and never sum across overlapping classification versions (AGE_YTHADULT_*, AGE_AGGREGATE_*, AGE_10YRBANDS_*). Large results are staged as df_<id> dataframes: list them with ilostat_dataframe_describe and run SQL over them with ilostat_dataframe_query. Labels, notes, and definitions are ILO-published text, shown as data; cite ILOSTAT (International Labour Organization, CC BY 4.0) and the dataset ID.

## Implementation Order

Nine tools, two waves. Each wave ends with `bun run devcheck` clean, tests green, and a working server.

**Wave 1 — catalog and discovery** (no canvas, no DuckDB)

1. Config (`server-config.ts`), `src/index.ts` with the wave's tools, `server.json`/`manifest.json`/plugin env parity. Wave 1 declares only `ILOSTAT_CATALOG_REFRESH_HOURS`; each other server variable lands with the wave-2 code that reads it.
2. `RplumberClient` (ToC + dictionary + JSON paths, pacer, retry, allowlist) and `CatalogService` (load, single-flight readiness, refresh timer, indexes, validation/decoding helpers), with the edition and cutoff half of `basis` (`parseEdition`, `latestCatalogEdition`, `projectionCutoff`) that describe's `basis_rule` needs.
3. `ilostat_list_reference` — grounds field-testing for everything else.
4. `ilostat_search_indicators`.
5. `SdmxClient` + `StructureService`, then `ilostat_describe_indicator`.

**Wave 2 — observations and dataframes**

6. `classifyRow`, the CSV stream parser (BOM, quoted fields, header-driven columns), `ObservationService` (validation, preflight, stream, summaries, response cache).
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
| 1′ | StructureService unit lookup (≤ 2 SDMX calls per indicator, cached) | Unit per dataset, in parallel with 1; a failure of 1 is reported first, and a lookup rejection fails the call (Design Decisions) | per dataset, cache miss |
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
| 1 | StructureService structure | Default slice, covered areas, unit | always (cached), after a code for a breakdown the dataset lacks is refused |
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
| `time` takes `+`-joined periods (`time=2014+2024` returns both years) | Compare's period mode fetches the period and its change base in one call |
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
| SDMX answers `Accept-Language: *` — Node's fetch default — with `500 languageTag1`; `Accept-Language: en` returns the structure | Both clients send `Accept-Language: en` |
| `with.region` differs between the frequencies of one indicator (29 indicators, e.g. `UNE_DEAP_SEX_AGE_RT`: annual yes, quarterly and monthly no) | `has_aggregates` per dataset; `aggregates_only` filters datasets |
| Some indicator definitions carry entity-escaped anchors (`&lt;a href = "…"&gt;…&lt;/a&gt;`) | `&lt;`/`&gt;` decoded before tags are stripped |
| The `obs_status` dictionary includes an empty `{}` row (the blank status); the ToC's `QTL` classification has an empty `classif.labels` | Dictionary rows without a code are skipped; ToC-only classification types are listed with a no-label marker |
| Node's fetch cancels an unread response body once its `Response` object is garbage-collected, and the cancelled body then reads as empty — `200`, zero bytes, no error. It struck the first data call on a freshly started server, where a collection lands while the stream waits for the unit lookup | The streamed body is locked the moment its headers arrive |

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
15. **Inline rows carry codes plus a legend; staged rows carry codes and labels.** A legend keeps the inline preview compact without losing decoding; SQL users need labels in-table to filter and group. Compare rows, one per area, carry the area and source labels inline and decode status flags and note codes through the same kind of legend.
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
28. **`has_aggregates` is per dataset, and `aggregates_only` filters datasets.** `with.region` differs between frequencies of one indicator for 29 indicators (the annual unemployment rate carries aggregates, its quarterly and monthly variants do not), so an indicator-level flag would send a caller to a frequency without aggregate rows. Hit- and describe-level flags summarize the listed or requested datasets.
29. **Describe lists every frequency variant, whichever code it was given.** The description promises frequency variants and coverage; a dataset ID additionally echoes as `dataset_id` and sets `has_aggregates` for that dataset, since the variants differ.
30. **Every upstream request sends `Accept-Language: en`.** Node's fetch defaults to `Accept-Language: *`, which the SDMX host rejects with HTTP 500, so describe's structure would otherwise fail under `node dist/index.js` while working under Bun.
31. **ToC-only classification types are listed with an explicit no-label marker.** `breakdown` accepts `QTL`, which the classification-type dictionary lacks and the ToC leaves unlabelled; listing it keeps every accepted code discoverable without inventing a label.
32. **Shared request validation raises through the calling tool's `ctx.fail`.** Query and compare validate the same inputs, so the checks live once in `ObservationService`, which receives the handler context and fails with that tool's own contract — code, reason, and recovery stay the tool's, with no catch-and-rethrow. The entries it raises carry `thrownBy: 'service'`, since the lint reads only the handler body.
33. **`truncated`/`shown`/`cap` are always written on query and compare, and `cap` counts characters.** The inline preview is cut by a character budget, not a row count, so the only honest cap is that budget; writing `truncated: false` on every path keeps the enrichment fields required and the zero-row and staged pages valid.
34. **The streamed body is locked as soon as the headers arrive.** Query opens the data stream in parallel with the SDMX unit lookup and reads it only once units resolve; an unlocked body in that gap is cancelled by Node's fetch when its `Response` is collected, which read as a silent zero-row result on cold starts.
35. **A `register_as` dataframe inherits its parents' datasets and records its SQL.** The derived rows' coverage and basis counts cannot be known without re-reading them, so they are left absent rather than copied from the parents; the SQL and the `derived_from` names say where the table came from.
36. **Compare's period mode sends both periods in one `time` value.** Upstream accepts `+`-joined periods, so the change base costs no second request, and the result stays one cacheable response.
37. **Some fields are left out of outputs on purpose, each carried elsewhere.** Query's inline rows omit `ref_area_kind`, `year`/`subperiod`, `unit`/`unit_multiplier`, and the indicator label (the period string, `datasets[]`, the staged table, and `ilostat_list_reference` carry them); compare's rows omit `dataset_id` and the unit (both in `dataset`) and `year`/`subperiod` (in the period). Search omits `n_records_all`, the measure, and the definition, which describe returns; the profile's area omits the detailed subregion, frequencies, and coverage, which `ilostat_list_reference` returns; and describe shows the catalog's `last_update`, not the SDMX `LAST_UPDATE` annotation, so every tool reports one update time from one source.
38. **`ilostat_list_reference` documents its two non-code orders instead of re-sorting them.** Sexes keep the dictionary's order with `SEX_T` first, the total that profile and compare default to, and frequencies run annual, quarterly, monthly, as describe lists frequency variants; a code sort would lead with `SEX_F` and put M before Q. The `entries` describe names both exceptions.
39. **Declared errors a caller's input causes log at `notice`.** An unknown code or a refused oversized request is a modelled answer, not an incident, and logging it at `error` would bury the upstream and engine failures alerting has to see. `dataset_retired` logs at `warning`, since it means the catalog lags upstream; the wire envelope is the same at every level.
40. **Dataset IDs, area codes, and sex codes are checked by schema pattern; other codes by dictionary alone.** These three have one fixed shape across the catalog, so the pattern or enum reaches the client's `inputSchema` and a malformed value fails before any lookup, as periods do (decision 27); breakdown and source codes vary in shape (`AGE_YTHADULT_Y15-24`, `BA:453`, `DCL_DECILE_01`), so a pattern would add nothing the dictionary check does not. The normalizations run in the schema preprocess, so every documented form still passes.
41. **Dataframe names fold to the minted form, then are checked against it.** SQL reads `df_` names case-insensitively, so a name copied from a query can arrive in any case; describe, drop, and `register_as` trim it, match `df_` in any case, and uppercase the rest — a one-to-one mapping onto the only form the canvas mints — before `^df_[A-Z0-9]{5}_[A-Z0-9]{5}$` runs. Provenance is looked up by exact name, so a name that is still not a minted shape after the fold can only miss; the schema says why instead of answering "not found". The advertised pattern stays the minted form, as for area codes (decision 40). The same fold applies to `df_` names read from `ilostat_dataframe_query`'s SQL, so `FROM DF_…` passes the `missing_table` check and a `register_as` built from it inherits its source's datasets, instead of the name falling through to DuckDB's own error.
42. **`canvas_unavailable` recovers through a tool, not operator config.** The calling agent cannot set `CANVAS_PROVIDER_TYPE` or install DuckDB; it can re-run query or compare with narrower filters so the result fits inline. All three dataframe tools carry the same text.
43. **Server instructions carry only what no single tool definition does.** They keep the ID shape and the search → describe → query path, the code decoder, the basis and classification-overlap rules, the dataframe pointer (dropped when the canvas is off), and the ILO-text and citation line; per-tool summaries, code formats, and retry behavior already live in the tool descriptions, input schemas, and error recoveries.
44. **`X01` is an area group: every country the reference-area ToC lists.** It puts every country in reach of query and compare in one argument. Aggregates are left out so a sum over members never double-counts, and dictionary-only areas are left out because no ToC row gives them coverage. `area_group` is a filter, so the no-filter preflight never refuses `X01`; a dataset too large for the row ceiling fails `result_too_large` while streaming, whose recovery says how to narrow.
45. **A paged search carries its service notice inside the truncation guidance.** The framework keeps one notice, and `enrich.truncated` writes its guidance into it, so the no-searchable-word explanation is prefixed to the paging line instead of being set separately and overwritten.
46. **Area-group members are listed only on an exact `codes` lookup.** The `area_groups` listing keeps `member_count` alone so the whole topic stays one small page (`X01` alone has every country); a caller who needs a group's countries names the group and gets each member's code and label.
47. **With the canvas off, the dataframe tools are unlisted through `disabledTool()`.** A listed tool that can only fail `canvas_unavailable` costs the caller a wasted call; `disabledTool()` keeps the three out of `tools/list` while the registration list stays nine long and the landing page shows operators the `CANVAS_PROVIDER_TYPE=duckdb` hint. The framework publishes each contract's `when` in the tool's output schema, so `canvas_unavailable` describes only the engine failure that can still reach a listed tool.
48. **A re-minted canvas clears its provenance, and describe prunes records whose table is gone.** A new canvas starts empty, so records from the old one made `register_as` clash with a table that no longer existed and `ilostat_dataframe_drop` report `dropped: true` for nothing; clearing `df-meta/` at the mint removes both. Describe deletes a record whose table has left a live canvas instead of listing a dataframe SQL cannot read.
49. **The reported busy wait is at least 1 s and at least the cooldown the pacer is about to apply.** A pacer shed while every slot is in flight carries `retryAfter: 0`, and "retry in about 0 s" invites a retry that sheds again. A bare `Retry-After` or the first cooldown would undercount from the second 429 in a row, since the pacer doubles its gate each time. The pacer exposes neither its gate nor its count, so `UpstreamHttp` keeps its own count; the pacer honours the reported value when it closes its gate, so the gate never outlasts the wait the caller was given.
50. **A cursor is decoded before the catalog wait.** The cursor carries only an offset, so decoding it needs no catalog; checked after the wait, a malformed cursor sent during a catalog outage came back `catalog_unavailable`, and the caller's retry a minute later met the real error. Paging therefore splits into decoding (`cursorOffset`) and slicing (`pageOf`), and search and list pass the offset to the service.
51. **`ilostat_list_reference` names the step that emptied the listing, and says when a filter was not applied.** The notice used to test the filter before `classification_type`, so a type that matched nothing was reported as a filter miss whenever a filter was also set, and so was a `codes` lookup that found nothing, whose misses `not_found` already lists. A filter with no letter or digit matched every entry without saying so; it now carries the same kind of notice as search's query (decision 45 covers the paged case).
52. **Describe marks a total code `is_total: true` in `content[]`.** The text uses the output field's own name, so a format()-only reader and a structuredContent reader see the same key.
53. **Query's period conflicts and compare's missing areas are checked before the catalog wait.** Neither needs the catalog, and checked after it they came back `catalog_unavailable` during an outage (decision 50's failure). Query's `invalid_period` therefore splits: the `time`/range/`latest_only` conflicts and a reversed range run in the handler before `ready()`, the frequency check after it. `areas_required` moved from `ObservationService` into the compare handler, so its contract entry no longer carries `thrownBy: 'service'`.
54. **Query and compare let a structure lookup's rejection fail the call.** `StructureService` already turns every SDMX outage into `unavailable` and rejects only for this server's own fault (an SDMX 422 on the probe key), the caller's cancellation, or shutdown. Swallowing those turned the fault into a success without a unit in query and a caller-input `invalid_slice` in compare, while describe failed `InternalError` on the same fault. Query still overlaps the lookup with the row request and reports a failure of the rows first, without waiting on the lookup (a busy answer is not held back behind SDMX). Compare refuses a code for a breakdown the dataset lacks before the lookup starts, then awaits the lookup, so the caller's input error wins and no lookup is left unawaited to reject.
55. **Upstream codes are flattened in `content[]` like labels.** The CSV parser keeps a quoted line break, so an area, source, breakdown, period, status, or note code can open a markdown block as readily as a label; every inline slot runs it through `inlineText` and every table cell through `tableCell`, while `structuredContent` keeps it verbatim.
56. **Query and compare name a unit the structure service could not supply.** A dataset without `unit` otherwise reads as unitless, and describe already says so for the same lookup. The sentence fires on any unresolved unit, not only an unavailable structure: a unit probe that fails transiently degrades to a complete structure without a unit, which is exactly the partial failure that went unmentioned.
57. **Compare says when it could not read the dataset's area list.** Without that list `not_covered` cannot be given, so an area the dataset never covers reads as `no_value_in_window` or `no_value_for_period`, a different claim. The notice names the gap instead of adding a fourth, speculative reason.
58. **A default slice that needs an unavailable structure fails `structure_unavailable`, not `invalid_slice`.** The caller's input was valid; the failure is upstream, and logging it at `notice` alongside caller mistakes hid SDMX outages from error-level alerting. It is `ServiceUnavailable` at `error` severity and names every breakdown left without a default, so one retry with explicit codes suffices. It sets no `retryable`: a missing dataflow is cached for up to 24 h, so the same call keeps failing, while explicit codes always work.
59. **A profile with no headline dataset left in the catalog fails `ServiceUnavailable`.** Dropping entries one by one keeps the profile useful, but with none left the modelled cutoff had no year (`Math.min()` of nothing is `Infinity`) and an empty `indicators[]` with an empty `reported_missing` would claim nothing is missing. The call fails before any upstream request and points at search and query instead.
60. **A dataframe tool with no canvas wired fails `InternalError`, and `canvas_unavailable` names only the engine failure.** With the canvas off the three tools are registered through `disabledTool()` (decision 47), so no caller can reach a handler without a bridge; the handlers' old guard answered that state with `canvas_unavailable` and "Dataframes are off", a caller-facing outage for what can only be a wiring bug. `requireCanvasBridge()` now fails it as a server fault, the bridge raises every `canvas_unavailable` (so each entry is `thrownBy: 'service'`), and its message says the DuckDB engine could not be loaded, matching the contract's `when`.
61. **A `register_as` result shorter inline than its `row_count` points at the stored dataframe.** The framework stores the whole result under `register_as` and counts it, so `row_count` is exact and can pass `row_limit`, and `row_count_capped` is never set; only the inline rows stop at `preview` (default `row_limit`). The guidance used to tell the caller to use `register_as` to keep the full result, which the call had just done, and `row_count` was described as bounded by `row_limit`. The guidance now names the stored dataframe and says to query it, and both output descriptions state the `register_as` case.
62. **A `df_` name in double quotes is a table reference.** DuckDB reads `"…"` as an identifier, not a string, so blanking it skipped the `missing_table` pre-check and left a `register_as` dataframe with an empty `derived_from` and no inherited datasets. The scan blanks only single-quoted literals, and matches double-quoted identifiers in the same pass so an apostrophe inside one (`"women's share"`) cannot open a literal that swallows a later name. A quote with a like quote after it always closes, so the pass stays linear in the SQL's length.
63. **A failed canvas drop fails `ilostat_dataframe_drop` and keeps the provenance.** Deleting the provenance first and swallowing the canvas error answered `dropped: true` while the table was still on the canvas and no longer listed. The table is dropped first with the error left to propagate, and the provenance is deleted only after, so a failure leaves the dataframe listed and retryable.
64. **`sql` is capped at 20,000 characters.** Parse cost grows with the SQL's length; the cap bounds it.

## Known Limitations

- **No projection flag upstream.** The edition rule is the best available boundary, and it is deliberately conservative: a model that calls its edition-year values estimates (the hours-worked model's 2025) has them labelled `projection`, and a dataset whose label names no edition inherits the catalog's latest ILO modelled estimates edition.
- **Latest means latest per area and indicator**, not per series: a sub-series (e.g. youth) missing in an area's latest year is absent from `latest_only` and profile results rather than taken from an earlier year.
- **Breakdown versions overlap** (`AGE_YTHADULT_*`, `AGE_AGGREGATE_*`, `AGE_10YRBANDS_*` each include 15+); summing across versions double-counts. The instructions and the dataframe-query description say so; the server does not prevent it.
- **One indicator in the catalog has no SDMX dataflow** (and SDMX may be unreachable): describe then returns no breakdown codes, unit, or default slice, and compare needs an explicit slice (`structure_unavailable` otherwise) and cannot mark a missing area `not_covered`.
- **Result ceiling.** A query returning more than `ILOSTAT_MAX_ROWS` rows (default 500,000) is refused; the largest datasets (~4.8M rows) need filters.
- **Custom aggregates are out of scope.** Upstream's `/aggregate/*` endpoints compute regional aggregates for arbitrary country groups on ~70 indicators; not exposed.
- **Freshness.** New datasets and codes appear after the next catalog refresh (default 6 h); small upstream responses are cached up to 15 min.
- **Hosted, no-auth deployments share one canvas.** Tenant `default` means every caller can list and query every staged table — acceptable for public statistics, but nothing staged is private.
- **English labels only.**
- **Restricted microdata and the ILOSTAT website** are not reachable through this server.
