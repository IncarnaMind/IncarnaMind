import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  askInAssistant,
  assistantAnswers,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  focusRingShows,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sizeAssistant,
  startSamples,
  stopSamples,
  tabMenu,
  tabTo,
} from "./app";

/**
 * What an Answer in the assistant holds fits the Answer (#898), at the sizes the assistant is
 * narrowest in, in English and Chinese: a wide table scrolls inside it, first column in view,
 * and opens as a table in a tab, from an icon on its corner that only a table wider than the
 * assistant has (#1382); Citation badges wrap with their sentence and never pass its text.
 * The checks are relations (inside, on one line, beside), never pixels.
 */
const SIZES = [
  { width: 1100, height: 760 },
  { width: 1440, height: 900 },
] as const;

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

async function start(language: "en" | "zh-CN", width: number, height: number) {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
  await setWindowSize(app, window, width, height);
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

const QUESTIONS = {
  en: {
    table: "What do tides do in nine rows",
    forty: "What do tides do with forty citations",
    row: "What do tides do, twelve in a row",
    two: "What do tides do in two tables",
    compare: "Compare the two contracts on tides",
  },
  "zh-CN": {
    table: "九行 tides",
    forty: "四十条引用 tides",
    row: "连续十二条 tides",
    two: "两个表 tides",
    compare: "比较两份合同 tides",
  },
} as const;

const WORDS = {
  en: {
    open: "Open as a table",
    nth: (n: number) => `Open table ${n} as a table`,
    find: "table",
    header: ["Figure", "Harrow Foods", "Brightmart", "Calder Grocers"],
    second: ["Region", "Share"],
  },
  "zh-CN": {
    open: "以表格打开",
    nth: (n: number) => `以表格打开第 ${n} 个表格`,
    find: "表格",
    header: ["指标", "哈罗食品", "明智超市", "考尔德杂货"],
    second: ["地区", "占比"],
  },
} as const;

/** A Mind made from an Answer says nothing: Delete from its tab takes it back. */
async function deleteShownMind(window: Page, tabs: Locator): Promise<void> {
  await pointAndClick(window, (await tabMenu(window)).getByTestId("mind.delete"));
  await expect(tabs).toHaveCount(1);
}

function reachesPast(answer: Locator) {
  return answer.getByTestId("assistant-answer-text").evaluate((text) => {
    const box = text.getBoundingClientRect();
    const past: string[] = [];
    for (const element of text.querySelectorAll("*")) {
      // A table's cells are in its own frame, which scrolls: the frame is what must fit.
      const inFrame = element.closest(".tableWrapper");
      if (inFrame && inFrame !== element) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0) continue;
      if (rect.width > box.width + 0.5 || rect.right > box.right + 0.5) {
        past.push(`${element.tagName.toLowerCase()}.${element.className}`);
      }
    }
    const thread = text.closest('[role="log"]')?.parentElement;
    return { past, threadScrollsSideways: thread ? thread.scrollWidth > thread.clientWidth : null };
  });
}

const leftFadeShows = (frame: Locator) =>
  frame.evaluate((each) => {
    const cell = each.querySelector("tr > :first-child");
    if (!cell) return null;
    const { content } = getComputedStyle(cell, "::after");
    return content !== "none" && content !== "normal";
  });

