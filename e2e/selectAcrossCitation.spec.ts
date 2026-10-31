import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  createDataFolder,
  launchApp,
  leaveFirstOpen,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
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
    const before = citation?.closest(".node-citation")?.previousSibling;
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

for (const language of ["en", "zh-CN"] as const) {
  for (const width of [1600, 900] as const) {
    for (const paused of [true, false] as const) {
      test(`a Shift-press after a Citation, or on it, extends the selection through it (${language}, ${width}px, ${paused ? "after the menu shows" : "at once"})`, async () => {
        const { app, window } = await launchApp(dataDir, { examples: true });
        try {
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

          // Dragging across it does the same, to the character the pointer ends on.
          await window.keyboard.press("Escape");
          await window.waitForTimeout(520);
          await window.mouse.move(word.x, word.y, { steps: 3 });
          await window.mouse.down();
          await window.mouse.move(afterX, y, { steps: 6 });
          await window.mouse.up();
          const dragged = await selection(window);
          expect(dragged.covers).toBe(true);
          expect(dragged.text.startsWith(word.text)).toBe(true);
          expect(dragged.text.endsWith(tail)).toBe(true);
          expect(dragged.text.length).toBeLessThanOrEqual(word.text.length + 2 + tail.length);

          // With no selection to extend (a caret), a Shift-press on the Citation acts on it.
          await window.keyboard.press("Escape");
          await window.mouse.click(word.x, word.y);
          await shiftClick(window, box.x + box.width / 8, y);
          // Its card is pinned, so it stays once the pointer leaves.
          await expect(window.getByTestId("citation-card")).toHaveCount(1);
          await window.mouse.move(box.x - 15, box.y - 120);
          await expect(window.getByTestId("citation-card")).toHaveCount(1);
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
        const before = citation?.closest(".node-citation")?.previousSibling;
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
