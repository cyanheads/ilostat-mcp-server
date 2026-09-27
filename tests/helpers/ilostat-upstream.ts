/**
 * @fileoverview Recorded-shape ILOSTAT upstream for the test suite: the trimmed
 * rplumber tables of contents and dictionaries, the `/data/indicator` CSV and
 * `/data/ref_area` JSON bodies, and the SDMX structure documents and unit probes
 * under `tests/fixtures/`, served through the framework's strict fetch fake; an
 * emulator that filters a recorded CSV by the request's parameters, read as
 * upstream reads them (a literal `+` joins a list; `%2B` inside `id` names one
 * invalid dataset); a pull-based
 * CSV body that records how much of it was read; an in-memory DuckDB canvas and
 * one that fails at a chosen engine step; the fast pacing/retry/timer options;
 * the service wiring handler tests share, and the staging the dataframe tools
 * start from.
 * Every fake is injected through a client's `fetch` constructor option — the seam
 * `docs/design.md` names — never through `globalThis`.
 * @module tests/helpers/ilostat-upstream
 */

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@cyanheads/mcp-ts-core';
import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import {
  createFetchMock,
  type FetchMockHarness,
  type FetchMockResponder,
  type FetchMockRoute,
} from '@cyanheads/mcp-ts-core/testing';
import { getServerConfig } from '@/config/server-config.js';
import { queryIndicatorTool } from '@/mcp-server/tools/definitions/query-indicator.tool.js';
import { CatalogService } from '@/services/catalog/catalog-service.js';
import { type IlostatServices, initIlostatServices } from '@/services/ilostat-services.js';
import { ObservationService } from '@/services/observations/observation-service.js';
import { ResponseCache } from '@/services/observations/response-cache.js';
import { ProfileService } from '@/services/profile/profile-service.js';
import { RplumberClient } from '@/services/rplumber/rplumber-client.js';
import { SdmxClient } from '@/services/sdmx/sdmx-client.js';
import type {
  FetchFn,
  PacingOptions,
  RetryPolicy,
  TimeoutOptions,
  UpstreamClientOptions,
} from '@/services/upstream/upstream-http.js';

export const RPLUMBER_ORIGIN = 'https://rplumber.ilo.org';
export const SDMX_ORIGIN = 'https://sdmx.ilo.org';
export const TEST_USER_AGENT =
  'ilostat-mcp-server/0.0.0-test (+https://github.com/cyanheads/ilostat-mcp-server)';

/** The wall clock handler tests run at unless a test pins another. */
export const FIXED_NOW = new Date('2026-09-26T12:00:00Z');

/** No windows, no start gap, no cooldown: every request dispatches immediately. */
export const FAST_PACING: PacingOptions = {
  limits: [],
  maxConcurrent: 8,
  minStartGapMs: 0,
  maxWaitMs: 1_000,
};
export const NO_RETRY: RetryPolicy = { maxRetries: 0, baseDelayMs: 0, deadlineMs: 5_000 };
export const FAST_TIMEOUTS: TimeoutOptions = { headersMs: 1_000, stallMs: 1_000, bodyMs: 5_000 };

/** The tool recovery `catalog_unavailable` carries (docs/design.md, Shared conventions). */
export const CATALOG_UNAVAILABLE_RECOVERY =
  'The ILOSTAT catalog could not be loaded from the upstream API; wait about a minute and call the tool again.';

/** The tool recovery `invalid_cursor` carries on search and list_reference. */
export const INVALID_CURSOR_RECOVERY =
  'Omit cursor to start from the first page, or pass next_cursor from the previous response unchanged.';

const FIXTURES = new URL('../fixtures/', import.meta.url);

/** A fixture file's text. */
export function fixtureText(path: string): string {
  return readFileSync(new URL(path, FIXTURES), 'utf8');
}

export type RawRow = Record<string, unknown>;