for (const { width, height } of SIZES) {
  for (const language of ["en", "zh-CN"] as const) {
    test(`at ${width} × ${height}, in ${language}: a wide table scrolls to every column and opens as a table, and a run of Citations stays in the Answer`, async () => {
      test.setTimeout(240_000);
      const window = await start(language, width, height);
      const asked = QUESTIONS[language];
      const words = WORDS[language];

      await test.step("the table scrolls inside the Answer", async () => {
        const answer = await askInAssistant(window, asked.table);
        const text = answer.getByTestId("assistant-answer-text");
        const frame = text.locator(".tableWrapper");
        await expect(text.locator("table tr")).toHaveCount(10);
        await expect(frame.locator("tr").first().locator("th")).toHaveCount(4);

        expect(await reachesPast(answer)).toEqual({ past: [], threadScrollsSideways: false });

        const sizes = await frame.evaluate((each) => ({
          scrolls: each.scrollWidth > each.clientWidth,
          overflow: getComputedStyle(each).overflowX,
        }));
        expect(sizes).toEqual({ scrolls: true, overflow: "auto" });
        await expect(frame).toHaveAttribute("tabindex", "0");
        await expect(frame).toHaveAttribute("role", "region");

        const cut = await frame.evaluate((each) => {
          const cells = [...each.querySelectorAll("td:not(:first-child), th:not(:first-child)")];
          return cells
            .filter((cell) => {
              const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
              const lines = new Set<number>();
              for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (node.parentElement?.closest(".citation")) continue;
                const range = document.createRange();
                range.selectNodeContents(node);
                for (const rect of range.getClientRects()) lines.add(Math.round(rect.top));
              }
              return cell.scrollWidth > cell.clientWidth || lines.size > 1;
            })
            .map((cell) => cell.textContent);
        });
        expect(cut).toEqual([]);

        await expect(frame).toHaveAttribute("data-more-after", "");
        expect(await leftFadeShows(frame)).toBe(false);
        await tabTo(window, frame);
        expect(await focusRingShows(window)).toBe(true);
        const ring = await frame.evaluate((each) => {
          const style = getComputedStyle(each);
          return {
            offset: Number.parseFloat(style.outlineOffset),
            masked: style.maskImage !== "none",
          };
        });
        expect(ring.offset).toBeLessThanOrEqual(-2);
        expect(ring.masked).toBe(false);

        /**
         * A key scrolls the frame over a moment, so it is read once it rests, or as soon as it is
         * at its end: a key read at once sometimes leaves the last column unseen (#1521).
         */
        const frameAtRest = (from: number) =>
          frame.evaluate(
            (each, was) =>
              new Promise<void>((resolve) => {
                const atEnd = () => each.scrollLeft + each.clientWidth >= each.scrollWidth - 1;
                let last = -1;
                let still = 0;
                const settle = () => {
                  still = each.scrollLeft === last ? still + 1 : 0;
                  last = each.scrollLeft;
                  if (still >= 2) resolve();
                  else requestAnimationFrame(settle);
                };
                let waited = 0;
                const started = () => {
                  // Two seconds with no movement: the key took nothing, and the read after it says why.
                  if (++waited > 120) resolve();
                  else if (each.scrollLeft !== was || atEnd()) settle();
                  else requestAnimationFrame(started);
                };
                requestAnimationFrame(started);
              }),
            from,
          );
        const readFrame = () =>
          frame.evaluate((each) => {
            const frameBox = each.getBoundingClientRect();
            const headings = [...each.querySelectorAll<HTMLElement>("tr:first-child > *")];
            const first = headings[0];
            if (!first) throw new Error("The table has no heading row.");
            const firstBox = first.getBoundingClientRect();
            const visible = headings.flatMap((heading, column) => {
              const box = heading.getBoundingClientRect();
              return column > 0 &&
                box.left >= firstBox.right - 0.5 &&
                box.right <= frameBox.right + 1.5
                ? [column]
                : [];
            });
            const middle = document.elementFromPoint(
              firstBox.left + firstBox.width / 2,
              firstBox.top + firstBox.height / 2,
            );
            return {
              visible,
              firstAtEdge: Math.abs(firstBox.left - frameBox.left) <= 1,
              firstInFront: first.contains(middle),
              atEnd: each.scrollLeft + each.clientWidth >= each.scrollWidth - 1,
              scrollLeft: each.scrollLeft,
            };
          });

        const seen = new Set<number>();
        let state = await readFrame();
        for (let press = 0; press < 40; press++) {
          for (const column of state.visible) seen.add(column);
          expect(state.firstAtEdge).toBe(true);
          expect(state.firstInFront).toBe(true);
          if (state.atEnd) break;
          await window.keyboard.press("ArrowRight");
          await frameAtRest(state.scrollLeft);
          state = await readFrame();
        }
        for (const column of state.visible) seen.add(column);
        expect([...seen].sort()).toEqual([1, 2, 3]);
        await expect(frame).not.toHaveAttribute("data-more-after", "");
        await expect(frame).toHaveAttribute("data-more-before", "");
        expect(await leftFadeShows(frame)).toBe(true);
        expect(await focusRingShows(window)).toBe(true);
      });

      await test.step("Open as a table shows all of it in a tab beside the Mind", async () => {
        const answer = window.getByTestId("assistant-answer").last();
        const tabs = window.getByTestId("mind-tab");
        await expect(tabs).toHaveCount(1);
        const original = await tabs.first().getAttribute("title");
        const note = window.getByTestId("mind-editor");
        const before = await note.textContent();

        const open = answer.getByTestId("answer-open-table");
        await expect(open).toHaveAccessibleName(words.open);
        const opener = await open.boundingBox();
        const table = await answer.locator(".tableWrapper").boundingBox();
        if (!opener || !table) throw new Error("The table or its button isn't visible.");
        expect(opener.y).toBeGreaterThanOrEqual(table.y - 1);
        expect(opener.y + opener.height).toBeLessThanOrEqual(table.y + table.height);
        await pointAndClick(window, open);

        await expect(tabs).toHaveCount(2);
        await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
        await expect(tabs.first()).toHaveAttribute("title", original ?? "");
        await tabs.first().click();
        await expect(note).toHaveText(before ?? "");
        await tabs.nth(1).click();

        const opened = window.getByTestId("mind-editor").locator("table");
        await expect(opened).toHaveCount(1);
        await expect(opened.locator("tr")).toHaveCount(10);
        const cells = await opened
          .locator("tr")
          .evaluateAll((rows) =>
            rows.map((row) => [...row.children].map((cell) => (cell.textContent ?? "").trim())),
          );
        expect(cells.every((row) => row.length === 4)).toBe(true);
        expect(cells[0]).toEqual(words.header);
        expect(cells[9]?.slice(1)).toEqual(["1.1×", "0.1×", "0.65×"]);

        await expect(answer.getByTestId("answer-added")).toHaveCount(0);
        await deleteShownMind(window, tabs);
      });

      await test.step("twelve Citations in a row wrap and stay in the Answer", async () => {
        const answer = await askInAssistant(window, asked.row);
        const chips = answer.getByTestId("citation-chip");
        await expect(chips).toHaveCount(12);
        expect(await reachesPast(answer)).toEqual({ past: [], threadScrollsSideways: false });
        for (const chip of await chips.all())
          await expect(chip.locator(".citation-marker-icon")).toBeVisible();
      });

      if (width === SIZES[0].width) {
        await test.step("forty Citations, each beside its sentence", async () => {
          const answer = await askInAssistant(window, asked.forty, { timeout: 120_000 });
          const text = answer.getByTestId("assistant-answer-text");
          await expect(text.getByTestId("citation-chip")).toHaveCount(40);
          expect(await reachesPast(answer)).toEqual({ past: [], threadScrollsSideways: false });

          const strays = await text.evaluate((root) => {
            const stray: number[] = [];
            for (const paragraph of root.querySelectorAll(":scope > p")) {
              let last: DOMRect | null = null;
              const walker = document.createTreeWalker(
                paragraph,
                NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
              );
              for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (node instanceof Text) {
                  if (node.parentElement?.closest(".citation")) continue;
                  const end = (node.nodeValue ?? "").trimEnd().length;
                  if (end === 0) continue;
                  const range = document.createRange();
                  range.setStart(node, end - 1);
                  range.setEnd(node, end);
                  last = range.getBoundingClientRect();
                } else if (node instanceof Element && node.matches(".citation-marker")) {
                  const chip = node.getBoundingClientRect();
                  const middle = (chip.top + chip.bottom) / 2;
                  const beside =
                    last !== null &&
                    middle > last.top &&
                    middle < last.bottom &&
                    chip.left >= last.right - 1;
                  if (!beside) stray.push(Number(node.textContent));
                }
              }
            }
            return stray;
          });
          expect(strays).toEqual([]);
        });
      }
    });
  }
}

