import { copyFile, mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge, Document } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  interceptShowItemInFolder,
  launchApp,
  linkedFolderRow,
  linkFolderFromSidebar,
  newMind,
  openDocumentMenu,
  openLinkedFolderMenu,
  pathsShown,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  showSourceLocations,
} from "./app";

/*
 * Get info (⌘I, or in a Document's or Linked folder's menu) and Copy path
 * (#249): a small panel with what is known of the file, and its path on this
 * computer on the clipboard. Set INCARNAMIND_SCREENSHOTS to a folder to also
 * save screenshots of the panel there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const FIXTURES = join(__dirname, "..", "tests", "fixtures", "formats");
const PRIMARY = "ControlOrMeta";

const REPORT = buildPdf(
  [
    { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
    { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
  ],
  { info: { CreationDate: "D:20190304103000Z" } },
);

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

async function screenshot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== "running"),
  );
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** What the clipboard would hold: the real one is the User's, so the page's write is caught instead. */
async function stubCopy(window: Page) {
  await window.evaluate(() => {
    const held = { text: "" };
    (globalThis as { copiedText?: unknown }).copiedText = held;
    navigator.clipboard.writeText = async (text: string) => {
      held.text = text;
    };
  });
  return () =>
    window.evaluate(() => (globalThis as { copiedText?: { text: string } }).copiedText?.text ?? "");
}

const documentsOf = (window: Page) =>
  window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return await bridge.listDocuments();
  }) as Promise<Document[]>;

test("Get info shows what is known of a PDF, a Word file, a spreadsheet and a deck, by ⌘I and by the menu, and Esc closes it", async () => {
  await writeFile(join(sources, "Report.pdf"), REPORT);
  for (const name of [
    "Coastal Flood Risk Review.docx",
    "Quarterly Research Update.pptx",
    "Regional Revenue.xlsx",
  ]) {
    await copyFile(join(FIXTURES, name), join(sources, name));
  }
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1400, 800);
  await addDocuments(
    window,
    [
      "Report.pdf",
      "Coastal Flood Risk Review.docx",
      "Quarterly Research Update.pptx",
      "Regional Revenue.xlsx",
    ].map((name) => join(sources, name)),
  );
  const documents = await documentsOf(window);
  const panel = window.getByTestId("info-panel");
  const items = window.getByTestId("document-list-item");

  const expected = [
    { name: "Report", kind: "PDF", count: /2 pages/ },
    { name: "Coastal Flood Risk Review", kind: "Word", count: null },
    { name: "Quarterly Research Update", kind: "PowerPoint", count: /\d+ slides?/ },
    { name: "Regional Revenue", kind: "Excel", count: /\d+ sheets?/ },
  ];
  for (const { name, kind, count } of expected) {
    const document = documents.find((each) => each.name === name);
    if (!document) throw new Error(`No Document called ${name}.`);
    const row = items.filter({ hasText: name });

    // ⌘I with the keyboard in the list.
    await row.getByTestId("open-document").focus();
    await window.keyboard.press(`${PRIMARY}+i`);
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("info-name")).toHaveText(name);
    const summary = panel.getByTestId("info-summary");
    await expect(summary).toContainText(kind);
    if (count) await expect(summary).toHaveText(count);
    await expect(summary).toContainText(/\d+(\.\d)? (KB|MB)/);
    await expect(panel.getByTestId("info-path")).toHaveText(document.path);
    await expect(panel.getByTestId("info-from")).toHaveText("Other Documents");
    await expect(panel.getByTestId("info-folder")).toHaveText("Not in a Folder");
    await expect(panel.getByTestId("info-added")).toHaveText(/\d{4}/);
    await expect(panel.getByTestId("info-status")).toHaveText("Ready");
    if (document.creationDate) {
      await expect(panel.getByTestId("info-created")).toContainText("(the file’s own date)");
    } else {
      await expect(panel.getByTestId("info-created")).toHaveCount(0);
    }
    if (name === "Report") {
      await expect(panel.getByTestId("info-created")).toHaveText(
        "4 Mar 2019 (the file’s own date)",
      );
      await screenshot(window, "get-info-pdf");
    }
    // Esc closes it, and the focus is back on the row.
    await window.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(row.getByTestId("open-document")).toBeFocused();
  }

  // The same panel from the menu, opened with the mouse.
  const report = items.filter({ hasText: "Report" });
  await openDocumentMenu(report);
  const menu = report.getByTestId("document-file-actions");
  await expect(menu.getByTestId("file.info")).toHaveText(/^Get info(⌘I|Ctrl\+I)$/);
  await pointAndClick(window, menu.getByTestId("file.info"));
  await expect(panel.getByTestId("info-name")).toHaveText("Report");
  // It sits beside the row it is about, inside the window.
  const beside = await panel.boundingBox();
  const rowBox = await report.boundingBox();
  const viewport = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  if (!beside || !rowBox) throw new Error("The panel or its row isn't visible.");
  expect(beside.x).toBeGreaterThanOrEqual(rowBox.x + rowBox.width - 1);
  expect(beside.x + beside.width).toBeLessThanOrEqual(viewport.width);
  expect(beside.y + beside.height).toBeLessThanOrEqual(viewport.height);
  await window.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await app.close();
});

