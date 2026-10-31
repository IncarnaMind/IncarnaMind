/**
 * Signing in with ChatGPT from anywhere in the window: the first-run choice,
 * Settings, the model chip, a problem line or ⌘K. One sign-in runs at a time,
 * so its state (waiting, or how it failed) is one for the whole window.
 */
import { create } from "zustand";
import type { ChatGptSignInErrorKind, ChatProvider } from "../../core/api";
import { core } from "./core";
import { errorMessage } from "./errors";
import { translateNow } from "./i18n";
import { clearModelFailure } from "./modelHealth";
import { useAppStore } from "./store";

/** Whether the once-only "You're using your ChatGPT plan" message is showing. */
export const useWelcome = create<{ open: boolean }>(() => ({ open: false }));

export interface ChatGptSignInFailure {
  kind: ChatGptSignInErrorKind;
  message: string;
}

/**
 * The sign-in under way, or how the last one failed: one for the whole
 * window, as the core runs one sign-in at a time, so every place that offers
 * "Continue with ChatGPT" says the same.
 */
export const useSignIn = create<{ waiting: boolean; failure: ChatGptSignInFailure | null }>(() => ({
  waiting: false,
  failure: null,
}));

interface ContinueOptions {
  anotherAccount?: boolean;
  keepDefault?: boolean;
}

/** The ChatGPT provider after a sign-in, and the model to ask with. */
export interface SignedIn {
  provider: ChatProvider;
  modelId: string;
}

/**
 * Signs in with ChatGPT and, where the User has no ChatGPT provider yet,
 * saves one with the plan's first model, so Questions can be asked at once.
 * `keepDefault` leaves the default model for new Minds as it was (the model
 * chip chooses for one Mind only). The first sign-in on this device shows
 * the once-only message about the plan. Resolves with the provider, or the
 * failure to show; a cancelled sign-in is the User's own doing and says nothing.
 */
export async function continueWithChatGpt(
  options: ContinueOptions = {},
): Promise<SignedIn | ChatGptSignInFailure | null> {
  useSignIn.setState({ waiting: true, failure: null });
  try {
    const result = await signIn(options);
    if (result && "kind" in result) useSignIn.setState({ failure: result });
    else if (result) clearModelFailure(result.provider.id);
    return result;
  } catch (error) {
    const failure: ChatGptSignInFailure = {
      kind: "failed",
      message: errorMessage(error, translateNow),
    };
    useSignIn.setState({ failure });
    return failure;
  } finally {
    useSignIn.setState({ waiting: false });
  }
}

/**
 * "Sign in again", where a problem says the ChatGPT sign-in has ended: it
 * signs in right there. If that fails, Settings → Models says why. True once
 * signed in.
 */
export async function signInAgain(openSettings: (page: "models") => void): Promise<boolean> {
  const result = await continueWithChatGpt({ keepDefault: true });
  if (result && "kind" in result) openSettings("models");
  return result !== null && !("kind" in result);
}

async function signIn(options: ContinueOptions): Promise<SignedIn | ChatGptSignInFailure | null> {
  const current = await core.getChatGptPlan();
  // Already signed in (e.g. the provider was removed since): no need to go through the browser again.
  const result =
    current.account.state === "signed-in" && !options.anotherAccount
      ? { ok: true as const, firstTime: false, status: current }
      : await core.signInToChatGpt(options.anotherAccount ? { anotherAccount: true } : undefined);
  if (!result.ok) return result.error.kind === "cancelled" ? null : result.error;
  if (result.firstTime) useWelcome.setState({ open: true });
  const providers = await core.listChatProviders();
  const existing = providers.find((provider) => provider.kind === "chatgpt");
  const chatModel = useAppStore.getState().settings?.user.chatModel ?? null;
  const inUse = existing !== undefined && chatModel?.providerId === existing.id;
  const modelId = inUse && chatModel ? chatModel.modelId : result.status.models[0]?.id;
  if (!modelId) return { kind: "failed", message: "OpenAI offered no models for this plan." };
  if (existing && (inUse || options.keepDefault)) return { provider: existing, modelId };
  // Saving makes the plan the default for new Minds; from the model chip, only the Mind changes,
  // and the core keeps the default as it saves, so one chosen meanwhile stays too (#2302).
  const provider = await core.saveChatProvider({
    kind: "chatgpt",
    modelId,
    keepDefault: options.keepDefault === true,
  });
  return { provider, modelId };
}
