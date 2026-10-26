import { expect, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  tabMenu,
} from "./app";

/*
 * A new Mind on a fresh data folder says little (#1191): the page's note that asking needs an AI
 * model, and the assistant's lines about what it reads, and nothing else. Making it leaves no
 * "Made a new note" line, because deleting it is what takes it back.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const MESSAGES = [
  '[data-testid="chat-readiness"]',
  '[data-testid="undo-message"]',
  '[data-testid="model-setup"]',
  '[data-testid="first-open-steps"]',
  '[data-testid="assistant-empty"]',
].join(", ");

for (const examples of [false, true]) {
  for (const [language, width] of [
    ["en", 900],
    ["en", 1440],
    ["zh-CN", 900],
    ["zh-CN", 1440],
  ] as const) {
    test(`a new Mind shows at most two messages and no “made” line, ${examples ? "with" : "without"} the examples, at ${width} px in ${language}`, async () => {
      const { app, window } = await launchApp(dataDir, { examples });
      await dismissChatSetup(window);
      await setWindowSize(app, window, width, 760);
      await setLanguage(window, language);
      await newMind(window);

      await expect(window.getByTestId("chat-readiness")).toBeVisible();
      await expect(window.getByTestId("undo-message")).toHaveCount(0);
      await expect(window.getByTestId("undo-line")).not.toContainText(/Made a new note|已新建笔记/);
      const shown = await window.locator(MESSAGES).evaluateAll(
        (elements) =>
          elements.filter((element) => {
            const box = element.getBoundingClientRect();
            return box.width > 0 && box.height > 0;
          }).length,
      );
      expect(shown).toBeLessThanOrEqual(2);
      await app.close();
    });
  }
}

test("a new Mind is taken back by deleting it, which offers Undo", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 760);
  await newMind(window);
  const tabs = window.getByRole("tab");
  await expect(tabs).toHaveCount(1);

  await pointAndClick(window, (await tabMenu(window)).getByTestId("mind.delete"));
  await expect(tabs).toHaveCount(0);
  await expect(window.getByTestId("undo-message")).toContainText("Recently deleted");
  await pointAndClick(window, window.getByTestId("undo-action"));
  await expect(window.getByTestId("sidebar").getByTestId("mind-row")).toHaveCount(1);
  await app.close();
});
