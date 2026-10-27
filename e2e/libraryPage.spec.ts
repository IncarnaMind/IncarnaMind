import { expect, type Locator, test } from "@playwright/test";
import { translate } from "../src/shared/i18n";
import {
  addFilesLabel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  placeAssistant,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sidebarFolder,
  useLocalChatModel,
} from "./app";
import {
  DELETED,
  FIXTURE_COUNT,
  FOLDERS,
  NOT_IN_A_FOLDER,
  openFullLibrary,
  SCAN_NAME,
} from "./libraryFixture";

/*
 * The Library as one page grouped by Folder (#240): its head, one section per
 * Folder that folds and remembers it, Not in a Folder last and Recently deleted
 * folded at the foot, rows of 40px with no native controls, search, filters
 * and the problem line narrowing every section, Move to… for Documents, a
 * Folder from the sidebar brought into view, and columns that give way at a
 * narrow window. On a Library of about 100 Documents in every format, with
 * English and Chinese names, by the mouse (slid onto each target) and the keyboard.
 */

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

const LOOSE = NOT_IN_A_FOLDER.length - DELETED.length;

const sections = (library: Locator) => library.getByTestId("library-section");

const section = (library: Locator, name: string) =>
  sections(library).filter({
    has: library.page().locator('[data-testid="library-section-name"]', {
      hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    }),
  });

const rowsOf = (scope: Locator) => scope.getByTestId("library-document");

const row = (scope: Locator, name: string) =>
  rowsOf(scope).filter({
    has: scope.page().getByTestId("library-document-name").getByText(name, { exact: true }),
  });

const left = (locator: Locator) =>
  locator.evaluate((element) => element.getBoundingClientRect().left);

