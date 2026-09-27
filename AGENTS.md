# Developer Protocol

**Server:** ilostat-mcp-server
**Version:** 0.1.0
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.8`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.0.0
**Zod:** ^4.6.5

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Cut noise.** Add only what earns its place: no speculative generality, no guards for states the framework already prevents (Zod-validated params, classified errors), no abstraction until a third caller proves it, no option nothing sets.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

Abridged from `src/mcp-server/tools/definitions/search-indicators.tool.ts`:

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { blankAsUnset } from '@/mcp-server/tools/tool-helpers.js';
import { cursorOffset } from '@/services/catalog/paging.js';
import { searchIndicators } from '@/services/catalog/search.js';
import { getIlostatServices } from '@/services/ilostat-services.js';

export const searchIndicatorsTool = tool('ilostat_search_indicators', {
  title: 'Search ILOSTAT indicators',
  description: "Search ILOSTAT's catalog of labour-statistics indicators by plain-language terms and filters. …",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    query: blankAsUnset(z.string().optional()).describe('Plain-language terms, e.g. "youth unemployment" …'),
    database: blankAsUnset(z.string().optional()).describe('Source database code, e.g. LFS or ILOEST; case-insensitive. …'),
    limit: z.number().int().min(1).max(50).default(10).describe('Hits per page (1–50).'),
    cursor: blankAsUnset(z.string().optional()).describe("Opaque continuation token: the previous page's next_cursor, passed unchanged."),
    // … frequency, subject, breakdown, aggregates_only
  }),

  output: z.object({ /* hits, total, facets, next_cursor, catalog_as_of */ }),
  enrichment: { /* truncated, shown, cap, notice */ },

  errors: [
    {
      reason: 'unknown_filter_code',
      code: JsonRpcErrorCode.ValidationError,
      when: 'database, subject, or breakdown is not an ILOSTAT code.',
      recovery: 'Call ilostat_list_reference with topic databases, subjects, or classification_types to see the valid codes.',
      severity: 'notice',
    },
    // … invalid_cursor and catalog_unavailable, both thrownBy: 'service'
  ],

  async handler(input, ctx) {
    const offset = cursorOffset(input.cursor, ctx);
    const snapshot = await getIlostatServices().catalog.ready(ctx);
    const database = input.database?.toUpperCase();
    if (database && !snapshot.databases.has(database)) {
      throw ctx.fail('unknown_filter_code', `Not an ILOSTAT code: database ${database}.`, {
        ...ctx.recoveryFor('unknown_filter_code'),
      });
    }
    const result = searchIndicators(snapshot, { limit: input.limit, offset /* , … */ });
    ctx.enrich({ truncated: false, shown: result.hits.length, cap: input.limit });
    // … ctx.enrich.truncated() with next-page guidance when result.nextCursor is set
    return { /* … */ };
  },

  format: (result) => [{ type: 'text', text: /* every output field; ILO text through inlineText() */ '' }],
});
```

