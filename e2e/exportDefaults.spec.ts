import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import * as Y from "yjs";
import type { CoreBridge, Document } from "../src/core/api";
import { footnotesOf, paragraphsOf, part, unzip } from "../tests/helpers/docx";
import {
  addDocuments,
  assistantAnswers,
  blocksUpdate,
  createDataFolder,
  dismissChatSetup,
  exportFromMenu,
  launchApp,
  mindNode,
  motionSettled,
  nameMind,
  newMind,
  paletteOffers,
  pointAndClick,
  removeDataFolder,
  runCommand,
  savedLine,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
  useOutputLocation,
  WINDOW_SIZE,
} from "./app";

/*
 * The first export asks nothing (#1945): Word marks the text IncarnaMind wrote, Citations are
 * footnotes, and the Saved line says what the file was written with — "Saved “Tides.docx” in
 * Exports · 2 footnotes · AI text marked · Not checked · Change" — with Change to change either
 * choice and export again, and Undo to put the choice back. The file is named after the note:
 * its title, or the Question that made it. Set INCARNAMIND_SCREENSHOTS to a folder to also save
 * screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const WORDS = {
  en: {
    footnotes: "2 footnotes",
    marked: "AI text marked",
    unmarked: "AI text not marked",
    notChecked: "Not checked",
    change: "Change",
    list: "2 Citations in a list at the end",
    undo: "Word files now leave the text IncarnaMind wrote unmarked",
    comment: "Written by IncarnaMind",
  },
  "zh-CN": {
    footnotes: "2 个脚注",
    marked: "已标出 AI 生成的文字",
    unmarked: "未标出 AI 生成的文字",
    notChecked: "未核对",
    change: "更改",
    list: "2 个引用列在文末",
    undo: "Word 导出改为不标出 IncarnaMind 写的内容",
    comment: "由 IncarnaMind 生成",
  },
} as const;

let dataDir: string;
let out: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  out = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(out);
  await removeDataFolder(sources);
});

const bridge = (window: Page) => ({
  documents: () =>
    window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    ),
  write: (mindId: string, update: Uint8Array) =>
    window.evaluate(
      ([id, bytes]) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.applyMindUpdate(
          id,
          new Uint8Array(bytes),
        ),
      [mindId, Array.from(update)] as const,
    ),
  settings: () =>
    window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return (await core.getSettings()).user.exportOptions;
    }),
});

function citationAttributes(document: Document, page: number): Record<string, unknown> {
  return {
    passageId: "passage-1",
    documentId: document.id,
    documentName: document.name,
    contentHash: document.contentHash,
    pageFrom: page,
    pageTo: page,
    location: null,
    quote: "Spring tides happen at new moon.",
    check: "found",
    checkReason: null,
  };
}

/** A paragraph IncarnaMind wrote: its words carry the mark the export reads as AI text. */
function aiParagraph(said: string): Y.XmlElement {
  const text = new Y.XmlText();
  text.applyDelta([{ insert: said, attributes: { generated: true } }]);
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.setAttribute("id", randomUUID());
  paragraph.insert(0, [text]);
  return paragraph;
}

/**
 * A note named `name` that cites a Document once for each of `pages` and holds a line IncarnaMind
 * wrote: the two choices the Saved line speaks for, and a claim of the User's still to check.
 */
async function noteCiting(
  window: Page,
  name: string,
  pages: readonly number[] = [1, 2],
): Promise<string> {
  await newMind(window);
  await nameMind(window, name);
  const mindId = await window.getByTestId("mind-pane").getAttribute("data-mind-id");
  if (!mindId) throw new Error("No Mind is open.");
  await writeFile(join(sources, "Tides.txt"), "Spring tides happen at new moon.");
  await addDocuments(window, [join(sources, "Tides.txt")]);
  await expect.poll(async () => (await bridge(window).documents())[0]?.status).toBe("ready");
  const [tides] = await bridge(window).documents();
  if (!tides) throw new Error("No Document.");
  await bridge(window).write(
    mindId,
    blocksUpdate([
      mindNode("paragraph", { id: randomUUID() }, [
        ...pages.flatMap((page, index) => [
          index === 0 ? "Spring tides come at new moon " : " and again ",
          mindNode("citation", citationAttributes(tides, page)),
        ]),
        ".",
      ]),
      aiParagraph("Written by IncarnaMind."),
    ]),
  );
  return mindId;
}

const exported = async (name: string) => unzip(await readFile(join(out, name)));
const documentOf = async (name: string) => part(await exported(name), "word/document.xml");
const commentsOf = async (name: string) => {
  const files = await exported(name);
  return files.has("word/comments.xml") ? part(files, "word/comments.xml") : "";
};