test("the page is grouped by Folder in the sidebar's order, with Not in a Folder last and Recently deleted folded at the foot, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1600, 900);
    const library = await openFullLibrary(window, sources);
    await expect(library.getByTestId("library-heading")).toContainText("Library");
    await expect(window.getByTestId("tab-title").filter({ hasText: "Library" })).toHaveCount(1);
    await expect(window.getByTestId("open-library")).toContainText("Library");

    // One section per Folder, in the sidebar's order, then Not in a Folder.
    const sidebarNames = await window
      .getByTestId("library-folders")
      .getByTestId("library-folder")
      .locator(':scope > div [data-testid="row-text"]')
      .allTextContents();
    expect(sidebarNames).toHaveLength(FOLDERS.length);
    await expect(sections(library).getByTestId("library-section-name")).toHaveText([
      ...sidebarNames,
      "Not in a Folder",
    ]);
    for (const folder of FOLDERS) {
      await expect(section(library, folder.name)).toHaveAttribute(
        "data-count",
        String(folder.documents.length),
      );
    }
    await expect(section(library, "Not in a Folder")).toHaveAttribute("data-count", String(LOOSE));
    const finance = section(library, "Finance");
    // The Folder's description is no line on the page: it shows pointing at the head.
    await expect(finance.getByTestId("library-section-head")).not.toContainText(
      "Invoices, budgets and statements",
    );
    await expect(finance.getByTestId("library-section-head")).toHaveAttribute(
      "title",
      "Invoices, budgets and statements",
    );

    // A long section lists its first 8, then "Show all 17".
    await expect(rowsOf(finance)).toHaveCount(8);
    await pointAndClick(window, finance.getByTestId("library-show-all"));
    await expect(rowsOf(finance)).toHaveCount(17);
    await expect(finance.getByTestId("library-show-all")).toHaveCount(0);

    // Rows: name, Tags, format and when it was added; no native select or disclosure anywhere.
    const invoice = row(finance, "Invoice 4471");
    await expect(invoice.getByTestId("tag-chip")).toHaveText("Invoice");
    await expect(invoice.getByTestId("library-document-format")).toHaveText("PDF");
    await expect(invoice.getByTestId("library-document-added")).not.toHaveText("");
    await expect(library.locator("select, details, summary")).toHaveCount(0);
    const tallest = () =>
      rowsOf(library).evaluateAll((rows) =>
        Math.max(...rows.map((each) => each.getBoundingClientRect().height)),
      );
    expect(await tallest()).toBeLessThanOrEqual(40);

    // The words of the title, the search, + Filter and the first section and row start on one edge.
    const edge = await left(library.getByTestId("library-heading"));
    const plus = library.getByTestId("library-add-filter").locator("svg");
    for (const each of [
      library.getByTestId("library-search").locator("xpath=.."),
      plus,
      sections(library).first().getByTestId("library-section-head"),
      rowsOf(library).first(),
    ]) {
      expect(Math.abs((await left(each)) - edge)).toBeLessThanOrEqual(1);
    }
    // Every menu button opens with the app's chevron, never a typed caret.
    await expect(library.getByTestId("library-add-documents").locator("svg")).toHaveCount(2);
    await expect(library.getByTestId("library-add-documents")).not.toContainText("▾");

    // The problem, in one line with one action.
    await expect(library.getByTestId("library-problem")).toHaveText(
      "1 Document has no text: a scan · Show",
    );

    // Recently deleted waits folded at the foot; opened, each row offers Restore.
    const deleted = window.getByTestId("deleted-section-head");
    await expect(deleted).toHaveAttribute("data-open", "false");
    await expect(deleted.getByTestId("library-section-count")).toHaveText("2");
    await expect(window.getByTestId("deleted-item")).toHaveCount(0);
    await pointAndClick(window, deleted.getByTestId("deleted-heading"));
    await expect(window.getByTestId("deleted-item")).toHaveCount(2);
    await expect(window.getByTestId("deleted-name")).toHaveText(DELETED.toReversed());

    // In Chinese, the same page in its words, and rows still 40px.
    await setLanguage(window, "zh-CN");
    await expect(library.getByTestId("library-heading")).toContainText("资料库");
    await expect(sections(library).getByTestId("library-section-name").last()).toHaveText(
      "不在文件夹中",
    );
    await expect(library.getByTestId("library-problem")).toHaveText(
      "1 个文档没有文字：扫描件 · 显示",
    );
    await expect(window.getByTestId("deleted-heading")).toHaveText("回收站");
    expect(await tallest()).toBeLessThanOrEqual(40);
    await expect(window.getByTestId("tab-title").filter({ hasText: "资料库" })).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test("sections fold and remember it after a restart, by the mouse and by ← and →; Collapse all and Expand all", async () => {
  const first = await launchApp(dataDir);
  try {
    const { window } = first;
    const library = await openFullLibrary(window, sources);
    const board = section(library, "Board");
    await pointAndClick(window, board.getByTestId("library-section-toggle"));
    await expect(board.getByTestId("library-section-head")).toHaveAttribute("data-open", "false");
    await expect(rowsOf(board)).toHaveCount(0);

    // By keyboard: ← folds the focused section, → opens it, ↓ walks on into its rows.
    const finance = section(library, "Finance");
    await finance.getByTestId("library-section-name").focus();
    await window.keyboard.press("ArrowLeft");
    await expect(rowsOf(finance)).toHaveCount(0);
    await window.keyboard.press("ArrowRight");
    await expect(rowsOf(finance)).toHaveCount(8);
    await window.keyboard.press("ArrowDown");
    await expect(rowsOf(finance).first().locator("[data-row-main]")).toBeFocused();
    await window.keyboard.press("ArrowUp");
    await window.keyboard.press("ArrowLeft");
    await expect(rowsOf(finance)).toHaveCount(0);
  } finally {
    await first.app.close();
  }

  const again = await launchApp(dataDir);
  try {
    const { window } = again;
    await window.getByTestId("open-library").click();
    const library = window.getByTestId("library");
    await expect(rowsOf(section(library, "Contracts"))).toHaveCount(5);
    await expect(rowsOf(section(library, "Board"))).toHaveCount(0);
    await expect(rowsOf(section(library, "Finance"))).toHaveCount(0);

    const foldAll = library.getByTestId("library-fold-all");
    await expect(foldAll).toHaveText("Collapse all");
    await pointAndClick(window, foldAll);
    await expect(rowsOf(library)).toHaveCount(0);
    await expect(foldAll).toHaveText("Expand all");
    await pointAndClick(window, foldAll);
    await expect(rowsOf(section(library, "Board"))).toHaveCount(8);
    await expect(foldAll).toHaveText("Collapse all");
  } finally {
    await again.app.close();
  }
});

test("search narrows every section and hides the empty ones; a filter chip and the problem line's Show narrow it too", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    const library = await openFullLibrary(window, sources);
    const search = library.getByTestId("library-search");

    // / focuses the search from the list.
    await rowsOf(library).first().locator("[data-row-main]").focus();
    await window.keyboard.press("/");
    await expect(search).toBeFocused();
    await window.keyboard.type("sensor");
    await expect(sections(library).getByTestId("library-section-name")).toHaveText([
      "Thesis: urban heat",
    ]);
    await expect(rowsOf(library)).toHaveCount(5);
    await expect(window.getByTestId("recently-deleted")).toHaveCount(0);

    // Every word must match, in names and Tags; Chinese names by their characters.
    await search.fill("contract nda");
    await expect(rowsOf(library)).toHaveCount(2);
    expect(
      (await rowsOf(library).getByTestId("library-document-name").allTextContents()).sort(),
    ).toEqual(["Mutual NDA, Alder Systems", "NDA: Polar Freight"]);
    await search.fill("纪要");
    await expect(rowsOf(library)).toHaveCount(3);

    // Nothing found says so: ask about it instead, or go back.
    await search.fill("zzz nothing");
    await expect(library.getByTestId("library-no-match")).toHaveText(
      "No Documents match · Ask about “zzz nothing” · Clear search and filters",
    );
    await pointAndClick(window, library.getByTestId("library-clear-narrowing"));
    await expect(search).toHaveValue("");
    await expect(sections(library)).toHaveCount(FOLDERS.length + 1);

    // + Filter, then Format, then PDF: a chip that reads as a sentence; × drops it.
    await pointAndClick(window, library.getByTestId("library-add-filter"));
    await pointAndClick(
      window,
      window.locator('[data-testid="library-filter-kind"][data-facet="format"]'),
    );
    await pointAndClick(
      window,
      window.locator('[data-testid="library-filter-option"][data-value="pdf"]'),
    );
    await window.keyboard.press("Escape");
    await expect(library.getByTestId("library-filter")).toHaveText("Format: PDF");
    const formats = await rowsOf(library).getByTestId("library-document-format").allTextContents();
    expect(new Set(formats)).toEqual(new Set(["PDF"]));
    await pointAndClick(window, library.getByTestId("library-filter-remove"));
    await expect(library.getByTestId("library-filter")).toHaveCount(0);

    // The problem line's Show filters to the scan, in Not in a Folder.
    await pointAndClick(window, library.getByTestId("library-problem-show"));
    await expect(rowsOf(library).getByTestId("library-document-name")).toHaveText([SCAN_NAME]);
    await expect(rowsOf(library).getByTestId("document-status")).toContainText("No text");
    await expect(library.getByTestId("library-filter")).toContainText("Status: No text");
  } finally {
    await app.close();
  }
});

