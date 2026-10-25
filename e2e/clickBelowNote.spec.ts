import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  documentIdOf,
  enterContent,
  frontMindName,
  launchApp,
  mindWrittenBefore,
  nameMind,
  newMind,
  openDocumentAt,
  removeDataFolder,
  setWindowSize,
} from "./app";

/*
 * A click in the page's empty space under the Mind's last Block puts the cursor at the end of
 * the Mind (#768), as in Word, Notion and Apple Notes.
 */
const TIDES = buildPdf([{ lines: ["Tides and the Moon", "The Moon raises two bulges of water."] }]);

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

const VIEWS = [
  { name: "a 1600px window", width: 1600, document: false },
  { name: "a 1100px window", width: 1100, document: false },
  { name: "a 1440px window with a Document beside the Mind", width: 1440, document: true },
] as const;

const blocks = (editor: Locator) => editor.locator(":scope > *");

const lastText = async (editor: Locator) => (await blocks(editor).last().textContent()) ?? "";

/** The editor's selection is empty and sits in its last Block. */
const cursorInLastBlock = (editor: Locator) =>
  editor.evaluate((dom) => {
    const { state } = (dom as unknown as { editor: Editor }).editor;
    const { selection, doc } = state;
    return selection.empty && selection.$from.index(0) === doc.childCount - 1;
  });

/**
 * Slides the mouse into the page's empty space, as a person does, and clicks there: 24px under
 * the editor's last Block, which is still the editor's own space when the Mind is short (it keeps
 * a minimum height), or under the editor's whole box, which is the page's. `across` is how far
 * along the editor's width.
 */
async function clickBelowNote(
  window: Page,
  editor: Locator,
  under: "block" | "editor",
  across = 0.5,
) {
  const last = await blocks(editor).last().boundingBox();
  const box = await editor.boundingBox();
  if (!last || !box) throw new Error("The Mind isn't visible.");
  let x = box.x + box.width * across;
  const y = (under === "block" ? last.y + last.height : box.y + box.height) + 24;
  // The check badge sits in the page's bottom right corner: a click on it opens its card, so aim beside it.
  const shown = window.locator('[data-testid="check-badge"]:visible');
  const badge = (await shown.count()) > 0 ? await shown.first().boundingBox() : null;
  if (badge && x >= badge.x - 8 && y >= badge.y - 8 && y <= badge.y + badge.height + 8) {
    x = badge.x - 12;
  }
  const found = await editor.evaluate(
    (dom, point) => {
      const element = document.elementFromPoint(point.x, point.y);
      return element === dom ? "editor" : element && dom.contains(element) ? "block" : "page";
    },
    { x, y },
  );
  expect(found, "the point is on no Block").not.toBe("block");
  expect(found === "page", "the point is outside the editor's own box").toBe(under === "editor");
  await window.mouse.move(x, y - 40, { steps: 6 });
  await window.mouse.move(x, y, { steps: 4 });
  await window.mouse.click(x, y);
}

