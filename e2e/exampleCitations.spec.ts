import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  assistantAnswers,
  createDataFolder,
  launchApp,
  markSteps,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  welcomeStep as step,
} from "./app";

const mindTitle = (window: Page) => window.getByTestId("mind-editor").locator("h1");

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

async function askReady(window: Page): Promise<Locator> {
  const checks = window
    .getByTestId("mind-pane")
    .getByTestId("mind-editor")
    .getByTestId("citation-chip");
  await expect(checks).toHaveCount(2);
  for (const chip of await checks.all()) {
    await expect(chip).toHaveAttribute("data-check", "found", { timeout: 30_000 });
  }
  await markSteps(window, { mistakeSeen: true });
  await pointAndClick(window, step(window, "question").getByTestId("first-open-ready"));
  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done");
  return answer;
}

async function openFromPalette(window: Page, find: string): Promise<Locator> {
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type(find);
  const found = window
    .getByTestId("palette")
    .locator('[data-testid="palette-group"][data-group="conversations"]')
    .getByTestId("palette-item")
    .first();
  await expect(found).toBeVisible();
  await window.keyboard.press("Enter");
  const answer = assistantAnswers(window).last();
  await expect(answer).toBeVisible();
  return answer;
}

async function expectCitedPage(
  window: Page,
  answer: Locator,
  index: number,
  document: string,
  quote: string,
): Promise<void> {
  const chip = answer.getByTestId("citation-chip").nth(index);
  await expect(chip).toHaveAttribute("data-check", "found");
  await pointAndClick(window, chip);
  await expect(window.getByTestId("viewer-removed")).toHaveCount(0);
  await expect(window.getByTestId("viewer-title")).toHaveText(document);
  await expect(window.getByTestId("pdf-page-number")).toHaveValue("1");
  const highlight = window
    .getByTestId("viewer")
    .locator('[data-page-number="1"] [data-quote-highlight]');
  await expect(highlight.first()).toBeInViewport();
  await expect.poll(async () => (await highlight.allTextContents()).join("")).toContain(quote);
  await window.keyboard.press("Escape");
}

test("an English Conversation's Citations open their original pages after the interface language becomes Chinese, and after a restart (#1794)", async () => {
  const first = await launchApp(dataDir, { examples: true });
  await setWindowSize(first.app, first.window, 1440, 900);
  const answer = await askReady(first.window);
  await first.window.keyboard.press("Escape");

  await setLanguage(first.window, "zh-CN");
  await expectCitedPage(
    first.window,
    answer,
    0,
    "Northwind Retail · Senior facilities agreement (excerpt)",
    "The Company shall ensure that Leverage in respect of each Relevant Period does not exceed 3.5:1.",
  );
  await expectCitedPage(
    first.window,
    answer,
    1,
    "Northwind Retail · Q3 2026 results",
    "Net debt to EBITDA was 3.1 times at the end of the quarter",
  );
  await expect(mindTitle(first.window)).toHaveText("Draft: credit committee paper");
  await first.app.close();

  const again = await launchApp(dataDir, { examples: true });
  await setWindowSize(again.app, again.window, 1440, 900);
  const reopened = await openFromPalette(again.window, "leverage limit");
  await expect(reopened.getByTestId("citation-chip")).toHaveCount(2);
  await expectCitedPage(
    again.window,
    reopened,
    0,
    "Northwind Retail · Senior facilities agreement (excerpt)",
    "The Company shall ensure that Leverage in respect of each Relevant Period does not exceed 3.5:1.",
  );
  await expectCitedPage(
    again.window,
    reopened,
    1,
    "Northwind Retail · Q3 2026 results",
    "Net debt to EBITDA was 3.1 times at the end of the quarter",
  );
  await again.app.close();
});

test("a Chinese Conversation's Citations open their original pages after the interface language becomes English, and after a restart (#1794)", async () => {
  const first = await launchApp(dataDir, { examples: true });
  await setWindowSize(first.app, first.window, 1440, 900);
  await setLanguage(first.window, "zh-CN");
  await expect(mindTitle(first.window)).toHaveText("授信委员会报告（草稿）", { timeout: 30_000 });
  const answer = await askReady(first.window);
  await first.window.keyboard.press("Escape");

  await setLanguage(first.window, "en");
  await expectCitedPage(
    first.window,
    answer,
    0,
    "Northwind Retail · 优先级贷款协议（节选）",
    "公司应确保每一相关期间的杠杆率不超过 3.5 倍。",
  );
  await expectCitedPage(
    first.window,
    answer,
    1,
    "Northwind Retail · 2026 年第三季度业绩",
    "季末净债务与 EBITDA 之比为 3.1 倍",
  );
  await expect(mindTitle(first.window)).toHaveText("授信委员会报告（草稿）");
  await first.app.close();

  const again = await launchApp(dataDir, { examples: true });
  await setWindowSize(again.app, again.window, 1440, 900);
  const reopened = await openFromPalette(again.window, "杠杆率上限");
  await expect(reopened.getByTestId("citation-chip")).toHaveCount(2);
  await expectCitedPage(
    again.window,
    reopened,
    0,
    "Northwind Retail · 优先级贷款协议（节选）",
    "公司应确保每一相关期间的杠杆率不超过 3.5 倍。",
  );
  await expectCitedPage(
    again.window,
    reopened,
    1,
    "Northwind Retail · 2026 年第三季度业绩",
    "季末净债务与 EBITDA 之比为 3.1 倍",
  );
  await again.app.close();
});
