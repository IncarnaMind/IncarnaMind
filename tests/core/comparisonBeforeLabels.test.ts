/**
 * A Mind written before a comparison table's columns had a label (#1833):
 * version 27 content, each column a Question. The fixture is the document a
 * version-27 core wrote, stored as it wrote it; this version opens it to edit
 * and reads and exports it as it was, without rewriting its columns.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
  COMPARISON_TABLE_NODE,
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
} from "../../src/core";
import { cellIndex } from "../../src/core/documents/formats/sheetLayout";
import { readWorkbook } from "../../src/core/documents/formats/xlsx";
import { comparisonQuestionsOf } from "../../src/shared/comparisons";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";

const FIXTURE = join(import.meta.dirname, "../fixtures/comparisons/tides-27.yjs");
const TABLE = "tides-terms";
const QUESTIONS = ["Revenue", "Year end"];

/** The Mind's comparison table, as stored. */
function tableOf(doc: Y.Doc): Y.XmlElement | null {
  return (
    doc
      .getXmlFragment(MIND_CONTENT_FIELD)
      .toArray()
      .find(
        (element): element is Y.XmlElement =>
          element instanceof Y.XmlElement && element.nodeName === COMPARISON_TABLE_NODE,
      ) ?? null
  );
}

describe("a Mind written before a comparison table's columns had a label", () => {
  // protects=a Mind a version-27 core wrote opens to edit here, its table's columns named by their Questions in exports, and its stored content keeps them as they are; fails_when=it opens read-only, a heading is blank or a label, or the columns are rewritten; no_claim=Excel's own rendering.
  test("opens to edit and exports its table with Questions for headings, as it was", async () => {
    expect(CONTENT_SCHEMA_VERSION).toBeGreaterThan(27);
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const mind = await core.createMind({ title: "Tides" });
    core.close();
    const at = new Date().toISOString();
    queryDatabase(dataDir, "DELETE FROM mind_updates WHERE mind_id = ?", [mind.id]);
    queryDatabase(
      dataDir,
      "INSERT INTO mind_updates (id, mind_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [randomUUID(), mind.id, new Uint8Array(await readFile(FIXTURE)), at, at],
    );

    const restarted = startCore(dataDir);
    const opened = await restarted.openMind(mind.id);
    expect(opened.access).toBe("edit");
    const stored = new Y.Doc();
    Y.applyUpdate(stored, opened.state);
    expect(stored.getMap(MIND_SETTINGS_FIELD).get(CONTENT_SCHEMA_VERSION_KEY)).toBe(27);
    const table = tableOf(stored);
    if (!table) throw new Error("The Mind has no comparison table.");
    const columns = comparisonQuestionsOf(table.getAttributes());
    expect(columns.map((column) => column.text)).toEqual(QUESTIONS);
    expect(columns.some((column) => column.label !== undefined)).toBe(false);

    // Read as it was: each column is named by its whole Question, in the table and in Markdown.
    const saved = await restarted.saveComparisonExport({ mindId: mind.id, tableId: TABLE });
    if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
    expect(saved.file.name).toBe("Tides.xlsx");
    const { sheets } = await readWorkbook(
      new Uint8Array(await readFile(saved.file.path)),
      undefined,
      {},
    );
    const [sheet] = sheets;
    if (!sheet) throw new Error("The workbook has no sheets.");
    const cellAt = (row: number, column: number) =>
      sheet.layout?.shown.get(cellIndex(row, column))?.text ??
      sheet.cells.find((cell) => cell.row === row && cell.column === column)?.value;
    expect([0, 1, 2].map((column) => cellAt(1, column))).toEqual(["Document", ...QUESTIONS]);
    // The fixture is the Mind alone: its Documents live outside it, so the row says its source is gone.
    expect([0, 1, 2].map((column) => cellAt(2, column))).toEqual([
      "Acme report.txt (source removed)",
      "1.2m",
      "31 March 2026",
    ]);
    expect([1, 2].map((column) => cellAt(3, column))).toEqual(["1.1 Mio. €", "…"]);
    const markdown = Buffer.from(
      (await restarted.exportMind(mind.id, { format: "markdown" })).data,
    ).toString("utf8");
    expect(markdown).toContain(`| Document | ${QUESTIONS.join(" | ")} |`);

    // This version's next write records 28, and the columns stay as version 27 wrote them.
    await restarted.addToNote({
      mindId: mind.id,
      blocks: [{ type: "paragraph", content: [{ type: "text", text: "Later." }] }],
      origin: null,
      model: null,
    });
    const after = new Y.Doc();
    Y.applyUpdate(after, (await restarted.openMind(mind.id)).state);
    expect(after.getMap(MIND_SETTINGS_FIELD).get(CONTENT_SCHEMA_VERSION_KEY)).toBe(
      CONTENT_SCHEMA_VERSION,
    );
    const kept = tableOf(after);
    if (!kept) throw new Error("The comparison table is gone.");
    expect(comparisonQuestionsOf(kept.getAttributes())).toEqual(columns);
  });
});
