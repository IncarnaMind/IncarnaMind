import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { formatDate } from "../src/shared/dates";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  addToNote,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  tabMenu,
  useLocalChatModel,
} from "./app";

/*
 * Export AI use statement (#739): from a Mind's ⋯ menu and from ⌘K, the
 * counts of what the Mind records of AI use open as a new Mind in a tab beside
 * it, to edit. The Mind the User is in stays open and as it was; Undo takes
 * the new one back to Recently deleted. Set INCARNAMIND_SCREENSHOTS to a folder
 * to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
]);

const TEXTS = {
  en: {
    heading: "Methods",
    command: "Export AI use statement",
    title: "AI use statement: Thesis",
    sections: ["AI models and what they were used for", "AI text, by section", "Checks"],
    undo: "Undo",
    added: "Answers added to the note",
    found: "Quote found",
    note: "Schools have their own forms for declaring AI use. Use these counts to fill in yours.",
    empty:
      "There is nothing to report: IncarnaMind has no record of AI use in this note, and the note has no Citations or checks.",
    checkedUse: "Sentences checked against the Documents",
    usesColumns: ["Use", "Model", "Times"],
    sentenceColumns: ["Sentence", "Result", "Model", "Checked"],
    supported: "Supported",
    notFound: "Not found",
    unsupported: "Unsupported",
    noRecord: "has no record of AI writing",
    checkedIntro:
      "Sentences the author had checked against the Documents, with Check against Documents, by result:",
  },
  "zh-CN": {
    heading: "第一章 绪论",
    command: "导出 AI 使用声明",
    title: "AI 使用声明：Thesis",
    sections: [
      "一、使用的 AI 模型及用途",
      "二、AI 生成文字的保留与改写（按章节）",
      "三、引用与说法的核对",
    ],
    undo: "撤销",
    added: "将助手的回答加入笔记",
    found: "找到引文",
    note: "各学校对 AI 使用声明另有格式要求，请以学校提供的表格为准，可据此处的统计数字填写。",
    empty: "无可说明的内容：IncarnaMind 中没有这篇笔记使用 AI 的记录，笔记中也没有引用和核对结果。",
    checkedUse: "对照文档核对句子",
    usesColumns: ["用途", "模型", "次数"],
    sentenceColumns: ["句子", "核对结果", "模型", "核对日期"],
    supported: "有依据",
    notFound: "未找到",
    unsupported: "无依据",
    noRecord: "中没有这篇笔记使用 AI 撰写",
    checkedIntro: "以下是“对照文档核对”的结果：",
  },
} as const;

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

const editorOf = (window: Page) => window.getByTestId("mind-editor").filter({ visible: true });
const tabs = (window: Page) => window.getByRole("tab");

/** A new Mind, "Thesis", with a heading and an Answer from the assistant added under it, Citation and all. */
async function writeThesis(window: Page, heading: string): Promise<Locator> {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await newMind(window);
  await nameMind(window, "Thesis");
  const editor = editorOf(window);
  await editor.click();
  await window.keyboard.type(`# ${heading}`);
  await window.keyboard.press("Enter");
  await addToNote(window, await askInAssistant(window, "When do spring tides happen?"));
  await expect(editor.getByTestId("citation")).toHaveCount(1);
  await expect(editor.getByTestId("citation")).toHaveAttribute("data-check", "found");
  return editor;
}

/** Each table of a Mind as rows of cell text. */
const tablesOf = (editor: Locator) =>
  editor
    .locator("table")
    .evaluateAll((tables) =>
      tables.map((table) =>
        [...table.querySelectorAll("tr")].map((row) =>
          [...row.querySelectorAll("th, td")].map((cell) => cell.textContent?.trim() ?? ""),
        ),
      ),
    );