test("the Source location filter is 文件位置 in the Chinese interface (#1507)", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1440, 900);
    const library = await openFullLibrary(window, sources);
    await setLanguage(window, "zh-CN");
    await pointAndClick(window, library.getByTestId("library-add-filter"));
    await pointAndClick(
      window,
      window.locator('[data-testid="library-filter-kind"][data-facet="source"]'),
    );
    await pointAndClick(
      window,
      window.locator('[data-testid="library-filter-option"][data-value="other"]'),
    );
    await window.keyboard.press("Escape");
    await expect(library.getByTestId("library-filter")).toHaveText("文件位置：其他文档");
  } finally {
    await app.close();
  }
});

test("words nothing in the Library matches are asked about in the assistant, by Enter or the line's button, in English and Chinese (#763)", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  const library = await openFullLibrary(window, sources);
  await useLocalChatModel(window);
  const search = library.getByTestId("library-search");
  const asked = window.getByTestId("assistant-question");

  await search.click();
  await window.keyboard.type("harbour tide tables");
  const line = library.getByTestId("library-no-match");
  await expect(line.getByTestId("library-ask")).toHaveText("Ask about “harbour tide tables”");
  await window.keyboard.press("Enter");
  await expect(asked.last()).toContainText("harbour tide tables");

  await setLanguage(window, "zh-CN");
  await search.fill("潮汐时刻表");
  await expect(line.getByTestId("library-ask")).toHaveText("就“潮汐时刻表”提问");
  await expect(line.getByTestId("library-clear-narrowing")).toBeVisible();
  await pointAndClick(window, line.getByTestId("library-ask"));
  await expect(asked.last()).toContainText("潮汐时刻表");
  await app.close();
});

