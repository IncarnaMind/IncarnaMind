import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import type { TestHooks } from "../src/shared/testHooks";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  clickNow,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  interceptOpenDialog,
  launchApp,
  linkedFolderRow,
  linkFolderFromSidebar,
  openDocumentMenu,
  removeDataFolder,
  setWindowSize,
  showSourceLocations,
} from "./app";

/*
 * The Documents section as people use it with a mouse: dropping folders,
 * adding what is there already, retrying a Document that failed, folding
 * while filtering, the footer with more than one thing to say, right-clicks,
 * and the drop overlay. Set INCARNAMIND_SCREENSHOTS to a folder to also save
 * screenshots there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

async function screenshot(target: Page | Locator, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** Writes `files` (relative paths) under `root`, each holding `text` or its own name. */
async function writeTree(root: string, files: string[], text?: string): Promise<void> {
  for (const file of files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), text ?? `${file}.\n`);
  }
}

/** What dropping these paths on the window does, through the test hook (a test can't drop a folder). */
const drop = (window: Page, paths: string[]) =>
  window.evaluate(async (dropped) => {
    const hooks = (globalThis as { incarnamindTestHooks?: TestHooks }).incarnamindTestHooks;
    if (!hooks) throw new Error("Test hooks are off: launch with INCARNAMIND_TEST_HOOKS=1.");
    await hooks.addPaths(dropped);
  }, paths);

test("dropping folders offers each for linking in turn; what's there already is said once", async () => {
  const papers = join(sources, "Papers");
  const notes = join(sources, "Notes");
  await writeTree(papers, ["Attention.txt", "Scaling.txt"]);
  await writeTree(notes, ["Meeting.md"]);
  await writeTree(sources, ["Loose.txt"]);
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);

  // Two folders and a file dropped together: the file is added, each folder is asked about.
  await drop(window, [papers, join(sources, "Loose.txt"), notes]);
  const items = window.getByTestId("document-list-item");
  await expect(items.filter({ hasText: "Loose" })).toHaveCount(1);
  const dialog = window.getByTestId("link-folder-dialog");
  await expect(dialog.getByTestId("link-folder-name")).toHaveText("Papers");
  await expect(dialog.getByTestId("link-folder-files")).toHaveText(/^2 supported files/);
  // Linked; the next folder is asked about in its place.
  await dialog.getByTestId("link-folder-confirm").click();
  await expect(dialog.getByTestId("link-folder-name")).toHaveText("Notes");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await showSourceLocations(window);
  await expect(linkedFolderRow(window, "Papers")).toHaveCount(1);
  await expect(linkedFolderRow(window, "Notes")).toHaveCount(0);
  // Nothing was skipped: a folder isn't an unsupported file.
  await expect(window.getByTestId("skipped-files")).toHaveCount(0);

  // The same file again: nothing new, and the footer says so, once.
  await drop(window, [join(sources, "Loose.txt")]);
  const already = window.getByTestId("already-added");
  await expect(already).toHaveCount(1);
  await expect(already).toHaveAttribute("title", /Already in IncarnaMind.*Loose/);
  await expect(items.filter({ hasText: "Loose" })).toHaveCount(1);
  await screenshot(window.getByTestId("sidebar"), "already-added");
  await already.getByRole("button", { name: "Dismiss" }).click();
  await expect(already).toHaveCount(0);

  // The linked folder picked again: the dialog says it's linked already, and only closes.
  await interceptOpenDialog(app, papers);
  await window.getByTestId("plus-menu").click();
  await window.getByTestId("plus-add-documents").click();
  await expect(dialog.getByRole("heading")).toHaveText("Already in IncarnaMind");
  await expect(dialog.getByTestId("link-folder-inside")).toHaveText(
    "“Papers” is already linked, so its files are in IncarnaMind.",
  );
  await screenshot(window, "link-dialog-already-linked");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await app.close();
});

