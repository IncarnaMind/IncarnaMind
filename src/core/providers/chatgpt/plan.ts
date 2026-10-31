/**
 * The ChatGPT plan provider ("Continue with ChatGPT"): the sign-in, its
 * status, the account's models and their limits, and the clean-up of the experimental
 * provider it replaces. Chat providers (`../chat.ts`) use it for readiness,
 * the connection test and the model factory; the endpoint adapter does the
 * requests.
 */
import { translate } from "../../../shared/i18n";
import type { Browser } from "../../adapters";
import type {
  ChatGptPlanModel,
  ChatGptPlanStatus,
  ChatGptSignInErrorKind,
  ChatGptSignInResult,
  ChatGptSignOutResult,
  PastedAddressResult,
} from "../../api";
import { SecretStorageError, SecretsFileDamagedError } from "../../errors";
import { DEFAULT_SIGN_IN_TIMEOUT_MS, OAuthFlowError } from "../../oauth";
import {
  pastedAddressResult,
  type RefreshLock,
  SignInRecordUnreadableError,
  SignInStoreUnreadableError,
} from "../../oauthAccount";
import type { Secrets } from "../../secrets";
import type { SettingsStore } from "../../settings";
import { ChatGptOtherAccountError, ChatGptPlanNotAllowedError } from "./errors";
import { CHATGPT_PLAN_BASE_URL, KNOWN_PLAN_MODELS, listPlanModels } from "./planEndpoint";
import { createPlanLimits } from "./planLimits";
import { type ChatGptSignInEndpoints, createChatGptSignIn, OPENAI_AUTH } from "./signIn";

/** Where the provider signs in and sends Questions. */
export interface ChatGptPlanEndpoints extends ChatGptSignInEndpoints {
  /** The API's base URL; requests go to `<base>/responses`, the model list to `<base>/models`. */
  apiBaseUrl: string;
}

export const CHATGPT_PLAN_ENDPOINTS: Readonly<ChatGptPlanEndpoints> = {
  ...OPENAI_AUTH,
  signInTimeoutMs: DEFAULT_SIGN_IN_TIMEOUT_MS,
  apiBaseUrl: CHATGPT_PLAN_BASE_URL,
};

/** The account's model list is read again after this long. */
const MODEL_LIST_TTL_MS = 10 * 60_000;
const MODEL_LIST_TIMEOUT_MS = 5_000;

/** What the experimental "ChatGPT plan (via Codex sign-in)" provider left on a device. */
const CODEX_TOKENS_SECRET = "chatgpt-plan:tokens";
const CODEX_DEVICE_VALUES = ["chatGptPlanEnabled", "chatGptSignInExpired"];

function signInError(error: unknown): { kind: ChatGptSignInErrorKind; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof OAuthFlowError) {
    return { kind: error.reason === "port-in-use" ? "failed" : error.reason, message };
  }
  if (error instanceof SecretStorageError) return { kind: "secret-storage", message };
  if (error instanceof SignInStoreUnreadableError || error instanceof SecretsFileDamagedError) {
    return { kind: "store-unreadable", message };
  }
  if (error instanceof SignInRecordUnreadableError) return { kind: "record-unreadable", message };
  if (error instanceof ChatGptPlanNotAllowedError) return { kind: "plan-not-allowed", message };
  if (error instanceof ChatGptOtherAccountError) return { kind: "other-account", message };
  return { kind: "failed", message };
}

export type ChatGptPlan = ReturnType<typeof createChatGptPlan>;

