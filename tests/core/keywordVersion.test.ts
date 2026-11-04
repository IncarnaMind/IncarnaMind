/**
 * A Document's keyword rows carry a version of their own, and a rewrite that
 * reads no file never moves the version its Passages were read at (#2185): a
 * Document whose file is missing at start keeps that version, so it is read
 * again once the file is back, and its rows are rebuilt from the Passages the
 * read makes.
 */
import { readFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, test, vi } from "vitest";
import { DATABASE_FILE, type Document } from "../../src/core";
import type { TextRecognizer } from "../../src/core/adapters";
import { keywordText } from "../../src/core/documents/keywords";
import { PROCESSING_VERSION } from "../../src/core/documents/processing";
import { createFakeTextRecognizer } from "../../src/core/documents/scan/fake";
import { openDatabase } from "../../src/core/storage";
import { createTempDataFolder, NO_MODEL_FILES, queryDatabase, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  unfoldedKeywords,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { createControlledEmbedder, turnOnEmbeddings } from "../helpers/embedding";
import { docxOf, xlsxOf } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";
import { startWeb } from "../helpers/web";

/** A Word comment, which processing version 6 didn't read. */
const FINANCE = "Finance has asked to lower the contingency to 8 per cent.";

const CHART_LINES = ["Revenue by quarter", "Q1 2026 41.2", "Q2 2026 44.9"];

const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nWe hired two engineers.\n";

const png = (width: number, height: number) => createCanvas(width, height).toBuffer("image/png");

/** Reads the chart's lines from the page's first picture, as a model can. */
function recognizer(): TextRecognizer {
  return createFakeTextRecognizer({ script: { pages: { "1": { lines: CHART_LINES } } } });
}

async function startSite() {
  const served = (body: Buffer) => () => ({
    status: 200,
    headers: { "Content-Type": "image/png" },
    body,
  });
  return startWeb({
    "/report": () => ({
      status: 200,
      body: readFileSync(new URL("../fixtures/web/report.html", import.meta.url)),
    }),
    "/article": () => ({
      status: 200,
      body: readFileSync(new URL("../fixtures/web/article.html", import.meta.url)),
    }),
    "/charts/revenue.png": served(png(400, 300)),
    "/harbour/berth.jpg": served(png(640, 480)),
  });
}

/**
 * Takes a Document back to an older pipeline: its read version and keyword
 * version, the text its Passages held then, and keyword rows built then,
 * holding the Document's name in every one.
 */
function asOlderPipeline(
  dataDir: string,
  document: Document,
  version: number,
  read: (text: string) => string = (text) => text,
): void {
  const at = "2026-10-01T09:00:00.000Z";
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    db.transaction(() => {
      db.run("UPDATE documents SET processing_version = ?, keywords_version = 0 WHERE id = ?", [
        BigInt(version),
        document.id,
      ]);
      for (const { seq, text } of db.all<{ seq: number; text: string }>(
        "SELECT seq, text FROM passages WHERE document_id = ? AND deleted_at IS NULL",
        [document.id],
      )) {
        const older = read(text);
        db.run("DELETE FROM passages_fts WHERE rowid = ?", [BigInt(seq)]);
        db.run("UPDATE passages SET text = ?, updated_at = ? WHERE seq = ?", [
          older,
          at,
          BigInt(seq),
        ]);
        db.run("INSERT INTO passages_fts (rowid, text) VALUES (?, ?)", [
          BigInt(seq),
          `${unfoldedKeywords(document.name)} ${unfoldedKeywords(older)}`,
        ]);
      }
    });
  } finally {
    db.close();
  }
}

/** A Document's read version, and the version its keyword rows are. */
function versions(dataDir: string, id: string) {
  const [row] = queryDatabase<{ processing_version: number; keywords_version: number }>(
    dataDir,
    "SELECT processing_version, keywords_version FROM documents WHERE id = ?",
    [id],
  );
  return row;
}