test("a Document that failed offers Retry, which processes it again", async () => {
  const report = join(sources, "Report.pdf");
  await writeFile(report, "This is not a PDF at all.");
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await window.getByTestId("add-documents-input").setInputFiles([report]);
  const item = window.getByTestId("document-list-item");
  await expect(item).toHaveAttribute("data-status", "failed");
  await expect(item.getByTestId("document-status")).toHaveText(/^Failed/);

  // Fixed on disk, then retried from its menu.
  await writeFile(report, buildPdf([{ lines: ["Quarterly report"] }]));
  await openDocumentMenu(item);
  await screenshot(window, "document-failed-menu");
  // At once, while the menu still grows in, before the file's change is noticed on its own.
  await clickNow(window, item.getByTestId("document.retry"));
  await expect(item).toHaveAttribute("data-status", "ready");
  // A ready Document has nothing to retry.
  await openDocumentMenu(item);
  await expect(item.getByTestId("document.retry")).toHaveCount(0);
  await app.close();
});

test("the footer shows the most pressing status, keeps the others a click away, and gives a problem its second line", async () => {
  await writeFile(join(sources, "Paper.txt"), "Test loss falls as a power law in model size.\n");
  await writeFile(join(sources, "Archive.zip"), "not a document");
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const status = window.getByTestId("sidebar-status");
  const before = await status.boundingBox();

  await window
    .getByTestId("add-documents-input")
    .setInputFiles([join(sources, "Paper.txt"), join(sources, "Archive.zip")]);
  // Once the paper is read, two things to say, whatever the machine's speed: the skipped
  // file first, and tagging, which waits for a model, behind "+1".
  await expect(window.getByTestId("document-list-item")).toHaveAttribute("data-status", "ready");
  // A Tag of its own: the model it waits for is named only once a Tag exists (#1942).
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const [document] = await core.listDocuments();
    const tag = await core.createTag({ name: "Papers", description: "" });
    if (document) await core.addTagToDocuments([document.id], tag.id);
  });
  await expect(status.getByTestId("skipped-files")).toBeVisible();
  const more = status.getByTestId("status-more");
  await expect(more).toHaveText("+1");
  // A file it can't take, with Show beside it, takes a second line: 20px of text either side of
  // the row's 4px. The footer keeps its width, and no more.
  const after = await status.boundingBox();
  expect(after?.width).toBe(before?.width);
  expect(after?.height).toBe(48);
  await more.click();
  const others = status.getByTestId("status-others");
  await expect(others).toBeVisible();
  await expect(others.getByTestId("tagging-waiting")).toBeVisible();
  await screenshot(window.getByTestId("sidebar"), "footer-more");
  await window.keyboard.press("Escape");
  await expect(others).toBeHidden();
  await app.close();
});

test("a right-click on a row opens its menu, without selecting its name; a selected row keeps its outline", async () => {
  await writeFile(join(sources, "Field notes.txt"), "Notes from the field.\n");
  const library = join(sources, "Library");
  await writeTree(library, ["Paper.txt"]);
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await addDocuments(window, [join(sources, "Field notes.txt")]);
  await linkFolderFromSidebar(app, window, library);
  await showSourceLocations(window);
  const item = window.getByTestId("document-list-item").filter({ hasText: "Field notes" });
  // Settled: the file added on its own is in Not in a Folder, at the top level.
  await expect(linkedFolderRow(window, "Library")).toHaveAttribute("data-state", "idle");
  await expect(item).toHaveAttribute("data-depth", "0");

  await item.getByTestId("row-text").click({ button: "right" });
  await expect(item.getByTestId("document-file-actions")).toBeVisible();
  expect(await window.evaluate(() => document.getSelection()?.toString() ?? "")).toBe("");
  await window.keyboard.press("Escape");

  const root = linkedFolderRow(window, "Library");
  await root.getByTestId("row-text").click({ button: "right" });
  await expect(root.getByTestId("linked-folder-actions")).toBeVisible();
  expect(await window.evaluate(() => document.getSelection()?.toString() ?? "")).toBe("");
  await window.keyboard.press("Escape");

  // Selected (open in the viewer) and pointed at: its actions sit inside its outline, and clear of a focus ring's 2px.
  await item.getByTestId("open-document").click();
  await item.hover();
  const row = await item.boundingBox();
  const actions = await item.locator(":scope > div").boundingBox();
  if (!row || !actions) throw new Error("The row isn't visible.");
  expect(actions.y).toBeCloseTo(row.y + 2, 0);
  expect(actions.x + actions.width).toBeCloseTo(row.x + row.width - 2, 0);
  await screenshot(window.getByTestId("sidebar"), "selected-row-hover");
  await app.close();
});