export function createChatGptPlan(options: {
  endpoints: ChatGptPlanEndpoints;
  /** The device's secret store. */
  secrets: Secrets;
  /**
   * Where the sign-in is kept, when not in the device's secret store: a store
   * shared by several data folders on this computer (a test profile), with a
   * lock that keeps their refreshes apart.
   */
  sharedStore?: { secrets: Secrets; refreshLock: RefreshLock };
  settings: SettingsStore;
  browser: Browser;
  /** Milliseconds since the epoch. */
  now: () => number;
  /** Its sign-in changed. */
  onChange: () => void;
  onLimitsChange: () => void;
  fetch?: typeof globalThis.fetch;
}) {
  const { endpoints, settings, onChange } = options;

  const signIn = createChatGptSignIn({
    endpoints,
    secrets: options.sharedStore?.secrets ?? options.secrets,
    ...(options.sharedStore && { refreshLock: options.sharedStore.refreshLock }),
    browser: options.browser,
    now: options.now,
    onChange,
    ...(options.fetch && { fetch: options.fetch }),
    pages: () => {
      const { language } = settings.get();
      return {
        success: {
          title: translate(language, "chatgpt.page.success.title"),
          body: translate(language, "chatgpt.page.success.body"),
        },
        failure: {
          title: translate(language, "chatgpt.page.failure.title"),
          body: translate(language, "chatgpt.page.failure.body"),
        },
      };
    },
  });

  let listed: { at: number; models: ChatGptPlanModel[] } | null = null;
  const limits = createPlanLimits({ now: options.now, onChange: options.onLimitsChange });

  /**
   * The account's models, read with its token and kept a few minutes; the
   * known ones while signed out, or when OpenAI can't say.
   */
  const models = async (): Promise<ChatGptPlanModel[]> => {
    if (!(await signIn.hasSignIn())) return KNOWN_PLAN_MODELS.map((model) => ({ ...model }));
    if (listed && options.now() - listed.at < MODEL_LIST_TTL_MS) return listed.models;
    try {
      const fresh = await listPlanModels({
        baseUrl: endpoints.apiBaseUrl,
        credentials: signIn.credentials,
        signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
        ...(options.fetch && { fetch: options.fetch }),
      });
      if (fresh.length > 0) {
        listed = { at: options.now(), models: fresh };
        return fresh;
      }
    } catch (error) {
      console.error("The ChatGPT plan's model list couldn't be read.", error);
    }
    return KNOWN_PLAN_MODELS.map((model) => ({ ...model }));
  };

  const status = async (): Promise<ChatGptPlanStatus> => {
    // Read before awaiting the keychain, so the status describes the moment it was asked for.
    const signingIn = signIn.signingIn();
    return {
      account: await signIn.account(),
      signingIn,
      models: await models(),
      limits: limits.snapshot(),
    };
  };

  return {
    status,
    credentials: signIn.credentials,
    apiBaseUrl: endpoints.apiBaseUrl,
    hasSignIn: signIn.hasSignIn,
    /** Whether the sign-in's traffic can happen on this device: it has signed in, or is signing in. */
    used: signIn.used,
    /** The account's models, for a Question's model picker. */
    models,
    limits,

    async signIn(
      input: { anotherAccount?: boolean; replaceUnreadable?: boolean } = {},
    ): Promise<ChatGptSignInResult> {
      try {
        const { firstTime } = await signIn.signIn(input);
        listed = null;
        limits.clear();
        return { ok: true, firstTime, status: await status() };
      } catch (error) {
        return { ok: false, error: signInError(error) };
      }
    },

    cancelSignIn: () => signIn.cancelSignIn(),
    reopenSignInPage: () => signIn.reopenSignInPage(),

    async signOut(): Promise<ChatGptSignOutResult> {
      const { revoked } = await signIn.signOut();
      listed = null;
      limits.clear();
      return { revoked, status: await status() };
    },

    pasteSignInAddress: (address: string): PastedAddressResult =>
      pastedAddressResult(signIn.pasteAddress(address)),

    /**
     * Forgets what the experimental provider kept on this device: its tokens,
     * which belong to another app's sign-in and can't be used here, and its
     * switch (migration 53 already kept or removed its providers by it).
     * Does nothing on a device that never had it.
     */
    async forgetCodexSignIn(): Promise<void> {
      const left = CODEX_DEVICE_VALUES.filter((key) => settings.readDeviceValue(key) !== undefined);
      if (left.length === 0) return;
      await options.secrets.delete(CODEX_TOKENS_SECRET);
      for (const key of left) settings.deleteDeviceValue(key);
    },
  };
}
