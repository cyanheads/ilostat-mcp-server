/**
 * @fileoverview Tests for `RplumberClient`'s data path over fetch fakes serving the
 * recorded `/data/indicator` CSV and `/data/ref_area` JSON bodies: the per-endpoint
 * parameter allowlist (never a blank value; `/data/ref_area` suffixes only the area,
 * never the indicator codes), CSV and JSON records normalized header-driven, the
 * retired-dataset `400` mapping, and the stream's lifetime — retried only up to the
 * headers, `Timeout` on a stall, `ServiceUnavailable` on a dropped connection, the
 * caller's abort passed through, the body locked the moment the stream opens (the
 * garbage-collection regression), and the signal handed to fetch left unaborted
 * until the caller ends the transfer.
 * @module tests/services/rplumber/rplumber-data.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, type FetchMockRoute } from '@cyanheads/mcp-ts-core/testing';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it } from 'vitest';
import { type IndicatorDataParams, RplumberClient } from '@/services/rplumber/rplumber-client.js';
import type { RawObservation } from '@/services/rplumber/types.js';
import type {
  FetchFn,
  UpstreamClientOptions,
  UpstreamScope,
} from '@/services/upstream/upstream-http.js';
import {
  clientOptions,
  csvResponse,
  fixtureText,
  INDICATOR_CSV,
  indicatorDataRoute,
  isIndicatorData,
  isRefAreaData,
  RPLUMBER_ORIGIN,
  refAreaRows,
  retiredDatasetResponse,
  rplumberBody,
  streamedCsv,
} from '../../helpers/ilostat-upstream.js';
import { guardNetwork } from '../../helpers/network-guard.js';

guardNetwork();

/** The parameters each data endpoint may carry (docs/design.md, API Reference). */
const ALLOWLIST: Record<string, readonly string[]> = {
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
};

const HEADER =
  '"ref_area","source","indicator","sex","classif1","time","obs_value","obs_status","note_classif","note_indicator","note_source"';
const USA_ROW =
  '"USA","BA:453","UNE_DEAP_SEX_AGE_RT","SEX_T","AGE_YTHADULT_YGE15","2024",4.022,,,,"R1:3513_T2:85"';
const RETRY_TWICE = { maxRetries: 2, baseDelayMs: 0, deadlineMs: 5_000 };
const UNE = ['UNE_DEAP_SEX_AGE_RT_A'];

const clients: RplumberClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});

function rplumber(fetch: FetchFn, overrides: Partial<UpstreamClientOptions> = {}): RplumberClient {
  const client = new RplumberClient(clientOptions(fetch, overrides));
  clients.push(client);
  return client;
}

function routed(routes: FetchMockRoute[], overrides: Partial<UpstreamClientOptions> = {}) {
  const http = createFetchMock(routes);
  return { http, client: rplumber(http.fetch, overrides) };
}

function scope(extra: Partial<UpstreamScope> = {}): UpstreamScope {
  return {
    ...requestContextService.createRequestContext({ operation: 'rplumber-data-test' }),
    ...extra,
  };
}

async function drain<T>(rows: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const row of rows) collected.push(row);
  return collected;
}

/** Streams `/data/indicator` for `params` through `client` and collects every row. */
async function streamRows(
  client: RplumberClient,
  params: Partial<IndicatorDataParams> = {},
): Promise<RawObservation[]> {
  const url = client.indicatorDataUrl({ datasetIds: UNE, ...params });
  return drain(await client.streamIndicatorData(url, scope(), new AbortController().signal));
}

async function rejection(promise: Promise<unknown>): Promise<McpError> {
  return (await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  )) as McpError;
}

const encoder = new TextEncoder();

/**
 * A fetch that answers every call with `text` in 64-character chunks and, as Node's
 * fetch does, errors the body once the signal it was handed aborts. It records the
 * signal and the `Response` so a test can watch both.
 */
