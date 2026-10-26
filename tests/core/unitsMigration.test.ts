/**
 * Migration 22 (ADR-0011): each Document's stored page text becomes Units,
 * PDFs keep theirs, and Markdown and TXT processed before Units are processed
 * again into sections and lines, while their old Citations stay valid.
 */
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DATABASE_FILE, type Document } from "../../src/core";
import { CURRENT_SINCE, PROCESSING_VERSION } from "../../src/core/documents/processing";
import { migrate, openDatabase } from "../../src/core/storage";
import { migrations } from "../../src/core/storage/migrations";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  sha256,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { xlsxOf } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";

const NOTES =
  "# Methods\n\nGauges were read hourly.\n\n# Results\n\nSpring tides came at full moon.\n";
const LOG = Array.from({ length: 70 }, (_, index) => `Entry ${index + 1}: calm.`).join("\n");
const PDF = buildPdf([
  { lines: ["Tides and the Moon"] },
  { lines: ["Spring tides happen at new moon."] },
]);
const AT = "2026-10-01T09:00:00.000Z";

const IDS = { notes: "d1", log: "d2", pdf: "d3" } as const;

/** The built-in model's vector of a Passage: 384 float32s. */
const vector = () => {
  const values = new Float32Array(384);
  values[0] = 1;
  return new Uint8Array(values.buffer);
};

/**
 * A data folder as version 4 of processing left it, before migration 22: a
 * Markdown and a TXT file stored as one text each (page NULL), and a PDF by
 * page, all ready and embedded; the PDF is as the current version reads PDFs.
 */
async function beforeUnits(): Promise<{
  dataDir: string;
  paths: Record<keyof typeof IDS, string>;
}> {
  const dataDir = await createTempDataFolder();
  const sources = await createSourceFolder();
  const paths = {
    notes: join(sources, "Notes.md"),
    log: join(sources, "Log.txt"),
    pdf: join(sources, "Tides.pdf"),
  };
  const contents = { notes: NOTES, log: LOG, pdf: PDF };
  const kinds = { notes: "markdown", log: "text", pdf: "pdf" };
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    migrate(
      db,
      migrations.filter((migration) => migration.version < 22),
    );
    for (const key of Object.keys(IDS) as (keyof typeof IDS)[]) {
      await writeFile(paths[key], contents[key]);
      const info = await stat(paths[key]);
      const hash = sha256(contents[key]);
      db.run(
        `INSERT INTO documents (id, content_hash, name, kind, size, status, page_count, path,
           file_status, file_mtime_ms, processing_version, embedding_model, embedding_dimensions,
           tagging_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, 'available', ?, ?, 'multilingual-e5-small-int8',
           384, 'tagged', ?, ?)`,
        [
          IDS[key],
          hash,
          key,
          kinds[key],
          info.size,
          key === "pdf" ? 2n : null,
          paths[key],
          info.mtimeMs,
          BigInt(key === "pdf" ? CURRENT_SINCE.pdf : 4),
          AT,
          AT,
        ],
      );
      const pages = key === "pdf" ? [1, 2] : [null];
      for (const page of pages) {
        const text = key === "pdf" ? `page ${page}` : contents[key];
        db.run(
          `INSERT INTO passages (id, document_id, content_hash, position, page_from, page_to,
             window_from, window_to, text, embedding, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
          [
            `${IDS[key]}-passage-${page ?? 0}`,
            IDS[key],
            hash,
            BigInt(page ?? 0),
            page === null ? null : BigInt(page),
            page === null ? null : BigInt(page),
            text,
            vector(),
            AT,
            AT,
          ],
        );
        db.run(
          `INSERT INTO document_pages (id, document_id, content_hash, page, text, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            `${IDS[key]}-page-${page ?? 0}`,
            IDS[key],
            hash,
            page === null ? null : BigInt(page),
            text,
            AT,
            AT,
          ],
        );
      }
    }
  } finally {
    db.close();
  }
  return { dataDir, paths };
}

