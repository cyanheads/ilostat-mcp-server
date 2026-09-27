<div align="center">
  <h1>@cyanheads/ilostat-mcp-server</h1>
  <p><b>Search ILOSTAT labour indicators, query and compare series, build country profiles, run SQL via MCP. STDIO or Streamable HTTP.</b>
  <div>9 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/ilostat-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/ilostat-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/ilostat-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/ilostat-mcp-server/releases/latest/download/ilostat-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=ilostat-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvaWxvc3RhdC1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22ilostat-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Filostat-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Labour statistics from [ILOSTAT](https://ilostat.ilo.org), the International Labour Organization's statistical database, read from two keyless ILO APIs: the [ILOSTAT data API](https://rplumber.ilo.org/__docs__/) (`rplumber.ilo.org`) and the [ILO SDMX API](https://sdmx.ilo.org/) (`sdmx.ilo.org`). Find an indicator, read its unit and breakdown codes, pull observations for countries, regions, and income groups, compare areas, and build a headline labour-market profile. Every value is marked as reported, modelled estimate, or projection. Large results stage as dataframes you query with SQL. Runs as a stdio process or a local Streamable HTTP server.

### Tools

| Tool | Description |
|:---|:---|
| `ilostat_search_indicators` | Search the indicator catalog by plain-language terms and filters; each hit lists a dataset ID per available frequency |
| `ilostat_describe_indicator` | Explain one dataset: definition, unit and multiplier, breakdown codes in use, covered areas, and how its values are classed |
| `ilostat_query_indicator` | Fetch observations for up to 3 datasets, filtered by area or area group, sex, breakdown codes, source, and period |
| `ilostat_get_country_profile` | Headline labour-market figures for one area: latest reported value and latest ILO modelled estimate, side by side |
| `ilostat_compare_geographies` | Rank areas on one slice of one dataset at a common or latest period, with optional change over N years |
| `ilostat_list_reference` | Decode ILOSTAT's code vocabulary: areas, area groups, databases, subjects, sexes, breakdowns, sources, status flags, notes |
| `ilostat_dataframe_describe` | Describe a staged `df_<id>` dataframe by name, or list them all (off under HTTP with auth `none`), with provenance, coverage, basis counts, and column schema |
| `ilostat_dataframe_query` | Run one read-only SQL `SELECT` over staged dataframes, optionally storing the result as a new one |
| `ilostat_dataframe_drop` | Drop a staged dataframe before its TTL |

`ilostat_dataframe_drop` is off unless `ILOSTAT_DATAFRAME_DROP_ENABLED=true`, and `CANVAS_PROVIDER_TYPE=none` turns off all three dataframe tools.

## Capability reference

### `ilostat_search_indicators` <sub>tool</sub>

- Plain-language `query` (every term must match a word or word prefix; case, accents, and labour/labor folded) plus `frequency`, `database`, `subject`, `breakdown`, and `aggregates_only` filters; omit `query` to browse by filters
- Up to 50 hits per page (default 10), continued with `next_cursor`; each hit is one indicator with a `dataset_id` per frequency, coverage years, `n_ref_area`, `last_update`, and `has_aggregates`, and `facets` count the whole match set
- An unrecognized `database`, `subject`, or `breakdown` code fails as `unknown_filter_code`

---

### `ilostat_describe_indicator` <sub>tool</sub>

- One `dataset_id` (`UNE_DEAP_SEX_AGE_RT_A`) or a bare indicator code, which describes every frequency; an unknown code returns `found: false` with `guidance`
- Definition, `unit` and its `multiplier`, frequency variants, `breakdowns` (sex codes, plus `classif1` / `classif2` codes with totals marked `is_total`), `default_slice`, covered `ref_areas`, `basis_rule`, and up to 20 `related_datasets`
- Breakdowns, unit, and areas come from the SDMX API; when it can't answer, `structure_status` is `unavailable` and those fields are absent rather than the call failing

---

### `ilostat_query_indicator` <sub>tool</sub>

- 1–3 `dataset_ids`, filtered by `ref_areas` (up to 300) and/or an `area_group`, `sex`, `classif1`, `classif2`, `sources`, and period: one exact `time`, or a `time_from` / `time_to` year window, `latest_only`, or both
- `source_selection` is `best` by default (the preferred source per area and period), `all`, or `secondary`; rows carry `source`, `obs_status`, `notes`, and `basis`, decoded in `legend`, and `applied_filters` echoes every parameter sent
- A result past the inline preview stages in full as a `df_<id>` `dataframe`; an unfiltered request larger than `ILOSTAT_MAX_ROWS` fails as `request_too_broad`, and a filtered one that streams past it as `result_too_large`

---

### `ilostat_get_country_profile` <sub>tool</sub>

- One `ref_area` with annual data, an ISO3 country (`KEN`) or an X-coded aggregate (`X01` World, regions, income groups), and `sex` (`SEX_T` by default, `SEX_M`, or `SEX_F`)
- Nine headline indicators (labour force participation, employment-to-population ratio, unemployment, youth unemployment, youth NEET, informal employment, employment, labour income share, working poverty), each with its latest `reported` value and, separately, its latest non-projected `modelled` estimate
- A missing reported value stays missing and is listed in `reported_missing`; aggregates carry modelled values only

---

### `ilostat_compare_geographies` <sub>tool</sub>

- One `dataset_id` and one slice (`sex`, `classif1`, `classif2`, defaulting to the dataset's totals); areas from `ref_areas` (up to 300), an `area_group`, or both, and at least one is required
- `period` puts every area at one period; without it, each area gets its latest value within `lookback_years` (default 10), projections excluded unless `include_projections`; `change_years` (1–30) adds each value's change over that span
- Rows carry `rank`, `value`, `period`, `basis`, and `source`; areas without a value land in `missing` with a `reason`, and `comparability` reports `mixed_periods`, `basis_counts`, and `distinct_sources`

---

### `ilostat_list_reference` <sub>tool</sub>

- `topic`: `ref_areas`, `area_groups`, `databases`, `subjects`, `sexes`, `classifications`, `classification_types`, `sources`, `obs_status`, `notes`, or `frequencies`
- A text `filter` or up to 100 exact `codes` (misses in `not_found`; exact `area_groups` lookups list member countries); `ref_area` narrows `sources`, and `classification_type` narrows `classifications`
- Up to 500 entries per page (default 50), continued with `next_cursor`

---

### `ilostat_dataframe_describe` <sub>tool</sub>

- Pass one `df_XXXXX_XXXXX`, or omit `name` to list every staged dataframe, newest first. Listing is off under HTTP with auth `none`, where every caller shares one canvas: there a dataframe is reached by its exact name only
- Each entry carries the producing `source_tool` and its `query_params`, `datasets`, `coverage`, `basis_counts`, `attribution`, `created_at` / `expires_at`, `row_count`, and the `column_schema` to write SQL against

---

### `ilostat_dataframe_query` <sub>tool</sub>

- One DuckDB `SELECT` (joins, aggregates, window functions, CTEs) over `df_<id>` tables, up to 20,000 characters; writes, DDL, multi-statement SQL, file-reading functions, and system catalogs are rejected
- `row_limit` caps the rows materialized (default 1,000, max 10,000; `row_count_capped` flags a hit) and `preview` the rows returned inline; BIGINT values arrive as strings
- `register_as` stores the full result as a new dataframe with a fresh TTL, so analyses chain; a result over 1,000,000 rows is refused as `register_as_too_large`, and `evicted` names any older dataframes dropped to make room

---

### `ilostat_dataframe_drop` <sub>tool</sub>

- Drops one staged dataframe by `name` before its TTL; idempotent, with `dropped: false` when nothing matched
- Listed only when `ILOSTAT_DATAFRAME_DROP_ENABLED=true` and dataframes are on; it is the only destructive tool

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

ILOSTAT-specific:

- Two keyless ILO APIs: the ILOSTAT data API serves the catalog, the code dictionaries, and observations; the ILO SDMX API serves each dataset's breakdown codes, default slice, and unit
- The catalog (both tables of contents and 13 code dictionaries) is held in memory and rechecked every `ILOSTAT_CATALOG_REFRESH_HOURS`; every code a tool takes is validated against it before a request goes upstream
- One request pacer per upstream host; a 429 or challenge page starts a cooldown and reaches the caller as a retryable `upstream_busy` carrying `retryAfter`
- Data responses of up to 5,000 rows are cached for `ILOSTAT_CACHE_TTL_SECONDS`
- Dataframes on by default: a query or comparison larger than `ILOSTAT_PREVIEW_CHARS` stages in full as a DuckDB `df_<id>` table that lives for `ILOSTAT_DATASET_TTL_SECONDS`. A tenant holds at most 1,000,000 staged rows in 100 dataframes, so a new table can evict the oldest ones before their TTL, and the response names them in `evicted`. With `CANVAS_PROVIDER_TYPE=none`, or in the `.mcpb` bundle (which ships without DuckDB's native binding), results stop at the inline preview and say so
- ILOSTAT data and metadata are published under the ILO Open Access policy as [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); every data response carries an `attribution` to keep with the numbers

Agent-friendly output:

- Basis on every value: each row is `reported`, `modelled_estimate`, or `projection`, and results carry `basis_counts`. The country profile returns reported and modelled values in separate fields and never fills one from the other
- Provenance and decoding: rows keep `source`, `obs_status`, and note codes with a `legend` that decodes them, and query and comparison responses echo `applied_filters`, defaults included
- Misses as data: an unknown dataset returns `found: false` with `guidance`, and compared areas without a value land in `missing` with a typed `reason`
- Typed errors: failures carry a reason (`unknown_code`, `request_too_broad`, `upstream_busy`, …) and a recovery hint

## Getting started

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "ilostat-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/ilostat-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "ilostat-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/ilostat-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "ilostat-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/ilostat-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key or account: both ILO APIs are open.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/ilostat-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd ilostat-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# every variable is optional; see Configuration below
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `ILOSTAT_CATALOG_REFRESH_HOURS` | Hours between checks of the ILOSTAT tables of contents (1–168). The dictionaries are re-fetched only when a dataset was added, removed, or updated. | `6` |
| `ILOSTAT_MAX_ROWS` | Ceiling on the rows one query may return or stage (1,000–1,000,000). | `500000` |
| `ILOSTAT_PREVIEW_CHARS` | Inline preview budget in serialized characters (at least 1,000); a larger result stages as a dataframe. | `40000` |
| `ILOSTAT_CACHE_TTL_SECONDS` | Seconds an upstream data response of up to 5,000 rows stays cached; `0` disables the cache. | `900` |
| `ILOSTAT_DATASET_TTL_SECONDS` | Per-table TTL for staged dataframes, in seconds (at least 60). | `86400` |
| `ILOSTAT_DATAFRAME_DROP_ENABLED` | Set `true` to expose `ilostat_dataframe_drop`. | `false` |
| `CANVAS_PROVIDER_TYPE` | DataCanvas engine for staged dataframes: `duckdb`, or `none` to turn dataframes and the three dataframe tools off. | `duckdb` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point. Turns dataframes on by default, registers the tools, starts the catalog load. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) and the input and rendering helpers they share. Nine tools. |
| `src/services/rplumber`, `src/services/sdmx` | Clients for the ILOSTAT data API and the ILO SDMX API, on the paced, retried HTTP layer in `src/services/upstream`. |
| `src/services/catalog` | In-memory catalog snapshot, indicator search, reference listings, paging. |
| `src/services/structure` | Per-indicator SDMX structure and unit, cached. |
| `src/services/observations` | Request validation, size preflight, row decoding, comparisons, response cache. |
| `src/services/profile` | Headline country profile. |
| `src/services/basis` | Rules classing each value as reported, modelled estimate, or projection. |
| `src/services/canvas-bridge` | DataCanvas adapter: `df_<id>` staging, provenance, SQL, drop. |
| `tests/` | Vitest suite mirroring `src/`, with recorded upstream fixtures. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools in `buildToolDefinitions()` in `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details. The ILOSTAT data the tools return belongs to the International Labour Organization and is published under CC BY 4.0; cite ILOSTAT and the dataset ID.
