import { expect, type Page, test } from "@playwright/test";
import {
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  nameMind,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * A request to write a piece goes into a new Mind, opened in a tab beside the User's (#1109),
 * in English and Chinese: the User's Mind stays open and as it was. The model is the smoke tests'
 * fake.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const titles = (window: Page) =>
  window.locator(
    '[data-testid="tab-group"][data-focused] [data-testid="mind-tab"] [data-testid="tab-title"]',
  );

for (const [language, request] of [
  ["en", "Write a summary of my documents"],
  ["zh-CN", "根据我现有的文件帮我写一份summary"],
] as const) {
  test(`“${request}” opens a new Mind in a tab beside the User's (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 900);
    await newMind(window);
    await nameMind(window, "Lease notes");
    await window.keyboard.type("My notes on the leases.");
    await expect(titles(window)).toHaveText(["Lease notes"]);

    await askInAssistant(window, request);

    // The new Mind's tab comes right after the User's, and is the one shown.
    await expect(titles(window)).toHaveText(["Lease notes", "Summary"]);
    const shown = window.locator(
      '[data-testid="tab-group"][data-focused] [role="tab"][aria-selected="true"]',
    );
    await expect(shown).toContainText("Summary");
    await expect(window.getByTestId("mind-editor")).not.toContainText("My notes on the leases.");
    await window.getByTestId("mind-tab").filter({ hasText: "Lease notes" }).click();
    await expect(window.getByTestId("mind-editor")).toContainText("My notes on the leases.");
  });
}
