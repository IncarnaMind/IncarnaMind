/**
 * OAuth 2.0 sign-in for a desktop app: the authorization code flow with PKCE
 * (RFC 7636) in the User's browser. Nothing here knows about a particular
 * service: the caller passes every URL, the client ID and where the browser
 * comes back to.
 *
 * `openLoopbackRedirect` (RFC 8252) is used on its own by remote Connectors,
 * whose sign-in the MCP SDK builds; `authorizeInBrowser` runs the whole flow
 * on it, or on a page of the server's own whose code the User pastes.
 * `authorizeWithDevice` is the device flow (RFC 8628): the User types a code
 * the app shows on the server's own page.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isRecord } from "./errors";

/** The browser sign-in gives up after this long unless the caller sets its own limit. */
export const DEFAULT_SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** The server always listens here (and on ::1 for a "localhost" redirect), never elsewhere. */
const LOOPBACK_HOST = "127.0.0.1";

export interface OAuthPage {
  title: string;
  body: string;
}

/** Where the browser comes back to: a one-off HTTP server on the loopback interface. */
export interface LoopbackRedirectOptions {
  /**
   * The loopback port to listen on. Some servers allow only the redirect URI
   * they registered, so a fixed port; 0 picks any free port, for servers that
   * accept any loopback port (RFC 8252 §7.3).
   */
  port: number;
  /** The redirect path, e.g. "/auth/callback"; "" for the bare address. */
  path: string;
  /**
   * The host name the redirect URI names. The server listens on 127.0.0.1 either way; a
   * registration that allows only `http://localhost` (Microsoft's public clients) needs that name.
   */
  host?: LoopbackHost;
  /** What the browser tab shows when sign-in finishes, or fails. */
  pages: { success: OAuthPage; failure: OAuthPage };
  /** Defaults to five minutes. */
  timeoutMs?: number;
  /** Aborting cancels the sign-in and frees the port. */
  signal?: AbortSignal;
  /** Random bytes in the sign-in's `state`. Defaults to 24; some servers want more. */
  stateBytes?: number;
}

/** How a loopback redirect URI names this computer (RFC 8252 §7.3). */
export type LoopbackHost = "127.0.0.1" | "localhost";

export type RedirectShape =
  /** A loopback server (`openLoopbackRedirect`); pasting the browser's address is the fallback. */
  | { kind: "loopback"; port: number; path: string; host?: LoopbackHost }
  /**
   * A page of the authorization server's own, which shows the code to copy:
   * the User pastes it, as "code#state" or as the page's address.
   */
  | { kind: "page"; uri: string };

export interface BrowserAuthorizationOptions {
  /** The authorization endpoint, e.g. "https://auth.example.com/oauth/authorize". */
  authorizeUrl: string;
  /** The token endpoint, for exchanging the code. */
  tokenUrl: string;
  clientId: string;
  scope?: string;
  redirect: RedirectShape;
  /** What a loopback redirect's browser tab shows when sign-in finishes, or fails. */
  pages: { success: OAuthPage; failure: OAuthPage };
  /** Defaults to five minutes. */
  timeoutMs?: number;
  /** Aborting cancels the sign-in and frees the port. */
  signal?: AbortSignal;
  /** Random bytes in the sign-in's `state`. Defaults to 24; some servers want more. */
  stateBytes?: number;
  /** Extra query parameters for the authorization request (e.g. RFC 8707 `resource`). */
  authorizeParams?: Readonly<Record<string, string>>;
  tokenParams?: Readonly<Record<string, string>>;
  /** How the token endpoint takes a request. Defaults to a form (RFC 6749). */
  tokenFormat?: TokenRequestFormat;
  /** The code exchange carries the `state` too, for a server that asks for it back. */
  stateInExchange?: boolean;
  /**
   * Called once the browser is open, with the redirect's `paste`, for a User
   * whose browser can't come back to IncarnaMind.
   */
  onWaiting?(paste: SignInRedirect["paste"]): void;
  /**
   * Checks what the browser brought back before anything in it is used (see
   * `RedirectReceipt.verify`).
   */
  verify?(params: URLSearchParams): void;
  /**
   * The client ID to exchange the code for, from what the browser brought
   * back. Defaults to `clientId`; a server that registers the app during this
   * sign-in names the client it issued there.
   */
  exchangeClientId?(params: URLSearchParams): string;
  /** Opens the authorization URL in the User's browser. */
  openBrowser(url: string): Promise<void>;
  fetch?: typeof globalThis.fetch;
}

