/**
 * Real-model proof for targeted AI deck editing (#149 part 2, AC #2):
 * Everyday English and Chinese requests to change one detail of a PowerPoint deck already in
 * IncarnaMind use `read_deck` + `propose_deck_changes` (never `hand_over_file`), modifying only
 * the named shape, chart series, or speaker notes while keeping untouched slides byte-identical.
 *
 * Needs INCARNAMIND_DECK_EDIT_EVAL_KEY (Anthropic key for claude-haiku-5-5).
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readDeckStructure } from "../../src/core/decks/readDeck";
import { openPackage } from "../../src/core/documents/formats/zip";
import { chartAgreement, chartSeries } from "../../src/core/exports/pptxPatch/charts";
import { Deck } from "../../src/core/exports/pptxPatch/deck";
import { agentsAdapter } from "../../tests/helpers/agents";
import { createTempDataFolder, startCore } from "../../tests/helpers/core";
import { addAndProcess, createSourceFolder } from "../../tests/helpers/documents";
import { para, pptxOf, rel, sp, txBody, xfrm } from "../../tests/helpers/pptx";
import { buildZip } from "../../tests/helpers/zip";
import { agentSession, agentUsd } from "../lib/agentSession";

const HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
const ROOT_RELS = {
  name: "_rels/.rels",
  data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
};

const rawOf = (bytes: Uint8Array, name: string) => {
  const raw = openPackage(bytes).raw(name);
  return raw ? Buffer.from(raw.data).toString("base64") : null;
};

const partsChanged = (before: Uint8Array, after: Uint8Array) =>
  openPackage(before)
    .names()
    .filter((name) => rawOf(before, name) !== rawOf(after, name));

function buildTestDeck(): Uint8Array {
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
          shapes:
            sp({
              id: 2,
              name: "Title",
              spPr: xfrm(457200, 300000, 7500000, 700000),
              body: txBody(para("Harbour plan 2027")),
            }) +
            sp({
              id: 3,
              name: "Summary Box",
              txBox: true,
              spPr: xfrm(457200, 1200000, 5000000, 900000),
              body: txBody(para("South quay holds 17 boats.")),
            }) +
            `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Route Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="2300000"/><a:ext cx="6000000" cy="2400000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rChart"/></a:graphicData></a:graphic></p:graphicFrame>`,
          rels: rel("rChart", "chart", "../charts/chart1.xml"),
        },
        {
          shapes: sp({
            id: 2,
            name: "Slide 2 Body",
            spPr: xfrm(457200, 500000, 6500000, 700000),
            body: txBody(para("North quay holds 42 boats.")),
          }),
        },
        {
          shapes: sp({
            id: 2,
            name: "Slide 3 Body",
            spPr: xfrm(457200, 500000, 6500000, 700000),
            body: txBody(para("Harbour office is open every day.")),
          }),
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
}

interface Case {
  id: string;
  lang: "en" | "zh";
  prompt: string;
  verify: (before: Uint8Array, after: Uint8Array) => Promise<boolean>;
}

const CASES: readonly Case[] = [
  {
    id: "en-text-count",
    lang: "en",
    prompt:
      "In the Harbour plan deck already in IncarnaMind, change the south quay boat count on slide 1 from 17 to 19. Leave everything else untouched.",
    verify: async (before, after) => {
      const s = (await readDeckStructure(after)).structure;
      const body = s.slides[0]?.shapes.find((x) => x.shapeId === "3")?.paragraphs?.join(" ") ?? "";
      return (
        body.includes("19") &&
        !body.includes("17") &&
        partsChanged(before, after).every((p) => p === "ppt/slides/slide1.xml")
      );
    },
  },
  {
    id: "en-title",
    lang: "en",
    prompt: "Change only the title on slide 1 of Harbour plan in IncarnaMind to: Q4 Harbour Brief",
    verify: async (before, after) => {
      const s = (await readDeckStructure(after)).structure;
      const title = s.slides[0]?.shapes.find((x) => x.shapeId === "2")?.paragraphs?.join(" ") ?? "";
      return (
        title.includes("Q4 Harbour Brief") &&
        partsChanged(before, after).every((p) => p === "ppt/slides/slide1.xml")
      );
    },
  },
  {
    id: "en-chart-series",
    lang: "en",
    prompt:
      "In Harbour plan in IncarnaMind, update only the East series on the slide 1 Route Chart to 21 and 27.5. Do not touch the West series.",
    verify: async (_before, after) => {
      const deck = Deck.open(after);
      const series = await chartSeries(deck, "ppt/charts/chart1.xml");
      const agree = await chartAgreement(deck, "ppt/charts/chart1.xml");
      return (
        JSON.stringify(series[0]?.points.map((p) => p.value)) === JSON.stringify([10, 12.5]) &&
        JSON.stringify(series[1]?.points.map((p) => p.value)) === JSON.stringify([21, 27.5]) &&
        agree.differences.length === 0
      );
    },
  },
  {
    id: "en-notes",
    lang: "en",
    prompt:
      "Add speaker notes to slide 2 of Harbour plan in IncarnaMind saying: Verify Q4 numbers before board meeting.",
    verify: async (_before, after) => {
      const s = (await readDeckStructure(after)).structure;
      const notes = s.slides[1]?.notes.join(" ") ?? "";
      return notes.includes("Verify Q4 numbers before board meeting");
    },
  },
  {
    id: "zh-text-count",
    lang: "zh",
    prompt: "把 IncarnaMind 里 Harbour plan 第一页的南码头船只数量从 17 改成 19，其余保持原样。",
    verify: async (before, after) => {
      const s = (await readDeckStructure(after)).structure;
      const body = s.slides[0]?.shapes.find((x) => x.shapeId === "3")?.paragraphs?.join(" ") ?? "";
      return (
        body.includes("19") &&
        !body.includes("17") &&
        partsChanged(before, after).every((p) => p === "ppt/slides/slide1.xml")
      );
    },
  },
  {
    id: "zh-title",
    lang: "zh",
    prompt: "把 IncarnaMind 里 Harbour plan 第一页的标题改成：2027 港口年度简报",
    verify: async (before, after) => {
      const s = (await readDeckStructure(after)).structure;
      const title = s.slides[0]?.shapes.find((x) => x.shapeId === "2")?.paragraphs?.join(" ") ?? "";
      return (
        title.includes("2027 港口年度简报") &&
        partsChanged(before, after).every((p) => p === "ppt/slides/slide1.xml")
      );
    },
  },
  {
    id: "zh-chart-series",
    lang: "zh",
    prompt:
      "把 IncarnaMind 里 Harbour plan 第一页 Route Chart 图表中的 East 系列改成 21 和 27.5，不要改动 West 系列。",
    verify: async (_before, after) => {
      const deck = Deck.open(after);
      const series = await chartSeries(deck, "ppt/charts/chart1.xml");
      const agree = await chartAgreement(deck, "ppt/charts/chart1.xml");
      return (
        JSON.stringify(series[0]?.points.map((p) => p.value)) === JSON.stringify([10, 12.5]) &&
        JSON.stringify(series[1]?.points.map((p) => p.value)) === JSON.stringify([21, 27.5]) &&
        agree.differences.length === 0
      );
    },
  },
  {
    id: "zh-notes",
    lang: "zh",
    prompt: "给 IncarnaMind 里 Harbour plan 第二页加上演讲者备注：会前核对第四季度数据。",
    verify: async (_before, after) => {
      const s = (await readDeckStructure(after)).structure;
      const notes = s.slides[1]?.notes.join(" ") ?? "";
      return notes.includes("会前核对第四季度数据");
    },
  },
];

test.skipIf(!process.env.INCARNAMIND_DECK_EDIT_EVAL_KEY)(
  "everyday EN and ZH requests edit one detail of an existing deck with read_deck + propose_deck_changes",
  async () => {
    const setup = {
      chat: {
        kind: "anthropic" as const,
        modelId: "claude-haiku-5-5",
        apiKey: process.env.INCARNAMIND_DECK_EDIT_EVAL_KEY ?? "",
      },
    };
    const usd = agentUsd(setup);
    let passed = 0;
    let usedHandOver = 0;
    let totalSpend = 0;
    const rows: string[] = [];

    const only = process.env.INCARNAMIND_DECK_EDIT_ONLY?.split(",").filter(Boolean);
    const selected = only ? CASES.filter((c) => only.includes(c.id)) : CASES;
    for (const c of selected) {
      const data = await createTempDataFolder();
      const core = startCore(data, { agents: await agentsAdapter(data) });
      const folder = await core.createLibraryGroup({ name: "Coast", description: "" });
      const source = await createSourceFolder();
      const deckBytes = buildTestDeck();
      const deckPath = join(source, "Harbour plan.pptx");
      await writeFile(deckPath, deckBytes);
      const [doc] = await addAndProcess(core, [deckPath]);
      if (!doc) throw new Error("Deck failed to process.");
      await core.assignDocumentGroup(doc.id, folder.id);
      await core.setAgentsEnabled(true);

      const session = await agentSession(core, setup, usd, "Claude Code", folder.id, null);
      try {
        const { cost, done } = await session.converse([{ role: "user", content: c.prompt }]);
        totalSpend += cost;
        const toolNames = session.calls.map((each) => each.name);
        const calledRead = toolNames.includes("read_deck");
        const calledPropose = toolNames.includes("propose_deck_changes");
        const calledHandOver = toolNames.includes("hand_over_file");
        if (calledHandOver) usedHandOver += 1;

        const proposals = await core.deckProposals(doc.id);
        const first = proposals[0];
        let ok = false;
        if (calledRead && calledPropose && !calledHandOver && first) {
          const accepted = await core.acceptDeckProposal(first.id);
          ok = await c.verify(deckBytes, accepted.bytes);
        }
        if (ok) passed += 1;
        rows.push(
          `${ok ? "PASS" : "FAIL"} ${c.id} (${c.lang}): tools=[${toolNames.join(",")}] refusals=${JSON.stringify(session.refusals())} proposals=${proposals.length} USD ${cost.toFixed(4)} reply=${done.text.slice(0, 160).replace(/\s+/g, " ")}`,
        );
      } finally {
        await session.close();
        await core.close();
      }
    }

    console.log(rows.join("\n"));
    console.log(
      `Summary (claude-haiku-5-5): ${passed}/${CASES.length} passed, hand_over_file calls=${usedHandOver}, total spend USD ${totalSpend.toFixed(4)}`,
    );
    expect(usedHandOver).toBe(0);
    expect(passed).toBe(CASES.length);
  },
  300_000,
);
