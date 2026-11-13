import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  addToNote,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

/*
 * Tables in a Mind (#92): one inserted from "/", written in with Tab and
 * Shift-Tab between cells and Enter inside one; rows and columns added and
 * removed from the table menu (its ⋯ button, a right-click, ⌘/) and with the
 * keyboard, each change undone with ⌘Z; a table too wide for the note
 * scrolling sideways inside it, at a narrow and a wide window; and an Answer
 * written as a Markdown table, its Citation found in a cell. In English and
 * Chinese. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const WORDS = {
  en: {
    slash: "/table",
    table: "Table",
    cells: ["Site", "Rise (mm/yr)", "Notes", "Harbour", "4.1", "Gauge on the pier"],
    second: "since 1990",
    replaced: "4.2",
    rowBelow: "Insert row below",
    deleteRow: "Delete row",
    deleteColumn: "Delete column",
    menu: "Table options",
  },
  "zh-CN": {
    slash: "/表格",
    table: "表格",
    cells: ["站点", "上升（毫米/年）", "备注", "港口", "4.1", "码头上的验潮仪"],
    second: "自 1990 年起",
    replaced: "4.2",
    rowBelow: "在下方插入行",
    deleteRow: "删除行",
    deleteColumn: "删除列",
    menu: "表格选项",
  },
} as const;

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

/** The table's text, row by row, each cell's lines joined by " / ". */
const tableText = (table: Locator) =>
  table.evaluate((element) =>
    [...element.querySelectorAll("tr")].map((row) =>
      [...row.querySelectorAll("th, td")].map((cell) =>
        [...cell.querySelectorAll("p")].map((line) => line.textContent ?? "").join(" / "),
      ),
    ),
  );

/** How many columns the table's first row has. */
const columnsOf = (table: Locator) => table.locator("tr").first().locator("th, td").count();

