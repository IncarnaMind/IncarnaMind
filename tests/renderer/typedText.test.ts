/**
 * The words typed in a slide's text box, drawn in its place while their write is on its way
 * (#149): numbered run for run as the deck's patch writes them, so an edit made on them names
 * the file's runs and each run keeps its own look on disk.
 */
import { describe, expect, test } from "vitest";
import {
  drawPptx,
  type Item,
  type SlideDrawing,
  type TextBody,
} from "../../src/core/documents/formats/pptxDrawing";
import { applyShapeEdits } from "../../src/core/exports/pptxPatch/edits";
import type { EditedParagraph, ShapeEdit } from "../../src/core/exports/pptxPatch/shapeEdit";
import { typedText } from "../../src/renderer/src/viewer/slides/editedText";
import { pptxOf, sp, txBody, xfrm } from "../helpers/pptx";

const ROOT_RELS = {
  name: "_rels/.rels",
  data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
};

/** A run of text, bold or not; "" makes a run with no text, as PowerPoint leaves some. */
const r = (text: string, bold = false) =>
  `<a:r><a:rPr lang="en-GB"${bold ? ` b="1"` : ""}/><a:t>${text}</a:t></a:r>`;
const BREAK = `<a:br><a:rPr lang="en-GB"/></a:br>`;

const boxDeck = (paragraphs: string) =>
  new Uint8Array(
    pptxOf({
      slides: [
        {
          shapes: sp({
            id: 5,
            name: "Words",
            txBox: true,
            spPr: xfrm(914400, 914400, 6400800, 1828800),
            body: txBody(paragraphs),
          }),
        },
      ],
      parts: [ROOT_RELS],
    }),
  );

