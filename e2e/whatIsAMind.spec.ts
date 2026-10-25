import { expect, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  enterContent,
  launchApp,
  leaveFirstOpen,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/**
 * One sentence says what a Mind is where the User first meets it (#721): in the
 * example's banner, on the first empty Mind's first line until something is
 * written, and in New Mind's tooltip; in English and Chinese.
 */

const SENTENCE = {
  en: "A Mind: write here and ask your Documents, every quote checked.",
  "zh-CN": "Mind：在这里写作、向文档提问，每条引文都会核对。",
} as const;
const TOOLTIP = {
  en: "New Mind: write and ask your Documents",
  "zh-CN": "新建 Mind：写作并向文档提问",
} as const;

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

for (const language of ["en", "zh-CN"] as const) {
  test(`the example's banner and New Mind's tooltip say what a Mind is, in ${language}`, async () => {
    const { app, window } = await launchApp(dataDir, { examples: true });
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, language);
    await leaveFirstOpen(window);
    await expect(window.getByTestId("example-banner")).toContainText(SENTENCE[language]);
    await expect(window.getByTestId("new-tab").first()).toHaveAttribute(
      "title",
      new RegExp(`^${TOOLTIP[language]}`),
    );
    await app.close();
  });

  test(`the first empty Mind says it on its first line until something is written, and no later Mind does, in ${language}`, async () => {
    const { app, window } = await launchApp(dataDir);
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await newMind(window);
    await enterContent(window);
    const hint = window.getByTestId("end-hint");
    await expect(hint).toContainText(SENTENCE[language]);
    await window.keyboard.type("Tides");
    await expect(hint).toHaveCount(0);

    await newMind(window);
    await enterContent(window);
    await expect(hint).toHaveAttribute("data-place", "empty");
    await expect(hint).not.toContainText(SENTENCE[language]);
    await app.close();
  });
}