test("⌘I in the note still makes the text italic", async () => {
  const { window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type("Tides follow the Moon");
  await window.keyboard.press(`${PRIMARY}+a`);
  await window.keyboard.press(`${PRIMARY}+i`);
  await expect(editor.locator("em")).toHaveText("Tides follow the Moon");
  await expect(window.getByTestId("info-panel")).toHaveCount(0);
});

test("Copy path puts a Document's full path, and a Linked folder's, on the clipboard and shows Copied, which goes by itself", async () => {
  const library = join(sources, "Library");
  await mkdir(library, { recursive: true });
  await writeFile(join(library, "Tides.pdf"), REPORT);
  await writeFile(join(sources, "Alone.pdf"), REPORT);
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await interceptShowItemInFolder(app);
  await addDocuments(window, [join(sources, "Alone.pdf")]);
  await linkFolderFromSidebar(app, window, library);
  await showSourceLocations(window);
  const copied = await stubCopy(window);
  const copiedLine = window.getByTestId("copied-line");

  // A Document, from its menu: the file group puts it after Open in default app and Show in folder.
  const alone = window.getByTestId("document-list-item").filter({ hasText: "Alone" });
  await expect(alone).toBeVisible();
  await openDocumentMenu(alone);
  const actions = alone.getByTestId("document-file-actions");
  const ids = await actions
    .getByRole("menuitem")
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-testid")));
  const file = ids.slice(ids.indexOf("document.openExternally"));
  expect(file.slice(0, 4)).toEqual([
    "document.openExternally",
    "document.showInFolder",
    "file.copyPath",
    "file.info",
  ]);
  await pointAndClick(window, actions.getByTestId("file.copyPath"));
  expect(await copied()).toBe(join(sources, "Alone.pdf"));
  await expect(copiedLine).toHaveText("Copied");
  await expect(copiedLine).toHaveText("", { timeout: 10_000 });

  // By its key, from the list.
  await alone.getByTestId("open-document").focus();
  await window.keyboard.press(`${PRIMARY}+Alt+c`);
  await expect(copiedLine).toHaveText("Copied");

  // A Linked folder.
  const row = linkedFolderRow(window, "Library");
  const menu = await openLinkedFolderMenu(row);
  const entries = await menu
    .getByRole("menuitem")
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-testid")));
  expect(entries.indexOf("file.copyPath")).toBe(entries.indexOf("linkedFolder.reveal") + 1);
  await pointAndClick(window, menu.getByTestId("file.copyPath"));
  expect(await copied()).toBe(library);
  await expect(copiedLine).toHaveText("Copied");

  // Its info: path, files, size and state, with Copy path and Show in Finder in the panel.
  const panel = window.getByTestId("info-panel");
  await window.keyboard.press("Escape");
  await row.getByTestId("row-text").focus();
  await window.keyboard.press(`${PRIMARY}+i`);
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("info-path")).toHaveText(library);
  await expect(panel.getByTestId("info-files")).toHaveText("1 file");
  await expect(panel.getByTestId("info-size")).toHaveText(/\d+(\.\d)? KB/);
  await expect(panel.getByTestId("info-status")).toHaveText("Up to date");
  await screenshot(window, "get-info-linked-folder");
  await panel.getByTestId("info-copy-path").click();
  await expect(panel.getByTestId("info-copy-path")).toHaveText("Copied");
  await panel.getByTestId("info-show").click();
  await expect.poll(() => pathsShown(app)).toEqual([library]);

  // A Linked folder that can't be reached says so, and has nothing to show.
  await window.keyboard.press("Escape");
  await rename(library, `${library}-away`);
  await expect(row).toHaveAttribute("data-state", "unavailable", { timeout: 15_000 });
  await row.getByTestId("row-text").focus();
  await window.keyboard.press(`${PRIMARY}+i`);
  await expect(panel.getByTestId("info-status")).toContainText("Can’t reach this folder");
  await expect(panel.getByTestId("info-show")).toHaveCount(0);
  await app.close();
});

