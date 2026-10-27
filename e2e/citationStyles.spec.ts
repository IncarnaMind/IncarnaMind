import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge, ReferencePatch } from "../src/core/api";
import { readPackIndex } from "../src/core/citationStyles/pack";
import type { TestHooks } from "../src/shared/testHooks";
import { paragraphsOf, part, unzip } from "../tests/helpers/docx";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  addToNote,
  askInAssistant,
  useOutputLocation as chooseOutputLocation,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  documentIdOf,
  exportFromMenu,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sidebarFolder,
  useLocalChatModel,
} from "./app";

/** Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots. */
async function screenshot(target: Page | Locator, name: string): Promise<void> {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (folder) await target.screenshot({ path: join(folder, `${name}.png`) });
}

/** Spring tides are on page 2. */
const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
]);

const TIDES_RECORD: ReferencePatch = {
  type: "article-journal",
  title: "Tides and the Moon",
  authors: [
    { family: "Bowler", given: "Diana E." },
    { family: "Buyung-Ali", given: "Lisette" },
  ],
  issued: "2010",
  containerTitle: "Ocean Review",
  volume: "12",
  pages: "1–20",
  language: "en",
};

/** Sets a Document's reference record, as its "Cite as" panel would. */
const setRecord = (window: Page, documentId: string, patch: ReferencePatch) =>
  window.evaluate(
    ([id, fields]) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateReference(
        id,
        fields,
      ),
    [documentId, patch] as const,
  );

/** A master's thesis: its cover, set as Chinese universities set one, then a page of its text. */
const THESIS = buildPdf([
  {
    printed: [
      { text: "硕士学位论文", size: 26 },
      { text: "城市绿地与夏季降温调查", size: 20 },
      { text: "作者姓名：林小雨", size: 14 },
      { text: "指导教师：王建国 教授", size: 14 },
      { text: "培养单位：华东师范大学地理科学学院", size: 14 },
      { text: "二〇二六年五月", size: 14 },
    ],
  },
  { chineseLines: ["城市绿地使夏季夜间平均降温一摄氏度。"] },
]);

/** A Chinese journal article: its title large, its authors under it, and its DOI. */
const ARTICLE = buildPdf([
  {
    printed: [
      { text: "地理学报 2024 年 3 月", size: 9 },
      { text: "城市绿地对热岛效应的缓解作用", size: 18 },
      { text: "张三 1，李四 2", size: 11 },
      { text: "（1. 北京大学城市与环境学院，北京 100871）", size: 9 },
      { text: "摘要：城市绿地在夏季夜间缓解城市热岛效应。", size: 10 },
      { text: "文献标识码：A", size: 9 },
      { text: "DOI: 10.5555/greenspace-2024", size: 9 },
    ],
  },
]);

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

/**
 * Asks a Question from a new Mind, in the assistant (#201), and adds its
 * Answer to the Mind, as a person keeps one; resolves with the Mind's text,
 * where its Citations now are.
 */
async function ask(window: Page, text: string): Promise<Locator> {
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await pointAndClick(window, editor);
  await addToNote(window, await askInAssistant(window, text));
  await expect(editor.getByTestId("citation").first()).toBeVisible();
  return editor;
}

/** Chooses a style in the open picker, typing to find it and pressing Enter, as a person would. */
async function chooseStyle(window: Page, search: string, label: string): Promise<void> {
  const picker = window.getByTestId("citation-style-picker");
  const field = picker.getByTestId("citation-style-search");
  await expect(field).toBeFocused();
  await window.keyboard.type(search);
  await expect(picker.getByTestId("citation-style-option-label").first()).toHaveText(label);
  await window.keyboard.press("Enter");
  await expect(picker).toBeHidden();
}

async function openPickerFromRow(window: Page, row: Locator): Promise<void> {
  await row.hover();
  await pointAndClick(window, row.getByTestId("mind-menu"));
  await pointAndClick(window, row.getByTestId("mind.citationStyle"));
}

const holdStyleCatalogue = (window: Page, hold: boolean) =>
  window.evaluate((held) => {
    const hooks = (globalThis as { incarnamindTestHooks?: TestHooks }).incarnamindTestHooks;
    if (!hooks) throw new Error("Test hooks are off: launch with INCARNAMIND_TEST_HOOKS=1.");
    hooks.holdStyleCatalogue(held);
  }, hold);

