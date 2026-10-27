import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  acceptPlainTextKeys,
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
  // The User's eight: the example's own Documents have folded to one Example row (#1944).
  await expect(window.getByTestId("document-list-item")).toHaveCount(8);
  await expect(window.getByTestId("example-row")).toHaveCount(1);
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

/** The footer's line for a status, by its label, in the interface's language. */
const statusLabel = (window: Window, id: string) =>
  window.getByTestId("sidebar-status").getByTestId(id).getByTestId("status-label");

/** A chat key saved as this device's, automatic tagging on: no model dialog, no Tag. */
async function tagAutomatically(window: Window, apiKey: string): Promise<string | null> {
  await acceptPlainTextKeys(window);
  return window.evaluate(async (key) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const provider = await core.saveChatProvider({
      kind: "openai",
      apiKey: key,
      modelId: "gpt-6-luna",
    });
    await core.saveLibrarySettings({ ...(await core.getLibrary()).settings, automatic: true });
    return provider.service?.id ?? null;
  }, apiKey);
}

test("with no Tag, a failed tagging still reaches the footer, in English and Chinese (#1942)", async () => {
  test.setTimeout(180_000);
  const file = join(sources, "Invoice 51.txt");
  await writeFile(file, "Invoice 51. The invoice server was unreachable.\n");
  const { app, window } = await launchApp(dataDir, {
    examples: true,
    fakeChat: true,
    home: sources,
  });
  await setWindowSize(app, window, 1440, 900);
  try {
    await setLanguage(window, "en");
    await tagAutomatically(window, "sk-test");
    await window.getByTestId("add-documents-input").setInputFiles([file]);
    const item = window.getByTestId("document-list-item").filter({ hasText: "Invoice 51" });
    await expect(item).toHaveAttribute("data-tagging", "failed", { timeout: 60_000 });
    // No Tag of the User's own anywhere: the failure is still the User's to act on.
    await expect(window.getByTestId("sidebar-tags")).toHaveCount(0);
    await expect(statusLabel(window, "tagging-failed")).toHaveText("1 Document couldn’t be tagged");
    await setLanguage(window, "zh-CN");
    await expect(statusLabel(window, "tagging-failed")).toHaveText("1 个文档未能打标签");
  } finally {
    await app.close();
  }
});

test("with no Tag, a rate limit still reaches the footer, in English and Chinese (#1942)", async () => {
  test.setTimeout(180_000);
  const file = join(sources, "Invoice 61.txt");
  await writeFile(file, "Invoice 61. The invoice server is rate-limited.\n");
  const { app, window } = await launchApp(dataDir, {
    examples: true,
    fakeChat: true,
    home: sources,
  });
  await setWindowSize(app, window, 1440, 900);
  try {
    await setLanguage(window, "en");
    await tagAutomatically(window, "sk-test");
    await window.getByTestId("add-documents-input").setInputFiles([file]);
    const item = window.getByTestId("document-list-item").filter({ hasText: "Invoice 61" });
    await expect(item).toHaveAttribute("data-tagging", "waiting-for-provider", {
      timeout: 60_000,
    });
    await expect(window.getByTestId("sidebar-tags")).toHaveCount(0);
    await expect(statusLabel(window, "tagging-rate-limited")).toHaveText(/^Rate limit reached/);
    await setLanguage(window, "zh-CN");
    await expect(statusLabel(window, "tagging-rate-limited")).toHaveText(/^已达到速率上限/);
  } finally {
    await app.close();
  }
});

test("with no Tag, a refused key still reaches the footer, in English and Chinese (#1942)", async () => {
  test.setTimeout(180_000);
  const file = join(sources, "Invoice 71.txt");
  await writeFile(file, "Invoice 71. Amount due: 90 EUR.\n");
  const { app, window } = await launchApp(dataDir, {
    examples: true,
    fakeChat: true,
    home: sources,
  });
  await setWindowSize(app, window, 1440, 900);
  try {
    await setLanguage(window, "en");
    // A key the provider doesn't know is refused as a wrong key is (401).
    await tagAutomatically(window, "sk-refused-a-wrong-key");
    await window.getByTestId("add-documents-input").setInputFiles([file]);
    const item = window.getByTestId("document-list-item").filter({ hasText: "Invoice 71" });
    await expect(item).toHaveAttribute("data-tagging", "waiting-for-provider", {
      timeout: 60_000,
    });
    await expect(window.getByTestId("sidebar-tags")).toHaveCount(0);
    await expect(statusLabel(window, "tagging-key-refused")).toHaveText("The key was refused");
    await setLanguage(window, "zh-CN");
    await expect(statusLabel(window, "tagging-key-refused")).toHaveText("密钥被拒绝了");
  } finally {
    await app.close();
  }
});

