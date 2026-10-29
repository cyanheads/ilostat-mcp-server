/**
 * @fileoverview Tests for `scanSql`, the one left-to-right pass that finds the
 * `df_` names an `ilostat_dataframe_query` statement names as identifiers and
 * whether it reads: line comments (ended by LF or CR), nested block comments,
 * `'…'` literals, `E'…'` strings with backslash escapes, and `$tag$…$tag$`
 * strings are skipped; bare and double-quoted identifiers are read whole; the
 * SQL of a `query()` call over one string literal is read as DuckDB unescapes
 * it, through every form the canvas gate admits, in every position where DuckDB
 * runs it as a call, and down to the gate's four nesting levels, and no other
 * literal is, a table alias's or CTE's column list after `query` included; and
 * adversarial inputs, nested `query()` bodies among them, scale linearly in CPU
 * time.
 * @module tests/services/canvas-bridge/scan-sql.test
 */

import { describe, expect, it } from 'vitest';
import { scanSql } from '@/services/canvas-bridge/scan-sql.js';

const A = 'df_AAAAA_11111';
const B = 'df_BBBBB_22222';
/** The name read at each `query()` depth by {@link nestedNaming}: depth 0 is the statement itself. */
const AT_DEPTH = [0, 1, 2, 3, 4, 5].map((depth) => `df_DEPTH_0000${depth}`);

/**
 * A statement whose `query()` literals nest `depth` deep, each a `'…'` literal
 * with its quotes doubled once per level, the SQL at each depth reading
 * {@link AT_DEPTH} for that depth.
 */
function nestedNaming(depth: number): string {
  let sql = `SELECT * FROM ${AT_DEPTH[depth]}`;
  for (let level = depth - 1; level >= 0; level--) {
    sql = `SELECT * FROM ${AT_DEPTH[level]}, query('${sql.replaceAll("'", "''")}')`;
  }
  return sql;
}

/** `statement` as the SQL of a `query()` literal one level down, its quotes doubled. */
function inQueryBody(statement: string): string {
  return `SELECT * FROM query('${statement.replaceAll("'", "''")}')`;
}

/** A `query()` call whose SQL reads {@link A}. */
const CALL = `query('SELECT * FROM ${A}')`;

/** Positions where DuckDB 1.5.6 runs `query(…)` as a table function: each statement reads {@link A} through {@link CALL}. */
const CALL_POSITIONS: [label: string, sql: string][] = [
  ['after FROM', `SELECT * FROM ${CALL}`],
  ['in a FROM-first statement', `FROM ${CALL} SELECT *`],
  ['after JOIN, with ON', `SELECT * FROM t JOIN ${CALL} ON true`],
  ['after CROSS JOIN', `SELECT * FROM t CROSS JOIN ${CALL}`],
  ['after LEFT OUTER JOIN, with USING', `SELECT * FROM t LEFT OUTER JOIN ${CALL} USING (k)`],
  ['after a comma in a FROM list', `SELECT * FROM t, ${CALL}`],
  ['after a comma past a JOIN … USING (k)', `SELECT * FROM t JOIN u USING (k), ${CALL}`],
  ['after a comma past a subquery', `SELECT * FROM (SELECT a, b FROM t) s, ${CALL}`],
  ['after a comma in a FROM-first list', `FROM t, ${CALL} SELECT *`],
  [
    'after a comma in a FROM past a CTE list',
    `WITH c AS (SELECT 1), d AS (SELECT 2) SELECT * FROM c, ${CALL}`,
  ],
  ['after LATERAL', `SELECT * FROM t, LATERAL ${CALL}`],
  ['after JOIN LATERAL', `SELECT * FROM t JOIN LATERAL ${CALL} ON true`],
  ['qualified main.', `SELECT * FROM main.${CALL}`],
  ['qualified system.main.', `SELECT * FROM system.main.${CALL}`],
  ['after PIVOT', `PIVOT ${CALL} ON k IN ('x') USING count(*)`],
  ['after UNPIVOT', `UNPIVOT ${CALL} ON k INTO NAME n VALUE v`],
  ['in an IN (FROM …) subquery', `SELECT * FROM t WHERE k IN (FROM ${CALL})`],
  ['after a block comment', `SELECT * FROM /* c */ ${CALL}`],
  ['after a line comment', `SELECT * FROM t JOIN -- c\n${CALL} ON true`],
];

/**
 * `query` followed by a parenthesized literal that DuckDB 1.5.6 does not run as a
 * call: a table alias's or CTE's column list (each statement runs, reading
 * {@link A} only), or a parenthesized `query(…)`, which does not parse.
 */