/** The raw rplumber catalog: both tables of contents and every dictionary, as upstream sends them. */
export interface CatalogFixture {
  dictionaries: Record<string, RawRow[]>;
  indicatorToc: RawRow[];
  refAreaToc: RawRow[];
}

/** A fresh, mutable copy of the recorded catalog fixture. */
export function loadCatalogFixture(): CatalogFixture {
  return {
    indicatorToc: JSON.parse(fixtureText('rplumber/toc-indicator.json')) as RawRow[],
    refAreaToc: JSON.parse(fixtureText('rplumber/toc-ref-area.json')) as RawRow[],
    dictionaries: JSON.parse(fixtureText('rplumber/dictionaries.json')) as Record<string, RawRow[]>,
  };
}

/**
 * The recorded catalog plus `observation-catalog-extras.json`: the headline
 * datasets the country profile reads (reported and modelled), the ILO modelled
 * estimates sources for KEN, USA, X01, and X06 (the only source label that
 * classifies a row as modelled), KEN's national survey sources, and the note codes
 * the data fixtures carry. Kept apart from `loadCatalogFixture()` because the
 * catalog tests assert its exact counts.
 */
export function observationCatalogFixture(): CatalogFixture {
  const fixture = loadCatalogFixture();
  const extras = JSON.parse(fixtureText('rplumber/observation-catalog-extras.json')) as {
    dictionaries: Record<string, RawRow[]>;
    indicatorToc: RawRow[];
  };
  fixture.indicatorToc.push(...extras.indicatorToc);
  for (const [name, rows] of Object.entries(extras.dictionaries)) {
    fixture.dictionaries[name] = [...(fixture.dictionaries[name] ?? []), ...rows];
  }
  return fixture;
}

/** Recorded `/data/indicator` bodies (`type=code`, `format=.csv`): BOM, quoted strings, bare numbers, LF. */
export const INDICATOR_CSV = {
  /**
   * `UNE_DEAP_SEX_AGE_RT_A`, merged from three captures: KEN SEX_T 15+ (6 rows,
   * 1999–2021, four national sources); USA SEX_T/M/F × 15+ and 15–24, 2023–2025
   * (compound note_source codes, `C6:1058` on the youth rows, status `B` in 2025);
   * X01 SEX_T 15+, 2000–2027, sourced to ILO modelled estimates (projections past 2024).
   */
  uneDeap: 'rplumber/une-deap-sex-age-rt-a.csv',
  /** KEN SEX_T 15+ under `best_source=all`: a trailing `best_source` column (1/0) and a note code (`T5:1429`) the dictionary lacks. */
  bestSourceAll: 'rplumber/une-deap-best-source-all.csv',
  /**
   * `id=LAP_2GDP_NOC_RT_A+UNE_2EAP_SEX_AGE_RT_A&ref_area=KEN&classif1=AGE_YTHADULT_YGE15&time=2020`:
   * the two datasets' header union with no note columns; the LAP row (empty sex and
   * classif1) passed the classif1 filter unfiltered.
   */
  multiDatasetUnion: 'rplumber/multi-dataset-union.csv',
  /** A valid dataset with an unknown `ref_area`: `200` with the header row only. */
  headerOnly: 'rplumber/header-only.csv',
} as const;

/**
 * Recorded `/data/ref_area` bodies (`format=.json`, `latestyear=TRUE`), trimmed to
 * the profile's headline slices (15+ and 15–24, sex-only and unbroken datasets
 * whole) plus the 25+ rows of the unemployment indicator, so local slicing has to
 * choose. The modelled KEN and X01 captures were recorded at `timeto=2025`, but the
 * service sends the Nov. 2025 edition's cutoff, `timeto=2024`: their periods are
 * set to 2024 keeping the recorded shape and values. `kenModelled2025` keeps the
 * capture's 2025 periods verbatim, for the case where rows past the cutoff must be
 * excluded.
 */
