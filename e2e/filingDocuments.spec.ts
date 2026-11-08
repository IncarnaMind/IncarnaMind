import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  coreOf,
  createDataFolder,
  decisionServer,
  dismissChatSetup,
  dragOnto,
  interceptOpenDialog,
  launchApp,
  leaveText,
  motionSettled,
  paletteFound,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sidebarFolder,
} from "./app";

/*
 * Filing Documents with the shared building blocks (#212): a row dragged onto
 * a sidebar Folder or "Not in a Folder", several selected dragged together, a
 * file from Finder dropped on a Folder while only the Folder lights and the
 * card's overlay stays quiet, Move to… by ⇧⌘M and from the Folder line a
 * search shows, each move with one ⌘Z that puts every Document back; the
 * registry's menus on a Document and a Folder, with Add Documents here… run
 * from the menu by keyboard and from ⌘K, New note here, Rename and Delete; no
 * dropdown on a row and no row of text buttons on the Folder's page; the
 * sidebar's and the Library's counts after every move; and an automatic
 * Folder kept automatic when a move is taken back. English and Simplified
 * Chinese, at 900 and 1,600 pixels.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(target: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
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

const WORDS = {
  en: {
    folders: { finance: "Finance", research: "Research", archive: "Archive" },
    documents: ["Budget", "Ledger", "Survey", "Minutes"],
    notInFolder: "Not in a Folder",
    movedOne: (name: string, folder: string) => `Moved “${name}” to ${folder}`,
    movedMany: (count: number, folder: string) => `Moved ${count} Documents to ${folder}`,
    moveLabel: (folder: string) => `Move to ${folder}`,
    moveLabelMany: (count: number, folder: string) => `Move ${count} Documents to ${folder}`,
    dropFiles: (folder: string) => `Add to ${folder}`,
    addToLibrary: "Add to Library",
    cardDrop: "Drop files to add them, or a folder to link it",
    addedOne: "Added 1 Document",
    folderRenamed: (name: string) => `Renamed to “${name}”`,
    folderDeleted: (name: string) => `Moved “${name}” to Recently deleted`,
    newNoteHere: "New note here",
    addDocumentsHere: "Add Documents here…",
    rename: "Rename",
    delete: "Delete",
    folderPageButtons: /^(new folder|starter folders|edit folder|delete folder)$/i,
  },
  "zh-CN": {
    folders: { finance: "财务", research: "调研", archive: "归档" },
    documents: ["预算", "明细", "问卷", "记录"],
    notInFolder: "不在文件夹中",
    movedOne: (name: string, folder: string) => `已将“${name}”移动到“${folder}”`,
    movedMany: (count: number, folder: string) => `已将 ${count} 个文档移动到“${folder}”`,
    moveLabel: (folder: string) => `移动到“${folder}”`,
    moveLabelMany: (count: number, folder: string) => `将 ${count} 个文档移动到“${folder}”`,
    dropFiles: (folder: string) => `添加到“${folder}”`,
    addToLibrary: "加入资料库",
    cardDrop: "松开即可添加文件；松开文件夹则添加为关联文件夹",
    addedOne: "已添加 1 个文档",
    folderRenamed: (name: string) => `已重命名为“${name}”`,
    folderDeleted: (name: string) => `已将“${name}”移到回收站`,
    newNoteHere: "在此新建笔记",
    addDocumentsHere: "在此添加文档…",
    rename: "重命名",
    delete: "删除",
    folderPageButtons: /^(新建文件夹|预设文件夹|编辑文件夹|删除文件夹)$/,
  },
} as const;

type Language = keyof typeof WORDS;
type Words = (typeof WORDS)[Language];

interface Seeded {
  finance: string;
  research: string;
  archive: string;
}

interface Counts {
  finance: number;
  research: number;
  archive: number;
  loose: number;
  /** How many Documents the Library holds in all. */
  total: number;
}

async function seed(window: Page, words: Words): Promise<Seeded> {
  const paths = words.documents.map((name) => join(sources, `${name}.txt`));
  for (const [at, name] of words.documents.entries()) {
    await writeFile(paths[at] as string, `${name} ${at}: the harbour project's figures.`);
  }
  const seeded = await (await coreOf(window)).evaluate(
    async (core: CoreBridge, input) => {
      const finance = await core.createLibraryGroup({
        name: input.folders.finance,
        description: "",
      });
      const research = await core.createLibraryGroup({
        name: input.folders.research,
        description: "",
      });
      const archive = await core.createLibraryGroup({
        name: input.folders.archive,
        description: "",
      });
      await core.addDocuments(input.paths);
      return { finance: finance.id, research: research.id, archive: archive.id };
    },
    { paths, folders: words.folders },
  );
  await expect(window.getByTestId("document-list-item")).toHaveCount(words.documents.length);
  return seeded;
}

const libraryRow = (library: Locator, name: string): Locator =>
  library.getByTestId("library-document").filter({
    has: library.page().getByTestId("library-document-name").getByText(name, { exact: true }),
  });

const section = (library: Locator, key: string): Locator =>
  library.locator(`[data-testid="library-section"][data-section="${key}"]`);

/** The Folder a Document is filed in, by its name, from the core. */
const folderOfDocument = async (window: Page, name: string): Promise<string | null> =>
  (await coreOf(window)).evaluate(async (core: CoreBridge, documentName: string) => {
    const document = (await core.listDocuments()).find((each) => each.name === documentName);
    if (!document) return null;
    const library = await core.getLibrary();
    return library.assignments.find((each) => each.documentId === document.id)?.groupId ?? null;
  }, name);