test("with no Tag, a missing consent still reaches the footer, in English and Chinese (#1942)", async () => {
  test.setTimeout(180_000);
  const file = join(sources, "Invoice 81.txt");
  await writeFile(file, "Invoice 81. Amount due: 150 EUR.\n");
  const { app, window } = await launchApp(dataDir, {
    examples: true,
    fakeChat: true,
    home: sources,
  });
  await setWindowSize(app, window, 1440, 900);
  try {
    await setLanguage(window, "en");
    const service = await tagAutomatically(window, "sk-test");
    if (!service) throw new Error("The saved key has no service to send to.");
    await window.evaluate(async (id) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.revokeConsent("tagging", id);
    }, service);
    await window.getByTestId("add-documents-input").setInputFiles([file]);
    const item = window.getByTestId("document-list-item").filter({ hasText: "Invoice 81" });
    await expect(item).toHaveAttribute("data-tagging", "waiting-for-provider", {
      timeout: 60_000,
    });
    await expect(window.getByTestId("sidebar-tags")).toHaveCount(0);
    await expect(statusLabel(window, "tagging-waiting")).toHaveText("Tags need your OK");
    await setLanguage(window, "zh-CN");
    await expect(statusLabel(window, "tagging-waiting")).toHaveText("打标签需要你允许");
  } finally {
    await app.close();
  }
});

test("an example's stored Organize assignment owes no progress on restart (#1942)", async () => {
  test.setTimeout(240_000);
  const launch = () => launchApp(dataDir, { examples: true, fakeChat: true, home: sources });
  const first = await launch();
  try {
    // Organize on, with a Folder to file into and a model: a Document waiting to be filed is work.
    await acceptPlainTextKeys(first.window);
    await first.window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const provider = await core.saveChatProvider({
        kind: "openai",
        apiKey: "sk-test",
        modelId: "gpt-6-luna",
      });
      await core.createLibraryGroup({ name: "Invoices", description: "Invoices" });
      await core.saveLibrarySettings({
        classifier: {
          kind: "chat",
          choice: { providerId: provider.id, modelId: "gpt-6-luna" },
        },
        automatic: true,
      });
    });
    // The example's Documents are copied in as the app starts: wait for the first.
    const exampleDocuments = () =>
      first.window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const examples = await core.getExamples();
        if (examples.linkedFolderId === null) return [];
        return core.listDocuments({ linkedFolderId: examples.linkedFolderId });
      });
    await expect
      .poll(async () => (await exampleDocuments()).length, { timeout: 60_000 })
      .toBeGreaterThan(0);
    const [example] = await exampleDocuments();
    if (!example) throw new Error("The example has no Document.");
    // As an earlier version left it: waiting to be filed, and never worked on again.
    const exampleId = await first.window.evaluate(async (id) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.restoreAssignment(id, {
        groupId: null,
        source: "automatic",
        suggested: false,
        status: "pending",
        error: null,
        model: null,
      });
      return id;
    }, example.id);
    await first.app.close();

    const again = await launch();
    await setWindowSize(again.app, again.window, 1440, 900);
    try {
      await leaveFirstOpen(again.window);
      // One of the User's own, filed slowly: the count is theirs alone, never the example's too.
      const own = join(sources, "Note 1.txt");
      await writeFile(own, "Note 1. The tide tables are read slowly.\n");
      await again.window.getByTestId("add-documents-input").setInputFiles([own]);
      await expect(
        again.window
          .getByTestId("sidebar-status")
          .getByTestId("organization-progress")
          .getByTestId("status-label"),
      ).toHaveText(/^Organizing 1 Document\b/);
      // It ends when the User's own is filed: the example's waiting assignment owes nothing.
      await expect(again.window.getByTestId("organization-progress")).toHaveCount(0, {
        timeout: 60_000,
      });
      const stored = await again.window.evaluate(async (id) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        return (await core.getLibrary()).assignments.find((each) => each.documentId === id)?.status;
      }, exampleId);
      expect(stored).toBe("pending");
      await expect(again.window.getByTestId("sidebar")).not.toContainText("Organizing");
    } finally {
      await again.app.close();
    }
  } finally {
    await first.app.close().catch(() => undefined);
  }
});
