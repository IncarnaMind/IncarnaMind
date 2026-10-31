import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  askInAssistant,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/**
 * One count for one list (#2290). The Library row counts the Documents the
 * Library page lists, and the tree lists the same Documents. Until the User
 * has a Folder their loose Notes and Documents are two lists, Notes and
 * Documents, each counting its rows; once a Folder exists, Not in a Folder
 * holds the Note above the Documents, uncounted. The page is Documents only.
 */
const PDFS = ["Tides.pdf", "Seabirds.pdf"];
const PDF_NAMES = PDFS.map((name) => name.replace(".pdf", ""));

const WORDS = {
  en: {
    library: "Library",
    notes: "Notes",
    documents: "Documents",
    notInFolder: "Not in a Folder",
    hint: "Searches everything",
  },
  "zh-CN": {
    library: "资料库",
    notes: "笔记",
    documents: "文档",
    notInFolder: "不在文件夹中",
    hint: "搜索全部文档",
  },
} as const;

type Words = (typeof WORDS)[keyof typeof WORDS];

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

async function twoPdfs(): Promise<string[]> {
  const written: string[] = [];
  for (const name of PDFS) {
    const path = join(sources, name);
    await writeFile(
      path,
      buildPdf([{ lines: [`${name} says the tide rises and falls twice a day.`] }]),
    );
    written.push(path);
  }
  return written;
}

type Window = Awaited<ReturnType<typeof launchApp>>["window"];

/** The shown names of the Documents in a surface's rows. */
const documentNames = (rows: Locator) =>
  rows.evaluateAll((all) =>
    all.flatMap((row) => {
      const name = row.querySelector(
        '[data-testid="row-text"], [data-testid="library-document-name"]',
      );
      return name ? [name.textContent ?? ""] : [];
    }),
  );

/** The names of every Document the core holds. */
const coreDocumentNames = (window: Window) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.listDocuments()).map((doc) => doc.name);
  });

/**
 * The sidebar's Documents list (no Folder yet) and the page's Not in a Folder
 * hold the same Documents, each count matching its rows.
 */
async function expectDocumentsListedInBoth(
  window: Window,
  words: Words,
  documents: readonly string[],
): Promise<{ listed: Locator; section: Locator }> {
  const sidebar = window.getByTestId("sidebar");
  const count = String(documents.length);
  const listed = sidebar.getByTestId("not-in-a-folder-section");
  await expect(listed.getByTestId("not-in-a-folder-title")).toContainText(words.documents);
  await expect(listed.getByTestId("sidebar-section-count")).toHaveText(count);
  await expect(listed.getByTestId("document-list-item")).toHaveCount(documents.length);
  await expect(listed.getByTestId("mind-row")).toHaveCount(0);
  const inSidebar = await documentNames(listed.getByTestId("document-list-item"));

  await window.getByTestId("open-library").click();
  const library = window.getByTestId("library");
  await expect(library).toBeVisible();
  await expect(library.getByTestId("library-count")).toHaveText(count);
  const section = library.locator(
    '[data-testid="library-section"][data-section="not-in-a-folder"]',
  );
  await expect(section).toHaveAttribute("data-count", count);
  await expect(section.getByTestId("library-section-head")).toContainText(words.notInFolder);
  await expect(section.getByTestId("library-section-count")).toHaveText(count);
  await expect(section.getByTestId("library-document")).toHaveCount(documents.length);
  const inLibrary = await documentNames(section.getByTestId("library-document"));

  expect(inSidebar.sort()).toEqual([...documents].sort());
  expect(inLibrary.sort()).toEqual([...documents].sort());
  return { listed, section };
}

