import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import { readWorkbook } from "../src/core/documents/formats/xlsx";
import {
  acceptPlainTextKeys,
  addDocuments,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  stubClipboard,
  useLocalChatModel,
  useOutputLocation,
  WORD_KEY,
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
  cloudModel: (modelId = "claude-haiku-5-5", kind: "anthropic" | "ollama" = "anthropic") =>
    window.evaluate(
      async (chosen) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.saveChatProvider({
          kind: chosen.kind,
          ...(chosen.kind === "anthropic" ? { apiKey: "sk-ant-test" } : {}),
          modelId: chosen.modelId,
        });
      },
      { modelId, kind },
    ),
  documentId: (name: string) =>
    window.evaluate(
      async (wanted) =>
        (
          await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments()
        ).find((document) => document.name === wanted)?.id ?? "",
      name,
    ),
  /** A monthly cap, so the estimate shows under it even for a run that costs less than a dollar (#1941). */
  cap: () =>
    window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { monthlyCap: { amount: 20, currency: "USD" } },
      }),
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

/**
 * Waits until every one of `cells` cells has its outcome. A fill starts a moment after
 * the table is made or rows are added, so an absent progress line does not mean it ended.
 */
/** Fill Tasks that have ended, as the assistant's progress cards show them. */
const fillsDone = (window: Page) =>
  window.locator('[data-testid="task-progress"][data-status="done"]').count();

/**
 * Chooses a refill with `choose` and waits for that fill to end: one more fill Task done and the
 * table no longer filling. The table's own progress line isn't there yet when the refill is
 * chosen, so its absence can't say the fill ended.
 */
async function refillEnded(window: Page, table: Locator, choose: () => Promise<void>) {
  const before = await fillsDone(window);
  await choose();
  await expect.poll(() => fillsDone(window), { timeout: 30_000 }).toBe(before + 1);
  await expect(table).not.toHaveAttribute("data-filling", "true");
}

const fillSettled = async (table: Locator, cells: number) => {
  await expect
    .poll(
      async () => {
        const statuses = await table
          .getByTestId("comparison-cell")
          .evaluateAll((each) => each.map((cell) => cell.getAttribute("data-status")));
        return (
          statuses.length === cells &&
          statuses.every((status) => status === "done" || status === "failed")
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
};

test("Compare Documents from “/”: 3 Documents × 2 Questions fill as a change to accept, a busy provider waited out, every cell cited and checked; Accept all, Reject all and ⌘Z", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 860);
  await acceptPlainTextKeys(window);
  await bridge(window).cloudModel();
  await bridge(window).cap();
  await addSuppliers(window);

  const sheet = await openSheetFromSlash(window);
  await expect(sheet.getByTestId("compare-sheet-counted")).toHaveText("3 of 3");
  await expect(sheet.getByTestId("compare-sheet-document")).toHaveCount(3);
  await typeQuestions(window, ["Termination notice", "Liability cap (busy)"]);
  // A cloud model billed per token under a monthly cap: the estimate shows before the run, and
  // never says model calls.
  const estimateLine = sheet.getByTestId("compare-sheet-estimate");
  await expect(estimateLine).toHaveText(
    /^About \$[\d.,]+ · [\d.,]+[KMB]? tokens · \$[\d.,]+ of \$20\.00 used this month$/,
  );
  await expect(estimateLine).not.toContainText("model calls");
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
  await expect(result).toContainText("Comparison table.xlsx");
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
  await expect(result).toContainText("Comparison table 2.xlsx");
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
      model
        .locator("span")
        .first()
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true);
  await screenshot(window, "compare-sheet-zh-900");
  // Its foot, which the model's name makes wrap: kept for the pull request's before and after.
  if (SCREENSHOTS) {
    await mkdir(SCREENSHOTS, { recursive: true });
    await sheet
      .locator(".compare-sheet-foot")
      .screenshot({ path: join(SCREENSHOTS, "compare-footer-zh-900.png") });
  }

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
    await bridge(window).cap();
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
    const estimateText =
      language === "zh-CN"
        ? /^约 \$[\d.,]+ · [^\s·]+ token · 本月已用 \$[\d.,]+，上限 \$20\.00$/
        : /^About \$[\d.,]+ · [^\s·]+ tokens · \$[\d.,]+ of \$20\.00 used this month$/;
    await expect(estimate).toHaveText(estimateText);
    await expect(estimate).not.toContainText("model calls");
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
  await bridge(window).cap();
  await addLibrary(window, 12);

  const sheet = await openSheetFromPlusMenu(window);
  const boxes = sheet.getByTestId("compare-sheet-document");
  const estimate = sheet.getByTestId("compare-sheet-estimate");
  await typeQuestions(window, ["Termination notice"]);
  await pointAndClick(window, boxes.first());
  await expect(estimate).toHaveText(
    /^About \$[\d.,]+ · [\d.,]+[KMB]? tokens · \$[\d.,]+ of \$20\.00 used this month$/,
  );

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
  await expect(estimate).toHaveText(
    /^About \$[\d.,]+ · [\d.,]+[KMB]? tokens · \$[\d.,]+ of \$20\.00 used this month$/,
  );
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

test("a key saved while a large run is being confirmed keeps the question, and Make runs once with that model (#1922)", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 860);
  await acceptPlainTextKeys(window);
  // A monthly cap, so the estimate shows under it even for a run that costs less than a dollar (#1941).
  await bridge(window).cap();
  await addLibrary(window, 22);

  const sheet = await openSheetFromPlusMenu(window);
  await typeQuestions(window, ["Termination notice"]);
  await pointAndClick(window, sheet.getByTestId("compare-sheet-select-all"));
  await expect(sheet.getByTestId("compare-sheet-counted")).toHaveText("22 of 22");
  await pointAndClick(window, sheet.getByTestId("compare-sheet-make"));
  const ask = sheet.getByTestId("compare-sheet-ask");
  await expect(ask).toContainText(WORDS.en.ask(22));
  await pointAndClick(window, sheet.getByTestId("compare-sheet-ask-make"));

  // No model yet: the key field comes in place, with the question still asked.
  const needs = sheet.getByTestId("compare-sheet-needs-model");
  await expect(needs).toBeVisible();
  await expect(ask).toBeVisible();
  const field = needs.getByTestId("compare-sheet-needs-model-key");
  await field.fill("sk-ant-api03-a-test-key-for-first-run");
  await field.press("Enter");

  // The key saved, the question stays and now prices the run with that model; nothing runs by itself.
  await expect(needs).toHaveCount(0);
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("About $");
  await expect(sheet.getByTestId("comparison-table")).toHaveCount(0);
  await pointAndClick(window, sheet.getByTestId("compare-sheet-ask-make"));
  const table = window.getByTestId("comparison-table");
  await expect(table.getByTestId("comparison-title")).toHaveText(WORDS.en.title(22), {
    timeout: 60_000,
  });
  await expect(table).toHaveCount(1);
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
    await readWorkbook(new Uint8Array(await readFile(join(sources, "Comparison table.xlsx"))))
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

/** The Answers in each cell without its Citation numbers. */
const answersIn = async (table: Locator): Promise<string[][]> =>
  (await cellTexts(table)).map((row) => row.map((text) => text.replace(/(\s+\d+)+\s*$/, "")));

/** The Answers in a row in the order the table draws them, from left to right. */
const visualAnswersIn = (table: Locator, row = 0): Promise<string[]> =>
  table
    .getByTestId("comparison-row")
    .nth(row)
    .getByTestId("comparison-cell")
    .evaluateAll((cells) =>
      cells
        .map((cell) => ({
          x: cell.getBoundingClientRect().x,
          text: (cell as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
        }))
        .sort((left, right) => left.x - right.x)
        .map((cell) => cell.text.replace(/(\s+\d+)+\s*$/, "")),
    );

/** The heading of a column, or a cell by its row and column, as the table draws them. */
const headingAt = (table: Locator, column: number) =>
  table.getByTestId("comparison-question").nth(column);
const cellAt = (table: Locator, row: number, column: number) =>
  table.getByTestId("comparison-row").nth(row).getByTestId("comparison-cell").nth(column);

async function expectGridRows(table: Locator): Promise<void> {
  const grid = await table.getByTestId("comparison-row").evaluateAll((rows) =>
    rows.map((row) =>
      [
        row.querySelector(".comparison-document"),
        ...row.querySelectorAll('[data-testid="comparison-cell"]'),
      ].map((cell) => {
        const element = cell as HTMLElement;
        const box = element.getBoundingClientRect();
        const parents = [];
        let parent = element.parentElement;
        while (parent && !parent.classList.contains("comparison-scroll")) {
          parents.push({ class: parent.className, display: getComputedStyle(parent).display });
          parent = parent.parentElement;
        }
        return {
          text: element.innerText.slice(0, 30),
          top: Math.round(box.top),
          left: Math.round(box.left),
          parent: element.parentElement?.className,
          parents,
        };
      }),
    ),
  );
  for (const row of grid) {
    if (new Set(row.map((cell) => cell.top)).size !== 1) {
      throw new Error(`A comparison row's cells don't share a grid row: ${JSON.stringify(grid)}`);
    }
  }
}

/** A filled 3 × 2 table of suppliers' terms, accepted, so the columns can be changed. */
async function filledSuppliersTable(window: Page): Promise<Locator> {
  await addSuppliers(window);
  const sheet = await openSheetFromSlash(window);
  await typeQuestions(window, ["Termination notice", "Liability cap"]);
  await pointAndClick(window, sheet.getByTestId("compare-sheet-make"));
  const table = window.getByTestId("comparison-table");
  await expect(table).toBeVisible();
  await expect(table.getByTestId("comparison-progress")).toHaveCount(0, { timeout: 30_000 });
  await pointAndClick(window, table.getByTestId("comparison-accept-all"));
  await expect(table).not.toHaveAttribute("data-pending", "true");
  return table;
}

/** A 2 × 2 table whose cells are full claims, with the note's own lines taken out. */
async function filledClaimsTable(window: Page): Promise<Locator> {
  // The app's examples would make rows of their own: this table is its two Documents alone.
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const documents = await core.listDocuments();
    if (documents.length > 0) {
      await core.deleteDocuments(documents.map((document) => document.id));
    }
  });
  const files: Record<string, string> = {
    "Alpha Terms.txt":
      "Alpha Terms.\nTermination notice: Alpha may end the agreement in 30 days.\nLiability cap: Alpha's liability is capped at twelve months of fees.\n",
    "Beta Terms.txt":
      "Beta Terms.\nTermination notice: Beta may end the agreement in 60 days.\nLiability cap: Beta's liability is capped at six months of fees.\n",
  };
  const paths: string[] = [];
  for (const [name, text] of Object.entries(files)) {
    const path = join(sources, name);
    await writeFile(path, text);
    paths.push(path);
  }
  await addDocuments(window, paths);
  const sheet = await openSheetFromSlash(window);
  await typeQuestions(window, ["Termination notice", "Liability cap"]);
  await pointAndClick(window, sheet.getByTestId("compare-sheet-make"));
  const table = window.getByTestId("comparison-table");
  await expect(table).toBeVisible();
  await expect(table.getByTestId("comparison-progress")).toHaveCount(0, { timeout: 30_000 });
  await pointAndClick(window, table.getByTestId("comparison-accept-all"));
  await expect(table).not.toHaveAttribute("data-pending", "true");
  // The note's own lines made claims too: take them out, so the cells are what needs a look.
  await window
    .getByTestId("mind-editor")
    .first()
    .evaluate((dom) => {
      const editor = (dom as unknown as { editor: Editor }).editor;
      let tablePos = -1;
      editor.state.doc.forEach((node, offset) => {
        if (node.type.name === "comparisonTable") tablePos = offset;
      });
      if (tablePos > 0) editor.commands.deleteRange({ from: 0, to: tablePos });
      // A line above the table, so "Show" starts before its first cell rather than in it.
      editor.commands.insertContentAt(0, { type: "paragraph" });
    });
  return table;
}

/** A double-click on a heading, and the label and Question it opens in place. */
async function editColumn(window: Page, heading: Locator) {
  const point = await pointAt(window, heading);
  await window.mouse.dblclick(point.x, point.y);
  const label = window.getByTestId("comparison-edit-label");
  await expect(label).toBeFocused();
  return { label, question: window.getByTestId("comparison-edit-question") };
}

/** Every chat model taken away, so a reworded column waits rather than filling at once. */
async function forgetModels(window: Page): Promise<void> {
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    for (const provider of await core.listChatProviders())
      await core.deleteChatProvider(provider.id);
  });
}

