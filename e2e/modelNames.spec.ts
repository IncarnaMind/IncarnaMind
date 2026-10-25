import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  openSettings,
  openSteps,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  showSettingsPage,
} from "./app";

/**
 * Models show by name, never by id (#549): the chip and its menu, Settings →
 * Models, and an Answer's steps, with the id on hover and the menu's search
 * finding a model by either. Names aren't translated. OpenAI's list is stubbed
 * in the main process. Set INCARNAMIND_SCREENSHOTS to a folder to also save
 * screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(target: Page | Locator, name: string): Promise<void> {
  if (SCREENSHOTS) await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const LISTED = ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra", "gpt-4-turbo", "gpt-9-not-found"];

let dataDir: string;
let home: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
});

test("the chip, its menu, Settings → Models and the steps show a model's name with its id on hover, and the menu's search finds it by either, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
  try {
    await dismissChatSetup(window);
    await acceptPlainTextKeys(window);
    await setWindowSize(app, window, 1100, 900);
    await app.evaluate((_electron, ids) => {
      const original = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return url === "https://api.openai.com/v1/models"
          ? Promise.resolve(Response.json({ data: ids.map((id) => ({ id })) }))
          : original(input, init);
      };
    }, LISTED);
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.saveChatProvider({
        kind: "openai",
        modelId: "gpt-6-luna",
        apiKey: "key-not-real",
      });
    });
    await newMind(window);

    // The chip names the model; the id is in its tooltip.
    const chip = window.getByTestId("composer-model");
    await expect(chip).toHaveText("GPT-6 Luna");
    await expect(chip).toHaveAttribute("title", /^GPT-6 Luna · gpt-6-luna · /);

    // The menu: names, the id on each item's tooltip.
    await pointAndClick(window, chip);
    const menu = window.getByTestId("composer-model-menu");
    const options = menu.getByTestId("composer-model-option");
    const namesShown = () =>
      options.allInnerTexts().then((all) => all.map((each) => each.split("\n")[0]).sort());
    await expect(options.first()).toBeVisible();
    await expect.poll(namesShown).toEqual(["GPT-6 Astra", "GPT-6 Luna", "GPT-6.1 Sol"]);
    await expect(options.filter({ hasText: "GPT-6.1 Sol" })).toHaveAttribute(
      "title",
      "gpt-6.1-sol",
    );
    await expect(menu).toContainText("Default for new Minds: GPT-6 Luna");
    await screenshot(window, "model-names-menu-en");

    // Search finds a model by its id (not in its name) and by its name (not in its id).
    await window.keyboard.type("6.1-sol");
    const search = menu.getByTestId("composer-model-search");
    await expect(search).toHaveValue("6.1-sol");
    await expect(options).toHaveCount(1);
    await expect(options).toContainText("GPT-6.1 Sol");
    await search.fill("6.1 sol");
    await expect(options).toHaveCount(1);
    await expect(options).toContainText("GPT-6.1 Sol");
    await search.fill("no such model");
    await expect(options).toHaveCount(0);
    await expect(menu.getByTestId("composer-model-none")).toBeVisible();
    await search.fill("");
    await expect(options).toHaveCount(3);
    await window.keyboard.press("Escape");

    // Settings → Models: the Answers default by name, its id in its tooltip; on OpenAI's page its
    // models and Other models by name.
    const settings = await openSettings(window, "models");
    const model = settings.getByRole("combobox", { name: "Answers" });
    await expect(model).toHaveValue(/\ngpt-6-luna$/);
    await expect
      .poll(() =>
        model
          .locator("option")
          .allInnerTexts()
          .then((all) => all.sort()),
      )
      .toEqual(["GPT-6 Astra · OpenAI", "GPT-6 Luna · OpenAI", "GPT-6.1 Sol · OpenAI"]);
    await expect(model).toHaveAttribute("title", "gpt-6-luna");
    await settings.getByTestId("provider-row").first().click();
    const sol = settings.getByTestId("provider-model-row").filter({ hasText: "GPT-6.1 Sol" });
    await expect(sol.locator("label")).toHaveAttribute("title", "gpt-6.1-sol");
    const other = settings.getByTestId("other-models-settings");
    await other.getByTestId("other-models-toggle").click();
    const older = other.getByTestId("other-model").filter({ hasText: "GPT-4 Turbo" });
    await expect(older).toHaveAttribute("data-model", "gpt-4-turbo");
    await expect(older.locator("span[title]").first()).toHaveAttribute("title", "gpt-4-turbo");
    await expect(
      other.getByTestId("other-model").filter({ hasText: "gpt-9-not-found" }),
    ).toHaveCount(1);
    await screenshot(window, "model-names-settings-en");
    await settings.getByRole("button", { name: "Close Settings" }).click();

    // A step row names the model that answered.
    await pointAndClick(window, window.getByTestId("composer-input"));
    await window.keyboard.type("Which model answers?");
    await window.keyboard.press("Enter");
    const answer = assistantAnswers(window).first();
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    const timeline = await openSteps(window, answer);
    await expect(timeline).toContainText("Answered by GPT-6 Luna");
    await expect(timeline.locator(".answer-step-title").first()).toHaveAttribute(
      "title",
      "gpt-6-luna",
    );
    await screenshot(window, "model-names-steps-en");

    // In Chinese the names stay as they are.
    await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: "zh-CN" },
      }),
    );
    await expect(chip).toHaveText("GPT-6 Luna");
    await pointAndClick(window, chip);
    await expect(options.first()).toBeVisible();
    await expect.poll(namesShown).toEqual(["GPT-6 Astra", "GPT-6 Luna", "GPT-6.1 Sol"]);
    await expect(menu).toContainText("新 Mind 的默认模型：GPT-6 Luna");
    await expect(menu.getByTestId("composer-model-search")).toHaveAttribute(
      "placeholder",
      "搜索模型",
    );
    await window.keyboard.type("6.1-sol");
    await expect(options).toHaveCount(1);
    await expect(options).toContainText("GPT-6.1 Sol");
    await screenshot(window, "model-names-menu-zh");
    await window.keyboard.press("Escape");
    await expect(answer.getByTestId("answer-timeline")).toContainText("GPT-6 Luna");
    await window.getByRole("button", { name: "设置" }).click();
    const settingsZh = await showSettingsPage(window, "models");
    const modelZh = settingsZh.getByRole("combobox", { name: "回答" });
    await expect(modelZh).toHaveValue(/\ngpt-6-luna$/);
    await expect(modelZh.locator("option:checked")).toHaveText("GPT-6 Luna · OpenAI");
    await screenshot(window, "model-names-settings-zh");
  } finally {
    await app.close();
  }
});
