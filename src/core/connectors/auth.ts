/**
 * A remote Connector's sign-in, as the MCP SDK's `OAuthClientProvider`: the
 * SDK does the protocol (protected-resource and authorization-server
 * discovery, dynamic client registration, PKCE, the token requests and
 * refreshing them), and this keeps what it produces in the secret store,
 * never in SQLite (ADR-0003):
 *
 * - `connector:<id>:oauth-tokens`: the access and refresh tokens, with when
 *   the access token expires; or, after renewing them failed, a marker that
 *   the sign-in expired, so the Connector asks the User to sign in again.
 * - `connector:<id>:oauth-client`: the registration IncarnaMind made with the
 *   authorization server (its client ID, and secret if it got one), or the
 *   secret of an OAuth app the User entered, and the redirect URI last used.
 *
 * A provider is either interactive (a sign-in the User started, with a
 * loopback redirect waiting for the browser) or not (connecting in the
 * background). A background one never registers a client or opens the
 * browser: where the SDK would, it throws `SignInRequiredError` instead, and
 * the Connector waits for the User.
 *
 * Beyond what the SDK does, it also follows the MCP authorization spec
 * (2026-07-28) where the SDK doesn't yet:
 * - the authorization server's metadata must name the issuer it was fetched for;
 * - the `resource` parameter goes in every authorization and token request,
 *   even to a server without protected-resource metadata;
 * - the browser's answer is checked against the expected issuer (RFC 9207);
 * - a dynamic registration says it is a native app.
 */
import { randomBytes } from "node:crypto";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isRecord } from "../errors";
import type { Secrets } from "../secrets";

const tokensSecret = (connectorId: string) => `connector:${connectorId}:oauth-tokens`;
export const clientSecret = (connectorId: string) => `connector:${connectorId}:oauth-client`;

/** Renew an access token this long before it expires. */
const REFRESH_WINDOW_MS = 60_000;
/** How long a refresh's answer is shared with requests that started from the same refresh token. */
const SHARED_REFRESH_MS = 30_000;
/** What a background provider gives as its redirect URI, which it never uses. */
const UNUSED_REDIRECT = "http://127.0.0.1/callback";

const CLIENT_NAME = "IncarnaMind";
const CLIENT_URI = "https://github.com/IncarnaMind/IncarnaMind";

/** The server requires a sign-in that IncarnaMind doesn't have on this device. */
export class SignInRequiredError extends Error {
  override name = "SignInRequiredError";
}

/** The service can't register IncarnaMind by itself, and the User hasn't entered a client ID. */
export class ClientIdRequiredError extends Error {
  override name = "ClientIdRequiredError";
}

/** Renewing the sign-in failed in a way that may pass, e.g. the network: the tokens are kept. */
export class RefreshFailedError extends Error {
  override name = "RefreshFailedError";
}

/** Local mode is on and the sign-in's server is on another computer: nothing was sent, and the tokens are kept. */
export class HeldBackError extends Error {
  override name = "HeldBackError";
}

const HELD_BACK = "Everything stays on this computer, so nothing is sent.";

/** Whether `error`, or what caused it, is `type`: the SDK sometimes passes errors on wrapped. */
export function causedBy<T extends Error>(
  error: unknown,
  type: abstract new (...args: never[]) => T,
): T | null {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    if (current instanceof type) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

interface StoredTokens {
  /** As the SDK saved them, stamped with the issuer they came from. */
  tokens: OAuthTokens;
  /** When the access token expires, in milliseconds since the epoch; null if the server didn't say. */
  expiresAt: number | null;
}

/** The tokens secret: the tokens, or the marker that renewing them failed. */
type TokenRecord = StoredTokens | { expired: true };

interface ClientRecord {
  /** The registration IncarnaMind made itself, as the SDK saved it (with its issuer). */
  registered?: OAuthClientInformationMixed;
  /** The secret of the OAuth app the User entered, if it has one. */
  manualSecret?: string;
  /** The authorization server the User's OAuth app was first used with. */
  manualIssuer?: string;
  /** The redirect URI of the registration, or of the last sign-in: the next one tries its port first. */
  redirectUri?: string;
}

/** The client secret, as first stored for an OAuth app the User entered with a new Connector. */
export const manualClientRecord = (secret: string): string =>
  JSON.stringify({ manualSecret: secret } satisfies ClientRecord);

const hasTokens = (record: TokenRecord | null): record is StoredTokens =>
  record !== null && "tokens" in record;

function parseTokens(raw: string | null): TokenRecord | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return null;
    if (value.expired === true) return { expired: true };
    const tokens = value.tokens;
    if (!isRecord(tokens) || typeof tokens.access_token !== "string") return null;
    return {
      tokens: tokens as OAuthTokens,
      expiresAt: typeof value.expiresAt === "number" ? value.expiresAt : null,
    };
  } catch {
    return null;
  }
}

