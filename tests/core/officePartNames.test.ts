import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import { extractDocx } from "../../src/core/documents/formats/docx";
import { openWordPackage, reviewOf } from "../../src/core/documents/formats/docxPackage";
import { extractPptx } from "../../src/core/documents/formats/pptx";
import { openPackage } from "../../src/core/documents/formats/zip";
import { openDatabase } from "../../src/core/storage";
import { drawnTargetOf } from "../../src/renderer/src/viewer/wordPlaces";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { recordingLog } from "../helpers/log";
import { xlsxOf } from "../helpers/office";
import { paragraph, run, STYLES, wordFile } from "../helpers/word";
import { buildZip } from "../helpers/zip";

/**
 * A copy of an Office file with its parts renamed ("document.xml" → "document2.xml"), and every
 * relationship and content type that names them, as some editors save them; and with parts'
 * text replaced, or added.
 */
async function repackaged(
  bytes: Uint8Array,
  renames: Readonly<Record<string, string>>,
  parts: Readonly<Record<string, string>> = {},
): Promise<Buffer> {
  const zip = openPackage(bytes);
  const rename = (text: string) =>
    Object.entries(renames).reduce((each, [from, to]) => each.replaceAll(from, to), text);
  const kept = await Promise.all(
    zip.names().map(async (name) => {
      const data = Buffer.from((await zip.read(name)) ?? new Uint8Array());
      const listsNames = name.endsWith(".rels") || name === "[Content_Types].xml";
      return {
        name: rename(name),
        data: parts[name] ?? (listsNames ? rename(data.toString("utf8")) : data),
      };
    }),
  );
  const added = Object.entries(parts).filter(([name]) => !zip.has(name));
  return buildZip([...kept, ...added.map(([name, data]) => ({ name, data }))]);
}

const CHINESE_HEADING = `<w:style w:type="paragraph" w:styleId="标题1"><w:name w:val="标题 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>`;

const harbourFile = () =>
  wordFile({
    styles: STYLES + CHINESE_HEADING,
    body: [
      paragraph(run("Harbour dues"), { style: "Heading1" }),
      paragraph(run("The harbour master sets the dues each spring.")),
      paragraph(run("潮汐记录"), { style: "标题1" }),
      paragraph(run("每月记录一次潮汐高度。")),
    ].join(""),
    footnotes: `<w:footnote w:id="1"><w:p><w:ins w:id="7" w:author="Dana Kim" w:date="2026-11-01T09:00:00Z">${run("Dues are set in pounds.")}</w:ins></w:p></w:footnote>`,
  });

const RENAMED_WORD = {
  "document.xml": "document2.xml",
  "styles.xml": "styles2.xml",
  "footnotes.xml": "notes-at-foot.xml",
};

const sectionPaths = (dataDir: string, documentId: string) =>
  queryDatabase<{ label: string }>(
    dataDir,
    "SELECT label FROM document_pages WHERE document_id = ? AND deleted_at IS NULL ORDER BY page",
    [documentId],
  ).map((row) => {
    const label = JSON.parse(row.label) as { path?: string[]; notes?: boolean };
    return label.notes ? "notes" : (label.path ?? []).join(" › ");
  });

