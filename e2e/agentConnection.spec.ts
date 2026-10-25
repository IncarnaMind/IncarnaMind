import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { agentSocketPath } from "../src/core/agents/socket";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  acceptPlainTextKeys,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  openSettings,
  removeDataFolder,
  setLanguage,
} from "./app";

/*
 * Connecting outside agents (#351) while it isn't offered: no Settings page,
 * no ⌘K command, no Privacy row and no way to set up a model (#890) lead to it,
 * and the socket stays closed even where an earlier build turned it on and
 * paired an agent.
 */

test.skip(SHOW_AGENT_CONNECTION, "Checks the app while SHOW_AGENT_CONNECTION is false.");

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

async function actionsFor(window: Page, query: string): Promise<string[]> {
  await window.keyboard.press("ControlOrMeta+k");
  const palette = window.getByTestId("palette");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type(`> ${query}`);
  await expect(
    palette.getByTestId("palette-item").or(palette.getByTestId("palette-empty")).first(),
  ).toBeVisible();
  const items = await palette.getByTestId("palette-item").allTextContents();
  await window.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  return items;
}

test("Settings has no Agents page, Privacy no agents row and ⌘K no agent command, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    const settings = await openSettings(window, "privacy");
    await expect(settings.getByTestId("consent-settings")).toBeVisible();
    await expect(settings.locator('[data-flow-id="agents"]')).toHaveCount(0);
    const nav = settings.getByTestId("settings-nav");
    for (const language of ["en", "zh-CN"] as const) {
      await setLanguage(window, language);
      await expect(nav.getByTestId("settings-nav-privacy")).toHaveText(
        language === "en" ? "Privacy" : "隐私",
      );
      await expect(nav.getByTestId("settings-nav-agents")).toHaveCount(0);
      await expect(
        nav.getByRole("button", { name: language === "en" ? "Agents" : "智能体" }),
      ).toHaveCount(0);
    }
    await window.keyboard.press("Escape");
    await expect(settings).toBeHidden();

    for (const language of ["en", "zh-CN"] as const) {
      await setLanguage(window, language);
      const word = language === "en" ? "Agents" : "智能体";
      const pages = await actionsFor(window, language === "en" ? "settings" : "设置");
      expect(pages.length).toBeGreaterThan(0);
      expect(pages.filter((text) => text.includes(word))).toEqual([]);
      expect((await actionsFor(window, word)).filter((text) => text.includes(word))).toEqual([]);
    }
  } finally {
    await app.close();
  }
});

test("turning agents on leaves the socket closed, and a pairing an earlier build left doesn't open it at the next start; the log says so once", async () => {
  const socket = agentSocketPath(dataDir);
  let { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await acceptPlainTextKeys(window);
    const enabled = await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.setAgentsEnabled(true);
      await bridge.connectAgent({ name: "Older agent", client: "other" });
      return (await bridge.getAgents()).enabled;
    });
    expect(enabled).toBe(false);
    expect(existsSync(socket)).toBe(false);
  } finally {
    await app.close();
  }

  ({ app, window } = await launchApp(dataDir));
  try {
    const mentions = async () => {
      const log = await readFile(join(dataDir, "logs", "incarnamind.log"), "utf8");
      return log.split("agents.notOffered").length - 1;
    };
    await expect.poll(mentions).toBe(1);
    expect(existsSync(socket)).toBe(false);
  } finally {
    await app.close();
  }
});

test("neither the setup card nor Settings › Models offers the Claude app, Antigravity or Agents settings, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    const leadsToAgents = {
      en: ["Open Agents settings", "Connect the Claude app", "Connect Antigravity"],
      "zh-CN": ["打开智能体设置", "连接 Claude 应用", "连接 Antigravity"],
    } as const;
    await newMind(window);
    await window.getByTestId("mind-editor").click();
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("What is in my Documents?");
    await window.keyboard.press("Enter");
    const card = window.getByTestId("model-setup");
    await card.getByTestId("setup-other").click();
    await expect(card.getByTestId("way-local")).toBeVisible();
    for (const language of ["en", "zh-CN"] as const) {
      await setLanguage(window, language);
      await expect(card.getByTestId("setup-other")).toHaveText(
        language === "en" ? "Other ways" : "其他方式",
      );
      await expect(card.getByTestId("setup-claude")).toHaveCount(0);
      for (const name of leadsToAgents[language]) {
        await expect(window.getByRole("button", { name })).toHaveCount(0);
      }
    }
    await setLanguage(window, "en");
    await card.getByTestId("setup-later").click();
    await expect(card).toBeHidden();

    const settings = await openSettings(window, "models");
    const plans = settings.getByTestId("plans-settings");
    for (const language of ["en", "zh-CN"] as const) {
      await setLanguage(window, language);
      await expect(plans.getByTestId("chatgpt-continue")).toHaveText(
        language === "en" ? "Continue with ChatGPT" : "使用 ChatGPT 继续",
      );
      await expect(plans.getByTestId("plans-claude")).toHaveCount(0);
      await expect(plans.getByTestId("plans-google")).toHaveCount(0);
      for (const name of leadsToAgents[language]) {
        await expect(settings.getByRole("button", { name })).toHaveCount(0);
      }
    }
  } finally {
    await app.close();
  }
});
