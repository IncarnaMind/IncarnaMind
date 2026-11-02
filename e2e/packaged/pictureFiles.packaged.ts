import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { Document } from "../../src/core/api";
import { coreOf, dismissChatSetup, setWindowSize } from "../app";
import {
  copyModelsIn,
  copyModelsOut,
  launchPackaged,
  packagedExecutable,
  packagedLogLines,
  runtimeTelemetryFolders,
} from "./app";

const root = resolve(__dirname, "../..");
const fixtures = join(root, "tests/fixtures");

test.skip(process.platform !== "darwin", "CI builds and runs the packaged app on macOS only");

let app: ElectronApplication | undefined;
let dataDir = "";
let sources = "";
const folders: string[] = [];

test.afterEach(async () => {
  const testInfo = test.info();
  await app?.close();
  app = undefined;
  if (testInfo.status !== testInfo.expectedStatus && dataDir) {
    const lines = await packagedLogLines(dataDir, /ERROR|WARN/);
    await testInfo.attach("app log", { body: lines.join("\n"), contentType: "text/plain" });
    console.log(lines.slice(-30).join("\n"));
  }
  for (const folder of [...folders.splice(0), ...runtimeTelemetryFolders(dataDir)]) {
    await rm(folder, { recursive: true, force: true });
  }
});

/**
 * Adds a picture file the way a person does, and waits until its one page has
 * been read by the real text recognition engine, as the packaged app runs it.
 */
async function importPicture(window: Page, name: string, bytes: Uint8Array): Promise<Document> {
  const path = join(sources, `${name}.jpg`);
  await writeFile(path, bytes);
  await window.getByTestId("add-documents-input").setInputFiles(path);
  const row = window.getByTestId("document-list-item").filter({ hasText: name });
  await expect
    .poll(() => row.getAttribute("data-status"), { timeout: 5 * 60_000 })
    .toMatch(/^(ready|failed)$/);
  const bridge = await coreOf(window);
  const document = (await bridge.evaluate((core) => core.listDocuments())).find(
    (each) => each.name === name,
  );
  await bridge.dispose();
  if (!document) throw new Error(`${name} wasn't added.`);
  return document;
}

// protects=the real OCR engine reading a picture file the way the built app runs it, its page anchored for a Citation and marked as read from a picture (#762); fails_when=a picture is refused, its text is not read, its lines have no boxes, or a quote is not said to be from a picture; no_claim=OCR accuracy on phone photos, HEIC, or non-macOS packaging.
test("a picture file is read by the real OCR engine, its lines anchored, and its Citation says read from a picture", async () => {
  test.setTimeout(20 * 60_000);
  expect(existsSync(packagedExecutable), `${packagedExecutable}: run npm run dist:dir first`).toBe(
    true,
  );
  const home = await mkdtemp(join(tmpdir(), "incarnamind-home-"));
  dataDir = await mkdtemp(join(tmpdir(), "incarnamind-data-"));
  sources = await mkdtemp(join(tmpdir(), "incarnamind-sources-"));
  folders.push(home, dataDir, sources);
  await copyModelsIn(dataDir);
  app = await launchPackaged(home, dataDir, { testHooks: true });
  const window = await app.firstWindow();
  await setWindowSize(app, window, 1000, 640);
  await dismissChatSetup(window);

  const bytes = await readFile(join(fixtures, "scans/en-clean.jpg"));
  const document = await importPicture(window, "Whiteboard", bytes);
  expect(document).toMatchObject({ kind: "image", status: "ready" });

  const bridge = await coreOf(window);
  const scanned = await bridge.evaluate((core, id) => core.readScannedText(id), document.id);
  const quoted = await bridge.evaluate(
    (core, id) =>
      core.readScannedQuote({
        documentId: id,
        contentHash: null,
        pageFrom: 1,
        pageTo: 1,
        quote: "undisputed invoice",
      }),
    document.id,
  );
  const found = await bridge.evaluate((core) =>
    core.searchPassages("undisputed invoice", { mode: "keyword" }),
  );
  await bridge.dispose();

  expect(scanned.pages).toHaveLength(1);
  const page = scanned.pages[0];
  expect(page?.label?.scan?.picture).toBe(true);
  expect(page?.text).toContain("MASTER SERVICES AGREEMENT");
  expect(page?.text).toContain("undisputed invoice");
  // Each line has its box on the picture, as a scanned page's do: where a quote is washed.
  expect(page?.anchors.length).toBeGreaterThan(3);
  expect(page?.anchors.every((anchor) => (anchor.quad?.length ?? 0) === 8)).toBe(true);
  expect(quoted).toEqual({ unsure: [], from: "picture" });
  expect(found.some((passage) => passage.documentId === document.id)).toBe(true);

  // The picture is read where it is: no copy of it was made.
  expect(document.path).toBe(join(sources, "Whiteboard.jpg"));
  expect(await readFile(document.path)).toEqual(bytes);
  await copyModelsOut(dataDir);
});
