/**
 * @fileoverview Paced, retried GET against one ILOSTAT host. Both upstream clients
 * build on it: one pacer per host (retry outside, pacer inside), a per-attempt
 * header timeout plus a body stall timeout, and the busy mapping — an HTTP 429 or a
 * Cloudflare challenge page throws `upstream_busy` inside the pacer task, which is
 * what closes the pacer's cooldown gate, and a pacer shed is rewrapped as the same
 * reason. The wait it reports is never below 1 s, and after a 429 or challenge it
 * is never shorter than the cooldown the pacer then applies. Some non-2xx
 * statuses are results on these hosts, so each request names
 * the statuses whose body it interprets; every other status is an error, unless
 * the request maps it to a domain error first. A buffered request reads and
 * interprets the whole body inside each retry attempt; a streamed request retries
 * only up to the response headers, then hands the body over as text chunks, and a
 * stream that fails after that point is never retried. Every body is bounded:
 * each request names its byte cap, past which the read stops and the call fails
 * `upstream_too_large` (never retried); an error body is read only for its
 * message, so it is cut off at 64 KiB instead and its status still decides the
 * error. A body must arrive in full within `bodyMs` of its first read, however
 * steadily it trickles.
 * @module services/upstream/upstream-http
 */

import { McpError, rateLimited, serviceUnavailable, timeout } from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  defaultIsTransient,
  httpErrorFromResponse,
  type Pacer,
  type PacerCooldownOptions,
  type PacerLimit,
  type RequestContext,
  type RetryOptions,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';

/** The `fetch` seam each client accepts; defaults to `globalThis.fetch`. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Pacer settings for one host, plus the queue-wait ceiling tool-initiated calls use. */
export interface PacingOptions {
  cooldown?: PacerCooldownOptions;
  limits: PacerLimit[];
  maxConcurrent: number;
  /** Queue-time ceiling for tool-initiated calls; a longer projected wait sheds as `upstream_busy`. */
  maxWaitMs: number;
  minStartGapMs: number;
}

/**
 * Per-attempt timers: time to response headers, the longest gap between body
 * chunks, and the longest a whole body may take from its first read.
 */
export interface TimeoutOptions {
  bodyMs: number;
  headersMs: number;
  stallMs: number;
}

/** The `withRetry` budget around one request. */
export interface RetryPolicy {
  baseDelayMs: number;
  deadlineMs: number;
  maxRetries: number;
}

/** Constructor options shared by both upstream clients — the test seam for every timer and the network. */
export interface UpstreamClientOptions {
  fetch?: FetchFn;
  pacing?: PacingOptions;
  retry?: RetryPolicy;
  timeouts?: TimeoutOptions;
  userAgent: string;
}

/**
 * Who is waiting on a request. A tool call passes its handler `ctx`; the background
 * catalog loader passes a plain request context. `recoveryFor` is declared as a
 * method so a handler context typed against its own contract still fits.
 */
export interface UpstreamScope extends RequestContext {
  recoveryFor?(reason: string): { recovery: { hint: string } } | Record<string, never>;
  readonly signal?: AbortSignal;
}

/** What every request names: where, what to accept, and how long it may queue. */
interface RequestBase {
  accept: string;
  /** Statuses whose body the caller reads. Any other status becomes an error. */
  acceptStatuses: readonly number[];
  /**
   * Tool-initiated calls wait at most `pacing.maxWaitMs` in the queue; the
   * background catalog loader waits without a cap.
   */
  bounded: boolean;
  /** Most body bytes (decoded from any content encoding) read before the call fails `upstream_too_large`. */
  maxBytes: number;
  operation: string;
  /**
   * Maps a non-accepted status and its body to a domain error; `undefined`
   * falls through to the generic status mapping. The body is read only when
   * this is set, and at most {@link ERROR_BODY_MAX_BYTES} of it.
   */
  rejectStatus?: (status: number, body: string) => Error | undefined;
  url: string;
}

/** A buffered request: the whole body is read and interpreted inside each attempt. */
export interface UpstreamRequest<T> extends RequestBase {
  /** Runs inside each retry attempt, so a transient error it throws is retried. */
  interpret: (exchange: { body: string; status: number }) => T;
}

/**
 * A buffered body is also bounded by the retry deadline (45 s), so `bodyMs` binds
 * the streamed ones: a full 1,000,000-row download is ~92 MiB.
 */