test("the drop overlay is the card's alone, and hides what is under it", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await window.getByTestId("tab-groups").evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["x"], "Notes.txt", { type: "text/plain" }));
    const box = element.getBoundingClientRect();
    element.dispatchEvent(
      new DragEvent("dragenter", {
        bubbles: true,
        dataTransfer: transfer,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
      }),
    );
  });
  const overlay = window.getByTestId("drop-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveCSS("background-color", "rgb(231, 237, 251)");
  await expect(overlay).toContainText("or a folder to link it");
  await screenshot(window, "drop-overlay");

  // Over the sidebar the card stays quiet, so the sidebar is never covered, and the label says
  // what the window's own add would do.
  await window.getByTestId("sidebar").evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["x"], "Notes.txt", { type: "text/plain" }));
    const box = element.getBoundingClientRect();
    element.dispatchEvent(
      new DragEvent("dragover", {
        bubbles: true,
        dataTransfer: transfer,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
      }),
    );
  });
  await expect(overlay).toHaveCount(0);
  await expect(window.getByTestId("drop-label")).toHaveText("Add to Library");
  await app.close();
});

test("Add Documents opens a sheet on the window in a folder on this computer, then where the User last picked from", async () => {
  const notes = join(sources, "Notes.txt");
  const plan = join(sources, "Plan.md");
  await writeFile(notes, "Notes about tides.");
  await writeFile(plan, "# Plan\n\nRead the tide tables.");
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  // The system's open dialog, answered by the test: it records how it was opened.
  await app.evaluate(
    ({ dialog }, picked) => {
      const asked: { sheet: boolean; options: Electron.OpenDialogOptions }[] = [];
      (globalThis as { openDialogsAsked?: unknown }).openDialogsAsked = asked;
      dialog.showOpenDialog = (async (...args: unknown[]) => {
        asked.push({
          sheet: args.length === 2,
          options: args.at(-1) as Electron.OpenDialogOptions,
        });
        return { canceled: false, filePaths: picked };
      }) as typeof dialog.showOpenDialog;
    },
    [notes, plan],
  );
  const asked = () =>
    app.evaluate(
      () =>
        (
          globalThis as {
            openDialogsAsked?: { sheet: boolean; options: Electron.OpenDialogOptions }[];
          }
        ).openDialogsAsked ?? [],
    );

  // From the "+" menu.
  await window.getByTestId("plus-menu").click();
  await window.getByTestId("plus-add-documents").click();
  const items = window.getByTestId("document-list-item");
  await expect(items).toHaveCount(2);
  const downloads = await app.evaluate(({ app: electron }) => electron.getPath("downloads"));
  const [first] = await asked();
  expect(first?.sheet).toBe(true);
  expect(first?.options.defaultPath).toBe(downloads);
  // macOS can offer files and a folder in one sheet; Windows and Linux only files there (#1942).
  expect(first?.options.properties).toEqual(
    process.platform === "darwin"
      ? ["openFile", "openDirectory", "multiSelections"]
      : ["openFile", "multiSelections"],
  );

  // Next time it starts where those came from.
  await window.getByTestId("plus-menu").click();
  await window.getByTestId("plus-add-documents").click();
  await expect.poll(async () => (await asked()).length).toBe(2);
  expect((await asked())[1]?.options.defaultPath).toBe(sources);
  await app.close();
});