for (const view of VIEWS) {
  test(`in ${view.name}, a click under the last Block puts the cursor at the end of the Mind: in the last paragraph, or on a new one under an Answer, which Undo takes back`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await setWindowSize(app, window, view.width, 660);
    await mindWrittenBefore(window, "Tides", [
      { note: "Spring tides follow the Moon." },
      { note: "They come at new moon and at full moon, when the Sun and the Moon pull in line." },
      { note: "Neap tides come in between, at the quarter moons, when the two pulls cross." },
      { question: "When do spring tides happen?", answer: "At new moon and at full moon." },
    ]);
    await window.getByTestId("mind-list-item").filter({ hasText: "Tides" }).click();
    const editor = window.getByTestId("mind-editor");
    await expect(editor.getByTestId("answer")).toHaveAttribute("data-status", "done");
    if (view.document) {
      await writeFile(join(sources, "Tides.pdf"), TIDES);
      await addDocuments(window, [join(sources, "Tides.pdf")]);
      await openDocumentAt(window, { documentId: await documentIdOf(window, "Tides") });
      await expect(window.getByTestId("viewer")).toBeVisible();
    }
    await expect(blocks(editor)).toHaveCount(5);

    // The Mind ends in an Answer: a click under it makes an empty paragraph there, and nothing
    // typed means Undo takes it away.
    await clickBelowNote(window, editor, "editor");
    await expect(blocks(editor)).toHaveCount(6);
    await expect(editor).toBeFocused();
    await expect(blocks(editor).last()).toHaveText("");
    expect(await cursorInLastBlock(editor)).toBe(true);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(blocks(editor)).toHaveCount(5);
    await expect(blocks(editor).last()).toHaveClass(/node-answer/);

    // Again: what is typed lands in the new paragraph, and Undo takes the words, then the paragraph.
    await clickBelowNote(window, editor, "editor");
    await expect(blocks(editor)).toHaveCount(6);
    await window.keyboard.type("Neap tides are weaker.");
    await expect(blocks(editor).last()).toHaveText("Neap tides are weaker.");

    // The Mind ends in a paragraph now: a click under it, near the right edge too, goes to its end.
    for (const across of [0.5, 0.95]) {
      await clickBelowNote(window, editor, "editor", across);
      expect(await cursorInLastBlock(editor)).toBe(true);
      await window.keyboard.type("!");
    }
    const typed = "Neap tides are weaker.!!";
    await expect(blocks(editor)).toHaveCount(6);
    await expect(blocks(editor).last()).toHaveText(typed);
    await expect(frontMindName(window)).toHaveText("Tides");

    // Undo groups typing by the time between keystrokes, so how much one Undo takes depends on how
    // far apart they were: on a slow machine it can split the text inside a word. Whatever it
    // leaves is the beginning of what was typed; a "!" left in it is taken by a second Undo.
    await window.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(
        async () => {
          const text = await lastText(editor);
          return text !== typed && typed.startsWith(text);
        },
        { message: "Undo leaves a shorter beginning of what was typed" },
      )
      .toBe(true);
    if ((await lastText(editor)).endsWith("!")) {
      await window.keyboard.press("ControlOrMeta+z");
    }
    await expect(blocks(editor).last()).not.toHaveText(/!/);
    await expect(blocks(editor)).toHaveCount(6);
    await app.close();
  });
}

test("a click under a table, inside the editor's own space, puts the cursor on a new paragraph under it, and Undo takes the paragraph away", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 660);
  await newMind(window);
  await nameMind(window, "Tide tables");
  await enterContent(window);
  await window.keyboard.type("Heights in metres.");
  const editor = window.getByTestId("mind-editor");
  await editor.evaluate((dom) => {
    const { commands } = (dom as unknown as { editor: Editor }).editor;
    commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false });
  });
  await expect(editor.locator(":scope > table, :scope > .tableWrapper")).toHaveCount(1);
  const lastIsTable = () =>
    blocks(editor)
      .last()
      .evaluate((block) => block.matches("table, .tableWrapper"));
  expect(await lastIsTable()).toBe(true);

  await clickBelowNote(window, editor, "block");
  await expect(blocks(editor).last()).toHaveText("");
  expect(await lastIsTable()).toBe(false);
  expect(await cursorInLastBlock(editor)).toBe(true);
  // A second click at once, as in a double click, doesn't make a second paragraph.
  const count = await blocks(editor).count();
  await clickBelowNote(window, editor, "editor");
  await expect(blocks(editor)).toHaveCount(count);
  await window.keyboard.type("Low water at six.");
  await expect(blocks(editor).last()).toHaveText("Low water at six.");

  // Undo groups typing by the time between keystrokes: on a slow machine the words take several.
  for (let text = await lastText(editor); text !== ""; text = await lastText(editor)) {
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => lastText(editor)).not.toBe(text);
  }
  await window.keyboard.press("ControlOrMeta+z");
  await expect.poll(lastIsTable).toBe(true);
  await app.close();
});

test("in an empty Mind a click under its line puts the cursor on it, and Chinese typed there lands in the note, not the title", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1100, 660);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await expect(editor).toBeVisible();

  await clickBelowNote(window, editor, "editor");
  await expect(editor).toBeFocused();
  await window.keyboard.type("大潮在朔日和望日。");
  await expect(blocks(editor)).toHaveCount(1);
  await expect(blocks(editor).first()).toHaveText("大潮在朔日和望日。");
  await app.close();
});