for (const language of ["en", "zh-CN"] as const) {
  test(`⌘K opens a table of the Answer as a table: the one the cursor is in, or one listed, in ${language}`, async () => {
    test.setTimeout(240_000);
    const window = await start(language, 1440, 900);
    const words = WORDS[language];
    const answer = await askInAssistant(window, QUESTIONS[language].two);
    const frames = answer.locator(".tableWrapper");
    await expect(frames).toHaveCount(2);
    const tabs = window.getByTestId("mind-tab");
    await expect(tabs).toHaveCount(1);
    const items = window.getByTestId("palette").getByTestId("palette-item");

    for (const frame of await frames.all()) {
      await expect(frame).not.toHaveAttribute("tabindex");
      await expect(frame).not.toHaveAttribute("data-more-after");
      expect(await leftFadeShows(frame)).toBe(false);
    }

    const ask = async () => {
      await window.keyboard.press("ControlOrMeta+k");
      await expect(window.getByTestId("palette-search")).toBeFocused();
      await window.keyboard.type(words.find);
    };
    const opened = async () => {
      await expect(tabs).toHaveCount(2);
      await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
      const table = window.getByTestId("mind-editor").locator("table");
      await expect(table.locator("tr")).toHaveCount(3);
      await expect(table.locator("th")).toHaveText(words.second);
      await deleteShownMind(window, tabs);
    };

    await test.step("with the cursor in no table, both are listed, and the second is chosen", async () => {
      await ask();
      await expect(items.filter({ hasText: words.nth(1) })).toHaveCount(1);
      await expect(items.filter({ hasText: words.nth(2) })).toHaveCount(1);
      await items.filter({ hasText: words.nth(2) }).click();
      await opened();
    });

    await test.step("with the cursor in a table, only that one is offered, and it opens", async () => {
      await pointAndClick(window, frames.nth(1).locator("td").first());
      await ask();
      await expect(items.filter({ hasText: words.open })).toHaveCount(1);
      await expect(items.filter({ hasText: words.nth(1) })).toHaveCount(0);
      await items.filter({ hasText: words.open }).click();
      await opened();
    });
  });

  test(`an Answer with one table: Open as a table from ⌘K and from the keyboard, ⌘Z never closes the Mind it made, and its tab is open before the table is in, in ${language}`, async () => {
    test.setTimeout(240_000);
    const window = await start(language, 1440, 900);
    const words = WORDS[language];
    const answer = await askInAssistant(window, QUESTIONS[language].table);
    const tabs = window.getByTestId("mind-tab");
    const table = window.getByTestId("mind-editor").locator("table");
    await expect(tabs).toHaveCount(1);

    await test.step("from ⌘K", async () => {
      await window.keyboard.press("ControlOrMeta+k");
      await expect(window.getByTestId("palette-search")).toBeFocused();
      await window.keyboard.type(words.find);
      const item = window.getByTestId("palette").getByTestId("palette-item");
      await expect(item.filter({ hasText: words.open })).toHaveCount(1);

      const tableWhenTabShown = await window.evaluateHandle(() => {
        const seen: number[] = [];
        new MutationObserver(() => {
          const shown = document.querySelectorAll('[data-testid="mind-tab"]').length;
          if (shown === 2 && seen.length === 0) {
            seen.push(document.querySelectorAll('[data-testid="mind-editor"] table').length);
          }
        }).observe(document.body, { subtree: true, childList: true, attributes: true });
        return seen;
      });
      await item.filter({ hasText: words.open }).click();

      await expect(tabs).toHaveCount(2);
      // The Mind takes the Question's name, not the table's first cell (#1345).
      await expect(tabs.nth(1)).toContainText(QUESTIONS[language].table);
      await expect(table.locator("tr")).toHaveCount(10);
      expect(await tableWhenTabShown.jsonValue()).toEqual([0]);
      await expect(answer.getByTestId("answer-added")).toHaveCount(0);
      // ⌘Z never closes a Mind that was made: making one leaves no step to take back.
      await window.keyboard.press("ControlOrMeta+z");
      await expect(tabs).toHaveCount(2);
      await deleteShownMind(window, tabs);
    });

    await test.step("from the keyboard: Tab to the button, Enter", async () => {
      const open = answer.getByTestId("answer-open-table");
      await tabTo(window, open);
      expect(await focusRingShows(window)).toBe(true);
      await window.keyboard.press("Enter");

      await expect(tabs).toHaveCount(2);
      await expect(table.locator("tr")).toHaveCount(10);
      await expect(answer.getByTestId("answer-added")).toHaveCount(0);

      await deleteShownMind(window, tabs);
      await expect(open).toBeVisible();
    });
  });
}

