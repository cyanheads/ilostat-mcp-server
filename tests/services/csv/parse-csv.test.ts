/**
 * @fileoverview Tests for the RFC 4180 CSV reader the SDMX unit probe and the
 * streamed `/data/indicator` bodies parse with: a leading BOM, quoted fields with
 * doubled quotes and embedded line breaks, CRLF or LF record ends, empty cells, and
 * header-driven rows — and, streamed, the same rows wherever the chunks split a
 * BOM, a quote, a doubled quote, or a CRLF.
 * @module tests/services/csv/parse-csv.test
 */

import { describe, expect, it } from 'vitest';
import { parseCsvObjects, parseCsvRecords, parseCsvStream } from '@/services/csv/parse-csv.js';
import { fixtureText, INDICATOR_CSV } from '../../helpers/ilostat-upstream.js';
import { guardNetwork } from '../../helpers/network-guard.js';

guardNetwork();

describe('parseCsvRecords', () => {
  it('strips a leading BOM', () => {
    expect(parseCsvRecords('﻿ref_area,time\nUSA,2024\n')).toEqual([
      ['ref_area', 'time'],
      ['USA', '2024'],
    ]);
  });

  it('reads quoted fields with doubled quotes, commas, and embedded line breaks', () => {
    expect(parseCsvRecords('a,b\n"x, ""y""","line 1\nline 2"\n')).toEqual([
      ['a', 'b'],
      ['x, "y"', 'line 1\nline 2'],
    ]);
  });

  it('accepts CRLF record ends and keeps empty cells', () => {
    expect(parseCsvRecords('a,b,c\r\n1,,3\r\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ]);
  });

  it('keeps a final record that has no trailing newline', () => {
    expect(parseCsvRecords('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('reads an empty body as no records', () => {
    expect(parseCsvRecords('')).toEqual([]);
  });
});

describe('parseCsvObjects', () => {
  it('keys each row by the header, so readers stay header-driven', () => {
    const [row] = parseCsvObjects(fixtureText('sdmx/probe-UNE_DEAP_SEX_AGE_RT.csv'));
    expect(row).toMatchObject({
      REF_AREA: 'ABW',
      SEX: 'SEX_T',
      AGE: 'AGE_YTHADULT_YGE15',
      OBS_VALUE: '8.9',
      OBS_STATUS: '',
      UNIT_MEASURE_TYPE: 'RT',
      UNIT_MEASURE: 'PT',
      UNIT_MULT: '0',
      SOURCE: 'LFS - Labour Force Survey',
    });
  });

  it('reads a header-only body as no rows', () => {
    expect(parseCsvObjects('DATAFLOW,REF_AREA,UNIT_MULT\n')).toEqual([]);
  });

  it('skips blank lines and fills cells a short row lacks with empty strings', () => {
    expect(parseCsvObjects('a,b,c\n\n1,2\n')).toEqual([{ a: '1', b: '2', c: '' }]);
  });
});

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

describe('parseCsvStream', () => {
  it('yields the rows parseCsvObjects reads from the whole body', async () => {
    expect(parseCsvObjects(TRICKY)).toEqual([
      { ref_area: 'USA', note: 'a, "b"', time: '2024' },
      { ref_area: 'KEN', note: 'line 1\nline 2', time: '' },
    ]);
    expect(await streamed([TRICKY])).toEqual(parseCsvObjects(TRICKY));
  });

  it('reads the same rows at every two-chunk split point', async () => {
    const whole = parseCsvObjects(TRICKY);
    for (let at = 0; at <= TRICKY.length; at++) {
      expect(await streamed([TRICKY.slice(0, at), TRICKY.slice(at)]), `split at ${at}`).toEqual(
        whole,
      );
    }
  });

  it('reads the same rows one character per chunk', async () => {
    expect(await streamed([...TRICKY])).toEqual(parseCsvObjects(TRICKY));
  });

  it('reads a recorded data body the same in small chunks', async () => {
    const body = fixtureText(INDICATOR_CSV.uneDeap);
    const chunks = body.match(/[\s\S]{1,7}/g) ?? [];
    const rows = await streamed(chunks);
    expect(rows).toEqual(parseCsvObjects(body));
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
