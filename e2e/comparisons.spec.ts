import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { readWorkbook } from "../src/core/documents/formats/xlsx";
import {
  acceptPlainTextKeys,
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  useLocalChatModel,
  useOutputLocation,
} from "./app";

/*
 * Compare Documents (#98): from "/", the + menu or ⌘K, the sheet at the foot
 * of the Mind takes Documents and Questions and makes a comparison table,
 * which arrives as a change to accept. Its cells fill with cited Answers, a
 * busy provider waited out; each cell without one says why. "+ Question" adds
 * a column, Expand fills the card, a deleted Document's row says its source
 * was removed, and the table is there after a reload. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** Three suppliers' terms, a line each. */
const SUPPLIERS: Record<string, string> = {
  "Corvane Agreement.txt":
    "Corvane Agreement.\nTermination notice: 90 days.\nLiability cap: 12 months of fees.\n",
  "Halvard MSA.txt":
    "Halvard MSA.\nTermination notice: 6 months.\nLiability cap: twice the annual fees.\n",
  "Lumeric Order Form.txt":
    "Lumeric Order Form.\nTermination notice: 30 days.\nGoverning law: New York.\n",
};

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

const bridge = (window: Page) => ({
  language: (language: "en" | "zh-CN") =>
    window.evaluate(
      (value) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
          user: { language: value },
        }),
      language,
    ),
  /** Claude Haiku 5.5 on an Anthropic key, billed per token: choosing it allows sending to it. */
  cloudModel: () =>
    window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.saveChatProvider({
        kind: "anthropic",
        apiKey: "sk-ant-test",
        modelId: "claude-haiku-5-5",
      });
    }),
  documentId: (name: string) =>
    window.evaluate(
      async (wanted) =>
        (
          await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments()
        ).find((document) => document.name === wanted)?.id ?? "",
      name,
    ),
  deleteDocument: (id: string) =>
    window.evaluate(
      (documentId) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.deleteDocument(
          documentId,
        ),
      id,
    ),
});

async function addSuppliers(window: Page): Promise<void> {
  const paths: string[] = [];
  for (const [name, text] of Object.entries(SUPPLIERS)) {
    const path = join(sources, name);
    await writeFile(path, text);
    paths.push(path);
  }
  await addDocuments(window, paths);
}

/** A new Mind with a line of the User's, and the sheet opened from "/" on the line after it. */
async function openSheetFromSlash(window: Page): Promise<Locator> {
  await newMind(window);
  await window.keyboard.type("Shortlist: contract terms");
  await window.keyboard.press("Enter");
  await window.keyboard.type("Three suppliers made the shortlist.");
  await window.keyboard.press("Enter");
  await window.keyboard.type("/compare");
  await expect(window.getByTestId("slash-item-compare")).toBeVisible();
  await window.keyboard.press("Enter");
  const sheet = window.getByTestId("compare-sheet");
  await expect(sheet).toBeVisible();
  // The first Question's field has the focus.
  await expect(sheet.getByTestId("compare-sheet-question").first()).toBeFocused();
  return sheet;
}

/** Types the Questions into the sheet, one per line, as a person does. */
async function typeQuestions(window: Page, questions: readonly string[]): Promise<void> {
  for (const [index, question] of questions.entries()) {
    if (index > 0) await window.keyboard.press("Enter");
    await window.keyboard.type(question);
  }
}