test("a reworded column fills alone: its old Answers greyed until the new ones come, and ⌘Z brings them back", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 860);
  await useLocalChatModel(window);
  const table = await filledSuppliersTable(window);
  const before = await answersIn(table);
  expect(before.map((row) => row[1])).toEqual([
    "12 months of fees",
    "twice the annual fees",
    "! not found",
  ]);
  await forgetModels(window);

  const fields = await editColumn(window, headingAt(table, 0));
  await expect(fields.label).toHaveValue("Termination notice");
  await expect(fields.question).toHaveValue("Termination notice");
  // Enter while a Chinese input method composes keeps the field open.
  await fields.question.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        isComposing: true,
      }),
    ),
  );
  await expect(fields.question).toBeVisible();
  await fields.question.fill("Liability cap");
  await window.keyboard.press("Enter");
  await expect(headingAt(table, 0)).toHaveText("Liability cap");

  // No model: the column waits, its old Answers greyed, and nothing else changes.
  await expect(table.getByTestId("comparison-not-ready")).toBeVisible();
  for (const [row, said] of ["90 days", "6 months", "30 days"].entries()) {
    await expect(cellAt(table, row, 0)).toHaveAttribute("data-stale", "true");
    await expect(cellAt(table, row, 0)).toContainText(said);
    await expect(cellAt(table, row, 1)).not.toHaveAttribute("data-stale", "true");
  }
  expect((await answersIn(table)).map((row) => row[1])).toEqual(before.map((row) => row[1]));

  // A model again: Fill writes the cells that wait, and only those.
  await useLocalChatModel(window);
  await pointAndClick(window, table.getByTestId("comparison-fill"));
  await expect
    .poll(async () => (await answersIn(table)).map((row) => row[0]), { timeout: 30_000 })
    .toEqual(["12 months of fees", "twice the annual fees", "! not found"]);
  expect((await answersIn(table)).map((row) => row[1])).toEqual(before.map((row) => row[1]));
  await expect(cellAt(table, 0, 0).locator('.citation-marker[data-check="found"]')).toHaveCount(1);
  await expect(cellAt(table, 0, 0)).not.toHaveAttribute("data-stale", "true");

  // ⌘Z puts the old Question and its Answers back, with no model call: a call would start a
  // Task for the table, and none appears.
  const taskIds = () =>
    window.evaluate(async () =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind
        .listTasks()
        .then((tasks) => tasks.map((task) => `${task.id}:${task.finishedAt === null}`)),
    );
  const tasksBefore = await taskIds();
  await window.getByTestId("mind-editor").first().focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(headingAt(table, 0)).toHaveText("Termination notice");
  await expect
    .poll(async () => (await answersIn(table)).map((row) => row[0]))
    .toEqual(["90 days", "6 months", "30 days"]);
  expect(await taskIds()).toEqual(tasksBefore);
  await expect(table.getByTestId("comparison-progress")).toHaveCount(0);
});

test("a label alone refills nothing; F2 edits in place and Esc cancels; its undo line takes it back", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 860);
  await useLocalChatModel(window);
  const table = await filledSuppliersTable(window);
  const before = await answersIn(table);

  const heading = headingAt(table, 0);
  await heading.focus();
  await window.keyboard.press("F2");
  await expect(window.getByTestId("comparison-edit-label")).toBeFocused();
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("comparison-edit-label")).toHaveCount(0);
  // Esc leaves the heading focused, so F2 or Delete act on the column again at once.
  await expect(heading).toBeFocused();

  // An empty Question is refused, and a save that changes nothing, each leaving the heading focused.
  const empty = await editColumn(window, heading);
  await empty.question.fill("");
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("comparison-edit-question")).toHaveCount(0);
  await expect(heading).toBeFocused();
  await expect(heading).toHaveText("Termination notice");

  await heading.focus();
  await window.keyboard.press("F2");
  await expect(window.getByTestId("comparison-edit-label")).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("comparison-edit-label")).toHaveCount(0);
  await expect(heading).toBeFocused();
  await expect(heading).toHaveText("Termination notice");

  const fields = await editColumn(window, headingAt(table, 0));
  await fields.label.fill("Notice");
  await window.keyboard.press("Enter");
  await expect(headingAt(table, 0)).toHaveText("Notice");
  await expect(window.getByTestId("undo-message")).toContainText("Edited “Notice”");
  expect(await answersIn(table)).toEqual(before);
  await expect(table.getByTestId("comparison-progress")).toHaveCount(0);

  await pointAndClick(window, window.getByTestId("undo-action"));
  await expect(headingAt(table, 0)).toHaveText("Termination notice");
  expect(await answersIn(table)).toEqual(before);
});

test("insert adds a column that fills alone, duplicate copies its Answers, and both undo", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 860);
  await useLocalChatModel(window);
  const table = await filledSuppliersTable(window);
  const before = await answersIn(table);

  const heading = headingAt(table, 0);
  await pointAndClick(window, heading.getByTestId("comparison-column-menu"));
  const menu = heading.locator('[role="menu"]');
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId("comparison.column.insertRight")).toContainText("Insert right");
  // Its items show the heading's own keys, as every menu shows its row's.
  await expect(menu.getByTestId("comparison.column.edit")).toContainText("F2");
  await expect(menu.getByTestId("comparison.column.remove")).toContainText(/Delete|⌦/);
  await pointAndClick(window, menu.getByTestId("comparison.column.insertRight"));
  const field = window.getByTestId("comparison-insert-question");
  await expect(field).toBeFocused();
  await window.keyboard.type("Governing law");
  await window.keyboard.press("Enter");

  await expect(table.getByTestId("comparison-question")).toHaveCount(3);
  await expect(headingAt(table, 1)).toHaveText("Governing law");
  await expect
    .poll(async () => (await answersIn(table)).map((row) => row[1]), { timeout: 30_000 })
    .toEqual(["! not found", "! not found", "New York"]);
  const inserted = await answersIn(table);
  expect(inserted.map((row) => row[0])).toEqual(before.map((row) => row[0]));
  expect(inserted.map((row) => row[2])).toEqual(before.map((row) => row[1]));

  await window.getByTestId("mind-editor").first().focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(table.getByTestId("comparison-question")).toHaveCount(2);
  expect(await answersIn(table)).toEqual(before);

  // A duplicate copies its Answers, so no model is asked for them again.
  await pointAndClick(window, headingAt(table, 0).getByTestId("comparison-column-menu"));
  await pointAndClick(
    window,
    headingAt(table, 0).locator('[role="menu"]').getByTestId("comparison.column.duplicate"),
  );
  await expect(table.getByTestId("comparison-question")).toHaveCount(3);
  await expect(headingAt(table, 1)).toHaveText("Termination notice");
  await expect(window.getByTestId("undo-message")).toContainText("Duplicated “Termination notice”");
  const copied = await answersIn(table);
  expect(copied.map((row) => row[1])).toEqual(before.map((row) => row[0]));
  expect(copied.map((row) => row[2])).toEqual(before.map((row) => row[1]));
  await expect(table.getByTestId("comparison-progress")).toHaveCount(0);

  await window.getByTestId("mind-editor").first().focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(table.getByTestId("comparison-question")).toHaveCount(2);
  expect(await answersIn(table)).toEqual(before);
});

test("a column removed while the table fills takes its waiting cells with it and leaves the rest as they were", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 860);
  await useLocalChatModel(window);
  const table = await filledSuppliersTable(window);
  const before = await answersIn(table);

  // Its three cells are refused once each, so the fill is still going when the column goes.
  await pointAndClick(window, headingAt(table, 0).getByTestId("comparison-column-menu"));
  await pointAndClick(
    window,
    headingAt(table, 0).locator('[role="menu"]').getByTestId("comparison.column.insertRight"),
  );
  const field = window.getByTestId("comparison-insert-question");
  await expect(field).toBeFocused();
  await window.keyboard.type("Governing law (busy)");
  await window.keyboard.press("Enter");
  await expect(table.getByTestId("comparison-progress")).toBeVisible();

  await headingAt(table, 1).focus();
  await window.keyboard.press("Delete");
  await expect(table.getByTestId("comparison-question")).toHaveCount(2);
  await expect(table.getByTestId("comparison-progress")).toHaveCount(0, { timeout: 30_000 });
  expect(await answersIn(table)).toEqual(before);
});

test("remove takes a column whole, its undo line brings back its Citations, and the last column stays", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 860);
  await useLocalChatModel(window);
  const table = await filledSuppliersTable(window);
  const before = await answersIn(table);

  await headingAt(table, 0).focus();
  await window.keyboard.press("Delete");
  await expect(table.getByTestId("comparison-question")).toHaveCount(1);
  await expect(window.getByTestId("undo-message")).toContainText("Removed “Termination notice”");
  await pointAndClick(window, window.getByTestId("undo-action"));
  await expect(table.getByTestId("comparison-question")).toHaveCount(2);
  expect(await answersIn(table)).toEqual(before);
  await expect(cellAt(table, 0, 0).locator('.citation-marker[data-check="found"]')).toHaveCount(1);

  // In Chinese, the heading's right-click menu, in its order.
  await bridge(window).language("zh-CN");
  const heading = headingAt(table, 0);
  await heading.focus();
  await pointAndClick(window, heading, { button: "right" });
  const menu = heading.locator('[role="menu"]');
  await expect(menu).toBeVisible();
  for (const [id, text] of [
    ["comparison.column.edit", "编辑列…"],
    ["comparison.column.insertLeft", "在左侧插入列"],
    ["comparison.column.insertRight", "在右侧插入列"],
    ["comparison.column.duplicate", "复制列"],
    ["comparison.column.remove", "删除列"],
  ] as const) {
    await expect(menu.getByTestId(id)).toContainText(text);
  }
  await pointAndClick(window, menu.getByTestId("comparison.column.remove"));
  await expect(table.getByTestId("comparison-question")).toHaveCount(1);
  await expect(window.getByTestId("undo-message")).toContainText("已删除“Termination notice”");

  // The last column isn't offered for removal, and Delete leaves it.
  const last = headingAt(table, 0);
  await pointAndClick(window, last, { button: "right" });
  await expect(last.locator('[role="menu"]')).toBeVisible();
  await expect(last.locator('[role="menu"]').getByTestId("comparison.column.remove")).toHaveCount(
    0,
  );
  await window.keyboard.press("Escape");
  await expect(last.locator('[role="menu"]')).toBeHidden();
  // In Chinese too, Escape in an open menu closes the menu alone, not the expanded table.
  await pointAndClick(window, table.getByTestId("comparison-expand"));
  await expect(table).toHaveAttribute("data-expanded", "true");
  await pointAndClick(window, last, { button: "right" });
  await expect(last.locator('[role="menu"]')).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(last.locator('[role="menu"]')).toBeHidden();
  await expect(table).toHaveAttribute("data-expanded", "true");
  // Clicking a cell then Escape collapses the table, as the note's editor took the key otherwise.
  await pointAndClick(window, cellAt(table, 0, 0));
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("comparison-cell-card")).toHaveCount(0);
  await window.keyboard.press("Escape");
  await expect(table.locator('[aria-selected="true"]')).toHaveCount(0);
  await window.keyboard.press("Escape");
  await expect(table).not.toHaveAttribute("data-expanded", "true");
  // Settings open over the table takes Escape itself; the table stays expanded.
  await pointAndClick(window, table.getByTestId("comparison-expand"));
  await expect(table).toHaveAttribute("data-expanded", "true");
  await window.keyboard.press("ControlOrMeta+,");
  await expect(window.getByTestId("settings")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("settings")).toBeHidden();
  await expect(table).toHaveAttribute("data-expanded", "true");
  await window.keyboard.press("Escape");
  await expect(table).not.toHaveAttribute("data-expanded", "true");
  await last.focus();
  await window.keyboard.press("Delete");
  await expect(table.getByTestId("comparison-question")).toHaveCount(1);
});

