import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import { footnotesOf, paragraphsOf, part, unzip } from "../tests/helpers/docx";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  addToNote,
  askInAssistant,
  clickEndOf,
  createDataFolder,
  dismissChatSetup,
  dragBlock,
  launchApp,
  leavingCopies,
  motionLook,
  motionRunning,
  motionSettled,
  newMind,
  removeDataFolder,
  runCommand,
  setMotionSpeed,
  setWindowSize,
  showCountWhileWriting,
  slideSelect,
  useLocalChatModel,
} from "./app";

/*
 * Footnotes the User writes (#284): inserted by keyboard, from the "/" menu,
 * from the selection menu and by typing "^[…]"; written and edited in place,
 * in the popover at the marker and in the footnote area; numbered in the
 * order they appear, as Blocks move; deleted, and back with Undo.
 */

/** Spring tides are on page 2. */
const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
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

/** The core's bridge, as the window has it. */
const bridge = (window: Page) => ({
  language: (language: "en" | "zh-CN") =>
    window.evaluate(
      (value) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
          user: { language: value },
        }),
      language,
    ),
  /** The open Mind (the only one) as a .docx, as Export would write it. */
  exportDocx: async () =>
    new Uint8Array(
      await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const [mind] = await core.listMinds();
        if (!mind) throw new Error("There is no Mind.");
        return Array.from((await core.exportMind(mind.id, { format: "docx" })).data);
      }),
    ),
});

/** Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots of footnotes. */
async function screenshot(target: Page | Locator, name: string): Promise<void> {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await target.screenshot({ path: join(folder, `${name}.png`) });
}

/** The footnotes' texts in the footnote area, in their order. */
const areaTexts = (window: Page) =>
  window.getByTestId("footnote-area").getByTestId("footnote-row").getByTestId("footnote-text");

