import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  addDocuments,
  askInAssistant,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  launchApp,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setWindowSize,
} from "./app";

/**
 * Add to note (#702): a table's Citation stays on its cells, Answers land in
 * the order they were added, and only an Answer's content goes in, not the
 * lead-in before it or the closing note after it.
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

const CASES = [
  {
    name: "English",
    language: "en",
    file: "Tides.md",
    text: "# Tides\n\nSpring tides happen at new moon and at full moon.\n",
    tableQuestion: "Spring tides revenue table, cited below, framed",
    questions: ["Alpha question one", "Beta question two", "Gamma question three"],
    answerLine: (question: string) => `This is a scripted Answer to: ${question}`,
    lead: "Here is a draft",
    note: "Note: this is only a draft.",
  },
  {
    name: "Chinese",
    language: "zh-CN",
    file: "潮汐.md",
    text: "# 潮汐\n\n大潮发生在新月和满月的时候，太阳和月球的引力叠加。\n",
    tableQuestion: "大潮的收入表，引用在下，带说明",
    questions: ["第一个提问", "第二个提问", "第三个提问"],
    answerLine: (question: string) => `This is a scripted Answer to: ${question}`,
    lead: "以下是草稿",
    note: "注：以上仅为草稿。",
  },
] as const;

const blocksOf = (editor: Locator) =>
  editor.locator(":scope > *").evaluateAll((all) =>
    all.map((block) => {
      const copy = block.cloneNode(true) as Element;
      for (const citation of copy.querySelectorAll('[data-testid="citation"]')) citation.remove();
      return (copy.textContent ?? "").trim();
    }),
  );

async function start(language: "en" | "zh-CN", file: string, text: string) {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await connectLocalChatModel(window);
  await window.evaluate(
    (chosen) =>
      (
        globalThis as unknown as {
          incarnamind: { updateSettings(patch: unknown): Promise<unknown> };
        }
      ).incarnamind.updateSettings({ user: { language: chosen } }),
    language,
  );
  await writeFile(join(sources, file), text);
  await addDocuments(window, [join(sources, file)]);
  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-new-mind"));
  await enterContent(window);
  return { app, window, editor: window.getByTestId("mind-editor") };
}

const addAnswer = async (window: Page, answer: Locator) => {
  await pointAt(window, answer.getByTestId("assistant-answer-text"));
  await pointAndClick(window, answer.getByTestId("answer-add"));
  await expect(answer.getByTestId("answer-added")).toBeVisible();
};

for (const each of CASES) {
  test(`a table's Citation stays on its cells, and only the content goes in, not the lead-in or the closing note (${each.name})`, async () => {
    const { app, window, editor } = await start(each.language, each.file, each.text);
    const answer = await askInAssistant(window, each.tableQuestion);
    await expect(answer).toContainText(each.lead);
    await addAnswer(window, answer);

    const table = editor.locator("table");
    await expect(table).toHaveCount(1);
    // The two data rows' figure cells carry the Citation; the table holds no loose Citation after it.
    await expect(
      table.locator("tr").nth(1).locator("td").nth(1).getByTestId("citation"),
    ).toHaveCount(1);
    await expect(
      table.locator("tr").nth(2).locator("td").nth(1).getByTestId("citation"),
    ).toHaveCount(1);
    const blocks = await blocksOf(editor);
    expect(blocks.filter((text) => text.includes(each.lead) || text.includes(each.note))).toEqual(
      [],
    );
    expect(
      await editor
        .locator(":scope > p")
        .evaluateAll(
          (all) =>
            all.filter((p) => p.querySelector('[data-testid="citation"]') && !p.textContent?.trim())
              .length,
        ),
    ).toBe(0);
    await expect(window.getByTestId("check-badge").locator('[data-part="notFound"]')).toHaveCount(
      0,
    );

    // A chart made from that table: every value carries the Citation.
    await pointAndClick(window, table.locator("td").nth(1));
    await pointAndClick(window, window.getByTestId("table-menu"));
    await pointAndClick(window, window.getByTestId("chart.fromTable"));
    const chart = editor.getByTestId("chart");
    await expect(chart).toHaveCount(1);
    await expect(chart.getByTestId("chart-point")).toHaveCount(2);
    await expect(chart.getByTestId("chart-source")).not.toContainText(/no Citation|没有引用/);
    await pointAt(window, chart.getByTestId("chart-point").first());
    await expect(window.getByTestId("chart-check")).toHaveAttribute("data-check", "found");
    await app.close();
  });

  test(`Answers added one after another land in that order, without clicking in the note (${each.name})`, async () => {
    const { app, window, editor } = await start(each.language, each.file, each.text);
    await editor.click();
    for (const question of each.questions) {
      const answer = await askInAssistant(window, question);
      await addAnswer(window, answer);
    }
    const blocks = await blocksOf(editor);
    const at = each.questions.map((question) =>
      blocks.findIndex((text) => text.includes(each.answerLine(question))),
    );
    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    await app.close();
  });
}
