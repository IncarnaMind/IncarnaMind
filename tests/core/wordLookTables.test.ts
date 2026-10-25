import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  BLOCK_ID_ATTRIBUTE,
  MIND_WORD_LOOK_FIELD,
  PARAGRAPH_FORMAT_ATTRIBUTE,
  WORD_LOOK_ATTRIBUTE,
  WORD_RUN_MARK,
  type WordCellLook,
  type WordLook,
  type WordParagraphLook,
  type WordRunLook,
} from "../../src/core";
import { WORD_LOOK_VERSION } from "../../src/core/documents/formats/docxLook";
import { setWordSource, wordFingerprint, wordSourceOf } from "../../src/shared/wordFiles";
import { wordLookOf } from "../../src/shared/wordLook";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { unzip } from "../helpers/docx";
import { recordingLog } from "../helpers/log";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { paragraph, run, wordFile } from "../helpers/word";
import { importWordBytes } from "../helpers/wordMinds";

const STYLES = `<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Indented"><w:name w:val="Indented"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:leftChars="200" w:left="100"/></w:pPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="000000"/><w:left w:val="single" w:sz="4" w:color="000000"/><w:bottom w:val="single" w:sz="4" w:color="000000"/><w:right w:val="single" w:sz="4" w:color="000000"/><w:insideH w:val="single" w:sz="4" w:color="000000"/><w:insideV w:val="single" w:sz="4" w:color="000000"/></w:tblBorders></w:tblPr></w:style>
<w:style w:type="table" w:styleId="Report"><w:name w:val="Report"/><w:basedOn w:val="TableGrid"/>
<w:tblStylePr w:type="firstRow"><w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="4472C4"/><w:tcBorders><w:insideV w:val="nil"/></w:tcBorders></w:tcPr></w:tblStylePr>
<w:tblStylePr w:type="lastRow"><w:tcPr><w:tcBorders><w:top w:val="double" w:sz="4" w:color="000000"/></w:tcBorders></w:tcPr></w:tblStylePr>
<w:tblStylePr w:type="firstCol"><w:rPr><w:b/></w:rPr><w:pPr><w:jc w:val="left"/></w:pPr></w:tblStylePr>
<w:tblStylePr w:type="band1Horz"><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/></w:tcPr></w:tblStylePr>
<w:tblStylePr w:type="band1Vert"><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="FFF2CC"/></w:tcPr></w:tblStylePr>
</w:style>`;

const cell = (text: string, tcPr = "") =>
  `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ""}${paragraph(run(text))}</w:tc>`;

function report({ tblLook, rows }: { tblLook?: string; rows: string[][] }): string {
  return `<w:tbl><w:tblPr><w:tblStyle w:val="Report"/>${tblLook ?? ""}</w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="1500"/><w:gridCol w:w="1500"/></w:tblGrid>${rows
    .map((row) => `<w:tr>${row.map((text) => cell(text)).join("")}</w:tr>`)
    .join("")}</w:tbl>`;
}

const FIGURES = [
  ["Region", "Q1", "Q2"],
  ["North", "1", "2"],
  ["South", "3", "4"],
  ["East", "5", "6"],
  ["Total", "9", "12"],
];

interface Cell {
  text: string;
  look: WordCellLook | null;
  paragraph: WordParagraphLook | null;
  run: WordRunLook | null;
  bold: boolean;
}

/** Each cell, with its first paragraph's look and its first text's run look and bold mark. */
function cellsOf(client: MindClient, look: WordLook): Cell[] {
  const found: Cell[] = [];
  readMind(client).descendants((node) => {
    if (node.type.name !== "tableCell" && node.type.name !== "tableHeader") return true;
    const key: unknown = node.attrs[WORD_LOOK_ATTRIBUTE];
    const first = node.firstChild;
    const paragraphKey: unknown = first?.attrs[WORD_LOOK_ATTRIBUTE];
    const paragraph =
      typeof paragraphKey === "string" ? (look.paragraphs[paragraphKey] ?? null) : null;
    const text = first?.firstChild;
    const runKey =
      text?.marks.find((mark) => mark.type.name === WORD_RUN_MARK)?.attrs.k ?? paragraph?.run;
    found.push({
      text: node.textContent,
      look: typeof key === "string" ? (look.cells[key] ?? null) : null,
      paragraph,
      run: typeof runKey === "string" ? (look.runs[runKey] ?? null) : null,
      bold: text?.marks.some((mark) => mark.type.name === "bold") ?? false,
    });
    return false;
  });
  return found;
}