test("footnotes by keyboard, the / menu, the selection menu and ^[…], edited in place, numbered as Blocks move, deleted and undone", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1280, 800);
  await dismissChatSetup(window);
  await newMind(window);
  await showCountWhileWriting(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type("Neap tides are weaker");
  await window.keyboard.press("Enter");
  await window.keyboard.type("Spring tides come at new moon");

  // ⌘K Insert Footnote puts one after the cursor and opens its text at the marker (⌥⌘F is Find and Replace, #1935).
  await runCommand(window, "footnote.insert", "Insert Footnote");
  const popover = window.getByTestId("footnote-popover");
  await expect(popover).toBeVisible();
  const field = popover.getByTestId("footnote-text");
  await expect(field).toBeFocused();
  await window.keyboard.type("Twice a month.");
  const marker = editor.getByTestId("footnote-marker").first();
  // Measured once the popover has grown from its marker.
  await motionSettled(window);
  const markerBox = await marker.boundingBox();
  const popoverBox = await popover.boundingBox();
  if (!markerBox || !popoverBox) throw new Error("The marker or its popover isn't visible.");
  expect(popoverBox.y).toBeGreaterThanOrEqual(markerBox.y + markerBox.height - 2);
  await screenshot(window, "footnote-popover-en");

  // Enter goes back to the text, right after the marker.
  await window.keyboard.press("Enter");
  await expect(popover).toHaveCount(0);
  await window.keyboard.type(" and at full moon.");
  const paragraphs = editor.locator(":scope > p");
  await expect(paragraphs).toHaveText([
    "Neap tides are weaker",
    "Spring tides come at new moon1 and at full moon.",
  ]);
  await expect(editor.getByTestId("footnote-marker")).toHaveText(["1"]);
  await expect(marker).toHaveAttribute("aria-label", "Footnote 1: Twice a month.");

  // The footnote area at the end of the Mind lists it.
  const area = window.getByTestId("footnote-area");
  await expect(area).toBeVisible();
  await expect(areaTexts(window)).toHaveText(["Twice a month."]);

  // The "/" menu, in the line above: its footnote is 1 now, and the first one 2.
  await clickEndOf(window, paragraphs.nth(0));
  await window.keyboard.type(" /footnote");
  await expect(window.getByTestId("slash-item-footnote")).toHaveAttribute("aria-selected", "true");
  await window.keyboard.press("Enter");
  await expect(popover).toBeVisible();
  await window.keyboard.type("At the quarter moons.");
  await window.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(areaTexts(window)).toHaveText(["At the quarter moons.", "Twice a month."]);
  await expect(editor.getByTestId("footnote-marker")).toHaveText(["1", "2"]);
  await expect(paragraphs).toHaveText([
    "Neap tides are weaker 1",
    "Spring tides come at new moon2 and at full moon.",
  ]);

  // The selection menu, by mouse: a footnote after the selected words.
  await slideSelect(window, paragraphs.nth(0), "Neap tides");
  await expect(window.getByTestId("selection-menu")).toBeVisible();
  await screenshot(window, "selection-menu-footnote-en");
  await window.getByTestId("format-footnote").hover();
  await window.getByTestId("format-footnote").click();
  await expect(popover).toBeVisible();
  await window.keyboard.type("Less pull.");
  await window.keyboard.press("Enter");
  await expect(areaTexts(window)).toHaveText([
    "Less pull.",
    "At the quarter moons.",
    "Twice a month.",
  ]);
  await expect(paragraphs).toHaveText([
    "Neap tides1 are weaker 2",
    "Spring tides come at new moon3 and at full moon.",
  ]);

  // Typing "^[…]" makes one, in a new line at the end.
  await clickEndOf(window, paragraphs.nth(1));
  await window.keyboard.press("Enter");
  await window.keyboard.type("Tide tables^[Published each year.]");
  await expect(paragraphs.nth(2)).toHaveText("Tide tables4");
  await expect(areaTexts(window)).toHaveText([
    "Less pull.",
    "At the quarter moons.",
    "Twice a month.",
    "Published each year.",
  ]);
  await screenshot(window, "footnote-area-en");

  // Edited in place in the area: the marker's text follows.
  await clickEndOf(window, areaTexts(window).nth(1));
  await expect(areaTexts(window).nth(1)).toBeFocused();
  await window.keyboard.type(" Roughly.");
  await expect(editor.getByTestId("footnote-marker").nth(1)).toHaveAttribute(
    "aria-label",
    "Footnote 2: At the quarter moons. Roughly.",
  );

  // Moving a Block renumbers: "Tide tables" dragged to the top takes 1.
  await dragBlock(window, paragraphs.nth(2), paragraphs.nth(0));
  await expect(paragraphs.nth(0)).toHaveText("Tide tables1");
  await expect(areaTexts(window)).toHaveText([
    "Published each year.",
    "Less pull.",
    "At the quarter moons. Roughly.",
    "Twice a month.",
  ]);
  // Undo puts it back, numbers and all.
  await window.keyboard.press("ControlOrMeta+Z");
  await expect(paragraphs.nth(2)).toHaveText("Tide tables4");
  await expect(areaTexts(window).first()).toHaveText("Less pull.");

  // By keyboard: from a footnote's number in the area to its marker; Backspace deletes it.
  await window.getByTestId("footnote-area").getByTestId("footnote-row-number").nth(2).click();
  await expect(editor).toBeFocused();
  await window.keyboard.press("Backspace");
  await expect(editor.getByTestId("footnote-marker")).toHaveText(["1", "2", "3"]);
  await expect(areaTexts(window)).toHaveText([
    "Less pull.",
    "At the quarter moons. Roughly.",
    "Published each year.",
  ]);
  await window.keyboard.press("ControlOrMeta+Z");
  await expect(areaTexts(window)).toHaveText([
    "Less pull.",
    "At the quarter moons. Roughly.",
    "Twice a month.",
    "Published each year.",
  ]);

  // The arrows select a marker, and Enter opens its text; "Remove footnote" deletes it, Undo too.
  await window.getByTestId("footnote-area").getByTestId("footnote-row-number").nth(2).click();
  await expect(editor).toBeFocused();
  await window.keyboard.press("ArrowLeft");
  await expect(editor.getByTestId("footnote").nth(2)).toHaveClass(/ProseMirror-selectednode/);
  await window.keyboard.press("Enter");
  await expect(popover).toBeVisible();
  await expect(field).toHaveText("Twice a month.");
  await popover.getByTestId("footnote-remove").hover();
  await popover.getByTestId("footnote-remove").click();
  await expect(popover).toHaveCount(0);
  await expect(editor.getByTestId("footnote-marker")).toHaveCount(3);
  await window.keyboard.press("ControlOrMeta+Z");
  await expect(editor.getByTestId("footnote-marker")).toHaveCount(4);

  // Clicking a marker opens it too; Undo while writing takes the typing back.
  await editor.getByTestId("footnote-marker").first().hover();
  await editor.getByTestId("footnote-marker").first().click();
  await expect(field).toHaveText("Less pull.");
  await expect(field).toBeFocused();
  await window.keyboard.type(" Much less.");
  await expect(areaTexts(window).first()).toHaveText("Less pull. Much less.");
  await window.keyboard.press("ControlOrMeta+Z");
  await expect(field).toHaveText("Less pull.");
  await expect(areaTexts(window).first()).toHaveText("Less pull.");
  await window.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  // The word count counts the text, not the footnotes the markers stand for.
  await expect(window.getByTestId("mind-count-button")).toHaveText("16 words");
  // A narrow window: the area's numbers come in from the margin, and its text still wraps by word.
  await setWindowSize(app, window, 900, 800);
  await expect(areaTexts(window).first()).toBeVisible();
  await screenshot(window, "footnote-area-en-900");
  await app.close();

  // After a restart the footnotes are there, in the same order, with their texts.
  const again = await launchApp(dataDir);
  await again.window.getByTestId("mind-list-item").click();
  await expect(again.window.getByTestId("mind-editor").getByTestId("footnote-marker")).toHaveText([
    "1",
    "2",
    "3",
    "4",
  ]);
  await expect(areaTexts(again.window)).toHaveText([
    "Less pull.",
    "At the quarter moons. Roughly.",
    "Twice a month.",
    "Published each year.",
  ]);
  await again.app.close();
});