/** What the core says about a Document's Folder: the assignment's Folder and who chose it. */
const assignmentOf = async (window: Page, name: string) =>
  (await coreOf(window)).evaluate(async (core: CoreBridge, documentName: string) => {
    const document = (await core.listDocuments()).find((each) => each.name === documentName);
    if (!document) return null;
    const library = await core.getLibrary();
    const assignment = library.assignments.find((each) => each.documentId === document.id);
    return assignment ? { groupId: assignment.groupId, source: assignment.source } : null;
  }, name);

/** The Folder of the User's that waits in Suggestions for a Document, by its name; null: none. */
const proposedFolderOf = async (window: Page, name: string): Promise<string | null> =>
  (await coreOf(window)).evaluate(async (core: CoreBridge, documentName: string) => {
    const [documents, review, library] = await Promise.all([
      core.listDocuments(),
      core.getOrganizeReview(),
      core.getLibrary(),
    ]);
    const document = documents.find((each) => each.name === documentName);
    const placement = review.items.find((each) => each.documentId === document?.id)?.placement;
    if (placement?.kind !== "folder") return null;
    return library.groups.find((group) => group.id === placement.folderId)?.name ?? null;
  }, name);

async function folderNames(window: Page): Promise<string[]> {
  return (await coreOf(window)).evaluate(async (core: CoreBridge) =>
    (await core.getLibrary()).groups.map((group) => group.name),
  );
}

const mindCount = async (window: Page, folderId: string): Promise<number> =>
  (await coreOf(window)).evaluate(
    async (core: CoreBridge, id: string) =>
      (await core.listMinds()).filter((mind) => mind.folderId === id).length,
    folderId,
  );

async function openLibrary(window: Page): Promise<Locator> {
  await pointAndClick(window, window.getByTestId("open-library"));
  const library = window.getByTestId("library");
  await expect(library).toBeVisible();
  return library;
}

async function undo(window: Page): Promise<void> {
  await leaveText(window);
  await window.keyboard.press("ControlOrMeta+z");
}

const undoMessage = (window: Page) => window.getByTestId("undo-message");

/**
 * Types a Folder's name in Move to…, and waits until the filtered list has it as the row Enter
 * chooses: a typed name reaches the list a render after the field, and Enter before that takes
 * the first row, "Not in a Folder".
 */
async function typeFolderInto(window: Page, picker: Locator, name: string): Promise<void> {
  await window.keyboard.type(name);
  await expect(
    picker.locator('[data-testid="move-to-option"][aria-selected="true"]'),
  ).toContainText(name);
}

/** ⌘-click on a row: one of several selected. */
const addToSelection = (window: Page, row: Locator): Promise<void> =>
  pointAndClick(window, row.getByTestId("library-document-name"), {
    modifiers: ["ControlOrMeta"],
  });

/** What the sidebar and the Library say each Folder and Not in a Folder hold, and the Library's total. */
async function expectCounts(
  window: Page,
  library: Locator,
  seeded: Seeded,
  counts: Counts,
): Promise<void> {
  const byFolder: [string, number][] = [
    [seeded.finance, counts.finance],
    [seeded.research, counts.research],
    [seeded.archive, counts.archive],
  ];
  for (const [key, count] of byFolder) {
    const sidebar = window
      .getByTestId("library-folders")
      .locator(`[data-testid="library-folder"][data-folder-id="${key}"]`);
    await expect(sidebar).toHaveAttribute("data-count", String(count));
    await expect(sidebar.getByTestId("browse-count")).toHaveText(String(count));
    await expect(section(library, key)).toHaveAttribute("data-count", String(count));
  }
  await expect(window.getByTestId("not-in-a-folder")).toHaveAttribute(
    "data-count",
    String(counts.loose),
  );
  await expect(section(library, "not-in-a-folder")).toHaveAttribute(
    "data-count",
    String(counts.loose),
  );
  await expect(library.getByTestId("library-count")).toHaveText(String(counts.total));
}

/** Writes one file for a drop from Finder, and gives its path. */
async function droppedFile(name: string): Promise<string> {
  const path = join(sources, `${name}.txt`);
  await writeFile(path, `${name}: dropped from Finder onto a Folder.\n`);
  return path;
}

/**
 * Drops files from outside the window onto `target`, as Finder does: the
 * browser's own drag events, carrying real paths, at the target's middle.
 * Given `way`, the drag visits each place first, and each `check` looks at
 * what the window shows there before it moves on.
 */
async function dropFromFinder(
  window: Page,
  target: Locator,
  paths: readonly string[],
  whileOver?: () => Promise<void>,
  way: readonly {
    at: Locator;
    check: (point: { x: number; y: number }) => Promise<void>;
  }[] = [],
): Promise<void> {
  const middleOf = async (locator: Locator) => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) throw new Error("The drop target isn't showing.");
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  };
  const data = {
    items: [{ mimeType: "text/plain", data: "" }],
    files: [...paths],
    dragOperationsMask: 1,
  };
  const session = await window.context().newCDPSession(window);
  try {
    const [first] = way;
    const start = await middleOf(first?.at ?? target);
    await session.send("Input.dispatchDragEvent", { type: "dragEnter", ...start, data });
    await session.send("Input.dispatchDragEvent", { type: "dragOver", ...start, data });
    await first?.check(start);
    for (const step of way.slice(1)) {
      const point = await middleOf(step.at);
      await session.send("Input.dispatchDragEvent", { type: "dragOver", ...point, data });
      await step.check(point);
    }
    const point = await middleOf(target);
    await session.send("Input.dispatchDragEvent", { type: "dragOver", ...point, data });
    await whileOver?.();
    await session.send("Input.dispatchDragEvent", { type: "drop", ...point, data });
  } finally {
    await session.detach();
  }
}

