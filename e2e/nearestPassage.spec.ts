import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  openCardMenu,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

/**
 * An unsupported sentence whose Document says something different (#770): its
 * card quotes the nearest line with its page, names it as different, and
 * offers Open the page and Fix the sentence; an unrelated sentence keeps the
 * plain "I didn’t find this in “All Documents”". The scripted model finds the
 * sentence unsupported (two shared words), then judges the nearest line: it
 * says something different when it has another number.
 */
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

const TIDES = buildPdf([
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);
const DIFFERENT = "Harbours publish forecasts monthly (6).";
const UNRELATED = "Penguins nest on the harbour cliffs.";

const WORDS = {
  en: {
    differs: "Your Documents say something different:",
    nothing: "I didn’t find this in “All Documents”.",
    open: "Open the page",
    fix: "Fix the sentence",
  },
  "zh-CN": {
    differs: "你的文档里是另一种说法：",
    nothing: "未在“全部文档”中找到。",
    open: "打开该页",
    fix: "修改这句话",
  },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`the card quotes the nearest line when the Document says something different (${language})`, async () => {
    test.setTimeout(120_000);
    const words = WORDS[language];
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.type(`${DIFFERENT} ${UNRELATED}`);
    const line = editor.locator(":scope > p").first();
    await slideSelect(window, line, "Harbours publish", { line, words: "cliffs." });
    await pointAndClick(
      window,
      window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
    );
    const marks = window.getByTestId("claim-mark");
    await expect(marks).toHaveCount(2);
    await expect(marks.first()).toHaveAttribute("data-check", "unsupported");
    await expect(marks.nth(1)).toHaveAttribute("data-check", "unsupported");
    await motionSettled(window);
    const card = window.getByTestId("claim-card");

    await pointAndClick(window, marks.first());
    await expect(card.getByTestId("claim-badge")).toHaveAttribute("data-check", "unsupported");
    await expect(card.getByTestId("claim-differs")).toHaveText(words.differs);
    await expect(card.getByTestId("claim-quote")).toHaveText(
      "Harbours publish the times of high water every 12 months.",
    );
    await expect(card.getByTestId("claim-nothing")).toHaveCount(0);
    // Its two buttons: Fix the sentence, then Keep as my view (#2869).
    await expect(card.locator(".citation-card-actions button")).toHaveCount(2);
    await expect(card.getByTestId("claim-fix")).toHaveText(words.fix);
    await expect(card.getByTestId("claim-keep")).toBeVisible();
    // The rest under ⋯, Open the page first: no more ways to look, and the mark can go.
    const menu = await openCardMenu(window, card);
    await expect(menu.locator('[role="menuitem"]').first()).toHaveAttribute(
      "data-testid",
      "claim-open",
    );
    await expect(menu.getByTestId("claim-open")).toHaveText(words.open);
    await expect(menu.getByTestId("check.findSources")).toHaveCount(0);
    await expect(menu.getByTestId("claim-search-web")).toHaveCount(0);
    await expect(menu.getByTestId("claim-remove")).toBeVisible();
    // With no Citation it can still be cut.
    await expect(menu.getByTestId("claim-cut-sentence")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    // The quote opens the Document beside the Mind at the page, as a Citation does.
    await pointAndClick(window, card.getByTestId("claim-open-quote"));
    await expect(window.getByTestId("viewer")).toBeVisible();
    // Fix the sentence selects it to write over.
    await pointAndClick(window, marks.first());
    await pointAndClick(window, window.getByTestId("claim-card").getByTestId("claim-fix"));
    await expect
      .poll(() => window.evaluate(() => globalThis.getSelection()?.toString() ?? ""))
      .toContain("Harbours publish forecasts");
    // Fix leaves the sentence selected and its menu over the next mark: close it first.
    await expect(window.getByTestId("selection-menu")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("selection-menu")).toHaveCount(0);

    // An unrelated sentence keeps today's wording.
    await pointAndClick(window, marks.nth(1));
    await expect(card.getByTestId("claim-nothing")).toHaveText(words.nothing);
    // Find sources and Search the web are in the card's ⋯, as the Mind cites no paper or book.
    const nothing = await openCardMenu(window, card);
    await expect(nothing.getByTestId("check.findSources")).toBeVisible();
    await expect(nothing.getByTestId("claim-search-web")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(nothing).toBeHidden();
    await expect(card.getByTestId("claim-differs")).toHaveCount(0);
    await app.close();
  });
}
