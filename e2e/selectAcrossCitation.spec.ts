import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  focusSettled,
  launchApp,
  leaveFirstOpen,
  newMind,
  openExample,
  paintOf,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  showEveryCheckResult,
  tokenColor,
} from "./app";

/*
 * A Shift-press extends a Note's selection to where it landed, through a
 * Citation and past it (#2279). The browser's own extension goes by the last
 * selection's granularity: after a double-click that is a word, so a press
 * just past a Citation could keep the word alone, and a Citation's marker
 * takes its own press before the editor hears it. A press outside the
 * selection keeps its far end, and a press in another table cell is the
 * table's.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const editor = (window: Page) => window.getByTestId("mind-pane").getByTestId("mind-editor");

/** What the User sees selected, and whether it covers the first Citation. */
const selection = (window: Page) =>
  window.evaluate(() => {
    const chosen = getSelection();
    const citation = document.querySelector('[data-testid="citation"]');
    return {
      text: String(chosen?.toString()),
      covers: citation !== null && (chosen?.containsNode(citation, true) ?? false),
    };
  });

/** Presses Shift and clicks at a point, as a person does. */
async function shiftClick(window: Page, x: number, y: number): Promise<void> {
  await window.keyboard.down("Shift");
  try {
    await window.mouse.move(x, y, { steps: 4 });
    await window.mouse.down();
    await window.mouse.up();
  } finally {
    await window.keyboard.up("Shift");
  }
}

/** A point inside the word before the first Citation, at its left, and the word itself. */
const wordBefore = (window: Page) =>
  window.evaluate(() => {
    const citation = document.querySelector('[data-testid="citation"]');
    let before = citation?.closest(".node-citation")?.previousSibling;
    // The space before a Citation is drawn in a span of its own, so a chip never starts a line (#3654).
    if (before instanceof Element && before.classList.contains("citation-lead-space")) {
      before = before.previousSibling;
    }
    if (!(before instanceof Text)) return null;
    const text = before.data;
    let end = text.length;
    while (end > 0 && /\s/.test(text[end - 1] ?? "")) end--;
    let start = end;
    while (start > 0 && !/\s/.test(text[start - 1] ?? "")) start--;
    if (start === end) return null;
    const first = document.createRange();
    first.setStart(before, start);
    first.setEnd(before, start + 1);
    const rect = first.getBoundingClientRect();
    return {
      x: rect.x + rect.width / 4,
      y: rect.y + rect.height / 2,
      text: text.slice(start, end),
    };
  });

/**
 * The text from just after the Citation to the caret at a point: how far a press there should
 * reach. The Citation's own text is left out, as the page draws a selection over it.
 */
const tailAt = (window: Page, x: number, y: number) =>
  window.evaluate(
    ([x, y]) => {
      const citation = document.querySelector('[data-testid="citation"]');
      const wrapper = citation?.closest(".node-citation");
      if (!(wrapper instanceof Element)) return null;
      const caret = document.caretRangeFromPoint(x as number, y as number);
      if (!caret) return null;
      const range = document.createRange();
      range.setStartAfter(wrapper);
      range.setEnd(caret.startContainer, caret.startOffset);
      return range.toString();
    },
    [x, y],
  );

/**
 * Whether the selection covers the first character after the first Citation. The browser rounds a
 * drag's end by its own rule, so the drag is checked by what it selects, not by a caret position.
 */
const selectionThrough = (window: Page) =>
  window.evaluate(() => {
    const wrapper = document.querySelector('[data-testid="citation"]')?.closest(".node-citation");
    if (!(wrapper instanceof Element)) return false;
    const root = wrapper.closest('[data-testid="mind-editor"]') ?? wrapper.ownerDocument.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Text | null = null;
    for (let each = walker.nextNode(); each; each = walker.nextNode()) {
      if (wrapper.contains(each) || !(each instanceof Text)) continue;
      if (wrapper.compareDocumentPosition(each) & Node.DOCUMENT_POSITION_FOLLOWING) {
        node = each;
        break;
      }
    }
    if (!node) return false;
    const text = node.data;
    let index = 0;
    while (index < text.length && /\s/.test(text[index] ?? "")) index++;
    if (index >= text.length) return false;
    const chosen = getSelection();
    if (!chosen || chosen.rangeCount === 0) return false;
    return chosen.getRangeAt(0).isPointInRange(node, index + 1);
  });

