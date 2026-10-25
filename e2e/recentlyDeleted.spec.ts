import { createHash } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  openDocumentMenu,
  openManageTags,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  sidebarFolder,
} from "./app";

/*
 * Recently deleted (#228): deleting a Mind, Document, Folder or Tag asks nothing and shows
 * the undo line; the Library's Recently deleted view lists them, newest first, with Restore
 * and Delete Permanently, the only question. Set INCARNAMIND_SCREENSHOTS to a folder to also
 * save screenshots there.
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

async function screenshot(target: Page | Locator, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** Reads the core through the bridge (or changes it, as from another window). */
function read<T>(window: Page, query: (core: CoreBridge) => Promise<T>): Promise<T>;
function read<T, A>(
  window: Page,
  query: (core: CoreBridge, arg: A) => Promise<T>,
  arg: A,
): Promise<T>;
async function read(
  window: Page,
  query: (core: CoreBridge, arg?: unknown) => Promise<unknown>,
  arg?: unknown,
): Promise<unknown> {
  return (await coreOf(window)).evaluate(query, arg);
}

/** What the core holds that deleting and restoring touch, to compare before and after. */
const stateOf = (window: Page) =>
  read(window, async (core) => {
    const library = await core.getLibrary();
    const byName = (a: string, b: string) => a.localeCompare(b);
    return {
      folders: library.groups.map((group) => `${group.id}:${group.name}`).sort(byName),
      minds: (await core.listMinds()).map((mind) => `${mind.title}:${mind.folderId}`).sort(byName),
      documents: (await core.listDocuments())
        .map(
          (document) =>
            `${document.name}:${
              library.assignments.find((item) => item.documentId === document.id)?.groupId ?? null
            }`,
        )
        .sort(byName),
      tags: (await core.listTags()).map((tag) => tag.name).sort(byName),
    };
  });

const deletedNames = (window: Page) =>
  read(window, async (core) => (await core.listDeleted()).map((item) => item.name));

const undoLine = (window: Page) => window.getByTestId("undo-line");
const noQuestion = (window: Page) => expect(window.locator("dialog[open]")).toHaveCount(0);
const rows = (window: Page) => window.getByTestId("deleted-item");
const row = (window: Page, name: string) => rows(window).filter({ hasText: name });

/** Recently deleted, at the foot of the Library page: its section, opened if it was folded. */
async function openDeleted(window: Page): Promise<Locator> {
  await pointAndClick(window, window.getByTestId("open-library"));
  const head = window.getByTestId("deleted-section-head");
  if ((await head.getAttribute("data-open")) === "false") {
    await pointAndClick(window, head.getByTestId("deleted-heading"));
  }
  await expect(head).toHaveAttribute("data-open", "true");
  return window.getByTestId("recently-deleted");
}

/** Gone from the page once nothing waits in it. */
const nothingDeleted = (window: Page) =>
  expect(window.getByTestId("recently-deleted")).toHaveCount(0);

const TIDE_NOTES = "# Tide notes\n\nSpring tides happen at new moon and at full moon.\n";