test("a Mind citing a paper offers a citation style; chosen, its Citations and References read in it, the References' picker switches it, with Undo, and the export follows", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  await writeFile(join(sources, "Lease agreement.txt"), "Spring rent is due at the new moon.");
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf"), join(sources, "Lease agreement.txt")]);
  await setRecord(window, await documentIdOf(window, "Tides"), TIDES_RECORD);

  // "each": one Citation of each Document, side by side. A Mind is Numbered until it chooses:
  // numbered markers, and no References.
  const answer = await ask(window, "When do spring tides happen in each?");
  const chips = answer.getByTestId("citation-chip");
  await expect(chips).toHaveText(["1", "2"]);
  const references = window.getByTestId("references");
  await expect(references).toHaveCount(0);

  // It cites a paper (Tides has a record with its authors), so once the User has a second note
  // its end offers a style, APA first in English. Chosen, APA 7 writes the two side by side as one.
  await (await coreOf(window)).evaluate((core) => core.createMind({ title: "Second note" }));
  const prompt = window.getByTestId("citation-style-prompt");
  await expect(prompt).toHaveText("Choose a citation style? APA · GB/T 7714 · More…");
  await screenshot(window, "citation-style-prompt-en");
  await pointAndClick(window, prompt.getByTestId("citation-style-prompt-choice").first());
  await expect(prompt).toHaveCount(0);
  await expect(window.getByTestId("undo-line")).toContainText("Citation style changed to APA 7");
  const styled = answer.locator('[data-testid="citation"][data-styled="runs"]');
  await expect(styled).toHaveCount(1);
  await expect(styled.getByTestId("citation-chip")).toHaveText(
    /^\(Bowler & Buyung-Ali, 2010, p\. 2; Lease Agreement, n\.d\., Line 1\)$/,
  );
  // The second Citation is drawn by the first, with its own check on its words.
  await expect(answer.locator('[data-testid="citation"][data-styled="joined"]')).toHaveCount(1);
  await expect(styled.locator('[data-work="1"]').first()).toHaveAttribute("data-check", "found");
  await expect(styled.locator(".citation-run-icon")).toHaveCount(0);
  // A work whose quote isn't found has its mark before its words, so colour isn't the only cue.
  const setSecondCheck = (check: string, checkReason: string | null) =>
    answer.evaluate(
      (dom, change) => {
        const { view } = (dom as unknown as { editor: Editor }).editor;
        const tr = view.state.tr;
        let seen = 0;
        view.state.doc.descendants((node, pos) => {
          if (node.type.name === "citation" && ++seen === 2) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...change });
          }
        });
        view.dispatch(tr);
      },
      { check, checkReason },
    );
  await setSecondCheck("not-found", "quote-not-on-pages");
  await expect(styled.locator('[data-work="1"]').first()).toHaveAttribute(
    "data-check",
    "not-found",
  );
  await expect(styled.locator('[data-work="1"] .citation-run-icon')).toHaveCount(1);
  await expect(styled.locator('[data-work="0"] .citation-run-icon')).toHaveCount(0);
  await setSecondCheck("found", null);
  await expect(styled.locator(".citation-run-icon")).toHaveCount(0);

  // Over a work's words, the pointer shows that Citation's card.
  const chip = styled.getByTestId("citation-chip");
  await chip.locator('[data-work="1"]').first().hover();
  const card = window.getByTestId("citation-card");
  await expect(card).toContainText("Lease agreement");
  // Moving on to the first work's words: its card shows, and the other's goes.
  await chip.locator('[data-work="0"]').first().hover();
  await expect(card.filter({ hasText: "Tides" })).toBeVisible();
  await expect(card).toHaveCount(1);

  // The References: each Document once, in APA 7, the thin one by its name, needing details.
  await expect(references).toHaveAttribute("data-style", "apa");
  await expect(references.getByTestId("references-style")).toHaveText("APA 7");
  const entries = references.getByTestId("reference-entry");
  await expect(entries).toHaveCount(2);
  await expect(entries.first()).toContainText(
    "Bowler, D. E., & Buyung-Ali, L. (2010). Tides and the Moon. Ocean Review, 12, 1–20.",
  );
  await expect(entries.nth(1)).toHaveAttribute("data-needs-details", "true");
  await expect(entries.nth(1)).toContainText("Lease agreement.");
  await expect(entries.nth(1)).not.toContainText("added");
  await screenshot(window, "references-apa-en");

  // "Needs details" opens the Document's "Cite as" right there, at its first gap, its title.
  // Esc leaves the field, then closes the panel, giving the focus back.
  const needs = entries.nth(1).getByTestId("reference-needs-details");
  await pointAndClick(window, needs);
  const citeAs = window.getByTestId("reference-cite-as");
  await expect(citeAs).toBeVisible();
  await expect(citeAs.locator("input:focus, textarea:focus")).toHaveCount(1);
  await screenshot(window, "references-cite-as-en");
  await window.keyboard.press("Escape");
  await expect(citeAs.locator("input:focus, textarea:focus")).toHaveCount(0);
  await window.keyboard.press("Escape");
  await expect(citeAs).toBeHidden();
  await expect(needs).toBeFocused();

  // An edit to a record reaches the References and the Citation.
  await setRecord(window, await documentIdOf(window, "Tides"), { issued: "2011" });
  await expect(chip).toContainText("Bowler & Buyung-Ali, 2011, p. 2");
  await expect(entries.first()).toContainText("(2011)");

  // The style button opens the picker: IEEE numbers them, in the text and the References.
  await pointAndClick(window, references.getByTestId("references-style"));
  await chooseStyle(window, "ieee", "IEEE");
  await expect(references).toHaveAttribute("data-style", "ieee");
  await expect(chip).toHaveText("[1, p. 2], [2, L. 1]");
  await expect(entries.first().locator(".references-label")).toHaveText("[1]");
  await expect(window.getByTestId("undo-line")).toContainText("Citation style changed to IEEE");
  await screenshot(window, "references-ieee-en");

  // ⌘Z takes it back.
  await references.getByTestId("references-style").focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(references).toHaveAttribute("data-style", "apa");
  await expect(chip).toContainText("Bowler & Buyung-Ali, 2011, p. 2");

  // A note style: the chip is the note's number, and the card shows the note.
  await pointAndClick(window, references.getByTestId("references-style"));
  await chooseStyle(window, "notes", "Chicago (notes and bibliography)");
  await expect(answer.locator('[data-testid="citation"][data-styled="note"]')).toHaveCount(1);
  const note = answer.locator('[data-testid="citation"][data-styled="note"]');
  await expect(note.getByTestId("citation-chip")).toHaveText("1");
  await note.getByTestId("citation-chip").hover();
  await expect(card.getByTestId("citation-styled-note")).toContainText(
    "Diana E. Bowler and Lisette Buyung-Ali",
  );
  await screenshot(window, "references-chicago-notes-en");

  // The export is in the Mind's style: Chicago notes become Word footnotes, with the Bibliography.
  const target = join(sources, "Untitled.docx");
  await chooseOutputLocation(window, sources);
  await window.keyboard.press("Escape");
  await pointAndClick(window, references.getByTestId("references-export"));
  const dialog = window.getByTestId("export-dialog");
  await expect(dialog.getByTestId("export-citation-style")).toHaveText(
    "Chicago (notes and bibliography)",
  );
  // The options sheet's own style button switches it back to APA 7, for the Mind and so its
  // exports; Save options keeps Word, and Export makes the file.
  await pointAndClick(window, dialog.getByTestId("export-citation-style"));
  await chooseStyle(window, "apa", "APA 7");
  await expect(dialog.getByTestId("export-citation-style")).toHaveText("APA 7");
  await screenshot(window, "export-dialog-style-en");
  await pointAndClick(window, dialog.getByTestId("export-save"));
  await expect(dialog).toBeHidden();
  await exportFromMenu(window);
  const done = window.getByTestId("export-result").getByTestId("export-done");
  await expect(done).toContainText(/^Saved “.+\.docx” in /);
  const saved = (await done.getAttribute("title")) ?? target;
  const text = paragraphsOf(part(unzip(await readFile(saved)), "word/document.xml")).map(
    (each) => each.text,
  );
  expect(text).toContain("References");
  expect(text.some((line) => line.includes("(Bowler & Buyung-Ali, 2011, p. 2; "))).toBe(true);
  await app.close();
});

