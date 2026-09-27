/**
 * @fileoverview Client for rplumber.ilo.org, the ILOSTAT data path: the two tables
 * of contents, the code dictionaries, filtered observation downloads
 * (`/data/indicator`, streamed CSV), and per-area latest values (`/data/ref_area`,
 * JSON). Upstream silently ignores unknown query parameters and reads a blank one
 * as "all", so each endpoint sends only its explicit parameter allowlist and never
 * a blank value. Every response arrives as `application/octet-stream` whatever
 * the format, so bodies are parsed by the format requested, never by content type.
 * @module services/rplumber/rplumber-client
 */

import { z } from '@cyanheads/mcp-ts-core';
import { notFound, serializationError } from '@cyanheads/mcp-ts-core/errors';
import { parseCsvStream } from '@/services/csv/parse-csv.js';
import {
  type PacingOptions,
  type UpstreamClientOptions,
  UpstreamHttp,
  type UpstreamScope,
} from '@/services/upstream/upstream-http.js';
import {
  type DictionaryEntry,
  type DictionaryVar,
  type IndicatorTocRow,
  IndicatorTocRowSchema,
  type RawObservation,
  type RefAreaDataRow,
  RefAreaDataRowSchema,
  type RefAreaTocRow,
  RefAreaTocRowSchema,
} from './types.js';

const BASE_URL = 'https://rplumber.ilo.org';
const SERVICE = 'ILOSTAT API (rplumber.ilo.org)';

/**
 * About one request a second: a hard 60-per-minute window, two in flight, a 500 ms
 * start gap, and a 60 s cooldown doubling to 10 min after a 429 or challenge.
 */
const RPLUMBER_PACING: PacingOptions = {
  limits: [{ requests: 60, perMs: 60_000 }],
  maxConcurrent: 2,
  minStartGapMs: 500,
  cooldown: { baseMs: 60_000, maxMs: 600_000 },
  maxWaitMs: 15_000,
};

/** The only parameters each endpoint may carry. Anything else is a code bug, never a caller option. */
const ENDPOINT_PARAMS = {
  '/metadata/toc/indicator': ['lang', 'format'],
  '/metadata/toc/ref_area': ['lang', 'format'],
  '/metadata/dic': ['var', 'lang', 'format'],
  '/data/indicator': [
    'id',
    'ref_area',
    'sex',
    'classif1',
    'classif2',
    'source',
    'time',
    'timefrom',
    'timeto',
    'latestyear',
    'best_source',
    'type',
    'format',
  ],
  '/data/ref_area': ['id', 'indicator', 'timeto', 'latestyear', 'format'],
} as const satisfies Record<string, readonly string[]>;

type Endpoint = keyof typeof ENDPOINT_PARAMS;
/** A scalar, or a list sent `+`-joined. */
type ParamValue = string | readonly string[] | undefined;
type ParamsFor<E extends Endpoint> = Partial<
  Record<(typeof ENDPOINT_PARAMS)[E][number], ParamValue>
>;

const JSON_ACCEPT = 'application/json';
const CSV_ACCEPT = 'text/csv';

const MIB = 1024 * 1024;

/**
 * Body caps, set well above the live sizes: the tables of contents and dictionaries
 * run to 1.4 MiB at most (the indicator dictionary), and `/data/ref_area` to 3.2 MiB
 * for the full history of the profile's headline indicators. A catalog body past
 * its cap takes every catalog tool down until a release, so that cap is the
 * loosest. A `/data/indicator` row is 93–96 bytes live; the stream's cap is ten
 * times that for each row the caller may read.
 */
const METADATA_MAX_BYTES = 32 * MIB;
const REF_AREA_DATA_MAX_BYTES = 16 * MIB;
const INDICATOR_ROW_BYTES = 1024;

/** Upstream `best_source` values: preferred source only, every source flagged, secondary only. */
export type BestSource = 'yes' | 'all' | 'no';

/** Filters for one `/data/indicator` download. Every list is `+`-joined; an absent filter is not sent. */
export interface IndicatorDataParams {
  /** Omitted: upstream applies its own default (`yes`). */
  bestSource?: BestSource;
  classif1?: readonly string[];
  classif2?: readonly string[];
  /** Dataset IDs (`UNE_DEAP_SEX_AGE_RT_A`). */
  datasetIds: readonly string[];
  latestOnly?: boolean;
  refAreas?: readonly string[];
  sex?: readonly string[];
  sources?: readonly string[];
  /** Exact periods, `YYYY`, `YYYYQn`, or `YYYYMmm`. */
  time?: readonly string[];
  /** Upstream reads the year only. */
  timeFrom?: number;
  timeTo?: number;
}

/** Filters for one `/data/ref_area` call. */
export interface RefAreaDataParams {
  area: string;
  /** Indicator codes without the frequency suffix — a suffixed dataset ID silently returns `[]`. */
  indicators: readonly string[];
  latestOnly: boolean;
  timeTo?: number;
}

