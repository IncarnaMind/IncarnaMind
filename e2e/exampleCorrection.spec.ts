import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { translate } from "../src/shared/i18n";
import {
  createDataFolder,
  editItem,
  launchApp,
  leaveText,
  motionSettled,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * The example's wrong figure is the first ≠ a newcomer opens: its card offers the fix an English
 * Note's card does, in either language (#2081), with no model set up. The fix writes the results'
 * 38.6% over the draft's 36.8%, and Undo and Redo take it back and bring it again.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

for (const [language, width] of [
  ["en", 1440],
  ["zh-CN", 900],
  ["en", 900],
  ["zh-CN", 1440],
] as const) {
  test(`the example's ≠ card fixes its figure, with Undo and Redo (${language}, ${width}px)`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await launchApp(dataDir, { examples: true });
    await setWindowSize(app, window, width, 900);
    const title = window.getByTestId("mind-editor").locator("h1");
    await expect(title).toHaveText("Draft: credit committee paper");
    if (language === "zh-CN") {
      await setLanguage(window, "zh-CN");
      await expect(title).toHaveText("授信委员会报告（草稿）", { timeout: 30_000 });
    }
    const sentence =
      language === "en"
        ? "Gross margin fell to 36.8% in Q3, mostly in online."
        : "第三季度毛利率降至 36.8%，主要拖累来自线上业务。";
    const fixedStart =
      language === "en" ? "Gross margin fell to 38.6% in Q3" : "第三季度毛利率降至 38.6%";
    const pane = window.getByTestId("mind-pane");
    const editor = pane.getByTestId("mind-editor");
    const line = editor.locator("p", {
      hasText: language === "en" ? "Gross margin fell" : "第三季度毛利率降至",
    });
    await expect(line).toContainText(sentence);
    const mark = pane.getByTestId("claim-mark");
    await expect(mark).toHaveAttribute("data-check", "contradicted");
    // Its Passage is found once the results are read: the fix is offered from then on.
    await expect(pane.getByTestId("citation-chip").nth(1)).toHaveAttribute("data-check", "found", {
      timeout: 30_000,
    });

    await pointAndClick(window, mark);
    const card = window.getByTestId("claim-card");
    await expect(card.getByTestId("claim-says")).toHaveText(
      language === "en"
        ? "The Q3 results say gross margin was 38.6%, not 36.8%."
        : "第三季度业绩写的是毛利率 38.6%，不是 36.8%。",
    );
    await expect(card.getByTestId("claim-quote")).toBeVisible();
    await screenshot(window, `example-card-${language}-${width}`);
    const correct = card.getByTestId("claim-correct");
    await expect(correct).toHaveText(translate(language, "claim.correction", { wording: "38.6%" }));
    await expect(card.locator(".citation-card-actions button").first()).toHaveAttribute(
      "data-testid",
      "claim-correct",
    );
    const box = await card.boundingBox();
    const actions = await card.locator(".citation-card-actions").boundingBox();
    if (!box || !actions) throw new Error("The card isn't drawn.");
    expect(actions.x + actions.width).toBeLessThanOrEqual(box.x + box.width + 1);

    // The results' figure in place of the draft's, cited at the sentence's end.
    const fixed = async () => {
      await expect(line).toContainText(fixedStart);
      await expect(line).not.toContainText("36.8%");
      await expect(line.locator("[data-generated]")).toHaveText("38.6%");
      await expect(line.getByTestId("citation")).toHaveCount(1);
    };
    const before = async () => {
      await expect(line).toContainText(sentence);
      await expect(line.getByTestId("citation")).toHaveCount(0);
    };
    await pointAndClick(window, correct);
    await fixed();
    await expect(window.getByTestId("undo-line")).toContainText(
      translate(language, "claim.usedDocumentWording"),
    );
    await screenshot(window, `example-correction-applied-${language}-${width}`);

    await pointAndClick(window, window.getByTestId("undo-action"));
    await before();
    await expect(mark).toHaveAttribute("data-check", "contradicted");

    await leaveText(window);
    await expect.poll(async () => (await editItem(app, "edit.redo"))?.enabled).toBe(true);
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await fixed();
    await app.close();
  });
}
