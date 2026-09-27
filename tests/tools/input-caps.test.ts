/**
 * @fileoverview Length caps on every free-text and code string input: each
 * field accepts a value at its cap and rejects one character more as invalid
 * arguments naming the field, before the handler runs, so no upstream call or
 * catalog load is made.
 * @module tests/tools/input-caps.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { compareGeographiesTool } from '@/mcp-server/tools/definitions/compare-geographies.tool.js';
import { describeIndicatorTool } from '@/mcp-server/tools/definitions/describe-indicator.tool.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { queryIndicatorTool } from '@/mcp-server/tools/definitions/query-indicator.tool.js';
import { searchIndicatorsTool } from '@/mcp-server/tools/definitions/search-indicators.tool.js';
import { guardNetwork } from '../helpers/network-guard.js';

guardNetwork();

type AnyTool = Parameters<typeof runToolContract>[0];

interface CapCase {
  /** Arguments carrying `value` in the capped field. */
  args: (value: string) => Record<string, unknown>;
  max: number;
  /** The issue path: the field, plus the element index for an array input. */
  path: (string | number)[];
  tool: AnyTool;
}

const UNE = 'UNE_DEAP_SEX_AGE_RT_A';
const TOPIC = { topic: 'classifications' };
const COMPARE = { dataset_id: UNE, ref_areas: ['USA'] };

const CASES: CapCase[] = [
  { tool: searchIndicatorsTool, path: ['query'], max: 500, args: (query) => ({ query }) },
  { tool: searchIndicatorsTool, path: ['database'], max: 32, args: (database) => ({ database }) },
  { tool: searchIndicatorsTool, path: ['subject'], max: 32, args: (subject) => ({ subject }) },
  {
    tool: searchIndicatorsTool,
    path: ['breakdown'],
    max: 32,
    args: (breakdown) => ({ breakdown }),
  },
  { tool: searchIndicatorsTool, path: ['cursor'], max: 256, args: (cursor) => ({ cursor }) },
  { tool: listReferenceTool, path: ['filter'], max: 200, args: (filter) => ({ ...TOPIC, filter }) },
  {
    tool: listReferenceTool,
    path: ['codes', 0],
    max: 64,
    args: (code) => ({ ...TOPIC, codes: [code] }),
  },
  {
    tool: listReferenceTool,
    path: ['classification_type'],
    max: 32,
    args: (classification_type) => ({ ...TOPIC, classification_type }),
  },
  { tool: listReferenceTool, path: ['cursor'], max: 256, args: (cursor) => ({ ...TOPIC, cursor }) },
  {
    tool: describeIndicatorTool,
    path: ['dataset_id'],
    max: 200,
    args: (dataset_id) => ({ dataset_id }),
  },
  {
    tool: queryIndicatorTool,
    path: ['dataset_ids', 0],
    max: 64,
    args: (id) => ({ dataset_ids: [id] }),
  },
  {
    tool: queryIndicatorTool,
    path: ['classif1', 0],
    max: 64,
    args: (code) => ({ dataset_ids: [UNE], classif1: [code] }),
  },
  {
    tool: queryIndicatorTool,
    path: ['classif2', 0],
    max: 64,
    args: (code) => ({ dataset_ids: [UNE], classif2: [code] }),
  },
  {
    tool: queryIndicatorTool,
    path: ['sources', 0],
    max: 64,
    args: (code) => ({ dataset_ids: [UNE], sources: [code] }),
  },
  {
    tool: compareGeographiesTool,
    path: ['dataset_id'],
    max: 64,
    args: (dataset_id) => ({ ...COMPARE, dataset_id }),
  },
  {
    tool: compareGeographiesTool,
    path: ['classif1'],
    max: 64,
    args: (classif1) => ({ ...COMPARE, classif1 }),
  },
  {
    tool: compareGeographiesTool,
    path: ['classif2'],
    max: 64,
    args: (classif2) => ({ ...COMPARE, classif2 }),
  },
];

/** A value of `length` characters every one of these fields' patterns accepts. */
const filler = (length: number) => 'A'.repeat(length);

describe.each(CASES.map((entry) => ({ ...entry, field: entry.path.join('.') })))(
  '$tool.name $field (max $max)',
  ({ tool, path, field, max, args }) => {
    it('accepts a value at the cap', () => {
      expect(tool.input.safeParse(args(filler(max))).success).toBe(true);
    });

    it('rejects one character more as invalid arguments naming the field, on both surfaces', async () => {
      const result = await runToolContract(tool, args(filler(max + 1)) as never);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'invalid_arguments', issues: [{ code: 'too_big', maximum: max, path }] },
        },
      });
      const text = result.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      expect(text).toContain(`${field}: Too big: expected string to have <=${max} characters`);
    });
  },
);
