import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { xlsxPackage } from "../tests/helpers/office";
import {
  addDocuments,
  askInAssistant,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * A Citation to a workbook's cells opens the sheet scrolled to them, whether they are off to the
 * right or far down, and the Citation's mark sits outside the cited cells, never over the figure
 * the User came to see (#974). Set INCARNAMIND_SCREENSHOTS to a folder to keep a screenshot of each.
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

const MONTHS = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];

const text = (ref: string, value: string) =>
  `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
const amount = (ref: string, value: number) => `<c r="${ref}" s="1"><v>${value}</v></c>`;
const column = (index: number) => String.fromCharCode(65 + index);

/**
 * A trial balance, each account with its twelve months and its closing balance in column O, past
 * the view: "Trade debtors" on row 8, and "Rounding suspense" at its foot on row 380.
 */
function trialBalance(): string {
  const header = ["Code", "Account", ...MONTHS, "Closing"]
    .map((value, index) => text(`${column(index)}1`, value))
    .join("");
  const rows = [`<row r="1">${header}</row>`];
  for (const row of [2, 3, 4, 5, 6, 7, 8, 9, 380]) {
    const name =
      row === 8 ? "Trade debtors" : row === 380 ? "Rounding suspense" : `Ledger ${1000 + row}`;
    const months = MONTHS.map((_, index) =>
      amount(`${column(index + 2)}${row}`, row * 100 + index + 0.25),
    );
    const closing = row === 8 ? 84317.52 : row === 380 ? 12.48 : row * 1000 + 0.5;
    rows.push(
      `<row r="${row}">${text(`A${row}`, String(4000 + row))}${text(`B${row}`, name)}${months.join("")}${amount(`O${row}`, closing)}</row>`,
    );
  }
  return `<cols><col min="1" max="1" width="8" customWidth="1"/><col min="2" max="2" width="30" customWidth="1"/><col min="3" max="15" width="14" customWidth="1"/></cols><sheetData>${rows.join("")}</sheetData>`;
}

/** The bank reconciliation, as an accountant lays it out: a wide label column, then the figures. */
function bankRec(): string {
  return `<cols><col min="1" max="1" width="60" customWidth="1"/><col min="2" max="2" width="16" customWidth="1"/></cols><sheetData>${[
    `<row r="1">${text("A1", "Calderbeck Joinery Ltd: bank reconciliation, current account")}</row>`,
    `<row r="3">${text("A3", "Per confirmation statement")}${amount("B3", 84317.52)}</row>`,
    `<row r="4">${text("A4", "Less unpresented cheques:")}</row>`,
    `<row r="5">${text("A5", "cheque 004781")}${amount("B5", -1240)}</row>`,
    `<row r="6">${text("A6", "cheque 004785")}${amount("B6", -1115)}</row>`,
    `<row r="7">${text("A7", "Per nominal ledger (code 7400)")}${amount("B7", 81962.52)}</row>`,
  ].join("")}</sheetData>`;
}

const STYLES = `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>`;

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The element isn't shown.");
  return box;
}

const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** The part of the grid the cells scroll in: inside the scroller, below and right of its headers. */
async function bodyOf(grid: Locator): Promise<Box> {
  return grid.evaluate((element) => {
    const outer = element.getBoundingClientRect();
    const header = element.querySelector("thead")?.getBoundingClientRect().height ?? 0;
    const numbers = element.querySelector("tbody th")?.getBoundingClientRect().width ?? 0;
    return {
      x: outer.left + numbers,
      y: outer.top + header,
      width: element.clientWidth - numbers,
      height: element.clientHeight - header,
    };
  });
}

const within = (inner: Box, outer: Box) =>
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  inner.x + inner.width <= outer.x + outer.width + 0.5 &&
  inner.y + inner.height <= outer.y + outer.height + 0.5;

/**
 * Opens the Citation of `answer` and checks the cited figure in `figureRef` is in view with the
 * mark beside the cells, in view and over none of them.
 */
async function expectCitedFigureInView(
  window: Page,
  answer: Locator,
  sheet: string,
  figureRef: string,
  figure: string,
  shot: string,
) {
  // From the Citation's card, as the accountant did: "Open the rows".
  await window.mouse.move(0, 0);
  await answer.getByTestId("citation-chip").first().focus();
  const card = window.getByTestId("citation-card");
  await expect(card).toBeVisible();
  await pointAndClick(window, card.getByTestId("citation-open"));
  await expect(card).toHaveCount(0);
  const viewer = window.getByTestId("viewer");
  await expect(viewer.getByRole("tab", { name: sheet })).toHaveAttribute("aria-selected", "true");
  const grid = viewer.getByTestId("viewer-grid");
  const cells = grid.locator("td[data-quote-highlight]");
  const cell = grid.locator(`td[data-ref="${figureRef}"]`);
  await expect(cell).toHaveAttribute("data-quote-highlight", "");
  await expect(cell).toHaveText(figure);
  const mark = viewer.getByTestId("viewer-quote-mark");
  await expect(mark).toBeVisible();

  await expect(async () => {
    const body = await bodyOf(grid);
    // The cited figure is wholly in the grid's view, not off to the right or below.
    expect(within(await boxOf(cell), body)).toBe(true);
    // The mark is in view too, beside the cells and over none of them.
    const markBox = await boxOf(mark);
    expect(within(markBox, body)).toBe(true);
    const cited = await cells.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      }),
    );
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.filter((each) => intersects(markBox, each))).toEqual([]);
  }).toPass();
  // What the User reads at the figure is the figure, not the mark.
  const top = await cell.evaluate((element) => {
    const words = document.createRange();
    words.selectNodeContents(element);
    const rect = words.getBoundingClientRect();
    return document
      .elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      ?.closest("td")?.dataset.ref;
  });
  expect(top).toBe(figureRef);
  if (SCREENSHOTS) {
    await motionSettled(window);
    await mkdir(SCREENSHOTS, { recursive: true });
    await window.screenshot({ path: join(SCREENSHOTS, `${shot}.png`) });
  }
}

async function start(width: number): Promise<{ app: ElectronApplication; window: Page }> {
  const file = join(sources, "Calderbeck trial balance.xlsx");
  await writeFile(
    file,
    xlsxPackage({
      sheets: [
        { name: "Trial balance", xml: trialBalance() },
        { name: "Bank rec", xml: bankRec() },
      ],
      styles: STYLES,
      activeTab: 0,
    }),
  );
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, width, 900);
  await dismissChatSetup(window);
  await connectLocalChatModel(window);
  await addDocuments(window, [file]);
  await expect(window.getByTestId("document-list-item").first()).toHaveAttribute(
    "data-status",
    "ready",
    { timeout: 30_000 },
  );
  return { app, window };
}

/** The Answer to `question`, held by its id: `askInAssistant` gives the last Answer, whichever it is. */
async function ask(window: Page, question: string): Promise<Locator> {
  const id = await (await askInAssistant(window, question)).getAttribute("data-answer-id");
  return window.locator(`[data-testid="assistant-answer"][data-answer-id="${id}"]`);
}

for (const width of [1440, 1100, 900]) {
  test(`a Citation to workbook cells scrolls to them and its mark never covers them (${width}px)`, async () => {
    const { app, window } = await start(width);

    // Off to the right: the closing balance in column O of a row the Citation quotes whole.
    const debtors = await ask(window, "What are the trade debtors?");
    await expectCitedFigureInView(
      window,
      debtors,
      "Trial balance",
      "O8",
      "84,317.52",
      `sheet-citation-right-${width}`,
    );

    // On another sheet, past a wide label column: the sheet switches, and the figure shows. The
    // scripted model cites the workbook's first Passage unless the Question says "each", when it
    // cites the Passage whose line shares the most words with it.
    const rec = await ask(window, "In each sheet, what does the confirmation statement say?");
    await expectCitedFigureInView(
      window,
      rec,
      "Bank rec",
      "B3",
      "84,317.52",
      `sheet-citation-rec-${width}`,
    );

    // Far down, and off to the right.
    const suspense = await ask(window, "In each sheet, where is the rounding suspense?");
    await expectCitedFigureInView(
      window,
      suspense,
      "Trial balance",
      "O380",
      "12.48",
      `sheet-citation-down-${width}`,
    );

    // In Chinese the mark's words change, and it still keeps clear of the cells.
    await setLanguage(window, "zh-CN");
    await expectCitedFigureInView(
      window,
      debtors,
      "Trial balance",
      "O8",
      "84,317.52",
      `sheet-citation-right-${width}-zh`,
    );
    await expectCitedFigureInView(
      window,
      rec,
      "Bank rec",
      "B3",
      "84,317.52",
      `sheet-citation-rec-${width}-zh`,
    );
    await app.close();
  });
}