/** Runs the command from the Mind's row ⋯ menu, or from ⌘K, as a person does. */
async function runCommand(
  window: Page,
  via: "menu" | "palette",
  text: (typeof TEXTS)[keyof typeof TEXTS],
  shot: string,
): Promise<void> {
  if (via === "menu") {
    const row = window.getByTestId("mind-row").filter({ hasText: "Thesis" });
    await pointAt(window, row);
    await pointAndClick(window, row.getByTestId("mind-menu"));
    const menu = row.getByTestId("mind-actions");
    // In the menu's order: right after Export….
    const ids = await menu
      .getByRole("menuitem")
      .evaluateAll((items) => items.map((item) => item.getAttribute("data-testid")));
    expect(ids.indexOf("mind.aiUseStatement")).toBe(ids.indexOf("mind.exportMenu") + 1);
    await expect(menu.getByTestId("mind.aiUseStatement")).toHaveText(text.command);
    await screenshot(window, `${shot}-menu`);
    await pointAndClick(window, menu.getByTestId("mind.aiUseStatement"));
  } else {
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.type(">");
    const item = window.getByTestId("palette").locator('[data-key="command:mind.aiUseStatement"]');
    await expect(item).toContainText(text.command);
    await screenshot(window, `${shot}-palette`);
    await pointAndClick(window, item);
  }
}

const CASES = [
  { language: "en", width: 1600, via: "menu" },
  { language: "zh-CN", width: 900, via: "palette" },
  { language: "en", width: 900, via: "palette" },
  { language: "zh-CN", width: 1600, via: "menu" },
] as const;

for (const { language, width, via } of CASES) {
  test(`${via === "menu" ? "from the Mind's ⋯ menu" : "from ⌘K"} it opens in a new tab beside the Mind, to edit, and Undo takes it back (${language}, ${width} px)`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, width, 800);
    const text = TEXTS[language];
    const shot = `ai-statement-${language}-${width}`;
    const thesis = await writeThesis(window, text.heading);
    const written = await thesis.innerText();
    const found = await thesis.locator('[data-testid="citation"][data-check="found"]').count();
    await expect(tabs(window)).toHaveCount(1);

    await runCommand(window, via, text, shot);

    // A new tab right after the Mind's, in front; the Mind is still open in its own.
    await expect(tabs(window)).toHaveCount(2);
    await expect(tabs(window).nth(0)).toContainText("Thesis");
    await expect(tabs(window).nth(1)).toContainText(text.title);
    await expect(tabs(window).nth(1)).toHaveAttribute("aria-selected", "true");
    const statement = editorOf(window);
    await expect(statement.getByRole("heading")).toHaveText(text.sections);
    await expect(window.getByTestId("undo-message")).toHaveCount(0);
    await screenshot(window, shot);

    // The counts are the Mind's: its Answer added once, its one Citation found, its heading's section.
    const [uses, byHeading, citations] = await tablesOf(statement);
    expect(uses?.at(-1)).toEqual([text.added, "fake-model", "1"]);
    expect(byHeading?.at(1)?.slice(0, 3)).toEqual([text.heading, "1", "0"]);
    expect(Number(byHeading?.at(1)?.[3])).toBeGreaterThan(0);
    expect(citations?.at(1)).toEqual([text.found, String(found)]);
    await expect(statement.locator(":scope > p").last()).toHaveText(text.note);
    await statement.locator(":scope > p").last().scrollIntoViewIfNeeded();
    await screenshot(window, `${shot}-end`);

    // The tables sit inside the Mind's text, and the page doesn't scroll sideways.
    const card = await statement.boundingBox();
    for (const table of await statement.locator("table").all()) {
      const box = await table.boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
        (card?.x ?? 0) + (card?.width ?? 0) + 1,
      );
    }
    expect(
      await window.evaluate(() => document.documentElement.scrollWidth <= globalThis.innerWidth),
    ).toBe(true);

    // ⌘Z never takes it back: Delete sends it to Recently deleted, and Undo brings it back.
    await window.getByTestId("plus-menu").focus();
    await window.keyboard.press("ControlOrMeta+z");
    await expect(tabs(window)).toHaveCount(2);
    await pointAndClick(window, (await tabMenu(window)).getByTestId("mind.delete"));
    await expect(tabs(window)).toHaveCount(1);
    await expect(tabs(window).nth(0)).toContainText("Thesis");
    await expect(window.getByTestId("undo-action")).toHaveText(text.undo);
    await pointAndClick(window, window.getByTestId("undo-action"));
    await pointAndClick(
      window,
      window.getByTestId("mind-list-item").filter({ hasText: text.title }),
    );
    await expect(tabs(window)).toHaveCount(2);
    await expect(tabs(window).nth(1)).toContainText(text.title);
    await expect(statement.getByRole("heading")).toHaveText(text.sections);

    // It is the User's to edit: a plain Mind, its text theirs.
    await expect(statement).toHaveAttribute("contenteditable", "true");
    const first = statement.locator(":scope > p").first();
    await first.click();
    await window.keyboard.type("Reworded. ");
    await expect(first).toContainText("Reworded. ");

    // The Mind it is of is open as it was, one click away.
    await pointAndClick(window, tabs(window).nth(0));
    await expect(editorOf(window).getByTestId("citation")).toHaveCount(1);
    expect(await editorOf(window).innerText()).toBe(written);
  });
}

