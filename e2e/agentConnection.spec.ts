import { expect, type Page, test } from "@playwright/test";
import { agentSocketPath } from "../src/core/agents/socket";
import { agentSocketAnswers } from "../tests/helpers/agentClients";
import {
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  openSettings,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  showSettingsPage,
} from "./app";

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
  await window.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(window.getByTestId("agents-settings")).toBeVisible();
  await window.getByTestId("settings-close").focus();
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("settings")).toBeHidden();
  return items;
}

test("Agents settings and command-palette entries are offered in both languages and widths", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    for (const language of ["en", "zh-CN"] as const) {
      await setLanguage(window, language);
      for (const width of [900, 1600]) {
        await setWindowSize(app, window, width, 900);
        await window
          .getByRole("button", { name: language === "en" ? "Settings" : "设置", exact: true })
          .click();
        const settings = await showSettingsPage(window, "privacy");
        await expect(settings.getByTestId("consent-settings")).toBeVisible();
        const agents = settings.getByTestId("settings-nav-agents");
        await expect(agents).toHaveText(language === "en" ? "Agents" : "智能体");
        await agents.focus();
        await window.keyboard.press("Enter");
        await expect(settings.getByTestId("agents-settings")).toBeVisible();
        await window.keyboard.press("Escape");
        await expect(settings).toBeHidden();
        const word = language === "en" ? "Agents" : "智能体";
        expect((await actionsFor(window, word)).some((text) => text.includes(word))).toBe(true);
      }
    }
  } finally {
    await app.close();
  }
});

test("offering agents leaves the listener off until the User enables it", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1600, 900);
    await dismissChatSetup(window);
    const bridge = await coreOf(window);
    expect(await bridge.evaluate((core) => core.getAgents())).toMatchObject({
      enabled: false,
      pairings: [],
    });
    const socket = agentSocketPath(dataDir);
    expect(await agentSocketAnswers(socket)).toBe(false);
    await bridge.evaluate((core) => core.setAgentsEnabled(true));
    expect(await agentSocketAnswers(socket)).toBe(true);
    await bridge.evaluate((core) => core.setAgentsEnabled(false));
    expect(await agentSocketAnswers(socket)).toBe(false);
  } finally {
    await app.close();
  }
});

test("the model setup keeps its Claude app shortcut separate from Agents settings, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1600, 900);
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
    }
  } finally {
    await app.close();
  }
});
