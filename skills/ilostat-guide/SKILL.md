---
name: ilostat-guide
description: Gates for answering labour-market questions with the ilostat_* tools of ilostat-mcp-server — choosing reported vs ILO modelled data, finding youth, women, a sector, or a currency as a breakdown code, one classification version per sum, rates that do not add, mixed definitions, source changes and breaks in trends, and SQL over staged df_ dataframes. Use before comparing countries, building a trend, or aggregating ILOSTAT values.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

`ilostat-mcp-server` serves ILOSTAT, the International Labour Organization's labour statistics: employment, unemployment and underutilization, labour force participation, informality, NEET, earnings, working time, and labour income share, for countries and X-coded aggregates, at annual, quarterly, and monthly frequency. Keyless. Out of reach: microdata, custom aggregates for country groups ILOSTAT does not publish, and non-English labels.

## Identifiers

| Identifier | Where it comes from |
|:--|:--|
| Dataset ID for a headline measure | `ilostat_get_country_profile` names the reported and the modelled dataset behind each headline value (labour force participation: `EAP_DWAP_SEX_AGE_RT_A` and `EAP_2WAP_SEX_AGE_RT_A`); pass them to `ilostat_query_indicator` for history |
| Dataset ID for anything else | `ilostat_search_indicators`; the same measure under other breakdowns is in describe's related list |
| Breakdown code (`classif1`/`classif2`) | `ilostat_describe_indicator` for that dataset; `ilostat_list_reference` lists ILOSTAT-wide codes a given dataset may not use |
| A country's peer groups | `ilostat_list_reference` topic `ref_areas` with `codes: ["KEN"]` returns its ILO region, broad and detailed subregion, and income group as X codes (KEN → X06, X13, X18, X03), ready for `area_group` |
| Bloc aggregates | ASEAN, G20, G7, BRICS, EU27, MENA and more are aggregate reference areas (`ilostat_list_reference` topic `ref_areas`, filter by name: ASEAN is X84), not area groups |
| `df_` name | `dataframe.name` on a staged query or comparison, or your own `register_as` |

## Gates

**A population group is a breakdown code, not an indicator.** Youth, women, men, an age band, a sector, an occupation, a currency: search for the quantity ("unemployment rate", "labour force participation rate"), then take the group's code from describe — women are sex `SEX_F`; youth on `UNE_DEAP_SEX_AGE_RT_A` is classif1 `AGE_YTHADULT_Y15-24`, a band the dataset also carries under its other age versions (see the version gate below). Indicators in database YOUTHSTATS (labelled "Youth …" or "NEET …") mostly cross the age band with a further breakdown (education, school attendance, rural/urban, disability, economic activity, occupation, and more); use them only when that breakdown is asked for.

**Choose the basis before the dataset.** Headline measures come in two datasets: reported, from national sources (database LFS and others, e.g. `UNE_DEAP_SEX_AGE_RT_A`), and ILO modelled (database ILOEST, label containing "-- ILO modelled estimates", e.g. `UNE_2EAP_SEX_AGE_RT_A`).
- Ranking or comparing many countries, or a regional picture: use the ILOEST dataset, which carries nearly every country up to the same cutoff year, and say the values are ILO estimates. Latest reported values for one region can span a decade and come from a different survey in each country, and ranking them can order countries differently from the modelled series.
- A country's official figure, or what its own survey measured: use the reported dataset.
- Never fill a reported gap with a modelled value or splice the two into one series. When both are shown, label each.
- Basis is per row, not per database: X-coded rows inside reported LFS datasets are modelled, and some datasets outside ILOEST (SDG 1.1.1 working poverty) are modelled throughout. Read each row's `basis`.

**Bound projections in `ilostat_query_indicator`.** A query without `time_to` returns modelled rows past the cutoff (basis `projection`) up to the dataset's last year. Set `time_to` to describe's `basis_rule.projection_after_year`, or drop `projection` rows, unless the user asked for projections. `ilostat_compare_geographies` leaves them out unless `include_projections` is set.

