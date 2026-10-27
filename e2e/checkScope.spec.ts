import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { wordFile, paragraph as wordParagraph } from "../tests/helpers/word";
import {
  addDocuments,
  checkCard,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  documentIdOf,
  importWordFile,
  launchApp,
  motionSettled,
  newMind,
  openDocumentMenu,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

/**
 * A Mind's chosen scope narrows its check (#1623): the Search scope set in the composer is
 * where the check looks, every card says where that was, a change of the scope marks the
 * checks made before it for a re-check, one click goes back to the scope it narrowed, and a
 * scope that holds nothing says so. The scripted model supports a sentence that shares three words with a line it was
 * handed. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
let shots = 0;
const screenshot = async (window: Page, name: string) => {
  shots++;
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  const file = `${String(shots).padStart(2, "0")}-${name}.png`;
  await window.screenshot({ path: join(SCREENSHOTS, file) });
};

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

const OWN = "Harbours publish the times of high water every week.";
const ELSEWHERE = "Penguins nest on the harbour cliffs every spring.";

async function launched() {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
  await setWindowSize(app, window, 900, 800);
  await dismissChatSetup(window);
  return { app, window };
}

async function twoDocumentsAndAMind(window: Page) {
  await writeFile(join(sources, "Harbour times.txt"), `${OWN}\n`);
  await writeFile(join(sources, "Seabirds.txt"), `${ELSEWHERE}\n`);
  await addDocuments(window, [join(sources, "Harbour times.txt"), join(sources, "Seabirds.txt")]);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type(`${OWN} ${ELSEWHERE}`);
  return editor;
}

test("a check looks in the Mind's chosen scope, its card says where, and a change of the scope marks it for a re-check", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launched();
  await useLocalChatModel(window);
  const editor = await twoDocumentsAndAMind(window);

  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("@Harbour");
  await expect(window.getByTestId("scope-picker")).toBeVisible();
  await window.keyboard.press("Enter");
  const composer = window.getByTestId("composer");
  await expect(composer.getByTestId("scope-chip")).toHaveText("Harbour times");

  const line = editor.locator(":scope > p").first();
  await slideSelect(window, line, "Harbours publish", { line, words: "spring." });
  await pointAndClick(
    window,
    window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
  );
  const marks = window.getByTestId("claim-mark");
  await expect(marks).toHaveCount(2);
  await expect(marks.first()).toHaveAttribute("data-check", "supported");
  await expect(marks.nth(1)).toHaveAttribute("data-check", "unsupported");
  await motionSettled(window);
  const card = window.getByTestId("claim-card");

  await pointAndClick(window, marks.first());
  await expect(card.getByTestId("claim-checked-in")).toHaveText("Checked against “Harbour times”");
  await screenshot(window, "checked-in-en");
  await window.keyboard.press("Escape");

  // Not found where it looked: the line that says so names the scope, and only it does.
  await pointAndClick(window, marks.nth(1));
  await expect(card.getByTestId("claim-nothing")).toHaveText(
    "I didn’t find this in “Harbour times”.",
  );
  await expect(card.getByTestId("claim-checked-in")).toHaveCount(0);
  await screenshot(window, "not-found-in-scope-en");
  await pointAndClick(window, card.getByTestId("claim-search-all"));
  await expect(marks.nth(1)).toHaveAttribute("data-check", "supported");
  await pointAndClick(window, marks.nth(1));
  await expect(card.getByTestId("claim-checked-in")).toHaveText("Checked against “All Documents”");
  await screenshot(window, "widened-en");
  await window.keyboard.press("Escape");

  await setLanguage(window, "zh-CN");
  await pointAndClick(window, marks.first());
  await expect(card.getByTestId("claim-checked-in")).toHaveText("已对照“Harbour times”核对");
  await screenshot(window, "checked-in-zh");
  await window.keyboard.press("Escape");
  await pointAndClick(window, marks.nth(1));
  await expect(card.getByTestId("claim-checked-in")).toHaveText("已对照“全部文档”核对");
  await screenshot(window, "widened-zh");
  await window.keyboard.press("Escape");

  // Widened in the composer: the check made in the one Document needs a re-check; the one made
  // in every Document still holds.
  await pointAndClick(window, composer.getByTestId("scope-chip-remove"));
  await expect(composer.getByTestId("composer-scope-all")).toBeVisible();
  await expect(marks.first()).toHaveAttribute("data-check", "needs-recheck");
  await expect(marks.nth(1)).toHaveAttribute("data-check", "supported");
  await pointAndClick(window, marks.first());
  await expect(card.getByTestId("claim-reason")).toHaveText("这篇笔记的搜索范围已更改。");
  await screenshot(window, "recheck-zh");
  await app.close();
});

test("“Ask about this Document” sets the Mind's scope, and one click goes back to the scope it narrowed, the Mind's Folder or All Documents, by mouse or keyboard, in English and Chinese", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launched();
  await useLocalChatModel(window);
  await twoDocumentsAndAMind(window);
  const composer = window.getByTestId("composer");
  const chip = composer.getByTestId("scope-chip");
  const back = composer.getByTestId("scope-chip-remove");
  const input = composer.getByTestId("composer-input");
  const all = composer.getByTestId("composer-scope-all");
  const askAbout = async () => {
    const row = window.getByTestId("document-list-item").filter({ hasText: "Harbour times" });
    await openDocumentMenu(row);
    await pointAndClick(window, row.getByTestId("document.ask"));
    await expect(chip).toHaveText("Harbour times");
  };
  const mindId = (await window.getByTestId("mind-pane").first().getAttribute("data-mind-id")) ?? "";
  const fileMind = async (folderId: string | null) =>
    (await coreOf(window)).evaluate(
      (core, place) => core.moveToFolder({ mindIds: [place.mindId], folderId: place.folderId }),
      { mindId, folderId },
    );

  // In no Folder, the Mind's own scope is every Document.
  await askAbout();
  await expect(back).toHaveAccessibleName("Back to All Documents");
  await screenshot(window, "asked-about-en");
  await pointAndClick(window, back);
  await expect(chip).toHaveCount(0);
  await expect(all).toHaveText("All Documents");
  await expect(input).toBeFocused();
  await askAbout();
  await back.focus();
  await window.keyboard.press("Enter");
  await expect(all).toHaveText("All Documents");
  await expect(input).toBeFocused();

  // In a Folder that holds a Document, it is that Folder.
  const folderId = await (await coreOf(window)).evaluate(
    async (core, documentId) => {
      const folder = await core.createLibraryGroup({ name: "Harbours", description: "" });
      await core.moveToFolder({ documentIds: [documentId], folderId: folder.id });
      return folder.id;
    },
    await documentIdOf(window, "Seabirds"),
  );
  await fileMind(folderId);
  await expect(chip).toHaveText("Harbours");
  await askAbout();
  await expect(back).toHaveAccessibleName("Back to “Harbours”");
  await expect(back).toHaveAttribute("title", "Back to “Harbours”");
  await screenshot(window, "back-to-folder-en");
  await pointAndClick(window, back);
  await expect(chip).toHaveText("Harbours");
  await expect(input).toBeFocused();
  await askAbout();
  await back.focus();
  await window.keyboard.press("Enter");
  await expect(chip).toHaveText("Harbours");
  await expect(input).toBeFocused();

  await setLanguage(window, "zh-CN");
  await askAbout();
  await expect(back).toHaveAccessibleName("改回“Harbours”");
  await screenshot(window, "back-to-folder-zh");
  await back.focus();
  await window.keyboard.press("Space");
  await expect(chip).toHaveText("Harbours");
  await expect(input).toBeFocused();

  await fileMind(null);
  await expect(all).toHaveText("全部文档");
  await askAbout();
  await expect(back).toHaveAccessibleName("改回全部文档");
  await screenshot(window, "asked-about-zh");
  await back.focus();
  await window.keyboard.press("Space");
  await expect(all).toHaveText("全部文档");
  await expect(input).toBeFocused();
  await app.close();
});

test("when the Mind's own scope holds nothing, the check says so and offers all Documents or another scope, in English and Chinese, and an empty Library still says to add Documents", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launched();
  await useLocalChatModel(window);
  const editor = await twoDocumentsAndAMind(window);
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("@Harbour");
  await expect(window.getByTestId("scope-picker")).toBeVisible();
  await window.keyboard.press("Enter");
  const composer = window.getByTestId("composer");
  await expect(composer.getByTestId("scope-chip")).toHaveText("Harbour times");
  const remove = async (name: string) => {
    const id = await documentIdOf(window, name);
    await (await coreOf(window)).evaluate(
      (core, documentId) => core.deleteDocument(documentId),
      id,
    );
    await expect(window.getByTestId("document-list-item").filter({ hasText: name })).toHaveCount(0);
  };
  await remove("Harbour times");

  const line = editor.locator(":scope > p").first();
  const findSupport = async () => {
    await slideSelect(window, line, "Harbours publish", { line, words: "spring." });
    await pointAndClick(
      window,
      window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
    );
  };
  const marks = window.getByTestId("claim-mark");
  await findSupport();
  const problem = (await checkCard(window)).getByTestId("checks-problem");
  await expect(problem).toContainText(
    "Nothing to check against: the Document this note’s Search scope names was deleted.",
  );
  await expect(problem.getByTestId("checks-change-scope")).toHaveText("Change the Search scope…");
  await expect(marks).toHaveCount(0);
  await screenshot(window, "empty-scope-en");
  await pointAndClick(window, problem.getByTestId("checks-check-all"));
  await expect(marks).toHaveCount(2);
  await expect(marks.nth(1)).toHaveAttribute("data-check", "supported");
  // Checked against every Document this once: the Mind's scope is still the one chosen.
  await expect(composer.getByTestId("scope-chip")).toHaveCount(1);
  await expect(composer.getByTestId("composer-scope-all")).toHaveCount(0);

  await setLanguage(window, "zh-CN");
  await findSupport();
  await expect((await checkCard(window)).getByTestId("checks-problem")).toContainText(
    "没有可核对的文档：这篇笔记的搜索范围中的文档已删除。",
  );
  await screenshot(window, "empty-scope-zh");
  await pointAndClick(window, problem.getByTestId("checks-change-scope"));
  await expect(window.getByTestId("scope-picker")).toBeVisible();
  await expect(composer.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.press("Escape");

  // With no Document left at all, the selection offers to add some, and so does Check.
  await remove("Seabirds");
  await slideSelect(window, line, "Harbours publish", { line, words: "spring." });
  await expect(
    window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
  ).toContainText("添加文档后才能核对");
  await window.keyboard.press("Escape");
  const card = await checkCard(window);
  await pointAndClick(window, card.getByTestId("badge-check-mind"));
  const empty = card.getByTestId("checks-problem");
  await expect(empty).toContainText("没有可核对的文档：请先添加文档。");
  await expect(empty.getByTestId("checks-add-files")).toBeVisible();
  await app.close();
});

test("a Mind imported from a Word file isn't supported by its own file, and the card says the copy was left out, in English and Chinese", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launched();
  await useLocalChatModel(window);
  // Something else to check against: the imported file alone is left out of its own check.
  await writeFile(join(sources, "Seabirds.txt"), `${ELSEWHERE}\n`);
  await addDocuments(window, [join(sources, "Seabirds.txt")]);
  await importWordFile(
    app,
    window,
    sources,
    "Draft memo.docx",
    wordFile({ body: wordParagraph(OWN) }),
  );
  const item = window.getByTestId("document-list-item").filter({ hasText: "Draft memo" });
  await expect(item).toHaveAttribute("data-status", "ready");
  const editor = window.getByTestId("mind-editor");
  const line = editor.locator("p", { hasText: "Harbours publish" });
  await slideSelect(window, line, "Harbours publish", { line, words: "week." });
  await pointAndClick(
    window,
    window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
  );
  const mark = window.getByTestId("claim-mark");
  await expect(mark).toHaveAttribute("data-check", "unsupported");
  await motionSettled(window);
  await pointAndClick(window, mark);
  const card = window.getByTestId("claim-card");
  await expect(card.getByTestId("claim-left-out")).toHaveText(
    "Also in “Draft memo”, a copy of the checked document: not counted",
  );
  await screenshot(window, "left-out-en");
  await window.keyboard.press("Escape");

  await setLanguage(window, "zh-CN");
  await pointAndClick(window, mark);
  await expect(card.getByTestId("claim-left-out")).toHaveText(
    "也出现在“Draft memo”（正在核对的文档的副本）中，未计为依据",
  );
  await screenshot(window, "left-out-zh");
  await app.close();
});
