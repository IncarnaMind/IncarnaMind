import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
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
 * The Library's one count for one list (#2290): the Library row counts the
 * Documents the Library page lists, and the sidebar's "Not in a Folder" holds
 * the same Documents as the page's section. A Note is not a Document, so it is
 * not counted there: the sidebar lists it under its own Notes heading, and the
 * Library page leaves it out.
 */
const PDFS = ["Tides.pdf", "Seabirds.pdf"];
const PDF_NAMES = PDFS.map((name) => name.replace(".pdf", ""));

const WORDS = {
  en: {
    library: "Library",
    notes: "Notes",
    notInFolder: "Not in a Folder",
  },
  "zh-CN": {
    library: "资料库",
    notes: "笔记",
    notInFolder: "不在文件夹中",
  },
} as const;

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

/**
 * The sidebar's "Not in a Folder" and the Library page's section of that name
 * list the same Documents, each count matching its rows.
 */
async function expectSameDocumentsUnderNotInAFolder(
  window: Window,
  words: (typeof WORDS)[keyof typeof WORDS],
  expected?: readonly string[],
): Promise<Locator> {
  const sidebar = window.getByTestId("sidebar");
  const loose = sidebar.getByTestId("not-in-a-folder-section");
  await expect(loose.getByTestId("not-in-a-folder-title")).toContainText(words.notInFolder);
  await expect(loose.getByTestId("sidebar-section-count")).toHaveText("2");
  await expect(loose.getByTestId("document-list-item")).toHaveCount(2);
  await expect(loose.getByTestId("mind-row")).toHaveCount(0);
  const inSidebar = await documentNames(loose.getByTestId("document-list-item"));

  await window.getByTestId("open-library").click();
  const library = window.getByTestId("library");
  await expect(library).toBeVisible();
  await expect(library.getByTestId("library-count")).toHaveText("2");
  const section = library.locator(
    '[data-testid="library-section"][data-section="not-in-a-folder"]',
  );
  await expect(section).toHaveAttribute("data-count", "2");
  await expect(section.getByTestId("library-section-head")).toContainText(words.notInFolder);
  await expect(section.getByTestId("library-section-count")).toHaveText("2");
  await expect(section.getByTestId("library-document")).toHaveCount(2);
  const inLibrary = await documentNames(section.getByTestId("library-document"));

  expect(inSidebar.sort()).toEqual(inLibrary.sort());
  if (expected) expect(inSidebar.sort()).toEqual([...expected].sort());
  return loose;
}

for (const language of ["en", "zh-CN"] as const) {
  test(`the Library's count is the Documents it lists, and a Note is listed apart (${language})`, async () => {
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

      // The Library row's count is the Documents the tree lists, and only those.
      await expect(sidebar.getByTestId("open-library")).toContainText(words.library);
      await expect(sidebar.getByTestId("library-row-count")).toHaveText("2");
      await expect(sidebar.getByTestId("document-list-item")).toHaveCount(2);

      // The Note is listed, with a count that matches its one row, under Notes, never under
      // Not in a Folder: the page's Not in a Folder lists the Documents, not the Note.
      const notes = sidebar.getByTestId("notes-section");
      await expect(notes.getByTestId("notes-title")).toContainText(words.notes);
      await expect(notes.getByTestId("sidebar-section-count")).toHaveText("1");
      await expect(notes.getByTestId("mind-row")).toHaveCount(1);
      await expect(notes.getByTestId("mind-row").getByTestId("row-text")).toHaveText(noteTitle);

      const loose = await expectSameDocumentsUnderNotInAFolder(window, words, PDF_NAMES);

      // The same state proves the Note exists and is not in the page: the sidebar lists it above.
      await expect(loose).not.toContainText(noteTitle);
      const library = window.getByTestId("library");
      await expect(library).not.toContainText(noteTitle);
      await expect(library.getByTestId("mind-row")).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}

test("the Library's count is the same before the User has a Document of their own", async () => {
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

    await expectSameDocumentsUnderNotInAFolder(window, WORDS.en);
  } finally {
    await app.close();
  }
});