async function imported(body: string, styles = STYLES) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  const mind = await importWordBytes(core, dataDir, wordFile({ styles, body }), {
    name: "Report.docx",
    origin: "own",
  });
  const look = wordLookOf(mind.client.doc);
  if (!look) throw new Error("No look.");
  return { dataDir, core, ...mind, look, cells: cellsOf(mind.client, look) };
}

const byText = (cells: Cell[], text: string) => {
  const found = cells.find((each) => each.text === text);
  if (!found) throw new Error(`No cell "${text}".`);
  return found;
};

describe("a Word table's conditional formatting, as its tblLook picks it", () => {
  test("the heading row, the first column, banded rows and the total row, each over the ones before as in Word", async () => {
    const { look, cells } = await imported(
      report({
        tblLook:
          '<w:tblLook w:val="04E0" w:firstRow="1" w:lastRow="1" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>',
        rows: FIGURES,
      }),
    );

    expect(look.version).toBe(WORD_LOOK_VERSION);
    const region = byText(cells, "Region");
    expect(region.look?.shade).toBe("4472C4");
    expect(region.bold).toBe(true);
    expect(region.run).toMatchObject({ color: "FFFFFF" });
    // insideV "nil" in the heading row hides the lines between its cells, not its outer edges.
    const between = { style: "none", width: 0, color: null, space: 0 };
    expect(region.look?.borders).toEqual({ right: between });
    expect(byText(cells, "Q1").look?.borders).toEqual({ left: between, right: between });
    expect(byText(cells, "Q2").look?.borders).toEqual({ left: between });
    expect(byText(cells, "Q1").bold).toBe(true);

    expect(byText(cells, "North")).toMatchObject({ look: { shade: "D9E2F3" }, bold: true });
    expect(byText(cells, "1").look?.shade).toBe("D9E2F3");
    expect(byText(cells, "1").bold).toBe(false);
    expect(byText(cells, "3").look?.shade).toBeUndefined();
    expect(byText(cells, "5").look?.shade).toBe("D9E2F3");

    for (const text of ["Total", "9", "12"]) {
      expect(byText(cells, text).look?.shade).toBeUndefined();
      expect(byText(cells, text).look?.borders?.top).toMatchObject({ style: "double" });
    }
    expect(byText(cells, "Total").bold).toBe(true);
    expect(byText(cells, "9").bold).toBe(false);
  });

  test("a table with no tblLook takes Word's 04A0: the heading row, the first column and banded rows, not the total row", async () => {
    const { cells } = await imported(report({ rows: FIGURES }));
    expect(byText(cells, "Region").look?.shade).toBe("4472C4");
    expect(byText(cells, "North").bold).toBe(true);
    expect(byText(cells, "1").look?.shade).toBe("D9E2F3");
    expect(byText(cells, "Total").look?.borders?.top).toBeUndefined();
    expect(byText(cells, "Total").look?.shade).toBeUndefined();
  });

  test("with banded rows off and banded columns on, the bands run down instead", async () => {
    const { cells } = await imported(
      report({
        tblLook:
          '<w:tblLook w:firstRow="0" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="1" w:noVBand="0"/>',
        rows: FIGURES,
      }),
    );
    expect(byText(cells, "Region").look?.shade).toBeUndefined();
    expect(byText(cells, "Region").bold).toBe(true);
    expect(byText(cells, "Q1").look?.shade).toBe("FFF2CC");
    expect(byText(cells, "1").look?.shade).toBe("FFF2CC");
    expect(byText(cells, "2").look?.shade).toBeUndefined();
  });

  test("a band size of 0 bands nothing", async () => {
    const { cells } = await imported(
      report({
        tblLook:
          '<w:tblLook w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="0"/><w:tblStyleRowBandSize w:val="0"/><w:tblStyleColBandSize w:val="0"/>',
        rows: FIGURES,
      }),
    );
    for (const text of ["North", "1", "2", "South", "3"]) {
      expect(byText(cells, text).look?.shade, text).toBeUndefined();
    }
  });

  test("cell looks grow with the table's styles and places, never with its rows", async () => {
    const rows = [
      FIGURES[0] ?? [],
      ...Array.from({ length: 60 }, (_, index) => ["Row", `${index}`, "x"]),
    ];
    const { look } = await imported(report({ rows }));
    expect(Object.keys(look.cells).length).toBeLessThanOrEqual(12);
  });
});