test("Get info on a file that is missing says so, and a long path and Chinese names fit, in both languages", async () => {
  const deep = join(
    sources,
    "A very long folder name for the contracts of the year",
    "and another one inside it that goes on",
  );
  await mkdir(deep, { recursive: true });
  await writeFile(join(deep, "季度报告.pdf"), REPORT);
  await writeFile(join(deep, "Gone.pdf"), REPORT);
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 900, 700);
  await linkFolderFromSidebar(app, window, sources);
  await showSourceLocations(window);
  const items = window.getByTestId("not-in-a-folder").getByTestId("document-list-item");
  await expect(items).toHaveCount(2);
  await expect(items.first()).toHaveAttribute("data-status", "ready");
  await expect(items.nth(1)).toHaveAttribute("data-status", "ready");
  await rm(join(deep, "Gone.pdf"));
  const gone = items.filter({ hasText: "Gone" });
  await expect(gone).toHaveAttribute("data-file-status", "missing", { timeout: 15_000 });

  const panel = window.getByTestId("info-panel");
  await gone.getByTestId("open-document").focus();
  await window.keyboard.press(`${PRIMARY}+i`);
  await expect(panel.getByTestId("info-status")).toContainText(
    "File missing: Citations keep its text; searches skip it.",
  );
  await expect(panel.getByTestId("info-show")).toHaveCount(0);
  await expect(panel.getByTestId("info-copy-path")).toBeVisible();
  await window.keyboard.press("Escape");

  const chinese = items.filter({ hasText: "季度报告" });
  for (const language of ["en", "zh-CN"] as const) {
    await window.evaluate(async (chosen) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ user: { language: chosen } });
    }, language);
    await chinese.getByTestId("open-document").focus();
    await window.keyboard.press(`${PRIMARY}+i`);
    await expect(panel.getByTestId("info-name")).toHaveText("季度报告");
    await expect(panel.getByTestId("info-path")).toHaveText(join(deep, "季度报告.pdf"));
    // The whole long path is there, wrapped inside the panel, which stays inside the window.
    const box = await panel.boundingBox();
    const path = await panel.getByTestId("info-path").boundingBox();
    if (!box || !path) throw new Error("The panel isn't visible.");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(900);
    expect(path.x + path.width).toBeLessThanOrEqual(box.x + box.width);
    expect((await stat(join(deep, "季度报告.pdf"))).size).toBeGreaterThan(0);
    if (language === "zh-CN") {
      await expect(panel.getByTestId("info-status")).toHaveText("就绪");
      await expect(panel.getByTestId("info-copy-path")).toHaveText("复制路径");
    }
    await screenshot(window, `get-info-narrow-${language}`);
    await window.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  }
  await app.close();
});