test("in Chinese: footnotes typed with an input method number together with an Answer's Citations, one holds a found Citation, and Word gets them as real footnotes", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1100, 760);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await bridge(window).language("zh-CN");
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await newMind(window);
  await showCountWhileWriting(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type("Spring tides 大潮");

  // ⌘K 插入脚注 opens the footnote, named in Chinese; an input method writes its text.
  await runCommand(window, "footnote.insert", "插入脚注");
  const popover = window.getByTestId("footnote-popover");
  const field = popover.getByTestId("footnote-text");
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute("aria-label", "脚注 1 的内容");
  await expect(popover.getByTestId("footnote-remove")).toHaveText("删除脚注");
  const session = await window.context().newCDPSession(window);
  try {
    await session.send("Input.imeSetComposition", {
      text: "meiyue",
      selectionStart: 6,
      selectionEnd: 6,
    });
    await session.send("Input.insertText", { text: "每月两次。" });
    await expect(field).toHaveText("每月两次。");
    await expect(popover).toBeVisible();
    await window.keyboard.press("Enter");
    await expect(popover).toHaveCount(0);

    // "^[" then Chinese from the input method, then "]": a footnote too.
    await window.keyboard.type("^[");
    await session.send("Input.imeSetComposition", {
      text: "xiaochao",
      selectionStart: 8,
      selectionEnd: 8,
    });
    await session.send("Input.insertText", { text: "小潮在上下弦月" });
    await window.keyboard.type("]");
  } finally {
    await session.detach();
  }
  const markers = editor.getByTestId("footnote-marker");
  await expect(markers).toHaveText(["1", "2"]);
  await expect(markers.nth(1)).toHaveAttribute("aria-label", "脚注 2：小潮在上下弦月");
  const area = window.getByTestId("footnote-area");
  // Footnotes alone are headed only by their rule; the area is named for them.
  await expect(area.getByRole("heading")).toHaveCount(0);
  await expect(area).toHaveAttribute("aria-label", "脚注");
  await expect(areaTexts(window)).toHaveText(["每月两次。", "小潮在上下弦月"]);

  // An Answer's Citation, added to the note after them, is 3, in the text and the area.
  await addToNote(window, await askInAssistant(window, "When do spring tides happen?"));
  const answer = editor.locator(":scope > p").nth(1);
  await expect(answer.getByTestId("citation-chip")).toHaveText("3");
  const citationRow = area.getByTestId("footnote-row-citation");
  await expect(citationRow).toHaveAttribute("data-number", "3");
  await expect(citationRow).toHaveAttribute("data-check", "found");
  await expect(citationRow).toContainText("Tides");

  // A footnote holding a found Citation: the Answer's, copied into a new footnote's text.
  const copied = await editor.evaluate((dom) => {
    const { view } = (dom as unknown as { editor: Editor }).editor;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at < 0 && node.type.name === "citation") at = pos;
    });
    return view.serializeForClipboard(view.state.doc.slice(at, at + 1)).dom.innerHTML;
  });
  await clickEndOf(window, editor.locator(":scope > p").first());
  await runCommand(window, "footnote.insert", "插入脚注");
  await expect(field).toBeFocused();
  await window.keyboard.type("参见");
  // Pasted as the editor pastes it (the system clipboard is shared with the machine).
  await field.evaluate(
    (dom, html) => (dom as unknown as { editor: Editor }).editor.view.pasteHTML(html),
    copied,
  );
  const held = field.getByTestId("citation");
  await expect(held).toHaveAttribute("data-check", "found");
  await expect(held.getByTestId("citation-chip")).toContainText("Tides");
  await screenshot(window, "footnote-citation-zh");
  // Its card shows on hover, as any Citation's does; Esc closes the card, not the footnote.
  await held.getByTestId("citation-chip").hover();
  const card = window.getByTestId("citation-card");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-check", "found");
  await window.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(popover).toBeVisible();
  await expect(field).toBeFocused();
  await window.keyboard.press("Enter");
  // It is footnote 3 now, before the Answer's Citation, which becomes 4; the one inside has no number.
  await expect(markers).toHaveText(["1", "2", "3"]);
  await expect(answer.getByTestId("citation-chip")).toHaveText("4");
  await expect(areaTexts(window).nth(2)).toContainText("参见");
  await expect(areaTexts(window).nth(2).getByTestId("citation")).toHaveAttribute(
    "data-check",
    "found",
  );
  // The word count counts the text, not the footnotes' text the markers stand for.
  await expect(window.getByTestId("mind-count-button")).not.toHaveText(/^0/);
  await screenshot(window, "footnote-area-zh-1100");
  await setWindowSize(app, window, 900, 760);
  await expect(area).toBeVisible();
  await screenshot(window, "footnote-area-zh-900");

  // Word gets real footnotes, numbered as in the Mind.
  const files = unzip(await bridge(window).exportDocx());
  const footnotes = footnotesOf(part(files, "word/footnotes.xml"));
  expect(Object.keys(footnotes)).toEqual(["1", "2", "3", "4"]);
  expect(footnotes["1"]).toBe("每月两次。");
  expect(footnotes["2"]).toBe("小潮在上下弦月");
  expect(footnotes["3"]).toBe("参见 Tides，第 2 页");
  expect(footnotes["4"]).toBe("Tides，第 2 页");
  const paragraphs = paragraphsOf(part(files, "word/document.xml")).map((each) => each.text);
  expect(paragraphs).toContain("Spring tides 大潮[1][2][3]");
  await app.close();
});

