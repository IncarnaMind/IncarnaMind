/**
 * Targeted AI edits to an existing PowerPoint deck (#149 part 2):
 * - `read_deck` reads slides, stable shape ids, text, autofit, tables, chart series, notes, Citations, and `version`.
 * - `propose_deck_changes` changes only the named shapes, cells, notes, or a single named chart series,
 *   keeping every untouched slide and part byte-identical, preserving concurrent hand edits on other shapes,
 *   detecting overflow for every autofit kind, writing Citation tags and workbook cell notes readable by tag name
 *   and relationship type even when parts/rIds are renamed, and never overwriting the User's own original file.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { readDeckStructure } from "../../src/core/decks/readDeck";
import { openPackage } from "../../src/core/documents/formats/zip";
import { chartAgreement, chartSeries } from "../../src/core/exports/pptxPatch/charts";
import { Deck } from "../../src/core/exports/pptxPatch/deck";
import { CITATION_TAG_NAME } from "../../src/core/exports/pptxPatch/deckChanges";
import { Workbook } from "../../src/core/exports/pptxPatch/workbook";
import { buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { addAndProcess } from "../helpers/documents";
import { handOver, started, structured } from "../helpers/handedFiles";
import { para, pptxOf, rel, sp, txBody } from "../helpers/pptx";
import { buildZip } from "../helpers/zip";

const HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
const ROOT_RELS = {
  name: "_rels/.rels",
  data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const rawOf = (bytes: Uint8Array, name: string) => {
  const raw = openPackage(bytes).raw(name);
  return raw ? Buffer.from(raw.data).toString("base64") : null;
};

const partsChanged = (before: Uint8Array, after: Uint8Array) => {
  const original = openPackage(before);
  return original.names().filter((name) => rawOf(before, name) !== rawOf(after, name));
};

function multiSlideDeck(options?: {
  autofit?: "none" | "shrink" | "grow";
  boxHeightEmu?: number;
}): Uint8Array {
  const fit = options?.autofit ?? "none";
  const bodyPr =
    fit === "shrink"
      ? "<a:bodyPr><a:normAutofit/></a:bodyPr>"
      : fit === "grow"
        ? "<a:bodyPr><a:spAutoFit/></a:bodyPr>"
        : "<a:bodyPr><a:noAutofit/></a:bodyPr>";
  const cy = options?.boxHeightEmu ?? 914_400; // 1.0 in
  const shapeA = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="274320"/><a:ext cx="6858000" cy="457200"/></a:xfrm></p:spPr><p:txBody>${bodyPr}<a:lstStyle/>${para("Harbour review")}</p:txBody></p:sp>`;
  const shapeB = `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Summary Box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="914400"/><a:ext cx="2743200" cy="${cy}"/></a:xfrm></p:spPr><p:txBody>${bodyPr}<a:lstStyle/>${para("South quay holds 17 boats.")}</p:txBody></p:sp>`;
  return new Uint8Array(
    pptxOf({
      slides: [
        { shapes: shapeA + shapeB },
        {
          shapes: sp({
            id: 2,
            name: "Slide 2 Body",
            body: txBody(para("Untouched slide two.")),
          }),
        },
        {
          shapes: sp({
            id: 2,
            name: "Slide 3 Body",
            body: txBody(para("Untouched slide three.")),
          }),
        },
      ],
      parts: [ROOT_RELS],
    }),
  );
}

function twoSeriesChartDeck(): Uint8Array {
  const sheet = `${HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>10</v></c><c r="C2"><v>20</v></c></row><row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3"><v>12.5</v></c><c r="C3"><v>25</v></c></row></sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
  const workbook = buildZip([
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
    { name: "xl/worksheets/sheet1.xml", data: sheet },
    {
      name: "xl/sharedStrings.xml",
      data: `${HEAD}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t></t></si><si><t>West</t></si><si><t>East</t></si><si><t>Q1</t></si><si><t>Q2</t></si></sst>`,
    },
  ]);
  const chart = `${HEAD}<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:chart><c:plotArea><c:barChart><c:ser><c:idx val="0"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>West</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>12.5</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser><c:ser><c:idx val="1"/><c:tx><c:strRef><c:f>Sheet1!$C$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>East</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$C$2:$C$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>20</c:v></c:pt><c:pt idx="1"><c:v>25</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart><c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`;
  return new Uint8Array(
    pptxOf({
      slides: [
        {
          shapes: `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Route Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="6000000" cy="4000000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rChart"/></a:graphicData></a:graphic></p:graphicFrame>`,
          rels: rel("rChart", "chart", "../charts/chart1.xml"),
        },
        { shapes: sp({ id: 2, name: "Untouched", body: txBody(para("Second slide stays")) }) },
      ],
      parts: [
        ROOT_RELS,
        { name: "ppt/charts/chart1.xml", data: chart },
        {
          name: "ppt/charts/_rels/chart1.xml.rels",
          data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/Microsoft_Excel_Worksheet.xlsx"/></Relationships>`,
        },
        { name: "ppt/embeddings/Microsoft_Excel_Worksheet.xlsx", data: workbook },
      ],
    }),
  );
}

describe("targeted AI edits on existing PowerPoint decks (#149 part 2)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=hand edits on shape A survive byte-for-byte when an AI proposal on shape B is accepted, untouched slides stay byte-identical, receipt reports exact slide counts, and Undo restores prior bytes (#149 AC #1, #4, #8); fails_when=hand edit is overwritten, untouched slide bytes change, receipt counts are wrong, or Undo fails
  it("preserves concurrent hand edits on shape A when confirming AI's proposal on shape B, keeps untouched slides byte-identical, and supports Undo", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const deckPath = join(files, "Harbour.pptx");
    const initialBytes = multiSlideDeck();
    await writeFile(deckPath, initialBytes);

    const handed = structured<{ fileId: string }>(
      await handOver(agent, { path: deckPath, folderId: coast.id }),
    );

    // Agent reads the deck (accepting handed fileId directly) before the User edits Shape A by hand.
    const readRes = structured<{
      documentId: string;
      version: string;
      slideCount: number;
      slides: Array<{
        slide: number;
        shapes: Array<{ shapeId: string; name: string; text?: string[] }>;
      }>;
    }>(await agent.callTool({ name: "read_deck", arguments: { documentId: handed.fileId } }));
    const documentId = readRes.documentId;
    expect(readRes.slideCount).toBe(3);
    const shapeA = readRes.slides[0]?.shapes.find((s) => s.name === "Title 1");
    const shapeB = readRes.slides[0]?.shapes.find((s) => s.name === "Summary Box");
    expect(shapeA?.shapeId).toBe("2");
    expect(shapeB?.shapeId).toBe("3");

    // Agent proposes an edit to Shape B ("Summary Box").
    const proposed = structured<{
      proposalId: string;
      status: string;
      unchangedSlides: number;
      changedSlides: number;
      hasOverflow: boolean;
    }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId,
          version: readRes.version,
          summary: "Update south quay count",
          changes: [
            {
              kind: "text",
              slide: 1,
              shape: "3",
              paragraphs: ["South quay holds 19 boats."],
            },
          ],
        },
      }),
    );
    expect(proposed.status).toBe("waiting");
    expect(proposed.unchangedSlides).toBe(2);
    expect(proposed.changedSlides).toBe(1);
    expect(proposed.hasOverflow).toBe(false);

    // Meanwhile, User edits Shape A ("Title 1") by hand on the kept deck.
    const docBeforeHand = (await core.listDocuments()).find((each) => each.id === documentId);
    if (!docBeforeHand) throw new Error("Deck document not found.");
    const handResult = await core.editDeck({
      documentId,
      sittingId: null,
      shown: docBeforeHand.contentHash,
      viewer: "test-viewer",
      edits: [
        {
          kind: "text",
          slide: 1,
          shape: "2",
          paragraphs: [
            { source: 0, runs: [{ source: { paragraph: 0, run: 0 }, text: "User hand title" }] },
          ],
        },
      ],
    });
    expect(handResult.kind).toBe("saved");
    if (handResult.kind !== "saved") throw new Error("Expected saved hand edit.");
    const bytesAfterHand = handResult.bytes;

    // User confirms AI's Proposal on Shape B -> Shape A's hand edit must survive AND Shape B updates.
    const accepted = await core.acceptDeckProposal(proposed.proposalId);
    expect(accepted.documentId).toBe(documentId);
    expect(accepted.unchangedSlides).toBe(2);
    expect(accepted.changedSlides).toBe(1);
    expect(accepted.totalSlides).toBe(3);

    const bytesAfterAccept = accepted.bytes;
    const afterStructure = (await readDeckStructure(bytesAfterAccept)).structure;
    const afterA = afterStructure.slides[0]?.shapes.find((s) => s.shapeId === "2");
    const afterB = afterStructure.slides[0]?.shapes.find((s) => s.shapeId === "3");
    expect(afterA?.paragraphs).toEqual(["User hand title"]);
    expect(afterB?.paragraphs).toEqual(["South quay holds 19 boats."]);

    // Untouched slides 2 & 3 and every untouched part stay byte-identical!
    expect(partsChanged(bytesAfterHand, bytesAfterAccept)).toEqual(["ppt/slides/slide1.xml"]);

    // Undo restores the exact bytes before confirming the AI proposal (keeping the hand edit!).
    const undone = await core.undoDeckProposal(accepted.undoId);
    expect(undone.bytes).not.toBeNull();
    expect(sha256(undone.bytes as Uint8Array)).toBe(sha256(bytesAfterHand));
  });

  // protects=accepting an AI deck proposal on a User's own file never overwrites their original file on disk, writing a copy beside it instead (#149 trust rule); fails_when=the User's original .pptx bytes change on disk
  it("never overwrites the User's own .pptx file on disk when confirming an AI proposal", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const userDeckPath = join(files, "Quarterly Research Update.pptx");
    const fixtureBytes = new Uint8Array(
      await readFile(join(process.cwd(), "tests/fixtures/formats/Quarterly Research Update.pptx")),
    );
    await writeFile(userDeckPath, fixtureBytes);
    const [added] = await addAndProcess(core, [userDeckPath]);
    if (!added) throw new Error("Deck was not added.");
    await core.assignDocumentGroup(added.id, coast.id);

    const readRes = structured<{
      version: string;
      slideCount: number;
      slides: Array<{
        slide: number;
        shapes: Array<{ shapeId: string; kind: string; text?: string[] }>;
      }>;
    }>(await agent.callTool({ name: "read_deck", arguments: { documentId: added.id } }));
    const targetShape = readRes.slides[0]?.shapes.find((s) => s.kind === "text");
    if (!targetShape) throw new Error("No text shape in fixture deck.");

    const proposed = structured<{ proposalId: string }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: added.id,
          version: readRes.version,
          summary: "Update title",
          changes: [
            {
              kind: "text",
              slide: 1,
              shape: targetShape.shapeId,
              paragraphs: ["Updated Q4 Brief"],
            },
          ],
        },
      }),
    );

    const accepted = await core.acceptDeckProposal(proposed.proposalId);
    // Original file on disk MUST remain byte-for-byte identical.
    const originalOnDisk = new Uint8Array(await readFile(userDeckPath));
    expect(sha256(originalOnDisk)).toBe(sha256(fixtureBytes));
    expect(accepted.documentId).not.toBe(added.id);
    expect(accepted.originalDocumentId).toBe(added.id);

    // Every untouched part of the real fixture .pptx in the saved copy is byte-identical!
    const copyBytes = accepted.bytes;
    expect(partsChanged(fixtureBytes, copyBytes)).toEqual(["ppt/slides/slide1.xml"]);
  });

  // protects=editing a single named chart series updates both chart XML cache and embedded workbook for that series alone while leaving all other series untouched, and writes Citations as workbook cell notes readable even after renaming part/rId (#149 AC #5, #7); fails_when=another series changes, cache and workbook disagree, or cell notes fail to survive part/rId rename
  it("edits a single named chart series in both XML and workbook without touching other series, and persists Citations across part/rId renames", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const deckPath = join(files, "Routes.pptx");
    await writeFile(deckPath, twoSeriesChartDeck());
    const handed = structured<{ fileId: string }>(
      await handOver(agent, { path: deckPath, folderId: coast.id }),
    );
    const documentId = handed.fileId;

    // Search + mint a real Citation from the paired Folder's source Document.
    const searched = structured<{ passages: Array<{ passageId: string; text: string }> }>(
      await agent.callTool({ name: "search", arguments: { query: "south quay 19 boats" } }),
    );
    const passage = searched.passages[0];
    if (!passage) throw new Error("Expected a passage to cite.");
    const cited = structured<{ citations: Array<{ cite: string | null }> }>(
      await agent.callTool({
        name: "cite",
        arguments: {
          citations: [{ passageId: passage.passageId, quote: "south quay holds 19 boats" }],
        },
      }),
    );
    const citeToken = cited.citations[0]?.cite;
    expect(citeToken).toMatch(/^\[cite:[a-z0-9]+\]$/);

    const readRes = structured<{
      documentId: string;
      version: string;
      slides: Array<{
        slide: number;
        shapes: Array<{
          shapeId: string;
          kind: string;
          series?: Array<{
            index: number;
            name: string | null;
            categories: string[];
            values: Array<number | null>;
          }>;
        }>;
      }>;
    }>(await agent.callTool({ name: "read_deck", arguments: { documentId } }));
    const realDocId = readRes.documentId;
    const chartShape = readRes.slides[0]?.shapes.find((s) => s.kind === "chart");
    expect(chartShape?.series).toEqual([
      {
        index: 0,
        name: "West",
        categories: ["Q1", "Q2"],
        values: [10, 12.5],
        formatCode: "General",
      },
      {
        index: 1,
        name: "East",
        categories: ["Q1", "Q2"],
        values: [20, 25],
        formatCode: "General",
      },
    ]);

    const beforeBytes = new Uint8Array(await readFile(deckPath));
    const proposed = structured<{ proposalId: string }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: realDocId,
          version: readRes.version,
          summary: "Update East series only",
          changes: [
            {
              kind: "chartSeries",
              slide: 1,
              shape: "4",
              series: "East",
              values: [21, 27.5],
              pointCitations: [{ pointIndex: 1, citations: [citeToken] }],
            },
          ],
        },
      }),
    );
    const acceptedChart = await core.acceptDeckProposal(proposed.proposalId);

    const afterBytes = acceptedChart.bytes;
    expect(partsChanged(beforeBytes, afterBytes).sort()).toEqual([
      "ppt/charts/chart1.xml",
      "ppt/embeddings/Microsoft_Excel_Worksheet.xlsx",
    ]);

    const reread = Deck.open(afterBytes);
    const series = await chartSeries(reread, "ppt/charts/chart1.xml");
    // West (series 0) untouched; East (series 1) updated in both cache and workbook.
    expect(series[0]?.points.map((p) => p.value)).toEqual([10, 12.5]);
    expect(series[1]?.points.map((p) => p.value)).toEqual([21, 27.5]);
    expect(await chartAgreement(reread, "ppt/charts/chart1.xml")).toEqual({
      points: 4,
      agreeing: 4,
      differences: [],
    });

    const wbBytes = (await reread.pkg.bytes(
      "ppt/embeddings/Microsoft_Excel_Worksheet.xlsx",
    )) as Uint8Array;
    const wb = Workbook.open(wbBytes);
    expect(await wb.read("Sheet1", ["B2", "B3", "C2", "C3"])).toEqual([10, 12.5, 21, 27.5]);
    const notes = await wb.readNotes("Sheet1");
    expect(notes.C3).toContain("south quay holds 19 boats");

    // Simulate PowerPoint/Keynote renaming the comments part and rId inside the workbook.
    const wbPkg = openPackage(wbBytes);
    const renamedEntries: Array<{ name: string; data: Buffer }> = [];
    for (const name of wbPkg.names()) {
      const data = Buffer.from((await wbPkg.read(name)) as Uint8Array);
      if (name === "xl/comments1.xml") {
        renamedEntries.push({ name: "xl/comments99.xml", data });
      } else if (name === "xl/worksheets/_rels/sheet1.xml.rels") {
        const text = data
          .toString("utf8")
          .replace("../comments1.xml", "../comments99.xml")
          .replace('Id="rId1"', 'Id="rId99"');
        renamedEntries.push({ name, data: Buffer.from(text, "utf8") });
      } else {
        renamedEntries.push({ name, data });
      }
    }
    const renamedWb = Workbook.open(new Uint8Array(buildZip(renamedEntries)));
    const rereadNotes = await renamedWb.readNotes("Sheet1");
    expect(rereadNotes.C3).toContain("south quay holds 19 boats");
  });

  // protects=overflowing text is detected for none/shrink/grow autofit kinds, confirming shrink writes valid normAutofit, confirming grow expands spAutoFit height, and shape Citation tags survive part/rId renaming (#149 AC #6, #7); fails_when=overflow goes undetected, normAutofit/ext are not updated, or Citations vanish when tag parts are renamed
  it("detects text overflow across autofit kinds, applies shrink/grow choices, and reads shape Citation tags across part/rId renames", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);

    const searched = structured<{ passages: Array<{ passageId: string }> }>(
      await agent.callTool({ name: "search", arguments: { query: "south quay 19 boats" } }),
    );
    const cited = structured<{ citations: Array<{ cite: string }> }>(
      await agent.callTool({
        name: "cite",
        arguments: {
          citations: [
            { passageId: searched.passages[0]?.passageId, quote: "south quay holds 19 boats" },
          ],
        },
      }),
    );
    const citeToken = cited.citations[0]?.cite ?? "";

    const longText =
      "South quay holds nineteen boats across two seasonal berths with steady winter freight demand.";

    // 1. Shrink-to-fit on a noAutofit box + inline [cite:...] stripped into INCARNAMIND_CITES tag.
    const shrinkPath = join(files, "OverflowShrink.pptx");
    await writeFile(shrinkPath, multiSlideDeck({ autofit: "none", boxHeightEmu: 420_000 }));
    const shrinkHanded = structured<{ fileId: string }>(
      await handOver(agent, { path: shrinkPath, folderId: coast.id }),
    );
    const shrinkRead = structured<{ documentId: string; version: string }>(
      await agent.callTool({ name: "read_deck", arguments: { documentId: shrinkHanded.fileId } }),
    );
    const shrinkProp = structured<{
      proposalId: string;
      hasOverflow: boolean;
      overflow: Array<{ slide: number; shape: string | null }>;
    }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: shrinkRead.documentId,
          version: shrinkRead.version,
          changes: [
            {
              kind: "text",
              slide: 1,
              shape: "3",
              paragraphs: [`${longText} ${citeToken}`],
            },
          ],
        },
      }),
    );
    expect(shrinkProp.hasOverflow).toBe(true);
    expect(shrinkProp.overflow).toHaveLength(1);
    const waitingShrink = (await core.deckProposals(shrinkRead.documentId))[0];
    expect(waitingShrink?.items[0]?.overflow?.shrinkFit?.fontScale).toBeLessThan(1);
    // Inline [cite:...] token must be stripped from visible slide text.
    expect(waitingShrink?.items[0]?.after).not.toContain("[cite:");

    const acceptedShrink = await core.acceptDeckProposal(shrinkProp.proposalId, { fit: "shrink" });
    const shrunkBytes = acceptedShrink.bytes;
    const slide1Xml = (await openPackage(shrunkBytes).readText("ppt/slides/slide1.xml")) ?? "";
    expect(slide1Xml).toContain("normAutofit");
    expect(slide1Xml).toContain("fontScale=");

    // Citation tag read back by tag name, even after renaming tag part and rId.
    const pkg = openPackage(shrunkBytes);
    const tagPart = pkg.names().find((n) => n.startsWith("ppt/tags/"));
    expect(tagPart).toBeDefined();
    expect(await pkg.readText(tagPart as string)).toContain(CITATION_TAG_NAME);
    const renamedDeckEntries: Array<{ name: string; data: Buffer }> = [];
    for (const name of pkg.names()) {
      const data = Buffer.from((await pkg.read(name)) as Uint8Array);
      if (name === tagPart) {
        renamedDeckEntries.push({ name: "ppt/tags/tag99.xml", data });
      } else if (name === "ppt/slides/_rels/slide1.xml.rels") {
        const text = data
          .toString("utf8")
          .replace(/tags\/tag\d+\.xml/, "tags/tag99.xml")
          .replace(/Id="rId(\d+)"([^>]*relationships\/tags)/, 'Id="rId99"$2');
        renamedDeckEntries.push({ name, data: Buffer.from(text, "utf8") });
      } else if (name === "ppt/slides/slide1.xml") {
        const text = data
          .toString("utf8")
          .replace(/<p:tags r:id="rId\d+"\/>/, '<p:tags r:id="rId99"/>');
        renamedDeckEntries.push({ name, data: Buffer.from(text, "utf8") });
      } else {
        renamedDeckEntries.push({ name, data });
      }
    }
    const renamedStructure = (await readDeckStructure(new Uint8Array(buildZip(renamedDeckEntries))))
      .structure;
    const citedShape = renamedStructure.slides[0]?.shapes.find((s) => s.shapeId === "3");
    expect(citedShape?.citations?.[0]?.quote).toContain("south quay holds 19 boats");

    // 2. Grow-to-fit on a spAutoFit box expands box height.
    const growPath = join(files, "OverflowGrow.pptx");
    await writeFile(growPath, multiSlideDeck({ autofit: "grow", boxHeightEmu: 228_600 }));
    const growHanded = structured<{ fileId: string }>(
      await handOver(agent, { path: growPath, folderId: coast.id }),
    );
    const growRead = structured<{ documentId: string; version: string }>(
      await agent.callTool({ name: "read_deck", arguments: { documentId: growHanded.fileId } }),
    );
    const growProp = structured<{
      proposalId: string;
      hasOverflow: boolean;
    }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: growRead.documentId,
          version: growRead.version,
          changes: [{ kind: "text", slide: 1, shape: "3", paragraphs: [longText] }],
        },
      }),
    );
    expect(growProp.hasOverflow).toBe(true);
    const waitingGrow = (await core.deckProposals(growRead.documentId))[0];
    expect(waitingGrow?.items[0]?.overflow?.growFit?.box.h).toBeGreaterThan(24);
    const acceptedGrow = await core.acceptDeckProposal(growProp.proposalId, { fit: "grow" });
    const grownStructure = (await readDeckStructure(acceptedGrow.bytes)).structure;
    const grownBox = grownStructure.slides[0]?.shapes.find((s) => s.shapeId === "3")?.box;
    expect(grownBox?.h).toBeGreaterThan(24);
  });

  // protects=sending a deck-edit request carries the selected deck, slide, shapeId, shapeName, and text through read_request, and read-only pairings are refused propose_deck_changes (#149 AC #3); fails_when=read_request loses the shape target or a read-only agent can propose deck edits
  it("hands the selected shape to the agent via askAgent(deck-edit) -> read_request and refuses read-only pairings", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const deckPath = join(files, "AskDeck.pptx");
    await writeFile(deckPath, multiSlideDeck());
    const handed = structured<{ fileId: string }>(
      await handOver(agent, { path: deckPath, folderId: coast.id }),
    );
    const readForAsk = structured<{ documentId: string }>(
      await agent.callTool({ name: "read_deck", arguments: { documentId: handed.fileId } }),
    );

    const asked = await core.askAgent({
      pairingId: writer.pairing.id,
      mindId: null,
      ask: {
        kind: "deck-edit",
        documentId: readForAsk.documentId,
        slide: 1,
        shapeId: "3",
        shapeName: "Summary Box",
        text: "South quay holds 17 boats.",
        instruction: "Change 17 to 19",
      },
    });
    expect(asked.kind).toBe("copy");
    if (asked.kind === "copy") expect(asked.text).toContain("Change 17 to 19");

    const req = structured<{ request: string }>(
      await agent.callTool({ name: "read_request", arguments: {} }),
    );
    expect(req.request).toContain(readForAsk.documentId);
    expect(req.request).toContain("slide 1, “Summary Box” (shapeId: 3)");
    expect(req.request).toContain("South quay holds 17 boats.");
    expect(req.request).toContain("propose_deck_changes");

    // Another pairing cannot read a deck handed over by writer (S8).
    const reader = await core.connectAgent({
      client: "claude-code",
      name: "Read-only",
      folderIds: [coast.id],
      propose: false,
    });
    const readOnlyAgent = await connectLegacyAgent(reader.launch);
    const foreignHandedRead = await readOnlyAgent.callTool({
      name: "read_deck",
      arguments: { documentId: readForAsk.documentId },
    });
    expect(foreignHandedRead.isError).toBe(true);

    // On a regular shared Folder deck, a read-only pairing can read_deck, but is refused propose_deck_changes.
    const sharedDeckPath = join(files, "SharedDeck.pptx");
    await writeFile(sharedDeckPath, multiSlideDeck());
    const [sharedDeck] = await addAndProcess(core, [sharedDeckPath]);
    if (!sharedDeck) throw new Error("Shared deck not added.");
    await core.assignDocumentGroup(sharedDeck.id, coast.id);

    const roRead = structured<{ documentId: string; version: string }>(
      await readOnlyAgent.callTool({
        name: "read_deck",
        arguments: { documentId: sharedDeck.id },
      }),
    );
    expect(roRead.version).toBeTruthy();

    const roPropose = await readOnlyAgent.callTool({
      name: "propose_deck_changes",
      arguments: {
        documentId: roRead.documentId,
        version: roRead.version,
        changes: [{ kind: "text", slide: 1, shape: "3", paragraphs: ["Nope"] }],
      },
    });
    expect(roPropose.isError).toBe(true);
  });

  // protects=a deck in another Folder outside the pairing's reach is refused by read_deck, and a non-deck Document is refused (#149); fails_when=out-of-scope decks or non-decks succeed
  it("refuses out-of-scope decks and non-deck Documents", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const other = await core.createLibraryGroup({ name: "Other", description: "" });
    const deckPath = join(files, "Secret.pptx");
    await writeFile(deckPath, multiSlideDeck());
    const [secretDeck] = await addAndProcess(core, [deckPath]);
    if (!secretDeck) throw new Error("Secret deck not added.");
    await core.assignDocumentGroup(secretDeck.id, other.id);

    const outOfScope = await agent.callTool({
      name: "read_deck",
      arguments: { documentId: secretDeck.id },
    });
    expect(outOfScope.isError).toBe(true);

    const textPath = join(files, "Notes.txt");
    await writeFile(textPath, "Plain text, not a deck.");
    const [textDoc] = await addAndProcess(core, [textPath]);
    if (!textDoc) throw new Error("Text doc not added.");
    await core.assignDocumentGroup(textDoc.id, coast.id);
    const notADeck = await agent.callTool({
      name: "read_deck",
      arguments: { documentId: textDoc.id },
    });
    expect(notADeck.isError).toBe(true);
  });

  // protects=when the User edits the same shape an AI proposal targeted, confirming refuses cleanly rather than overwriting the User's hand edit, and rejecting drops the proposal (#149); fails_when=the User's hand edit on the same shape is silently clobbered
  it("refuses to confirm when the same targeted shape changed by hand meanwhile, and supports reject", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const deckPath = join(files, "Conflict.pptx");
    await writeFile(deckPath, multiSlideDeck());
    const handed = structured<{ fileId: string }>(
      await handOver(agent, { path: deckPath, folderId: coast.id }),
    );
    const readRes = structured<{ documentId: string; version: string }>(
      await agent.callTool({ name: "read_deck", arguments: { documentId: handed.fileId } }),
    );
    const proposed = structured<{ proposalId: string }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: readRes.documentId,
          version: readRes.version,
          changes: [{ kind: "text", slide: 1, shape: "3", paragraphs: ["AI replacement"] }],
        },
      }),
    );

    // User edits the SAME shape ("3") by hand before confirming.
    const doc = (await core.listDocuments()).find((each) => each.id === readRes.documentId);
    if (!doc) throw new Error("Deck not found.");
    const handEdit = await core.editDeck({
      documentId: readRes.documentId,
      sittingId: null,
      shown: doc.contentHash,
      viewer: "test-viewer",
      edits: [
        {
          kind: "text",
          slide: 1,
          shape: "3",
          paragraphs: [
            { source: 0, runs: [{ source: { paragraph: 0, run: 0 }, text: "My hand edit on 3" }] },
          ],
        },
      ],
    });
    expect(handEdit.kind).toBe("saved");

    await expect(core.acceptDeckProposal(proposed.proposalId)).rejects.toThrow(
      /changed since|again/i,
    );
    await core.rejectDeckProposal(proposed.proposalId);
    expect(await core.deckProposals(readRes.documentId)).toEqual([]);
  });

  // protects=M2 inline formatting (bold, hyperlinks, fields, line breaks) survives paragraph edits and untouched paragraphs stay byte-identical; fails_when=inline XML runs or fields are flattened or dropped
  it("preserves bold, hyperlinks, fields, and line breaks when editing multi-run paragraphs (M2)", async () => {
    const richBody = `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" b="1"/><a:t>Keep </a:t></a:r><a:r><a:rPr lang="en-US"><a:hlinkClick r:id="rLink1"/></a:rPr><a:t>link</a:t></a:r><a:br/><a:fld id="{11111111-1111-1111-1111-111111111111}" type="slidenum"><a:t>1</a:t></a:fld></a:p><a:p><a:r><a:rPr lang="en-US" b="1"/><a:t>Revenue: </a:t></a:r><a:r><a:rPr lang="en-US"/><a:t>17 boats</a:t></a:r></a:p></p:txBody>`;
    const richDeck = new Uint8Array(
      pptxOf({
        slides: [
          {
            shapes: `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Summary"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="914400"/><a:ext cx="6000000" cy="1800000"/></a:xfrm></p:spPr>${richBody}</p:sp>`,
          },
        ],
        parts: [ROOT_RELS],
      }),
    );
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const deckPath = join(files, "Rich.pptx");
    await writeFile(deckPath, richDeck);
    const handed = structured<{ fileId: string }>(
      await handOver(agent, { path: deckPath, folderId: coast.id }),
    );
    const readRes = structured<{ documentId: string; version: string }>(
      await agent.callTool({ name: "read_deck", arguments: { documentId: handed.fileId } }),
    );
    const proposed = structured<{ proposalId: string }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: readRes.documentId,
          version: readRes.version,
          changes: [
            {
              kind: "text",
              slide: 1,
              shape: "3",
              paragraphs: ["Keep link\n1", "Revenue: 19 boats"],
            },
          ],
        },
      }),
    );
    // Live preview bytes contain the change before confirming while disk stays untouched.
    const previewBytes = await core.deckProposalPreview(proposed.proposalId);
    const previewXml = (await openPackage(previewBytes).readText("ppt/slides/slide1.xml")) ?? "";
    expect(previewXml).toContain("19 boats");
    expect(previewXml).toContain('r:id="rLink1"');
    expect(previewXml).toContain("<a:br");
    expect(previewXml).toContain("<a:fld");
    expect(previewXml).toContain('b="1"');

    const accepted = await core.acceptDeckProposal(proposed.proposalId);
    const slideXml = (await openPackage(accepted.bytes).readText("ppt/slides/slide1.xml")) ?? "";
    expect(slideXml).toContain('r:id="rLink1"');
    expect(slideXml).toContain("<a:br");
    expect(slideXml).toContain("<a:fld");
    expect(slideXml).toContain('b="1"');
    expect(slideXml).toContain("19 boats");
  });

  // protects=M1 sparse chart points align by c:pt/@idx and refuse non-null writes to missing c:pt slots, and M4 preserves the User's own Excel cell note on the same cell (including prefixed comments XML); fails_when=values shift across blank categories or User's cell note is overwritten
  it("aligns sparse chart points, refuses missing c:pt writes (M1), and preserves User's existing Excel cell notes (M4)", async () => {
    const existingComments = `${HEAD}<x:comments xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:authors><x:author>Analyst</x:author></x:authors><x:commentList><x:comment ref="B2" authorId="0"><x:text><x:t>Reviewed with CFO</x:t></x:text></x:comment></x:commentList></x:comments>`;
    const sheet = `${HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>10</v></c></row><row r="3"><c r="A3" t="s"><v>3</v></c></row><row r="4"><c r="A4" t="s"><v>4</v></c><c r="B4"><v>30</v></c></row></sheetData></worksheet>`;
    const workbook = buildZip([
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
      { name: "xl/worksheets/sheet1.xml", data: sheet },
      {
        name: "xl/worksheets/_rels/sheet1.xml.rels",
        data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/></Relationships>`,
      },
      { name: "xl/comments1.xml", data: existingComments },
      {
        name: "xl/sharedStrings.xml",
        data: `${HEAD}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t></t></si><si><t>West</t></si><si><t>Q1</t></si><si><t>Q2</t></si><si><t>Q3</t></si></sst>`,
      },
    ]);
    // Note: Q2 (idx="1") is intentionally missing from c:numCache!
    const chart = `${HEAD}<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:chart><c:plotArea><c:barChart><c:ser><c:idx val="0"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>West</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$4</c:f><c:strCache><c:ptCount val="3"/><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt><c:pt idx="2"><c:v>Q3</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$4</c:f><c:numCache><c:formatCode>0.0%</c:formatCode><c:ptCount val="3"/><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="2"><c:v>30</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart><c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`;
    const sparseDeck = new Uint8Array(
      pptxOf({
        slides: [
          {
            shapes: `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Sparse Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="6000000" cy="4000000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rChart"/></a:graphicData></a:graphic></p:graphicFrame>`,
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
          { name: "ppt/embeddings/Microsoft_Excel_Worksheet.xlsx", data: workbook },
        ],
      }),
    );

    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const deckPath = join(files, "Sparse.pptx");
    await writeFile(deckPath, sparseDeck);
    const handed = structured<{ fileId: string }>(
      await handOver(agent, { path: deckPath, folderId: coast.id }),
    );
    const searched = structured<{ passages: Array<{ passageId: string }> }>(
      await agent.callTool({ name: "search", arguments: { query: "south quay 19 boats" } }),
    );
    const cited = structured<{ citations: Array<{ cite: string }> }>(
      await agent.callTool({
        name: "cite",
        arguments: {
          citations: [
            { passageId: searched.passages[0]?.passageId, quote: "south quay holds 19 boats" },
          ],
        },
      }),
    );
    const citeToken = cited.citations[0]?.cite ?? "";

    const readRes = structured<{
      documentId: string;
      version: string;
      slides: Array<{
        shapes: Array<{
          shapeId: string;
          series?: Array<{ values: Array<number | null>; formatCode?: string | null }>;
        }>;
      }>;
    }>(await agent.callTool({ name: "read_deck", arguments: { documentId: handed.fileId } }));
    const s0 = readRes.slides[0]?.shapes[0]?.series?.[0];
    // Sparse slot idx=1 must be null, NOT shifted to 30!
    expect(s0?.values).toEqual([10, null, 30]);
    expect(s0?.formatCode).toBe("0.0%");

    // Trying to write a non-null value into the missing c:pt slot (idx=1) is refused cleanly.
    const badMissing = await agent.callTool({
      name: "propose_deck_changes",
      arguments: {
        documentId: readRes.documentId,
        version: readRes.version,
        changes: [
          { kind: "chartSeries", slide: 1, shape: "4", series: "West", values: [11, 22, 33] },
        ],
      },
    });
    expect(badMissing.isError).toBe(true);

    // Keeping idx=1 as null succeeds and appends the Citation note to B2 WITHOUT wiping "Reviewed with CFO"!
    const okProp = structured<{ proposalId: string }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: readRes.documentId,
          version: readRes.version,
          changes: [
            {
              kind: "chartSeries",
              slide: 1,
              shape: "4",
              series: "West",
              values: [19, null, 35],
              pointCitations: [{ pointIndex: 0, citations: [citeToken] }],
            },
          ],
        },
      }),
    );
    const accepted = await core.acceptDeckProposal(okProp.proposalId);
    const wbBytes = (await Deck.open(accepted.bytes).pkg.bytes(
      "ppt/embeddings/Microsoft_Excel_Worksheet.xlsx",
    )) as Uint8Array;
    const notes = await Workbook.open(wbBytes).readNotes("Sheet1");
    expect(notes.B2).toContain("Reviewed with CFO");
    expect(notes.B2).toContain("south quay holds 19 boats");
  });

  // protects=S1 subsequent AI edits reuse one working copy without piling up copies, and S2 Undo refuses if the copy was hand-edited since; fails_when=2nd AI edit creates a second copy or Undo silently wipes a later hand edit
  it("reuses one working copy on subsequent edits (S1) and refuses Undo after a later hand edit on the copy (S2)", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const userDeckPath = join(files, "Quarterly.pptx");
    const initial = multiSlideDeck();
    await writeFile(userDeckPath, initial);
    const [added] = await addAndProcess(core, [userDeckPath]);
    if (!added) throw new Error("Deck not added.");
    await core.assignDocumentGroup(added.id, coast.id);

    const read1 = structured<{ version: string }>(
      await agent.callTool({ name: "read_deck", arguments: { documentId: added.id } }),
    );
    const prop1 = structured<{ proposalId: string }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: added.id,
          version: read1.version,
          changes: [{ kind: "text", slide: 1, shape: "3", paragraphs: ["First AI edit"] }],
        },
      }),
    );
    const acc1 = await core.acceptDeckProposal(prop1.proposalId);
    expect(acc1.copyCreated).toBe(true);
    expect(acc1.documentId).not.toBe(added.id);

    // Second AI edit on the working copy reuses it in place (no (2)/(3) pile-up!).
    const readOrigAgain = structured<{ workingCopyDocumentId: string | null }>(
      await agent.callTool({ name: "read_deck", arguments: { documentId: added.id } }),
    );
    expect(readOrigAgain.workingCopyDocumentId).toBe(acc1.documentId);
    const read2 = structured<{ version: string }>(
      await agent.callTool({ name: "read_deck", arguments: { documentId: acc1.documentId } }),
    );
    const prop2 = structured<{ proposalId: string }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: acc1.documentId,
          version: read2.version,
          changes: [{ kind: "text", slide: 1, shape: "3", paragraphs: ["Second AI edit"] }],
        },
      }),
    );
    const acc2 = await core.acceptDeckProposal(prop2.proposalId);
    expect(acc2.copyCreated).toBe(false);
    expect(acc2.documentId).toBe(acc1.documentId);
    // Original file on disk STILL untouched!
    expect(sha256(new Uint8Array(await readFile(userDeckPath)))).toBe(sha256(initial));

    // User hand-edits the working copy -> Undo of acc2 must now be REFUSED (S2)!
    const hand = await core.editDeck({
      documentId: acc1.documentId,
      sittingId: null,
      shown: acc2.contentHash,
      viewer: "test-viewer",
      edits: [
        {
          kind: "text",
          slide: 1,
          shape: "2",
          paragraphs: [
            { source: 0, runs: [{ source: { paragraph: 0, run: 0 }, text: "My copy tweak" }] },
          ],
        },
      ],
    });
    expect(hand.kind).toBe("saved");
    await expect(core.undoDeckProposal(acc2.undoId)).rejects.toThrow(/changed since|undone/i);
  });

  // protects=M3 out-of-reach Citations are masked in read_deck, S8 moving a handed deck out of shared Folders revokes access, S10 stale-version tells the agent to call read_deck again without leaking paths, and S12 off-slide box coordinates are refused; fails_when=restricted citations leak, moved handed deck stays readable, or off-slide box succeeds
  it("masks out-of-reach Citations (M3), revokes moved handed decks (S8), gives agent-facing stale wording (S10), and refuses off-slide boxes (S12)", async () => {
    const { core, coast, writer, files } = await started();
    const other = await core.createLibraryGroup({ name: "PrivateFolder", description: "" });
    const fullAgent = await core.connectAgent({
      client: "claude-code",
      name: "FullWriter",
      folderIds: [coast.id, other.id],
      propose: true,
    });
    const fullClient = await connectLegacyAgent(fullAgent.launch);
    const restrictedClient = await connectLegacyAgent(writer.launch);

    // Add a private Document in `other` (outside `writer`'s reach).
    const secretPath = join(files, "SecretSource.txt");
    await writeFile(secretPath, "Project Falcon revenue reached 88 million.");
    const [secretDoc] = await addAndProcess(core, [secretPath]);
    if (!secretDoc) throw new Error("Secret doc missing.");
    await core.assignDocumentGroup(secretDoc.id, other.id);

    // Add a deck in `coast` (shared with both) and attach a Citation from SecretSource via `fullClient`.
    const deckPath = join(files, "Board.pptx");
    await writeFile(deckPath, multiSlideDeck());
    const [boardDeck] = await addAndProcess(core, [deckPath]);
    if (!boardDeck) throw new Error("Board deck missing.");
    await core.assignDocumentGroup(boardDeck.id, coast.id);

    const searchSecret = structured<{ passages: Array<{ passageId: string }> }>(
      await fullClient.callTool({ name: "search", arguments: { query: "Project Falcon 88" } }),
    );
    const citeSecret = structured<{ citations: Array<{ cite: string }> }>(
      await fullClient.callTool({
        name: "cite",
        arguments: {
          citations: [
            {
              passageId: searchSecret.passages[0]?.passageId,
              quote: "Project Falcon revenue reached 88 million",
            },
          ],
        },
      }),
    );
    const readFull = structured<{ version: string }>(
      await fullClient.callTool({ name: "read_deck", arguments: { documentId: boardDeck.id } }),
    );
    const propCited = structured<{ proposalId: string }>(
      await fullClient.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: boardDeck.id,
          version: readFull.version,
          changes: [
            {
              kind: "text",
              slide: 1,
              shape: "3",
              paragraphs: ["Revenue hit 88 million."],
              citations: [citeSecret.citations[0]?.cite],
            },
          ],
        },
      }),
    );
    const accepted = await core.acceptDeckProposal(propCited.proposalId);

    // Now `restrictedClient` (only reaches `coast`, NOT `other`) reads the copy -> Citation MUST be masked!
    const readRestricted = structured<{
      version: string;
      slides: Array<{
        shapes: Array<{
          shapeId: string;
          citations?: Array<{ restricted?: boolean; quote?: string; documentName?: string }>;
        }>;
      }>;
    }>(
      await restrictedClient.callTool({
        name: "read_deck",
        arguments: { documentId: accepted.documentId },
      }),
    );
    const maskedShape = readRestricted.slides[0]?.shapes.find((s) => s.shapeId === "3");
    expect(maskedShape?.citations?.[0]?.restricted).toBe(true);
    expect(maskedShape?.citations?.[0]?.quote).toBe("");
    expect(JSON.stringify(readRestricted)).not.toContain("Project Falcon");
    expect(JSON.stringify(readRestricted)).not.toContain("SecretSource");

    // S10: Stale version returns an agent-facing "Call read_deck again" error with no file path.
    const staleRes = await restrictedClient.callTool({
      name: "propose_deck_changes",
      arguments: {
        documentId: accepted.documentId,
        version: "0000000000000000",
        changes: [{ kind: "text", slide: 1, shape: "3", paragraphs: ["Stale"] }],
      },
    });
    expect(staleRes.isError).toBe(true);
    expect(JSON.stringify(staleRes)).toContain("read_deck");
    expect(JSON.stringify(staleRes)).not.toContain(files);

    // S12: Off-slide box coordinates are refused.
    const offSlide = await restrictedClient.callTool({
      name: "propose_deck_changes",
      arguments: {
        documentId: accepted.documentId,
        version: readRestricted.version,
        changes: [{ kind: "box", slide: 1, shape: "3", box: { x: 50_000, y: 0, w: 100, h: 50 } }],
      },
    });
    expect(offSlide.isError).toBe(true);

    // S8: Handed-over deck moved out of shared Folder is revoked from originating pairing.
    const movedPath = join(files, "HandedMoved.pptx");
    await writeFile(movedPath, multiSlideDeck({ autofit: "shrink" }));
    const handed = structured<{ fileId: string }>(
      await handOver(restrictedClient, { path: movedPath, folderId: coast.id }),
    );
    const beforeMove = structured<{ documentId: string }>(
      await restrictedClient.callTool({
        name: "read_deck",
        arguments: { documentId: handed.fileId },
      }),
    );
    await core.assignDocumentGroup(beforeMove.documentId, other.id);
    const afterMove = await restrictedClient.callTool({
      name: "read_deck",
      arguments: { documentId: handed.fileId },
    });
    expect(afterMove.isError).toBe(true);
  });

  // protects=confirming a stale proposal drawn on the original deck after its working copy already changed that shape fails with plain, actionable wording pointing the User to the copy (#149); fails_when=Confirm overwrites the copy or surfaces a raw technical error
  it("gives plain wording when confirming an original-tab proposal whose shape already changed in the working copy", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const deckPath = join(files, "OriginalCopyConflict.pptx");
    await writeFile(deckPath, multiSlideDeck());
    const [deck] = await addAndProcess(core, [deckPath]);
    if (!deck) throw new Error("Deck not added.");
    await core.assignDocumentGroup(deck.id, coast.id);

    const read1 = structured<{ documentId: string; version: string }>(
      await agent.callTool({ name: "read_deck", arguments: { documentId: deck.id } }),
    );
    const prop1 = structured<{ proposalId: string }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: deck.id,
          version: read1.version,
          changes: [{ kind: "text", slide: 1, shape: "3", paragraphs: ["First copy edit."] }],
        },
      }),
    );
    const accepted = await core.acceptDeckProposal(prop1.proposalId);
    expect(accepted.documentId).not.toBe(deck.id);

    // Ask again on the original deck targeting the same shape already edited on the working copy.
    const prop2 = structured<{ proposalId: string }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: deck.id,
          version: read1.version,
          changes: [
            { kind: "text", slide: 1, shape: "3", paragraphs: ["Second edit on original."] },
          ],
        },
      }),
    );
    await expect(core.acceptDeckProposal(prop2.proposalId)).rejects.toMatchObject({
      wording: { key: "error.deck.proposalStaleCopy" },
    });
  });
});