/**
 * A point just past the first character after the first Citation, and that character. Four
 * pixels past the Citation can be before a full-width mark, so a drag ending there selects no
 * text after it (the Chinese fixture follows the Citation with `，`).
 */
const afterCharacter = (window: Page) =>
  window.evaluate(() => {
    const wrapper = document.querySelector('[data-testid="citation"]')?.closest(".node-citation");
    if (!(wrapper instanceof Element)) return null;
    const root = wrapper.closest('[data-testid="mind-editor"]') ?? wrapper.ownerDocument.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Text | null = null;
    for (let each = walker.nextNode(); each; each = walker.nextNode()) {
      if (wrapper.contains(each) || !(each instanceof Text)) continue;
      if (wrapper.compareDocumentPosition(each) & Node.DOCUMENT_POSITION_FOLLOWING) {
        node = each;
        break;
      }
    }
    if (!node) return null;
    const text = node.data;
    let index = 0;
    while (index < text.length && /\s/.test(text[index] ?? "")) index++;
    if (index >= text.length) return null;
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + 1);
    const rect = range.getBoundingClientRect();
    return { x: rect.right + 2, y: rect.y + rect.height / 2, char: text[index] as string };
  });

interface PageRecord {
  entries: object[];
  snapshot: () => object;
  stop: () => void;
}
type Recording = typeof globalThis & { atOnceRecord?: PageRecord };

/**
 * Starts recording in the page what a test can see of the presses that follow: each pointer,
 * mouse and Shift event with its time, target and phase, each selection change, and as each
 * passes, the browser's and the editor's selection and whether a Citation's card is open. Read
 * only when the test fails (`attachRecord`): the at-once press has failed only in the Nightly,
 * whose trace holds no page (#3697).
 */
const startRecord = (window: Page) =>
  window.evaluate(() => {
    const started = performance.now();
    const since = (time: number) => Math.round((time - started) * 10) / 10;
    const name = (node: Node | null): string => {
      if (!node) return "none";
      if (node instanceof Text) return `${name(node.parentNode)} "${node.data.slice(0, 16)}"`;
      if (!(node instanceof Element)) return node.nodeName;
      const id = node.getAttribute("data-testid");
      const classes = [...node.classList].slice(0, 3).join(".");
      return `${node.tagName.toLowerCase()}${id ? `[${id}]` : ""}${classes ? `.${classes}` : ""}`;
    };
    const root = document.querySelector('[data-testid="mind-pane"] [data-testid="mind-editor"]');
    // Reads only what needs no layout, so recording forces none the page wouldn't do itself.
    const snapshot = () => {
      const chosen = getSelection();
      const citation = document.querySelector('[data-testid="citation"]');
      const selected = (root as (Element & { editor?: Editor }) | null)?.editor?.state.selection;
      return {
        anchor: chosen?.anchorNode ? `${name(chosen.anchorNode)} @${chosen.anchorOffset}` : "none",
        head: chosen?.focusNode ? `${name(chosen.focusNode)} @${chosen.focusOffset}` : "none",
        covers: citation !== null && (chosen?.containsNode(citation, true) ?? false),
        editor: selected
          ? {
              anchor: selected.anchor,
              head: selected.head,
              kind: "node" in selected ? "node" : selected.empty ? "caret" : "range",
            }
          : null,
        card: document.querySelector('[data-testid="citation-card"]') !== null,
      };
    };
    const entries: object[] = [];
    const keep = (entry: object) => {
      if (entries.length < 1000) entries.push({ ...entry, ...snapshot() });
    };
    const heard = (phase: "capture" | "bubble") => (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Shift") return;
      keep({
        type: event.type,
        phase,
        at: since(event.timeStamp),
        handled: since(performance.now()),
        target: name(event.target instanceof Node ? event.target : null),
        ...(event instanceof MouseEvent && {
          x: event.clientX,
          y: event.clientY,
          buttons: event.buttons,
          detail: event.detail,
          shift: event.shiftKey,
        }),
        ...(phase === "bubble" && { prevented: event.defaultPrevented }),
      });
    };
    const capture = heard("capture");
    const bubble = heard("bubble");
    const changed = (event: Event) => keep({ type: event.type, at: since(event.timeStamp) });
    const types = [
      "pointerdown",
      "pointermove",
      "pointerup",
      "mousedown",
      "mousemove",
      "mouseup",
      "click",
      "dblclick",
      "keydown",
      "keyup",
    ];
    for (const type of types) {
      addEventListener(type, capture, true);
      addEventListener(type, bubble);
    }
    document.addEventListener("selectionchange", changed);
    const stop = () => {
      for (const type of types) {
        removeEventListener(type, capture, true);
        removeEventListener(type, bubble);
      }
      document.removeEventListener("selectionchange", changed);
    };
    (globalThis as Recording).atOnceRecord = { entries, snapshot, stop };
  });

