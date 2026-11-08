import { expect, test } from "@playwright/test";
import { translate } from "../src/shared/i18n";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/**
 * A double-click on the New note button of a window with no tab makes one Note, not two (#2771).
 */
let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

for (const language of ["en", "zh-CN"] as const) {
  test(`a double-click on New note makes one Note (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 1100, 700);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      const home = window.getByTestId("mind-none-open");
      await expect(home).toBeVisible();
      await home.getByRole("button", { name: translate(language, "sidebar.newMind") }).dblclick();
      await expect(window.getByTestId("mind-tab")).toHaveCount(1);
      await expect(window.getByTestId("mind-list-item")).toHaveCount(1);
    } finally {
      await app.close();
    }
  });
}
