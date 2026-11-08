/**
 * Fetches a web page from this computer (#261): http(s) only, within a time
 * and a size limit, without cookies, and only the page itself, nothing it
 * embeds.
 */
import { WebPageError } from "./errors";

export interface FetchLimits {
  /** Headers and body together. */
  timeoutMs: number;
  maxBytes: number;
}

export const FETCH_LIMITS: FetchLimits = { timeoutMs: 20_000, maxBytes: 10 * 1024 * 1024 };

/** What `fetchPage` asks of a fetch: the public-internet one (../../tools/web/fetcher), or one a test gives. */
export interface PageRequest {
  redirect: "follow";
  credentials: "omit";
  signal: AbortSignal;
  headers: Record<string, string>;
}

/** What `fetchPage` reads of a response, whichever fetch gave it. */
export interface PageResponse {
  readonly url: string;
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  readonly body: (AsyncIterable<Uint8Array> & { cancel(): Promise<void> }) | null;
}

export type PageFetch = (address: string, init: PageRequest) => Promise<PageResponse>;

export interface FetchedPage {
  html: string;
  /** After any redirects. */
  url: string;
}

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

// Some sites turn away requests that don't look like a browser's.
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 IncarnaMind";

const isWebAddress = (url: string) => /^https?:$/i.test(URL.parse(url)?.protocol ?? "");

const messageOf = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
};

const timedOut = (error: unknown, signal: AbortSignal) =>
  signal.aborted || (error instanceof Error && error.name === "TimeoutError");

function declaredCharset(bytes: Uint8Array): string | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  return /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1] ?? null;
}

/** By its byte-order mark, its Content-Type's charset, its markup's, else UTF-8. */
export function decodePage(bytes: Uint8Array, contentType: string | null): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes);
  }
  const charset =
    /charset\s*=\s*["']?([\w-]+)/i.exec(contentType ?? "")?.[1] ?? declaredCharset(bytes);
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

async function readBody(response: PageResponse, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Leaving the loop early cancels the rest of the body.
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      throw new WebPageError("too-large", `The page is larger than ${maxBytes} bytes.`);
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** Throws `WebPageError` when it can't, saying why. */
export async function fetchPage(
  address: string,
  options: { limits?: FetchLimits; fetch?: PageFetch; languages?: readonly string[] } = {},
): Promise<FetchedPage> {
  const { timeoutMs, maxBytes } = options.limits ?? FETCH_LIMITS;
  if (!isWebAddress(address)) {
    throw new WebPageError("invalid-address", "Only http and https addresses are fetched.");
  }
  const signal = AbortSignal.timeout(timeoutMs);
  const languages = options.languages?.length ? options.languages.join(",") : "en";
  let response: PageResponse;
  try {
    response = await (options.fetch ?? fetch)(address, {
      redirect: "follow",
      credentials: "omit",
      signal,
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "Accept-Language": languages,
        "User-Agent": USER_AGENT,
      },
    });
  } catch (error) {
    if (error instanceof WebPageError) throw error;
    if (timedOut(error, signal)) {
      throw new WebPageError("timed-out", `No answer within ${timeoutMs} ms.`, { cause: error });
    }
    throw new WebPageError("unreachable", messageOf(error), { cause: error });
  }
  const url = response.url || address;
  const fail = async (failure: WebPageError): Promise<never> => {
    await response.body?.cancel().catch(() => undefined);
    throw failure;
  };
  if (!isWebAddress(url)) {
    return fail(new WebPageError("unreachable", "The page redirected away from the web."));
  }
  const { status } = response;
  if (status === 401 || status === 403 || status === 407) {
    return fail(new WebPageError("needs-sign-in", `The site answered ${status}.`));
  }
  if (status === 404 || status === 410) {
    return fail(new WebPageError("not-found", `The site answered ${status}.`));
  }
  if (!response.ok) return fail(new WebPageError("site-error", `The site answered ${status}.`));
  const contentType = response.headers.get("content-type");
  const mediaType = (contentType ?? "text/html").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!HTML_TYPES.has(mediaType)) {
    return fail(new WebPageError("not-a-page", `The address is a file of type ${mediaType}.`));
  }
  const length = Number(response.headers.get("content-length"));
  if (length > maxBytes) {
    return fail(new WebPageError("too-large", `The page is ${length} bytes.`));
  }
  try {
    return { html: decodePage(await readBody(response, maxBytes), contentType), url };
  } catch (error) {
    if (error instanceof WebPageError) throw error;
    if (timedOut(error, signal)) {
      throw new WebPageError("timed-out", `No answer within ${timeoutMs} ms.`, { cause: error });
    }
    throw new WebPageError("unreachable", messageOf(error), { cause: error });
  }
}
