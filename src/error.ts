/**
 * The one error the client throws for an HTTP error response.
 *
 * `code` is the API's machine-readable `error` code, such as `capacity_full`.
 * New codes can appear at any time, so treat it as an open string. Branch on
 * `code`, not on `reason` or `message`.
 *
 * Network failures (DNS, refused connections) are not wrapped: they reject
 * with the error `fetch` threw.
 */
export class SinatraError extends Error {
  override readonly name = "SinatraError";
  /** The HTTP status, such as `409`. */
  readonly status: number;
  /**
   * The API's `error` code, such as `not_running`. `http_error` when the
   * response had no code, for example an HTML page from a proxy.
   */
  readonly code: string;
  /** A sentence saying what went wrong, written to show to a person. */
  readonly reason: string | undefined;
  /** The request's id, from the body or the `x-request-id` header. Share it with support. */
  readonly requestId: string | undefined;
  /** The response body: the parsed JSON object, or the text when it wasn't JSON. */
  readonly body: unknown;
  /** The response headers. */
  readonly headers: Headers;

  constructor(status: number, body: unknown, headers: Headers) {
    const fields = isRecord(body) ? body : {};
    const code = typeof fields.error === "string" ? fields.error : "http_error";
    const reason = typeof fields.reason === "string" ? fields.reason : undefined;
    super(reason ? `${status} ${code}: ${reason}` : `${status} ${code}`);
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.requestId =
      (typeof fields.requestId === "string" ? fields.requestId : undefined) ??
      headers.get("x-request-id") ??
      undefined;
    this.body = body;
    this.headers = headers;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