const cellTexts = (table: Locator) =>
  table
    .getByTestId("comparison-row")
    .evaluateAll((rows) =>
      rows.map((row) =>
        [...row.querySelectorAll('[data-testid="comparison-cell"]')].map((cell) =>
          (cell as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
        ),
      ),
    );

test("Compare Documents from “/”: 3 Documents × 2 Questions fill as a change to accept, a busy provider waited out, every cell cited and checked; Accept all, Reject all and ⌘Z", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 860);
  await acceptPlainTextKeys(window);
  await bridge(window).cloudModel();
  await addSuppliers(window);

  const sheet = await openSheetFromSlash(window);
  await expect(sheet.getByTestId("compare-sheet-counted")).toHaveText("3 of 3");
  await expect(sheet.getByTestId("compare-sheet-document")).toHaveCount(3);
  await typeQuestions(window, ["Termination notice", "Liability cap (busy)"]);
  // A cloud model billed per token: the estimate shows before the run.
  await expect(sheet.getByTestId("compare-sheet-estimate")).toContainText(
    "About $0.0095 · 18 model calls",
  );
  await screenshot(window, "compare-sheet-en-1440");
  await pointAndClick(window, sheet.getByTestId("compare-sheet-make"));

  const table = window.getByTestId("comparison-table");
  await expect(table).toBeVisible();
  await expect(sheet).toHaveCount(0);
  await expect(table).toHaveAttribute("data-pending", "true");
  await expect(table.getByTestId("comparison-title")).toHaveText(
    "Comparison table · 3 Documents × 2 Questions",
  );
  // The busy provider refused each "busy" cell once; the fill waits and tries again.
  await expect(table.getByTestId("comparison-progress")).toHaveCount(0, { timeout: 30_000 });
  expect(await cellTexts(table)).toEqual([
    ["90 days 1", "12 months of fees 2"],
    ["6 months 3", "twice the annual fees 4"],
    ["30 days 5", "! not found"],
  ]);
  await expect(table.getByTestId("comparison-row").first()).toContainText("Corvane Agreement");
  // Each cell's Citation is checked, as any Answer's, and none is drawn in the margin.
  await expect(table.locator('.citation-marker[data-check="found"]')).toHaveCount(5);
  await expect(window.getByTestId("margin-checks").getByRole("button")).toHaveCount(0);
  await screenshot(window, "compare-filled-en-1440");

  // Accept all keeps it; ⌘Z takes that back; Reject all takes it out; ⌘Z brings it back.
  await pointAndClick(window, table.getByTestId("comparison-accept-all"));
  await expect(table).not.toHaveAttribute("data-pending", "true");
  await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
  await window.keyboard.press("ControlOrMeta+z");
  await expect(table).toHaveAttribute("data-pending", "true");
  await pointAndClick(window, table.getByTestId("comparison-reject-all"));
  await expect(window.getByTestId("comparison-table")).toHaveCount(0);
  await window.keyboard.press("ControlOrMeta+z");
  await expect(window.getByTestId("comparison-table")).toHaveAttribute("data-pending", "true");
  expect(await cellTexts(window.getByTestId("comparison-table"))).toHaveLength(3);
});

/** A one-Question table asked "slowly", so each cell can be watched being written. */
async function makeSlowTable(window: Page): Promise<Locator> {
  const sheet = await openSheetFromSlash(window);
  await typeQuestions(window, ["Termination notice (slowly)"]);
  await pointAndClick(window, sheet.getByTestId("compare-sheet-make"));
  const table = window.getByTestId("comparison-table");
  await expect(table).toBeVisible();
  return table;
}

test("a cell reads, then shows its words as they arrive and its checked Citation when it ends; the status line speaks only when a cell finishes; Stop takes half-written words away", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 860);
  await acceptPlainTextKeys(window);
  await bridge(window).cloudModel();
  await addSuppliers(window);
  const table = await makeSlowTable(window);
  const cells = table.getByTestId("comparison-cell");
  const progress = table.getByTestId("comparison-progress");

  // At once, every cell being written says so; none sits as an empty box or as "Waiting…".
  await expect(cells.first()).toHaveAttribute("data-status", "writing");
  await expect(cells.first().locator(".comparison-cell-reading")).toHaveText("Reading…");
  await expect(cells.first()).toHaveAttribute("aria-busy", "true");
  const readingHeight = (await cells.first().boundingBox())?.height;

  // Then its words, with the status line unchanged and no Citation yet.
  await expect(cells.first()).toHaveAttribute("data-streaming", "true");
  await expect(cells.first().locator(".comparison-cell-content")).toContainText("90 days");
  await expect(cells.first().locator(".comparison-cell-reading")).toBeHidden();
  await expect(cells.first().locator(".citation-marker")).toHaveCount(0);
  // The row holds its height as the label gives way to words.
  expect((await cells.first().boundingBox())?.height).toBe(readingHeight);
  await expect(progress).toHaveAttribute("role", "status");
  await expect(progress).toContainText("0 of 3 cells");

  // Stop while they stream: the words not finished go, and the cells say they stopped.
  await pointAndClick(window, table.getByTestId("comparison-stop"));
  await expect(progress).toHaveCount(0);
  for (const cell of await cells.all()) {
    await expect(cell).not.toHaveAttribute("data-streaming", "true");
    await expect(cell.locator(".comparison-cell-content")).toBeHidden();
    await expect(cell.locator(".comparison-cell-stopped")).toBeVisible();
  }
  await expect(table.getByTestId("comparison-fill")).toHaveText("Fill 3 cells");

  // Filling again writes them whole: the Citation lands checked, the status line counts them.
  await pointAndClick(window, table.getByTestId("comparison-fill"));
  await expect(progress).toBeVisible();
  await expect(progress).toHaveCount(0, { timeout: 60_000 });
  await expect(table.locator('.citation-marker[data-check="found"]')).toHaveCount(3);
  expect(await cellTexts(table)).toEqual([["90 days 1"], ["6 months 2"], ["30 days 3"]]);
  for (const cell of await cells.all()) {
    await expect(cell).toHaveAttribute("data-status", "done");
    await expect(cell).not.toHaveAttribute("aria-busy", "true");
  }
  expect((await cells.first().boundingBox())?.height).toBe(readingHeight);
});

