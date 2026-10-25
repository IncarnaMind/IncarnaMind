import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge, LinkedFolder } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addToNote,
  askInAssistant,
  clickNow,
  confirmLink,
  createDataFolder,
  dismissChatSetup,
  interceptOpenDialog,
  interceptOpenPath,
  interceptShowItemInFolder,
  launchApp,
  linkedFolderRow,
  linkFolderFromSidebar,
  newMind,
  openDocumentMenu,
  openLinkedFolderMenu,
  pathsOpened,
  pathsShown,
  pointAndClick,
  previewLink,
  removeDataFolder,
  setWindowSize,
  showSourceLocations,
  useLocalChatModel,
} from "./app";

/*
 * Linked folders in the sidebar (ADR-0010): "Add folder…" previews what
 * linking takes before anything is read, the folder's row says how it is
 * (indexing, paused, unavailable, online-only files, nothing in it), its
 * menu pauses, shows and unlinks it (its Citations still
 * check), and its Documents say when their file is missing or can't be
 * reached. Set INCARNAMIND_SCREENSHOTS
 * to a folder to also save screenshots of each there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
/** Where the Linked folders are made: outside the data folder. */
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

/** The Linked folders' Document rows: in Not in a Folder, since a Linked folder's row doesn't unfold. */
const linkedRows = (window: Page) =>
  window.getByTestId("not-in-a-folder").getByTestId("document-list-item");

async function screenshot(target: Page | Locator, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** The version of the Document at `path` that is indexed, through the core's bridge. */
const contentHashOf = (window: Page, path: string) =>
  window.evaluate(async (wanted) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.listDocuments()).find((each) => each.path === wanted)?.contentHash;
  }, path);

/** The Linked folder at `path`, through the core's bridge. */
const linkedAt = (window: Page, path: string) =>
  window.evaluate(async (wanted) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.listLinkedFolders()).find((each) => each.path === wanted);
  }, path) as Promise<LinkedFolder | undefined>;

/** Writes `files` (relative paths) under `root`, each holding `text` or its own name. */
async function writeTree(root: string, files: string[], text?: string): Promise<void> {
  for (const file of files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), text ?? `${file}.\n`);
  }
}

/** Three short pages: the line about spring tides is on page 2. */
const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
  { lines: ["Tide tables", "Harbours publish the times of high water every year."] },
]);

/** Long enough for many Passages, so indexing a few of these stays on screen for a moment. */
const LONG_TEXT = Array.from(
  { length: 4000 },
  (_, index) => `Line ${index}: test loss falls as a power law in model size and data.`,
).join("\n");

/** Every file and folder under `root`, with its size, modified time, mode and content hash. */
async function snapshot(root: string): Promise<string[]> {
  const entries: string[] = [];
  const visit = async (folder: string) => {
    for (const name of (await readdir(folder)).sort()) {
      const path = join(folder, name);
      const info = await lstat(path);
      if (info.isDirectory()) {
        entries.push(`${path}/ ${info.mtimeMs}`);
        await visit(path);
      } else {
        const hash = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
        entries.push(`${path} ${info.size} ${info.mtimeMs} ${info.mode} ${hash}`);
      }
    }
  };
  await visit(root);
  return entries;
}

test("a linked folder's files become Documents, and follow edits and deletions on disk", async () => {
  const library = join(sources, "Library");
  await mkdir(join(library, "Sub"), { recursive: true });
  const notes = join(library, "Reading notes.md");
  const report = join(library, "Sub", "Report.txt");
  await writeFile(
    notes,
    "# Reading notes\n\nAttention lets a model focus on the relevant words.\n",
  );
  await writeFile(report, "Revenue grew by ten percent.\n");

  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  // "Add folder…" asks with the system's folder picker, which the test answers, then the link dialog.
  await linkFolderFromSidebar(app, window, library);
  await showSourceLocations(window);

  const items = linkedRows(window);
  await expect(items).toHaveCount(2);
  const notesItem = items.filter({ hasText: "Reading notes" });
  const reportItem = items.filter({ hasText: "Report" });
  await expect(notesItem).toHaveAttribute("data-status", "ready");
  await expect(reportItem).toHaveAttribute("data-status", "ready");
  await expect(notesItem).toHaveAttribute("data-file-status", "available");
  // The Linked folder is one row of its own.
  await expect(window.getByTestId("folder-item").filter({ hasText: "Library" })).toHaveCount(1);

  // Edited on disk: indexed again, as a new version, while the app runs.
  const before = await contentHashOf(window, notes);
  await writeFile(
    notes,
    "# Reading notes\n\nSelf-attention compares every word with every other.\n",
  );
  await expect.poll(() => contentHashOf(window, notes), { timeout: 15_000 }).not.toBe(before);
  await expect(notesItem).toHaveAttribute("data-status", "ready");
  await expect
    .poll(() =>
      window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        return (await bridge.searchPassages("Self-attention", { mode: "keyword" })).length;
      }),
    )
    .toBe(1);

  // Deleted on disk: still listed, as missing.
  await rm(report);
  await expect(reportItem).toHaveAttribute("data-file-status", "missing", { timeout: 15_000 });
  await expect(items).toHaveCount(2);
  await expect(notesItem).toHaveAttribute("data-file-status", "available");
  await app.close();
});

