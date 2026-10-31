import type { SignInRoute } from "../../core/providers/signInRoutes";
import { SHOW_AGENT_CONNECTION } from "../../shared/agentConnection";
import type { MessageKey } from "../../shared/i18n";

/** The pages of the Settings dialog, in the order its list shows them. */
export const settingsPages = [
  "general",
  "models",
  "search",
  "meetings",
  "connectors",
  "skills",
  "agents",
  "privacy",
] as const;

export type SettingsPage = (typeof settingsPages)[number];

export type SettingsTarget =
  | "output-location"
  | "author-name"
  | "local-mode"
  | "chat-model"
  | "add-provider"
  | "tagging"
  | "turn-on-tagging"
  | SignInRoute;

export const offeredSettingsPages: readonly SettingsPage[] = settingsPages.filter(
  (page) => page !== "agents" || SHOW_AGENT_CONNECTION,
);

/** Each page's name: in the dialog's list, as its title, and in ⌘K. */
export const settingsPageLabels: Record<SettingsPage, MessageKey> = {
  general: "privacy.tabs.general",
  models: "settings.pages.models",
  search: "settings.pages.search",
  meetings: "settings.pages.meetings",
  connectors: "connectors.settings.title",
  skills: "skills.settings.title",
  agents: "settings.pages.agents",
  privacy: "privacy.tabs.privacy",
};

/** Pages that were renamed or folded into another; a link to one opens where its settings went. */
const movedPages: Record<string, SettingsPage> = { tools: "privacy", notifications: "general" };

export const resolveSettingsPage = (page: unknown): SettingsPage =>
  isSettingsPage(page) && offeredSettingsPages.includes(page)
    ? page
    : typeof page === "string"
      ? (movedPages[page] ?? "general")
      : "general";

export const isSettingsPage = (page: unknown): page is SettingsPage =>
  settingsPages.some((each) => each === page);
