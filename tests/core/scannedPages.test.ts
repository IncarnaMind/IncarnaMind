import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import {
  type Core,
  type CoreEvents,
  DATABASE_FILE,
  type Document,
  type RecognizedLine,
  type TextRecognizer,
} from "../../src/core";
import { SCAN_CURRENT_SINCE } from "../../src/core/documents/processing";
import { createFakeTextRecognizer, type FakeScanScript } from "../../src/core/documents/scan/fake";
import { BUILT_IN_TEXT_RECOGNITION_MODEL } from "../../src/core/documents/scan/model";
import { openDatabase } from "../../src/core/storage";
import { askAndFinish, citingModel, onlyCitation, setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, NO_MODEL_FILES, queryDatabase, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  sha256,
  waitForDocuments,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { buildPdf, pdfAppearance } from "../helpers/pdf";

const SCANS = join(import.meta.dirname, "../fixtures/scans");
const picture = (id: string) => readFileSync(join(SCANS, `${id}.jpg`));
const set = JSON.parse(readFileSync(join(SCANS, "set.json"), "utf8")) as {
  pages: { id: string; lines: string[] }[];
};
const linesOf = (id: string) => set.pages.find((page) => page.id === id)?.lines ?? [];

const READER = BUILT_IN_TEXT_RECOGNITION_MODEL.reader;

/** A recognizer reading what `script` says, counting the pages it reads. */
function countingRecognizer(script: FakeScanScript, fail: ReadonlySet<number> = new Set()) {
  const fake = createFakeTextRecognizer({ script });
  const read: number[] = [];
  const recognizer: TextRecognizer = {
    load: (files) => fake.load(files),
    async read(picture, page) {
      read.push(page);
      if (fail.has(page)) throw new Error("The model failed on this page.");
      return fake.read(picture, page);
    },
    readFile: (file, page) => fake.readFile(file, page),
    close: () => fake.close(),
  };
  return { recognizer, read };
}

const scanning = (recognizer: TextRecognizer) => ({
  textRecognizer: recognizer,
  textRecognitionModelSource: NO_MODEL_FILES,
});

/** The stored Units of a Document's current version. */
function unitsOf(dataDir: string, document: Document) {
  return queryDatabase<{
    page: number;
    text: string;
    label: string | null;
    anchors: string | null;
  }>(
    dataDir,
    `SELECT page, text, label, anchors FROM document_pages
     WHERE document_id = ? AND content_hash = ? AND deleted_at IS NULL ORDER BY page`,
    [document.id, document.contentHash],
  );
}

async function addPdf(core: Core, name: string, pdf: Uint8Array): Promise<Document> {
  const sources = await createSourceFolder();
  const [document] = await addAndProcess(core, [await writeSourceFile(sources, name, pdf)]);
  if (!document) throw new Error("The PDF wasn't added.");
  return document;
}

describe("Scanned pages are read on this computer (#397)", { timeout: 60_000 }, () => {
  test("a scanned PDF's pages are read, with their progress, and become searchable", async () => {
    const dataDir = await createTempDataFolder();
    const { recognizer, read } = countingRecognizer({
      pages: { 1: { lines: linesOf("en-clean") }, 2: { lines: linesOf("zh-clean") } },
    });
    const core = startCore(dataDir, scanning(recognizer));
    const progress: Document["scan"][] = [];
    core.on("document.status", (document) => {
      if (document.scan) progress.push(document.scan);
    });

    const document = await addPdf(
      core,
      "Lease scan.pdf",
      buildPdf([{ scan: picture("en-clean") }, { scan: picture("zh-clean") }]),
    );

    expect(document.status).toBe("ready");
    expect(read).toEqual([1, 2]);
    expect(progress).toContainEqual({ pages: 2, read: 0, of: "scanned-pages" });
    expect(progress).toContainEqual({ pages: 2, read: 1, of: "scanned-pages" });
    expect(progress.at(-1)).toEqual({ pages: 2, read: 2, of: "scanned-pages" });
    const [english] = await core.searchPassages("undisputed invoice", { mode: "keyword" });
    expect(english).toMatchObject({ documentId: document.id, pageFrom: 1 });
    const [chinese] = await core.searchPassages("押金", { mode: "keyword" });
    expect(chinese).toMatchObject({ documentId: document.id, pageFrom: 2 });

    // Each page records what read it, and each line where it is on the page.
    const units = unitsOf(dataDir, document);
    expect(units.map((unit) => JSON.parse(unit.label ?? "null"))).toEqual([
      { scan: { reader: READER } },
      { scan: { reader: READER } },
    ]);
    const scanned = await core.readScannedText(document.id);
    expect(scanned.pages.map((page) => page.page)).toEqual([1, 2]);
    const firstLine = scanned.pages[0]?.anchors[0];
    expect(firstLine).toMatchObject({ start: 0, target: "line1" });
    expect(scanned.pages[0]?.text.slice(firstLine?.start, firstLine?.end)).toBe(
      "MASTER SERVICES AGREEMENT",
    );
    expect(firstLine?.quad).toHaveLength(8);
  });

  test("a turned scanned page is laid out upright and anchored to its displayed page", async () => {
    const dataDir = await createTempDataFolder();
    const fake = createFakeTextRecognizer({
      script: {
        pages: {
          1: { lines: linesOf("en-clean") },
          2: {
            lines: [
              { text: "Glass beads", quad: [0.1, 0.1, 0.4, 0.1, 0.4, 0.12, 0.1, 0.12] },
              {
                text: "0.075 kg × 2 = 0.150 kg",
                quad: [0.5, 0.1, 0.9, 0.1, 0.9, 0.12, 0.5, 0.12],
              },
            ],
          },
        },
      },
    });
    const recognizer: TextRecognizer = {
      load: (files) => fake.load(files),
      async read(picture, page) {
        if (page === 2 && picture.width > picture.height) {
          return [
            {
              text: "N",
              quad: [
                [0, 0],
                [10, 0],
                [10, 100],
                [0, 100],
              ],
              confidence: 0.98,
              characters: [{ text: "N", confidence: 0.98, at: 0.5 }],
            },
          ];
        }
        return fake.read(picture, page);
      },
      readFile: (file, page) => fake.readFile(file, page),
      close: () => fake.close(),
    };
    const core = startCore(dataDir, scanning(recognizer));
    const document = await addPdf(
      core,
      "Turned worksheet.pdf",
      buildPdf([{ scan: picture("en-clean") }, { scan: picture("table"), rotation: 90 }]),
    );

    expect(document.status).toBe("ready");
    const scanned = await core.readScannedText(document.id);
    const turned = scanned.pages.find((page) => page.page === 2);
    expect(turned?.text).toBe("Glass beads\t0.075 kg × 2 = 0.150 kg");
    expect(turned?.label?.scan?.turn).toBe(270);
    expect(scanned.pages.find((page) => page.page === 1)?.label?.scan?.turn).toBeUndefined();
    const quantity = turned?.anchors.find((anchor) =>
      turned.text.slice(anchor.start, anchor.end).includes("0.075"),
    );
    const expected = [0.9, 0.5, 0.9, 0.9, 0.88, 0.9, 0.88, 0.5];
    for (const [index, value] of (quantity?.quad ?? []).entries()) {
      expect(value).toBeCloseTo(expected[index] ?? 0, 12);
    }
    expect(
      await core.readScannedQuote({
        documentId: document.id,
        contentHash: null,
        pageFrom: 2,
        pageTo: 2,
        quote: "0.075 kg × 2 = 0.150 kg",
      }),
    ).toEqual({ from: "scan", unsure: [] });
  });

  test("a mixed PDF keeps its text pages as they were, and reads only its scanned one", async () => {
    const dataDir = await createTempDataFolder();
    const { recognizer, read } = countingRecognizer({
      pages: { 2: { lines: linesOf("en-noisy") } },
    });
    const core = startCore(dataDir, scanning(recognizer));
    const text = { lines: ["Survey of the harbour", "The harbour floor is mostly sand."] };
    const document = await addPdf(
      core,
      "Survey.pdf",
      buildPdf([text, { scan: picture("en-noisy") }]),
    );

    expect(read).toEqual([2]);
    const units = unitsOf(dataDir, document);
    expect(units[0]).toEqual({
      page: 1,
      text: "Survey of the harbour\nThe harbour floor is mostly sand.",
      label: null,
      anchors: null,
    });
    expect(units[1]?.text).toContain("Mean water temperature rose to 9.4 degrees Celsius");
    expect(JSON.parse(units[1]?.label ?? "null")).toEqual({ scan: { reader: READER } });
    // A Citation of both pages says it was read from a scan only when it quotes the scanned one.
    const quoted = (quote: string) =>
      core.readScannedQuote({
        documentId: document.id,
        contentHash: null,
        pageFrom: 1,
        pageTo: 2,
        quote,
      });
    expect(await quoted("The harbour floor is mostly sand.")).toBeNull();
    expect(await quoted("Mean water temperature rose to 9.4 degrees Celsius")).toEqual({
      unsure: [],
      from: "scan",
    });

    // Without a model to read them, a scanned page is left as it was before.
    const plainDir = await createTempDataFolder();
    const plain = startCore(plainDir);
    const left = await addPdf(plain, "Survey.pdf", buildPdf([text, { scan: picture("en-noisy") }]));
    expect(unitsOf(plainDir, left).map((unit) => unit.text)).toEqual([units[0]?.text, ""]);
  });

  test("a scan with a stamp on it is read; a blank page and a small picture aren't", async () => {
    const dataDir = await createTempDataFolder();
    const { recognizer, read } = countingRecognizer({
      pages: { 1: { lines: linesOf("zh-noisy") } },
    });
    const core = startCore(dataDir, scanning(recognizer));
    const document = await addPdf(
      core,
      "Report.pdf",
      buildPdf([
        { lines: ["Received 12 March 2025"], scan: picture("zh-noisy") },
        {},
        { lines: ["Figure 2"], image: true },
      ]),
    );
    expect(read).toEqual([1]);
    const units = unitsOf(dataDir, document);
    expect(units[0]?.text).toContain("本月门店总客流量为十二万三千人次");
    expect(units.slice(1).map((unit) => [unit.text, unit.label])).toEqual([
      ["", null],
      ["Figure 2", null],
    ]);
  });

  test("the page numbers a scan prints, as the model read them, name its pages as a text PDF's are named", async () => {
    const dataDir = await createTempDataFolder();
    const { recognizer } = countingRecognizer({
      pages: {
        1: { lines: ["Harbour survey", "Annual report"] },
        2: { lines: ["Spring tides rose in March.", "1"] },
        3: { lines: ["Neap tides fell in April.", "2"] },
        4: { lines: ["Storm surges came in May.", "3"] },
      },
    });
    const core = startCore(dataDir, scanning(recognizer));

    const document = await addPdf(
      core,
      "Survey scan.pdf",
      buildPdf(Array.from({ length: 4 }, () => ({ scan: picture("en-clean") }))),
    );

    expect(unitsOf(dataDir, document).map((unit) => JSON.parse(unit.label ?? "null"))).toEqual([
      { scan: { reader: READER } },
      { scan: { reader: READER }, printed: "1" },
      { scan: { reader: READER }, printed: "2" },
      { scan: { reader: READER }, printed: "3" },
    ]);
  });

  test("a scan an older version found no text in is read at the next start", async () => {
    const dataDir = await createTempDataFolder();
    const before = startCore(dataDir);
    const document = await addPdf(before, "Lease.pdf", buildPdf([{ scan: picture("zh-clean") }]));
    expect(document.status).toBe("no-text");
    before.close();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE documents SET processing_version = ?", [BigInt(SCAN_CURRENT_SINCE - 1)]);
    } finally {
      db.close();
    }

    const { recognizer, read } = countingRecognizer({
      pages: { 1: { lines: linesOf("zh-clean") } },
    });
    const after = startCore(dataDir, scanning(recognizer));
    const [reread] = await waitForProcessing(after, [document.id]);
    expect(reread?.status).toBe("ready");
    expect(read).toEqual([1]);
    const [found] = await after.searchPassages("押金", { mode: "keyword" });
    expect(found).toMatchObject({ documentId: document.id, pageFrom: 1 });
  });

  test("a scanned page keeps its rows on the first read and on a re-read", async () => {
    const dataDir = await createTempDataFolder();
    const lines = ["华东 1,286 1,452", "月起配送费率调整", "华南 974 1,031"];
    const { recognizer } = countingRecognizer({ pages: { 1: { lines } } });
    const core = startCore(dataDir, scanning(recognizer));
    const document = await addPdf(core, "Rows.pdf", buildPdf([{ scan: picture("zh-clean") }]));
    const pageText = () => unitsOf(dataDir, document)[0]?.text ?? "";
    // A row ends in a digit and the next starts with a Han character: joining them would merge
    // the table's rows, so a scanned page keeps the line break.
    expect(pageText()).toContain("华东 1,286 1,452\n月起配送费率调整");
    core.close();

    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE documents SET processing_version = 15 WHERE id = ?", [document.id]);
    } finally {
      db.close();
    }
    const again = startCore(dataDir, scanning(recognizer));
    await waitForProcessing(again, [document.id]);
    expect(unitsOf(dataDir, document)[0]?.text ?? "").toContain(
      "华东 1,286 1,452\n月起配送费率调整",
    );
    again.close();
  });

  test("an Answer cites a scanned page, and the Citation check finds its quote", async () => {
    const quote = "Either party may terminate this Agreement for convenience";
    const model = citingModel({
      query: "terminate for convenience",
      records: (passages) => [
        {
          marker: 1,
          passage: passages[0]?.id ?? "",
          pageFrom: 1,
          pageTo: 1,
          quote,
        },
      ],
      answer: "Either party can end it on 90 days' notice [^1].",
    });
    const { recognizer } = countingRecognizer({
      pages: { 1: { lines: linesOf("en-clean"), unsure: ["convenience"] } },
    });
    const { core, client, mind, documents } = await setUpWithDocuments(
      model,
      [{ name: "Agreement.pdf", contents: buildPdf([{ scan: picture("en-clean") }]) }],
      scanning(recognizer),
    );
    const { answerId } = await askAndFinish(core, client, mind.id, "How can it be ended?");
    const citation = onlyCitation(client, answerId);
    expect(citation).toMatchObject({
      documentId: documents[0]?.id,
      pageFrom: 1,
      quote,
      check: "found",
    });
    // The card says it was read from a scan, and which of its words the reading wasn't sure of.
    expect(
      await core.readScannedQuote({
        documentId: citation.documentId as string,
        contentHash: citation.contentHash ?? null,
        pageFrom: 1,
        pageTo: 1,
        quote,
      }),
    ).toEqual({ unsure: ["convenience"], from: "scan" });
    expect(
      await core.readScannedQuote({
        documentId: citation.documentId as string,
        contentHash: citation.contentHash ?? null,
        pageFrom: 1,
        pageTo: 1,
        quote: "Business Days and certify the deletion",
      }),
    ).toEqual({ unsure: [], from: "scan" });
    // A quote that isn't on the page says nothing of the scan: the check says it wasn't found.
    expect(
      await core.readScannedQuote({
        documentId: citation.documentId as string,
        contentHash: citation.contentHash ?? null,
        pageFrom: 1,
        pageTo: 1,
        quote: "The tenant may keep a dog",
      }),
    ).toBeNull();
  });

  test("pages that couldn't be read are named, and Retry reads only them", async () => {
    const dataDir = await createTempDataFolder();
    const failing = new Set([2]);
    const { recognizer, read } = countingRecognizer(
      { pages: { 1: { lines: linesOf("en-clean") }, 2: { lines: linesOf("en-noisy") } } },
      failing,
    );
    const core = startCore(dataDir, scanning(recognizer));
    const pdf = buildPdf([{ scan: picture("en-clean") }, { scan: picture("en-noisy") }]);
    const document = await addPdf(core, "Two scans.pdf", pdf);

    expect(document.status).toBe("failed");
    expect(document.failure).toMatchObject({ reason: "pages-unread", pages: [2] });
    expect(document.failure?.message).toContain("The model failed on this page.");
    // The page that was read is searched meanwhile.
    expect(await core.searchPassages("undisputed invoice", { mode: "keyword" })).toHaveLength(1);

    failing.clear();
    read.length = 0;
    await core.retryDocument(document.id);
    const [retried] = await waitForProcessing(core, [document.id]);
    expect(retried?.status).toBe("ready");
    expect(retried?.failure).toBeNull();
    expect(read).toEqual([2]);
    const [found] = await core.searchPassages("oystercatchers", { mode: "keyword" });
    expect(found).toMatchObject({ documentId: document.id, pageFrom: 2 });
  });

  test("offline, the model can't be downloaded: its pages are named as unread, and none is tried after the first", async () => {
    const dataDir = await createTempDataFolder();
    const { recognizer, read } = countingRecognizer({ pages: { 1: { lines: ["Never read."] } } });
    const statuses: string[] = [];
    const core = startCore(dataDir, {
      textRecognizer: recognizer,
      // Nothing answers there, as when the computer is offline.
      textRecognitionModelSource: {
        baseUrl: "http://127.0.0.1:9/",
        files: [{ path: "model.onnx", size: 10, sha256: "0".repeat(64) }],
      },
    });
    core.on("textRecognitionModel.status", (status) => statuses.push(status.state));
    const document = await addPdf(
      core,
      "Offline scan.pdf",
      buildPdf([{ scan: picture("en-clean") }, { scan: picture("en-noisy") }]),
    );
    expect(document.status).toBe("failed");
    expect(document.failure).toMatchObject({ reason: "pages-unread", pages: [] });
    expect(document.failure?.message).toMatch(
      /Scanned pages 1, 2 couldn't be read: Couldn't reach/,
    );
    expect(read).toEqual([]);
    expect(statuses).toEqual(["downloading", "failed"]);
    expect((await core.getTextRecognitionModel()).error?.kind).toBe("network");
  });

  test.each([false, true])(
    "once the model downloads, unread pages recover automatically (unread forms: %s)",
    async (forms) => {
      const dataDir = await createTempDataFolder();
      const { recognizer, read } = countingRecognizer({
        pages: { 1: { lines: linesOf("en-clean") } },
      });
      // A file the model's source serves once it is back: its bytes, size and hash pinned.
      const bytes = Buffer.from("not really a model");
      let online = false;
      const server = createServer((_request, response) => {
        if (!online) {
          response.writeHead(503).end();
          return;
        }
        response.writeHead(200, { "content-length": bytes.length }).end(bytes);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
      const { port } = server.address() as AddressInfo;
      const core = startCore(dataDir, {
        textRecognizer: recognizer,
        textRecognitionModelSource: {
          baseUrl: `http://127.0.0.1:${port}/`,
          files: [{ path: "model.onnx", size: bytes.length, sha256: sha256(bytes) }],
        },
      });
      const document = await addPdf(
        core,
        "Waiting scan.pdf",
        buildPdf([
          {
            scan: picture("en-clean"),
            fields: forms
              ? [
                  {
                    dictionary:
                      "/FT /Foo /T (brokenChoice) /TU (Broken choice) /V (Fallback) /Rect [210 80 570 104] /F 4",
                    appearance: pdfAppearance("Fallback"),
                  },
                ]
              : undefined,
          },
        ]),
      );
      expect(document.failure?.reason).toBe(forms ? "forms-unread" : "pages-unread");
      if (forms) {
        expect(document.failure?.message).toContain("Some PDF form fields");
        expect(document.failure?.message).toContain("Scanned page 1 couldn't be read");
      }
      expect(read).toEqual([]);

      online = true;
      await core.downloadTextRecognitionModel();
      const [ready] = await waitForDocuments(core, (documents) => {
        expect(read).toEqual([1]);
        expect(documents[0]).toMatchObject(
          forms
            ? { status: "failed", failure: { reason: "forms-unread" } }
            : { status: "ready", failure: null },
        );
      });
      expect(ready?.id).toBe(document.id);
      expect(read).toEqual([1]);
      expect((await core.readScannedText(document.id)).pages[0]?.text).toContain(
        "MASTER SERVICES AGREEMENT",
      );
    },
  );

  test("re-reading after a reader's upgrade keeps the pages a Citation quotes as they were read", async () => {
    const quote = "Either party may terminate this Agreement for convenience";
    const model = citingModel({
      query: "terminate",
      records: (passages) => [
        { marker: 1, passage: passages[0]?.id ?? "", pageFrom: 1, pageTo: 1, quote },
      ],
      answer: "It can be ended [^1].",
    });
    const first = countingRecognizer({
      pages: { 1: { lines: linesOf("en-clean") }, 2: { lines: linesOf("en-noisy") } },
    });
    const pdf = buildPdf([{ scan: picture("en-clean") }, { scan: picture("en-noisy") }]);
    const { core, client, mind, dataDir, documents } = await setUpWithDocuments(
      model,
      [{ name: "Agreement.pdf", contents: pdf }],
      scanning(first.recognizer),
    );
    const document = documents[0] as Document;
    const { answerId } = await askAndFinish(core, client, mind.id, "Can it be ended?");
    expect(onlyCitation(client, answerId).check).toBe("found");
    await client.settled();
    core.close();

    // As an older reader would have left it: its pages read by "PP-OCRv4 mobile/1".
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run(
        `UPDATE document_pages SET label = json_set(label, '$.scan.reader', 'PP-OCRv4 mobile/1')
         WHERE document_id = ?`,
        [document.id],
      );
      db.run("UPDATE documents SET processing_version = ? WHERE id = ?", [
        BigInt(SCAN_CURRENT_SINCE - 1),
        document.id,
      ]);
    } finally {
      db.close();
    }
    // The new reader reads both pages differently.
    const upgraded = countingRecognizer({
      pages: {
        1: { lines: linesOf("en-clean").map((line) => line.replaceAll("Agreement", "Agreernent")) },
        2: { lines: linesOf("en-noisy").map((line) => line.replaceAll("estuary", "estuarine")) },
      },
    });
    const restarted = startCore(dataDir, {
      ...scanning(upgraded.recognizer),
      createChatModel: () => {
        throw new Error("No Answers here.");
      },
    });
    const [reread] = await waitForProcessing(restarted, [document.id]);
    expect(reread?.status).toBe("ready");
    // Page 1, which the Citation quotes, is kept as the older reader read it; page 2 is read again.
    expect(upgraded.read).toEqual([2]);
    const units = unitsOf(dataDir, reread as Document);
    expect(units[0]?.text).toContain(quote);
    expect(JSON.parse(units[0]?.label ?? "{}").scan.reader).toBe("PP-OCRv4 mobile/1");
    expect(units[1]?.text).toContain("northern estuarine");
    expect(JSON.parse(units[1]?.label ?? "{}").scan.reader).toBe(READER);
    const recheck = await restarted.recheckCitation({
      mindId: null,
      documentId: document.id,
      quote,
      pageFrom: 1,
      pageTo: 1,
    });
    expect(recheck.check).toBe("found");
  });

  test("pausing a Linked folder stops reading its scan, and resuming goes on from where it stopped", async () => {
    const dataDir = await createTempDataFolder();
    const pages = [1, 2, 3, 4].map((page) => [page, { lines: [`Page ${page} of the minutes.`] }]);
    const fake = createFakeTextRecognizer({
      script: { pages: Object.fromEntries(pages) },
      delayMs: 150,
    });
    const read: number[] = [];
    const recognizer: TextRecognizer = {
      load: (files) => fake.load(files),
      read: (picture, page): Promise<RecognizedLine[]> => {
        read.push(page);
        return fake.read(picture, page);
      },
      readFile: (file, page) => fake.readFile(file, page),
      close: () => fake.close(),
    };
    const core = startCore(dataDir, scanning(recognizer));
    const folder = await createSourceFolder();
    const scan = { scan: picture("table") };
    await writeSourceFile(folder, "Minutes.pdf", buildPdf([scan, scan, scan, scan]));
    const linked = await core.addLinkedFolder(folder);
    const midway = new Promise<void>((resolve) => {
      const stop = core.on("document.status", (document: CoreEvents["document.status"]) => {
        if ((document.scan?.read ?? 0) >= 2) {
          stop();
          resolve();
        }
      });
    });
    await midway;
    await core.setLinkedFolderPaused(linked.id, true);
    const readWhenPaused = read.length;
    // The processor takes one job at a time, in the order queued: once a Document added now is
    // ready, the scan has stopped, or would have read all its pages.
    await addAndProcess(core, [
      await writeSourceFile(await createSourceFolder(), "Control.md", "Nothing to do with it."),
    ]);
    // At most the page under way when it was paused is read after.
    expect(read.length).toBeLessThanOrEqual(readWhenPaused + 1);

    await core.setLinkedFolderPaused(linked.id, false);
    const document = (await core.listDocuments()).find((each) => each.name === "Minutes");
    const [done] = await waitForProcessing(core, [document?.id as string]);
    expect(done?.status).toBe("ready");
    // The pages read before the pause weren't read again; only the one under way could be.
    expect(new Set(read)).toEqual(new Set([1, 2, 3, 4]));
    expect(read.filter((page) => page <= 2)).toEqual([1, 2]);
  });
});

