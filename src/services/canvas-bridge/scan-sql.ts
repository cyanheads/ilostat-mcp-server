/**
 * @fileoverview One left-to-right pass over an `ilostat_dataframe_query` statement,
 * following DuckDB's lexer: the `df_` dataframe names it uses as identifiers and
 * whether it reads. Comments and string literals are skipped, so a name inside
 * one is never a reference, and an apostrophe inside one never opens a literal
 * that hides a later name. The one literal read is the argument of a `query()`
 * call in the one form the canvas gate admits, a single string literal, where a
 * table reference starts (`query ('…')` after a table or `AS` is an alias and
 * its column list): its SQL, unescaped as DuckDB runs it, is scanned as a
 * statement of its own, down to the gate's nesting limit. Each character is read
 * a fixed number of times per nesting level (a call that turns out not to take a
 * lone literal is read again as ordinary tokens), and the levels are capped, so
 * the pass stays linear in the statement's length.
 * @module services/canvas-bridge/scan-sql
 */

/** What {@link scanSql} found in a statement. */
export interface SqlScan {
  /**
   * `df_` names used as identifiers, bare or double-quoted, in any case, folded
   * to the minted `df_XXXXX_XXXXX` form (DuckDB identifiers are case-insensitive),
   * each once, in order of first use; a name in the SQL of a `query()` call counts
   * where the call stands. A name in alias or CTE position counts too: telling
   * those apart needs a parser.
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
/**
 * Keywords after which a table reference starts, so `query (` there is a call:
 * the `FROM` list, every join (`CROSS JOIN`, `LEFT OUTER JOIN`, …), `LATERAL`,
 * and the `PIVOT` and `UNPIVOT` statements. After a table reference or `AS`,
 * DuckDB reads `query ('…')` as an alias with a column list instead.
 */
const TABLE_REF_KEYWORDS = new Set(['from', 'join', 'lateral', 'pivot', 'unpivot']);
/**
 * Keywords that end a `FROM` list at their parenthesis depth, so a later `,`
 * starts no table reference: in a `WITH` list, `, query ('…') AS (…)` names a
 * CTE and its column. `ON` and `USING` stay inside the list (`JOIN u USING (k), t`).
 */
const FROM_LIST_ENDS = new Set([
  'select',
  'with',
  'where',
  'group',
  'having',
  'qualify',
  'window',
  'order',
  'limit',
  'offset',
  'union',
  'intersect',
  'except',
  'values',
]);
/** The longest keyword in {@link TABLE_REF_KEYWORDS} and {@link FROM_LIST_ENDS}. */
const LONGEST_KEYWORD = 9;
/**
 * How many `query()` string literals deep the canvas gate follows a statement:
 * `MAX_QUERY_NESTING` in `@cyanheads/mcp-ts-core`'s SQL gate
 * (`services/canvas/core/sqlGate`), restated because the package does not export
 * it. Depth 1 is the literal of a `query()` call in the statement itself. The
 * gate refuses a deeper one as `denied_function`, so its SQL never runs.
 */
const MAX_QUERY_NESTING = 4;
/** DuckDB's lexer reads every byte from 0x80 up as an identifier character, and `$` after the first. */
const IDENTIFIER = /[A-Za-z_\u0080-￿][\w$\u0080-￿]*/y;
/** `$$` or `$tag$`; a tag never starts with a digit and never holds `$`. */
const DOLLAR_DELIMITER = /\$(?:[A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/y;
const SPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);
/** Space DuckDB allows on a line around the break that joins two `'…'` literals. */
const LINE_SPACE = new Set([' ', '\t', '\f']);
/** The control characters an `E'…'` string's `\b`, `\f`, `\n`, `\r`, and `\t` stand for. */
const CONTROL_ESCAPES = new Map([
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
]);

/** The match of a sticky `pattern` at `index`. */
function matchAt(pattern: RegExp, sql: string, index: number): string | undefined {
  pattern.lastIndex = index;
  return pattern.exec(sql)?.[0];
}

/**
 * The index of the quote that closes a quoted token whose body starts at `from`,
 * or -1 when it is unterminated: a doubled `quote` is part of the body, and so is
 * a backslash-escaped character when `backslash` (an `E'…'` string).
 */
function quotedClose(sql: string, from: number, quote: string, backslash: boolean): number {
  let index = from;
  while (index < sql.length) {
    const char = sql[index];
    if (backslash && char === '\\') index += 2;
    else if (char !== quote) index++;
    else if (sql[index + 1] === quote) index += 2;
    else return index;
  }
  return -1;
}

/** The index just past a quoted token whose body starts at `from`; an unterminated one runs to the end. */
function quotedEnd(sql: string, from: number, quote: string, backslash: boolean): number {
  const close = quotedClose(sql, from, quote, backslash);
  return close === -1 ? sql.length : close + 1;
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

/** The index of the first token at or after `index`, past whitespace and comments. */
function nextToken(sql: string, index: number): number {
  let at = index;
  while (at < sql.length) {
    const char = sql[at] as string;
    if (SPACE.has(char)) at++;
    else if (char === '-' && sql[at + 1] === '-') at = lineCommentEnd(sql, at + 2);
    else if (char === '/' && sql[at + 1] === '*') at = blockCommentEnd(sql, at + 2);
    else break;
  }
  return at;
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

/** Whether the token `sql[start, end)` names the `query` function: bare or double-quoted, any case. */
function namesQuery(sql: string, start: number, end: number): boolean {
  if (end - start !== 5 && end - start !== 7) return false;
  const token = sql.slice(start, end).toLowerCase();
  return token === 'query' || token === '"query"';
}

/** The value of hex (`radix` 16, up to 2 digits) or octal (8, up to 3) digits at `from`, and how many. */
function codeAt(text: string, from: number, radix: 8 | 16): { digits: number; value: number } {
  const most = radix === 16 ? 2 : 3;
  let digits = 0;
  let value = 0;
  while (digits < most) {
    const digit = Number.parseInt(text[from + digits] ?? '', radix);
    if (Number.isNaN(digit)) break;
    value = value * radix + digit;
    digits++;
  }
  return { digits, value };
}

/**
 * An `E'…'` body as DuckDB unescapes it: `''` is a quote; `\b`, `\f`, `\n`, `\r`,
 * and `\t` are control characters; `\x` with one or two hex digits, or one to three
 * octal digits, is that character code; a backslash before anything else is that
 * character. (DuckDB refuses `\u`, `\U`, and a code of 0 or from 0x80 up as a
 * parse error, so their decoding here never reaches a statement that runs.)
 */
function unescapeExtended(body: string): string {
  const parts: string[] = [];
  let start = 0;
  let index = 0;
  while (index < body.length) {
    const char = body[index];
    if (char === "'") {
      // Only a doubled quote reaches here: quotedClose ends the body at a lone one.
      parts.push(body.slice(start, index + 1));
      index += 2;
      start = index;
    } else if (char === '\\') {
      parts.push(body.slice(start, index));
      const escaped = body[index + 1] ?? '';
      const hex = escaped === 'x' ? codeAt(body, index + 2, 16) : undefined;
      const octal = hex ? undefined : codeAt(body, index + 1, 8);
      if (hex && hex.digits > 0) {
        parts.push(String.fromCharCode(hex.value));
        index += 2 + hex.digits;
      } else if (octal && octal.digits > 0) {
        parts.push(String.fromCharCode(octal.value));
        index += 1 + octal.digits;
      } else {
        parts.push(CONTROL_ESCAPES.get(escaped) ?? escaped);
        index += 2;
      }
      start = index;
    } else {
      index++;
    }
  }
  parts.push(body.slice(start));
  return parts.join('');
}

/**
 * The index of the `'` that continues a quoted literal closed just before `from`:
 * DuckDB joins two literals separated only by spaces, tabs, form feeds, `--`
 * comments, and at least one line break (LF or CR). `undefined` when none does.
 */
function continuationAt(sql: string, from: number): number | undefined {
  let index = from;
  let broken = false;
  while (index < sql.length) {
    const char = sql[index] as string;
    if (char === '\n' || char === '\r') {
      broken = true;
      index++;
    } else if (LINE_SPACE.has(char)) {
      index++;
    } else if (char === '-' && sql[index + 1] === '-') {
      index = lineCommentEnd(sql, index + 2);
    } else {
      break;
    }
  }
  return broken && sql[index] === "'" ? index : undefined;
}

/**
 * The string literal at `index` — `'…'`, `E'…'`, or `$tag$…$tag$` — unescaped as
 * DuckDB reads it, and the index just past it; `undefined` for any other token or
 * an unterminated literal. A quoted literal takes the `'…'` parts joined to it
 * across line breaks, each unescaped the way the first part is.
 */
function stringLiteralAt(sql: string, index: number): { end: number; text: string } | undefined {
  const delimiter = sql[index] === '$' ? matchAt(DOLLAR_DELIMITER, sql, index) : undefined;
  if (delimiter) {
    const close = sql.indexOf(delimiter, index + delimiter.length);
    if (close === -1) return undefined;
    return { end: close + delimiter.length, text: sql.slice(index + delimiter.length, close) };
  }
  const extended = (sql[index] === 'E' || sql[index] === 'e') && sql[index + 1] === "'";
  let quote: number | undefined = extended ? index + 1 : sql[index] === "'" ? index : undefined;
  const parts: string[] = [];
  let end = index;
  while (quote !== undefined) {
    const close = quotedClose(sql, quote + 1, "'", extended);
    if (close === -1) return undefined;
    const body = sql.slice(quote + 1, close);
    parts.push(extended ? unescapeExtended(body) : body.replaceAll("''", "'"));
    end = close + 1;
    quote = continuationAt(sql, end);
  }
  return parts.length === 0 ? undefined : { end, text: parts.join('') };
}

/**
 * The SQL of a `query()` call whose name ends at `from`, when the call takes the
 * one argument form the canvas gate admits: a single string literal, any number of
 * parentheses deep. Returns that SQL, unescaped, and the index just past the
 * call's `)`; `undefined` for any other argument (an expression, a cast, a second
 * or named argument), which the gate refuses.
 */
function queryCallSql(sql: string, from: number): { end: number; text: string } | undefined {
  let index = nextToken(sql, from);
  let parentheses = 0;
  while (sql[index] === '(') {
    parentheses++;
    index = nextToken(sql, index + 1);
  }
  if (parentheses === 0) return undefined;
  const literal = stringLiteralAt(sql, index);
  if (!literal) return undefined;
  index = literal.end;
  for (; parentheses > 0; parentheses--) {
    index = nextToken(sql, index);
    if (sql[index] !== ')') return undefined;
    index++;
  }
  return { end: index, text: literal.text };
}

/**
 * Scans `sql`, `depth` `query()` literals below the statement the caller sent,
 * recording its `df_` identifiers and those of every `query()` literal it holds
 * down to {@link MAX_QUERY_NESTING}. `query` is read as a call only where a table
 * reference starts: after one of {@link TABLE_REF_KEYWORDS}, after a `.` that
 * qualifies it, or after a `,` in a `FROM` list. Anywhere else a `query ('…')`
 * that runs is an alias or CTE name with a column list, and a `query()` that is
 * a call fails to bind (a select-list call) or to parse (`FROM (query(…))`).
 * Returns the index of its first token.
 */
function scanStatement(sql: string, depth: number, dataframes: Set<string>): number | undefined {
  let first: number | undefined;
  /** Whether the token before this one starts a table reference. */
  let opensTableRef = false;
  /** Whether a `,` at this parenthesis depth continues a `FROM` list; the stack holds the enclosing depths'. */
  let inFromList = false;
  const enclosingFromLists: boolean[] = [];
  let index = nextToken(sql, 0);
  while (index < sql.length) {
    first ??= index;
    const end = tokenEnd(sql, index, dataframes);
    const call =
      opensTableRef && depth < MAX_QUERY_NESTING && namesQuery(sql, index, end)
        ? queryCallSql(sql, end)
        : undefined;
    if (call) {
      scanStatement(call.text, depth + 1, dataframes);
      opensTableRef = false;
    } else {
      const char = sql[index];
      if (char === '(') {
        enclosingFromLists.push(inFromList);
        inFromList = false;
      } else if (char === ')') {
        inFromList = enclosingFromLists.pop() ?? false;
      }
      const keyword = end - index <= LONGEST_KEYWORD ? sql.slice(index, end).toLowerCase() : '';
      if (keyword === 'from') inFromList = true;
      else if (FROM_LIST_ENDS.has(keyword)) inFromList = false;
      opensTableRef =
        TABLE_REF_KEYWORDS.has(keyword) || char === '.' || (char === ',' && inFromList);
    }
    index = nextToken(sql, call?.end ?? end);
  }
  return first;
}

/** Whether the token at `first` opens a read: `(` or one of {@link READ_KEYWORDS}. */
function opensRead(sql: string, first: number | undefined): boolean {
  if (first === undefined) return false;
  if (sql[first] === '(') return true;
  return READ_KEYWORDS.has(matchAt(IDENTIFIER, sql, first)?.toLowerCase() ?? '');
}

/** Scans `sql` once for the `df_` identifiers it names, `query()` literals included, and whether it reads. */
export function scanSql(sql: string): SqlScan {
  const dataframes = new Set<string>();
  const first = scanStatement(sql, 0, dataframes);
  return { dataframes: [...dataframes], reads: opensRead(sql, first) };
}