const NOT_CALLS: [label: string, sql: string][] = [
  ['an alias AS query', `SELECT * FROM ${A} AS query ('${B}')`],
  ['an implicit alias query', `SELECT * FROM ${A} query ('${B}')`],
  ['an alias AS "query"', `SELECT * FROM ${A} AS "query" ('${B}')`],
  ['an alias AS QUERY past a comment', `SELECT * FROM ${A} AS /* c */ QUERY ('${B}')`],
  ['an implicit "query" after a quoted name', `SELECT * FROM "${A}" "query" ('${B}')`],
  ['an implicit alias after a qualified name', `SELECT * FROM main.${A} query ('${B}')`],
  ['an implicit alias after a query() call', `SELECT * FROM ${CALL} query ('${B}')`],
  ['an implicit alias after a subquery', `SELECT * FROM (FROM ${A}) query ('${B}')`],
  ['an alias before USING SAMPLE', `SELECT * FROM ${A} query ('${B}') USING SAMPLE 100%`],
  ['a leading CTE name', `WITH query ('${B}') AS (SELECT * FROM ${A}) SELECT * FROM query`],
  [
    'a CTE name after a comma, past a FROM in the CTE before it',
    `WITH x AS (SELECT * FROM ${A}), query ('${B}') AS (SELECT 1) SELECT * FROM x`,
  ],
  [
    'a MATERIALIZED CTE name after a comma',
    `WITH x AS (SELECT 1), query ('${B}') AS MATERIALIZED (SELECT * FROM ${A}) SELECT * FROM query`,
  ],
  ['a parenthesized query()', `SELECT * FROM ${A} JOIN (query('SELECT * FROM ${B}')) ON true`],
];

/** The same nesting written with `$tag$` literals, which need no escaping at any depth. */
function nestedDollarNaming(depth: number): string {
  let sql = `SELECT * FROM ${AT_DEPTH[depth]}`;
  for (let level = depth - 1; level >= 0; level--) {
    sql = `SELECT * FROM ${AT_DEPTH[level]}, query($t${level}$${sql}$t${level}$)`;
  }
  return sql;
}

