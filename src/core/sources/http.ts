/**
 * Requests to Source providers, from the main process (never the window):
 * each on its service's lane of the Pace, named by a User-Agent, within a
 * time and size limit, without cookies. A 429 or 503 with a short
 * Retry-After waits and tries once more; otherwise it stops and says so.
 */
import { type Pace, type PaceTimers, realTimers } from "./pace";

/**
 * Why a request gave nothing:
 * - "unreachable": no answer, or none in time;
 * - "rate-limited": the service asked to slow down (429, 503), or its free allowance is used up;
 * - "service-error": an error status, or an answer that can't be read;
 * - "not-found": 404 or 410;
 * - "not-open": what came back isn't the open file asked for (a sign-in page, a paywall, too large);
 * - "needs-key": the provider works only with the User's own key, and none is set;
 * - "key-rejected": the provider turned the User's key away.
 */
export type SourceErrorReason =
  | "unreachable"
  | "rate-limited"
  | "service-error"
  | "not-found"
  | "not-open"
  | "needs-key"
  | "key-rejected";

export class SourceError extends Error {
  override name = "SourceError";
  constructor(
    readonly reason: SourceErrorReason,
    message: string,
    /** The status the service answered, when it answered one. */
    readonly status: number | null = null,
    /** "rate-limited": when the service said it takes requests again, epoch milliseconds. */
    readonly resetsAt: number | null = null,
  ) {
    super(message);
  }
}

/** How IncarnaMind names itself to the services it asks, so their operators can reach the project. */
export const SOURCE_USER_AGENT = "IncarnaMind (https://github.com/IncarnaMind/IncarnaMind)";

/**
 * For an open copy on a publisher's or a repository's own site, which may
 * turn away what doesn't look like a browser: as adding a web page does, with
 * IncarnaMind still named.
 */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 IncarnaMind";

/** The longest a 429 or 503 may ask to wait before the one retry; longer, and the request stops. */
const MAX_RETRY_AFTER_MS = 30_000;

export interface SourceRequest {
  /** The service's lane on the Pace, and how far apart its requests must be. */
  lane: string;
  intervalMs: number;
  accept: string;
  signal: AbortSignal;
  /** Defaults to 20 seconds. */
  timeoutMs?: number;
  /** Defaults to `SOURCE_USER_AGENT`. */
  userAgent?: string;
  /** Defaults to 20 MB, far more than any API answer. */
  maxBytes?: number;
  /** Extra headers, for a key: never written to an error. */
  headers?: Record<string, string>;
  /** "manual": a redirect isn't followed; its target is the response's `url`, with no body. */
  redirect?: "manual";
  /** Called as each request is sent, after any wait for its lane; throws to send nothing. */
  beforeSend?: () => void;
}

export interface SourceResponse {
  bytes: Uint8Array;
  /** As served, e.g. "application/pdf". */
  contentType: string | null;
  /** After redirects. */
  url: string;
}

const isWebAddress = (url: string) => /^https?:$/i.test(URL.parse(url)?.protocol ?? "");

/** Seconds, or an HTTP date; null when it says neither. */
function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** OpenAlex says how many seconds until its allowance resets; others give the moment, in epoch seconds. */
function resetMs(header: string | null, now: number): number | null {
  const seconds = Number(header);
  if (!header || !Number.isFinite(seconds)) return null;
  return seconds > 1e9 ? Math.max(0, seconds * 1000 - now) : seconds * 1000;
}

