/**
 * @fileoverview Tests for `SdmxClient` over a fetch fake serving the recorded SDMX
 * responses: the structure and unit-probe URLs and Accept headers, and the
 * statuses that are results on this host — a 404 (no dataflow, no data for the
 * key) and a 500 carrying an Oracle `ORA-` message read as "nothing here", the
 * Oracle text never relayed — against the ones that are errors (422 is this
 * server's bug; any other 500 is the upstream failing). Path segments taken from
 * upstream data (indicator code, dataflow version, series key) are checked against
 * the SDMX identifier grammar before any URL is built, and a bad one is refused
 * without a request.
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
  isProbeRequest,
  isStructureRequest,
  probeResponse,
  probeRoute,
  SDMX_404_NO_DATA,
  SDMX_404_NO_STRUCTURE,
  SDMX_422_SHORT_KEY,
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

describe('SdmxClient.probeSeries', () => {
  it('requests one observation of the series key and returns the first row by column', async () => {
    const { http, client } = setup([probeRoute('UNE_DEAP_SEX_AGE_RT', 'ABW....')]);
    const row = await client.probeSeries('UNE_DEAP_SEX_AGE_RT', '1.0', 'ABW....', scope());
    expect(row).toMatchObject({
      REF_AREA: 'ABW',
      UNIT_MEASURE_TYPE: 'RT',
      UNIT_MEASURE: 'PT',
      UNIT_MULT: '0',
    });
    const request = http.calls[0]?.request;
    expect(request?.url).toBe(
      'https://sdmx.ilo.org/rest/data/ILO,DF_UNE_DEAP_SEX_AGE_RT,1.0/ABW....?lastNObservations=1',
    );
    expect(request?.headers.get('accept')).toBe('application/vnd.sdmx.data+csv;version=1.0.0');
    expect(request?.headers.get('accept-language')).toBe('en');
  });

  it('reads a header-only body, a 404, and an ORA- 500 as no data for the key', async () => {
    const { http, client } = setup([
      probeRoute('UNE_DEAP_SEX_AGE_RT', 'AAA....', () =>
        probeResponse('DATAFLOW,REF_AREA,UNIT_MULT\n'),
      ),
      probeRoute('UNE_DEAP_SEX_AGE_RT', 'PRK....', () => sdmxText(SDMX_404_NO_DATA, 404)),
      probeRoute('UNE_DEAP_SEX_AGE_RT', 'ZZZ....', () => sdmxText(`\n${SDMX_500_ORA}`, 500)),
    ]);
    for (const key of ['AAA....', 'PRK....', 'ZZZ....']) {
      await expect(
        client.probeSeries('UNE_DEAP_SEX_AGE_RT', '1.0', key, scope()),
      ).resolves.toBeUndefined();
    }
    expect(http.calls).toHaveLength(3);
  });

  it('fails InternalError on a 422 (a key of the wrong arity is a bug here), without retrying', async () => {
    const { http, client } = setup([
      probeRoute('UNE_DEAP_SEX_AGE_RT', 'USA..', () => sdmxText(SDMX_422_SHORT_KEY, 422)),
    ]);
    const error = (await client
      .probeSeries('UNE_DEAP_SEX_AGE_RT', '1.0', 'USA..', scope())
      .catch((caught: unknown) => caught)) as McpError;
    expect(error.code).toBe(JsonRpcErrorCode.InternalError);
    expect(error.message).toContain('HTTP 422');
    expect(http.calls).toHaveLength(1);
  });

  it('fails ServiceUnavailable on a 500 that is not an Oracle key error, after retrying', async () => {
    const { http, client } = setup([
      {
        match: (request) => isProbeRequest(request),
        respond: () => sdmxText('Internal Server Error', 500),
      },
    ]);
    const error = (await client
      .probeSeries('UNE_DEAP_SEX_AGE_RT', '1.0', 'USA....', scope())
      .catch((caught: unknown) => caught)) as McpError;
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toMatch(/^ILOSTAT SDMX API \(sdmx\.ilo\.org\) failed with HTTP 500\./);
    expect(http.calls).toHaveLength(3);
  });

  it('does not treat a non-accepted status as a result', async () => {
    const { client } = setup([
      {
        match: (request) => isStructureRequest(request) || isProbeRequest(request),
        respond: () => sdmxText('gone', 410),
      },
    ]);
    await expect(
      client.probeSeries('UNE_DEAP_SEX_AGE_RT', '1.0', 'USA....', scope()),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.InvalidRequest });
  });
});

describe('SdmxClient path segments', () => {
  const anyRequest: FetchMockRoute = { match: () => true, respond: () => sdmxText('', 404) };

  it.each([
    [
      'a dataflow version with dot segments',
      'dataflow version',
      'UNE_DEAP_SEX_AGE_RT',
      '1.0/../../../structure/codelist/ILO/all',
      'USA....',
    ],
    [
      'a key area with dot segments and a query',
      'series key',
      'UNE_DEAP_SEX_AGE_RT',
      '1.0',
      '../../../../availableconstraint?x=1#....',
    ],
    ['a key with an encoded slash', 'series key', 'UNE_DEAP_SEX_AGE_RT', '1.0', 'USA%2F....'],
    ['an indicator carrying a path', 'indicator code', '../../structure/X', '1.0', 'USA....'],
  ])(
    'refuses %s on the probe without sending a request',
    async (_label, segment, indicator, version, key) => {
      const { http, client } = setup([anyRequest]);
      await expect(client.probeSeries(indicator, version, key, scope())).rejects.toMatchObject({
        code: JsonRpcErrorCode.SerializationError,
        message: `ILOSTAT sent an SDMX ${segment} this server will not put in a URL; no request was made.`,
      });
      expect(http.calls).toHaveLength(0);
    },
  );

  it('refuses an indicator carrying a path on the structure call without sending a request', async () => {
    const { http, client } = setup([anyRequest]);
    await expect(
      client.getDataflowStructure('X/../../../data/ILO,DF_Y', scope()),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.SerializationError });
    expect(http.calls).toHaveLength(0);
  });

  it('sends a key of plain codes and empty positions unchanged', async () => {
    const { http, client } = setup([anyRequest]);
    await client.probeSeries('SDG_0552_NOC_RT', '1.0.0', 'X01..', scope());
    expect(new URL(http.calls[0]?.request.url ?? '').pathname).toBe(
      '/rest/data/ILO,DF_SDG_0552_NOC_RT,1.0.0/X01..',
    );
  });
});
