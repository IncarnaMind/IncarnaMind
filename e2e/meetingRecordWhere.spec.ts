import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  addDocuments,
  coreOf,
  createDataFolder,
  documentIdOf,
  expectHomeInFront,
  frontMindName,
  launchApp,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  sidebarFolder,
} from "./app";

/*
 * + › Record a meeting makes the meeting's Note where the User is (#3762): in the Folder of the
 * Document or the Note in front, and Not in a Folder with Home in front.
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

const FOLDER = "Harbour";

async function makeFolder(window: Page): Promise<string> {
  const folder = await (await coreOf(window)).evaluate(
    (core, name) =>
      core.createLibraryGroup({ name, description: "Calls about the harbour works." }),
    FOLDER,
  );
  return folder.id;
}

/** A Note in the Folder, through the core. */
async function makeNoteIn(window: Page, folderId: string): Promise<string> {
  const note = await (await coreOf(window)).evaluate(
    (core, folder) => core.createMind({ title: "Brief", folderId: folder }),
    folderId,
  );
  return note.id;
}

/** The Folder's row in the sidebar, opened so it lists what is in it. */
async function openedFolder(window: Page): Promise<Locator> {
  const folder = sidebarFolder(window, FOLDER);
  const row = folder.getByTestId("folder-row");
  if ((await row.getAttribute("aria-expanded")) !== "true") await pointAndClick(window, row);
  await expect(row).toHaveAttribute("aria-expanded", "true");
  return folder;
}

const noteRow = (scope: Locator, mindId: string) =>
  scope.locator(`[data-testid="mind-list-item"][data-mind-id="${mindId}"]`);

/** Opens the Note from its row in the Folder, as the User does. */
async function openNoteInFolder(window: Page, mindId: string): Promise<void> {
  await pointAndClick(window, noteRow(await openedFolder(window), mindId));
  await expect(frontMindName(window)).toHaveText("Brief");
}

/** The Note of the Meeting recording now, as the core lists it. */
async function recordingNote(window: Page) {
  const core = await coreOf(window);
  const recording = (await core.evaluate((each) => each.listMeetings())).find(
    (each) => each.status === "recording",
  );
  if (!recording) throw new Error("No Meeting is recording.");
  const note = (await core.evaluate((each) => each.listMinds())).find(
    (each) => each.id === recording.mindId,
  );
  if (!note) throw new Error("The recording Meeting has no Note.");
  return note;
}

/** The meeting's Note is in the Folder, in the core and under the Folder in the sidebar. */
async function expectNoteInFolder(window: Page, folderId: string): Promise<void> {
  const note = await recordingNote(window);
  expect(note.folderId).toBe(folderId);
  await expect(noteRow(await openedFolder(window), note.id)).toHaveCount(1);
  await expect(noteRow(window.getByTestId("not-in-a-folder"), note.id)).toHaveCount(0);
}

test("with a Document of a Folder in front, + › Record a meeting makes the meeting's Note in that Folder", async () => {
  const { window } = await launchApp(dataDir);
  const file = join(sources, "Rebate terms.md");
  await writeFile(file, "# Rebate terms\n\nRebates stay as they are until January.\n");
  await addDocuments(window, [file]);
  const documentId = await documentIdOf(window, "Rebate terms");
  const folderId = await makeFolder(window);
  await (await coreOf(window)).evaluate(
    (core, [document, group]) => core.assignDocumentGroup(document, group),
    [documentId, folderId] as const,
  );

  const folder = await openedFolder(window);
  await pointAndClick(
    window,
    folder.locator(`[data-testid="document-list-item"][data-document-id="${documentId}"]`),
  );
  await expect(
    window.locator(`[data-testid="document-tab"][data-document-id="${documentId}"]`),
  ).toHaveAttribute("aria-selected", "true");

  await recordMeeting(window);
  await expectNoteInFolder(window, folderId);
});

test("with a Note of a Folder in front, + › Record a meeting makes the meeting's Note in that Folder", async () => {
  const { window } = await launchApp(dataDir);
  const folderId = await makeFolder(window);
  await openNoteInFolder(window, await makeNoteIn(window, folderId));

  await recordMeeting(window);
  await expect(frontMindName(window)).not.toHaveText("Brief");
  await expectNoteInFolder(window, folderId);
});

test("with Home in front, + › Record a meeting makes the meeting's Note Not in a Folder, though a Note of a Folder was in front before", async () => {
  const { window } = await launchApp(dataDir);
  const folderId = await makeFolder(window);
  await openNoteInFolder(window, await makeNoteIn(window, folderId));
  await pointAndClick(window, window.getByTestId("sidebar-home"));
  await expectHomeInFront(window);

  await recordMeeting(window);
  const note = await recordingNote(window);
  expect(note.folderId).toBeNull();
  await expect(noteRow(window.getByTestId("not-in-a-folder"), note.id)).toHaveCount(1);
  await expect(noteRow(await openedFolder(window), note.id)).toHaveCount(0);
});
