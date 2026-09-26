/**
 * @fileoverview Client for sdmx.ilo.org/rest — structure only: a dataflow's
 * structure with the codes it uses (`references=all&detail=referencepartial`,
 * SDMX-JSON), and a one-observation data probe (SDMX-CSV) whose attributes carry
 * the units the structure declares without values. Some non-2xx statuses are
 * results here: 404 means no dataflow or no data for the key, and a 500 carrying
 * an Oracle `ORA-` message means the key names an unknown member — both read as
 * "nothing here", and the Oracle text is never relayed. A 422 (wrong key arity)
 * is a bug in this server.
 * @module services/sdmx/sdmx-client
 */

import {
  internalError,
  serializationError,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { parseCsvObjects } from '@/services/csv/parse-csv.js';
import {
  type PacingOptions,
  type UpstreamClientOptions,
  UpstreamHttp,
  type UpstreamScope,
} from '@/services/upstream/upstream-http.js';

const BASE_URL = 'https://sdmx.ilo.org/rest';
const SERVICE = 'ILOSTAT SDMX API (sdmx.ilo.org)';
const STRUCTURE_ACCEPT = 'application/vnd.sdmx.structure+json;version=1.0';
const DATA_CSV_ACCEPT = 'application/vnd.sdmx.data+csv;version=1.0.0';

/**
 * Structure documents are 50–130 KB and slow to build, so SDMX runs one request at
 * a time at 20 a minute with a 1 s start gap, and the same 60 s → 10 min cooldown.
 */
export const SDMX_PACING: PacingOptions = {
  limits: [{ requests: 20, perMs: 60_000 }],
  maxConcurrent: 1,
  minStartGapMs: 1_000,
  cooldown: { baseMs: 60_000, maxMs: 600_000 },
  maxWaitMs: 15_000,
};

/** Every SDMX call here is tool-initiated (describe), so each caps its queue wait. */
export class SdmxClient {
  private readonly http: UpstreamHttp;

  constructor(options: UpstreamClientOptions) {
    this.http = new UpstreamHttp(SERVICE, options, SDMX_PACING);
  }

  dispose(): void {
    this.http.dispose();
  }

  /** The dataflow `DF_{indicator}` with its structures and used codes; `undefined` when SDMX has no such dataflow. */
  getDataflowStructure(indicator: string, scope: UpstreamScope): Promise<unknown> {
    const url = new URL(`${BASE_URL}/dataflow/ILO/DF_${indicator}/latest`);
    url.searchParams.set('references', 'all');
    url.searchParams.set('detail', 'referencepartial');
    return this.http.request(
      {
        url: url.toString(),
        operation: 'sdmx dataflow structure',
        accept: STRUCTURE_ACCEPT,
        acceptStatuses: [200, 404],
        bounded: true,
        interpret: ({ status, body }) => {
          if (status === 404) return;
          try {
            return JSON.parse(body) as unknown;
          } catch (error) {
            throw serializationError(
              `${SERVICE} returned a structure document that is not JSON.`,
              undefined,
              {
                cause: error,
              },
            );
          }
        },
      },
      scope,
    );
  }

  /**
   * The first series row of `…/data/ILO,DF_{indicator},{version}/{key}?lastNObservations=1`,
   * keyed by CSV column; `undefined` when there is no data for the key.
   */
  probeSeries(
    indicator: string,
    version: string,
    key: string,
    scope: UpstreamScope,
  ): Promise<Record<string, string> | undefined> {
    const url = new URL(`${BASE_URL}/data/ILO,DF_${indicator},${version}/${key}`);
    url.searchParams.set('lastNObservations', '1');
    return this.http.request(
      {
        url: url.toString(),
        operation: 'sdmx unit probe',
        accept: DATA_CSV_ACCEPT,
        acceptStatuses: [200, 404, 422, 500],
        bounded: true,
        interpret: ({ status, body }) => {
          if (status === 200) return parseCsvObjects(body)[0];
          if (status === 404) return;
          if (status === 500 && body.trimStart().startsWith('ORA-')) return;
          if (status === 422) {
            throw internalError(
              `${SERVICE} rejected the series key built for ${indicator} (HTTP 422).`,
            );
          }
          throw serviceUnavailable(`${SERVICE} failed with HTTP ${status}.`);
        },
      },
      scope,
    );
  }
}
