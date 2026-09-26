/**
 * @fileoverview Tests for the paced, retried HTTP layer both upstream clients share,
 * driven through `RplumberClient` and `SdmxClient` over fetch fakes: the throttling
 * mapping (HTTP 429, Cloudflare challenge pages, pacer sheds → `upstream_busy`), the
 * cooldown the in-task busy check trips, retry of transient failures only, the
 * header and body-stall timers, caller cancellation, and disposal.
 * @module tests/services/upstream/upstream-http.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, type FetchMockRoute } from '@cyanheads/mcp-ts-core/testing';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RplumberClient } from '@/services/rplumber/rplumber-client.js';
import { SdmxClient } from '@/services/sdmx/sdmx-client.js';
import {
  isUpstreamBusy,
  type PacingOptions,
  type UpstreamClientOptions,
  type UpstreamScope,
} from '@/services/upstream/upstream-http.js';
import {
  challengePage,
  clientOptions,
  FAST_PACING,
  hangingFetch,
  isProbeRequest,
  isRplumber,
  isStructureRequest,
  probeResponse,
  rplumberBody,
  structureDocument,
  structureResponse,
  tooManyRequests,
} from '../../helpers/ilostat-upstream.js';
import { guardNetwork } from '../../helpers/network-guard.js';

guardNetwork();

const disposables: { dispose(): void }[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const item of disposables.splice(0)) item.dispose();
});

function scope(signal?: AbortSignal): UpstreamScope {
  return {
    ...requestContextService.createRequestContext({ operation: 'upstream-test' }),
    ...(signal ? { signal } : {}),
  };
}

function rplumber(routes: FetchMockRoute[], overrides: Partial<UpstreamClientOptions> = {}) {
  const http = createFetchMock(routes);
  const client = new RplumberClient(clientOptions(http.fetch, overrides));
  disposables.push(client);
  return { http, client };
}

function sdmx(routes: FetchMockRoute[], overrides: Partial<UpstreamClientOptions> = {}) {
  const http = createFetchMock(routes);
  const client = new SdmxClient(clientOptions(http.fetch, overrides));
  disposables.push(client);
  return { http, client };
}

const sexToc = (respond: FetchMockRoute['respond'], once = false): FetchMockRoute => ({
  match: (request) => isRplumber(request, '/metadata/dic'),
  respond,
  ...(once ? { once } : {}),
});

const SEX_ROWS = [{ sex: 'SEX_T', 'sex.label': 'Total' }];
const COOLDOWN_PACING: PacingOptions = {
  ...FAST_PACING,
  maxWaitMs: 50,
  cooldown: { baseMs: 60_000, maxMs: 600_000 },
};
const RETRY_TWICE = { maxRetries: 2, baseDelayMs: 0, deadlineMs: 5_000 };

async function rejection(promise: Promise<unknown>): Promise<McpError> {
  return (await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  )) as McpError;
}

describe('throttling → upstream_busy', () => {
  it('maps HTTP 429 to RateLimited upstream_busy with the Retry-After seconds, never retried', async () => {
    const { http, client } = rplumber([sexToc(() => tooManyRequests('120'))], {
      retry: RETRY_TWICE,
    });
    const error = await rejection(client.getDictionary('sex', scope()));
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'upstream_busy', retryable: true, retryAfter: 120 });
    expect(error.message).toBe(
      'ILOSTAT API (rplumber.ilo.org) is throttling this server; retry in about 120 s.',
    );
    expect(isUpstreamBusy(error)).toBe(true);
    expect(http.calls).toHaveLength(1);
  });

  it('reports the first cooldown as the wait when upstream names none', async () => {
    const { client } = rplumber([sexToc(() => tooManyRequests())], {
      pacing: { ...FAST_PACING, cooldown: { baseMs: 60_000, maxMs: 600_000 } },
    });
    const error = await rejection(client.getDictionary('sex', scope()));
    expect(error.data).toMatchObject({ reason: 'upstream_busy', retryAfter: 60 });
  });

  it('reports the pacer cooldown when a 429 names a shorter Retry-After', async () => {
    const { client } = rplumber([sexToc(() => tooManyRequests('5'))], {
      pacing: { ...FAST_PACING, cooldown: { baseMs: 60_000, maxMs: 600_000 } },
    });
    const error = await rejection(client.getDictionary('sex', scope()));
    expect(error.data).toMatchObject({ reason: 'upstream_busy', retryAfter: 60 });
    expect(error.message).toBe(
      'ILOSTAT API (rplumber.ilo.org) is throttling this server; retry in about 60 s.',
    );
  });

  it('never reports a wait below 1 s', async () => {
    const { client } = rplumber([sexToc(() => tooManyRequests('0'))]);
    const error = await rejection(client.getDictionary('sex', scope()));
    expect(error.data).toMatchObject({ reason: 'upstream_busy', retryAfter: 1 });
    expect(error.message).toBe(
      'ILOSTAT API (rplumber.ilo.org) is throttling this server; retry in about 1 s.',
    );
  });

  it('omits retryAfter when neither upstream nor a cooldown supplies one', async () => {
    const { client } = rplumber([sexToc(() => tooManyRequests('Wed, 21 Oct 2026 07:28:00 GMT'))]);
    const error = await rejection(client.getDictionary('sex', scope()));
    expect(error.data?.reason).toBe('upstream_busy');
    expect(error.data).not.toHaveProperty('retryAfter');
    expect(error.message).toBe('ILOSTAT API (rplumber.ilo.org) is throttling this server.');
  });

  it('maps a cf-mitigated challenge page to upstream_busy, whatever its status', async () => {
    const { http, client } = rplumber([sexToc(() => challengePage())], { retry: RETRY_TWICE });
    const error = await rejection(client.getDictionary('sex', scope()));
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data?.reason).toBe('upstream_busy');
    expect(http.calls).toHaveLength(1);
  });

  it('maps HTML on an accepted status to upstream_busy instead of parsing it', async () => {
    const { client } = rplumber([
      sexToc(
        () =>
          new Response('<html><body>Checking your browser</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    ]);
    const error = await rejection(client.getDictionary('sex', scope()));
    expect(error.data?.reason).toBe('upstream_busy');
  });
});

describe('the busy check trips the pacer cooldown', () => {
  it('after a 429, the next bounded call sheds as upstream_busy without reaching upstream', async () => {
    const { http, client } = sdmx(
      [
        {
          match: (request) => isProbeRequest(request),
          respond: () => tooManyRequests(),
          once: true,
        },
        {
          match: (request) => isStructureRequest(request),
          respond: () => structureResponse(structureDocument('SDG_0552_NOC_RT')),
        },
      ],
      { pacing: COOLDOWN_PACING },
    );
    const first = await rejection(client.probeSeries('SDG_0552_NOC_RT', '1.0', 'KEN..', scope()));
    expect(first.data?.reason).toBe('upstream_busy');

    const shed = await rejection(client.getDataflowStructure('SDG_0552_NOC_RT', scope()));
    expect(shed.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(shed.data).toMatchObject({ reason: 'upstream_busy', retryable: true });
    expect(shed.data?.retryAfter).toBeGreaterThanOrEqual(59);
    expect((shed.cause as McpError).data?.reason).toBe('pacer_shed');
    expect(http.calls).toHaveLength(1);
  });

  it('a challenge page closes the gate the same way', async () => {
    const { http, client } = sdmx(
      [
        {
          match: (request) => isStructureRequest(request),
          respond: () => challengePage(),
          once: true,
        },
        {
          match: (request) => isStructureRequest(request),
          respond: () => structureResponse(structureDocument('SDG_0552_NOC_RT')),
        },
      ],
      { pacing: COOLDOWN_PACING },
    );
    await rejection(client.getDataflowStructure('SDG_0552_NOC_RT', scope()));
    const shed = await rejection(client.getDataflowStructure('SDG_0552_NOC_RT', scope()));
    expect(shed.data?.reason).toBe('upstream_busy');
    expect(http.calls).toHaveLength(1);
  });

  it('each consecutive 429 reports the doubled, capped cooldown, and the next request goes out exactly then', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const busy = () => sexToc(() => tooManyRequests('0'), true);
    const { http, client } = rplumber(
      [busy(), busy(), busy(), sexToc(() => rplumberBody(SEX_ROWS), true), busy()],
      {
        pacing: { ...FAST_PACING, cooldown: { baseMs: 2_000, maxMs: 5_000 } },
        retry: { maxRetries: 0, baseDelayMs: 0, deadlineMs: 60_000 },
      },
    );
    /**
     * One dictionary read — the catalog loader's unbounded wait — asserting it
     * reaches upstream only once `waitMs` has passed; its error, if it failed.
     */
    async function sentAfter(waitMs: number): Promise<McpError | undefined> {
      const calls = http.calls.length;
      const outcome = client.getDictionary('sex', scope()).then(
        () => undefined,
        (error: unknown) => error as McpError,
      );
      if (waitMs > 0) {
        await vi.advanceTimersByTimeAsync(waitMs - 1);
        expect(http.calls).toHaveLength(calls);
        await vi.advanceTimersByTimeAsync(1);
      }
      const error = await outcome;
      expect(http.calls).toHaveLength(calls + 1);
      return error;
    }

    expect((await sentAfter(0))?.data?.retryAfter).toBe(2);
    expect((await sentAfter(2_000))?.data?.retryAfter).toBe(4);
    expect((await sentAfter(4_000))?.data?.retryAfter).toBe(5);
    expect(await sentAfter(5_000)).toBeUndefined();
    // The success reset the count, so the next 429 is a first one again.
    expect((await sentAfter(0))?.data?.retryAfter).toBe(2);
  });

  it('any other failure leaves the gate open', async () => {
    const { http, client } = sdmx(
      [
        {
          match: (request) => isStructureRequest(request),
          respond: () => new Response('down', { status: 503 }),
          once: true,
        },
        {
          match: (request) => isStructureRequest(request),
          respond: () => structureResponse(structureDocument('SDG_0552_NOC_RT')),
        },
      ],
      { pacing: COOLDOWN_PACING },
    );
    const failed = await rejection(client.getDataflowStructure('SDG_0552_NOC_RT', scope()));
    expect(failed.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    await expect(client.getDataflowStructure('SDG_0552_NOC_RT', scope())).resolves.toBeDefined();
    expect(http.calls).toHaveLength(2);
  });
});

