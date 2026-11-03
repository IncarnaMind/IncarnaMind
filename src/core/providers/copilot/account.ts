/**
 * A profile with a token exchange keeps the GitHub token to trade for
 * short-lived Copilot tokens; any other sends the GitHub token itself.
 */
import type { Browser } from "../../adapters";
import {
  type CopilotModel,
  type CopilotPlan,
  type CopilotProfileId,
  type CopilotSignInErrorKind,
  type CopilotSignInResult,
  type CopilotStatus,
  copilotProfileIds,
} from "../../api";
import { isRecord, SecretStorageError } from "../../errors";
import {
  type DeviceCode,
  nonEmptyText,
  OAuthFlowError,
  type OAuthFlowFailure,
  OAuthTokenError,
  type OAuthTokens,
  refreshOAuthTokens,
} from "../../oauth";
import {
  createOAuthAccount,
  type OAuthAccountRecord,
  parseAccountRecord,
  type StoredTokens,
} from "../../oauthAccount";
import type { Secrets } from "../../secrets";
import { SignInRouteError } from "../providerErrors";
import { USER_AGENT } from "../signedFetch";
import type { CopilotProfile } from "./config";
import { listCopilotModels } from "./requests";
import { NO_COPILOT_ACCESS, ORGANIZATION_POLICY } from "./service";

const ACCOUNT_SECRET = "copilot:account";

const MODEL_LIST_TTL_MS = 10 * 60_000;
const MODEL_LIST_TIMEOUT_MS = 5_000;
const ACCOUNT_TIMEOUT_MS = 5_000;

const PLANS: readonly CopilotPlan[] = ["free", "pro", "pro-plus", "business", "enterprise"];

/** Most specific first: "plus_monthly_subscriber" names Pro+, not Pro. */
const PLAN_SKUS: readonly [RegExp, CopilotPlan][] = [
  [/enterprise/i, "enterprise"],
  [/business/i, "business"],
  [/plus/i, "pro-plus"],
  [/educational|subscriber|individual/i, "pro"],
  [/free/i, "free"],
];

interface StoredAccount extends OAuthAccountRecord {
  /** The profile the account signed in with, which every refresh and request uses. */
  profile: CopilotProfileId;
  login: string | null;
  plan: CopilotPlan | null;
}

const parseStored = (record: Record<string, unknown>): StoredAccount => ({
  ...parseAccountRecord(record),
  profile: record.profile === "editor" ? "editor" : "own",
  login: nonEmptyText(record.login),
  plan: PLANS.find((plan) => plan === record.plan) ?? null,
});

const planOf = (sku: unknown): CopilotPlan | null =>
  typeof sku === "string" ? (PLAN_SKUS.find(([pattern]) => pattern.test(sku))?.[1] ?? null) : null;

async function readLogin(options: {
  url: string;
  githubToken: string;
  headers: Readonly<Record<string, string>>;
  fetch?: typeof globalThis.fetch;
}): Promise<string | null> {
  const headers = new Headers({ "user-agent": USER_AGENT });
  for (const [name, value] of Object.entries(options.headers)) headers.set(name, value);
  headers.set("authorization", `Bearer ${options.githubToken}`);
  headers.set("accept", "application/vnd.github+json");
  try {
    const response = await (options.fetch ?? globalThis.fetch)(options.url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => undefined);
    return response.ok && isRecord(body) ? nonEmptyText(body.login) : null;
  } catch (error) {
    console.error("The GitHub account's name couldn't be read.", error);
    return null;
  }
}

/** The token exchange's refusal, with what GitHub said, as a refresh refusal too. */
class ExchangeRefusal extends OAuthTokenError {
  constructor(
    status: number | null,
    readonly said: string,
  ) {
    super(status, null, `GitHub didn't give a Copilot token (${status ?? "no token"}): ${said}`);
  }
}

async function exchangeToken(options: {
  exchange: NonNullable<CopilotProfile["tokenExchange"]>;
  githubToken: string;
  now: number;
  signal: AbortSignal;
  fetch?: typeof globalThis.fetch;
}): Promise<{ tokens: OAuthTokens; plan: CopilotPlan | null }> {
  const response = await (options.fetch ?? globalThis.fetch)(options.exchange.url, {
    headers: {
      ...options.exchange.headers,
      authorization: `Bearer ${options.githubToken}`,
      accept: "application/json",
    },
    redirect: "error",
    signal: options.signal,
  });
  const body: unknown = await response.json().catch(() => undefined);
  const token = isRecord(body) && typeof body.token === "string" ? body.token : null;
  if (!response.ok || !token || !isRecord(body)) {
    const details = isRecord(body) && isRecord(body.error_details) ? body.error_details : {};
    const said = [isRecord(body) && body.message, details.notification_id, details.message]
      .filter((each) => typeof each === "string")
      .join(" ");
    throw new ExchangeRefusal(response.ok ? null : response.status, said);
  }
  const expiresAt = typeof body.expires_at === "number" ? body.expires_at : null;
  return {
    tokens: {
      accessToken: token,
      refreshToken: options.githubToken,
      idToken: null,
      expiresIn: expiresAt === null ? null : Math.max(0, expiresAt - options.now / 1000),
      scope: null,
      account: { email: null, organization: null },
    },
    plan: planOf(body.sku),
  };
}