export const REF_AREA_JSON = {
  /** `id=KEN_A`, the six reported headline indicators, latest year (2021; informality 2019). */
  kenReported: 'rplumber/ref-area-ken-reported.json',
  /** `id=KEN_A`, the modelled headline indicators at 2024 (no informality estimate for KEN). */
  kenModelled: 'rplumber/ref-area-ken-modelled.json',
  kenModelled2025: 'rplumber/ref-area-ken-modelled-2025.json',
  /** `id=X01_A`, the modelled unemployment rate and labour income share at 2024. */
  x01Modelled: 'rplumber/ref-area-x01-modelled.json',
} as const;

/** The rows of a recorded `/data/ref_area` body. */
export function refAreaRows(name: keyof typeof REF_AREA_JSON): RawRow[] {
  return JSON.parse(fixtureText(REF_AREA_JSON[name])) as RawRow[];
}

/** One ToC row of the fixture by `id`, for tests that alter a single dataset. */
export function tocRow(fixture: CatalogFixture, id: string): RawRow {
  const row = fixture.indicatorToc.find((entry) => entry.id === id);
  if (!row) throw new Error(`No fixture ToC row ${id}`);
  return row;
}

/** A 200 exactly as rplumber sends every body: `application/octet-stream`, as an attachment. */
export function rplumberBody(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename=response.json',
    },
  });
}

const CSV_HEADERS = {
  'content-type': 'application/octet-stream',
  'content-disposition': 'attachment; filename=response.csv',
};

/** A `/data/indicator` 200 as rplumber sends it: `application/octet-stream`, as an attachment. */
export function csvResponse(text: string): Response {
  return new Response(text, { status: 200, headers: CSV_HEADERS });
}

/** The recorded `400` for a dataset ID upstream no longer serves, byte for byte. */
export function retiredDatasetResponse(): Response {
  const body = JSON.stringify(JSON.parse(fixtureText('rplumber/retired-dataset.json')));
  return new Response(body, { status: 400, headers: { 'content-type': 'application/json' } });
}

/** The recorded `400` body, naming `id` as the dataset ID upstream could not serve. */
function invalidDatasetResponse(id: string): Response {
  const recorded = JSON.parse(fixtureText('rplumber/retired-dataset.json')) as RawRow;
  const body = JSON.stringify({ ...recorded, error: `deprecated or invalid dataset id=${id}` });
  return new Response(body, { status: 400, headers: { 'content-type': 'application/json' } });
}

/** The recorded Cloudflare challenge page: `cf-mitigated: challenge`, HTML body, HTTP 403. */
export function challengePage(): Response {
  return new Response('<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>', {
    status: 403,
    headers: { 'content-type': 'text/html; charset=UTF-8', 'cf-mitigated': 'challenge' },
  });
}

/** An HTTP 429; `retryAfter` sets the `Retry-After` delta-seconds header. */
export function tooManyRequests(retryAfter?: string): Response {
  return new Response('Too Many Requests', {
    status: 429,
    headers: {
      'content-type': 'text/plain',
      ...(retryAfter === undefined ? {} : { 'retry-after': retryAfter }),
    },
  });
}

