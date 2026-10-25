import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  leaveFirstOpen,
  linkFolderFromSidebar,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/**
 * Day one (#1942): a newcomer's sidebar is one flat list called Documents,
 * with the example's row beside it and no Library, Folders, Linked folders or
 * Tags named until one helps. Tags become a Library filter once one exists,
 * and the example's Documents stay out of the User's Library.
 */
const SHOTS = process.env.DAY_ONE_SHOTS;

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
  en: { documents: "Documents", tags: "Tags" },
  "zh-CN": { documents: "文档", tags: "标签" },
} as const;

const PDFS = ["Tides.pdf", "Seabirds.pdf", "Ledger.pdf"];

async function threePdfs(): Promise<string[]> {
  const written: string[] = [];
  for (const name of PDFS) {
    const path = join(sources, name);
    await writeFile(
      path,
      buildPdf([{ lines: [`${name} says the tide tables are read every spring.`] }]),
    );
    written.push(path);
  }
  return written;
}

type Window = Awaited<ReturnType<typeof launchApp>>["window"];

/** How many of the three PDFs' Documents are live (or read), by their shown names. */
const countPdfs = (window: Window, status?: "ready") =>
  window.evaluate(
    async (wanted: { names: string[]; status?: string }) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return (await core.listDocuments()).filter(
        (each) =>
          wanted.names.includes(each.name) &&
          (wanted.status === undefined || each.status === wanted.status),
      ).length;
    },
    { names: PDFS.map((name) => name.replace(".pdf", "")), status },
  );

/** Adds files through the page's own input, as a drop does, and waits for them to be read. */
async function addFiles(window: Window, paths: string[]): Promise<void> {
  await window.getByTestId("add-documents-input").setInputFiles(paths);
  await expect.poll(() => countPdfs(window, "ready"), { timeout: 60_000 }).toBe(paths.length);
}

/** How many of the User's own Documents the core holds: the ones this spec added. */
const countOwn = (window: Window, start = "Note ") =>
  window.evaluate(async (prefix: string) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.listDocuments()).filter((each) => each.name.startsWith(prefix)).length;
  }, start);

async function shot(window: Window, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await window.screenshot({ path: join(SHOTS, `${name}.png`) });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`day one is one flat list called Documents, with nothing new but the example (${language})`, async () => {
    test.setTimeout(180_000);
    const words = WORDS[language];
    const paths = await threePdfs();
    const { app, window } = await launchApp(dataDir, { examples: true, home: sources });
    await setWindowSize(app, window, 900, 900);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await addFiles(window, paths);

    // One flat list, counted, where Not in a Folder would be once Folders exist.
    const list = window.getByTestId("not-in-a-folder-section");
    await expect(list.getByTestId("not-in-a-folder-title")).toContainText(words.documents);
    await expect(list.getByTestId("sidebar-section-count")).toHaveText("3");
    for (const name of PDFS) {
      await expect(
        window.getByTestId("document-list-item").filter({ hasText: name.replace(".pdf", "") }),
      ).toHaveCount(1);
    }

    // Nothing else new: no Library row, no Linked folders, no Tags.
    await expect(window.getByTestId("open-library")).toHaveCount(0);
    await expect(window.getByTestId("linked-folders-section")).toHaveCount(0);
    await expect(window.getByTestId("sidebar-tags")).toHaveCount(0);
    // And nothing asks for a model for Tags, or names them at all.
    for (const id of ["tagging-waiting", "tagging-stopped", "tagging-failed"]) {
      await expect(window.getByTestId(id)).toHaveCount(0);
    }
    await expect(window.getByTestId("sidebar")).not.toContainText(words.tags);
    await shot(window, `day-one-${language}-900`);

    await setWindowSize(app, window, 1600, 1000);
    await expect(list.getByTestId("sidebar-section-count")).toHaveText("3");
    await shot(window, `day-one-${language}-1600`);
  });
}

