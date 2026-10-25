import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addFilesLabel,
  createDataFolder,
  dismissChatSetup,
  interceptOpenDialog,
  launchApp,
  linkedFolderRow,
  paletteFound,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/**
 * One way in (#1942): "Add files or a folder…" takes files and a folder, in
 * the + menu and from ⌘K, and a folder picked there is read where it is, its
 * row saying read-only. Link a folder… is no longer a second item.
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

const SHOTS = process.env.ADD_FILES_SHOTS;

const ADD = addFilesLabel("en");
const LINK = "Link a folder…";
const READ_ONLY = "read-only";

async function threePdfs(): Promise<string[]> {
  const written: string[] = [];
  for (const name of ["Tides.pdf", "Seabirds.pdf", "Ledger.pdf"]) {
    const path = join(sources, name);
    await writeFile(path, buildPdf([{ lines: [`${name} says the tide is high.`] }]));
    written.push(path);
  }
  return written;
}

async function shot(window: Awaited<ReturnType<typeof launchApp>>["window"], name: string) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await window.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function start() {
  const paths = await threePdfs();
  const { app, window } = await launchApp(dataDir, { examples: true, home: sources });
  await setWindowSize(app, window, 900, 900);
  await dismissChatSetup(window);
  await setLanguage(window, "en");
  await window.getByTestId("add-documents-input").setInputFiles(paths);
  await expect
    .poll(() =>
      window.evaluate(
        async () =>
          (
            await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments()
          ).filter((each) => each.name.startsWith("Tides")).length,
      ),
    )
    .toBe(1);
  return { app, window, paths };
}

// macOS is the platform whose one sheet takes a folder too; Windows and Linux offer files only.
const mac = process.platform === "darwin";

test("the + menu offers one way in, and a folder picked there is read where it is", async () => {
  test.setTimeout(180_000);
  const folder = join(sources, "Contracts");
  await mkdir(folder);
  await writeFile(join(folder, "Lease.txt"), "The lease term is five years.\n");
  test.skip(!mac, "Only macOS's one sheet takes a folder with the files.");
  const { app, window } = await start();
  try {
    await window.getByTestId("plus-menu").click();
    await expect(window.getByTestId("plus-add-documents")).toContainText(ADD);
    await shot(window, "plus-menu-one-way-in");
    await window.getByTestId("plus-more").click();
    await expect(window.getByTestId("plus-more-menu")).not.toContainText(LINK);
    await window.keyboard.press("Escape");
    await window.keyboard.press("Escape");

    await interceptOpenDialog(app, folder);
    await window.getByTestId("plus-menu").click();
    await window.getByTestId("plus-add-documents").click();
    const dialog = window.getByTestId("link-folder-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("link-folder-confirm").click();
    await expect(dialog).toBeHidden();

    const row = linkedFolderRow(window, "Contracts");
    await expect(row).toBeVisible();
    await expect(row.getByTestId("linked-folder-read-only")).toHaveText(READ_ONLY);
    await expect
      .poll(() =>
        window.evaluate(
          async () =>
            (
              await (
                globalThis as unknown as { incarnamind: CoreBridge }
              ).incarnamind.listDocuments()
            ).filter((each) => each.name === "Lease").length,
        ),
      )
      .toBe(1);
    // The file is still where the User keeps it.
    await expect
      .poll(() =>
        window.evaluate(
          async () =>
            (
              await (
                globalThis as unknown as { incarnamind: CoreBridge }
              ).incarnamind.listDocuments()
            ).find((each) => each.name === "Lease")?.fileStatus,
        ),
      )
      .toBe("available");

    // A folder the User allows IncarnaMind to add files to is not read-only: the label goes.
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      // The example has a Linked folder of its own: the one this test linked is Contracts.
      const linked = (await core.listLinkedFolders()).find((each) =>
        each.path.endsWith("Contracts"),
      );
      if (!linked) throw new Error("Contracts isn't linked.");
      await core.setLinkedFolderWriting(linked.id, true);
    });
    await expect
      .poll(() =>
        window.evaluate(async () => {
          const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          const settings = await core.getOutputSettings();
          return settings.linkedFolders.map((each) => each.allowed);
        }),
      )
      .toEqual([true]);
    await expect(row.getByTestId("linked-folder-read-only")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("a folder linked outside the one sheet is read where it is, where that sheet takes no folder", async () => {
  test.setTimeout(180_000);
  test.skip(mac, "macOS adds a folder through the one sheet instead.");
  const folder = join(sources, "Contracts");
  await mkdir(folder);
  await writeFile(join(folder, "Lease.txt"), "The lease term is five years.\n");
  const { app, window } = await start();
  try {
    await window.evaluate(async (path) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.addLinkedFolder(path);
    }, folder);
    const row = linkedFolderRow(window, "Contracts");
    await expect(row).toBeVisible();
    await expect(row.getByTestId("linked-folder-read-only")).toHaveText(READ_ONLY);
  } finally {
    await app.close();
  }
});

test("⌘K finds the one way in, and running it opens the one sheet, at 1,600 px too", async () => {
  test.setTimeout(180_000);
  const picked = join(sources, mac ? "Contracts" : "Rates.txt");
  if (mac) {
    await mkdir(picked);
    await writeFile(join(picked, "Lease.txt"), "The lease term is five years.\n");
  } else {
    await writeFile(picked, "The rates are agreed.\n");
  }
  const { app, window } = await start();
  try {
    await setWindowSize(app, window, 1600, 1000);

    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.type(ADD.replace(/…$/, ""));
    const found = paletteFound(window).filter({ hasText: ADD });
    await expect(found).toHaveCount(1);
    await interceptOpenDialog(app, picked);
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("palette")).toBeHidden();
    if (mac) {
      const dialog = window.getByTestId("link-folder-dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
    } else {
      // A file: it is read as a Document, and no folder is offered.
      await expect(
        window.getByTestId("document-list-item").filter({ hasText: "Rates" }),
      ).toHaveCount(1, { timeout: 20_000 });
      await expect(window.getByTestId("link-folder-dialog")).toHaveCount(0);
    }
  } finally {
    await app.close();
  }
});
