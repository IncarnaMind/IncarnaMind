/**
 * Remote Connectors: MCP servers reached by URL over Streamable HTTP, with
 * the official SDK's client transport, signing in with OAuth when the server
 * requires it (see ./auth for where the sign-in is kept).
 *
 * Signing in follows the MCP authorization spec: the SDK discovers the
 * server's authorization server (protected-resource metadata, then
 * authorization-server metadata), registers IncarnaMind if it has to, and
 * builds the authorization request with PKCE and the `resource` indicator.
 * The User signs in in their browser, which comes back to a one-off loopback
 * redirect on 127.0.0.1 (../oauth), and the SDK exchanges the code.
 */
import type { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Browser } from "../adapters";
import type { ConnectorError, ConnectorSignInError, ExternalService } from "../api";
import { SecretStorageError } from "../errors";
import {
  OAuthFlowError,
  type OAuthPage,
  openLoopbackRedirect,
  type SignInRedirect,
} from "../oauth";
import {
  ClientIdRequiredError,
  type ConnectorAuth,
  causedBy,
  HeldBackError,
  IssuerMismatchError,
  RefreshFailedError,
  SignInRequiredError,
} from "./auth";

/** The loopback redirect's path: http://127.0.0.1:<port>/callback. */
const CALLBACK_PATH = "/callback";

/** Consent is per server origin: two Connectors on one server are one service. */
export function remoteService(url: string): ExternalService {
  const { origin, host } = new URL(url);
  return { id: origin, name: host };
}

/** The MCP SDK, once a connection or sign-in has loaded it (see ./sdk). */
let sdk: typeof import("./sdk") | null = null;

async function loadSdk(): Promise<typeof import("./sdk")> {
  sdk ??= await import("./sdk");
  return sdk;
}

/** A transport to the server that signs its requests with the stored tokens, renewing them as needed. */
export async function remoteTransport(
  url: string,
  auth: ConnectorAuth,
  options: {
    connection: "http" | "sse";
    headers: Record<string, string>;
    fetch: FetchLike;
  },
): Promise<StreamableHTTPClientTransport | SSEClientTransport> {
  const { StreamableHTTPClientTransport, SSEClientTransport } = await loadSdk();
  const settings = {
    ...(Object.keys(options.headers).length === 0 ? { authProvider: auth.provider(null) } : {}),
    fetch: options.fetch,
  };
  return options.connection === "sse"
    ? new SSEClientTransport(new URL(url), settings)
    : new StreamableHTTPClientTransport(new URL(url), settings);
}

export class OpeningRejectedError extends Error {
  override name = "OpeningRejectedError";
}

export class KeyRefusedError extends Error {
  override name = "KeyRefusedError";
}

export function connectionFetch(options: {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  fetch: FetchLike;
  check(): void;
  opening: boolean;
  onKeyRefused?(): void;
}): FetchLike {
  const origin = new URL(options.url).origin;
  const headerSignIn = Object.keys(options.headers).length > 0;
  let opening = options.opening;
  return async (input, init) => {
    options.check();
    options.signal.throwIfAborted();
    const url = new URL(String(input));
    if (headerSignIn && url.origin !== origin)
      throw new Error("The Connector tried to use another server.");
    const headers = new Headers();
    new Headers(init?.headers).forEach((value, name) => {
      headers.set(name, value);
    });
    for (const [name, value] of Object.entries(options.headers)) headers.set(name, value);
    const isOpening = opening && init?.method === "POST";
    if (isOpening) opening = false;
    const response = await options.fetch(input, {
      ...init,
      headers,
      ...(headerSignIn ? { redirect: "manual" as const } : {}),
      signal: init?.signal ? AbortSignal.any([options.signal, init.signal]) : options.signal,
    });
    if (
      Object.keys(options.headers).length > 0 &&
      (response.status === 401 || response.status === 403)
    ) {
      options.onKeyRefused?.();
      await response.body?.cancel();
      throw new KeyRefusedError("The server refused this key.");
    }
    if (isOpening && (response.status === 404 || response.status === 405)) {
      await response.body?.cancel();
      throw new OpeningRejectedError("The server needs the older connection.");
    }
    return response;
  };
}

/** The connection needs the User to sign in: the server wants one, and there is none to use. */
export const needsSignIn = (error: unknown) => causedBy(error, SignInRequiredError) !== null;

