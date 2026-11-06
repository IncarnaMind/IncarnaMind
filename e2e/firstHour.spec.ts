import { expect, type Locator, test } from "@playwright/test";
import {
  askFirstQuestion,
  createDataFolder,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * The first hour (#2270): with no key at 900 × 900, every way in without one shows on the setup
 * card, and the Note above the dock stays in reach while the card waits.
 */

const LANGUAGES = ["en", "zh-CN"] as const;

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

/** Whether `control` is drawn whole inside `box`, which the window shows. */
async function inside(control: Locator, box: Locator): Promise<boolean> {
  const [one, other] = await Promise.all([control.boundingBox(), box.boundingBox()]);
  if (!one || !other) return false;
  const height = await control.page().evaluate(() => window.innerHeight);
  return (
    one.y >= other.y - 0.5 &&
    one.y + one.height <= other.y + other.height + 0.5 &&
    one.y + one.height <= height
  );
}

for (const language of LANGUAGES) {
  test(`with no key at 900 × 900, every way in without one is on the setup card's first screen, and the Note stays in reach (${language}) (#2270)`, async () => {
    test.setTimeout(180_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 900, 900);
      await setLanguage(window, language);
      const card = await askFirstQuestion(window);
      for (const way of ["setup-chatgpt", "way-claude", "way-local"]) {
        await expect(card.getByTestId(way)).toBeVisible();
        expect(await inside(card.getByTestId(way), card), `${way} is whole on the card`).toBe(true);
      }
      // The Note keeps its room above the dock: a click in its text lands there, not on the card.
      await pointAndClick(window, window.getByTestId("mind-editor"));
      expect(
        await window.evaluate(() => {
          const editor = document.querySelector('[data-testid="mind-editor"]');
          return editor?.contains(document.activeElement) ?? false;
        }),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
}
