/**
 * The PowerPoint patches (src/core/exports/pptxPatch, #1264) on small decks
 * built here: what they write, and that every byte they don't write stays.
 */
import { describe, expect, test } from "vitest";
import { child, descendants, elements, parseXml } from "../../src/core/documents/formats/xml";
import { openPackage } from "../../src/core/documents/formats/zip";
import {
  chartAgreement,
  chartSeries,
  setChartValues,
} from "../../src/core/exports/pptxPatch/charts";
import { Deck } from "../../src/core/exports/pptxPatch/deck";
import { setNotes } from "../../src/core/exports/pptxPatch/notes";
import { setShapeText, tagShape } from "../../src/core/exports/pptxPatch/shapes";
import { addSlide } from "../../src/core/exports/pptxPatch/slides";
import { Workbook } from "../../src/core/exports/pptxPatch/workbook";
import { para, pptxOf, rel, sp, txBody } from "../helpers/pptx";
import { buildZip } from "../helpers/zip";

const HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
const ROOT_RELS = {
  name: "_rels/.rels",
  data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
};
const THEME_RELS = {
  name: "ppt/theme/_rels/theme1.xml.rels",
  data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>`,
};
const TIMING = `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" nodeType="tmRoot"/></p:par></p:tnLst><p:bldLst><p:bldP spid="3" grpId="0" build="p"/></p:bldLst></p:timing>`;
const BY_PARAGRAPH = `<p:timing><p:tnLst><p:par><p:cTn id="1"><p:childTnLst><p:anim><p:cBhvr><p:tgtEl><p:spTgt spid="3"><p:txEl><p:pRg st="1" end="1"/></p:txEl></p:spTgt></p:tgtEl></p:cBhvr></p:anim></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;

function deckBytes(timing = TIMING): Uint8Array {
  const shapes =
    sp({
      id: 2,
      name: "Title 1",
      ph: '<p:ph type="title"/>',
      body: txBody(para("Quarterly review")),
    }) +
    sp({
      id: 3,
      name: "Content 2",
      ph: '<p:ph idx="1"/>',
      body: txBody(
        `<a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-GB" b="1"/><a:t>Revenue grew 3%</a:t></a:r><a:endParaRPr lang="en-GB"/></a:p>${para("Margin held")}`,
      ),
    });
  const raw = `${HEAD}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${timing}</p:sld>`;
  const layout =
    sp({
      id: 2,
      name: "Title 1",
      ph: '<p:ph type="title"/>',
      body: txBody(para("Click to edit")),
    }) +
    sp({
      id: 3,
      name: "Content Placeholder 2",
      ph: '<p:ph idx="1"/>',
      body: txBody(para("Click to edit")),
    }) +
    sp({
      id: 4,
      name: "Date Placeholder 3",
      ph: '<p:ph type="dt" sz="half" idx="10"/>',
      body: txBody(para("")),
    });
  return new Uint8Array(
    pptxOf({
      slides: [
        { shapes: "", raw },
        { shapes: sp({ id: 2, name: "Other", body: txBody(para("Untouched slide")) }) },
      ],
      layout: { shapes: layout, attrs: 'type="obj"' },
      parts: [ROOT_RELS, THEME_RELS],
    }),
  );
}

const rawOf = (bytes: Uint8Array, name: string) => {
  const raw = openPackage(bytes).raw(name);
  return raw && Buffer.from(raw.data).toString("base64");
};

const partsChanged = (before: Uint8Array, after: Uint8Array) => {
  const original = openPackage(before);
  return original.names().filter((name) => rawOf(before, name) !== rawOf(after, name));
};

describe("Saving a deck", () => {
  // protects=a deck saved with no patch keeps every part's stored bytes; fails_when=any part is re-encoded or dropped; no_claim=the ZIP headers around them.
  test("with no edit, every part keeps its bytes", async () => {
    const bytes = deckBytes();
    const saved = await Deck.open(bytes).save();
    expect(partsChanged(bytes, saved)).toEqual([]);
    expect(openPackage(saved).names()).toEqual(openPackage(bytes).names());
  });
});

