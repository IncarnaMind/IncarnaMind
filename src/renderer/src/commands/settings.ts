import { useCallHelpOffer } from "../callHelpOffer";
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
        // Models and Search are found where they went.
        keywords:
          page === "ai" ? ["settings.title", "command.settings.ai.keywords"] : ["settings.title"],
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
    assistant: { never: "privacy" },
    label: "embeddingProviders.localOnly.label",
    keywords: ["settings.title", "command.settings.localMode.keywords"],
    group: "open",
    reversible: true,
    run: () => useAppStore.getState().openSettings("ai", "local-mode"),
  },
  {
    id: "settings.meetingWords",
    label: "meetings.words.title",
    keywords: [
      "settings.title",
      "settings.pages.meetings",
      "command.settings.meetingWords.keywords",
    ],
    group: "open",
    reversible: true,
    run: () => useAppStore.getState().openSettings("meetings", "meeting-words"),
  },
  {
    id: "settings.callHelpModel",
    label: "command.settings.callHelpModel",
    keywords: [
      "settings.title",
      "settings.pages.meetings",
      "meetings.callHelp",
      "command.settings.callHelpModel.keywords",
    ],
    group: "open",
    when: () => {
      if (useCallHelpOffer.getState().fastest !== null) return true;
      const settings = useAppStore.getState().settings;
      // Kept while Fastest is chosen, so it can be undone, where there is a model for its row.
      return settings?.user.callHelpModel === "fastest" && settings.user.chatModel !== null;
    },
    reversible: true,
    run: () => useAppStore.getState().openSettings("meetings", "call-help-model"),
  },
  {
    // Where a transcription service's key is added, and where the meeting audio goes is chosen.
    id: "settings.transcription",
    assistant: { never: "keys" },
    label: "command.settings.transcription",
    keywords: ["settings.title", "settings.pages.ai", "command.settings.transcription.keywords"],
    group: "open",
    reversible: true,
    run: () => useAppStore.getState().openSettings("ai", "transcription"),
  },
  {
    id: "settings.background",
    label: "settings.background",
    keywords: ["settings.title", "command.settings.background.keywords"],
    group: "open",
    reversible: true,
    run: () => useAppStore.getState().openSettings("general", "background"),
  },
  {
    id: "settings.callOffers",
    label: "settings.callOffers",
    keywords: ["settings.title", "settings.notifications", "command.settings.callOffers.keywords"],
    group: "open",
    reversible: true,
    run: () => useAppStore.getState().openSettings("general", "call-offers"),
  },
  {
    id: "settings.addProvider",
    assistant: { never: "keys" },
    label: "command.settings.addProvider",
    keywords: ["settings.title", "settings.pages.ai"],
    group: "open",
    reversible: true,
    run: () => useAppStore.getState().openSettings("ai", "add-provider"),
  },
];