test("search finds the words inside Documents too, in every section: the line that holds them, where it is, its Folder, and a click opens it there, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1600, 900);
    await placeAssistant(window, { folded: true });
    const library = await openFullLibrary(window, sources);
    const search = library.getByTestId("library-search");
    await expect(search).toHaveAttribute("placeholder", "Search names, words inside, Tags");

    // "ledger" is in no name, but in the text of every English Document that has text:
    // far more than ⌘K's 20.
    const withText = [...FOLDERS.flatMap((folder) => folder.documents), ...NOT_IN_A_FOLDER]
      .map(([name]) => name)
      .filter((name) => name !== SCAN_NAME && !DELETED.includes(name));
    const english = withText.filter((name) => !/\p{Script=Han}/u.test(name));
    await search.fill("ledger");
    await expect(rowsOf(library)).toHaveCount(english.length);
    expect(english.length).toBeGreaterThan(20);
    await expect(library.getByTestId("library-no-match")).toHaveCount(0);

    // Each row says the line that holds the words, with them in bold, and its Folder.
    const invoice = row(section(library, "Finance"), "Invoice 4471");
    await expect(invoice.getByTestId("library-found-text")).toHaveText(
      /against the ledger on 12 March 2026\.$/,
    );
    await expect(invoice.getByTestId("library-found-text").locator("b")).toHaveText(["ledger"]);
    await expect(invoice.getByTestId("library-found-place")).toHaveText("p. 1");
    await expect(invoice.getByTestId("library-path")).toHaveText("Finance");
    // Not in a Folder's rows need no path.
    const loose = row(section(library, "Not in a Folder"), "Reading list");
    await expect(loose.getByTestId("library-found-text")).toContainText("ledger");
    await expect(loose.getByTestId("library-path")).toHaveCount(0);

    // A name that holds the words has them in bold too.
    await search.fill("invoice 4471");
    await expect(invoice.getByTestId("library-document-name").locator("b")).toHaveText([
      "Invoice",
      "4471",
    ]);

    // A click opens it at the words, once the rows are the search's: before, it lands on another.
    await search.fill("ledger");
    await expect(rowsOf(library)).toHaveCount(english.length);
    await pointAndClick(window, invoice.getByTestId("library-document-name"));
    const viewer = window.getByTestId("viewer");
    await expect(viewer).toBeVisible();
    await expect(viewer.getByTestId("viewer-header")).toContainText("Invoice 4471");

    // Cleared, rows are one line again.
    await library.getByRole("button", { name: "Clear the search", exact: true }).click();
    await expect(library.getByTestId("library-found-text")).toHaveCount(0);
    await expect(library.getByTestId("library-path")).toHaveCount(0);

    // In Chinese: the placeholder, and words inside Chinese Documents.
    await setLanguage(window, "zh-CN");
    await expect(search).toHaveAttribute("placeholder", "搜索名称、文档内容和标签");
    const chinese = withText.filter((name) => /\p{Script=Han}/u.test(name));
    await search.fill("核对");
    await expect(rowsOf(library)).toHaveCount(chinese.length);
    const report = row(section(library, "财务报表"), "审计意见书");
    await expect(report.getByTestId("library-found-text").locator("b")).toHaveText(["核对"]);
    await expect(report.getByTestId("library-path")).toHaveText("财务报表");
  } finally {
    await app.close();
  }
});

test("every task on the page by keyboard alone: / and ↓ into the rows, ↑ back, ← and →, T, ⇧⌘M, Shift+↓, ⌘⌫ with ⌘Z, ⌘A, Esc and Enter", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1600, 900);
    await placeAssistant(window, { folded: true });
    const library = await openFullLibrary(window, sources);
    const search = library.getByTestId("library-search");
    const contracts = section(library, "Contracts");
    const focusedRow = library.locator("[data-document-id]:has([data-row-main]:focus)");
    const focusedName = () => focusedRow.getByTestId("library-document-name").textContent();

    // / searches; ↓ goes from the field to the first row, ↑ back up to the field.
    await window.keyboard.press("/");
    await expect(search).toBeFocused();
    await window.keyboard.type("agreement");
    await expect(rowsOf(library)).toHaveCount(2);
    await window.keyboard.press("ArrowDown");
    await expect(rowsOf(contracts).first().locator("[data-row-main]")).toBeFocused();
    await window.keyboard.press("ArrowUp");
    await expect(contracts.getByTestId("library-section-name")).toBeFocused();
    await window.keyboard.press("ArrowUp");
    await expect(search).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(search).toHaveValue("");

    // ← folds the section its head has the focus on, → opens it again.
    await window.keyboard.press("ArrowDown");
    const board = section(library, "Board");
    await expect(rowsOf(board).first().locator("[data-row-main]")).toBeFocused();
    await window.keyboard.press("ArrowUp");
    await expect(board.getByTestId("library-section-name")).toBeFocused();
    await window.keyboard.press("ArrowLeft");
    await expect(rowsOf(board)).toHaveCount(0);
    await window.keyboard.press("ArrowRight");
    await expect(rowsOf(board)).not.toHaveCount(0);

    // T opens the row's Tags; a Tag typed and ↵ is on it, and Esc gives the focus back.
    await window.keyboard.press("ArrowDown");
    const tagged = await focusedName();
    await window.keyboard.press("t");
    await expect(focusedRow).toHaveCount(0);
    await window.keyboard.type("Paper");
    await window.keyboard.press("Enter");
    await window.keyboard.press("Escape");
    await expect(focusedRow.getByTestId("library-document-name")).toHaveText(tagged ?? "");
    await expect(focusedRow.getByTestId("tag-chip").filter({ hasText: "Paper" })).toHaveCount(1);

    // ⇧⌘M moves it, and the focus goes with it to its new section.
    await window.keyboard.press("ControlOrMeta+Shift+M");
    await window.keyboard.type("Contracts");
    await window.keyboard.press("Enter");
    await expect(row(contracts, tagged ?? "")).toHaveCount(1);
    await expect(row(contracts, tagged ?? "").locator("[data-row-main]")).toBeFocused();

    // Shift+↓ selects the rows below it; ⌘⌫ deletes the three, the focus moving on; ⌘Z brings them back.
    await window.keyboard.press("Shift+ArrowDown");
    await window.keyboard.press("Shift+ArrowDown");
    const bar = library.getByTestId("library-selection");
    await expect(bar.getByRole("status")).toHaveText("3 selected");
    await expect(bar.locator('[data-command="document.delete"]')).toHaveText(
      /^Delete 3 Documents(⌘⌫|Ctrl\+Backspace)$/,
    );
    const count = library.getByTestId("library-count");
    const shown = FIXTURE_COUNT - DELETED.length;
    await window.keyboard.press("ControlOrMeta+Backspace");
    await expect(count).toHaveText(String(shown - 3));
    await expect(row(contracts, tagged ?? "")).toHaveCount(0);
    await expect(focusedRow).toHaveCount(1);
    await expect(window.getByTestId("undo-line")).toContainText("3 Documents");
    await window.keyboard.press("ControlOrMeta+z");
    await expect(count).toHaveText(String(shown));
    await expect(row(contracts, tagged ?? "")).toHaveCount(1);

    // ⌘A selects every row shown; Esc lets go.
    await focusedRow.locator("[data-row-main]").focus();
    await window.keyboard.press("ControlOrMeta+a");
    await expect(bar.getByRole("status")).toHaveText(`${shown} selected`);
    await window.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);

    // Enter opens the row beside the list.
    const opened = await focusedName();
    await window.keyboard.press("Enter");
    const viewer = window.getByTestId("viewer");
    await expect(viewer).toBeVisible();
    await expect(viewer.getByTestId("viewer-header")).toContainText(opened ?? "");
  } finally {
    await app.close();
  }
});