test("a column moves by menu, keys and drag, and hides and shows from the table's ⋯, each undone", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1600, 860);
  await useLocalChatModel(window);
  const table = await filledSuppliersTable(window);
  const before = await answersIn(table);
  const orderOf = () =>
    table
      .getByTestId("comparison-question")
      .evaluateAll((all) => all.map((each) => (each as HTMLElement).innerText.trim()));

  // Its menu, in the shared order; Move left has nowhere to go at the first column.
  const first = headingAt(table, 0);
  await pointAndClick(window, first.getByTestId("comparison-column-menu"));
  const menu = first.locator('[role="menu"]');
  await expect(menu).toBeVisible();
  const items = menu.getByRole("menuitem");
  await expect(items).toHaveCount(8);
  for (const [index, label] of [
    "Edit column…",
    "Insert left",
    "Insert right",
    "Duplicate",
    "Move left",
    "Move right",
    "Hide",
    "Remove column",
  ].entries()) {
    await expect(items.nth(index)).toContainText(label);
  }
  await expect(menu.getByTestId("comparison.column.moveLeft")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await pointAndClick(window, menu.getByTestId("comparison.column.moveRight"));
  await expect(window.getByTestId("undo-message")).toContainText("Moved “Termination notice”");
  await expect.poll(orderOf).toEqual(["Liability cap", "Termination notice"]);
  expect(await visualAnswersIn(table)).toEqual(["12 months of fees", "90 days"]);
  await pointAndClick(window, window.getByTestId("undo-action"));
  await expect.poll(orderOf).toEqual(["Termination notice", "Liability cap"]);
  expect(await answersIn(table)).toEqual(before);

  // The same from the heading's own keys, and from ⌘K.
  await headingAt(table, 0).focus();
  // ⌥⇧→ on macOS, Ctrl+Shift+→ elsewhere, as the heading binds them.
  await window.keyboard.press(`${WORD_KEY}+Shift+ArrowRight`);
  await expect(window.getByTestId("undo-message")).toContainText("Moved “Termination notice”");
  await expect.poll(orderOf).toEqual(["Liability cap", "Termination notice"]);
  expect(await visualAnswersIn(table)).toEqual(["12 months of fees", "90 days"]);
  await window.getByTestId("mind-editor").first().focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect.poll(orderOf).toEqual(["Termination notice", "Liability cap"]);

  await headingAt(table, 0).focus();
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("move right");
  await expect(
    window.getByTestId("palette").locator('[data-key="command:comparison.column.moveRight"]'),
  ).toBeVisible();
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("undo-message")).toContainText("Moved “Termination notice”");
  await expect.poll(orderOf).toEqual(["Liability cap", "Termination notice"]);
  await window.getByTestId("mind-editor").first().focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect.poll(orderOf).toEqual(["Termination notice", "Liability cap"]);

  // Dragged by its heading: a rule shows where it would land, and it lands there.
  const from = await pointAt(window, headingAt(table, 0));
  const to = await headingAt(table, 1).boundingBox();
  if (!to) throw new Error("The second heading isn't on screen.");
  await window.mouse.move(from.x, from.y, { steps: 4 });
  await window.mouse.down();
  await window.mouse.move(to.x + to.width * 0.75, from.y, { steps: 12 });
  await expect(headingAt(table, 1)).toHaveAttribute("data-drop", "after");
  await window.mouse.up();
  await expect(window.getByTestId("undo-message")).toContainText("Moved “Termination notice”");
  await expect.poll(orderOf).toEqual(["Liability cap", "Termination notice"]);
  expect(await visualAnswersIn(table)).toEqual(["12 months of fees", "90 days"]);
  // What the User copies, and what Tab reaches, is the order drawn: the cells' document order.
  const drawnIds = await table
    .getByTestId("comparison-row")
    .first()
    .getByTestId("comparison-cell")
    .evaluateAll((cells) =>
      cells
        .map((cell) => ({
          x: cell.getBoundingClientRect().x,
          id: cell.getAttribute("data-question-id") ?? "",
        }))
        .sort((left, right) => left.x - right.x)
        .map((cell) => cell.id),
    );
  const documentOrder = await table
    .getByTestId("comparison-row")
    .first()
    .getByTestId("comparison-cell")
    .evaluateAll((cells) => cells.map((cell) => cell.getAttribute("data-question-id") ?? ""));
  expect(documentOrder).toEqual(drawnIds);
  await headingAt(table, 0).focus();
  const reached: string[] = [];
  for (let step = 0; step < 8 && reached.length < 2; step++) {
    await window.keyboard.press("Tab");
    const label = await window.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return (
        active
          ?.closest(".comparison-question")
          ?.querySelector(".comparison-question-label")
          ?.textContent?.trim() ?? null
      );
    });
    if (label && !reached.includes(label)) reached.push(label);
  }
  expect(reached).toEqual(["Liability cap", "Termination notice"]);
  await pointAndClick(window, window.getByTestId("undo-action"));
  await expect.poll(orderOf).toEqual(["Termination notice", "Liability cap"]);
  expect(await answersIn(table)).toEqual(before);

  // Hidden from its menu; its Answers stay with the Note, and the table's ⋯ shows it again.
  await headingAt(table, 0).focus();
  await pointAndClick(window, headingAt(table, 0).getByTestId("comparison-column-menu"));
  await pointAndClick(
    window,
    headingAt(table, 0).locator('[role="menu"]').getByTestId("comparison.column.hide"),
  );
  await expect(window.getByTestId("undo-message")).toContainText("Hid “Termination notice”");
  await expect(table.getByTestId("comparison-question")).toHaveCount(1);
  await expect(headingAt(table, 0)).toHaveText("Liability cap");
  await pointAndClick(window, table.getByTestId("comparison-table-menu"));
  const hiddenMenu = window.getByTestId("comparison-table-actions");
  const showFirst = hiddenMenu.locator('[data-testid^="comparison-column-show-"]');
  await expect(showFirst).toHaveCount(1);
  await expect(showFirst.first()).toContainText("Show “Termination notice”");
  await pointAndClick(window, showFirst.first());
  await expect(table.getByTestId("comparison-question")).toHaveCount(2);
  await expect(headingAt(table, 0)).toHaveText("Termination notice");
  await expect(window.getByTestId("undo-message")).toContainText("Showed “Termination notice”");
  expect(await answersIn(table)).toEqual(before);
  await pointAndClick(window, window.getByTestId("undo-action"));
  await expect(table.getByTestId("comparison-question")).toHaveCount(1);
  await window.getByTestId("mind-editor").first().focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(table.getByTestId("comparison-question")).toHaveCount(2);
  expect(await answersIn(table)).toEqual(before);

  // Hide from ⌘K, and show in Chinese from the table's ⋯.
  await headingAt(table, 0).focus();
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("hide column");
  await expect(
    window.getByTestId("palette").locator('[data-key="command:comparison.column.hide"]'),
  ).toBeVisible();
  await window.keyboard.press("Enter");
  await expect(table.getByTestId("comparison-question")).toHaveCount(1);
  await bridge(window).language("zh-CN");
  await pointAndClick(window, table.getByTestId("comparison-table-menu"));
  const zhHidden = window.getByTestId("comparison-table-actions");
  await expect(zhHidden).toContainText("已隐藏的列（1）");
  await expect(zhHidden.locator('[data-testid^="comparison-column-show-"]').first()).toContainText(
    "显示“Termination notice”",
  );
  await window.keyboard.press("Escape");
  await window.getByTestId("mind-editor").first().focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(table.getByTestId("comparison-question")).toHaveCount(2);
  const zhFirst = headingAt(table, 0);
  await pointAndClick(window, zhFirst, { button: "right" });
  const zhMenu = zhFirst.locator('[role="menu"]');
  for (const [index, label] of [
    "编辑列…",
    "在左侧插入列",
    "在右侧插入列",
    "复制列",
    "向左移动",
    "向右移动",
    "隐藏",
    "删除列",
  ].entries()) {
    await expect(zhMenu.getByRole("menuitem").nth(index)).toContainText(label);
  }
  await screenshot(window, "compare-column-menu-zh-1600");
  await window.keyboard.press("Escape");
  await bridge(window).language("en");

  // Show from ⌘K: the command opens the table's ⋯ picker, and the column comes back.
  await headingAt(table, 0).focus();
  await pointAndClick(window, headingAt(table, 0).getByTestId("comparison-column-menu"));
  await pointAndClick(
    window,
    headingAt(table, 0).locator('[role="menu"]').getByTestId("comparison.column.hide"),
  );
  await expect(table.getByTestId("comparison-question")).toHaveCount(1);
  await headingAt(table, 0).focus();
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("show hidden");
  await expect(
    window.getByTestId("palette").locator('[data-key="command:comparison.column.showHidden"]'),
  ).toBeVisible();
  await window.keyboard.press("Enter");
  const showMenu = window.getByTestId("comparison-table-actions");
  await expect(showMenu).toBeVisible();
  await pointAndClick(window, showMenu.locator('[data-testid^="comparison-column-show-"]').first());
  await expect(table.getByTestId("comparison-question")).toHaveCount(2);
  await expect(window.getByTestId("undo-message")).toContainText("Showed “Termination notice”");

  // With nothing hidden, ⌘K doesn't offer Show at all.
  await headingAt(table, 0).focus();
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("show hidden");
  await expect(
    window.getByTestId("palette").locator('[data-key="command:comparison.column.showHidden"]'),
  ).toHaveCount(0);
  await window.keyboard.press("Escape");
});

