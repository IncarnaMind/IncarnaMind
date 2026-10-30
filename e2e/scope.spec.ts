import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  assistantAnswers,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  newMind,
  openSteps,
  removeDataFolder,
  sidebarFolder,
} from "./app";

let dataDir: string;
/** Where the files a test adds are written: outside the data folder. */
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

test("typing @ in the composer limits the search to a Folder: the Answer cites only a Document in it", async () => {
  // Both answer the Question; each is in its own folder of a Linked folder, Notes.
  const notes = join(await realpath(sources), "Notes");
  await mkdir(join(notes, "Ocean"), { recursive: true });
  await mkdir(join(notes, "Kitchen"));
  await writeFile(
    join(notes, "Ocean", "Tide tables.txt"),
    "Neap tides are the smallest of the month.\nSpring tides happen at new moon and at full moon.\n",
  );
  await writeFile(
    join(notes, "Kitchen", "Spring menu.txt"),
    "When do spring tides happen? Spring tides happen when the market sells mussels.\n",
  );
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await connectLocalChatModel(window);
  await window.evaluate(async (path) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.addLinkedFolder(path);
  }, notes);
  const items = window.getByTestId("document-list-item");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveAttribute("data-status", "ready");
  await expect(items.nth(1)).toHaveAttribute("data-status", "ready");
  const oceanId = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.listFolders()).find((folder) => folder.name === "Ocean")?.id;
  });
  if (!oceanId) throw new Error("No Ocean Folder.");

  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.press("ControlOrMeta+j");
  const composer = window.getByTestId("composer");
  await expect(composer.getByTestId("composer-input")).toBeFocused();
  // With no Search scope, every Document is searched.
  await expect(composer.getByTestId("composer-scope-all")).toHaveText("All Documents");

  // "@" opens the picker: Folders, Tags and Documents, the first one chosen; arrows move.
  await window.keyboard.type("@");
  const picker = window.getByTestId("scope-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("group", { name: "Folders" })).toBeVisible();
  await expect(picker.getByRole("group", { name: "Tags" })).toBeVisible();
  await expect(picker.getByRole("group", { name: "Documents" })).toBeVisible();
  const choices = picker.getByTestId("scope-choice");
  // The Linked folder's own Folder, then its folders, each with the path it is in.
  await expect(choices.first().locator(".truncate").first()).toHaveText("Notes");
  await expect(choices.first()).toHaveAttribute("aria-selected", "true");
  await window.keyboard.press("ArrowDown");
  await expect(choices.nth(1)).toHaveText(/^Kitchen/);
  await expect(choices.nth(1)).toHaveAttribute("aria-selected", "true");

  // Typing filters; Enter adds the choice as a chip in the composer, and the "@" text goes.
  await window.keyboard.type("oce");
  await expect(choices).toHaveCount(1);
  await expect(choices).toHaveAttribute("data-kind", "folder");
  await window.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  const composerChip = composer.getByTestId("scope-chip");
  await expect(composerChip).toHaveText("Ocean");
  await expect(composerChip).toHaveAttribute("data-id", oceanId);
  await expect(composer.getByTestId("composer-input")).toHaveValue("");

  // Asked, the Question goes to the assistant, and its Answer's line names the scope it
  // searched; the composer keeps it for the next.
  await window.keyboard.type("When do spring tides happen?");
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("assistant-question")).toContainText(
    "When do spring tides happen?",
  );
  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  const searched = answer.getByTestId("answer-steps");
  await expect(searched).toContainText("Searched “Ocean” ·");
  await expect(composerChip).toHaveText("Ocean");
  await expect(composerChip).toHaveAttribute("data-id", oceanId);
  await expect(editor.getByTestId("question")).toHaveCount(0);

  // It searched only the Ocean Folder, and cites its Document.
  const steps = await openSteps(window, answer);
  await expect(steps.getByTestId("answer-step-found")).toContainText("1 passage found");
  const citation = answer.getByTestId("citation");
  await expect(citation).toHaveCount(1);
  await expect(citation).toHaveAttribute("data-check", "found");
  // A text file is cited by its lines (ADR-0011): the spring tides are on line 2.
  await expect(citation.getByTestId("citation-chip")).toHaveAttribute(
    "aria-label",
    /^Citation 1: Tide tables, line 2\. /,
  );

  // Once the folder is renamed on disk, its Folder is gone: the composer's chip shows it,
  // struck through, the Answer's steps say so, and regenerating searches nothing and says so.
  await rename(join(notes, "Ocean"), join(notes, "Sea"));
  await expect(composerChip).toHaveAttribute("data-deleted", "true");
  await expect(composerChip.locator("s")).toHaveText("Deleted Folder");
  await expect(searched).toContainText("Searched “Deleted Folder” ·");
  await answer.hover();
  await answer.getByTestId("answer-regenerate").click();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  // Not refused: the model answers, and the line says the scope has no Documents.
  await expect(answer.getByTestId("answer-empty-scope")).toContainText("has no Documents");
  await expect(answer.getByTestId("citation")).toHaveCount(0);

  // The chip's × takes it out of the composer's scope.
  await composerChip.getByTestId("scope-chip-remove").click();
  await expect(composer.getByTestId("composer-scope-all")).toBeVisible();

  // Clicking the chip types the "@" that opens the picker.
  await composer.getByTestId("composer-scope-all").click();
  await expect(picker).toBeVisible();
  await expect(composer.getByTestId("composer-input")).toHaveValue("@");
  await window.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await app.close();
});

