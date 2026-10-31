import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { part, unzip } from "../tests/helpers/docx";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  exportFromMenu,
  launchApp,
  nameMind,
  newMind,
  openExportOptions,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
  useOutputLocation,
} from "./app";

/**
 * What a file holds of the sentences whose check isn't good, and what the line
 * after saving says of it (#900): a Word file carries each as a comment and
 * says how many, and any other format, or Word with the option off, says that
 * they went out unmarked, with a way to fix it.
 */
let dataDir: string;
let sources: string;
let out: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
  out = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
  await removeDataFolder(out);
});

const TIDES = buildPdf([
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);
const WRONG = "Harbours publish the times of high water every 6 months.";

test("a Contradicted sentence goes into a Word file as a comment and the line says so; a PDF, or Word with the option off, says it went out unmarked, in English and Chinese", async () => {
  test.setTimeout(240_000);
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await newMind(window);
  await nameMind(window, "Memo");
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type(WRONG);
  const line = editor.locator(":scope > p").first();
  await slideSelect(window, line, "Harbours", { line, words: "months." });
  await pointAndClick(
    window,
    window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
  );
  await expect(window.getByTestId("claim-mark")).toHaveAttribute("data-check", "contradicted");
  await useOutputLocation(window, out);

  // Word: a comment on the sentence, counted on the line.
  const result = window.getByTestId("export-result");
  await exportFromMenu(window, "docx");
  const comments = result.getByTestId("export-comments");
  await expect(comments).toHaveText("1 check comment");
  // The last part before Change.
  await expect(result.getByTestId("export-done")).toContainText(/1 check comment\s*·\s*Change$/);
  await expect(result.getByTestId("export-tracked")).toHaveCount(0);
  await expect(result.getByTestId("export-unmarked")).toHaveCount(0);
  const word = unzip(await readFile(join(out, "Memo.docx")));
  expect(part(word, "word/comments.xml")).toContain("Contradicted: ");

  await setLanguage(window, "zh-CN");
  await expect(comments).toHaveText("1 条核对批注");
  await setLanguage(window, "en");

  // A narrow window: the line and its parts stay inside the Mind, its buttons whole.
  await setWindowSize(app, window, 900, 660);
  const pane = await window.getByTestId("mind-pane").boundingBox();
  const shown = await result.boundingBox();
  expect(shown && pane && shown.x >= pane.x && shown.x + shown.width <= pane.x + pane.width).toBe(
    true,
  );
  await expect(result.getByTestId("export-open")).toBeVisible();
  await setWindowSize(app, window, 1440, 900);

  // PDF: no comments, so the line warns, and Export as Word instead does it.
  await exportFromMenu(window, "pdf");
  const unmarked = result.getByTestId("export-unmarked");
  await expect(unmarked).toHaveText(
    "1 Contradicted sentence went out unmarked · Export as Word instead",
  );
  await expect(result.getByTestId("export-comments")).toHaveCount(0);
  await expect(result.getByTestId("export-dismiss")).toBeVisible();
  await setLanguage(window, "zh-CN");
  await expect(unmarked).toHaveText("有 1 句与文档矛盾，导出时没有标记 · 改为导出 Word");
  await setLanguage(window, "en");
  await pointAndClick(window, result.getByTestId("export-unmarked-word"));
  await expect(result.getByTestId("export-comments")).toHaveText("1 check comment");
  await expect(result.getByTestId("export-unmarked")).toHaveCount(0);

  // Word with the option off: the same warning, and its fix opens the options.
  await openExportOptions(window);
  const sheet = window.getByTestId("export-dialog");
  await sheet.getByTestId("export-comment-failed-checks").uncheck();
  await sheet.getByTestId("export-save").click();
  await expect(sheet).toBeHidden();
  await exportFromMenu(window, "docx");
  await expect(unmarked).toHaveText("1 Contradicted sentence went out unmarked · Export options…");
  const plain = unzip(await readFile(join(out, "Memo 3.docx")));
  expect(plain.has("word/comments.xml")).toBe(false);
  await pointAndClick(window, result.getByTestId("export-unmarked-options"));
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("export-comment-failed-checks")).not.toBeChecked();
  await app.close();
});