const DEFAULT_TIMEOUTS: TimeoutOptions = { headersMs: 30_000, stallMs: 30_000, bodyMs: 600_000 };
const DEFAULT_RETRY: RetryPolicy = { maxRetries: 2, baseDelayMs: 1_000, deadlineMs: 45_000 };

const KIB = 1024;
const MIB = 1024 * KIB;

/**
 * The most of an error body `rejectStatus` interprets; the one upstream sends (a
 * retired dataset ID) is ~150 bytes. The rest is never read, and never fails the
 * call: a 503 with a long page is still retried as a 503.
 */
const ERROR_BODY_MAX_BYTES = 64 * KIB;

const byteSize = (bytes: number): string =>
  bytes % MIB === 0 ? `${bytes / MIB} MiB` : `${bytes / KIB} KiB`;

/** A body past its request's cap. Never retried: the same request would send the same body. */
function upstreamTooLarge(service: string, operation: string, maxBytes: number): McpError {
  return serviceUnavailable(
    `${service} sent more than ${byteSize(maxBytes)} for ${operation}; the rest of the response was not read.`,
    { reason: 'upstream_too_large', retryable: false, maxBytes },
  );
}

/** Reason carried by every throttling failure — upstream 429, challenge page, or pacer shed. */
const UPSTREAM_BUSY_REASON = 'upstream_busy';

/** True for the throttling failure, which is never retried in-call: the pacer cooldown handles the wait. */
export function isUpstreamBusy(error: unknown): boolean {
  return error instanceof McpError && error.data?.reason === UPSTREAM_BUSY_REASON;
}

function isPacerShed(error: unknown): error is McpError {
  return error instanceof McpError && error.data?.reason === 'pacer_shed';
}

/**
 * The throttling failure. A known wait is reported as at least 1 s: a pacer shed
 * while every slot is in flight carries `retryAfter: 0`, since the pacer's wait
 * projection does not model `maxConcurrent`, and "retry in about 0 s" invites an
 * immediate retry that sheds again.
 */
function upstreamBusy(
  service: string,
  waitSeconds: number | undefined,
  scope: UpstreamScope,
  cause?: unknown,
): McpError {
  const retryAfter = waitSeconds === undefined ? undefined : Math.max(1, waitSeconds);
  return rateLimited(
    `${service} is throttling this server${retryAfter === undefined ? '' : `; retry in about ${retryAfter} s`}.`,
    {
      reason: UPSTREAM_BUSY_REASON,
      retryable: true,
      ...(retryAfter === undefined ? {} : { retryAfter }),
      ...scope.recoveryFor?.(UPSTREAM_BUSY_REASON),
    },
    cause === undefined ? undefined : { cause },
  );
}

/** `Retry-After` as whole seconds, when the upstream sent the delta-seconds form. */
function retryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get('retry-after')?.trim();
  if (!header || !/^\d+$/.test(header)) return;
  return Number(header);
}

type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

/** What bounds one body: its byte cap and operation, and the client's stall and total timers. */
interface BodyLimits {
  bodyMs: number;
  maxBytes: number;
  operation: string;
  /** Past `maxBytes`: fail `upstream_too_large`, or end the body at the cap (an error body). */
  overflow: 'fail' | 'truncate';
  stallMs: number;
}

/** One read that fails with `expired()` when no bytes arrive for `waitMs`. */
function readWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  waitMs: number,
  expired: () => McpError,
): Promise<ReadResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reader.cancel().catch(() => undefined);
      reject(expired());
    }, waitMs);
    reader.read().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * A body as decoded text chunks. A stall past `stallMs`, or a body still arriving
 * `bodyMs` after its first read, fails with `Timeout`; a body past `maxBytes`
 * fails `upstream_too_large` before the chunk that crossed it is decoded, or
 * under `truncate` ends at `maxBytes`; a connection dropped mid-body fails with
 * `ServiceUnavailable`; a cancellation (`signal`) passes through untouched.
 * Stopping early cancels the body.
 *
 * The body is locked here, before the first read: Node's fetch cancels an
 * unlocked body once its `Response` is garbage-collected, and a cancelled body
 * then reads as an empty one — no error, no bytes.
 */