function recordingFetch(text: string) {
  const signals: AbortSignal[] = [];
  const responses: Response[] = [];
  const fetch: FetchFn = async (_url, init) => {
    const signal = init?.signal;
    if (!signal) throw new Error('expected fetch to receive a signal');
    signals.push(signal);
    const chunks = text.match(/[\s\S]{1,64}/g) ?? [];
    let next = 0;
    let settled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener(
          'abort',
          () => {
            if (settled) return;
            settled = true;
            controller.error(signal.reason);
          },
          { once: true },
        );
      },
      pull(controller) {
        const chunk = chunks[next++];
        if (chunk !== undefined) {
          controller.enqueue(encoder.encode(chunk));
          return;
        }
        settled = true;
        controller.close();
      },
      cancel() {
        settled = true;
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
    responses.push(response);
    return response;
  };
  return { fetch, signals, responses };
}

describe('/data/indicator request', () => {
  it('sends each filter as its allowlisted parameter, lists +-joined, codes and CSV fixed', () => {
    const client = rplumber(createFetchMock([]).fetch);
    const url = new URL(
      client.indicatorDataUrl({
        datasetIds: ['UNE_DEAP_SEX_AGE_RT_A', 'UNE_2EAP_SEX_AGE_RT_A'],
        refAreas: ['USA', 'KEN'],
        sex: ['SEX_T', 'SEX_F'],
        classif1: ['AGE_YTHADULT_YGE15'],
        classif2: ['GEO_COV_NAT'],
        sources: ['BA:453'],
        time: ['2023', '2025'],
        timeFrom: 2016,
        timeTo: 2024,
        latestOnly: true,
        bestSource: 'all',
      }),
    );
    expect(url.origin + url.pathname).toBe(`${RPLUMBER_ORIGIN}/data/indicator`);
    expect([...url.searchParams]).toEqual([
      ['id', 'UNE_DEAP_SEX_AGE_RT_A+UNE_2EAP_SEX_AGE_RT_A'],
      ['ref_area', 'USA+KEN'],
      ['sex', 'SEX_T+SEX_F'],
      ['classif1', 'AGE_YTHADULT_YGE15'],
      ['classif2', 'GEO_COV_NAT'],
      ['source', 'BA:453'],
      ['time', '2023+2025'],
      ['timefrom', '2016'],
      ['timeto', '2024'],
      ['latestyear', 'TRUE'],
      ['best_source', 'all'],
      ['type', 'code'],
      ['format', '.csv'],
    ]);
    for (const [name] of url.searchParams) {
      expect(ALLOWLIST['/data/indicator']).toContain(name);
    }
  });

  it('leaves out every unset, empty, or blank filter instead of sending it blank', () => {
    const client = rplumber(createFetchMock([]).fetch);
    const url = new URL(
      client.indicatorDataUrl({
        datasetIds: UNE,
        refAreas: [],
        sex: [''],
        classif1: ['  '],
        sources: [],
        time: [],
        latestOnly: false,
      }),
    );
    expect([...url.searchParams]).toEqual([
      ['id', 'UNE_DEAP_SEX_AGE_RT_A'],
      ['type', 'code'],
      ['format', '.csv'],
    ]);
    expect(url.search).not.toMatch(/=(&|$)/);
  });

  it('requests exactly the URL built, asking for CSV with the identifying headers', async () => {
    const { http, client } = routed([indicatorDataRoute(fixtureText(INDICATOR_CSV.uneDeap))]);
    const url = client.indicatorDataUrl({ datasetIds: UNE, refAreas: ['USA'], timeFrom: 2025 });
    await drain(await client.streamIndicatorData(url, scope(), new AbortController().signal));
    const [call] = http.calls;
    expect(call?.request.url).toBe(url);
    expect(call?.request.method).toBe('GET');
    expect(call?.request.headers.get('accept')).toBe('text/csv');
    expect(call?.request.headers.get('accept-language')).toBe('en');
  });
});

