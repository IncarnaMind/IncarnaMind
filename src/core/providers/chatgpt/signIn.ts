/**
 * Sign in with ChatGPT, OpenAI's documented flow for open-source apps that
 * run on the User's computer to use the User's ChatGPT plan
 * (https://developers.openai.com/siwc/token-sharing-open-source/sign-in).
 *
 * - The first sign-in registers IncarnaMind with the User's ChatGPT account:
 *   `client_id=dynamic_agent_client`, the app's name as `agent_name_hint`,
 *   and a host ID chosen once for this computer (`ext_agent_host_id`). The
 *   browser comes back with the client ID OpenAI issued, which every later
 *   sign-in and refresh uses. No client secret, and no other app's client.
 * - PKCE, a nonce and a loopback redirect on 127.0.0.1 at any free port.
 * - The ID token's signature, issuer, audience, expiry and nonce are checked,
 *   and the granted scopes must include `chatgpt.tokens.use.direct`: without
 *   it the User didn't allow plan use, and the next sign-in asks again.
 * - Tokens are kept, refreshed and signed out of as `../../oauthAccount`
 *   does, as one record with the registration. Signing out revokes the
 *   refresh token at OpenAI but keeps the registration, so the next sign-in
 *   reuses the same client.
 *
 * Written from OpenAI's documentation; no code from OpenAI's devkit, whose
 * licence is non-commercial.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Browser } from "../../adapters";
import { nonEmptyText, type OAuthPage, refreshOAuthTokens } from "../../oauth";
import {
  createOAuthAccount,
  isSignInUnreadable,
  type OAuthAccountRecord,
  parseAccountRecord,
  type RefreshLock,
  revokeRefreshToken,
  type SignInFlows,
  SignInRecordUnreadableError,
} from "../../oauthAccount";
import type { Secrets } from "../../secrets";
import {
  ChatGptOtherAccountError,
  ChatGptPlanNotAllowedError,
  ChatGptSignInRequiredError,
} from "./errors";
import { createJwks, verifyIdToken } from "./idToken";

/** OpenAI's production OpenID configuration (https://auth.openai.com/.well-known/openid-configuration). */
export const OPENAI_AUTH = {
  issuer: "https://auth.openai.com",
  authorizeUrl: "https://auth.openai.com/api/accounts/authorize",
  tokenUrl: "https://auth.openai.com/api/accounts/oauth/token",
  revokeUrl: "https://auth.openai.com/api/accounts/oauth/revoke",
  jwksUrl: "https://auth.openai.com/.well-known/jwks.json",
} as const;

/** The API the tokens are for (the OAuth `resource`), whatever URL tests send requests to. */
export const CHATGPT_PLAN_RESOURCE = "https://api.openai.com/v1";

/** The client ID for a first sign-in: OpenAI issues IncarnaMind's own in return. */
const DYNAMIC_CLIENT = "dynamic_agent_client";

/** What the User sees on OpenAI's page as the app asking; used the same way in every installation. */
const APP_NAME = "IncarnaMind";

const CALLBACK_PATH = "/auth/callback";

const IDENTITY_SCOPES = "openid profile email";
/** The permission to use the User's ChatGPT plan; without it nothing can be asked. */
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `${IDENTITY_SCOPES} offline_access resource.invoke ${PLAN_SCOPE}`;

const ACCOUNT_SECRET = "chatgpt:account";

/** Where the sign-in happens. Tests point these at a local fake server. */
export interface ChatGptSignInEndpoints {
  issuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  jwksUrl: string;
  signInTimeoutMs: number;
}

/** Everything about the ChatGPT sign-in on this device, kept as one secret. */
interface StoredAccount extends OAuthAccountRecord {
  /** This computer's `ext_agent_host_id`, chosen before its first sign-in and kept. */
  hostId: string;
  /** The client OpenAI issued at the first sign-in; null until then. */
  clientId: string | null;
  /** The account the client was registered with (the ID token's `sub`). */
  subject: string | null;
  email: string | null;
  /** The last sign-in's ID token, sent back as `id_token_hint`; dropped at sign-out. */
  idToken: string | null;
  /** The last sign-in didn't allow plan use, so the next one asks for consent again. */
  planRefused: boolean;
}

function parseStored(record: Record<string, unknown>): StoredAccount | null {
  const hostId = nonEmptyText(record.hostId);
  if (!hostId) return null;
  return {
    ...parseAccountRecord(record),
    hostId,
    clientId: nonEmptyText(record.clientId),
    subject: nonEmptyText(record.subject),
    email: nonEmptyText(record.email),
    idToken: nonEmptyText(record.idToken),
    planRefused: record.planRefused === true,
  };
}

