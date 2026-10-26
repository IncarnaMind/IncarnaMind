import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { documentBlocks } from "../../src/core/answers/checks/verifyTables";
import type { Document, ScannedText } from "../../src/core/api";
import type { QuarterTurn } from "../../src/core/documents/scan/rotation";
import { buildPdf, type PdfPage } from "../../tests/helpers/pdf";
import { coreOf, dismissChatSetup, openDocumentAt, setWindowSize } from "../app";
import {
  copyModelsIn,
  copyModelsOut,
  launchPackaged,
  packagedExecutable,
  packagedLogLines,
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
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

interface Imported {
  document: Document;
  scanned: ScannedText;
  milliseconds: number;
}

async function importPdf(window: Page, name: string, contents: Uint8Array): Promise<Imported> {
  const path = join(sources, `${name}.pdf`);
  await writeFile(path, contents);
  const started = performance.now();
  await window.getByTestId("add-documents-input").setInputFiles(path);
  const row = window.getByTestId("document-list-item").filter({ hasText: name });
  await expect
    .poll(() => row.getAttribute("data-status"), { timeout: 3 * 60_000 })
    .toMatch(/^(ready|failed)$/);
  const bridge = await coreOf(window);
  const document = (await bridge.evaluate((core) => core.listDocuments())).find(
    (each) => each.name === name,
  );
  if (!document) throw new Error(`${name} wasn't added.`);
  expect(document.status).toBe("ready");
  const scanned = await bridge.evaluate((core, id) => core.readScannedText(id), document.id);
  await bridge.dispose();
  return { document, scanned, milliseconds: Math.round(performance.now() - started) };
}

function expectTable(text: string, label: string): void {
  const inOrder = (within: string | undefined, parts: readonly string[]) => {
    const positions = parts.map((part) => within?.indexOf(part) ?? -1);
    expect(
      positions.every((at) => at >= 0),
      `${label}: ${parts.join(" before ")}`,
    ).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  };
  const rows = text.split("\n");
  const freight = rows.find((row) => row.includes("Freight software"));
  expect(freight, `${label}:\n${text}`).toContain("4,812");
  expect(freight).toContain("5,330");
  inOrder(freight, ["4,812", "5,330"]);
  const warehouse = rows.find((row) => row.includes("Warehouse sensors"));
  expect(warehouse).toContain("2,147");
  expect(warehouse).toContain("1,985");
  inOrder(warehouse, ["2,147", "1,985"]);
  const east = rows.find((row) => row.includes("华东"));
  expect(east).toContain("1,286");
  expect(east).toContain("1,452");
  inOrder(east, ["1,286", "1,452"]);
  const south = rows.find((row) => row.includes("华南"));
  expect(south).toContain("974");
  expect(south).toContain("1,031");
  inOrder(south, ["974", "1,031"]);

  inOrder(text, [
    "Table 3. Revenue by product line",
    "Freight software",
    "Warehouse sensors",
    "Total",
    "华东",
    "华南",
    "合计",
  ]);
}

async function turnedJpeg(source: Uint8Array, turn: QuarterTurn): Promise<Uint8Array> {
  const image = await loadImage(Buffer.from(source));
  const swap = turn === 90 || turn === 270;
  const canvas = createCanvas(swap ? image.height : image.width, swap ? image.width : image.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (turn === 90) context.translate(canvas.width, 0);
  else if (turn === 180) context.translate(canvas.width, canvas.height);
  else if (turn === 270) context.translate(0, canvas.height);
  context.rotate((turn * Math.PI) / 180);
  context.drawImage(image, 0, 0);
  return canvas.encodeSync("jpeg", 90);
}

// protects=real OCR in the packaged app preserves quantities, EN+ZH table rows and original-page quote anchors across PDF /Rotate and sideways source pixels (#1819); fails_when=a quarter-turned page is recognized or laid out sideways, its 2 becomes N, or its Citation highlight leaves the quoted words; no_claim=general OCR accuracy, uncertainty presentation (#535), a chat model's arithmetic, or non-macOS packaging.
test("rotated scans keep their quantities, table rows and Citation highlights with the real OCR engine", async () => {
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

  const upright = await importPdf(
    window,
    "upright",
    await readFile(join(fixtures, "rotated-scans/upright.pdf")),
  );
  const rotated = await importPdf(
    window,
    "rotated",
    await readFile(join(fixtures, "rotated-scans/rotated.pdf")),
  );
  expect(rotated.scanned.pages.map((page) => page.text)).toEqual(
    upright.scanned.pages.map((page) => page.text),
  );
  const current = rotated.scanned.pages.find((page) => page.page === 2);
  expect(current?.text).toContain("状态：当前版本");
  expect(current?.text).toContain("最大载荷：0.250千克");
  const glass = current?.text.split("\n").find((row) => row.includes("Glass beads"));
  expect(glass).toContain("0.075");
  expect(glass).toContain("2");
  expect(glass).toContain("0.150");
  const control = current?.text.split("\n").find((row) => row.includes("Control weights"));
  expect(control).toContain("0.050");
  expect(control).toContain("2");
  expect(control).toContain("0.100");
  expect(current?.text.indexOf("LARCH STATION SPECIFICATION")).toBe(0);
  expect(current?.text.indexOf("Synthetic audit fixture")).toBeGreaterThan(
    current?.text.indexOf("状态：当前版本") ?? -1,
  );

  const table = await readFile(join(fixtures, "scans/table.jpg"));
  const correction = { 90: 270, 180: 180, 270: 90 } as const;
  const cases: { name: string; page: PdfPage; reading: QuarterTurn }[] = [
    { name: "Table upright", page: { scan: table }, reading: 0 },
    ...([90, 180, 270] as const).map((turn) => ({
      name: `Table Rotate ${turn}`,
      page: { scan: table, rotation: turn },
      reading: correction[turn],
    })),
  ];
  for (const turn of [90, 180, 270] as const) {
    cases.push({
      name: `Table pixels ${turn}`,
      page: { scan: await turnedJpeg(table, turn), landscape: turn !== 180 },
      reading: correction[turn],
    });
  }
  // The issue pair covers mixed pages. Identical tables stay in separate Documents so they aren't running headers.
  const generated: Imported[] = [];
  for (const { name, page, reading } of cases) {
    const imported = await importPdf(window, name, buildPdf([page]));
    expect(imported.scanned.pages.map((each) => each.page)).toEqual([1]);
    const scannedPage = imported.scanned.pages[0];
    if (!scannedPage) throw new Error(`${name} has no scanned text.`);
    expect(scannedPage.label?.scan?.turn).toBe(reading === 0 ? undefined : reading);
    expectTable(scannedPage.text, name);
    const blocks = documentBlocks(
      [{ page: 1, text: scannedPage.text, kind: "page", label: scannedPage.label }],
      new Map(),
      [scannedPage],
    );
    const tableText = JSON.stringify(blocks.filter((block) => block.node.type === "table"));
    expect(tableText).toContain("4,812");
    expect(tableText).toContain("1,452");
    generated.push(imported);
  }
  const generatedEvidence = test.info().outputPath("generated-ocr.json");
  await writeFile(
    generatedEvidence,
    JSON.stringify(
      generated.map((each) => ({ name: each.document.name, pages: each.scanned.pages })),
      null,
      2,
    ),
  );
  await test.info().attach("generated-ocr", {
    path: generatedEvidence,
    contentType: "application/json",
  });

  const bridge = await coreOf(window);
  expect(
    await bridge.evaluate(
      (core, id) =>
        core.readScannedQuote({
          documentId: id,
          contentHash: null,
          pageFrom: 2,
          pageTo: 2,
          quote: "0.075",
        }),
      rotated.document.id,
    ),
  ).toEqual({ from: "scan", unsure: [] });
  await bridge.dispose();

  await openDocumentAt(window, {
    documentId: rotated.document.id,
    pageFrom: 2,
    pageTo: 2,
    quote: "0.075",
  });
  const viewer = window.getByTestId("viewer");
  const page = viewer.locator('[data-page-number="2"]');
  const highlight = page.locator("[data-quote-highlight]").filter({ hasText: "0.075" }).first();
  await expect(highlight).toBeVisible({ timeout: 30_000 });
  await expect(highlight).toBeInViewport();
  const anchor = current?.anchors.find((each) =>
    current.text.slice(each.start, each.end).includes("0.075"),
  );
  expect(anchor?.quad).toHaveLength(8);
  const pageBox = await page.boundingBox();
  const highlightBox = await highlight.boundingBox();
  expect(pageBox && highlightBox).toBeTruthy();
  if (anchor?.quad && pageBox && highlightBox) {
    const x = [0, 2, 4, 6].reduce((sum, at) => sum + (anchor.quad?.[at] ?? 0), 0) / 4;
    const y = [1, 3, 5, 7].reduce((sum, at) => sum + (anchor.quad?.[at] ?? 0), 0) / 4;
    const expected = { x: pageBox.x + x * pageBox.width, y: pageBox.y + y * pageBox.height };
    const actual = {
      x: highlightBox.x + highlightBox.width / 2,
      y: highlightBox.y + highlightBox.height / 2,
    };
    expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(4);
    expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(4);
  }
  const highlightEvidence = test.info().outputPath("rotated-page-highlight.png");
  await page.screenshot({ path: highlightEvidence });
  await test.info().attach("rotated-page-highlight", {
    path: highlightEvidence,
    contentType: "image/png",
  });

  const costs = [upright, rotated, ...generated].map((each) => ({
    document: each.document.name,
    pages: each.scanned.pages.length,
    milliseconds: each.milliseconds,
    millisecondsPerPage: Math.round(each.milliseconds / each.scanned.pages.length),
  }));
  console.log("Packaged rotated-scan ingestion cost", JSON.stringify(costs));
  const costEvidence = test.info().outputPath("orientation-cost.json");
  await writeFile(costEvidence, JSON.stringify(costs, null, 2));
  await test.info().attach("orientation-cost", {
    path: costEvidence,
    contentType: "application/json",
  });
  await app.close();
  app = undefined;
  await copyModelsOut(dataDir);
});