describe('/data/ref_area request', () => {
  it('suffixes the area as its annual ToC id and sends the indicator codes as given', () => {
    const client = rplumber(createFetchMock([]).fetch);
    const url = new URL(
      client.refAreaDataUrl({
        area: 'KEN',
        indicators: ['EAP_2WAP_SEX_AGE_RT', 'UNE_2EAP_SEX_AGE_RT', 'LAP_2GDP_NOC_RT'],
        latestOnly: true,
        timeTo: 2024,
      }),
    );
    expect(url.origin + url.pathname).toBe(`${RPLUMBER_ORIGIN}/data/ref_area`);
    expect([...url.searchParams]).toEqual([
      ['id', 'KEN_A'],
      ['indicator', 'EAP_2WAP_SEX_AGE_RT+UNE_2EAP_SEX_AGE_RT+LAP_2GDP_NOC_RT'],
      ['timeto', '2024'],
      ['latestyear', 'TRUE'],
      ['format', '.json'],
    ]);
    for (const [name] of url.searchParams) expect(ALLOWLIST['/data/ref_area']).toContain(name);
    for (const code of url.searchParams.get('indicator')?.split('+') ?? []) {
      expect(code).not.toMatch(/_[AQM]$/);
    }
  });

  it('leaves out timeto and latestyear when unset', () => {
    const client = rplumber(createFetchMock([]).fetch);
    const url = new URL(
      client.refAreaDataUrl({
        area: 'X01',
        indicators: ['UNE_2EAP_SEX_AGE_RT'],
        latestOnly: false,
      }),
    );
    expect([...url.searchParams.keys()]).toEqual(['id', 'indicator', 'format']);
    expect(url.searchParams.get('id')).toBe('X01_A');
  });

  it('normalizes the recorded JSON rows, sparse fields left absent', async () => {
    const { http, client } = routed([
      { match: isRefAreaData, respond: () => rplumberBody(refAreaRows('kenModelled')) },
    ]);
    const url = client.refAreaDataUrl({
      area: 'KEN',
      indicators: ['LAP_2GDP_NOC_RT', 'SDG_0111_SEX_AGE_RT'],
      latestOnly: true,
      timeTo: 2024,
    });
    const rows = await client.getRefAreaData(url, scope());
    expect(http.calls[0]?.request.headers.get('accept')).toBe('application/json');
    expect(rows).toHaveLength(32);
    expect(rows.find((row) => row.indicator === 'LAP_2GDP_NOC_RT')).toEqual({
      refArea: 'KEN',
      source: 'XA:1909',
      indicator: 'LAP_2GDP_NOC_RT',
      period: '2024',
      notes: [],
      value: 33.276,
      obsStatus: 'M',
    });
    expect(rows.find((row) => row.indicator === 'EIP_2EET_SEX_RT' && row.sex === 'SEX_F')).toEqual({
      refArea: 'KEN',
      source: 'XA:1909',
      indicator: 'EIP_2EET_SEX_RT',
      period: '2024',
      notes: [],
      sex: 'SEX_F',
      value: 25.745,
    });
  });

  it('reads a numeric time, a null value, and compound notes', async () => {
    const { client } = routed([
      {
        match: isRefAreaData,
        respond: () =>
          rplumberBody([
            {
              ref_area: 'KEN',
              source: 'BX:3465',
              indicator: 'UNE_DEAP_SEX_AGE_RT',
              sex: 'SEX_T',
              classif1: 'AGE_YTHADULT_YGE15',
              time: 2021,
              obs_value: null,
              note_indicator: 'I11:264',
              note_source: 'R1:3513_T2:85',
            },
          ]),
      },
    ]);
    const url = client.refAreaDataUrl({
      area: 'KEN',
      indicators: ['UNE_DEAP_SEX_AGE_RT'],
      latestOnly: true,
    });
    expect(await client.getRefAreaData(url, scope())).toEqual([
      {
        refArea: 'KEN',
        source: 'BX:3465',
        indicator: 'UNE_DEAP_SEX_AGE_RT',
        period: '2021',
        notes: ['I11:264', 'R1:3513', 'T2:85'],
        sex: 'SEX_T',
        classif1: 'AGE_YTHADULT_YGE15',
      },
    ]);
  });
});

