/**
 * @fileoverview Waiting on shared work from one caller: the work keeps running for
 * everyone else when this caller's signal aborts or its own time budget runs out.
 * @module services/wait
 */

/** Rejection value when `waitFor`'s timeout elapses first. */
export const WAIT_TIMEOUT = Symbol('wait-timeout');

/**
 * Resolves with `promise`, or rejects with `signal.reason` on abort, or with
 * {@link WAIT_TIMEOUT} once `timeoutMs` elapses. Never cancels `promise` itself.
 */
export function waitFor<T>(
  promise: Promise<T>,
  options: { signal?: AbortSignal | undefined; timeoutMs?: number },
): Promise<T> {
  const { signal, timeoutMs } = options;
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      settle();
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        settle();
        reject(WAIT_TIMEOUT);
      }, timeoutMs);
    }
    promise.then(
      (value) => {
        settle();
        resolve(value);
      },
      (error: unknown) => {
        settle();
        reject(error);
      },
    );
  });
}
