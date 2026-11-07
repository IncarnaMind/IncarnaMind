import { otherTheme, showAppearance } from "../appearance";
import { useAppStore } from "../store";
import type { Command } from "./registry";

/** ⌘K's Switch theme (#1262): the other of Light and Dark, kept as the choice in Settings. */
export const appearanceCommands: readonly Command[] = [
  {
    id: "appearance.switch",
    label: "command.appearance",
    keywords: ["command.appearance.keywords"],
    group: "main",
    reversible: true,
    run: () => {
      const theme = otherTheme();
      showAppearance(theme);
      return useAppStore.getState().updateSettings({ device: { appearance: theme } });
    },
  },
];