test("a Document is found and asked about in four steps by keyboard: /, its words, ↓, and Ask from its menu", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1600, 900);
    const library = await openFullLibrary(window, sources);
    // 1 and 2: the search, and words of what is wanted.
    await window.keyboard.press("/");
    await window.keyboard.type("rotterdam lease");
    // 3: ↓ to what was found.
    await window.keyboard.press("ArrowDown");
    const lease = row(section(library, "Contracts"), "Lease: Rotterdam warehouse");
    await expect(lease.locator("[data-row-main]")).toBeFocused();
    const id = await lease.getAttribute("data-document-id");
    // 4: Ask, from its menu (⇧F10, as the context-menu key).
    await window.keyboard.press("Shift+F10");
    const ask = window.getByTestId("document-file-actions").filter({ visible: true });
    for (let step = 0; step < 6; step++) {
      if (await ask.getByTestId("document.ask").evaluate((item) => item === document.activeElement))
        break;
      await window.keyboard.press("ArrowDown");
    }
    await expect(ask.getByTestId("document.ask")).toBeFocused();
    await window.keyboard.press("Enter");
    const composer = window.getByTestId("composer");
    await expect(composer.getByTestId("composer-input")).toBeFocused();
    await expect(composer.getByTestId("scope-chip")).toHaveCount(1);
    await expect(composer.getByTestId("scope-chip")).toHaveAttribute("data-id", id ?? "");
  } finally {
    await app.close();
  }
});