test("in Chinese, at a narrow width and with reduced motion, a cell reads without a pulse and its words stay inside it", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await bridge(window).language("zh-CN");
  await setWindowSize(app, window, 900, 860);
  await window.emulateMedia({ reducedMotion: "reduce" });
  await acceptPlainTextKeys(window);
  await bridge(window).cloudModel();
  await addSuppliers(window);
  const sheet = await openSheetFromSlash(window);
  await typeQuestions(window, ["Termination notice (slowly)"]);
  await pointAndClick(window, sheet.getByTestId("compare-sheet-make"));
  const table = window.getByTestId("comparison-table");
  const cell = table.getByTestId("comparison-cell").first();

  const reading = cell.locator(".comparison-cell-reading");
  await expect(reading).toHaveText("正在阅读…");
  expect(
    await reading.evaluate((element) => getComputedStyle(element, "::before").animationName),
  ).toBe("none");

  await expect(cell).toHaveAttribute("data-streaming", "true");
  const content = cell.locator(".comparison-cell-content");
  await expect(content).toContainText("90 days");
  await expect(cell.locator(".comparison-cell-reading")).toBeHidden();
  const [inside, outside] = await Promise.all([content.boundingBox(), cell.boundingBox()]);
  expect(inside && outside && inside.x + inside.width <= outside.x + outside.width + 1).toBe(true);
  expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await expect(table.getByTestId("comparison-progress")).toHaveCount(0, { timeout: 60_000 });
});

