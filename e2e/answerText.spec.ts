import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  addToNote,
  askInAssistant,
  assistantAnswers,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sizeAssistant,
  stubClipboard,
} from "./app";

/**
 * An Answer's text keeps to the Answer's edge and size in the assistant
 * (#612): lists, code, maths, tables and Citation markers, at the assistant's
 * narrowest and wider, in English and Chinese. The checks are relations
 * (inside, on one line, scrolls), never pixels. Set INCARNAMIND_SCREENSHOTS
 * to a folder to also save screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

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

/** The assistant's widths: its default and a wider one (the table fits at the last). */
const WIDTHS = [320, 420, 620];

async function start(language: "en" | "zh-CN") {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await connectLocalChatModel(window);
  await setLanguage(window, language);
  const paths: string[] = [];
  for (const name of ["Tides", "Moon", "Harbour", "Weather"]) {
    const path = join(sources, `${name}.pdf`);
    await writeFile(
      path,
      buildPdf([
        { lines: [`${name} and tides`, `Every ${name} document says tides rise and fall.`] },
      ]),
    );
    paths.push(path);
  }
  await addDocuments(window, paths);
  await newMind(window);
  return window;
}

async function shoot(target: Locator, name: string) {
  if (SCREENSHOTS) await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`an Answer's lists, code, maths, tables and Citation markers keep to its edge and size, in ${language}`, async () => {
    const window = await start(language);
    await askInAssistant(window, "Say something plain");
    await askInAssistant(window, "What do tides do in each Document?");
    await askInAssistant(window, "What do tides do in four columns?");
    const plain = assistantAnswers(window).nth(0);
    const cited = assistantAnswers(window).nth(1);
    const wide = assistantAnswers(window).nth(2);
    const assistant = window.getByTestId("assistant");

    // Scrolled to its end, the table's edge fades on the other side.
    const scrolled = wide.locator(".tableWrapper");
    await scrolled.evaluate((frame) => {
      frame.scrollLeft = frame.scrollWidth;
    });
    await expect(scrolled).toHaveAttribute("data-more-before", "");
    await expect(scrolled).not.toHaveAttribute("data-more-after", "");
    await scrolled.evaluate((frame) => {
      frame.scrollLeft = 0;
    });
    await expect(scrolled).toHaveAttribute("data-more-after", "");

    for (const wanted of WIDTHS) {
      await sizeAssistant(window, wanted);
      const width = wanted;

      // A list: its text starts 20px in from the Answer's edge, the bullet inside those 20px.
      const list = await plain.getByTestId("assistant-answer-text").evaluate((text) => {
        const edge = (text.querySelector(":scope > p") as HTMLElement).getBoundingClientRect().left;
        const lists = [...text.querySelectorAll("ul, ol")].map((each) => {
          const item = each.querySelector("li") as HTMLElement;
          return {
            list: each.getBoundingClientRect().left - edge,
            item: item.getBoundingClientRect().left - edge,
          };
        });
        return lists;
      });
      expect(list.length).toBeGreaterThan(0);
      for (const { list: listLeft, item } of list) {
        expect(Math.abs(listLeft)).toBeLessThanOrEqual(1);
        expect(item).toBeGreaterThanOrEqual(19);
      }

      // Code never wraps and stays inside the Answer's column.
      const code = await plain.getByTestId("assistant-answer-text").evaluate((text) => {
        const pre = text.querySelector("pre") as HTMLElement;
        const frame = text.getBoundingClientRect();
        const band = pre.getBoundingClientRect();
        const source = pre.querySelector("code") as HTMLElement;
        // A line longer than the band: it scrolls inside it.
        const long = document.createTextNode(` // ${"long ".repeat(60)}`);
        source.append(long);
        const range = document.createRange();
        range.selectNodeContents(source);
        const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
        const measured = {
          wraps: getComputedStyle(source).whiteSpace !== "pre",
          scrolls: pre.scrollWidth > pre.clientWidth,
          lines: lines.size,
          inside: band.left >= frame.left - 0.5 && band.right <= frame.right + 0.5,
        };
        long.remove();
        return measured;
      });
      expect(code).toEqual({ wraps: false, scrolls: true, lines: 1, inside: true });

      // Inline maths is no taller than its line.
      const maths = await plain.getByTestId("assistant-answer-text").evaluate((text) => {
        const formula = text.querySelector("li .katex") as HTMLElement;
        const line = formula.closest("p") as HTMLElement;
        return {
          formula: formula.getBoundingClientRect().height,
          line: Number.parseFloat(getComputedStyle(line).lineHeight),
        };
      });
      expect(maths.formula).toBeLessThanOrEqual(maths.line);

      // "this [1][2][3][4]." stays together, on the line of "this", at larger sizes too, which break the line earlier.
      for (const size of [14, 16, 18]) {
        const markers = await cited
          .getByTestId("assistant-answer-text")
          .evaluate((text, fontSize) => {
            (text as HTMLElement).style.fontSize = `${fontSize}px`;
            const paragraph = text.querySelector("p") as HTMLElement;
            const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
            let this_: DOMRect | null = null;
            let stop: DOMRect | null = null;
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              const value = node.nodeValue ?? "";
              const range = document.createRange();
              const at = value.indexOf("this");
              if (at >= 0) {
                range.setStart(node, at);
                range.setEnd(node, at + 4);
                this_ = range.getBoundingClientRect();
              }
              const dot = value.indexOf(".");
              if (dot >= 0 && value.trim() === ".") {
                range.setStart(node, dot);
                range.setEnd(node, dot + 1);
                stop = range.getBoundingClientRect();
              }
            }
            const chips = [...paragraph.querySelectorAll(".citation-marker")].map((chip) =>
              chip.getBoundingClientRect(),
            );
            return {
              this_: this_ && { top: this_.top, bottom: this_.bottom },
              stop: stop && { top: stop.top, bottom: stop.bottom, left: stop.left },
              chips: chips.map((chip) => ({
                top: chip.top,
                bottom: chip.bottom,
                left: chip.left,
                right: chip.right,
              })),
            };
          }, size);
        expect(markers.chips).toHaveLength(4);
        const thisLine = markers.this_ as { top: number; bottom: number };
        for (const chip of markers.chips) {
          // On the line of the word before: its middle is between that line's top and bottom.
          const middle = (chip.top + chip.bottom) / 2;
          expect(middle, `a marker at ${size}px`).toBeGreaterThan(thisLine.top);
          expect(middle, `a marker at ${size}px`).toBeLessThan(thisLine.bottom);
        }
        for (const [index, chip] of markers.chips.entries()) {
          const next = markers.chips[index + 1];
          if (next) expect(next.left - chip.right).toBeLessThanOrEqual(3);
        }
        const last = markers.chips[3] as { right: number };
        const stop = markers.stop as { top: number; bottom: number; left: number };
        // On the same line: the middle of the full stop is within the line of "this".
        const stopMiddle = (stop.top + stop.bottom) / 2;
        expect(stopMiddle).toBeGreaterThan(thisLine.top);
        expect(stopMiddle).toBeLessThan(thisLine.bottom);
        expect(stop.left - last.right).toBeLessThanOrEqual(2);
      }
      await cited.getByTestId("assistant-answer-text").evaluate((text) => {
        (text as HTMLElement).style.fontSize = "";
      });

      // A table wider than the Answer scrolls inside its frame, its cut edge faded.
      const table = wide.locator(".tableWrapper");
      const scrolls = await table.evaluate((frame) => ({
        wider: frame.scrollWidth > frame.clientWidth,
        overflow: getComputedStyle(frame).overflowX,
        fades: frame.hasAttribute("data-more-after"),
        faded: getComputedStyle(frame).maskImage !== "none",
      }));
      expect(scrolls.overflow).toBe("auto");
      // Wide enough for all of it, no cut and no fade; narrower, scrolling with its edge faded.
      expect(scrolls.fades).toBe(scrolls.wider);
      expect(scrolls.faded).toBe(scrolls.wider);
      if (width <= 320) expect(scrolls.wider).toBe(true);
      await shoot(assistant, `after-${language}-${width}`);
    }
  });
}

