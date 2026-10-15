/**
 * @fileoverview Tests for `scanSql`, the one left-to-right pass that finds the
 * `df_` names an `ilostat_dataframe_query` statement names as identifiers and
 * whether it reads: line comments (ended by LF or CR), nested block comments,
 * `'…'` literals, `E'…'` strings with backslash escapes, and `$tag$…$tag$`
 * strings are skipped; bare and double-quoted identifiers are read whole; and
 * adversarial inputs scale linearly in CPU time from 640 to 40,960 characters.
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
    ["'", "'"],
    ['"', '"'],
    ['/* */', '/* */'],
    ['--', "--'\n"],
    ['$a', '$a'],
    ['$', '$'],
    ["E'\\", "E'\\"],
    ['df_', 'df_AAAAA_11111 '],
  ])(
    'scans repeated %s in linear CPU time from 640 to 40,960 characters',
    (_label, unit) => {
      const [small = '', large = ''] = [SMALL, LARGE].map((size) =>
        unit.repeat(Math.ceil(size / unit.length)),
      );
      const cost = perCallCpuMicros(
        () => scanSql(small),
        () => scanSql(large),
      );
      // 64× the input: a linear scan costs about 64× per call (41–70× measured), a quadratic one about 4,096×.
      expect(cost.large / cost.small).toBeLessThan(256);
      // One scan of 40,960 characters: under 1 ms measured; a quadratic scan takes tens to hundreds.
      expect(cost.large).toBeLessThan(20_000);
    },
    // CPU time is what is asserted; the wall clock of a loaded machine is not.
    60_000,
  );
});

const SMALL = 640;
const LARGE = 40_960;
/** Calls in a batch of the large input; a small batch makes 64× the calls, so both scan as many characters. */
const LARGE_CALLS = 2;
const SMALL_CALLS = LARGE_CALLS * (LARGE / SMALL);
/** CPU microseconds after which sampling stops: a linear scan spends under 50 ms in all seven rounds. */
const SAMPLING_BUDGET = 500_000;

/** CPU microseconds (user + system, this thread) of `calls` calls of `run`. */
function cpuMicros(run: () => void, calls: number): number {
  const start = process.threadCpuUsage();
  for (let call = 0; call < calls; call += 1) run();
  const used = process.threadCpuUsage(start);
  return used.user + used.system;
}

/**
 * Fewest CPU microseconds per call of `small` and of `large`, over up to seven rounds
 * that each run one batch of both, in alternating order, so the two sizes are measured
 * under the same core, clock, and heap conditions. Sampling ends early once
 * {@link SAMPLING_BUDGET} is spent, so a quadratic scan fails in seconds, not minutes.
 */
function perCallCpuMicros(small: () => void, large: () => void): { large: number; small: number } {
  small();
  large();
  let smallBest = Number.POSITIVE_INFINITY;
  let largeBest = Number.POSITIVE_INFINITY;
  let spent = 0;
  for (let round = 0; round < 7 && spent < SAMPLING_BUDGET; round += 1) {
    const smallFirst = round % 2 === 0;
    const first = smallFirst ? cpuMicros(small, SMALL_CALLS) : cpuMicros(large, LARGE_CALLS);
    const second = smallFirst ? cpuMicros(large, LARGE_CALLS) : cpuMicros(small, SMALL_CALLS);
    const [smallCost, largeCost] = smallFirst ? [first, second] : [second, first];
    smallBest = Math.min(smallBest, smallCost);
    largeBest = Math.min(largeBest, largeCost);
    spent += first + second;
  }
  return { small: smallBest / SMALL_CALLS, large: largeBest / LARGE_CALLS };
}