const cellTexts = (table: Locator) =>
  table.locator("th, td").evaluateAll((cells) =>
    cells.map((cell) => {
      const copy = cell.cloneNode(true) as HTMLElement;
      for (const marker of copy.querySelectorAll(".citation")) marker.remove();
      return (copy.textContent ?? "").trim();
    }),
  );

const overlayOf = (open: Locator) =>
  open.evaluate((button) => {
    const slot = button.parentElement;
    const frame = slot?.nextElementSibling;
    if (!slot || !(frame instanceof HTMLElement)) throw new Error("No table follows the Expand.");
    const icon = button.getBoundingClientRect();
    const box = frame.getBoundingClientRect();
    const heading = frame.querySelector("tr")?.getBoundingClientRect();
    const covered: string[] = [];
    const walker = document.createTreeWalker(frame, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        const across =
          rect.width > 0 &&
          rect.left < icon.right &&
          rect.right > icon.left &&
          rect.top < icon.bottom &&
          rect.bottom > icon.top;
        if (across) covered.push((node.nodeValue ?? "").trim());
      }
    }
    return {
      slotHeight: slot.getBoundingClientRect().height,
      inCorner:
        icon.right <= box.right + 0.5 &&
        icon.left >= box.right - 40 &&
        icon.top >= box.top - 1 &&
        heading !== undefined &&
        icon.bottom <= heading.bottom + 1,
      covered,
    };
  });