test("in Chinese: the offer puts GB/T 7714 first; chosen, raised numbers and 参考文献, and the picker finds 国标 styles; a narrow window keeps the header on its lines", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  await writeFile(join(sources, "复杂系统.txt"), "开放的复杂巨系统是一个科学新领域。");
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "zh-CN" },
    }),
  );
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf"), join(sources, "复杂系统.txt")]);
  await setRecord(window, await documentIdOf(window, "Tides"), TIDES_RECORD);
  await setRecord(window, await documentIdOf(window, "复杂系统"), {
    type: "article-journal",
    title: "一个科学新领域——开放的复杂巨系统及其方法论",
    authors: [{ literal: "钱学森" }, { literal: "于景元" }, { literal: "戴汝为" }],
    issued: "1990",
    containerTitle: "自然杂志",
    language: "zh",
  });

  const answer = await ask(window, "开放的复杂巨系统 each");
  await (await coreOf(window)).evaluate((core) => core.createMind({ title: "第二篇笔记" }));
  const prompt = window.getByTestId("citation-style-prompt");
  await expect(prompt).toHaveText("选择引用格式？GB/T 7714 · APA · 更多…");
  await screenshot(window, "citation-style-prompt-zh");
  await pointAndClick(window, prompt.getByTestId("citation-style-prompt-choice").first());
  const styled = answer.locator('[data-testid="citation"][data-styled="runs"]').first();
  // A page raised after its number, as GB/T 7714 prints one; lines in brackets: "[1]（第 1 行）".
  await expect(styled.getByTestId("citation-chip")).toHaveText(/^(\[\d\](\d+|（第 \d+ 行）)?)+$/);
  // The numbers raised; a chip with a Location on the line stays on the line itself.
  await expect(
    styled.getByTestId("citation-chip").locator("sup").filter({ hasText: /\d/ }).first(),
  ).toBeVisible();

  const references = window.getByTestId("references");
  await expect(references).toHaveAttribute("data-style", "gb-t-7714-2015-numeric");
  await expect(references.getByRole("heading")).toHaveText("参考文献");
  await expect(references.getByTestId("references-style")).toHaveText(
    "GB/T 7714—2015（顺序编码制）",
  );
  await expect(
    references.getByTestId("reference-entry").filter({ hasText: "钱学森" }),
  ).toContainText(
    "钱学森, 于景元, 戴汝为. 一个科学新领域——开放的复杂巨系统及其方法论[J]. 自然杂志, 1990.",
  );
  await screenshot(window, "references-gbt-zh");

  // Typed in Chinese, the picker finds the national standard's styles; the author-date one
  // writes an English work with "et al." and a Chinese one with 等.
  await pointAndClick(window, references.getByTestId("references-style"));
  const picker = window.getByTestId("citation-style-picker");
  await window.keyboard.type("国标");
  await expect(picker.getByTestId("citation-style-option")).toHaveCount(4);
  await screenshot(window, "citation-style-picker-zh");
  await window.keyboard.press("ArrowDown");
  await window.keyboard.press("Enter");
  await expect(references).toHaveAttribute("data-style", "gb-t-7714-2015-author-date");
  await expect(window.getByTestId("undo-line")).toContainText(
    "引用格式已改为 GB/T 7714—2015（著者-出版年制）",
  );

  // At the narrowest window the header wraps by word and nothing spills out of the column.
  await setWindowSize(app, window, 900, 660);
  await expect(window.getByTestId("assistant")).toHaveAttribute("data-dock", "bottom");
  const column = await window.getByTestId("mind-pane").boundingBox();
  const head = await references.locator(".references-head").boundingBox();
  if (!column || !head) throw new Error("The References or the Mind aren't on screen.");
  expect(head.x + head.width).toBeLessThanOrEqual(column.x + column.width + 1);
  await screenshot(window, "references-narrow-zh");
  await app.close();
});