test("Add folder… shows what linking would take, then the folder's row shows indexing until it's done", async () => {
  const library = join(sources, "Library");
  await writeTree(
    library,
    ["Scaling laws.txt", "Chinchilla.txt", "2026/Attention.txt", "2026/Retrieval.txt"],
    LONG_TEXT,
  );
  // iCloud Drive's stubs for two files that aren't downloaded: never read, only counted.
  await writeTree(library, [".Remote paper.pdf.icloud", "2026/.Remote notes.md.icloud"], "plist");

  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await interceptShowItemInFolder(app);
  const dialog = await previewLink(app, window, library);

  // The folder, what it holds, the files it skips, and how it shows. Not how long reading takes:
  // nothing has been read on this computer yet.
  await expect(dialog.getByTestId("link-folder-name")).toHaveText("Library");
  await expect(dialog.getByTestId("link-folder-path")).toHaveText(library);
  await expect(dialog.getByTestId("link-folder-files")).toHaveText(/^4 supported files, 1\.\d MB$/);
  await expect(dialog.getByTestId("link-folder-time")).toHaveCount(0);
  await expect(dialog.getByTestId("link-folder-online-only")).toContainText(
    "2 online-only files are skipped for now",
  );
  await expect(dialog.getByTestId("link-folder-layout-tree")).toHaveCount(0);
  await expect(dialog.getByTestId("link-folder-merge")).toHaveCount(0);
  await screenshot(window, "link-dialog");
  // Nothing is linked before the User says so.
  expect(await linkedAt(window, library)).toBeUndefined();
  await confirmLink(dialog);
  await showSourceLocations(window);

  // Indexing: its count and a thin bar on the folder's one 28px row.
  const row = linkedFolderRow(window, "Library");
  await expect(row).toHaveAttribute("data-state", "indexing");
  await expect(row.getByTestId("folder-status")).toContainText(/Reading \d of 4/);
  await expect(row.getByTestId("folder-progress")).toBeVisible();
  expect((await row.boundingBox())?.height).toBeCloseTo(28, 0);
  await screenshot(window.getByTestId("sidebar"), "row-indexing");

  // Done: the bar goes, and the row says what it skipped.
  await expect(row).toHaveAttribute("data-state", "online-only", { timeout: 60_000 });
  await expect(row.getByTestId("folder-status")).toContainText("2 online-only");
  await expect(row.getByTestId("folder-progress")).toHaveCount(0);
  await expect(linkedRows(window)).toHaveCount(4);

  // Text files have been read here now, so linking another folder of them says how long it takes.
  const more = join(sources, "More");
  await writeTree(more, ["Gopher.txt", "Llama.txt"], LONG_TEXT);
  const next = await previewLink(app, window, more);
  await expect(next.getByTestId("link-folder-time")).toHaveText(
    "Reading takes under a minute, newest first.",
  );
  await screenshot(window, "link-dialog-time");
  await next.getByRole("button", { name: "Cancel" }).click();
  await expect(next).toBeHidden();

  // Its menu offers to download and index them (not done here: it would ask iCloud Drive).
  const menu = await openLinkedFolderMenu(row);
  await expect(menu.getByTestId("linkedFolder.download")).toHaveText(
    "Download and read 2 online-only files",
  );
  await expect(menu.getByTestId("linkedFolder.pause")).toHaveText("Pause reading");
  await screenshot(window, "row-menu");
  // Show in Finder (Explorer, the file manager) shows the folder itself, never anything else.
  await menu.getByTestId("linkedFolder.reveal").click();
  await expect.poll(() => pathsShown(app)).toEqual([library]);
  await app.close();
});