for (const language of ["en", "zh-CN"] as const) {
  test(`a column change and a move, each taken back through the core (${language})`, async () => {
    test.setTimeout(240_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1600, 860);
    await useLocalChatModel(window);
    const table = await filledSuppliersTable(window);
    // A third column, so a remove and a move both have somewhere to land.
    await pointAndClick(window, table.getByTestId("comparison-add-question").first());
    await window.keyboard.type("Governing law");
    await window.keyboard.press("Enter");
    await expect(table.getByTestId("comparison-question")).toHaveCount(3, { timeout: 30_000 });
    await expect(table.getByTestId("comparison-progress")).toHaveCount(0, { timeout: 30_000 });
    await table
      .getByTestId("comparison-accept-all")
      .click({ trial: true })
      .catch(() => undefined);

    const state = async () => {
      const headings = await table.getByTestId("comparison-question").evaluateAll((all) =>
        all
          .map((each) => ({
            x: each.getBoundingClientRect().x,
            text: (each as HTMLElement).innerText.trim(),
          }))
          .sort((left, right) => left.x - right.x)
          .map((each) => each.text),
      );
      const rows = await table.getByTestId("comparison-row").count();
      const answers: string[][] = [];
      for (let row = 0; row < rows; row++) answers.push(await visualAnswersIn(table, row));
      return { headings, answers };
    };
    const undo = async () => {
      await window.getByTestId("mind-editor").first().focus();
      await window.keyboard.press("ControlOrMeta+z");
    };
    const menu = async (column: number, item: string) => {
      if ((await window.getByTestId("citation-card").count()) > 0) {
        await window.keyboard.press("Escape");
        await expect(window.getByTestId("citation-card")).toHaveCount(0);
      }
      const heading = headingAt(table, column);
      await heading.focus();
      // A heading is redrawn, and the table can scroll to it, after a move: a click aimed at its
      // box a moment earlier can land in a cell instead, whose Citation card then covers the
      // heading. A click that waits for the button to keep its box and take the pointer lands on
      // the button; the menu is then open before the item is clicked.
      await heading.getByTestId("comparison-column-menu").click();
      const opened = heading.locator('[role="menu"]');
      await expect(opened).toBeVisible();
      await opened.getByTestId(item).click();
    };
    const base = await state();

    // Hide, then move: ⌘Z twice shows the column again and puts the order back.
    await menu(0, "comparison.column.hide");
    await expect(table.getByTestId("comparison-question")).toHaveCount(2);
    await menu(0, "comparison.column.moveRight");
    await undo();
    await undo();
    await expect.poll(state).toEqual(base);

    // Remove, then move: ⌘Z twice puts the column and its cells back whole.
    await menu(0, "comparison.column.remove");
    await expect(table.getByTestId("comparison-question")).toHaveCount(2);
    await menu(0, "comparison.column.moveRight");
    await undo();
    await undo();
    await expect.poll(state).toEqual(base);

    // Reword, then move: ⌘Z twice brings the old Question and its Answers back.
    const fields = await editColumn(window, headingAt(table, 0));
    await fields.question.fill("Ending the agreement");
    await window.keyboard.press("Enter");
    await expect(headingAt(table, 0)).toHaveText("Ending the agreement");
    await expect(table.getByTestId("comparison-progress")).toHaveCount(0, { timeout: 30_000 });
    await menu(0, "comparison.column.moveRight");
    await undo();
    await undo();
    await expect.poll(state).toEqual(base);

    // Insert, then move: the first Undo takes back the move, the second the column.
    await menu(0, "comparison.column.insertLeft");
    await window.keyboard.type("Extra term");
    await window.keyboard.press("Enter");
    await expect(table.getByTestId("comparison-question")).toHaveCount(4, { timeout: 30_000 });
    await expect(table.getByTestId("comparison-progress")).toHaveCount(0, { timeout: 30_000 });
    await menu(0, "comparison.column.moveRight");
    await undo();
    await expect(table.getByTestId("comparison-question")).toHaveCount(4);
    await undo();
    await expect.poll(state).toEqual(base);

    // Duplicate, then move: both taken back.
    await menu(0, "comparison.column.duplicate");
    await expect(table.getByTestId("comparison-question")).toHaveCount(4, { timeout: 30_000 });
    await menu(1, "comparison.column.moveRight");
    await undo();
    await undo();
    await expect.poll(state).toEqual(base);

    // Resize, then move: the first Undo takes back the move, the second the width.
    const widthBefore = (await headingAt(table, 0).boundingBox())?.width ?? 0;
    await pointAt(window, headingAt(table, 0).getByTestId("comparison-column-resize"));
    await headingAt(table, 0).getByTestId("comparison-column-resize").dblclick();
    await expect(window.getByTestId("undo-message")).toContainText(
      language === "en" ? "Resized" : "已调整",
    );
    await expect
      .poll(async () => (await headingAt(table, 0).boundingBox())?.width ?? 0)
      .not.toBe(widthBefore);
    await menu(0, "comparison.column.moveRight");
    await undo();
    await undo();
    await expect.poll(state).toEqual(base);

    // Move, then hide: ⌘Z shows the column, ⌘Z again moves it back.
    await menu(0, "comparison.column.moveRight");
    // The core writes the move, and the headings are redrawn in its order: wait for the drawn
    // order by name, or a redraw between the menu's own two clicks leaves the second place on a
    // heading whose menu is not the one opened.
    await expect
      .poll(async () => (await state()).headings)
      .toEqual(["Liability cap", "Termination notice", "Governing law"]);
    await menu(1, "comparison.column.hide");
    // Which column the hide took, not just how many are left.
    await expect
      .poll(async () => (await state()).headings)
      .toEqual(["Liability cap", "Governing law"]);
    await undo();
    await expect
      .poll(async () => (await state()).headings)
      .toEqual(["Liability cap", "Termination notice", "Governing law"]);
    await undo();
    await expect.poll(state).toEqual(base);
  });
}

test("⌘K shows hidden columns even when every column is hidden, in English and Chinese", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1600, 860);
  await useLocalChatModel(window);
  const table = await filledSuppliersTable(window);
  for (const column of [1, 0]) {
    await headingAt(table, column).focus();
    await pointAndClick(window, headingAt(table, column).getByTestId("comparison-column-menu"));
    await pointAndClick(
      window,
      headingAt(table, column).locator('[role="menu"]').getByTestId("comparison.column.hide"),
    );
    await expect(table.getByTestId("comparison-question")).toHaveCount(column);
  }
  await expect(table.getByTestId("comparison-question")).toHaveCount(0);

  for (const language of ["en", "zh-CN"] as const) {
    await setLanguage(window, language);
    await window.getByTestId("mind-editor").first().focus();
    await window.keyboard.press("ControlOrMeta+k");
    await window.keyboard.type(language === "en" ? "show hidden" : "显示隐藏的列");
    await expect(
      window.getByTestId("palette").locator('[data-key="command:comparison.column.showHidden"]'),
    ).toBeVisible();
    await window.keyboard.press("Escape");
  }

  // The picker shows one column at a time; both come back.
  for (const count of [1, 2]) {
    await pointAndClick(window, table.getByTestId("comparison-table-menu"));
    await pointAndClick(
      window,
      window
        .getByTestId("comparison-table-actions")
        .locator('[data-testid^="comparison-column-show-"]')
        .first(),
    );
    await expect(table.getByTestId("comparison-question")).toHaveCount(count);
  }
});

test("Show steps through the table's cells that need a look in the order the columns are drawn, after a move", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1600, 860);
  await useLocalChatModel(window);
  const table = await filledClaimsTable(window);
  const drawnQuestions = () =>
    table.getByTestId("comparison-question").evaluateAll((all) =>
      all
        .map((each) => ({
          x: each.getBoundingClientRect().x,
          id: (each as HTMLElement).dataset.questionId ?? "",
        }))
        .sort((left, right) => left.x - right.x)
        .map((each) => each.id),
    );
  const caretQuestion = () =>
    window
      .getByTestId("mind-editor")
      .first()
      .evaluate((dom) => {
        const editor = (dom as unknown as { editor: Editor }).editor;
        const { $from } = editor.state.selection;
        for (let depth = $from.depth; depth > 0; depth--) {
          const node = $from.node(depth);
          if (node.type.name === "comparisonCell") return String(node.attrs.questionId ?? "");
        }
        return "";
      });
  const startAtTop = () =>
    window
      .getByTestId("mind-editor")
      .first()
      .evaluate((dom) => {
        (dom as unknown as { editor: Editor }).editor.commands.focus("start");
      });
  const showNext = async () => {
    await pointAndClick(window, (await checkCard(window)).getByTestId("health-toCheck"));
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("check-card")).toHaveCount(0);
  };
  // The first row's two cells are the first two cells that need a look, drawn left to right.
  const cellsShown = async () => {
    await startAtTop();
    const shown: string[] = [];
    for (let step = 0; step < 8 && shown.length < 2; step++) {
      await showNext();
      const questionId = await caretQuestion();
      if (questionId && !shown.includes(questionId)) shown.push(questionId);
    }
    return shown;
  };
  expect(await cellsShown()).toEqual(await drawnQuestions());

  // Move the first column right: Show now steps the other column first, as it is drawn.
  await headingAt(table, 0).focus();
  await pointAndClick(window, headingAt(table, 0).getByTestId("comparison-column-menu"));
  await pointAndClick(
    window,
    headingAt(table, 0).locator('[role="menu"]').getByTestId("comparison.column.moveRight"),
  );
  await expect(window.getByTestId("undo-message")).toContainText("Moved “Termination notice”");
  await expect
    .poll(() => table.getByTestId("comparison-question").first().innerText())
    .toBe("Liability cap");
  expect(await cellsShown()).toEqual(await drawnQuestions());
});

for (const [language, words] of [
  ["en", "terms amended"],
  ["zh-CN", "条款已修订"],
] as const) {
  test(`words typed in the note just before a column move are kept, through Undo and Redo (${language})`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1600, 860);
    await useLocalChatModel(window);
    const table = await filledSuppliersTable(window);
    const editor = window.getByTestId("mind-editor").first();
    await editor.focus();
    await window.keyboard.press("ControlOrMeta+Home");
    await window.keyboard.type(words);
    // Move at once, before the words have had time to be stored.
    await headingAt(table, 0).focus();
    await window.keyboard.press(`${WORD_KEY}+Shift+ArrowRight`);
    await expect(window.getByTestId("undo-message")).toContainText(
      language === "en" ? "Moved “Termination notice”" : "已移动“Termination notice”列",
    );
    await expect(editor).toContainText(words);
    await editor.focus();
    await window.keyboard.press("ControlOrMeta+z");
    await expect(editor).toContainText(words);
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect(editor).toContainText(words);
  });
}

test("a hidden column is out of Fill's count until it is shown, in English and Chinese", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1600, 860);
  await useLocalChatModel(window);
  const table = await filledSuppliersTable(window);
  // No model, so a new column's cells wait instead of filling.
  await forgetModels(window);
  await headingAt(table, 0).focus();
  await pointAndClick(window, headingAt(table, 0).getByTestId("comparison-column-menu"));
  await pointAndClick(
    window,
    headingAt(table, 0).locator('[role="menu"]').getByTestId("comparison.column.insertRight"),
  );
  await window.keyboard.type("Governing law");
  await window.keyboard.press("Enter");
  await expect(table.getByTestId("comparison-question")).toHaveCount(3);
  await expect(table.getByTestId("comparison-fill")).toHaveText("Fill 3 cells");

  // Hidden, its waiting cells leave Fill's count.
  await headingAt(table, 1).focus();
  await pointAndClick(window, headingAt(table, 1).getByTestId("comparison-column-menu"));
  await pointAndClick(
    window,
    headingAt(table, 1).locator('[role="menu"]').getByTestId("comparison.column.hide"),
  );
  await expect(table.getByTestId("comparison-question")).toHaveCount(2);
  await expect(table.getByTestId("comparison-fill")).toHaveCount(0);

  // Shown, Fill offers them again.
  await pointAndClick(window, table.getByTestId("comparison-table-menu"));
  await pointAndClick(
    window,
    window
      .getByTestId("comparison-table-actions")
      .locator('[data-testid^="comparison-column-show-"]')
      .first(),
  );
  await expect(table.getByTestId("comparison-question")).toHaveCount(3);
  await expect(table.getByTestId("comparison-fill")).toHaveText("Fill 3 cells");

  // The same in Chinese.
  await bridge(window).language("zh-CN");
  await headingAt(table, 1).focus();
  await pointAndClick(window, headingAt(table, 1).getByTestId("comparison-column-menu"));
  await pointAndClick(
    window,
    headingAt(table, 1).locator('[role="menu"]').getByTestId("comparison.column.hide"),
  );
  await expect(table.getByTestId("comparison-fill")).toHaveCount(0);
  await pointAndClick(window, table.getByTestId("comparison-table-menu"));
  await pointAndClick(
    window,
    window
      .getByTestId("comparison-table-actions")
      .locator('[data-testid^="comparison-column-show-"]')
      .first(),
  );
  await expect(table.getByTestId("comparison-fill")).toHaveText("补全 3 个单元格");
  await bridge(window).language("en");
});