/**
 * Builds the request URL from allowlisted parameters; blank values are left off,
 * never sent as `param=`. A list is sent with each element percent-encoded and a
 * literal `+` between them: upstream reads `id=A%2BB` as the one dataset ID `A+B`
 * (HTTP 400), so the separator must never be encoded.
 */
function buildUrl<E extends Endpoint>(endpoint: E, params: ParamsFor<E>): string {
  const url = new URL(endpoint, BASE_URL);
  url.search = (Object.entries(params) as [string, ParamValue][])
    .flatMap(([key, value]) => {
      const values = (typeof value === 'string' ? [value] : (value ?? [])).filter((v) => v.trim());
      return values.length ? [`${key}=${values.map(encodeURIComponent).join('+')}`] : [];
    })
    .join('&');
  return url.toString();
}

function parseJsonBody(body: string, operation: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    throw serializationError(
      `${SERVICE} returned a body that is not JSON for ${operation}.`,
      undefined,
      {
        cause: error,
      },
    );
  }
}

function parseRows<T>(schema: z.ZodType<T>, body: string, operation: string): T[] {
  const result = z.array(schema).safeParse(parseJsonBody(body, operation));
  if (!result.success) {
    const issue = result.error.issues[0];
    throw serializationError(
      `${SERVICE} returned an unexpected shape for ${operation}${issue ? ` at ${issue.path.join('.')}: ${issue.message}` : ''}.`,
    );
  }
  return result.data;
}

/** `R1:3513_T2:85` → `['R1:3513', 'T2:85']`; compound notes are `_`-joined. */
function noteCodes(...cells: (string | null | undefined)[]): string[] {
  return cells.flatMap((cell) => (cell ? cell.split('_').filter(Boolean) : []));
}

/** A number from an upstream cell, or `undefined` for a blank or non-numeric one. */
function numericValue(cell: string | number | null | undefined): number | undefined {
  if (cell == null || cell === '') return;
  const value = Number(cell);
  return Number.isFinite(value) ? value : undefined;
}

const present = (cell: string | null | undefined): string | undefined => cell || undefined;

/** One `/data/indicator` CSV record, normalized. The CSV header is the union of the requested datasets' columns. */
function fromCsvRecord(record: Record<string, string>): RawObservation {
  const value = numericValue(record.obs_value);
  const sex = present(record.sex);
  const classif1 = present(record.classif1);
  const classif2 = present(record.classif2);
  const obsStatus = present(record.obs_status);
  const bestSource = record.best_source;
  return {
    refArea: record.ref_area ?? '',
    source: record.source ?? '',
    indicator: record.indicator ?? '',
    period: record.time ?? '',
    notes: noteCodes(record.note_classif, record.note_indicator, record.note_source),
    ...(sex ? { sex } : {}),
    ...(classif1 ? { classif1 } : {}),
    ...(classif2 ? { classif2 } : {}),
    ...(value === undefined ? {} : { value }),
    ...(obsStatus ? { obsStatus } : {}),
    ...(bestSource === '1' || bestSource === '0' ? { bestSource: bestSource === '1' } : {}),
  };
}

function fromRefAreaRow(row: RefAreaDataRow): RawObservation {
  const value = numericValue(row.obs_value);
  const sex = present(row.sex);
  const classif1 = present(row.classif1);
  const classif2 = present(row.classif2);
  const obsStatus = present(row.obs_status);
  return {
    refArea: row.ref_area,
    source: row.source,
    indicator: row.indicator,
    period: String(row.time),
    notes: noteCodes(row.note_classif, row.note_indicator, row.note_source),
    ...(sex ? { sex } : {}),
    ...(classif1 ? { classif1 } : {}),
    ...(classif2 ? { classif2 } : {}),
    ...(value === undefined ? {} : { value }),
    ...(obsStatus ? { obsStatus } : {}),
  };
}

/**
 * `400 {"error":"deprecated or invalid dataset id=…"}` — a catalog ID the upstream
 * withdrew after the last catalog refresh.
 */
function retiredDataset(body: string, scope: UpstreamScope): Error | undefined {
  const message = /"error"\s*:\s*"([^"]*)"/.exec(body)?.[1];
  if (!message || !/deprecated or invalid dataset id/i.test(message)) return;
  const id = /id=([A-Z0-9_+]+)/i.exec(message)?.[1];
  return notFound(
    `ILOSTAT no longer serves ${id ? `dataset ${id}` : 'a requested dataset'}: the upstream reports a deprecated or invalid dataset ID.`,
    {
      reason: 'dataset_retired',
      ...(id ? { datasetId: id } : {}),
      ...scope.recoveryFor?.('dataset_retired'),
    },
  );
}

/**
 * Reads the ToCs and dictionaries for the background catalog loader (uncapped
 * queue wait), and observations for tool calls (queue wait capped).
 */
export class RplumberClient {
  private readonly http: UpstreamHttp;

  constructor(options: UpstreamClientOptions) {
    this.http = new UpstreamHttp(SERVICE, options, RPLUMBER_PACING);
  }

  dispose(): void {
    this.http.dispose();
  }

