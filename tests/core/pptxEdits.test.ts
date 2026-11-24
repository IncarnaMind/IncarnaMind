/**
 * A person's edits on a drawn slide (src/core/exports/pptxPatch/edits.ts):
 * what each writes into the slide, and that every byte it doesn't write stays.
 */
import { describe, expect, test } from "vitest";
import { drawPptx, type ShapeItem } from "../../src/core/documents/formats/pptxDrawing";
import { openPackage } from "../../src/core/documents/formats/zip";
import { applyShapeEdits } from "../../src/core/exports/pptxPatch/edits";
import type { EditedParagraph } from "../../src/core/exports/pptxPatch/shapeEdit";
import { pptxOf, sp, txBody, xfrm } from "../helpers/pptx";

/** The package's own relationships, which a deck read for writing starts from. */
const ROOT_RELS = {
  name: "_rels/.rels",
  data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
};

const BY_PARAGRAPH = `<p:timing><p:tnLst><p:par><p:cTn id="1"><p:childTnLst><p:anim><p:cBhvr><p:tgtEl><p:spTgt spid="3"><p:txEl><p:pRg st="1" end="1"/></p:txEl></p:spTgt></p:tgtEl></p:cBhvr></p:anim></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;

const RUNS =
  '<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="zh-CN"/><a:t>收入增长</a:t></a:r><a:r><a:rPr lang="zh-CN" b="1"/><a:t>百分之四</a:t></a:r><a:r><a:rPr lang="zh-CN"/><a:t>，已核对</a:t></a:r><a:endParaRPr lang="zh-CN" sz="2000"/></a:p>' +
  '<a:p><a:r><a:rPr lang="en-GB" i="1"/><a:t>Margin held</a:t></a:r></a:p>';

function deck(shapes?: string): Uint8Array {
  return new Uint8Array(
    pptxOf({
      slides: [
        {
          shapes:
            shapes ??
            sp({
              id: 3,
              name: "Body",
              spPr: xfrm(914400, 914400, 4572000, 1828800, 'rot="5400000"'),
              body: txBody(RUNS),
            }) +
              sp({
                id: 4,
                name: "Title",
                ph: '<p:ph type="title"/>',
                body: txBody('<a:p><a:r><a:rPr lang="en-GB"/><a:t>Test Co</a:t></a:r></a:p>'),
              }),
        },
      ],
      parts: [ROOT_RELS],
      layout: {
        shapes: sp({
          id: 2,
          name: "Title",
          ph: '<p:ph type="title"/>',
          spPr: xfrm(457200, 228600, 8229600, 1143000),
          body: txBody("<a:p><a:r><a:t>Click</a:t></a:r></a:p>"),
        }),
      },
    }),
  );
}

const slideXml = async (bytes: Uint8Array) =>
  (await openPackage(bytes).readText("ppt/slides/slide1.xml")) ?? "";

/** What changed between two texts: the stretch of `before` replaced, and what replaced it. */
function difference(before: string, after: string) {
  let start = 0;
  while (start < before.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++;
  }
  return {
    was: before.slice(start, before.length - end),
    now: after.slice(start, after.length - end),
  };
}

const typed = (paragraphs: EditedParagraph[]) => [
  { kind: "text" as const, slide: 1, shape: "3", paragraphs },
];

const runs = (paragraph: number, texts: string[]) =>
  texts.map((text, run) => ({ source: { paragraph, run }, text }));

describe("Typing in a text shape", () => {
  // protects=text typed into a run changes only that run's text; fails_when=the run's or paragraph's properties are rewritten, or other bytes move; no_claim=how PowerPoint lays it out.
  test("changes only the text of the run it was typed into", async () => {
    const bytes = deck();
    const saved = await applyShapeEdits(
      bytes,
      typed([
        { source: 0, runs: runs(0, ["收入增长", "百分之四点二", "，已核对"]) },
        { source: 1, runs: runs(1, ["Margin held"]) },
      ]),
    );
    expect(difference(await slideXml(bytes), await slideXml(saved))).toEqual({
      was: "",
      now: "点二",
    });
  });

  // protects=Enter makes a paragraph with the split one's properties, and text typed outside a run takes the run before it; fails_when=the new paragraph loses its alignment or the text its run's formatting; no_claim=PowerPoint's own choice at a run's edge.
  test("a new paragraph keeps the properties of the one it was split from", async () => {
    const saved = await applyShapeEdits(
      deck(),
      typed([
        { source: 0, runs: runs(0, ["收入增长", "百分"]) },
        {
          source: 0,
          runs: [
            { source: { paragraph: 0, run: 1 }, text: "之四" },
            { source: null, text: "新" },
          ],
        },
        { source: 1, runs: runs(1, ["Margin held"]) },
      ]),
    );
    const xml = await slideXml(saved);
    expect(xml).toContain(
      '<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="zh-CN" b="1"/><a:t>之四</a:t></a:r><a:r><a:rPr lang="zh-CN" b="1"/><a:t>新</a:t></a:r><a:endParaRPr lang="zh-CN" sz="2000"/></a:p>',
    );
    const drawn = await drawPptx(saved);
    const slide = drawn.slides[0];
    const body = slide && "items" in slide ? (slide.items[0] as ShapeItem) : null;
    expect(body?.text?.paragraphs.map((each) => each.runs.map((run) => run.text).join(""))).toEqual(
      ["收入增长百分", "之四新", "Margin held"],
    );
  });

  // protects=a paragraph count change is refused when an animation builds the shape by paragraph; fails_when=the file names paragraphs that are gone; no_claim=rewriting the animation.
  test("can't change the number of paragraphs an animation builds one by one", async () => {
    const bytes = new Uint8Array(
      pptxOf({
        slides: [
          {
            shapes: "",
            raw: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sp({ id: 3, name: "Body", spPr: xfrm(0, 0, 100, 100), body: txBody(RUNS) })}</p:spTree></p:cSld>${BY_PARAGRAPH}</p:sld>`,
          },
        ],
        parts: [ROOT_RELS],
      }),
    );
    await expect(
      applyShapeEdits(
        bytes,
        typed([{ source: 0, runs: runs(0, ["收入增长", "百分之四", "，已核对"]) }]),
      ),
    ).rejects.toThrow(/animated by paragraph/);
  });
});

