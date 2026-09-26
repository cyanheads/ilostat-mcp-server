/**
 * @fileoverview Canary for the network tripwire, run with the tripwire installed:
 * a stray `fetch` and a raw socket connect both fail before leaving the process.
 * @module tests/helpers/network-guard.test
 */

import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { guardNetwork, NETWORK_BLOCKED } from './network-guard.js';

guardNetwork();

describe('network tripwire', () => {
  it('rejects a fetch that no injected fake handles', async () => {
    await expect(fetch('https://rplumber.ilo.org/metadata/toc/indicator')).rejects.toThrow(
      NETWORK_BLOCKED,
    );
  });

  it('refuses a raw socket connect', () => {
    expect(() => net.connect({ host: 'sdmx.ilo.org', port: 443 })).toThrow(NETWORK_BLOCKED);
  });
});