test("pausing a Linked folder holds its indexing until it is resumed", async () => {
  // Indexing the five long files, after the pause, takes a while with the test's embedding model.
  test.setTimeout(150_000);
  const library = join(sources, "Big library");
  await writeTree(
    library,
    Array.from({ length: 5 }, (_, index) => `Paper ${index + 1}.txt`),
    LONG_TEXT,
  );
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await linkFolderFromSidebar(app, window, library);
  await showSourceLocations(window);
  const row = linkedFolderRow(window, "Big library");
  await expect(row).toHaveAttribute("data-state", "indexing");

  let menu = await openLinkedFolderMenu(row);
  // At once, while the menu still grows in: indexing goes on meanwhile.
  await clickNow(window, menu.getByTestId("linkedFolder.pause"));
  await expect(row).toHaveAttribute("data-state", "paused");
  await expect(row.getByTestId("folder-status")).toHaveText(/^Paused/);
  const paused = await linkedAt(window, library);
  expect(paused?.status).toBe("paused");
  expect(paused?.progress.indexed).toBeLessThan(paused?.progress.files ?? 0);
  // The bar stays where it stopped, greyed, and the footer doesn't count its files as processing.
  await expect(row.getByTestId("folder-progress")).toBeVisible();
  await expect(window.getByTestId("sidebar-status")).not.toContainText("Processing");
  await screenshot(window.getByTestId("sidebar"), "row-paused");

  menu = await openLinkedFolderMenu(row);
  await expect(menu.getByTestId("linkedFolder.pause")).toHaveText("Resume reading");
  await menu.getByTestId("linkedFolder.pause").click();
  await expect(row).not.toHaveAttribute("data-state", "paused");
  await expect(row).toHaveAttribute("data-state", "idle", { timeout: 120_000 });
  await expect(row.getByTestId("folder-status")).toHaveCount(0);
  expect((await linkedAt(window, library))?.progress).toEqual({ files: 5, indexed: 5 });
  await app.close();
});

test("a Linked folder of one-file folders is a flat list, each row naming its folder", async () => {
  // Zotero's storage: a folder per item, one file in each. Twenty or more link as a flat list.
  const storage = join(sources, "storage");
  await writeTree(
    storage,
    Array.from({ length: 20 }, (_, index) => `KEY${1000 + index}/Paper ${index + 1}.txt`),
  );
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const dialog = await previewLink(app, window, storage);
  await confirmLink(dialog);
  await showSourceLocations(window);

  const documents = linkedRows(window);
  // All 20 in Not in a Folder, which lists the first five, then "Show 15 more"; each names its folder.
  const loose = window.getByTestId("not-in-a-folder");
  await expect(loose).toHaveAttribute("data-count", "20");
  await expect(documents.first()).toHaveAttribute("data-depth", "0");
  await expect(documents.first().getByTestId("row-place")).toHaveText(/^KEY10\d\d$/);
  await screenshot(window.getByTestId("sidebar"), "row-flat");
  const menu = await openLinkedFolderMenu(linkedFolderRow(window, "storage"));
  await expect(menu.getByTestId("linkedFolder.layout")).toHaveCount(0);
  await app.close();
});