test("“+ Question” adds a column that fills; Expand fills the card with the Document column held; a deleted Document's row says so; it is there after a reload and in the export", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1600, 860);
  await useLocalChatModel(window);
  await addSuppliers(window);

  const sheet = await openSheetFromSlash(window);
  await typeQuestions(window, ["Termination notice"]);
  // A model on this computer: no estimate.
  await expect(sheet.getByTestId("compare-sheet-estimate")).toHaveCount(0);
  await window.keyboard.press("ControlOrMeta+Enter");
  const table = window.getByTestId("comparison-table");
  await expect(table.getByTestId("comparison-progress")).toHaveCount(0, { timeout: 30_000 });
  await pointAndClick(window, table.getByTestId("comparison-accept-all"));
  await expect(table).not.toHaveAttribute("data-pending", "true");

  // "+ Question": a column, written in place, then filled.
  await pointAndClick(window, table.getByTestId("comparison-add-question").locator("visible=true"));
  await expect(table.getByTestId("comparison-new-question")).toBeFocused();
  await window.keyboard.type("Governing law");
  await window.keyboard.press("Enter");
  await expect(table.getByTestId("comparison-question")).toHaveText([
    "Termination notice",
    "Governing law",
  ]);
  await expect(table.getByTestId("comparison-progress")).toHaveCount(0, { timeout: 30_000 });
  await expect
    .poll(() => cellTexts(table))
    .toEqual([
      ["90 days 1", "! not found"],
      ["6 months 2", "! not found"],
      ["30 days 3", "New York 4"],
    ]);

  // Expand: the table fills the card; Esc goes back to the note.
  const scroller = window.locator(".mind-scroller").first();
  await pointAndClick(window, table.getByTestId("comparison-expand"));
  await expect(table).toHaveAttribute("data-expanded", "true");
  await expect(table.getByTestId("comparison-back")).toBeVisible();
  const [card, expanded] = [await scroller.boundingBox(), await table.boundingBox()];
  if (!card || !expanded) throw new Error("The card or the table isn't on screen.");
  expect(Math.abs(expanded.x - card.x)).toBeLessThan(2);
  expect(Math.abs(expanded.y - card.y)).toBeLessThan(2);
  expect(expanded.height).toBeGreaterThan(card.height - 2);
  await screenshot(window, "compare-expanded-en-1600");

  // Export to Excel, in the expanded title line beside "+ Question": the result line says where
  // it went.
  await table.getByTestId("comparison-export-excel").hover();
  await screenshot(window, "compare-excel-hover-en-1600");
  await pointAndClick(window, table.getByTestId("comparison-export-excel"));
  const result = window.getByTestId("export-result");
  await expect(result).toHaveAttribute("data-state", "saved", { timeout: 20_000 });
  await expect(result).toContainText("Shortlist contract terms.xlsx");
  await screenshot(window, "compare-excel-saved-en-1600");
  // Esc collapses the table first; the line stays until the next Esc.
  await window.keyboard.press("Escape");
  await expect(table).not.toHaveAttribute("data-expanded", "true");
  await expect(result).toHaveAttribute("data-state", "saved");
  await window.keyboard.press("Escape");
  await expect(result).toHaveCount(0);

  // The same from ⌘K, by keyboard, with the table not expanded: the next free name.
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("Export table to Excel");
  await expect(window.getByTestId("palette-item").first()).toContainText("Export table to Excel");
  await screenshot(window, "compare-excel-palette-en-1600");
  await window.keyboard.press("Enter");
  await expect(result).toHaveAttribute("data-state", "saved", { timeout: 20_000 });
  await expect(result).toContainText("Shortlist contract terms 2.xlsx");
  await screenshot(window, "compare-excel-saved-keyboard-en-1600");
  await window.keyboard.press("Escape");

  // Narrow, in English and Chinese, the expanded title line keeps Export to Excel in the card.
  await setWindowSize(app, window, 900, 860);
  await pointAndClick(window, table.getByTestId("comparison-expand"));
  for (const language of ["en", "zh-CN"] as const) {
    await bridge(window).language(language);
    const exportButton = table.getByTestId("comparison-export-excel");
    await expect(exportButton).toHaveText(language === "en" ? "Export to Excel" : "导出到 Excel");
    const [box, frame] = [await exportButton.boundingBox(), await scroller.boundingBox()];
    if (!box || !frame) throw new Error("The button or the card isn't on screen.");
    expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
    await screenshot(window, `compare-excel-expanded-${language}-900`);
  }
  await bridge(window).language("en");
  await window.keyboard.press("Escape");
  await expect(table).not.toHaveAttribute("data-expanded", "true");

  // Scrolled sideways, the Document column stays where it was; the Questions move.
  for (const question of ["Liability cap", "Auto-renewal", "Price increase limit"]) {
    await pointAndClick(
      window,
      table.getByTestId("comparison-add-question").locator("visible=true"),
    );
    await window.keyboard.type(question);
    await window.keyboard.press("Enter");
  }
  await expect(table.getByTestId("comparison-progress")).toHaveCount(0, { timeout: 30_000 });
  const frame = table.locator(".comparison-scroll");
  const documentCell = table.locator(".comparison-document").first();
  const firstQuestion = table.getByTestId("comparison-question").first();
  // From its start: the last column's field had scrolled it to the end.
  await frame.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await expect.poll(() => frame.evaluate((element) => element.scrollLeft)).toBe(0);
  const before = {
    document: await documentCell.boundingBox(),
    question: await firstQuestion.boundingBox(),
  };
  await frame.evaluate((element) => {
    element.scrollLeft = 200;
  });
  await expect
    .poll(async () => (await firstQuestion.boundingBox())?.x)
    .toBeLessThan((before.question?.x ?? 0) - 100);
  expect((await documentCell.boundingBox())?.x).toBe(before.document?.x);
  await screenshot(window, "compare-scrolled-en-900");

  // A deleted Document: its row says its source was removed.
  await bridge(window).deleteDocument(await bridge(window).documentId("Lumeric Order Form"));
  const lumeric = table.getByTestId("comparison-row").filter({ hasText: "Lumeric Order Form" });
  await expect(lumeric.getByTestId("comparison-source-removed")).toHaveText("source removed");

  // After a reload the table is there as it was.
  await window.reload();
  await expect(window.getByTestId("comparison-table")).toBeVisible({ timeout: 20_000 });
  expect((await cellTexts(window.getByTestId("comparison-table")))[0]?.slice(0, 2)).toEqual([
    "90 days 1",
    "! not found",
  ]);

  // The Markdown export holds it as a table, its Citations as footnotes.
  const markdown = await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const [mind] = await core.listMinds();
    const exported = await core.exportMind(mind?.id ?? "", { format: "markdown" });
    return new TextDecoder().decode(exported.data);
  });
  expect(markdown).toContain(
    "| Document | Termination notice | Governing law | Liability cap | Auto-renewal | Price increase limit |",
  );
  expect(markdown).toContain("| Corvane Agreement | 90 days[^1] | not found |");
  expect(markdown).toMatch(/\n\[\^1\]: Corvane Agreement, /);
});

