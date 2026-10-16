import { SinatraError } from "./error";

/** At most this many retries after the first attempt. */
export const MAX_RETRIES = 3;
/** The first `503` backoff; it doubles on each retry (0.5s, 1s, 2s). */
const BACKOFF_MS = 500;
/** A `Retry-After` longer than this is cut to it. */
const MAX_RETRY_AFTER_MS = 60_000;

/** Which statuses a request may be retried on. */
export type RetryOn = ReadonlySet<number>;
/** GETs, DELETE, and POSTs that carry an `Idempotency-Key`. */
export const RETRY_IDEMPOTENT: RetryOn = new Set([429, 503]);
/** `tasks.stop`: a stop is safe to repeat after a `503`, but not after a `429`. */
export const RETRY_UNAVAILABLE: RetryOn = new Set([503]);
/** POSTs without an `Idempotency-Key`: never retried. */
export const RETRY_NEVER: RetryOn = new Set();

/** What one attempt of a generated SDK call resolves to (with `throwOnError: false`). */
interface AttemptResult<T> {
  data?: T;
  error?: unknown;
  response?: Response;
}

export interface CallOptions {
  /** Cancels the call, including a retry it is waiting to make. */
  signal?: AbortSignal;
  /** Milliseconds each attempt may take before it is aborted with a `TimeoutError`. `0` for none. */
  timeout?: number;
}

/**
 * Runs `attempt` until it succeeds, fails with a status `retryOn` doesn't
 * cover, or runs out of retries. Every attempt must send the same request:
 * callers compute the `Idempotency-Key` once, outside `attempt`.
 */
export async function withRetries<T>(
  retryOn: RetryOn,
  options: CallOptions,
  attempt: (signal: AbortSignal) => Promise<AttemptResult<T>>,
): Promise<T> {
  for (let retry = 0; ; retry++) {
    const limit = attemptSignal(options);
    let result: AttemptResult<T>;
    try {
      result = await attempt(limit.signal);
    } finally {
      limit.done();
    }
    const { response } = result;
    // No response: fetch itself failed (network error, timeout, abort). Surface it as is.
    if (!response) throw result.error;
    if (response.ok) {
      // A 2xx whose body didn't parse.
      if ("error" in result) throw result.error;
      return result.data as T;
    }
    if (retry < MAX_RETRIES && retryOn.has(response.status)) {
      await sleep(retryDelayMs(response, retry), options.signal);
      continue;
    }
    throw new SinatraError(response.status, result.error, response.headers);
  }
}

/** One attempt's signal: aborted by the caller's signal, or when the timeout passes. */
function attemptSignal({ signal, timeout }: CallOptions): { signal: AbortSignal; done(): void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer =
    timeout && timeout > 0 && Number.isFinite(timeout)
      ? setTimeout(
          () => controller.abort(new DOMException(`Request timed out after ${timeout}ms`, "TimeoutError")),
          timeout,
        )
      : undefined;
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function retryDelayMs(response: Response, retry: number): number {
  if (response.status === 429) {
    const after = parseRetryAfter(response.headers.get("retry-after"));
    if (after !== undefined) return Math.min(after, MAX_RETRY_AFTER_MS);
  }
  return BACKOFF_MS * 2 ** retry;
}

/** `Retry-After` is either seconds or an HTTP date. Returns milliseconds. */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