// protects=two Documents with one name show which folder each is in, in the sidebar, the Library and ⌘K, and a Linked folder's row opens the Library on its own Documents (#1507); fails_when=the rows read the same, or the row only focuses; no_claim=the folders as on disk, which are Source locations' (#1250).
test("two files with one name show where each is, and a Linked folder's row opens the Library on its Documents", async () => {
  const awkward = join(sources, "awkward");
  await writeTree(awkward, [
    "same-name/2025/Annual-Report.md",
    "same-name/2025/notes.md",
    "same-name/2026/Annual-Report.md",
    "same-name/2026/notes.md",
  ]);
  const other = join(sources, "Other");
  await writeTree(other, ["Budget.md"]);
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await linkFolderFromSidebar(app, window, awkward);
  await linkFolderFromSidebar(app, window, other);
  await showSourceLocations(window);
  await expect(linkedRows(window)).toHaveCount(5, { timeout: 30_000 });

  const reports = linkedRows(window).filter({ hasText: "Annual-Report" });
  await expect(reports).toHaveCount(2);
  await expect
    .poll(async () => (await reports.getByTestId("row-place").allInnerTexts()).sort())
    .toEqual(["2025", "2026"]);
  await expect(
    linkedRows(window).filter({ hasText: "Budget" }).getByTestId("row-place"),
  ).toHaveCount(0);
  await screenshot(window.getByTestId("sidebar"), "same-name-rows");

  await linkedFolderRow(window, "awkward").getByTestId("linked-folder-open").click();
  const library = window.getByTestId("library-document");
  await expect(library).toHaveCount(4);
  await expect(library.filter({ hasText: "Budget" })).toHaveCount(0);
  await expect
    .poll(async () =>
      (
        await library
          .filter({ hasText: "notes" })
          .getByTestId("library-document-place")
          .allInnerTexts()
      ).sort(),
    )
    .toEqual(["2025", "2026"]);
  await screenshot(window, "same-name-library");

  const twins = await window.evaluate(async () => {
    const api = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const documents = await api.listDocuments();
    const idAt = (place: string) =>
      documents.find((document) => document.path.replace(/\\/g, "/").endsWith(place))?.id ?? "";
    return {
      report2025: idAt("same-name/2025/Annual-Report.md"),
      report2026: idAt("same-name/2026/Annual-Report.md"),
    };
  });

  await pointAndClick(
    window,
    window.locator(
      `[data-testid="library-document"][data-document-id="${twins.report2026}"] [data-row-main]`,
    ),
  );
  await expect(
    window.locator(`[data-testid="document-tab"][data-document-id="${twins.report2026}"]`),
  ).toHaveCount(1);

  await window.keyboard.press("ControlOrMeta+k");
  await window.getByTestId("palette-search").fill("Annual-Report");
  const found = window.getByTestId("palette").getByTestId("palette-item");
  await expect(found.filter({ hasText: "Annual-Report · 2025" })).toHaveCount(1);
  await expect(found.filter({ hasText: "Annual-Report · 2026" })).toHaveCount(1);
  await pointAndClick(
    window,
    window.locator(`[data-testid="palette"] [data-key="document:${twins.report2026}"]`),
  );
  await expect(
    window.locator(`[data-testid="document-tab"][data-document-id="${twins.report2026}"]`),
  ).toHaveCount(1);
  await app.close();
});

// protects=at 900, 1,100 and 1,600 px a short name in a folder with a long name stays whole, in the sidebar and the Library, and the place is cut instead, with the place in the Library row's tooltip (#1507); fails_when=the name shows "会…" while its place keeps the room, or the tooltip leaves the place out; no_claim=names longer than the row, which are cut as before.
test("a long place gives way before the name, in the sidebar and the Library", async () => {
  const minutes = join(sources, "纪要");
  await writeTree(minutes, [
    "二〇二五年第三季度董事会与审计委员会联席会议资料汇编/会议纪要.md",
    "二〇二六年第一季度董事会与薪酬委员会联席会议资料汇编/会议纪要.md",
  ]);
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1100, 760);
  await linkFolderFromSidebar(app, window, minutes);
  await showSourceLocations(window);
  const rows = linkedRows(window);
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  const whole = (name: Locator) =>
    name.evaluateAll((all) => all.map((each) => each.scrollWidth <= each.clientWidth));
  const cut = (place: Locator) =>
    place.evaluateAll((all) => all.map((each) => each.scrollWidth > each.clientWidth));
  for (const width of [900, 1100, 1600]) {
    await setWindowSize(app, window, width, 760);
    expect(await whole(rows.getByTestId("row-text"))).toEqual([true, true]);
    expect(await cut(rows.getByTestId("row-place"))).toEqual([true, true]);
  }
  await setWindowSize(app, window, 1100, 760);
  await screenshot(window.getByTestId("sidebar"), "long-place-rows");

  await linkedFolderRow(window, "纪要").getByTestId("linked-folder-open").click();
  const library = window.getByTestId("library-document");
  await expect(library).toHaveCount(2);
  for (const width of [900, 1100, 1600]) {
    await setWindowSize(app, window, width, 760);
    expect(await whole(library.getByTestId("library-document-name"))).toEqual([true, true]);
    await expect(library.first().locator("[data-row-main]")).toHaveAttribute(
      "title",
      /^会议纪要 · 二〇二\S+汇编\n/,
    );
  }
  await setWindowSize(app, window, 1100, 760);
  await screenshot(window, "long-place-library");
  await app.close();
});