test("a column's edge resizes it and the width and a hidden column stay with the Note and in the export", async () => {
  test.setTimeout(240_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1600, 860);
  await useLocalChatModel(window);
  await useOutputLocation(window, sources);
  const table = await filledSuppliersTable(window);
  const first = headingAt(table, 0);
  const second = headingAt(table, 1);
  const widthOf = async (heading: Locator) => (await heading.boundingBox())?.width ?? 0;
  const auto = await widthOf(first);
  const handle = first.getByTestId("comparison-column-resize");

  // Drag its edge: wider at once, one change with its undo line.
  const start = await pointAt(window, handle);
  await window.mouse.down();
  await window.mouse.move(start.x + 90, start.y, { steps: 12 });
  await window.mouse.up();
  await expect(window.getByTestId("undo-message")).toContainText("Resized “Termination notice”");
  const wider = await widthOf(first);
  expect(wider).toBeGreaterThan(auto + 40);
  await pointAndClick(window, window.getByTestId("undo-action"));
  await expect.poll(() => widthOf(first)).toBeLessThan(wider - 40);

  // Double-click the edge fits the column to what it holds.
  await pointAt(window, handle);
  await handle.dblclick();
  await expect(window.getByTestId("undo-message")).toContainText("Resized “Termination notice”");
  await expect.poll(() => widthOf(first)).toBeLessThan(auto - 40);
  await pointAndClick(window, window.getByTestId("undo-action"));
  await expect.poll(async () => Math.round(await widthOf(first))).toBe(Math.round(auto));

  // The grip's own keys, and ⌘K fits it too.
  await handle.focus();
  await window.keyboard.press("ArrowRight");
  await expect(window.getByTestId("undo-message")).toContainText("Resized “Termination notice”");
  await expect.poll(() => widthOf(first)).toBeGreaterThan(auto + 8);
  await window.keyboard.press("ArrowLeft");
  await expect.poll(async () => Math.round(await widthOf(first))).toBe(Math.round(auto));
  await first.focus();
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("fit column");
  await expect(
    window.getByTestId("palette").locator('[data-key="command:comparison.column.fit"]'),
  ).toBeVisible();
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("undo-message")).toContainText("Resized “Termination notice”");
  await expect.poll(() => widthOf(first)).toBeLessThan(auto - 40);
  await window.getByTestId("mind-editor").first().focus();
  await window.keyboard.press("ControlOrMeta+z");

  // A width set by hand on the second column, and the first hidden.
  const secondHandle = second.getByTestId("comparison-column-resize");
  const at = await pointAt(window, secondHandle);
  await window.mouse.down();
  await window.mouse.move(at.x + 120, at.y, { steps: 12 });
  await window.mouse.up();
  const secondWidth = await widthOf(second);
  expect(secondWidth).toBeGreaterThan(auto + 60);
  await first.focus();
  await pointAndClick(window, first.getByTestId("comparison-column-menu"));
  await pointAndClick(window, first.locator('[role="menu"]').getByTestId("comparison.column.hide"));
  await expect(table.getByTestId("comparison-question")).toHaveCount(1);
  await expect(table.getByTestId("comparison-table-menu")).toBeVisible();

  // Kept with the Note: after a reload the column is still sized and the other still hidden.
  await window.reload();
  await expect(window.getByTestId("comparison-table")).toBeVisible({ timeout: 20_000 });
  const reloaded = window.getByTestId("comparison-table");
  await expect(reloaded.getByTestId("comparison-question")).toHaveCount(1);
  await expect(headingAt(reloaded, 0)).toHaveText("Liability cap");
  await expect
    .poll(async () => Math.round(await widthOf(headingAt(reloaded, 0))))
    .toBe(Math.round(secondWidth));
  await expect(reloaded.getByTestId("comparison-table-menu")).toBeVisible();

  // The sheet leaves the hidden column out with no line, keeps the width, and the app says the count.
  // Export options says it before the file is written.
  let lastName = "";
  const exported = async () => {
    await pointAndClick(window, reloaded.getByTestId("comparison-export-excel"));
    const result = window.getByTestId("export-result");
    await expect(result).toHaveAttribute("data-state", "saved", { timeout: 20_000 });
    // The line can still show the file saved a moment ago: wait for this export's own name.
    await expect
      .poll(async () => /“([^”]+\.xlsx)”/.exec(await result.innerText())?.[1] ?? "")
      .not.toBe(lastName);
    const name = /“([^”]+\.xlsx)”/.exec(await result.innerText())?.[1];
    if (!name) throw new Error(`No file name in “${await result.innerText()}”.`);
    lastName = name;
    const written = new Uint8Array(await readFile(join(sources, name)));
    return (await readWorkbook(written, undefined, {})).sheets[0];
  };
  await window.getByTestId("mind-editor").first().focus();
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("Export options");
  await expect(
    window.getByTestId("palette").locator('[data-key="command:mind.exportOptions"]'),
  ).toBeVisible();
  await window.keyboard.press("Enter");
  const dialog = window.getByTestId("export-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("export-hidden-columns")).toHaveText("Left out 1 hidden column");
  await pointAndClick(window, dialog.getByTestId("export-options-close"));
  await expect(dialog).toBeHidden();

  await pointAndClick(window, reloaded.getByTestId("comparison-expand"));
  const sheet = await exported();
  const atCell = (row: number, column: number) =>
    sheet?.cells.find((cell) => cell.row === row && cell.column === column)?.value;
  expect(atCell(1, 1)).toBe("Liability cap");
  expect(atCell(1, 2)).toBeUndefined();
  // No line about the hidden column in the file at all.
  expect(atCell(5, 0)).toBeUndefined();
  await expect(window.getByTestId("export-result")).toContainText("Left out 1 hidden column");
  const columnWidth = (column: number) =>
    sheet?.layout?.columns.get(column)?.width ?? sheet?.layout?.defaultColumnWidth ?? 0;
  expect(columnWidth(1)).toBeGreaterThan(columnWidth(0));

  // In Chinese the app says it in Chinese, and the ⋯ says what it holds.
  await bridge(window).language("zh-CN");
  const zhSheet = await exported();
  expect(zhSheet?.cells.find((cell) => cell.row === 5 && cell.column === 0)?.value).toBeUndefined();
  await expect(window.getByTestId("export-result")).toContainText("已排除 1 个隐藏列");
  await window.getByTestId("mind-editor").first().focus();
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("Export options");
  await expect(
    window.getByTestId("palette").locator('[data-key="command:mind.exportOptions"]'),
  ).toBeVisible();
  await window.keyboard.press("Enter");
  await expect(dialog.getByTestId("export-hidden-columns")).toHaveText("已排除 1 个隐藏列");
  await pointAndClick(window, dialog.getByTestId("export-options-close"));
  await expect(dialog).toBeHidden();
  await pointAndClick(window, reloaded.getByTestId("comparison-table-menu"));
  await expect(window.getByTestId("comparison-table-actions")).toContainText("已隐藏的列（1）");
  await expect(
    window
      .getByTestId("comparison-table-actions")
      .locator('[data-testid^="comparison-column-show-"]')
      .first(),
  ).toContainText("显示“Termination notice”");
  await window.keyboard.press("Escape");

  // Narrow, the title line and the hidden columns' menu stay inside the card.
  await setWindowSize(app, window, 900, 860);
  const scroller = window.locator(".mind-scroller").first();
  const [menuBox, frame] = [
    await reloaded.getByTestId("comparison-table-menu").boundingBox(),
    await scroller.boundingBox(),
  ];
  if (!menuBox || !frame) throw new Error("The menu or the card isn't on screen.");
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(frame.x + frame.width + 1);
  await screenshot(window, "compare-column-width-hidden-zh-900");
  await window.keyboard.press("Escape");
  await bridge(window).language("en");
});

test("fitting a column measures what the table shows, not a hidden column's cells", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1600, 860);
  await useLocalChatModel(window);
  const table = await filledSuppliersTable(window);
  // A short heading, so the cells decide the fitted width.
  const fields = await editColumn(window, headingAt(table, 1));
  await fields.label.fill("Cap");
  await window.keyboard.press("Enter");
  await expect(headingAt(table, 1)).toHaveText("Cap");

  const widthOf = async (heading: Locator) => (await heading.boundingBox())?.width ?? 0;
  const fitColumn = async (heading: Locator) => {
    await pointAt(window, heading.getByTestId("comparison-column-resize"));
    await heading.getByTestId("comparison-column-resize").dblclick();
    await expect(window.getByTestId("undo-message")).toContainText("Resized “Cap”");
  };
  await fitColumn(headingAt(table, 1));
  const shown = await widthOf(headingAt(table, 1));
  await pointAndClick(window, window.getByTestId("undo-action"));

  // Hidden before it, the column fits to its own Answers still.
  await headingAt(table, 0).focus();
  await pointAndClick(window, headingAt(table, 0).getByTestId("comparison-column-menu"));
  await pointAndClick(
    window,
    headingAt(table, 0).locator('[role="menu"]').getByTestId("comparison.column.hide"),
  );
  await expect(table.getByTestId("comparison-question")).toHaveCount(1);
  await fitColumn(headingAt(table, 0));
  expect(Math.abs((await widthOf(headingAt(table, 0))) - shown)).toBeLessThanOrEqual(2);
});

