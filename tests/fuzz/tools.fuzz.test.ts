/**
 * @fileoverview Property-based fuzzing of all nine tools against the recorded
 * catalog, SDMX, and observation fixtures and a real in-memory DuckDB canvas,
 * with every other upstream request refused by the strict fetch fake. Generated
 * valid and adversarial inputs must produce a schema-valid result (enrichment
 * contract included) or a classified MCP error — never a crash, a hang, a
 * leaked stack or path, prototype pollution, an unclassified throw, or an
 * `InternalError`. `fuzzTool`'s generated valid inputs mostly fail these
 * schemas (codes, patterns, and preprocessed inputs), so a second pass draws
 * each field from real codes, blanks, adversarial strings, and wrong types, and
 * runs it through `runToolContract`, where a majority reach the handler.
 * @module tests/fuzz/tools.fuzz.test
 */

import { appendFileSync } from 'node:fs';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { ADVERSARIAL_STRINGS, fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareGeographiesTool } from '@/mcp-server/tools/definitions/compare-geographies.tool.js';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { describeIndicatorTool } from '@/mcp-server/tools/definitions/describe-indicator.tool.js';
import { getCountryProfileTool } from '@/mcp-server/tools/definitions/get-country-profile.tool.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { queryIndicatorTool } from '@/mcp-server/tools/definitions/query-indicator.tool.js';
import { searchIndicatorsTool } from '@/mcp-server/tools/definitions/search-indicators.tool.js';
import { disposeIlostatServices } from '@/services/ilostat-services.js';
import { memoryCanvas, wireDataframes } from '../helpers/ilostat-upstream.js';
import { guardNetwork } from '../helpers/network-guard.js';

guardNetwork();

const NUM_RUNS = 60;
const NUM_ADVERSARIAL = 30;
const HANDLER_BUDGET_MS = 5_000;
let canvas: DataCanvas;

beforeAll(() => {
  canvas = memoryCanvas();
  wireDataframes({ canvas });
});

afterAll(async () => {
  disposeIlostatServices();
  await canvas.shutdown(createMockContext());
});

type Definition = Parameters<typeof fuzzTool>[0];

/**
 * `definition` with its handler instrumented: how many generated inputs passed
 * the schema and reached it, the slowest call, and every throw that is not a
 * classified `McpError` or is an `InternalError`.
 */
function instrumented(definition: Definition) {
  const stats = { reached: 0, slowestMs: 0, unclassified: [] as unknown[] };
  const handler = definition.handler as (input: unknown, ctx: unknown) => Promise<unknown>;
  const wrapped = {
    ...definition,
    async handler(input: unknown, ctx: unknown) {
      stats.reached++;
      const started = performance.now();
      try {
        return await handler(input, ctx);
      } catch (error) {
        if (!(error instanceof McpError) || error.code === JsonRpcErrorCode.InternalError) {
          stats.unclassified.push({ input, error });
        }
        throw error;
      } finally {
        stats.slowestMs = Math.max(stats.slowestMs, performance.now() - started);
      }
    },
  } as Definition;
  return { stats, wrapped };
}

const CONTRACT_RUNS = 150;
const SCHEMA_REJECTION = 'Input validation error: Invalid arguments for tool';

/** Appends a run summary to the file `FUZZ_REPORT` names, when set. */
function report_(line: string): void {
  if (process.env.FUZZ_REPORT) appendFileSync(process.env.FUZZ_REPORT, `${line}\n`);
}
/** Real codes and values from the fixtures, blanks, and query-shaped strings. */
const PLAUSIBLE = [
  '',
  ' ',
  'USA',
  'KEN',
  'X01',
  'WLD',
  'usa',
  'UNE_DEAP_SEX_AGE_RT_A',
  'EMP_TEMP_SEX_AGE_NB_A',
  'UNE_DEAP_SEX_AGE_RT',
  'SEX_T',
  'SEX_F',
  'AGE_YTHADULT_Y15-24',
  'AGE_YTHADULT_YGE15',
  '2020',
  '2024',
  '2024M01',
  'A',
  'M',
  'Q',
  'LFS',
  'ILOEST',
  'UNE',
  'SEX',
  'unemployment',
  'youth unemployment',
  'databases',
  'subjects',
  'classification_types',
  'sources',
  'frequencies',
  'ref_areas',
  'df_ABCDE_FGHIJ',
  'df_abcde_fghij',
  'SELECT 1 AS n',
  'SELECT * FROM df_ABCDE_FGHIJ',
  'VALUES (1)',
  'latest',
  'all',
];

/** One field value: plausible, adversarial, or the wrong type, sometimes absent. */
const fieldValue = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(...PLAUSIBLE) },
  { weight: 3, arbitrary: fc.array(fc.constantFrom(...PLAUSIBLE), { maxLength: 4 }) },
  { weight: 2, arbitrary: fc.constantFrom(...ADVERSARIAL_STRINGS) },
  { weight: 2, arbitrary: fc.integer({ min: -5, max: 60_000 }) },
  { weight: 1, arbitrary: fc.boolean() },
  { weight: 2, arbitrary: fc.constant(undefined) },
);

interface SafeParser {
  safeParse(value: unknown): { success: boolean };
}

