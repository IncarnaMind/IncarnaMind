import { showOutputLocationSetting } from "../outputFiles";
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
    // Where a Linked folder's row sends the User when it couldn't read what it may write. Named
    // for the switches it opens, since "location" would answer a search for Local mode first.
    id: "settings.outputLocation",
    label: "outputLocation.linked.title",
    purpose: "outputLocation.title",
    keywords: ["settings.title", "outputLocation.title"],
    group: "open",
    reversible: true,
    run: () => showOutputLocationSetting(),
  },
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
