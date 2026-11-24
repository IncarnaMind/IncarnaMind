/**
 * A person's edits on a drawn slide (src/core/exports/pptxPatch/edits.ts):
 * what each writes into the slide, and that every byte it doesn't write stays.
 */
import { describe, expect, test } from "vitest";
import { parseShapeEdits } from "../../src/core/decks/parse";
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

  // protects=a choice and its fallback that say different words aren't both rewritten with the words the viewer drew (#149 review); fails_when=the Choice's own words are replaced by the Fallback's edit; no_claim=which copy PowerPoint shows.
  test("refuses to type into copies whose words differ, and never edits a second Choice as a copy", async () => {
    const copy = (prefix: string, words: string) =>
      sp({
        id: 3,
        name: `${prefix} box`,
        spPr: xfrm(914400, 914400, 4572000, 1828800),
        body: txBody(`<a:p><a:r><a:rPr lang="en-GB"/><a:t>${words}</a:t></a:r></a:p>`),
      });
    const slide = (inside: string) =>
      new Uint8Array(
        pptxOf({
          slides: [
            {
              shapes: "",
              raw: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${inside}</p:spTree></p:cSld></p:sld>`,
            },
          ],
          parts: [ROOT_RELS],
        }),
      );
    const typed = [
      {
        kind: "text" as const,
        slide: 1,
        shape: "3",
        paragraphs: [{ source: 0, runs: runs(0, ["Forecast."]) }],
      },
    ];
    const differ = slide(
      `<mc:AlternateContent><mc:Choice Requires="a14">${copy("Choice", "Internal forecast")}</mc:Choice><mc:Fallback>${copy("Fallback", "Forecast")}</mc:Fallback></mc:AlternateContent>`,
    );
    await expect(applyShapeEdits(differ, typed)).rejects.toThrow(/don't hold the same runs/);
    const twoChoices = slide(
      `<mc:AlternateContent><mc:Choice Requires="a14">${copy("One", "Forecast")}</mc:Choice><mc:Choice Requires="a14">${copy("Two", "Forecast")}</mc:Choice><mc:Fallback>${copy("Fallback", "Forecast")}</mc:Fallback></mc:AlternateContent>`,
    );
    await expect(applyShapeEdits(twoChoices, typed)).rejects.toThrow(/more than one shape/);
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

/** A slide of its own shapes, its XML whole, so a test names exactly what the file holds. */
const slideOf = (tree: string) =>
  new Uint8Array(
    pptxOf({
      slides: [
        {
          shapes: "",
          raw: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${tree}</p:spTree></p:cSld></p:sld>`,
        },
      ],
      parts: [ROOT_RELS],
    }),
  );

describe("Shapes in a group, table cells and text that follows its box", () => {
  // protects=a shape in a group is moved in the group's own child space; fails_when=the slide's position is written as if the group weren't scaled or moved; no_claim=moving the group itself.
  test("moves a shape inside a scaled group in the group's own space", async () => {
    // The group is drawn at 1 inch from the slide's corner, half the size of its child space.
    const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="5" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="1828800" cy="1828800"/><a:chOff x="0" y="0"/><a:chExt cx="3657600" cy="3657600"/></a:xfrm></p:grpSpPr>${sp({ id: 6, name: "Inner", spPr: xfrm(0, 0, 1828800, 914400) })}</p:grpSp>`;
    const bytes = slideOf(group);
    // On the slide the inner shape starts at 96 px; moved 48 px right on the slide.
    const saved = await applyShapeEdits(bytes, [
      { kind: "box", slide: 1, shape: "6", box: { x: 144, y: 96, w: 96, h: 48 } },
    ]);
    // 48 px on the slide is 96 px, 914400 EMU, in the group's space, which is drawn at half size.
    expect(await slideXml(saved)).toBe(
      (await slideXml(bytes)).replace(
        '<a:off x="0" y="0"/><a:ext cx="1828800" cy="914400"/>',
        '<a:off x="914400" y="0"/><a:ext cx="1828800" cy="914400"/>',
      ),
    );
  });

  // protects=typing in a table cell changes only that cell's run; fails_when=another cell, the grid or the frame changes; no_claim=new rows or columns.
  test("changes only the text of the table cell typed in", async () => {
    const cell = (text: string) =>
      `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-GB"/><a:t>${text}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`;
    const table = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="3657600" cy="731520"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid><a:gridCol w="1828800"/><a:gridCol w="1828800"/></a:tblGrid><a:tr h="365760">${cell("Quay")}${cell("Boats")}</a:tr><a:tr h="365760">${cell("North")}${cell("42")}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const bytes = slideOf(table);
    const saved = await applyShapeEdits(bytes, [
      {
        kind: "cell",
        slide: 1,
        shape: "7",
        row: 1,
        column: 1,
        paragraphs: [{ source: 0, runs: runs(0, ["44"]) }],
      },
    ]);
    expect(difference(await slideXml(bytes), await slideXml(saved))).toEqual({
      was: "2",
      now: "4",
    });
  });

  // protects=a box that grows with its text is written its new height, and one that shrinks its text its font scale and line reduction, as PowerPoint writes them; fails_when=the text runs past its box in PowerPoint; no_claim=PowerPoint's exact line breaks.
  test("writes how a box follows its text: its new height, or its shrink", async () => {
    const box = (autofit: string) =>
      slideOf(
        sp({
          id: 3,
          name: "Body",
          txBox: true,
          spPr: xfrm(914400, 914400, 4572000, 457200),
          body: txBody(RUNS, `<a:bodyPr wrap="square">${autofit}</a:bodyPr>`),
        }),
      );
    const paragraphs = [
      { source: 0, runs: runs(0, ["收入增长", "百分之四", "，已核对"]) },
      { source: 1, runs: runs(1, ["Margin held, and more"]) },
    ];
    const grown = await applyShapeEdits(box("<a:spAutoFit/>"), [
      {
        kind: "text",
        slide: 1,
        shape: "3",
        paragraphs,
        fit: { kind: "grow", box: { x: 96, y: 96, w: 480, h: 96 } },
      },
    ]);
    expect(await slideXml(grown)).toContain('<a:ext cx="4572000" cy="914400"/>');
    // A fit measured on the box where it was drawn before a move landed keeps the file's place.
    const stale = await applyShapeEdits(grown, [
      {
        kind: "text",
        slide: 1,
        shape: "3",
        paragraphs,
        fit: { kind: "grow", box: { x: 10, y: 20, w: 300, h: 120 } },
      },
    ]);
    expect(await slideXml(stale)).toContain(
      '<a:off x="914400" y="914400"/><a:ext cx="4572000" cy="1143000"/>',
    );
    const shrunk = await applyShapeEdits(box(""), [
      {
        kind: "text",
        slide: 1,
        shape: "3",
        paragraphs,
        fit: { kind: "shrink", fontScale: 0.775, lineReduction: 0.1 },
      },
    ]);
    expect(await slideXml(shrunk)).toContain(
      '<a:bodyPr wrap="square"><a:normAutofit fontScale="77500" lnSpcReduction="10000"/></a:bodyPr>',
    );
    // A box that said it doesn't fit its text takes the shrink in place of that: the two are one choice.
    for (const was of ["<a:noAutofit/>", "<a:spAutoFit/>"]) {
      const replaced = await applyShapeEdits(box(was), [
        {
          kind: "text",
          slide: 1,
          shape: "3",
          paragraphs,
          fit: { kind: "shrink", fontScale: 0.775, lineReduction: 0.1 },
        },
      ]);
      expect(await slideXml(replaced)).toContain(
        '<a:bodyPr wrap="square"><a:normAutofit fontScale="77500" lnSpcReduction="10000"/></a:bodyPr>',
      );
    }
    const drawn = await drawPptx(shrunk);
    const slide = drawn.slides[0];
    const body = slide && "items" in slide ? (slide.items[0] as ShapeItem) : null;
    expect(body?.text?.autofit).toEqual({ kind: "shrink", fontScale: 0.775, lineReduction: 0.1 });
  });
});

describe("A gesture's edits as the window sends them", () => {
  // protects=the core checks every edit before making any; fails_when=a malformed edit reaches the file; no_claim=what the window means by it.
  test("are refused when malformed, and taken as they are when sound", () => {
    const sound = [
      { kind: "box", slide: 1, shape: "3", box: { x: 1, y: 2, w: 3, h: 4 } },
      {
        kind: "text",
        slide: 1,
        shape: "3",
        paragraphs: [{ source: null, runs: [{ source: null, text: "新" }] }],
        fit: { kind: "shrink", fontScale: 0.5, lineReduction: 0.2 },
      },
    ];
    expect(parseShapeEdits(sound)).toEqual(sound);
    for (const bad of [
      [],
      [{ kind: "box", slide: 1, shape: "3; drop", box: { x: 1, y: 2, w: 3, h: 4 } }],
      [{ kind: "box", slide: -1, shape: "3", box: { x: 1, y: 2, w: 3, h: 4 } }],
      [{ kind: "box", slide: 1, shape: "3", box: { x: 1, y: 2, w: -3, h: 4 } }],
      [
        {
          kind: "text",
          slide: 1,
          shape: "3",
          paragraphs: [],
          fit: { kind: "shrink", fontScale: 2, lineReduction: 0 },
        },
      ],
      [{ kind: "picture", slide: 1, shape: "3" }],
    ]) {
      expect(() => parseShapeEdits(bad)).toThrow();
    }
  });
});

describe("Two shapes that share an id", () => {
  // protects=shapes that happen to share a cNvPr id are never edited as one (#149 review); fails_when=typing in one box rewrites the other; no_claim=which of them PowerPoint keeps if it renumbers.
  test("are never edited as one: the edit is refused, and neither is offered for editing", async () => {
    const box = (name: string, words: string, y: number) =>
      sp({
        id: 3,
        name,
        spPr: xfrm(914400, y, 4572000, 457200),
        body: txBody(`<a:p><a:r><a:rPr lang="en-GB"/><a:t>${words}</a:t></a:r></a:p>`),
      });
    const bytes = slideOf(
      box("First", "North quay", 914400) + box("Second", "South quay", 2743200),
    );
    await expect(
      applyShapeEdits(bytes, [
        {
          kind: "text",
          slide: 1,
          shape: "3",
          paragraphs: [{ source: 0, runs: runs(0, ["North quay, dredged"]) }],
        },
      ]),
    ).rejects.toThrow(/more than one shape/);
    const drawn = await drawPptx(bytes);
    const slide = drawn.slides[0];
    const ids = slide && "items" in slide ? slide.items.map((item) => item.shapeId) : [];
    expect(ids).toEqual([undefined, undefined]);
  });
});