test("in Chinese, a thesis Mind: 引用信息 read from the PDFs waits to be checked; GB/T 7714 by default, in the Export menu; pages raised, and a thin entry written with its name alone, named after the export", async () => {
  await writeFile(join(sources, "林小雨学位论文.pdf"), THESIS);
  await writeFile(join(sources, "绿地与热岛.pdf"), ARTICLE);
  await writeFile(join(sources, "城市绿地调查笔记.txt"), "城市绿地调查：公园比周围街道凉快。");
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "zh-CN" },
    }),
  );
  await useLocalChatModel(window);
  await addDocuments(
    window,
    ["林小雨学位论文.pdf", "绿地与热岛.pdf", "城市绿地调查笔记.txt"].map((name) =>
      join(sources, name),
    ),
  );

  // The thesis's 引用信息 came from its cover, and waits in the Library to be checked.
  await window.getByTestId("open-library").click();
  const thesisRow = window.getByTestId("library-document").filter({ hasText: "林小雨学位论文" });
  const toggle = thesisRow.getByTestId("cite-as-toggle");
  await expect(toggle).toHaveText("需要核对");
  await pointAndClick(window, toggle);
  const panel = thesisRow.getByTestId("cite-as");
  await expect(panel.getByTestId("reference-type")).toHaveValue("thesis");
  await expect(panel.getByTestId("reference-title")).toHaveText("城市绿地与夏季降温调查");
  await expect(panel.getByTestId("reference-authors")).toHaveText("林小雨");
  await expect(panel.getByTestId("reference-issued")).toHaveText("2026");
  await expect(panel.getByTestId("reference-publisher")).toHaveText("华东师范大学");
  await expect(panel.locator("dt[data-unchecked]")).toHaveCount(5);
  await screenshot(window, "cite-as-check-zh");
  await pointAndClick(window, panel.getByTestId("reference-confirm"));
  await expect(panel.locator("dt[data-unchecked]")).toHaveCount(0);
  await expect(toggle).toHaveText("引用信息");
  await expect(window.getByTestId("undo-line")).toContainText("已确认“林小雨学位论文”的引用信息");

  // A Mind in Chinese citing the three: GB/T 7714 by default, and it says so.
  const answer = await ask(window, "城市绿地 each");
  await pointAndClick(window, answer.locator("p").last());
  await window.keyboard.press("ControlOrMeta+End");
  await window.keyboard.press("Enter");
  await window.keyboard.type("本文梳理城市绿地对夏季降温的作用，并比较不同城市的热岛效应。");
  const references = window.getByTestId("references");
  await expect(references).toHaveAttribute("data-style", "gb-t-7714-2015-numeric");
  await expect(references.getByTestId("references-style")).toHaveText(
    "GB/T 7714—2015（顺序编码制）",
  );
  await expect(references.getByTestId("references-style-default")).toHaveText("默认");
  await expect(window.getByTestId("citation-style-prompt")).toHaveCount(0);
  const entries = references.getByTestId("reference-entry");
  await expect(entries.filter({ hasText: "林小雨" })).toContainText(
    "林小雨. 城市绿地与夏季降温调查[D]. 华东师范大学, 2026.",
  );
  await expect(entries.filter({ hasText: "张三" })).toContainText(
    "张三, 李四. 城市绿地对热岛效应的缓解作用[J/OL]. 2024. DOI:10.5555/greenspace-2024.",
  );
  const thin = entries.filter({ hasText: "城市绿地调查笔记" });
  await expect(thin).toHaveAttribute("data-needs-details", "true");
  // Each cited work on its own, its page raised after its number, lines in brackets: "[1]（第 1 行）[2]1[3]1".
  await expect(answer.getByTestId("citation-chip").first()).toHaveText(
    /^(\[\d\](\d+|（第 \d+ 行）)){3}$/,
  );
  await screenshot(window, "references-gbt-default-zh");

  // Where the User exports: the Export menu names the style, and opens the picker.
  await chooseOutputLocation(window, sources);
  await pointAndClick(window, window.getByTestId("export-mind"));
  const styleItem = window.getByTestId("export-citation-style-menu");
  await expect(styleItem).toHaveText("引用格式GB/T 7714—2015（顺序编码制）");
  await screenshot(window, "export-menu-style-zh");
  await pointAndClick(window, styleItem);
  const picker = window.getByTestId("citation-style-picker");
  await expect(picker).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(picker).toBeHidden();

  // Exported to Word: raised pages, 参考文献, and the thin entry written with its name alone,
  // never a placeholder in the file the User sends (#1910).
  await exportFromMenu(window, "docx");
  const result = window.getByTestId("export-result");
  const done = result.getByTestId("export-done");
  await expect(done).toHaveText(/\.docx/);
  const needs = result.getByTestId("export-needs-details");
  await expect(needs).toContainText("1 个文档缺少作者或日期");
  await expect(needs).toContainText("补充信息");
  await screenshot(window, "export-needs-details-zh");
  const saved = (await done.getAttribute("title")) ?? "";
  const paragraphs = paragraphsOf(part(unzip(await readFile(saved)), "word/document.xml")).map(
    (each) => each.text,
  );
  expect(paragraphs).toContain("参考文献");
  expect(paragraphs.some((line) => /(\[\d\](\d+|（第 \d+ 行）)){3}/.test(line))).toBe(true);
  expect(
    paragraphs.some((line) => line.includes("林小雨. 城市绿地与夏季降温调查[D]. 华东师范大学")),
  ).toBe(true);
  expect(paragraphs.some((line) => line.endsWith("城市绿地调查笔记."))).toBe(true);
  expect(paragraphs.join("\n")).not.toContain("信息待补充");
  expect(paragraphs.join("\n")).not.toContain("添加于");

  // Add details opens the thin entry's Cite as right there, at its first gap, its title.
  await pointAndClick(window, needs.getByTestId("export-needs-details-show"));
  const citeAs = window.getByTestId("reference-cite-as");
  await expect(citeAs).toBeVisible();
  await expect(citeAs.locator("input:focus, textarea:focus")).toHaveCount(1);
  await app.close();
});