/** Why the second way's token exchange failed: only GitHub's own word says there's no plan. */
class ExchangeFailure extends Error {
  override name = "ExchangeFailure";
  constructor(
    readonly kind: CopilotSignInErrorKind,
    message: string,
  ) {
    super(message);
  }
}

function exchangeFailure(error: unknown): ExchangeFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof ExchangeRefusal)) return new ExchangeFailure("unreachable", message);
  const { status } = error;
  if (status === null) return new ExchangeFailure("unexpected-response", message);
  if (NO_COPILOT_ACCESS.test(error.said)) {
    return new ExchangeFailure("no-plan", message);
  }
  if (status === 403 && ORGANIZATION_POLICY.test(error.said)) {
    return new ExchangeFailure("policy-blocked", message);
  }
  if (status >= 500) return new ExchangeFailure("service-error", message);
  return new ExchangeFailure("refused", message);
}

const FLOW_KINDS: Record<OAuthFlowFailure, CopilotSignInErrorKind> = {
  cancelled: "sign-in-cancelled",
  "timed-out": "code-expired",
  denied: "declined",
  "port-in-use": "failed",
};

function signInError(error: unknown): { kind: CopilotSignInErrorKind; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SecretStorageError) return { kind: "secret-storage", message };
  if (error instanceof ExchangeFailure) return { kind: error.kind, message };
  if (error instanceof OAuthFlowError) {
    return { kind: FLOW_KINDS[error.reason], message };
  }
  if (error instanceof OAuthTokenError) {
    if (error.status === null) return { kind: "unexpected-response", message };
    return { kind: error.status >= 500 ? "service-error" : "refused", message };
  }
  // fetch rejects with a TypeError when the network fails.
  if (error instanceof TypeError) return { kind: "unreachable", message };
  return { kind: "failed", message };
}

export type CopilotSignIn = ReturnType<typeof createCopilotAccount>;