describe("A Word file, deck or workbook is read where its package says its parts are (#2620)", {
  timeout: 60_000,
}, () => {
  test("a Word file whose main part, styles and notes have other names is indexed by its sections, shown and imported", async () => {
    const bytes = await repackaged(harbourFile(), RENAMED_WORD);
    expect(openPackage(bytes).has("word/document.xml")).toBe(false);

    const shown = await extractDocx(bytes);
    expect(shown.headings.map((heading) => heading.text)).toEqual(["Harbour dues", "潮汐记录"]);
    expect(shown.unreadable).toEqual([]);
    expect(await drawnTargetOf(bytes, "w:p#1")).toEqual({
      index: 1,
      text: "The harbour master sets the dues each spring.",
    });

    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const path = await writeSourceFile(await createSourceFolder(), "Harbour.docx", bytes);
    const [document] = await addAndProcess(core, [path]);
    if (!document) throw new Error("Missing Document.");
    expect(document.status).toBe("ready");
    expect(sectionPaths(dataDir, document.id)).toEqual(["Harbour dues", "潮汐记录", "notes"]);
    const [found] = await core.searchPassages("harbour master dues", { mode: "keyword" });
    expect(found).toMatchObject({ documentId: document.id, pageFrom: 1 });

    expect((await core.checkWordFile(path)).refusal).toBeNull();
    expect(await reviewOf(await openWordPackage(bytes))).toEqual({
      authors: ["Dana Kim"],
      changes: 1,
      comments: 0,
    });
    expect(await core.importWordFile({ path, origin: "own" })).toMatchObject({ ok: true });
    core.close();
  });

  test("a Word file with the usual names reads as it did", async () => {
    const usual = await extractDocx(harbourFile());
    const renamed = await extractDocx(await repackaged(harbourFile(), RENAMED_WORD));

    expect(renamed.units).toEqual(usual.units);
    expect(renamed.headingStyles).toEqual(usual.headingStyles);
    expect(usual.headingStyles).toEqual(["Heading1", "Heading2", "Heading3", "标题1"]);
  });

  test("a deck and a workbook whose main parts have other names are read", async () => {
    const deck = await readFile(
      new URL("../fixtures/formats/Quarterly Research Update.pptx", import.meta.url),
    );
    const renamedDeck = await repackaged(deck, { "presentation.xml": "presentation2.xml" });
    expect((await extractPptx(renamedDeck)).units).toEqual((await extractPptx(deck)).units);
    const workbook = await repackaged(
      xlsxOf([
        {
          name: "Tides",
          rows: [
            ["Month", "Height"],
            ["March", 4.2],
          ],
        },
      ]),
      { "workbook.xml": "workbook2.xml" },
      {
        "_rels/.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook2.xml"/></Relationships>`,
      },
    );

    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const sources = await createSourceFolder();
    const read = await addAndProcess(core, [
      await writeSourceFile(sources, "Update.pptx", renamedDeck),
      await writeSourceFile(sources, "Tides.xlsx", workbook),
    ]);

    expect(read.map((each) => [each.kind, each.status])).toEqual([
      ["pptx", "ready"],
      ["xlsx", "ready"],
    ]);
    const [cell] = await core.searchPassages("March", { mode: "keyword" });
    expect(cell?.documentId).toBe(read[1]?.id);
    core.close();
  });

  test("a relationships part that can't be read: the index reads the rest and logs it, the import refuses the file", async () => {
    const broken = await repackaged(
      harbourFile(),
      {},
      { "word/_rels/document.xml.rels": "<Relationships><Relationship" },
    );
    const recorded = recordingLog();
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, { log: recorded.log });
    const path = await writeSourceFile(await createSourceFolder(), "Broken.docx", broken);

    const [document] = await addAndProcess(core, [path]);

    expect(document?.status).toBe("ready");
    const [found] = await core.searchPassages("harbour master dues", { mode: "keyword" });
    expect(found?.documentId).toBe(document?.id);
    expect(recorded.entries).toContainEqual(
      expect.objectContaining({
        event: "documents.partsNotRead",
        fields: { documentId: document?.id, parts: "word/_rels/document.xml.rels" },
      }),
    );
    expect((await core.checkWordFile(path)).refusal).toBe("damaged");
    core.close();
  });

  test("a Word file an older version couldn't read is read again, once, at the next start", async () => {
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir);
    const path = await writeSourceFile(
      await createSourceFolder(),
      "Harbour.docx",
      await repackaged(harbourFile(), RENAMED_WORD),
    );
    const [document] = await addAndProcess(first, [path]);
    if (!document) throw new Error("Missing Document.");
    first.close();

    // As version 24 left it: failed, as it found no word/document.xml.
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run(
        `UPDATE documents SET status = 'failed', failure_reason = 'unreadable',
           failure_message = 'Not a Word document: it has no word/document.xml.',
           processing_version = 24 WHERE id = ?`,
        [document.id],
      );
    } finally {
      db.close();
    }

    const again = startCore(dataDir);
    expect((await again.listDocuments())[0]).toMatchObject({ id: document.id, status: "queued" });
    const [read] = await waitForProcessing(again, [document.id]);
    expect(read).toMatchObject({ status: "ready" });
    expect(sectionPaths(dataDir, document.id)).toEqual(["Harbour dues", "潮汐记录", "notes"]);
    again.close();
  });
});