test("five Documents go into a Folder with Move to…, from the selection bar and by ⇧⌘M, with Undo; no row has a dropdown", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1600, 900);
    const library = await openFullLibrary(window, sources);
    const loose = section(library, "Not in a Folder");
    const contracts = section(library, "Contracts");
    const five = [
      "Call notes: procurement",
      "Team offsite agenda",
      "Launch sync 2026-04-02",
      "Stand-up notes, 29 Sep",
      "Stand-up notes, 22 Sep",
    ];
    await pointAndClick(window, loose.getByTestId("library-show-all"));
    for (const name of five) {
      await pointAndClick(window, row(loose, name).getByTestId("library-document-name"), {
        modifiers: ["ControlOrMeta"],
      });
    }
    const bar = library.getByTestId("library-selection");
    await expect(bar.getByRole("status")).toHaveText("5 selected");
    await expect(bar.getByTestId("library-selection-action")).toHaveText([
      /^Move to…(⇧⌘M|Ctrl\+Shift\+M)$/,
      "Ask about these 5 Documents",
      /^Delete 5 Documents(⌘⌫|Ctrl\+Backspace)$/,
    ]);
    // The quiet bar gives way to the selection's.
    await expect(library.getByTestId("library-bar")).toHaveCount(0);

    await pointAndClick(window, bar.locator('[data-command="document.moveTo"]'));
    const picker = window.getByTestId("move-to-picker");
    await expect(picker.getByTestId("move-to-search")).toBeFocused();
    await window.keyboard.type("Contracts");
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("undo-line")).toContainText("Moved 5 Documents to Contracts");
    await expect(contracts).toHaveAttribute("data-count", "10");
    await expect(loose).toHaveAttribute("data-count", String(LOOSE - 5));

    await window.keyboard.press("ControlOrMeta+z");
    await expect(contracts).toHaveAttribute("data-count", "5");
    await expect(loose).toHaveAttribute("data-count", String(LOOSE));

    // Esc, with the focus back on the bar, clears the selection; ⇧⌘M on a focused row moves that one.
    await window.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);
    const call = row(loose, "Call notes: procurement");
    await call.locator("[data-row-main]").focus();
    await window.keyboard.press("ControlOrMeta+Shift+M");
    await expect(picker.getByTestId("move-to-search")).toBeFocused();
    await window.keyboard.type("Board");
    await window.keyboard.press("Enter");
    await expect(row(section(library, "Board"), "Call notes: procurement")).toHaveCount(1);

    // And its ⋯ has Move to… in the shared order, after the row's own actions.
    const offsite = row(loose, "Team offsite agenda");
    await pointAt(window, offsite);
    await pointAndClick(window, offsite.getByTestId("document-file-menu"));
    const menu = window.getByTestId("document-file-actions").filter({ visible: true });
    await expect(menu.getByTestId("document.moveTo")).toHaveText(/Move to…/);
    await pointAndClick(window, menu.getByTestId("document.moveTo"));
    await expect(picker.getByTestId("move-to-option").first()).toHaveText("Not in a Folder");
    await window.keyboard.press("Escape");
    await expect(library.locator("select")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("Tags are edited on the row: a click in the cell opens the picker over it, T and ⌥⌘T from the keyboard, × takes one off, and each change has its own ⌘Z", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 760);
    const library = await openFullLibrary(window, sources);
    await placeAssistant(window, { folded: true });
    const finance = section(library, "Finance");
    await pointAndClick(window, finance.getByTestId("library-show-all"));
    const invoice = row(finance, "Invoice 4471");
    const cell = invoice.getByTestId("document-tags");
    const chips = cell.getByTestId("tag-chip");
    await expect(chips).toHaveText(["Invoice"]);

    // A click on a chip opens the picker over the cell, its field where the chips were.
    await pointAndClick(window, chips.first());
    const picker = invoice.getByTestId("document-tags-popover");
    const field = picker.getByTestId("tag-picker-input");
    await expect(field).toBeFocused();
    await expect(window.getByTestId("viewer")).toHaveCount(0);
    const [cellBox, pickerBox] = await Promise.all([cell.boundingBox(), picker.boundingBox()]);
    if (!cellBox || !pickerBox) throw new Error("The picker isn't showing.");
    expect(Math.abs(pickerBox.x - cellBox.x)).toBeLessThanOrEqual(8);
    expect(pickerBox.y).toBeLessThanOrEqual(cellBox.y);
    expect(pickerBox.y + pickerBox.height).toBeGreaterThan(cellBox.y + cellBox.height);
    // No legend of keys under the list: the field's tooltip has them.
    await expect(picker.getByTestId("tag-picker-keys")).toHaveCount(0);
    await expect(field).toHaveAttribute("title", "Enter adds · Backspace removes");

    // Two Tags added; ⌘Z in the empty field takes back one change at a time, and ⇧⌘Z does it again.
    const tokens = picker.getByTestId("tag-token");
    await window.keyboard.type("Contract");
    await window.keyboard.press("Enter");
    await window.keyboard.type("Report");
    await window.keyboard.press("Enter");
    await expect(tokens).toHaveText(["Contract", "Invoice", "Report"]);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(tokens).toHaveText(["Contract", "Invoice"]);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(tokens).toHaveText(["Invoice"]);
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect(tokens).toHaveText(["Contract", "Invoice"]);
    await expect(field).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(picker).toBeHidden();
    await expect(cell.getByTestId("document-tags-menu")).toBeFocused();
    await expect(chips).toHaveText(["Contract", "Invoice"]);

    // Pointed at, a chip offers × to take it off in one click; ⌘Z puts it back.
    const contract = chips.filter({ hasText: "Contract" });
    await pointAt(window, library.getByTestId("library-count"));
    await expect(contract.getByTestId("remove-document-tag")).toBeHidden();
    await pointAt(window, contract);
    await pointAndClick(window, contract.getByTestId("remove-document-tag"));
    await expect(chips).toHaveText(["Invoice"]);
    await expect(window.getByTestId("undo-line")).toContainText("Contract");
    await window.keyboard.press("ControlOrMeta+z");
    await expect(chips).toHaveText(["Contract", "Invoice"]);

    // T on a focused row opens its Tags, and Esc gives the focus back to the row; ⌥⌘T does the same.
    const statement = row(finance, "Bank statement, August");
    const statementPicker = statement.getByTestId("document-tags-popover");
    await statement.locator("[data-row-main]").focus();
    await window.keyboard.press("t");
    await expect(statementPicker.getByTestId("tag-picker-input")).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(statementPicker).toBeHidden();
    await expect(statement.locator("[data-row-main]")).toBeFocused();
    await window.keyboard.press("ControlOrMeta+Alt+t");
    await expect(statementPicker.getByTestId("tag-picker-input")).toBeFocused();
    await window.keyboard.type("Invoice");
    await window.keyboard.press("Enter");
    await window.keyboard.press("Escape");
    await expect(statement.getByTestId("tag-chip")).toHaveText(["Invoice"]);

    // Two selected: T on one of them opens Tags… in the selection's bar, for both.
    const others = [row(finance, "Invoice 4502"), row(finance, "Invoice 4519")];
    for (const each of others) await pointAndClick(window, each.getByTestId("library-select"));
    const bar = library.getByTestId("library-selection");
    await expect(bar.getByTestId("library-selection-tags")).toHaveText(/^Tags…(⌥⌘T|Ctrl\+Alt\+T)$/);
    await others[1]?.locator("[data-row-main]").focus();
    await window.keyboard.press("t");
    const bulk = bar.getByTestId("selection-tags-popover");
    await expect(bulk.getByTestId("tag-picker-input")).toBeFocused();
    await window.keyboard.type("Report");
    await window.keyboard.press("Enter");
    await window.keyboard.press("Escape");
    for (const each of others) {
      await expect(each.getByTestId("tag-chip")).toHaveText(["Invoice", "Report"]);
    }
    await window.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);

    // In Chinese, at the narrowest window, the picker speaks Chinese and stays in the window.
    await setLanguage(window, "zh-CN");
    await setWindowSize(app, window, 900, 660);
    await invoice.scrollIntoViewIfNeeded();
    await pointAndClick(window, chips.first());
    await expect(picker.getByTestId("tag-picker-keys")).toHaveCount(0);
    await expect(picker.getByTestId("tag-picker-input")).toHaveAttribute(
      "title",
      "Enter 添加 · Backspace 移除",
    );
    const narrow = await picker.boundingBox();
    const width = await window.evaluate(() => innerWidth);
    if (!narrow) throw new Error("The picker isn't showing.");
    expect(narrow.x).toBeGreaterThanOrEqual(0);
    expect(narrow.x + narrow.width).toBeLessThanOrEqual(width);
    await window.keyboard.press("Escape");
  } finally {
    await app.close();
  }
});