test("a small library of one-file folders keeps its folders", async () => {
  const library = join(sources, "Reading");
  await writeTree(library, ["Week 1/Notes.txt", "Week 2/Notes.txt", "Week 3/Notes.txt"]);
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const dialog = await previewLink(app, window, library);
  await confirmLink(dialog);
  await showSourceLocations(window);
  await expect
    .poll(() =>
      window.evaluate(
        async () =>
          (
            await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listFolders()
          ).filter((folder) => folder.parentId !== null).length,
      ),
    )
    .toBe(3);
  // Each row names its folder too, until Source locations show the folders as on disk (#1250).
  await expect
    .poll(async () => (await linkedRows(window).getByTestId("row-place").allTextContents()).sort())
    .toEqual(["Week 1", "Week 2", "Week 3"]);
  await app.close();
});

test("a file deleted on disk shows as missing, still opens, and can be removed from IncarnaMind", async () => {
  const library = join(sources, "Library");
  await writeTree(library, ["Kept.txt", "Deleted later.txt"]);
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await interceptOpenPath(app);
  await interceptShowItemInFolder(app);
  await linkFolderFromSidebar(app, window, library);
  await showSourceLocations(window);
  const row = linkedFolderRow(window, "Library");
  await expect(row).toHaveAttribute("data-state", "idle");
  const items = linkedRows(window);
  const doomed = items.filter({ hasText: "Deleted later" });
  await expect(doomed).toHaveAttribute("data-status", "ready");

  await rm(join(library, "Deleted later.txt"));
  await expect(doomed).toHaveAttribute("data-file-status", "missing", { timeout: 15_000 });
  // Muted, with "Missing" at its end, on its one 28px line.
  const status = doomed.getByTestId("document-status");
  await expect(status).toHaveText(/^Missing/);
  await expect(status).toHaveAttribute("title", /File missing/);
  await expect(doomed).toHaveCSS("color", "rgb(101, 107, 116)");
  expect((await doomed.boundingBox())?.height).toBeCloseTo(28, 0);
  await screenshot(window.getByTestId("sidebar"), "document-missing");

  // Opening it still opens the viewer, as for any Document, which says its file is missing.
  await doomed.getByTestId("open-document").click();
  await expect(window.getByTestId("viewer")).toBeVisible();
  await expect(window.getByTestId("viewer-removed")).toContainText("is missing from its folder");

  // Its file can't be opened or shown: the items say why, and do nothing.
  await openDocumentMenu(doomed);
  const actions = doomed.getByTestId("document-file-actions");
  for (const id of ["document.openExternally", "document.showInFolder"]) {
    const item = actions.getByTestId(id);
    await expect(item).toHaveAttribute("aria-disabled", "true");
    await expect(item).toHaveAttribute("title", "The file is missing from its folder.");
  }
  await screenshot(window, "document-missing-menu");
  // Clicked anyway (Playwright would wait for them to be enabled): nothing happens.
  await actions.getByTestId("document.openExternally").click({ force: true });
  await actions.getByTestId("document.showInFolder").click({ force: true });
  expect(await pathsOpened(app)).toEqual([]);
  expect(await pathsShown(app)).toEqual([]);

  // "Remove from IncarnaMind" asks nothing: the row goes, to Recently deleted.
  await actions.getByTestId("document.delete").click();
  await expect(doomed).toHaveCount(0);
  await expect(items).toHaveCount(1);
  await app.close();
});

test("unlinking asks first, and leaves the folder on disk exactly as it was", async () => {
  const library = join(sources, "Library");
  await writeTree(library, ["Paper.txt", "Notes/Reading notes.md", "Notes/Deep/Draft.txt"]);
  const before = await snapshot(library);
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await linkFolderFromSidebar(app, window, library);
  await showSourceLocations(window);
  const row = linkedFolderRow(window, "Library");
  await expect(row).toHaveAttribute("data-state", "idle");
  const items = linkedRows(window);
  await expect(items).toHaveCount(3);

  // Cancel changes nothing.
  let menu = await openLinkedFolderMenu(row);
  await menu.getByTestId("linkedFolder.unlink").click();
  const dialog = window.getByTestId("unlink-folder-dialog");
  await expect(dialog.getByRole("heading")).toHaveText("Unlink “Library”?");
  await expect(dialog).toContainText("Your files aren’t touched.");
  await expect(dialog).toContainText("It keeps only what your Citations quote");
  await screenshot(window, "unlink-dialog");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(items).toHaveCount(3);

  menu = await openLinkedFolderMenu(row);
  await menu.getByTestId("linkedFolder.unlink").click();
  await dialog.getByTestId("confirm-unlink-folder").click();
  await expect(row).toHaveCount(0);
  await expect(items).toHaveCount(0);
  expect(await linkedAt(window, library)).toBeUndefined();
  // Nothing linked: the Linked folders section is gone with it.
  await expect(window.getByTestId("linked-folders-section")).toHaveCount(0);
  // Byte for byte, time for time, as it was.
  expect(await snapshot(library)).toEqual(before);
  await app.close();
});

