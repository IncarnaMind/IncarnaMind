import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, expect, test } from "@playwright/test";
import { depositionMapper } from "../../src/core/documents/deposition";
import { BUILT_IN_TEXT_RECOGNITION_MODEL } from "../../src/core/documents/scan/model";
import { parseRecordCite } from "../../src/core/recordCites/parser";
import { resolveRecordCites } from "../../src/core/recordCites/resolver";
import { depositionScan } from "../../tests/helpers/depositionScan";
import { buildPdf } from "../../tests/helpers/pdf";
import { coreOf, dismissChatSetup, setWindowSize } from "../app";
import {
  copyModelsIn,
  copyModelsOut,
  launchPackaged,
  packagedExecutable,
  packagedLogLines,
} from "./app";

const RAW = "Smith Dep. 45:3–46:2";
const SCANS = [
  {
    physical: 8,
    printed: 45,
    rows: [
      "Q. Did the courier arrive?",
      "A. The courier arrived early.",
      "Q. Did the witness sign the sheet?",
      "A. The witness signed the sheet.",
    ],
  },
  {
    physical: 9,
    printed: 46,
    rows: [
      "Q. When did the witness sign it?",
      "A. The witness signed it at noon.",
      "Q. Did the neighbour leave?",
      "A. The neighbour left before noon.",
    ],
  },
  {
    physical: 10,
    printed: 47,
    rows: ["Q. Is this the third page?", "A. This third page is outside the cite."],
  },
] as const;
const EXPECTED_PASSAGE = [
  "Q. Did the witness sign the sheet?",
  "A. The witness signed the sheet.",
  "Q. When did the witness sign it?",
  "A. The witness signed it at noon.",
].join("\n");

test.skip(process.platform !== "darwin", "CI builds and runs the packaged app on macOS only");

let app: ElectronApplication | undefined;
let dataDir = "";
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
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

// protects=the packaged app's real OCR stores printed deposition anchors and resolves 45:3–46:2 to only those rows on physical pages 8–9 (#1709); fails_when=the scan is not read by the real engine, printed labels are not stored, or the passage includes a header, adjacent row or third page; no_claim=noisy or rotated deposition scans, other OCR layouts, or non-macOS packaging.
test("real OCR stores deposition anchors and resolves a printed range across scanned pages", async () => {
  test.setTimeout(20 * 60_000);
  expect(existsSync(packagedExecutable), `${packagedExecutable}: run npm run dist:dir first`).toBe(
    true,
  );
  const home = await mkdtemp(join(tmpdir(), "incarnamind-home-"));
  dataDir = await mkdtemp(join(tmpdir(), "incarnamind-data-"));
  const sources = await mkdtemp(join(tmpdir(), "incarnamind-sources-"));
  folders.push(home, dataDir, sources);

  const frontMatter = Array.from({ length: 7 }, (_, index) => ({
    lines: [`Front matter ${index + 1}`],
  }));
  const scannedPages = SCANS.map(({ printed, rows }) => ({
    scan: depositionScan([
      `SMITH DEPOSITION - HEADER ${printed}`,
      `Page ${printed}`,
      ...rows.map((row, index) => `${index + 1} ${row}`),
    ]),
  }));
  const file = join(sources, "Smith Deposition.pdf");
  await writeFile(file, buildPdf([...frontMatter, ...scannedPages]));

  await copyModelsIn(dataDir);
  app = await launchPackaged(home, dataDir, { testHooks: true });
  const window = await app.firstWindow();
  await setWindowSize(app, window, 1000, 640);
  await dismissChatSetup(window);
  const bridge = await coreOf(window);
  const added = await bridge.evaluate((core, path) => core.addDocuments([path]), file);
  const id = added.added[0];
  if (!id) throw new Error("The deposition was not added.");
  await expect
    .poll(
      () =>
        bridge.evaluate(
          async (core, documentId) =>
            (await core.listDocuments()).find((document) => document.id === documentId)?.status,
          id,
        ),
      { timeout: 10 * 60_000 },
    )
    .toMatch(/^(ready|failed)$/);
  const document = await bridge.evaluate(
    async (core, documentId) => (await core.listDocuments()).find((each) => each.id === documentId),
    id,
  );
  if (!document) throw new Error("The deposition is missing.");
  expect(document.status).toBe("ready");

  const scanned = await bridge.evaluate((core, documentId) => core.readScannedText(documentId), id);
  const ocrEvidence = test.info().outputPath("deposition-ocr.json");
  await writeFile(ocrEvidence, JSON.stringify(scanned, null, 2));
  await test.info().attach("deposition-ocr", {
    path: ocrEvidence,
    contentType: "application/json",
  });
  expect(scanned.pages.map((page) => page.page)).toEqual(SCANS.map((page) => page.physical));
  for (const { physical, printed, rows } of SCANS) {
    const page = scanned.pages.find((each) => each.page === physical);
    if (!page) throw new Error(`Physical page ${physical} has no scanned text.`);
    expect(page.label?.scan?.reader).toBe(BUILT_IN_TEXT_RECOGNITION_MODEL.reader);
    const stored = Object.fromEntries(
      page.anchors
        .filter((anchor) => anchor.target.startsWith("deposition:"))
        .map((anchor) => [anchor.target, page.text.slice(anchor.start, anchor.end)]),
    );
    const expected = [
      [`deposition:page:${printed}`, `Page ${printed}`],
      ...rows.map((row, index) => [`deposition:line:${printed}:${index + 1}`, row]),
    ];
    expect(stored).toEqual(Object.fromEntries(expected));
  }

  const [resolved] = resolveRecordCites({
    cites: [parseRecordCite(RAW)],
    documents: [
      {
        id: document.id,
        name: document.name,
        contentHash: document.contentHash,
        units: scanned.pages,
      },
    ],
    choices: {},
    deposition: depositionMapper,
  });
  if (!resolved) throw new Error("The deposition citation returned no result.");
  expect(resolved).toMatchObject({
    raw: RAW,
    outcome: "found",
    documentId: document.id,
    pageFrom: 8,
    pageTo: 9,
    location: {
      kind: "page",
      from: 8,
      to: 9,
      printed: { from: "45", to: "46" },
      lines: { from: 3, to: 2 },
    },
  });
  expect(resolved.passage).toBe(EXPECTED_PASSAGE);
  for (const excluded of ["HEADER", "courier", "neighbour", "third page"]) {
    expect(resolved.passage).not.toContain(excluded);
  }

  await bridge.dispose();
  await app.close();
  app = undefined;
  await copyModelsOut(dataDir);
});
