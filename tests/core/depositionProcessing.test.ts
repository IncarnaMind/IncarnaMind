import { describe, expect, test } from "vitest";
import { PROCESSING_VERSION } from "../../src/core/documents/processing";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
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
});