const fadeOf = (open: Locator) =>
  open.evaluate((button) => {
    const slot = button.parentElement;
    const fade = slot?.querySelector(".answer-table-fade");
    const frame = slot?.nextElementSibling;
    if (!(fade instanceof HTMLElement) || !(frame instanceof HTMLElement)) {
      throw new Error("The Expand has no fade, or no table follows it.");
    }
    const icon = button.getBoundingClientRect();
    const box = fade.getBoundingClientRect();
    const heading = frame.querySelector("tr");
    const meets = (rect: DOMRect, other: DOMRect) =>
      rect.width > 0 &&
      rect.left < other.right &&
      rect.right > other.left &&
      rect.top < other.bottom &&
      rect.bottom > other.top;
    const shown = getComputedStyle(fade).opacity !== "0";
    let underIcon = false;
    let inFade = false;
    const walker = document.createTreeWalker(heading ?? frame, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        underIcon ||= meets(rect, icon);
        inFade ||= shown && meets(rect, box);
      }
    }
    const row = heading?.getBoundingClientRect();
    const last = heading?.lastElementChild;
    let lastClear = false;
    if (last) {
      const range = document.createRange();
      range.selectNodeContents(last);
      const text = range.getBoundingClientRect();
      lastClear = text.right <= icon.left + 0.5;
    }
    return {
      reachesPastIcon:
        box.left <= icon.left - 28 + 0.5 &&
        box.right >= icon.right &&
        box.top <= icon.top + 0.5 &&
        row !== undefined &&
        box.bottom >= row.bottom - 0.5,
      shown,
      more: frame.hasAttribute("data-more-after"),
      lastClear,
      underIcon,
      inFade,
    };
  });

const scrollToEnd = (frame: Locator) =>
  frame.evaluate((each) => {
    each.scrollLeft = each.scrollWidth;
  });

const cellLength = (text: string, language: "en" | "zh-CN") =>
  language === "en"
    ? text.split(/\s+/).filter(Boolean).length
    : [...text.replace(/\s/g, "")].length;

