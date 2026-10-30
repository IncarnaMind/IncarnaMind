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
// By its own name: where it was can be another row's name (#2238).
const row = (window: Page, name: string) =>
  rows(window).filter({ has: window.getByTestId("deleted-name").getByText(name, { exact: true }) });

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
  await expect(row(window, "Shortlist").getByTestId("deleted-was-in")).toHaveText("Finance");
  await expect(row(window, "Invoice 4471").getByTestId("deleted-was-in")).toHaveText("Finance");
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

test("a Document restored from Recently deleted comes back with no Organize mark, in English and Chinese (#1433)", async () => {
  test.setTimeout(120_000);
  const file = join(sources, "Harbour notes.txt");
  await writeFile(file, "Notes about the harbour and its tides.\n");
  const { window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await addDocuments(window, [file]);
  // The Folder comes after the Document, so Organize had nothing to file it into then.
  await read(window, async (core) => {
    const [document] = await core.listDocuments();
    if (!document) throw new Error("The Document was not added.");
    await core.createLibraryGroup({ name: "Finance", description: "" });
    await core.deleteDocument(document.id);
  });
  await openDeleted(window);
  await row(window, "Harbour notes").getByTestId("deleted-restore").click();
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText("Restored “Harbour notes”");

  // The Library read again, as a restart or another change reads it, so the row shows the assignment the core holds.
  await window.reload();
  await pointAndClick(window, window.getByTestId("open-library"));
  const library = window.getByTestId("library");
  const item = library
    .getByTestId("library-document")
    .filter({ has: window.getByRole("button", { name: "Harbour notes", exact: true }) });
  const organizeOf = async () => {
    await item.locator("[data-row-main]").focus();
    await window.keyboard.press("ControlOrMeta+i");
    const info = window.getByTestId("info-panel");
    await expect(info).toBeVisible();
    return info.getByTestId("info-organize");
  };
  const english = await organizeOf();
  await expect(english).toContainText("Not organized yet");
  await expect(english).not.toContainText("Needs attention");
  await window.keyboard.press("Escape");

  await read(window, (core) => core.updateSettings({ user: { language: "zh-CN" } }));
  const chinese = await organizeOf();
  await expect(chinese).toContainText("尚未整理");
  await expect(chinese).not.toContainText("需要处理");
  await window.keyboard.press("Escape");

  expect(await read(window, async (core) => (await core.getLibrary()).assignments)).toEqual([]);
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
  await expect(dialog).toContainText("Your text in 12 notes is gone.");
  await dialog.getByTestId("confirm-delete-permanently").click();
  await nothingDeleted(window);
  expect(await deletedNames(window)).toEqual([]);
  await screenshot(window, "recently-deleted-empty-en");
});

test("deleted names stay readable beside metadata and actions in English and Chinese (#1952)", async () => {
  const testInfo = test.info();
  test.setTimeout(120_000);
  const names = [
    "Audit cited forecast",
    "The annual report of the harbour authority on tides and ferries ".repeat(3).trim(),
    "季度报告及港口轮渡年度预算分析".repeat(8),
  ];
  const file = join(sources, "Forecast.txt");
  await writeFile(file, "Synthetic forecast for the harbour authority.\n");
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await addDocuments(window, [file]);
  await read(
    window,
    async (core, titles) => {
      const [document] = await core.listDocuments();
      if (!document) throw new Error("The synthetic Document was not added.");
      await core.renameDocument(document.id, titles[0] ?? "Forecast");
      await core.deleteDocument(document.id);
      for (const title of titles.slice(1)) {
        const mind = await core.createMind({ title });
        await core.deleteMind(mind.id);
      }
    },
    names,
  );
  await openDeleted(window);
  await expect(rows(window)).toHaveCount(names.length);
  await expect(rows(window).getByTestId("deleted-name")).toHaveText(names.toReversed());

  for (const language of ["en", "zh-CN"] as const) {
    await read(window, (core, language) => core.updateSettings({ user: { language } }), language);
    await expect(window.getByTestId("deleted-heading")).toHaveText(
      language === "en" ? "Recently deleted" : "回收站",
    );
    for (const width of [1280, 900, 1600]) {
      await setWindowSize(app, window, width, 660);
      await row(window, names[0] ?? "Forecast").hover();
      await screenshot(window, `recently-deleted-${language}-${width}`);
      const geometry = await rows(window).evaluateAll((elements) =>
        elements.map((element) => {
          const name = element.querySelector<HTMLElement>('[data-testid="deleted-name"]');
          const icon = name?.parentElement?.querySelector("svg");
          const box = element.getBoundingClientRect();
          const text = name?.getBoundingClientRect();
          const mark = icon?.getBoundingClientRect();
          return {
            name: name?.textContent,
            rowWidth: box.width,
            metadata: element
              .querySelector('[data-testid="deleted-was-in"]')
              ?.getBoundingClientRect().width,
            actions: element
              .querySelector('[data-testid="deleted-restore"]')
              ?.parentElement?.parentElement?.getBoundingClientRect().width,
            width: text?.width ?? 0,
            fullWidth: name?.scrollWidth ?? 0,
            iconRight: mark?.right ?? 0,
            nameLeft: text?.left ?? 0,
            nameRight: text?.right ?? 0,
            rowRight: box.right,
            overflow: element.scrollWidth - element.clientWidth,
            cells: [
              name,
              icon,
              element.querySelector('[data-testid="deleted-was-in"]'),
              element.querySelector('[data-testid="deleted-when"]')?.parentElement,
              element.querySelector('[data-testid="deleted-menu"]')?.parentElement,
            ].flatMap((cell) => {
              if (!cell || cell.getClientRects().length === 0) return [];
              const { left, right, top, bottom } = cell.getBoundingClientRect();
              return [{ left, right, top, bottom }];
            }),
          };
        }),
      );
      await testInfo.attach(`geometry-${language}-${width}`, {
        body: JSON.stringify(geometry, null, 2),
        contentType: "application/json",
      });
      for (const item of geometry) {
        expect
          .soft(item.width, `${language} ${width}: ${item.name}`)
          .toBeGreaterThanOrEqual(Math.min(160, item.fullWidth, item.rowWidth / 2) - 1);
        expect.soft(item.nameLeft).toBeGreaterThanOrEqual(item.iconRight);
        expect.soft(item.nameRight).toBeLessThanOrEqual(item.rowRight);
        expect.soft(item.overflow).toBeLessThanOrEqual(1);
        for (let i = 0; i < item.cells.length; i++) {
          for (const other of item.cells.slice(i + 1)) {
            const cell = item.cells[i];
            if (!cell) continue;
            const overlap = Math.min(cell.right, other.right) - Math.max(cell.left, other.left);
            const sameLine = cell.top < other.bottom && other.top < cell.bottom;
            expect.soft(sameLine && overlap > 1).toBe(false);
          }
        }
      }
    }
  }
});

for (const language of ["en", "zh-CN"] as const) {
  test(`deleted row actions keep their target with mouse and keyboard in ${language} (#1952)`, async () => {
    test.setTimeout(120_000);
    const name = language === "en" ? "Harbour forecast" : "港口季度预测";
    const file = join(sources, `${name}.txt`);
    await writeFile(file, "Synthetic harbour forecast.\n");
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await addDocuments(window, [file]);
    await read(window, (core, language) => core.updateSettings({ user: { language } }), language);
    const document = window.getByTestId("sidebar").getByTestId("document-list-item");
    await openDocumentMenu(document);
    await pointAndClick(window, document.getByTestId("document.delete"));
    await noQuestion(window);

    for (const width of [1600, 900]) {
      await setWindowSize(app, window, width, 660);
      await window.keyboard.press("ControlOrMeta+k");
      const search = window.getByTestId("palette-search");
      await expect(search).toBeFocused();
      await search.fill(language === "en" ? ">recently deleted" : ">回收站");
      await expect(window.locator('[data-key="command:deleted.show"]')).toBeVisible();
      await window.keyboard.press("Enter");
      const target = row(window, name);
      await expect(target.getByTestId("deleted-name")).toBeVisible();
      await target.hover();
      await expect(target.getByTestId("deleted-restore")).toHaveText(
        language === "en" ? "Restore" : "恢复",
      );
      await expect(target.getByTestId("deleted-delete")).toHaveText(
        language === "en" ? "Delete Permanently…" : "彻底删除…",
      );
      await expect(target.getByTestId("deleted-left")).toHaveText(
        language === "en" ? "30 days" : "30 天",
      );
      await expect(target.getByTestId("deleted-menu")).toHaveAttribute(
        "aria-label",
        language === "en" ? `More for ${name}` : `“${name}”的更多操作`,
      );
      await expect(target.getByTestId("deleted-restore").locator("..")).toHaveCSS("opacity", "1");
      await pointAndClick(window, target.getByTestId("deleted-delete"));
      const dialog = window.getByTestId("delete-permanently-dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(
        language === "en"
          ? "This can’t be undone. Your files stay where they are."
          : "此操作无法撤销。你的文件仍在原处。",
      );
      await expect(dialog.getByRole("heading")).toContainText(name);
      await window.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(target).toHaveCount(1);

      await window.mouse.move(0, 0);
      await target.getByTestId("deleted-select").focus();
      await window.keyboard.press("Tab");
      await expect(target.getByTestId("deleted-restore")).toBeFocused();
      await expect(target.getByTestId("deleted-restore").locator("..")).toHaveCSS("opacity", "1");
      await window.keyboard.press("Shift+F10");
      await expect(target.getByTestId("deleted-actions")).toBeVisible();
      await expect(target.getByTestId("deleted.restore")).toBeFocused();
      await expect(target.getByTestId("deleted.deletePermanently")).toBeVisible();
      await window.keyboard.press("Enter");
      await expect(target).toHaveCount(0);
      await window.keyboard.press("ControlOrMeta+z");
      await expect(target).toHaveCount(1);

      await target.hover();
      await target.getByTestId("deleted-select").check();
      await expect(window.getByTestId("deleted-selection")).toBeVisible();
      await expect(target).toHaveAttribute("aria-selected", "true");
      await window.getByTestId("deleted-delete-selected").hover();
      await window.getByTestId("deleted-delete-selected").click();
      await expect(dialog.getByRole("heading")).toContainText(name);
      await window.keyboard.press("Escape");
      await window.getByTestId("deleted-restore-selected").hover();
      await window.getByTestId("deleted-restore-selected").click();
      await expect(target).toHaveCount(0);
      await pointAndClick(window, undoLine(window).getByTestId("undo-action"));
      await expect(target).toHaveCount(1);
      await target.getByTestId("deleted-name").click({ button: "right" });
      await expect(target.getByTestId("deleted-actions")).toBeVisible();
      await expect(target.getByTestId("deleted.restore")).toBeVisible();
      await expect(target.getByTestId("deleted.deletePermanently")).toBeVisible();
      await window.keyboard.press("Escape");
      await screenshot(window, `recently-deleted-actions-${language}-${width}`);
    }
  });
}
