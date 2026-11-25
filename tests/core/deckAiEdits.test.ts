/**
 * Targeted AI edits to an existing PowerPoint deck (#149 part 2):
 * - `read_deck` reads slides, stable shape ids, text, autofit, tables, chart series, notes, Citations, and `version`.
 * - `propose_deck_changes` changes only the named shapes, cells, notes, or a single named chart series,
 *   keeping every untouched slide and part byte-identical, preserving concurrent hand edits on other shapes,
 *   detecting overflow for every autofit kind, writing Citation tags and workbook cell notes readable by tag name
 *   and relationship type even when parts/rIds are renamed, writing the confirmed change to the file itself
 *   atomically after keeping the original on disk (surviving restart), and refusing cleanly when locked or changed.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createNodeDeckFiles } from "../../src/core/decks/places";
import { createDeckProposals } from "../../src/core/decks/proposals";
import { readDeckStructure } from "../../src/core/decks/readDeck";
import { openPackage } from "../../src/core/documents/formats/zip";
import { chartAgreement, chartSeries } from "../../src/core/exports/pptxPatch/charts";
import { Deck } from "../../src/core/exports/pptxPatch/deck";
import { CITATION_TAG_NAME } from "../../src/core/exports/pptxPatch/deckChanges";
import { Workbook } from "../../src/core/exports/pptxPatch/workbook";
import { buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { addAndProcess } from "../helpers/documents";
import { handOver, started, structured } from "../helpers/handedFiles";
import { para, pptxOf, rel, sp, txBody, xfrm } from "../helpers/pptx";
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
            spPr: xfrm(457_200, 914_400, 6_000_000, 914_400),
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

  // protects=confirming an AI deck proposal on a User's own file keeps the original untouched before Confirm, writes only the changed part into the file itself on Confirm with zero copies created, and keeps the original for one-step Put back (#149); fails_when=bytes change before Confirm, extra copies are created, or untouched slides/parts change
  it("writes the User's own .pptx file in place with no copies when confirming an AI proposal", async () => {
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

    // Original file on disk MUST remain byte-for-byte identical BEFORE Confirm.
    expect(sha256(new Uint8Array(await readFile(userDeckPath)))).toBe(sha256(fixtureBytes));

    const accepted = await core.acceptDeckProposal(proposed.proposalId);
    // Confirmed AI change writes the User's own file in place (no copy beside it) and keeps original.
    expect(accepted.documentId).toBe(added.id);
    expect(accepted.saved.kind).toBe("file");
    if (accepted.saved.kind === "file") expect(accepted.saved.keptId).toBeTruthy();

    const writtenOnDisk = new Uint8Array(await readFile(userDeckPath));
    expect(sha256(writtenOnDisk)).toBe(sha256(accepted.bytes));
    // No extra copy was created in the User's folder or Library.
    expect((await readdir(files)).filter((name) => name.endsWith(".pptx"))).toEqual([
      "Quarterly Research Update.pptx",
    ]);
    expect((await core.listDocuments()).filter((d) => d.kind === "pptx")).toHaveLength(1);

    // Every untouched part of the real fixture .pptx on disk is byte-identical!
    expect(partsChanged(fixtureBytes, writtenOnDisk)).toEqual(["ppt/slides/slide1.xml"]);
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

    // Citation tag stores ids only (no Document name or quote enters the .pptx) and survives tag part/rId renames.
    const pkg = openPackage(shrunkBytes);
    const tagPart = pkg.names().find((n) => n.startsWith("ppt/tags/"));
    expect(tagPart).toBeDefined();
    const rawTagXml = (await pkg.readText(tagPart as string)) ?? "";
    expect(rawTagXml).toContain(CITATION_TAG_NAME);
    expect(rawTagXml).not.toContain("Harbour survey");
    expect(rawTagXml).not.toContain("south quay holds 19 boats");
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
    expect(citedShape?.citations?.[0]?.documentId).toBeTruthy();
    expect(citedShape?.citations?.[0]?.passageId).toBe(searched.passages[0]?.passageId);
    // Agent read_deck hydrates Document name and passage text from the index when in reach.
    const rereadAfterShrink = structured<{
      slides: Array<{
        shapes: Array<{
          shapeId: string;
          citations?: Array<{ document: string; quote: string }>;
        }>;
      }>;
    }>(
      await agent.callTool({ name: "read_deck", arguments: { documentId: shrinkRead.documentId } }),
    );
    const hydratedShape = rereadAfterShrink.slides[0]?.shapes.find((s) => s.shapeId === "3");
    expect(hydratedShape?.citations?.[0]?.document).toContain("Harbour survey");
    expect(hydratedShape?.citations?.[0]?.quote).toContain("south quay holds 19 boats");

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

  // protects=subsequent confirmed AI edits keep writing the User's own deck in place without creating copies, keep both the first and latest pre-edit states, and refuse Undo after a later hand edit (S2); fails_when=copies pile up, kept states are lost, or Undo silently wipes a later hand edit
  it("writes subsequent AI edits to the deck itself with no copies and refuses Undo after a later hand edit (S2)", async () => {
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
    expect(acc1.documentId).toBe(added.id);
    expect(acc1.saved.kind).toBe("file");

    // Second AI edit also writes the same file in place — zero copies created!
    const read2 = structured<{ version: string }>(
      await agent.callTool({ name: "read_deck", arguments: { documentId: added.id } }),
    );
    const prop2 = structured<{ proposalId: string }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: added.id,
          version: read2.version,
          changes: [{ kind: "text", slide: 1, shape: "3", paragraphs: ["Second AI edit"] }],
        },
      }),
    );
    const acc2 = await core.acceptDeckProposal(prop2.proposalId);
    expect(acc2.documentId).toBe(added.id);
    expect((await readdir(files)).filter((name) => name.endsWith(".pptx"))).toEqual([
      "Quarterly.pptx",
    ]);
    const kept = await core.keptDeckStates(added.id);
    expect(kept.first?.contentHash).toBe(sha256(initial));
    expect(kept.sitting?.contentHash).toBe(acc1.contentHash);

    // User hand-edits the deck -> Undo of acc2 must now be REFUSED (S2)!
    const hand = await core.editDeck({
      documentId: added.id,
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

  // protects=a confirmed AI change keeps the pre-edit original in Kept decks/ across a full app restart and one-step Put back restores the file byte-for-byte (#149 Condition 1); fails_when=kept state disappears on restart or restoreKeptDeck fails to restore exact original bytes
  it("keeps the original across a restart and puts the file back byte-for-byte in one step", async () => {
    const { core, coast, writer, files, restart } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const deckPath = join(files, "RestartRestore.pptx");
    const initial = multiSlideDeck();
    const initialHash = sha256(initial);
    await writeFile(deckPath, initial);
    const [deck] = await addAndProcess(core, [deckPath]);
    if (!deck) throw new Error("Deck not added.");
    await core.assignDocumentGroup(deck.id, coast.id);

    const read1 = structured<{ version: string }>(
      await agent.callTool({ name: "read_deck", arguments: { documentId: deck.id } }),
    );
    const prop1 = structured<{ proposalId: string }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: deck.id,
          version: read1.version,
          changes: [{ kind: "text", slide: 1, shape: "3", paragraphs: ["Confirmed AI edit."] }],
        },
      }),
    );
    // Nothing written to disk before Confirm.
    expect(sha256(new Uint8Array(await readFile(deckPath)))).toBe(initialHash);

    const accepted = await core.acceptDeckProposal(prop1.proposalId);
    expect(accepted.documentId).toBe(deck.id);
    expect(sha256(new Uint8Array(await readFile(deckPath)))).toBe(accepted.contentHash);
    expect(accepted.contentHash).not.toBe(initialHash);
    await agent.close();

    // Quit and reopen the app on the same data folder.
    const core2 = await restart();
    try {
      const kept = await core2.keptDeckStates(deck.id);
      expect(kept.sitting?.contentHash).toBe(initialHash);
      if (!kept.sitting) throw new Error("Expected kept sitting state after restart.");

      // One-step "Put back as it was" restores the exact original bytes on disk.
      const restored = await core2.restoreKeptDeck({
        documentId: deck.id,
        keptId: kept.sitting.id,
        shown: accepted.contentHash,
      });
      expect(restored.contentHash).toBe(initialHash);
      expect(sha256(new Uint8Array(await readFile(deckPath)))).toBe(initialHash);
    } finally {
      await core2.close();
    }
  });

  // protects=confirming an AI deck proposal refuses in plain words with nothing written and zero temp files when the file is locked by another app or changed underneath (#149 Condition 3); fails_when=Confirm overwrites a locked or externally changed file, leaves temp leftovers, or drops the waiting proposal on lock
  it("refuses in plain words with nothing written when the file is locked or changed underneath", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const lockedPath = join(files, "LockedDeck.pptx");
    const initial = multiSlideDeck();
    const initialHash = sha256(initial);
    await writeFile(lockedPath, initial);
    const [lockedDoc] = await addAndProcess(core, [lockedPath]);
    if (!lockedDoc) throw new Error("Deck not added.");
    await core.assignDocumentGroup(lockedDoc.id, coast.id);

    const readLocked = structured<{ version: string }>(
      await agent.callTool({ name: "read_deck", arguments: { documentId: lockedDoc.id } }),
    );
    const propLocked = structured<{ proposalId: string }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: lockedDoc.id,
          version: readLocked.version,
          changes: [{ kind: "text", slide: 1, shape: "3", paragraphs: ["Blocked while locked."] }],
        },
      }),
    );

    // Simulate PowerPoint holding the file open via its sibling lock file.
    const lockFilePath = join(files, "~$LockedDeck.pptx");
    await writeFile(lockFilePath, "lock");
    await expect(core.acceptDeckProposal(propLocked.proposalId)).rejects.toMatchObject({
      wording: { key: "error.deck.unwritable.locked", values: { name: "LockedDeck.pptx" } },
    });
    // Nothing written, zero temp files left beside it, proposal still waiting.
    expect(sha256(new Uint8Array(await readFile(lockedPath)))).toBe(initialHash);
    expect((await readdir(files)).filter((n) => n.includes(".tmp") || n.includes(".part"))).toEqual(
      [],
    );
    expect(await core.deckProposals(lockedDoc.id)).toHaveLength(1);

    // Once PowerPoint closes (lock removed), Confirming the same waiting proposal succeeds.
    await unlink(lockFilePath);
    const afterUnlock = await core.acceptDeckProposal(propLocked.proposalId);
    expect(afterUnlock.documentId).toBe(lockedDoc.id);
    expect(sha256(new Uint8Array(await readFile(lockedPath)))).toBe(afterUnlock.contentHash);

    // Part B: file changed underneath right before atomic rename (mid-write race).
    const baseFiles = createNodeDeckFiles();
    let triggerExternalWrite = false;
    const externalBytes = multiSlideDeck({ autofit: "shrink" });
    const raceStarted = await started([], {
      adapters: {
        deckFiles: {
          ...baseFiles,
          replaceFile: async (path, bytes, stillSame, mode) => {
            if (triggerExternalWrite) {
              triggerExternalWrite = false;
              await writeFile(path, externalBytes);
            }
            return baseFiles.replaceFile(path, bytes, stillSame, mode);
          },
        },
      },
    });
    const raceAgent = await connectLegacyAgent(raceStarted.writer.launch);
    const racePath = join(raceStarted.files, "RaceDeck.pptx");
    await writeFile(racePath, initial);
    const [raceDoc] = await addAndProcess(raceStarted.core, [racePath]);
    if (!raceDoc) throw new Error("Race deck not added.");
    await raceStarted.core.assignDocumentGroup(raceDoc.id, raceStarted.coast.id);

    const readRace = structured<{ version: string }>(
      await raceAgent.callTool({ name: "read_deck", arguments: { documentId: raceDoc.id } }),
    );
    const propRace = structured<{ proposalId: string }>(
      await raceAgent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: raceDoc.id,
          version: readRace.version,
          changes: [{ kind: "text", slide: 1, shape: "3", paragraphs: ["Should not clobber."] }],
        },
      }),
    );

    triggerExternalWrite = true;
    await expect(raceStarted.core.acceptDeckProposal(propRace.proposalId)).rejects.toMatchObject({
      wording: { key: "error.deck.changed" },
    });
    // The other program's bytes stay intact on disk, and replaceFile left zero temp files behind.
    expect(sha256(new Uint8Array(await readFile(racePath)))).toBe(sha256(externalBytes));
    expect((await readdir(raceStarted.files)).filter((n) => n !== "RaceDeck.pptx")).toEqual([]);
    await raceAgent.close();
  });

  // protects=duplicate-name zip decks (unrewritable) and signed/final/password/read-only decks are refused on the AI path with nothing written (#149); fails_when=unrewritable or protected decks appear editable or succeed on propose/confirm
  it("refuses unrewritable duplicate-name zips, signed/final/password decks, and read-only files on the AI path", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);

    // 1. Duplicate-name zip entry makes pkg.rewritable === false.
    const basePkg = openPackage(multiSlideDeck());
    const dupEntries: Array<{ name: string; data: Buffer }> = [];
    for (const name of basePkg.names()) {
      const data = Buffer.from((await basePkg.read(name)) as Uint8Array);
      dupEntries.push({ name, data });
      if (name === "ppt/slides/slide1.xml") dupEntries.push({ name, data });
    }
    const dupBytes = new Uint8Array(buildZip(dupEntries));
    expect(openPackage(dupBytes).rewritable).toBe(false);
    const dupPath = join(files, "DuplicateEntries.pptx");
    await writeFile(dupPath, dupBytes);
    const [dupDoc] = await addAndProcess(core, [dupPath]);
    if (!dupDoc) throw new Error("Duplicate-entry deck not added.");
    await core.assignDocumentGroup(dupDoc.id, coast.id);

    const dupRead = structured<{ editable: boolean; refusal: string | null; version: string }>(
      await agent.callTool({ name: "read_deck", arguments: { documentId: dupDoc.id } }),
    );
    expect(dupRead.editable).toBe(false);
    expect(dupRead.refusal).toBe("unrewritable");
    const dupProp = await agent.callTool({
      name: "propose_deck_changes",
      arguments: {
        documentId: dupDoc.id,
        version: dupRead.version,
        changes: [{ kind: "text", slide: 1, shape: "3", paragraphs: ["Blocked"] }],
      },
    });
    expect(dupProp.isError).toBe(true);

    // 2. Signed, marked-as-final, and password-to-modify decks are refused on read_deck + propose.
    const protectedCases: Array<{
      file: string;
      expected: "signed" | "final" | "protected";
      mutate(entries: Array<{ name: string; data: Buffer }>): void;
    }> = [
      {
        file: "Signed.pptx",
        expected: "signed",
        mutate(entries) {
          entries.push({ name: "_xmlsignatures/sig1.xml", data: Buffer.from("<Signature/>") });
        },
      },
      {
        file: "Final.pptx",
        expected: "final",
        mutate(entries) {
          entries.push({
            name: "docProps/custom.xml",
            data: Buffer.from(
              `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="_MarkAsFinal"><vt:bool>true</vt:bool></property></Properties>`,
            ),
          });
        },
      },
      {
        file: "Password.pptx",
        expected: "protected",
        mutate(entries) {
          for (const entry of entries) {
            if (entry.name === "ppt/presentation.xml") {
              entry.data = Buffer.from(
                entry.data
                  .toString("utf8")
                  .replace(
                    "</p:presentation>",
                    '<p:modifyVerifier saltData="abc"/></p:presentation>',
                  ),
              );
            }
          }
        },
      },
    ];
    for (const tc of protectedCases) {
      const entries: Array<{ name: string; data: Buffer }> = [];
      for (const name of basePkg.names()) {
        entries.push({ name, data: Buffer.from((await basePkg.read(name)) as Uint8Array) });
      }
      tc.mutate(entries);
      const path = join(files, tc.file);
      await writeFile(path, new Uint8Array(buildZip(entries)));
      const [doc] = await addAndProcess(core, [path]);
      if (!doc) throw new Error(`${tc.file} not added.`);
      await core.assignDocumentGroup(doc.id, coast.id);

      const readRes = structured<{ editable: boolean; refusal: string | null; version: string }>(
        await agent.callTool({ name: "read_deck", arguments: { documentId: doc.id } }),
      );
      expect(readRes.editable).toBe(false);
      expect(readRes.refusal).toBe(tc.expected);
      const propRes = await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: doc.id,
          version: readRes.version,
          changes: [{ kind: "text", slide: 1, shape: "3", paragraphs: ["Blocked"] }],
        },
      });
      expect(propRes.isError).toBe(true);
    }

    // 3. Read-only file on disk refuses Confirm with error.deck.unwritable.read-only and writes nothing.
    const roPath = join(files, "ReadOnly.pptx");
    const roInitial = multiSlideDeck();
    await writeFile(roPath, roInitial);
    const [roDoc] = await addAndProcess(core, [roPath]);
    if (!roDoc) throw new Error("ReadOnly deck not added.");
    await core.assignDocumentGroup(roDoc.id, coast.id);

    const roRead = structured<{ version: string }>(
      await agent.callTool({ name: "read_deck", arguments: { documentId: roDoc.id } }),
    );
    const roProp = structured<{ proposalId: string }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: roDoc.id,
          version: roRead.version,
          changes: [{ kind: "text", slide: 1, shape: "3", paragraphs: ["Read only"] }],
        },
      }),
    );
    await chmod(roPath, 0o444);
    try {
      await expect(core.acceptDeckProposal(roProp.proposalId)).rejects.toMatchObject({
        wording: { key: "error.deck.unwritable.read-only", values: { name: "ReadOnly.pptx" } },
      });
      expect(sha256(new Uint8Array(await readFile(roPath)))).toBe(sha256(roInitial));
    } finally {
      await chmod(roPath, 0o644);
    }
    await agent.close();
  });

  // protects=external edits on another slide refuse Confirm so outside bytes are never silently overwritten, while app-own hand edits on another slide still confirm cleanly (#149 Condition 3); fails_when=external edit on an untouched slide is clobbered or app-own hand edit on another slide is refused
  it("refuses Confirm after an external edit on another slide, but allows Confirm after an app-own hand edit on another slide", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const deckPath = join(files, "ExternalOtherSlide.pptx");
    const initial = multiSlideDeck();
    await writeFile(deckPath, initial);
    const [doc] = await addAndProcess(core, [deckPath]);
    if (!doc) throw new Error("Deck not added.");
    await core.assignDocumentGroup(doc.id, coast.id);

    const read1 = structured<{ version: string }>(
      await agent.callTool({ name: "read_deck", arguments: { documentId: doc.id } }),
    );
    const prop = structured<{ proposalId: string }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: doc.id,
          version: read1.version,
          changes: [{ kind: "text", slide: 1, shape: "3", paragraphs: ["AI edit on slide 1"] }],
        },
      }),
    );

    // Simulate PowerPoint editing Slide 2 directly on disk (Slide 1 shape 3 fingerprint still matches!).
    const basePkg = openPackage(initial);
    const extEntries: Array<{ name: string; data: Buffer }> = [];
    for (const name of basePkg.names()) {
      const raw = Buffer.from((await basePkg.read(name)) as Uint8Array);
      if (name === "ppt/slides/slide2.xml") {
        extEntries.push({
          name,
          data: Buffer.from(
            raw.toString("utf8").replace("Untouched slide two.", "Edited in PowerPoint."),
          ),
        });
      } else {
        extEntries.push({ name, data: raw });
      }
    }
    const externalBytes = new Uint8Array(buildZip(extEntries));
    await writeFile(deckPath, externalBytes);

    await expect(core.acceptDeckProposal(prop.proposalId)).rejects.toMatchObject({
      wording: { key: "error.deck.proposalStale" },
    });
    expect(sha256(new Uint8Array(await readFile(deckPath)))).toBe(sha256(externalBytes));

    // Re-read after the external save, propose on Slide 1, then make an app-own hand edit on Slide 2 -> Confirm succeeds!
    const read2 = structured<{ version: string }>(
      await agent.callTool({ name: "read_deck", arguments: { documentId: doc.id } }),
    );
    const prop2 = structured<{ proposalId: string }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: doc.id,
          version: read2.version,
          changes: [{ kind: "text", slide: 1, shape: "3", paragraphs: ["AI edit after re-read"] }],
        },
      }),
    );
    const handSlide2 = await core.editDeck({
      documentId: doc.id,
      sittingId: null,
      shown: read2.version,
      viewer: "test-viewer",
      edits: [
        {
          kind: "text",
          slide: 2,
          shape: "2",
          paragraphs: [
            {
              source: 0,
              runs: [{ source: { paragraph: 0, run: 0 }, text: "App hand edit on slide 2" }],
            },
          ],
        },
      ],
    });
    expect(handSlide2.kind).toBe("saved");

    const accepted = await core.acceptDeckProposal(prop2.proposalId);
    const afterStruct = (await readDeckStructure(accepted.bytes)).structure;
    expect(afterStruct.slides[0]?.shapes.find((s) => s.shapeId === "3")?.paragraphs).toEqual([
      "AI edit after re-read",
    ]);
    expect(afterStruct.slides[1]?.shapes.find((s) => s.shapeId === "2")?.paragraphs).toEqual([
      "App hand edit on slide 2",
    ]);
    await agent.close();
  });

  // protects=a deck inside a Linked folder is written in place on Confirm with original kept and Put back working (#149); fails_when=Linked-folder deck fails to write in place or Put back fails
  it("writes a Linked-folder deck in place on Confirm and restores it with Put back", async () => {
    const { core, files } = await started();
    const linkedDir = join(files, "linked-decks");
    await mkdir(linkedDir, { recursive: true });
    const deckPath = join(linkedDir, "Board.pptx");
    const initial = multiSlideDeck();
    const initialHash = sha256(initial);
    await writeFile(deckPath, initial);

    const linked = await core.addLinkedFolder(linkedDir);
    const linkedFolderId = linked.bound?.folder.id;
    if (!linkedFolderId) throw new Error("Linked folder has no bound Folder.");
    await core.reconcileDocuments();
    const deckDoc = await vi.waitFor(
      async () => {
        const read = (await core.listDocuments()).find(
          (each) => each.kind === "pptx" && each.path === deckPath,
        );
        expect(read?.status).toBe("ready");
        return read;
      },
      { timeout: 30_000 },
    );
    if (!deckDoc) throw new Error("Linked-folder deck not indexed.");

    const linkedWriter = await core.connectAgent({
      name: "LinkedWriter",
      folderIds: [linkedFolderId],
      propose: true,
    });
    const agent = await connectLegacyAgent(linkedWriter.launch);
    const readRes = structured<{ version: string }>(
      await agent.callTool({ name: "read_deck", arguments: { documentId: deckDoc.id } }),
    );
    const prop = structured<{ proposalId: string }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: deckDoc.id,
          version: readRes.version,
          changes: [{ kind: "text", slide: 1, shape: "3", paragraphs: ["Linked deck updated."] }],
        },
      }),
    );

    const accepted = await core.acceptDeckProposal(prop.proposalId);
    expect(accepted.saved.kind).toBe("file");
    expect(sha256(new Uint8Array(await readFile(deckPath)))).toBe(accepted.contentHash);
    expect((await readdir(linkedDir)).filter((n) => n.endsWith(".pptx"))).toEqual(["Board.pptx"]);

    const kept = await core.keptDeckStates(deckDoc.id);
    expect(kept.sitting?.contentHash).toBe(initialHash);
    if (!kept.sitting) throw new Error("Expected kept state for Linked-folder deck.");
    await core.restoreKeptDeck({
      documentId: deckDoc.id,
      keptId: kept.sitting.id,
      shown: accepted.contentHash,
    });
    expect(sha256(new Uint8Array(await readFile(deckPath)))).toBe(initialHash);
    await agent.close();
  });

  // protects=table cell edits report exact 1-based row/column without double-incrementing, speaker notes strip [cite:...] tokens, shape tags stay ids-only, and receipt displays letGo when a kept state is dropped (#149); fails_when=cell label is off by 1, raw [cite:...] lands in speaker notes, Document names/quotes leak into .pptx tags, or letGo is omitted
  it("applies cell and notes changes with 1-based cell labels, stripped notes [cite:...], ids-only cell tags, and letGo receipt formatting", async () => {
    const tableShape = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Metrics Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="914400"/><a:ext cx="6000000" cy="1800000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid><a:gridCol w="3000000"/><a:gridCol w="3000000"/></a:tblGrid><a:tr h="900000"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${para("Metric")}</a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${para("17")}</a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const notesXml = `${HEAD}<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${para("Original speaker note.")}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
    const tableDeck = new Uint8Array(
      pptxOf({
        slides: [
          {
            shapes: tableShape,
            rels: rel("rNotes", "notesSlide", "../notesSlides/notesSlide1.xml"),
          },
        ],
        parts: [ROOT_RELS, { name: "ppt/notesSlides/notesSlide1.xml", data: notesXml }],
      }),
    );

    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const deckPath = join(files, "TableAndNotes.pptx");
    await writeFile(deckPath, tableDeck);
    const [doc] = await addAndProcess(core, [deckPath]);
    if (!doc) throw new Error("Table deck not added.");
    await core.assignDocumentGroup(doc.id, coast.id);

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

    const readRes = structured<{ version: string }>(
      await agent.callTool({ name: "read_deck", arguments: { documentId: doc.id } }),
    );
    const prop = structured<{ proposalId: string }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: doc.id,
          version: readRes.version,
          changes: [
            {
              kind: "cell",
              slide: 1,
              shape: "5",
              row: 0,
              column: 1,
              paragraphs: [`19 ${citeToken}`],
            },
            {
              kind: "notes",
              slide: 1,
              paragraphs: [`Updated speaker note ${citeToken}.`],
            },
          ],
        },
      }),
    );

    const waiting = (await core.deckProposals(doc.id))[0];
    const cellItem = waiting?.items[0];
    const notesItem = waiting?.items[1];
    expect(cellItem?.cell).toEqual({ row: 1, column: 2 });
    expect(notesItem?.after).toBe("Updated speaker note.");
    expect(notesItem?.after).not.toContain("[cite:");

    const accepted = await core.acceptDeckProposal(prop.proposalId);
    const pkg = openPackage(accepted.bytes);
    const tagPart = pkg.names().find((n) => n.startsWith("ppt/tags/"));
    expect(tagPart).toBeDefined();
    const rawTagXml = (await pkg.readText(tagPart as string)) ?? "";
    expect(rawTagXml).not.toContain("Harbour survey");
    expect(rawTagXml).not.toContain("south quay holds 19 boats");

    const notesAfter = (await pkg.readText("ppt/notesSlides/notesSlide1.xml")) ?? "";
    expect(notesAfter).toContain("Updated speaker note.");
    expect(notesAfter).not.toContain("[cite:");
    await agent.close();
  });

  // protects=a failed undo-snapshot write leaves the deck untouched, and a tampered undo snapshot hash is refused cleanly on Undo (#149); fails_when=deck writes even though undo snapshot failed, or corrupted undo bytes overwrite the deck
  it("leaves the deck untouched if storing the Undo snapshot fails, and refuses Undo if the snapshot is tampered", async () => {
    const initial = multiSlideDeck();
    let writeDeckCalled = false;
    const proposals = createDeckProposals({
      read: async () => initial,
      writeDeck: async (documentId) => {
        writeDeckCalled = true;
        return { documentId, saved: { kind: "file", name: "Deck.pptx", keptId: null, letGo: [] } };
      },
      undoStore: {
        put: async () => {
          throw new Error("ENOSPC: disk full");
        },
        get: async () => null,
        del: async () => undefined,
      },
      newId: () => "11111111-1111-1111-1111-111111111111",
      now: () => "2026-11-25T12:00:00.000Z",
    });
    const proposed = await proposals.propose({
      documentId: "doc-1",
      agentName: "Agent",
      pairingId: "pair-1",
      version: sha256(initial),
      summary: "Test",
      changes: [{ kind: "text", slide: 1, shape: "3", paragraphs: ["Will not write"] }],
    });
    await expect(proposals.accept(proposed.id)).rejects.toThrow(/disk full/i);
    expect(writeDeckCalled).toBe(false);

    // Tampered undo file on disk is refused by hash verification.
    const { core, dataDir, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const deckPath = join(files, "TamperUndo.pptx");
    await writeFile(deckPath, initial);
    const [doc] = await addAndProcess(core, [deckPath]);
    if (!doc) throw new Error("Tamper deck not added.");
    await core.assignDocumentGroup(doc.id, coast.id);

    const readRes = structured<{ version: string }>(
      await agent.callTool({ name: "read_deck", arguments: { documentId: doc.id } }),
    );
    const prop = structured<{ proposalId: string }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: doc.id,
          version: readRes.version,
          changes: [{ kind: "text", slide: 1, shape: "3", paragraphs: ["Confirmed text"] }],
        },
      }),
    );
    const accepted = await core.acceptDeckProposal(prop.proposalId);
    const undoFile = join(dataDir, "deck-proposal-undos", `${accepted.undoId}.pptx`);
    await writeFile(undoFile, Buffer.from("tampered-bytes"));

    await expect(core.undoDeckProposal(accepted.undoId)).rejects.toMatchObject({
      wording: { key: "error.deck.undoRefused" },
    });
    expect(sha256(new Uint8Array(await readFile(deckPath)))).toBe(accepted.contentHash);
    await agent.close();
  });

  // protects=Confirm is refused while a hand-edit sitting has a waiting change, and two waiting proposals on different shapes of one deck can both be confirmed sequentially (#149); fails_when=Confirm overwrites a waiting hand edit or the second proposal fails after confirming the first
  it("refuses Confirm while a hand-edit sitting is waiting, and confirms two proposals on different shapes sequentially", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const deckPath = join(files, "WaitingAndTwo.pptx");
    const initial = multiSlideDeck();
    await writeFile(deckPath, initial);
    const [doc] = await addAndProcess(core, [deckPath]);
    if (!doc) throw new Error("Deck not added.");
    await core.assignDocumentGroup(doc.id, coast.id);

    const readRes = structured<{ version: string }>(
      await agent.callTool({ name: "read_deck", arguments: { documentId: doc.id } }),
    );
    const propA = structured<{ proposalId: string }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: doc.id,
          version: readRes.version,
          changes: [{ kind: "text", slide: 1, shape: "2", paragraphs: ["Title from proposal A"] }],
        },
      }),
    );
    const propB = structured<{ proposalId: string }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: doc.id,
          version: readRes.version,
          changes: [{ kind: "text", slide: 1, shape: "3", paragraphs: ["Body from proposal B"] }],
        },
      }),
    );

    // Put a hand-edit sitting into waiting state by making the file temporarily read-only.
    await chmod(deckPath, 0o444);
    let waitingSittingId: string | null = null;
    try {
      const handWaiting = await core.editDeck({
        documentId: doc.id,
        sittingId: null,
        shown: readRes.version,
        viewer: "test-viewer",
        edits: [
          {
            kind: "text",
            slide: 2,
            shape: "2",
            paragraphs: [
              {
                source: 0,
                runs: [{ source: { paragraph: 0, run: 0 }, text: "Waiting hand edit" }],
              },
            ],
          },
        ],
      });
      expect(handWaiting.kind).toBe("unwritable");
      if (handWaiting.kind === "unwritable") waitingSittingId = handWaiting.sittingId;
    } finally {
      await chmod(deckPath, 0o644);
    }

    // Even after chmod 0644, Confirm must be refused while the sitting still has a waiting edit.
    await expect(core.acceptDeckProposal(propA.proposalId)).rejects.toMatchObject({
      wording: { key: "error.deck.waiting" },
    });

    // Retry the waiting hand edit so it lands cleanly, then confirm BOTH Proposal A and Proposal B!
    if (!waitingSittingId) throw new Error("Expected waiting sitting id.");
    const retried = await core.retryDeckEdit(waitingSittingId);
    expect(retried.kind).toBe("saved");

    const accA = await core.acceptDeckProposal(propA.proposalId);
    const accB = await core.acceptDeckProposal(propB.proposalId);
    const finalStruct = (await readDeckStructure(accB.bytes)).structure;
    expect(finalStruct.slides[0]?.shapes.find((s) => s.shapeId === "2")?.paragraphs).toEqual([
      "Title from proposal A",
    ]);
    expect(finalStruct.slides[0]?.shapes.find((s) => s.shapeId === "3")?.paragraphs).toEqual([
      "Body from proposal B",
    ]);
    expect(finalStruct.slides[1]?.shapes.find((s) => s.shapeId === "2")?.paragraphs).toEqual([
      "Waiting hand edit",
    ]);
    expect(accA.unchangedSlides).toBe(2);
    expect(accB.unchangedSlides).toBe(2);
    await agent.close();
  });
});