for (const [language, width] of [
  ["en", 900],
  ["zh-CN", 1600],
] as const) {
  const words = WORDS[language];

  test(`a fresh note exports with no question, the Saved line says what was chosen, and Change exports again with Undo (${language}, ${width}px)`, async () => {
    test.setTimeout(240_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, width, WINDOW_SIZE.height);
    await useOutputLocation(window, out);
    await noteCiting(window, "Tides");
    const result = window.getByTestId("export-result");
    const done = result.getByTestId("export-done");
    const chosen = result.getByTestId("export-chosen");
    const unchecked = result.getByTestId("export-unchecked");
    const change = result.getByTestId("export-change");

    // Export asks nothing: the file is saved at once, and its line says what was chosen, in order.
    await exportFromMenu(window, "docx");
    await expect(done).toContainText(savedLine("Tides.docx", out, language));
    await expect(chosen).toHaveText([words.footnotes, words.marked]);
    await expect(unchecked).toHaveText([words.notChecked]);
    await expect(change).toHaveText(words.change);
    await expect(window.getByTestId("export-mark-question")).toHaveCount(0);
    await expect(result).not.toHaveAttribute("data-state", "ask");
    await screenshot(window, `export-defaults-${language}-${width}`);
    expect(await documentOf("Tides.docx")).toContain("footnoteReference");
    expect(await commentsOf("Tides.docx")).toContain(words.comment);

    // Change opens both choices under the line, and Esc leaves them without exporting again.
    await pointAndClick(window, result.getByTestId("export-change"));
    const mark = result.getByTestId("export-mark-question");
    const place = result.getByTestId("export-place-question");
    await expect(mark).toBeVisible();
    await expect(place).toBeVisible();
    await expect(result.getByTestId("export-mark-ask-mark")).toBeFocused();
    await motionSettled(window);
    await screenshot(window, `export-change-${language}-${width}`);
    await window.keyboard.press("Escape");
    await expect(mark).toHaveCount(0);
    await expect(chosen).toHaveText([words.footnotes, words.marked]);
    expect([...(await readdir(out))].sort()).toEqual(["Tides.docx"]);

    // Leave it out: a second file, unmarked, and the line says so; Undo puts the choice back.
    await pointAndClick(window, result.getByTestId("export-change"));
    await pointAndClick(window, result.getByTestId("export-mark-ask-leave"));
    await expect(done).toContainText(savedLine("Tides 2.docx", out, language));
    await expect(chosen).toHaveText([words.footnotes, words.unmarked]);
    await expect
      .poll(async () => [...(await readdir(out))].sort())
      .toEqual(["Tides 2.docx", "Tides.docx"]);
    expect(await commentsOf("Tides 2.docx")).toBe("");
    expect((await bridge(window).settings()).docx.markAiText).toBe("leave");
    const undo = window.getByTestId("undo-line");
    await expect(undo).toContainText(words.undo);
    await pointAndClick(
      window,
      undo.getByRole("button", { name: language === "en" ? "Undo" : "撤销" }),
    );
    expect((await bridge(window).settings()).docx.markAiText).toBe("mark");

    // List at the end: the third file has no footnotes but a numbered list, and the line says so.
    await pointAndClick(window, result.getByTestId("export-change"));
    await pointAndClick(window, result.getByTestId("export-place-ask-list"));
    await expect(done).toContainText(savedLine("Tides 3.docx", out, language));
    await expect(chosen).toHaveText([words.list, words.marked]);
    await expect(unchecked).toHaveText([words.notChecked]);
    const listed = await documentOf("Tides 3.docx");
    expect(listed).not.toContain("footnoteReference");
    expect(
      paragraphsOf(listed)
        .map((each) => each.text)
        .filter((each) => /^\[\d+\]\t/.test(each)),
    ).toHaveLength(1);
    await app.close();
  });

  test(`the Saved line counts the footnotes the file has, not the Citations it was made from (${language}, ${width}px)`, async () => {
    test.setTimeout(240_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, width, WINDOW_SIZE.height);
    await useOutputLocation(window, out);
    // Five Citations of two pages: one footnote for each page the file cites (#1381).
    await noteCiting(window, "Tides", [1, 1, 1, 2, 2]);
    const result = window.getByTestId("export-result");
    const chosen = result.getByTestId("export-chosen");

    await exportFromMenu(window, "docx");
    await expect(result.getByTestId("export-done")).toContainText(
      savedLine("Tides.docx", out, language),
    );
    await expect(chosen).toHaveText([words.footnotes, words.marked]);
    const footnotes = footnotesOf(part(await exported("Tides.docx"), "word/footnotes.xml"));
    expect(Object.keys(footnotes)).toHaveLength(2);
    await screenshot(window, `export-footnotes-${language}-${width}`);
    await app.close();
  });
}

