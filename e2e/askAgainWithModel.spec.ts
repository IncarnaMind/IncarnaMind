import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
} from "./app";

/*
 * A failed Answer whose model is unknown (#1848): "Choose another model" opens the composer's model
 * menu, not Settings, and once a working model is picked there the failed Question offers Ask
 * again with it, keeping its words; the Answer then comes back on the same Question.
 */

const LANGUAGES = {
  en: { choose: "Choose another model", remove: "Remove from menu", again: "Ask again" },
  "zh-CN": { choose: "换一个模型", remove: "从菜单中移除", again: "重新提问" },
} as const;

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

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

async function setUpProviders(window: Page, language: "en" | "zh-CN"): Promise<void> {
  await window.evaluate(async (chosen) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.updateSettings({ user: { language: chosen } });
    const provider = await bridge.saveChatProvider({
      kind: "openai",
      modelId: "gpt-6.1-sol",
      apiKey: "key-not-real",
    });
    await bridge.setChatModelInMenu({
      providerId: provider.id,
      modelId: "gpt-9-not-found",
      inMenu: true,
    });
  }, language);
}

async function launch(width: number) {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  await setWindowSize(app, window, width, 900);
  await app.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url === "https://api.openai.com/v1/models"
        ? Promise.resolve(
            Response.json({ data: ["gpt-6.1-sol", "gpt-6-luna"].map((id) => ({ id })) }),
          )
        : original(input, init);
    };
  });
  return { app, window };
}

for (const language of ["en", "zh-CN"] as const) {
  const words = LANGUAGES[language];

  test(`a Question that failed on a model added to the menu: it is taken out, another is chosen from the composer, and the Question is asked again with it (${language})`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await launch(1100);
    try {
      await setUpProviders(window, language);
      await newMind(window);
      const chip = window.getByTestId("composer-model");
      const options = window
        .getByTestId("composer-model-menu")
        .getByTestId("composer-model-option");

      // A wrong pick: its first Question fails, and the chip still shows it.
      await pointAndClick(window, chip);
      await pointAndClick(window, options.filter({ hasText: "gpt-9-not-found" }));
      await expect(window.getByTestId("composer-input")).toBeFocused();
      await window.keyboard.type("Which model answers?");
      await window.keyboard.press("Enter");
      const problem = window.getByTestId("answer-error");
      await expect(problem).toContainText("gpt-9-not-found");
      const action = problem.getByTestId("answer-error-action");
      await expect(action).toHaveText(words.remove);
      await screenshot(window, `ask-again-1-failed-${language}`);

      // Taken out of the menu, the Note still has it chosen: the next step is to choose another, in
      // the composer's menu, not Settings.
      await action.focus();
      await window.keyboard.press("Enter");
      await expect(action).toHaveText(words.choose);
      await action.focus();
      await window.keyboard.press("Enter");
      const menu = window.getByTestId("composer-model-menu");
      await expect(menu).toBeVisible();
      await expect(window.getByTestId("settings")).toBeHidden();
      await screenshot(window, `ask-again-2-menu-${language}`);
      await pointAndClick(window, options.filter({ hasText: /Luna/ }));
      await expect(action).toHaveText(words.again);
      await screenshot(window, `ask-again-3-offered-${language}`);

      // Asked again, by keyboard, it is answered on the same single Question.
      await action.focus();
      await window.keyboard.press("Enter");
      await expect(problem).toHaveCount(0);
      const answer = window.getByTestId("assistant-answer");
      await expect(answer).toHaveCount(1);
      await expect(answer).toHaveAttribute("data-status", "done");
      await expect(window.getByTestId("assistant-question")).toHaveCount(1);
      await screenshot(window, `ask-again-4-answered-${language}`);
    } finally {
      await app.close();
    }
  });

  test(`Choose another model on a refused request opens the composer's menu, and the model picked there is offered to ask again with (${language})`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await launch(1100);
    try {
      await setUpProviders(window, language);
      await newMind(window);
      const menu = window.getByTestId("composer-model-menu");
      await window.getByTestId("composer-input").click();
      await window.keyboard.type("Send a refused request about the zanzibar codeword");
      await window.keyboard.press("Enter");
      const problem = window.getByTestId("answer-error");
      await expect(problem).toHaveAttribute("data-error-kind", "refused");
      const action = problem.getByTestId("answer-error-action");
      await expect(action).toHaveText(words.choose);

      // The menu is the composer's, where the Question was asked: no Settings page opens.
      await action.focus();
      await window.keyboard.press("Enter");
      await expect(menu).toBeVisible();
      await expect(window.getByTestId("settings")).toBeHidden();
      await screenshot(window, `ask-again-5-refused-menu-${language}`);
      await pointAndClick(
        window,
        menu.getByTestId("composer-model-option").filter({ hasText: /Luna/ }),
      );
      await expect(action).toHaveText(words.again);
    } finally {
      await app.close();
    }
  });
}