describe("Migration 22: Units", { timeout: 30_000 }, () => {
  test("a PDF's pages stay its Units, and a text stored whole becomes Unit 1 of kind 'text'", async () => {
    const { dataDir } = await beforeUnits();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      migrate(db);
    } finally {
      db.close();
    }

    expect(
      queryDatabase(
        dataDir,
        "SELECT document_id, page, kind, label, anchors FROM document_pages ORDER BY document_id, page",
      ),
    ).toEqual([
      { document_id: "d1", page: 1, kind: "text", label: null, anchors: null },
      { document_id: "d2", page: 1, kind: "text", label: null, anchors: null },
      { document_id: "d3", page: 1, kind: "page", label: null, anchors: null },
      { document_id: "d3", page: 2, kind: "page", label: null, anchors: null },
    ]);
  });

  test("at startup, Markdown and TXT are processed again into sections and lines; PDFs are left as they are", async () => {
    expect(CURRENT_SINCE).toMatchObject({ markdown: 5, text: 5 });
    const { dataDir } = await beforeUnits();
    const core = startCore(dataDir);
    const statuses: [string, Document["status"]][] = [];
    core.on("document.status", (document) => statuses.push([document.id, document.status]));

    await waitForProcessing(core, [IDS.notes, IDS.log]);

    expect(
      queryDatabase(
        dataDir,
        `SELECT document_id, page, kind, label FROM document_pages
         WHERE deleted_at IS NULL ORDER BY document_id, page`,
      ),
    ).toEqual([
      { document_id: "d1", page: 1, kind: "section", label: '{"path":["Methods"]}' },
      { document_id: "d1", page: 2, kind: "section", label: '{"path":["Results"]}' },
      { document_id: "d2", page: 1, kind: "lines", label: '{"from":1,"to":50}' },
      { document_id: "d2", page: 2, kind: "lines", label: '{"from":51,"to":70}' },
      { document_id: "d3", page: 1, kind: "page", label: null },
      { document_id: "d3", page: 2, kind: "page", label: null },
    ]);
    // The PDF wasn't processed: its Passages and their vectors are the ones it had. Its title,
    // read in the background (#213), is pushed as a Document that is ready, as before.
    expect(statuses.filter(([id, status]) => id === IDS.pdf && status !== "ready")).toEqual([]);
    expect(
      queryDatabase(
        dataDir,
        `SELECT id, deleted_at IS NULL AS live FROM passages WHERE document_id = 'd3' ORDER BY id`,
      ),
    ).toEqual([
      { id: "d3-passage-1", live: 1 },
      { id: "d3-passage-2", live: 1 },
    ]);
    // Having no Han characters to fold either (see `HAN_CURRENT_SINCE`), it is set to this
    // version as it is.
    expect(
      queryDatabase(dataDir, "SELECT id, processing_version FROM documents ORDER BY id"),
    ).toEqual([
      { id: "d1", processing_version: PROCESSING_VERSION },
      { id: "d2", processing_version: PROCESSING_VERSION },
      { id: "d3", processing_version: PROCESSING_VERSION },
    ]);

    // A Citation of a whole file, from before Units, is still checked: now in its section.
    expect(
      await core.recheckCitation({
        documentId: IDS.notes,
        quote: "Spring tides came at full moon.",
        pageFrom: null,
        pageTo: null,
      }),
    ).toMatchObject({
      check: "found",
      pageFrom: 2,
      pageTo: 2,
      location: { kind: "section", heading: "Results" },
    });
    core.close();
  });
});

describe("a workbook stamped by an older pipeline", () => {
  test("is read again once for its hidden sheets, a no-text one too; a PDF is not read", async () => {
    const sources = await createSourceFolder();
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir);
    const [book, blank, pdf, notes] = (await addAndProcess(first, [
      await writeSourceFile(
        sources,
        "Budget.xlsx",
        xlsxOf([
          { name: "Visible", rows: [["Region"]] },
          { name: "Q3 raw", state: "hidden", rows: [["Secret"]] },
        ]),
      ),
      await writeSourceFile(
        sources,
        "Hidden.xlsx",
        xlsxOf([{ name: "Q3 raw", state: "hidden", rows: [["Secret"]] }]),
      ),
      await writeSourceFile(sources, "Tides.pdf", buildPdf([{ lines: ["Spring tides."] }])),
      await writeSourceFile(sources, "Notes.md", "# Notes\n\nSpring tides.\n"),
    ])) as [Document, Document, Document, Document];
    expect(blank.status).toBe("no-text");
    first.close();

    // Workbooks are stamped 12, before #1924; the PDF is current and is not read again.
    expect(12).toBeLessThan(PROCESSING_VERSION);
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run(
        "UPDATE documents SET processing_version = CASE WHEN kind = 'pdf' THEN ? ELSE 12 END, unread_parts = NULL",
        [BigInt(CURRENT_SINCE.pdf)],
      );
    } finally {
      db.close();
    }

    const second = startCore(dataDir);
    const waiting = Object.fromEntries(
      (await second.listDocuments()).map((document) => [document.id, document.status]),
    );
    // Only the workbooks are read again; a PDF or Markdown read would be queued too.
    expect(waiting).toEqual({
      [book.id]: "queued",
      [blank.id]: "queued",
      [pdf.id]: "ready",
      [notes.id]: "ready",
    });
    await waitForProcessing(second, [book.id, blank.id]);
    // Both workbooks said what they left out, so both were read again.
    for (const id of [book.id, blank.id]) {
      const [row] = queryDatabase<{ unread_parts: string | null }>(
        dataDir,
        "SELECT unread_parts FROM documents WHERE id = ?",
        [id],
      );
      expect(row?.unread_parts).toContain("Q3 raw");
    }
    // All say this pipeline's version now, so a later start reads none of them again.
    expect(
      queryDatabase<{ processing_version: number }>(
        dataDir,
        "SELECT processing_version FROM documents ORDER BY name",
      ).map((row) => row.processing_version),
    ).toEqual([PROCESSING_VERSION, PROCESSING_VERSION, PROCESSING_VERSION, PROCESSING_VERSION]);
    expect(
      queryDatabase<{ status: string }>(dataDir, "SELECT status FROM documents")
        .map((row) => row.status)
        .sort(),
    ).toEqual(["no-text", "ready", "ready", "ready"]);
    second.close();

    // Read once: at the next start nothing is queued for reading again.
    const third = startCore(dataDir);
    const statuses = queryDatabase<{ status: string }>(dataDir, "SELECT status FROM documents").map(
      (row) => row.status,
    );
    expect(statuses).not.toContain("queued");
    expect(statuses).not.toContain("extracting");
    third.close();
  });
});
