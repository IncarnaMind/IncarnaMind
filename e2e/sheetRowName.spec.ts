import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
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
 * A Citation to a row of a trial balance wider than the viewer scrolls to the row's figures, so the
 * account's name in column B is out of view; the Citation's mark then shows the account's name,
 * and its tooltip the whole label (#2388). Set INCARNAMIND_SCREENSHOTS to a folder to keep a
 * screenshot of each.
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
 * Each account's code in A, its name in B, twelve months and its closing balance: row 8 is
 * "Trade debtors", row 10 a Chinese name, and row 12 a row of numbers with no name.
 */
function trialBalance(): string {
  const header = ["Code", "Account", ...MONTHS, "Closing"]
    .map((value, index) => text(`${column(index)}1`, value))
    .join("");
  const rows = [`<row r="1">${header}</row>`];
  for (const row of [2, 3, 4, 5, 6, 7, 8, 9, 10, 12]) {
    const name = row === 8 ? "Trade debtors" : row === 10 ? "银行存款" : `Ledger ${1000 + row}`;
    // Row 8's code is a number, as many ledgers store it; it doesn't hide the name beside it.
    const code =
      row === 12 || row === 8
        ? `<c r="A${row}"><v>${4000 + row}</v></c>`
        : text(`A${row}`, String(4000 + row));
    const months = MONTHS.map((_, index) =>
      amount(`${column(index + 2)}${row}`, row * 100 + index + 0.25),
    );
    const closing = amount(`O${row}`, row * 1000 + 0.5);
    rows.push(
      `<row r="${row}">${code}${row === 12 ? "" : text(`B${row}`, name)}${months.join("")}${closing}</row>`,
    );
  }
  return `<cols><col min="1" max="1" width="8" customWidth="1"/><col min="2" max="2" width="30" customWidth="1"/><col min="3" max="15" width="14" customWidth="1"/></cols><sheetData>${rows.join("")}</sheetData>`;
}

const STYLES = `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>`;

type Box = { x: number; y: number; width: number; height: number };

const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** The Answer to `question`, held by its id: `askInAssistant` gives the last Answer, whichever it is. */
async function ask(window: Page, question: string): Promise<Locator> {
  const id = await (await askInAssistant(window, question)).getAttribute("data-answer-id");
  return window.locator(`[data-testid="assistant-answer"][data-answer-id="${id}"]`);
}

/**
 * Opens the Citation of `answer` and checks its mark shows `shown` beside the cited cells, over
 * none of them, its tooltip names `location`, and the name's column B is out of view.
 */
async function expectMark(
  window: Page,
  answer: Locator,
  { row, shown, location }: { row: number; shown: string; location: string },
  shot: string,
) {
  await window.mouse.move(0, 0);
  await answer.getByTestId("citation-chip").first().focus();
  const card = window.getByTestId("citation-card");
  await expect(card).toBeVisible();
  await pointAndClick(window, card.getByTestId("citation-open"));
  await expect(card).toHaveCount(0);
  const grid = window.getByTestId("viewer").getByTestId("viewer-grid");
  await expect(grid.locator(`td[data-ref="O${row}"]`)).toHaveAttribute("data-quote-highlight", "");
  const mark = window.getByTestId("viewer").getByTestId("viewer-quote-mark");
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute("data-label-shown", "true");
  await expect(mark.getByTestId("viewer-quote-mark-label")).toHaveText(shown);
  await expect(mark).toHaveAttribute("title", new RegExp(`${location}$`));
  await expect(async () => {
    const body = await grid.evaluate((element) => {
      const outer = element.getBoundingClientRect();
      const numbers = element.querySelector("tbody th")?.getBoundingClientRect().width ?? 0;
      return { x: outer.left + numbers };
    });
    const name = await grid.locator(`td[data-ref="B${row}"]`).boundingBox();
    // The name's own cell is scrolled out of view to the left (or not drawn at all).
    expect(name === null || name.x + name.width <= body.x + 0.5).toBe(true);
    const markBox = await mark.boundingBox();
    if (!markBox) throw new Error("The mark isn't shown.");
    const cited = await grid.locator("td[data-quote-highlight]").evaluateAll((cells) =>
      cells.map((cell) => {
        const rect = cell.getBoundingClientRect();
        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      }),
    );
    expect(cited.filter((each) => intersects(markBox, each))).toEqual([]);
  }).toPass();
  if (SCREENSHOTS) {
    await motionSettled(window);
    await mkdir(SCREENSHOTS, { recursive: true });
    await window.screenshot({ path: join(SCREENSHOTS, `${shot}.png`) });
  }
}

for (const width of [1600, 900]) {
  test(`a cited row's mark shows the row's name when its column is out of view (${width}px)`, async () => {
    const file = join(sources, "Calderbeck trial balance.xlsx");
    await writeFile(
      file,
      xlsxPackage({ sheets: [{ name: "Trial balance", xml: trialBalance() }], styles: STYLES }),
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

    // The scripted model cites the line that shares the most words with a Question that says
    // "each", and that line and the next two when it says "three rows".
    const debtors = await ask(window, "In each sheet, where are the trade debtors?");
    await expectMark(
      window,
      debtors,
      { row: 8, shown: "Trade debtors", location: "Trial balance, row 8 · Trade debtors" },
      `row-name-${width}`,
    );
    const chinese = await ask(window, "In each sheet, where is 4010?");
    await expectMark(
      window,
      chinese,
      { row: 10, shown: "银行存款", location: "Trial balance, row 10 · 银行存款" },
      `row-name-chinese-${width}`,
    );
    const numbers = await ask(window, "In each sheet, where is 4012?");
    await expectMark(
      window,
      numbers,
      { row: 12, shown: "Trial balance, row 12", location: "Trial balance, row 12" },
      `row-name-none-${width}`,
    );
    // Several rows keep their range on the mark; the tooltip names each.
    const three = await ask(window, "In each sheet, what are the three rows from ledger 1007?");
    await expectMark(
      window,
      three,
      {
        row: 7,
        shown: "Trial balance, rows 7–9",
        location: "Trial balance, rows 7–9 · Ledger 1007, Trade debtors, Ledger 1009",
      },
      `row-name-rows-${width}`,
    );

    await setLanguage(window, "zh-CN");
    await expectMark(
      window,
      debtors,
      { row: 8, shown: "Trade debtors", location: "Trial balance，第 8 行 · Trade debtors" },
      `row-name-${width}-zh`,
    );
    await expectMark(
      window,
      three,
      {
        row: 7,
        shown: "Trial balance，第 7–9 行",
        location: "Trial balance，第 7–9 行 · Ledger 1007、Trade debtors、Ledger 1009",
      },
      `row-name-rows-${width}-zh`,
    );
    await app.close();
  });
}
