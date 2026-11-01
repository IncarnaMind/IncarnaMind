import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
  CHART_NODE,
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
  type Pictures,
} from "../../src/core";
import { addCitedVersions, type CitedVersions } from "../../src/core/answers/citedVersions";
import { tableGrid } from "../../src/renderer/src/editor/chartCommands";
import {
  type ChartAttributes,
  chartFromTable,
  chartSources,
  readChart,
} from "../../src/shared/charts";
import { chartOf, Q1, Q2, TABLE } from "../helpers/calculatedCharts";
import {
  answerEnded,
  askAndFinish,
  citingModel,
  contextOfNextQuestion,
  type ShownPassage,
  setUpWithDocuments,
} from "../helpers/citations";
import { startCore } from "../helpers/core";
import { checkWellFormed, footnotesOf, paragraphsOf, part, textOf, unzip } from "../helpers/docx";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { editMind, question, readMind, writeMind } from "../helpers/minds";
import { promptOf } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";
import { fakePrinter } from "../helpers/printer";

/** Acme's quarterly revenue, a year a page. */
const REPORT = buildPdf([
  { lines: ["Revenue by quarter, 2024", "Revenue was 289.4, 301.2, 309.8 and 330.6 in 2024."] },
  { lines: ["Revenue by quarter, 2025", "Revenue was 341.5, 362.0 and 377.9 in 2025."] },
]);
const QUOTE_2024 = "Revenue was 289.4, 301.2, 309.8 and 330.6 in 2024.";
const QUOTE_2025 = "Revenue was 341.5, 362.0 and 377.9 in 2025.";

/** An Answer that writes a table of the figures, each cited to its page but the last. */
const FIGURES_ANSWER = [
  "Revenue by quarter:",
  "| Quarter | 2024 | 2025 |",
  "|:--|--:|--:|",
  "| Q1 | 289.4 [^1] | 341.5 [^2] |",
  "| Q2 | 301.2 [^1] | 362.0 [^2] |",
  "| Q3 | 309.8 [^1] | 377.9 [^2] |",
  "| Q4 | 330.6 [^1] | 401.2 |",
].join("\n");

const figuresModel = () =>
  citingModel({
    query: "revenue by quarter",
    records: (passages: ShownPassage[]) => {
      const passage = passages[0];
      if (!passage) throw new Error("The search showed no Passages.");
      return [
        { marker: 1, passage: passage.id, pageFrom: 1, pageTo: 1, quote: QUOTE_2024 },
        { marker: 2, passage: passage.id, pageFrom: 2, pageTo: 2, quote: QUOTE_2025 },
      ];
    },
    answer: FIGURES_ANSWER,
  });

/** The first table in the Mind, as the editor holds it. */
function tableIn(client: MindClient): ProseMirrorNode {
  let found: ProseMirrorNode | null = null;
  readMind(client).descendants((node) => {
    if (!found && node.type.name === "table") found = node;
    return !found;
  });
  if (!found) throw new Error("No table in the Mind.");
  return found;
}

/** A chart of the Mind's first table, made as the editor's "Chart from table" makes it. */
function chartOfFirstTable(client: MindClient, title = "Revenue by quarter"): ChartAttributes {
  const table = tableIn(client);
  const chart = chartFromTable(tableGrid(table), {
    blockId: String(table.attrs.id),
    title,
    language: "en",
  });
  if (!chart) throw new Error("The table made no chart.");
  return chart;
}

const chartBlock = (chart: ChartAttributes): JSONContent => ({
  type: CHART_NODE,
  attrs: { id: randomUUID(), ...chart },
});

/** The charts in the Mind, as stored. */
function chartsIn(client: MindClient): ChartAttributes[] {
  const charts: ChartAttributes[] = [];
  readMind(client).descendants((node) => {
    if (node.type.name === CHART_NODE) charts.push(readChart(node.attrs));
    return true;
  });
  return charts;
}