test("the marker glue is drawn only: no invisible character is in the Answer, its copy or the note it is added to", async () => {
  const window = await start("en");
  await askInAssistant(window, "What do tides do in each Document?");
  const answer = assistantAnswers(window).nth(0);
  const JOINER = "\u2060";

  const inDocument = await answer.getByTestId("assistant-answer-text").evaluate((text) => ({
    shown: text.textContent ?? "",
    stored: JSON.stringify((text as unknown as { editor: Editor }).editor.getJSON()),
  }));
  expect(inDocument.shown).not.toContain(JOINER);
  expect(inDocument.stored).not.toContain(JOINER);

  const copied = await stubClipboard(window);
  await pointAndClick(window, answer.getByTestId("answer-copy"));
  await expect(answer.getByTestId("answer-copy")).toHaveText("Copied");
  const clipboard = Object.values(await copied());
  expect(clipboard.length).toBeGreaterThan(0);
  for (const text of clipboard) expect(text).not.toContain(JOINER);

  await addToNote(window, answer);
  const note = window.getByTestId("mind-editor");
  await expect(note.getByTestId("citation")).toHaveCount(4);
  const noted = await note.evaluate((editor) =>
    JSON.stringify((editor as unknown as { editor: Editor }).editor.getJSON()),
  );
  expect(noted).not.toContain(JOINER);
  expect(await note.evaluate((editor) => editor.textContent ?? "")).not.toContain(JOINER);
});
