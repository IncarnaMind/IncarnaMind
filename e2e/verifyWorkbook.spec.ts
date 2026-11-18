import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { WorkbookBuilder } from "../tests/helpers/financeWorkbooks";
import {
  addDocuments,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  frontMindName,
  interceptOpenDialog,
  launchApp,
  motionSettled,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
  verifyRows,
} from "./app";

/*
 * "Check someone else’s file…" on a workbook (#3278): its sheets are listed to choose from, and a
 * range of a sheet can be written; the sheet becomes a Note of one table whose card says how many
 * formulas were worked out again and moves to the cell whose saved result differs, while each row
 * with typed-in numbers is a claim checked against the Documents. The scripted model
 * (src/main/fakeChat/) finds a row supported when it shares three words with a line of a
 * Document, contradicted when it also has a number the line doesn't. Set INCARNAMIND_SCREENSHOTS
 * to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const FINANCE = [
  "# Finance notes",
  "",
  "Rent for 2026 is 14000 and for 2027 14000.",
  "",
  "Insurance for 2026 is 2200 and for 2027 2500.",
  "",
].join("\n");

/** Three rows of typed-in numbers and a total row of formulas, the 2027 total saved wrong; a second sheet with only words. */
function budget(): Buffer {
  const book = new WorkbookBuilder();
  book
    .sheet("Plan")
    .text("A1", "Item")
    .text("B1", "2026")
    .text("C1", "2027")
    .text("A2", "Rent")
    .number("B2", 14000)
    .number("C2", 14000)
    .text("A3", "Insurance")
    .number("B3", 2200)
    .number("C3", 2300)
    .text("A4", "Travel")
    .number("B4", 6000)
    .number("C4", 6500)
    .text("A5", "Total")
    .formula("B5", "SUM(B2:B4)", 22200)
    .formula("C5", "SUM(C2:C4)", 23800);
  book.sheet("Notes").text("A1", "Prepared by the finance team.");
  return book.xlsx();
}

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

test("Verify a workbook: its sheet is chosen, its formulas are worked out again and its rows checked", async () => {
  await writeFile(join(sources, "Finance notes.md"), FINANCE);
  await writeFile(join(sources, "Budget.xlsx"), budget());
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Finance notes.md")]);
  await interceptOpenDialog(app, join(sources, "Budget.xlsx"));
  await setWindowSize(app, window, 1440, 900);

  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-more"));
  await pointAndClick(window, window.getByTestId("plus-verify-document"));

  // The sheets say what each holds; the first with something in it is chosen, one with nothing can't be.
  const dialog = window.getByTestId("workbook-sheet-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Check a workbook");
  const sheets = dialog.getByTestId("workbook-sheet");
  await expect(sheets).toHaveCount(2);
  await expect(sheets.first()).toBeChecked();
  await expect(dialog.locator("label").filter({ hasText: "Plan" })).toContainText(
    "6 typed-in numbers · 2 formulas",
  );
  await expect(sheets.nth(1)).toBeDisabled();
  await expect(dialog.locator("label").filter({ hasText: "Notes" })).toContainText(
    "nothing to check",
  );
  await screenshot(window, "verify-workbook-dialog-en");

  // A range that isn't one is said, and the dialog stays for another.
  await dialog.getByTestId("workbook-range").fill("B2-C9");
  await pointAndClick(window, dialog.getByTestId("workbook-check"));
  await expect(dialog.getByTestId("workbook-problem")).toContainText(
    "The workbook has no such sheet or range. Write a range like B2:M40.",
  );
  await dialog.getByTestId("workbook-range").fill("");
  await pointAndClick(window, dialog.getByTestId("workbook-check"));

  await expect(dialog).toBeHidden();
  await expect(frontMindName(window)).toHaveText("Checking: Budget");
  const card = await checkCard(window);
  const formulas = card.getByTestId("verify-formulas");
  await expect(formulas).toContainText("2 formulas worked out again · 1 saved result differs");
  const differs = formulas.getByTestId("verify-formula-differs");
  await expect(differs).toHaveCount(1);
  await expect(differs).toContainText("C5: saved 23,800, worked out 22,800");
  await screenshot(window, "verify-workbook-card-en");

  // Each row with typed-in numbers is a claim; the total row of formulas is not.
  const ask = card.getByTestId("verify-ask");
  await expect(ask.getByTestId("verify-check")).toHaveText("Check 3 claims");
  await pointAndClick(window, ask.getByTestId("verify-check"));
  const done = card.getByTestId("verify-done");
  await expect(done).toContainText("Checked 3 claims · 3 need a look");
  await verifyRows(window);
  await expect(done.getByTestId("verify-contradicted")).toContainText("1 contradicted");
  await expect(done.getByTestId("verify-unsupported")).toContainText("1 unsupported");
  await expect(done.getByTestId("verify-supported")).toContainText("1 supported");
  await screenshot(window, "verify-workbook-results-en");

  // The formula row goes to its cell.
  await pointAndClick(window, differs);
  await expect(window.getByTestId("mind-editor")).toBeFocused();
  await expect
    .poll(() =>
      window
        .getByTestId("mind-editor")
        .evaluate(() => getSelection()?.anchorNode?.parentElement?.closest("td")?.textContent),
    )
    .toBe("23800");

  await setLanguage(window, "zh-CN");
  await expect(formulas).toContainText("已重新计算 2 个公式 · 1 个保存的结果不一致");
  await expect(differs).toContainText("C5：保存的是 23,800，重新计算为 22,800");
  await screenshot(window, "verify-workbook-card-zh");
  await setLanguage(window, "en");
});

test("Verify a workbook: a range checks only its cells, and a sheet with nothing to check can't be chosen", async () => {
  await writeFile(join(sources, "Finance notes.md"), FINANCE);
  await writeFile(join(sources, "Budget.xlsx"), budget());
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Finance notes.md")]);
  await interceptOpenDialog(app, join(sources, "Budget.xlsx"));

  await setLanguage(window, "zh-CN");
  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-more"));
  await pointAndClick(window, window.getByTestId("plus-verify-document"));
  const dialog = window.getByTestId("workbook-sheet-dialog");
  await expect(dialog).toContainText("核对工作簿");
  await expect(dialog.locator("label").filter({ hasText: "Plan" })).toContainText(
    "6 个手动输入的数字 · 2 个公式",
  );
  await screenshot(window, "verify-workbook-dialog-zh");
  await dialog.getByTestId("workbook-range").fill("A1:B5");
  await pointAndClick(window, dialog.getByTestId("workbook-check"));

  await expect(dialog).toBeHidden();
  const card = await checkCard(window);
  await expect(card.getByTestId("verify-formulas")).toContainText(
    "已重新计算 1 个公式 · 结果都一致",
  );
  await expect(card.getByTestId("verify-ask").getByTestId("verify-check")).toHaveText(
    "核对 3 条说法",
  );
});
