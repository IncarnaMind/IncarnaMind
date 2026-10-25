import { expect, type Locator, type Page, test } from "@playwright/test";
import { createDataFolder, launchApp, removeDataFolder, setLanguage, setWindowSize } from "./app";

/**
 * The example Mind follows a change of interface language while nobody has
 * touched it (#709): its title, its draft and its check, its Question, its
 * Answer and its Documents become the other language's, with every Citation
 * found, and back again. In Chinese, as in English (#802), the wrong figure's
 * card says what the results say, and a Citation opens the PDF at its quote.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

/** Moves the mouse onto it as a person does, then clicks. */
async function pointAndClick(window: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("The element isn't visible.");
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await window.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test("switching the interface to Chinese and back swaps the untouched example, its check, its Answer and its Documents", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true });
  await setWindowSize(app, window, 1440, 900);
  const title = window.getByTestId("mind-editor").locator("h1");
  await expect(title).toHaveText("Draft: credit committee paper");
  const pane = window.getByTestId("mind-pane");
  const checks = pane.getByTestId("mind-editor").getByTestId("citation-chip");
  const mark = pane.getByTestId("claim-mark");
  await expect(checks.nth(1)).toHaveAttribute("data-check", "found", { timeout: 30_000 });
  await expect(mark).toHaveAttribute("data-check", "contradicted");

  await setLanguage(window, "zh-CN");
  await expect(title).toHaveText("授信委员会报告（草稿）", { timeout: 30_000 });
  await expect(window.getByTestId("mind-editor")).toContainText(
    "第三季度毛利率降至 36.8%，主要拖累来自线上业务。",
  );
  await expect(checks).toHaveCount(2);
  await expect(checks.nth(0)).toHaveAttribute("data-check", "found", { timeout: 30_000 });
  await expect(checks.nth(1)).toHaveAttribute("data-check", "found", { timeout: 30_000 });
  await expect(mark).toHaveCount(1);
  await expect(mark).toHaveAttribute("data-check", "contradicted");

  // The red mark's card, in Chinese: what the results say, and their words.
  await pointAndClick(window, mark);
  const card = window.getByTestId("claim-card");
  await expect(card.getByTestId("claim-says")).toHaveText(
    "第三季度业绩写的是毛利率 38.6%，不是 36.8%。",
  );
  await expect(card.getByTestId("claim-quote")).toHaveText(
    "集团毛利率为 38.6%，上年同期为 40.3%，主要受线上业务拖累。",
  );
  await window.keyboard.press("Escape");

  // A Citation opens the Chinese results at the page it quotes, the quote highlighted.
  await pointAndClick(window, checks.nth(0));
  await expect(window.getByTestId("viewer-title")).toHaveText(
    "Northwind Retail · 2026 年第三季度业绩",
  );
  await expect(window.getByTestId("pdf-page-number")).toHaveValue("1");
  const highlight = window
    .getByTestId("viewer")
    .locator('[data-page-number="1"] [data-quote-highlight]');
  await expect(highlight.first()).toBeInViewport();
  await expect
    .poll(async () => (await highlight.allTextContents()).join(""))
    .toContain("季末净债务与 EBITDA 之比为 3.1 倍");
  await window.keyboard.press("Escape");

  await setLanguage(window, "en");
  await expect(title).toHaveText("Draft: credit committee paper", { timeout: 30_000 });
  await expect(checks.nth(1)).toHaveAttribute("data-check", "found", { timeout: 30_000 });
  await expect(mark).toHaveAttribute("data-check", "contradicted");
  await app.close();
});
