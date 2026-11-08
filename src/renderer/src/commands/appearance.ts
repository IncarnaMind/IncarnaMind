import { chooseAppearance, otherTheme } from "../appearance";
import type { Command } from "./registry";

/**
 * ⌘K's "Switch to Dark" or "Switch to Light" (#1262): the theme the window doesn't show now, kept
 * as the choice in Settings.
 */
export const appearanceCommands: readonly Command[] = [
  {
    id: "appearance.switch",
    label: (_ctx, t) =>
      t(otherTheme() === "dark" ? "command.appearance.dark" : "command.appearance.light"),
    keywords: ["command.appearance.keywords"],
    group: "main",
    reversible: true,
    run: () => chooseAppearance(otherTheme()),
  },
];