function streamBodyText(
  body: ReadableStream<Uint8Array> | null,
  limits: BodyLimits,
  service: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body?.getReader();
  const overdue = () =>
    timeout(`${service} took longer than ${limits.bodyMs / 1000} s to send the response.`);
  const stalled = () =>
    timeout(`${service} stopped sending data for ${limits.stallMs / 1000} s mid-response.`);
  return (async function* () {
    if (!reader) return;
    const decoder = new TextDecoder();
    const deadline = Date.now() + limits.bodyMs;
    let received = 0;
    try {
      for (;;) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw overdue();
        let result: ReadResult;
        try {
          result = await (remainingMs < limits.stallMs
            ? readWithin(reader, remainingMs, overdue)
            : readWithin(reader, limits.stallMs, stalled));
        } catch (error) {
          if (signal?.aborted || error instanceof McpError) throw error;
          throw serviceUnavailable(`${service} dropped the connection mid-response.`, undefined, {
            cause: error,
          });
        }
        if (result.done) break;
        const room = limits.maxBytes - received;
        received += result.value.byteLength;
        if (received > limits.maxBytes) {
          if (limits.overflow === 'fail') {
            throw upstreamTooLarge(service, limits.operation, limits.maxBytes);
          }
          const text = decoder.decode(result.value.subarray(0, room));
          if (text) yield text;
          return;
        }
        const text = decoder.decode(result.value, { stream: true });
        if (text) yield text;
      }
      const tail = decoder.decode();
      if (tail) yield tail;
    } finally {
      reader.cancel().catch(() => undefined);
    }
  })();
}

/** Reads a whole body to text under the same limits and rules as {@link streamBodyText}. */
async function readBodyText(
  body: ReadableStream<Uint8Array> | null,
  limits: BodyLimits,
  service: string,
  signal: AbortSignal,
): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of streamBodyText(body, limits, service, signal)) chunks.push(chunk);
  return chunks.join('');
}

/** Paced, retried HTTP client for one upstream host. */
export class UpstreamHttp {
  /**
   * Busy answers since the last request that succeeded — the count the pacer
   * doubles its cooldown by, mirrored here because the pacer does not expose it.
   */
  private consecutiveBusy = 0;
  private readonly fetchImpl: FetchFn;
  private readonly pacer: Pacer;
  private readonly pacing: PacingOptions;
  private readonly retry: RetryPolicy;
  private readonly timeouts: TimeoutOptions;
  private readonly userAgent: string;

  constructor(
    private readonly service: string,
    options: UpstreamClientOptions,
    defaultPacing: PacingOptions,
  ) {
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.pacing = options.pacing ?? defaultPacing;
    this.retry = options.retry ?? DEFAULT_RETRY;
    this.timeouts = options.timeouts ?? DEFAULT_TIMEOUTS;
    this.userAgent = options.userAgent;
    this.pacer = createPacer({
      name: service,
      limits: this.pacing.limits,
      minStartGapMs: this.pacing.minStartGapMs,
      maxConcurrent: this.pacing.maxConcurrent,
      ...(this.pacing.cooldown ? { cooldown: this.pacing.cooldown } : {}),
    });
  }

  /** Clears the pacer's dispatch timer and rejects queued waiters. */
  dispose(): void {
    this.pacer.dispose();
  }

  /** GET `request.url`, paced and retried, and hand the accepted body to `request.interpret`. */
  request<T>(request: UpstreamRequest<T>, scope: UpstreamScope): Promise<T> {
    return withRetry(
      async (attempt) => {
        const exchange = await this.paced(request, scope, attempt.signal, async (signal) => {
          const response = await this.send(request, signal, scope);
          return {
            status: response.status,
            body: await readBodyText(response.body, this.bodyLimits(request), this.service, signal),
          };
        });
        return request.interpret(exchange);
      },
      this.retryOptions(request, scope),
    );
  }

  /**
   * GET `request.url`, paced and retried up to the response headers, and return
   * the body as text chunks. `signal` ends the transfer: abort it once the caller
   * stops reading, so an early stop never leaves the connection draining.
   */
  async openStream(
    request: RequestBase,
    scope: UpstreamScope,
    signal: AbortSignal,
  ): Promise<AsyncGenerator<string>> {
    const response = await withRetry(
      (attempt) =>
        this.paced(request, scope, attempt.signal, (pacerSignal) =>
          this.send(request, AbortSignal.any([pacerSignal, signal]), scope),
        ),
      this.retryOptions(request, scope),
    );
    return streamBodyText(
      response.body,
      this.bodyLimits(request),
      this.service,
      scope.signal ? AbortSignal.any([scope.signal, signal]) : signal,
    );
  }