export function createCopilotAccount(options: {
  /** The ways to sign in this build offers, the default first. */
  profiles: Readonly<Partial<Record<CopilotProfileId, Readonly<CopilotProfile>>>>;
  secrets: Secrets;
  browser: Browser;
  /** Milliseconds since the epoch. */
  now: () => number;
  onChange: () => void;
  fetch?: typeof globalThis.fetch;
}) {
  const { profiles, now } = options;
  const fetcher = options.fetch && { fetch: options.fetch };
  const profileIds = copilotProfileIds.filter((id) => profiles[id] !== undefined);
  const [defaultProfile] = profileIds;

  const required = (reason: "signed-out" | "expired") =>
    reason === "expired"
      ? new SignInRouteError("sign-in-expired", "Your GitHub sign-in expired. Sign in again.")
      : new SignInRouteError("signed-out", "Sign in with GitHub to use your Copilot plan first.");

  const account = createOAuthAccount<StoredAccount>({
    secretName: ACCOUNT_SECRET,
    provider: "GitHub",
    secrets: options.secrets,
    parse: parseStored,
    browser: options.browser,
    now,
    async renew(stored, refreshToken, signal) {
      const profile = profiles[stored.profile];
      if (!profile) throw required("signed-out");
      if (profile.tokenExchange) {
        const exchanged = await exchangeToken({
          exchange: profile.tokenExchange,
          githubToken: refreshToken,
          now: now(),
          signal,
          ...fetcher,
        });
        return exchanged.tokens;
      }
      return refreshOAuthTokens({
        tokenUrl: profile.tokenUrl,
        clientId: profile.clientId,
        refreshToken,
        format: profile.format,
        signal,
        ...fetcher,
      });
    },
    forgetOnSignOut: (stored) => ({ ...stored, login: null, plan: null }),
    signInRequired: required,
    onChange: options.onChange,
    ...fetcher,
  });

  let deviceCode: DeviceCode | null = null;
  let listed: { at: number; models: CopilotModel[] } | null = null;

  /** Tokens to keep: a GitHub token that says neither when it expires nor how to renew it lasts until refused. */
  const kept = (tokens: OAuthTokens): StoredTokens => {
    const stored = account.storedTokens(tokens, null);
    return tokens.expiresIn === null && tokens.refreshToken === null
      ? { ...stored, expiresAt: Number.MAX_SAFE_INTEGER }
      : stored;
  };

  const signedIn = async (): Promise<StoredAccount | null> => {
    const stored = await account.loadOrNull();
    return stored?.tokens && profiles[stored.profile] ? stored : null;
  };

  const requestsOf = (stored: StoredAccount | null) => {
    const profile =
      (stored && profiles[stored.profile]) ?? (defaultProfile && profiles[defaultProfile]);
    return { apiBaseUrl: profile?.apiBaseUrl ?? null, headers: profile?.requestHeaders ?? {} };
  };

  /** The account's models, read with its token and kept a few minutes; none while signed out. */
  const models = async (): Promise<CopilotModel[]> => {
    const stored = await signedIn();
    if (!stored) return [];
    if (listed && now() - listed.at < MODEL_LIST_TTL_MS) return listed.models;
    const { apiBaseUrl, headers } = requestsOf(stored);
    if (!apiBaseUrl) return [];
    try {
      const fresh = await listCopilotModels({
        baseUrl: apiBaseUrl,
        credentials: account.credentials,
        headers,
        signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
        ...fetcher,
      });
      // A plan that lists nothing is asked again next time, as when the list fails.
      if (fresh.length > 0) listed = { at: now(), models: fresh };
      return fresh;
    } catch (error) {
      console.error("The Copilot plan's model list couldn't be read.", error);
      return [];
    }
  };

  const status = async (): Promise<CopilotStatus> => {
    // Read before awaiting the keychain, so the status describes the moment it was asked for.
    const signingIn = account.signingIn();
    const waiting = deviceCode;
    const stored = await account.loadOrNull();
    const usable = stored?.tokens && profiles[stored.profile] ? stored : null;
    return {
      account: usable
        ? { state: "signed-in", profile: usable.profile, login: usable.login, plan: usable.plan }
        : { state: stored?.ended === "expired" ? "expired" : "signed-out" },
      signingIn,
      deviceCode: signingIn && waiting ? waiting : null,
      profiles: profileIds.map((id) => ({ id, experimental: profiles[id]?.experimental === true })),
      models: usable ? await models() : [],
    };
  };

  return {
    status,
    credentials: account.credentials,
    requests: async () => requestsOf(await signedIn()),
    hasSignIn: async () => (await signedIn()) !== null,
    models,
    /** Whether the sign-in's traffic can happen on this device: it has signed in, or is signing in. */
    used: async () => account.signingIn() || (await account.loadOrNull()) !== null,

    /** Starting again cancels a sign-in still waiting. */
    async signIn(input: { profile?: CopilotProfileId } = {}): Promise<CopilotSignInResult> {
      const id = input.profile ?? defaultProfile;
      const profile = id && profiles[id];
      if (!id || !profile) {
        return {
          ok: false,
          error: { kind: "unavailable", message: "This build doesn't offer that way to sign in." },
        };
      }
      try {
        await account.signIn(async (flows, signal) => {
          const github = await flows.device({
            deviceCodeUrl: profile.deviceCodeUrl,
            tokenUrl: profile.tokenUrl,
            clientId: profile.clientId,
            scope: profile.scopes.join(" "),
            format: profile.format,
            ...(profile.signInHeaders && { headers: profile.signInHeaders }),
            onCode(code) {
              deviceCode = code;
              options.onChange();
            },
          });
          let tokens = github;
          let plan: CopilotPlan | null = null;
          if (profile.tokenExchange) {
            try {
              ({ tokens, plan } = await exchangeToken({
                exchange: profile.tokenExchange,
                githubToken: github.accessToken,
                now: now(),
                signal,
                ...fetcher,
              }));
            } catch (error) {
              if (signal.aborted)
                throw new OAuthFlowError("cancelled", "The sign-in was cancelled.");
              throw exchangeFailure(error);
            }
          }
          const login = await readLogin({
            url: profile.accountUrl,
            githubToken: github.accessToken,
            headers: profile.signInHeaders ?? {},
            ...fetcher,
          });
          if (signal.aborted) throw new OAuthFlowError("cancelled", "The sign-in was cancelled.");
          listed = null;
          await account.commit({ tokens: kept(tokens), ended: null, profile: id, login, plan });
        });
        return { ok: true, status: await status() };
      } catch (error) {
        return { ok: false, error: signInError(error) };
      } finally {
        deviceCode = null;
      }
    },

    cancelSignIn: account.cancelSignIn,

    /** Forgets the tokens on this device; the User can also revoke access in GitHub's settings. */
    async signOut(): Promise<CopilotStatus> {
      await account.signOut();
      listed = null;
      return status();
    },
  };
}
