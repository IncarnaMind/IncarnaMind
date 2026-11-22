import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
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

describe("every place that names a page held back while no model is set up (#3537)", () => {
  const source = join(__dirname, "../../src/renderer/src");
  const files = (folder: string): string[] =>
    readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(join(folder, entry.name))
        : /\.tsx?$/.test(entry.name)
          ? [join(folder, entry.name)]
          : [],
    );
  const naming = files(source)
    .filter((file) =>
      /(openSettings|showSettingsPage)\(\s*["'](connectors|skills)["']/.test(
        readFileSync(file, "utf8"),
      ),
    )
    .map((file) => relative(source, file).split(sep).join("/"))
    .sort();

  test("are these, so a new one has to say what it does with no model", () => {
    expect(naming).toEqual([
      // Not offered with no model (the Library's menu, the empty note's tip).
      "components/AddDocumentsMenu.tsx",
      "components/GettingStarted.tsx",
      // Land on AI: the Skill just saved, and Manage Skills… in the chat box.
      "components/MakeSkillCard.tsx",
      "editor/Composer.tsx",
    ]);
  });

  test("the ones that are not offered ask whether the page is listed", () => {
    for (const file of ["components/AddDocumentsMenu.tsx", "components/GettingStarted.tsx"]) {
      expect(readFileSync(join(source, file), "utf8"), file).toContain(
        'useSettingsPageOffered("connectors")',
      );
    }
  });

  test("⌘K's page commands ask too, each", () => {
    expect(readFileSync(join(source, "commands/settings.ts"), "utf8")).toContain(
      "when: () => settingsPageOfferedNow(page)",
    );
  });
});