/** A plain-text SDMX response, the shape of every SDMX error body. */
export function sdmxText(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

export const SDMX_404_NO_STRUCTURE = 'Could not find requested structures';
export const SDMX_404_NO_DATA =
  'No data is found. Please adjust your query parameters and try again.';
export const SDMX_500_ORA =
  'ORA-00936: missing expression\nhttps://docs.oracle.com/error-help/db/ora-00936/';
export const SDMX_422_SHORT_KEY = 'Not enough key values in query, expecting 5 got 3';

/** The recorded SDMX-JSON structure document for an indicator. */
export function structureDocument(indicator: string): Record<string, unknown> {
  return JSON.parse(fixtureText(`sdmx/structure-${indicator}.json`)) as Record<string, unknown>;
}

export function structureResponse(document: unknown): Response {
  return new Response(JSON.stringify(document), {
    status: 200,
    headers: { 'content-type': 'application/vnd.sdmx.structure+json; version=1.0; charset=utf-8' },
  });
}

export function probeResponse(csv: string): Response {
  return new Response(csv, {
    status: 200,
    headers: { 'content-type': 'application/vnd.sdmx.data+csv; charset=utf-8' },
  });
}

function hasPath(request: Request, origin: string, pathname: string): boolean {
  const url = new URL(request.url);
  return url.origin === origin && url.pathname === pathname;
}

/** An rplumber request to `pathname`. */
export function isRplumber(request: Request, pathname: string): boolean {
  return hasPath(request, RPLUMBER_ORIGIN, pathname);
}

/** An rplumber `/data/indicator` request. */
export function isIndicatorData(request: Request): boolean {
  return isRplumber(request, '/data/indicator');
}

/** An rplumber `/data/ref_area` request. */
export function isRefAreaData(request: Request): boolean {
  return isRplumber(request, '/data/ref_area');
}

/**
 * A request's query parameters as rplumber reads them: a literal `+` is the list
 * separator, never a space as `URLSearchParams` would decode it. A `%2B` decodes
 * to the same `+` here; only `id` tells the two apart ({@link indicatorDataRoute}).
 */
export function upstreamParams(url: URL): URLSearchParams {
  return new URLSearchParams(url.search.replaceAll('+', '%2B'));
}

/**
 * The `id` elements as rplumber splits them: on a literal `+` only. Verified live:
 * `id=A+B` returns both datasets, while `id=A%2BB` is read as the single ID `A+B`
 * and answered `400 deprecated or invalid dataset id=A+B`.
 */
function requestedIds(url: URL): string[] {
  const raw = url.search
    .slice(1)
    .split('&')
    .find((pair) => pair.startsWith('id='));
  return raw ? raw.slice(3).split('+').map(decodeURIComponent) : [];
}

/** Code-list parameters the emulator applies, each to the CSV column of the same name. */
const CODE_FILTERS = ['ref_area', 'sex', 'classif1', 'classif2', 'source'] as const;

/** Splits one recorded CSV line; the recorded bodies carry no comma or quote inside a quoted field. */
const csvCells = (line: string): string[] =>
  line.split(',').map((cell) => cell.replace(/^"(.*)"$/, '$1'));

/**
 * Emulates `/data/indicator` over a recorded CSV body: keeps the rows the request
 * selects by `id` (its indicator codes), `ref_area`, `sex`, `classif1`, `classif2`,
 * `source`, `time` (`+`-joined periods), `timefrom`, and `timeto` (years), every
 * list read as {@link upstreamParams} reads it. A code filter applies only to rows
 * whose cell for it is non-empty — upstream's rule: a dataset without the breakdown
 * passes through unfiltered. `latestyear`, `best_source`, `type`, and `format` are
 * not emulated; serve a fixture recorded with them instead. Kept lines are returned
 * byte for byte, header (and BOM) first.
 */
export function filterIndicatorCsv(csv: string, url: URL): string {
  const [header = '', ...lines] = csv.split('\n').filter((line) => line !== '');
  const columns = csvCells(header.replace(/^﻿/, ''));
  const params = upstreamParams(url);
  const listed = (name: string): Set<string> | undefined => {
    const value = params.get(name);
    return value ? new Set(value.split('+')) : undefined;
  };
  const indicators = listed('id');
  const codeFilters = CODE_FILTERS.flatMap((name) => {
    const allowed = listed(name);
    return allowed ? [{ name, allowed }] : [];
  });
  const periods = listed('time');
  const from = params.has('timefrom') ? Number(params.get('timefrom')) : undefined;
  const to = params.has('timeto') ? Number(params.get('timeto')) : undefined;

  const kept = lines.filter((line) => {
    const cells = csvCells(line);
    const cell = (name: string): string => cells[columns.indexOf(name)] ?? '';
    const year = Number(cell('time').slice(0, 4));
    return (
      (!indicators ||
        [...indicators].some((id) => id.replace(/_[AQM]$/, '') === cell('indicator'))) &&
      codeFilters.every(({ name, allowed }) => cell(name) === '' || allowed.has(cell(name))) &&
      (!periods || periods.has(cell('time'))) &&
      (from === undefined || year >= from) &&
      (to === undefined || year <= to)
    );
  });
  return `${[header, ...kept].join('\n')}\n`;
}

/**
 * `/data/indicator` route answering each request with `csv` filtered by
 * {@link filterIndicatorCsv} — or, as upstream does, with the invalid-dataset `400`
 * when an `id` element holds a `+` that arrived percent-encoded.
 */
export function indicatorDataRoute(csv: string): FetchMockRoute {
  return {
    method: 'GET',
    match: (request) => isIndicatorData(request),
    respond: (request) => {
      const url = new URL(request.url);
      const joinedAsOne = requestedIds(url).find((id) => id.includes('+'));
      return joinedAsOne
        ? invalidDatasetResponse(joinedAsOne)
        : csvResponse(filterIndicatorCsv(csv, url));
    },
  };
}

/** A CSV body served on demand, recording how much of it the reader took. */
export interface StreamedCsv {
  /** True once the reader cancelled the body, ending the transfer early. */
  readonly cancelled: boolean;
  /** Data rows handed to the body so far, across every response served; the header is not counted. */
  readonly pulled: number;
  /** A fresh 200 whose body yields the header, then `rowsPerPull` rows per read. Serve it from a route factory. */
  response(): Response;
}

/**
 * A pull-based `/data/indicator` body of `rowCount` rows built by `row(index)`:
 * nothing is produced until the reader asks for it, so `pulled` shows how far a
 * reader got before it stopped, and `cancelled` whether it closed the body.
 */
export function streamedCsv(
  header: string,
  rowCount: number,
  row: (index: number) => string,
  rowsPerPull = 100,
): StreamedCsv {
  const encoder = new TextEncoder();
  const state = { pulled: 0, cancelled: false };
  return {
    get cancelled() {
      return state.cancelled;
    },
    get pulled() {
      return state.pulled;
    },
    response() {
      let next = 0;
      let headerSent = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (!headerSent) {
              headerSent = true;
              controller.enqueue(encoder.encode(`﻿${header}\n`));
              return;
            }
            if (next >= rowCount) {
              controller.close();
              return;
            }
            const lines: string[] = [];
            while (next < rowCount && lines.length < rowsPerPull) lines.push(row(next++));
            state.pulled += lines.length;
            controller.enqueue(encoder.encode(`${lines.join('\n')}\n`));
          },
          cancel() {
            state.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, { status: 200, headers: CSV_HEADERS });
    },
  };
}