/** The drop label sits under the pointer, kept inside the window by a few pixels. */
async function expectLabelByPointer(window: Page, point: { x: number; y: number }): Promise<void> {
  const box = await window.getByTestId("drop-label").boundingBox();
  if (!box) throw new Error("The drop label isn't showing.");
  const size = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const left = Math.max(4, Math.min(point.x - 12, size.width - box.width - 4));
  const top = Math.min(point.y + 20, size.height - box.height - 4);
  expect(Math.abs(box.x - left)).toBeLessThanOrEqual(2);
  expect(Math.abs(box.y - top)).toBeLessThanOrEqual(2);
}

/**
 * A file drag from Finder that crosses the card and a Folder, cancelled as the
 * browser does (Esc): no dragleave reaches the page, and the first pointer
 * move after it ends the drag. The next drag must light the card again, then
 * the Folders heading says the window's add (#229).
 */
async function cancelCrossingFinderDrag(
  window: Page,
  cardHeading: Locator,
  foldersHeading: Locator,
  folder: Locator,
  paths: readonly string[],
  cardWords: string,
  addWords: string,
): Promise<void> {
  const middleOf = async (locator: Locator) => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) throw new Error("The drop target isn't showing.");
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  };
  const data = {
    items: [{ mimeType: "text/plain", data: "" }],
    files: [...paths],
    dragOperationsMask: 1,
  };
  const session = await window.context().newCDPSession(window);
  try {
    const cardPoint = await middleOf(cardHeading);
    const folderPoint = await middleOf(folder.getByTestId("folder-row"));
    await session.send("Input.dispatchDragEvent", { type: "dragEnter", ...cardPoint, data });
    await session.send("Input.dispatchDragEvent", { type: "dragOver", ...cardPoint, data });
    await expect(window.getByTestId("drop-overlay")).toContainText(cardWords);
    await session.send("Input.dispatchDragEvent", { type: "dragOver", ...folderPoint, data });
    await expect(folder).toHaveAttribute("data-drop-target", "true");
    await session.send("Input.dispatchDragEvent", { type: "dragCancel", ...folderPoint, data });
    await window.mouse.move(folderPoint.x + 24, folderPoint.y + 24);
    await expect(folder).not.toHaveAttribute("data-drop-target", "true");
    await expect(window.getByTestId("drop-overlay")).toHaveCount(0);

    // The next drag after the cancel must light the card again, and the Folders heading must say
    // the window's own add rather than stay dark.
    await session.send("Input.dispatchDragEvent", { type: "dragEnter", ...cardPoint, data });
    await session.send("Input.dispatchDragEvent", { type: "dragOver", ...cardPoint, data });
    await expect(window.getByTestId("card").getByTestId("drop-overlay")).toContainText(cardWords);
    const headingPoint = await middleOf(foldersHeading);
    await session.send("Input.dispatchDragEvent", { type: "dragOver", ...headingPoint, data });
    await expect(window.getByTestId("drop-overlay")).toHaveCount(0);
    await expect(window.getByTestId("drop-label")).toHaveText(addWords);

    // Dragged out of the window, the label goes; brought back, it says the window's add again.
    await session.send("Input.dispatchDragEvent", {
      type: "dragOver",
      x: -30,
      y: headingPoint.y,
      data,
    });
    await expect(window.getByTestId("drop-label")).toHaveCount(0);
    await expect(window.getByTestId("drop-overlay")).toHaveCount(0);
    await session.send("Input.dispatchDragEvent", { type: "dragOver", ...headingPoint, data });
    await expect(window.getByTestId("drop-label")).toHaveText(addWords);

    await session.send("Input.dispatchDragEvent", { type: "dragCancel", ...headingPoint, data });
    await window.mouse.move(headingPoint.x + 24, headingPoint.y + 24);
    await expect(window.getByTestId("drop-label")).toHaveCount(0);
  } finally {
    await session.detach();
  }
}

