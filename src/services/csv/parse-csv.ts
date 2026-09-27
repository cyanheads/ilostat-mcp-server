/**
 * @fileoverview Minimal RFC 4180 CSV reader for upstream bodies: a leading BOM,
 * quoted fields with doubled quotes and embedded line breaks, and CRLF or LF
 * record ends. One incremental reader serves both whole bodies and streamed
 * ones — a quote, an escaped quote, or a CRLF split across two chunks parses the
 * same as when it arrives whole. Rows come back keyed by the header row, so
 * readers stay header-driven rather than positional. A field is held as slices
 * of the chunks it arrived in and joined once when it ends, so it costs about
 * its own length in memory, and a field past 65,536 characters or a record past
 * 262,144 fails as a serialization error: a stray quote that swallows the rest
 * of a large download stops at the cap instead of exhausting the heap.
 * @module services/csv/parse-csv
 */

import { serializationError } from '@cyanheads/mcp-ts-core/errors';

/** Longest field read; ILOSTAT's longest live field is under 100 characters. */
const MAX_FIELD_CHARS = 65_536;
/** Longest record read, counting one separator per field. */
const MAX_RECORD_CHARS = 262_144;

/** Incremental CSV tokenizer: feed text chunks in order, then call {@link CsvRecordReader.end}. */
class CsvRecordReader {
  /** The current field's text so far, as slices of the chunks it arrived in. */
  private readonly parts: string[] = [];
  private fieldLength = 0;
  /** A `"` inside a quoted field whose meaning (close, or first of `""`) depends on the next character. */
  private quotePending = false;
  private quoted = false;
  private record: string[] = [];
  /** Characters in the current record's completed fields, plus one separator for each. */
  private recordLength = 0;
  /** The previous character ended a record on `\r`; a `\n` right after it belongs to that CRLF. */
  private skipLineFeed = false;
  private started = false;

  /**
   * Consumes one chunk and returns the records it completed. Field text is never
   * copied character by character: `start` marks where the chunk's pending field
   * text begins, and each quote, separator, or line break takes the text before it.
   */
  push(chunk: string): string[][] {
    let text = chunk;
    if (!this.started && text.length > 0) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    const completed: string[][] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (this.skipLineFeed) {
        this.skipLineFeed = false;
        if (char === '\n') {
          start = i + 1;
          continue;
        }
      }
      if (this.quotePending) {
        this.quotePending = false;
        // The second quote of `""` is field text: it opens the next slice.
        if (char === '"') continue;
        this.quoted = false;
      } else if (this.quoted) {
        if (char === '"') {
          this.take(text, start, i);
          start = i + 1;
          this.quotePending = true;
        }
        continue;
      }
      if (char === '"') {
        this.take(text, start, i);
        start = i + 1;
        this.quoted = true;
      } else if (char === ',') {
        this.take(text, start, i);
        start = i + 1;
        this.endField();
      } else if (char === '\n' || char === '\r') {
        this.take(text, start, i);
        start = i + 1;
        this.endField();
        completed.push(this.record);
        this.record = [];
        this.recordLength = 0;
        this.skipLineFeed = char === '\r';
      }
    }
    this.take(text, start, text.length);
    return completed;
  }

  /** Flushes the final record when the input does not end on a line break. */
  end(): string[][] {
    this.quotePending = false;
    this.quoted = false;
    if (this.fieldLength === 0 && this.record.length === 0) return [];
    this.endField();
    const last = this.record;
    this.record = [];
    this.recordLength = 0;
    return [last];
  }

  /** Adds `text[start, end)` to the current field, failing once the field passes its cap. */
  private take(text: string, start: number, end: number): void {
    if (end === start) return;
    this.fieldLength += end - start;
    if (this.fieldLength > MAX_FIELD_CHARS) {
      throw serializationError(
        `ILOSTAT sent a CSV field longer than ${MAX_FIELD_CHARS.toLocaleString('en-US')} characters.`,
      );
    }
    this.parts.push(text.slice(start, end));
  }

  /** Ends the current field, failing once its record passes the record cap. */
  private endField(): void {
    this.recordLength += this.fieldLength + 1;
    if (this.recordLength > MAX_RECORD_CHARS) {
      throw serializationError(
        `ILOSTAT sent a CSV record longer than ${MAX_RECORD_CHARS.toLocaleString('en-US')} characters.`,
      );
    }
    this.record.push(this.parts.join(''));
    this.parts.length = 0;
    this.fieldLength = 0;
  }
}

/** Splits CSV text into records of raw field strings. */
export function parseCsvRecords(text: string): string[][] {
  const reader = new CsvRecordReader();
  return [...reader.push(text), ...reader.end()];
}

const isBlankRecord = (record: string[]): boolean => record.every((value) => value === '');

function toObject(header: string[], record: string[]): Record<string, string> {
  return Object.fromEntries(header.map((name, index) => [name, record[index] ?? '']));
}

/** Data rows keyed by the header row. A header-only body yields no rows. */
export function parseCsvObjects(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsvRecords(text);
  if (!header) return [];
  return rows.filter((row) => !isBlankRecord(row)).map((row) => toObject(header, row));
}

/**
 * Streams data rows keyed by the header row as text chunks arrive. Blank lines
 * are skipped; a header-only body yields nothing.
 */
export async function* parseCsvStream(
  chunks: AsyncIterable<string>,
): AsyncGenerator<Record<string, string>> {
  const reader = new CsvRecordReader();
  let header: string[] | undefined;
  const rows = function* (records: string[][]): Generator<Record<string, string>> {
    for (const record of records) {
      if (!header) header = record;
      else if (!isBlankRecord(record)) yield toObject(header, record);
    }
  };
  for await (const chunk of chunks) yield* rows(reader.push(chunk));
  yield* rows(reader.end());
}