test("empty states from the + menu, and the monthly cap: every cell left says it wasn't checked, in Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await bridge(window).language("zh-CN");
  await setWindowSize(app, window, 900, 860);
  await acceptPlainTextKeys(window);
  await bridge(window).cloudModel();

  // No Documents: the sheet says so, and nothing can be made.
  await newMind(window);
  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-more"));
  await pointAndClick(window, window.getByTestId("plus-compare-documents"));
  const sheet = window.getByTestId("compare-sheet");
  await expect(sheet.getByTestId("compare-sheet-no-documents")).toContainText("这里还没有文档。");
  await expect(sheet.getByTestId("compare-sheet-make")).toBeDisabled();
  await pointAndClick(window, sheet.getByTestId("compare-sheet-close"));
  await expect(sheet).toHaveCount(0);

  // From the + menu once there are Documents: no Question yet, so it says what's missing.
  await addSuppliers(window);
  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-more"));
  await pointAndClick(window, window.getByTestId("plus-compare-documents"));
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("compare-sheet-hint-questions")).toHaveText(
    "每列一个问题，先添加一个。",
  );
  await expect(sheet.getByTestId("compare-sheet-make")).toBeDisabled();
  await typeQuestions(window, ["Termination notice", "Liability cap"]);
  // The model's name is never squeezed into a letter: Make moves down instead (#763).
  const model = sheet.getByTestId("composer-model");
  await expect(model).toBeVisible();
  await expect
    .poll(() =>
      model.locator("span").first().evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true);
  await screenshot(window, "compare-sheet-zh-900");

  // A cap too small for one request: nothing is sent, and every cell says why.
  await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { monthlyCap: { amount: 0.000001, currency: "USD" } },
    }),
  );
  await pointAndClick(window, sheet.getByTestId("compare-sheet-make"));
  const table = window.getByTestId("comparison-table");
  await expect(table.getByTestId("comparison-title")).toHaveText("对比表 · 3 个文档 × 2 个问题");
  await expect(table.getByTestId("comparison-progress")).toHaveCount(0, { timeout: 30_000 });
  await expect(table.getByTestId("comparison-cell-problem")).toHaveText(
    Array(6).fill("!未核对：已达花费上限"),
  );
  await expect(table.getByTestId("comparison-fill")).toHaveText("补全 6 个单元格");
  // The table says what stopped it, once, with the one thing that helps.
  await expect(table.getByTestId("comparison-stopped")).toContainText("已达到每月花费上限");
  await expect(table.getByTestId("comparison-stopped")).toContainText("更改上限");
  await screenshot(window, "compare-cost-cap-zh-900");
});

async function addLibrary(window: Page, count: number): Promise<void> {
  const paths: string[] = [];
  for (let each = 1; each <= count; each++) {
    const number = String(each).padStart(2, "0");
    const path = join(sources, `Supplier ${number}.txt`);
    await writeFile(path, `Supplier ${number}.\nTermination notice: ${number} days.\n`);
    paths.push(path);
  }
  await addDocuments(window, paths);
}