/** A 1 × 1 PNG, as a fake host draws every picture. */
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);

function fakePictures(): Pictures & { drawn: string[] } {
  const drawn: string[] = [];
  return {
    drawn,
    async png(svg) {
      drawn.push(svg);
      return PNG;
    },
  };
}

describe("a chart from a cited table", { timeout: 30_000 }, () => {
  test("keeps each value's cell and the Citation in it, through sync and a restart; a cell with none is marked so", async () => {
    const model = figuresModel();
    const { core, dataDir, client, mind } = await setUpWithDocuments(model, [
      { name: "Acme.pdf", contents: REPORT },
    ]);
    await askAndFinish(core, client, mind.id, "Revenue by quarter? Answer as a table.");
    const chart = chartOfFirstTable(client);
    editMind(client, (blocks) => [...blocks, chartBlock(chart)]);
    await client.settled();

    // Every value of the table, each with its cell and the Citation that was in it.
    const q3 = chart.data.rows[2];
    expect(q3?.label).toBe("Q3");
    expect(q3?.values.map((value) => value?.shown)).toEqual(["309.8", "377.9"]);
    expect(q3?.values.map((value) => value?.from)).toEqual([
      { kind: "cell", row: 3, column: 1 },
      { kind: "cell", row: 3, column: 2 },
    ]);
    expect(q3?.values.map((value) => value?.citation?.check)).toEqual(["found", "found"]);
    expect(q3?.values.map((value) => value?.citation?.quote)).toEqual([QUOTE_2024, QUOTE_2025]);
    expect(q3?.values[1]?.citation?.pageFrom).toBe(2);
    expect(chart.data.rows[3]?.values[1]?.citation).toBeNull();

    // Another window sees it as it was made, and records the content schema version.
    const other = await connectToMind(core, mind.id);
    await expect.poll(() => chartsIn(other)).toEqual([chart]);
    expect(client.doc.getMap(MIND_SETTINGS_FIELD).get(CONTENT_SCHEMA_VERSION_KEY)).toBe(
      CONTENT_SCHEMA_VERSION,
    );

    core.close();
    const restarted = startCore(dataDir);
    const reader = await connectToMind(restarted, mind.id);
    expect(chartsIn(reader)).toEqual([chart]);
    restarted.close();
  });

  test("Question context reads it as its title and its values with their sources", async () => {
    const model = figuresModel();
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Acme.pdf", contents: REPORT },
    ]);
    await askAndFinish(core, client, mind.id, "Revenue by quarter? Answer as a table.");
    editMind(client, (blocks) => [...blocks, chartBlock(chartOfFirstTable(client))]);
    await client.settled();

    const context = await contextOfNextQuestion(core, client, mind.id, model);
    expect(context).toContain(
      [
        "Chart, bar: Revenue by quarter",
        "",
        "| Quarter | 2024 | 2025 |",
        "| --- | --- | --- |",
        "| Q1 | 289.4 [Acme, p. 1 · C1] | 341.5 [Acme, p. 2 · C2] |",
      ].join("\n"),
    );
    // The value with no Citation reads as written, with no source.
    expect(context).toContain("| Q4 | 330.6 [Acme, p. 1 · C1] | 401.2 |");
  });

  test("Question context names its values' Document as it is named now", async () => {
    const model = figuresModel();
    const { core, client, mind, documents } = await setUpWithDocuments(model, [
      { name: "Acme.pdf", contents: REPORT },
    ]);
    await askAndFinish(core, client, mind.id, "Revenue by quarter? Answer as a table.");
    editMind(client, (blocks) => [...blocks, chartBlock(chartOfFirstTable(client))]);
    await client.settled();

    await core.renameDocument(documents[0]?.id ?? "", "Acme annual report");
    const context = await contextOfNextQuestion(core, client, mind.id, model);

    expect(context).toContain(
      "| Q1 | 289.4 [Acme annual report, p. 1 · C1] | 341.5 [Acme annual report, p. 2 · C2] |",
    );
    expect(context).not.toContain("[Acme, p.");
  });

  test("Markdown writes its caption, its values as a table, and its sources as footnotes", async () => {
    const model = figuresModel();
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Acme.pdf", contents: REPORT },
    ]);
    await askAndFinish(core, client, mind.id, "Revenue by quarter? Answer as a table.");
    // Only the chart, so its footnotes are the export's only ones.
    const chart = chartOfFirstTable(client);
    writeMind(client, [chartBlock(chart)]);
    await client.settled();

    const exported = await core.exportMind(mind.id, { format: "markdown" });
    expect(new TextDecoder().decode(exported.data)).toBe(
      [
        "*Chart: Revenue by quarter*",
        "",
        "| Quarter | 2024 | 2025 |",
        "| --- | ---: | ---: |",
        "| Q1 | 289.4 | 341.5 |",
        "| Q2 | 301.2 | 362.0 |",
        "| Q3 | 309.8 | 377.9 |",
        "| Q4 | 330.6 | 401.2 |",
        "",
        "Source: [^1][^2] 1 value has no Citation.",
        "",
        "[^1]: Acme, p. 1",
        "[^2]: Acme, p. 2",
        "",
      ].join("\n"),
    );
    expect(exported.citations).toBe(2);
    expect(exported.unverifiedCitations).toBe(0);

    // In Chinese, the words are Chinese, with no space after the full-width colon.
    await core.updateSettings({ user: { language: "zh-CN" } });
    const chinese = new TextDecoder().decode(
      (await core.exportMind(mind.id, { format: "markdown" })).data,
    );
    expect(chinese).toContain("*图表：Revenue by quarter*");
    expect(chinese).toContain("数据来源：[^1][^2] 1 个数值没有引用。");
  });

  test("a pie's export covers the one column it draws, its sources too (#503)", async () => {
    const model = figuresModel();
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Acme.pdf", contents: REPORT },
    ]);
    await askAndFinish(core, client, mind.id, "Revenue by quarter? Answer as a table.");
    writeMind(client, [chartBlock({ ...chartOfFirstTable(client), kind: "pie" })]);
    await client.settled();

    const exported = await core.exportMind(mind.id, { format: "markdown" });
    expect(new TextDecoder().decode(exported.data)).toBe(
      [
        "*Chart: Revenue by quarter*",
        "",
        "| Quarter | 2025 |",
        "| --- | ---: |",
        "| Q1 | 341.5 |",
        "| Q2 | 362.0 |",
        "| Q3 | 377.9 |",
        "| Q4 | 401.2 |",
        "",
        "Source: [^1] 1 value has no Citation.",
        "",
        "[^1]: Acme, p. 2",
        "",
      ].join("\n"),
    );
  });

  test("Word has its picture, its caption, and its sources as real footnotes; with no picture, its table", async () => {
    const model = figuresModel();
    const pictures = fakePictures();
    const { core, client, mind } = await setUpWithDocuments(
      model,
      [{ name: "Acme.pdf", contents: REPORT }],
      { pictures },
    );
    await askAndFinish(core, client, mind.id, "Revenue by quarter? Answer as a table.");
    const chart = chartOfFirstTable(client);
    writeMind(client, [chartBlock(chart)]);
    await client.settled();

    const exported = await core.exportMind(mind.id, { format: "docx" });
    const files = unzip(exported.data);
    for (const [name, content] of files) {
      if (name.endsWith(".xml") || name.endsWith(".rels"))
        checkWellFormed(content.toString("utf8"));
    }
    // The picture, as the host drew it from the chart's SVG, at twice the page's width.
    expect(pictures.drawn).toHaveLength(1);
    expect(pictures.drawn[0]).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1200"/,
    );
    expect(pictures.drawn[0]).toContain(">Q3</text>");
    expect(files.get("word/media/image1.png")).toEqual(Buffer.from(PNG));
    const document = part(files, "word/document.xml");
    expect(document).toContain('descr="Bar chart: Revenue by quarter"');
    expect(part(files, "word/_rels/document.xml.rels")).toContain('Target="media/image1.png"');
    expect(part(files, "[Content_Types].xml")).toContain('Extension="png"');

    // Under it, its caption and its sources, each a footnote Word numbers with the rest.
    const captions = paragraphsOf(document).filter((paragraph) => paragraph.style === "Caption");
    expect(captions.map((paragraph) => paragraph.text)).toEqual([
      "Chart: Revenue by quarter",
      "Source: [1][2] 1 value has no Citation.",
    ]);
    expect(footnotesOf(part(files, "word/footnotes.xml"))).toMatchObject({
      "1": "Acme, p. 1",
      "2": "Acme, p. 2",
    });

    // A host that can't draw pictures: the table of its values instead.
    const plain = await setUpWithDocuments(figuresModel(), [
      { name: "Acme.pdf", contents: REPORT },
    ]);
    await askAndFinish(plain.core, plain.client, plain.mind.id, "Revenue by quarter? As a table.");
    writeMind(plain.client, [chartBlock(chartOfFirstTable(plain.client))]);
    await plain.client.settled();
    const tableOnly = unzip((await plain.core.exportMind(plain.mind.id, { format: "docx" })).data);
    expect([...tableOnly.keys()].some((name) => name.startsWith("word/media/"))).toBe(false);
    expect(textOf(part(tableOnly, "word/document.xml"))).toContain("Q3309.8377.9");
  });

  test("a PDF has the same picture and caption, and its sources as numbered footnotes; with no picture, its table", async () => {
    const pictures = fakePictures();
    const { printed, printer } = fakePrinter();
    const { core, client, mind } = await setUpWithDocuments(
      figuresModel(),
      [{ name: "Acme.pdf", contents: REPORT }],
      { pictures, printer },
    );
    await askAndFinish(core, client, mind.id, "Revenue by quarter? Answer as a table.");
    writeMind(client, [chartBlock(chartOfFirstTable(client))]);
    await client.settled();

    await core.exportMind(mind.id, { format: "pdf" });
    expect(pictures.drawn).toHaveLength(1);
    expect(pictures.drawn[0]).toMatch(/^<svg [^>]*width="1200"/);
    const body = printed[0]?.body ?? "";
    const png = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;
    expect(body).toContain(`<img src="${png}" alt="Bar chart: Revenue by quarter">`);
    expect(body).not.toContain("<table>");
    expect(body).toContain(
      '<p class="caption keep-next">Chart: Revenue by quarter</p>' +
        '<p class="caption chart-sources">Source: <sup class="note-ref" data-note="1">1</sup>' +
        '<sup class="note-ref" data-note="2">,2</sup> 1 value has no Citation.</p>',
    );
    expect(printed[0]?.notes).toEqual(["Acme, p. 1", "Acme, p. 2"]);

    // In the Mind's citation style, the sources side by side are one note, as a style cites them.
    await core.setMindCitationStyle(mind.id, "chicago-notes");
    await core.exportMind(mind.id, { format: "pdf" });
    expect(printed[1]?.body).toContain(
      '<p class="caption chart-sources">Source: <sup class="note-ref" data-note="1">1</sup> 1 value',
    );
    // One Document cited twice in the cluster is one source with both its pages.
    expect(printed[1]?.notes).toEqual(["“Acme,” n.d., 1, 2."]);

    // A host that can't draw pictures: the table of its values instead.
    const plain = fakePrinter();
    const tableOnly = await setUpWithDocuments(
      figuresModel(),
      [{ name: "Acme.pdf", contents: REPORT }],
      { printer: plain.printer },
    );
    await askAndFinish(tableOnly.core, tableOnly.client, tableOnly.mind.id, "Revenue? As a table.");
    writeMind(tableOnly.client, [chartBlock(chartOfFirstTable(tableOnly.client))]);
    await tableOnly.client.settled();
    await tableOnly.core.exportMind(tableOnly.mind.id, { format: "pdf" });
    expect(plain.printed[0]?.body).toContain("<table>");
    expect(plain.printed[0]?.body).not.toContain("<img");
    expect(plain.printed[0]?.body).toContain(
      '<p class="caption keep-next">Chart: Revenue by quarter</p>',
    );
  });

  test("a picture the host fails to draw leaves the table, and the export still succeeds", async () => {
    const failing: Pictures = {
      png: async () => {
        throw new Error("No window to draw in.");
      },
    };
    const { core, client, mind } = await setUpWithDocuments(
      figuresModel(),
      [{ name: "Acme.pdf", contents: REPORT }],
      { pictures: failing },
    );
    await askAndFinish(core, client, mind.id, "Revenue by quarter? Answer as a table.");
    writeMind(client, [chartBlock(chartOfFirstTable(client))]);
    await client.settled();
    const files = unzip((await core.exportMind(mind.id, { format: "docx" })).data);
    expect(textOf(part(files, "word/document.xml"))).toContain("Q4330.6401.2");
  });
});