`format()` populates `content[]`, the markdown twin of `structuredContent`. Clients read different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`), so both carry the same data; the linter checks that every `output` field appears in the rendered text.

Conventions every tool here follows:

- The catalog snapshot comes from `getIlostatServices().catalog.ready(ctx)`, and every code is validated against it before a request goes upstream.
- Optional inputs go through `blankAsUnset` / `blankFreeArray`, since form clients send every field blank. Dataset IDs, area codes, sex codes, periods, and dataframe names use the normalizing inputs in `src/mcp-server/tools/tool-helpers.ts`.
- ILO-published text rendered in `format()` passes through `inlineText()`, `blockquote()`, or `tableCell()`.
- Data-bearing outputs carry `attribution: ATTRIBUTION`, and every observation a `basis` (`reported` | `modelled_estimate` | `projection`). A modelled value never fills a missing reported one.

### Tool registration

`src/mcp-server/tools/definitions/index.ts` builds the list handed to `createApp()`. It is constant in length: a gated tool stays in it through `disabledTool()`, absent from `tools/list` but shown with its enable hint on the HTTP landing page.

```ts
export function buildToolDefinitions(options: ToolDefinitionOptions) {
  const dataframeTools = options.canvasEnabled
    ? [
        dataframeQueryTool,
        dataframeDescribeTool,
        options.dropEnabled ? dataframeDropTool : disabledTool(dataframeDropTool, DROP_OFF),
      ]
    : [dataframeQueryTool, dataframeDescribeTool, dataframeDropTool].map((definition) =>
        disabledTool(definition, CANVAS_OFF),
      );
  return [searchIndicatorsTool, describeIndicatorTool, /* … */ ...dataframeTools];
}
```

### Resources and prompts

None. Every capability is a tool (`docs/design.md` § Design Decisions). Scaffold one with the `add-resource` or `add-prompt` skill if that changes.

### Server config

Abridged from `src/config/server-config.ts` (the real `.describe()` text is longer):

```ts
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  catalogRefreshHours: z.coerce.number().int().min(1).max(168).default(6).describe('Hours between catalog checks (1–168).'),
  maxRows: z.coerce.number().int().min(1_000).max(1_000_000).default(500_000).describe('Row ceiling per query.'),
  previewChars: z.coerce.number().int().min(1_000).default(40_000).describe('Inline preview budget, in characters.'),
  cacheTtlSeconds: z.coerce.number().int().min(0).default(900).describe('Response cache TTL (0 disables).'),
  datasetTtlSeconds: z.coerce.number().int().min(60).default(86_400).describe('Per-table dataframe TTL.'),
  dataframeDropEnabled: z.stringbool().default(false).describe('Exposes ilostat_dataframe_drop.'),
});

let _config: ServerConfig | undefined;
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    catalogRefreshHours: 'ILOSTAT_CATALOG_REFRESH_HOURS',
    maxRows: 'ILOSTAT_MAX_ROWS',
    previewChars: 'ILOSTAT_PREVIEW_CHARS',
    cacheTtlSeconds: 'ILOSTAT_CACHE_TTL_SECONDS',
    datasetTtlSeconds: 'ILOSTAT_DATASET_TTL_SECONDS',
    dataframeDropEnabled: 'ILOSTAT_DATAFRAME_DROP_ENABLED',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so errors name the variable (`ILOSTAT_MAX_ROWS`) not the path (`maxRows`). Throws `ConfigurationError`, which the framework prints as a clean startup banner. No variable is required: the upstream APIs are keyless.

`CANVAS_PROVIDER_TYPE` is a framework variable, not part of this schema: `src/index.ts` loads `.env`, then sets it to `duckdb` when unset or blank, before `createApp()` runs. `none` turns dataframes off and registers the three dataframe tools disabled.

For env booleans use `z.stringbool()`, never `z.coerce.boolean()` — `Boolean("false")` is `true`, so a coerced flag can't be disabled through the environment. `z.stringbool()` parses `true/false/1/0/yes/no/on/off` and rejects anything else, so `=false` actually disables.

### Server identity and instructions

`createApp()` forwards its identity fields to the SDK's `initialize` response and the server manifest (`/.well-known/mcp.json`). The call in `src/index.ts`:

```ts
await createApp({
  name: 'ilostat-mcp-server',
  title: 'ilostat-mcp-server', // display identity is the machine name, never Title Case
  tools: buildToolDefinitions({ canvasEnabled, dropEnabled: dataframeDropEnabled }),
  resources: [],
  prompts: [],
  sessionMode: 'stateless',
  instructions: buildInstructions({ canvasEnabled }),
  setup(core) {
    initIlostatServices({ canvas: core.canvas }).catalog.start();
  },
  teardown() {
    disposeIlostatServices();
  },
});
```

`description` is never set here: `package.json` is the canonical source, and the framework serves it from there.

`instructions` is server-level orientation, sent on every `initialize` as session-level context. `src/mcp-server/server-instructions.ts` builds it: the dataset-ID workflow, the basis rule, the overlapping-classification warning, and the citation line, plus a dataframe sentence only when the canvas is on, so the instructions never name a capability the deployment can't serve.

### Session posture and shutdown