export type TokenRequestFormat = "form" | "json";

/** A token endpoint's answer (RFC 6749 §5.1), in camelCase. */
export interface OAuthTokens {
  accessToken: string;
  /** Absent when the server issues no refresh token, or keeps the old one on refresh. */
  refreshToken: string | null;
  /** OpenID Connect servers send one when the "openid" scope was requested. */
  idToken: string | null;
  /** Lifetime of the access token in seconds, as the server sent it. */
  expiresIn: number | null;
  scope: string | null;
  /** The account the answer names, where the server adds one (Anthropic's does). */
  account: { email: string | null; organization: string | null };
}

export type OAuthFlowFailure =
  /** Another program is listening on the port (for example another app signing in). */
  | "port-in-use"
  /** Nothing came back from the browser in time. */
  | "timed-out"
  /** The caller cancelled. */
  | "cancelled"
  /** The authorization server redirected back with an error, e.g. the User declined. */
  | "denied";

/** The browser part of a sign-in failed. */
export class OAuthFlowError extends Error {
  override name = "OAuthFlowError";
  constructor(
    readonly reason: OAuthFlowFailure,
    message: string,
  ) {
    super(message);
  }
}

/** The token endpoint refused a code exchange or a refresh, or sent something unusable. */
export class OAuthTokenError extends Error {
  override name = "OAuthTokenError";
  constructor(
    /** The HTTP status, or null when the response itself was unusable. */
    readonly status: number | null,
    /** The OAuth error code, e.g. "invalid_grant". */
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

const base64Url = (bytes: Buffer) => bytes.toString("base64url");

/** A PKCE verifier and its S256 challenge (RFC 7636). */
function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

function renderPage({ title, body }: OAuthPage, detail?: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;color:#1f2937;background:#f3f4f6;margin:0;display:grid;place-items:center;min-height:100vh}main{background:#fff;border-radius:9px;padding:2rem;max-width:28rem;box-shadow:0 1px 3px #0002}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0}small{display:block;margin-top:1rem;color:#6b7280;word-break:break-word}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${
    detail ? `<small>${escapeHtml(detail)}</small>` : ""
  }</main></body></html>`;
}

/** Resolves once the page has been handed to the OS, so closing the server can't cut it off. */
function sendPage(response: ServerResponse, status: number, html: string): Promise<void> {
  return new Promise((resolve) => {
    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      connection: "close",
    });
    response.end(html, () => resolve());
  });
}

export const nonEmptyText = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : null;

async function readJsonBody(response: Response): Promise<{ raw: string; body: unknown }> {
  const raw = await response.text();
  try {
    return { raw, body: JSON.parse(raw) };
  } catch {
    return { raw, body: undefined };
  }
}

function tokenRefusal(response: Response, raw: string, body: unknown, action: string) {
  const code = isRecord(body) ? nonEmptyText(body.error) : null;
  const description = isRecord(body) ? nonEmptyText(body.error_description) : null;
  return new OAuthTokenError(
    response.status,
    code,
    `The ${action} was refused (${response.status}): ${description ?? code ?? (raw.slice(0, 200) || response.statusText)}`,
  );
}

function tokensOf(body: Record<string, unknown>, accessToken: string): OAuthTokens {
  return {
    accessToken,
    refreshToken: nonEmptyText(body.refresh_token),
    idToken: nonEmptyText(body.id_token),
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : null,
    scope: nonEmptyText(body.scope),
    account: {
      email: isRecord(body.account) ? nonEmptyText(body.account.email_address) : null,
      organization: isRecord(body.organization) ? nonEmptyText(body.organization.name) : null,
    },
  };
}

async function readTokenResponse(response: Response, action: string): Promise<OAuthTokens> {
  const { raw, body } = await readJsonBody(response);
  // GitHub refuses with 200 and an `error`.
  if (!response.ok || (isRecord(body) && nonEmptyText(body.error))) {
    throw tokenRefusal(response, raw, body, action);
  }
  const accessToken = isRecord(body) ? nonEmptyText(body.access_token) : null;
  if (!isRecord(body) || !accessToken) {
    throw new OAuthTokenError(null, null, `The ${action} response has no access token.`);
  }
  return tokensOf(body, accessToken);
}

async function postToken(
  fetcher: typeof globalThis.fetch,
  url: string,
  params: Record<string, string>,
  format: TokenRequestFormat,
  signal?: AbortSignal,
  headers?: Readonly<Record<string, string>>,
): Promise<Response> {
  return fetcher(url, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": format === "json" ? "application/json" : "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: format === "json" ? JSON.stringify(params) : new URLSearchParams(params),
    // A redirect would carry the code, a refresh token or a verifier to another address.
    redirect: "error",
    ...(signal ? { signal } : {}),
  });
}

/** Trades a refresh token for new tokens (RFC 6749 §6). Network failures reject as fetch does. */
export async function refreshOAuthTokens(options: {
  tokenUrl: string;
  clientId: string;
  refreshToken: string;
  scope?: string;
  params?: Readonly<Record<string, string>>;
  format?: TokenRequestFormat;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<OAuthTokens> {
  const response = await postToken(
    options.fetch ?? globalThis.fetch,
    options.tokenUrl,
    {
      ...options.params,
      grant_type: "refresh_token",
      client_id: options.clientId,
      refresh_token: options.refreshToken,
      ...(options.scope ? { scope: options.scope } : {}),
    },
    options.format ?? "form",
    options.signal,
  );
  return readTokenResponse(response, "token refresh");
}

/**
 * Ends a sign-in's renewable session at the server (RFC 7009): the token
 * stops working there. Resolves when the server confirms (HTTP 200, which it
 * also answers for a token that was already invalid); rejects with
 * `OAuthTokenError` when it refuses, and as fetch does when it can't be reached.
 */
export async function revokeOAuthToken(options: {
  revokeUrl: string;
  clientId: string;
  token: string;
  tokenTypeHint: "refresh_token" | "access_token";
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<void> {
  const response = await postToken(
    options.fetch ?? globalThis.fetch,
    options.revokeUrl,
    {
      token: options.token,
      token_type_hint: options.tokenTypeHint,
      client_id: options.clientId,
    },
    "form",
    options.signal,
  );
  if (response.status === 200) {
    await response.body?.cancel();
    return;
  }
  const raw = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = undefined;
  }
  const code = isRecord(body) ? nonEmptyText(body.error) : null;
  throw new OAuthTokenError(
    response.status,
    code,
    `The sign-out was refused (${response.status}): ${code ?? (raw.slice(0, 200) || response.statusText)}`,
  );
}

/** What the browser brought back, for the caller to check and use. */
export interface RedirectReceipt<T> {
  /**
   * Checks the authorization response before anything in it is acted on, e.g.
   * its `iss` (RFC 9207). Throwing fails the sign-in with the thrown error, and
   * the tab shows that error's message, never what the response said.
   */
  verify?(params: URLSearchParams): void;
  /** Exchanges the authorization code for tokens. The tab then says how it went. */
  exchange(code: string, params: URLSearchParams): Promise<T>;
}

/** What became of an address pasted from the browser (see `SignInRedirect.paste`). */
export type PastedRedirect =
  /** It is this sign-in's redirect: `receive` goes on with it. */
  | "accepted"
  /** It isn't a redirect to this sign-in's address with a code and a `state`. */
  | "not-redirect"
  /** It is a redirect, but for another sign-in. */
  | "wrong-state"
  /** A redirect already came back, or the sign-in ended. */
  | "finished";

/**
 * A redirect waiting for the browser. It answers only a redirect to its
 * address that carries its `state`; anything else is refused, and it keeps
 * waiting. The first such redirect, from the browser or pasted, is held until
 * `receive` deals with it.
 */
export interface SignInRedirect {
  /** e.g. "http://127.0.0.1:53124/callback", for the authorization request. */
  readonly redirectUri: string;
  /** The `state` the authorization request carries and the redirect must bring back. */
  readonly state: string;
  /**
   * Waits for the redirect, checks it, exchanges its code, and shows the tab
   * a page saying how it went. Rejects with `OAuthFlowError` when the User
   * declined, nothing came back in time, or the sign-in was cancelled, and
   * with whatever `verify` or `exchange` threw.
   */
  receive<T>(receipt: RedirectReceipt<T>): Promise<T>;
  /**
   * The browser's address, or a server page's "code#state", checked exactly
   * as the browser's own request; only surrounding whitespace and one pair of
   * quotes are ignored. A refused one changes nothing.
   */
  paste(text: string): PastedRedirect;
  /** Stops waiting and frees the port. Safe to call more than once. */
  close(): Promise<void>;
}

interface Arrival {
  params: URLSearchParams;
  /** The browser's request, to answer with a page; none for a pasted address. */
  response: ServerResponse | null;
}

const QUOTE_PAIRS = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
] as const;

/** The URL parser alone would also drop tabs and line breaks inside the address. */
function unquoted(text: string): string | null {
  let pasted = text.trim();
  const quoted = QUOTE_PAIRS.some(
    ([open, close]) => pasted.length > 1 && pasted.startsWith(open) && pasted.endsWith(close),
  );
  if (quoted) pasted = pasted.slice(1, -1);
  return pasted === "" || /\s/.test(pasted) ? null : pasted;
}

function pastedUrl(pasted: string): URL | null {
  try {
    return new URL(pasted);
  } catch {
    return null;
  }
}

/** "code#state", as a server's page shows the code to copy, as the redirect it stands for. */
function pastedCode(pasted: string, redirectUri: string): URL | null {
  const found = /^([^#]+)#([^#]+)$/.exec(pasted);
  if (!found?.[1] || !found[2]) return null;
  const url = new URL(redirectUri);
  url.searchParams.set("code", found[1]);
  url.searchParams.set("state", found[2]);
  return url;
}

interface RedirectWait {
  redirect: SignInRedirect;
  /** The one check for a redirect, from the browser or pasted: the first that passes is taken. */
  claim(url: URL): PastedRedirect;
  arrive(arrival: Arrival): void;
  fail(error: Error): void;
}

/** What a redirect is however the browser comes back; `release` frees what the caller holds. */
function waitForRedirect(options: {
  redirectUri: string;
  pages: { success: OAuthPage; failure: OAuthPage };
  /** Also take "code#state" pasted from a server's own page. */
  acceptsCode: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  stateBytes?: number;
  release(): Promise<void>;
}): RedirectWait {
  const { signal, redirectUri } = options;
  const state = base64Url(randomBytes(options.stateBytes ?? 24));
  const redirect = new URL(redirectUri);

  let arrive!: (arrival: Arrival) => void;
  let fail!: (error: Error) => void;
  const arrived = new Promise<Arrival>((resolve, reject) => {
    arrive = resolve;
    fail = reject;
  });
  // A failure before anyone awaits (e.g. a timeout before `receive`) must not go unhandled.
  arrived.catch(() => undefined);

  let waiting = true;
  const failurePage = (detail: string) => renderPage(options.pages.failure, detail);

  const claim = (url: URL): PastedRedirect => {
    if (url.origin !== redirect.origin || url.pathname !== redirect.pathname) {
      return "not-redirect";
    }
    // A redirect that didn't come from this sign-in: refuse it and keep waiting.
    if (url.searchParams.get("state") !== state) return "wrong-state";
    if (!waiting) return "finished";
    waiting = false;
    return "accepted";
  };

  const end = (error: OAuthFlowError) => {
    waiting = false;
    fail(error);
  };
  const timer = setTimeout(
    () => end(new OAuthFlowError("timed-out", "The sign-in didn't finish in time.")),
    options.timeoutMs ?? DEFAULT_SIGN_IN_TIMEOUT_MS,
  );
  const onAbort = () => end(new OAuthFlowError("cancelled", "The sign-in was cancelled."));
  signal?.addEventListener("abort", onAbort, { once: true });
  // Cancelled while the caller was getting ready: the listener above came too late to hear it.
  if (signal?.aborted) onAbort();

  let closing: Promise<void> | null = null;
  return {
    claim,
    arrive,
    fail,
    redirect: {
      redirectUri,
      state,

      async receive<T>(receipt: RedirectReceipt<T>): Promise<T> {
        const { params, response } = await arrived;
        const answer = async (status: number, html: string) => {
          if (response) await sendPage(response, status, html);
        };
        try {
          receipt.verify?.(params);
        } catch (failure) {
          const reason = failure instanceof Error ? failure : new Error(String(failure));
          await answer(400, failurePage(reason.message));
          throw reason;
        }
        const error = params.get("error");
        if (error) {
          const description = params.get("error_description") ?? error;
          await answer(400, failurePage(description));
          throw new OAuthFlowError("denied", `The sign-in was refused: ${description}`);
        }
        const code = params.get("code");
        if (!code) {
          await answer(400, failurePage("No authorization code came back."));
          throw new OAuthFlowError("denied", "The sign-in returned no authorization code.");
        }
        try {
          const value = await receipt.exchange(code, params);
          await answer(200, renderPage(options.pages.success));
          return value;
        } catch (failure) {
          const reason = failure instanceof Error ? failure : new Error(String(failure));
          await answer(502, failurePage(reason.message));
          throw reason;
        }
      },

      paste(text) {
        const pasted = unquoted(text);
        const url =
          pasted === null
            ? null
            : (pastedUrl(pasted) ?? (options.acceptsCode ? pastedCode(pasted, redirectUri) : null));
        if (!url?.searchParams.get("code") || !url.searchParams.get("state")) return "not-redirect";
        const claimed = claim(url);
        if (claimed === "accepted") arrive({ params: url.searchParams, response: null });
        return claimed;
      },

      close() {
        closing ??= (async () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          end(new OAuthFlowError("cancelled", "The sign-in was cancelled."));
          await options.release();
        })();
        return closing;
      },
    },
  };
}

/** Rejects with "port-in-use" when the port is taken. The timeout runs from now; always `close` it. */
export async function openLoopbackRedirect(
  options: LoopbackRedirectOptions,
): Promise<SignInRedirect> {
  if (options.signal?.aborted) throw new OAuthFlowError("cancelled", "The sign-in was cancelled.");

  let wait: RedirectWait | null = null;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = wait && new URL(request.url ?? "/", wait.redirect.redirectUri);
    const claimed = wait && url && request.method === "GET" ? wait.claim(url) : "not-redirect";
    if (!wait || !url || claimed === "not-redirect") {
      response.writeHead(404, { connection: "close" }).end();
      return;
    }
    const failurePage = (detail: string) => renderPage(options.pages.failure, detail);
    if (claimed === "wrong-state") {
      await sendPage(response, 400, failurePage("The sign-in state didn't match."));
      return;
    }
    if (claimed === "finished") {
      await sendPage(response, 409, failurePage("This sign-in already finished."));
      return;
    }
    // The tab waits for its page until `receive` has dealt with the redirect.
    wait.arrive({ params: url.searchParams, response });
  };

  const serve = () =>
    createServer((request, response) => {
      handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) response.writeHead(500, { connection: "close" }).end();
        wait?.fail(error instanceof Error ? error : new Error(String(error)));
      });
    });
  const server = serve();

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new OAuthFlowError(
              "port-in-use",
              `Port ${options.port} on this computer is in use by another program, so the sign-in can't receive its answer.`,
            )
          : error,
      );
    });
    server.listen(options.port, LOOPBACK_HOST, () => resolve());
  });

  const { port } = server.address() as AddressInfo;
  // "localhost" may reach this computer as ::1 first: listen there on the same port too, where
  // the computer has IPv6. Without it, the browser goes on to 127.0.0.1.
  const servers = [server];
  if (options.host === "localhost") {
    const v6 = serve();
    const listening = await new Promise<boolean>((resolve) => {
      v6.once("error", () => resolve(false));
      v6.listen(port, "::1", () => resolve(true));
    });
    if (listening) servers.push(v6);
  }
  const opened = waitForRedirect({
    redirectUri: `http://${options.host ?? LOOPBACK_HOST}:${port}${options.path}`,
    pages: options.pages,
    acceptsCode: false,
    ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
    ...(options.signal && { signal: options.signal }),
    ...(options.stateBytes !== undefined && { stateBytes: options.stateBytes }),
    // Pages are sent with "connection: close"; drop anything still open so the port is free now.
    release: () =>
      Promise.all(
        servers.map(
          (each) =>
            new Promise<void>((resolve) => {
              each.close(() => resolve());
              each.closeAllConnections();
            }),
        ),
      ).then(() => undefined),
  });
  wait = opened;
  for (const each of servers) each.on("error", (error) => opened.fail(error));
  return opened.redirect;
}