/**
 * A real in-memory DuckDB canvas, as `core.canvas` builds one, minus the sweeper
 * timer. Its provider disables extension autoinstall/autoload, so it never reaches
 * the network. Call `canvas.shutdown(ctx)` after each test.
 */
export function memoryCanvas(): DataCanvas {
  const provider = new DuckdbProvider({
    memoryLimitMb: 256,
    exportRootPath: join(tmpdir(), 'ilostat-mcp-server-test-exports'),
    defaultRowLimit: 10_000,
    schemaSniffRows: 100,
  });
  return new DataCanvas(
    provider,
    new CanvasRegistry(provider, { ...DEFAULT_CANVAS_REGISTRY_OPTIONS, sweeperIntervalMs: 0 }),
  );
}

/** Where a {@link faultyCanvas} breaks. */
export type CanvasFault =
  /** Every `acquire` rejects with `error` — an engine that cannot load or start. */
  | { at: 'acquire'; error: Error }
  /** `registerTable` appends `afterRows` rows, then the append fails with `error`. */
  | { at: 'registerTable'; afterRows: number; error: Error }
  /** Every table `drop` rejects with `error`, leaving the table in place. */
  | { at: 'drop'; error: Error };

/**
 * A {@link memoryCanvas} whose engine fails at one step, the way DuckDB fails:
 * the rest of the canvas is real, so a partial table really exists until the
 * code under test drops it. Call `canvas.shutdown(ctx)` after each test.
 */
