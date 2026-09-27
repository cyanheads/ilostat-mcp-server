/**
 * @fileoverview One left-to-right pass over an `ilostat_dataframe_query` statement,
 * following DuckDB's lexer: the `df_` dataframe names it uses as identifiers and
 * whether it reads. Comments and string literals are skipped, so a name inside
 * one is never a reference, and an apostrophe inside one never opens a literal
 * that hides a later name. Every character is consumed once, so the pass is
 * linear in the statement's length.
 * @module services/canvas-bridge/scan-sql
 */

/** What {@link scanSql} found in a statement. */
export interface SqlScan {
  /**
   * `df_` names used as identifiers, bare or double-quoted, in any case, folded
   * to the minted `df_XXXXX_XXXXX` form (DuckDB identifiers are case-insensitive),
   * each once, in order of first use. A name in alias or CTE position counts too:
   * telling those apart needs a parser.
   */
  dataframes: string[];
  /** The first token opens a read: `(` or one of {@link READ_KEYWORDS}. */
  reads: boolean;
}

const DATAFRAME_NAME = /^df_[A-Za-z0-9]{5}_[A-Za-z0-9]{5}$/i;
/**
 * Keywords that open a read. `EXPLAIN` is not one: it also wraps writes, and a
 * write naming a missing table is not fixed by staging it.
 */
const READ_KEYWORDS = new Set([
  'select',
  'with',
  'from',
  'values',
  'table',
  'pivot',
  'unpivot',
  'summarize',
  'describe',
  'show',
]);
/** DuckDB's lexer reads every byte from 0x80 up as an identifier character, and `$` after the first. */
const IDENTIFIER = /[A-Za-z_\u0080-￿][\w$\u0080-￿]*/y;
/** `$$` or `$tag$`; a tag never starts with a digit and never holds `$`. */
const DOLLAR_DELIMITER = /\$(?:[A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/y;
const SPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);

/** The match of a sticky `pattern` at `index`. */
function matchAt(pattern: RegExp, sql: string, index: number): string | undefined {
  pattern.lastIndex = index;
  return pattern.exec(sql)?.[0];
}

/**
 * The index just past a quoted token whose body starts at `from`: a doubled
 * `quote` is part of the body, and so is a backslash-escaped character when
 * `backslash` (an `E'…'` string). An unterminated token runs to the end.
 */
function quotedEnd(sql: string, from: number, quote: string, backslash: boolean): number {
  let index = from;
  while (index < sql.length) {
    const char = sql[index];
    if (backslash && char === '\\') index += 2;
    else if (char !== quote) index++;
    else if (sql[index + 1] === quote) index += 2;
    else return index + 1;
  }
  return sql.length;
}

/** The index just past a block comment whose body starts at `from`; block comments nest. */
function blockCommentEnd(sql: string, from: number): number {
  let depth = 1;
  let index = from;
  while (index < sql.length) {
    if (sql[index] === '/' && sql[index + 1] === '*') {
      depth++;
      index += 2;
    } else if (sql[index] === '*' && sql[index + 1] === '/') {
      index += 2;
      if (--depth === 0) return index;
    } else {
      index++;
    }
  }
  return sql.length;
}

/** The index of the LF or CR that ends a `--` comment whose body starts at `from`. */
function lineCommentEnd(sql: string, from: number): number {
  let index = from;
  while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index++;
  return index;
}

/** `identifier` folded to the minted `df_XXXXX_XXXXX` form, when it is a whole `df_` name. */
export function mintedDataframeName(identifier: string): string | undefined {
  return DATAFRAME_NAME.test(identifier) ? `df_${identifier.slice(3).toUpperCase()}` : undefined;
}

/** Adds `identifier` to `dataframes`, folded, when it is a whole `df_` name. */
function recordDataframe(dataframes: Set<string>, identifier: string): void {
  const name = mintedDataframeName(identifier);
  if (name) dataframes.add(name);
}

/** The index just past the token at `index`, recording a `df_` identifier in `dataframes`. */
function tokenEnd(sql: string, index: number, dataframes: Set<string>): number {
  const char = sql[index];
  if (char === "'") return quotedEnd(sql, index + 1, "'", false);
  if (char === '"') {
    const end = quotedEnd(sql, index + 1, '"', false);
    recordDataframe(dataframes, sql.slice(index + 1, end - 1).replaceAll('""', '"'));
    return end;
  }
  const delimiter = char === '$' ? matchAt(DOLLAR_DELIMITER, sql, index) : undefined;
  if (delimiter) {
    const close = sql.indexOf(delimiter, index + delimiter.length);
    return close === -1 ? sql.length : close + delimiter.length;
  }
  const word = matchAt(IDENTIFIER, sql, index);
  if (!word) return index + 1;
  if ((word === 'E' || word === 'e') && sql[index + 1] === "'") {
    return quotedEnd(sql, index + 2, "'", true);
  }
  recordDataframe(dataframes, word);
  return index + word.length;
}

/** Whether the token at `first` opens a read: `(` or one of {@link READ_KEYWORDS}. */
function opensRead(sql: string, first: number | undefined): boolean {
  if (first === undefined) return false;
  if (sql[first] === '(') return true;
  return READ_KEYWORDS.has(matchAt(IDENTIFIER, sql, first)?.toLowerCase() ?? '');
}

/** Scans `sql` once for the `df_` identifiers it names and whether it reads. */
export function scanSql(sql: string): SqlScan {
  const dataframes = new Set<string>();
  let first: number | undefined;
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] as string;
    if (SPACE.has(char)) {
      index++;
    } else if (char === '-' && sql[index + 1] === '-') {
      index = lineCommentEnd(sql, index + 2);
    } else if (char === '/' && sql[index + 1] === '*') {
      index = blockCommentEnd(sql, index + 2);
    } else {
      first ??= index;
      index = tokenEnd(sql, index, dataframes);
    }
  }
  return { dataframes: [...dataframes], reads: opensRead(sql, first) };
}