describe('/data/indicator records', () => {
  it('splits compound notes in note_classif, note_indicator, note_source order', async () => {
    const { client } = routed([indicatorDataRoute(fixtureText(INDICATOR_CSV.uneDeap))]);
    const rows = await streamRows(client, {
      refAreas: ['USA'],
      sex: ['SEX_T'],
      time: ['2025'],
    });
    expect(rows).toEqual([
      {
        refArea: 'USA',
        source: 'BA:453',
        indicator: 'UNE_DEAP_SEX_AGE_RT',
        period: '2025',
        notes: ['I11:264', 'R1:3513', 'R1:2803', 'T2:85'],
        sex: 'SEX_T',
        classif1: 'AGE_YTHADULT_YGE15',
        value: 4.282,
        obsStatus: 'B',
      },
      {
        refArea: 'USA',
        source: 'BA:453',
        indicator: 'UNE_DEAP_SEX_AGE_RT',
        period: '2025',
        notes: ['C6:1058', 'I11:264', 'R1:3513', 'R1:2803', 'T2:85'],
        sex: 'SEX_T',
        classif1: 'AGE_YTHADULT_Y15-24',
        value: 9.981,
        obsStatus: 'B',
      },
    ]);
  });

  it('reads a two-dataset header union without note columns, absent cells left absent', async () => {
    const { client } = routed([indicatorDataRoute(fixtureText(INDICATOR_CSV.multiDatasetUnion))]);
    const rows = await streamRows(client, {
      datasetIds: ['LAP_2GDP_NOC_RT_A', 'UNE_2EAP_SEX_AGE_RT_A'],
      refAreas: ['KEN'],
      classif1: ['AGE_YTHADULT_YGE15'],
      time: ['2020'],
    });
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({
      refArea: 'KEN',
      source: 'XA:1909',
      indicator: 'LAP_2GDP_NOC_RT',
      period: '2020',
      notes: [],
      value: 36.723,
    });
    expect(rows[1]).toMatchObject({ indicator: 'UNE_2EAP_SEX_AGE_RT', sex: 'SEX_T', value: 5.613 });
  });

  it('reads best_source as a boolean only where the column is present', async () => {
    const { client } = routed([indicatorDataRoute(fixtureText(INDICATOR_CSV.bestSourceAll))]);
    const rows = await streamRows(client, { refAreas: ['KEN'], bestSource: 'all' });
    expect(rows.map((row) => `${row.period} ${row.source} ${row.bestSource}`)).toEqual([
      '2021 BX:3465 true',
      '2019 BX:3465 true',
      '2019 AA:1311 false',
      '2016 BB:7021 true',
      '2009 AA:1311 true',
      '2005 BB:7021 true',
      '1999 BA:7008 true',
      '1999 AA:1311 false',
    ]);

    const { client: preferred } = routed([indicatorDataRoute(fixtureText(INDICATOR_CSV.uneDeap))]);
    for (const row of await streamRows(preferred, { refAreas: ['KEN'] })) {
      expect(row).not.toHaveProperty('bestSource');
    }
  });

  it('leaves value absent for an empty obs_value', async () => {
    const { client } = routed([
      {
        match: isIndicatorData,
        respond: () =>
          csvResponse(
            `﻿${HEADER}\n"USA","BA:453","UNE_DEAP_SEX_AGE_RT","SEX_T","AGE_YTHADULT_YGE15","2025",,"U",,,\n`,
          ),
      },
    ]);
    const [row] = await streamRows(client);
    expect(row).not.toHaveProperty('value');
    expect(row).toMatchObject({ period: '2025', obsStatus: 'U', notes: [] });
  });

  it('reads a header-only body as zero rows', async () => {
    const { client } = routed([
      { match: isIndicatorData, respond: () => csvResponse(fixtureText(INDICATOR_CSV.headerOnly)) },
    ]);
    expect(
      await streamRows(client, { datasetIds: ['LAP_2GDP_NOC_RT_A'], refAreas: ['ZZZ'] }),
    ).toEqual([]);
  });
});