/** Attaches the page's record of the presses to the failed test's report. */
async function attachRecord(window: Page): Promise<void> {
  const record = await window.evaluate(() => {
    const recording = (globalThis as Recording).atOnceRecord;
    if (!recording) return null;
    recording.stop();
    const end = { ...recording.snapshot(), text: String(getSelection()?.toString()) };
    return { entries: recording.entries, end };
  });
  if (!record) return;
  // A file, not a body: CI keeps a failed test's folder, where the list reporter names it.
  const path = test.info().outputPath("at-once-record.json");
  await writeFile(path, JSON.stringify(record, null, 2));
  await test.info().attach("at-once-record", { path, contentType: "application/json" });
}

for (const language of ["en", "zh-CN"] as const) {
  for (const width of [1600, 900] as const) {
    for (const paused of [true, false] as const) {
      test(`a Shift-press after a Citation, or on it, extends the selection through it (${language}, ${width}px, ${paused ? "after the menu shows" : "at once"})`, async () => {
        const { app, window } = await launchApp(dataDir, { examples: true });
        try {
          await openExample(window);
          await setWindowSize(app, window, width, 900);
          await setLanguage(window, language);
          await leaveFirstOpen(window);
          const chip = editor(window).getByTestId("citation-chip").first();
          await expect(chip).toHaveAttribute("data-check", "found", { timeout: 30_000 });
          await chip.evaluate((element) => element.scrollIntoView({ block: "center" }));
          const box = await chip.boundingBox();
          if (!box) throw new Error("The Citation isn't on screen.");
          const y = box.y + box.height / 2;
          const word = await wordBefore(window);
          if (!word) throw new Error("No word before the Citation.");
          const afterX = box.x + box.width + 4;
          const tail = await tailAt(window, afterX, y);
          if (tail === null) throw new Error("No place to press.");
          const beyond = await afterCharacter(window);
          if (!beyond) throw new Error("No character after the Citation.");

          if (!paused) await startRecord(window);
          // Double-click the word; a person's pause is the selection menu showing.
          await window.mouse.dblclick(word.x, word.y);
          if (paused) {
            await expect(window.getByTestId("selection-menu")).toBeVisible();
            const worded = await selection(window);
            expect(worded.covers).toBe(false);
            expect(worded.text.trim(), "The double-click selected nothing.").toBe(word.text);
          }

          // Just after the Citation: the word, the Citation and the text up to the press.
          await shiftClick(window, afterX, y);
          const past = await selection(window);
          expect(past.covers).toBe(true);
          // From the double-clicked word to the press and no further: the Citation is one character.
          expect(past.text.startsWith(word.text)).toBe(true);
          expect(past.text.endsWith(tail)).toBe(true);
          expect(past.text.length).toBeLessThanOrEqual(word.text.length + 2 + tail.length);

          // On the Citation's marker, at its left: it extends through the Citation too.
          await window.keyboard.press("Escape");
          // A second double-click on the same word within half a second is a triple-click to the
          // browser, which takes its paragraph; a person stops, then double-clicks again.
          await window.waitForTimeout(520);
          await window.mouse.dblclick(word.x, word.y);
          if (paused) await expect(window.getByTestId("selection-menu")).toBeVisible();
          await shiftClick(window, box.x + box.width / 8, y);
          const onIt = await selection(window);
          expect(onIt.covers).toBe(true);
          // Through the Citation and no further, whichever half of the marker was pressed.
          expect(onIt.text.startsWith(word.text)).toBe(true);
          expect(onIt.text.length).toBeLessThanOrEqual(word.text.length + 2);
          await window.mouse.move(box.x - 15, box.y - 120);
          await expect(window.getByTestId("citation-card")).toHaveCount(0);
          await expect(window.getByTestId("viewer")).toHaveCount(0);

          // Dragging past the character after the Citation does the same, to where the pointer ends.
          await window.keyboard.press("Escape");
          await window.waitForTimeout(520);
          // From a caret: pressing inside the still-selected word drags the text, so the selection
          // wouldn't move (Linux does; macOS starts a new selection).
          await window.mouse.click(word.x, word.y);
          await window.waitForTimeout(520);
          await window.mouse.move(word.x, word.y, { steps: 3 });
          await window.mouse.down();
          // Well past the character, as a browser can round a drag's end back to the boundary
          // before the pointer (Linux does), which would leave that character out.
          await window.mouse.move(beyond.x + 12, beyond.y, { steps: 6 });
          await window.mouse.up();
          const draggedTail = await tailAt(window, beyond.x + 12, beyond.y);
          if (draggedTail === null) throw new Error("No place to end the drag.");
          const dragged = await selection(window);
          expect(dragged.covers).toBe(true);
          expect(dragged.text.startsWith(word.text)).toBe(true);
          // The drag ends past the character that follows the Citation, and the selection covers
          // it. The browser rounds a drag's end by its own rule, so the end is bounded, not exact.
          expect(
            await selectionThrough(window),
            "The character after the Citation is selected.",
          ).toBe(true);
          expect(dragged.text.length).toBeLessThanOrEqual(
            word.text.length + 2 + draggedTail.length + 2,
          );

          // With no selection to extend (a caret), a Shift-press on the Citation acts on it.
          // The drag's menu opens a moment after its mouseup; closed, it cannot cover the word.
          await expect(window.getByTestId("selection-menu")).toBeVisible();
          await window.keyboard.press("Escape");
          await expect(window.getByTestId("selection-menu")).toHaveCount(0);
          // The drag began on the same word; a click within half a second of that press is a
          // double-click to the browser, which takes the word rather than leaving a caret.
          await window.waitForTimeout(520);
          await window.mouse.click(word.x, word.y);
          expect(
            await window.evaluate(() => getSelection()?.type),
            "The plain click left a caret, so there is nothing to extend.",
          ).toBe("Caret");
          // Run the page's clock, so the card this press pins must outlive the hover peek, which
          // closes 200 ms after the pointer leaves (peek.ts); an unpinned card would be gone.
          await window.clock.install();
          await shiftClick(window, box.x + box.width / 8, y);
          await window.mouse.move(box.x - 15, box.y - 120);
          await window.clock.runFor(400);
          await expect(window.getByTestId("citation-card")).toHaveCount(1);
          await window.clock.resume();
        } catch (error) {
          if (!paused) {
            await attachRecord(window).catch((problem: unknown) =>
              console.warn(`The record of the at-once presses was not kept: ${problem}`),
            );
          }
          throw error;
        } finally {
          await app.close();
        }
      });
    }
  }
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a Shift-press before the selection keeps its far end, and one in another table cell selects cells (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { examples: true });
    try {
      await openExample(window);
      await setWindowSize(app, window, language === "en" ? 1600 : 900, 900);
      await setLanguage(window, language);
      await leaveFirstOpen(window);
      const chip = editor(window).getByTestId("citation-chip").first();
      await expect(chip).toHaveAttribute("data-check", "found", { timeout: 30_000 });
      await chip.evaluate((element) => element.scrollIntoView({ block: "center" }));
      const box = await chip.boundingBox();
      if (!box) throw new Error("The Citation isn't on screen.");
      const y = box.y + box.height / 2;
      const word = await wordBefore(window);
      if (!word) throw new Error("No word before the Citation.");
      // An earlier word on the same line, with what the far end keeps when it is pressed.
      const earlier = await window.evaluate(() => {
        const citation = document.querySelector('[data-testid="citation"]');
        let before = citation?.closest(".node-citation")?.previousSibling;
        if (before instanceof Element && before.classList.contains("citation-lead-space")) {
          before = before.previousSibling;
        }
        if (!(before instanceof Text)) return null;
        const text = before.data;
        let end = text.length;
        while (end > 0 && /\s/.test(text[end - 1] ?? "")) end--;
        let start = end;
        while (start > 0 && !/\s/.test(text[start - 1] ?? "")) start--;
        let back = start - 1;
        while (back > 0 && /\s/.test(text[back] ?? "")) back--;
        let from = back;
        while (from > 0 && !/\s/.test(text[from - 1] ?? "")) from--;
        if (from >= back) return null;
        const range = document.createRange();
        range.setStart(before, from);
        range.setEnd(before, from + 1);
        const rect = range.getBoundingClientRect();
        const point = document.caretRangeFromPoint(
          rect.x + rect.width / 4,
          rect.y + rect.height / 2,
        );
        if (!point) return null;
        const kept = document.createRange();
        kept.setStart(point.startContainer, point.startOffset);
        kept.setEnd(before, end);
        return {
          x: rect.x + rect.width / 4,
          y: rect.y + rect.height / 2,
          expected: kept.toString(),
        };
      });
      if (!earlier) throw new Error("No earlier word.");

      // Double-click the word before the Citation, then press Shift inside the earlier word.
      await window.mouse.dblclick(word.x, word.y);
      await expect(window.getByTestId("selection-menu")).toBeVisible();
      // The menu can sit over the earlier word; closed, the selection stays where it is.
      await window.keyboard.press("Escape");
      await shiftClick(window, earlier.x, earlier.y);
      const kept = await selection(window);
      expect(kept.text, "The double-clicked word's far end is kept.").toBe(earlier.expected);
      expect(
        kept.text.endsWith(word.text),
        "The selection ends with the double-clicked word.",
      ).toBe(true);

      // A Shift-press into another table cell is the table's: a range of cells, not text.
      await window.keyboard.press("Escape");
      await window.mouse.click(box.x - 15, y);
      await window.keyboard.press("End");
      await window.keyboard.press("Enter");
      await window.keyboard.type("/");
      await pointAndClick(window, window.getByTestId("slash-item-table"));
      const cells = editor(window).locator("th, td");
      await expect(cells).toHaveCount(9);
      await expect(cells.first()).toBeVisible();
      await pointAndClick(window, cells.first());
      await window.keyboard.type("cell");
      await expect(cells.first()).toContainText("cell");
      const cellWord = await cells.first().evaluate((cell) => {
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        const text = walker.nextNode();
        if (!(text instanceof Text) || !text.data.trim()) return null;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 1);
        const rect = range.getBoundingClientRect();
        return { x: rect.x + rect.width / 4, y: rect.y + rect.height / 2 };
      });
      if (!cellWord) throw new Error("No word in the first cell.");
      await window.mouse.dblclick(cellWord.x, cellWord.y);
      expect((await selection(window)).text.trim()).toBe("cell");
      await shiftClick(window, ...(await centreOf(cells.nth(1))));
      expect(
        await window.locator(".selectedCell").count(),
        "The two cells are selected, as the table selects them.",
      ).toBe(2);
    } finally {
      await app.close();
    }
  });
}