async function openSheetFromPlusMenu(window: Page): Promise<Locator> {
  await newMind(window);
  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-more"));
  await pointAndClick(window, window.getByTestId("plus-compare-documents"));
  const sheet = window.getByTestId("compare-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("compare-sheet-question").first()).toBeFocused();
  return sheet;
}

const WORDS = {
  en: {
    counted: (checked: number, total: number) => `${checked} of ${total}`,
    tick: "Tick the Documents to compare.",
    addQuestion: "Add a Question for each column.",
    ask: (count: number) => `Compare ${count} Documents?`,
    cells: (count: number) => `${count} cells to fill`,
    title: (documents: number) => `Comparison table · ${documents} Documents × 1 Question`,
    selectAll: "Select all Documents",
    selectNone: "Clear selection",
    selectedFromLibrary: "Documents selected in the Library",
  },
  "zh-CN": {
    counted: (checked: number, total: number) => `${checked}/${total}`,
    tick: "勾选要对比的文档。",
    addQuestion: "每列一个问题，先添加一个。",
    ask: (count: number) => `对比 ${count} 个文档？`,
    cells: (count: number) => `要填写 ${count} 个单元格`,
    title: (documents: number) => `对比表 · ${documents} 个文档 × 1 个问题`,
    selectAll: "全选文档",
    selectNone: "取消选择",
    selectedFromLibrary: "资料库中已选的文档",
  },
} as const;

const SCOPE_VARIANTS = [
  { language: "en", width: 900 },
  { language: "en", width: 1440 },
  { language: "zh-CN", width: 900 },
  { language: "zh-CN", width: 1440 },
] as const;

for (const { language, width } of SCOPE_VARIANTS) {
  test(`Compare Documents opens with nothing ticked, ticks all or none by click and key, shows its estimate beside the button, and asks before a large run only (${language}, ${width} px)`, async () => {
    test.setTimeout(150_000);
    const words = WORDS[language];
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await bridge(window).language(language);
    await setWindowSize(app, window, width, 860);
    await acceptPlainTextKeys(window);
    await bridge(window).cloudModel();
    await addLibrary(window, 22);

    const sheet = await openSheetFromPlusMenu(window);
    const boxes = sheet.getByTestId("compare-sheet-document");
    const ticked = sheet.locator('[data-testid="compare-sheet-document"]:checked');
    const counted = sheet.getByTestId("compare-sheet-counted");
    const make = sheet.getByTestId("compare-sheet-make");
    const selectAll = sheet.getByTestId("compare-sheet-select-all");
    const estimate = sheet.getByTestId("compare-sheet-estimate");
    const ask = sheet.getByTestId("compare-sheet-ask");

    await expect(boxes).toHaveCount(22);
    await expect(counted).toHaveText(words.counted(0, 22));
    await expect(ticked).toHaveCount(0);
    await expect(make).toBeDisabled();
    await expect(estimate).toHaveCount(0);
    await expect(sheet.getByTestId("compare-sheet-hint-documents")).toHaveText(words.tick);
    await expect(sheet.getByTestId("compare-sheet-hint-questions")).toHaveText(words.addQuestion);
    await screenshot(window, `compare-scope-start-${language}-${width}`);

    await typeQuestions(window, ["Termination notice"]);
    await expect(sheet.getByTestId("compare-sheet-hint-questions")).toHaveCount(0);
    await expect(make).toBeDisabled();

    await pointAndClick(window, boxes.first());
    await expect(counted).toHaveText(words.counted(1, 22));
    await expect(make).toBeEnabled();
    await expect(selectAll).toHaveJSProperty("indeterminate", true);
    await expect(estimate).toContainText("$0.00");
    const [estimateBox, makeBox, sheetBox] = [
      await estimate.boundingBox(),
      await make.boundingBox(),
      await sheet.boundingBox(),
    ];
    if (!estimateBox || !makeBox || !sheetBox) throw new Error("The estimate isn't showing.");
    const gap = makeBox.y - (estimateBox.y + estimateBox.height);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(makeBox.height + 12);
    expect(estimateBox.x).toBeGreaterThanOrEqual(sheetBox.x);
    expect(estimateBox.x + estimateBox.width).toBeLessThanOrEqual(sheetBox.x + sheetBox.width);
    await expect(estimate).toBeInViewport();
    await screenshot(window, `compare-scope-estimate-${language}-${width}`);

    await expect(selectAll).toHaveAccessibleName(words.selectNone);
    await pointAndClick(window, selectAll);
    await expect(ticked).toHaveCount(0);
    await expect(counted).toHaveText(words.counted(0, 22));
    await expect(selectAll).toHaveAccessibleName(words.selectAll);
    await pointAndClick(window, selectAll);
    await expect(ticked).toHaveCount(22);
    await expect(selectAll).toBeChecked();
    await expect(selectAll).toHaveJSProperty("indeterminate", false);

    await pointAndClick(window, sheet.getByTestId("compare-sheet-question").first());
    await window.keyboard.press("Tab");
    await expect(sheet.getByTestId("compare-sheet-add-question")).toBeFocused();
    await window.keyboard.press("Tab");
    await expect(selectAll).toBeFocused();
    await window.keyboard.press("Space");
    await expect(ticked).toHaveCount(0);
    await window.keyboard.press("Tab");
    await expect(sheet.getByTestId("compare-sheet-source")).toBeFocused();
    await window.keyboard.press("Tab");
    await expect(boxes.first()).toBeFocused();
    await window.keyboard.press("ControlOrMeta+a");
    await expect(ticked).toHaveCount(22);

    await pointAndClick(window, make);
    await expect(ask).toBeVisible();
    await expect(ask).toContainText(words.ask(22));
    await expect(ask).toContainText("$0.03");
    await expect(make).toHaveCount(0);
    await expect(sheet.getByTestId("compare-sheet-ask-make")).toBeFocused();
    await expect(window.getByTestId("comparison-table")).toHaveCount(0);
    await screenshot(window, `compare-scope-ask-${language}-${width}`);

    await pointAndClick(window, sheet.getByTestId("compare-sheet-ask-choose"));
    await expect(ask).toHaveCount(0);
    await expect(selectAll).toBeFocused();
    await expect(ticked).toHaveCount(22);
    await window.keyboard.press("ControlOrMeta+Enter");
    await expect(ask).toBeVisible();
    await window.keyboard.press("ControlOrMeta+Enter");
    await expect(ask).toBeVisible();
    await expect(window.getByTestId("comparison-table")).toHaveCount(0);
    await window.keyboard.press("Escape");
    await expect(ask).toHaveCount(0);
    await expect(sheet).toBeVisible();
    await window.keyboard.press("ControlOrMeta+Enter");
    await expect(ask).toBeVisible();
    await pointAndClick(window, boxes.nth(5));
    await expect(ask).toHaveCount(0);
    await expect(counted).toHaveText(words.counted(21, 22));

    await pointAndClick(window, boxes.nth(6));
    await expect(counted).toHaveText(words.counted(20, 22));
    await pointAndClick(window, make);
    await expect(window.getByTestId("comparison-table").getByTestId("comparison-title")).toHaveText(
      words.title(20),
    );
    await expect(sheet).toHaveCount(0);
  });
}

test("a tick doesn't move the sheet: the estimate stays on show while the next one loads", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 900, 860);
  await acceptPlainTextKeys(window);
  await bridge(window).cloudModel();
  await addLibrary(window, 12);

  const sheet = await openSheetFromPlusMenu(window);
  const boxes = sheet.getByTestId("compare-sheet-document");
  const estimate = sheet.getByTestId("compare-sheet-estimate");
  await typeQuestions(window, ["Termination notice"]);
  await pointAndClick(window, boxes.first());
  await expect(estimate).toContainText("About $");

  // A flash lasts a frame or two, so it is sampled on every frame rather than polled for.
  await window.evaluate(() => {
    const sampler = { running: true, frames: [] as { estimate: boolean; height: number }[] };
    (globalThis as unknown as { sampler: typeof sampler }).sampler = sampler;
    const sample = () => {
      const box = document.querySelector('[data-testid="compare-sheet"]')?.getBoundingClientRect();
      sampler.frames.push({
        estimate: document.querySelector('[data-testid="compare-sheet-estimate"]') !== null,
        height: Math.round(box?.height ?? -1),
      });
      if (sampler.running) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  for (const index of [1, 2, 3, 4, 5]) await pointAndClick(window, boxes.nth(index));
  await expect(sheet.getByTestId("compare-sheet-counted")).toHaveText("6 of 12");
  await expect(estimate).toContainText("18 model calls");
  const frames = await window.evaluate(() => {
    const { sampler } = globalThis as unknown as {
      sampler: { running: boolean; frames: { estimate: boolean; height: number }[] };
    };
    sampler.running = false;
    return sampler.frames;
  });
  expect(frames.length).toBeGreaterThan(10);
  expect(frames.every((frame) => frame.estimate)).toBe(true);
  expect(new Set(frames.map((frame) => frame.height)).size).toBe(1);

  // With nothing ticked the sheet shows its hint again, so this step is outside the sampled frames.
  await pointAndClick(window, sheet.getByTestId("compare-sheet-select-all"));
  await expect(sheet.getByTestId("compare-sheet-counted")).toHaveText("0 of 12");
  await expect(estimate).toBeHidden();
});

test("a large run goes on once it is asked about: Enter on the question makes the table", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 860);
  await useLocalChatModel(window);
  await addLibrary(window, 22);

  const sheet = await openSheetFromPlusMenu(window);
  await typeQuestions(window, ["Termination notice"]);
  await pointAndClick(window, sheet.getByTestId("compare-sheet-select-all"));
  await expect(sheet.getByTestId("compare-sheet-counted")).toHaveText("22 of 22");
  await pointAndClick(window, sheet.getByTestId("compare-sheet-make"));
  const ask = sheet.getByTestId("compare-sheet-ask");
  await expect(ask).toContainText(WORDS.en.ask(22));
  await expect(ask).toContainText(WORDS.en.cells(22));
  await expect(sheet.getByTestId("compare-sheet-ask-make")).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("comparison-table").getByTestId("comparison-title")).toHaveText(
    WORDS.en.title(22),
  );
  await expect(sheet).toHaveCount(0);
});