**One classification version per aggregate.** Breakdown codes come in parallel versions, each with its own total, and an unfiltered query returns all of them:
- age: `AGE_YTHADULT_*`, `AGE_AGGREGATE_*`, `AGE_10YRBANDS_*`, `AGE_5YRBANDS_*` — each has a `…_YGE15` total
- economic activity: `ECO_SECTOR_*`, `ECO_AGGREGATE_*`, `ECO_ISIC4_*`, `ECO_ISIC3_*` — each has a `…_TOTAL`

Filter `classif1`/`classif2` to one version prefix (in the request, or in SQL with `LIKE 'ECO_SECTOR_%'`) before summing, counting, pivoting, or computing shares; the same rule holds for any classification type whose codes carry a version segment. Codes nest inside a version too: `ECO_SECTOR_NAG` (non-agriculture) is the total minus agriculture — industry, services, and the not-classified `ECO_SECTOR_X` — and `AGE_YTHADULT_Y15-64` contains `AGE_YTHADULT_Y15-24`. Sum only non-overlapping codes, never with their total.

**Rates do not add.** A value whose unit type is RT (a rate, in percent) cannot be summed across areas, and an unweighted mean of country rates is not the region's rate. For a regional or bloc figure use its X-coded aggregate from a dataset with `has_aggregates` true; only annual datasets carry aggregates, so this server has no quarterly or monthly regional figure. Levels (unit type NB) are published in describe's `unit.multiplier` scale and never rescaled: Kenya's reported 2021 employment of 19575.268 is in thousands, 19.6 million people.

**Keep one definition.** Reported unemployment comes under two definitions: `UNE_DEAP_*` (measure labelled "previous ILO definition - ICLS13") and the 19th ICLS series in database WORK (`UNE_5EAP_SEX_AGE_RT`, labels containing "-- 19th ICLS"). Use one across every country and year of an answer; describe's measure label says which one a dataset carries.

**Compare money in one currency.** Earnings datasets labelled "… and currency" break down by `CUR_TYPE_LCU`, `CUR_TYPE_PPP` (2021 PPP $), and `CUR_TYPE_USD`, with no total. Compare countries in PPP or USD, never in local currency; earnings datasets labelled "(local currency)" offer no other currency.

**A trend is one source with no break.** Under the default best-source selection, a reported series can switch surveys between years (Kenya's youth rate: a household budget survey in 2016, a continuous household survey in 2019 and 2021). Before calling a movement a trend, check every row's `source`, and treat `obs_status` B or an `I11` note (break in series) as a seam. `ilostat_compare_geographies` flags source changes and breaks on each `change`; query rows leave the check to you. Notes can also change what a value covers: Mauritius's "15–24" youth rate carries a note setting its minimum age at 16.

## Core chain

For a region or a country's peers: `ilostat_list_reference` (`ref_areas`, the country's code) → its subregion or income-group X code → `ilostat_compare_geographies` with that code as `area_group`, plus the same code in `ref_areas` for the group's own aggregate row (only on a dataset with aggregates) → `ilostat_query_indicator` for the history of the areas that matter.

For a bloc: list its member ISO3 codes in `ref_areas` yourself (area groups cover only X01, ILO regions and subregions, and World Bank income groups), and add the bloc's aggregate code (ASEAN X84) for its own value. An ILO subregion is not the bloc: South-Eastern Asia (X54) and ASEAN (X84) are separate aggregates.

## Workflows

**Country snapshot.** `ilostat_get_country_profile` first; it pairs each headline's latest reported and modelled values with their periods. Go to query only for history or a breakdown the profile does not carry.

**Cross-country table.** Pick the basis (gates above), describe the dataset for its slice codes and unit, then `ilostat_compare_geographies`. Report each value's period when `comparability.mixed_periods` is true, and keep the `missing` areas in the answer rather than dropping them silently.

**Breakdown analysis in SQL.** Results too large to return inline are staged as a `df_XXXXX_XXXXX` dataframe, named in the response's `dataframe.name`. Call `ilostat_dataframe_describe` with that name for the column schema before writing SQL, then `ilostat_dataframe_query` with one read-only SELECT. On the hosted instance every caller shares one canvas and listing is off, so keep each name you are given; dataframes expire with their TTL. In the SQL, filter to one classification version, keep `basis` and `source` in the projection, and carry `unit` and `unit_multiplier` into any derived table you store with `register_as`.