test("two Citations of one page show that page's one footnote number, as Word numbers it (#2292)", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1100, 760);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await addToNote(window, await askInAssistant(window, "When do spring tides happen?"));
  const chip = editor.getByTestId("citation").first().getByTestId("citation-chip");
  await expect(chip).toHaveText("1");

  // The same page cited again, in a paragraph of its own: the same footnote's number, not the next.
  const copied = await editor.evaluate((dom) => {
    const { view } = (dom as unknown as { editor: Editor }).editor;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at < 0 && node.type.name === "citation") at = pos;
    });
    return view.serializeForClipboard(view.state.doc.slice(at, at + 1)).dom.innerHTML;
  });
  await clickEndOf(window, editor.locator(":scope > p").last());
  await window.keyboard.press("Enter");
  await window.keyboard.type("Spring tides come at new moon and at full moon.");
  await editor.evaluate(
    (dom, html) => (dom as unknown as { editor: Editor }).editor.view.pasteHTML(html),
    copied,
  );
  await expect(editor.getByTestId("citation-chip")).toHaveText(["1", "1"]);
  await screenshot(window, "citations-same-page-en");

  // The Word file holds that one footnote, the second mark a cross-reference to it.
  const files = unzip(await bridge(window).exportDocx());
  expect(footnotesOf(part(files, "word/footnotes.xml"))).toEqual({
    "1": "Tides, p. 2",
  });
  expect(part(files, "word/document.xml")).toContain("NOTEREF");
  await app.close();
});