test("the Documents selected in the Library are offered as the scope, and start the sheet ticked", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 860);
  await useLocalChatModel(window);
  await addLibrary(window, 8);

  await window.getByTestId("open-library").click();
  const library = window.getByTestId("library");
  const selectBoxes = library.getByTestId("library-select");
  for (const index of [1, 3, 4]) await pointAndClick(window, selectBoxes.nth(index));
  await expect(library.getByTestId("library-selection")).toBeVisible();

  const sheet = await openSheetFromPlusMenu(window);
  const source = sheet.getByTestId("compare-sheet-source");
  const counted = sheet.getByTestId("compare-sheet-counted");
  await expect(source).toContainText(WORDS.en.selectedFromLibrary);
  await expect(counted).toHaveText("3 of 3");
  await expect(sheet.getByTestId("compare-sheet-document")).toHaveCount(3);

  await pointAndClick(window, source);
  await pointAndClick(window, window.getByRole("menuitem", { name: "All Documents" }));
  await expect(counted).toHaveText("0 of 8");
  await pointAndClick(window, source);
  await pointAndClick(window, sheet.getByTestId("compare-sheet-source-selected"));
  await expect(counted).toHaveText("3 of 3");
  await expect(source).toContainText(WORDS.en.selectedFromLibrary);
});

