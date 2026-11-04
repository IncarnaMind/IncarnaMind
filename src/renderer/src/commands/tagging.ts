import { useAppStore } from "../store";
import { failedTagging, retryTagging } from "../taggingRetry";
import { stoppedPlaces, stopTagging, taggingPlaces, tagWithAi } from "../taggingStop";
import type { Command } from "./registry";

const store = () => useAppStore.getState();

export const taggingCommands: readonly Command[] = [
  {
    // Opens the line that says what goes before anything is turned on (#2308).
    id: "tagging.turnOn",
    label: "command.tagging.turnOn",
    keywords: ["command.tagging.turnOn.keywords"],
    group: "open",
    when: () => store().library?.settings.automatic === false,
    reversible: true,
    run: () => store().openSettings("models", "turn-on-tagging"),
  },
  {
    id: "tagging.stop",
    label: "tagging.stop.command",
    group: "main",
    when: () => taggingPlaces(store().documents, store().library).length > 0,
    reversible: true,
    run: () => stopTagging(),
  },
  {
    id: "tagging.tagNotInFolder",
    label: "tagging.tagNotInFolder",
    keywords: ["tagging.resume.keywords"],
    group: "main",
    when: () => stoppedPlaces(store().library).includes(null),
    reversible: true,
    run: () => tagWithAi([null]),
  },
  {
    id: "tagging.retry",
    label: "tagging.retry",
    group: "main",
    when: () => failedTagging(store()).length > 0,
    // Only automatic Tags change; the User's own stay.
    reversible: true,
    run: () => retryTagging(),
  },
];