test("after unlinking, a Citation of a Document in the folder still says its quote was found, and linked again it opens the Document", async () => {
  const library = join(sources, "Library");
  await mkdir(library, { recursive: true });
  await writeFile(join(library, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await linkFolderFromSidebar(app, window, library);
  await showSourceLocations(window);
  const row = linkedFolderRow(window, "Library");
  await expect(row).toHaveAttribute("data-state", "idle");

  await newMind(window);
  await window.getByTestId("mind-editor").click();
  const answer = await askInAssistant(window, "When do spring tides happen?");
  const citation = answer.getByTestId("citation");
  await expect(citation).toHaveAttribute("data-check", "found");

  const menu = await openLinkedFolderMenu(row);
  await menu.getByTestId("linkedFolder.unlink").click();
  await window.getByTestId("confirm-unlink-folder").click();
  await expect(row).toHaveCount(0);
  await expect(linkedRows(window)).toHaveCount(0);

  // The page it quotes is kept, so its check stands.
  await expect(citation).toHaveAttribute("data-check", "found");
  await expect(citation.locator(".citation-marker-icon")).toBeVisible();
  await citation.getByTestId("citation-chip").click();
  await expect(window.getByTestId("citation-badge")).toHaveText("Quote found on p. 2");
  // The viewer shows the quote, and says the folder was unlinked: the Document wasn't deleted.
  const removed = window.getByTestId("viewer-removed");
  await expect(removed).toContainText("Spring tides happen at new moon and at full moon.");
  await expect(removed).toContainText(
    "This Document’s Linked folder was unlinked. IncarnaMind kept the text your Citation quotes.",
  );
  await expect(removed).not.toContainText("deleted");
  await screenshot(window, "unlinked-citation");
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("citation-card")).toBeHidden();

  // Linked again, the file is found again by its content: the Citation opens it at its page.
  await linkFolderFromSidebar(app, window, library);
  await showSourceLocations(window);
  await expect(linkedFolderRow(window, "Library")).toHaveAttribute("data-state", "idle");
  await expect(linkedRows(window)).toHaveCount(1);
  await citation.getByTestId("citation-chip").click();
  await expect(window.getByTestId("citation-badge")).toHaveText("Quote found on p. 2");
  await expect(window.getByTestId("viewer-title")).toHaveText("Tides");
  await expect(window.getByTestId("pdf-page-number")).toHaveValue("2");
  await app.close();
});

test("a Linked folder that can't be reached shows as unavailable, and so do its Documents", async () => {
  const drive = join(sources, "Drive");
  await writeTree(drive, ["Field notes.txt", "Survey.md"]);
  let running = await launchApp(dataDir);
  await dismissChatSetup(running.window);
  await linkFolderFromSidebar(running.app, running.window, drive);
  await showSourceLocations(running.window);
  await expect(linkedFolderRow(running.window, "Drive")).toHaveAttribute("data-state", "idle");
  await running.app.close();

  // The drive is unplugged while the app is closed.
  await rename(drive, join(sources, "Drive (unplugged)"));
  running = await launchApp(dataDir);
  const { window } = running;
  await showSourceLocations(window);
  const row = linkedFolderRow(window, "Drive");
  await expect(row).toHaveAttribute("data-state", "unavailable", { timeout: 15_000 });
  await expect(row.getByTestId("folder-status")).toHaveText(/^Unavailable/);
  await expect(row).toHaveCSS("color", "rgb(101, 107, 116)");
  const items = linkedRows(window);
  await expect(items).toHaveCount(2);
  for (const item of await items.all()) {
    await expect(item).toHaveAttribute("data-file-status", "unavailable");
    await expect(item.getByTestId("document-status")).toHaveText(/^Unavailable/);
  }
  await screenshot(window.getByTestId("sidebar"), "row-unavailable");

  const menu = await openLinkedFolderMenu(row);
  await expect(menu.getByTestId("linkedFolder.reveal")).toHaveAttribute("aria-disabled", "true");
  await expect(menu.getByTestId("linkedFolder.reveal")).toHaveAttribute(
    "title",
    "The folder can’t be reached right now.",
  );
  await window.keyboard.press("Escape");
  await openDocumentMenu(items.first());
  await expect(
    items.first().getByTestId("document-file-actions").getByTestId("document.openExternally"),
  ).toHaveAttribute("title", "The file can’t be reached right now.");
  await window.keyboard.press("Escape");
  // The viewer says so too, rather than that the Document was deleted.
  await items.first().getByTestId("open-document").click();
  await expect(window.getByTestId("viewer-removed")).toContainText("right now (drive unplugged?)");
  await expect(window.getByTestId("viewer-removed")).not.toContainText("deleted");
  await running.app.close();
});

test("a Linked folder that moved is located from its menu, and its Document and the Citation quoting it come back as they were", async () => {
  const library = join(sources, "Library");
  await mkdir(library, { recursive: true });
  await writeFile(join(library, "Tides.pdf"), TIDES);
  const first = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(first.window);
  await useLocalChatModel(first.window);
  await linkFolderFromSidebar(first.app, first.window, library);
  await showSourceLocations(first.window);
  await expect(linkedFolderRow(first.window, "Library")).toHaveAttribute("data-state", "idle");
  await newMind(first.window);
  await first.window.getByTestId("mind-editor").click();
  const answer = await askInAssistant(first.window, "When do spring tides happen?");
  await expect(answer.getByTestId("citation")).toHaveAttribute("data-check", "found");
  await addToNote(first.window, answer);
  await expect(first.window.getByTestId("mind-editor").getByTestId("citation")).toHaveAttribute(
    "data-check",
    "found",
  );
  const before = await first.window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.listDocuments()).map(({ id, contentHash }) => ({ id, contentHash }));
  });
  await first.app.close();

  // Moved and renamed while the app was closed, as when the data folder is opened on another computer.
  const moved = join(sources, "Archive", "Library 2026");
  await mkdir(dirname(moved));
  await rename(library, moved);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await showSourceLocations(window);
  const row = linkedFolderRow(window, "Library");
  await expect(row).toHaveAttribute("data-state", "unavailable", { timeout: 15_000 });
  await expect(row.getByTestId("folder-status")).toHaveAttribute(
    "title",
    /If it moved, use Locate folder…$/,
  );

  await interceptOpenDialog(app, moved);
  const menu = await openLinkedFolderMenu(row);
  await menu.getByTestId("linkedFolder.locate").click();
  const located = linkedFolderRow(window, "Library 2026");
  await expect(located).toHaveAttribute("data-state", "idle", { timeout: 15_000 });
  await expect(located.getByTestId("linked-folder-open")).toHaveAttribute("title", moved);
  const item = linkedRows(window);
  await expect(item).toHaveCount(1);
  await expect(item).toHaveAttribute("data-file-status", "available");
  // The same Document and version, not a new one.
  expect(
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return (await bridge.listDocuments()).map(({ id, contentHash }) => ({ id, contentHash }));
    }),
  ).toEqual(before);

  await window.getByTestId("mind-tab").click();
  const citation = window.getByTestId("mind-editor").getByTestId("citation");
  await expect(citation).toHaveAttribute("data-check", "found");
  await citation.getByTestId("citation-chip").click();
  await expect(window.getByTestId("citation-badge")).toHaveText("Quote found on p. 2");
  await expect(window.getByTestId("viewer-title")).toHaveText("Tides");
  await expect(window.getByTestId("pdf-page-number")).toHaveValue("2");
  await screenshot(window, "located-folder");

  // A folder that doesn't hold its files is refused, in plain words, and nothing changes.
  await interceptOpenDialog(app, sources);
  await (await openLinkedFolderMenu(located)).getByTestId("linkedFolder.locate").click();
  await expect(window.getByRole("alert")).toHaveText(
    /^That didn’t work: That folder doesn’t hold “Library 2026”’s files\. Choose the folder that does\./,
  );
  await expect(located).toHaveAttribute("data-state", "idle");
  await expect(item).toHaveAttribute("data-file-status", "available");
  await app.close();
});