test("the selection's bar holds at 900px and at 1,100px beside the viewer, in English and Chinese: no sideways scroll, Esc in sight, the rest under ⋯", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    const library = await openFullLibrary(window, sources);
    const bar = library.getByTestId("library-selection");
    const scroller = library.locator(":scope > div");
    const holds = async () => {
      await expect(bar).toBeVisible();
      await expect(bar.getByTestId("library-selection-clear")).toBeInViewport();
      const [barBox, pageBox, esc] = await Promise.all([
        bar.boundingBox(),
        scroller.boundingBox(),
        bar.getByTestId("library-selection-clear").boundingBox(),
      ]);
      if (!barBox || !pageBox || !esc) throw new Error("The bar isn't showing.");
      expect(barBox.x + barBox.width).toBeLessThanOrEqual(pageBox.x + pageBox.width);
      expect(esc.x + esc.width).toBeLessThanOrEqual(barBox.x + barBox.width);
      expect(await scroller.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(
        0,
      );
      // What doesn't fit waits under ⋯, which holds every command for the selection.
      await pointAndClick(window, bar.getByTestId("document-file-menu"));
      const menu = window.getByTestId("document-file-actions").filter({ visible: true });
      await expect(menu.getByTestId("document.ask")).toBeVisible();
      await expect(menu.getByTestId("document.delete")).toBeVisible();
      // Move to… among them, its picker beside ⋯ when the bar's own button has folded away.
      await pointAndClick(window, menu.getByTestId("document.moveTo"));
      const picker = window.getByTestId("move-to-picker");
      await expect(picker.getByTestId("move-to-search")).toBeFocused();
      await expect(picker).toBeInViewport();
      await window.keyboard.press("Escape");
      await expect(picker).toBeHidden();
    };
    const finance = section(library, "Finance");
    const choose = async () => {
      await pointAndClick(window, rowsOf(finance).nth(0).getByTestId("library-document-name"), {
        modifiers: ["ControlOrMeta"],
      });
      await pointAndClick(window, rowsOf(finance).nth(1).getByTestId("library-document-name"), {
        modifiers: ["ControlOrMeta"],
      });
    };
    for (const language of ["en", "zh-CN"] as const) {
      await setLanguage(window, language);
      await setWindowSize(app, window, 900, 660);
      await choose();
      await holds();
      await window.keyboard.press("Escape");
      await expect(bar).toHaveCount(0);
    }

    // At 1,100px with a Document open beside the list.
    await setLanguage(window, "en");
    await placeAssistant(window, { folded: true });
    await setWindowSize(app, window, 1100, 660);
    await pointAndClick(window, rowsOf(finance).nth(2).getByTestId("library-document-name"));
    await expect(window.getByTestId("viewer")).toBeVisible();
    for (const language of ["en", "zh-CN"] as const) {
      await setLanguage(window, language);
      await choose();
      await holds();
      await window.keyboard.press("Escape");
    }
  } finally {
    await app.close();
  }
});

