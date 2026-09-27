/**
 * @fileoverview Tests for the shared tool input and rendering helpers: blank strings
 * and blank array elements from form clients read as unset, multi-line
 * ILO-published text stays inside its markdown blockquote, and a table cell
 * carries no line terminator.
 * @module tests/tools/tool-helpers.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { queryIndicatorTool } from '@/mcp-server/tools/definitions/query-indicator.tool.js';
import {
  blankAsUnset,
  blankFreeArray,
  blockquote,
  splitIdArray,
  tableCell,
} from '@/mcp-server/tools/tool-helpers.js';
import { guardNetwork } from '../helpers/network-guard.js';

guardNetwork();

describe('blankAsUnset', () => {
  const schema = z.object({
    code: blankAsUnset(
      z
        .string()
        .regex(/^[A-Z]+$/)
        .optional(),
    ),
  });

  it('reads an empty or whitespace-only string as unset', () => {
    expect(schema.parse({ code: '' })).toEqual({});
    expect(schema.parse({ code: '   ' })).toEqual({});
  });

  it('trims a value before the inner schema checks it', () => {
    expect(schema.parse({ code: '  LFS ' })).toEqual({ code: 'LFS' });
  });

  it('still rejects a value the inner schema rejects', () => {
    expect(() => schema.parse({ code: 'lfs' })).toThrow();
  });
});

describe('blankFreeArray', () => {
  const schema = z.object({ codes: blankFreeArray(z.array(z.string()).max(2).optional()) });

  it('trims elements and drops blank ones before the inner schema runs', () => {
    expect(schema.parse({ codes: [' USA ', '', '  ', 'KEN'] })).toEqual({ codes: ['USA', 'KEN'] });
  });

  it('applies the cap after the blanks are gone', () => {
    expect(() => schema.parse({ codes: ['A', 'B', 'C'] })).toThrow();
    expect(schema.parse({ codes: ['A', '', 'B', ''] }).codes).toEqual(['A', 'B']);
  });

  it('reads a bare string as a one-element array, and a blank one as unset', () => {
    expect(schema.parse({ codes: ' KEN ' })).toEqual({ codes: ['KEN'] });
    expect(schema.parse({ codes: '  ' })).toEqual({});
  });
});

describe('splitIdArray', () => {
  const schema = z.object({ ids: splitIdArray(z.array(z.string()).min(1).max(3)) });

  it('splits a bare joined string the same way as a joined element', () => {
    expect(schema.parse({ ids: 'A_A' })).toEqual({ ids: ['A_A'] });
    expect(schema.parse({ ids: ' A_A + B_A,C_A ' })).toEqual({ ids: ['A_A', 'B_A', 'C_A'] });
    expect(schema.parse({ ids: ['A_A+B_A'] })).toEqual({ ids: ['A_A', 'B_A'] });
  });
});

describe('query_indicator array inputs', () => {
  it('accepts a single code where the schema takes an array', () => {
    const parsed = queryIndicatorTool.input.parse({
      dataset_ids: 'UNE_DEAP_SEX_AGE_RT_A',
      ref_areas: 'KEN',
      sex: 'SEX_T',
      classif1: 'AGE_YTHADULT_YGE15',
    });
    expect(parsed).toMatchObject({
      dataset_ids: ['UNE_DEAP_SEX_AGE_RT_A'],
      ref_areas: ['KEN'],
      sex: ['SEX_T'],
      classif1: ['AGE_YTHADULT_YGE15'],
    });
  });
});

describe('blockquote', () => {
  it('prefixes every line, whatever the line ending, so none escapes the quote', () => {
    expect(blockquote('first\r\nsecond\rthird\n# not a heading')).toBe(
      '> first\n> second\n> third\n> # not a heading',
    );
  });

  it('prefixes the line after a Unicode line terminator (NEL, LS, PS)', () => {
    expect(blockquote('first\u0085second\u2028third\u2029# not a heading')).toBe(
      '> first\n> second\n> third\n> # not a heading',
    );
  });
});

describe('tableCell', () => {
  it('flattens every line terminator to a space, then escapes backslashes and pipes', () => {
    expect(tableCell('a\r\n| forged |\u0085b\u2028c\u2029d\\e')).toBe(
      'a \\| forged \\| b c d\\\\e',
    );
  });

  it('with a line-break string, puts one per break (CRLF is one) and leaves no terminator', () => {
    expect(tableCell('a\u2028| forged |\u2029b\u0085c\r\nd\ne\rf', '<br>')).toBe(
      'a<br>\\| forged \\|<br>b<br>c<br>d<br>e<br>f',
    );
  });
});