test("in Chinese a folder that doesn't hold the Linked folder's files is refused in Chinese, and its Details stay English", async () => {
  const library = join(sources, "Library");
  const empty = join(sources, "Empty");
  await mkdir(empty);
  await writeTree(library, ["Tides.md"], "Spring tides happen at new moon and at full moon.\n");
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 900, 660);
    await linkFolderFromSidebar(app, window, library);
    await showSourceLocations(window);
    const row = linkedFolderRow(window, "Library");
    await expect(row).toHaveAttribute("data-state", "idle");
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ user: { language: "zh-CN" } });
    });

    await interceptOpenDialog(app, empty);
    await (await openLinkedFolderMenu(row)).getByTestId("linkedFolder.locate").click();
    const notice = window.getByTestId("error-notice");
    await expect(notice.getByTestId("error-notice-message")).toHaveText(
      "无法完成操作：这个文件夹中没有“Library”的文件。请选择存放这些文件的文件夹。",
    );
    const details = notice.getByTestId("error-notice-details");
    await details.getByText("详情").click();
    await expect(details).toContainText("core:locateLinkedFolder");
    await expect(details).toContainText(
      "InvalidInputError: That folder doesn’t hold “Library”’s files. Choose the folder that does.",
    );
    await screenshot(window, "locate-refused-zh-900");
    await setWindowSize(app, window, 1600, 900);
    await expect(notice).toBeVisible();
    await screenshot(window, "locate-refused-zh-1600");
    await expect(row).toHaveAttribute("data-state", "idle");
    expect((await linkedAt(window, library))?.path).toBe(library);
  } finally {
    await app.close();
  }
});