describe("a Word table's own lines and widths", () => {
  test("a cell's 'no border' is kept: on the table's edge to hide the table's line, between cells to leave a neighbour's own", async () => {
    const { cells } = await imported(
      `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid><w:tr>${cell("Open", '<w:tcBorders><w:top w:val="nil"/><w:left w:val="none"/></w:tcBorders>')}${cell("Lined")}</w:tr><w:tr>${cell("Below", '<w:tcBorders><w:top w:val="nil"/></w:tcBorders>')}${cell("Beside")}</w:tr></w:tbl>`,
    );
    const noLine = (style: string) => ({ style, width: 0, color: null, space: 0 });
    expect(byText(cells, "Open").look?.borders).toEqual({
      top: noLine("nil"),
      left: noLine("nil"),
    });
    expect(byText(cells, "Below").look?.borders).toEqual({ top: noLine("none") });
    expect(byText(cells, "Lined").look).toBeNull();
  });

  test("every table has a look, even one the file gives nothing, so the Word look draws it", async () => {
    const { client, look } = await imported(
      `<w:tbl><w:tr>${cell("Bare")}</w:tr></w:tbl>${paragraph("After")}`,
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>',
    );
    const keys: unknown[] = [];
    readMind(client).descendants((node) => {
      if (node.type.name === "table") keys.push(node.attrs[WORD_LOOK_ATTRIBUTE]);
      return true;
    });
    const [key] = keys;
    if (typeof key !== "string") throw new Error("The table has no look.");
    expect(look.tables[key]).toEqual({});
  });
});