describe("Moving and sizing a shape", () => {
  // protects=a move writes only the offset, a resize only the extent, rotation kept; fails_when=other attributes or bytes change; no_claim=snapping or guides.
  test("writes only the offset or extent that changed", async () => {
    const bytes = deck();
    const moved = await applyShapeEdits(bytes, [
      { kind: "box", slide: 1, shape: "3", box: { x: 196, y: 96, w: 480, h: 192 } },
    ]);
    expect(await slideXml(moved)).toBe(
      (await slideXml(bytes)).replace(
        '<a:off x="914400" y="914400"/>',
        '<a:off x="1866900" y="914400"/>',
      ),
    );
    const sized = await applyShapeEdits(bytes, [
      { kind: "box", slide: 1, shape: "3", box: { x: 96, y: 96, w: 500, h: 192 } },
    ]);
    const xml = await slideXml(sized);
    expect(xml).toContain(
      '<a:xfrm rot="5400000"><a:off x="914400" y="914400"/><a:ext cx="4762500" cy="1828800"/>',
    );
  });

  // protects=a shape kept twice in mc:AlternateContent moves in both copies; fails_when=PowerPoint (the choice) and other readers (the fallback) show it in two places; no_claim=what each copy draws.
  test("moves both copies of a shape PowerPoint keeps as a choice and its fallback", async () => {
    const copy = (prefix: string) =>
      sp({
        id: 3,
        name: `${prefix} box`,
        spPr: xfrm(914400, 914400, 4572000, 1828800),
        body: txBody(RUNS),
      });
    const bytes = new Uint8Array(
      pptxOf({
        slides: [
          {
            shapes: "",
            raw: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><mc:AlternateContent><mc:Choice Requires="a14">${copy("Choice")}</mc:Choice><mc:Fallback>${copy("Fallback")}</mc:Fallback></mc:AlternateContent></p:spTree></p:cSld></p:sld>`,
          },
        ],
        parts: [ROOT_RELS],
      }),
    );
    const saved = await applyShapeEdits(bytes, [
      { kind: "box", slide: 1, shape: "3", box: { x: 196, y: 96, w: 480, h: 192 } },
      {
        kind: "text",
        slide: 1,
        shape: "3",
        paragraphs: [
          { source: 0, runs: runs(0, ["收入增长", "百分之四", "，已核对！"]) },
          { source: 1, runs: runs(1, ["Margin held"]) },
        ],
      },
    ]);
    const xml = await slideXml(saved);
    expect(xml.match(/<a:off x="1866900" y="914400"\/>/g)).toHaveLength(2);
    expect(xml.match(/，已核对！/g)).toHaveLength(2);
  });

  // protects=a placeholder that takes its place from the layout gets a transform of its own; fails_when=the move is lost or the layout changes; no_claim=the layout's own transform.
  test("gives a placeholder that inherits its place a transform of its own", async () => {
    const bytes = deck();
    const drawn = await drawPptx(bytes);
    const slide = drawn.slides[0];
    const title =
      slide && "items" in slide ? slide.items.find((item) => item.shapeId === "4") : undefined;
    expect(title?.box).toMatchObject({ x: 48, y: 24 });
    const saved = await applyShapeEdits(bytes, [
      { kind: "box", slide: 1, shape: "4", box: { x: 60, y: 30, w: 864, h: 120 } },
    ]);
    expect(await slideXml(saved)).toContain(
      '<p:spPr><a:xfrm><a:off x="571500" y="285750"/><a:ext cx="8229600" cy="1143000"/></a:xfrm></p:spPr>',
    );
    const layout = (bytes: Uint8Array) =>
      openPackage(bytes).raw("ppt/slideLayouts/slideLayout1.xml")?.data;
    expect(Buffer.from(layout(saved) ?? []).equals(Buffer.from(layout(bytes) ?? []))).toBe(true);
  });
});
