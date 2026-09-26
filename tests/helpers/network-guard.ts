/**
 * @fileoverview Network tripwire for every test file: `globalThis.fetch` is replaced
 * by the framework's strict fetch fake with no routes, and `net.Socket#connect`
 * throws, so any code path that reaches for the real network — a client built
 * without an injected `fetch`, or a raw socket — fails loudly instead of calling
 * out. Upstream traffic in the suite goes only through fetch fakes injected at
 * each client's constructor.
 * @module tests/helpers/network-guard
 */

import net from 'node:net';
import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll } from 'vitest';

/** Message every blocked network attempt carries. */
export const NETWORK_BLOCKED = 'Network access is blocked in the test suite';

/** Installs the tripwire for the calling test file. */
export function guardNetwork(): void {
  const strictFetch = createFetchMock([], {
    onUnhandled: (request) =>
      Promise.reject(new Error(`${NETWORK_BLOCKED}: fetch ${request.method} ${request.url}`)),
  });
  const originalConnect = net.Socket.prototype.connect;

  beforeAll(() => {
    strictFetch.install();
    net.Socket.prototype.connect = function blockedConnect(): never {
      throw new Error(`${NETWORK_BLOCKED}: socket connect`);
    } as unknown as typeof net.Socket.prototype.connect;
  });

  afterAll(() => {
    strictFetch.restore();
    net.Socket.prototype.connect = originalConnect;
  });
}