  /** `/metadata/toc/indicator` — one row per dataset. */
  getIndicatorToc(scope: UpstreamScope): Promise<IndicatorTocRow[]> {
    const operation = 'indicator table of contents';
    return this.getJson(
      buildUrl('/metadata/toc/indicator', { lang: 'en', format: '.json' }),
      operation,
      (body) => parseRows(IndicatorTocRowSchema, body, operation),
      scope,
      false,
      METADATA_MAX_BYTES,
    );
  }

  /** `/metadata/toc/ref_area` — one row per reference area and frequency. */
  getRefAreaToc(scope: UpstreamScope): Promise<RefAreaTocRow[]> {
    const operation = 'reference-area table of contents';
    return this.getJson(
      buildUrl('/metadata/toc/ref_area', { lang: 'en', format: '.json' }),
      operation,
      (body) => parseRows(RefAreaTocRowSchema, body, operation),
      scope,
      false,
      METADATA_MAX_BYTES,
    );
  }

  /**
   * `/metadata/dic?var=…` — `{<var>, <var>.label}` rows normalized to entries.
   * Rows missing a code or label are skipped (the status dictionary carries an
   * empty object for the blank status).
   */
  getDictionary(dictionary: DictionaryVar, scope: UpstreamScope): Promise<DictionaryEntry[]> {
    const operation = `${dictionary} dictionary`;
    return this.getJson(
      buildUrl('/metadata/dic', { var: dictionary, lang: 'en', format: '.json' }),
      operation,
      (body) =>
        parseRows(z.record(z.string(), z.unknown()), body, operation).flatMap((row) => {
          const code = row[dictionary];
          const label = row[`${dictionary}.label`];
          if (typeof code !== 'string' || !code || typeof label !== 'string') return [];
          const description = row[`${dictionary}.description`];
          const refArea = row.ref_area;
          return [
            {
              code,
              label,
              ...(typeof description === 'string' ? { description } : {}),
              ...(dictionary === 'source' && typeof refArea === 'string' ? { refArea } : {}),
            },
          ];
        }),
      scope,
      false,
      METADATA_MAX_BYTES,
    );
  }

  /** The canonical `/data/indicator` URL for `params` — also the response-cache key. */
  indicatorDataUrl(params: IndicatorDataParams): string {
    return buildUrl('/data/indicator', {
      id: params.datasetIds,
      ref_area: params.refAreas,
      sex: params.sex,
      classif1: params.classif1,
      classif2: params.classif2,
      source: params.sources,
      time: params.time,
      timefrom: params.timeFrom?.toString(),
      timeto: params.timeTo?.toString(),
      latestyear: params.latestOnly ? 'TRUE' : undefined,
      best_source: params.bestSource,
      type: 'code',
      format: '.csv',
    });
  }

  /**
   * Streams `/data/indicator` observations from a URL built by
   * {@link indicatorDataUrl}. Abort `signal` once reading stops early; a 400 for a
   * withdrawn dataset ID fails as `dataset_retired`. The body is capped at
   * {@link INDICATOR_ROW_BYTES} for each of the `maxRows` rows the caller may read,
   * past which the stream fails `upstream_too_large`.
   */
  async streamIndicatorData(
    url: string,
    scope: UpstreamScope,
    signal: AbortSignal,
    maxRows: number,
  ): Promise<AsyncGenerator<RawObservation>> {
    const chunks = await this.http.openStream(
      {
        url,
        operation: 'rplumber indicator data',
        accept: CSV_ACCEPT,
        acceptStatuses: [200],
        bounded: true,
        maxBytes: maxRows * INDICATOR_ROW_BYTES,
        rejectStatus: (status, body) => (status === 400 ? retiredDataset(body, scope) : undefined),
      },
      scope,
      signal,
    );
    return (async function* () {
      for await (const record of parseCsvStream(chunks)) yield fromCsvRecord(record);
    })();
  }

  /** The canonical `/data/ref_area` URL for `params` — also the response-cache key. */
  refAreaDataUrl(params: RefAreaDataParams): string {
    return buildUrl('/data/ref_area', {
      id: `${params.area}_A`,
      indicator: params.indicators,
      timeto: params.timeTo?.toString(),
      latestyear: params.latestOnly ? 'TRUE' : undefined,
      format: '.json',
    });
  }

  /** `/data/ref_area` observations from a URL built by {@link refAreaDataUrl}. */
  getRefAreaData(url: string, scope: UpstreamScope): Promise<RawObservation[]> {
    const operation = 'reference-area data';
    return this.getJson(
      url,
      operation,
      (body) => parseRows(RefAreaDataRowSchema, body, operation).map(fromRefAreaRow),
      scope,
      true,
      REF_AREA_DATA_MAX_BYTES,
    );
  }

  private getJson<T>(
    url: string,
    operation: string,
    parse: (body: string) => T,
    scope: UpstreamScope,
    bounded: boolean,
    maxBytes: number,
  ): Promise<T> {
    return this.http.request(
      {
        url,
        operation: `rplumber ${operation}`,
        accept: JSON_ACCEPT,
        acceptStatuses: [200],
        bounded,
        maxBytes,
        interpret: ({ body }) => parse(body),
      },
      scope,
    );
  }
}