describe('scanSql', () => {
  it.each([
    ['a bare name, folded', 'SELECT * FROM df_abcde_12345', ['df_ABCDE_12345']],
    [
      'double-quoted and schema-qualified names',
      'SELECT "we""ird" FROM "DF_aaaaa_11111", main.df_BBBBB_22222',
      [A, B],
    ],
    ['each name once', `SELECT * FROM ${A} a JOIN DF_aaaaa_11111 b USING (k)`, [A]],
    ['a line comment ended by CR', `-- it's\rSELECT 1 FROM ${A}`, [A]],
    ['a nested block comment', `/* a /* b */ ${A} */ SELECT 1`, []],
    [
      "'…', E'…' with a backslash-escaped quote, and $tag$ strings",
      `SELECT '${A}', E'\\'${B}', $t$ df_CCCCC_33333 $t$, $$df_DDDDD_44444$$`,
      [],
    ],
    ['an identifier holding $$', `SELECT a$$b FROM ${A}`, [A]],
    [
      'a df_ shape inside a longer identifier',
      `SELECT 1 FROM ${A}x, my_${B}, "df_CCCCC_33333 x"`,
      [],
    ],
    ['an unterminated string', `SELECT '${A} FROM ${B}`, []],
    ['an unterminated block comment', `SELECT 1 /* ${A}`, []],
  ])('finds the dataframes named by identifiers past %s', (_label, sql, dataframes) => {
    expect(scanSql(sql).dataframes).toEqual(dataframes);
  });

  it.each([
    ["a '…' body", `SELECT * FROM query('SELECT * FROM ${A}')`],
    [
      "a '…' body whose doubled quotes hold an apostrophe before the name",
      `SELECT * FROM query('SELECT ''it''''s'' AS s, * FROM ${A}')`,
    ],
    [
      "an E'…' body with a backslash-escaped quote",
      `SELECT * FROM query(E'SELECT \\'it\\'\\'s\\' AS s, * FROM ${A}')`,
    ],
    [
      "an E'…' body naming it in hex escapes",
      `SELECT * FROM query(E'SELECT * FROM \\x64\\x66_AAAAA_11111')`,
    ],
    [
      "an e'…' body naming it in octal escapes",
      `SELECT * FROM query(e'SELECT * FROM \\144\\146_AAAAA_11111')`,
    ],
    ['a $$ body holding an apostrophe', `SELECT * FROM query($$SELECT 'it''s', * FROM ${A}$$)`],
    ['a $tag$ body', `SELECT * FROM query($q$SELECT * FROM ${A}$q$)`],
    ['a literal in parentheses', `SELECT * FROM query((('SELECT * FROM ${A}')))`],
    ['literals joined across LF', `SELECT * FROM query('SELECT * FROM '\n'${A}')`],
    ['literals joined across CR', `SELECT * FROM query('SELECT * '\r'FROM '\r\n'${A}')`],
    [
      'literals joined across a line comment and blank lines',
      `SELECT * FROM query('SELECT * FROM ' -- part one\n\t\f\n  -- part two\n'${A}')`,
    ],
    [
      "E'…' joined to a '…' that keeps its escapes",
      `SELECT * FROM query(E'SELECT * FROM '\n'\\x64f_AAAAA_11111')`,
    ],
    ['a parenthesized joined literal', `SELECT * FROM query(('SELECT * FROM '\n'${A}'))`],
    ['QUERY spaced from its parenthesis', `SELECT * FROM QUERY ( 'SELECT * FROM ${A}' )`],
    [
      'comments around the call',
      `SELECT * FROM QuErY /* a */ ( -- b\n 'SELECT * FROM ${A}' /* c */ )`,
    ],
    ['main.query', `SELECT * FROM main.query('SELECT * FROM ${A}')`],
    ['system.main.query', `SELECT * FROM system.main.query('SELECT * FROM ${A}')`],
    ['a double-quoted "query"', `SELECT * FROM "query"('SELECT * FROM ${A}')`],
    ['a double-quoted "QUERY"', `SELECT * FROM "main"."QUERY"('SELECT * FROM ${A}')`],
    ['a scalar subquery', `SELECT (SELECT count(*) FROM query('SELECT * FROM ${A}')) AS n`],
  ])('reads the dataframe in the SQL of a query() call over %s', (_label, sql) => {
    expect(scanSql(sql).dataframes).toEqual([A]);
  });

  it.each(CALL_POSITIONS)(
    'reads the SQL of a query() call %s, at the top and inside a query() body',
    (_label, sql) => {
      expect(scanSql(sql).dataframes).toEqual([A]);
      expect(scanSql(inQueryBody(sql)).dataframes).toEqual([A]);
    },
  );

  it.each(NOT_CALLS)(
    'reads no SQL from query and a literal in %s, at the top and inside a query() body',
    (_label, sql) => {
      expect(scanSql(sql).dataframes).toEqual([A]);
      expect(scanSql(inQueryBody(sql)).dataframes).toEqual([A]);
    },
  );

  it.each([
    ['an ordinary literal', `SELECT * FROM ${B} WHERE c = '${A}'`],
    ["another function's string argument", `SELECT upper('SELECT * FROM ${A}') FROM ${B}`],
    ["query_table()'s string argument", `SELECT * FROM ${B}, query_table('${A}')`],
    ['a line comment inside a query() body', `SELECT * FROM query('SELECT * FROM ${B} -- ${A}')`],
    [
      'a block comment inside a query() body',
      `SELECT * FROM query('SELECT * FROM ${B} /* ${A} */')`,
    ],
    ['a literal inside a query() body', `SELECT * FROM query('SELECT ''${A}'' AS s, * FROM ${B}')`],
    [
      'a literal inside a query() body read from a $tag$',
      `SELECT * FROM query($q$SELECT '${A}' AS s, * FROM ${B}$q$)`,
    ],
  ])('never reads a df_ name in %s', (_label, sql) => {
    expect(scanSql(sql).dataframes).toEqual([B]);
  });

  it.each([
    ['an expression', `SELECT * FROM query('SELECT * FROM ${A}' || '')`],
    ['a cast', `SELECT * FROM query('SELECT * FROM ${A}'::VARCHAR)`],
    ['a second argument', `SELECT * FROM query('SELECT * FROM ${A}', 'x')`],
    ['a named argument', `SELECT * FROM query(sql := 'SELECT * FROM ${A}')`],
    ['an N-string, which parses as a cast', `SELECT * FROM query(N'SELECT * FROM ${A}')`],
    ['literals adjacent on one line', `SELECT * FROM query('SELECT * FROM ' '${A}')`],
    ['a block comment between literals', `SELECT * FROM query('SELECT * FROM '\n/* c */\n'${A}')`],
    [
      "a $$ literal before a line break and a '…'",
      `SELECT * FROM query($$SELECT * FROM $$\n'${A}')`,
    ],
    ["a '…' before a line break and an E'…'", `SELECT * FROM query('SELECT * FROM '\nE'${A}')`],
    ['an unclosed call', `SELECT * FROM query('SELECT * FROM ${A}'`],
    ['an unterminated literal', `SELECT * FROM query('SELECT * FROM ${A}`],
    ['query_table()', `SELECT * FROM query_table('SELECT * FROM ${A}')`],
  ])('reads no SQL from a query() call the gate refuses — over %s', (_label, sql) => {
    expect(scanSql(sql).dataframes).toEqual([]);
  });

  it.each([
    [1, AT_DEPTH.slice(0, 2)],
    [2, AT_DEPTH.slice(0, 3)],
    [4, AT_DEPTH.slice(0, 5)],
    [5, AT_DEPTH.slice(0, 5)],
  ])(
    'reads query() literals nested %i deep down to depth 4, the gate’s limit, and no deeper',
    (depth, dataframes) => {
      expect(scanSql(nestedNaming(depth)).dataframes).toEqual(dataframes);
      expect(scanSql(nestedDollarNaming(depth)).dataframes).toEqual(dataframes);
    },
  );

  it('lists names in order of first use, a name inside a query() body where the call stands', () => {
    expect(
      scanSql(`SELECT * FROM ${B}, query('SELECT * FROM ${A}'), DF_bbbbb_22222, df_CCCCC_33333`)
        .dataframes,
    ).toEqual([B, A, 'df_CCCCC_33333']);
  });

  it.each([
    ['SELECT', 'SELECT 1', true],
    ['WITH', 'with x AS (SELECT 1) SELECT * FROM x', true],
    ['FROM', `FROM ${A}`, true],
    ['a parenthesis', '(SELECT 1)', true],
    ['comments first', "-- it's\n/* a /* b */ c */ SELECT 1", true],
    ['FROM query()', `FROM query('SELECT * FROM ${A}')`, true],
    ['DROP', `DROP TABLE ${A}`, false],
    ['a longer identifier', 'selectx 1', false],
    ['a quoted identifier', '"select" 1', false],
    ['a string', "'SELECT' 1", false],
    ['query() alone', `query('SELECT * FROM ${A}')`, false],
  ])('reads when the first token is SELECT, WITH, FROM, or ( — here %s', (_label, sql, reads) => {
    expect(scanSql(sql).reads).toBe(reads);
  });
});