`sessionMode: 'stateless'` fits here because no tool asks the caller for input mid-handler. `setup()` constructs the services and starts the catalog load without blocking startup; `teardown()` releases the catalog refresh timer, in-flight loads, and both upstream pacers.

`sessionMode` declares the HTTP session posture in `src/` instead of leaving it to a deployment's `MCP_SESSION_MODE`, which still wins whenever it carries a meaningful value (an empty string and an unsubstituted `${…}` placeholder read as unset and fall through to the option). Add `require: 'stateful'` when a tool asks the caller for input mid-handler via `ctx.requestInput`: startup then fails with a `ConfigurationError` rather than serving a mode in which a 2025-era client can never answer the prompt. Stdio is never refused.

`teardown(core)` is the `setup()` counterpart — release a watcher, socket, or non-`unref()`'d timer there. It runs after the transport stops and before the logger closes, on every shutdown path, and a signal-triggered shutdown then exits the process explicitly (0, or 1 if a step never settles within the framework's 10 s ceiling).

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino **and** `notifications/message` to the client, so treat it as client-visible. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.getMany(keys)`, `.list(prefix, { cursor, limit })`. Accepts any JSON-serializable value; reads return its JSON form (a `Date` comes back as an ISO string). Here the canvas bridge keeps the tenant's canvas ID (`canvas-id`) and per-dataframe provenance (`df-meta/<name>`) in it. |
| `ctx.enrich` | Success-path agent context (empty-result notices, query echo, pagination totals) — `ctx.enrich(...)` or `.notice()` / `.total()` / `.echo()` / `.truncated()`. Reaches `structuredContent` and `content[]`; lands only when the definition declares an `enrichment` block (no-op otherwise). The observation tools carry `applied_filters` through it, rendered by an `enrichmentTrailer`. |
| `ctx.fail(reason, …)` / `ctx.recoveryFor(reason)` | Typed throw against the tool's `errors[]` contract, and the contract's recovery hint to spread into its data. |
| `ctx.signal` | `AbortSignal` for cancellation; composed into the upstream request timeouts. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable?, severity?, thrownBy? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required (≥ 5 words, lint-validated) — the single source of truth for the agent's next move. Pass `ctx.recoveryFor('reason')` as the throw's data to put it on the wire (`data.recovery.hint`, mirrored into `content[]` text unless the message already contains it verbatim); override with an explicit `{ recovery: { hint: '...' } }` when dynamic runtime context matters. Forwarding it is lint-enforced per throw site (`error-contract-recovery-unforwarded`). Mark an entry the service layer throws with `thrownBy: 'service'` so `error-contract-unthrown` skips it — lint-only metadata, nothing at runtime reads it. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No item matched the query',
    recovery: 'Broaden the query or check the spelling and try again.' },
],
async handler(input, ctx) {
  const item = await db.find(input.id);
  if (!item) throw ctx.fail('no_match', `No item ${input.id}`, ctx.recoveryFor('no_match'));
  return item;
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.InitializationFailed, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point; canvas default, drop gate
  config/
    server-config.ts                    # ILOSTAT_* env vars (Zod schema)
  mcp-server/
    server-instructions.ts              # instructions string (dataframe sentence gated on the canvas)
    tools/
      tool-helpers.ts                   # blank-as-unset and normalizing inputs, ILO-text renderers
      observation-output.ts             # output schemas + renderers shared by query and compare
      definitions/
        index.ts                        # buildToolDefinitions() — gated tools via disabledTool()
        [tool-name].tool.ts             # 9 tool definitions
  services/
    ilostat-services.ts                 # init/accessor/dispose for every service below
    attribution.ts                      # the CC BY 4.0 attribution string
    upstream/                           # paced, retried GET per host; 429/challenge → upstream_busy
    rplumber/                           # rplumber.ilo.org client: tables of contents, dictionaries, data
    sdmx/                               # sdmx.ilo.org client: dataflow structure, unit probe
    catalog/                            # in-memory catalog snapshot, search, reference listings, paging
    structure/                          # per-indicator SDMX structure + unit, cached
    observations/                       # request validation, streaming, rows, comparison, response cache
    profile/                            # headline country profile
    basis/                              # reported / modelled_estimate / projection rules
    canvas-bridge/                      # DataCanvas adapter: df_<id> staging, provenance, SQL, drop
    csv/                                # incremental RFC 4180 reader
    wait.ts                             # shared-work waits bounded by the caller's signal
tests/                                  # Vitest suite mirroring src/, with recorded upstream fixtures
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-indicators.tool.ts` |
| Tool names | snake_case, `ilostat_` prefix | `ilostat_search_indicators` |
| Input/output fields | snake_case | `dataset_id`, `ref_areas`, `latest_only` |
| Directories | kebab-case | `src/services/canvas-bridge/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Hits per page (1–50).'` |

