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
 * The first hour (#2270): with no key at 900 × 900, the setup card shows every way in without one
 * on its first screen, or shows that it scrolls, and the Note above the dock stays in reach.
 */

const LANGUAGES = ["en", "zh-CN"] as const;
/** The ways in without a key. In Chinese the plans wait under Other ways, itself a way in (#2865). */
const WAYS = {
  en: ["setup-chatgpt", "way-claude", "way-local"],
  "zh-CN": ["way-local", "setup-other"],
} as const;

/** Where the card's first screen ends: its own bottom, or the window's, whichever comes first. */
async function fold(card: Locator): Promise<{ top: number; bottom: number } | null> {
  const box = await card.boundingBox();
  if (!box) return null;
  const innerHeight = await card.page().evaluate(() => window.innerHeight);
  return { top: box.y, bottom: Math.min(box.y + box.height, innerHeight) };
}

/**
 * Whether every way in shows whole on the card's first screen, or the card shows it scrolls: it
 * overflows and cuts a way at the fold. Only a keyless store lengthens the card past the room a
 * dock may take, so anywhere else a cut way is a regression, not the scroll sign (#2270).
 */
async function firstScreenShows(
  card: Locator,
  language: (typeof LANGUAGES)[number],
): Promise<boolean> {
  const screen = await fold(card);
  if (screen === null) return false;
  const ways = await Promise.all(WAYS[language].map((way) => card.getByTestId(way).boundingBox()));
  if (ways.some((box) => box === null)) return false;
  const whole = ways.every(
    (box) => box !== null && box.y >= screen.top - 0.5 && box.y + box.height <= screen.bottom + 0.5,
  );
  if (whole) return true;
  if ((await card.getByTestId("plain-text-secrets").count()) === 0) return false;
  const scrolls = await card.evaluate((el) => el.scrollHeight > el.clientHeight + 0.5);
  const cut = ways.some(
    (box) =>
      box !== null && box.y < screen.bottom - 0.5 && box.y + box.height > screen.bottom + 0.5,
  );
  return scrolls && cut;
}

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

for (const language of LANGUAGES) {
  test(`with no key at 900 × 900, the card shows every way in without one or shows it scrolls, and the Note stays in reach (${language}) (#2270)`, async () => {
    test.setTimeout(180_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 900, 900);
      await setLanguage(window, language);
      const card = await askFirstQuestion(window);
      for (const way of WAYS[language]) await expect(card.getByTestId(way)).toBeVisible();
      // The dock takes its room a frame after the card comes, so the first screen is read once it settles.
      await expect.poll(() => firstScreenShows(card, language), { timeout: 5_000 }).toBe(true);
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