test("⌘K edits a column by keyboard, and the Excel export follows the label", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 860);
  await useLocalChatModel(window);
  await useOutputLocation(window, sources);
  const table = await filledSuppliersTable(window);

  await headingAt(table, 0).focus();
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("edit column");
  const item = window.getByTestId("palette").locator('[data-key="command:comparison.column.edit"]');
  await expect(item).toBeVisible();
  await pointAndClick(window, item);
  const label = window.getByTestId("comparison-edit-label");
  await expect(label).toBeFocused();
  await label.fill("Notice");
  await window.keyboard.press("Enter");
  await expect(headingAt(table, 0)).toHaveText("Notice");

  await pointAndClick(window, table.getByTestId("comparison-expand"));
  // The heading's menu works in the expanded table too, and Escape closes the menu
  // alone: the table stays expanded.
  const expandedMenu = headingAt(table, 0).locator('[role="menu"]');
  await pointAndClick(window, headingAt(table, 0).getByTestId("comparison-column-menu"));
  await expect(expandedMenu.getByTestId("comparison.column.edit")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(expandedMenu).toBeHidden();
  await expect(table).toHaveAttribute("data-expanded", "true");
  // A field there closes on Escape too, leaving the table expanded.
  await headingAt(table, 0).focus();
  await window.keyboard.press("F2");
  await expect(window.getByTestId("comparison-edit-label")).toBeFocused();
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("comparison-edit-label")).toHaveCount(0);
  await expect(headingAt(table, 0)).toBeFocused();
  await expect(table).toHaveAttribute("data-expanded", "true");
  // Settings open over the table takes Escape itself, leaving the table expanded.
  await window.keyboard.press("ControlOrMeta+,");
  await expect(window.getByTestId("settings")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("settings")).toBeHidden();
  await expect(table).toHaveAttribute("data-expanded", "true");
  await pointAndClick(window, table.getByTestId("comparison-export-excel"));
  const result = window.getByTestId("export-result");
  await expect(result).toHaveAttribute("data-state", "saved", { timeout: 20_000 });
  const name = /“([^”]+\.xlsx)”/.exec(await result.innerText())?.[1];
  if (!name) throw new Error(`No file name in “${await result.innerText()}”.`);
  const written = new Uint8Array(await readFile(join(sources, name)));
  const { sheets } = await readWorkbook(written, undefined, {});
  const header = (column: number) =>
    sheets[0]?.cells.find((cell) => cell.row === 1 && cell.column === column)?.value;
  expect(header(0)).toBe("Document");
  expect(header(1)).toBe("Notice");
  expect(header(2)).toBe("Liability cap");

  // A click on a cell puts the focus in the note; Escape still collapses the table.
  await pointAndClick(window, cellAt(table, 0, 0));
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("comparison-cell-card")).toHaveCount(0);
  await window.keyboard.press("Escape");
  await expect(table.locator('[aria-selected="true"]')).toHaveCount(0);
  await window.keyboard.press("Escape");
  await expect(table).not.toHaveAttribute("data-expanded", "true");
});

test("the sheet's foot keeps the model's whole name and every part inside the sheet (#763)", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await dismissChatSetup(window);
    await bridge(window).language("zh-CN");
    await setWindowSize(app, window, 900, 860);
    await acceptPlainTextKeys(window);
    await bridge(window).cloudModel();
    await addSuppliers(window);
    const sheet = await openSheetFromSlash(window);
    await typeQuestions(window, ["Termination notice"]);
    const model = sheet.getByTestId("composer-model");
    await expect(model).toBeVisible();
    // The name is whole: never cut to a letter, whatever room the foot has.
    const name = model.locator("span").first();
    expect(await name.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    // And no part of the foot runs past the sheet's edge: Make moves down rather than out.
    const foot = sheet.locator(".compare-sheet-foot");
    const [footBox, makeBox, sheetBox] = await Promise.all([
      foot.boundingBox(),
      sheet.getByTestId("compare-sheet-make").boundingBox(),
      sheet.boundingBox(),
    ]);
    expect(
      footBox && sheetBox && footBox.x + footBox.width <= sheetBox.x + sheetBox.width + 1,
    ).toBe(true);
    expect(
      makeBox && sheetBox && makeBox.x + makeBox.width <= sheetBox.x + sheetBox.width + 1,
    ).toBe(true);
    if (SCREENSHOTS) {
      await screenshot(window, "compare-footer-zh-900");
      await foot.screenshot({ path: join(SCREENSHOTS, "compare-footer-only-zh-900.png") });
    }
  } finally {
    await app.close();
  }
});

test("two windows on one Note: the second sees a move, its Undo takes nothing of the first's, and closing it leaves no window to wait for", async () => {
  test.setTimeout(240_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1600, 860);
  await useLocalChatModel(window);
  const table = await filledSuppliersTable(window);

  // A second window of the app, with its own session and the same data: the tab it opens is the Mind.
  const info = await app.evaluate(({ app, BrowserWindow }) => {
    const [first] = BrowserWindow.getAllWindows();
    if (!first) throw new Error("The app has no window.");
    return {
      url: first.webContents.getURL(),
      preload: `${app.getAppPath()}/out/preload/index.js`,
    };
  });
  const spawned = app.waitForEvent("window");
  await app.evaluate(({ BrowserWindow }, values) => {
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      show: true,
      webPreferences: {
        preload: values.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    void win.loadURL(values.url);
  }, info);
  const second = await spawned;
  await second.waitForLoadState("domcontentloaded");
  await second
    .getByTestId("tab-strip")
    .getByRole("tab", { name: /Shortlist: contract terms/u })
    .click();
  const secondTable = second.getByTestId("comparison-table");
  await expect(secondTable).toBeVisible({ timeout: 20_000 });
  await expect(secondTable.getByTestId("comparison-question")).toHaveCount(2);

  const headings = (target: Locator) =>
    target.getByTestId("comparison-question").evaluateAll((all) =>
      all
        .map((each) => ({
          x: (each as HTMLElement).getBoundingClientRect().x,
          text: (each as HTMLElement).innerText.trim(),
        }))
        .sort((left, right) => left.x - right.x)
        .map((each) => each.text),
    );
  expect(await headings(secondTable)).toEqual(["Termination notice", "Liability cap"]);

  // A moves a column: the second window sees the order the core wrote.
  await headingAt(table, 0).focus();
  await pointAndClick(window, headingAt(table, 0).getByTestId("comparison-column-menu"));
  await pointAndClick(
    window,
    headingAt(table, 0).locator('[role="menu"]').getByTestId("comparison.column.moveRight"),
  );
  await expect(window.getByTestId("undo-message")).toContainText("Moved “Termination notice”");
  await expect.poll(() => headings(secondTable)).toEqual(["Liability cap", "Termination notice"]);

  // The second window's Undo has no step of the first's: it takes nothing back.
  await second.getByTestId("mind-editor").first().focus();
  await second.keyboard.press("ControlOrMeta+z");
  await second.waitForTimeout(300);
  expect(await headings(secondTable)).toEqual(["Liability cap", "Termination notice"]);

  // The first window's Undo takes its own move back, and the second sees that too.
  await window.getByTestId("mind-editor").first().focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => headings(secondTable)).toEqual(["Termination notice", "Liability cap"]);

  // Closing the second window leaves no watcher behind: the next change doesn't wait for it.
  await second.close();
  await expect.poll(() => app.windows().length, { timeout: 20_000 }).toBe(1);
  await headingAt(table, 0).focus();
  await pointAndClick(window, headingAt(table, 0).getByTestId("comparison-column-menu"));
  await pointAndClick(
    window,
    headingAt(table, 0).locator('[role="menu"]').getByTestId("comparison.column.moveRight"),
  );
  await expect(window.getByTestId("undo-message")).toContainText("Moved “Termination notice”");
  await expect
    .poll(() => headings(window.getByTestId("comparison-table")))
    .toEqual(["Liability cap", "Termination notice"]);
  const log = await readFile(join(dataDir, "logs", "incarnamind.log"), "utf8");
  expect(log).not.toContain("did not answer");
});

/** The names of a table's rows, in the order it draws them. */
const rowNames = (table: Locator) =>
  table
    .locator(".comparison-document-name")
    .evaluateAll((names) => names.map((name) => (name.textContent ?? "").trim()));

/** The rows the table shows, when a count is clicked. */
const shownRows = (table: Locator) => table.locator('[data-testid="comparison-row"]:visible');

test("a table gains Documents later: the picker ticks its own, its line counts only the new cells, and ⌘Z takes the rows out", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 860);
  await acceptPlainTextKeys(window);
  await bridge(window).cloudModel();
  await bridge(window).cap();
  // Five Documents at once: the three the table is made from, and two it gains later.
  const paths: string[] = [];
  for (const [name, text] of Object.entries(SUPPLIERS)) {
    const path = join(sources, name);
    await writeFile(path, text);
    paths.push(path);
  }
  for (const [name, text] of [
    ["Aldermoor Term Sheet.txt", "Aldermoor Term Sheet.\nTermination notice: 45 days.\n"],
    ["Brackwater Term Sheet.txt", "Brackwater Term Sheet.\nTermination notice: 15 days.\n"],
  ] as const) {
    const path = join(sources, name);
    await writeFile(path, text);
    paths.push(path);
  }
  await addDocuments(window, paths);

  const sheet = await openSheetFromSlash(window);
  await expect(sheet.getByTestId("compare-sheet-document")).toHaveCount(5);
  await typeQuestions(window, ["Termination notice"]);
  for (const name of ["Aldermoor Term Sheet", "Brackwater Term Sheet"]) {
    await pointAndClick(window, sheet.locator("label", { hasText: name }).locator("input"));
  }
  await expect(sheet.getByTestId("compare-sheet-counted")).toHaveText("3 of 5");
  await pointAndClick(window, sheet.getByTestId("compare-sheet-make"));
  const table = window.getByTestId("comparison-table");
  await fillSettled(table, 3);
  await pointAndClick(window, table.getByTestId("comparison-accept-all"));
  await expect(table).not.toHaveAttribute("data-pending", "true");
  // ⌘K reaches Add Documents from the table's title line.
  await table.getByTestId("comparison-head").focus();
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("Add Documents");
  await expect(
    window.getByTestId("palette").locator('[data-key="command:comparison.table.addDocuments"]'),
  ).toBeVisible();
  await window.keyboard.press("Escape");
  // Every cell answered: nothing to look at, so no counts.
  await expect
    .poll(async () => (await cellTexts(table)).flat().some((text) => text.includes("Reading…")))
    .toBe(false);
  await expect(table.getByTestId("comparison-count-nothing")).toHaveCount(0);
  await expect(table.getByTestId("comparison-count-failed")).toHaveCount(0);
  const before = await cellTexts(table);

  await pointAndClick(window, table.getByTestId("comparison-table-menu"));
  await pointAndClick(
    window,
    window.getByTestId("comparison-table-actions").getByTestId("comparison.table.addDocuments"),
  );
  const picker = window.getByTestId("comparison-add-documents");
  await expect(picker).toBeVisible();
  // The table's own Documents are ticked and greyed.
  await expect(picker.locator('input[data-testid="comparison-add-document"]')).toHaveCount(5);
  await expect(picker.locator('input[data-testid="comparison-add-document"]:checked')).toHaveCount(
    3,
  );
  await expect(picker.locator('input[data-testid="comparison-add-document"]:disabled')).toHaveCount(
    3,
  );
  await pointAndClick(window, picker.locator("label", { hasText: "Aldermoor" }).locator("input"));
  await pointAndClick(window, picker.locator("label", { hasText: "Brackwater" }).locator("input"));
  await expect(picker.getByTestId("comparison-add-estimate")).toHaveText(
    /^2 cells to fill · About \$[\d.,]+ · [\d.,]+[KMB]? tokens/,
  );
  await expect(picker.getByTestId("comparison-add-confirm")).toHaveText("Add 2 Documents");
  await screenshot(window, "compare-add-documents-en-1440");
  // Narrow, the picker stays inside the window.
  await setWindowSize(app, window, 900, 860);
  await motionSettled(window);
  const pickerBox = await picker.boundingBox();
  const width = await window.evaluate(() => globalThis.innerWidth);
  if (!pickerBox) throw new Error("The picker isn't on screen.");
  expect(pickerBox.x).toBeGreaterThanOrEqual(0);
  expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(width + 1);
  await screenshot(window, "compare-add-documents-en-900");
  await setWindowSize(app, window, 1440, 860);
  await pointAndClick(window, picker.getByTestId("comparison-add-confirm"));

  await expect(window.getByTestId("undo-message")).toContainText("Added 2 Documents");
  await expect(table.getByTestId("comparison-row")).toHaveCount(5);
  // The fill starts after the rows are added, so wait for its Answers rather than for a
  // progress line that is still absent the moment before it starts.
  const addedAnswers = async () =>
    (await cellTexts(table)).slice(3).map((cells) => cells[0]?.replace(/(\s+\d+)+\s*$/, ""));
  await expect.poll(addedAnswers, { timeout: 30_000 }).toEqual(["45 days", "15 days"]);
  // Only the new rows were asked: the Answers already there are as they were.
  expect((await cellTexts(table)).slice(0, 3)).toEqual(before);
  await fillSettled(table, 5);
  await expect.poll(() => rowNames(table)).toContain("Aldermoor Term Sheet");

  await window.getByTestId("mind-editor").first().focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(table.getByTestId("comparison-row")).toHaveCount(3);
  await window.keyboard.press("ControlOrMeta+Shift+z");
  await expect(table.getByTestId("comparison-row")).toHaveCount(5);

  // In Chinese the picker says what it is and what it will add.
  await bridge(window).language("zh-CN");
  await pointAndClick(window, table.getByTestId("comparison-table-menu"));
  await expect(
    window.getByTestId("comparison-table-actions").getByTestId("comparison.table.addDocuments"),
  ).toHaveText("添加文档…");
  await pointAndClick(
    window,
    window.getByTestId("comparison-table-actions").getByTestId("comparison.table.addDocuments"),
  );
  await expect(picker).toContainText("添加文档");
  await window.keyboard.press("Escape");
  await bridge(window).language("en");
});

