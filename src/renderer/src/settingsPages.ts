import type { CloudTranscriptionRoute } from "../../core/api";
import type { SignInRoute } from "../../core/providers/signInRoutes";
import type { MessageKey } from "../../shared/i18n";

/** The pages of the Settings dialog, in the order its list shows them. */
export const settingsPages = [
  "general",
  "ai",
  "meetings",
  "connectors",
  "skills",
  "privacy",
] as const;

export type SettingsPage = (typeof settingsPages)[number];

export type SettingsTarget =
  /** Where a model in IncarnaMind is set up or changed, for every way that asks for one (#3645). */
  | "model"
  | "transcription"
  | `transcription-key:${CloudTranscriptionRoute}`
  | "output-location"
  | "author-name"
  | "local-mode"
  | "spending-cap"
  | "web-search"
  | "chat-model"
  | "add-provider"
  | "tagging"
  | "turn-on-tagging"
  | "meeting-templates"
  | "meeting-words"
  | "call-help-model"
  | "calendars"
  | "background"
  | "call-offers"
  | "check-decision"
  | SignInRoute;

export const offeredSettingsPages: readonly SettingsPage[] = settingsPages;

/** What decides whether the pages only the built-in assistant uses are listed (#3537). */
export interface PageOffers {
  noModel: boolean;
  /** A Connector is on: its page stays, the one place that disconnects it. */
  connectorsOn: boolean;
}

/**
 * The pages Settings lists. With no model set up in IncarnaMind, Connectors and Skills belong to
 * an assistant that can't run, so they step out of the list; nothing in them is removed.
 */
export function pagesOffered({ noModel, connectorsOn }: PageOffers): readonly SettingsPage[] {
  return offeredSettingsPages.filter(
    (page) => !noModel || !(page === "skills" || (page === "connectors" && !connectorsOn)),
  );
}

/** Each page's name: in the dialog's list, as its title, and in ⌘K. */
export const settingsPageLabels: Record<SettingsPage, MessageKey> = {
  general: "privacy.tabs.general",
  ai: "settings.pages.ai",
  meetings: "settings.pages.meetings",
  connectors: "connectors.settings.title",
  skills: "skills.settings.title",
  privacy: "privacy.tabs.privacy",
};

/** Pages that were renamed or folded into another; a link to one opens where its settings went. */
const movedPages: Record<string, SettingsPage> = {
  tools: "privacy",
  notifications: "general",
  models: "ai",
  search: "ai",
  // The User's own AI leads Settings › AI, so a link to the Agents page lands on it.
  agents: "ai",
};

/** A page held back lands on AI, which says what a model adds. */
export const resolveSettingsPage = (
  page: unknown,
  offered: readonly SettingsPage[] = offeredSettingsPages,
): SettingsPage =>
  isSettingsPage(page) && offered.includes(page)
    ? page
    : isSettingsPage(page) && offeredSettingsPages.includes(page)
      ? "ai"
      : typeof page === "string"
        ? (movedPages[page] ?? "general")
        : "general";

export const isSettingsPage = (page: unknown): page is SettingsPage =>
  settingsPages.some((each) => each === page);
