/**
 * A sign-in kept on this device for a provider whose plan the User signs in
 * with: one sign-in at a time, tokens only in the secret store, refreshes
 * one at a time because refresh tokens may rotate (across processes too, see
 * `RefreshLock`), and sign-out ending the session where it can. Codes and
 * tokens are never logged.
 */
import type { Browser } from "./adapters";
import type { PastedAddressProblem, PastedAddressResult } from "./api";
import { isRecord, SecretStorageError, TranslatableError } from "./errors";
import {
  authorizeInBrowser,
  authorizeWithDevice,
  type BrowserAuthorizationOptions,
  type DeviceAuthorizationOptions,
  nonEmptyText,
  type OAuthPage,
  OAuthTokenError,
  type OAuthTokens,
  type PastedRedirect,
  revokeOAuthToken,
  type SignInRedirect,
} from "./oauth";
import type { Secrets } from "./secrets";

const REFRESH_WINDOW_MS = 5 * 60_000;

/** When neither the server nor the token says how long it lasts. */
const ASSUMED_LIFETIME_MS = 60 * 60_000;

const REVOKE_RETRIES_MS = [250, 1000];

/** Well under the shared refresh lock's staleness (a minute); giving up keeps the sign-in. */
export const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

/** Refresh-token errors that mean the token can't be used again (RFC 6749, OpenAI's and GitHub's). */
const UNUSABLE_REFRESH = new Set([
  "invalid_grant",
  "bad_refresh_token",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

/**
 * A sign-in record is there but can't be read: its key is gone (a reset keychain,
 * a Mac restored without one), or what it holds isn't a record. It is never
 * replaced by reading it or by starting a sign-in; only a completed sign-in
 * writes over it.
 */
export class SignInRecordUnreadableError extends TranslatableError {
  override name = "SignInRecordUnreadableError";
  constructor(
    readonly provider: string,
    options?: ErrorOptions,
  ) {
    super({ key: "error.signIn.unreadable", values: { provider } }, options);
  }
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

export type SignInEnded = "signed-out" | "expired";

export interface OAuthAccountRecord {
  tokens: StoredTokens | null;
  ended: SignInEnded | null;
}

export function parseAccountRecord(record: Record<string, unknown>): OAuthAccountRecord {
  const tokens = isRecord(record.tokens) ? record.tokens : null;
  const accessToken = tokens ? nonEmptyText(tokens.accessToken) : null;
  return {
    tokens:
      tokens && accessToken && typeof tokens.expiresAt === "number"
        ? {
            accessToken,
            refreshToken: nonEmptyText(tokens.refreshToken),
            expiresAt: tokens.expiresAt,
          }
        : null,
    ended:
      record.ended === "expired" ? "expired" : record.ended === "signed-out" ? "signed-out" : null,
  };
}

/** Keeps other processes sharing the store from refreshing at the same time. */
export interface RefreshLock {
  run<T>(task: () => Promise<T>): Promise<T>;
}

const NO_LOCK: RefreshLock = { run: (task) => task() };

export type RefreshRefusal = "unusable" | "client-gone";

function refusal(error: unknown): RefreshRefusal | "passing" {
  if (!(error instanceof OAuthTokenError) || error.status === null) return "passing";
  if (error.code === "invalid_client") return "client-gone";
  if (error.code && UNUSABLE_REFRESH.has(error.code)) return "unusable";
  // Only an overloaded or slow server is worth waiting for. GitHub refuses with 200 and a code.
  const { status, code } = error;
  const waiting =
    status >= 500 || status === 408 || status === 429 || code === "temporarily_unavailable";
  return waiting ? "passing" : "unusable";
}

const PASTE_PROBLEMS: Record<Exclude<PastedRedirect, "accepted">, PastedAddressProblem> = {
  "not-redirect": "not-sign-in-address",
  "wrong-state": "other-sign-in",
  finished: "finished",
};

export const pastedAddressResult = (pasted: PastedRedirect): PastedAddressResult =>
  pasted === "accepted" ? { ok: true } : { ok: false, problem: PASTE_PROBLEMS[pasted] };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Revokes a refresh token, trying again shortly when offline; false if the provider never confirmed. */
export async function revokeRefreshToken(options: {
  revokeUrl: string;
  clientId: string;
  refreshToken: string;
  provider: string;
  fetch?: typeof globalThis.fetch;
}): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await revokeOAuthToken({
        revokeUrl: options.revokeUrl,
        clientId: options.clientId,
        token: options.refreshToken,
        tokenTypeHint: "refresh_token",
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
        ...(options.fetch && { fetch: options.fetch }),
      });
      return true;
    } catch (error) {
      // A refusal won't change by asking again; a server or network failure might.
      const passing =
        !(error instanceof OAuthTokenError) || error.status === null || error.status >= 500;
      const wait = REVOKE_RETRIES_MS[attempt];
      if (!passing || wait === undefined) {
        console.error(`The sign-out couldn't be confirmed by ${options.provider}.`, error);
        return false;
      }
      await sleep(wait);
    }
  }
}