describe("Word's hang of a table into the margin (#1035)", () => {
  const settings = (mode: number | null) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${
      mode === null
        ? ""
        : `<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="${mode}"/></w:compat>`
    }</w:settings>`;
  const lookFor = async (mode: number | null) => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    try {
      const { client } = await importWordBytes(
        core,
        dataDir,
        wordFile({
          body: `<w:tbl><w:tr>${cell("Dates")}</w:tr></w:tbl>${paragraph("After")}`,
          rels: '<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>',
          parts: [{ name: "word/settings.xml", data: settings(mode) }],
        }),
        { name: "CV.docx", origin: "own" },
      );
      return wordLookOf(client.doc);
    } finally {
      await core.close();
    }
  };

  test("in compatibility mode 14 and lower, and with no mode named, tables hang; from mode 15 they don't", async () => {
    expect((await lookFor(14))?.tablesHang).toBe(true);
    expect((await lookFor(12))?.tablesHang).toBe(true);
    expect((await lookFor(null))?.tablesHang).toBe(true);
    expect((await lookFor(15))?.tablesHang).toBeUndefined();
  });
});

describe("indents in characters", () => {
  test("are in the paragraph's size and win over lengths; 0 characters leaves the length", async () => {
    const { client, look } = await imported(
      [
        paragraph(
          '<w:pPr><w:ind w:firstLineChars="200" w:firstLine="100"/></w:pPr><w:r><w:t>首行缩进两个字</w:t></w:r>',
        ),
        paragraph("Indented by its style", { style: "Indented" }),
        paragraph(
          '<w:pPr><w:pStyle w:val="Indented"/><w:ind w:leftChars="0" w:left="720"/></w:pPr><w:r><w:t>Indented by a length</w:t></w:r>',
        ),
        paragraph(
          '<w:pPr><w:ind w:hangingChars="100"/></w:pPr><w:r><w:t>Hanging one character</w:t></w:r>',
        ),
      ].join(""),
    );
    const looks = new Map<string, WordParagraphLook>();
    const formats = new Map<string, unknown>();
    readMind(client).descendants((node) => {
      const key = node.attrs[WORD_LOOK_ATTRIBUTE];
      if (node.type.name !== "paragraph") return true;
      looks.set(node.textContent, typeof key === "string" ? (look.paragraphs[key] ?? {}) : {});
      formats.set(node.textContent, node.attrs[PARAGRAPH_FORMAT_ATTRIBUTE]);
      return true;
    });
    // A paragraph's own indent in characters stays in characters, measured in its style's size.
    expect(formats.get("首行缩进两个字")).toEqual({ firstLineChars: 2 });
    expect(looks.get("首行缩进两个字")).toMatchObject({ characterSize: 12 });
    expect(looks.get("Indented by its style")).toMatchObject({ left: 24 });
    expect(formats.get("Indented by a length")).toEqual({ left: 36 });
    expect(formats.get("Hanging one character")).toEqual({ firstLineChars: -1 });
  });
});

function findText(blocks: Y.XmlFragment, text: string): Y.XmlText {
  for (const element of blocks.createTreeWalker(() => true)) {
    if (!(element instanceof Y.XmlText)) continue;
    const plain = (element.toDelta() as { insert: unknown }[])
      .map((each) => (typeof each.insert === "string" ? each.insert : ""))
      .join("");
    if (plain.startsWith(text)) return element;
  }
  throw new Error(`No "${text}".`);
}

const documentXml = (bytes: Uint8Array) => unzip(bytes).get("word/document.xml")?.toString() ?? "";

describe("exporting a table with conditional formatting", () => {
  test("untouched, it writes the file's own bytes", async () => {
    const body = report({ rows: FIGURES });
    const { core, mindId } = await imported(body);
    const result = await core.exportMind(mindId, { format: "docx" });
    expect(documentXml(result.data)).toBe(documentXml(wordFile({ styles: STYLES, body })));
  });

  test("a heading-row paragraph edited in a Mind read before conditional formatting keeps the row's bold; the rest is written as it was", async () => {
    const body = report({ rows: FIGURES });
    const { dataDir, core, mindId, client } = await imported(body);
    // As version 2 read and recorded it: no bold from the heading row. Then the User edits one of its cells.
    client.doc.transact(() => {
      for (const text of ["Region", "Q1", "Q2"]) {
        const cell = findText(client.blocks, text);
        cell.format(0, cell.length, { bold: null });
        const paragraph = cell.parent;
        const id =
          paragraph instanceof Y.XmlElement ? paragraph.getAttribute(BLOCK_ID_ATTRIBUTE) : null;
        const source = typeof id === "string" ? wordSourceOf(client.doc, id) : null;
        if (!id || !source || !(paragraph instanceof Y.XmlElement)) throw new Error("No source.");
        setWordSource(client.doc, id, { ...source, f: wordFingerprint(paragraph) });
      }
      const region = findText(client.blocks, "Region");
      region.insert(region.length, ", edited");
      client.doc.getMap(MIND_WORD_LOOK_FIELD).set("version", 2);
    });
    await client.settled();
    core.close();
    queryDatabase(dataDir, "UPDATE word_packages SET look_version = 2 WHERE mind_id = ?", [mindId]);

    const { log, entries } = recordingLog();
    const restarted = startCore(dataDir, { log });
    await connectToMind(restarted, mindId);
    await vi.waitFor(() =>
      expect(entries).toContainEqual(expect.objectContaining({ event: "word.look.done" })),
    );
    const xml = documentXml((await restarted.exportMind(mindId, { format: "docx" })).data);
    expect(xml).not.toContain('w:val="0"');
    expect(xml).toBe(
      documentXml(wordFile({ styles: STYLES, body })).replace(">Region<", ">Region, edited<"),
    );
  });
});