describe('/data/indicator failures', () => {
  it('maps the retired-dataset 400 to NotFound dataset_retired, with the recovery, never retried', async () => {
    const { http, client } = routed([{ match: isIndicatorData, respond: retiredDatasetResponse }], {
      retry: RETRY_TWICE,
    });
    const url = client.indicatorDataUrl({ datasetIds: ['FOO_BAR_A'] });
    const error = await rejection(
      client.streamIndicatorData(
        url,
        scope({ recoveryFor: (reason) => ({ recovery: { hint: `recover from ${reason}` } }) }),
        new AbortController().signal,
      ),
    );
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.message).toBe(
      'ILOSTAT no longer serves dataset FOO_BAR_A: the upstream reports a deprecated or invalid dataset ID.',
    );
    expect(error.data).toEqual({
      reason: 'dataset_retired',
      datasetId: 'FOO_BAR_A',
      recovery: { hint: 'recover from dataset_retired' },
    });
    expect(http.calls).toHaveLength(1);
  });

  it('fails any other 400 generically, without a reason or the body', async () => {
    for (const body of ['{"error":"invalid parameter: timefrom"}', 'Bad Request']) {
      const { http, client } = routed(
        [{ match: isIndicatorData, respond: () => new Response(body, { status: 400 }) }],
        { retry: RETRY_TWICE },
      );
      const error = await rejection(
        client.streamIndicatorData(
          client.indicatorDataUrl({ datasetIds: UNE }),
          scope(),
          new AbortController().signal,
        ),
      );
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBeUndefined();
      expect(error.message).toMatch(/^ILOSTAT API \(rplumber\.ilo\.org\) returned HTTP 400\./);
      expect(error.message).not.toContain('timefrom');
      expect(http.calls).toHaveLength(1);
    }
  });

  it('retries a transient failure before the headers arrive', async () => {
    const { http, client } = routed(
      [
        {
          match: isIndicatorData,
          respond: () => new Response('unavailable', { status: 503 }),
          once: true,
        },
        indicatorDataRoute(fixtureText(INDICATOR_CSV.uneDeap)),
      ],
      { retry: RETRY_TWICE },
    );
    expect(await streamRows(client, { refAreas: ['KEN'] })).toHaveLength(6);
    expect(http.calls).toHaveLength(2);
  });

  it('fails Timeout when the body stalls after the headers, and never retries it', async () => {
    const { http, client } = routed(
      [
        {
          match: isIndicatorData,
          respond: () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(encoder.encode(`﻿${HEADER}\n${USA_ROW}\n`));
                },
              }),
              { status: 200, headers: { 'content-type': 'application/octet-stream' } },
            ),
        },
      ],
      { retry: RETRY_TWICE, timeouts: { headersMs: 1_000, stallMs: 20 } },
    );
    const url = client.indicatorDataUrl({ datasetIds: UNE });
    const rows = await client.streamIndicatorData(url, scope(), new AbortController().signal);
    const iterator = rows[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ refArea: 'USA', value: 4.022 });
    const error = await rejection(iterator.next());
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.message).toBe(
      'ILOSTAT API (rplumber.ilo.org) stopped sending data for 0.02 s mid-response.',
    );
    expect(http.calls).toHaveLength(1);
  });

  it('fails ServiceUnavailable when the connection drops mid-body, and never retries it', async () => {
    const { http, client } = routed(
      [
        {
          match: isIndicatorData,
          respond: () => {
            let pulls = 0;
            return new Response(
              new ReadableStream<Uint8Array>({
                pull(controller) {
                  pulls += 1;
                  if (pulls === 1) controller.enqueue(encoder.encode(`﻿${HEADER}\n${USA_ROW}\n`));
                  else controller.error(new TypeError('terminated'));
                },
              }),
              { status: 200, headers: { 'content-type': 'application/octet-stream' } },
            );
          },
        },
      ],
      { retry: RETRY_TWICE },
    );
    const error = await rejection(streamRows(client));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toBe(
      'ILOSTAT API (rplumber.ilo.org) dropped the connection mid-response.',
    );
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(http.calls).toHaveLength(1);
  });

  it("passes the caller's abort through untouched, not as a dropped connection", async () => {
    // One row, then the body stays open — a long download — until the fetch signal aborts it.
    const open: FetchFn = async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`﻿${HEADER}\n${USA_ROW}\n`));
          const signal = init?.signal;
          signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(body, { status: 200 });
    };
    const client = rplumber(open);
    const controller = new AbortController();
    const rows = await client.streamIndicatorData(
      client.indicatorDataUrl({ datasetIds: UNE }),
      scope(),
      controller.signal,
    );
    const iterator = rows[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ refArea: 'USA' });
    const reason = new Error('reader stopped');
    const pending = iterator.next();
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('cancels the body when the reader stops early, bounding the transfer', async () => {
    const body = streamedCsv(
      HEADER,
      100_000,
      (index) => USA_ROW.replace('"2024"', `"${index}"`),
      100,
    );
    const { client } = routed([{ match: isIndicatorData, respond: () => body.response() }]);
    const rows = await client.streamIndicatorData(
      client.indicatorDataUrl({ datasetIds: UNE }),
      scope(),
      new AbortController().signal,
    );
    let read = 0;
    for await (const _row of rows) {
      read += 1;
      if (read === 150) break;
    }
    expect(body.cancelled).toBe(true);
    expect(body.pulled).toBeLessThanOrEqual(300);
  });
});

