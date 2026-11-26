import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  askInAssistant,
  assistantAnswers,
  coreOf,
  createDataFolder,
  frontMind,
  launchApp,
  openExample,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

const mindTitle = (window: Page) => window.getByTestId("mind-editor").locator("h1");

// With "each" (每份), the scripted model cites the line of each Document that shares the most
// words with the Question; it matches Latin words only, so the Chinese one names EBITDA.
const ENGLISH_QUESTION =
  "What does each Document say about net debt to EBITDA and the leverage limit?";
const CHINESE_QUESTION = "每份文档对净债务与 EBITDA 之比和杠杆率上限怎么说？";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

/** A Question about the example asked in the assistant from its page, once its Documents are read. */
async function askAboutExample(window: Page, question: string): Promise<Locator> {
  const checks = window
    .getByTestId("mind-pane")
    .getByTestId("mind-editor")
    .getByTestId("citation-chip");
  await expect(checks).toHaveCount(2);
  for (const chip of await checks.all()) {
    await expect(chip).toHaveAttribute("data-check", "found", { timeout: 30_000 });
  }
  const answer = await askInAssistant(window, question);
  await expect(answer).toHaveAttribute("data-status", "done");
  await expect(answer.getByTestId("citation-chip")).toHaveCount(2);
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
  // The PDF's text layer can leave out a space between two words of a quote.
  const unspaced = (text: string) => text.replace(/\s+/g, "");
  await expect
    .poll(async () => unspaced((await highlight.allTextContents()).join("")))
    .toContain(unspaced(quote));
  await window.keyboard.press("Escape");
}

test("an English Conversation's Citations open their original pages after the interface language becomes Chinese, and after a restart (#1794)", async () => {
  const first = await launchApp(dataDir, { examples: true, fakeChat: true });
  await openExample(first.window);
  await setWindowSize(first.app, first.window, 1440, 900);
  await useLocalChatModel(first.window);
  const answer = await askAboutExample(first.window, ENGLISH_QUESTION);
  await first.window.keyboard.press("Escape");

  await setLanguage(first.window, "zh-CN");
  await expectCitedPage(
    first.window,
    answer,
    0,
    "Northwind Retail · Q3 2026 results",
    "Net debt to EBITDA was 3.1 times at the end of the quarter",
  );
  await expectCitedPage(
    first.window,
    answer,
    1,
    "Northwind Retail · Senior facilities agreement (excerpt)",
    "The Company shall ensure that Leverage in respect of each Relevant Period does not exceed 3.5:1.",
  );
  await expect(mindTitle(first.window)).toHaveText("Draft: credit committee paper");
  await first.app.close();

  const again = await launchApp(dataDir, { examples: true, fakeChat: true });
  await setWindowSize(again.app, again.window, 1440, 900);
  const reopened = await openFromPalette(again.window, "net debt");
  await expect(reopened.getByTestId("citation-chip")).toHaveCount(2);
  await expectCitedPage(
    again.window,
    reopened,
    0,
    "Northwind Retail · Q3 2026 results",
    "Net debt to EBITDA was 3.1 times at the end of the quarter",
  );
  await expectCitedPage(
    again.window,
    reopened,
    1,
    "Northwind Retail · Senior facilities agreement (excerpt)",
    "The Company shall ensure that Leverage in respect of each Relevant Period does not exceed 3.5:1.",
  );
  await again.app.close();
});

test("a Chinese Conversation's Citations open their original pages after the interface language becomes English, and after a restart (#1794)", async () => {
  const first = await launchApp(dataDir, { examples: true, fakeChat: true });
  await openExample(first.window);
  await setWindowSize(first.app, first.window, 1440, 900);
  await setLanguage(first.window, "zh-CN");
  await expect(mindTitle(first.window)).toHaveText("授信委员会报告（草稿）", { timeout: 30_000 });
  await useLocalChatModel(first.window);
  const answer = await askAboutExample(first.window, CHINESE_QUESTION);
  await first.window.keyboard.press("Escape");

  await setLanguage(first.window, "en");
  await expectCitedPage(
    first.window,
    answer,
    0,
    "Northwind Retail · 优先级贷款协议（节选）",
    "“EBITDA”指任一相关期间内集团扣除利息、税项、折旧及摊销前的合并经营利润，以该相关期间的合规证明所载数额为准。",
  );
  await expectCitedPage(
    first.window,
    answer,
    1,
    "Northwind Retail · 2026 年第三季度业绩",
    "基础 EBITDA 为 9,600 万英镑，上年同期为 1.18 亿英镑。",
  );
  await expect(mindTitle(first.window)).toHaveText("授信委员会报告（草稿）");
  await first.app.close();

  const again = await launchApp(dataDir, { examples: true, fakeChat: true });
  await setWindowSize(again.app, again.window, 1440, 900);
  const reopened = await openFromPalette(again.window, "杠杆率上限");
  await expect(reopened.getByTestId("citation-chip")).toHaveCount(2);
  await expectCitedPage(
    again.window,
    reopened,
    0,
    "Northwind Retail · 优先级贷款协议（节选）",
    "“EBITDA”指任一相关期间内集团扣除利息、税项、折旧及摊销前的合并经营利润，以该相关期间的合规证明所载数额为准。",
  );
  await expectCitedPage(
    again.window,
    reopened,
    1,
    "Northwind Retail · 2026 年第三季度业绩",
    "基础 EBITDA 为 9,600 万英镑，上年同期为 1.18 亿英镑。",
  );
  await again.app.close();
});

test("a Citation copied from an Answer about the example into a Mind opens its original page after the interface language becomes Chinese (#1830)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await openExample(window);
  await setWindowSize(app, window, 1440, 900);
  await useLocalChatModel(window);
  const answer = await askAboutExample(window, ENGLISH_QUESTION);
  await pointAndClick(window, answer.getByTestId("answer-write-note"));
  const copy = frontMind(window).getByTestId("mind-editor");
  await expect(copy.getByTestId("citation-chip")).toHaveCount(2);
  await expect(copy.getByTestId("citation-chip").first()).toHaveAttribute("data-check", "found");

  // The Conversation's Citations would keep the example as it is: only the copy is to.
  await (await coreOf(window)).evaluate(async (core) => {
    for (const { id } of await core.listConversations()) {
      await core.deleteConversation(id);
      await core.deletePermanently([{ kind: "conversation", id }]);
    }
  });

  await setLanguage(window, "zh-CN");
  const titles = await (await coreOf(window)).evaluate(async (core) =>
    (await core.listMinds()).map((mind) => mind.title),
  );
  expect(titles).toContain("Draft: credit committee paper");

  await expectCitedPage(
    window,
    copy,
    0,
    "Northwind Retail · Q3 2026 results",
    "Net debt to EBITDA was 3.1 times at the end of the quarter",
  );
  await expectCitedPage(
    window,
    copy,
    1,
    "Northwind Retail · Senior facilities agreement (excerpt)",
    "The Company shall ensure that Leverage in respect of each Relevant Period does not exceed 3.5:1.",
  );
  await app.close();
});