export function faultyCanvas(fault: CanvasFault): DataCanvas {
  const canvas = memoryCanvas();
  const acquire = canvas.acquire.bind(canvas);
  canvas.acquire = async (maybeId, context, options) => {
    if (fault.at === 'acquire') throw fault.error;
    const instance = await acquire(maybeId, context, options);
    if (fault.at === 'drop') {
      instance.drop = () => Promise.reject(fault.error);
      return instance;
    }
    const registerTable = instance.registerTable.bind(instance);
    instance.registerTable = (name, rows, registerOptions) =>
      registerTable(
        name,
        (async function* () {
          let appended = 0;
          for await (const row of rows) {
            if (appended === fault.afterRows) throw fault.error;
            appended++;
            yield row;
          }
        })(),
        registerOptions,
      );
    return instance;
  };
  return canvas;
}

/** An rplumber dictionary request for `dictionary`. */
export function isDictionary(request: Request, dictionary: string): boolean {
  return (
    isRplumber(request, '/metadata/dic') &&
    new URL(request.url).searchParams.get('var') === dictionary
  );
}

/** An SDMX dataflow-structure request (for `indicator`, when given). */
export function isStructureRequest(request: Request, indicator?: string): boolean {
  const url = new URL(request.url);
  if (url.origin !== SDMX_ORIGIN) return false;
  return indicator === undefined
    ? /^\/rest\/dataflow\/ILO\/DF_[^/]+\/latest$/.test(url.pathname)
    : url.pathname === `/rest/dataflow/ILO/DF_${indicator}/latest`;
}

/** An SDMX unit-probe request (for `indicator` and series `key`, when given). */
export function isProbeRequest(request: Request, indicator?: string, key?: string): boolean {
  const url = new URL(request.url);
  if (url.origin !== SDMX_ORIGIN || !url.pathname.startsWith('/rest/data/')) return false;
  if (indicator === undefined) return true;
  const prefix = `/rest/data/ILO,DF_${indicator},1.0/`;
  if (!url.pathname.startsWith(prefix)) return false;
  return key === undefined || url.pathname === `${prefix}${key}`;
}

/** Routes serving the catalog fixture, read at request time so a test can change it between loads. */
export function catalogRoutes(fixture: CatalogFixture): FetchMockRoute[] {
  return [
    {
      method: 'GET',
      match: (request) => isRplumber(request, '/metadata/toc/indicator'),
      respond: () => rplumberBody(fixture.indicatorToc),
    },
    {
      method: 'GET',
      match: (request) => isRplumber(request, '/metadata/toc/ref_area'),
      respond: () => rplumberBody(fixture.refAreaToc),
    },
    {
      method: 'GET',
      match: (request) => isRplumber(request, '/metadata/dic'),
      respond: (request) => {
        const dictionary = new URL(request.url).searchParams.get('var') ?? '';
        const rows = fixture.dictionaries[dictionary];
        if (!rows) throw new Error(`No dictionary fixture for var=${dictionary}`);
        return rplumberBody(rows);
      },
    },
  ];
}

/** Structure route for `indicator`: the recorded document unless `respond` replaces it. */
export function structureRoute(indicator: string, respond?: FetchMockResponder): FetchMockRoute {
  return {
    method: 'GET',
    match: (request) => isStructureRequest(request, indicator),
    respond: respond ?? (() => structureResponse(structureDocument(indicator))),
  };
}

/** Unit-probe route for `indicator` and `key`: the recorded CSV unless `respond` replaces it. */
export function probeRoute(
  indicator: string,
  key: string,
  respond?: FetchMockResponder,
): FetchMockRoute {
  return {
    method: 'GET',
    match: (request) => isProbeRequest(request, indicator, key),
    respond: respond ?? (() => probeResponse(fixtureText(`sdmx/probe-${indicator}.csv`))),
  };
}