for (const language of ["en", "zh-CN"] as const) {
  test(`no Folder: the Library counts its Documents, Notes and Documents count their rows (${language})`, async () => {
    test.setTimeout(240_000);
    const words = WORDS[language];
    const paths = await twoPdfs();
    const { app, window } = await launchApp(dataDir, {
      examples: true,
      fakeChat: true,
      home: sources,
    });
    try {
      await setWindowSize(app, window, 1200, 900);
      await dismissChatSetup(window);
      await connectLocalChatModel(window);
      await setLanguage(window, language);
      await addDocuments(window, paths);

      // A Note written from an Answer, as the newcomer wrote it.
      const answer = await askInAssistant(window, "How do tides rise?");
      await answer.getByTestId("answer-write-note").click();
      await expect(answer.getByTestId("answer-added-undo")).toBeVisible();
      const sidebar = window.getByTestId("sidebar");
      const written = sidebar.getByTestId("notes-section").getByTestId("mind-row");
      await expect(written).toHaveCount(1);
      const noteTitle = (await written.getByTestId("row-text").innerText()).trim();
      expect(noteTitle).not.toBe("");

      // Dismiss the "You're set up." card, whose ✕ is on the example's tab.
      await sidebar.getByTestId("example-section").getByTestId("mind-list-item").click();
      await expect(window.getByTestId("first-open-hide")).toBeVisible();
      await window.getByTestId("first-open-hide").click();
      await expect(window.getByTestId("first-open-steps")).toHaveCount(0);

      // No Folder yet: Notes N, then Documents N, card dismissed, and the Library row counts
      // the Documents the page lists.
      await expect(sidebar.getByTestId("open-library")).toContainText(words.library);
      await expect(sidebar.getByTestId("library-row-count")).toHaveText("2");
      await expect(sidebar.getByTestId("document-list-item")).toHaveCount(2);
      const notes = sidebar.getByTestId("notes-section");
      await expect(notes.getByTestId("notes-title")).toContainText(words.notes);
      await expect(notes.getByTestId("sidebar-section-count")).toHaveText("1");
      await expect(notes.getByTestId("mind-row")).toHaveCount(1);
      await expect(notes.getByTestId("mind-row").getByTestId("row-text")).toHaveText(noteTitle);

      const { listed, section } = await expectDocumentsListedInBoth(window, words, PDF_NAMES);
      // The page lists Documents only: the Note is in neither its count nor its rows, while the
      // sidebar lists it above, in the same state.
      await expect(listed).not.toContainText(noteTitle);
      await expect(section).not.toContainText(noteTitle);
      await expect(window.getByTestId("library").getByTestId("mind-row")).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}

test("with no Documents of one's own the Library counts the examples' Documents in both places", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  try {
    await setWindowSize(app, window, 1200, 900);
    await dismissChatSetup(window);
    await setLanguage(window, "en");
    // Nothing added: the Library lists the examples' Documents, so its count says 2 in both places.
    await window.getByTestId("first-open-hide").click();
    await expect(window.getByTestId("first-open-steps")).toHaveCount(0);
    const sidebar = window.getByTestId("sidebar");
    await expect(sidebar.getByTestId("library-row-count")).toHaveText("2");
    await expect(sidebar.getByTestId("document-list-item")).toHaveCount(2);
    // The example's Note is listed under Examples, not counted as a Document of the Library.
    await expect(sidebar.getByTestId("examples-section").getByTestId("mind-row")).toHaveCount(1);
    await expect(sidebar.getByTestId("notes-section")).toHaveCount(0);
    await expect(
      sidebar.getByTestId("not-in-a-folder-section").getByTestId("mind-row"),
    ).toHaveCount(0);

    const names = await coreDocumentNames(window);
    await expectDocumentsListedInBoth(window, WORDS.en, names);
  } finally {
    await app.close();
  }
});

for (const language of ["en", "zh-CN"] as const) {
  test(`with a Folder, Not in a Folder lists the Note above the Documents, uncounted (${language})`, async () => {
    test.setTimeout(240_000);
    const words = WORDS[language];
    const paths = await twoPdfs();
    const { app, window } = await launchApp(dataDir, {
      examples: true,
      fakeChat: true,
      home: sources,
    });
    try {
      await setWindowSize(app, window, 1200, 900);
      await dismissChatSetup(window);
      await connectLocalChatModel(window);
      await setLanguage(window, language);
      await addDocuments(window, paths);
      const answer = await askInAssistant(window, "How do tides rise?");
      await answer.getByTestId("answer-write-note").click();
      await expect(answer.getByTestId("answer-added-undo")).toBeVisible();
      const sidebar = window.getByTestId("sidebar");
      const written = sidebar.getByTestId("notes-section").getByTestId("mind-row");
      await expect(written).toHaveCount(1);
      const noteTitle = (await written.getByTestId("row-text").innerText()).trim();
      await sidebar.getByTestId("example-section").getByTestId("mind-list-item").click();
      await expect(window.getByTestId("first-open-hide")).toBeVisible();
      await window.getByTestId("first-open-hide").click();
      await expect(window.getByTestId("first-open-steps")).toHaveCount(0);

      // The first Folder: the two lists become one Not in a Folder, with no count of its own.
      await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.createLibraryGroup({ name: "Finance", description: "" });
      });
      await expect(sidebar.getByTestId("folders-section")).toBeVisible();
      await expect(sidebar.getByTestId("notes-section")).toHaveCount(0);
      const listed = sidebar.getByTestId("not-in-a-folder-section");
      await expect(listed.getByTestId("not-in-a-folder-title")).toContainText(words.notInFolder);
      await expect(listed.getByTestId("sidebar-section-count")).toHaveCount(0);
      await expect(listed.getByTestId("not-in-a-folder-section-heading")).toHaveAttribute(
        "title",
        words.hint,
      );
      // The Note first, then the two Documents, each row once.
      const rows = listed.locator(
        '[data-testid="mind-list-item"], [data-testid="document-list-item"]',
      );
      await expect(rows).toHaveCount(3);
      expect(await rows.evaluateAll((all) => all.map((row) => row.dataset.testid))).toEqual([
        "mind-list-item",
        "document-list-item",
        "document-list-item",
      ]);
      expect(await rows.first().getByTestId("row-text").innerText()).toBe(noteTitle);

      // The Library row still counts the Documents; the page lists them, never the Note.
      await expect(sidebar.getByTestId("library-row-count")).toHaveText("2");
      await window.getByTestId("open-library").click();
      const library = window.getByTestId("library");
      await expect(library.getByTestId("library-count")).toHaveText("2");
      const section = library.locator(
        '[data-testid="library-section"][data-section="not-in-a-folder"]',
      );
      await expect(section).toHaveAttribute("data-count", "2");
      await expect(section.getByTestId("library-section-count")).toHaveText("2");
      await expect(section.getByTestId("library-document")).toHaveCount(2);
      expect((await documentNames(section.getByTestId("library-document"))).sort()).toEqual(
        [...PDF_NAMES].sort(),
      );
      await expect(section).not.toContainText(noteTitle);
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`the example's Documents leave the tree and the page together when its Note is deleted (${language})`, async () => {
    test.setTimeout(240_000);
    const words = WORDS[language];
    const ownPath = join(sources, "Tides.pdf");
    await writeFile(ownPath, buildPdf([{ lines: ["Tides says the tide rises twice a day."] }]));
    const { app, window } = await launchApp(dataDir, {
      examples: true,
      fakeChat: true,
      home: sources,
    });
    try {
      await setWindowSize(app, window, 1200, 900);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await addDocuments(window, [ownPath]);
      await expect(
        window.getByTestId("example-section").getByTestId("mind-list-item"),
      ).toBeVisible();

      // The example's two Documents, by their shown names, and the User's own one.
      const names = await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const examples = await core.getExamples();
        const all = await core.listDocuments();
        return {
          examples: all
            .filter((doc) => doc.linkedFolderId === examples.linkedFolderId)
            .map((doc) => doc.name),
          own: all.filter((doc) => doc.linkedFolderId === null).map((doc) => doc.name),
        };
      });
      expect(names.examples).toHaveLength(2);
      expect(names.own).toEqual(["Tides"]);

      // Its Note deleted, the example folds back to nothing: its Documents stay in the core,
      // reachable through their Linked folder row, and out of the Library's one list.
      await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const { mindId } = await core.getExamples();
        if (mindId) await core.deleteMind(mindId);
      });
      await expect(window.getByTestId("example-section")).toHaveCount(0);

      const sidebar = window.getByTestId("sidebar");
      await expect(sidebar.getByTestId("library-row-count")).toHaveText("1");
      await expect(sidebar.getByTestId("document-list-item")).toHaveCount(1);
      await expect(sidebar.getByTestId("document-list-item").getByTestId("row-text")).toHaveText(
        "Tides",
      );
      const listed = sidebar.getByTestId("not-in-a-folder-section");
      await expect(listed.getByTestId("not-in-a-folder-title")).toContainText(words.documents);
      await expect(listed.getByTestId("sidebar-section-count")).toHaveText("1");
      await expect(listed.getByTestId("document-list-item")).toHaveCount(1);
      for (const name of names.examples) await expect(listed).not.toContainText(name);
      await expect(sidebar.getByTestId("linked-folders-section")).toBeVisible();
      expect(await coreDocumentNames(window)).toHaveLength(3);

      // The page's own Not in a Folder lists the same one Document and the same set.
      await window.getByTestId("open-library").click();
      const library = window.getByTestId("library");
      await expect(library).toBeVisible();
      await expect(library.getByTestId("library-count")).toHaveText("1");
      const section = library.locator(
        '[data-testid="library-section"][data-section="not-in-a-folder"]',
      );
      await expect(section).toHaveAttribute("data-count", "1");
      await expect(section.getByTestId("library-section-head")).toContainText(words.notInFolder);
      await expect(section.getByTestId("library-section-count")).toHaveText("1");
      await expect(section.getByTestId("library-document")).toHaveCount(1);
      for (const name of names.examples) await expect(section).not.toContainText(name);
    } finally {
      await app.close();
    }
  });
}