test("a note is named after its title, in Chinese and with what a file name can't hold taken out", async () => {
  test.setTimeout(240_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, WINDOW_SIZE.height);
  await useOutputLocation(window, out);
  await noteCiting(window, "港口航运笔记 2025 年收入复核");
  const done = window.getByTestId("export-result").getByTestId("export-done");

  await exportFromMenu(window, "docx");
  await expect(done).toContainText("港口航运笔记 2025 年收入复核.docx");
  await expect(window.getByTestId("export-result").getByTestId("export-chosen")).toHaveText([
    "2 个脚注",
    "已标出 AI 生成的文字",
  ]);

  await newMind(window);
  await nameMind(window, 'Q3: why "Harbourline" <draft>/2025?');
  await exportFromMenu(window, "docx");
  await expect(done).toContainText("Q3 why Harbourline draft 2025.docx");
  await expect
    .poll(async () => [...(await readdir(out))].sort())
    .toEqual(["Q3 why Harbourline draft 2025.docx", "港口航运笔记 2025 年收入复核.docx"]);
  await app.close();
});

test("the assistant's export asks nothing either, and marks the text IncarnaMind wrote", async () => {
  test.setTimeout(240_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await useOutputLocation(window, out);
  await noteCiting(window, "Deal notes");

  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("Export this Mind as Word");
  await window.keyboard.press("Enter");
  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(window.getByTestId("task-tray").getByTestId("question-card")).toHaveCount(0);
  await expect(answer.getByTestId("command-changes-title")).toHaveText(
    `Saved “Deal notes.docx” in “${basename(out)}”`,
  );
  await expect.poll(async () => [...(await readdir(out))].sort()).toEqual(["Deal notes.docx"]);
  expect(await commentsOf("Deal notes.docx")).toContain("Written by IncarnaMind");
  await app.close();
});

test("a note with nothing to check says nothing about checks; a sentence it holds makes the line say Not checked (#1915)", async () => {
  test.setTimeout(240_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "en");
  await useOutputLocation(window, out);
  await newMind(window);
  await nameMind(window, "Tides");
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type("Notes");
  const done = window.getByTestId("export-result").getByTestId("export-done");

  const result = window.getByTestId("export-result");
  const chosen = result.getByTestId("export-chosen");
  const unchecked = result.getByTestId("export-unchecked");

  await exportFromMenu(window, "docx");
  await expect(done).toContainText(savedLine("Tides.docx", out));
  await expect(chosen).toHaveText(["AI text marked"]);
  await expect(unchecked).toHaveCount(0);

  // A sentence to check, and the line says so (#1915); the file's own words are unchanged.
  await editor.click();
  await window.keyboard.type(" Spring tides come twice a month.");
  await exportFromMenu(window, "docx");
  await expect(done).toContainText(savedLine("Tides 2.docx", out));
  await expect(unchecked).toHaveText(["Not checked"]);
  await app.close();
});

test("Change is on a PDF's Saved line too, even for a note with no Citations, and writes the file again", async () => {
  test.setTimeout(240_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "en");
  await useOutputLocation(window, out);
  await newMind(window);
  await nameMind(window, "Tides");
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type("Spring tides come twice a month.");
  const result = window.getByTestId("export-result");
  const done = result.getByTestId("export-done");

  await exportFromMenu(window, "pdf");
  await expect(done).toContainText(savedLine("Tides.pdf", out));
  const change = result.getByTestId("export-change");
  await expect(change).toHaveText("Change");
  await pointAndClick(window, change);
  // No Citation to count, and the place is still the User's to choose: the row shows without one.
  await expect(result.getByTestId("export-place-question")).toBeVisible();
  await expect(result.getByTestId("export-place-count")).toHaveCount(0);
  await pointAndClick(window, result.getByTestId("export-place-ask-list"));
  await expect(done).toContainText(savedLine("Tides 2.pdf", out));
  await expect
    .poll(async () => [...(await readdir(out))].sort())
    .toEqual(["Tides 2.pdf", "Tides.pdf"]);
  await expect(window.getByTestId("undo-line")).toContainText(
    "Citations now go in a list at the end",
  );
  await app.close();
});

test("a non-Office export of a Numbered note has no Change, and ⌘K offers none (en)", async () => {
  test.setTimeout(240_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "en");
  await useOutputLocation(window, out);
  await noteCiting(window, "Tides");
  const result = window.getByTestId("export-result");
  const done = result.getByTestId("export-done");

  // Markdown keeps its own notes and has no marking to choose: nothing there is the User's to change.
  await exportFromMenu(window, "markdown");
  await expect(done).toContainText("Tides.md");
  await expect(result.getByTestId("export-change")).toHaveCount(0);
  expect(await paletteOffers(window, "mind.exportChangeChoices", "change what the export")).toBe(0);
  await window.keyboard.press("Escape");

  // Word does: the same change opens from ⌘K, and its re-export is the file's again.
  await exportFromMenu(window, "docx");
  await expect(result.getByTestId("export-change")).toHaveText("Change");
  await runCommand(window, "mind.exportChangeChoices", "Change what the export was written with");
  await expect(result.getByTestId("export-mark-question")).toBeVisible();
  await expect(result.getByTestId("export-place-question")).toBeVisible();
  await app.close();
});