describe("A shape's text", () => {
  // protects=new text takes the replaced paragraph's own formatting and only that shape's paragraphs change; fails_when=the run loses its bold, or another shape or the animations change; no_claim=how PowerPoint lays the text out.
  test("is written in its paragraphs' formatting, and nothing else on the slide changes", async () => {
    const bytes = deckBytes();
    const deck = Deck.open(bytes);
    await setShapeText(deck, "ppt/slides/slide1.xml", "3", [
      "Revenue grew 4.2% & more",
      "Margin held",
    ]);
    const saved = await deck.save();
    expect(partsChanged(bytes, saved)).toEqual(["ppt/slides/slide1.xml"]);
    const before = (await openPackage(bytes).readText("ppt/slides/slide1.xml")) ?? "";
    const after = (await openPackage(saved).readText("ppt/slides/slide1.xml")) ?? "";
    expect(after).toContain(
      '<a:pPr lvl="0"/><a:r><a:rPr lang="en-GB" b="1"/><a:t>Revenue grew 4.2% &amp; more</a:t></a:r><a:endParaRPr lang="en-GB"/>',
    );
    const outside = (text: string) =>
      text.slice(0, text.indexOf("Content 2")) + text.slice(text.indexOf("</p:spTree>"));
    expect(outside(after)).toBe(outside(before));
    const texts = await Deck.open(saved).textShapes("ppt/slides/slide1.xml");
    expect(texts.map((each) => each.paragraphs)).toEqual([
      ["Quarterly review"],
      ["Revenue grew 4.2% & more", "Margin held"],
    ]);
  });

  // protects=an animation that builds a shape by paragraph keeps pointing at paragraphs that exist; fails_when=the paragraph count changes under it and PowerPoint would repair the file; no_claim=animations of whole shapes.
  test("keeps its paragraph count when an animation builds it by paragraph", async () => {
    const deck = Deck.open(deckBytes(BY_PARAGRAPH));
    await expect(
      setShapeText(deck, "ppt/slides/slide1.xml", "3", ["One paragraph"]),
    ).rejects.toThrow(/animated by paragraph/);
    await setShapeText(deck, "ppt/slides/slide1.xml", "3", ["One", "Two"]);
  });

  // protects=a Citation can be kept on a shape as a tag in a tags part of its own; fails_when=the tag isn't linked from the shape or its part has no content type; no_claim=whether PowerPoint keeps it after an edit (a person checks).
  test("can carry a tag, in a tags part the shape names", async () => {
    const deck = Deck.open(deckBytes());
    const part = await tagShape(deck, "ppt/slides/slide1.xml", "2", {
      INCARNAMIND_CITATION: "c-1",
    });
    const saved = openPackage(await deck.save());
    expect(await saved.readText(part)).toContain('<p:tag name="INCARNAMIND_CITATION" val="c-1"/>');
    expect(await saved.readText("ppt/slides/slide1.xml")).toMatch(
      /<p:nvPr><p:ph type="title"\/><p:custDataLst><p:tags r:id="rId\d+"\/><\/p:custDataLst><\/p:nvPr>/,
    );
    expect(await saved.readText("[Content_Types].xml")).toContain(`PartName="/${part}"`);
  });
});

describe("Speaker notes", () => {
  // protects=the theme copied for a new notes master keeps its relationships, so a background picture it names still resolves; fails_when=the copy names a relationship it doesn't have (the schema check's Sem_InvalidRelationshipId); no_claim=themes in other folders.
  test("copy the theme's relationships with the theme a new notes master gets", async () => {
    const deck = Deck.open(deckBytes());
    await setNotes(deck, "ppt/slides/slide1.xml", ["A note."]);
    const saved = openPackage(await deck.save());
    expect(await saved.readText("ppt/theme/_rels/theme2.xml.rels")).toBe(THEME_RELS.data);
    expect(await saved.readText("ppt/notesMasters/_rels/notesMaster1.xml.rels")).toContain(
      'Target="../theme/theme2.xml"',
    );
  });

  // protects=a slide without notes in a deck without a notes master gets both, linked both ways, and the presentation lists the master in the schema's place; fails_when=a link, content type or list entry is missing; no_claim=how PowerPoint draws the notes page.
  test("make a notes slide, and a notes master when the deck has none", async () => {
    const deck = Deck.open(deckBytes());
    const notes = await setNotes(deck, "ppt/slides/slide1.xml", [
      "Say where the figure comes from.",
    ]);
    await setNotes(deck, "ppt/slides/slide2.xml", ["第二页的备注。"]);
    const saved = openPackage(await deck.save());
    const presentation = (await saved.readText("ppt/presentation.xml")) ?? "";
    expect(presentation).toMatch(
      /<\/p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId\d+"\/><\/p:notesMasterIdLst><p:sldIdLst>/,
    );
    expect(
      saved.names().filter((name) => name.startsWith("ppt/notesMasters/") && name.endsWith(".xml")),
    ).toHaveLength(1);
    expect(await saved.readText(notes)).toContain("Say where the figure comes from.");
    expect(await saved.readText("ppt/slides/_rels/slide1.xml.rels")).toContain("notesSlide1.xml");
    const reread = await Deck.open(await deck.save()).slides();
    expect(reread.map((slide) => slide.notes)).toEqual([
      "ppt/notesSlides/notesSlide1.xml",
      "ppt/notesSlides/notesSlide2.xml",
    ]);
  });
});

