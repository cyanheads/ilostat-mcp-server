/**
 * @fileoverview Tests for `scanSql`, the one left-to-right pass that finds the
 * `df_` names an `ilostat_dataframe_query` statement names as identifiers and
 * whether it reads: line comments (ended by LF or CR), nested block comments,
 * `'…'` literals, `E'…'` strings with backslash escapes, and `$tag$…$tag$`
 * strings are skipped; bare and double-quoted identifiers are read whole; and a
 * 20,000-character adversarial input finishes in linear time.
 * @module tests/services/canvas-bridge/scan-sql.test
 */

import { describe, expect, it } from 'vitest';
import { scanSql } from '@/services/canvas-bridge/scan-sql.js';

describe('scanSql', () => {
  it.each([
    ['a bare name, folded', 'SELECT * FROM df_abcde_12345', ['df_ABCDE_12345']],
    [
      'double-quoted and schema-qualified names',
      'SELECT "we""ird" FROM "DF_aaaaa_11111", main.df_BBBBB_22222',
      ['df_AAAAA_11111', 'df_BBBBB_22222'],
    ],
    [
      'each name once',
      'SELECT * FROM df_AAAAA_11111 a JOIN DF_aaaaa_11111 b USING (k)',
      ['df_AAAAA_11111'],
    ],
    ['a line comment ended by CR', "-- it's\rSELECT 1 FROM df_AAAAA_11111", ['df_AAAAA_11111']],
    ['a nested block comment', '/* a /* b */ df_AAAAA_11111 */ SELECT 1', []],
    [
      "'…', E'…' with a backslash-escaped quote, and $tag$ strings",
      "SELECT 'df_AAAAA_11111', E'\\'df_BBBBB_22222', $t$ df_CCCCC_33333 $t$, $$df_DDDDD_44444$$",
      [],
    ],
    ['an identifier holding $$', 'SELECT a$$b FROM df_AAAAA_11111', ['df_AAAAA_11111']],
    [
      'a df_ shape inside a longer identifier',
      'SELECT 1 FROM df_AAAAA_11111x, my_df_BBBBB_22222, "df_CCCCC_33333 x"',
      [],
    ],
    ['an unterminated string', "SELECT 'df_AAAAA_11111 FROM df_BBBBB_22222", []],
    ['an unterminated block comment', 'SELECT 1 /* df_AAAAA_11111', []],
  ])('finds the dataframes named by identifiers past %s', (_label, sql, dataframes) => {
    expect(scanSql(sql).dataframes).toEqual(dataframes);
  });

  it.each([
    ['SELECT', 'SELECT 1', true],
    ['WITH', 'with x AS (SELECT 1) SELECT * FROM x', true],
    ['FROM', 'FROM df_AAAAA_11111', true],
    ['a parenthesis', '(SELECT 1)', true],
    ['comments first', "-- it's\n/* a /* b */ c */ SELECT 1", true],
    ['DROP', 'DROP TABLE df_AAAAA_11111', false],
    ['a longer identifier', 'selectx 1', false],
    ['a quoted identifier', '"select" 1', false],
    ['a string', "'SELECT' 1", false],
  ])('reads when the first token is SELECT, WITH, FROM, or ( — here %s', (_label, sql, reads) => {
    expect(scanSql(sql).reads).toBe(reads);
  });

  it.each([
    ["'", "'".repeat(20_000)],
    ['"', '"'.repeat(20_000)],
    ['/* */', '/* */'.repeat(4_000)],
    ['--', "--'\n".repeat(5_000)],
    ['$a', '$a'.repeat(10_000)],
    ['$', '$'.repeat(20_000)],
    ["E'\\", "E'\\".repeat(6_667)],
    ['df_', 'df_AAAAA_11111 '.repeat(1_334)],
  ])('scans 20,000 characters of %s in under 50 ms', (_label, sql) => {
    const started = performance.now();
    scanSql(sql);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
