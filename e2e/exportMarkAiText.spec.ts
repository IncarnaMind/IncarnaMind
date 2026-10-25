import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge, MarkAiTextChoice } from "../src/core/api";
import { part, unzip } from "../tests/helpers/docx";
import {
  addToNote,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  exportFromMenu,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  openOptions,
  pointAndClick,
  removeDataFolder,
  savedLine,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
  useOutputLocation,
  WINDOW_SIZE,
} from "./app";

/*
 * The first Word export asks whether to mark the text IncarnaMind wrote (#1380), once: one line
 * in the Mind's export line, whichever way the export started. Each answer gives the file it
 * says, and Export options shows the answer and changes it, without asking again. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const WORDS = {
  en: {
    question: "Mark the text IncarnaMind wrote?",
    mark: "Mark it",
    leave: "Leave it out",
    comment: "Written by IncarnaMind",
    unasked: "Not chosen yet, so the first Word export asks.",
    options: "Export options",
  },
  "zh-CN": {
    question: "标出 IncarnaMind 写的内容？",
    mark: "标出",
    leave: "不标",
    comment: "由 IncarnaMind 生成",
    unasked: "尚未选择，首次导出 Word 时会询问。",
    options: "导出选项",
  },
} as const;

let dataDir: string;
let out: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  out = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(out);
});

/** A Mind named "Tides" with a line of the User's and an Answer added under it, which is AI text. */
async function mindWithAiText(window: Page): Promise<Locator> {
  await newMind(window);
  await nameMind(window, "Tides");
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type("My own line.");
  await window.keyboard.press("Enter");
  await addToNote(window, await askInAssistant(window, "How do tides work?"));
  return editor;
}

/** Puts the cursor in the User's own line: the middle of the Mind may be the Answer's equation. */
const focusMind = (editor: Locator) => editor.getByText("My own line.").click();

/** What the User chose, which a test sets back to "not asked yet" with null. */
const setAnswer = (window: Page, answer: MarkAiTextChoice | null) =>
  window.evaluate(async (chosen) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const { exportOptions } = (await bridge.getSettings()).user;
    const docx = { ...exportOptions.docx, markAiText: chosen };
    await bridge.updateSettings({ user: { exportOptions: { ...exportOptions, docx } } });
  }, answer);

/** The comments a saved Word file holds, or null when it has none. */
async function comments(name: string): Promise<string | null> {
  const files = unzip(await readFile(join(out, name)));
  return files.has("word/comments.xml") ? part(files, "word/comments.xml") : null;
}