describe("A new slide", () => {
  // protects=a slide made from a layout gets one placeholder per layout placeholder but the date, footer and number, follows the layout, and is listed last; fails_when=it copies the layout's positions, misses the list or the layout link; no_claim=PowerPoint's own placeholder prompts.
  test("comes from a layout's placeholders and goes at the end", async () => {
    const deck = Deck.open(deckBytes());
    const part = await addSlide(deck, "ppt/slideLayouts/slideLayout1.xml", {
      title: "要点",
      body: ["收入增长 4.2%", "毛利率 38.6%"],
      language: "zh-CN",
    });
    const saved = await deck.save();
    const slides = await Deck.open(saved).slides();
    expect(slides.map((slide) => slide.part)).toEqual([
      "ppt/slides/slide1.xml",
      "ppt/slides/slide2.xml",
      part,
    ]);
    expect(slides[2]?.layout).toBe("ppt/slideLayouts/slideLayout1.xml");
    const shapes = await Deck.open(saved).textShapes(part);
    expect(shapes.map((shape) => [shape.placeholder?.type, shape.paragraphs])).toEqual([
      ["title", ["要点"]],
      ["body", ["收入增长 4.2%", "毛利率 38.6%"]],
    ]);
    const xml = parseXml((await openPackage(saved).readText(part)) ?? "");
    expect(descendants(xml, "a:xfrm")).toHaveLength(1);
    expect(descendants(xml, "a:rPr")[0]?.attrs.lang).toBe("zh-CN");
  });
});

describe("A chart's data", () => {
  const SHEET = `${HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="3"><v>10</v></c></row><row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3" s="3"><v>12.5</v></c></row></sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
  const workbook = () =>
    buildZip([
      {
        name: "[Content_Types].xml",
        data: `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`,
      },
      {
        name: "xl/workbook.xml",
        data: `${HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      },
      { name: "xl/worksheets/sheet1.xml", data: SHEET },
      {
        name: "xl/sharedStrings.xml",
        data: `${HEAD}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t></t></si><si><t>Revenue</t></si><si><t>Q2</t></si><si><t>Q3</t></si></sst>`,
      },
    ]);
  const chart = `${HEAD}<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:chart><c:plotArea><c:barChart><c:ser><c:idx val="0"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f></c:strRef></c:tx><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>12.5</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart><c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`;
  const deckWithChart = () =>
    new Uint8Array(
      pptxOf({
        slides: [
          {
            shapes: `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Chart 3"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rChart"/></a:graphicData></a:graphic></p:graphicFrame>`,
            rels: rel("rChart", "chart", "../charts/chart1.xml"),
          },
        ],
        parts: [
          ROOT_RELS,
          { name: "ppt/charts/chart1.xml", data: chart },
          {
            name: "ppt/charts/_rels/chart1.xml.rels",
            data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/Microsoft_Excel_Worksheet.xlsx"/></Relationships>`,
          },
          { name: "ppt/embeddings/Microsoft_Excel_Worksheet.xlsx", data: workbook() },
        ],
      }),
    );

  // protects=new values go into both the chart's cache and the cells its formula names, keeping the cells' style; fails_when=one copy is stale, so Edit Data would bring the old numbers back; no_claim=charts linked to another file.
  test("changes in the cache and the embedded workbook together", async () => {
    const bytes = deckWithChart();
    const deck = Deck.open(bytes);
    expect(await chartAgreement(deck, "ppt/charts/chart1.xml")).toMatchObject({
      points: 2,
      agreeing: 2,
    });
    await setChartValues(deck, "ppt/charts/chart1.xml", [[11, 14.75]]);
    const saved = await deck.save();
    const reread = Deck.open(saved);
    expect(
      (await chartSeries(reread, "ppt/charts/chart1.xml"))[0]?.points.map((point) => point.value),
    ).toEqual([11, 14.75]);
    expect(await chartAgreement(reread, "ppt/charts/chart1.xml")).toEqual({
      points: 2,
      agreeing: 2,
      differences: [],
    });
    const cells = Workbook.open(
      (await reread.pkg.bytes("ppt/embeddings/Microsoft_Excel_Worksheet.xlsx")) as Uint8Array,
    );
    expect(await cells.read("Sheet1", ["A2", "B2", "B3"])).toEqual(["Q2", 11, 14.75]);
    expect(partsChanged(bytes, saved).sort()).toEqual([
      "ppt/charts/chart1.xml",
      "ppt/embeddings/Microsoft_Excel_Worksheet.xlsx",
    ]);
  });

  // protects=a note on a chart's cell is written as Excel's legacy note with its drawing, linked from the sheet in the schema's place; fails_when=the sheet doesn't name the drawing or the note's part is missing; no_claim=whether PowerPoint keeps it after an edit (a person checks).
  test("can carry a note on a cell of its workbook", async () => {
    const book = Workbook.open(new Uint8Array(workbook()));
    await book.addNote("Sheet1", "B2", "IncarnaMind", "Source: c-1");
    const saved = openPackage(await book.save());
    const sheet = parseXml((await saved.readText("xl/worksheets/sheet1.xml")) ?? "");
    const names = elements(sheet).map((each) => each.name);
    expect(names.slice(-2)).toEqual(["pageMargins", "legacyDrawing"]);
    expect(child(sheet, "legacyDrawing")).toBeDefined();
    expect(await saved.readText("xl/comments1.xml")).toContain("Source: c-1");
    expect(await saved.readText("xl/drawings/vmlDrawing1.vml")).toContain(
      "<x:Row>1</x:Row><x:Column>1</x:Column>",
    );
  });
});