for (const motion of ["on", "off"] as const) {
  test(`a Citation's card opened in a footnote closes before the footnote, and only it moves (motion ${motion})`, async () => {
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 1280, 800);
    await window.emulateMedia({ reducedMotion: "no-preference" });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await window.evaluate(
      (chosen) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
          device: { motion: chosen },
        }),
      motion,
    );
    await expect(window.locator("html")).toHaveAttribute("data-motion", motion);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.type("Spring tides");
    await addToNote(window, await askInAssistant(window, "When do spring tides happen?"));
    await expect(editor.getByTestId("citation")).toHaveAttribute("data-check", "found");

    // The Answer's Citation, kept in the note, copied into a footnote's text.
    const copied = await editor.evaluate((dom) => {
      const { view } = (dom as unknown as { editor: Editor }).editor;
      let at = -1;
      view.state.doc.descendants((node, pos) => {
        if (at < 0 && node.type.name === "citation") at = pos;
      });
      return view.serializeForClipboard(view.state.doc.slice(at, at + 1)).dom.innerHTML;
    });
    await clickEndOf(window, editor.locator(":scope > p").first());
    await runCommand(window, "footnote.insert", "Insert Footnote");
    const popover = window.getByTestId("footnote-popover");
    const field = popover.getByTestId("footnote-text");
    await expect(field).toBeFocused();
    await field.evaluate(
      (dom, html) => (dom as unknown as { editor: Editor }).editor.view.pasteHTML(html),
      copied,
    );
    const held = field.getByTestId("citation");
    await expect(held).toHaveAttribute("data-check", "found");
    await motionSettled(window);
    await setMotionSpeed(window, 0.2);

    // Its card opens over the footnote: on, it grows from its Citation; off, it is there at once.
    // The footnote, open already, isn't animated again.
    await held.getByTestId("citation-chip").hover();
    const card = window.getByTestId("citation-card");
    await expect(card).toBeVisible();
    const opening = await motionLook(card);
    if (motion === "on") {
      expect(opening.opacity).toBeLessThan(1);
      expect(opening.scale).toBeLessThan(1);
    } else {
      expect(opening).toMatchObject({ opacity: 1, scale: 1, y: 0 });
      expect(await motionRunning(window)).toBe(0);
    }
    expect(await motionLook(popover)).toMatchObject({ opacity: 1, scale: 1, y: 0 });
    await motionSettled(window);

    // Esc closes the card first: on, its copy goes back toward its Citation, the only thing
    // moving; the footnote stays as it was, with the focus.
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(popover).toBeVisible();
    if (motion === "on") {
      await expect.poll(async () => (await leavingCopies(window)).length).toBe(1);
      expect(await motionRunning(window)).toBe(1);
    } else {
      expect(await leavingCopies(window)).toEqual([]);
      expect(await motionRunning(window)).toBe(0);
    }
    expect(await motionLook(popover)).toMatchObject({ opacity: 1, scale: 1, y: 0 });
    await motionSettled(window);
    await expect(field).toBeFocused();

    // Then Esc closes the footnote, toward its marker.
    await window.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    if (motion === "on") {
      await expect.poll(async () => (await leavingCopies(window)).length).toBe(1);
    } else {
      expect(await leavingCopies(window)).toEqual([]);
    }
    await motionSettled(window);
    expect(await leavingCopies(window)).toEqual([]);
    await app.close();
  });
}