/**
 * CPU-time shapes, each `[label, build, top]`: `build(n)` makes an input of at
 * least `n` characters, and the input doubles from {@link FIRST_SIZE} to `top`.
 * Bun's regex engine can run a shape ~33× slower past ~80,000 characters, so most
 * stop there; a digit run and the two line-break shapes, linear to 320,000 on
 * both runtimes, carry the full 64× span.
 */
type Shape = [label: string, build: (size: number) => string, top: number];

const FIRST_SIZE = 5_000;
const repeated =
  (unit: string) =>
  (size: number): string =>
    unit.repeat(Math.ceil(size / unit.length));

/** Closed `query($tN$…$tN$)` bodies nested ~30 characters a level, each tag distinct. */
function dollarNested(size: number): string {
  const opens: string[] = [];
  const closes: string[] = [];
  let length = A.length;
  for (let level = 0; length < size; level++) {
    const open = `SELECT * FROM query($t${level}$`;
    const close = `$t${level}$)`;
    opens.push(open);
    closes.push(close);
    length += open.length + close.length;
  }
  return `${opens.join('')}${A}${closes.reverse().join('')}`;
}

/** Unclosed `FROM query('FROM query(''…` openers, each level doubling the quotes before it. */
function quoteNestedOpeners(size: number): string {
  let sql = '';
  for (let level = 0; sql.length < size; level++) sql += `FROM query(${"'".repeat(2 ** level)}`;
  return sql;
}

const SHAPES: Shape[] = [
  ['a digit run', repeated('1'), 320_000],
  [
    "one long line ending in a break ('§1 x' … '\\ny')",
    (size) => `${repeated('§1 x')(size)}\ny`,
    320_000,
  ],
  ["breaks throughout ('  \\r\\n')", repeated('  \r\n'), 320_000],
  ["repeated '", repeated("'"), 80_000],
  ['repeated "', repeated('"'), 80_000],
  ['repeated /* */', repeated('/* */'), 80_000],
  ["repeated --'\\n", repeated("--'\n"), 80_000],
  ['repeated $a', repeated('$a'), 80_000],
  ['repeated $', repeated('$'), 80_000],
  ["repeated E'\\", repeated("E'\\"), 80_000],
  ['repeated df_ names', repeated(`${A} `), 80_000],
  ["repeated FROM query(' with no closer", repeated("FROM query('"), 80_000],
  ['repeated $$ with no closer', repeated('$$'), 80_000],
  ["repeated E' with no closer", repeated("E'"), 80_000],
  ["nested FROM query(' openers", quoteNestedOpeners, 80_000],
  ['$tag$-nested query() bodies', dollarNested, 80_000],
  ['repeated FROM query(', repeated('FROM query('), 80_000],
  ['repeated FROM query((((', repeated('FROM query(((('), 80_000],
  ["repeated FROM query('a' line-joined", repeated("FROM query('a'\n"), 80_000],
  ["repeated FROM query('a')", repeated("FROM query('a') "), 80_000],
  [
    'repeated FROM query() over a line-broken run',
    (size) => `FROM query('a'${repeated('  \r\n')(size)}`,
    80_000,
  ],
  ['repeated (', repeated('('), 80_000],
  ['repeated (FROM t, query(', repeated('(FROM t, query('), 80_000],
];

