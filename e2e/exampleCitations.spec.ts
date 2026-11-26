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

/** The credit paper's two Documents in each language, as its Citations name them. */
const DOCUMENTS = {
  en: [
    "Northwind Retail · Q3 2026 results",
    "Northwind Retail · Senior facilities agreement (excerpt)",
  ],
  "zh-CN": ["Northwind Retail · 2026 年第三季度业绩", "Northwind Retail · 优先级贷款协议（节选）"],
} as const;

/** A Citation as the core keeps it: the Document it names, the words it quotes and their page. */
interface Cited {
  documentName: string;
  quote: string;
  pageFrom: number | null;
}

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

/** An Answer's Citations, in the order of their markers, as the core keeps them. */
async function citationsOf(window: Page, answer: Locator): Promise<Cited[]> {
  const answerId = await answer.getAttribute("data-answer-id");
  return (await coreOf(window)).evaluate(async (core, id) => {
    for (const conversation of await core.listConversations()) {
      const { messages } = await core.getConversation(conversation.id);
      const found = messages.find((each) => each.id === id);
      if (found?.kind === "answer") {
        return found.citations.map(({ documentName, quote, pageFrom }) => ({
          documentName,
          quote,
          pageFrom,
        }));
      }
    }
    return [];
  }, answerId);
}

/**
 * A Question about the example asked in the assistant from its page, once its Citations show its
 * Documents are read: the scripted model answers it from each of them.
 */
async function askAboutExample(
  window: Page,
  question: string,
  documents: readonly string[],
): Promise<{ answer: Locator; cited: Cited[] }> {
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
  const cited = await citationsOf(window, answer);
  expect(cited.map((each) => each.documentName).sort()).toEqual([...documents].sort());
  return { answer, cited };
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
  { documentName, quote, pageFrom }: Cited,
): Promise<void> {
  const chip = answer.getByTestId("citation-chip").nth(index);
  await expect(chip).toHaveAttribute("data-check", "found");
  await pointAndClick(window, chip);
  await expect(window.getByTestId("viewer-removed")).toHaveCount(0);
  await expect(window.getByTestId("viewer-title")).toHaveText(documentName);
  await expect(window.getByTestId("pdf-page-number")).toHaveValue(String(pageFrom));
  const highlight = window
    .getByTestId("viewer")
    .locator(`[data-page-number="${pageFrom}"] [data-quote-highlight]`);
  await expect(highlight.first()).toBeInViewport();
  // The PDF's text layer can leave out a space between two words of a quote.
  const unspaced = (text: string) => text.replace(/\s+/g, "");
  await expect
    .poll(async () => unspaced((await highlight.allTextContents()).join("")))
    .toContain(unspaced(quote));
  await window.keyboard.press("Escape");
}

async function expectEachCitedPage(
  window: Page,
  answer: Locator,
  cited: readonly Cited[],
): Promise<void> {
  for (const [index, citation] of cited.entries()) {
    await expectCitedPage(window, answer, index, citation);
  }
}

test("an English Conversation's Citations open their original pages after the interface language becomes Chinese, and after a restart (#1794)", async () => {
  const first = await launchApp(dataDir, { examples: true, fakeChat: true });
  await openExample(first.window);
  await setWindowSize(first.app, first.window, 1440, 900);
  await useLocalChatModel(first.window);
  const { answer, cited } = await askAboutExample(
    first.window,
    "What does each Document say about leverage?",
    DOCUMENTS.en,
  );
  await first.window.keyboard.press("Escape");

  await setLanguage(first.window, "zh-CN");
  await expectEachCitedPage(first.window, answer, cited);
  await expect(mindTitle(first.window)).toHaveText("Draft: credit committee paper");
  await first.app.close();

  const again = await launchApp(dataDir, { examples: true, fakeChat: true });
  await setWindowSize(again.app, again.window, 1440, 900);
  const reopened = await openFromPalette(again.window, "leverage");
  await expect(reopened.getByTestId("citation-chip")).toHaveCount(2);
  expect(await citationsOf(again.window, reopened)).toEqual(cited);
  await expectEachCitedPage(again.window, reopened, cited);
  await again.app.close();
});

test("a Chinese Conversation's Citations open their original pages after the interface language becomes English, and after a restart (#1794)", async () => {
  const first = await launchApp(dataDir, { examples: true, fakeChat: true });
  await openExample(first.window);
  await setWindowSize(first.app, first.window, 1440, 900);
  await setLanguage(first.window, "zh-CN");
  await expect(mindTitle(first.window)).toHaveText("授信委员会报告（草稿）", { timeout: 30_000 });
  await useLocalChatModel(first.window);
  const { answer, cited } = await askAboutExample(
    first.window,
    "每份文档 each 对杠杆率上限怎么说？",
    DOCUMENTS["zh-CN"],
  );
  await first.window.keyboard.press("Escape");

  await setLanguage(first.window, "en");
  await expectEachCitedPage(first.window, answer, cited);
  await expect(mindTitle(first.window)).toHaveText("授信委员会报告（草稿）");
  await first.app.close();

  const again = await launchApp(dataDir, { examples: true, fakeChat: true });
  await setWindowSize(again.app, again.window, 1440, 900);
  const reopened = await openFromPalette(again.window, "杠杆率上限");
  await expect(reopened.getByTestId("citation-chip")).toHaveCount(2);
  expect(await citationsOf(again.window, reopened)).toEqual(cited);
  await expectEachCitedPage(again.window, reopened, cited);
  await again.app.close();
});

test("a Citation copied from an Answer about the example into a Mind opens its original page after the interface language becomes Chinese (#1830)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await openExample(window);
  await setWindowSize(app, window, 1440, 900);
  await useLocalChatModel(window);
  const { answer, cited } = await askAboutExample(
    window,
    "What does each Document say about leverage?",
    DOCUMENTS.en,
  );
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

  await expectEachCitedPage(window, copy, cited);
  await app.close();
});
