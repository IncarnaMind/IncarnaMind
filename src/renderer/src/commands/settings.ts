import { offeredSettingsPages, settingsPageLabels } from "../settingsPages";
import { useAppStore } from "../store";
import type { Command } from "./registry";

/** Each Settings page but General, which is Settings… itself, opened from ⌘K; and adding a model provider. */
export const settingsPageCommands: readonly Command[] = [
  ...offeredSettingsPages
    .filter((page) => page !== "general")
    .map(
      (page): Command => ({
        id: `settings.${page}`,
        label: (_ctx, t) => t("command.settings.page", { page: t(settingsPageLabels[page]) }),
        keywords: ["settings.title"],
        group: "open",
        reversible: true,
        run: () => useAppStore.getState().openSettings(page),
      }),
    ),
  {
    id: "settings.localMode",
    label: "embeddingProviders.localOnly.label",
    keywords: ["settings.title", "command.settings.localMode.keywords"],
    group: "open",
    reversible: true,
    run: () => useAppStore.getState().openSettings("privacy", "local-mode"),
  },
  {
    id: "settings.addProvider",
    label: "command.settings.addProvider",
    keywords: ["settings.title", "settings.pages.models"],
    group: "open",
    reversible: true,
    run: () => useAppStore.getState().openSettings("models", "add-provider"),
  },
];