test("in Chinese, a Mind that takes GB/T 7714 by default says so once on the undo line: Change opens the picker, Undo puts Numbered back, and it never shows again in that Mind", async () => {
  await writeFile(join(sources, "绿地与热岛.pdf"), ARTICLE);
  let session = await launchApp(dataDir, { fakeChat: true });
  let { window } = session;
  await dismissChatSetup(window);
  await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "zh-CN" },
    }),
  );
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "绿地与热岛.pdf")]);
  try {
    /** A new Mind citing the article, in Chinese, titled `title`. */
    const chineseMind = async (title: string) => {
      const editor = await ask(window, "城市绿地 each");
      await nameMind(window, title);
      await pointAndClick(window, editor.locator("p").last());
      await window.keyboard.press("ControlOrMeta+End");
      await window.keyboard.press("Enter");
      await window.keyboard.type("本文梳理城市绿地对夏季降温的作用，并比较不同城市的热岛效应。");
      return editor;
    };
    const message = window.getByTestId("undo-line").getByTestId("undo-message");
    const notice = "此笔记引用了论文，引用格式已设为 GB/T 7714—2015（顺序编码制）";

    // The first Mind: the line says so, with Change and Undo; Change opens the picker.
    await chineseMind("第一章");
    const references = window.getByTestId("references");
    await expect(references).toHaveAttribute("data-style", "gb-t-7714-2015-numeric");
    await expect(message).toHaveText(notice);
    await motionSettled(window);
    await screenshot(window, "default-style-notice-zh");
    await pointAndClick(window, window.getByTestId("undo-change-style"));
    const picker = window.getByTestId("citation-style-picker");
    await expect(picker).toBeVisible();
    await expect(message).toHaveCount(0);
    await window.keyboard.press("Escape");
    await expect(picker).toBeHidden();
    // Writing on, it doesn't say it again.
    await window.keyboard.type("城市绿地使夜间降温。");
    await expect(references).toHaveAttribute("data-style", "gb-t-7714-2015-numeric");
    await expect(message).toHaveCount(0);

    // The second Mind says it once too; Undo puts Numbered back, as the Mind's own choice.
    const second = await chineseMind("第二章");
    await expect(message).toHaveText(notice);
    await pointAndClick(window, window.getByTestId("undo-action"));
    await expect(window.getByTestId("references")).toHaveCount(0);
    await expect(second.getByTestId("citation-chip").first()).toHaveText("1");
    await window.keyboard.type("再写一句。");
    await expect(message).toHaveCount(0);

    // After a restart, the first Mind is still in GB/T 7714 by default, and says nothing.
    await session.app.close();
    session = await launchApp(dataDir, { fakeChat: true });
    window = session.window;
    await pointAndClick(window, window.getByTestId("mind-list-item").filter({ hasText: "第一章" }));
    await expect(window.getByTestId("references")).toHaveAttribute(
      "data-style",
      "gb-t-7714-2015-numeric",
    );
    await expect(window.getByTestId("references-style-default")).toBeVisible();
    await pointAndClick(window, window.getByTestId("export-mind"));
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("undo-line").getByTestId("undo-message")).toHaveCount(0);
  } finally {
    await session.app.close();
  }
});