test("rows are removed and moved by menu, keys and drag, each undone, and a row's Document opens beside the table", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1600, 860);
  await acceptPlainTextKeys(window);
  await useLocalChatModel(window);
  const table = await filledSuppliersTable(window);
  const heads = table.locator(".comparison-document");
  const names = await rowNames(table);

  // ⌘K reaches the row's actions from its head.
  await heads.first().focus();
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("Remove row");
  await expect(
    window.getByTestId("palette").locator('[data-key="command:comparisonRow.remove"]'),
  ).toBeVisible();
  await window.keyboard.press("Escape");

  // Delete on the focused row's head takes it out; the undo line names it.
  await heads.first().focus();
  await window.keyboard.press("Delete");
  await expect(table.getByTestId("comparison-row")).toHaveCount(2);
  await expect(window.getByTestId("undo-message")).toContainText("Removed “Corvane Agreement”");
  await window.keyboard.press("ControlOrMeta+z");
  await expect(table.getByTestId("comparison-row")).toHaveCount(3);
  expect(await rowNames(table)).toEqual(names);

  // Its menu moves it down, and up, each one step of Undo.
  await pointAndClick(window, heads.first().getByTestId("comparison-row-menu"));
  const rowMenu = window.locator('[data-testid="comparison-row-actions"]:popover-open');
  await expect(rowMenu.getByRole("menuitem").nth(0)).toContainText("Open");
  await expect(rowMenu.getByRole("menuitem").nth(1)).toContainText("Fill row again");
  await expect(rowMenu.getByRole("menuitem").nth(2)).toContainText("Move up");
  await expect(rowMenu.getByRole("menuitem").nth(3)).toContainText("Move down");
  await expect(rowMenu.getByRole("menuitem").nth(4)).toContainText("Remove row");
  await pointAndClick(window, rowMenu.getByTestId("comparisonRow.moveDown"));
  await expect.poll(() => rowNames(table)).toEqual([names[1], names[0], names[2]]);
  await window.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => rowNames(table)).toEqual(names);

  // The keys move the row too.
  const moveDown =
    process.platform === "darwin" ? "Alt+Shift+ArrowDown" : "Control+Shift+ArrowDown";
  await heads.first().focus();
  await window.keyboard.press(moveDown);
  await expect.poll(() => rowNames(table)).toEqual([names[1], names[0], names[2]]);
  await window.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => rowNames(table)).toEqual(names);

  // Dragged by its head, it lands below the last row.
  const start = await pointAt(window, heads.first());
  const last = await heads.nth(2).boundingBox();
  if (!last) throw new Error("The last row isn't on screen.");
  await window.mouse.down();
  await window.mouse.move(start.x, last.y + last.height - 4, { steps: 14 });
  await window.mouse.up();
  await expect.poll(() => rowNames(table)).toEqual([names[1], names[2], names[0]]);
  await screenshot(window, "compare-rows-dragged-en-1600");
  await window.getByTestId("mind-editor").first().focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => rowNames(table)).toEqual(names);

  // Open shows the row's Document beside the table.
  await pointAndClick(window, heads.first().getByTestId("comparison-row-open"));
  await expect(window.getByTestId("viewer-header")).toBeVisible({ timeout: 20_000 });
});

test("the table is renamed in place, and its name is the Excel file's and sheet's name", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 860);
  await acceptPlainTextKeys(window);
  await useLocalChatModel(window);
  await useOutputLocation(window, sources);
  const table = await filledSuppliersTable(window);

  const name = table.getByTestId("comparison-name");
  await expect(table.getByTestId("comparison-title")).toContainText("Comparison table ·");
  await name.dblclick();
  const field = table.getByTestId("comparison-name-field");
  await expect(field).toBeFocused();
  await field.fill("Refinancing offers");
  await field.press("Enter");
  await expect(table.getByTestId("comparison-title")).toContainText(
    "Refinancing offers · 3 Documents × 2 Questions",
  );
  await expect(window.getByTestId("undo-message")).toContainText("Renamed to “Refinancing offers”");

  // F2 renames it too; Esc keeps the name.
  await table.getByTestId("comparison-head").focus();
  await window.keyboard.press("F2");
  await expect(field).toBeFocused();
  await field.fill("Not this");
  await field.press("Escape");
  await expect(table.getByTestId("comparison-title")).toContainText("Refinancing offers ·");

  // ⌘Z takes the name back, and ⇧⌘Z does it again.
  await table.getByTestId("comparison-head").focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(table.getByTestId("comparison-title")).toContainText("Comparison table ·");
  await window.keyboard.press("ControlOrMeta+Shift+z");
  await expect(table.getByTestId("comparison-title")).toContainText("Refinancing offers ·");

  // Expanded, the title line keeps its name, and the export is named after it.
  await pointAndClick(window, table.getByTestId("comparison-expand"));
  await expect(table.getByTestId("comparison-title")).toContainText(
    "Refinancing offers · 3 Documents × 2 Questions",
  );
  await screenshot(window, "compare-renamed-expanded-en-1440");
  await pointAndClick(window, table.getByTestId("comparison-export-excel"));
  const result = window.getByTestId("export-result");
  await expect(result).toHaveAttribute("data-state", "saved", { timeout: 20_000 });
  await expect(result).toContainText("Refinancing offers.xlsx");
  const written = new Uint8Array(await readFile(join(sources, "Refinancing offers.xlsx")));
  const book = await readWorkbook(written, undefined, {});
  expect(book.sheets.map((sheet) => sheet.name)).toEqual(["Refinancing offers", "Sources"]);
});

test("the counts say what found nothing and what failed, each a filter, in English and Chinese", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1600, 860);
  await acceptPlainTextKeys(window);
  await bridge(window).cloudModel();
  await addSuppliers(window);

  const sheet = await openSheetFromSlash(window);
  await typeQuestions(window, ["Termination notice", "Liability cap", "Budget (out of credit)"]);
  await pointAndClick(window, sheet.getByTestId("compare-sheet-make"));
  const table = window.getByTestId("comparison-table");
  await fillSettled(table, 9);
  await pointAndClick(window, table.getByTestId("comparison-accept-all"));

  const nothing = table.getByTestId("comparison-count-nothing");
  const failed = table.getByTestId("comparison-count-failed");
  await expect(nothing).toHaveText("1 found nothing");
  await expect(failed).toHaveText("3 failed");
  await expect(nothing).toHaveAttribute("aria-pressed", "false");
  await expect(shownRows(table)).toHaveCount(3);

  await pointAndClick(window, nothing);
  await expect(nothing).toHaveAttribute("aria-pressed", "true");
  await expect(table.getByTestId("comparison-showing")).toHaveText("Showing 1 of 3 Documents");
  await expect(shownRows(table)).toHaveCount(1);
  await screenshot(window, "compare-status-filter-en-1600");
  await pointAndClick(window, table.getByTestId("comparison-clear-filter"));
  await expect(shownRows(table)).toHaveCount(3);
  await expect(table.getByTestId("comparison-showing")).toHaveCount(0);

  // Chinese says the same, and its Clear filter does the same.
  await bridge(window).language("zh-CN");
  await expect(table.getByTestId("comparison-count-nothing")).toHaveText("1 个未找到");
  await expect(table.getByTestId("comparison-count-failed")).toHaveText("3 个失败");
  await pointAndClick(window, table.getByTestId("comparison-count-nothing"));
  await expect(table.getByTestId("comparison-showing")).toHaveText("显示 3 个文档中的 1 个");
  await expect(table.getByTestId("comparison-clear-filter")).toHaveText("清除筛选");
  await pointAndClick(window, table.getByTestId("comparison-clear-filter"));
  await expect(shownRows(table)).toHaveCount(3);
  // Narrow, the title line and its counts stay inside the card.
  await setWindowSize(app, window, 900, 860);
  await expect(table.getByTestId("comparison-count-nothing")).toBeVisible();
  const [headBox, cardBox] = [
    await table.getByTestId("comparison-head").boundingBox(),
    await window.locator(".mind-scroller").first().boundingBox(),
  ];
  if (!headBox || !cardBox) throw new Error("The title line or the card isn't on screen.");
  expect(headBox.x + headBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
  await screenshot(window, "compare-status-zh-900");
  await bridge(window).language("en");
});

