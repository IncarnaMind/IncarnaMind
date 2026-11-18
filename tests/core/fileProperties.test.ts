/**
 * What a Document keeps of its file's properties (#2458): its own created and modified dates, its
 * author and a workbook's sheets as the file records them, and none where they can't be the file's.
 */
import { describe, expect, test } from "vitest";
import type { Document } from "../../src/core";
import { ownDate } from "../../src/core/documents/creationDate";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { corePropertiesXml, docxOf, xlsxOf } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";

const agreement = (core: { modified?: string; created?: string; creator?: string }) =>
  docxOf(
    [
      { text: "Services agreement", heading: 1 },
      { text: "This agreement was signed on 14 March 2026 between Halden Ltd and Orrin plc." },
      { text: "Author: Sam Smith" },
    ],
    { coreXml: corePropertiesXml({ created: "2026-10-01T08:00:00Z", ...core }) },
  );

/** A file to add. */
interface SourceFile {
  name: string;
  contents: string | Uint8Array;
}

/** Adds these files to a new Library. */
async function setUp(files: readonly SourceFile[]) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  const sources = await createTempDataFolder();
  const paths = await Promise.all(
    files.map((file) => writeSourceFile(sources, file.name, file.contents)),
  );
  const documents = await addAndProcess(core, paths);
  const named = (name: string): Document => {
    const found = documents.find((each) => each.path.endsWith(name));
    if (!found) throw new Error(`No Document of ${name}.`);
    return found;
  };
  return { core, dataDir, named };
}

describe("What a Document keeps of its file's properties", () => {
  const propertiesOf = async (files: readonly SourceFile[]) => {
    const setup = await setUp(files);
    const listed = await setup.core.listDocuments();
    return (name: string) => listed.find((each) => each.path.endsWith(name))?.properties;
  };

  test("dates as the file writes them, offset and all; its author, Chinese too; a workbook's sheets", async () => {
    const of = await propertiesOf([
      {
        name: "Brief.docx",
        contents: docxOf([{ text: "Brief" }], {
          coreXml: corePropertiesXml({
            created: "2026-10-01T08:00:00+08:00",
            modified: "2026-11-02T23:59:00-05:00",
            creator: "  王  小明  ",
          }),
        }),
      },
      {
        name: "Report.pdf",
        contents: buildPdf([{ lines: ["Report"] }], {
          info: { CreationDate: "D:20260930", ModDate: "D:20261102093000Z", Author: "Ana Ruiz" },
        }),
      },
      {
        name: "Model.xlsx",
        contents: xlsxOf(
          [
            { name: "A", rows: [["x", 1]] },
            { name: "B", rows: [["y", 2]], state: "veryHidden" },
          ],
          { coreXml: corePropertiesXml({ modified: "2026-11-01T10:00:00Z" }) },
        ),
      },
    ]);

    expect(of("Brief.docx")).toEqual({
      created: "2026-10-01T08:00:00+08:00",
      modified: "2026-11-02T23:59:00-05:00",
      author: "王 小明",
      sheets: null,
    });
    expect(of("Report.pdf")).toEqual({
      created: "2026-09-30",
      modified: "2026-11-02T09:30:00Z",
      author: "Ana Ruiz",
      sheets: null,
    });
    expect(of("Model.xlsx")).toEqual({
      created: null,
      modified: "2026-11-01T10:00:00Z",
      author: "IncarnaMind tests",
      sheets: { count: 2, hidden: 1 },
    });
  });

  // protects=a property that can't be read as the file's is none, never a guess: an empty, garbled or overlong author, a zero or future date; fails_when=a placeholder or damaged value is shown and cited as the file's own.
  test("an empty, garbled or overlong author, and a zero or future date, are none", async () => {
    const office = (core: Parameters<typeof corePropertiesXml>[0]) =>
      docxOf([{ text: "Text" }], { coreXml: corePropertiesXml(core) });
    const of = await propertiesOf([
      {
        name: "Empty.docx",
        contents: office({ creator: "   ", modified: "1980-01-01T00:00:00Z" }),
      },
      { name: "Garbled.docx", contents: office({ creator: "J��nes", modified: "2099-05-01" }) },
      { name: "Long.docx", contents: office({ creator: "A".repeat(201), created: "2026-13-40" }) },
      { name: "Edge.docx", contents: office({ creator: "B".repeat(200) }) },
    ]);

    for (const name of ["Empty.docx", "Garbled.docx", "Long.docx"]) {
      expect(of(name), name).toEqual({ created: null, modified: null, author: null, sheets: null });
    }
    expect(of("Edge.docx")?.author).toBe("B".repeat(200));
  });

  test("a date still to come is no date the file was saved on", async () => {
    // Days ahead of today: a date in a later year is refused by its year alone.
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const of = await propertiesOf([
      {
        name: "Soon.docx",
        contents: docxOf([{ text: "Text" }], {
          coreXml: corePropertiesXml({ created: "2026-10-01T08:00:00Z", modified: soon }),
        }),
      },
    ]);

    expect(of("Soon.docx")).toEqual({
      created: "2026-10-01T08:00:00Z",
      modified: null,
      author: "IncarnaMind tests",
      sheets: null,
    });
  });

  // protects=a stored row is read back checked: a damaged, older or synced value that can't be the file's makes them all unknown, never "the file records none"; fails_when=a row's garbage date is shown and cited as the file's, or a malformed row brings up "only this computer's date".
  test("a stored row that can't be the file's reads as unknown, never as none recorded", async () => {
    const setup = await setUp([{ name: "Brief.docx", contents: agreement({}) }]);
    const brief = setup.named("Brief.docx");
    const read = async (stored: string) => {
      queryDatabase(
        setup.dataDir,
        "UPDATE documents SET file_properties = ? WHERE id = ? RETURNING id",
        [stored, brief.id],
      );
      return (await setup.core.listDocuments()).find((each) => each.id === brief.id)?.properties;
    };
    const row = (values: Record<string, unknown>) =>
      JSON.stringify({ created: null, modified: null, author: null, sheets: null, ...values });

    for (const stored of [
      row({ modified: "2099-01-01" }),
      row({ modified: "yesterday" }),
      row({ created: 5 }),
      row({ author: "J\u0000nes" }),
      row({ sheets: { count: 2, hidden: 3 } }),
      "{}",
      "not JSON",
    ]) {
      expect(await read(stored), stored).toBeNull();
    }
    expect(await read(row({ modified: "2026-11-02T09:00:00Z", author: "Jo Jones" }))).toEqual({
      created: null,
      modified: "2026-11-02T09:00:00Z",
      author: "Jo Jones",
      sheets: null,
    });
  });

  test("a date up to a day ahead of this computer's clock is kept, and a later one isn't", () => {
    const now = new Date("2026-11-03T11:00:00Z");
    expect(ownDate(["2026-11-04T10:00:00Z"], now)).toBe("2026-11-04T10:00:00Z");
    expect(ownDate(["2026-11-04T12:00:00Z"], now)).toBeNull();
  });

  test("a text file records none of its own; a kind whose properties aren't read has none known", async () => {
    const of = await propertiesOf([
      { name: "Notes.md", contents: "# Notes\n\nText.\n" },
      { name: "Letter.rtf", contents: "{\\rtf1\\ansi{\\info{\\author Jo}}Dear Jo,\\par}" },
    ]);

    expect(of("Notes.md")).toEqual({ created: null, modified: null, author: null, sheets: null });
    expect(of("Letter.rtf")).toBeNull();
  });
});