test("a Folder opened from the sidebar brings its section into view, open, with the focus on its name", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1600, 660);
    const library = await openFullLibrary(window, sources);
    const last = FOLDERS.find((folder) => folder.name === "财务报表");
    if (!last) throw new Error("The fixture has no Chinese Folder.");
    const target = section(library, last.name);
    await pointAndClick(window, target.getByTestId("library-section-toggle"));
    await expect(rowsOf(target)).toHaveCount(0);
    await library.evaluate((element) => element.querySelector(":scope > div")?.scrollTo(0, 0));
    // A Tag filter from the sidebar's Tags that none of its Documents has gives way too.
    const tagFilter = library.locator('[data-testid="library-filter"][data-facet="tag"]');
    await pointAndClick(
      window,
      window.getByTestId("sidebar-tag").filter({ hasText: "Slides" }).getByTestId("row-text"),
    );
    await expect(tagFilter).toContainText("Slides");
    await expect(target).toHaveCount(0);

    const folder = sidebarFolder(window, last.name);
    await pointAt(window, folder.getByTestId("folder-row"));
    await pointAndClick(window, folder.getByTestId("folder-menu"));
    await pointAndClick(window, folder.getByTestId("folder.open"));
    await expect(target.getByTestId("library-section-name")).toBeFocused();
    await expect(target.getByTestId("library-section-name")).toBeInViewport();
    await expect(rowsOf(target)).toHaveCount(last.documents.length);
    // The page still shows every Folder.
    await expect(sections(library)).toHaveCount(FOLDERS.length + 1);
    await expect(tagFilter).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("as the window narrows the columns give way, Added first, then Format, then Tags, and names never break by letter", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    const library = await openFullLibrary(window, sources);
    await placeAssistant(window, { folded: true });
    const first = rowsOf(library).first();
    const shown = async () =>
      Promise.all(
        ["tag-chip", "library-document-format", "library-document-added"].map(
          async (id) =>
            (await first.getByTestId(id).first().count()) > 0 &&
            (await first.getByTestId(id).first().isVisible()),
        ),
      );
    const seen: boolean[][] = [];
    for (const width of [1600, 1300, 1150, 1050, 950, 900]) {
      await setWindowSize(app, window, width, 660);
      seen.push(await shown());
      // One line each: a long name is cut with "…", never wrapped.
      const heights = await rowsOf(library)
        .getByTestId("library-document-name")
        .evaluateAll((names) => names.map((name) => name.getBoundingClientRect().height));
      expect(Math.max(...heights)).toBeLessThanOrEqual(22);
    }
    expect(seen[0]).toEqual([true, true, true]);
    for (const [tags, format, added] of seen) {
      // A column shows only while every column before it in the order does.
      if (added) expect(format).toBe(true);
      if (format) expect(tags).toBe(true);
    }
    expect(seen.some(([, format, added]) => format && !added)).toBe(true);

    // At 1,100px with the Document open beside it, the rows keep their names.
    await setWindowSize(app, window, 1100, 660);
    await pointAndClick(window, first.getByTestId("library-document-name"));
    await expect(window.getByTestId("viewer")).toBeVisible();
    expect(await shown()).toEqual([false, false, false]);
    await expect(first.getByTestId("library-document-name")).toBeVisible();
    await expect
      .poll(() => library.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);
  } finally {
    await app.close();
  }
});

test("an empty Library says No Documents yet, with its two ways in beside one Add Documents", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await window.getByTestId("open-library").click();
    const library = window.getByTestId("library");
    const empty = library.getByTestId("library-empty");
    await expect(library.getByTestId("library-count")).toHaveText("0");
    await expect(empty).toContainText("No Documents yet");
    await expect(empty.getByTestId("library-empty-add-files")).toHaveText(addFilesLabel("en"));
    await expect(empty.getByTestId("library-empty-link-folder")).toHaveText(
      translate("en", "startGuide.documents.linkFolder"),
    );
    await expect(library.getByTestId("library-bar")).toHaveCount(0);
    await expect(library.getByRole("button", { name: /Add Documents/ })).toHaveCount(1);
    await pointAndClick(window, library.getByTestId("library-add-documents"));
    await expect(
      window.getByTestId("library-add-documents-items").getByRole("menuitem"),
    ).toHaveText([
      /^Files…(⌘O|Ctrl\+O)$/,
      "A folder on this computer…",
      "A web page…",
      "Find sources…",
      "Connect an app…",
      "Import references…",
    ]);
    await window.keyboard.press("Escape");
    await setLanguage(window, "zh-CN");
    await expect(empty).toContainText("还没有文档");
    await expect(empty.getByTestId("library-empty-add-files")).toHaveText(addFilesLabel("zh-CN"));
    await expect(empty.getByTestId("library-empty-link-folder")).toHaveText(
      translate("zh-CN", "startGuide.documents.linkFolder"),
    );
  } finally {
    await app.close();
  }
});