test("the Library's count keeps its place and width as Documents are added", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  const count = window.getByTestId("library-row-count");
  const placeOf = async () => {
    const box = await count.boundingBox();
    if (!box) throw new Error("The Library's count isn't showing.");
    return { left: box.x, width: box.width };
  };

  let added = 0;
  const addUpTo = async (total: number) => {
    const files = Array.from({ length: total - added }, (_, index) =>
      join(sources, `Report ${String(added + index + 1).padStart(4, "0")}.txt`),
    );
    await Promise.all(files.map((file) => writeFile(file, `${file}.\n`)));
    await (await coreOf(window)).evaluate((core, paths) => core.addDocuments(paths), files);
    added = total;
  };

  await addUpTo(1);
  await expect(count).toHaveText("1");
  const first = await placeOf();
  for (const [total, shown] of [
    [12, "12"],
    [123, "123"],
    [1234, "1,234"],
  ] as const) {
    await addUpTo(total);
    await expect(count).toHaveText(shown);
    expect(await placeOf()).toEqual(first);
  }
  await app.close();
});

test("the Documents list holds its rows while a batch is being added, and the count follows it", async () => {
  test.setTimeout(240_000);
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  const core = await coreOf(window);

  // Two Documents are there before the batch: their rows are the ones that must not move.
  const earlier = ["Earlier one.txt", "Earlier two.txt"].map((name) => join(sources, name));
  await Promise.all(earlier.map((file) => writeFile(file, "Added before the batch.\n")));
  await core.evaluate((each, files) => each.addDocuments(files), earlier);
  const rows = window.getByTestId("document-list-item");
  await expect(rows).toHaveCount(2);
  const listed = () =>
    rows.evaluateAll((all) =>
      all.map((row) => ({
        name: row.querySelector('[data-testid="row-text"]')?.textContent ?? "",
        top: Math.round(row.getBoundingClientRect().top),
      })),
    );
  const before = await listed();
  const count = window.getByTestId("library-row-count");
  const countBox = await count.boundingBox();

  // A batch of 400, started and left running.
  const files = Array.from({ length: 400 }, (_, index) =>
    join(sources, `Report ${String(index + 1).padStart(4, "0")}.txt`),
  );
  await Promise.all(files.map((file) => writeFile(file, `${file}.\n`)));
  await window.evaluate((each) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    (globalThis as unknown as { addedBatch?: Promise<unknown> }).addedBatch =
      bridge.addDocuments(each);
  }, files);

  // While the core has plenty of the batch: the tree still shows the two rows where they were, and
  // the count has already moved on, in the same place and width.
  const seen = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    let coreCount = 0;
    const until = Date.now() + 120_000;
    while (Date.now() < until) {
      coreCount = (await bridge.listDocuments()).length;
      if (coreCount >= 60) break;
      await new Promise((done) => setTimeout(done, 20));
    }
    const rows = [...document.querySelectorAll('[data-testid="document-list-item"]')];
    return {
      coreCount,
      count: document.querySelector('[data-testid="library-row-count"]')?.textContent ?? "",
      rows: rows.map((row) => ({
        name: row.querySelector('[data-testid="row-text"]')?.textContent ?? "",
        top: Math.round(row.getBoundingClientRect().top),
      })),
    };
  });
  expect(seen.coreCount).toBeGreaterThanOrEqual(60);
  expect(Number(seen.count.replace(/,/g, ""))).toBeGreaterThan(2);
  expect(seen.rows).toEqual(before);
  expect(await count.boundingBox()).toEqual(countBox);

  // Landed: its rows are listed, the ones there before still under the count.
  await window.evaluate(async () => {
    await (globalThis as unknown as { addedBatch?: Promise<unknown> }).addedBatch;
  });
  await expect(count).toHaveText("402");
  await expect(rows).toHaveCount(5);
  expect((await listed()).map((each) => each.name)).not.toContain(before[0]?.name);
  await app.close();
});
