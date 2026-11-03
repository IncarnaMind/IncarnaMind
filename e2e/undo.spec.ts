import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  clickEditItem,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  documentIdOf,
  editItem,
  enterContent,
  launchApp,
  leaveFirstOpen,
  leaveText,
  nameMind,
  newMind,
  openDocumentMenu,
  openDocumentTags,
  openManageTags,
  pointAndClick,
  removeDataFolder,
  sidebarFolder,
} from "./app";

/*
 * Undo (#227): every change outside the note goes on one stack for the session.
 * ⌘Z (Ctrl+Z) outside text takes the last one back and ⇧⌘Z (Ctrl+Shift+Z) does
 * it again, as the undo line's Undo does; each is checked in the core, through
 * the bridge, not only on screen. In the note ⌘Z is the note's own, in a field
 * the field's, and the Edit menu goes the same way, naming the change.
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

const undoLine = (window: Page) => window.getByTestId("undo-line");
const mindRow = (window: Page, title: string) =>
  window.getByTestId("mind-row").filter({ hasText: title });
const documentRow = async (window: Page, name: string) =>
  window.locator(
    `[data-testid="document-list-item"][data-document-id="${await documentIdOf(window, name)}"]`,
  );

const undo = (window: Page) => window.keyboard.press("ControlOrMeta+z");
const redo = (window: Page) => window.keyboard.press("ControlOrMeta+Shift+z");

const mindTitles = (window: Page) =>
  read(window, async (core) => (await core.listMinds()).map((mind) => mind.title).sort());
const mindFolder = (window: Page, title: string) =>
  read(
    window,
    async (core, name) =>
      (await core.listMinds()).find((mind) => mind.title === name)?.folderId ?? null,
    title,
  );

test("Minds and Folders: renamed, moved and deleted, each back with ⌘Z and again with ⇧⌘Z, as the core has them", async () => {
  test.setTimeout(120_000);
  const { window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const finance = await read(
    window,
    async (core) => (await core.createLibraryGroup({ name: "Finance", description: "" })).id,
  );
  await newMind(window);
  await window.getByTestId("mind-list-item").dblclick();
  await window.getByTestId("mind-rename").fill("Shortlist");
  await window.getByTestId("mind-rename").press("Enter");
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText("Renamed to “Shortlist”");
  const shortlist = mindRow(window, "Shortlist");

  // Renamed in its row: a double-click, a name, Enter.
  await shortlist.getByTestId("mind-list-item").dblclick();
  await window.getByTestId("mind-rename").fill("Vendors");
  await window.getByTestId("mind-rename").press("Enter");
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText("Renamed to “Vendors”");
  expect(await mindTitles(window)).toEqual(["Vendors"]);
  await leaveText(window);
  await undo(window);
  await expect(undoLine(window).getByTestId("undo-message")).toHaveCount(0);
  await expect.poll(() => mindTitles(window)).toEqual(["Shortlist"]);
  await redo(window);
  await expect.poll(() => mindTitles(window)).toEqual(["Vendors"]);
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText("Renamed to “Vendors”");

  // Moved by its menu's Move to….
  const vendors = mindRow(window, "Vendors");
  await vendors.hover();
  await vendors.getByTestId("mind-menu").click();
  await vendors.getByTestId("mind-actions").getByTestId("mind.moveTo").click();
  const picker = window.getByTestId("move-to-picker");
  await picker.getByTestId("move-to-option").filter({ hasText: "Finance" }).click();
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText(
    "Moved “Vendors” to Finance",
  );
  expect(await mindFolder(window, "Vendors")).toBe(finance);
  await leaveText(window);
  await undo(window);
  await expect.poll(() => mindFolder(window, "Vendors")).toBeNull();
  await redo(window);
  await expect.poll(() => mindFolder(window, "Vendors")).toBe(finance);

  // The Folder renamed in place.
  const folder = sidebarFolder(window, "Finance");
  await folder.getByTestId("folder-row").dblclick();
  await window.getByTestId("folder-rename-field").fill("Money");
  await window.getByTestId("folder-rename-field").press("Enter");
  const folderNames = () =>
    read(window, async (core) => (await core.getLibrary()).groups.map((group) => group.name));
  await expect.poll(folderNames).toEqual(["Money"]);
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText("Renamed to “Money”");
  await leaveText(window);
  await undo(window);
  await expect.poll(folderNames).toEqual(["Finance"]);
  await redo(window);
  await expect.poll(folderNames).toEqual(["Money"]);

  // The Folder deleted (asking nothing): restored with its Mind back in it.
  const money = sidebarFolder(window, "Money");
  await money.getByTestId("folder-row").hover();
  await money.getByTestId("folder-menu").click();
  await money.getByTestId("folder.delete").click();
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText(
    "Moved “Money” to Recently deleted",
  );
  await expect.poll(folderNames).toEqual([]);
  expect(await mindFolder(window, "Vendors")).toBeNull();
  await leaveText(window);
  await undo(window);
  await expect.poll(folderNames).toEqual(["Money"]);
  await expect.poll(() => mindFolder(window, "Vendors")).toBe(finance);
  await redo(window);
  await expect.poll(folderNames).toEqual([]);
  await undo(window);
  await expect.poll(folderNames).toEqual(["Money"]);

  // The Mind deleted (asking nothing), then put back.
  const row = mindRow(window, "Vendors");
  await row.hover();
  await row.getByTestId("mind-menu").click();
  await row.getByTestId("mind-actions").getByTestId("mind.delete").click();
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText(
    "Moved “Vendors” to Recently deleted",
  );
  await expect.poll(() => mindTitles(window)).toEqual([]);
  await leaveText(window);
  // The line's Undo does what ⌘Z does.
  await pointAndClick(window, undoLine(window).getByTestId("undo-action"));
  await expect.poll(() => mindTitles(window)).toEqual(["Vendors"]);
  await redo(window);
  await expect.poll(() => mindTitles(window)).toEqual([]);

  // Several changes go back in reverse order and come again in order.
  await undo(window);
  await expect.poll(() => mindTitles(window)).toEqual(["Vendors"]);
  await undo(window);
  await expect.poll(folderNames).toEqual(["Finance"]);
  await expect.poll(() => mindTitles(window)).toEqual(["Vendors"]);
  await redo(window);
  await expect.poll(folderNames).toEqual(["Money"]);
  await redo(window);
  await expect.poll(() => mindTitles(window)).toEqual([]);
});

test("Documents: renamed, moved, tagged and deleted, each back with ⌘Z and again with ⇧⌘Z", async () => {
  test.setTimeout(120_000);
  await writeFile(join(sources, "Tides.txt"), "Neap tides are the smallest of the month.\n");
  await writeFile(join(sources, "Ferries.txt"), "The ferry leaves at noon.\n");
  const { window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const finance = await read(
    window,
    async (core) => (await core.createLibraryGroup({ name: "Finance", description: "" })).id,
  );
  await addDocuments(window, [join(sources, "Tides.txt"), join(sources, "Ferries.txt")]);
  const documents = () =>
    read(window, async (core) =>
      (await core.listDocuments())
        .map((document) => ({
          name: document.name,
          tags: document.tags.map((link) => `${link.tagId}:${link.source}`),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  const names = async () => (await documents()).map((document) => document.name);

  // Renamed from its menu.
  const tides = await documentRow(window, "Tides");
  await openDocumentMenu(tides);
  await tides.getByTestId("document-file-actions").getByTestId("document.rename").click();
  const field = tides.getByRole("textbox");
  await field.fill("Tide tables");
  await field.press("Enter");
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText("Renamed to “Tide tables”");
  await expect.poll(names).toEqual(["Ferries", "Tide tables"]);
  await leaveText(window);
  await undo(window);
  await expect.poll(names).toEqual(["Ferries", "Tides"]);
  await redo(window);
  await expect.poll(names).toEqual(["Ferries", "Tide tables"]);

  // Moved into a Folder with Move to…, from its row's ⋯ in the Library.
  await pointAndClick(window, window.getByTestId("open-library"));
  const library = window.getByTestId("library");
  const tideRow = library
    .getByTestId("library-document")
    .filter({ has: window.getByRole("button", { name: "Tide tables", exact: true }) });
  await tideRow.hover();
  await pointAndClick(window, tideRow.getByTestId("document-file-menu"));
  await pointAndClick(
    window,
    window
      .getByTestId("document-file-actions")
      .filter({ visible: true })
      .getByTestId("document.moveTo"),
  );
  await pointAndClick(
    window,
    window
      .getByTestId("move-to-picker")
      .getByTestId("move-to-option")
      .filter({ hasText: "Finance" }),
  );
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText(
    "Moved “Tide tables” to Finance",
  );
  const folderOf = () =>
    read(window, async (core) => {
      const id = (await core.listDocuments()).find((each) => each.name === "Tide tables")?.id;
      return (await core.getLibrary()).assignments.find((each) => each.documentId === id)?.groupId;
    });
  await expect.poll(folderOf).toBe(finance);
  await leaveText(window);
  await undo(window);
  // Back to Not in a Folder: with a Folder, Organize keeps an assignment with none while it waits for a model.
  await expect.poll(folderOf).toBeFalsy();
  await redo(window);
  await expect.poll(folderOf).toBe(finance);

  // A Tag added in its picker, then taken off.
  const report = await read(
    window,
    async (core) => (await core.listTags()).find((tag) => tag.name === "Report")?.id ?? "",
  );
  const ferries = await documentRow(window, "Ferries");
  await openDocumentTags(ferries);
  const popover = ferries.getByTestId("document-tags-popover");
  await popover.getByTestId("tag-option").filter({ hasText: "Report" }).click();
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText("Tagged “Ferries” Report");
  await window.keyboard.press("Escape");
  const ferryTags = async () =>
    (await documents()).find((document) => document.name === "Ferries")?.tags;
  await expect.poll(ferryTags).toEqual([`${report}:user`]);
  await leaveText(window);
  await undo(window);
  await expect.poll(ferryTags).toEqual([]);
  await redo(window);
  await expect.poll(ferryTags).toEqual([`${report}:user`]);
  await openDocumentTags(ferries);
  await popover.getByTestId("tag-token-remove").click();
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText(
    "Removed Report from “Ferries”",
  );
  await window.keyboard.press("Escape");
  await expect.poll(ferryTags).toEqual([]);
  await leaveText(window);
  await undo(window);
  await expect.poll(ferryTags).toEqual([`${report}:user`]);
  await redo(window);
  await expect.poll(ferryTags).toEqual([]);

  // Deleted (asking nothing), then restored.
  await openDocumentMenu(ferries);
  await ferries.getByTestId("document-file-actions").getByTestId("document.delete").click();
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText(
    "Moved “Ferries” to Recently deleted",
  );
  await expect.poll(names).toEqual(["Tide tables"]);
  expect(
    await read(window, async (core) => (await core.listDeleted()).map((each) => each.name)),
  ).toEqual(["Ferries"]);
  await leaveText(window);
  await undo(window);
  await expect.poll(names).toEqual(["Ferries", "Tide tables"]);
  await expect(ferries).toBeVisible();
  await redo(window);
  await expect.poll(names).toEqual(["Tide tables"]);
});

test("Tags: renamed, recoloured, merged and deleted in Manage Tags, each back with ⌘Z and again with ⇧⌘Z", async () => {
  test.setTimeout(120_000);
  await writeFile(join(sources, "Lab notes.txt"), "Notes from the lab.\n");
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await addDocuments(window, [join(sources, "Lab notes.txt")]);
  const ids = await read(window, async (core) => {
    const tags = await core.listTags();
    const id = (name: string) => tags.find((tag) => tag.name === name)?.id ?? "";
    const [lab] = await core.listDocuments();
    if (lab) await core.addTagToDocuments([lab.id], id("Report"));
    return { notes: id("Notes"), report: id("Report") };
  });
  const tags = () =>
    read(window, async (core) =>
      (await core.listTags())
        .filter((tag) => tag.name !== "Paper" && tag.name !== "Book")
        .map((tag) => `${tag.name}:${tag.colour}`)
        .sort(),
    );
  const labTags = () =>
    read(window, async (core) => (await core.listDocuments())[0]?.tags.map((link) => link.tagId));
  const dialog = window.getByTestId("tags-dialog");
  const row = (id: string) => dialog.locator(`[data-testid="tag-row"][data-tag-id="${id}"]`);
  // Manage Tags, from ⌘K.
  const manage = () => openManageTags(window);
  const done = async () => {
    await pointAndClick(window, dialog.getByRole("button", { name: "Done" }));
    await expect(dialog).toBeHidden();
    await leaveText(window);
  };
  const before = await tags();

  // Renamed and recoloured in one edit.
  await manage();
  await pointAndClick(window, row(ids.report).getByTestId("edit-tag"));
  const name = row(ids.report).getByTestId("tag-name-input");
  await name.fill("Reports");
  // The Edit menu's Undo in a dialog's field is the field's own.
  await clickEditItem(app, "edit.undo");
  await expect(name).toHaveValue("Report");
  await name.fill("Reports");
  await pointAndClick(window, row(ids.report).locator('label:has([data-colour="teal"])'));
  await pointAndClick(window, row(ids.report).getByTestId("save-tag"));
  await expect(row(ids.report).getByTestId("tag-row-name")).toHaveText("Reports");
  await done();
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText("Renamed to “Reports”");
  const edited = await tags();
  expect(edited).toContain("Reports:teal");
  await undo(window);
  await expect.poll(tags).toEqual(before);
  await redo(window);
  await expect.poll(tags).toEqual(edited);

  // Merged into Notes: the Document carries Notes instead, until ⌘Z.
  await manage();
  await pointAndClick(window, row(ids.report).getByTestId("merge-tag"));
  await row(ids.report).getByTestId("merge-target").selectOption({ label: "Notes" });
  await pointAndClick(window, row(ids.report).getByTestId("confirm-merge-tag"));
  await expect(row(ids.report)).toHaveCount(0);
  await done();
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText(
    "Merged “Reports” into Notes",
  );
  await expect.poll(labTags).toEqual([ids.notes]);
  await undo(window);
  await expect.poll(labTags).toEqual([ids.report]);
  await expect.poll(tags).toEqual(edited);
  await redo(window);
  await expect.poll(labTags).toEqual([ids.notes]);
  await undo(window);
  await expect.poll(labTags).toEqual([ids.report]);

  // Deleted (asking nothing): back with its link.
  await manage();
  await pointAndClick(window, row(ids.report).getByTestId("delete-tag"));
  await expect(row(ids.report)).toHaveCount(0);
  await done();
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText(
    "Moved “Reports” to Recently deleted",
  );
  await expect.poll(labTags).toEqual([]);
  await undo(window);
  await expect.poll(labTags).toEqual([ids.report]);
  await expect.poll(tags).toEqual(edited);
  await redo(window);
  await expect.poll(labTags).toEqual([]);
});

test("Remove the examples: made again by ⌘Z, removed again by ⇧⌘Z", async () => {
  const { window } = await launchApp(dataDir, { examples: true });
  await leaveFirstOpen(window);
  await expect(window.getByTestId("example-banner")).toBeVisible();
  const exampleMind = () => read(window, async (core) => (await core.getExamples()).mindId);
  await pointAndClick(window, window.getByTestId("example-remove"));
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText("Removed the examples");
  await expect.poll(exampleMind).toBeNull();
  await dismissChatSetup(window);
  await leaveText(window);
  await undo(window);
  await expect.poll(exampleMind).not.toBeNull();
  await expect(window.getByTestId("mind-list-item")).toHaveCount(1);
  await redo(window);
  await expect.poll(exampleMind).toBeNull();
  await expect(window.getByTestId("mind-list-item")).toHaveCount(0);
});

test("⌘Z goes to the note's own undo in the note, to a field's in a field, and to the last change elsewhere; the Edit menu too, naming it", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const finance = await read(
    window,
    async (core) => (await core.createLibraryGroup({ name: "Finance", description: "" })).id,
  );
  await newMind(window);
  await nameMind(window, "Shortlist");
  await enterContent(window);
  const shortlist = mindRow(window, "Shortlist");
  await shortlist.hover();
  await shortlist.getByTestId("mind-menu").click();
  await shortlist.getByTestId("mind-actions").getByTestId("mind.moveTo").click();
  await window
    .getByTestId("move-to-picker")
    .getByTestId("move-to-option")
    .filter({ hasText: "Finance" })
    .click();
  await expect.poll(() => mindFolder(window, "Shortlist")).toBe(finance);

  // In the note: only the note's text goes.
  const editor = window.getByTestId("mind-editor");
  await pointAndClick(window, editor);
  await window.keyboard.type("Ask about ferries");
  await expect(editor).toContainText("Ask about ferries");
  await expect.poll(() => editItem(app, "edit.undo")).toEqual({ label: "Undo", enabled: true });
  await undo(window);
  await expect(editor).not.toContainText("Ask about ferries");
  expect(await mindFolder(window, "Shortlist")).toBe(finance);
  // The Edit menu's Undo, chosen there, is the note's too.
  await window.keyboard.type("Ferries at noon");
  await expect(editor).toContainText("Ferries at noon");
  await clickEditItem(app, "edit.undo");
  await expect(editor).not.toContainText("Ferries at noon");
  expect(await mindFolder(window, "Shortlist")).toBe(finance);

  // In a field: only the field's text goes.
  const composer = window.getByTestId("composer-input");
  await pointAndClick(window, composer);
  await window.keyboard.type("How cold");
  await expect(composer).toHaveValue("How cold");
  await undo(window);
  // The field's own undo takes its typing back, as far as it groups it.
  await expect(composer).not.toHaveValue("How cold");
  expect("How cold".startsWith(await composer.inputValue())).toBe(true);
  expect(await mindFolder(window, "Shortlist")).toBe(finance);
  // And the Edit menu's, chosen there.
  await composer.fill("");
  await window.keyboard.type("Tides");
  await expect(composer).toHaveValue("Tides");
  await clickEditItem(app, "edit.undo");
  await expect(composer).not.toHaveValue("Tides");
  expect(await mindFolder(window, "Shortlist")).toBe(finance);
  // Even chosen right after clicking into the field from where the menu names the last change.
  await composer.fill("");
  await window.keyboard.type("Neap");
  await leaveText(window);
  await expect
    .poll(() => editItem(app, "edit.undo"))
    .toEqual({ label: "Undo Move “Shortlist”", enabled: true });
  await pointAndClick(window, composer);
  await clickEditItem(app, "edit.undo");
  await expect(composer).not.toHaveValue("Neap");
  expect(await mindFolder(window, "Shortlist")).toBe(finance);

  // Anywhere else: the last change, and the Edit menu names it.
  await leaveText(window);
  await expect
    .poll(() => editItem(app, "edit.undo"))
    .toEqual({ label: "Undo Move “Shortlist”", enabled: true });
  await expect.poll(() => editItem(app, "edit.redo")).toEqual({ label: "Redo", enabled: false });
  await undo(window);
  await expect.poll(() => mindFolder(window, "Shortlist")).toBeNull();
  await expect
    .poll(() => editItem(app, "edit.redo"))
    .toEqual({ label: "Redo Move “Shortlist”", enabled: true });
  // The menu's Redo goes the same way.
  await clickEditItem(app, "edit.redo");
  await expect.poll(() => mindFolder(window, "Shortlist")).toBe(finance);
  await clickEditItem(app, "edit.undo");
  await expect.poll(() => mindFolder(window, "Shortlist")).toBeNull();
});

test("in the composer, a run of typing is one step to undo and to redo, with ⌘Z and the Edit menu", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window);
  const field = window.getByTestId("composer-input");
  await pointAndClick(window, field);
  await window.keyboard.type("abc");
  await expect(field).toHaveValue("abc");
  await undo(window);
  await expect(field).toHaveValue("");
  await redo(window);
  await expect(field).toHaveValue("abc");
  await clickEditItem(app, "edit.undo");
  await expect(field).toHaveValue("");
  await clickEditItem(app, "edit.redo");
  await expect(field).toHaveValue("abc");
});

test("an undo the core can't do shows one problem line where it happened, in Chinese too, and its action lets it happen", async () => {
  const { window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const folders = await read(window, async (core) => {
    await core.updateSettings({ user: { language: "zh-CN" } });
    const finance = await core.createLibraryGroup({ name: "Finance", description: "" });
    const research = await core.createLibraryGroup({ name: "Research", description: "" });
    const mind = await core.createMind({ title: "Shortlist", folderId: finance.id });
    return { finance: finance.id, research: research.id, mind: mind.id };
  });
  const shortlist = mindRow(window, "Shortlist");
  await sidebarFolder(window, "Finance").getByTestId("folder-row").click();
  await shortlist.hover();
  await shortlist.getByTestId("mind-menu").click();
  await shortlist.getByTestId("mind-actions").getByTestId("mind.moveTo").click();
  await window
    .getByTestId("move-to-picker")
    .getByTestId("move-to-option")
    .filter({ hasText: "Research" })
    .click();
  await expect(undoLine(window).getByTestId("undo-message")).toHaveText(
    "已将“Shortlist”移动到“Research”",
  );
  // Finance goes meanwhile, as from another window.
  await read(
    window,
    async (core, id) => {
      await core.deleteLibraryGroup(id);
    },
    folders.finance,
  );
  await expect(sidebarFolder(window, "Finance")).toHaveCount(0);
  await leaveText(window);
  await undo(window);
  const problem = undoLine(window).getByTestId("undo-problem");
  await expect(problem).toContainText("无法撤销：“Finance”已删除");
  await expect(problem.getByTestId("undo-fix")).toHaveText("恢复“Finance”");
  expect(await mindFolder(window, "Shortlist")).toBe(folders.research);
  await pointAndClick(window, problem.getByTestId("undo-fix"));
  await expect.poll(() => mindFolder(window, "Shortlist")).toBe(folders.finance);
  await expect(sidebarFolder(window, "Finance")).toHaveCount(1);
  await expect(problem).toHaveCount(0);
});
