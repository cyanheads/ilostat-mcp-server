/**
 * @fileoverview Tests for the shared tool input and rendering helpers: blank strings
 * and blank array elements from form clients read as unset, and multi-line
 * ILO-published text stays inside its markdown blockquote.
 * @module tests/tools/tool-helpers.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { blankAsUnset, blankFreeArray, blockquote } from '@/mcp-server/tools/tool-helpers.js';
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
});

describe('blockquote', () => {
  it('prefixes every line, whatever the line ending, so none escapes the quote', () => {
    expect(blockquote('first\r\nsecond\rthird\n# not a heading')).toBe(
      '> first\n> second\n> third\n> # not a heading',
    );
  });
});