for (const language of ["en", "zh-CN"] as const) {
  test(`a comparison keeps its cells short and fits the panel at 320 px with no Open as a table, and a wider table has it, in ${language}`, async () => {
    test.setTimeout(240_000);
    const window = await start(language, 1440, 900);
    const asked = QUESTIONS[language];
    const limit = language === "en" ? 8 : 16;

    await startSamples(window);
    await askInAssistant(window, asked.compare);
    const written = await stopSamples(window);
    expect(written.length).toBeGreaterThan(0);
    expect(written.filter((sample) => sample.button !== null)).toEqual([]);
    const comparison = assistantAnswers(window).first();
    const frame = comparison.getByTestId("assistant-answer-text").locator(".tableWrapper");
    await expect(frame.locator("tr")).toHaveCount(4);
    await expect(frame.locator("tr").first().locator("th")).toHaveCount(3);
    expect((await window.getByTestId("assistant").boundingBox())?.width).toBe(320);

    const cells = await cellTexts(frame);
    expect(cells).toHaveLength(12);
    for (const text of cells) {
      expect(text).not.toBe("");
      expect(cellLength(text, language)).toBeLessThanOrEqual(limit);
    }
    expect(await frame.evaluate((each) => each.scrollWidth <= each.clientWidth)).toBe(true);
    await expect(frame).not.toHaveAttribute("data-more-after");
    await expect(frame).not.toHaveAttribute("tabindex");

    // The narrowest panel: the button is there exactly when the table scrolls, and inside the panel.
    await sizeAssistant(window, 280);
    await expect
      .poll(() => comparison.getByTestId("answer-open-table").count())
      .toBe((await frame.evaluate((each) => each.scrollWidth > each.clientWidth)) ? 1 : 0);
    const narrow = comparison.getByTestId("answer-open-table");
    if ((await narrow.count()) > 0) {
      const box = await narrow.boundingBox();
      const panel = await window.getByTestId("assistant").boundingBox();
      if (!box || !panel) throw new Error("The button or the panel isn't visible.");
      expect(box.x).toBeGreaterThanOrEqual(panel.x);
      expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width);
    }
    await sizeAssistant(window, 320);

    // The Answer below is wider than the panel and has the button: the first had its turn to get it.
    const wide = await askInAssistant(window, asked.table);
    await expect(wide.getByTestId("answer-open-table")).toHaveAccessibleName(WORDS[language].open);
    await expect(comparison.getByTestId("answer-open-table")).toHaveCount(0);
  });

  test(`the Expand lies on the corner of a table wider than the panel without covering text, never opens by itself, and comes and goes as the panel is resized, in ${language}`, async () => {
    test.setTimeout(240_000);
    const window = await start(language, 1440, 900);
    const answer = await askInAssistant(window, QUESTIONS[language].table);
    const text = answer.getByTestId("assistant-answer-text");
    const frame = text.locator(".tableWrapper");
    const open = answer.getByTestId("answer-open-table");
    const tabs = window.getByTestId("mind-tab");
    const fits = () => frame.evaluate((each) => each.scrollWidth <= each.clientWidth);

    await test.step("it lies on the table's top-right corner, takes no room, and is the first thing in the Answer the keyboard reaches", async () => {
      await expect(open).toHaveAccessibleName(WORDS[language].open);
      await expect(open).toHaveAttribute("title", WORDS[language].open);
      await expect(open).toHaveText("");
      await expect(frame).toHaveAttribute("data-more-after", "");
      expect(await overlayOf(open)).toMatchObject({ slotHeight: 0, inCorner: true });
      await scrollToEnd(frame);
      await expect(frame).not.toHaveAttribute("data-more-after", "");
      expect(await overlayOf(open)).toMatchObject({ inCorner: true, covered: [] });
      await frame.evaluate((each) => {
        each.scrollLeft = 0;
      });
      const first = await open.evaluate(
        (button) =>
          button
            .closest("[data-testid=assistant-answer-text]")
            ?.querySelector("button, a, [tabindex]") === button,
      );
      expect(first).toBe(true);
    });

    await test.step("nothing opens by itself", async () => {
      await expect(tabs).toHaveCount(1);
      await expect(window.getByTestId("mind-editor").locator("table")).toHaveCount(0);
    });

    await test.step("a panel the table fits in takes the button away, and a narrow one brings it back", async () => {
      await sizeAssistant(window, 620);
      await expect.poll(fits).toBe(true);
      await expect(open).toHaveCount(0);
      await sizeAssistant(window, 280);
      await expect.poll(fits).toBe(false);
      await expect(open).toBeVisible();
      await expect(tabs).toHaveCount(1);
    });

    await test.step("the click opens it", async () => {
      await pointAndClick(window, open);
      await expect(tabs).toHaveCount(2);
      await expect(window.getByTestId("mind-editor").locator("table tr")).toHaveCount(10);
      await deleteShownMind(window, tabs);
    });
  });

  test(`the Expand is greyed out and still reachable by keyboard until the Answer ends, then enabled in place with nothing moving, in ${language}`, async () => {
    test.setTimeout(240_000);
    const window = await start(language, 1440, 900);
    const tabs = window.getByTestId("mind-tab");
    await startSamples(window);
    const slowly = language === "en" ? "What do tides do in nine rows slowly" : "九行 tides slowly";
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type(slowly);
    await window.keyboard.press("Enter");
    const answer = assistantAnswers(window).last();
    const open = answer.getByTestId("answer-open-table");

    await test.step("while it is written: greyed out, focusable, and a press opens nothing", async () => {
      await expect(open).toHaveAttribute("aria-disabled", "true", { timeout: 60_000 });
      await expect(answer).toHaveAttribute("data-status", "streaming");
      await expect(open).toHaveAccessibleName(WORDS[language].open);
      await open.focus();
      await expect(open).toBeFocused();
      await window.keyboard.press("Enter");
      await expect(tabs).toHaveCount(1);
    });

    await test.step("when it ends: the same button, enabled, still focused", async () => {
      await expect(answer).toHaveAttribute("data-status", "done", { timeout: 120_000 });
      await expect(open).toHaveAttribute("aria-disabled", "false");
      await expect(open).toBeFocused();
      await expect(tabs).toHaveCount(1);
    });

    await test.step("from the first frame it had, the table never moved", async () => {
      const samples = await stopSamples(window);
      const withButton = samples.filter((sample) => sample.button !== null);
      expect(withButton.length).toBeGreaterThan(1);
      const firstWith = samples.findIndex((sample) => sample.button !== null);
      expect(new Set(samples.slice(firstWith).map((sample) => Math.round(sample.top))).size).toBe(
        1,
      );
      expect(
        samples.filter((sample) => sample.status === "done").every((s) => s.button === "false"),
      ).toBe(true);
      expect(
        samples
          .filter((sample) => sample.status === "streaming" && sample.button !== null)
          .every((s) => s.button === "true"),
      ).toBe(true);
    });

    await test.step("enabled, a press opens the table", async () => {
      await window.keyboard.press("Enter");
      await expect(tabs).toHaveCount(2);
      await expect(window.getByTestId("mind-editor").locator("table tr")).toHaveCount(10);
      await deleteShownMind(window, tabs);
    });
  });

  test(`a heading fades out before the Expand while the table has more to its right, and is fully clear at the end of the scroll, for a table that scrolls far and for nine rows, in ${language}`, async () => {
    test.setTimeout(240_000);
    const window = await start(language, 1600, 900);
    const asked = [
      { question: language === "en" ? "Tides long headings" : "长标题 tides", farthest: 300 },
      { question: QUESTIONS[language].table, farthest: 0 },
    ];
    for (const { question } of asked) await askInAssistant(window, question);
    const settled = () =>
      window.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );

    for (const width of [320, 280]) {
      await sizeAssistant(window, width);
      for (const [at, { farthest }] of asked.entries()) {
        await test.step(`table ${at + 1} with the panel at ${width} px`, async () => {
          const answer = assistantAnswers(window).nth(at);
          const frame = answer.getByTestId("assistant-answer-text").locator(".tableWrapper");
          const open = answer.getByTestId("answer-open-table");
          await expect(open).toBeVisible();
          const reach = await frame.evaluate((each) => each.scrollWidth - each.clientWidth);
          expect(reach).toBeGreaterThan(farthest);
          let slidUnder = 0;
          const scrollTo = async (left: number) => {
            await frame.evaluate(
              (each, to) => each.scrollTo({ left: to, behavior: "instant" }),
              left,
            );
            await settled();
            return fadeOf(open);
          };
          for (let left = 0; left < reach; left += 24) {
            const seen = await scrollTo(left);
            expect(seen.reachesPastIcon).toBe(true);
            // The fade shows exactly while there is more table to the right.
            expect(seen.shown).toBe(seen.more);
            if (seen.inFade) slidUnder++;
          }
          expect(slidUnder).toBeGreaterThan(0);
          const end = await scrollTo(reach + 100);
          expect(end).toMatchObject({
            more: false,
            shown: false,
            inFade: false,
            underIcon: false,
            lastClear: true,
          });
          expect(await overlayOf(open)).toMatchObject({ inCorner: true, covered: [] });
        });
      }
    }
  });

  test(`a table that starts narrow and widens while rows arrive gains the Expand without moving, with a line tight above it, in ${language}`, async () => {
    test.setTimeout(240_000);
    const window = await start(language, 1600, 900);
    const tabs = window.getByTestId("mind-tab");
    await startSamples(window);
    const slowly = language === "en" ? "Tides narrow then wide slowly" : "先窄后宽 tides slowly";
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type(slowly);
    await window.keyboard.press("Enter");
    const answer = assistantAnswers(window).last();
    const frame = answer.getByTestId("assistant-answer-text").locator(".tableWrapper");
    const open = answer.getByTestId("answer-open-table");

    await test.step("the table fits at first, then a row makes it wider and it gains the Expand, greyed", async () => {
      await expect(frame).toBeVisible({ timeout: 60_000 });
      await expect(open).toHaveAttribute("aria-disabled", "true", { timeout: 60_000 });
      await expect(answer).toHaveAttribute("data-status", "done", { timeout: 120_000 });
      await expect(open).toHaveAttribute("aria-disabled", "false");
    });

    await test.step("from the table's first frame to the end of the Answer, it never moved", async () => {
      const samples = await stopSamples(window);
      const first = samples[0];
      const gained = samples.findIndex((sample) => sample.button !== null);
      expect(first?.button).toBeNull();
      expect(gained).toBeGreaterThan(0);
      expect(new Set(samples.map((sample) => Math.round(sample.top))).size).toBe(1);
    });

    await test.step("tight under its line, the Expand is on the faded edge and covers no text", async () => {
      const lead = answer.getByTestId("assistant-answer-text").locator("p").first();
      const gap = await frame.evaluate(
        (each, line) => each.getBoundingClientRect().top - line.getBoundingClientRect().bottom,
        await lead.elementHandle(),
      );
      expect(gap).toBeLessThan(26);
      await expect(frame).toHaveAttribute("data-more-after", "");
      expect(await overlayOf(open)).toMatchObject({ slotHeight: 0, inCorner: true });
      await scrollToEnd(frame);
      expect(await overlayOf(open)).toMatchObject({ inCorner: true, covered: [] });
    });

    await test.step("at the narrowest panel it still lies inside the panel and covers no text", async () => {
      await sizeAssistant(window, 280);
      await scrollToEnd(frame);
      expect(await overlayOf(open)).toMatchObject({ slotHeight: 0, inCorner: true, covered: [] });
      const box = await open.boundingBox();
      const panel = await window.getByTestId("assistant").boundingBox();
      if (!box || !panel) throw new Error("The Expand or the panel isn't visible.");
      expect(box.x).toBeGreaterThanOrEqual(panel.x);
      expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width);
      await expect(tabs).toHaveCount(1);
    });
  });
}