test("an in-app folder scopes answers and deleting it never broadens the search", async () => {
  const ocean = join(sources, "Tide tables.txt");
  const kitchen = join(sources, "Spring menu.txt");
  await writeFile(
    ocean,
    "Neap tides are the smallest of the month.\nSpring tides happen at new moon and at full moon.\n",
  );
  await writeFile(kitchen, "Spring tides happen when the market sells mussels.");
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await dismissChatSetup(window);
    await connectLocalChatModel(window);
    const folderId = await window.evaluate(
      async (paths) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const folder = await core.createLibraryGroup({
          name: "Ocean research",
          description: "Research about tides",
        });
        const added = await core.addDocuments(paths);
        const doc = added.documents.find((doc) => doc.name === "Tide tables");
        if (!doc) throw new Error("No tide document");
        await core.assignDocumentGroup(doc.id, folder.id);
        return folder.id;
      },
      [ocean, kitchen],
    );
    await expectReadyDocuments(window, 2);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("@Ocean");
    const choices = window.getByTestId("scope-choice");
    await expect(choices).toHaveCount(1);
    await window.keyboard.press("Enter");
    const composerChip = window.getByTestId("composer").getByTestId("scope-chip");
    await expect(composerChip).toHaveText("Ocean research");
    await window.keyboard.type("When do spring tides happen?");
    await window.keyboard.press("Enter");
    const answer = assistantAnswers(window).last();
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    const searched = answer.getByTestId("answer-steps");
    await expect(searched).toContainText("Searched “Ocean research” ·");
    await expect(answer.getByTestId("citation")).toHaveCount(1);
    await expect(answer.getByTestId("citation-chip")).toHaveAttribute(
      "aria-label",
      /^Citation 1: Tide tables/,
    );
    await window.evaluate(
      async (id) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.deleteLibraryGroup(id),
      folderId,
    );
    await expect(composerChip).toHaveAttribute("data-deleted", "true");
    // A deleted Folder keeps its name where it is named: struck through on the chip, and on
    // the steps of the Answer that searched it.
    await expect(composerChip.locator("s")).toHaveText("Ocean research");
    await expect(searched).toContainText("Searched “Ocean research” ·");
    await openSteps(window, answer);
    await answer.getByTestId("answer-regenerate").click();
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    // Not refused: the model answers, and the line says the scope has no Documents.
    await expect(answer.getByTestId("answer-empty-scope")).toContainText("has no Documents");
    await expect(answer.getByTestId("citation")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("a Mind in a Folder asks within it by default: its chip can be taken out to search everything, and deleting the Folder moves the Mind out", async () => {
  const ocean = join(sources, "Tide tables.txt");
  const kitchen = join(sources, "Spring menu.txt");
  await writeFile(
    ocean,
    "Neap tides are the smallest of the month.\nSpring tides happen at new moon and at full moon.\n",
  );
  await writeFile(kitchen, "Spring tides happen when the market sells mussels.\n");
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await dismissChatSetup(window);
    await connectLocalChatModel(window);
    const folderId = await window.evaluate(
      async (paths) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const folder = await core.createLibraryGroup({ name: "Ocean research", description: "" });
        const added = await core.addDocuments(paths);
        const doc = added.documents.find((each) => each.name === "Tide tables");
        if (!doc) throw new Error("No tide document");
        await core.assignDocumentGroup(doc.id, folder.id);
        return folder.id;
      },
      [ocean, kitchen],
    );
    await expectReadyDocuments(window, 2);

    // "New note here", from the Folder's menu.
    const folder = sidebarFolder(window, "Ocean research");
    await folder.getByTestId("folder-row").click({ button: "right" });
    await folder.getByTestId("folder.newMind").click();
    await expect(folder.getByTestId("mind-row")).toHaveCount(1);
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.press("ControlOrMeta+j");
    const composer = window.getByTestId("composer");
    const composerChip = composer.getByTestId("scope-chip");
    // The Folder is the chip already, without "@".
    await expect(composerChip).toHaveText("Ocean research");
    await expect(composerChip).toHaveAttribute("data-id", folderId);
    await expect(composerChip).toHaveAttribute("data-own", "true");
    await window.keyboard.type("When do spring tides happen?");
    await window.keyboard.press("Enter");
    const answers = assistantAnswers(window);
    await expect(answers.first()).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    await expect(answers.first().getByTestId("answer-steps")).toContainText(
      "Searched “Ocean research” ·",
    );
    await expect(answers.first().getByTestId("citation-chip")).toHaveAttribute(
      "aria-label",
      /^Citation 1: Tide tables/,
    );

    // Its ×: every Document, kept for the Mind's next Questions.
    await composerChip.getByTestId("scope-chip-remove").click();
    await expect(composer.getByTestId("composer-scope-all")).toBeVisible();
    await composer.getByTestId("composer-input").click();
    await window.keyboard.type("When do spring tides happen, anywhere?");
    await window.keyboard.press("Enter");
    const second = answers.nth(1);
    await expect(second).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    await expect((await openSteps(window, second)).getByTestId("answer-step-found")).toContainText(
      "2 passages found",
    );
    await expect(composer.getByTestId("composer-scope-all")).toBeVisible();

    // Deleted, the Folder's Mind is Not in a Folder; the first Answer's steps keep its name.
    await window.evaluate(
      async (id) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.deleteLibraryGroup(id),
      folderId,
    );
    await expect(window.getByTestId("not-in-a-folder").getByTestId("mind-list-item")).toHaveCount(
      1,
    );
    await expect(answers.first().getByTestId("answer-steps")).toContainText(
      "Searched “Ocean research” ·",
    );
    await expect(second.getByTestId("answer-steps")).toContainText("Searched All Documents ·");
    await expect(composer.getByTestId("composer-scope-all")).toBeVisible();
  } finally {
    await app.close();
  }
});