describe("Pages read before a quit or a crash are kept (#1504)", { timeout: 60_000 }, () => {
  const PAGES = [1, 2, 3, 4];
  const script: FakeScanScript = {
    pages: Object.fromEntries(
      PAGES.map((page) => [page, { lines: [`Page ${page} of the lease.`] }]),
    ),
  };

  /**
   * A recognizer that reads up to `stopAfter` pages, then holds the next until the test ends;
   * with `fromPage`, it holds every scan's pages from that one on instead.
   */
  function recognizerHolding(stopAfter: number, fromPage = Number.POSITIVE_INFINITY) {
    const fake = createFakeTextRecognizer({ script });
    const read: number[] = [];
    const recognizer: TextRecognizer = {
      load: (files) => fake.load(files),
      read: async (picture, page): Promise<RecognizedLine[]> => {
        read.push(page);
        if (read.length > stopAfter || page >= fromPage) await new Promise(() => {});
        return fake.read(picture, page);
      },
      readFile: (file, page) => fake.readFile(file, page),
      close: () => fake.close(),
    };
    return { recognizer, read };
  }

  /** Adds a four-page scan and quits, in good order, once `pages` of it are read. */
  async function quitMidway(dataDir: string, pages: number) {
    const first = recognizerHolding(pages);
    const core = startCore(dataDir, scanning(first.recognizer));
    const sources = await createSourceFolder();
    const file = await writeSourceFile(
      sources,
      "Lease scan.pdf",
      buildPdf(PAGES.map(() => ({ scan: picture("en-clean") }))),
    );
    const {
      documents: [document],
    } = await core.addDocuments([file]);
    if (!document) throw new Error("The scan wasn't added.");
    await waitForDocuments(core, (documents) => {
      const scan = documents.find((each) => each.id === document.id)?.scan;
      expect(scan?.read).toBe(pages);
    });
    core.close();
    return { document, file, firstRead: first.read };
  }

  const liveUnits = (dataDir: string, id: string) =>
    queryDatabase<{ page: number; text: string }>(
      dataDir,
      `SELECT page, text FROM document_pages WHERE document_id = ? AND deleted_at IS NULL ORDER BY page`,
      [id],
    );

  // protects=after a quit mid-scan, the next start goes on from the first unread page, and no page is read twice or stored twice; fails_when=it starts again from page 1, or a page is doubled; no_claim=the page under way at the quit, which is read again.
  test("after a quit, the scan goes on from the first unread page", async () => {
    const dataDir = await createTempDataFolder();
    const { document } = await quitMidway(dataDir, 2);

    const second = countingRecognizer(script);
    const core = startCore(dataDir, scanning(second.recognizer));
    try {
      const [ready] = await waitForProcessing(core, [document.id]);
      expect(ready?.status).toBe("ready");
      expect(second.read).toEqual([3, 4]);
      expect(liveUnits(dataDir, document.id).map((unit) => unit.page)).toEqual(PAGES);
      expect(liveUnits(dataDir, document.id).map((unit) => unit.text)).toEqual(
        PAGES.map((page) => `Page ${page} of the lease.`),
      );
      expect(
        await core.searchPassages("Page 1 of the lease", { mode: "keyword" }),
      ).not.toHaveLength(0);
    } finally {
      core.close();
    }
  });

  // protects=after a crash mid-scan, the Document says the app stopped while it was read, and Retry reads only the pages not yet read; fails_when=Retry starts from page 1; no_claim=why the app stopped.
  test("after a crash, the Document says why, and Retry reads only what wasn't read", async () => {
    const dataDir = await createTempDataFolder();
    const { document } = await quitMidway(dataDir, 3);
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE documents SET status = 'extracting' WHERE id = ?", [document.id]);
    } finally {
      db.close();
    }

    const second = countingRecognizer(script);
    const core = startCore(dataDir, scanning(second.recognizer));
    try {
      const stopped = (await core.listDocuments()).find((each) => each.id === document.id);
      expect(stopped).toMatchObject({ status: "failed", failure: { reason: "app-stopped" } });
      await core.retryDocument(document.id);
      const [ready] = await waitForProcessing(core, [document.id]);
      expect(ready?.status).toBe("ready");
      expect(second.read).toEqual([4]);
      expect(liveUnits(dataDir, document.id).map((unit) => unit.page)).toEqual(PAGES);
    } finally {
      core.close();
    }
  });

  // protects=pages read of a version the file no longer is are never used for the new one; fails_when=the new version keeps the old version's pages; no_claim=none beyond protects.
  test("a file changed after the quit is read from its first page", async () => {
    const dataDir = await createTempDataFolder();
    const { document, file } = await quitMidway(dataDir, 2);
    await writeFile(file, buildPdf(PAGES.map(() => ({ scan: picture("zh-clean") }))));

    const second = countingRecognizer(script);
    const core = startCore(dataDir, scanning(second.recognizer));
    try {
      const [ready] = await waitForProcessing(core, [document.id]);
      expect(ready?.status).toBe("ready");
      // Each page of the new version is read: none is kept from the old one. The start reads
      // the file as found, and its check for changed files may read the first page again.
      expect(new Set(second.read)).toEqual(new Set(PAGES));
      expect(unitsOf(dataDir, ready as Document).map((unit) => unit.page)).toEqual(PAGES);
    } finally {
      core.close();
    }
  });

  // protects=with two scans read at once (#1502's lane), a quit or a crash keeps each scan's own pages: the next read of each reads only what it hadn't, and neither takes the other's; fails_when=a scan starts again from page 1, reads a page twice, or keeps a page of the other; no_claim=the pages under way at the quit, which are read again.
  test.each([["quit"], ["crash"]])(
    "two scans read at once each keep their own pages after a %s",
    async (how) => {
      const dataDir = await createTempDataFolder();
      // Each scan reads its first two pages, then waits at its third.
      const first = recognizerHolding(Number.POSITIVE_INFINITY, 3);
      const core = startCore(dataDir, { ...scanning(first.recognizer), scansAtOnce: 2 });
      const sources = await createSourceFolder();
      const files = [];
      for (const name of ["Lease A.pdf", "Lease B.pdf"]) {
        files.push(
          await writeSourceFile(
            sources,
            name,
            buildPdf(PAGES.map(() => ({ scan: picture("en-clean") }))),
          ),
        );
      }
      // Two versions, so neither file is a copy of the other.
      await writeFile(
        files[1] as string,
        buildPdf(PAGES.map(() => ({ scan: picture("zh-clean") }))),
      );
      const { documents: added } = await core.addDocuments(files);
      const ids = added.map((document) => document.id);
      await waitForDocuments(core, (documents) => {
        const reading = documents.filter((each) => ids.includes(each.id));
        expect(reading.map((each) => each.status)).toEqual(["extracting", "extracting"]);
        expect(reading.reduce((sum, each) => sum + (each.scan?.read ?? 0), 0)).toBe(4);
      });
      const keptBefore = ids.map((id) => liveUnits(dataDir, id).length);
      expect(keptBefore.reduce((sum, count) => sum + count, 0)).toBe(4);
      core.close();
      if (how === "crash") {
        const db = openDatabase(join(dataDir, DATABASE_FILE));
        try {
          for (const id of ids)
            db.run("UPDATE documents SET status = 'extracting' WHERE id = ?", [id]);
        } finally {
          db.close();
        }
      }

      const second = countingRecognizer(script);
      const again = startCore(dataDir, { ...scanning(second.recognizer), scansAtOnce: 2 });
      try {
        if (how === "crash") {
          for (const each of await again.listDocuments()) {
            if (ids.includes(each.id)) {
              expect(each).toMatchObject({ status: "failed", failure: { reason: "app-stopped" } });
              await again.retryDocument(each.id);
            }
          }
        }
        const ready = await waitForProcessing(again, ids);
        expect(ready.map((each) => each.status)).toEqual(["ready", "ready"]);
        // Only what neither had read: each scan's own pages were kept for it.
        expect(second.read).toHaveLength(8 - 4);
        for (const document of ready) {
          expect(unitsOf(dataDir, document).map((unit) => unit.page)).toEqual(PAGES);
        }
      } finally {
        again.close();
      }
    },
  );
});
