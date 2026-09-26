/**
 * @fileoverview Tests for `waitFor`: one caller waiting on shared work stops on its
 * own abort or time budget while the work itself runs on for everyone else.
 * @module tests/services/wait.test
 */

import { describe, expect, it } from 'vitest';
import { WAIT_TIMEOUT, waitFor } from '@/services/wait.js';
import { guardNetwork } from '../helpers/network-guard.js';

guardNetwork();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('waitFor', () => {
  it('resolves with the work when it settles first', async () => {
    await expect(waitFor(Promise.resolve(7), { timeoutMs: 1_000 })).resolves.toBe(7);
  });

  it('rejects with the work error when the work fails', async () => {
    await expect(waitFor(Promise.reject(new Error('boom')), {})).rejects.toThrow('boom');
  });

  it('rejects with WAIT_TIMEOUT once the budget elapses, and the work still settles', async () => {
    const work = deferred<string>();
    await expect(waitFor(work.promise, { timeoutMs: 5 })).rejects.toBe(WAIT_TIMEOUT);
    work.resolve('done');
    await expect(work.promise).resolves.toBe('done');
  });

  it("rejects with the signal's reason on abort, without cancelling the work", async () => {
    const work = deferred<string>();
    const controller = new AbortController();
    const waiting = waitFor(work.promise, { signal: controller.signal });
    controller.abort(new Error('caller went away'));
    await expect(waiting).rejects.toThrow('caller went away');
    work.resolve('still done');
    await expect(work.promise).resolves.toBe('still done');
  });

  it('rejects at once when the signal has already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already gone'));
    await expect(waitFor(new Promise(() => {}), { signal: controller.signal })).rejects.toThrow(
      'already gone',
    );
  });
});