test("Tags are never named until one exists, then they are a Library filter", async () => {
  test.setTimeout(180_000);
  const paths = await threePdfs();
  const { app, window } = await launchApp(dataDir, { examples: true, home: sources });
  await setWindowSize(app, window, 900, 900);
  await dismissChatSetup(window);
  await setLanguage(window, "en");
  await addFiles(window, paths);
  await expect(window.getByTestId("sidebar-tags")).toHaveCount(0);

  // The Library holds the User's own Documents only: the example's stay out.
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.changeLayout("main", { type: "open", item: { kind: "library" } });
  });
  const page = window.getByTestId("library");
  await expect(page.getByTestId("library-document")).toHaveCount(3);
  await expect(page).not.toContainText("Northwind Retail");

  // A Tag on one of them: the sidebar's Tags and the Library's Tags filter come.
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const [document] = await core.listDocuments();
    const tag = await core.createTag({ name: "Contracts", description: "" });
    if (document) await core.addTagToDocuments([document.id], tag.id);
  });
  await expect(window.getByTestId("sidebar-tags")).toBeVisible();
  await window.getByTestId("library-add-filter").click();
  await expect(
    window.locator('[data-testid="library-filter-kind"][data-facet="tag"]'),
  ).toBeVisible();
});

test("Undo takes the add on day one back", async () => {
  test.setTimeout(180_000);
  const paths = await threePdfs();
  const { app, window } = await launchApp(dataDir, { examples: true, home: sources });
  await setWindowSize(app, window, 900, 900);
  await dismissChatSetup(window);
  await setLanguage(window, "en");
  await addFiles(window, paths);
  await expect(window.getByTestId("not-in-a-folder-section")).toBeVisible();

  await window.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => countPdfs(window)).toBe(0);

  // Added again, it counts once each time: the list stays one flat list.
  await addFiles(window, paths);
  await expect(window.getByTestId("sidebar-section-count")).toHaveText("3");
  await expect(window.getByTestId("open-library")).toHaveCount(0);
});

test("a Folder is offered at the eighth loose Document, by pointer and by the tree's keys (#1942)", async () => {
  test.setTimeout(180_000);
  const files = Array.from({ length: 8 }, (_, index) => join(sources, `Note ${index + 1}.txt`));
  for (const [index, file] of files.entries())
    await writeFile(file, `Note ${index + 1}. The tide tables, again.`);
  const { window } = await launchApp(dataDir, { examples: true, home: sources });
  await dismissChatSetup(window);
  await setLanguage(window, "en");
  await window.getByTestId("add-documents-input").setInputFiles(files);
  await expect.poll(() => countOwn(window), { timeout: 30_000 }).toBe(8);
  // Still day one: one flat list, no Library row.
  await expect(window.getByTestId("open-library")).toHaveCount(0);
  await expect(window.getByTestId("not-in-a-folder-title")).toContainText("Documents");

  // The offer sits in the tree's keys: ↓ reaches it from the last row, Enter makes a Folder.
  const offer = window.getByTestId("offer-folder");
  await expect(offer).toBeVisible();
  await window.getByTestId("show-more-documents").click();
  // The User’s eight, and the example’s two until #1944’s fold.
  await expect(window.getByTestId("document-list-item")).toHaveCount(10);
  const last = window.getByTestId("document-list-item").last();
  await last.getByTestId("open-document").focus();
  await window.keyboard.press("ArrowDown");
  await expect(offer).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("folder-rename-field")).toBeVisible();
  await window.keyboard.type("Tides");
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("folder-row").filter({ hasText: "Tides" })).toHaveCount(1);
  // A Folder of the User's own is one of the three ways day one ends.
  await expect(window.getByTestId("open-library")).toBeVisible();
  // And ⌘Z puts it back as it was.
  await window.keyboard.press("ControlOrMeta+z");
  await expect(window.getByTestId("folder-row").filter({ hasText: "Tides" })).toHaveCount(0);
  await expect(window.getByTestId("open-library")).toHaveCount(0);
});

test("a Linked folder of the User's own shows its row only, never the example's, and leaves the Library row waiting (#1942)", async () => {
  test.setTimeout(180_000);
  const folder = join(sources, "Contracts");
  await mkdir(folder);
  await writeFile(join(folder, "Lease.txt"), "The lease term is five years.\n");
  const { app, window } = await launchApp(dataDir, { examples: true, home: sources });
  await dismissChatSetup(window);
  await setLanguage(window, "en");
  await linkFolderFromSidebar(app, window, folder);

  const section = window.getByTestId("linked-folders-section");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("row-text")).toHaveText(["Contracts"]);
  await expect(window.getByTestId("linked-folder-rows").getByText("Examples")).toHaveCount(0);
  // One Linked folder and no Folder is not a reason to show the Library on day one.
  await expect(window.getByTestId("open-library")).toHaveCount(0);

  // The steps put away, the Library row comes as it did.
  await leaveFirstOpen(window);
  await expect(window.getByTestId("open-library")).toBeVisible();
});