/** Whether `inner`'s box lies inside `outer`'s, give or take a pixel. */
async function inside(inner: Locator, outer: Locator): Promise<boolean> {
  const a = await inner.boundingBox();
  const b = await outer.boundingBox();
  if (!a || !b) return false;
  return (
    a.x >= b.x - 1 &&
    a.y >= b.y - 1 &&
    a.x + a.width <= b.x + b.width + 1 &&
    a.y + a.height <= b.y + b.height + 1
  );
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a table from "/": Tab between cells, Enter in one, rows and columns added and removed from its menu and keys, each undone, scrolling inside the note when wide (${language})`, async () => {
    const words = WORDS[language];
    const first = await launchApp(dataDir);
    const { app, window } = first;
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1280, 660);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await pointAndClick(window, editor);

    // "/" finds the table by its name, and inserts a heading row over two rows, three columns wide.
    await window.keyboard.type(words.slash);
    const item = window.getByTestId("slash-item-table");
    await expect(item).toHaveAttribute("aria-selected", "true");
    await expect(item).toContainText(words.table);
    await window.keyboard.press("Enter");
    const table = editor.locator("table");
    await expect(table.locator("tr")).toHaveCount(3);
    await expect(table.locator("tr").first().locator("th")).toHaveCount(3);

    // Typing starts in the first cell; Tab goes to the next, along the row and on to the next row.
    for (const [index, text] of words.cells.entries()) {
      if (index > 0) await window.keyboard.press("Tab");
      await window.keyboard.type(text);
    }
    // Enter starts another line in the same cell; Shift-Tab goes back a cell, selecting what is
    // in it, so typing replaces it.
    await window.keyboard.press("Enter");
    await window.keyboard.type(words.second);
    await window.keyboard.press("Shift+Tab");
    await expect
      .poll(() => window.evaluate(() => document.getSelection()?.toString().trim()))
      .toBe(words.cells[4]);
    await window.keyboard.type(words.replaced);
    const rows = [
      words.cells.slice(0, 3),
      [words.cells[3], words.replaced, `${words.cells[5]} / ${words.second}`],
    ];
    expect(await tableText(table)).toEqual([...rows, ["", "", ""]]);

    // The ⋯ button sits in the cell the cursor is in, and follows it to the cell clicked.
    const cell = table.locator("tr").nth(1).locator("td").nth(1);
    const button = window.getByTestId("table-menu");
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute("aria-label", words.menu);
    expect(await inside(button, cell)).toBe(true);
    const clickCell = async (target: Locator) => {
      await pointAndClick(window, target);
      await expect.poll(() => inside(button, target)).toBe(true);
    };
    await clickCell(table.locator("th").first());

    // Its menu adds a row under the cursor's. ⌘Z takes it back.
    await clickCell(cell);
    await pointAndClick(window, button);
    const menu = window.getByTestId("table-actions");
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("table.rowBelow")).toContainText(words.rowBelow);
    await screenshot(window, `table-menu-${language}`);
    await pointAndClick(window, menu.getByTestId("table.rowBelow"));
    await expect(menu).toBeHidden();
    await expect(table.locator("tr")).toHaveCount(4);
    expect((await tableText(table))[2]).toEqual(["", "", ""]);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(table.locator("tr")).toHaveCount(3);
    expect(await tableText(table)).toEqual([...rows, ["", "", ""]]);

    // A key adds a column to the right of the cursor's; ⌘Z takes it back too.
    await clickCell(cell);
    await window.keyboard.press("ControlOrMeta+Alt+ArrowRight");
    await expect.poll(() => columnsOf(table)).toBe(4);
    expect((await tableText(table))[0]).toEqual([
      words.cells[0],
      words.cells[1],
      "",
      words.cells[2],
    ]);
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => columnsOf(table)).toBe(3);

    // A right-click in a cell opens the Block's menu there, and deletes that row.
    const empty = table.locator("tr").nth(2).locator("td").first();
    const blockMenu = window.getByTestId("block-actions");
    await pointAndClick(window, empty, { button: "right" });
    await expect(blockMenu).toBeVisible();
    await expect(blockMenu.getByTestId("table.deleteRow")).toContainText(words.deleteRow);
    await pointAndClick(window, blockMenu.getByTestId("table.deleteRow"));
    await expect(table.locator("tr")).toHaveCount(2);

    // ⌘/ opens it from the keyboard, and Esc goes back to the cell; the arrows reach "Delete
    // column", and Enter does it.
    await clickCell(table.locator("tr").first().locator("th").nth(2));
    await window.keyboard.press("ControlOrMeta+/");
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("table.rowAbove")).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(editor).toBeFocused();
    await window.keyboard.press("ControlOrMeta+/");
    await expect(menu.getByTestId("table.rowAbove")).toBeFocused();
    await window.keyboard.press("End");
    await window.keyboard.press("ArrowUp");
    await expect(menu.getByTestId("table.deleteColumn")).toBeFocused();
    await expect(menu.getByTestId("table.deleteColumn")).toContainText(words.deleteColumn);
    await window.keyboard.press("Enter");
    await expect.poll(() => columnsOf(table)).toBe(2);
    expect(await tableText(table)).toEqual(rows.map((row) => row.slice(0, 2)));
    // Undone, one change at a time: the column, then the row.
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => columnsOf(table)).toBe(3);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(table.locator("tr")).toHaveCount(3);

    // Eight columns don't fit the note: the table scrolls sideways inside it, at a narrow and a
    // wide window, and the page never does. Words wrap whole.
    await clickCell(table.locator("th").first());
    for (let added = 0; added < 5; added++) {
      await window.keyboard.press("ControlOrMeta+Alt+ArrowRight");
    }
    await expect.poll(() => columnsOf(table)).toBe(8);
    const wrapper = editor.locator(".tableWrapper");
    for (const width of [900, 1440]) {
      await setWindowSize(app, window, width, 660);
      const layout = await wrapper.evaluate((element) => {
        const scroller = element.closest(".mind-scroller") as HTMLElement;
        const note = element.closest(".mind-editor") as HTMLElement;
        const style = getComputedStyle(note);
        const noteRight =
          note.getBoundingClientRect().right - Number.parseFloat(style.paddingRight);
        return {
          scrolls: element.scrollWidth > element.clientWidth,
          wrapperRight: element.getBoundingClientRect().right,
          noteRight,
          pageScrolls: scroller.scrollWidth > scroller.clientWidth + 1,
        };
      });
      expect(layout.scrolls).toBe(true);
      expect(layout.wrapperRight).toBeLessThanOrEqual(layout.noteRight + 1);
      expect(layout.pageScrolls).toBe(false);
      // A one-word heading stays on one line: never broken by letter.
      const lines = await table
        .locator("th")
        .first()
        .evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element.querySelector("p") as Node);
          return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
        });
      expect(lines).toBe(1);
      await screenshot(window, `table-${language}-${width}`);
    }
    await setWindowSize(app, window, 1280, 660);
    const written = await tableText(table);
    expect(written[1]).toEqual([
      words.cells[3],
      ...Array(5).fill(""),
      words.replaced,
      `${words.cells[5]} / ${words.second}`,
    ]);
    await app.close();

    // After a restart: the table and what was written in it.
    const second = await launchApp(dataDir);
    await second.window.getByTestId("mind-list-item").click();
    const reopened = second.window.getByTestId("mind-editor").locator("table");
    await expect(reopened.locator("tr")).toHaveCount(3);
    expect(await tableText(reopened)).toEqual(written);
    await second.app.close();
  });

  test(`the selection menu's Text › Table turns selected lines into a table's rows, and isn't offered inside a table (${language})`, async () => {
    const words = WORDS[language];
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1280, 660);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await pointAndClick(window, editor);
    await window.keyboard.type(words.cells[3]);
    await window.keyboard.press("Enter");
    await window.keyboard.type(words.cells[5]);

    // The mouse slides over both lines; the menu, by keyboard, to Text › Table.
    const menu = window.getByTestId("selection-menu");
    const lines = editor.locator("p");
    await slideSelect(window, lines.first(), words.cells[3], {
      line: lines.nth(1),
      words: words.cells[5],
    });
    await expect(menu).toBeVisible();
    await window.keyboard.press("ControlOrMeta+/");
    await expect(window.getByTestId("selection-turn-into")).toBeFocused();
    await window.keyboard.press("Enter");
    const item = window.getByTestId("turn-into-table");
    await expect(item).toContainText(words.table);
    await window.keyboard.press("End");
    await expect(item).toBeFocused();
    await window.keyboard.press("Enter");
    const table = editor.locator("table");
    expect(await tableText(table)).toEqual([[words.cells[3]], [words.cells[5]]]);
    await expect(table.locator("th")).toHaveCount(0);

    // Text selected in a cell gets the formatting, but nothing to turn the table into.
    await slideSelect(window, table.locator("td").first(), words.cells[3]);
    await expect(menu).toBeVisible();
    await expect(window.getByTestId("format-bold")).toBeVisible();
    await expect(window.getByTestId("selection-turn-into")).toHaveCount(0);

    // ⌘Z puts the lines back.
    await window.keyboard.press("Escape");
    await window.keyboard.press("ControlOrMeta+z");
    await expect(table).toHaveCount(0);
    await expect(editor.locator("p")).toHaveText([words.cells[3], words.cells[5]]);
    await app.close();
  });
}

