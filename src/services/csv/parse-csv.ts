/**
 * @fileoverview Minimal RFC 4180 CSV reader for upstream bodies: a leading BOM,
 * quoted fields with doubled quotes and embedded line breaks, and CRLF or LF
 * record ends. One incremental reader serves both whole bodies and streamed
 * ones — a quote, an escaped quote, or a CRLF split across two chunks parses the
 * same as when it arrives whole. Rows come back keyed by the header row, so
 * readers stay header-driven rather than positional.
 * @module services/csv/parse-csv
 */

/** Incremental CSV tokenizer: feed text chunks in order, then call {@link CsvRecordReader.end}. */
export class CsvRecordReader {
  private field = '';
  /** A `"` inside a quoted field whose meaning (close, or first of `""`) depends on the next character. */
  private quotePending = false;
  private quoted = false;
  private record: string[] = [];
  /** The previous character ended a record on `\r`; a `\n` right after it belongs to that CRLF. */
  private skipLineFeed = false;
  private started = false;

  /** Consumes one chunk and returns the records it completed. */
  push(chunk: string): string[][] {
    let text = chunk;
    if (!this.started && text.length > 0) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    const completed: string[][] = [];
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (this.skipLineFeed) {
        this.skipLineFeed = false;
        if (char === '\n') continue;
      }
      if (this.quotePending) {
        this.quotePending = false;
        if (char === '"') {
          this.field += '"';
          continue;
        }
        this.quoted = false;
      } else if (this.quoted) {
        if (char === '"') this.quotePending = true;
        else this.field += char;
        continue;
      }
      if (char === '"') {
        this.quoted = true;
      } else if (char === ',') {
        this.record.push(this.field);
        this.field = '';
      } else if (char === '\n' || char === '\r') {
        this.record.push(this.field);
        completed.push(this.record);
        this.record = [];
        this.field = '';
        this.skipLineFeed = char === '\r';
      } else {
        this.field += char;
      }
    }
    return completed;
  }

  /** Flushes the final record when the input does not end on a line break. */
  end(): string[][] {
    this.quotePending = false;
    this.quoted = false;
    if (this.field === '' && this.record.length === 0) return [];
    this.record.push(this.field);
    const last = this.record;
    this.record = [];
    this.field = '';
    return [last];
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