/** Rejects with `OAuthFlowError` or `OAuthTokenError`. */
export async function authorizeInBrowser(
  options: BrowserAuthorizationOptions,
): Promise<OAuthTokens> {
  const { signal } = options;
  const fetcher = options.fetch ?? globalThis.fetch;
  const pkce = createPkcePair();
  const redirect =
    options.redirect.kind === "loopback"
      ? await openLoopbackRedirect({
          port: options.redirect.port,
          path: options.redirect.path,
          ...(options.redirect.host && { host: options.redirect.host }),
          pages: options.pages,
          ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
          ...(signal && { signal }),
          ...(options.stateBytes !== undefined && { stateBytes: options.stateBytes }),
        })
      : waitForRedirect({
          redirectUri: options.redirect.uri,
          pages: options.pages,
          acceptsCode: true,
          ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
          ...(signal && { signal }),
          ...(options.stateBytes !== undefined && { stateBytes: options.stateBytes }),
          release: async () => {},
        }).redirect;
  try {
    if (!signal?.aborted) {
      const authorize = new URL(options.authorizeUrl);
      // The extra parameters go first, so they can't replace the state or the PKCE challenge.
      const params: Record<string, string> = {
        ...options.authorizeParams,
        response_type: "code",
        client_id: options.clientId,
        redirect_uri: redirect.redirectUri,
        ...(options.scope ? { scope: options.scope } : {}),
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        state: redirect.state,
      };
      for (const [name, value] of Object.entries(params)) authorize.searchParams.set(name, value);
      await options.openBrowser(authorize.href);
      options.onWaiting?.((pasted) => redirect.paste(pasted));
    }
    return await redirect.receive({
      ...(options.verify && { verify: options.verify }),
      async exchange(code, params) {
        const response = await postToken(
          fetcher,
          options.tokenUrl,
          {
            ...options.tokenParams,
            grant_type: "authorization_code",
            client_id: options.exchangeClientId?.(params) ?? options.clientId,
            code,
            ...(options.stateInExchange && { state: redirect.state }),
            redirect_uri: redirect.redirectUri,
            code_verifier: pkce.verifier,
          },
          options.tokenFormat ?? "form",
          signal,
        );
        return readTokenResponse(response, "sign-in");
      },
    });
  } finally {
    await redirect.close();
  }
}