test("an empty Linked folder says so, in its section, which comes with it", async () => {
  const empty = join(sources, "Projects");
  await mkdir(empty);
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);

  // An empty sidebar says nothing: no section waits for its first item.
  await expect(window.getByTestId("linked-folders-section")).toHaveCount(0);
  await expect(window.getByTestId("sidebar-sections")).toHaveText("");

  // The + menu's More › Link a folder….
  const dialog = await previewLink(app, window, empty);
  await expect(dialog.getByTestId("link-folder-files")).toHaveText(
    "No supported files yet. Files added later are read.",
  );
  await expect(dialog.getByTestId("link-folder-time")).toHaveCount(0);
  await confirmLink(dialog);
  await expect(window.getByTestId("linked-folders-section")).toBeVisible();

  const row = linkedFolderRow(window, "Projects");
  await expect(row).toHaveAttribute("data-state", "empty");
  await expect(row.getByTestId("folder-status")).toHaveText(/^No supported files/);
  // A row that never unfolds.
  await expect(row.getByTestId("linked-folder-open")).not.toHaveAttribute("aria-expanded");
  await screenshot(window.getByTestId("sidebar"), "row-empty");
  await app.close();
});

test("linking a folder that overlaps a Linked folder says what happens: they merge, or nothing changes", async () => {
  const papers = join(sources, "Papers");
  await writeTree(papers, [
    "Survey.txt",
    "2026/Attention.txt",
    "2026/Drafts/Draft.txt",
    "2027/Scaling.txt",
  ]);
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await linkFolderFromSidebar(app, window, join(papers, "2026"));
  await showSourceLocations(window);
  await expect(linkedFolderRow(window, "2026")).toHaveAttribute("data-state", "idle");

  // A folder inside it is linked already: the dialog says so, and only closes.
  await interceptOpenDialog(app, join(papers, "2026", "Drafts"));
  await window.getByTestId("plus-menu").click();
  await window.getByTestId("plus-more").click();
  await window.getByTestId("plus-link-folder").click();
  const dialog = window.getByTestId("link-folder-dialog");
  await expect(dialog.getByRole("heading")).toHaveText("Already in IncarnaMind");
  await expect(dialog.getByTestId("link-folder-inside")).toContainText(
    "This folder is inside the Linked folder “2026”",
  );
  await expect(dialog.getByTestId("link-folder-confirm")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();

  // The folder around it: the Linked folder inside merges into it, its Documents with it.
  const around = await previewLink(app, window, papers);
  await expect(around.getByTestId("link-folder-merge")).toContainText(
    "“2026”, already linked, merges into this folder",
  );
  await screenshot(window, "link-dialog-merge");
  await confirmLink(around);
  await showSourceLocations(window);
  await expect(linkedFolderRow(window, "Papers")).toHaveAttribute("data-state", "idle");
  await expect(linkedFolderRow(window, "2026")).toHaveCount(0);
  await expect(linkedRows(window)).toHaveCount(4);
  await app.close();
});