for (const release of ["a second own note", "an own export"] as const) {
  test(`a citation style prompt waits for a paper and ${release}; closing has Undo and More opens the picker`, async () => {
    await writeFile(join(sources, "Lease agreement.txt"), "Spring rent is due at the new moon.");
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await addDocuments(window, [join(sources, "Lease agreement.txt")]);

    // A contract: a numbered marker, as before styles, and nothing offered.
    const answer = await ask(window, "When is spring rent due?");
    await expect(answer.getByTestId("citation-chip")).toHaveText(["1"]);
    const prompt = window.getByTestId("citation-style-prompt");
    await expect(answer.getByTestId("citation-chip")).toHaveAttribute("data-check", "found");
    await expect(prompt).toHaveCount(0);
    await expect(window.getByTestId("references")).toHaveCount(0);

    // A report with an author and a date is still neither a paper nor a book: nothing offered (#1910).
    const lease = await documentIdOf(window, "Lease agreement");
    await setRecord(window, lease, {
      type: "report",
      title: "Rent review 2026",
      authors: [{ literal: "Facilities" }],
      issued: "2026",
    });
    await expect(prompt).toHaveCount(0);
    await expect(window.getByTestId("references")).toHaveCount(0);

    await setRecord(window, lease, {
      type: "article-journal",
      title: "Rent and the Moon",
      authors: [{ family: "Oke", given: "T. R." }],
      issued: "1982",
    });
    await expect(prompt).toHaveCount(0);
    await (await coreOf(window)).evaluate(async (core) => {
      const { exportOptions } = (await core.getSettings()).user;
      await core.updateSettings({
        user: { exportOptions: { ...exportOptions, citationPlace: "footnotes" } },
      });
    });
    await expect(prompt).toHaveCount(0);
    if (release === "a second own note") {
      await (await coreOf(window)).evaluate((core) => core.createMind({ title: "Second note" }));
    } else {
      await chooseOutputLocation(window, sources);
      await exportFromMenu(window, "markdown");
      await expect(window.getByTestId("export-done")).toBeVisible();
    }
    await expect(prompt).toBeVisible();

    // Closed, it doesn't come back in this Mind; Undo brings it back.
    await pointAndClick(window, prompt.getByTestId("citation-style-prompt-dismiss"));
    await expect(prompt).toHaveCount(0);
    await expect(window.getByTestId("undo-line")).toContainText(
      "Won’t ask about a citation style in this note",
    );
    await pointAndClick(window, window.getByTestId("undo-action"));
    await expect(prompt).toBeVisible();

    // More… opens the picker, for any style.
    await pointAndClick(window, prompt.getByTestId("citation-style-prompt-more"));
    await chooseStyle(window, "harvard", "Harvard (Cite Them Right)");
    await expect(prompt).toHaveCount(0);
    await expect(window.getByTestId("references")).toHaveAttribute("data-style", "harvard");
    await expect(answer.getByTestId("citation-chip")).toHaveText("(Oke, 1982, l. 1)");
    await app.close();
  });
}

test("the style chosen for a Mind in a Folder, from its menu, is the one a new Mind there starts in", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const folder = await core.createLibraryGroup({ name: "Thesis", description: "" });
    await core.createMind({ title: "Chapter 1", folderId: folder.id });
  });
  const folder = sidebarFolder(window, "Thesis");
  await pointAndClick(window, folder.getByTestId("folder-row"));
  await expect(folder).toHaveAttribute("data-expanded", "true");

  await openPickerFromRow(window, folder.getByTestId("mind-row").filter({ hasText: "Chapter 1" }));
  await chooseStyle(window, "ieee", "IEEE");

  // "New note here", from the Folder's menu: it starts in IEEE, ticked in its picker.
  await pointAndClick(window, folder.getByTestId("folder-row"), { button: "right" });
  await pointAndClick(window, folder.getByTestId("folder.newMind"));
  const rows = folder.getByTestId("mind-row");
  await expect(rows).toHaveCount(2);
  await openPickerFromRow(window, rows.filter({ hasNotText: "Chapter 1" }));
  const current = window.locator('[data-testid="citation-style-option"][data-current="true"]');
  await expect(current.getByTestId("citation-style-option-label")).toHaveText("IEEE");
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("citation-style-picker")).toBeHidden();
  await app.close();
});