for (const [language, width] of [
  ["en", 900],
  ["en", 1600],
  ["zh-CN", 900],
  ["zh-CN", 1600],
] as const) {
  test(`filing Documents: one dragged, three dragged, out of a Folder, a file dropped from Finder, Move to… by key and from the Folder line, each with one ⌘Z; the menus, the counts, and no dropdown (${language}, ${width}px)`, async () => {
    test.setTimeout(240_000);
    const words = WORDS[language];
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, width, 900);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      const seeded = await seed(window, words);
      const library = await openLibrary(window);
      const loose = words.documents.length;
      await expectCounts(window, library, seeded, {
        finance: 0,
        research: 0,
        archive: 0,
        loose,
        total: loose,
      });

      // One Document dragged from the Library onto a sidebar Folder: the Folder lights and says
      // what the drop would do; one ⌘Z puts it back, in the core and in both counts.
      const [first, second, third, fourth] = words.documents;
      const finance = sidebarFolder(window, words.folders.finance);
      await dragOnto(
        window,
        libraryRow(library, first).getByTestId("library-document-name"),
        finance,
        async () => {
          await expect(finance).toHaveAttribute("data-drop-target", "true");
          await expect(window.getByTestId("drop-label")).toHaveText(
            words.moveLabel(words.folders.finance),
          );
        },
      );
      await expect(window.getByTestId("drop-label")).toHaveCount(0);
      await expect(undoMessage(window)).toHaveText(words.movedOne(first, words.folders.finance));
      await expect.poll(() => folderOfDocument(window, first)).toBe(seeded.finance);
      await expectCounts(window, library, seeded, {
        finance: 1,
        research: 0,
        archive: 0,
        loose: loose - 1,
        total: loose,
      });
      await undo(window);
      await expect.poll(() => folderOfDocument(window, first)).toBeNull();
      await expectCounts(window, library, seeded, {
        finance: 0,
        research: 0,
        archive: 0,
        loose,
        total: loose,
      });

      // Three selected Documents dragged together: the label says how many, and one ⌘Z brings all back.
      for (const name of [first, second, third])
        await addToSelection(window, libraryRow(library, name));
      await expect(library.getByTestId("library-selection")).toContainText("3");
      const research = sidebarFolder(window, words.folders.research);
      await dragOnto(
        window,
        libraryRow(library, second).getByTestId("library-document-name"),
        research,
        async () => {
          await expect(research).toHaveAttribute("data-drop-target", "true");
          await expect(window.getByTestId("drop-label")).toHaveText(
            words.moveLabelMany(3, words.folders.research),
          );
        },
      );
      await expect(undoMessage(window)).toHaveText(words.movedMany(3, words.folders.research));
      // The drop's picture has faded into the Folder it landed in before the still is taken.
      await motionSettled(window);
      await screenshot(window, `moved-three-${language}-${width}`);
      for (const name of [first, second, third]) {
        await expect.poll(() => folderOfDocument(window, name)).toBe(seeded.research);
      }
      await expectCounts(window, library, seeded, {
        finance: 0,
        research: 3,
        archive: 0,
        loose: loose - 3,
        total: loose,
      });
      await undo(window);
      for (const name of [first, second, third]) {
        await expect.poll(() => folderOfDocument(window, name)).toBeNull();
      }
      await expectCounts(window, library, seeded, {
        finance: 0,
        research: 0,
        archive: 0,
        loose,
        total: loose,
      });

      // A Document dragged from the sidebar onto "Not in a Folder" comes out of its Folder.
      await dragOnto(
        window,
        libraryRow(library, fourth).getByTestId("library-document-name"),
        finance,
      );
      await expect.poll(() => folderOfDocument(window, fourth)).toBe(seeded.finance);
      // Open the Folder so its row shows (a drag that rested on it already opened it).
      if ((await finance.getAttribute("data-expanded")) !== "true") {
        await pointAndClick(window, finance.getByTestId("folder-row"));
      }
      await expect(finance).toHaveAttribute("data-expanded", "true");
      const inFolder = window
        .getByTestId("document-list-item")
        .filter({ has: window.getByTestId("row-text").getByText(fourth, { exact: true }) });
      await expect(inFolder).toHaveCount(1);
      const notInFolder = window.getByTestId("not-in-a-folder-section-heading");
      await dragOnto(window, inFolder.getByTestId("open-document"), notInFolder, async () => {
        await expect(notInFolder).toHaveAttribute("data-drop-target", "true");
        await expect(window.getByTestId("drop-label")).toHaveText(
          words.moveLabel(words.notInFolder),
        );
      });
      await expect(undoMessage(window)).toHaveText(words.movedOne(fourth, words.notInFolder));
      await expect.poll(() => folderOfDocument(window, fourth)).toBeNull();
      await expectCounts(window, library, seeded, {
        finance: 0,
        research: 0,
        archive: 0,
        loose,
        total: loose,
      });
      await undo(window);
      await expect.poll(() => folderOfDocument(window, fourth)).toBe(seeded.finance);

      // A file dropped from Finder onto the Folder is added into it, through the same target. Over
      // the card the card lights for the Library's add; over the Folders heading, Not in a Folder or
      // the composer the card stays quiet and the window's add says so by the pointer; over the
      // Folder only the Folder lights, so the sidebar is never covered.
      const droppedName = language === "en" ? "Field notes" : "现场记录";
      const dropped = await droppedFile(droppedName);
      await cancelCrossingFinderDrag(
        window,
        library.getByTestId("library-heading"),
        window.getByTestId("folders-title"),
        finance,
        [dropped],
        words.cardDrop,
        words.addToLibrary,
      );
      // After a cancelled file drag, dragging an app Document must not bring the file words back: a
      // Document dropped on the Folders heading or the card heading adds nothing.
      for (const heading of [
        window.getByTestId("folders-title"),
        library.getByTestId("library-heading"),
      ]) {
        await dragOnto(
          window,
          libraryRow(library, first).getByTestId("library-document-name"),
          heading,
          async () => {
            await expect(window.getByTestId("drop-label")).toHaveCount(0);
            await expect(window.getByTestId("drop-overlay")).toHaveCount(0);
          },
        );
      }
      await dropFromFinder(
        window,
        finance.getByTestId("folder-row"),
        [dropped],
        async () => {
          await expect(finance).toHaveAttribute("data-drop-target", "true");
          await expect(window.getByTestId("drop-label")).toHaveText(
            words.dropFiles(words.folders.finance),
          );
          await expect(window.getByTestId("drop-overlay")).toHaveCount(0);
          await screenshot(window, `finder-drop-${language}-${width}`);
        },
        [
          {
            at: library.getByTestId("library-heading"),
            check: async () => {
              await expect(window.getByTestId("card").getByTestId("drop-overlay")).toContainText(
                words.cardDrop,
              );
              await expect(finance).not.toHaveAttribute("data-drop-target", "true");
            },
          },
          {
            at: window.getByTestId("folders-title"),
            check: async (point) => {
              await expect(window.getByTestId("drop-overlay")).toHaveCount(0);
              await expect(window.getByTestId("drop-label")).toHaveText(words.addToLibrary);
              await expectLabelByPointer(window, point);
              await expect(finance).not.toHaveAttribute("data-drop-target", "true");
              await screenshot(window, `card-quiet-${language}-${width}`);
            },
          },
          {
            at: window.getByTestId("not-in-a-folder-title"),
            check: async (point) => {
              await expect(window.getByTestId("drop-overlay")).toHaveCount(0);
              await expect(window.getByTestId("drop-label")).toHaveText(words.addToLibrary);
              await expectLabelByPointer(window, point);
            },
          },
          {
            at: window.getByTestId("composer"),
            check: async (point) => {
              await expect(window.getByTestId("drop-overlay")).toHaveCount(0);
              await expect(window.getByTestId("drop-label")).toHaveText(words.addToLibrary);
              await expectLabelByPointer(window, point);
            },
          },
        ],
      );
      await expect(window.getByTestId("drop-label")).toHaveCount(0);
      await expect(undoMessage(window)).toHaveText(words.addedOne);
      await expect
        .poll(() => folderOfDocument(window, droppedName), { timeout: 30_000 })
        .toBe(seeded.finance);
      await expect(libraryRow(library, droppedName)).toHaveCount(1);
      // The fourth Document stayed in Finance when its move out was taken back, so one is loose the fewer.
      await expectCounts(window, library, seeded, {
        finance: 2,
        research: 0,
        archive: 0,
        loose: loose - 1,
        total: loose + 1,
      });
      await undo(window);
      await expect.poll(() => folderOfDocument(window, droppedName)).toBeNull();
      await expectCounts(window, library, seeded, {
        finance: 1,
        research: 0,
        archive: 0,
        loose: loose - 1,
        total: loose,
      });

      // Move to… by ⇧⌘M on a focused row: the picker's field takes the focus, its search finds the
      // Folder, Enter moves, and ⌘Z puts it back.
      const ledger = libraryRow(library, second);
      await ledger.locator("[data-row-main]").focus();
      await window.keyboard.press("ControlOrMeta+Shift+M");
      const picker = window.getByTestId("move-to-picker");
      await expect(picker.getByTestId("move-to-search")).toBeFocused();
      await typeFolderInto(window, picker, words.folders.archive);
      await screenshot(window, `move-to-picker-${language}-${width}`);
      await window.keyboard.press("Enter");
      await expect(undoMessage(window)).toHaveText(words.movedOne(second, words.folders.archive));
      await expect.poll(() => folderOfDocument(window, second)).toBe(seeded.archive);
      await expectCounts(window, library, seeded, {
        finance: 1,
        research: 0,
        archive: 1,
        loose: loose - 2,
        total: loose,
      });
      await undo(window);
      await expect.poll(() => folderOfDocument(window, second)).toBeNull();
      await expectCounts(window, library, seeded, {
        finance: 1,
        research: 0,
        archive: 0,
        loose: loose - 1,
        total: loose,
      });

      // A search shows the row's Folder as a quiet text button with a chevron on hover, which opens
      // Move to…; the row has no dropdown.
      const search = library.getByTestId("library-search");
      await addToSelection(window, libraryRow(library, third));
      await window.keyboard.press("ControlOrMeta+Shift+M");
      await expect(picker.getByTestId("move-to-search")).toBeFocused();
      await typeFolderInto(window, picker, words.folders.research);
      await window.keyboard.press("Enter");
      await expect.poll(() => folderOfDocument(window, third)).toBe(seeded.research);
      await expectCounts(window, library, seeded, {
        finance: 1,
        research: 1,
        archive: 0,
        loose: loose - 2,
        total: loose,
      });
      await search.fill(third);
      const placedLine = libraryRow(library, third).getByTestId("library-path");
      await expect(placedLine).toHaveText(words.folders.research);
      const chevron = libraryRow(library, third).getByTestId("library-path-chevron");
      // Pointed away from the line, the chevron is quiet until the line is pointed at.
      await pointAt(window, library.getByTestId("library-heading"));
      await expect(chevron).toHaveCSS("opacity", "0");
      await pointAt(window, placedLine);
      await expect(chevron).toHaveCSS("opacity", "1");
      await screenshot(window, `folder-line-${language}-${width}`);
      // A ⌘-click on the line only changes the selection, as anywhere in the row; it does not
      // open Move to….
      const bar = library.getByTestId("library-selection");
      const surveyRow = libraryRow(library, third);
      const selectedBefore = (await surveyRow.getAttribute("aria-selected")) === "true";
      await pointAndClick(window, placedLine, { modifiers: ["ControlOrMeta"] });
      await expect(picker).toHaveCount(0);
      await expect(surveyRow).toHaveAttribute("aria-selected", String(!selectedBefore));
      await pointAndClick(window, placedLine);
      await expect(picker.getByTestId("move-to-search")).toBeFocused();
      await typeFolderInto(window, picker, words.folders.archive);
      await window.keyboard.press("Enter");
      await expect(undoMessage(window)).toHaveText(words.movedOne(third, words.folders.archive));
      await expect.poll(() => folderOfDocument(window, third)).toBe(seeded.archive);
      // Every Folder's section shows the counts once the search is cleared, straight after the
      // move, and the search keeps the focus once the move has landed (#1741).
      await search.fill("");
      await expect(search).toHaveValue("");
      await expectCounts(window, library, seeded, {
        finance: 1,
        research: 0,
        archive: 1,
        loose: loose - 2,
        total: loose,
      });
      await expect(search).toBeFocused();
      // Back to the Folder it was in, then out of every Folder.
      await undo(window);
      await expect.poll(() => folderOfDocument(window, third)).toBe(seeded.research);
      await expectCounts(window, library, seeded, {
        finance: 1,
        research: 1,
        archive: 0,
        loose: loose - 2,
        total: loose,
      });
      await undo(window);
      await expect.poll(() => folderOfDocument(window, third)).toBeNull();
      await expectCounts(window, library, seeded, {
        finance: 1,
        research: 0,
        archive: 0,
        loose: loose - 1,
        total: loose,
      });
      await expect(library.locator("select")).toHaveCount(0);

      // A right-click on a Document opens the registry's menu, whose Move to… moves it.
      await pointAndClick(window, libraryRow(library, fourth), { button: "right" });
      const documentMenu = window.getByTestId("document-file-actions").filter({ visible: true });
      await expect(documentMenu).toBeVisible();
      await pointAndClick(window, documentMenu.getByTestId("document.moveTo"));
      await expect(picker.getByTestId("move-to-search")).toBeFocused();
      await typeFolderInto(window, picker, words.folders.archive);
      await window.keyboard.press("Enter");
      await expect.poll(() => folderOfDocument(window, fourth)).toBe(seeded.archive);
      await expectCounts(window, library, seeded, {
        finance: 0,
        research: 0,
        archive: 1,
        loose: loose - 1,
        total: loose,
      });
      await undo(window);
      await expect.poll(() => folderOfDocument(window, fourth)).toBe(seeded.finance);
      await expectCounts(window, library, seeded, {
        finance: 1,
        research: 0,
        archive: 0,
        loose: loose - 1,
        total: loose,
      });

      // A right-click on a Folder opens the same menu, with New note here, Add Documents here…,
      // Rename and Delete last; each one does what it says, and the add, the rename and the delete
      // are each taken back by ⌘Z.
      const financeRow = () =>
        window
          .getByTestId("library-folders")
          .locator(`[data-testid="library-folder"][data-folder-id="${seeded.finance}"]`)
          .getByTestId("folder-row");
      await pointAndClick(window, financeRow(), { button: "right" });
      const folderMenu = window.getByTestId("folder-actions").filter({ visible: true });
      await expect(folderMenu.getByTestId("folder.newMind")).toContainText(words.newNoteHere);
      await expect(folderMenu.getByTestId("folder.addDocuments")).toContainText(
        words.addDocumentsHere,
      );
      await expect(folderMenu.getByTestId("folder.rename")).toContainText(words.rename);
      await expect(folderMenu.getByTestId("folder.delete")).toContainText(words.delete);
      await screenshot(window, `folder-menu-${language}-${width}`);

      // The same menu by keyboard alone: Shift+F10 on the focused Folder, the arrows, then Enter
      // runs Add Documents here… on a file the system's dialog gives.
      const addedByKeyboard = language === "en" ? "Added by keyboard" : "通过键盘添加";
      await interceptOpenDialog(app, await droppedFile(addedByKeyboard));
      await window.keyboard.press("Escape");
      await financeRow().focus();
      await window.keyboard.press("Shift+F10");
      const keyboardMenu = window.getByTestId("folder-actions").filter({ visible: true });
      await expect(keyboardMenu).toBeVisible();
      await window.keyboard.press("ArrowDown");
      await expect(keyboardMenu.getByTestId("folder.newMind")).toBeFocused();
      await window.keyboard.press("ArrowDown");
      await expect(keyboardMenu.getByTestId("folder.addDocuments")).toBeFocused();
      await window.keyboard.press("Enter");
      await expect(keyboardMenu).toHaveCount(0);
      await expect
        .poll(() => folderOfDocument(window, addedByKeyboard), { timeout: 30_000 })
        .toBe(seeded.finance);
      await expect(undoMessage(window)).toHaveText(words.addedOne);
      await expect(libraryRow(library, addedByKeyboard)).toHaveCount(1);
      await undo(window);
      await expect(libraryRow(library, addedByKeyboard)).toHaveCount(0);

      // Add Documents here… adds the file the system's dialog gives into this Folder.
      const addedHere = language === "en" ? "Added here" : "在此添加";
      await interceptOpenDialog(app, await droppedFile(addedHere));
      await pointAndClick(window, financeRow(), { button: "right" });
      await pointAndClick(
        window,
        window
          .getByTestId("folder-actions")
          .filter({ visible: true })
          .getByTestId("folder.addDocuments"),
      );
      await expect
        .poll(() => folderOfDocument(window, addedHere), { timeout: 30_000 })
        .toBe(seeded.finance);
      await expect(undoMessage(window)).toHaveText(words.addedOne);
      await expectCounts(window, library, seeded, {
        finance: 2,
        research: 0,
        archive: 0,
        loose: loose - 1,
        total: loose + 1,
      });
      await undo(window);
      // The Undo takes the added Document out of the Library, not just out of the Folder.
      await expect(libraryRow(library, addedHere)).toHaveCount(0);
      await expectCounts(window, library, seeded, {
        finance: 1,
        research: 0,
        archive: 0,
        loose: loose - 1,
        total: loose,
      });

      // ⌘K runs the same Add Documents here… for the Folder with the focus.
      const addedFromPalette = language === "en" ? "Added from ⌘K" : "通过命令面板添加";
      await interceptOpenDialog(app, await droppedFile(addedFromPalette));
      if ((await bar.count()) > 0) {
        await pointAndClick(window, bar.getByTestId("library-selection-clear"));
      }
      await financeRow().focus();
      await window.keyboard.press("ControlOrMeta+k");
      await expect(window.getByTestId("palette-search")).toBeFocused();
      await window.keyboard.type(words.addDocumentsHere.replace(/…$/, ""));
      const paletteItem = paletteFound(window).filter({ hasText: words.addDocumentsHere });
      await expect(paletteItem).toHaveCount(1);
      await window.keyboard.press("Enter");
      await expect(window.getByTestId("palette")).toHaveCount(0);
      await expect
        .poll(() => folderOfDocument(window, addedFromPalette), { timeout: 30_000 })
        .toBe(seeded.finance);
      await expect(undoMessage(window)).toHaveText(words.addedOne);
      await expect(libraryRow(library, addedFromPalette)).toHaveCount(1);
      await undo(window);
      await expect(libraryRow(library, addedFromPalette)).toHaveCount(0);

      // Rename renames the Folder in place, with Undo.
      const renamed = language === "en" ? "Finance renamed" : "财务改名";
      await pointAndClick(window, financeRow(), { button: "right" });
      await pointAndClick(
        window,
        window.getByTestId("folder-actions").filter({ visible: true }).getByTestId("folder.rename"),
      );
      const field = window.getByTestId("folder-rename-field");
      await expect(field).toBeFocused();
      await field.fill(renamed);
      await field.press("Enter");
      await expect(undoMessage(window)).toHaveText(words.folderRenamed(renamed));
      await expect.poll(() => folderNames(window)).toContain(renamed);
      await undo(window);
      await expect.poll(() => folderNames(window)).toContain(words.folders.finance);

      // Delete moves the Folder to Recently deleted; ⌘Z brings it and each Document's Folder back.
      const library2 = await openLibrary(window);
      await pointAndClick(window, financeRow(), { button: "right" });
      const deleteMenu = window.getByTestId("folder-actions").filter({ visible: true });
      await pointAndClick(window, deleteMenu.getByTestId("folder.delete"));
      await expect(undoMessage(window)).toHaveText(words.folderDeleted(words.folders.finance));
      await expect.poll(() => folderNames(window)).not.toContain(words.folders.finance);
      await expect.poll(() => folderOfDocument(window, fourth)).toBeNull();
      await undo(window);
      await expect.poll(() => folderNames(window)).toContain(words.folders.finance);
      await expect.poll(() => folderOfDocument(window, fourth)).toBe(seeded.finance);

      // New note here adds a note to this Folder. It comes last: a Folder's sidebar count includes
      // its notes, so it would change the Document counts checked above.
      await pointAndClick(window, financeRow(), { button: "right" });
      await pointAndClick(
        window,
        window
          .getByTestId("folder-actions")
          .filter({ visible: true })
          .getByTestId("folder.newMind"),
      );
      await expect.poll(() => mindCount(window, seeded.finance)).toBe(1);

      // The Folder's page has no row of text buttons, and no Library row has a dropdown.
      await expect(library2.getByRole("button", { name: words.folderPageButtons })).toHaveCount(0);
      await expect(library2.locator("select")).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}

test("a Folder takes a second Document of the same name, a drop while a filter is on, and three Documents from three Folders with one ⌘Z", async () => {
  test.setTimeout(240_000);
  const firstDir = join(sources, "first copy");
  const secondDir = join(sources, "second copy");
  await mkdir(firstDir);
  await mkdir(secondDir);
  await writeFile(join(firstDir, "Field notes.txt"), "Field notes, the first copy.\n");
  await writeFile(join(secondDir, "Field notes.txt"), "Field notes, the second copy.\n");
  for (const name of ["Alpha", "Beta", "Gamma", "Filtered"]) {
    await writeFile(join(sources, `${name}.txt`), `${name}: the harbour project's figures.\n`);
  }
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1600, 900);
    await dismissChatSetup(window);
    const seeded = await (await coreOf(window)).evaluate(
      async (core: CoreBridge, input) => {
        const finance = await core.createLibraryGroup({ name: "Finance", description: "" });
        const research = await core.createLibraryGroup({ name: "Research", description: "" });
        const archive = await core.createLibraryGroup({ name: "Archive", description: "" });
        const filed = await core.createLibraryGroup({ name: "Filed", description: "" });
        await core.addDocuments([...input.paths, input.first]);
        const documents = await core.listDocuments();
        const idOf = (name: string) => documents.find((each) => each.name === name)?.id;
        const fieldNotes = idOf("Field notes");
        if (fieldNotes)
          await core.moveToFolder({ documentIds: [fieldNotes], folderId: finance.id });
        for (const [name, folderId] of [
          ["Alpha", finance.id],
          ["Beta", research.id],
          ["Gamma", archive.id],
        ] as const) {
          const id = idOf(name);
          if (id) await core.moveToFolder({ documentIds: [id], folderId });
        }
        if (!fieldNotes) throw new Error("Field notes wasn't added.");
        return { finance: finance.id, research: research.id, archive: archive.id, filed: filed.id };
      },
      {
        paths: ["Alpha", "Beta", "Gamma"].map((name) => join(sources, `${name}.txt`)),
        first: join(firstDir, "Field notes.txt"),
      },
    );
    const library = await openLibrary(window);
    await expect(library.getByTestId("library-document")).toHaveCount(4, { timeout: 15_000 });
    const folderCount = (key: string) => section(library, key).getAttribute("data-count");

    // A second file with the name the Folder already holds is added beside it, as Add Documents
    // anywhere adds one; one ⌘Z takes the new one out and leaves the first.
    const fieldNotesInCore = async () =>
      (await coreOf(window)).evaluate(async (core: CoreBridge, finance: string) => {
        const documents = (await core.listDocuments()).filter(
          (each) => each.name === "Field notes",
        );
        const library = await core.getLibrary();
        const folderOf = (documentId: string) =>
          library.assignments.find((each) => each.documentId === documentId)?.groupId ?? null;
        return {
          count: documents.length,
          allInFinance: documents.every((each) => folderOf(each.id) === finance),
        };
      }, seeded.finance);
    const finance = sidebarFolder(window, "Finance");
    const secondCopy = join(secondDir, "Field notes.txt");
    await dropFromFinder(window, finance.getByTestId("folder-row"), [secondCopy]);
    await expect(undoMessage(window)).toHaveText("Added 1 Document");
    await expect.poll(fieldNotesInCore, { timeout: 30_000 }).toEqual({
      count: 2,
      allInFinance: true,
    });
    await expect.poll(() => folderCount(seeded.finance)).toBe("3");
    await undo(window);
    await expect.poll(fieldNotesInCore).toEqual({ count: 1, allInFinance: true });
    await expect.poll(() => folderCount(seeded.finance)).toBe("2");

    // A file dropped while the page is filtered goes into the Folder just the same; clearing the
    // search shows it there.
    const search = library.getByTestId("library-search");
    await search.fill("Alpha");
    await dropFromFinder(window, finance.getByTestId("folder-row"), [
      join(sources, "Filtered.txt"),
    ]);
    await expect
      .poll(() => folderOfDocument(window, "Filtered"), { timeout: 30_000 })
      .toBe(seeded.finance);
    await expect(libraryRow(library, "Filtered")).toHaveCount(0);
    await search.fill("");
    await expect(libraryRow(library, "Filtered")).toHaveCount(1);
    await expect.poll(() => folderCount(seeded.finance)).toBe("3");

    // Three Documents from three different Folders, moved together: one ⌘Z puts each back in its own.
    for (const name of ["Alpha", "Beta", "Gamma"]) {
      await addToSelection(window, libraryRow(library, name));
    }
    await expect(library.getByTestId("library-selection")).toContainText("3");
    await window.keyboard.press("ControlOrMeta+Shift+M");
    const picker = window.getByTestId("move-to-picker");
    await expect(picker.getByTestId("move-to-search")).toBeFocused();
    await typeFolderInto(window, picker, "Filed");
    await window.keyboard.press("Enter");
    await expect(undoMessage(window)).toHaveText("Moved 3 Documents to Filed");
    for (const name of ["Alpha", "Beta", "Gamma"]) {
      await expect.poll(() => folderOfDocument(window, name)).toBe(seeded.filed);
    }
    await expect.poll(() => folderCount(seeded.filed)).toBe("3");
    await undo(window);
    await expect.poll(() => folderOfDocument(window, "Alpha")).toBe(seeded.finance);
    await expect.poll(() => folderOfDocument(window, "Beta")).toBe(seeded.research);
    await expect.poll(() => folderOfDocument(window, "Gamma")).toBe(seeded.archive);
    await expect.poll(() => folderCount(seeded.filed)).toBe("0");
  } finally {
    await app.close();
  }
});