describe('the open stream', () => {
  /** The recorded body: 52 rows across KEN, USA, and X01. */
  const RECORDED = fixtureText(INDICATOR_CSV.uneDeap);

  it('locks the body before the first read, so a collected Response cannot empty it', async () => {
    const upstream = recordingFetch(RECORDED);
    const client = rplumber(upstream.fetch);
    const rows = await client.streamIndicatorData(
      client.indicatorDataUrl({ datasetIds: UNE }),
      scope(),
      new AbortController().signal,
    );
    const body = upstream.responses[0]?.body;
    if (!body) throw new Error('expected a response body');
    expect(body.locked).toBe(true);

    // Node's fetch finalizer: once the Response is garbage-collected, it cancels the body — unless locked.
    if (!body.locked) await body.cancel();
    expect(await drain(rows)).toHaveLength(52);
  });

  it('control: an unlocked body the finalizer cancels reads as empty, with no error', async () => {
    const body = csvResponse(RECORDED).body;
    if (!body) throw new Error('expected a body');
    if (!body.locked) await body.cancel();
    const reader = body.getReader();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  it('leaves the signal handed to fetch unaborted past the header timer and retry deadline', async () => {
    const upstream = recordingFetch(RECORDED);
    const client = rplumber(upstream.fetch, {
      timeouts: { headersMs: 20, stallMs: 1_000 },
      retry: { maxRetries: 0, baseDelayMs: 0, deadlineMs: 30 },
    });
    const controller = new AbortController();
    const rows = await client.streamIndicatorData(
      client.indicatorDataUrl({ datasetIds: UNE }),
      scope(),
      controller.signal,
    );
    const [signal] = upstream.signals;
    if (!signal) throw new Error('expected fetch to have been called');
    expect(signal.aborted).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(signal.aborted).toBe(false);
    expect(await drain(rows)).toHaveLength(52);
    expect(signal.aborted).toBe(false);

    controller.abort();
    expect(signal.aborted).toBe(true);
  });
});