  private bodyLimits(request: RequestBase): BodyLimits {
    return {
      maxBytes: request.maxBytes,
      overflow: 'fail',
      operation: request.operation,
      stallMs: this.timeouts.stallMs,
      bodyMs: this.timeouts.bodyMs,
    };
  }

  private retryOptions(request: RequestBase, scope: UpstreamScope): RetryOptions {
    return {
      operation: request.operation,
      context: scope,
      maxRetries: this.retry.maxRetries,
      baseDelayMs: this.retry.baseDelayMs,
      deadlineMs: this.retry.deadlineMs,
      ...(scope.signal ? { signal: scope.signal } : {}),
      isTransient: (error) => !isUpstreamBusy(error) && defaultIsTransient(error),
    };
  }

  /** Runs `task` through the pacer; a shed is rewrapped as `upstream_busy` with its wait. */
  private async paced<T>(
    request: RequestBase,
    scope: UpstreamScope,
    signal: AbortSignal,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    try {
      const value = await this.pacer.run(task, {
        signal,
        ...(request.bounded ? { maxWaitMs: this.pacing.maxWaitMs } : {}),
      });
      this.consecutiveBusy = 0;
      return value;
    } catch (error) {
      if (isPacerShed(error)) {
        const retryAfter = error.data?.retryAfter;
        throw upstreamBusy(
          this.service,
          typeof retryAfter === 'number' ? retryAfter : undefined,
          scope,
          error,
        );
      }
      throw error;
    }
  }

  /**
   * One attempt inside the pacer: fetch, busy check, status check. Returns the
   * response with its body unread when the status is accepted.
   */
  private async send(
    request: RequestBase,
    attemptSignal: AbortSignal,
    scope: UpstreamScope,
  ): Promise<Response> {
    const headerClock = new AbortController();
    const timer = setTimeout(() => headerClock.abort(), this.timeouts.headersMs);
    let response: Response;
    try {
      response = await this.fetchImpl(request.url, {
        // Node's fetch sends `Accept-Language: *` unless told otherwise, and the SDMX
        // host answers that with HTTP 500 (`languageTag1`); the server is English-only.
        headers: {
          Accept: request.accept,
          'Accept-Language': 'en',
          'User-Agent': this.userAgent,
        },
        signal: AbortSignal.any([attemptSignal, headerClock.signal]),
      });
    } catch (error) {
      if (attemptSignal.aborted) throw error;
      if (headerClock.signal.aborted) {
        throw timeout(
          `${this.service} sent no response within ${this.timeouts.headersMs / 1000} s.`,
          undefined,
          { cause: error },
        );
      }
      throw serviceUnavailable(`${this.service} could not be reached.`, undefined, {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    const accepted = request.acceptStatuses.includes(response.status);
    const contentType = response.headers.get('content-type') ?? '';
    const challenged =
      response.headers.get('cf-mitigated') === 'challenge' ||
      (accepted && contentType.includes('text/html'));
    if (response.status === 429 || challenged) {
      await response.body?.cancel().catch(() => undefined);
      this.consecutiveBusy++;
      throw upstreamBusy(this.service, this.busyWaitSeconds(retryAfterSeconds(response)), scope);
    }
    if (!accepted) {
      if (request.rejectStatus) {
        const body = await readBodyText(
          response.body,
          { ...this.bodyLimits(request), maxBytes: ERROR_BODY_MAX_BYTES, overflow: 'truncate' },
          this.service,
          attemptSignal,
        );
        const mapped = request.rejectStatus(response.status, body);
        if (mapped) throw mapped;
      }
      const error = await httpErrorFromResponse(response, {
        service: this.service,
        captureBody: false,
      });
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    return response;
  }

  /**
   * The wait to report for the current run of busy answers: the upstream's
   * `Retry-After`, raised to the cooldown the pacer closes its gate for once this
   * answer reaches it — `min(baseMs · 2^(n−1), maxMs)` for the n-th in a row.
   * The pacer also honours the reported value, so the gate never outlasts it.
   */
  private busyWaitSeconds(upstreamSeconds: number | undefined): number | undefined {
    const cooldown = this.pacing.cooldown;
    if (!cooldown) return upstreamSeconds;
    const gateMs = Math.min(cooldown.baseMs * 2 ** (this.consecutiveBusy - 1), cooldown.maxMs);
    return Math.max(upstreamSeconds ?? 0, Math.ceil(gateMs / 1000));
  }
}