/** Three short pages: the line about spring tides is on page 2. */
const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
  { lines: ["Tide tables", "Harbours publish the times of high water every year."] },
]);

test("an Answer written as a Markdown table shows as a table, with its Citation found in a cell; added to the note it is one there, also after reopening", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const first = await launchApp(dataDir, { fakeChat: true });
  const { window } = first;
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await pointAndClick(window, editor);
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("When do spring tides happen? Answer as a table.");
  await window.keyboard.press("Enter");
  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });

  // The heading row, two rows, the "<br>" a line break, and the second column aligned right.
  const table = answer.locator("table");
  await expect(table.locator("th")).toHaveText(["Claim", "Where"]);
  await expect(table.locator("tr")).toHaveCount(3);
  await expect(table.locator("tr").nth(2).locator("td").first().locator("br")).toHaveCount(1);
  await expect(table.locator("td").nth(1)).toHaveCSS("text-align", "right");
  await expect(answer).not.toContainText("|");

  // The marker in the cell is a Citation whose quote was found, with its check in its badge.
  const citation = table.locator("td").first().getByTestId("citation");
  await expect(citation).toHaveAttribute("data-check", "found");
  await expect(citation.getByTestId("citation-chip")).toHaveAttribute(
    "aria-label",
    "Citation 1: Tides, p. 2. Quote found on p. 2",
  );
  await expect(citation.locator(".citation-marker-icon")).toBeVisible();
  await screenshot(window, "table-answer-en");

  // Added to the note, it is a table there, its Citation found in the same cell.
  await addToNote(window, answer);
  const added = editor.locator("table");
  await expect(added.locator("th")).toHaveText(["Claim", "Where"]);
  await expect(added.locator("td").first().getByTestId("citation")).toHaveAttribute(
    "data-check",
    "found",
  );
  await first.app.close();

  const second = await launchApp(dataDir, { fakeChat: true });
  await second.window.getByTestId("mind-list-item").click();
  const reopened = second.window.getByTestId("mind-editor").locator("table");
  await expect(reopened.locator("td").first().getByTestId("citation")).toHaveAttribute(
    "data-check",
    "found",
  );
  await second.app.close();
});
