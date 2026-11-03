import { realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  assistantAnswers,
  useLocalChatModel as connectLocalChatModel,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  expectReadyDocuments,
  frontMindName,
  launchApp,
  linkFolderFromSidebar,
  newMind,
  pointAndClick,
  pointAt,
  removeDataFolder,
} from "./app";

/*
 * From the Library into writing (#59, #240): + Filter's year, format, status
 * and Folder filters, with counts, narrow the page; the selection's "Ask about
 * these N Documents" scopes the composer's next Question to exactly the
 * Documents chosen, a Folder's "Ask about this Folder" to the Folder, and its
 * "New note here" starts a Mind that searches it. Only one test asks, with the
 * scripted model. Set INCARNAMIND_SCREENSHOTS to a folder to also save
 * screenshots there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

/** Each file's year is the latest year written in its first Unit (#53). */
const FIXTURES = {
  "Tide report.txt": "Field report, 2021: spring tides along the coast.\n",
  "Harbour notes.md": "# Harbour notes\n\nObserved at the harbour in 2023.\n",
  "Estuary survey.txt": "Estuary survey, summer 2023. Salt water reaches the bridge.\n",
  "Undated memo.txt": "A memo about the quay, with no date in it.\n",
  "Tide table.csv": "day,height\nMonday,2.1\nTuesday,2.4\n",
} as const;

const FOLDER = "Coastal research";

let dataDir: string;
/** The folder linked: outside the data folder. */
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
  for (const [name, text] of Object.entries(FIXTURES)) await writeFile(join(sources, name), text);
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

async function screenshot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/**
 * Links the fixtures from the sidebar, makes the Folder and files every
 * Document but the CSV in it, as the User did before. Returns the Library.
 */
async function libraryWithFolder(app: Parameters<typeof linkFolderFromSidebar>[0], window: Page) {
  await linkFolderFromSidebar(app, window, sources);
  await expectReadyDocuments(window, 5);
  await (await coreOf(window)).evaluate(async (core, name) => {
    const folder = await core.createLibraryGroup({
      name,
      description: "Tides, harbours and estuaries",
    });
    const documentIds = (await core.listDocuments())
      .filter((doc) => doc.kind !== "csv")
      .map((doc) => doc.id);
    await core.moveToFolder({ documentIds, folderId: folder.id });
  }, FOLDER);
  await window.getByTestId("open-library").click();
  const library = window.getByTestId("library");
  await expect(library.getByTestId("library-section")).toHaveCount(2);
  return library;
}

/** + Filter, then one of the filters: its options, in the same menu. */
async function addFilter(window: Page, library: Locator, facet: string) {
  await pointAndClick(window, library.getByTestId("library-add-filter"));
  await pointAndClick(
    window,
    window.locator(`[data-testid="library-filter-kind"][data-facet="${facet}"]`),
  );
  const menu = window.getByTestId("library-add-filter-menu");
  await expect(menu.getByTestId("library-filter-option").first()).toBeVisible();
  return menu;
}

/** A chosen filter's chip, opened: its options. */
async function openChip(window: Page, library: Locator, facet: string) {
  await pointAndClick(
    window,
    library
      .locator(`[data-testid="library-filter"][data-facet="${facet}"]`)
      .getByTestId("library-filter-chip"),
  );
  const menu = window.locator(`[data-testid="library-filter-menu"][data-facet="${facet}"]`);
  await expect(menu).toBeVisible();
  return menu;
}

const optionsOf = (menu: Locator) =>
  menu
    .getByTestId("library-filter-option")
    .evaluateAll((items) =>
      items.map((item) => [
        item.querySelector(".truncate")?.textContent,
        Number(item.getAttribute("data-count")),
        item.getAttribute("aria-checked") === "true",
      ]),
    );

/** The open Mind's composer, where the Question is written, its Search scope as chips. */
const composerOf = (window: Page) => window.getByTestId("composer");

