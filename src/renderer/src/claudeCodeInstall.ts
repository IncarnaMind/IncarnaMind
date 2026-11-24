import { useEffect } from "react";
import { create } from "zustand";
import type { ClaudeCodeInstallAvailability, ClaudeCodeInstallState } from "../../core/api";
import { core } from "./core";
import { useAppStore } from "./store";

interface Store {
  availability: ClaudeCodeInstallAvailability | null;
  state: ClaudeCodeInstallState;
  loaded: boolean;
  starting: boolean;
}

const useStore = create<Store>(() => ({
  availability: null,
  state: { kind: "idle" },
  loaded: false,
  starting: false,
}));

let subscribed = false;

const UNAVAILABLE: ClaudeCodeInstallAvailability = {
  supported: false,
  installed: false,
  cliAgentPresent: false,
  directory: "",
};

function settleUnavailableIfPending(): void {
  useStore.setState((current) =>
    current.availability === null ? { availability: UNAVAILABLE } : current,
  );
}

function refreshAvailability(): void {
  if (typeof core.getClaudeCodeInstallAvailability !== "function") {
    settleUnavailableIfPending();
    return;
  }
  core.getClaudeCodeInstallAvailability().then((availability) => {
    if (availability && typeof availability === "object") useStore.setState({ availability });
    else settleUnavailableIfPending();
  }, settleUnavailableIfPending);
}

function ensureLoaded(): void {
  if (!subscribed) {
    subscribed = true;
    core.on("claudeCodeInstall.changed", (next) => {
      if (!next || typeof next !== "object") return;
      useStore.setState({ state: next, loaded: true });
      if (next.kind === "awaiting-sign-in" || next.kind === "signed-in" || next.kind === "idle") {
        refreshAvailability();
      }
    });
    core.on("agents.changed", () => {
      refreshAvailability();
    });
  }
  const { loaded, availability } = useStore.getState();
  if (!loaded) {
    core.getClaudeCodeInstallState().then(
      (state) => {
        if (state && typeof state === "object" && "kind" in state) {
          useStore.setState({ state, loaded: true });
        }
      },
      () => undefined,
    );
  }
  if (availability === null) refreshAvailability();
}

export function useClaudeCodeInstallAvailability(): ClaudeCodeInstallAvailability | null {
  useEffect(ensureLoaded, []);
  return useStore((s) => s.availability);
}

/** Whether the one-press Claude Code offer is currently available (for ⌘K filtering). */
export function claudeCodeInstallOfferedNow(): boolean {
  const { availability } = useStore.getState();
  return availability?.supported === true && !availability.cliAgentPresent;
}

export function useClaudeCodeInstallState(): ClaudeCodeInstallState {
  useEffect(ensureLoaded, []);
  return useStore((s) => s.state);
}

export function useClaudeCodeInstallStarting(): boolean {
  return useStore((s) => s.starting);
}

export function refreshClaudeCodeInstallAvailability(): void {
  refreshAvailability();
}

export async function startClaudeCodeInstall(): Promise<void> {
  if (useStore.getState().starting) return;
  useStore.setState({ starting: true });
  ensureLoaded();
  try {
    const next = await core.installClaudeCode();
    if (next && typeof next === "object" && "kind" in next) {
      useStore.setState({ state: next, loaded: true });
    }
  } catch (error: unknown) {
    useAppStore.getState().reportError(error);
  } finally {
    useStore.setState({ starting: false });
  }
}

/** Moves focus to the Claude Code row in Settings › AI › Your AI in any install state. */
export function focusClaudeCodeInstallOffer(): void {
  const row = document.querySelector<HTMLElement>('[data-testid^="claude-code-install-"]');
  row?.scrollIntoView({ behavior: "smooth", block: "center" });
  const button =
    row?.querySelector<HTMLButtonElement>('[data-testid="install-claude-code"]') ??
    row?.querySelector<HTMLButtonElement>("button");
  button?.focus({ preventScroll: true });
}

export async function openClaudeCodeSignIn(): Promise<void> {
  ensureLoaded();
  try {
    const next = await core.openClaudeCodeSignIn();
    useStore.setState({ state: next, loaded: true });
  } catch (error: unknown) {
    useAppStore.getState().reportError(error);
  }
}

export async function checkClaudeCodeAuth(): Promise<void> {
  ensureLoaded();
  try {
    const next = await core.checkClaudeCodeAuth();
    useStore.setState({ state: next, loaded: true });
  } catch (error: unknown) {
    useAppStore.getState().reportError(error);
  }
}

export async function cancelClaudeCodeInstall(): Promise<void> {
  ensureLoaded();
  try {
    const next = await core.cancelClaudeCodeInstall();
    useStore.setState({ state: next, loaded: true });
    refreshAvailability();
  } catch (error: unknown) {
    useAppStore.getState().reportError(error);
  }
}

export async function resetClaudeCodeInstall(): Promise<void> {
  ensureLoaded();
  try {
    const next = await core.resetClaudeCodeInstall();
    useStore.setState({ state: next, loaded: true });
    refreshAvailability();
  } catch (error: unknown) {
    useAppStore.getState().reportError(error);
  }
}

/**
 * Starts one-press Claude Code installation from an empty-state entry point (where the one-line
 * disclosure sits right under the button) and opens Settings › AI so progress, browser sign-in
 * and the Connect confirmation appear in full view (#3638).
 */
export function installClaudeCodeFromEntry(): void {
  useAppStore.getState().openSettings("ai");
  void startClaudeCodeInstall();
}
