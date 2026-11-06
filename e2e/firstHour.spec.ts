import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  askFirstQuestion,
  askInAssistant,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * The first hour (#2270): a window with no key shows every way in without one, not only the key
 * field, and a Citation's page beside a Note leaves the Note the wider of the two at 1,440 px,
 * with the assistant docked or folded.
 */

const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
]);

const LANGUAGES = ["en", "zh-CN"] as const;

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
  test(`with no key at 900 × 900, every way in without one is on the setup card's first screen (${language}) (#2270)`, async () => {
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
    } finally {
      await app.close();
    }
  });
}

/** Widths of the Note's page and the viewer beside it, with the assistant as it is drawn. */
async function widths(window: Page) {
  return window.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      return Math.round(element.getBoundingClientRect().width);
    };
    return {
      note: box(".mind-tab-page"),
      viewer: box(".viewer-pane"),
    };
  });
}

for (const language of LANGUAGES) {
  test(`a Citation's page beside a Note leaves the Note the wider of the two at 1,440 px, docked or folded (${language}) (#2270)`, async () => {
    test.setTimeout(240_000);
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await dismissChatSetup(window);
      await connectLocalChatModel(window);
      await setLanguage(window, language);
      await setWindowSize(app, window, 1440, 900);
      await addDocuments(window, [join(sources, "Tides.pdf")]);
      await newMind(window);
      await window.getByTestId("mind-editor").focus();
      await window.keyboard.type("Reading notes");
      const answer = await askInAssistant(
        window,
        language === "en" ? "When do spring tides happen?" : "大潮 tides 什么时候出现？",
      );
      await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
      await pointAndClick(window, answer.getByTestId("citation-chip").first());
      const card = window.getByTestId("citation-card");
      await expect(card).toBeVisible();
      await pointAndClick(window, card.getByTestId("citation-open"));
      await expect(window.locator(".viewer-pane")).toBeVisible();

      const docked = await widths(window);
      if (docked.note === null || docked.viewer === null) throw new Error("Not side by side.");
      expect(docked.note).toBeGreaterThanOrEqual(docked.viewer * 1.5);

      await pointAndClick(window, window.getByTestId("assistant-fold"));
      await expect(window.getByTestId("assistant")).toHaveAttribute("data-folded", "true");
      const folded = await widths(window);
      if (folded.note === null || folded.viewer === null) throw new Error("Not side by side.");
      expect(folded.note).toBeGreaterThanOrEqual(folded.viewer * 1.5);
      expect(folded.note).toBeGreaterThan(docked.note);
    } finally {
      await app.close();
    }
  });
}