// Where the old layout (before ADR-0010) kept a Document's copy: the data folder's documents
// folder, named by its content's hash.
async function addOldLayoutCopy(window: Page): Promise<string> {
  const hash = createHash("sha256").update(TIDE_NOTES).digest("hex");
  const copy = join(dataDir, "documents", `${hash}.md`);
  await mkdir(join(dataDir, "documents"), { recursive: true });
  await writeFile(copy, TIDE_NOTES);
  await addDocuments(window, [copy]);
  await read(window, async (core) => {
    const [document] = await core.listDocuments();
    if (document) await core.renameDocument(document.id, "Tide notes");
  });
  return copy;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

async function deleteFromSidebar(window: Page, name: string): Promise<void> {
  const item = window
    .getByTestId("sidebar")
    .getByTestId("document-list-item")
    .filter({ hasText: name });
  await openDocumentMenu(item);
  await item.getByTestId("document-file-actions").getByTestId("document.delete").click();
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText(
    `Moved “${name}” to Recently deleted`,
  );
}

async function restoreAndOpen(window: Page, name: string): Promise<Locator> {
  await openDeleted(window);
  await row(window, name).getByTestId("deleted-restore").click();
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText(`Restored “${name}”`);
  const item = window
    .getByTestId("sidebar")
    .getByTestId("document-list-item")
    .filter({ hasText: name });
  await item.getByTestId("open-document").click();
  const viewer = window.getByTestId("viewer");
  await expect(viewer).toBeVisible();
  return viewer;
}

test("deleting a Mind, a Document, a Folder and a Tag asks nothing and lands in Recently deleted; Restore puts each back exactly", async () => {
  test.setTimeout(120_000);
  const invoice = join(sources, "Invoice 4471.txt");
  await writeFile(invoice, "Invoice 4471: the rent for October is due on the first.\n");
  const { window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const finance = await read(
    window,
    async (core) => (await core.createLibraryGroup({ name: "Finance", description: "" })).id,
  );
  await addDocuments(window, [invoice]);
  await read(
    window,
    async (core, folderId) => {
      const [document] = await core.listDocuments();
      if (document) await core.assignDocumentGroup(document.id, folderId);
      await core.createMind({ title: "Shortlist", folderId });
      await core.createTag({ name: "Vendor" });
    },
    finance,
  );
  const before = await stateOf(window);
  expect(before.minds).toEqual([`Shortlist:${finance}`]);
  expect(before.documents).toEqual([`Invoice 4471:${finance}`]);

  // A Mind, from its menu, in its open Folder.
  await sidebarFolder(window, "Finance").getByTestId("folder-row").click();
  const mind = window.getByTestId("mind-row").filter({ hasText: "Shortlist" });
  await mind.hover();
  await mind.getByTestId("mind-menu").click();
  await mind.getByTestId("mind-actions").getByTestId("mind.delete").click();
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText(
    "Moved “Shortlist” to Recently deleted",
  );
  await screenshot(undoLine(window), "undo-line-en");
  await noQuestion(window);

  // A Tag, in Manage Tags, from ⌘K.
  await openManageTags(window);
  const slides = window.locator('[data-testid="tag-row"]', { hasText: "Vendor" });
  await pointAndClick(window, slides.getByTestId("delete-tag"));
  await expect(slides).toHaveCount(0);
  await expect(window.locator("dialog[open]")).toHaveCount(1);
  await pointAndClick(window, window.getByRole("button", { name: "Done" }));
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText(
    "Moved “Vendor” to Recently deleted",
  );

  // A Document, from its menu.
  const document = window.getByTestId("document-list-item").filter({ hasText: "Invoice 4471" });
  await openDocumentMenu(document);
  await document.getByTestId("document-file-actions").getByTestId("document.delete").click();
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText(
    "Moved “Invoice 4471” to Recently deleted",
  );
  await noQuestion(window);

  // A Folder, from its menu.
  const folder = sidebarFolder(window, "Finance");
  await folder.getByTestId("folder-row").hover();
  await folder.getByTestId("folder-menu").click();
  await folder.getByTestId("folder.delete").click();
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText(
    "Moved “Finance” to Recently deleted",
  );
  await noQuestion(window);
  await expect
    .poll(() => deletedNames(window))
    .toEqual(["Finance", "Invoice 4471", "Vendor", "Shortlist"]);

  // The section lists them newest first, each with where it was and its 30 days.
  const view = await openDeleted(window);
  await expect(rows(window).getByTestId("deleted-name")).toHaveText([
    "Finance",
    "Invoice 4471",
    "Vendor",
    "Shortlist",
  ]);
  await expect(row(window, "Shortlist").getByTestId("deleted-was-in")).toHaveText(
    "Not in a Folder",
  );
  await expect(row(window, "Invoice 4471").getByTestId("deleted-was-in")).toHaveText(
    "Not in a Folder",
  );
  await expect(row(window, "Vendor").getByTestId("deleted-was-in")).toHaveText("Tags");
  await expect(row(window, "Finance").getByTestId("deleted-was-in")).toHaveText("Library");
  await expect(rows(window).getByTestId("deleted-left")).toHaveText(Array(4).fill("30 days"));
  await expect(rows(window).getByTestId("deleted-when").first()).toContainText("Today");
  await screenshot(window, "recently-deleted-rows-en");

  // Selecting them all restores them together, to where they were.
  await row(window, "Finance").getByTestId("deleted-select").check();
  await row(window, "Shortlist")
    .getByTestId("deleted-select")
    .click({ modifiers: ["Shift"] });
  await expect(window.getByTestId("deleted-selection")).toContainText("4 selected");
  await window.getByTestId("deleted-restore-selected").click();
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText("Restored 4 items");
  await nothingDeleted(window);
  expect(await stateOf(window)).toEqual(before);

  // Undo deletes them again; one more Undo... is the stack's: Restore is one change.
  await undoLine(window).getByTestId("undo-action").click();
  await expect.poll(() => deletedNames(window)).toHaveLength(4);
  await expect(rows(window)).toHaveCount(4);

  // One row's own button restores it alone, in its Folder.
  await row(window, "Finance").getByTestId("deleted-restore").click();
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText("Restored “Finance”");
  await row(window, "Shortlist").getByTestId("deleted-restore").click();
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText(
    "Restored “Shortlist” to Finance",
  );
  await expect(view).toBeVisible();
});

test("Delete Permanently asks once and says what is lost; the Document's file stays, and it can't be restored", async () => {
  test.setTimeout(120_000);
  const file = join(sources, "Tides.txt");
  await writeFile(file, "Neap tides are the smallest of the month.\n");
  const { window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await addDocuments(window, [file]);
  const documentId = await read(window, async (core) => (await core.listDocuments())[0]?.id ?? "");
  const item = window.getByTestId("document-list-item").filter({ hasText: "Tides" });
  await openDocumentMenu(item);
  await item.getByTestId("document-file-actions").getByTestId("document.delete").click();
  await expect(item).toHaveCount(0);
  await access(file);

  await openDeleted(window);
  await row(window, "Tides").getByTestId("deleted-delete").click();
  const dialog = window.getByTestId("delete-permanently-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("Delete “Tides” permanently?");
  await expect(dialog).toContainText(
    "IncarnaMind forgets the text it read from “Tides” and its Tags.",
  );
  await expect(dialog).toContainText("Your files stay where they are.");
  await screenshot(window, "delete-permanently-en");

  // Cancel keeps it; Esc does too.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(rows(window)).toHaveCount(1);
  await row(window, "Tides").getByTestId("deleted-delete").click();
  await window.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(rows(window)).toHaveCount(1);

  await row(window, "Tides").getByTestId("deleted-delete").click();
  await dialog.getByTestId("confirm-delete-permanently").click();
  await nothingDeleted(window);
  await access(file);
  const refused = await read(
    window,
    async (core, id) =>
      core.restore([{ kind: "document", id }]).then(
        () => "restored",
        (error: Error) => error.message,
      ),
    documentId,
  );
  expect(refused).toContain("deleted permanently");
});

test("a Document the old layout copied into the data folder keeps its copy in Recently deleted: restored, it opens; deleted permanently, the copy goes (#1432)", async () => {
  test.setTimeout(120_000);
  const { window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const copy = await addOldLayoutCopy(window);

  await deleteFromSidebar(window, "Tide notes");
  expect(await exists(copy)).toBe(true);
  const viewer = await restoreAndOpen(window, "Tide notes");
  await expect(viewer.getByTestId("viewer-text")).toContainText(
    "Spring tides happen at new moon and at full moon.",
  );
  await expect(viewer.getByTestId("viewer-removed")).toHaveCount(0);

  await deleteFromSidebar(window, "Tide notes");
  await openDeleted(window);
  await row(window, "Tide notes").getByTestId("deleted-delete").click();
  await window.getByTestId("confirm-delete-permanently").click();
  await nothingDeleted(window);
  await expect.poll(() => exists(copy)).toBe(false);
});

test("one an older build deleted, its copy already gone, comes back as a Document whose file is missing (#1432)", async () => {
  test.setTimeout(120_000);
  const { window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const copy = await addOldLayoutCopy(window);
  await deleteFromSidebar(window, "Tide notes");
  // What deleting did before #1432.
  await rm(copy, { force: true });

  const viewer = await restoreAndOpen(window, "Tide notes");

  await expect(viewer.getByTestId("viewer-removed")).toContainText("is missing from its folder");
  await expect(viewer.getByTestId("viewer-locate-file")).toBeVisible();
  await expect(
    window
      .getByTestId("sidebar")
      .getByTestId("document-list-item")
      .filter({ hasText: "Tide notes" }),
  ).toHaveAttribute("data-file-status", "missing");
});

test("emptying Recently deleted with many items asks once, counting what is lost", async () => {
  test.setTimeout(120_000);
  const { window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await read(window, async (core) => {
    for (let index = 1; index <= 12; index++) {
      const mind = await core.createMind({ title: `Draft ${index}` });
      await core.deleteMind(mind.id);
    }
  });
  await openDeleted(window);
  await expect(rows(window)).toHaveCount(12);
  await window.getByTestId("deleted-empty").click();
  const dialog = window.getByTestId("delete-permanently-dialog");
  await expect(dialog.getByRole("heading")).toHaveText("Empty Recently deleted?");
  await expect(dialog).toContainText("The notes in 12 Minds are gone.");
  await dialog.getByTestId("confirm-delete-permanently").click();
  await nothingDeleted(window);
  expect(await deletedNames(window)).toEqual([]);
  await screenshot(window, "recently-deleted-empty-en");
});

test("the view holds at a narrow window and in Chinese, with a very long name", async () => {
  test.setTimeout(120_000);
  const longName = "The annual report of the harbour authority on tides and ferries ".repeat(3);
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await read(
    window,
    async (core, name) => {
      for (const title of [name, "季度报告"]) {
        const mind = await core.createMind({ title });
        await core.deleteMind(mind.id);
      }
      await core.updateSettings({ user: { language: "zh-CN" } });
    },
    longName.trim(),
  );
  await setWindowSize(app, window, 900, 660);
  await openDeleted(window);
  await expect(window.getByTestId("deleted-heading")).toHaveText("回收站");
  await expect(rows(window)).toHaveCount(2);
  const overflow = await window.getByTestId("library").evaluate((element) => {
    const scroller = element.querySelector<HTMLElement>(":scope > div");
    return (scroller?.scrollWidth ?? 0) - (scroller?.clientWidth ?? 0);
  });
  expect(overflow).toBeLessThanOrEqual(0);
  // The name is cut by the row, not wrapped by letter; the actions stay inside it.
  const long = row(window, "harbour authority");
  const name = await long.getByTestId("deleted-name").boundingBox();
  const box = await long.boundingBox();
  if (!name || !box) throw new Error("The row isn't showing.");
  expect(name.x + name.width).toBeLessThanOrEqual(box.x + box.width);
  await expect(long.getByTestId("deleted-restore")).toHaveText("恢复");
  await expect(long.getByTestId("deleted-delete")).toHaveText("彻底删除…");
  await expect(long.getByTestId("deleted-left")).toHaveText("30 天");
  await screenshot(window, "recently-deleted-zh-narrow");

  await long.getByTestId("deleted-delete").click();
  const dialog = window.getByTestId("delete-permanently-dialog");
  await expect(dialog).toContainText("此操作无法撤销。你的文件仍在原处。");
  await screenshot(window, "delete-permanently-zh-narrow");
  await window.keyboard.press("Escape");
  await setWindowSize(app, window, 1600, 660);
  await screenshot(window, "recently-deleted-zh-wide");
});
