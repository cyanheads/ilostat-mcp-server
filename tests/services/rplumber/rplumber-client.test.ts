/**
 * @fileoverview Tests for `RplumberClient` over a fetch fake serving the recorded
 * rplumber bodies: the per-endpoint parameter allowlist (never a blank value), the
 * identifying headers, parsing by the requested format whatever the content type,
 * dictionary normalization, and the parse failures that must not be retried.
 * @module tests/services/rplumber/rplumber-client.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it } from 'vitest';
import { RplumberClient } from '@/services/rplumber/rplumber-client.js';
import { DICTIONARY_VARS } from '@/services/rplumber/types.js';
import type { UpstreamScope } from '@/services/upstream/upstream-http.js';
import {
  callUrls,
  catalogRoutes,
  clientOptions,
  isRplumber,
  loadCatalogFixture,
  rplumberBody,
  TEST_USER_AGENT,
} from '../../helpers/ilostat-upstream.js';
import { guardNetwork } from '../../helpers/network-guard.js';

guardNetwork();

const scope = (): UpstreamScope =>
  requestContextService.createRequestContext({ operation: 'test' });

/** The parameters each endpoint may carry (docs/design.md, API Reference). */
const ALLOWLIST: Record<string, readonly string[]> = {
  '/metadata/toc/indicator': ['lang', 'format'],
  '/metadata/toc/ref_area': ['lang', 'format'],
  '/metadata/dic': ['var', 'lang', 'format'],
};

let client: RplumberClient | undefined;

afterEach(() => {
  client?.dispose();
  client = undefined;
});

function setup(routes = catalogRoutes(loadCatalogFixture()), retryCount = 0) {
  const http = createFetchMock(routes);
  client = new RplumberClient(
    clientOptions(http.fetch, {
      retry: { maxRetries: retryCount, baseDelayMs: 0, deadlineMs: 5_000 },
    }),
  );
  return { http, client };
}

describe('RplumberClient requests', () => {
  it('fetches the indicator ToC with lang and format only, and identifying headers', async () => {
    const { http, client } = setup();
    const rows = await client.getIndicatorToc(scope());
    expect(rows).toHaveLength(13);
    expect(rows[0]).toMatchObject({ id: 'UNE_DEAP_SEX_AGE_RT_M', freq: 'M' });

    const [call] = http.calls;
    expect(call?.request.url).toBe(
      'https://rplumber.ilo.org/metadata/toc/indicator?lang=en&format=.json',
    );
    expect(call?.request.method).toBe('GET');
    expect(call?.request.headers.get('accept-language')).toBe('en');
    expect(call?.request.headers.get('user-agent')).toBe(TEST_USER_AGENT);
    expect(call?.request.headers.get('accept')).toBe('application/json');
  });

  it('fetches the reference-area ToC and keeps the fields upstream omits absent', async () => {
    const { http, client } = setup();
    const rows = await client.getRefAreaToc(scope());
    expect(http.calls[0]?.request.url).toBe(
      'https://rplumber.ilo.org/metadata/toc/ref_area?lang=en&format=.json',
    );
    const world = rows.find((row) => row.ref_area === 'X01');
    expect(world).toBeDefined();
    expect(world && 'ilo_region' in world).toBe(false);
  });

  it('sends only allowlisted parameters, never a blank one, across a full catalog load', async () => {
    const { http, client } = setup();
    await Promise.all([
      client.getIndicatorToc(scope()),
      client.getRefAreaToc(scope()),
      ...DICTIONARY_VARS.map((dictionary) => client.getDictionary(dictionary, scope())),
    ]);
    const urls = callUrls(http);
    expect(urls).toHaveLength(2 + DICTIONARY_VARS.length);
    for (const url of urls) {
      const allowed = ALLOWLIST[url.pathname];
      expect(allowed, url.pathname).toBeDefined();
      for (const [name, value] of url.searchParams) {
        expect(allowed).toContain(name);
        expect(value.trim(), `${url.pathname} ${name}`).not.toBe('');
      }
    }
    expect(
      urls
        .filter((url) => url.pathname === '/metadata/dic')
        .map((url) => url.searchParams.get('var')),
    ).toEqual([...DICTIONARY_VARS]);
    for (const call of http.calls) {
      expect(call.request.headers.get('accept-language')).toBe('en');
    }
  });
});

describe('RplumberClient dictionaries', () => {
  it('normalizes {<var>, <var>.label} rows and skips rows without a code', async () => {
    const { client } = setup();
    expect(await client.getDictionary('sex', scope())).toEqual([
      { code: 'SEX_T', label: 'Total' },
      { code: 'SEX_M', label: 'Male' },
      { code: 'SEX_F', label: 'Female' },
      { code: 'SEX_O', label: 'Other' },
    ]);
    const status = await client.getDictionary('obs_status', scope());
    expect(status.map((entry) => entry.code)).toEqual(['A', 'B', 'M', 'U', 'R', 'I']);
  });

  it("adds the indicator description and the source's reference area, and nothing else", async () => {
    const { client } = setup();
    const indicators = await client.getDictionary('indicator', scope());
    expect(indicators.find((entry) => entry.code === 'UNE_DEAP_SEX_AGE_RT')?.description).toMatch(
      /^<strong>/,
    );
    expect(indicators.find((entry) => entry.code === 'EAP_DWAP_SEX_AGE_RT')).toEqual({
      code: 'EAP_DWAP_SEX_AGE_RT',
      label: 'Labour force participation rate by sex and age (%)',
    });
    const sources = await client.getDictionary('source', scope());
    expect(sources.find((entry) => entry.code === 'BA:7008')).toEqual({
      code: 'BA:7008',
      label: 'LFS - Labour Force Survey',
      refArea: 'KEN',
    });
  });
});

describe('RplumberClient body parsing', () => {
  it('parses by the requested format even when the content type says otherwise', async () => {
    const { client } = setup([
      {
        match: (request) => isRplumber(request, '/metadata/dic'),
        respond: () =>
          new Response(JSON.stringify([{ sex: 'SEX_T', 'sex.label': 'Total' }]), {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          }),
      },
    ]);
    await expect(client.getDictionary('sex', scope())).resolves.toEqual([
      { code: 'SEX_T', label: 'Total' },
    ]);
  });

  it('fails SerializationError on a body that is not JSON, without retrying', async () => {
    const { http, client } = setup(
      [
        {
          match: (request) => isRplumber(request, '/metadata/toc/indicator'),
          respond: () =>
            new Response('id,indicator\nUNE_A,UNE', {
              status: 200,
              headers: { 'content-type': 'application/octet-stream' },
            }),
        },
      ],
      2,
    );
    await expect(client.getIndicatorToc(scope())).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
    });
    expect(http.calls).toHaveLength(1);
  });

  it('fails SerializationError naming the path when a row misses a required field', async () => {
    const { client } = setup([
      {
        match: (request) => isRplumber(request, '/metadata/toc/indicator'),
        respond: () =>
          rplumberBody([{ id: 'UNE_DEAP_SEX_AGE_RT_A', indicator: 'UNE_DEAP_SEX_AGE_RT' }]),
      },
    ]);
    const error = await client.getIndicatorToc(scope()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.SerializationError });
    expect((error as Error).message).toContain('at 0.indicator.label');
  });
});