test("an empty Mind says there is nothing to report, not a table of zeros, in both languages", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 900, 700);
  for (const language of ["en", "zh-CN"] as const) {
    await setLanguage(window, language);
    const text = TEXTS[language];
    await newMind(window);
    await nameMind(window, "Thesis");
    const before = await tabs(window).count();

    await runCommand(window, "palette", text, `ai-statement-empty-${language}`);

    await expect(tabs(window)).toHaveCount(before + 1);
    const statement = editorOf(window);
    await expect(statement.locator(":scope > p").nth(1)).toHaveText(text.empty);
    await expect(statement.locator("table")).toHaveCount(0);
    await expect(statement.getByRole("heading")).toHaveCount(0);
    await expect(statement.locator(":scope > p").last()).toHaveText(text.note);
    await screenshot(window, `ai-statement-empty-${language}`);
  }
});

for (const language of ["en", "zh-CN"] as const) {
  test(`sentences checked in the Mind are listed in the statement, each with its result, model and date (${language})`, async () => {
    const text = TEXTS[language];
    const sentences = [
      "Spring tides happen at new and full moon.",
      "Penguins nest on the harbour cliffs.",
    ];
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 900);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    await newMind(window);
    await nameMind(window, "Thesis");
    const editor = editorOf(window);
    await editor.click();
    await window.keyboard.type(sentences.join(" "));
    const line = editor.locator(":scope > p").first();
    await expect(line).toHaveText(sentences.join(" "));

    const started = new Date();
    await slideSelect(window, line, "Spring tides", { line, words: "harbour cliffs." });
    await pointAndClick(
      window,
      window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
    );
    const marks = window.getByTestId("claim-mark");
    await expect(marks.and(window.locator("[data-check=supported]"))).toHaveCount(1);
    await expect(marks.and(window.locator("[data-check=unsupported]"))).toHaveCount(1);

    await runCommand(window, "palette", text, `ai-statement-checks-${language}`);

    const statement = editorOf(window);
    await expect(statement.getByRole("heading")).toHaveText(text.sections);
    const [uses, , listed] = await tablesOf(statement);
    expect(uses).toEqual([text.usesColumns, [text.checkedUse, "fake-model", "2"]]);
    const days = [formatDate(started, language), formatDate(new Date(), language)];
    const [head, ...rows] = listed ?? [];
    expect(head).toEqual(text.sentenceColumns);
    expect(rows.map((row) => row.slice(0, 3))).toEqual([
      [sentences[0], text.supported, "fake-model"],
      [sentences[1], text.notFound, "fake-model"],
    ]);
    for (const row of rows) expect(days).toContain(row[3]);
    await expect(statement.getByText(text.noRecord)).toHaveCount(0);
    await expect(statement.getByText(text.checkedIntro, { exact: true })).toBeVisible();
    await screenshot(window, `ai-statement-checks-${language}`);
    await statement.locator(":scope > p").last().scrollIntoViewIfNeeded();
    await screenshot(window, `ai-statement-checks-${language}-end`);
    for (const width of [900, 1440]) {
      await setWindowSize(app, window, width, 900);
      await statement.getByText(text.checkedIntro, { exact: true }).scrollIntoViewIfNeeded();
      await screenshot(window, `ai-statement-checks-${language}-intro-${width}`);
    }
  });
}
