/**
 * Creation dates (#53), for the Library's year: every Document gets the
 * creation date its file's metadata gives (a PDF's Info dictionary or XMP,
 * the core properties of a Word, PowerPoint or Excel file), or else a year
 * written in its first Unit, and never a modification date. New Documents
 * get it while they're processed; existing ones get it once, in the
 * background, from a metadata job that extracts and embeds nothing.
 */
import { readFileSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { DATABASE_FILE, type Document, type DocumentKind } from "../../src/core";
import {
  creationDate,
  isPlaceholderDate,
  pdfDate,
  w3cDate,
  yearWritten,
} from "../../src/core/documents/creationDate";
import { METADATA_VERSION, PROCESSING_VERSION } from "../../src/core/documents/processing";
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
import { createControlledEmbedder } from "../helpers/embedding";
import { corePropertiesXml, docxOf, xlsxOf } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/formats/${name}`, import.meta.url)));

/** XMP metadata with these properties of the xmp: namespace, as elements or as attributes. */
const xmp = (properties: Record<string, string>, form: "elements" | "attributes") => {
  const namespace = 'xmlns:xmp="http://ns.adobe.com/xap/1.0/"';
  const description =
    form === "elements"
      ? `<rdf:Description rdf:about="" ${namespace}>${Object.entries(properties)
          .map(([name, value]) => `<xmp:${name}>${value}</xmp:${name}>`)
          .join("")}</rdf:Description>`
      : `<rdf:Description rdf:about="" ${namespace} ${Object.entries(properties)
          .map(([name, value]) => `xmp:${name}="${value}"`)
          .join(" ")}/>`;
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${description}</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
};

/**
 * Adds files and waits for them to be processed. Returns their Documents as
 * processing finished them, and their creation dates as the API now gives
 * them, by file name.
 */
async function datesOf(files: Record<string, string | Uint8Array>): Promise<{
  dates: Record<string, string | null | undefined>;
  documents: Document[];
}> {
  const sources = await createSourceFolder();
  const core = startCore(await createTempDataFolder());
  const names = Object.keys(files);
  const paths = await Promise.all(
    names.map((name) => writeSourceFile(sources, name, files[name] as string | Uint8Array)),
  );
  const documents = await addAndProcess(core, paths);
  const listed = await core.listDocuments();
  return {
    dates: Object.fromEntries(
      names.map((name, at) => [
        name,
        listed.find((document) => document.path === paths[at])?.creationDate,
      ]),
    ),
    documents,
  };
}

describe("Creation dates as files write them", () => {
  test("a PDF date is read as ISO 8601 at the precision it gives, keeping its offset from UTC", () => {
    expect(pdfDate("D:20190304103000+01'00'")).toBe("2019-03-04T10:30:00+01:00");
    expect(pdfDate("D:20190304103000-05'30")).toBe("2019-03-04T10:30:00-05:30");
    expect(pdfDate("D:20190304103000+0100")).toBe("2019-03-04T10:30:00+01:00");
    expect(pdfDate("D:20190304103000Z")).toBe("2019-03-04T10:30:00Z");
    expect(pdfDate("D:20190304103000Z00'00'")).toBe("2019-03-04T10:30:00Z");
    expect(pdfDate("20190304103000")).toBe("2019-03-04T10:30:00");
    expect(pdfDate("D:2019030410")).toBe("2019-03-04T10:00:00");
    expect(pdfDate("D:20190304")).toBe("2019-03-04");
    expect(pdfDate("D:201903")).toBe("2019-03");
    expect(pdfDate(" D:2019 ")).toBe("2019");
    // Some writers put an ISO 8601 date in the Info dictionary.
    expect(pdfDate("2019-03-04T10:30:00Z")).toBe("2019-03-04T10:30:00Z");
  });

  test("Office's dates (W3CDTF) are kept as written", () => {
    expect(w3cDate("2026-10-07T16:05:26.116Z")).toBe("2026-10-07T16:05:26.116Z");
    expect(w3cDate("2019-03-04T10:30+01:00")).toBe("2019-03-04T10:30+01:00");
    expect(w3cDate("2019-03-04T10:30:00")).toBe("2019-03-04T10:30:00");
    expect(w3cDate(" 2019-03-04 ")).toBe("2019-03-04");
    expect(w3cDate("2019-03")).toBe("2019-03");
    expect(w3cDate("2019")).toBe("2019");
  });

  test("a malformed date is no date", () => {
    for (const malformed of [
      "",
      "yesterday",
      "D:20191304",
      "D:20190230",
      "D:20190304250000",
      "D:20190304103000+25'00'",
      "Mon Mar  4 10:30:00 2019",
    ]) {
      expect(pdfDate(malformed), malformed).toBeNull();
    }
    for (const malformed of [
      "",
      "March 2019",
      "2019-13-01",
      "2019-02-30",
      "2019-03-04T24:00:00Z",
      "2019-03-04T10:30:00+01",
      "2019/03/04",
      "20190304",
    ]) {
      expect(w3cDate(malformed), malformed).toBeNull();
    }
  });

  test("a year written in text is four digits standing alone, from 1900 to this year: the latest of them", () => {
    expect(yearWritten("NIPS 2017, Long Beach. Trained on WMT 2014.", 2026)).toBe("2017");
    expect(yearWritten("2019年3月发布，参考2016年的数据", 2026)).toBe("2019");
    expect(yearWritten("FY2023 results (unaudited)", 2026)).toBe("2023");
    expect(yearWritten("Minutes, 12 March 2022.", 2026)).toBe("2022");
    expect(yearWritten("Released 2026; next review 2027", 2026)).toBe("2026");
    expect(
      yearWritten("1,950 people; version 2019.5; ref 12019; in 1899; plans for 2031", 2026),
    ).toBeNull();
    expect(yearWritten("No year here.", 2026)).toBeNull();
  });

  test("the metadata's date comes first; an implausible or zero date gives way to the first Unit's year", () => {
    expect(creationDate(["2019-03-04T10:30:00Z"], "Updated in 2024", 2026)).toBe(
      "2019-03-04T10:30:00Z",
    );
    expect(creationDate([null, "2018-05-01"], "2024", 2026)).toBe("2018-05-01");
    // Before 1900, or after this year.
    expect(creationDate(["1601-01-01T00:00:00Z"], "Written in 2015", 2026)).toBe("2015");
    expect(creationDate(["2031-01-01"], "Written in 2015", 2026)).toBe("2015");
    // Midnight on 1 January of a clock's epoch: software that had no date wrote zero.
    for (const zero of ["1970-01-01T00:00:00Z", "1904-01-01T00:00:00Z", "1980-01-01T00:00:00"]) {
      expect(creationDate([zero], null, 2026), zero).toBeNull();
    }
    expect(creationDate(["1970-01-01T09:15:00Z"], null, 2026)).toBe("1970-01-01T09:15:00Z");
    expect(creationDate([], null, 2026)).toBeNull();
  });
});

describe("New Documents get their creation date while they're processed", {
  timeout: 30_000,
}, () => {
  test("a PDF's comes from its Info dictionary's CreationDate, never its ModDate", async () => {
    const { dates, documents } = await datesOf({
      "Survey.pdf": buildPdf([{ lines: ["Coastal survey, revised in 2024"] }], {
        info: {
          Title: "Coastal survey",
          CreationDate: "D:20190304103000+01'00'",
          ModDate: "D:20240101090000Z",
        },
      }),
      "Revised.pdf": buildPdf([{ lines: ["Revised in 2024"] }], {
        info: { ModDate: "D:20240101090000Z" },
      }),
    });

    expect(dates).toEqual({ "Survey.pdf": "2019-03-04T10:30:00+01:00", "Revised.pdf": "2024" });
    expect(documents.map((document) => document.status)).toEqual(["ready", "ready"]);
  });

  test("a PDF's XMP metadata gives its creation date when its Info dictionary has none", async () => {
    const { dates } = await datesOf({
      "Elements.pdf": buildPdf([{ lines: ["Tides"] }], {
        xmp: xmp(
          { CreateDate: "2018-06-12T08:00:00-04:00", ModifyDate: "2023-01-01T00:00:00Z" },
          "elements",
        ),
      }),
      "Attributes.pdf": buildPdf([{ lines: ["Tides"] }], {
        xmp: xmp(
          { CreateDate: "2017-02-01T12:00:00Z", ModifyDate: "2023-01-01T00:00:00Z" },
          "attributes",
        ),
      }),
      "Modified only.pdf": buildPdf([{ lines: ["Tides"] }], {
        xmp: xmp({ ModifyDate: "2023-01-01T00:00:00Z" }, "elements"),
      }),
    });

    expect(dates).toEqual({
      "Elements.pdf": "2018-06-12T08:00:00-04:00",
      "Attributes.pdf": "2017-02-01T12:00:00Z",
      "Modified only.pdf": null,
    });
  });

  test("a PDF without a creation date takes the latest year written on its first page, and none from later pages", async () => {
    const { dates } = await datesOf({
      "Attention.pdf": buildPdf([
        { lines: ["Attention models", "Trained on WMT 2014 data.", "NIPS 2017, Long Beach"] },
        { lines: ["Results from 2025"] },
      ]),
      "Tides.pdf": buildPdf([{ lines: ["A survey of tides"] }, { lines: ["Written in 2015"] }]),
    });

    expect(dates).toEqual({ "Attention.pdf": "2017", "Tides.pdf": null });
  });

  test("Word, PowerPoint and Excel files take dcterms:created from their core properties", async () => {
    const { dates } = await datesOf({
      "Coastal Flood Risk Review.docx": fixture("Coastal Flood Risk Review.docx"),
      "Quarterly Research Update.pptx": fixture("Quarterly Research Update.pptx"),
      "Regional Revenue.xlsx": fixture("Regional Revenue.xlsx"),
      "Elsewhere.xlsx": xlsxOf([{ name: "Data", rows: [["Region"], ["North"]] }], {
        coreXml: corePropertiesXml({ created: "2020-02-02T02:02:02Z" }),
        corePath: "metadata/core.xml",
      }),
    });

    expect(dates).toEqual({
      "Coastal Flood Risk Review.docx": "2026-10-07T16:05:26.116Z",
      "Quarterly Research Update.pptx": "2026-10-07T16:05:26Z",
      "Regional Revenue.xlsx": "2026-10-07T16:05:26Z",
      // Found where the package's relationships say its core properties are.
      "Elsewhere.xlsx": "2020-02-02T02:02:02Z",
    });
  });

  test("an Office file's modification date is never taken: without dcterms:created, its year comes from its first Unit", async () => {
    const { dates } = await datesOf({
      "Budget.docx": docxOf(
        [
          { text: "Budget review 2016", heading: 1 },
          { text: "Spending rose." },
          { text: "Outlook for 2025", heading: 1 },
        ],
        { coreXml: corePropertiesXml({ modified: "2024-05-01T00:00:00Z" }) },
      ),
      "Plain.docx": docxOf([{ text: "No date anywhere." }], {
        coreXml: corePropertiesXml({ modified: "2024-05-01T00:00:00Z" }),
      }),
    });

    expect(dates).toEqual({ "Budget.docx": "2016", "Plain.docx": null });
  });

  test("Markdown, text and CSV files take the latest year written in their first Unit", async () => {
    const { dates } = await datesOf({
      "Annual review.md":
        "# Annual review 2021\n\nCompared with 2019, tides rose.\n\n# Outlook\n\nTargets for 2025.\n",
      "Minutes.txt": "Minutes of the meeting, 12 March 2022.\nAttendees: three.\n",
      "Revenue.csv": "Year,Revenue\n2018,10\n2019,12\n",
      "Undated.md": "# Notes\n\nNothing dated here.\n",
    });

    expect(dates).toEqual({
      "Annual review.md": "2021",
      "Minutes.txt": "2022",
      "Revenue.csv": "2019",
      "Undated.md": null,
    });
  });

  test("an unusual or malformed file never fails its Document: its year comes from its first Unit instead", async () => {
    const page = { lines: ["Annual report 2012"] };
    const { dates, documents } = await datesOf({
      "Month 13.pdf": buildPdf([page], { info: { CreationDate: "D:20191345990000" } }),
      "Before 1900.pdf": buildPdf([page], { info: { CreationDate: "D:16010101000000Z" } }),
      "Future.pdf": buildPdf([page], { info: { CreationDate: "D:29990101000000Z" } }),
      "Info not a dictionary.pdf": buildPdf([page], { rawInfo: "(not a dictionary)" }),
      "Broken XMP.pdf": buildPdf([page], { xmp: "<x:xmpmeta><rdf:RDF><broken" }),
      "Broken core.docx": docxOf([{ text: "Annual report 2012" }], {
        coreXml: "<cp:coreProperties><dcterms:created>2019-03-04",
      }),
      "Doctype core.docx": docxOf([{ text: "Annual report 2012" }], {
        coreXml: `<!DOCTYPE x [<!ENTITY e "2019">]>${corePropertiesXml({ created: "2019-03-04T00:00:00Z" })}`,
      }),
      "Zero date.xlsx": xlsxOf([{ name: "Data", rows: [["Annual report 2012"]] }], {
        coreXml: corePropertiesXml({ created: "1970-01-01T00:00:00Z" }),
      }),
    });

    expect(documents.map((document) => [document.status, document.failure])).toEqual(
      documents.map(() => ["ready", null]),
    );
    expect(Object.values(dates)).toEqual(documents.map(() => "2012"));
  });

  test("a file's new version brings its own creation date", async () => {
    const sources = await createSourceFolder();
    const core = startCore(await createTempDataFolder());
    const first = buildPdf([{ lines: ["Tides"] }], { info: { CreationDate: "D:20190304" } });
    const second = buildPdf([{ lines: ["Tides, rewritten"] }], {
      info: { CreationDate: "D:20210506" },
    });
    const path = await writeSourceFile(sources, "Tides.pdf", first);
    const [before] = await addAndProcess(core, [path]);
    if (!before) throw new Error("Nothing was added.");
    expect(before.creationDate).toBe("2019-03-04");

    await writeFile(path, second);
    await core.reconcileDocuments();
    const [after] = await waitForProcessing(core, [before.id]);

    expect(after).toMatchObject({ contentHash: sha256(second), creationDate: "2021-05-06" });
  });
});

/** The built-in model's vector of a Passage: 384 float32s. */
const vector = () => {
  const values = new Float32Array(384);
  values[0] = 1;
  return new Uint8Array(values.buffer);
};

interface Existing {
  id: string;
  file: string;
  kind: DocumentKind;
  contents: string | Uint8Array;
  /** Its Units' text, as processing stored them. */
  units: string[];
}

/**
 * A data folder from before migration 24: Documents processed by this
 * pipeline and embedded, with their Units and Passages, but no creation
 * date read. Each Unit is one Passage.
 */
async function beforeCreationDates(existing: readonly Existing[]): Promise<string> {
  const dataDir = await createTempDataFolder();
  const sources = await createSourceFolder();
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    migrate(
      db,
      migrations.filter((migration) => migration.version < 24),
    );
    const at = "2026-10-01T09:00:00.000Z";
    for (const document of existing) {
      const path = await writeSourceFile(sources, document.file, document.contents);
      const info = await stat(path);
      const hash = sha256(document.contents);
      db.run(
        `INSERT INTO documents (id, content_hash, name, kind, size, status, page_count, path,
           file_status, file_mtime_ms, processing_version, embedding_model, embedding_dimensions,
           tagging_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, 'available', ?, ?, 'multilingual-e5-small-int8',
           384, 'tagged', ?, ?)`,
        [
          document.id,
          hash,
          document.file,
          document.kind,
          info.size,
          document.kind === "pdf" ? BigInt(document.units.length) : null,
          path,
          info.mtimeMs,
          BigInt(PROCESSING_VERSION),
          at,
          at,
        ],
      );
      document.units.forEach((text, index) => {
        const page = BigInt(index + 1);
        db.run(
          `INSERT INTO passages (id, document_id, content_hash, position, page_from, page_to,
             window_from, window_to, text, embedding, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
          [
            `${document.id}-passage-${page}`,
            document.id,
            hash,
            page,
            page,
            page,
            text,
            vector(),
            at,
            at,
          ],
        );
        db.run(
          `INSERT INTO document_pages (id, document_id, content_hash, page, kind, text, created_at,
             updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `${document.id}-unit-${page}`,
            document.id,
            hash,
            page,
            document.kind === "pdf" ? "page" : "section",
            text,
            at,
            at,
          ],
        );
      });
    }
  } finally {
    db.close();
  }
  return dataDir;
}

describe("Existing Documents get their creation date once, in the background", {
  timeout: 30_000,
}, () => {
  test("a metadata job reads it for each, extracting nothing and embedding nothing", async () => {
    const dataDir = await beforeCreationDates([
      {
        id: "d1",
        file: "Survey.pdf",
        kind: "pdf",
        contents: buildPdf([{ lines: ["Coastal survey"] }], {
          info: { CreationDate: "D:20190304103000+01'00'" },
        }),
        units: ["Coastal survey"],
      },
      {
        id: "d2",
        file: "Coastal Flood Risk Review.docx",
        kind: "docx",
        contents: fixture("Coastal Flood Risk Review.docx"),
        units: ["Coastal Flood Risk Review", "1 Introduction"],
      },
      {
        id: "d3",
        file: "Annual review.md",
        kind: "markdown",
        contents: "# Annual review 2021\n\nCompared with 2019.\n\n# Outlook\n\nTargets for 2025.\n",
        units: ["# Annual review 2021\n\nCompared with 2019.", "# Outlook\n\nTargets for 2025."],
      },
      {
        id: "d4",
        file: "Tides.pdf",
        kind: "pdf",
        contents: buildPdf([{ lines: ["A survey of tides"] }, { lines: ["Written in 2015"] }]),
        units: ["A survey of tides", "Written in 2015"],
      },
    ]);
    const stored = () => ({
      passages: queryDatabase(
        dataDir,
        `SELECT id, document_id, content_hash, text, embedding, deleted_at FROM passages ORDER BY id`,
      ),
      // The Units as stored; `version_at` is their version's own moment, which this job leaves alone.
      units: queryDatabase(
        dataDir,
        `SELECT id, document_id, content_hash, page, kind, label, anchors, text, created_at,
           updated_at, deleted_at FROM document_pages ORDER BY id`,
      ),
      versions: queryDatabase(
        dataDir,
        `SELECT id, content_hash, status, processing_version, embedding_model, embedding_dimensions
         FROM documents ORDER BY id`,
      ),
    });
    const before = stored();
    const embedder = createControlledEmbedder();

    const core = startCore(dataDir, { embedder });
    const events: [string, Document["status"]][] = [];
    core.on("document.status", (document) => events.push([document.id, document.status]));
    await vi.waitFor(
      () =>
        expect(
          queryDatabase(dataDir, "SELECT id FROM documents WHERE metadata_version < ?", [
            BigInt(METADATA_VERSION),
          ]),
        ).toEqual([]),
      { timeout: 15_000, interval: 25 },
    );

    const documents = await core.listDocuments();
    expect(
      Object.fromEntries(documents.map((document) => [document.id, document.creationDate])),
    ).toEqual({
      d1: "2019-03-04T10:30:00+01:00",
      d2: "2026-10-07T16:05:26.116Z",
      d3: "2021",
      d4: null,
    });
    // Nothing was extracted, embedded or processed again: the Passages, their
    // vectors and the Units are the ones stored, and no status changed.
    expect(embedder.texts).toEqual([]);
    expect(stored()).toEqual(before);
    expect(events.every(([, status]) => status === "ready")).toBe(true);
    // Each Document whose date or title (#213) was found was pushed with it.
    expect(events.map(([id]) => id).sort()).toEqual(["d1", "d2", "d3", "d4"]);

    // Once: the next start reads nothing again.
    const written = queryDatabase(dataDir, "SELECT id, updated_at FROM documents ORDER BY id");
    core.close();
    const again = startCore(dataDir, { embedder });
    const later: string[] = [];
    again.on("document.status", (document) => later.push(document.id));
    expect((await again.listDocuments()).map((document) => document.creationDate)).toEqual(
      documents.map((document) => document.creationDate),
    );
    // The processor takes jobs in the order queued: once a Document added now is ready, any job
    // the start would have queued has run.
    const [control] = await addAndProcess(again, [
      await writeSourceFile(await createSourceFolder(), "Control.md", "Nothing to do with them."),
    ]);
    expect(later.filter((id) => id !== control?.id)).toEqual([]);
    expect(
      queryDatabase<{ id: string }>(
        dataDir,
        "SELECT id, updated_at FROM documents ORDER BY id",
      ).filter((row) => row.id !== control?.id),
    ).toEqual(written);
    expect(embedder.texts).toEqual([]);
  });
});

describe("A placeholder date is never a Document's date (#821)", () => {
  test("midnight on 1 January 2000, like the other zero dates, isn't taken", () => {
    expect(isPlaceholderDate("2000-01-01")).toBe(true);
    expect(isPlaceholderDate("2000-01-01T00:00:00Z")).toBe(true);
    expect(isPlaceholderDate("2000-01-02")).toBe(false);
    expect(creationDate(["2000-01-01T00:00:00Z", "2019-03-04"], null, 2026)).toBe("2019-03-04");
    expect(creationDate(["2000-01-01"], null, 2026)).toBeNull();
  });
});