for (const [language, name, id] of [
  ["en", "ieee", "ieee"],
  ["zh-CN", "温哥华", "vancouver"],
] as const) {
  test(`in ${language}: a style's exact name typed and Enter at once take it before every style has arrived; when they arrive, what was shown keeps its place and the highlight, under a resting pointer too`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await setLanguage(window, language);
    const minds = await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const folder = await core.createLibraryGroup({ name: "Thesis", description: "" });
      const first = await core.createMind({ title: "Chapter 1", folderId: folder.id });
      const second = await core.createMind({ title: "Chapter 2", folderId: folder.id });
      return { first: first.id, second: second.id };
    });
    const styleOf = (mindId: string) =>
      window.evaluate(
        (id) =>
          (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getMindCitationStyle(
            id,
          ),
        mindId,
      );
    const folder = sidebarFolder(window, "Thesis");
    await pointAndClick(window, folder.getByTestId("folder-row"));
    await expect(folder).toHaveAttribute("data-expanded", "true");
    const row = (title: string) => folder.getByTestId("mind-row").filter({ hasText: title });
    const picker = window.getByTestId("citation-style-picker");
    const field = picker.getByTestId("citation-style-search");
    const options = picker.getByTestId("citation-style-option");
    const labels = picker.getByTestId("citation-style-option-label");

    await holdStyleCatalogue(window, true);
    await openPickerFromRow(window, row("Chapter 1"));
    await expect(field).toBeFocused();
    await expect(field).not.toHaveAttribute("aria-label", /\d/);
    await window.keyboard.type(name);
    await window.keyboard.press("Enter");
    await expect(picker).toBeHidden();
    await expect.poll(async () => (await styleOf(minds.first)).style).toBe(id);

    expect((await styleOf(minds.second)).chosen).toBe(false);
    await openPickerFromRow(window, row("Chapter 2"));
    await expect(field).toBeFocused();
    await window.keyboard.type("chi");
    await expect(options).toHaveCount(2);
    await expect(options.first()).toHaveAttribute("data-style", "chicago-notes");
    const box = await field.boundingBox();
    if (!box) throw new Error("The picker's field isn't on screen.");
    const pointer = { x: box.x + box.width / 2, y: box.y + box.height + 220 };
    await window.mouse.move(pointer.x, pointer.y);
    await holdStyleCatalogue(window, false);
    await expect(field).toHaveAttribute("aria-label", /\d/);
    await expect
      .poll(() =>
        window.evaluate(
          ({ x, y }) =>
            document.elementFromPoint(x, y)?.closest('[role="option"]')?.matches(":hover") ?? false,
          pointer,
        ),
      )
      .toBe(true);
    await expect(options.first()).toHaveAttribute("data-style", "chicago-notes");
    await expect(picker.locator('[role="option"][aria-selected="true"]')).toHaveAttribute(
      "data-style",
      "chicago-notes",
    );
    await window.keyboard.press("ControlOrMeta+a");
    await window.keyboard.type("ieee");
    await expect(labels.first()).toHaveText("IEEE");
    await expect(
      picker
        .locator('[role="option"][aria-selected="true"]')
        .getByTestId("citation-style-option-label"),
    ).toHaveText("IEEE");
    await window.keyboard.press("Enter");
    await expect(picker).toBeHidden();
    await expect.poll(async () => (await styleOf(minds.second)).style).toBe("ieee");
    await app.close();
  });
}