/** What the User is shown to approve a device sign-in (RFC 8628 §3.2). */
export interface DeviceCode {
  /** The code the User types on the verification page. */
  userCode: string;
  verificationUri: string;
  /** Seconds until the code expires. */
  expiresIn: number;
}

export interface DeviceAuthorizationOptions {
  deviceCodeUrl: string;
  tokenUrl: string;
  clientId: string;
  /** Space-separated scopes, if the server wants them. */
  scope?: string;
  /** How the server takes a request. Defaults to a form (RFC 8628). */
  format?: TokenRequestFormat;
  headers?: Readonly<Record<string, string>>;
  /** The code to show the User, before the browser opens its verification page. */
  onCode(code: DeviceCode): void;
  openBrowser(url: string): Promise<void>;
  signal?: AbortSignal;
  /** Waits before each poll; rejects when `signal` aborts. Tests pass one that doesn't wait. */
  wait?(ms: number, signal?: AbortSignal): Promise<void>;
  fetch?: typeof globalThis.fetch;
}

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** RFC 8628 §3.2: poll every five seconds when the server doesn't say. */
const DEFAULT_POLL_INTERVAL_S = 5;

/** RFC 8628 §3.5: a `slow_down` adds five seconds to every later poll. */
const SLOW_DOWN_S = 5;

