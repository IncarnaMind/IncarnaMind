import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { translate } from "../src/shared/i18n";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

/*
 * A Supported sentence's check card says what a check can miss (#1927): the
 * scripted model (src/main/fakeChat/checks.ts) supports a sentence that shares
 * three words with a line of a Document, so no real model is involved.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const TIDES = buildPdf([
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);

const SENTENCES = {
  supported: "Spring tides happen at new and full moon.",
  unsupported: "Penguins nest on the harbour cliffs.",
  contradicted: "Harbours publish the times of high water every 6 months.",
} as const;

const MARKS = {
  first: "Spring tides",
  last: "months.",
} as const;

const SIZES = { narrow: [900, 800], wide: [1440, 900] } as const;

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

const marks = (window: Page) => window.getByTestId("claim-mark");

/** Selects the line and chooses Check against Documents. */
async function check(window: Page, line: Locator) {
  await slideSelect(window, line, MARKS.first, { line, words: MARKS.last });
  const menu = window.getByTestId("selection-menu");
  await expect(menu.getByTestId("selection-action-check-against-documents")).toBeVisible();
  await pointAndClick(window, menu.getByTestId("selection-action-check-against-documents"));
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a Supported card says the check can miss a change of obligation, and the line fits (${language})`, async () => {
    test.setTimeout(180_000);
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, ...SIZES.narrow);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    const sentences = [SENTENCES.supported, SENTENCES.unsupported, SENTENCES.contradicted];
    await window.keyboard.type(sentences.join(" "));
    const line = editor.locator(":scope > p").first();
    await expect(line).toHaveText(sentences.join(" "));
    await check(window, line);
    await expect(marks(window)).toHaveCount(3);

    const card = window.getByTestId("claim-card");
    const limit = card.getByTestId("claim-limit");
    const supported = marks(window).and(window.locator('[data-check="supported"]'));
    const contradicted = marks(window).and(window.locator('[data-check="contradicted"]'));
    const unsupported = marks(window).and(window.locator('[data-check="unsupported"]'));
    await expect(supported).toHaveCount(1);

    for (const [size, [width, height]] of Object.entries(SIZES)) {
      if (size === "wide") await setWindowSize(app, window, width, height);
      await pointAt(window, supported);
      await expect(card.getByTestId("claim-badge")).toHaveText(
        translate(language, "claim.state.supported"),
      );
      await expect(card.getByTestId("claim-checked-in")).toBeVisible();
      await expect(limit).toHaveText(translate(language, "claim.limit"));
      const box = await limit.boundingBox();
      const cardBox = await card.boundingBox();
      if (!box || !cardBox) throw new Error("The line or its card isn't drawn.");
      expect(box.x).toBeGreaterThanOrEqual(cardBox.x);
      expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(cardBox.y + cardBox.height);
      expect(cardBox.x).toBeGreaterThanOrEqual(0);
      expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(width);
      expect(cardBox.y).toBeGreaterThanOrEqual(0);
      expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(height);
      expect(await limit.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
      expect(await window.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await screenshot(window, `claim-limit-${language}-${width}`);
      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
    }

    await pointAt(window, contradicted);
    await expect(card.getByTestId("claim-badge")).toHaveText(
      translate(language, "claim.state.contradicted"),
    );
    await expect(limit).toHaveCount(0);
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);

    await pointAt(window, unsupported);
    await expect(card.getByTestId("claim-badge")).toHaveText(
      translate(language, "claim.state.notFound"),
    );
    await expect(limit).toHaveCount(0);
  });
}