export interface OAuthCredentials {
  /**
   * A current access token; `rejected`, one the API refused, is refreshed even
   * before it expires. Throws the provider's sign-in-required error.
   */
  access(options?: { rejected?: string }): Promise<{ accessToken: string }>;
}

export interface SignInFlows {
  /** In the browser, coming back to a redirect (or a pasted one). */
  browser(
    request: Omit<
      BrowserAuthorizationOptions,
      "openBrowser" | "onWaiting" | "pages" | "timeoutMs" | "signal" | "fetch"
    >,
  ): Promise<OAuthTokens>;
  /** With a code the User types on the provider's page (RFC 8628). */
  device(
    request: Omit<DeviceAuthorizationOptions, "openBrowser" | "signal" | "fetch">,
  ): Promise<OAuthTokens>;
}

export function createOAuthAccount<A extends OAuthAccountRecord>(options: {
  secretName: string;
  /** What the sign-in is called in the error that says its record can't be read, e.g. "ChatGPT". */
  provider: string;
  /** Where the sign-in is kept: the device's secret store, or a shared one (see `RefreshLock`). */
  secrets: Secrets;
  /** The provider's record from what is stored; null when it can't be used. */
  parse(record: Record<string, unknown>): A | null;
  refreshLock?: RefreshLock;
  browser: Browser;
  pages?(): { success: OAuthPage; failure: OAuthPage };
  /** Defaults to five minutes. */
  signInTimeoutMs?: number;
  /** Milliseconds since the epoch. */
  now(): number;
  renew(account: A, refreshToken: string, signal: AbortSignal): Promise<OAuthTokens>;
  /** What else an account forgets when its refresh is refused for good. Defaults to nothing. */
  expired?(account: A, refusal: RefreshRefusal): A;
  /** Ends the session at the provider at sign-out; true once confirmed. Defaults to nothing to end. */
  revoke?(account: A, refreshToken: string): Promise<boolean>;
  /** What else signing out forgets, besides the tokens. Defaults to nothing. */
  forgetOnSignOut?(account: A): A;
  signInRequired(reason: SignInEnded): Error;
  onChange(): void;
  fetch?: typeof globalThis.fetch;
}) {
  const { secrets, now, onChange } = options;
  const lock = options.refreshLock ?? NO_LOCK;

  /** Bumped by every sign-in and sign-out, so a refresh that finishes afterwards changes nothing. */
  let generation = 0;
  let refreshing: Promise<A> | null = null;
  let running: {
    controller: AbortController;
    done: Promise<unknown>;
    pageUrl?: string;
  } | null = null;
  let pasteRedirect: SignInRedirect["paste"] | null = null;
  let signingOut = false;
  let toldUnreadable = false;

  /** Null only when no record is stored; a record that can't be read is its own error, never "absent". */
  const load = async (): Promise<A | null> => {
    let json: string | null;
    try {
      json = await secrets.get(options.secretName);
    } catch (error) {
      throw new SignInRecordUnreadableError(options.provider, { cause: error });
    }
    if (json === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch (error) {
      throw new SignInRecordUnreadableError(options.provider, { cause: error });
    }
    const parsed = isRecord(value) ? options.parse(value) : null;
    if (parsed === null) throw new SignInRecordUnreadableError(options.provider);
    return parsed;
  };
  const save = (account: A) => secrets.set(options.secretName, JSON.stringify(account));

  /**
   * The record, or null when it is absent or can't be read: for a status line,
   * which says the sign-in is unusable rather than failing over it. Nothing is
   * written; only a completed sign-in may replace it.
   */
  const loadOrNull = async (): Promise<A | null> => {
    try {
      return await load();
    } catch (error) {
      if (error instanceof SignInRecordUnreadableError) {
        if (!toldUnreadable) {
          toldUnreadable = true;
          console.error(
            `The ${options.provider} sign-in couldn't be read, so it isn't used.`,
            error,
          );
        }
        return null;
      }
      throw error;
    }
  };

  const required = (account: A | null) =>
    options.signInRequired(account?.ended === "expired" ? "expired" : "signed-out");

  const expire = async (from: number, account: A, reason: RefreshRefusal) => {
    if (from !== generation) return;
    generation += 1;
    const kept = options.expired?.(account, reason) ?? account;
    await save({ ...kept, tokens: null, ended: "expired" });
    onChange();
  };

  const isStale = (tokens: StoredTokens) => tokens.expiresAt - now() <= REFRESH_WINDOW_MS;

  const storedTokens = (tokens: OAuthTokens, previous: StoredTokens | null): StoredTokens => ({
    accessToken: tokens.accessToken,
    // A refresh that doesn't rotate the refresh token keeps the old one.
    refreshToken: tokens.refreshToken ?? previous?.refreshToken ?? null,
    expiresAt: now() + (tokens.expiresIn ?? ASSUMED_LIFETIME_MS / 1000) * 1000,
  });

  /** One refresh at a time: everyone who needs a fresh token while it runs waits for it. */
  const refresh = (current: A, rejected?: string): Promise<A> => {
    if (refreshing) return refreshing;
    const from = generation;
    const run = lock.run(async () => {
      // Another process sharing the store may have refreshed while this one waited for the lock.
      const latest = (await load()) ?? current;
      const tokens = latest.tokens;
      if (!tokens) throw required(latest);
      const replaced = tokens.accessToken !== current.tokens?.accessToken;
      if (replaced && !isStale(tokens) && tokens.accessToken !== rejected) return latest;
      if (!tokens.refreshToken) {
        await expire(from, latest, "unusable");
        throw options.signInRequired("expired");
      }
      let fresh: OAuthTokens;
      try {
        fresh = await options.renew(
          latest,
          tokens.refreshToken,
          AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
        );
      } catch (error) {
        const meaning = refusal(error);
        if (meaning === "passing") throw error;
        await expire(from, latest, meaning);
        throw options.signInRequired("expired");
      }
      if (from !== generation) {
        // Signed out meanwhile: nothing keeps the rotated refresh token, so end its session too.
        if (fresh.refreshToken && options.revoke) await options.revoke(latest, fresh.refreshToken);
        throw options.signInRequired("signed-out");
      }
      const next: A = { ...latest, tokens: storedTokens(fresh, tokens) };
      await save(next);
      return next;
    });
    refreshing = run;
    const clear = () => {
      if (refreshing === run) refreshing = null;
    };
    run.then(clear, clear);
    return run;
  };

  const credentials: OAuthCredentials = {
    async access(request = {}) {
      // Join a refresh already under way: its result replaces what is stored.
      const current = refreshing ? await refreshing : await load();
      if (signingOut || !current?.tokens) throw required(current);
      const stale =
        isStale(current.tokens) ||
        (request.rejected !== undefined && request.rejected === current.tokens.accessToken);
      const usable = stale ? await refresh(current, request.rejected) : current;
      if (!usable.tokens) throw options.signInRequired("signed-out");
      return { accessToken: usable.tokens.accessToken };
    },
  };

  const cancelSignIn = async () => {
    const current = running;
    if (!current) return;
    current.controller.abort();
    await current.done.catch(() => undefined);
  };

  return {
    credentials,
    load,
    loadOrNull,
    save,
    /** Saves what a sign-in ended with: a refresh that finishes afterwards changes nothing. */
    async commit(account: A): Promise<void> {
      generation += 1;
      await save(account);
    },
    /** Tokens to keep from a token endpoint's answer, keeping the refresh token it didn't rotate. */
    storedTokens,

    signingIn: () => running !== null,

    /** Cancels a sign-in still waiting; rejects with `SecretStorageError` or what `attempt` throws. */
    async signIn<T>(attempt: (flows: SignInFlows, signal: AbortSignal) => Promise<T>): Promise<T> {
      const storage = secrets.status();
      // Check before the User signs in, not after: the tokens would have nowhere to go.
      if (!storage.canSave) throw new SecretStorageError(storage.protection);
      await cancelSignIn();
      const controller = new AbortController();
      const browser: SignInFlows["browser"] = async (request) => {
        const pages = options.pages?.();
        if (!pages) throw new Error("This sign-in has no browser flow.");
        let paste: SignInRedirect["paste"] | null = null;
        try {
          return await authorizeInBrowser({
            ...request,
            openBrowser: (url) => {
              if (running?.controller === controller) running.pageUrl = url;
              return options.browser.open(url);
            },
            onWaiting(waiting) {
              paste = waiting;
              pasteRedirect = waiting;
            },
            pages,
            ...(options.signInTimeoutMs !== undefined && { timeoutMs: options.signInTimeoutMs }),
            signal: controller.signal,
            ...(options.fetch && { fetch: options.fetch }),
          });
        } finally {
          if (pasteRedirect === paste) pasteRedirect = null;
        }
      };
      const device: SignInFlows["device"] = (request) =>
        authorizeWithDevice({
          ...request,
          openBrowser: (url) => {
            if (running?.controller === controller) running.pageUrl = url;
            return options.browser.open(url);
          },
          signal: controller.signal,
          ...(options.fetch && { fetch: options.fetch }),
        });
      // Registered before the attempt starts, which may open the browser before its first await.
      const entry: NonNullable<typeof running> = { controller, done: Promise.resolve() };
      running = entry;
      const done = attempt({ browser, device }, controller.signal);
      entry.done = done;
      onChange();
      try {
        return await done;
      } finally {
        if (running?.controller === controller) running = null;
        onChange();
      }
    },

    cancelSignIn,

    async reopenSignInPage(): Promise<boolean> {
      const url = running?.pageUrl;
      if (!url) return false;
      await options.browser.open(url);
      return true;
    },

    /** See `SignInRedirect.paste`; "finished" when no sign-in is waiting. */
    pasteAddress: (address: string): PastedRedirect => pasteRedirect?.(address) ?? "finished",

    /** `revoked` is false when the provider couldn't confirm the session ended. */
    async signOut(): Promise<{ revoked: boolean }> {
      await cancelSignIn();
      generation += 1;
      signingOut = true;
      try {
        // A refresh already under way would otherwise save its tokens after these are forgotten.
        await refreshing?.catch(() => undefined);
        const stored = await load();
        if (!stored?.tokens) return { revoked: true };
        const { refreshToken } = stored.tokens;
        const revoked =
          refreshToken && options.revoke ? await options.revoke(stored, refreshToken) : true;
        const kept = options.forgetOnSignOut?.(stored) ?? stored;
        await save({ ...kept, tokens: null, ended: "signed-out" });
        return { revoked };
      } finally {
        signingOut = false;
        onChange();
      }
    },
  };
}