---

## Skills

Skills are modular instructions in `framework-skills/` at the project root. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. The directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, so a server that ships `.claude-plugin/` or `.codex-plugin/` would hand these development skills to every agent that installs it. Keep `skills/` free for skills meant for those agents.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `framework-skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity (run by devcheck) |
| `bun run list-skills` | Print the skill registry |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run test:coverage` | Run tests with coverage (writes `coverage/`) |
| `bun run start` | Run the built server (`node dist/index.js`) with the transport from the environment |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |
| `bun run release:github` | Create the GitHub Release for the current version and attach the `.mcpb` (run by `release-and-publish`) |

**CI is one file.** `.github/workflows/codeql.yml` (scaffolded) is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`npm run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`framework-skills/`, `skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on. This server's bundle therefore ships portable and without the DuckDB native binding: `@duckdb/node-api` is a direct dependency here, but the framework loads it lazily, so in the bundle the dataframe tools report an actionable install hint and every other tool works normally. `CANVAS_PROVIDER_TYPE` is deliberately not a bundle option. MCPB is stdio-only; the npm, Docker, and HTTP installs are unaffected.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match, that every `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.X}"` (the host substitutes nothing else — `"${X}"` reaches the server as that literal string), and that an optional string option carries `"default": ""`.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `framework-skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

**Every release goes through a release PR, straight-through** — `git-wrapup`'s "Release PR mode", mode `straight-through`. One run: `git-wrapup` lands the commit stack on `release/<version>`, pushes it, and opens the PR (title = the release commit subject, body = the changelog entry plus a gates section); `release-and-publish` then fast-forwards `main` locally with `git merge --ff-only`, creates the tag on `main`'s tip, pushes `main` and the tag, deletes the branch, and publishes. A caller's brief may run a given release as `gated` instead — a `release-pr-review` pass on the open PR before `release-and-publish`. **Never merge through the GitHub UI or `gh pr merge`**: squash and rebase-merge are disabled in the repo settings because both rewrite the stack (rebase-merge also strips the SSH signatures), and a merge commit breaks the linear history.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getMyService } from '@/services/my-domain/my-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = the unscoped repo name (never the npm scope — `lint:packaging` enforces this); `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key is the unscoped repo name; every user-supplied variable (API key, contact email, instance URL) is listed in `env_vars` so Codex forwards it from the user's environment. Never write `"KEY": ""` into `env` — an empty value replaces the user's exported key and is read as unset
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `author`, `repository`, `license`, `keywords` from `package.json`; inline `mcpServers` entry keyed by the unscoped repo name. Every user-supplied variable is declared under `userConfig` (`type`, `title`, `description`; `sensitive: true` for keys and tokens; `required: true` or `default: ""`) and referenced from `env` as `"KEY": "${user_config.<option>}"` — mirror the `user_config` block in `manifest.json`. Never write `"KEY": ""` into `env`
- [ ] New env var added everywhere: `src/config/server-config.ts`, `.env.example`, both `server.json` package entries, `manifest.json` (`mcp_config.env` + `user_config`), both plugin manifests, and the README configuration table
- [ ] Every code a tool accepts is validated against the catalog snapshot before any upstream request
- [ ] Data-bearing outputs carry `attribution`; every observation carries a `basis`, and a modelled value never stands in for a missing reported one
- [ ] ILO-published text in `format()` passes through `inlineText()`, `blockquote()`, or `tableCell()`
- [ ] `npm run devcheck` passes