test("every CSL style: ⌘K and the References' style open the one picker, which finds a journal in English and Chinese and lists Recently used; the Mind keeps the journal's name, a style this version lacks says so, and the picker fits a 1,100px window", async () => {
  const count = readPackIndex(
    join(__dirname, "../resources/citation-styles/styles.pack"),
  ).styles.length.toLocaleString("en");
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1100, 720);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await setRecord(window, await documentIdOf(window, "Tides"), TIDES_RECORD);
  await ask(window, "When do spring tides happen?");

  // ⌘K's "Citation style…": a journal found by its name, with its form and the style it follows.
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("citation style");
  await window.keyboard.press("Enter");
  const picker = window.getByTestId("citation-style-picker");
  const search = picker.getByTestId("citation-style-search");
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute("placeholder", `Search ${count} styles and journals…`);
  const sections = picker.getByTestId("citation-style-section");
  await expect(sections.filter({ hasText: "Common" })).toBeVisible();
  await window.keyboard.type("Nature Genetics");
  const first = picker.getByTestId("citation-style-option").first();
  await expect(first.getByTestId("citation-style-option-label")).toHaveText("Nature Genetics");
  await expect(first).toContainText("numeric · follows Nature");
  await expect(sections.first()).toHaveText("Journals");
  await screenshot(window, "citation-style-search-en");
  await window.keyboard.press("Enter");
  await expect(picker).toBeHidden();
  await expect(window.getByTestId("undo-line")).toContainText(
    "Citation style changed to Nature Genetics",
  );

  // Formatted as Nature, named as the journal.
  const references = window.getByTestId("references");
  await expect(references).toHaveAttribute("data-style", "nature-genetics");
  const style = references.getByTestId("references-style");
  await expect(style).toHaveText("Nature Genetics");
  await expect(references.getByTestId("reference-entry").first()).toContainText(
    "Tides and the Moon",
  );
  // "References" on the left; the style, Copy and Export… together on the right.
  const title = await references.getByRole("heading").boundingBox();
  const styleBox = await style.boundingBox();
  const copy = await references.getByTestId("references-copy").boundingBox();
  if (!title || !styleBox || !copy) throw new Error("The References' head isn't on screen.");
  expect(styleBox.x).toBeGreaterThan(title.x + title.width + 40);
  expect(copy.x).toBeGreaterThan(styleBox.x);
  expect(Math.abs(copy.y - styleBox.y)).toBeLessThan(4);

  // The References' style opens the same picker, the Mind's style first, ticked; it fits the window.
  await pointAndClick(window, style);
  await expect(search).toBeFocused();
  const current = picker.locator('[data-testid="citation-style-option"][data-current="true"]');
  await expect(current.getByTestId("citation-style-option-label")).toHaveText("Nature Genetics");
  await expect(picker.getByTestId("citation-style-option").first()).toHaveAttribute(
    "data-current",
    "true",
  );
  const box = await picker.boundingBox();
  if (!box) throw new Error("The picker isn't on screen.");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1100);
  await screenshot(window, "citation-style-menu-en");
  // The arrows reach far down the list, which draws the rows as they come into view.
  await window.keyboard.type("journal");
  for (let step = 0; step < 30; step++) await window.keyboard.press("ArrowDown");
  await expect(
    picker.locator('[data-testid="citation-style-option"][aria-selected="true"]'),
  ).toBeInViewport();
  await window.keyboard.press("Escape");
  await expect(picker).toBeHidden();

  // Another style chosen: Nature Genetics is Recently used, after the Mind's style.
  await pointAndClick(window, style);
  await chooseStyle(window, "ieee", "IEEE");
  await expect(style).toHaveText("IEEE");
  await pointAndClick(window, style);
  await expect(search).toBeFocused();
  const labels = picker.getByTestId("citation-style-option-label");
  await expect(labels.first()).toHaveText("IEEE");
  await expect(sections.first()).toHaveText("Recently used");
  await expect(labels.nth(1)).toHaveText("Nature Genetics");
  await window.keyboard.press("Escape");
  await expect(picker).toBeHidden();

  // A style only a later version has, as a Mind synced from one would be in: the Mind keeps it,
  // formatted as Numbered, and its button says it isn't here.
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    for (const mind of await core.listMinds()) {
      await core.setMindCitationStyle(mind.id, "a-style-from-a-later-pack");
    }
  });
  await expect(references).toHaveAttribute("data-style", "a-style-from-a-later-pack");
  await expect(style).toHaveText("a-style-from-a-later-pack isn’t available in this version");
  await expect(references.getByTestId("reference-entry").first()).toContainText("Tides");
  await expect(window.getByTestId("mind-editor").getByTestId("citation-chip").first()).toHaveText(
    "1",
  );
  await screenshot(references, "references-unavailable-en");

  // In Chinese: a Chinese journal by its Chinese name.
  await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "zh-CN" },
    }),
  );
  await expect(references.getByRole("heading")).toHaveText("参考文献");
  await expect(style).toHaveText("a-style-from-a-later-pack 在此版本中不可用");
  await pointAndClick(window, style);
  await expect(search).toHaveAttribute("placeholder", `搜索 ${count} 种格式和期刊…`);
  await expect(sections.filter({ hasText: "最近使用" })).toBeVisible();
  await expect(sections.filter({ hasText: "常用" })).toBeVisible();
  await window.keyboard.type("物理学报");
  await expect(
    picker.getByTestId("citation-style-option").first().getByTestId("citation-style-option-label"),
  ).toHaveText("Acta Physica Sinica (物理学报)");
  await expect(picker.getByTestId("citation-style-option").first()).toContainText("编号");
  const zhBox = await picker.boundingBox();
  if (!zhBox) throw new Error("The picker isn't on screen.");
  expect(zhBox.x + zhBox.width).toBeLessThanOrEqual(1100);
  await screenshot(window, "citation-style-search-zh");
  await window.keyboard.press("Escape");
  await app.close();
});