for (const language of ["en", "zh-CN"] as const) {
  const words = WORDS[language];

  test(`the first Word export asks whether to mark the text IncarnaMind wrote, once, and each answer gives the file it says (${language})`, async () => {
    test.setTimeout(240_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true, askToMarkAiText: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    const editor = await mindWithAiText(window);
    await useOutputLocation(window, out);
    await setLanguage(window, language);
    const result = window.getByTestId("export-result");
    const mark = result.getByTestId("export-mark-ask-mark");
    const leave = result.getByTestId("export-mark-ask-leave");
    const done = result.getByTestId("export-done");

    // Export's menu, Word: one line asks, with the first answer in reach, and saves nothing.
    await exportFromMenu(window, "docx");
    await expect(result).toHaveAttribute("data-state", "ask");
    await expect(result.getByTestId("export-mark-question")).toHaveText(words.question);
    await expect(mark).toHaveText(words.mark);
    await expect(leave).toHaveText(words.leave);
    await expect(mark).toBeFocused();
    await screenshot(window, `mark-ask-${language}-wide`);
    expect(await readdir(out)).toEqual([]);
    await window.keyboard.press("Escape");
    await expect(result).toHaveCount(0);

    // The narrowest window: the line and its buttons stay inside the Mind.
    await setWindowSize(app, window, 900, WINDOW_SIZE.height);
    await exportFromMenu(window, "docx");
    await expect(result).toHaveAttribute("data-state", "ask");
    const [pane, shown] = await Promise.all([
      window.getByTestId("mind-pane").boundingBox(),
      result.boundingBox(),
    ]);
    expect(shown && pane && shown.x >= pane.x && shown.x + shown.width <= pane.x + pane.width).toBe(
      true,
    );
    await screenshot(window, `mark-ask-${language}-narrow`);

    // Mark it: the file carries the comment, and the line says where it went.
    await pointAndClick(window, mark);
    await expect(done).toHaveText(savedLine("Tides.docx", out, language));
    expect(await comments("Tides.docx")).toContain(words.comment);

    // It doesn't ask again: ⇧⌘E and Export's menu save at once.
    await focusMind(editor);
    await window.keyboard.press("ControlOrMeta+Shift+E");
    await expect(done).toHaveText(savedLine("Tides 2.docx", out, language));
    await exportFromMenu(window, "docx");
    await expect(done).toHaveText(savedLine("Tides 3.docx", out, language));
    await expect(result.getByTestId("export-mark-question")).toHaveCount(0);

    // Not answered again: ⇧⌘E asks too, the keys answer, and Leave it out leaves no comment.
    await setAnswer(window, null);
    await focusMind(editor);
    await window.keyboard.press("ControlOrMeta+Shift+E");
    await expect(result).toHaveAttribute("data-state", "ask");
    await expect(mark).toBeFocused();
    await window.keyboard.press("Tab");
    await expect(leave).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(done).toHaveText(savedLine("Tides 4.docx", out, language));
    expect(await comments("Tides 4.docx")).toBeNull();
    // The focus is back where the User was.
    await expect(editor).toBeFocused();

    // Esc leaves the question unanswered and saves nothing.
    await setAnswer(window, null);
    await window.keyboard.press("ControlOrMeta+Shift+E");
    await expect(result).toHaveAttribute("data-state", "ask");
    await window.keyboard.press("Escape");
    await expect(result).toHaveCount(0);
    await expect(editor).toBeFocused();
    expect(await readdir(out)).toHaveLength(4);

    // Twice: a held ⇧⌘E shows one question, and a double click on an answer makes one file.
    await window.keyboard.press("ControlOrMeta+Shift+E");
    await window.keyboard.press("ControlOrMeta+Shift+E");
    await expect(result).toHaveAttribute("data-state", "ask");
    await expect(mark).toHaveCount(1);
    await mark.dblclick();
    await expect(done).toHaveText(savedLine("Tides 5.docx", out, language));
    expect(await readdir(out)).toHaveLength(5);
    await app.close();
  });

  test(`Export options shows the answer and changes it, and a Word export follows it without asking (${language})`, async () => {
    test.setTimeout(240_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true, askToMarkAiText: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    const editor = await mindWithAiText(window);
    await setWindowSize(app, window, 900, WINDOW_SIZE.height);
    await useOutputLocation(window, out);
    await setLanguage(window, language);
    const result = window.getByTestId("export-result");
    const done = result.getByTestId("export-done");
    const sheet = window.getByTestId("export-dialog");
    const choice = sheet.getByTestId("export-mark-ai-text");
    const choose = async (answer: "mark" | "leave") => {
      await pointAndClick(window, choice.getByText(words[answer]));
      await expect(choice).toHaveAttribute("data-answer", answer);
    };

    // Before any export, the sheet has the question with neither answer, and says so. Cancel keeps it so.
    await openOptions(window, words.options);
    await expect(choice).toHaveAttribute("data-answer", "none");
    await expect(sheet.getByTestId("export-mark-ai-text-mark")).not.toBeChecked();
    await expect(sheet.getByTestId("export-mark-ai-text-leave")).not.toBeChecked();
    await expect(choice).toHaveAccessibleName(words.question);
    await expect(sheet).toContainText(words.unasked);
    await screenshot(window, `mark-options-${language}-unasked`);
    await window.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await focusMind(editor);
    await window.keyboard.press("ControlOrMeta+Shift+E");
    await expect(result).toHaveAttribute("data-state", "ask");
    await window.keyboard.press("Escape");

    // Answered in the sheet and saved, the export doesn't ask, and the file is as answered.
    await openOptions(window, words.options);
    await choose("mark");
    await expect(sheet).not.toContainText(words.unasked);
    await screenshot(window, `mark-options-${language}-answered`);
    await sheet.getByTestId("export-save").click();
    await expect(sheet).toBeHidden();
    await focusMind(editor);
    await window.keyboard.press("ControlOrMeta+Shift+E");
    await expect(done).toHaveText(savedLine("Tides.docx", out, language));
    expect(await comments("Tides.docx")).toContain(words.comment);

    // Changed there, never asked: the next file leaves the text unmarked.
    await openOptions(window, words.options);
    await expect(choice).toHaveAttribute("data-answer", "mark");
    await choose("leave");
    await sheet.getByTestId("export-save").click();
    await expect(sheet).toBeHidden();
    await exportFromMenu(window, "docx");
    await expect(done).toHaveText(savedLine("Tides 2.docx", out, language));
    expect(await comments("Tides 2.docx")).toBeNull();
    await expect(result.getByTestId("export-mark-question")).toHaveCount(0);

    // Not saved, not changed: Cancel leaves the answer as it was.
    await openOptions(window, words.options);
    await choose("mark");
    await sheet.getByRole("button", { name: language === "en" ? "Cancel" : "取消" }).click();
    await openOptions(window, words.options);
    await expect(choice).toHaveAttribute("data-answer", "leave");
    await window.keyboard.press("Escape");

    // The other formats don't wait for it, whatever the answer.
    await setAnswer(window, null);
    await exportFromMenu(window, "pdf");
    await expect(done).toHaveText(savedLine("Tides.pdf", out, language));
    await expect(result).not.toHaveAttribute("data-state", "ask");
    await app.close();
  });
}

test("Export as Word from ⌘K asks too, when the last format was PDF, and Word becomes the format once it exports", async () => {
  test.setTimeout(240_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true, askToMarkAiText: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  const editor = await mindWithAiText(window);
  await setWindowSize(app, window, 900, WINDOW_SIZE.height);
  await useOutputLocation(window, out);
  const result = window.getByTestId("export-result");

  await exportFromMenu(window, "pdf");
  await expect(result.getByTestId("export-done")).toHaveText(savedLine("Tides.pdf", out));
  await expect(window.getByTestId("export-mind")).toHaveAttribute("data-format", "pdf");

  await focusMind(editor);
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette")).toBeVisible();
  await window.keyboard.type("Export as Word");
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("palette")).toBeHidden();
  await expect(result).toHaveAttribute("data-state", "ask");
  await motionSettled(window);
  // Asking doesn't make Word the format Export uses: that waits for the export itself.
  await expect(window.getByTestId("export-mind")).toHaveAttribute("data-format", "pdf");
  expect(await readdir(out)).toEqual(["Tides.pdf"]);

  await pointAndClick(window, result.getByTestId("export-mark-ask-mark"));
  await expect(result.getByTestId("export-done")).toHaveText(savedLine("Tides.docx", out));
  await expect(window.getByTestId("export-mind")).toHaveAttribute("data-format", "docx");
  await app.close();
});