describe('scanSql CPU time', () => {
  it.each(SHAPES)(
    'scans %s in linear CPU time as the input doubles',
    (_label, build, top) => {
      const sizes: number[] = [];
      for (let size = FIRST_SIZE; size <= top; size *= 2) sizes.push(size);
      for (const size of sizes) {
        const sql = build(size);
        // Checked before the next doubling, so a quadratic scan fails at a small size, in seconds.
        expect(bestMicrosPerCall(() => scanSql(sql), callsFor(sql))).toBeLessThan(
          sql.length * MICROS_PER_CHAR,
        );
      }
      const [small = '', large = ''] = [sizes[0], sizes.at(-1)].map((size) => build(size ?? 0));
      const cost = perCallCpuMicros(
        () => scanSql(small),
        () => scanSql(large),
        callsFor(small),
        callsFor(large),
      );
      const span = large.length / small.length;
      // A linear scan costs about span× per call, a quadratic one span²× (4,096× over 64×).
      expect(cost.large / cost.small).toBeLessThan(4 * span);
    },
    // CPU time is what is asserted; the wall clock of a loaded machine is not.
    60_000,
  );
});

/**
 * The CPU bound per input character: every shape measures under 0.03 µs a
 * character on Bun and Node at every size; `query()` bodies rescanned at every
 * depth, uncapped, pass this by 40,000 characters of `$tag$` nesting.
 */
const MICROS_PER_CHAR = 0.25;
/** Characters each timed batch scans, so every size is measured over the same work. */
const BATCH_CHARS = 640_000;
/** CPU microseconds after which sampling one size stops. */
const SAMPLING_BUDGET = 500_000;

function callsFor(sql: string): number {
  return Math.max(1, Math.round(BATCH_CHARS / sql.length));
}

/** CPU microseconds (user + system, this thread) of `calls` calls of `run`. */
function cpuMicros(run: () => void, calls: number): number {
  const start = process.threadCpuUsage();
  for (let call = 0; call < calls; call += 1) run();
  const used = process.threadCpuUsage(start);
  return used.user + used.system;
}

/** Fewest CPU microseconds per call of `run`, over up to five batches or {@link SAMPLING_BUDGET}. */
function bestMicrosPerCall(run: () => void, calls: number): number {
  run();
  let best = Number.POSITIVE_INFINITY;
  let spent = 0;
  for (let round = 0; round < 5 && spent < SAMPLING_BUDGET; round += 1) {
    const used = cpuMicros(run, calls);
    best = Math.min(best, used / calls);
    spent += used;
  }
  return best;
}

/**
 * Fewest CPU microseconds per call of `small` and of `large`, over up to seven rounds
 * that each run one batch of both, in alternating order, so the two sizes are measured
 * under the same core, clock, and heap conditions.
 */
function perCallCpuMicros(
  small: () => void,
  large: () => void,
  smallCalls: number,
  largeCalls: number,
): { large: number; small: number } {
  small();
  large();
  let smallBest = Number.POSITIVE_INFINITY;
  let largeBest = Number.POSITIVE_INFINITY;
  let spent = 0;
  for (let round = 0; round < 7 && spent < SAMPLING_BUDGET; round += 1) {
    const smallFirst = round % 2 === 0;
    const first = smallFirst ? cpuMicros(small, smallCalls) : cpuMicros(large, largeCalls);
    const second = smallFirst ? cpuMicros(large, largeCalls) : cpuMicros(small, smallCalls);
    const [smallCost, largeCost] = smallFirst ? [first, second] : [second, first];
    smallBest = Math.min(smallBest, smallCost);
    largeBest = Math.min(largeBest, largeCost);
    spent += first + second;
  }
  return { small: smallBest / smallCalls, large: largeBest / largeCalls };
}