/** The middle of an element, as a point to press. */
async function centreOf(target: Locator): Promise<[number, number]> {
  const box = await target.boundingBox();
  if (!box) throw new Error("The element isn't on screen.");
  return [box.x + box.width / 2, box.y + box.height / 2];
}

/*
 * What a selection covers reads as selected. The browser paints a selection behind text and a
 * Citation's marker is none, so the marker and the gaps beside it are washed by the stylesheet,
 * and so is the mark of a sentence the selection covers whole. Read from the window's own pixels:
 * a row along the selected line shows no page-coloured gap, a bare mark shows the page.
 */

const SOURCES = {
  "Strategy review": "# Strategy review\n\nA clear strategy guides every team.\n",
  "Teams report": "# Teams report\n\nTeams and departments work together.\n",
} as const;

const SENTENCES = {
  en: {
    checked: [
      "Our plan rests on a clear strategy,",
      " and on collaboration across teams and departments",
      ".",
    ],
    // Letters past the first Citation that a selection reaches, on the line it stands on.
    past: 7,
    another: "Costs fell in the second quarter.",
    plain: ["Later, the board approved the budget", "."],
  },
  "zh-CN": {
    checked: ["我们的计划建立在清晰的战略之上，", "并依靠各团队和部门之间的协作", "。"],
    past: 4,
    another: "第二季度的运营成本有所下降。",
    plain: ["随后，董事会批准了预算", "。"],
  },
} as const;

