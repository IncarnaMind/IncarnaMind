import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
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
  await expect.poll(() => countPdfs(window, "ready")).toBe(paths.length);
}

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
});
