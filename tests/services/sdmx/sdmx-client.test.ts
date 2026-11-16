/**
 * @fileoverview Tests for `SdmxClient` over a fetch fake serving the recorded SDMX
 * responses: the structure URL and Accept header, a 404 read as "no such
 * dataflow", a body that is not JSON, and a 5xx retried and failed with its
 * Oracle text never relayed. The indicator code is checked against the SDMX
 * identifier grammar before the URL is built, and a bad one is refused without a
 * request.
 * @module tests/services/sdmx/sdmx-client.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, type FetchMockRoute } from '@cyanheads/mcp-ts-core/testing';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it } from 'vitest';
import { SdmxClient } from '@/services/sdmx/sdmx-client.js';
import type { UpstreamScope } from '@/services/upstream/upstream-http.js';
import {
  clientOptions,
  SDMX_404_NO_STRUCTURE,
  SDMX_500_ORA,
  sdmxText,
  structureDocument,
  structureRoute,
  TEST_USER_AGENT,
} from '../../helpers/ilostat-upstream.js';
import { guardNetwork } from '../../helpers/network-guard.js';

guardNetwork();

const scope = (): UpstreamScope =>
  requestContextService.createRequestContext({ operation: 'test' });
const RETRY_TWICE = { maxRetries: 2, baseDelayMs: 0, deadlineMs: 5_000 };

let client: SdmxClient | undefined;

afterEach(() => {
  client?.dispose();
  client = undefined;
});

function setup(routes: FetchMockRoute[]) {
  const http = createFetchMock(routes);
  client = new SdmxClient(clientOptions(http.fetch, { retry: RETRY_TWICE }));
  return { http, client };
}

describe('SdmxClient.getDataflowStructure', () => {
  it('requests DF_{indicator}/latest with references=all and detail=referencepartial', async () => {
    const { http, client } = setup([structureRoute('UNE_DEAP_SEX_AGE_RT')]);
    const document = await client.getDataflowStructure('UNE_DEAP_SEX_AGE_RT', scope());
    expect(document).toEqual(structureDocument('UNE_DEAP_SEX_AGE_RT'));

    const request = http.calls[0]?.request;
    expect(request?.url).toBe(
      'https://sdmx.ilo.org/rest/dataflow/ILO/DF_UNE_DEAP_SEX_AGE_RT/latest?references=all&detail=referencepartial',
    );
    expect(request?.headers.get('accept')).toBe('application/vnd.sdmx.structure+json;version=1.0');
    expect(request?.headers.get('accept-language')).toBe('en');
    expect(request?.headers.get('user-agent')).toBe(TEST_USER_AGENT);
  });

  it('reads a 404 as "SDMX has no such dataflow", not as an error', async () => {
    const { http, client } = setup([
      structureRoute('NOPE_NOT_REAL_XX', () => sdmxText(SDMX_404_NO_STRUCTURE, 404)),
    ]);
    await expect(client.getDataflowStructure('NOPE_NOT_REAL_XX', scope())).resolves.toBeUndefined();
    expect(http.calls).toHaveLength(1);
  });

  it('fails SerializationError on a structure body that is not JSON, without retrying', async () => {
    const { http, client } = setup([
      structureRoute('UNE_DEAP_SEX_AGE_RT', () => sdmxText('<Structure/>', 200)),
    ]);
    const error = (await client
      .getDataflowStructure('UNE_DEAP_SEX_AGE_RT', scope())
      .catch((caught: unknown) => caught)) as McpError;
    expect(error.code).toBe(JsonRpcErrorCode.SerializationError);
    expect(http.calls).toHaveLength(1);
  });

  it('retries a 5xx on the structure call and fails ServiceUnavailable', async () => {
    const { http, client } = setup([
      structureRoute('UNE_DEAP_SEX_AGE_RT', () => sdmxText(SDMX_500_ORA, 500)),
    ]);
    const error = (await client
      .getDataflowStructure('UNE_DEAP_SEX_AGE_RT', scope())
      .catch((caught: unknown) => caught)) as McpError;
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).not.toContain('ORA-');
    expect(http.calls).toHaveLength(3);
  });
});

describe('SdmxClient indicator code', () => {
  const anyRequest: FetchMockRoute = { match: () => true, respond: () => sdmxText('', 404) };

  it.each([
    ['carrying a path', 'X/../../../data/ILO,DF_Y'],
    ['with an encoded slash', 'UNE%2FDEAP'],
  ])('refuses an indicator code %s without sending a request', async (_label, indicator) => {
    const { http, client } = setup([anyRequest]);
    await expect(client.getDataflowStructure(indicator, scope())).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      message:
        'ILOSTAT sent an SDMX indicator code this server will not put in a URL; no request was made.',
    });
    expect(http.calls).toHaveLength(0);
  });

  it('does not treat a non-accepted status as a result', async () => {
    const { client } = setup([{ match: () => true, respond: () => sdmxText('gone', 410) }]);
    await expect(client.getDataflowStructure('UNE_DEAP_SEX_AGE_RT', scope())).rejects.toMatchObject(
      { code: JsonRpcErrorCode.InvalidRequest },
    );
  });
});