/** The Note's paragraphs: a checked sentence with Citations, another checked one, and one Citation in plain words. */
function citedParagraphs(
  language: "en" | "zh-CN",
  documents: Record<string, { id: string; name: string; contentHash: string }>,
) {
  const words = SENTENCES[language];
  const cite = (name: keyof typeof SOURCES, quote: string) => {
    const document = documents[name];
    if (!document) throw new Error(`${name} wasn't added.`);
    return {
      type: "citation",
      attrs: {
        documentId: document.id,
        documentName: document.name,
        contentHash: document.contentHash,
        quote,
        check: "found",
        checkReason: null,
      },
    };
  };
  const first = cite("Strategy review", "A clear strategy guides every team.");
  const second = cite("Teams report", "Teams and departments work together.");
  const check = (text: string) => ({
    type: "claimCheck",
    attrs: {
      id: randomUUID(),
      request: "check-1",
      action: "check-against-documents",
      state: "supported",
      text,
      scope: { folderId: null, widened: false },
      versions: [],
      excluded: [],
      checkedAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  const sentence = check(words.checked.join(""));
  const marked = (node: object) => ({ ...node, marks: [sentence] });
  const text = (value: string, marks: object[] = []) => ({ type: "text", text: value, marks });
  return [
    {
      type: "paragraph",
      content: [
        text(words.checked[0], [sentence]),
        marked(first),
        text(words.checked[1], [sentence]),
        marked(second),
        marked(first),
        text(words.checked[2], [sentence]),
      ],
    },
    { type: "paragraph", content: [text(words.another, [check(words.another)])] },
    {
      type: "paragraph",
      content: [text(words.plain[0]), first, text(words.plain[1])],
    },
  ];
}

/**
 * The first paragraph's first line, as points to press and rows to read, in window pixels: the
 * line's top edge, and the top of its letters' own box, which a font may keep inside it.
 */
const firstLine = (window: Page, past: number) =>
  window.evaluate((count) => {
    const paragraph = document.querySelector(
      '[data-testid="mind-pane"] [data-testid="mind-editor"] > p',
    );
    const wrapper = paragraph?.querySelector(".node-citation");
    if (!paragraph || !wrapper) throw new Error("There is no Citation in the first paragraph.");
    const texts: Text[] = [];
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    for (let each = walker.nextNode(); each; each = walker.nextNode()) {
      if (
        each instanceof Text &&
        each.data.trim() &&
        !each.parentElement?.closest(".node-citation")
      ) {
        texts.push(each);
      }
    }
    const first = texts[0];
    const after = texts.find(
      (each) => wrapper.compareDocumentPosition(each) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    if (!first || !after) throw new Error("The paragraph has no words around the Citation.");
    const rectOf = (node: Text, from: number, to: number) => {
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, to);
      return range.getBoundingClientRect();
    };
    const start = rectOf(first, 0, 1);
    const reach = rectOf(after, count - 1, count);
    return {
      lineTop: paragraph.getBoundingClientRect().top,
      top: start.top,
      from: { x: start.left + 0.5, y: start.top + start.height / 2 },
      to: { x: reach.right + 0.5, y: reach.top + reach.height / 2 },
    };
  }, past);

/** The colour of each pixel along a row of the window, as a User sees it: a capture of the row, read back through a canvas. */
async function rowColours(window: Page, x: number, y: number, width: number): Promise<string[]> {
  const row = await window.screenshot({
    clip: { x: Math.ceil(x), y: Math.floor(y), width: Math.floor(width), height: 1 },
  });
  return window.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The capture can't be read.");
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, 1);
    const colours: string[] = [];
    for (let at = 0; at < data.length; at += 4) {
      colours.push(`${data[at]}, ${data[at + 1]}, ${data[at + 2]}`);
    }
    return colours;
  }, row.toString("base64"));
}

