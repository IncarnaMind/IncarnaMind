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

for (const language of ["en", "zh-CN"] as const) {
  const words = LANGUAGES[language];

  test(`a Question that failed on an unknown model is asked again with the model chosen from its line (${language})`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
    try {
      await dismissChatSetup(window);
      await acceptPlainTextKeys(window);
      await setWindowSize(app, window, 1100, 900);
      await app.evaluate(() => {
        const original = globalThis.fetch;
        globalThis.fetch = (input, init) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          return url === "https://api.openai.com/v1/models"
            ? Promise.resolve(
                Response.json({ data: ["gpt-6.1-sol", "gpt-6-luna"].map((id) => ({ id })) }),
              )
            : original(input, init);
        };
      });
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
      await newMind(window);
      const chip = window.getByTestId("composer-model");
      const menu = window.getByTestId("composer-model-menu");
      const options = menu.getByTestId("composer-model-option");

      // A wrong pick: its first Question fails.
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
      await pointAndClick(window, action);
      await expect(action).toHaveText(words.choose);

      // Choose another model opens the composer's menu where the Question was asked, not Settings.
      await action.focus();
      await window.keyboard.press("Enter");
      await expect(menu).toBeVisible();
      await expect(window.getByRole("dialog", { name: /Settings|设置/ })).toHaveCount(0);
      await screenshot(window, `ask-again-2-menu-${language}`);
      await pointAndClick(window, options.filter({ hasText: /Luna/ }));

      // The failed Question offers Ask again, and asked again it is answered, still the one Question.
      await expect(action).toHaveText(words.again);
      await screenshot(window, `ask-again-3-offered-${language}`);
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
}
