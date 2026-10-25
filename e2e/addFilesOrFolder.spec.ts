import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
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

const WORDS = {
  en: { add: "Add files or a folder…", link: "Link a folder…", readOnly: "read-only" },
} as const;

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

test("the + menu offers one way in, and a folder picked there is read where it is", async () => {
  test.setTimeout(180_000);
  const words = WORDS.en;
  const folder = join(sources, "Contracts");
  await mkdir(folder);
  await writeFile(join(folder, "Lease.txt"), "The lease term is five years.\n");
  const { app, window } = await start();

  await window.getByTestId("plus-menu").click();
  await expect(window.getByTestId("plus-add-documents")).toContainText(words.add);
  await shot(window, "plus-menu-one-way-in");
  await window.getByTestId("plus-more").click();
  await expect(window.getByTestId("plus-more-menu")).not.toContainText(words.link);
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
  await expect(row.getByTestId("linked-folder-read-only")).toHaveText(words.readOnly);
  await expect
    .poll(() =>
      window.evaluate(
        async () =>
          (
            await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments()
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
            await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments()
          ).find((each) => each.name === "Lease")?.fileStatus,
      ),
    )
    .toBe("available");
});

test("⌘K finds Add files or a folder…", async () => {
  test.setTimeout(180_000);
  const { window } = await start();
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("Add files or a folder");
  await expect(paletteFound(window).filter({ hasText: "Add files or a folder…" })).toHaveCount(1);
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("palette")).toBeHidden();
});