const cancelledError = () => new OAuthFlowError("cancelled", "The sign-in was cancelled.");

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Rejects with `OAuthFlowError` when the User declines ("denied"), the code
 * expires ("timed-out") or the caller aborts ("cancelled"), else `OAuthTokenError`.
 */
export async function authorizeWithDevice(
  options: DeviceAuthorizationOptions,
): Promise<OAuthTokens> {
  const { signal } = options;
  const fetcher = options.fetch ?? globalThis.fetch;
  const wait = options.wait ?? waitFor;
  const format = options.format ?? "form";
  const post = async (url: string, params: Record<string, string>) => {
    try {
      const response = await postToken(fetcher, url, params, format, signal, options.headers);
      return { response, ...(await readJsonBody(response)) };
    } catch (error) {
      // Cancelling during a request aborts it: the sign-in was cancelled, it didn't fail.
      if (signal?.aborted) throw cancelledError();
      throw error;
    }
  };
  if (signal?.aborted) throw cancelledError();

  const {
    response: started,
    raw,
    body,
  } = await post(options.deviceCodeUrl, {
    client_id: options.clientId,
    ...(options.scope ? { scope: options.scope } : {}),
  });
  const deviceCode = isRecord(body) ? nonEmptyText(body.device_code) : null;
  const userCode = isRecord(body) ? nonEmptyText(body.user_code) : null;
  const verificationUri = isRecord(body) ? nonEmptyText(body.verification_uri) : null;
  if (!started.ok || !isRecord(body) || !deviceCode || !userCode || !verificationUri) {
    throw tokenRefusal(started, raw, body, "device sign-in");
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 900;
  let interval =
    (typeof body.interval === "number" ? body.interval : DEFAULT_POLL_INTERVAL_S) * 1000;
  options.onCode({ userCode, verificationUri, expiresIn });
  await options.openBrowser(nonEmptyText(body.verification_uri_complete) ?? verificationUri);

  // Counted in the intervals waited: the server's own `expired_token` ends a longer wait anyway.
  let waited = 0;
  for (;;) {
    if (waited >= expiresIn * 1000) {
      throw new OAuthFlowError("timed-out", "The sign-in didn't finish in time.");
    }
    await wait(interval, signal);
    waited += interval;
    if (signal?.aborted) throw cancelledError();
    const answer = await post(options.tokenUrl, {
      client_id: options.clientId,
      device_code: deviceCode,
      grant_type: DEVICE_GRANT,
    });
    const polled = answer.response;
    const error = isRecord(answer.body) ? nonEmptyText(answer.body.error) : null;
    const accessToken = isRecord(answer.body) ? nonEmptyText(answer.body.access_token) : null;
    if (polled.ok && !error && isRecord(answer.body) && accessToken) {
      return tokensOf(answer.body, accessToken);
    }
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      const next = isRecord(answer.body) ? answer.body.interval : undefined;
      interval = typeof next === "number" ? next * 1000 : interval + SLOW_DOWN_S * 1000;
      continue;
    }
    // GitHub names an expired code both ways.
    if (error === "expired_token" || error === "token_expired") {
      throw new OAuthFlowError("timed-out", "The sign-in code expired.");
    }
    if (error === "access_denied") {
      throw new OAuthFlowError("denied", "The sign-in was refused.");
    }
    throw tokenRefusal(polled, answer.raw, answer.body, "device sign-in");
  }
}
