/**
 * @fileoverview Tests for the RFC 4180 CSV reader the streamed `/data/indicator`
 * bodies parse with: a leading BOM, quoted fields with doubled quotes and embedded
 * line breaks, CRLF or LF record ends, empty cells, and header-driven rows — and
 * the same rows wherever the chunks split a BOM, a quote, a doubled quote, or a
 * CRLF. A field past 65,536 characters or a record past 262,144 fails as a
 * serialization error, and a long field costs about its own length in heap.
 * @module tests/services/csv/parse-csv.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { parseCsvStream } from '@/services/csv/parse-csv.js';
import { fixtureText, INDICATOR_CSV } from '../../helpers/ilostat-upstream.js';
import { guardNetwork } from '../../helpers/network-guard.js';

guardNetwork();

/** Rows `parseCsvStream` yields when the body arrives as `chunks`. */
async function streamed(chunks: readonly string[]): Promise<Record<string, string>[]> {
  const source = (async function* () {
    yield* chunks;
  })();
  const rows: Record<string, string>[] = [];
  for await (const row of parseCsvStream(source)) rows.push(row);
  return rows;
}

/** Every stateful case in one body: BOM, CRLF, a quoted comma, doubled quotes, an embedded line break, an empty last cell. */
const TRICKY = '﻿"ref_area","note","time"\r\n"USA","a, ""b""",2024\r\n"KEN","line 1\nline 2",\r\n';
const TRICKY_ROWS = [
  { ref_area: 'USA', note: 'a, "b"', time: '2024' },
  { ref_area: 'KEN', note: 'line 1\nline 2', time: '' },
];

describe('parseCsvStream', () => {
  it('reads the whole body in one chunk: BOM, CRLF, quoted comma, doubled quotes, embedded line break, empty cell', async () => {
    expect(await streamed([TRICKY])).toEqual(TRICKY_ROWS);
  });

  it('reads the same rows at every two-chunk split point', async () => {
    for (let at = 0; at <= TRICKY.length; at++) {
      expect(await streamed([TRICKY.slice(0, at), TRICKY.slice(at)]), `split at ${at}`).toEqual(
        TRICKY_ROWS,
      );
    }
  });

  it('reads the same rows one character per chunk', async () => {
    expect(await streamed([...TRICKY])).toEqual(TRICKY_ROWS);
  });

  it('skips blank lines and fills cells a short row lacks with empty strings', async () => {
    expect(await streamed(['a,b,c\n\n1,2\n'])).toEqual([{ a: '1', b: '2', c: '' }]);
  });

  it('reads a recorded data body the same in small chunks', async () => {
    const body = fixtureText(INDICATOR_CSV.uneDeap);
    const chunks = body.match(/[\s\S]{1,7}/g) ?? [];
    const rows = await streamed(chunks);
    expect(rows).toEqual(await streamed([body]));
    expect(rows).toHaveLength(52);
    expect(Object.keys(rows[0] ?? {})[0]).toBe('ref_area');
  });

  it('strips a BOM that arrives alone, after an empty chunk', async () => {
    const rows = await streamed(['', '﻿', 'a,b\n1,2\n']);
    expect(rows).toEqual([{ a: '1', b: '2' }]);
  });

  it('joins a doubled quote split between its two quotes', async () => {
    expect(await streamed(['a\n"say "', '"hi"" now"\n'])).toEqual([{ a: 'say "hi" now' }]);
  });

  it('closes a quoted field whose closing quote ends a chunk', async () => {
    expect(await streamed(['a,b\n"x"', ',2\n'])).toEqual([{ a: 'x', b: '2' }]);
  });

  it('reads a CRLF split across chunks as one record end', async () => {
    expect(await streamed(['a,b\r', '\n1,2\r', '\n'])).toEqual([{ a: '1', b: '2' }]);
  });

  it('keeps a final record the last chunk ends without a line break', async () => {
    expect(await streamed(['a,b\n1,', '2'])).toEqual([{ a: '1', b: '2' }]);
  });

  it('yields nothing for a header-only body, with or without its line break', async () => {
    const headerOnly = fixtureText(INDICATOR_CSV.headerOnly);
    expect(await streamed([headerOnly.slice(0, 10), headerOnly.slice(10)])).toEqual([]);
    expect(await streamed(['ref_area,time'])).toEqual([]);
    expect(await streamed([])).toEqual([]);
  });
});

/** `text` in 64 KiB chunks, as a network body arrives. */
const chunked = (text: string): string[] => text.match(/[\s\S]{1,65536}/g) ?? [];

/** A flat copy of `text`, so slicing it in a measured region allocates nothing new. */
const flat = (text: string): string => new TextDecoder().decode(new TextEncoder().encode(text));

describe('field and record length caps', () => {
  const MIB = 1024 * 1024;
  const FIELD_ERROR = {
    code: JsonRpcErrorCode.SerializationError,
    message: 'ILOSTAT sent a CSV field longer than 65,536 characters.',
  };

  it.each([
    ['an unquoted field', `ref_area,obs_value\n${'a'.repeat(MIB)}\n`],
    ['a quoted field', `ref_area,obs_value\n"${'a'.repeat(MIB)}"\n`],
    ['a field an unclosed quote opens', `ref_area,obs_value\n"${'a'.repeat(MIB)}`],
  ])('rejects %s past 65,536 characters', async (_label, body) => {
    await expect(streamed(chunked(body))).rejects.toMatchObject(FIELD_ERROR);
  });

  it('reads a field of exactly 65,536 characters', async () => {
    const field = 'b'.repeat(65_536);
    expect(await streamed(chunked(`a,b\n1,"${field}"\n`))).toEqual([{ a: '1', b: field }]);
  });

  it('rejects a record past 262,144 characters, however its fields divide it', async () => {
    const record = Array.from({ length: 5 }, () => 'c'.repeat(60_000)).join(',');
    await expect(streamed(chunked(`a,b,c,d,e\n${record}\n`))).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      message: 'ILOSTAT sent a CSV record longer than 262,144 characters.',
    });
    const commas = ','.repeat(300_000);
    await expect(streamed(chunked(`a\n${commas}\n`))).rejects.toMatchObject({
      message: 'ILOSTAT sent a CSV record longer than 262,144 characters.',
    });
  });

  it('holds each long field as one string, not one heap node per character', async () => {
    const field = 'd'.repeat(60_000);
    const chunks = chunked(flat(`ref_area,note\n${`KEN,${field}\n`.repeat(100)}`));
    const before = process.memoryUsage().heapUsed;
    const rows = await streamed(chunks);
    const grown = process.memoryUsage().heapUsed - before;
    expect(rows).toHaveLength(100);
    expect(rows.every((row) => row.note === field)).toBe(true);
    expect(grown).toBeLessThan(3 * 100 * field.length);
  });
});
