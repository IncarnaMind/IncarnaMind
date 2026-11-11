import { create } from "zustand";
import type { ChatProvider } from "../../core/api";
import { core } from "./core";

interface SavedProvidersState {
  /** The ids of the saved chat providers; null until first listed. */
  ids: ReadonlySet<string> | null;
  providers: readonly ChatProvider[];
}

export const useSavedProviders = create<SavedProvidersState>()(() => ({
  ids: null,
  providers: [],
}));

const read = () =>
  core.listChatProviders().then(
    (providers) =>
      useSavedProviders.setState({ ids: new Set(providers.map(({ id }) => id)), providers }),
    (error: unknown) => console.error("The saved chat providers couldn't be listed.", error),
  );

// Readiness changes whenever a provider is saved or removed.
core.on("chatReadiness.changed", () => void read());

let loaded = false;
export function loadSavedProviders(): void {
  if (loaded) return;
  loaded = true;
  void read();
}

/** Whether a provider is saved; every one is, until the list is known. */
export const isSaved =
  (ids: ReadonlySet<string> | null) =>
  (providerId: string): boolean =>
    ids === null || ids.has(providerId);
