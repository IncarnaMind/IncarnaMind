/**
 * A saved web page's pictures are read on this computer (#756), saying how
 * far it is: a chart's text is found by search, cited as "§ Results, figure
 * 1" and checked against what was read, and its card says it was read from a
 * picture. A picture that can't be read keeps its description alone.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, test } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import type { TextRecognizer } from "../../src/core/adapters";
import type { Document } from "../../src/core/api";
import { PROCESSING_VERSION } from "../../src/core/documents/processing";
import { createFakeTextRecognizer } from "../../src/core/documents/scan/fake";
import { BUILT_IN_TEXT_RECOGNITION_MODEL } from "../../src/core/documents/scan/model";
import { openDatabase } from "../../src/core/storage";
import { translate } from "../../src/shared/i18n";
import { formatLocation } from "../../src/shared/locations";
import type { UnitLabel } from "../../src/shared/units";
import { askAndFinish, citingModel, onlyCitation, setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, NO_MODEL_FILES, queryDatabase, startCore } from "../helpers/core";
import { waitForDocuments, waitForProcessing } from "../helpers/documents";
import { startWeb } from "../helpers/web";

const REPORT = readFileSync(new URL("../fixtures/web/report.html", import.meta.url));
const ARTICLE = readFileSync(new URL("../fixtures/web/article.html", import.meta.url));

const png = (width: number, height: number) => createCanvas(width, height).toBuffer("image/png");

const CHART_LINES = ["Revenue by quarter", "Q1 2026 41.2", "Q2 2026 44.9"];

/** Reads the chart's lines from the first picture; the second one fails, as a model can. */
function recognizer(): TextRecognizer {
  const fake = createFakeTextRecognizer({
    script: { pages: { "1": { lines: CHART_LINES, unsure: ["44.9"] } } },
  });
  return {
    load: (files) => fake.load(files),
    read: (picture, page) => fake.read(picture, page),
    async readFile(file, page) {
      if (page === 2) throw new Error("The model failed on this picture.");
      return fake.readFile(file, page);
    },
    close: () => fake.close(),
  };
}

async function startSite() {
  const served = (body: Buffer) => () => ({
    status: 200,
    headers: { "Content-Type": "image/png" },
    body,
  });
  return startWeb({
    "/report": () => ({ status: 200, body: REPORT }),
    "/article": () => ({ status: 200, body: ARTICLE }),
    "/charts/revenue.png": served(png(400, 300)),
    "/harbour/berth.jpg": served(png(640, 480)),
  });
}