describe("a chart of a long table", () => {
  test("is cut at 500 values, and Question context and exports say so", async () => {
    const model = figuresModel();
    const { core, client, mind } = await setUpWithDocuments(model, []);
    const cell = (type: "tableHeader" | "tableCell", text: string): JSONContent => ({
      type,
      attrs: { colspan: 1, rowspan: 1 },
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });
    const rows: JSONContent[] = [
      {
        type: "tableRow",
        content: [cell("tableHeader", "Day"), cell("tableHeader", "A"), cell("tableHeader", "B")],
      },
      ...Array.from({ length: 300 }, (_, index) => ({
        type: "tableRow",
        content: [
          cell("tableCell", `Day ${index + 1}`),
          cell("tableCell", String(index)),
          cell("tableCell", String(index * 2)),
        ],
      })),
    ];
    writeMind(client, [{ type: "table", attrs: { id: randomUUID() }, content: rows }]);
    await client.settled();
    const chart = chartOfFirstTable(client, "Daily");
    expect(chart.data.rows).toHaveLength(250);
    expect(chart.data.cutFrom).toBe(300);
    editMind(client, (blocks) => [...blocks, chartBlock(chart)]);
    await client.settled();

    const markdown = new TextDecoder().decode(
      (await core.exportMind(mind.id, { format: "markdown" })).data,
    );
    expect(markdown).toContain(
      "| Day 250 | 249 | 498 |\n\n500 values have no Citation. Only the first 250 of 300 rows are charted.",
    );

    // Question context: the table, then the chart, which says it was cut.
    const calls = model.doStreamCalls.length;
    const asked = question("What is the trend?");
    editMind(client, (blocks) => [...blocks, asked]);
    await client.settled();
    const result = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
    if (!result.asked) throw new Error("The Question wasn't asked.");
    await answerEnded(core, result.answerId);
    const context = promptOf(model, calls)
      .map((message) => message.text)
      .join("\n\n");
    expect(context).toContain("Chart, bar: Daily (its first 250 rows of 300)");
  });
});

