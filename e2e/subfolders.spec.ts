import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  dragOnto,
  launchApp,
  leaveText,
  motionSettled,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sidebarFolder,
} from "./app";

/*
 * Folders inside Folders (#246): a Folder holds Folders, each searching those
 * inside it; a Folder nests by drag (a box on the middle, a line at an edge)
 * or by Move to… (⇧⌘M) with the Folder tree; a Folder can't go inside itself
 * or its own sub-Folders, and the target says why; New Folder (⇧⌘N) with a
 * Folder focused makes it inside; a Folder's section counts what its
 * sub-Folders hold; deleting it takes the sub-Folders as one Recently deleted
 * item and Restore brings them all back. In English and Chinese. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots there.
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

async function screenshot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const nameField = (window: Page) => window.getByTestId("folder-rename-field");
const undoMessage = (window: Page) => window.getByTestId("undo-line").getByTestId("undo-message");
/** A Folder's own row: not the rows of the Folders inside it, which its list holds too. */
const row = (window: Page, name: string) =>
  sidebarFolder(window, name).locator(":scope > div").getByTestId("folder-row");
const folderMenu = (window: Page, name: string) =>
  sidebarFolder(window, name).locator(":scope > div").getByTestId("folder-menu");

/** Each Folder's name and the Folder it is in, by name, as the core has it. */
async function folders(window: Page): Promise<Record<string, string | null>> {
  return (await coreOf(window)).evaluate(async (core: CoreBridge) => {
    const groups = (await core.getLibrary()).groups;
    const nameOf = (id: string | null) => groups.find((each) => each.id === id)?.name ?? null;
    return Object.fromEntries(groups.map((group) => [group.name, nameOf(group.parentId)]));
  });
}

/** Makes "Untitled Folder" at the top level (⇧⌘N with nothing focused), and names it. */
async function newFolder(window: Page, name: string): Promise<void> {
  await leaveText(window);
  await window.keyboard.press("ControlOrMeta+Shift+n");
  await expect(nameField(window)).toBeFocused();
  await window.keyboard.type(name);
  await window.keyboard.press("Enter");
  await expect(nameField(window)).toHaveCount(0);
  // Named, the row takes the focus back: the next key acts on it, not on what was before.
  await expect(sidebarFolder(window, name).getByTestId("folder-row")).toBeFocused();
}

/** Makes a Folder inside the focused one with ⇧⌘N (criterion 4), and names it. */
async function newFolderInside(window: Page, focused: string, name: string): Promise<void> {
  await row(window, focused).focus();
  await expect(row(window, focused)).toBeFocused();
  await window.keyboard.press("ControlOrMeta+Shift+n");
  await expect(nameField(window)).toBeFocused();
  await window.keyboard.type(name);
  await window.keyboard.press("Enter");
  await expect(nameField(window)).toHaveCount(0);
}

async function nestedRow(window: Page, name: string, depth: number): Promise<Locator> {
  const folder = sidebarFolder(window, name);
  await expect(folder).toHaveCount(1);
  await expect(folder).toHaveAttribute("data-depth", String(depth));
  return row(window, name);
}

/** Files a Document in a Folder through the bridge, as Organize or a drop would. */
async function fileIn(window: Page, documentId: string, folderId: string): Promise<void> {
  await (await coreOf(window)).evaluate(
    async (core, ids) => core.assignDocumentGroup(ids.documentId, ids.folderId),
    { documentId, folderId },
  );
}

async function openLibrary(window: Page): Promise<void> {
  await pointAndClick(window, window.getByTestId("open-library"));
  await expect(window.getByTestId("library")).toBeVisible();
}

const sectionOf = (window: Page, name: string) =>
  window
    .getByTestId("library-section")
    .filter({ has: window.getByTestId("library-section-name").getByText(name, { exact: true }) });