/** Every value a field is offered; each field's own schema picks the ones it accepts. */
const CANDIDATES: unknown[] = [
  ...PLAUSIBLE,
  ['USA'],
  ['USA', 'KEN'],
  ['UNE_DEAP_SEX_AGE_RT_A'],
  ['SEX_T', 'SEX_F'],
  ['2020', '2024'],
  [],
  0,
  1,
  5,
  10,
  50,
  1000,
  true,
  false,
  undefined,
];

/**
 * `CONTRACT_RUNS` inputs keyed by the definition's own input fields, each run
 * through `runToolContract` under a hang budget: nineteen in twenty draws per field
 * come from the candidates that field's schema accepts, the rest from {@link fieldValue}. A failure is a throw past the
 * boundary, a hang, an `InternalError`, or an error envelope with no code.
 */
async function contractFuzz(definition: Definition) {
  const shape = (definition.input as unknown as { shape: Record<string, SafeParser> }).shape;
  const fields = Object.entries(shape).map(([key, schema]) => {
    const valid = CANDIDATES.filter((value) => schema.safeParse(value).success);
    const arbitrary =
      valid.length === 0
        ? fieldValue
        : fc.oneof(
            { weight: 19, arbitrary: fc.constantFrom(...valid) },
            { weight: 1, arbitrary: fieldValue },
          );
    return [key, arbitrary] as const;
  });
  const inputs = fc.sample(fc.record(Object.fromEntries(fields), { requiredKeys: [] }), {
    numRuns: CONTRACT_RUNS,
    seed: 20_260_926,
  });
  const outcome = {
    reached: 0,
    succeeded: 0,
    slowestMs: 0,
    codes: {} as Record<string, number>,
    failures: [] as unknown[],
  };
  for (const [index, input] of inputs.entries()) {
    const started = performance.now();
    let timer: NodeJS.Timeout | undefined;
    const hang = new Promise<'hang'>((resolve) => {
      timer = setTimeout(() => resolve('hang'), HANDLER_BUDGET_MS);
    });
    const result = await Promise.race([
      runToolContract(definition, input as never, {
        // Each call starts from empty tenant state and mints a canvas; spread them
        // over tenants so none reaches the framework's per-tenant canvas cap.
        context: { tenantId: `fuzz-${index % 50}`, errors: definition.errors },
      }).catch((error: unknown) => ({ thrown: error })),
      hang,
    ]);
    clearTimeout(timer);
    outcome.slowestMs = Math.max(outcome.slowestMs, performance.now() - started);
    if (result === 'hang' || 'thrown' in result) {
      outcome.failures.push({ input, result });
      continue;
    }
    if (!result.isError) {
      outcome.reached++;
      outcome.succeeded++;
      continue;
    }
    const error = (result.structuredContent as { error?: { code?: number; message?: string } })
      .error;
    const code = error?.code;
    outcome.codes[String(code)] = (outcome.codes[String(code)] ?? 0) + 1;
    // A schema rejection names the tool's arguments; an InvalidParams the handler throws does not.
    if (!error?.message?.startsWith(SCHEMA_REJECTION)) outcome.reached++;
    if (code === undefined || code === JsonRpcErrorCode.InternalError)
      outcome.failures.push({ input, result });
  }
  return outcome;
}

describe.each([
  ['ilostat_list_reference', listReferenceTool],
  ['ilostat_search_indicators', searchIndicatorsTool],
  ['ilostat_describe_indicator', describeIndicatorTool],
  ['ilostat_query_indicator', queryIndicatorTool],
  ['ilostat_compare_geographies', compareGeographiesTool],
  ['ilostat_get_country_profile', getCountryProfileTool],
  ['ilostat_dataframe_query', dataframeQueryTool],
  ['ilostat_dataframe_describe', dataframeDescribeTool],
  ['ilostat_dataframe_drop', dataframeDropTool],
] as const)('%s', (_name, definition) => {
  it('survives valid and adversarial inputs', { timeout: 120_000 }, async () => {
    const { stats, wrapped } = instrumented(definition as Definition);
    const report = await fuzzTool(wrapped, {
      numRuns: NUM_RUNS,
      numAdversarial: NUM_ADVERSARIAL,
      seed: 20_260_926,
      timeout: HANDLER_BUDGET_MS,
      ctx: { tenantId: 'default', errors: definition.errors },
    });
    expect(report.crashes).toEqual([]);
    expect(report.leaks).toEqual([]);
    expect(report.prototypePollution).toBe(false);
    expect(stats.unclassified).toEqual([]);
    expect(stats.slowestMs).toBeLessThan(HANDLER_BUDGET_MS);
    expect(report.totalRuns).toBeGreaterThanOrEqual(NUM_RUNS + NUM_ADVERSARIAL);
    report_(`${_name} fuzzTool: ${report.totalRuns} runs, ${stats.reached} reached the handler`);
  });

  it('survives schema-derived inputs through the contract boundary', {
    timeout: 120_000,
  }, async () => {
    const outcome = await contractFuzz(definition as Definition);
    expect(outcome.failures).toEqual([]);
    expect(outcome.reached).toBeGreaterThan(CONTRACT_RUNS / 2);
    report_(
      `${_name} contract: ${CONTRACT_RUNS} runs, ${outcome.reached} reached the handler, ${outcome.succeeded} succeeded, codes ${JSON.stringify(outcome.codes)}, slowest ${outcome.slowestMs.toFixed(0)} ms`,
    );
  });
});
