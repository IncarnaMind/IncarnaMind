/**
 * Signing in with GitHub for the Copilot plan, from first run's Other ways or Settings › Models:
 * one sign-in at a time, so its state (the status, how the last one failed, whether its notice is
 * open) is one for the whole window, and both places say the same.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { CopilotSignInErrorKind, CopilotStatus } from "../../core/api";
import { copilotWay } from "../../core/providers/copilot/service";
import { core } from "./core";
import { errorMessage } from "./errors";
import { translateNow } from "./i18n";
import { clearModelFailure } from "./modelHealth";
import { useAppStore } from "./store";

/** "no-models": signed in, but the plan listed no model for this account. */
export type CopilotFailureKind = CopilotSignInErrorKind | "no-models";

export interface CopilotFailure {
  kind: CopilotFailureKind;
  message: string;
}

interface CopilotState {
  status: CopilotStatus | null;
  failure: CopilotFailure | null;
  open: boolean;
  /** Whether a Copilot provider is saved: signed in without one, Questions can't use the plan yet. */
  providerSaved: boolean | null;
}

export const useCopilot = create<CopilotState>()(() => ({
  status: null,
  failure: null,
  open: false,
  providerSaved: null,
}));

const readProviders = () =>
  core.listChatProviders().then(
    (providers) =>
      useCopilot.setState({
        providerSaved: providers.some((provider) => provider.kind === "copilot"),
      }),
    (error: unknown) => console.error("The saved chat providers couldn't be listed.", error),
  );

let loaded = false;
core.on("copilot.changed", (status) => useCopilot.setState({ status }));
// Readiness changes whenever a provider is saved or removed.
core.on("chatReadiness.changed", () => void readProviders());

export function useCopilotStatus(): CopilotStatus | null {
  useEffect(() => {
    if (loaded) return;
    loaded = true;
    void readProviders();
    core.getCopilot().then(
      (status) => useCopilot.setState({ status }),
      (error: unknown) => {
        loaded = false;
        console.error("The Copilot plan's status couldn't be read.", error);
      },
    );
  }, []);
  return useCopilot((state) => state.status);
}

/** A "Sign in again" from a problem line, waiting for this sign-in to end. */
let waitingAgain: ((signedIn: boolean) => void) | null = null;

function settleAgain(signedIn: boolean): void {
  const settle = waitingAgain;
  waitingAgain = null;
  settle?.(signedIn);
}

export const openCopilotNotice = () => useCopilot.setState({ open: true, failure: null });

/** Cancel on the notice, or closing the row: a sign-in still waiting is cancelled too. */
export function closeCopilotNotice(): void {
  if (useCopilot.getState().status?.signingIn) void cancelCopilotSignIn();
  useCopilot.setState({ open: false, failure: null });
  settleAgain(false);
}

/**
 * Signs in with GitHub and, where the User has no Copilot provider yet, saves one with the plan's
 * first model, which is choosing the plan for Questions (ADR-0022). `keepDefault` leaves the
 * default model for new Minds as it was. True once signed in; a cancelled sign-in says nothing.
 */
export async function signInWithCopilot(options: { keepDefault?: boolean } = {}): Promise<boolean> {
  useCopilot.setState({ failure: null });
  try {
    const status = useCopilot.getState().status ?? (await core.getCopilot());
    const way = copilotWay(status.profiles);
    const result = await core.signInToCopilot(way ? { profile: way.id } : {});
    if (!result.ok) {
      if (result.error.kind === "sign-in-cancelled") settleAgain(false);
      else useCopilot.setState({ failure: result.error });
      return false;
    }
    useCopilot.setState({ status: result.status, open: false });
    return await choosePlan(result.status, options.keepDefault === true);
  } catch (error) {
    useCopilot.setState({
      failure: { kind: "failed", message: errorMessage(error, translateNow) },
    });
    return false;
  }
}

async function choosePlan(status: CopilotStatus, keepDefault: boolean): Promise<boolean> {
  const providers = await core.listChatProviders();
  let provider = providers.find((each) => each.kind === "copilot");
  if (!provider) {
    const modelId = status.models[0]?.id;
    if (!modelId) {
      useCopilot.setState({
        failure: {
          kind: "no-models",
          message: "GitHub Copilot listed no models for this account.",
        },
      });
      return false;
    }
    const chatModel = useAppStore.getState().settings?.user.chatModel ?? null;
    provider = await core.saveChatProvider({ kind: "copilot", modelId });
    // Saving makes the plan the default for new Minds; from Settings, a default the User had stays.
    if (keepDefault && chatModel)
      await useAppStore.getState().updateSettings({ user: { chatModel } });
  }
  clearModelFailure(provider.id);
  useCopilot.setState({ providerSaved: true, failure: null });
  settleAgain(true);
  return true;
}

/** Signed in, a plan model chosen again: after the plan listed none, or its provider was removed. */
export async function chooseCopilotPlan(options: { keepDefault?: boolean } = {}): Promise<boolean> {
  useCopilot.setState({ failure: null });
  try {
    return await choosePlan(await core.getCopilot(), options.keepDefault === true);
  } catch (error) {
    useCopilot.setState({
      failure: { kind: "failed", message: errorMessage(error, translateNow) },
    });
    return false;
  }
}

export const cancelCopilotSignIn = () =>
  core.cancelCopilotSignIn().catch((error: unknown) => useAppStore.getState().reportError(error));

/**
 * "Sign in again" from a problem line: Settings › Models opens at the Copilot plan with its
 * notice, where a new sign-in shows its code, even while signed in, since GitHub refused that
 * sign-in. The kept one is replaced only once the new one succeeds. True then; false on Cancel
 * or once Settings closes.
 */
export function signInToCopilotAgain(): Promise<boolean> {
  settleAgain(false);
  openCopilotNotice();
  useAppStore.getState().openSettings("models", "copilot");
  return new Promise((resolve) => {
    const stopSettings = useAppStore.subscribe((state) => {
      if (!state.settingsOpen) settleAgain(false);
    });
    waitingAgain = (signedIn) => {
      stopSettings();
      resolve(signedIn);
    };
  });
}