describe('pacer shed → upstream_busy', () => {
  it('rewraps a shed from an exhausted window, keeping its retryAfter', async () => {
    const { http, client } = sdmx(
      [
        {
          match: (request) => isStructureRequest(request),
          respond: () => structureResponse(structureDocument('SDG_0552_NOC_RT')),
        },
      ],
      { pacing: { ...FAST_PACING, limits: [{ requests: 1, perMs: 60_000 }], maxWaitMs: 50 } },
    );
    await client.getDataflowStructure('SDG_0552_NOC_RT', scope());
    const shed = await rejection(client.getDataflowStructure('SDG_0552_NOC_RT', scope()));
    expect(shed.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(shed.data).toMatchObject({ reason: 'upstream_busy', retryable: true, retryAfter: 60 });
    expect(shed.message).toBe(
      'ILOSTAT SDMX API (sdmx.ilo.org) is throttling this server; retry in about 60 s.',
    );
    expect(http.calls).toHaveLength(1);
  });

  it('the catalog loader queues past the window instead of shedding (unbounded wait)', async () => {
    const { http, client } = rplumber([sexToc(() => rplumberBody(SEX_ROWS))], {
      pacing: { ...FAST_PACING, limits: [{ requests: 1, perMs: 150 }], maxWaitMs: 0 },
    });
    const started = Date.now();
    await client.getDictionary('sex', scope());
    await expect(client.getDictionary('sex', scope())).resolves.toEqual([
      { code: 'SEX_T', label: 'Total' },
    ]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(http.calls).toHaveLength(2);
  });
});

describe('retry', () => {
  it('retries a transient failure and returns the recovered response', async () => {
    const { http, client } = rplumber(
      [
        sexToc(() => new Response('unavailable', { status: 503 }), true),
        sexToc(() => rplumberBody(SEX_ROWS)),
      ],
      { retry: RETRY_TWICE },
    );
    await expect(client.getDictionary('sex', scope())).resolves.toHaveLength(1);
    expect(http.calls).toHaveLength(2);
  });

  it('gives up after maxRetries with ServiceUnavailable, without relaying the body', async () => {
    const { http, client } = rplumber(
      [sexToc(() => new Response('internal detail', { status: 503 }))],
      { retry: RETRY_TWICE },
    );
    const error = await rejection(client.getDictionary('sex', scope()));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toMatch(/^ILOSTAT API \(rplumber\.ilo\.org\) returned HTTP 503\./);
    expect(error.message).not.toContain('internal detail');
    expect(error.data).not.toHaveProperty('body');
    expect(http.calls).toHaveLength(3);
  });

  it('does not retry a status that is not transient', async () => {
    const { http, client } = rplumber([sexToc(() => new Response('nope', { status: 404 }))], {
      retry: RETRY_TWICE,
    });
    const error = await rejection(client.getDictionary('sex', scope()));
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(http.calls).toHaveLength(1);
  });

  it('maps a network failure to ServiceUnavailable and retries it', async () => {
    const { http, client } = rplumber(
      [
        sexToc(() => Promise.reject(new TypeError('fetch failed')), true),
        sexToc(() => rplumberBody(SEX_ROWS)),
      ],
      { retry: RETRY_TWICE },
    );
    await expect(client.getDictionary('sex', scope())).resolves.toHaveLength(1);
    expect(http.calls).toHaveLength(2);

    const { client: down } = rplumber([
      sexToc(() => Promise.reject(new TypeError('fetch failed'))),
    ]);
    const error = await rejection(down.getDictionary('sex', scope()));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toMatch(/^ILOSTAT API \(rplumber\.ilo\.org\) could not be reached\./);
  });
});

describe('timers', () => {
  it('fails Timeout when no response headers arrive within headersMs, and retries it', async () => {
    const upstream = hangingFetch();
    const client = new RplumberClient(
      clientOptions(upstream.fetch, {
        timeouts: { headersMs: 20, stallMs: 1_000 },
        retry: { maxRetries: 1, baseDelayMs: 0, deadlineMs: 5_000 },
      }),
    );
    disposables.push(client);
    const error = await rejection(client.getDictionary('sex', scope()));
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.message).toMatch(
      /^ILOSTAT API \(rplumber\.ilo\.org\) sent no response within 0\.02 s\./,
    );
    expect(upstream.urls).toHaveLength(2);
  });

  it('fails Timeout when the body stalls mid-response for stallMs', async () => {
    const { client } = rplumber(
      [
        sexToc(
          () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('[{"sex":"SEX_T",'));
                },
              }),
              { status: 200, headers: { 'content-type': 'application/octet-stream' } },
            ),
        ),
      ],
      { timeouts: { headersMs: 1_000, stallMs: 20 } },
    );
    const error = await rejection(client.getDictionary('sex', scope()));
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.message).toMatch(
      /^ILOSTAT API \(rplumber\.ilo\.org\) stopped sending data for 0\.02 s mid-response\./,
    );
  });
});

