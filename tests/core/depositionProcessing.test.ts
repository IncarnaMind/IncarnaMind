import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveDeposition } from "../../src/core/documents/deposition";
import { PROCESSING_VERSION } from "../../src/core/documents/processing";
import { createFakeTextRecognizer } from "../../src/core/documents/scan/fake";
import { createTempDataFolder, NO_MODEL_FILES, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { buildPdf } from "../helpers/pdf";

describe("deposition anchors through document processing", () => {
  test("PDF processing stores printed page and line anchors at the new version", async () => {
    const dataDir = await createTempDataFolder();
    const source = await createSourceFolder();
    const core = startCore(dataDir);
    const path = await writeSourceFile(
      source,
      "smith-deposition.pdf",
      buildPdf([
        { lines: ["Page 45", "1 Q. First?", "2 A. Yes."] },
        { lines: ["Page 46", "1 Q. Next?", "2 A. Last."] },
      ]),
    );
    const [document] = await addAndProcess(core, [path]);
    if (!document) throw new Error("The deposition was not added.");
    expect(
      queryDatabase<{ processing_version: number }>(
        dataDir,
        "SELECT processing_version FROM documents WHERE id = ?",
        [document.id],
      ),
    ).toEqual([{ processing_version: PROCESSING_VERSION }]);

    const rows = queryDatabase<{ anchors: string | null }>(
      dataDir,
      "SELECT anchors FROM document_pages WHERE document_id = ? ORDER BY page",
      [document.id],
    );
    const targets = rows.flatMap((row) =>
      (JSON.parse(row.anchors ?? "[]") as { target: string }[]).map((anchor) => anchor.target),
    );
    expect(targets).toEqual(
      expect.arrayContaining([
        "deposition:page:45",
        "deposition:line:45:1",
        "deposition:line:45:2",
        "deposition:page:46",
        "deposition:line:46:1",
        "deposition:line:46:2",
      ]),
    );
  });

  test("plain text keeps its existing line semantics and gains no deposition anchors", async () => {
    const dataDir = await createTempDataFolder();
    const source = await createSourceFolder();
    const core = startCore(dataDir);
    const path = await writeSourceFile(
      source,
      "notes.txt",
      "Page 45\n1 Not a PDF line\n2 Existing text",
    );
    const [document] = await addAndProcess(core, [path]);
    if (!document) throw new Error("The text file was not added.");
    const rows = queryDatabase<{ anchors: string | null }>(
      dataDir,
      "SELECT anchors FROM document_pages WHERE document_id = ?",
      [document.id],
    );
    const targets = rows.flatMap((row) =>
      (JSON.parse(row.anchors ?? "[]") as { target: string }[]).map((anchor) => anchor.target),
    );
    expect(targets.some((target) => target.startsWith("deposition:"))).toBe(false);
  });

  test("scanned pages gain printed anchors through OCR and resolve across a page break", {
    timeout: 60_000,
  }, async () => {
    const dataDir = await createTempDataFolder();
    const source = await createSourceFolder();
    const recognizer = createFakeTextRecognizer({
      script: {
        pages: {
          1: { lines: ["Page 45", "1 Q. First?", "2 A. Yes."] },
          2: { lines: ["Page 46", "1 Q. Next?", "2 A. Last."] },
        },
      },
    });
    const core = startCore(dataDir, {
      textRecognizer: recognizer,
      textRecognitionModelSource: NO_MODEL_FILES,
    });
    const scan = readFileSync(join(import.meta.dirname, "../fixtures/scans/en-clean.jpg"));
    const path = await writeSourceFile(
      source,
      "smith-deposition-scan.pdf",
      buildPdf([{ scan }, { scan }]),
    );
    const [document] = await addAndProcess(core, [path]);
    if (!document) throw new Error("The scanned deposition was not added.");
    expect(document.status).toBe("ready");

    const { pages } = await core.readDocumentText(document.id);
    const resolved = resolveDeposition(pages, {
      kind: "page",
      from: 1,
      to: 2,
      printed: { from: "45", to: "46" },
      lines: { from: 1, to: 2 },
    });
    expect(resolved.status).toBe("found");
    if (resolved.status !== "found") throw new Error("The scanned lines did not resolve.");
    expect(resolved.units.map((unit) => unit.text)).toEqual([
      "Q. First?",
      "A. Yes.",
      "Q. Next?",
      "A. Last.",
    ]);
    expect(resolved.units.map((unit) => unit.page)).toEqual([1, 1, 2, 2]);
  });
});
