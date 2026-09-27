# ilostat-mcp-server - Directory Structure

Generated on: 2026-09-27 00:23:45

```text
ilostat-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   └── template.md
├── docs/
│   └── design.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── tools/
│   │   │   ├── definitions/
│   │   │   │   ├── compare-geographies.tool.ts
│   │   │   │   ├── dataframe-describe.tool.ts
│   │   │   │   ├── dataframe-drop.tool.ts
│   │   │   │   ├── dataframe-query.tool.ts
│   │   │   │   ├── describe-indicator.tool.ts
│   │   │   │   ├── get-country-profile.tool.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── list-reference.tool.ts
│   │   │   │   ├── query-indicator.tool.ts
│   │   │   │   └── search-indicators.tool.ts
│   │   │   ├── observation-output.ts
│   │   │   └── tool-helpers.ts
│   │   └── server-instructions.ts
│   ├── services/
│   │   ├── basis/
│   │   │   └── basis.ts
│   │   ├── canvas-bridge/
│   │   │   ├── canvas-bridge.ts
│   │   │   └── scan-sql.ts
│   │   ├── catalog/
│   │   │   ├── catalog-service.ts
│   │   │   ├── codes.ts
│   │   │   ├── paging.ts
│   │   │   ├── reference.ts
│   │   │   ├── search.ts
│   │   │   ├── snapshot.ts
│   │   │   ├── text.ts
│   │   │   └── types.ts
│   │   ├── csv/
│   │   │   └── parse-csv.ts
│   │   ├── observations/
│   │   │   ├── comparison.ts
│   │   │   ├── observation-rows.ts
│   │   │   ├── observation-service.ts
│   │   │   ├── request-validation.ts
│   │   │   └── response-cache.ts
│   │   ├── profile/
│   │   │   └── profile-service.ts
│   │   ├── rplumber/
│   │   │   ├── rplumber-client.ts
│   │   │   └── types.ts
│   │   ├── sdmx/
│   │   │   └── sdmx-client.ts
│   │   ├── structure/
│   │   │   ├── sdmx-structure.ts
│   │   │   └── structure-service.ts
│   │   ├── upstream/
│   │   │   └── upstream-http.ts
│   │   ├── attribution.ts
│   │   ├── ilostat-services.ts
│   │   └── wait.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── fixtures/
│   │   ├── rplumber/
│   │   │   ├── dictionaries.json
│   │   │   ├── header-only.csv
│   │   │   ├── multi-dataset-union.csv
│   │   │   ├── observation-catalog-extras.json
│   │   │   ├── ref-area-ken-modelled-2025.json
│   │   │   ├── ref-area-ken-modelled.json
│   │   │   ├── ref-area-ken-reported.json
│   │   │   ├── ref-area-x01-modelled.json
│   │   │   ├── retired-dataset.json
│   │   │   ├── toc-indicator.json
│   │   │   ├── toc-ref-area.json
│   │   │   ├── une-deap-best-source-all.csv
│   │   │   └── une-deap-sex-age-rt-a.csv
│   │   └── sdmx/
│   │       ├── probe-EMP_TEMP_SEX_INS_DSB_NB.csv
│   │       ├── probe-LAP_2LID_QTL_RT.csv
│   │       ├── probe-SDG_0552_NOC_RT.csv
│   │       ├── probe-UNE_DEAP_SEX_AGE_RT.csv
│   │       ├── structure-EMP_TEMP_SEX_INS_DSB_NB.json
│   │       ├── structure-LAP_2LID_QTL_RT.json
│   │       ├── structure-SDG_0552_NOC_RT.json
│   │       └── structure-UNE_DEAP_SEX_AGE_RT.json
│   ├── fuzz/
│   │   └── tools.fuzz.test.ts
│   ├── helpers/
│   │   ├── ilostat-upstream.test.ts
│   │   ├── ilostat-upstream.ts
│   │   ├── network-guard.test.ts
│   │   └── network-guard.ts
│   ├── services/
│   │   ├── basis/
│   │   │   └── basis.test.ts
│   │   ├── canvas-bridge/
│   │   │   ├── canvas-bridge.test.ts
│   │   │   ├── scan-sql.test.ts
│   │   │   └── staging-budget.test.ts
│   │   ├── catalog/
│   │   │   ├── catalog-service.test.ts
│   │   │   ├── codes.test.ts
│   │   │   ├── snapshot.test.ts
│   │   │   └── text.test.ts
│   │   ├── csv/
│   │   │   └── parse-csv.test.ts
│   │   ├── observations/
│   │   │   ├── comparison.test.ts
│   │   │   └── response-cache.test.ts
│   │   ├── rplumber/
│   │   │   ├── rplumber-client.test.ts
│   │   │   └── rplumber-data.test.ts
│   │   ├── sdmx/
│   │   │   └── sdmx-client.test.ts
│   │   ├── structure/
│   │   │   ├── sdmx-structure.test.ts
│   │   │   └── structure-service.test.ts
│   │   ├── upstream/
│   │   │   └── upstream-http.test.ts
│   │   ├── ilostat-services.test.ts
│   │   └── wait.test.ts
│   ├── tools/
│   │   ├── compare-geographies.tool.test.ts
│   │   ├── dataframe-describe.tool.test.ts
│   │   ├── dataframe-drop.tool.test.ts
│   │   ├── dataframe-query.tool.test.ts
│   │   ├── describe-indicator.tool.test.ts
│   │   ├── get-country-profile.tool.test.ts
│   │   ├── list-reference.tool.test.ts
│   │   ├── query-indicator.tool.test.ts
│   │   ├── search-indicators.tool.test.ts
│   │   ├── tool-definitions.test.ts
│   │   └── tool-helpers.test.ts
│   └── index.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