/**
 * Every recorded SDMX fixture — structure plus the probe of the first constrained
 * area — and a 404 for any other dataflow, as SDMX answers an indicator it lacks.
 */
export function sdmxFixtureRoutes(): FetchMockRoute[] {
  return [
    structureRoute('UNE_DEAP_SEX_AGE_RT'),
    probeRoute('UNE_DEAP_SEX_AGE_RT', 'ABW....'),
    structureRoute('LAP_2LID_QTL_RT'),
    probeRoute('LAP_2LID_QTL_RT', 'KEN...'),
    structureRoute('EMP_TEMP_SEX_INS_DSB_NB'),
    probeRoute('EMP_TEMP_SEX_INS_DSB_NB', 'KEN.....'),
    structureRoute('SDG_0552_NOC_RT'),
    probeRoute('SDG_0552_NOC_RT', 'KEN..'),
    {
      method: 'GET',
      match: (request) => isStructureRequest(request),
      respond: () => sdmxText(SDMX_404_NO_STRUCTURE, 404),
    },
  ];
}

/** Client options with the fast test timers; `overrides` replace any of them. */
export function clientOptions(
  fetch: FetchFn,
  overrides: Partial<UpstreamClientOptions> = {},
): UpstreamClientOptions {
  return {
    fetch,
    userAgent: TEST_USER_AGENT,
    pacing: FAST_PACING,
    retry: NO_RETRY,
    timeouts: FAST_TIMEOUTS,
    ...overrides,
  };
}

/** The limits the server reads from env config (1,000 minimum each), set here through the constructors instead. */
export interface ObservationLimits {
  /** Response-cache TTL; `0` disables the cache. Defaults to `ILOSTAT_CACHE_TTL_SECONDS`. */
  cacheTtlMs?: number;
  /** Defaults to `ILOSTAT_MAX_ROWS`. */
  maxRows?: number;
  /** Defaults to `ILOSTAT_PREVIEW_CHARS`. */
  previewChars?: number;
}

export interface WireOptions {
  /** `core.canvas`; absent leaves dataframes off (no bridge). */
  canvas?: DataCanvas;
  fixture?: CatalogFixture;
  now?: () => Date;
  /** Rebuilds the observation and profile services over these limits and one fresh response cache. */
  observations?: ObservationLimits;
  readyTimeoutMs?: number;
  /** Extra routes, matched before the fixture routes. */
  routes?: FetchMockRoute[];
  rplumber?: Partial<UpstreamClientOptions>;
  sdmx?: Partial<UpstreamClientOptions>;
}

export interface WiredServices {
  fixture: CatalogFixture;
  http: FetchMockHarness;
  services: IlostatServices;
}

/**
 * Wires the ILOSTAT services the tool handlers read through
 * `initIlostatServices({ rplumber, sdmx, catalog, canvas, now })`, both clients
 * over one fetch fake serving the fixtures. The catalog is not started: the first
 * `ready()` loads it on demand, and no refresh timer is armed. With `observations`,
 * the observation and profile services are rebuilt in the returned services object
 * — the one `getIlostatServices()` hands the tools — over the given limits.
 */