/** The red, green and blue of a computed colour, `rgb(…)` or `color(srgb …)`, from 0 to 255. */
function channels(colour: string): [number, number, number] {
  const [red = 0, green = 0, blue = 0] = (colour.match(/\d*\.?\d+/g) ?? []).map(Number);
  return colour.startsWith("color(") ? [red * 255, green * 255, blue * 255] : [red, green, blue];
}

/** WCAG's contrast ratio of two computed colours. */
function contrast(a: string, b: string): number {
  const luminance = (colour: string) => {
    const [red, green, blue] = channels(colour).map((value) => {
      const scaled = value / 255;
      return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
  };
  const [light = 0, dark = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

for (const language of ["en", "zh-CN"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`a Citation inside a selection is washed as its words are, one outside is not, and the sentence's mark goes with it (${language}, ${theme})`, async () => {
      test.setTimeout(120_000);
      const words = SENTENCES[language];
      const sources = await createDataFolder();
      const { app, window } = await launchApp(dataDir);
      try {
        await dismissChatSetup(window);
        const paths: string[] = [];
        for (const [name, text] of Object.entries(SOURCES)) {
          const path = join(sources, `${name}.md`);
          await writeFile(path, text);
          paths.push(path);
        }
        await addDocuments(window, paths);
        await expectReadyDocuments(window, paths.length);
        const documents = await window.evaluate(async () => {
          const listed = await (
            globalThis as unknown as { incarnamind: CoreBridge }
          ).incarnamind.listDocuments();
          return Object.fromEntries(
            listed.map((each) => [
              each.name,
              { id: each.id, name: each.name, contentHash: each.contentHash },
            ]),
          );
        });
        await setLanguage(window, language);
        await window.evaluate(
          (appearance) =>
            (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
              device: { appearance },
            }),
          theme,
        );
        await setWindowSize(app, window, 1600, 900);
        await newMind(window);
        await editor(window).evaluate(
          (dom, content) => {
            (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
          },
          citedParagraphs(language, documents),
        );
        const chips = editor(window).getByTestId("citation-chip");
        await expect(chips).toHaveCount(4);
        for (const chip of await chips.all()) {
          await expect(chip).toHaveAttribute("data-check", "found", { timeout: 30_000 });
        }
        await showEveryCheckResult(window);
        const marks = window.getByTestId("claim-mark");
        await expect(marks).toHaveCount(2);
        await expect(marks.first()).toBeVisible();

        const wash = await tokenColor(window, "--color-selection");
        const held = await tokenColor(window, "--color-selection-inactive");
        const [pageRed, pageGreen, pageBlue] = channels(await tokenColor(window, "--color-sheet"));
        const page = `${pageRed}, ${pageGreen}, ${pageBlue}`;
        const wrapperOf = (chip: Locator) =>
          chip.locator("xpath=ancestor::*[contains(@class,'node-citation')][1]");
        const background = async (target: Locator) => (await paintOf(target)).background;
        /** The wash a Citation's marker and the gaps beside it stand on while the Note has the focus. */
        const washBehind = (chip: Locator) =>
          chip.evaluate((marker) => {
            const citation = marker.closest('[data-testid="citation"]');
            return citation ? getComputedStyle(citation, "::after").backgroundColor : "";
          });
        const line = await firstLine(window, words.past);
        const plain = editor(window).locator("p").filter({ hasText: words.plain[0] });
        // A click in the last paragraph's empty end, so the next press starts from a caret.
        const clear = async () => {
          const at = await plain.boundingBox();
          if (!at) throw new Error("The last paragraph isn't on screen.");
          await window.mouse.click(at.x + at.width - 4, at.y + at.height / 2);
          await focusSettled(window, editor(window));
        };
        const drag = async (to: { x: number; y: number }) => {
          await clear();
          await window.mouse.move(line.from.x, line.from.y, { steps: 3 });
          await window.mouse.down();
          await window.mouse.move(to.x, to.y, { steps: 12 });
          await window.mouse.up();
          await expect(window.getByTestId("selection-menu")).toBeVisible();
        };
        /** How many pixels of a row, from the first letter to a few past the Citation, show the page and not the selection. */
        const gaps = async (row: number) =>
          (await rowColours(window, line.from.x + 2, row, line.to.x - line.from.x - 24)).filter(
            (colour) => colour === page,
          ).length;

        /** Whether the page shows beside a mark's icon, in its padding: a bare mark does, a washed one doesn't. */
        const pageBehind = async (mark: Locator) => {
          const box = await mark.boundingBox();
          if (!box) throw new Error("The mark isn't on screen.");
          const beside = await rowColours(window, box.x + 1, box.y + box.height / 2, 2);
          return beside.every((colour) => colour === page);
        };

        // Words from the first letter to just past the first Citation.
        await drag(line.to);
        expect((await selection(window)).covers, "The selection covers the Citation.").toBe(true);
        // The wash stands as tall as the line, so a row just inside its top edge crosses no gap.
        await expect
          .poll(() => gaps(line.lineTop + 1), { message: "The page shows through the selection." })
          .toBe(0);
        const chip = chips.first();
        await expect.poll(() => washBehind(chip)).toBe(wash);
        const marker = await paintOf(chip);
        expect(marker.background).toBe(wash);
        expect(
          contrast(marker.color, marker.background),
          "The Citation's number is readable on the wash.",
        ).toBeGreaterThanOrEqual(4.5);
        // A sentence the selection covers in part keeps its mark as it was; a Citation outside it keeps its own.
        expect(await pageBehind(marks.first())).toBe(true);
        const outside = chips.last();
        expect(await washBehind(outside)).toBe("rgba(0, 0, 0, 0)");
        expect(await background(outside)).toBe(await tokenColor(window, "--color-chip"));

        // The whole sentence, taken by a triple-click: its mark is washed with it, and the other sentence's is not.
        await clear();
        await window.mouse.move(line.from.x + 20, line.from.y, { steps: 3 });
        await window.mouse.click(line.from.x + 20, line.from.y, { clickCount: 3 });
        await expect(window.getByTestId("selection-menu")).toBeVisible();
        await expect
          .poll(() => pageBehind(marks.first()), {
            message: "The sentence's mark is bare in its selection.",
          })
          .toBe(false);
        expect(await pageBehind(marks.last()), "The other sentence's mark is washed.").toBe(true);
        expect(await background(marks.first())).toBe(wash);
        expect(await background(outside)).toBe(await tokenColor(window, "--color-chip"));

        // The Note loses the focus to the assistant's input: the selection stays, in the grey a window not in front draws.
        await window.getByTestId("composer-input").click();
        await expect
          .poll(() => gaps(line.top + 2), { message: "The page shows through the held selection." })
          .toBe(0);
        await expect.poll(() => background(wrapperOf(chip))).toBe(held);
        expect(await background(chip)).toBe(held);
        expect(await background(marks.first())).toBe(held);
      } finally {
        await app.close();
        await removeDataFolder(sources);
      }
    });
  }
}