const tableDeck = (cell: string) =>
  new Uint8Array(
    pptxOf({
      slides: [
        {
          shapes: `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="457200"/><a:ext cx="4000000" cy="400000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="4000000"/></a:tblGrid><a:tr h="400000"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${cell}</a:txBody><a:tcPr/></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
        },
      ],
      parts: [ROOT_RELS],
    }),
  );

async function textOf(bytes: Uint8Array): Promise<TextBody> {
  const slide = (await drawPptx(bytes)).slides[0] as SlideDrawing;
  const item = slide.items[0] as Item;
  if (item.kind === "shape" && item.text) return item.text;
  if (item.kind === "table" && item.rows[0]?.cells[0]) return item.rows[0].cells[0].text;
  throw new Error("no text");
}

/** Each paragraph's runs as numbered, with their text, break and boldness. */
const numbered = (body: TextBody) =>
  body.paragraphs.map((paragraph) =>
    paragraph.runs.map((run, at) => [at, run.lineBreak ? "\n" : run.text, run.bold]),
  );

/** The stand-in, against the file the same edit writes, drawn back. */
async function compare(bytes: Uint8Array, edited: EditedParagraph[], cell = false) {
  const edit: ShapeEdit = cell
    ? { kind: "cell", slide: 1, shape: "7", row: 0, column: 0, paragraphs: edited }
    : { kind: "text", slide: 1, shape: "5", paragraphs: edited };
  const before = await textOf(bytes);
  const standIn = typedText(before, edited);
  const written = await textOf(await applyShapeEdits(bytes, [edit]));
  if (!standIn) throw new Error("no stand-in");
  return { standIn: numbered(standIn), written: numbered(written) };
}

const at = (paragraph: number, run: number) => ({ paragraph, run });

describe("Words typed in a box, drawn while their write is on its way", () => {
  // protects=a second edit made on the stand-in names the file's runs, so the run that was bold stays bold on disk (#149 review); fails_when=the stand-in drops a run with no text and numbers the runs after it one lower than the file does; no_claim=the looks of words typed outside any run.
  test.each([
    {
      name: "a run with no text before the typed run",
      bytes: boxDeck(
        `<a:p>${r("")}${r("Revenue grew ")}${r("4 per cent", true)}${r(", checked.")}</a:p>`,
      ),
      edited: [
        {
          source: 0,
          runs: [
            { source: at(0, 1), text: "Revenue grew " },
            { source: at(0, 2), text: "4 per cent" },
            { source: at(0, 3), text: ", checked. Rising" },
          ],
        },
      ],
    },
    {
      name: "a run with no text between",
      bytes: boxDeck(
        `<a:p>${r("Revenue grew ")}${r("")}${r("4 per cent", true)}${r(", checked.")}</a:p>`,
      ),
      edited: [
        {
          source: 0,
          runs: [
            { source: at(0, 0), text: "Revenue grew " },
            { source: at(0, 2), text: "4 per cent" },
            { source: at(0, 3), text: ", checked. Rising" },
          ],
        },
      ],
    },
    {
      name: "a run with no text after",
      bytes: boxDeck(
        `<a:p>${r("Revenue grew ")}${r("4 per cent", true)}${r(", checked.")}${r("")}</a:p>`,
      ),
      edited: [
        {
          source: 0,
          runs: [
            { source: at(0, 0), text: "Revenue grew " },
            { source: at(0, 1), text: "4 per cent" },
            { source: at(0, 2), text: ", checked. Rising" },
          ],
        },
      ],
    },
    {
      name: "a line break, and a run with no text after it",
      bytes: boxDeck(`<a:p>${r("Line one")}${BREAK}${r("")}${r("Line two", true)}</a:p>`),
      edited: [
        {
          source: 0,
          runs: [
            { source: at(0, 0), text: "Line one, checked" },
            { source: at(0, 1), text: "\n" },
            { source: at(0, 3), text: "Line two" },
          ],
        },
      ],
    },
    {
      name: "a paragraph made by Enter, after one kept in place",
      bytes: boxDeck(
        `<a:p>${r("")}${r("Revenue grew ")}${r("4 per cent", true)}${r(", checked.")}</a:p>`,
      ),
      edited: [
        {
          source: 0,
          runs: [
            { source: at(0, 1), text: "Revenue grew " },
            { source: at(0, 2), text: "4 per cent" },
            { source: at(0, 3), text: ", checked." },
          ],
        },
        { source: null, runs: [{ source: at(0, 3), text: "Rising" }] },
      ],
    },
    {
      name: "a paragraph written anew, its runs changed",
      bytes: boxDeck(
        `<a:p>${r("")}${r("Revenue grew ")}${r("4 per cent", true)}${r(", checked.")}</a:p>`,
      ),
      edited: [
        {
          source: 0,
          runs: [
            { source: at(0, 2), text: "4 per cent" },
            { source: at(0, 1), text: " revenue growth" },
          ],
        },
      ],
    },
  ])("is numbered as the file numbers it: $name", async ({ bytes, edited }) => {
    const { standIn, written } = await compare(bytes, edited);
    expect(standIn).toEqual(written);
  });

  // protects=a table cell's typed words are numbered as the file numbers them (#149 review); fails_when=the cell's stand-in drops its run with no text; no_claim=none.
  test("in a table cell, is numbered as the file numbers it", async () => {
    const { standIn, written } = await compare(
      tableDeck(`<a:p>${r("")}${r("Total ")}${r("149,700", true)}</a:p>`),
      [
        {
          source: 0,
          runs: [
            { source: at(0, 1), text: "Total visits " },
            { source: at(0, 2), text: "149,700" },
          ],
        },
      ],
      true,
    );
    expect(standIn).toEqual(written);
  });

  // protects=after two edits, the second made on the stand-in, the run that was bold in the file is the run that is bold on disk (#149 review); fails_when=the second edit names the runs one lower, and bold moves to the words after it; no_claim=PowerPoint's drawing.
  test("a second edit made on it keeps each run's look on disk", async () => {
    const bytes = boxDeck(
      `<a:p>${r("")}${r("Revenue grew ")}${r("4 per cent", true)}${r(", checked.")}</a:p>`,
    );
    const first: EditedParagraph[] = [
      {
        source: 0,
        runs: [
          { source: at(0, 1), text: "Revenue grew " },
          { source: at(0, 2), text: "4 per cent" },
          { source: at(0, 3), text: ", checked. Rising" },
        ],
      },
    ];
    const standIn = typedText(await textOf(bytes), first);
    if (!standIn) throw new Error("no stand-in");
    // The box opened again on the stand-in: the editor names each run by its place there.
    const second: EditedParagraph[] = [
      {
        source: 0,
        runs: (standIn.paragraphs[0]?.runs ?? []).flatMap((run, place) =>
          run.text === ""
            ? []
            : [
                {
                  source: at(0, place),
                  text: run.text === ", checked. Rising" ? `${run.text} fast` : run.text,
                },
              ],
        ),
      },
    ];
    const written = await applyShapeEdits(
      await applyShapeEdits(bytes, [{ kind: "text", slide: 1, shape: "5", paragraphs: first }]),
      [{ kind: "text", slide: 1, shape: "5", paragraphs: second }],
    );
    const runs = (await textOf(written)).paragraphs[0]?.runs ?? [];
    expect(runs.filter((run) => run.bold).map((run) => run.text)).toEqual(["4 per cent"]);
    expect(runs.map((run) => run.text).join("")).toBe(
      "Revenue grew 4 per cent, checked. Rising fast",
    );
  });
});
