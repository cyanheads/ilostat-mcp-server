/**
 * @fileoverview The bundle cleaner (`scripts/clean-mcpb.ts`) and the packaging
 * check that verifies it (`scripts/lint-packaging.ts`) select agent-doc entries
 * only at a package root: a dependency's root `skills/` is stripped, while the
 * MCP SDK's `dist/ext/skills/` runtime modules stay in the bundle.
 * @module tests/scripts/bundle-agent-docs.test
 */

import { describe, expect, it } from 'vitest';

interface AgentDocSelectors {
  AGENT_DOC_ENTRY: RegExp;
}

/**
 * Loaded by URL at run time: `scripts/lint-packaging.ts` carries a repo-only
 * `import('../src/mcp-server/skills.js')` fallback that a static import would
 * pull into the typecheck, where it does not resolve (mcp-ts-core#797).
 */
const load = async (script: string): Promise<AgentDocSelectors> =>
  (await import(new URL(`../../scripts/${script}`, import.meta.url).href)) as AgentDocSelectors;

const cleaner = await load('clean-mcpb.ts');
const linter = await load('lint-packaging.ts');

const STRIPPED = [
  'node_modules/some-pkg/skills/guide/SKILL.md',
  'node_modules/some-pkg/skills/guide/references/notes.md',
  'node_modules/@scope/pkg/skills/guide/references/notes.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/references/example.md',
  'node_modules/thread-stream/.claude/settings.json',
  'node_modules/some-pkg/.agents/skills/x/notes.md',
  'node_modules/outer/node_modules/@scope/inner/skills/guide/notes.md',
  'node_modules/@scope/outer/node_modules/inner/.claude/settings.json',
  'node_modules/some-pkg/docs/SKILL.md',
];

const KEPT = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.cjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/outer/node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/@scope/skills/index.js',
  'node_modules/skills/index.js',
  'node_modules/some-pkg/lib/skills/loader.js',
  'skills/ilostat-guide/SKILL.md',
  'dist/index.js',
];

describe.each([
  ['clean-mcpb.ts', cleaner],
  ['lint-packaging.ts', linter],
])('%s AGENT_DOC_ENTRY', (_script, { AGENT_DOC_ENTRY }) => {
  it.each(STRIPPED)('selects the package-root agent doc %s', (entry) => {
    expect(AGENT_DOC_ENTRY.test(entry)).toBe(true);
  });

  it.each(KEPT)('keeps %s', (entry) => {
    expect(AGENT_DOC_ENTRY.test(entry)).toBe(false);
  });
});

describe('cleaner and packaging check', () => {
  it('carry the same agent-doc selector', () => {
    expect(linter.AGENT_DOC_ENTRY.source).toBe(cleaner.AGENT_DOC_ENTRY.source);
    expect(linter.AGENT_DOC_ENTRY.flags).toBe(cleaner.AGENT_DOC_ENTRY.flags);
  });
});