describe('cancellation and disposal', () => {
  it("stops on the caller's abort without retrying", async () => {
    const controller = new AbortController();
    const upstream = hangingFetch();
    const client = new RplumberClient(clientOptions(upstream.fetch, { retry: RETRY_TWICE }));
    disposables.push(client);
    const pending = client.getDictionary('sex', scope(controller.signal));
    setTimeout(() => controller.abort(new Error('caller cancelled')), 10);
    await expect(pending).rejects.toThrow('caller cancelled');
    expect(upstream.urls).toHaveLength(1);
  });

  it('rejects requests once the client is disposed', async () => {
    const { http, client } = rplumber([sexToc(() => rplumberBody(SEX_ROWS))]);
    client.dispose();
    const error = await rejection(client.getDictionary('sex', scope()));
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(http.calls).toHaveLength(0);
  });
});

describe('identifying headers', () => {
  it('sends Accept-Language en and the User-Agent on SDMX requests too', async () => {
    const { http, client } = sdmx([
      {
        match: (request) => isProbeRequest(request),
        respond: () => probeResponse('DATAFLOW,REF_AREA\n'),
      },
    ]);
    await client.probeSeries('SDG_0552_NOC_RT', '1.0', 'KEN..', scope());
    const headers = http.calls[0]?.request.headers;
    expect(headers?.get('accept-language')).toBe('en');
    expect(headers?.get('user-agent')).toMatch(/^ilostat-mcp-server\//);
  });
});
