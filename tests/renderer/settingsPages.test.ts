import { describe, expect, test } from "vitest";
import {
  isSettingsPage,
  resolveSettingsPage,
  settingsPages,
} from "../../src/renderer/src/settingsPages";
import { en } from "../../src/shared/i18n/en";
import { zhCN } from "../../src/shared/i18n/zh-CN";

describe("Settings pages", () => {
  test("are General, AI, Meetings, Connectors, Skills, Agents and Privacy, in that order", () => {
    expect(settingsPages).toEqual([
      "general",
      "ai",
      "meetings",
      "connectors",
      "skills",
      "agents",
      "privacy",
    ]);
  });

  test("a page name is recognised, and anything else, such as a click event, is not", () => {
    for (const page of settingsPages) expect(isSettingsPage(page)).toBe(true);
    for (const old of ["chat-model", "approvals", "organization", "models", "search"]) {
      expect(isSettingsPage(old)).toBe(false);
    }
    expect(isSettingsPage({ type: "click" })).toBe(false);
    expect(isSettingsPage(undefined)).toBe(false);
  });

  test("have a name in both languages", () => {
    expect(en["settings.pages.ai"]).toBe("AI");
    expect(zhCN["settings.pages.ai"]).toBe("AI");
    expect(en["settings.pages.meetings"]).toBe("Meetings");
    expect(zhCN["settings.pages.meetings"]).toBe("会议");
  });

  test("a link to a page that was folded into another opens where its settings went", () => {
    expect(resolveSettingsPage("tools")).toBe("privacy");
    expect(resolveSettingsPage("notifications")).toBe("general");
    expect(resolveSettingsPage("models")).toBe("ai");
    expect(resolveSettingsPage("search")).toBe("ai");
    expect(resolveSettingsPage("ai")).toBe("ai");
    expect(resolveSettingsPage({ type: "click" })).toBe("general");
  });
});
