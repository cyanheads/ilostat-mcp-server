/**
 * @fileoverview Client for sdmx.ilo.org/rest — structure only: a dataflow's
 * structure with the codes it uses (`references=all&detail=referencepartial`,
 * SDMX-JSON). A 404 is a result here: SDMX has no such dataflow. The indicator
 * code, which comes from the catalog, is checked against the SDMX identifier
 * grammar before the URL is built, so upstream data can never steer a request
 * off its endpoint.
 * @module services/sdmx/sdmx-client
 */

import { serializationError } from '@cyanheads/mcp-ts-core/errors';
import {
  type PacingOptions,
  type UpstreamClientOptions,
  UpstreamHttp,
  type UpstreamScope,
} from '@/services/upstream/upstream-http.js';

const BASE_URL = 'https://sdmx.ilo.org/rest';
const SERVICE = 'ILOSTAT SDMX API (sdmx.ilo.org)';
const STRUCTURE_ACCEPT = 'application/vnd.sdmx.structure+json;version=1.0';

/**
 * Structure documents are 50–130 KB and slow to build, so SDMX runs one request at
 * a time at 20 a minute with a 1 s start gap, and the same 60 s → 10 min cooldown.
 */
const SDMX_PACING: PacingOptions = {
  limits: [{ requests: 20, perMs: 60_000 }],
  maxConcurrent: 1,
  minStartGapMs: 1_000,
  cooldown: { baseMs: 60_000, maxMs: 600_000 },
  maxWaitMs: 15_000,
};

const MIB = 1024 * 1024;

/** Body cap, far above the live responses (2026-09): structure documents run 127–130 KB. */
const STRUCTURE_MAX_BYTES = 16 * MIB;

/** An SDMX identifier; nothing that matches needs percent-encoding. */
const CODE = /^[A-Z0-9_]+$/;

/** The SDMX call is tool-initiated (describe, query, compare), so it caps its queue wait. */
export class SdmxClient {
  private readonly http: UpstreamHttp;

  constructor(options: UpstreamClientOptions) {
    this.http = new UpstreamHttp(SERVICE, options, SDMX_PACING);
  }

  dispose(): void {
    this.http.dispose();
  }

  /** The dataflow `DF_{indicator}` with its structures and used codes; `undefined` when SDMX has no such dataflow. */
  async getDataflowStructure(indicator: string, scope: UpstreamScope): Promise<unknown> {
    // The code comes from upstream data, never a caller; one outside the grammar is refused unsent.
    if (!CODE.test(indicator)) {
      throw serializationError(
        'ILOSTAT sent an SDMX indicator code this server will not put in a URL; no request was made.',
      );
    }
    const url = new URL(`${BASE_URL}/dataflow/ILO/DF_${indicator}/latest`);
    url.searchParams.set('references', 'all');
    url.searchParams.set('detail', 'referencepartial');
    return await this.http.request(
      {
        url: url.toString(),
        operation: 'sdmx dataflow structure',
        accept: STRUCTURE_ACCEPT,
        acceptStatuses: [200, 404],
        bounded: true,
        maxBytes: STRUCTURE_MAX_BYTES,
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
}