/** How many keyword rows hold a word. */
function rowsWith(dataDir: string, word: string): number {
  const [row] = queryDatabase<{ n: number }>(
    dataDir,
    "SELECT count(*) AS n FROM passages_fts WHERE passages_fts MATCH ?",
    [`"${keywordText(word)}"`],
  );
  return row?.n ?? 0;
}

/** How many Documents' name rows hold a word. */
function namesWith(dataDir: string, word: string): number {
  const [row] = queryDatabase<{ n: number }>(
    dataDir,
    "SELECT count(*) AS n FROM document_names_fts WHERE document_names_fts MATCH ?",
    [`"${keywordText(word)}"`],
  );
  return row?.n ?? 0;
}

describe("A Document's keyword version", { timeout: 60_000 }, () => {
  test("a Word file read before version 7 keeps its version while its file is away, and its comment is found once it is back", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const path = await writeSourceFile(
      sources,
      "Library.docx",
      docxOf([
        { text: "Costs", heading: 1 },
        {
          text: "A contingency of 10 per cent is held.",
          comment: { text: FINANCE, author: "Reviewer" },
        },
      ]),
    );
    const first = startCore(dataDir);
    const [word] = (await addAndProcess(first, [path])) as [Document];
    first.close();
    // As version 6 left it: the comment wasn't read, and the rows hold the name.
    asOlderPipeline(dataDir, word, 6, (text) => text.replace(`\n\n${FINANCE}`, ""));
    expect(rowsWith(dataDir, "finance")).toBe(0);
    expect(rowsWith(dataDir, "library")).toBeGreaterThan(0);

    await rename(path, `${path}.away`);
    const second = startCore(dataDir);
    await waitForProcessing(second, [word.id]);
    second.upgradeKeywordIndex();
    await vi.waitFor(() => expect(rowsWith(dataDir, "library")).toBe(0), { timeout: 30_000 });
    expect(namesWith(dataDir, "library")).toBe(1);
    // The rows are this version's; the Passages, and what the next start reads them for, are not.
    expect(versions(dataDir, word.id)).toEqual({
      processing_version: 6,
      keywords_version: PROCESSING_VERSION,
    });
    second.close();

    await rename(`${path}.away`, path);
    const third = startCore(dataDir);
    await waitForProcessing(third, [word.id]);
    const found = await third.searchPassages("finance", { mode: "keyword" });
    expect(found.map((row) => row.documentId)).toEqual([word.id]);
    expect(found[0]?.text).toContain(FINANCE);
    expect(versions(dataDir, word.id)).toEqual({
      processing_version: PROCESSING_VERSION,
      keywords_version: PROCESSING_VERSION,
    });
    third.close();
  });

  test("a workbook read before version 13 keeps its version while its file is away, and its words are found once it is back", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const path = await writeSourceFile(
      sources,
      "Budget.xlsx",
      xlsxOf([{ name: "Revenue", rows: [["Region"], ["North"]] }]),
    );
    const first = startCore(dataDir);
    const [book] = (await addAndProcess(first, [path])) as [Document];
    first.close();
    // As version 12 left it: what a workbook that version read says instead.
    asOlderPipeline(dataDir, book, 12, () => "Superseded wording");
    expect(rowsWith(dataDir, "north")).toBe(0);
    expect(rowsWith(dataDir, "budget")).toBeGreaterThan(0);

    await rename(path, `${path}.away`);
    const second = startCore(dataDir);
    await waitForProcessing(second, [book.id]);
    second.upgradeKeywordIndex();
    await vi.waitFor(() => expect(rowsWith(dataDir, "budget")).toBe(0), { timeout: 30_000 });
    expect(versions(dataDir, book.id)).toEqual({
      processing_version: 12,
      keywords_version: PROCESSING_VERSION,
    });
    second.close();

    await rename(`${path}.away`, path);
    const third = startCore(dataDir);
    await waitForProcessing(third, [book.id]);
    const found = await third.searchPassages("north", { mode: "keyword" });
    expect(found.map((row) => row.documentId)).toEqual([book.id]);
    expect(versions(dataDir, book.id)).toEqual({
      processing_version: PROCESSING_VERSION,
      keywords_version: PROCESSING_VERSION,
    });
    third.close();
  });

  test("a web page and a transcript read before version 7 keep their versions while their files are away, and their words are found once they are back", async () => {
    const web = await startSite();
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const vttPath = await writeSourceFile(sources, "Standup.vtt", VTT);
    const first = startCore(dataDir, web.adapters);
    const [transcript] = (await addAndProcess(first, [vttPath])) as [Document];
    const saved = await first.saveWebPage({ address: `http://127.0.0.1:${web.port}/article` });
    if (saved.outcome !== "saved") throw new Error(JSON.stringify(saved));
    const page = saved.document;
    await waitForProcessing(first, [page.id]);
    first.close();
    // As version 6 left them: the text an older pipeline read instead.
    asOlderPipeline(dataDir, transcript, 6, () => "Superseded wording");
    asOlderPipeline(dataDir, page, 6, () => "Superseded wording");
    expect(rowsWith(dataDir, "engineers")).toBe(0);
    expect(rowsWith(dataDir, "caffeine")).toBe(0);

    const pagePath = page.path;
    await rename(vttPath, `${vttPath}.away`);
    await rename(pagePath, `${pagePath}.away`);
    const second = startCore(dataDir, web.adapters);
    await waitForProcessing(second, [transcript.id, page.id]);
    second.upgradeKeywordIndex();
    await vi.waitFor(() => expect(rowsWith(dataDir, "standup")).toBe(0), { timeout: 30_000 });
    for (const id of [transcript.id, page.id]) {
      expect(versions(dataDir, id)).toEqual({
        processing_version: 6,
        keywords_version: PROCESSING_VERSION,
      });
    }
    second.close();

    await rename(`${vttPath}.away`, vttPath);
    await rename(`${pagePath}.away`, pagePath);
    const third = startCore(dataDir, web.adapters);
    await waitForProcessing(third, [transcript.id, page.id]);
    const engineers = await third.searchPassages("engineers", { mode: "keyword" });
    expect(engineers.map((row) => row.documentId)).toEqual([transcript.id]);
    const caffeine = await third.searchPassages("caffeine", { mode: "keyword" });
    expect(caffeine.map((row) => row.documentId)).toEqual([page.id]);
    third.close();
  });

  test("a page saved with pictures before version 10 keeps its version while its file is away, and the chart's text is found once it is back", async () => {
    const web = await startSite();
    const dataDir = await createTempDataFolder();
    const withPictures = {
      ...web.adapters,
      textRecognizer: recognizer(),
      textRecognitionModelSource: NO_MODEL_FILES,
    };
    const first = startCore(dataDir, withPictures);
    const result = await first.saveWebPage({ address: `http://127.0.0.1:${web.port}/report` });
    if (result.outcome !== "saved") throw new Error(JSON.stringify(result));
    const page = result.document;
    await waitForProcessing(first, [page.id]);
    first.close();
    // As version 9 left it: the pictures weren't read into its sections.
    asOlderPipeline(dataDir, page, 9, (text) =>
      text
        .split("\n")
        .filter((line) => !CHART_LINES.includes(line))
        .join("\n"),
    );

    // The file is away, and no model can read its pictures yet: nothing reads the page, and the
    // rewrite that runs anyway must not say it was read.
    const pagePath = page.path;
    await rename(pagePath, `${pagePath}.away`);
    const second = startCore(dataDir, web.adapters);
    expect((await second.listDocuments())[0]?.status).toBe("ready");
    second.upgradeKeywordIndex();
    await vi.waitFor(
      () =>
        expect(versions(dataDir, page.id)).toEqual({
          processing_version: 9,
          keywords_version: PROCESSING_VERSION,
        }),
      { timeout: 30_000 },
    );
    second.close();

    // The file is back, and a model arrived: the page is read for its pictures.
    await rename(`${pagePath}.away`, pagePath);
    const third = startCore(dataDir, withPictures);
    await waitForProcessing(third, [page.id]);
    const found = await third.searchPassages("44.9", { mode: "keyword" });
    expect(found.map((row) => row.documentId)).toEqual([page.id]);
    expect(found[0]?.text).toContain(CHART_LINES.join("\n"));
    third.close();
  });

  test("a PDF last read before version 16 keeps its version while its file is away, and its words are found once it is back", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const path = await writeSourceFile(
      sources,
      "Away.pdf",
      buildPdf([{ chineseLines: ["配送成本上升，7", "月起免运费门槛下调。"] }]),
    );
    const first = startCore(dataDir);
    const [document] = (await addAndProcess(first, [path])) as [Document];
    first.close();
    asOlderPipeline(dataDir, document, 14, () => "Superseded wording");

    await rename(path, `${path}.away`);
    const second = startCore(dataDir);
    await waitForProcessing(second, [document.id]);
    expect(await second.searchPassages("配送成本", { mode: "keyword" })).toEqual([]);
    second.upgradeKeywordIndex();
    await vi.waitFor(() => expect(rowsWith(dataDir, "away")).toBe(0), { timeout: 30_000 });
    expect(versions(dataDir, document.id)).toEqual({
      processing_version: 14,
      keywords_version: PROCESSING_VERSION,
    });
    second.close();

    await rename(`${path}.away`, path);
    const third = startCore(dataDir);
    await waitForProcessing(third, [document.id]);
    const found = await third.searchPassages("配送成本", { mode: "keyword" });
    expect(found.map((row) => row.documentId)).toEqual([document.id]);
    expect(found[0]?.text).toContain("7月起");
    third.close();
  });

  test("a Document whose file is there is rewritten without being read or embedded", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const embedder = createControlledEmbedder();
    const first = startCore(dataDir, { embedder });
    await turnOnEmbeddings(first);
    // Markdown has been read the same way since version 5, so version 7 is current for it (#2365
    // made Word files current only from version 21).
    const [word] = (await addAndProcess(first, [
      await writeSourceFile(sources, "Library.md", "# Costs\n\nA contingency is held.\n"),
    ])) as [Document];
    first.close();
    // A Document whose Passages are what this pipeline builds, with rows the older one wrote.
    asOlderPipeline(dataDir, word, 7);
    const passages = () =>
      queryDatabase(
        dataDir,
        "SELECT id, text, embedding FROM passages WHERE document_id = ? AND deleted_at IS NULL",
        [word.id],
      );
    const before = passages();
    const embeddedBefore = embedder.texts.length;

    const second = startCore(dataDir, { embedder });
    const statuses: string[] = [];
    second.on("document.status", (document) => statuses.push(document.id));
    second.upgradeKeywordIndex();
    await vi.waitFor(() => expect(rowsWith(dataDir, "library")).toBe(0), { timeout: 30_000 });
    expect(versions(dataDir, word.id)).toEqual({
      processing_version: 7,
      keywords_version: PROCESSING_VERSION,
    });
    // Nothing was read, no Passage changed, and no vector was made again.
    expect(passages()).toEqual(before);
    expect(embedder.texts.length).toBe(embeddedBefore);
    expect(statuses).toEqual([]);
    expect(await second.searchPassages("contingency", { mode: "keyword" })).not.toEqual([]);
    second.close();

    // The next start reads nothing again.
    const third = startCore(dataDir, { embedder });
    expect(
      queryDatabase<{ status: string }>(dataDir, "SELECT status FROM documents").map(
        (row) => row.status,
      ),
    ).toEqual(["ready"]);
    third.close();
  });
});