test("a cell opens its Citation, checks hand edits, protects reviewed cells in bulk, refills explicitly, and copies a rectangle with Sources", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1600, 900);
  await useLocalChatModel(window);
  const copied = await stubClipboard(window);
  const table = await filledSuppliersTable(window);
  await expectGridRows(table);
  const first = cellAt(table, 0, 0);
  await expect(first).toHaveAttribute("tabindex", "0");
  await expect(cellAt(table, 0, 1)).toHaveAttribute("tabindex", "-1");

  await pointAndClick(window, first);
  const card = window.getByTestId("comparison-cell-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Corvane Agreement");
  await expect(card).toContainText("Termination notice: 90 days.");
  await expect(card.getByTestId("comparison-refill-estimate")).toContainText("Fill 1 cell again");
  await screenshot(window, "compare-cell-card-en-1600");
  await pointAndClick(window, card.getByRole("button", { name: "Open cited page" }));
  await expect(window.getByTestId("viewer-header")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  await first.focus();
  await window.keyboard.press("F2");
  const input = first.getByTestId("comparison-cell-input");
  await expect(input).toBeFocused();
  // A click on the cell's own padding while editing keeps the field, and what is typed goes in it.
  await pointAt(window, first);
  await first.click({ position: { x: 4, y: 4 } });
  await expect(input).toBeFocused();
  await window.keyboard.press("End");
  await window.keyboard.type(" (typed)", { delay: 40 });
  await expect(input).toHaveValue(/\(typed\)$/);
  await expect(input).toBeFocused();
  await expect(card).toHaveCount(0);
  await input.fill("Termination notice: 90 days.");
  await window.keyboard.press("Enter");
  await expect(input).toHaveCount(0);
  await expect(first.locator(".comparison-cell-content")).toContainText(
    "Termination notice: 90 days",
  );
  await expect(first.locator('.citation-marker[data-check="found"]')).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(first.locator(".comparison-cell-flags")).toContainText("✎");
  await expectGridRows(table);
  await expect(window.getByTestId("undo-message")).toContainText("Edited the cell");
  await pointAndClick(window, window.getByTestId("undo-action"));
  await expect(first.locator(".comparison-cell-content")).toContainText("90 days");
  await expect(first.locator(".comparison-cell-content")).not.toContainText("Termination notice:");

  await first.focus();
  await window.keyboard.press("F2");
  await first.getByTestId("comparison-cell-input").fill("Unrelated words");
  await window.keyboard.press("Enter");
  await expect(first.getByTestId("comparison-cell-input")).toHaveCount(0);
  await expect(first.locator(".comparison-cell-content")).toHaveText("Unrelated words");
  await expect(first.locator(".citation-marker")).toHaveCount(0);
  await expect(first.locator(".comparison-cell-flags")).toContainText("✎");

  await pointAndClick(window, first.locator(".comparison-cell-menu"));
  await pointAndClick(window, window.getByRole("menuitemcheckbox", { name: "Checked by me" }));
  await expect(window.getByRole("menu")).toHaveCount(0);
  await expect(first.locator(".comparison-cell-flags")).toContainText("✓");
  await pointAndClick(window, first);
  await expect(card).toBeVisible();
  await expect(card).toContainText("Checked by you");
  await screenshot(window, "compare-cell-checked-en-1600");
  await pointAndClick(window, card.getByRole("button", { name: "Fill again" }));
  await expect(card.getByText("Replace your edit?")).toBeVisible();
  await pointAndClick(window, card.getByRole("button", { name: "Replace", exact: true }));
  await expect(first.locator('.citation-marker[data-check="found"]')).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(first.locator(".comparison-cell-content")).toContainText("90 days");
  await expect(first.locator(".comparison-cell-flags")).toHaveCount(0);
  // The mark stays, as made on the Answer before it was replaced.
  await pointAndClick(window, first);
  await expect(card.getByTestId("sign-off-line")).toHaveText("Checked by you before it changed");
  await window.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  await pointAndClick(window, first.locator(".comparison-cell-menu"));
  await pointAndClick(window, window.getByRole("menuitemcheckbox", { name: "Checked by me" }));
  await expect(window.getByRole("menu")).toHaveCount(0);
  await pointAndClick(window, cellAt(table, 2, 1), { modifiers: ["ControlOrMeta"] });
  await first.locator(".comparison-cell-menu").click();
  await pointAndClick(window, window.getByRole("menuitemcheckbox", { name: "Checked by me" }));
  await expect(window.getByRole("menu")).toHaveCount(0);
  await expect(first.locator(".comparison-cell-flags")).toHaveCount(0);
  await first.locator(".comparison-cell-menu").click();
  await expect(first.locator(".comparison-cell-menu")).toHaveAttribute("aria-expanded", "true");
  await expect(window.getByRole("menu")).toBeVisible();
  await pointAndClick(window, window.getByRole("menuitemcheckbox", { name: "Checked by me" }));
  await expect(window.getByRole("menu")).toHaveCount(0);
  const row = table.getByTestId("comparison-row").first();
  await pointAndClick(window, row.locator(".comparison-row-menu"));
  await expect(window.getByTestId("comparison-refill-estimate")).toContainText("Fill 1 cell again");
  await refillEnded(window, table, async () => {
    await pointAndClick(window, window.getByRole("menuitem", { name: "Fill row again" }));
    await expect(window.getByTestId("undo-message")).toContainText("Fill 1 cell again");
  });
  await expect(first.locator(".comparison-cell-flags")).toContainText("✓");

  await pointAndClick(window, table.getByTestId("comparison-table-menu"));
  const estimates = window.getByTestId("comparison-refill-estimate");
  await expect(estimates).toHaveCount(2);
  await expect(estimates.nth(0)).toContainText("Fill all: 6 cells");
  await expect(estimates.nth(1)).toContainText("Problems: 1 cell");
  await refillEnded(window, table, async () => {
    await pointAndClick(window, window.getByRole("menuitem", { name: "Fill all again" }));
    await expect(window.getByTestId("undo-message")).toContainText("Fill 6 cells again");
  });
  // Written again in the same words from the same version, the cell is still as its mark checked it.
  await expect(first.locator(".comparison-cell-flags")).toContainText("✓");
  await expect(table.locator('.citation-marker[data-check="found"]')).toHaveCount(5);
  await expectGridRows(table);

  const last = cellAt(table, 1, 1);
  await expect(last).toHaveAttribute("data-status", "done");
  await pointAt(window, first);
  await first.click({ position: { x: 12, y: 12 } });
  await expect(first).toBeFocused();
  await pointAndClick(window, last, { modifiers: ["Shift"] });
  for (const [rowAt, columnAt] of [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ] as const) {
    await expect(cellAt(table, rowAt, columnAt)).toHaveAttribute("aria-selected", "true");
  }
  await expect(last).toBeFocused();
  await expect(card).toHaveCount(0);
  const cellMenu = last.locator(".comparison-cell-menu");
  await pointAt(window, cellMenu);
  await cellMenu.click();
  // The first cell's mark still stands on its Answer, so a refill of the four leaves it.
  await expect(window.getByTestId("comparison-refill-estimate")).toContainText(
    "Fill 3 cells again",
  );
  await refillEnded(window, table, async () => {
    await pointAndClick(window, window.getByRole("menuitem", { name: "Fill again", exact: true }));
    await expect(window.getByTestId("undo-message")).toContainText("Fill 3 cells again");
  });
  await last.focus();
  await window.keyboard.press("ControlOrMeta+c");
  await expect
    .poll(async () => (await copied())["text/plain"] ?? "")
    .toContain("Document\tTermination notice\tLiability cap\tSources");
  const clipboard = await copied();
  expect(clipboard["text/plain"] ?? "").toContain("Corvane Agreement");
  expect(clipboard["text/plain"] ?? "").toContain("Halvard MSA");
  expect(clipboard["text/plain"] ?? "").toContain("Termination notice: 90 days.");
  expect(clipboard["text/html"] ?? "").toContain("<table");
  await window.keyboard.press("Escape");
  await expect(table.locator('[aria-selected="true"]')).toHaveCount(0);

  await setWindowSize(app, window, 900, 760);
  await pointAndClick(window, table.getByTestId("comparison-expand"));
  await pointAndClick(window, first);
  await expect(card).toBeVisible();
  await screenshot(window, "compare-cell-card-expanded-en-900");
  await window.keyboard.press("Escape");

  await setWindowSize(app, window, 1600, 900);
  await bridge(window).language("zh-CN");
  await pointAndClick(window, first);
  await expect(card).toContainText("回答");
  await expect(card.getByRole("button", { name: "编辑", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "我已核对" })).toBeVisible();
  await screenshot(window, "compare-cell-card-expanded-zh-1600");
  await window.keyboard.press("Escape");

  await setWindowSize(app, window, 900, 760);
  await pointAndClick(window, first);
  await expect(card).toContainText("回答");
  await screenshot(window, "compare-cell-card-expanded-zh-900");
  await expect(card).toContainText("由你核对");
  await pointAndClick(window, card.getByRole("button", { name: "我已核对" }));
  await pointAndClick(window, first);
  await expect(card.getByTestId("sign-off-line")).toHaveCount(0);
  await pointAndClick(window, card.getByRole("button", { name: "我已核对" }));
  await pointAndClick(window, first);
  await expect(card).toContainText("由你核对");
  await screenshot(window, "compare-cell-checked-zh-900");
  await expectGridRows(table);
});

test("Shift-click closes the cell card and selects its range", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1600, 900);
  await useLocalChatModel(window);
  const table = await filledSuppliersTable(window);
  const first = cellAt(table, 0, 0);
  const last = cellAt(table, 1, 1);
  await pointAndClick(window, first);
  const card = window.getByTestId("comparison-cell-card");
  await expect(card).toBeVisible();

  await pointAndClick(window, last, { modifiers: ["Shift"] });
  await expect(card).toHaveCount(0);
  for (const [rowAt, columnAt] of [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ] as const) {
    await expect(cellAt(table, rowAt, columnAt)).toHaveAttribute("aria-selected", "true");
  }
});

for (const { language, refill, count, one, checkedByMe } of [
  {
    language: "en",
    refill: "Fill again",
    count: "Fill 5 cells again",
    one: "Fill 1 cell again",
    checkedByMe: "Checked by me",
  },
  {
    language: "zh-CN",
    refill: "重新填写",
    count: "重新填写 5 个单元格",
    one: "重新填写 1 个单元格",
    checkedByMe: "我已核对",
  },
] as const) {
  test(`Copy, refill and Checked by me follow the visible selection after a deselection (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await bridge(window).language(language);
    await setWindowSize(app, window, 1600, 900);
    await useLocalChatModel(window);
    const copied = await stubClipboard(window);
    const table = await filledSuppliersTable(window);
    const first = cellAt(table, 0, 0);
    const deselected = cellAt(table, 0, 1);
    const last = cellAt(table, 2, 1);
    await expect(last).toHaveAttribute("data-status", "failed");
    await pointAndClick(window, first);
    await pointAndClick(window, last, { modifiers: ["Shift"] });
    await pointAndClick(window, deselected, { modifiers: ["ControlOrMeta"] });
    await expect(deselected).toHaveAttribute("aria-selected", "false");
    for (const [rowAt, columnAt] of [
      [0, 0],
      [1, 0],
      [1, 1],
    ] as const) {
      await expect(cellAt(table, rowAt, columnAt)).toHaveAttribute("aria-selected", "true");
    }

    await window.keyboard.press("ControlOrMeta+c");
    await expect
      .poll(async () => (await copied())["text/plain"] ?? "")
      .toContain("Termination notice: 90 days.");
    const clipboard = (await copied())["text/plain"] ?? "";
    expect(clipboard).toContain("Termination notice: 6 months.");
    expect(clipboard).toContain("Termination notice: 30 days.");
    expect(clipboard).not.toContain("12 months of fees");

    await pointAndClick(window, last.locator(".comparison-cell-menu"));
    await refillEnded(window, table, async () => {
      await pointAndClick(window, window.getByRole("menuitem", { name: refill, exact: true }));
      await expect(window.getByTestId("undo-message")).toContainText(count);
    });

    // From ⌘K, "Checked by me" marks the visible selection too, not the cell just deselected.
    await deselected.focus();
    await window.keyboard.press("ControlOrMeta+k");
    await window.keyboard.type(checkedByMe);
    const command = window
      .getByTestId("palette")
      .locator('[data-key="command:comparison.cell.reviewed"]');
    await expect(command).toHaveAttribute("aria-selected", "true");
    await window.keyboard.press("Enter");
    for (const [rowAt, columnAt] of [
      [0, 0],
      [1, 0],
      [1, 1],
    ] as const) {
      await expect(cellAt(table, rowAt, columnAt).locator(".comparison-cell-flags")).toContainText(
        "✓",
      );
    }
    await expect(deselected.locator(".comparison-cell-flags")).toHaveCount(0);

    await pointAndClick(window, deselected.locator(".comparison-cell-menu"));
    await expect(window.getByTestId("comparison-refill-estimate")).toContainText(one);
  });
}