function parseClient(raw: string | null): ClientRecord {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? (value as ClientRecord) : {};
  } catch {
    return {};
  }
}

/**
 * The canonical URI of an MCP server, as the `resource` parameter names it:
 * without a fragment, and without the "/" a URL gets when it has no path.
 */
function canonicalResource(serverUrl: string | URL): string {
  const url = new URL(serverUrl);
  url.hash = "";
  const href = url.href;
  return url.pathname === "/" && !url.search && href.endsWith("/") ? href.slice(0, -1) : href;
}

/**
 * A resource indicator the SDK sends exactly as written: it sends a URL's
 * `href`, which would add "/" to "https://mcp.example.com" (SDK issue #1968).
 */
function resourceIndicator(text: string): URL {
  const url = new URL(text);
  Object.defineProperty(url, "href", { value: text });
  return url;
}

/** Issuer identifiers, compared as RFC 8414 asks, allowing only for a trailing "/". */
function sameIssuer(a: string, b: string): boolean {
  const trim = (text: string) => (text.endsWith("/") ? text.slice(0, -1) : text);
  return trim(a) === trim(b);
}

/**
 * A fetch that shares one refresh among requests that start from the same
 * refresh token: two Tool calls whose token expired together would otherwise
 * both refresh it, and with rotating refresh tokens the second would fail and
 * sign the User out.
 */
function sharingRefreshes(base: FetchLike): FetchLike {
  interface Answer {
    status: number;
    statusText: string;
    headers: [string, string][];
    body: string;
  }
  const shared = new Map<string, Promise<Answer>>();
  return async (url, init) => {
    const body = init?.body;
    const refreshToken =
      init?.method === "POST" &&
      body instanceof URLSearchParams &&
      body.get("grant_type") === "refresh_token"
        ? body.get("refresh_token")
        : null;
    if (!refreshToken) return base(url, init);
    let answer = shared.get(refreshToken);
    if (!answer) {
      answer = (async () => {
        const response = await base(url, init);
        return {
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers],
          body: await response.text(),
        };
      })();
      shared.set(refreshToken, answer);
      const forget = () => {
        setTimeout(() => shared.delete(refreshToken), SHARED_REFRESH_MS).unref?.();
      };
      answer.then(forget, () => shared.delete(refreshToken));
    }
    const { status, statusText, headers, body: text } = await answer;
    const empty = status === 204 || status === 205 || status === 304;
    return new Response(empty ? null : text, { status, statusText, headers });
  };
}

/** A sign-in the User started: where the browser comes back to, and how to open it. */
export interface InteractiveSignIn {
  redirectUrl: string;
  state: string;
  openBrowser(url: string): Promise<void>;
}

/** A provider for one connection or one sign-in. */
export interface ConnectorAuthProvider extends OAuthClientProvider {
  /** The SDK opened the browser: the sign-in now waits for the User. */
  readonly redirected: boolean;
  /**
   * Checks the browser's answer against the issuer recorded when the
   * authorization request was made (RFC 9207 §2.4). Throws on a mismatch.
   */
  verifyIssuer(params: URLSearchParams): void;
}

export interface ConnectorAuthOptions {
  connectorId: string;
  /** The server's MCP endpoint. */
  url: string;
  secrets: Secrets;
  /** Milliseconds since the epoch. */
  now: () => number;
  /** The client ID of the OAuth app the User entered, or null to register automatically. */
  manualClientId: () => string | null;
  /** The sign-in changed: signed in, renewed, expired or signed out. */
  onChange(): void;
  /** Whether Local mode is on and this address isn't on this computer: no request goes there. */
  heldBack?(url: string): boolean;
  fetch?: FetchLike;
}

export type ConnectorAuth = ReturnType<typeof createConnectorAuth>;