test("Organize only proposes a Folder, and undoing the User's move leaves the Document in no Folder, as Organize left it", async () => {
  test.setTimeout(180_000);
  const { server } = await decisionServer((text) =>
    text.includes("invoice") ? "Finance" : "Research",
  );
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1600, 900);
    await dismissChatSetup(window);
    const path = join(sources, "Invoice 501.txt");
    await writeFile(path, "Invoice 501: consulting for the harbour project, due in 30 days.\n");
    const port = (server.address() as AddressInfo).port;
    const { research } = await (await coreOf(window)).evaluate(
      async (core: CoreBridge, input) => {
        await core.createLibraryGroup({ name: "Finance", description: "" });
        const research = await core.createLibraryGroup({ name: "Research", description: "" });
        await core.saveLibrarySettings({
          classifier: { kind: "ollama", baseUrl: input.url, modelId: "tev1:0.8b" },
          automatic: true,
          turnOn: true,
        });
        await core.addDocuments([input.path]);
        const document = (await core.listDocuments()).find((each) => each.name === "Invoice 501");
        if (!document) throw new Error("The invoice wasn't added.");
        await core.classifyDocuments([document.id]);
        return { research: research.id };
      },
      { url: `http://127.0.0.1:${port}`, path },
    );
    await expect(window.getByTestId("document-list-item")).toHaveCount(1);
    const automatic = () => assignmentOf(window, "Invoice 501");
    // Organize answers in a moment and only proposes: Finance waits in Suggestions, and the
    // Document stays in no Folder, not the User's choice.
    await expect
      .poll(() => proposedFolderOf(window, "Invoice 501"), { timeout: 60_000 })
      .toBe("Finance");
    expect(await automatic()).toEqual({ groupId: null, source: "automatic" });

    // The User moves it, then takes that back: it is in no Folder again, as Organize left it.
    const library = await openLibrary(window);
    await libraryRow(library, "Invoice 501").locator("[data-row-main]").focus();
    await window.keyboard.press("ControlOrMeta+Shift+M");
    await expect(window.getByTestId("move-to-search")).toBeFocused();
    await typeFolderInto(window, window.getByTestId("move-to-picker"), "Research");
    await window.keyboard.press("Enter");
    await expect.poll(automatic).toMatchObject({ groupId: research, source: "user" });
    await undo(window);
    await expect.poll(automatic).toEqual({ groupId: null, source: "automatic" });
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