for (const [language, width] of [
  ["en", 1440],
  ["en", 1100],
  ["zh-CN", 1440],
  ["zh-CN", 1100],
] as const) {
  test(`Folders nest by drag and by ⇧⌘M, refuse themselves, count what is inside them, and come back whole from Recently deleted (${language}, ${width}px)`, async () => {
    test.setTimeout(180_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true, examples: false });
    try {
      await setWindowSize(app, window, width, 800);
      await dismissChatSetup(window);
      if (language !== "en") await setLanguage(window, language);
      const folderIds = async (name: string) =>
        (await coreOf(window)).evaluate(async (core: CoreBridge, wanted: string) => {
          const group = (await core.getLibrary()).groups.find((each) => each.name === wanted);
          return group?.id ?? "";
        }, name);

      const sensor = join(sources, "Sensor readings.txt");
      await writeFile(sensor, "Sensor 14 in Hyde Park was moved 20 m east on 17 July.\n");
      await addDocuments(window, [sensor]);

      // A Folder, a Folder at the top level beside it, and one made inside with ⇧⌘N.
      await newFolder(window, language === "en" ? "Thesis: urban heat" : "论文：城市热岛");
      const thesis = language === "en" ? "Thesis: urban heat" : "论文：城市热岛";
      const field = language === "en" ? "Field data" : "实地数据";
      const chapter = language === "en" ? "Chapter 2" : "第二章";
      await newFolder(window, field);
      await newFolderInside(window, thesis, chapter);
      await expect.poll(() => folders(window)).toMatchObject({ [chapter]: thesis });
      await nestedRow(window, chapter, 1);

      // Nest by drag: Field data dropped on Thesis's middle goes inside, the row a box saying so.
      await dragOnto(window, row(window, field), row(window, thesis), async () => {
        await expect(window.getByTestId("drop-label")).toHaveText(
          language === "en" ? "Put inside" : "放入其中",
        );
        await screenshot(window, `subfolders-${language}-${width}-drag-into`);
      });
      await expect.poll(() => folders(window)).toMatchObject({ [field]: thesis });
      await nestedRow(window, field, 1);
      await expect(undoMessage(window)).toHaveText(
        language === "en"
          ? `Moved the Folder “Field data” into “Thesis: urban heat”`
          : `已将文件夹“实地数据”移入“论文：城市热岛”`,
      );
      await motionSettled(window);
      await screenshot(window, `subfolders-${language}-${width}-nested`);
      await leaveText(window);
      await window.keyboard.press("ControlOrMeta+z");
      await expect.poll(() => folders(window)).toMatchObject({ [field]: null });
      await window.keyboard.press("ControlOrMeta+Shift+z");
      await expect.poll(() => folders(window)).toMatchObject({ [field]: thesis });

      // A Folder can't go inside itself or one of its own sub-Folders: the target says why.
      await dragOnto(window, row(window, thesis), row(window, chapter), async () => {
        await expect(window.getByTestId("drop-refusal")).toBeVisible();
        await screenshot(window, `subfolders-${language}-${width}-drag-refusal`);
      });
      expect(await folders(window)).toMatchObject({ [thesis]: null, [chapter]: thesis });
      await dragOnto(window, row(window, thesis), row(window, thesis), async () => {
        await expect(window.getByTestId("drop-refusal")).toBeVisible();
      });
      expect(await folders(window)).toMatchObject({ [thesis]: null });

      // Move to… (⇧⌘M) takes it out to the top level: one ⌘Z puts it back.
      await nestedRow(window, field, 1);
      await row(window, field).focus();
      await window.keyboard.press("ControlOrMeta+Shift+m");
      const picker = window.getByTestId("move-to-picker");
      await expect(picker).toBeVisible();
      await motionSettled(window);
      await screenshot(window, `subfolders-${language}-${width}-move-to`);
      await picker
        .getByTestId("move-to-option")
        .filter({ hasText: language === "en" ? "Top level" : "顶层" })
        .click();
      await expect.poll(() => folders(window)).toMatchObject({ [field]: null });
      await expect(undoMessage(window)).toHaveText(
        language === "en"
          ? `Moved the Folder “Field data” out of “Thesis: urban heat”`
          : `已将文件夹“实地数据”移出“论文：城市热岛”`,
      );
      await leaveText(window);
      await window.keyboard.press("ControlOrMeta+z");
      await expect.poll(() => folders(window)).toMatchObject({ [field]: thesis });

      // The same by keyboard: out, then ⇧⌘M with the tree filtered by name finds Thesis; Enter
      // nests it, and the line names the Folder it went into.
      await row(window, field).focus();
      await window.keyboard.press("ControlOrMeta+Shift+m");
      await expect(picker).toBeVisible();
      await picker
        .getByTestId("move-to-option")
        .filter({ hasText: language === "en" ? "Top level" : "顶层" })
        .click();
      await expect.poll(() => folders(window)).toMatchObject({ [field]: null });
      await row(window, field).focus();
      await window.keyboard.press("ControlOrMeta+Shift+m");
      await expect(picker).toBeVisible();
      const optionNamed = (name: string) =>
        picker.getByTestId("move-to-option").filter({
          has: window.getByTestId("move-to-option-label").getByText(name, { exact: true }),
        });
      // The tree indents each Folder a level, and filtering keeps its parent's name beside it.
      await expect(optionNamed(chapter).getByTestId("move-to-option-label")).toHaveCSS(
        "padding-left",
        "16px",
      );
      await picker.getByTestId("move-to-search").fill(language === "en" ? "Chapter" : "第二");
      if (language === "en") {
        await expect(optionNamed(chapter).getByTestId("move-to-option-detail")).toHaveText(
          "in Thesis: urban heat",
        );
      }
      await picker.getByTestId("move-to-search").fill(language === "en" ? "Thes" : "论文");
      await optionNamed(thesis).click();
      await expect.poll(() => folders(window)).toMatchObject({ [field]: thesis });
      await expect(undoMessage(window)).toHaveText(
        language === "en"
          ? `Moved the Folder “Field data” into “Thesis: urban heat”`
          : `已将文件夹“实地数据”移入“论文：城市热岛”`,
      );
      await leaveText(window);
      await window.keyboard.press("ControlOrMeta+z");
      await expect.poll(() => folders(window)).toMatchObject({ [field]: null });
      await window.keyboard.press("ControlOrMeta+Shift+z");
      await expect.poll(() => folders(window)).toMatchObject({ [field]: thesis });

      // A Folder opened from the sidebar opens its section and brings its row into view.
      await sidebarFolder(window, chapter).hover();
      await folderMenu(window, chapter).click();
      await sidebarFolder(window, chapter)
        .locator(":scope > div")
        .getByTestId("folder.open")
        .click();
      await expect(window.getByTestId("library")).toBeVisible();
      await expect(
        window.getByTestId("library-subfolder-name").filter({ hasText: chapter }),
      ).toBeFocused();
      await pointAndClick(window, window.getByTestId("open-library"));

      // A Folder opened from the sidebar opens its section and brings its row into view.
      await sidebarFolder(window, chapter).hover();
      await folderMenu(window, chapter).click();
      await sidebarFolder(window, chapter)
        .locator(":scope > div")
        .getByTestId("folder.open")
        .click();
      await expect(window.getByTestId("library")).toBeVisible();
      await expect(
        window.getByTestId("library-subfolder-name").filter({ hasText: chapter }),
      ).toBeFocused();
      await pointAndClick(window, window.getByTestId("open-library"));

      // The Folder's section counts what its sub-Folders hold, and a Mind in it searches there.
      const thesisId = await folderIds(thesis);
      const chapterId = await folderIds(chapter);
      const documentId = await window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        return (await bridge.listDocuments())[0]?.id ?? "";
      });
      await fileIn(window, documentId, chapterId);
      const counted = await (await coreOf(window)).evaluate(
        async (core: CoreBridge, id: string) =>
          core.countScopeDocuments({ folderIds: [id], tagIds: [], documentIds: [] }),
        thesisId,
      );
      expect(counted).toBe(1);

      await sidebarFolder(window, chapter).hover();
      await folderMenu(window, chapter).click();
      await sidebarFolder(window, chapter)
        .locator(":scope > div")
        .getByTestId("folder.newMind")
        .click();
      const scope = window.getByTestId("composer-scope");
      await expect(scope).toBeVisible();
      await expect(scope.getByTestId("scope-chip").first()).toHaveAttribute("data-id", chapterId);
      if (language === "en") {
        await expect(scope.getByTestId("scope-chip").first()).toHaveAttribute(
          "title",
          /Thesis: urban heat › Chapter 2.*1 Document/,
        );
      }

      // The Library opens the sub-Folder holding a search's match and shows its path.
      await openLibrary(window);
      const library = window.getByTestId("library");
      // The section counts what its sub-Folders hold.
      await expect(sectionOf(window, thesis).getByTestId("library-section-subfolders")).toHaveText(
        language === "en" ? "· 1 in subfolders" : "· 子文件夹中 1 个",
      );
      // A search opens the sub-Folders holding a match and shows each match's path.
      await library.getByTestId("library-search").fill("Hyde Park");
      await expect(library.getByTestId("library-path").first()).toHaveText(
        language === "en" ? "Thesis: urban heat › Chapter 2" : "论文：城市热岛 › 第二章",
      );
      await expect(
        sectionOf(window, thesis).getByTestId("library-subfolder-name").filter({
          hasText: chapter,
        }),
      ).toBeVisible();
      await motionSettled(window);
      await screenshot(window, `subfolders-${language}-${width}-search`);
      await library.getByTestId("library-search").fill("");
      // Opening the sub-Folder lists what is in it, in place.
      await motionSettled(window);
      const subfolder = sectionOf(window, thesis)
        .getByTestId("library-subfolder-name")
        .filter({ hasText: chapter });
      await subfolder.focus();
      await window.keyboard.press("Enter");
      await expect(subfolder).toHaveAttribute("aria-expanded", "true");
      await motionSettled(window);
      await expect(
        sectionOf(window, thesis).getByTestId("library-document-name").filter({
          hasText: "Sensor readings",
        }),
      ).toBeVisible();
      await screenshot(window, `subfolders-${language}-${width}-library-open`);

      // Deleting the outer Folder takes the two sub-Folders as one Recently deleted item.
      await sidebarFolder(window, thesis).hover();
      await folderMenu(window, thesis).click();
      await sidebarFolder(window, thesis)
        .locator(":scope > div")
        .getByTestId("folder.delete")
        .click();
      await expect(window.getByTestId("library-folders").getByTestId("library-folder")).toHaveCount(
        0,
      );
      const deleted = await (await coreOf(window)).evaluate(async (core: CoreBridge) =>
        core.listDeleted(),
      );
      expect(deleted.filter((item) => item.kind === "folder").map((item) => item.name)).toEqual([
        thesis,
      ]);
      await expect(window.getByTestId("recently-deleted")).toBeVisible();
      const head = window.getByTestId("deleted-section-head");
      if ((await head.getAttribute("data-open")) === "false") {
        await pointAndClick(window, head.getByTestId("deleted-heading"));
      }
      const deletedRow = window
        .getByTestId("deleted-item")
        .filter({ has: window.getByTestId("deleted-name").getByText(thesis, { exact: true }) });
      await expect(deletedRow).toHaveCount(1);
      await screenshot(window, `subfolders-${language}-${width}-deleted`);

      // Restore brings both back where they were, with the Document in the one it was in.
      await deletedRow.getByTestId("deleted-restore").click();
      await expect
        .poll(() => folders(window))
        .toMatchObject({
          [thesis]: null,
          [chapter]: thesis,
          [field]: thesis,
        });
      const assignments = await (await coreOf(window)).evaluate(async (core: CoreBridge) =>
        core.getLibrary(),
      );
      expect(assignments.assignments.find((each) => each.documentId === documentId)?.groupId).toBe(
        chapterId,
      );
      await nestedRow(window, chapter, 1);
      await screenshot(window, `subfolders-${language}-${width}-restored`);
    } finally {
      await app.close();
    }
  });
}