export function createConnectorAuth(options: ConnectorAuthOptions) {
  const { connectorId, secrets, now } = options;
  const send = options.fetch ?? globalThis.fetch;
  /** Requests Local mode stopped: the SDK sometimes swallows the error, so callers count them too. */
  let heldBackRequests = 0;
  const fetch = sharingRefreshes((url, init) => {
    if (!options.heldBack?.(String(url))) return send(url, init);
    heldBackRequests++;
    return Promise.reject(new HeldBackError(HELD_BACK));
  });
  let tokenRecord: TokenRecord | null = null;
  let client: ClientRecord = {};
  let loaded: Promise<void> | null = null;
  let known = false;
  let discovery: OAuthDiscoveryState | undefined;
  let refreshing: Promise<void> | null = null;

  const load = () => {
    loaded ??= (async () => {
      const [tokens, registration] = await Promise.all([
        secrets.tryGet(tokensSecret(connectorId)),
        secrets.tryGet(clientSecret(connectorId)),
      ]);
      tokenRecord = parseTokens(tokens);
      client = parseClient(registration);
      known = true;
    })();
    return loaded;
  };

  const writeTokens = async (record: TokenRecord | null) => {
    tokenRecord = record;
    if (record) await secrets.set(tokensSecret(connectorId), JSON.stringify(record));
    else await secrets.delete(tokensSecret(connectorId));
    options.onChange();
  };

  const writeClient = async (record: ClientRecord) => {
    client = record;
    if (Object.keys(record).length > 0) {
      await secrets.set(clientSecret(connectorId), JSON.stringify(record));
    } else {
      await secrets.delete(clientSecret(connectorId));
    }
  };

  /** The tokens can't be used any more: forget them, and say the sign-in expired. */
  const expire = async () => {
    if (hasTokens(tokenRecord)) await writeTokens({ expired: true });
  };

  const provider = (interactive: InteractiveSignIn | null): ConnectorAuthProvider => {
    let codeVerifier: string | undefined;
    let recordedIssuer: AuthorizationServerMetadata | undefined;
    let redirected = false;
    const redirectUrl = () => interactive?.redirectUrl ?? client.redirectUri ?? UNUSED_REDIRECT;
    const backgroundState = randomBytes(16).toString("base64url");

    return {
      get redirected() {
        return redirected;
      },

      get redirectUrl() {
        return redirectUrl();
      },

      get clientMetadata(): OAuthClientMetadata {
        // `application_type` (OpenID Connect registration) isn't in the SDK's type; it is sent as is.
        const metadata = {
          client_name: CLIENT_NAME,
          client_uri: CLIENT_URI,
          redirect_uris: [redirectUrl()],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          application_type: "native",
        };
        return metadata;
      },

      state: () => interactive?.state ?? backgroundState,

      async clientInformation() {
        await load();
        const manualId = options.manualClientId();
        if (manualId) {
          return {
            client_id: manualId,
            ...(client.manualSecret ? { client_secret: client.manualSecret } : {}),
            ...(client.manualIssuer ? { issuer: client.manualIssuer } : {}),
          };
        }
        const registered = client.registered;
        // A sign-in on another port registers again, for its own redirect URI.
        if (registered && (!interactive || client.redirectUri === interactive.redirectUrl)) {
          return registered;
        }
        if (!interactive) {
          throw new SignInRequiredError("The server requires a sign-in.");
        }
        const metadata = discovery?.authorizationServerMetadata;
        if (metadata && !metadata.registration_endpoint) {
          throw new ClientIdRequiredError(
            "The service can't register IncarnaMind by itself: enter the client ID of an OAuth app you registered with it.",
          );
        }
        return undefined;
      },

      async saveClientInformation(information) {
        await load();
        if (options.manualClientId()) {
          await writeClient({ ...client, manualIssuer: information.issuer });
          return;
        }
        await writeClient({
          ...client,
          registered: information,
          redirectUri: interactive?.redirectUrl ?? client.redirectUri,
        });
      },

      async tokens() {
        await load();
        return hasTokens(tokenRecord) ? tokenRecord.tokens : undefined;
      },

      async saveTokens(tokens) {
        await load();
        const expiresAt = tokens.expires_in !== undefined ? now() + tokens.expires_in * 1000 : null;
        await writeTokens({ tokens, expiresAt });
      },

      async redirectToAuthorization(authorizationUrl) {
        if (!interactive) {
          // Only a sign-in the User starts opens the browser.
          if (hasTokens(tokenRecord) && tokenRecord.tokens.refresh_token) {
            throw new RefreshFailedError(
              "Renewing the sign-in failed. IncarnaMind will try again shortly.",
            );
          }
          await expire();
          throw new SignInRequiredError("The server requires a sign-in.");
        }
        redirected = true;
        await interactive.openBrowser(authorizationUrl.href);
      },

      saveCodeVerifier(verifier) {
        codeVerifier = verifier;
        // The issuer the answer must come from, recorded with the verifier (RFC 9207).
        recordedIssuer = discovery?.authorizationServerMetadata;
      },

      codeVerifier() {
        if (!codeVerifier) throw new Error("No sign-in is under way.");
        return codeVerifier;
      },

      async validateResourceURL(serverUrl, resource) {
        const canonical = canonicalResource(serverUrl);
        if (resource === undefined) return resourceIndicator(canonical);
        if (!checkResourceAllowed({ requestedResource: canonical, configuredResource: resource })) {
          throw new Error(
            `The server's metadata describes another resource (${resource}), not ${canonical}.`,
          );
        }
        return resourceIndicator(resource);
      },

      async invalidateCredentials(scope) {
        await load();
        if (scope === "all" || scope === "client") {
          const { manualSecret, redirectUri } = client;
          await writeClient({
            ...(manualSecret ? { manualSecret } : {}),
            ...(redirectUri ? { redirectUri } : {}),
          });
        }
        if (scope === "all" || scope === "tokens") await expire();
        if (scope === "all" || scope === "verifier") codeVerifier = undefined;
        if (scope === "all" || scope === "discovery") discovery = undefined;
      },

      saveDiscoveryState(state) {
        const metadata = state.authorizationServerMetadata;
        if (metadata && !sameIssuer(metadata.issuer, state.authorizationServerUrl)) {
          discovery = undefined;
          throw new Error(
            `The authorization server's metadata names another issuer (${metadata.issuer}) than ${state.authorizationServerUrl}, so IncarnaMind won't use it.`,
          );
        }
        discovery = state;
      },

      discoveryState: () => discovery,

      verifyIssuer(params) {
        const metadata = recordedIssuer;
        if (!metadata) return;
        const iss = params.get("iss");
        if (iss === null) {
          // RFC 9207's flag; the SDK's metadata type doesn't name it, but keeps it.
          const advertised: unknown = (metadata as Record<string, unknown>)
            .authorization_response_iss_parameter_supported;
          if (advertised === true) {
            throw new Error("The sign-in's answer didn't say which server sent it.");
          }
          return;
        }
        if (iss !== metadata.issuer) {
          throw new Error(
            "The sign-in's answer came from another server than the one IncarnaMind asked.",
          );
        }
      },
    };
  };

  return {
    fetch,
    provider,
    load,

    /** What is known of the sign-in without waiting: false until the keychain has been read. */
    status(): { signedIn: boolean; expired: boolean } {
      if (!known) return { signedIn: false, expired: false };
      return {
        signedIn: hasTokens(tokenRecord),
        expired: tokenRecord !== null && !hasTokens(tokenRecord),
      };
    },

    /** The authorization server the server named, once discovered; null before. */
    authorizationServer(): string | null {
      return discovery?.authorizationServerUrl ?? null;
    },

    /** The port the last sign-in used: trying it first keeps a registration's redirect URI valid. */
    preferredPort(): number {
      if (!client.redirectUri) return 0;
      try {
        return Number(new URL(client.redirectUri).port) || 0;
      } catch {
        return 0;
      }
    },

    /** Remembers the redirect URI a sign-in that worked used. */
    async rememberRedirect(redirectUri: string): Promise<void> {
      await load();
      if (client.redirectUri !== redirectUri) await writeClient({ ...client, redirectUri });
    },

    /**
     * Renews the access token if it has expired or is about to, before a
     * request: one renewal at a time. Rejects with `SignInRequiredError` when
     * the server refuses it (the tokens are then gone), and with
     * `RefreshFailedError` when it may work later.
     */
    async refreshIfStale(): Promise<void> {
      await load();
      const stored = tokenRecord;
      if (!hasTokens(stored) || !stored.tokens.refresh_token || stored.expiresAt === null) return;
      if (stored.expiresAt - now() > REFRESH_WINDOW_MS) return;
      const before = heldBackRequests;
      refreshing ??= import("./sdk")
        .then(({ auth }) => auth(provider(null), { serverUrl: options.url, fetchFn: fetch }))
        .then(() => undefined)
        .finally(() => {
          refreshing = null;
        });
      try {
        await refreshing;
      } catch (error) {
        if (heldBackRequests > before) throw new HeldBackError(HELD_BACK);
        throw error;
      }
    },

    /** How many requests Local mode has stopped: a caller compares it before and after what it did. */
    heldBackCount: () => heldBackRequests,

    /** Signing out: the tokens are deleted. The registration stays, for signing in again. */
    async signOut(): Promise<void> {
      await load();
      await writeTokens(null);
    },

    /** The User changed the OAuth app: everything of the old one, and its tokens, goes. */
    async setManualSecret(secret: string | null): Promise<void> {
      await load();
      discovery = undefined;
      await writeClient(secret ? { manualSecret: secret } : {});
      await writeTokens(null);
    },

    /** The Connector was deleted. */
    async deleteAll(): Promise<void> {
      tokenRecord = null;
      client = {};
      await Promise.all([
        secrets.delete(tokensSecret(connectorId)),
        secrets.delete(clientSecret(connectorId)),
      ]);
    },
  };
}