test("a cell whose amount changed scale says what the Document gives, offers Fill, and exports as it reads, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 860);
  await useLocalChatModel(window);
  const files = {
    "Cedar final.txt": "Cedar Q3 2026 final.\nNet debt: 310,000 (GBP thousands).\n",
    "Cedar draft.txt": "Cedar Q3 2026 draft.\nAll amounts in GBP million.\nNet debt: 340.\n",
  };
  const paths: string[] = [];
  for (const [name, text] of Object.entries(files)) {
    paths.push(join(sources, name));
    await writeFile(join(sources, name), text);
  }
  await addDocuments(window, paths);

  const sheet = await openSheetFromSlash(window);
  // The scripted model writes the final's GBP thousands as GBP million, even when told.
  await typeQuestions(window, ["Net debt (rescaled)"]);
  await window.keyboard.press("ControlOrMeta+Enter");
  const table = window.getByTestId("comparison-table");
  await expect(sheet).toHaveCount(0);
  await expect(table.getByTestId("comparison-progress")).toHaveCount(0, { timeout: 30_000 });
  const rows = await table.getByTestId("comparison-row").allInnerTexts();
  const final = rows.findIndex((row) => row.includes("Cedar final"));
  const shownRows = await cellTexts(table);
  expect(shownRows[final]).toEqual([
    "! scale differs from the Document, which gives 310,000 GBP thousands",
  ]);
  expect(shownRows[1 - final]).toEqual(["340 1"]);
  await expect(table.getByTestId("comparison-fill")).toHaveText("Fill 1 cell");
  await screenshot(window, "compare-scale-en-1440");

  // Fill writes it again; the model changes the scale again, and the cell says so again.
  await pointAndClick(window, table.getByTestId("comparison-fill"));
  const progress = table.getByTestId("comparison-progress");
  await expect(progress).toBeVisible();
  await expect(progress).toHaveCount(0, { timeout: 30_000 });
  await expect(table.getByTestId("comparison-fill")).toHaveText("Fill 1 cell");
  expect((await cellTexts(table))[final]?.[0]).toContain("310,000 GBP thousands");

  // The Excel file holds what the table shows, and no Source for the flagged cell.
  await pointAndClick(window, table.getByTestId("comparison-accept-all"));
  await useOutputLocation(window, sources);
  await pointAndClick(window, table.getByTestId("comparison-expand"));
  await pointAndClick(window, table.getByTestId("comparison-export-excel"));
  await expect(window.getByTestId("export-result")).toHaveAttribute("data-state", "saved", {
    timeout: 20_000,
  });
  const [book, evidence] = (
    await readWorkbook(
      new Uint8Array(await readFile(join(sources, "Shortlist contract terms.xlsx"))),
    )
  ).sheets;
  const at = (cells: { row: number; column: number; value: string }[] | undefined, row: number) =>
    cells?.find((cell) => cell.row === row && cell.column === 1)?.value;
  expect(at(book?.cells, final + 2)).toBe(
    "scale differs from the Document, which gives 310,000 GBP thousands",
  );
  expect(evidence?.rowCount).toBe(2);
  expect(evidence?.cells.find((cell) => cell.row === 2 && cell.column === 0)?.value).toBe(
    "Cedar draft · Net debt (rescaled)",
  );
  await window.keyboard.press("Escape");

  await bridge(window).language("zh-CN");
  await expect
    .poll(async () => (await cellTexts(table))[final]?.[0])
    .toBe("! 金额单位与文档不符，文档写的是 310,000 GBP thousands");
  await expect(table.getByTestId("comparison-fill")).toHaveText("补全 1 个单元格");
  await screenshot(window, "compare-scale-zh-1440");

  // At a narrow width the line wraps inside its cell.
  await setWindowSize(app, window, 900, 860);
  const cell = table.getByTestId("comparison-row").nth(final).getByTestId("comparison-cell");
  const [line, box] = [
    await cell.getByTestId("comparison-cell-problem").boundingBox(),
    await cell.boundingBox(),
  ];
  if (!line || !box) throw new Error("The cell isn't on screen.");
  expect(line.x).toBeGreaterThanOrEqual(box.x - 1);
  expect(line.x + line.width).toBeLessThanOrEqual(box.x + box.width + 1);
  await screenshot(window, "compare-scale-zh-900");
});