/** Codes Node's fetch gives (as the cause of "fetch failed") when nothing answers. */
const UNREACHABLE = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function unreachable(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && UNREACHABLE.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return error instanceof TypeError && /fetch failed/i.test(error.message);
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Why connecting to a remote server failed, in terms the User can act on. */
export function remoteError(error: unknown): ConnectorError {
  const base = { command: null, install: null, retrying: false };
  if (causedBy(error, KeyRefusedError)) {
    return { ...base, kind: "key-refused", message: "The server refused this key." };
  }
  const issuer = causedBy(error, IssuerMismatchError);
  if (issuer) return { ...base, kind: "failed", message: issuer.message };
  const refresh = causedBy(error, RefreshFailedError);
  if (refresh) return { ...base, kind: "failed", message: "The sign-in could not be renewed." };
  if (unreachable(error)) {
    return {
      ...base,
      kind: "unreachable",
      message: "The server could not be reached.",
    };
  }
  const message = messageOf(error);
  // The SDK's errors come from a connection, which loaded it.
  if (sdk && error instanceof sdk.StreamableHTTPError) {
    return { ...base, kind: "failed", message: `The server answered ${error.code}.` };
  }
  return {
    ...base,
    kind: /timed out|timeout/i.test(message) ? "timed-out" : "failed",
    message: "The connection failed.",
  };
}

/** Why a sign-in didn't work, for the User. */
export function signInError(error: unknown): ConnectorSignInError {
  const message = messageOf(error);
  const flow = causedBy(error, OAuthFlowError);
  if (flow) return { kind: flow.reason, message: flow.message };
  if (causedBy(error, HeldBackError)) return { kind: "held-back", message };
  if (causedBy(error, ClientIdRequiredError)) return { kind: "client-id-required", message };
  // The SDK's own words, when the service has no metadata to say it can't register clients.
  if (/does not support dynamic client registration/i.test(message)) {
    return { kind: "client-id-required", message };
  }
  if (causedBy(error, SecretStorageError)) return { kind: "secret-storage", message };
  return { kind: "failed", message };
}

export interface RemoteSignInOptions {
  url: string;
  connection?: "http" | "sse";
  auth: ConnectorAuth;
  browser: Browser;
  pages: { success: OAuthPage; failure: OAuthPage };
  /** How long the User has to finish in the browser. */
  timeoutMs: number;
  /** How long the server and its authorization server have to answer each step. */
  requestTimeoutMs: number;
  signal: AbortSignal;
  clientInfo: { name: string; version: string };
}

/** The loopback redirect, on the port the last sign-in used if it is free, else on any free one. */
async function openRedirect(options: RemoteSignInOptions): Promise<SignInRedirect> {
  const base = {
    path: CALLBACK_PATH,
    pages: options.pages,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  };
  const preferred = options.auth.preferredPort();
  if (preferred) {
    try {
      return await openLoopbackRedirect({ ...base, port: preferred });
    } catch (error) {
      if (!(error instanceof OAuthFlowError && error.reason === "port-in-use")) throw error;
    }
  }
  return openLoopbackRedirect({ ...base, port: 0 });
}

/**
 * Signs in to a remote server: connects as the User would, and when the
 * server answers that it requires a sign-in, the SDK discovers its
 * authorization server, registers IncarnaMind if needed and opens the
 * authorization request in the browser. The loopback redirect then hands the
 * code to the SDK to exchange. Resolves once the tokens are stored, or at
 * once if the server let IncarnaMind in without a new sign-in. Rejects with
 * `OAuthFlowError`, `ClientIdRequiredError`, or the SDK's errors.
 */
export async function signInRemote(options: RemoteSignInOptions): Promise<void> {
  await options.auth.load();
  const redirect = await openRedirect(options);
  try {
    const provider = options.auth.provider({
      redirectUrl: redirect.redirectUri,
      state: redirect.state,
      openBrowser: (url) => options.browser.open(url),
    });
    const { StreamableHTTPClientTransport, SSEClientTransport, Client } = await loadSdk();
    const RemoteTransport =
      options.connection === "sse" ? SSEClientTransport : StreamableHTTPClientTransport;
    const transport = new RemoteTransport(new URL(options.url), {
      authProvider: provider,
      fetch: options.auth.fetch,
    });
    const client = new Client(options.clientInfo, { capabilities: {} });
    client.onerror = () => undefined;
    try {
      await client.connect(transport, {
        timeout: options.requestTimeoutMs,
        signal: options.signal,
      });
      // In without the browser: the server needs no sign-in, or the stored one was renewed.
      return;
    } catch (error) {
      // It failed before the browser opened, e.g. discovering or registering.
      if (!provider.redirected) throw error;
    } finally {
      await client.close().catch(() => undefined);
    }
    await redirect.receive({
      verify: (params) => provider.verifyIssuer(params),
      exchange: (code) => transport.finishAuth(code),
    });
    await options.auth.rememberRedirect(redirect.redirectUri);
  } finally {
    await redirect.close();
  }
}