describe("A web page's pictures, read", { timeout: 30_000 }, () => {
  test("a chart's text is found, cited as its section and figure and checked, its card saying it was read from a picture", async () => {
    const web = await startSite();
    const { core, client, mind, dataDir } = await setUpWithDocuments(
      citingModel({
        query: "revenue second quarter",
        records: (passages) => [{ marker: 1, passage: passages[0]?.id, quote: "Q2 2026 44.9" }],
        answer: "Revenue reached 44.9 in the second quarter [^1].",
      }),
      [],
      {
        ...web.adapters,
        textRecognizer: recognizer(),
        textRecognitionModelSource: NO_MODEL_FILES,
      },
    );
    const progress: Document["scan"][] = [];
    core.on("document.status", (document) => {
      if (document.scan) progress.push(document.scan);
    });
    const result = await core.saveWebPage({ address: `http://127.0.0.1:${web.port}/report` });
    if (result.outcome !== "saved") throw new Error(JSON.stringify(result));
    const [page] = await waitForProcessing(core, [result.document.id]);
    if (!page) throw new Error("It went.");
    expect(progress).toContainEqual({ pages: 2, read: 0, of: "pictures" });
    expect(progress.at(-1)).toEqual({ pages: 2, read: 2, of: "pictures" });

    // The chart's text is in its section, after its description, each line where it is on the picture.
    const units = queryDatabase<{ text: string; label: string; anchors: string }>(
      dataDir,
      `SELECT text, label, anchors FROM document_pages
       WHERE document_id = ? AND content_hash = ? AND deleted_at IS NULL ORDER BY page`,
      [page.id, page.contentHash],
    );
    const results = units.find((unit) => unit.text.startsWith("Results"));
    expect(results?.text).toContain(`Revenue by quarter\n${CHART_LINES.join("\n")}`);
    const label = JSON.parse(results?.label ?? "null") as UnitLabel;
    expect(label.figures).toEqual([
      {
        number: 1,
        reader: BUILT_IN_TEXT_RECOGNITION_MODEL.reader,
        unsure: [expect.any(Array)],
      },
    ]);
    const anchors = JSON.parse(results?.anchors ?? "[]") as { target: string; quad?: number[] }[];
    expect(anchors.map((anchor) => anchor.target)).toEqual(
      expect.arrayContaining(["figure1", "figure1.line1", "figure1.line3", "figure2"]),
    );
    expect(anchors.find((anchor) => anchor.target === "figure1.line1")?.quad).toHaveLength(8);
    // The berth's picture couldn't be read: its description alone, and not said to be read.
    expect(results?.text).toContain("The new deep-water berth at dawn");
    expect(anchors.some((anchor) => anchor.target.startsWith("figure2.line"))).toBe(false);

    expect(await core.searchPassages("44.9", { mode: "keyword" })).toHaveLength(1);

    const { answerId } = await askAndFinish(core, client, mind.id, "What was revenue in Q2?");
    const citation = onlyCitation(client, answerId);
    expect(citation).toMatchObject({
      documentId: page.id,
      location: { kind: "section", heading: "Results", figure: 1 },
      quote: "Q2 2026 44.9",
      check: "found",
    });
    const wording = (language: "en" | "zh-CN") =>
      formatLocation(citation.location ?? { kind: "section", heading: null }, (key, params) =>
        translate(language, key, params),
      );
    expect(wording("en")).toBe("§ Results, figure 1");
    expect(wording("zh-CN")).toBe("§ Results，图 1");
    expect(
      await core.readScannedQuote({
        documentId: citation.documentId as string,
        contentHash: citation.contentHash ?? null,
        pageFrom: citation.pageFrom ?? null,
        pageTo: citation.pageTo ?? null,
        quote: citation.quote ?? "",
      }),
    ).toEqual({ unsure: ["44.9"], from: "picture" });
  });

  test("a page saved with pictures before they were read has them read once, at startup, and a page without any isn't processed again", async () => {
    const web = await startSite();
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir, web.adapters);
    const saved = async (path: string) => {
      const result = await first.saveWebPage({ address: `http://127.0.0.1:${web.port}${path}` });
      if (result.outcome !== "saved") throw new Error(JSON.stringify(result));
      return result.document.id;
    };
    const report = await saved("/report");
    const article = await saved("/article");
    await waitForProcessing(first, [report, article]);
    first.close();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE documents SET processing_version = 9");
      // The page without pictures isn't the subject: it stays as this version built it.
      db.run("UPDATE documents SET processing_version = ? WHERE id = ?", [
        BigInt(PROCESSING_VERSION),
        article,
      ]);
    } finally {
      db.close();
    }

    const second = startCore(dataDir, {
      ...web.adapters,
      textRecognizer: recognizer(),
      textRecognitionModelSource: NO_MODEL_FILES,
    });
    const statuses = Object.fromEntries(
      (await second.listDocuments()).map((document) => [document.id, document.status]),
    );
    expect(statuses).toEqual({ [report]: "queued", [article]: "ready" });
    await waitForProcessing(second, [report]);
    expect(await second.searchPassages("44.9", { mode: "keyword" })).toHaveLength(1);
    second.close();

    const third = startCore(dataDir, {
      ...web.adapters,
      textRecognizer: recognizer(),
      textRecognitionModelSource: NO_MODEL_FILES,
    });
    expect((await third.listDocuments()).every((document) => document.status === "ready")).toBe(
      true,
    );
    third.close();
  });

  test("a page whose pictures are being read when the app quits in good order is read again at the next start", async () => {
    const web = await startSite();
    const dataDir = await createTempDataFolder();
    const slow = createFakeTextRecognizer({
      script: { pages: { "1": { lines: CHART_LINES } } },
      delayMs: 5_000,
    });
    const core = startCore(dataDir, {
      ...web.adapters,
      textRecognizer: slow,
      textRecognitionModelSource: NO_MODEL_FILES,
    });
    const result = await core.saveWebPage({ address: `http://127.0.0.1:${web.port}/report` });
    if (result.outcome !== "saved") throw new Error(JSON.stringify(result));
    await waitForDocuments(core, (documents) => {
      expect(documents.find((each) => each.id === result.document.id)?.status).toBe("extracting");
    });
    core.close();
    expect(
      queryDatabase(dataDir, "SELECT status FROM documents WHERE id = ?", [result.document.id]),
    ).toEqual([{ status: "queued" }]);

    const again = startCore(dataDir, {
      ...web.adapters,
      textRecognizer: recognizer(),
      textRecognitionModelSource: NO_MODEL_FILES,
    });
    const [page] = await waitForProcessing(again, [result.document.id]);
    expect(page?.failure).toBeNull();
    expect(await again.searchPassages("44.9", { mode: "keyword" })).toHaveLength(1);
    again.close();
  });
});