test("filters by year, format, status and Folder with counts, and asks about the Documents chosen or the Folder", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    // A Mind written in already: the most recent one, where the Questions go.
    await newMind(window);
    await window.keyboard.type("Tide notes");
    await window.keyboard.press("Enter");
    await window.keyboard.type("Notes on the tides.");
    const library = await libraryWithFolder(app, window);
    // A file removed from the folder: its Document is missing, and stays in its Folder.
    await rm(join(sources, "Undated memo.txt"));
    await expect
      .poll(
        () =>
          window.evaluate(
            async () =>
              (
                await (
                  globalThis as unknown as { incarnamind: CoreBridge }
                ).incarnamind.listDocuments()
              ).filter((each) => each.fileStatus === "missing").length,
          ),
        { timeout: 15_000 },
      )
      .toBe(1);
    const rows = library.getByTestId("library-document");
    await expect(rows).toHaveCount(5);

    // The Folder filter: the Folders, then Not in a Folder, each with its count.
    let menu = await addFilter(window, library, "folder");
    expect(await optionsOf(menu)).toEqual([
      [FOLDER, 4, false],
      ["Not in a Folder", 1, false],
    ]);
    await menu.getByRole("menuitemcheckbox", { name: `${FOLDER}, 4 Documents` }).click();
    await window.keyboard.press("Escape");
    await expect(rows).toHaveCount(4);
    await expect(library.getByTestId("library-section")).toHaveCount(1);

    // Each filter counts its options among what the others keep: newest year first, then no date.
    menu = await addFilter(window, library, "year");
    expect(await optionsOf(menu)).toEqual([
      ["2023", 2, false],
      ["2021", 1, false],
      ["No date", 1, false],
    ]);
    await menu.getByRole("menuitemcheckbox", { name: "2023, 2 Documents" }).click();
    await window.keyboard.press("Escape");
    await expect(rows).toHaveCount(2);
    await expect(library.locator('[data-testid="library-filter"][data-facet="year"]')).toHaveText(
      "Year: 2023",
    );
    menu = await addFilter(window, library, "format");
    expect(await optionsOf(menu)).toEqual([
      ["CSV", 0, false],
      ["Markdown", 1, false],
      ["Plain text", 1, false],
    ]);
    await window.keyboard.press("Escape");
    menu = await addFilter(window, library, "status");
    expect(await optionsOf(menu)).toEqual([
      ["Available", 2, false],
      ["Missing", 0, false],
    ]);
    await window.keyboard.press("Escape");

    // Options of one filter add up; the chip says how many more it keeps.
    menu = await openChip(window, library, "year");
    await menu.getByRole("menuitemcheckbox", { name: "No date, 1 Document" }).click();
    await window.keyboard.press("Escape");
    await expect(rows).toHaveCount(3);
    await expect(library.locator('[data-testid="library-filter"][data-facet="year"]')).toHaveText(
      "Year: 2023 +1",
    );
    menu = await addFilter(window, library, "status");
    await menu.getByRole("menuitemcheckbox", { name: "Missing, 1 Document" }).click();
    await window.keyboard.press("Escape");
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("Undated memo");
    await screenshot(window, "library-filters");

    // × drops each, and the page is whole again.
    const remove = library.getByTestId("library-filter-remove");
    while ((await remove.count()) > 0) await pointAndClick(window, remove.first());
    await expect(rows).toHaveCount(5);

    // Chosen, the Question searches exactly those Documents, and the bar says how many.
    menu = await addFilter(window, library, "year");
    await menu.getByRole("menuitemcheckbox", { name: "2023, 2 Documents" }).click();
    await window.keyboard.press("Escape");
    await expect(rows).toHaveCount(2);
    const shownIds = await rows.evaluateAll((items) =>
      items.map((item) => item.getAttribute("data-document-id")),
    );
    await rows.first().locator("[data-row-main]").focus();
    await window.keyboard.press("ControlOrMeta+a");
    const ask = library.getByTestId("library-selection").locator('[data-command="document.ask"]');
    await expect(ask).toHaveText("Ask about these 2 Documents");
    await pointAndClick(window, ask);

    await expect(window.getByTestId("library")).toHaveCount(0);
    await expect(frontMindName(window)).toHaveText("Tide notes");
    const editor = window.getByTestId("mind-editor");
    await expect(editor).toContainText("Notes on the tides.");
    // The composer takes the focus, its Search scope the Documents chosen.
    const composer = composerOf(window);
    const input = composer.getByTestId("composer-input");
    const chips = composer.getByTestId("scope-chip");
    await expect(chips).toHaveCount(2);
    expect(
      (
        await chips.evaluateAll((items) => items.map((item) => item.getAttribute("data-id")))
      ).sort(),
    ).toEqual([...shownIds].sort());
    await expect(chips.first()).toHaveAttribute("data-kind", "document");
    await expect(input).toBeFocused();
    await window.keyboard.type("What was observed in 2023?");
    await expect(input).toHaveValue("What was observed in 2023?");
    await screenshot(window, "library-ask-documents");

    // The Folder's own ⋯ asks about the Folder, in the same Mind, after the first.
    await window.getByTestId("open-library").click();
    const head = library
      .getByTestId("library-section")
      .filter({ hasText: FOLDER })
      .getByTestId("library-section-head");
    await pointAt(window, head);
    await pointAndClick(window, head.getByTestId("folder-menu"));
    await pointAndClick(
      window,
      window.getByTestId("folder-actions").filter({ visible: true }).getByTestId("folder.ask"),
    );
    await expect(frontMindName(window)).toHaveText("Tide notes");
    await expect(chips).toHaveCount(1);
    await expect(chips).toHaveText(FOLDER);
    await expect(chips).toHaveAttribute("data-kind", "folder");
    await expect(input).toBeFocused();
    await window.keyboard.type(" Which harbour?");
    await expect(input).toHaveValue("What was observed in 2023? Which harbour?");
    // Only the one Mind: nothing new was made.
    await expect(window.getByTestId("mind-list-item")).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test("a Folder's New note here starts a Mind that searches the Folder, and the Question asked goes to the assistant, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await dismissChatSetup(window);
    const library = await libraryWithFolder(app, window);
    const head = library
      .getByTestId("library-section")
      .filter({ hasText: FOLDER })
      .getByTestId("library-section-head");
    const menu = window.getByTestId("folder-actions").filter({ visible: true });

    // The Folder's menu and the filters read in Chinese too.
    await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: "zh-CN" },
      }),
    );
    await pointAt(window, head);
    await pointAndClick(window, head.getByTestId("folder-menu"));
    await expect(menu.getByTestId("folder.ask")).toHaveText("就此文件夹提问");
    await expect(menu.getByTestId("folder.newMind")).toHaveText("在此新建笔记");
    await window.keyboard.press("Escape");
    await pointAndClick(window, library.getByTestId("library-add-filter"));
    await expect(
      window.locator('[data-testid="library-filter-kind"][data-facet="status"]'),
    ).toHaveText("状态");
    await window.keyboard.press("Escape");
    await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: "en" },
      }),
    );

    await pointAt(window, head);
    await pointAndClick(window, head.getByTestId("folder-menu"));
    await pointAndClick(window, menu.getByTestId("folder.newMind"));
    await expect(window.getByTestId("library")).toHaveCount(0);
    await enterContent(window);
    await window.keyboard.type("Tides");
    const editor = window.getByTestId("mind-editor");
    await screenshot(window, "library-new-mind");

    // Asked, in the assistant, which searches the Folder; the new Mind stays empty.
    await connectLocalChatModel(window);
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("What do these say about tides?");
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("assistant-question")).toContainText(
      "What do these say about tides?",
    );
    const answer = assistantAnswers(window).first();
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    await expect(answer.getByTestId("answer-steps")).toContainText(`Searched “${FOLDER}” ·`);
    await expect(editor.getByTestId("question")).toHaveCount(0);
    await expect(editor.getByTestId("answer")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("with no Mind yet, asking about many Documents chosen makes one, and their chips fold", async () => {
  for (let index = 1; index <= 10; index++) {
    await writeFile(join(sources, `Survey ${index}.txt`), `Tide survey number ${index}, 2020.\n`);
  }
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await linkFolderFromSidebar(app, window, sources);
    await expectReadyDocuments(window, 15);
    await window.getByTestId("open-library").click();
    const library = window.getByTestId("library");
    const menu = await addFilter(window, library, "year");
    await menu.getByRole("menuitemcheckbox", { name: "2020, 10 Documents" }).click();
    await window.keyboard.press("Escape");
    const rows = library.getByTestId("library-document");
    await expect(rows).toHaveCount(10);
    await rows.first().locator("[data-row-main]").focus();
    await window.keyboard.press("ControlOrMeta+a");
    await pointAndClick(
      window,
      library.getByRole("button", { name: "Ask about these 10 Documents" }),
    );

    await expect(frontMindName(window)).toHaveText("Untitled");
    // The composer's Search scope: its first chips, then "+N more".
    const composer = composerOf(window);
    const input = composer.getByTestId("composer-input");
    const chips = composer.getByTestId("scope-chip");
    const more = composer.getByTestId("scope-chips-more");
    await expect(chips).toHaveCount(2);
    await expect(more).toHaveText("+8 more");
    await expect(input).toBeFocused();
    await more.click();
    await expect(chips).toHaveCount(10);
    await expect(more).toHaveText("Show fewer");
    // Unfolding keeps the focus where the Question is written.
    await expect(input).toBeFocused();
    await window.keyboard.type("How high were the tides?");
    await expect(input).toHaveValue("How high were the tides?");
    await expect(window.getByTestId("mind-list-item")).toHaveCount(1);
  } finally {
    await app.close();
  }
});