async function readBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SourceError("not-open", `The answer is larger than ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

const messageOf = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
};

export interface SourceHttp {
  /** GETs `url`; throws `SourceError` saying why when it can't. */
  get(url: string, request: SourceRequest): Promise<SourceResponse>;
  /** GETs `url` as text (UTF-8). */
  text(url: string, request: SourceRequest): Promise<string>;
}

export function createSourceHttp(pace: Pace, timers: PaceTimers = realTimers): SourceHttp {
  async function once(url: string, request: SourceRequest): Promise<Response> {
    request.beforeSend?.();
    const timeout = AbortSignal.timeout(request.timeoutMs ?? 20_000);
    try {
      return await fetch(url, {
        redirect: request.redirect ?? "follow",
        credentials: "omit",
        signal: AbortSignal.any([request.signal, timeout]),
        headers: {
          ...request.headers,
          Accept: request.accept,
          "User-Agent": request.userAgent ?? SOURCE_USER_AGENT,
        },
      });
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      const origin = URL.parse(url)?.origin ?? url;
      throw new SourceError(
        "unreachable",
        timeout.aborted
          ? `${origin} didn't answer in time.`
          : `Couldn't reach ${origin}: ${messageOf(error)}`,
      );
    }
  }

  async function get(url: string, request: SourceRequest): Promise<SourceResponse> {
    if (!isWebAddress(url)) {
      throw new SourceError("service-error", "Only http and https addresses are fetched.");
    }
    return pace.run(
      request.lane,
      request.intervalMs,
      async () => {
        let response = await once(url, request);
        if (response.status === 429 || response.status === 503) {
          const wait = retryAfterMs(response.headers.get("retry-after"), timers.now());
          await response.body?.cancel().catch(() => undefined);
          if (wait === null || wait > MAX_RETRY_AFTER_MS) {
            const reset = resetMs(response.headers.get("x-ratelimit-reset"), timers.now()) ?? wait;
            throw new SourceError(
              "rate-limited",
              `${url} answered ${response.status}.`,
              response.status,
              reset === null ? null : timers.now() + reset,
            );
          }
          await timers.sleep(wait, request.signal);
          response = await once(url, request);
          if (response.status === 429 || response.status === 503) {
            await response.body?.cancel().catch(() => undefined);
            throw new SourceError(
              "rate-limited",
              `${url} answered ${response.status} again.`,
              response.status,
            );
          }
        }
        const fail = async (error: SourceError): Promise<never> => {
          await response.body?.cancel().catch(() => undefined);
          throw error;
        };
        const { status } = response;
        if (request.redirect === "manual" && status >= 300 && status < 400) {
          const target = URL.parse(response.headers.get("location") ?? "", url)?.href;
          await response.body?.cancel().catch(() => undefined);
          if (!target || !isWebAddress(target)) {
            throw new SourceError("service-error", `${url} redirected nowhere.`, status);
          }
          return { bytes: new Uint8Array(), contentType: null, url: target };
        }
        if (status === 404 || status === 410) {
          return fail(new SourceError("not-found", `${url} answered ${status}.`, status));
        }
        if (status === 401 || status === 402 || status === 403) {
          return fail(new SourceError("not-open", `${url} answered ${status}.`, status));
        }
        if (!response.ok) {
          return fail(new SourceError("service-error", `${url} answered ${status}.`, status));
        }
        const finalUrl = response.url || url;
        if (!isWebAddress(finalUrl)) {
          return fail(new SourceError("not-open", "The address redirected away from the web."));
        }
        const maxBytes = request.maxBytes ?? 20 * 1024 * 1024;
        const length = Number(response.headers.get("content-length"));
        if (length > maxBytes) {
          return fail(new SourceError("not-open", `The file is ${length} bytes.`));
        }
        try {
          return {
            bytes: await readBody(response, maxBytes),
            contentType: response.headers.get("content-type"),
            url: finalUrl,
          };
        } catch (error) {
          if (error instanceof SourceError) throw error;
          if (request.signal.aborted) throw request.signal.reason;
          throw new SourceError("unreachable", `The answer broke off: ${messageOf(error)}`);
        }
      },
      request.signal,
    );
  }

  return {
    get,
    async text(url, request) {
      const { bytes } = await get(url, request);
      return new TextDecoder("utf-8").decode(bytes);
    },
  };
}

/** `http`, whose every request first passes `check` (../sendGate) as it is sent. */
export function gatedHttp(http: SourceHttp, check: () => void): SourceHttp {
  return {
    get: (url, request) => http.get(url, { ...request, beforeSend: check }),
    text: (url, request) => http.text(url, { ...request, beforeSend: check }),
  };
}