describe("the versions a chart's Citations quote", () => {
  test("are kept like any Citation's, so its values can still be checked and opened", () => {
    const doc = new Y.Doc();
    const element = new Y.XmlElement(CHART_NODE);
    element.setAttribute("data", {
      labelHeading: "Quarter",
      series: ["2025"],
      rows: [
        {
          label: "Q1",
          values: [
            {
              shown: "341.5",
              value: 341.5,
              unit: { kind: "plain" },
              citation: { documentId: "acme", contentHash: "old-version", pageFrom: 2, pageTo: 2 },
              from: { kind: "cell", row: 1, column: 1 },
            },
          ],
        },
      ],
      cutFrom: null,
    } as unknown as string);
    doc.getXmlFragment(MIND_CONTENT_FIELD).push([element]);
    const cited: CitedVersions = new Map();
    addCitedVersions(doc.getXmlFragment(MIND_CONTENT_FIELD), cited);
    expect(cited.get("acme")).toEqual(new Set(["old-version"]));
  });
});

describe("a chart of calculated figures (#2307)", { timeout: 30_000 }, () => {
  test("an export says its values are calculated and footnotes each Input, never one cell as their source", async () => {
    const model = figuresModel();
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Acme.pdf", contents: REPORT },
    ]);
    writeMind(client, [chartBlock(chartOf(TABLE))]);
    await client.settled();

    const markdown = new TextDecoder().decode(
      (await core.exportMind(mind.id, { format: "markdown" })).data,
    );
    const footnotes = markdown.split("\n").filter((line) => line.startsWith("[^"));
    expect(footnotes.map((line) => line.replace(/^\[\^\d+\]: /, ""))).toEqual([
      expect.stringMatching(/^Regional sales 2026, Q1 2026, row 5/),
      expect.stringMatching(/^Regional sales 2026, Q2 2026, row 5/),
      expect.stringMatching(/^Regional sales 2026, Q3 2026, row 5/),
    ]);
    expect(markdown).toContain("2 values are calculated.");
    expect(markdown).not.toContain("no Citation");

    await core.updateSettings({ user: { language: "zh-CN" } });
    const chinese = new TextDecoder().decode(
      (await core.exportMind(mind.id, { format: "markdown" })).data,
    );
    expect(chinese).toContain("2 个数值由计算得出。");
    // An older editor would write its figures away: the Note records a version that keeps them,
    // 43 or a later one.
    expect(
      client.doc.getMap(MIND_SETTINGS_FIELD).get(CONTENT_SCHEMA_VERSION_KEY),
    ).toBeGreaterThanOrEqual(43);
  });

  test("a chart stored before its values kept figures reads its values as quoted, as it did", () => {
    // As the version before stored it: each calculated value with the first Citation in its cell.
    const { data } = chartOf(TABLE);
    const before = readChart({
      data: JSON.parse(
        JSON.stringify(data, (key, value) =>
          key === "figure" ? undefined : key === "citation" && value === null ? Q1.citation : value,
        ),
      ),
    });
    const west = before.data.rows[0]?.values[0];
    expect(west?.figure).toBeUndefined();
    expect(west?.citation?.location).toEqual(Q1.citation.location);
    expect(chartSources(before)).toMatchObject({ values: 3, calculated: 0, uncited: 0 });
  });

  test("Question context reads a calculated value as calculated, with no one cell as its source", async () => {
    const model = figuresModel();
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Acme.pdf", contents: REPORT },
    ]);
    writeMind(client, [chartBlock(chartOf(TABLE))]);
    await client.settled();

    const context = await contextOfNextQuestion(core, client, mind.id, model);
    expect(context).toContain("| West | 52,530 (calculated) | 41.3% (calculated) |");
  });

  test("keeps the versions each Input quotes", () => {
    const doc = new Y.Doc();
    const element = new Y.XmlElement(CHART_NODE);
    const { data } = chartOf(TABLE);
    // Only West's calculated values: no quoted value's Citation to keep the version for them.
    element.setAttribute("data", { ...data, rows: data.rows.slice(0, 1) } as unknown as string);
    doc.getXmlFragment(MIND_CONTENT_FIELD).push([element]);
    const cited: CitedVersions = new Map();
    addCitedVersions(doc.getXmlFragment(MIND_CONTENT_FIELD), cited);
    expect(cited.get(Q2.citation.documentId)).toEqual(new Set([Q2.citation.contentHash]));
  });
});