export type ChatGptAccountState =
  | { state: "signed-out" }
  | { state: "expired" }
  /** A record is kept here, but it can't be read; signing in again replaces it once it completes. */
  | { state: "unreadable" }
  | { state: "signed-in"; email: string | null };

export function createChatGptSignIn(options: {
  endpoints: ChatGptSignInEndpoints;
  /** Where the sign-in is kept: the device's secret store, or a shared one (see `RefreshLock`). */
  secrets: Secrets;
  refreshLock?: RefreshLock;
  browser: Browser;
  /** Milliseconds since the epoch. */
  now: () => number;
  /** The browser tab's pages, in the User's language. */
  pages: () => { success: OAuthPage; failure: OAuthPage };
  /** The sign-in changed: started, finished, signed out, or expired. */
  onChange: () => void;
  fetch?: typeof globalThis.fetch;
}) {
  const { endpoints, now } = options;
  const jwks = createJwks(endpoints.jwksUrl, options.fetch);

  const revoke = (clientId: string, refreshToken: string) =>
    revokeRefreshToken({
      revokeUrl: endpoints.revokeUrl,
      clientId,
      refreshToken,
      provider: "OpenAI",
      ...(options.fetch && { fetch: options.fetch }),
    });

  const account = createOAuthAccount<StoredAccount>({
    secretName: ACCOUNT_SECRET,
    provider: "ChatGPT",
    secrets: options.secrets,
    parse: parseStored,
    ...(options.refreshLock && { refreshLock: options.refreshLock }),
    browser: options.browser,
    pages: options.pages,
    signInTimeoutMs: endpoints.signInTimeoutMs,
    now,
    renew(stored, refreshToken, signal) {
      if (!stored.clientId) {
        throw new ChatGptSignInRequiredError(stored.ended === "expired" ? "expired" : "signed-out");
      }
      return refreshOAuthTokens({
        tokenUrl: endpoints.tokenUrl,
        clientId: stored.clientId,
        refreshToken,
        // The grant keeps its scopes: `scope` is left out, as OpenAI asks.
        params: { resource: CHATGPT_PLAN_RESOURCE },
        signal,
        ...(options.fetch && { fetch: options.fetch }),
      });
    },
    // A client OpenAI no longer knows can't be signed in with again: the next sign-in registers anew.
    expired: (stored, refusal) =>
      refusal === "client-gone"
        ? { ...stored, clientId: null, subject: null, idToken: null }
        : stored,
    revoke: (stored, refreshToken) =>
      stored.clientId ? revoke(stored.clientId, refreshToken) : Promise.resolve(true),
    forgetOnSignOut: (stored) => ({ ...stored, idToken: null }),
    signInRequired: (reason) => new ChatGptSignInRequiredError(reason),
    onChange: options.onChange,
    ...(options.fetch && { fetch: options.fetch }),
  });

  /**
   * What to sign in with: the record kept here, or a fresh one held in memory
   * until a sign-in completes. A record that can't be read is not replaced,
   * unless the User signs in again to replace it (`replaceUnreadable`). A store
   * that can't be read at all is not replaceable, so its error always stops.
   */
  const prepare = async (
    replaceUnreadable: boolean,
  ): Promise<{ stored: StoredAccount; keepRecord: boolean }> => {
    let existing: StoredAccount | null = null;
    // A record that holds a sign-in, or can't be read, is left as it is by a refused attempt.
    let keepRecord = true;
    try {
      existing = await account.load();
      keepRecord = existing?.tokens != null;
    } catch (error) {
      if (!(error instanceof SignInRecordUnreadableError) || !replaceUnreadable) throw error;
    }
    return {
      stored: existing ?? {
        hostId: `urn:uuid:${randomUUID()}`,
        clientId: null,
        subject: null,
        email: null,
        idToken: null,
        tokens: null,
        ended: null,
        planRefused: false,
      },
      keepRecord,
    };
  };

  const signInOnce = async (
    authorize: SignInFlows["browser"],
    signal: AbortSignal,
    anotherAccount: boolean,
    replaceUnreadable: boolean,
  ) => {
    const { stored, keepRecord } = await prepare(replaceUnreadable);
    const registered = anotherAccount ? null : stored.clientId;
    const nonce = randomBytes(24).toString("base64url");
    /** The client the code is for: the registered one, or the one OpenAI issues now. */
    let clientId = registered;
    const tokens = await authorize({
      authorizeUrl: endpoints.authorizeUrl,
      tokenUrl: endpoints.tokenUrl,
      clientId: registered ?? DYNAMIC_CLIENT,
      scope: SCOPE,
      redirect: { kind: "loopback", port: 0, path: CALLBACK_PATH },
      authorizeParams: {
        resource: CHATGPT_PLAN_RESOURCE,
        nonce,
        ext_agent_host_id: stored.hostId,
        ...(registered
          ? {
              ...(stored.email && { login_hint: stored.email }),
              ...(stored.idToken && stored.ended !== "signed-out"
                ? { id_token_hint: stored.idToken }
                : {}),
            }
          : { agent_name_hint: APP_NAME }),
        // Asked again only after the User didn't allow plan use: not on every sign-in.
        ...(stored.planRefused && registered && { prompt: "consent" }),
      },
      tokenParams: { resource: CHATGPT_PLAN_RESOURCE },
      verify(params) {
        if (!params.has("code")) return;
        const returned = params.get("client_id");
        if (registered) {
          if (returned && returned !== registered) {
            throw new Error("OpenAI answered for another registration of IncarnaMind.");
          }
        } else if (!returned || returned === DYNAMIC_CLIENT) {
          throw new Error("OpenAI didn't finish registering IncarnaMind. Try again.");
        } else {
          clientId = returned;
        }
      },
      exchangeClientId: () => clientId ?? DYNAMIC_CLIENT,
    });
    const issued = clientId ?? DYNAMIC_CLIENT;
    if (!tokens.idToken) throw new Error("OpenAI's sign-in returned no ID token.");
    const claims = await verifyIdToken({
      token: tokens.idToken,
      jwks,
      issuer: endpoints.issuer,
      audience: issued,
      nonce,
      now: now(),
      signal,
    });
    const scopes = (tokens.scope ?? "").split(/\s+/);
    const abandon = async () => {
      if (tokens.refreshToken) await revoke(issued, tokens.refreshToken);
    };
    if (registered && stored.subject && claims.subject !== stored.subject) {
      await abandon();
      throw new ChatGptOtherAccountError(stored.email);
    }
    const signedIn: StoredAccount = {
      hostId: stored.hostId,
      clientId: issued,
      subject: claims.subject,
      email: claims.email ?? stored.email,
      idToken: tokens.idToken,
      tokens: null,
      ended: "signed-out",
      planRefused: false,
    };
    if (!scopes.includes(PLAN_SCOPE)) {
      // Signed in, but not allowed to use the plan: nothing IncarnaMind could use is kept.
      await abandon();
      // Keep why it asked again, so the next page asks for consent: only a record
      // that holds a sign-in, or can't be read, is left as it was.
      if (!keepRecord) await account.commit({ ...signedIn, planRefused: true });
      throw new ChatGptPlanNotAllowedError();
    }
    await account.commit({ ...signedIn, tokens: account.storedTokens(tokens, null), ended: null });
    return { firstTime: registered === null };
  };

  return {
    credentials: account.credentials,

    async account(): Promise<ChatGptAccountState> {
      let stored: StoredAccount | null;
      try {
        stored = await account.load();
      } catch (error) {
        if (isSignInUnreadable(error)) return { state: "unreadable" };
        throw error;
      }
      if (stored?.tokens) return { state: "signed-in", email: stored.email };
      return stored?.ended === "expired" ? { state: "expired" } : { state: "signed-out" };
    },

    hasSignIn: async () => (await account.loadOrNull())?.tokens != null,

    /** Whether this device has signed in with ChatGPT, or is signing in: its traffic can happen. */
    used: async () => account.signingIn() || (await account.loadOrNull())?.clientId != null,

    signingIn: account.signingIn,

    /**
     * Opens the browser and waits for the User. Starting again cancels a
     * sign-in still waiting. `anotherAccount` registers a new client instead
     * of signing in to the one this device has. `replaceUnreadable` is the
     * User's answer to a record that can't be read: sign in again, replacing
     * it once the sign-in completes. Rejects with `OAuthFlowError`,
     * `OAuthTokenError`, `IdTokenError`, `SecretStorageError`,
     * `SignInRecordUnreadableError`, `ChatGptPlanNotAllowedError` or
     * `ChatGptOtherAccountError`.
     */
    signIn: (
      signInOptions: { anotherAccount?: boolean; replaceUnreadable?: boolean } = {},
    ): Promise<{ firstTime: boolean }> =>
      account.signIn((flows, signal) =>
        signInOnce(
          flows.browser,
          signal,
          signInOptions.anotherAccount === true,
          signInOptions.replaceUnreadable === true,
        ),
      ),

    cancelSignIn: account.cancelSignIn,

    reopenSignInPage: account.reopenSignInPage,

    /**
     * Stops using the sign-in, ends its session at OpenAI and forgets its
     * tokens; the registration stays for the next sign-in. `revoked` is false
     * when OpenAI couldn't confirm the session ended. Safe when signed out.
     */
    signOut: account.signOut,

    pasteAddress: account.pasteAddress,
  };
}

export type ChatGptSignIn = ReturnType<typeof createChatGptSignIn>;
