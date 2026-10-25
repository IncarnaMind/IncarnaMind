import type { Language } from "../../../core/language";
import { languageNow } from "../i18n";
import { useAppStore } from "../store";
import type { Command } from "./registry";

const otherLanguage = (): Language => (languageNow() === "zh-CN" ? "en" : "zh-CN");

export const languageCommands: readonly Command[] = [
  {
    id: "language.switch",
    label: "command.language",
    keywords: ["command.language.keywords"],
    group: "main",
    reversible: true,
    run: () => useAppStore.getState().updateSettings({ user: { language: otherLanguage() } }),
  },
];
