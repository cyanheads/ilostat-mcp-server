/**
 * @fileoverview Property-based fuzzing of the three catalog tools against the
 * recorded catalog and SDMX fixtures: generated valid and adversarial inputs must
 * produce a schema-valid result (enrichment contract included) or a well-formed
 * MCP error, never a crash, a leaked stack or path, or prototype pollution.
 * @module tests/fuzz/wave1-tools.fuzz.test
 */

import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeIndicatorTool } from '@/mcp-server/tools/definitions/describe-indicator.tool.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { searchIndicatorsTool } from '@/mcp-server/tools/definitions/search-indicators.tool.js';
import { disposeIlostatServices } from '@/services/ilostat-services.js';
import { wireServices } from '../helpers/ilostat-upstream.js';
import { guardNetwork } from '../helpers/network-guard.js';

guardNetwork();

const OPTIONS = { numRuns: 60, numAdversarial: 30, seed: 20_260_926 };

beforeAll(() => {
  wireServices();
});

afterAll(() => {
  disposeIlostatServices();
});

describe.each([
  ['ilostat_list_reference', listReferenceTool],
  ['ilostat_search_indicators', searchIndicatorsTool],
  ['ilostat_describe_indicator', describeIndicatorTool],
] as const)('%s', (_name, definition) => {
  it('survives valid and adversarial inputs', async () => {
    const report = await fuzzTool(definition, OPTIONS);
    expect(report.crashes).toEqual([]);
    expect(report.leaks).toEqual([]);
    expect(report.prototypePollution).toBe(false);
    expect(report.totalRuns).toBeGreaterThan(0);
  });
});