export function wireServices(options: WireOptions = {}): WiredServices {
  const fixture = options.fixture ?? loadCatalogFixture();
  const http = createFetchMock([
    ...(options.routes ?? []),
    ...catalogRoutes(fixture),
    ...sdmxFixtureRoutes(),
  ]);
  const now = options.now ?? (() => FIXED_NOW);
  const rplumber = new RplumberClient(clientOptions(http.fetch, options.rplumber));
  const sdmx = new SdmxClient(clientOptions(http.fetch, options.sdmx));
  const catalog = new CatalogService({
    rplumber,
    now,
    refreshIntervalMs: 0,
    ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }),
  });
  const services = initIlostatServices({ rplumber, sdmx, catalog, canvas: options.canvas, now });
  if (options.observations) {
    const config = getServerConfig();
    const limits = options.observations;
    const cache = new ResponseCache({
      ttlMs: limits.cacheTtlMs ?? config.cacheTtlSeconds * 1000,
      now,
    });
    services.observations = new ObservationService({
      rplumber,
      structure: services.structure,
      catalog,
      cache,
      maxRows: limits.maxRows ?? config.maxRows,
      previewChars: limits.previewChars ?? config.previewChars,
      now,
      ...(services.bridge ? { bridge: services.bridge } : {}),
    });
    services.profiles = new ProfileService({ rplumber, catalog, cache });
  }
  return { http, fixture, services };
}

/** The inline preview {@link wireDataframes} sets: a three-area query (52 rows) or a three-value comparison stages. */
export const DATAFRAME_PREVIEW_CHARS = 600;

/**
 * {@link wireServices} for the dataframe tools: the observation catalog, the
 * recorded `UNE_DEAP_SEX_AGE_RT_A` CSV behind the upstream emulator, and a
 * {@link DATAFRAME_PREVIEW_CHARS} preview, so the producers stage what
 * {@link stageObservations} asks for. Without `canvas`, dataframes are off.
 */
export function wireDataframes(options: WireOptions = {}): WiredServices {
  return wireServices({
    ...options,
    fixture: options.fixture ?? observationCatalogFixture(),
    routes: [...(options.routes ?? []), indicatorDataRoute(fixtureText(INDICATOR_CSV.uneDeap))],
    observations: { previewChars: DATAFRAME_PREVIEW_CHARS, ...options.observations },
  });
}

/**
 * `ctx`, reading and writing `source`'s tenant state: every tool call gets a
 * context of its own (its contract, its enrichment) while all of them see one
 * stored canvas ID and one set of dataframes, as calls on one tenant do.
 */
export function sharingState<T extends Context>(ctx: T, source: Context): T {
  Object.defineProperty(ctx, 'state', { value: source.state });
  return ctx;
}

/**
 * Stages `UNE_DEAP_SEX_AGE_RT_A` for `refAreas` (every recorded year) through
 * `ilostat_query_indicator` on `ctx`'s tenant canvas, and returns the dataframe
 * it reports. The producer reads its own contract only on a failure, which
 * staging never reaches, so any tenant context will do.
 */
export async function stageObservations(
  ctx: Context,
  refAreas: string[] = ['USA', 'X01', 'KEN'],
): Promise<{ expires_at: string; name: string; row_count: number }> {
  const result = await queryIndicatorTool.handler(
    queryIndicatorTool.input.parse({ dataset_ids: ['UNE_DEAP_SEX_AGE_RT_A'], ref_areas: refAreas }),
    ctx as unknown as Parameters<typeof queryIndicatorTool.handler>[1],
  );
  if (!result.dataframe) throw new Error(`Nothing was staged for ${refAreas.join(', ')}`);
  return result.dataframe;
}

/** URLs of the captured calls matching `predicate`. */
export function callUrls(
  http: FetchMockHarness,
  predicate: (request: Request) => boolean = () => true,
): URL[] {
  return http.calls
    .filter((call) => predicate(call.request))
    .map((call) => new URL(call.request.url));
}

/**
 * A fetch that never answers and rejects with the abort reason once the signal it
 * was handed aborts — the signal the code under test passed, observed directly:
 * a `Request` built from it (as `createFetchMock` builds) follows it through a weak
 * reference, which garbage collection can sever mid-test.
 */
export function hangingFetch(): { fetch: FetchFn; signals: AbortSignal[]; urls: string[] } {
  const urls: string[] = [];
  const signals: AbortSignal[] = [];
  const fetch: FetchFn = (input, init) => {
    urls.push(input);
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      signals.push(signal);
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  return { fetch, signals, urls };
}
