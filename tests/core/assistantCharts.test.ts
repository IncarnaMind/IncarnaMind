import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, test } from "vitest";
import { markdownToBlocks } from "../../src/core/answers/markdown";
import { calculatedCells, chartOfTable } from "../../src/core/tools/minds/charts";
import { type ChartAttributes, readChart } from "../../src/shared/charts";
import type { PlacedFigure } from "../../src/shared/figureMarkers";
import { pendingProposals, proposalRequestOf } from "../../src/shared/proposals";
import { askAssistant, changesIn, lastResult } from "../helpers/assistant";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { note, readMind, resolveChanges, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

/**
 * "Make a bar chart of revenue by quarter" (#1091), through the core's public
 * interface as the assistant asks: the model is told to write the cited table
 * and give chart, and the Mind gets the table and a chart drawn from it, each
 * value with its cell's Citation, as one change. A scatter chart of one
 * column of numbers keeps the table, and the model is told why in the chart's
 * own words. The model's choices are scripted; real models' are checked by hand.
 */

const QUARTERS = [
  ["Q1", "120"],
  ["Q2", "135"],
  ["Q3", "150"],
  ["Q4", "160"],
] as const;

const REVENUE = {
  name: "Annual report.md",
  contents: [
    "# Annual report",
    "",
    ...QUARTERS.map(([quarter, million]) => `Revenue in ${quarter} was €${million} million.`),
  ].join("\n\n"),
};

const quoteOf = (quarter: string, million: string) =>
  `Revenue in ${quarter} was €${million} million`;

const TABLE = [
  "| Quarter | Revenue |",
  "|---|---|",
  ...QUARTERS.map(
    ([quarter, million], index) => `| ${quarter} | €${million} million [^${index + 1}] |`,
  ),
].join("\n");

const called = (call: ModelCall, tool: string) => call.results.some((each) => each.tool === tool);

/** Searches, cites each quarter's revenue, then adds the table with `chart`. */
const charting =
  (chart: { kind?: string; title: string }, systems: string[]) =>
  (call: ModelCall): ScriptedReply => {
    if (call.system.includes("read_mind")) systems.push(call.system);
    const search = call.results.find((each) => each.tool === "search_documents");
    if (!search) return { calls: [{ tool: "search_documents", input: { query: "revenue" } }] };
    if (!called(call, "cite")) {
      return { calls: [{ tool: "cite", input: { citations: citationsIn(search) } }] };
    }
    if (!called(call, "add_to_mind")) {
      return { calls: [{ tool: "add_to_mind", input: { chart, content: TABLE } }] };
    }
    return { text: "" };
  };

function chartingModel(chart: { kind?: string; title: string }, systems: string[] = []) {
  return scriptedModel(charting(chart, systems));
}

/** The Mind's top-level Blocks by type, and its charts as they read. */
function blocksOf(doc: ProseMirrorNode): {
  types: string[];
  charts: ChartAttributes[];
  ids: string[];
} {
  const types: string[] = [];
  const charts: ChartAttributes[] = [];
  const ids: string[] = [];
  doc.forEach((node) => {
    types.push(node.type.name);
    ids.push(String(node.attrs.id));
    if (node.type.name === "chart") charts.push(readChart(node.attrs));
  });
  return { types, charts, ids };
}

async function setUp(model: ReturnType<typeof scriptedModel>) {
  const set = await setUpWithDocuments(model, [REVENUE]);
  writeMind(set.client, [note("Notes on the year.")]);
  await set.client.settled();
  return set;
}

describe("A chart the User asks the assistant for (#1091)", { timeout: 60_000 }, () => {
  // protects=a request for a bar chart, in English or Chinese, tells the model to write the cited table and give chart, and the Mind gets the table, then a bar chart drawn from it, each value with its cell's checked Citation, as one change with the table; fails_when=the model isn't told, no chart comes, its values lose their Citations, or it isn't part of the table's change; no_claim=that a real model gives chart.
  test.each([
    ["make a bar chart of revenue by quarter", "Revenue by quarter"],
    ["画一个各季度收入的柱状图", "各季度收入"],
  ])("“%s” adds the cited table and a bar chart of it", async (request, title) => {
    const systems: string[] = [];
    const model = chartingModel({ kind: "bar", title }, systems);
    const { core, mind, client } = await setUp(model);

    const answer = await askAssistant(core, { text: request, mindId: mind.id });
    await client.settled();

    expect(systems.at(-1)).toContain("give chart with the kind the User named");
    const { types, charts, ids } = blocksOf(readMind(client));
    expect(types).toEqual(["paragraph", "table", "chart"]);
    const [chart] = charts;
    expect(chart).toMatchObject({ kind: "bar", title, source: { kind: "table", blockId: ids[1] } });
    expect(chart?.data.rows.map((row) => [row.label, row.values[0]?.value])).toEqual(
      QUARTERS.map(([quarter, million]) => [quarter, Number(million) * 1e6]),
    );
    expect(chart?.data.rows.map((row) => row.values[0]?.citation?.check)).toEqual(
      QUARTERS.map(() => "found"),
    );
    const [change, ...more] = changesIn(answer);
    expect(more).toEqual([]);
    expect(change).toMatchObject({ tables: 1, charts: 1 });
    expect(new Set(pendingProposals(client.blocks).map((each) => each.request))).toEqual(
      new Set([change?.request]),
    );
  });

  // protects=the kind the call gives is the kind drawn: "as a line chart" makes a line chart; fails_when=it is drawn as a bar chart; no_claim=that a real model gives the kind asked for.
  test("“as a line chart” makes a line chart", async () => {
    const systems: string[] = [];
    const model = chartingModel({ kind: "line", title: "Revenue by quarter" }, systems);
    const { core, mind, client } = await setUp(model);

    await askAssistant(core, {
      text: "Make a chart of revenue by quarter as a line chart",
      mindId: mind.id,
    });
    await client.settled();

    expect(blocksOf(readMind(client)).charts.map((chart) => chart.kind)).toEqual(["line"]);
  });

  // protects=taking the change back takes the table and its chart back together; fails_when=the chart, or the table, stays; no_claim=the window's own Undo step, which the e2e checks.
  test("taken back, the table and its chart go together", async () => {
    const model = chartingModel({ kind: "bar", title: "Revenue by quarter" });
    const { core, mind, client } = await setUp(model);
    await askAssistant(core, { text: "make a bar chart of revenue by quarter", mindId: mind.id });
    await client.settled();

    await resolveChanges(client, "reject");

    expect(blocksOf(readMind(client)).types).toEqual(["paragraph"]);
  });

  // protects=a scatter chart of a table with one column of numbers keeps the table, draws no chart, and the model is told why in the chart's own words; fails_when=a chart that can't draw is added, or the table is lost, or the model isn't told; no_claim=what a real model then says.
  test("a scatter chart of one column of numbers keeps the table and says it needs two", async () => {
    const model = chartingModel({ kind: "scatter", title: "Revenue by quarter" });
    const { core, mind, client } = await setUp(model);

    const answer = await askAssistant(core, {
      text: "make a scatter chart of revenue by quarter",
      mindId: mind.id,
    });
    await client.settled();

    expect(blocksOf(readMind(client)).types).toEqual(["paragraph", "table"]);
    expect(changesIn(answer)[0]).toMatchObject({ tables: 1 });
    expect(changesIn(answer)[0]?.charts).toBeUndefined();
    expect(lastResult(model)).toContain("A scatter chart needs two columns of numbers");
  });
});

function citationsIn(search: { text: string }) {
  const shown = shownPassages(search.text);
  return QUARTERS.map(([quarter, million], index) => {
    const quote = quoteOf(quarter, million);
    return {
      marker: index + 1,
      passage: shown.find((each) => each.text.includes(quote))?.id,
      quote,
    };
  });
}

/** Searches, then adds `content` with `chart`, and records the Citations after it, in one step. */
function writeThenCite(content: string) {
  return scriptedModel((call): ScriptedReply => {
    const search = call.results.find((each) => each.tool === "search_documents");
    if (!search) return { calls: [{ tool: "search_documents", input: { query: "revenue" } }] };
    const add = {
      tool: "add_to_mind",
      input: { chart: { kind: "bar", title: "Revenue" }, content },
    };
    const adds = call.results.filter((each) => each.tool === "add_to_mind");
    // Told its table has no Citation (#1415), it writes it again as it was.
    if (adds.length === 1 && adds[0]?.text.includes("content has no Citation")) {
      return { calls: [add] };
    }
    if (adds.length > 0) return { text: "" };
    return { calls: [add, { tool: "cite", input: { citations: citationsIn(search) } }] };
  });
}

describe("A chart only draws what is cited", { timeout: 60_000 }, () => {
  // protects=a table written before cite records its markers, in the same step, gets its chart once the Citations are in, each value with its cell's checked Citation; fails_when=the chart is drawn first and its values keep no Citation; no_claim=how a real provider orders the calls.
  test("cite after add_to_mind in the same step still gives the chart its Citations", async () => {
    const model = writeThenCite(TABLE);
    const { core, mind, client } = await setUp(model);

    const answer = await askAssistant(core, {
      text: "make a bar chart of revenue by quarter",
      mindId: mind.id,
    });
    await client.settled();

    const { types, charts } = blocksOf(readMind(client));
    expect(types).toEqual(["paragraph", "table", "chart"]);
    expect(charts[0]?.data.rows.map((row) => row.values[0]?.citation?.check)).toEqual(
      QUARTERS.map(() => "found"),
    );
    expect(changesIn(answer).at(-1)).toMatchObject({ tables: 1, charts: 1 });
    // Drawn once cite has recorded, the chart is the write the request is, whatever its words were.
    expect(proposalRequestOf(client.doc, changesIn(answer).at(-1)?.request ?? "")).toMatchObject({
      requested: "write",
    });
  });

  // protects=a column the model typed, with no Citation and no calculation (a growth rate), keeps the table and draws no chart, the model and the User told why; fails_when=a chart draws figures nothing backs; no_claim=what a real model then says.
  test("a typed growth column keeps the table, draws no chart, and says why", async () => {
    const growth = [
      "| Quarter | Revenue | Growth |",
      "|---|---|---|",
      ...QUARTERS.map(
        ([quarter, million], index) =>
          `| ${quarter} | €${million} million [^${index + 1}] | ${index * 10}% |`,
      ),
    ].join("\n");
    const model = scriptedModel((call): ScriptedReply => {
      const search = call.results.find((each) => each.tool === "search_documents");
      if (!search) return { calls: [{ tool: "search_documents", input: { query: "revenue" } }] };
      if (!called(call, "cite")) {
        return { calls: [{ tool: "cite", input: { citations: citationsIn(search) } }] };
      }
      if (!called(call, "add_to_mind")) {
        return {
          calls: [{ tool: "add_to_mind", input: { chart: { title: "Growth" }, content: growth } }],
        };
      }
      return { text: "" };
    });
    const { core, mind, client } = await setUp(model);

    const answer = await askAssistant(core, {
      text: "Could you chart revenue growth by quarter?",
      mindId: mind.id,
    });
    await client.settled();

    expect(blocksOf(readMind(client)).types).toEqual(["paragraph", "table"]);
    expect(changesIn(answer)[0]).toMatchObject({ tables: 1, chartNotDrawn: "uncited" });
    expect(lastResult(model)).toContain("no Citation and come from no calculation");
    // The table is a write like any other: it applies at once, chart or none (#1559).
    expect(proposalRequestOf(client.doc, changesIn(answer)[0]?.request ?? "")).toMatchObject({
      requested: "write",
    });
  });

  // protects=an uncited table of figures the model made up ("999, 888") draws no chart; fails_when=it charts them; no_claim=none beyond protects.
  test("an uncited table draws no chart", async () => {
    const made = ["| Quarter | Revenue |", "|---|---|", "| Q1 | 999 |", "| Q2 | 888 |"].join("\n");
    const model = writeThenCite(made);
    const { core, mind, client } = await setUp(model);

    const answer = await askAssistant(core, {
      text: "make a bar chart of revenue",
      mindId: mind.id,
    });
    await client.settled();

    expect(blocksOf(readMind(client)).types).toEqual(["paragraph", "table"]);
    expect(changesIn(answer)[0]).toMatchObject({ chartNotDrawn: "uncited", uncited: true });
  });
});

describe("A chart waiting for cite, the rest of its text revised", { timeout: 60_000 }, () => {
  // protects=a new Mind's chart that waits for cite is still drawn after its table once a later call of the same Answer revised another section of that text, and its card counts it; fails_when=the chart is dropped, or drawn away from its table; no_claim=how often a real model revises its own text.
  test("is drawn after its table", async () => {
    const content = `## Revenue\n\n${TABLE}\n\n## Outlook\n\nSales should keep growing.`;
    const model = scriptedModel((call): ScriptedReply => {
      const search = call.results.find((each) => each.tool === "search_documents");
      if (!search) return { calls: [{ tool: "search_documents", input: { query: "revenue" } }] };
      if (!called(call, "create_mind")) {
        const chart = { kind: "bar", title: "Revenue" };
        return {
          calls: [
            { tool: "create_mind", input: { title: "Revenue notes", chart, content } },
            { tool: "cite", input: { citations: citationsIn(search) } },
          ],
        };
      }
      if (!called(call, "edit_mind")) {
        const outlook = "## Outlook\n\nSales should keep growing next year.";
        return {
          calls: [
            {
              tool: "edit_mind",
              input: { mind: "Revenue notes", part: "Outlook", content: outlook },
            },
          ],
        };
      }
      return { text: "" };
    });
    const { core, mind } = await setUp(model);

    const answer = await askAssistant(core, {
      text: "make a note charting revenue",
      mindId: mind.id,
    });
    const [made] = changesIn(answer);
    const page = await connectToMind(core, made?.mindId ?? "");

    const { types } = blocksOf(readMind(page));
    expect(types[types.indexOf("table") + 1]).toBe("chart");
    expect(made).toMatchObject({ created: true, tables: 1, charts: 1 });
    expect(made?.chartNotDrawn).toBeUndefined();
  });
});

describe("A chart of a table already in the Mind", { timeout: 60_000 }, () => {
  // protects="chart this table" tells the model to give chart with no content, and charts the table there, right after it, without writing it again, as a change of its own; fails_when=the table is written a second time, or the chart goes elsewhere; no_claim=that a real model gives chart that way.
  test("“chart this table” charts the one there, without a second table", async () => {
    const systems: string[] = [];
    const first = charting({ kind: "bar", title: "Revenue" }, []);
    const model = scriptedModel((call): ScriptedReply => {
      if (!call.prompt.includes("chart this table")) return first(call);
      systems.push(call.system);
      return called(call, "add_to_mind")
        ? { text: "" }
        : {
            calls: [
              {
                tool: "add_to_mind",
                input: { chart: { kind: "line", title: "Revenue" }, content: "" },
              },
            ],
          };
    });
    const { core, mind, client } = await setUp(model);
    await askAssistant(core, { text: "make a bar chart of revenue by quarter", mindId: mind.id });
    await resolveChanges(client, "accept");
    client.doc.transact(() => client.blocks.delete(2, 1));
    await client.settled();

    const answer = await askAssistant(core, { text: "chart this table", mindId: mind.id });
    await client.settled();

    expect(systems.at(-1)).toContain(
      "For a table already in the Note, call add_to_mind with chart",
    );
    const { types, charts, ids } = blocksOf(readMind(client));
    expect(types).toEqual(["paragraph", "table", "chart"]);
    expect(charts[0]).toMatchObject({ kind: "line", source: { kind: "table", blockId: ids[1] } });
    const [change] = changesIn(answer);
    expect(change).toMatchObject({ charts: 1 });
    expect(change?.tables).toBeUndefined();
  });
});

describe("A chart of the User's own table", { timeout: 60_000 }, () => {
  const OWN_TABLE = ["| Quarter | Revenue |", "|---|---|", "| Q1 | 10 |", "| Q2 | 12 |"].join("\n");
  const chartThisTable = scriptedModel(
    (call): ScriptedReply =>
      called(call, "add_to_mind")
        ? { text: "Here it is." }
        : {
            calls: [{ tool: "add_to_mind", input: { chart: { title: "Revenue" }, content: "" } }],
          },
  );

  // protects="chart this table" charts the User's own uncited table, as "Chart from table" would: the User can chart any table of theirs; fails_when=it is refused for want of Citations; no_claim=tables the assistant writes, which stay held to their Citations.
  test("charts the User's own table, uncited", async () => {
    const { core, mind, client } = await setUpWithDocuments(chartThisTable, [REVENUE]);
    writeMind(client, [note("Notes."), ...markdownToBlocks(OWN_TABLE)]);
    await client.settled();

    await askAssistant(core, { text: "chart this table", mindId: mind.id });
    await client.settled();

    expect(blocksOf(readMind(client)).types).toEqual(["paragraph", "table", "chart"]);
  });

  // protects=a "chart this table" that can't chart says why on its card, not only to the model; fails_when=the card shows nothing of the refusal; no_claim=the card's look, which the renderer's tests check.
  test("with two tables and the cursor in neither, its card says so", async () => {
    const { core, mind, client } = await setUpWithDocuments(chartThisTable, [REVENUE]);
    writeMind(client, [
      ...markdownToBlocks(OWN_TABLE),
      note("Then."),
      ...markdownToBlocks(OWN_TABLE),
    ]);
    await client.settled();

    const answer = await askAssistant(core, { text: "chart this table", mindId: mind.id });

    const call = answer.toolCalls.find((each) => each.tool === "add_to_mind");
    expect(call).toMatchObject({
      status: "failed",
      mindProblem: { kind: "no-chart", mindId: mind.id, problem: "several" },
    });
    expect(blocksOf(readMind(client)).types).toEqual(["table", "paragraph", "table"]);
  });
});

describe("A figure from calculate backs a chart value", () => {
  const figure = (value: number, shown: string): PlacedFigure => ({
    value,
    shown,
    show: { language: "en", as: null, decimals: null, scale: null },
  });
  const recorded = new Map([
    [1, figure(0.125, "12.5%")],
    [2, figure(0.111, "11.1%")],
  ]);
  const figureOf = (marker: number) => recorded.get(marker) ?? null;

  // protects=a cell holding a figure calculate recorded counts as backed, so a computed series charts, while a figure typed with a marker calculate never recorded, or with another number beside its marker, draws nothing; fails_when=a checked calculation is refused, or a typed one drawn; no_claim=how calculate checks its figures (#439).
  test("recorded calculations chart, typed ones don't", () => {
    const written = [
      "| Quarter | Growth |",
      "|---|---|",
      "| Q2 | [=1] |",
      "| Q3 | 11.1% [=2] |",
      "| Q4 | 20.4% [=9] |",
      "| Q5 | 15% [=1] |",
    ].join("\n");
    const calculated = calculatedCells(written, figureOf);
    expect([1, 2, 3, 4].map((row) => calculated(row, 1))).toEqual([true, true, false, false]);
    expect([calculated(0, 1), calculated(1, 0)]).toEqual([false, false]);

    const tableOf = (cells: readonly string[]) => {
      const [table] = markdownToBlocks(
        [
          "| Quarter | Growth |",
          "|---|---|",
          ...cells.map((cell, at) => `| Q${at + 2} | ${cell} |`),
        ].join("\n"),
      );
      if (!table) throw new Error("No table.");
      return table;
    };
    const asked = { kind: null, title: "Growth" };
    expect(
      chartOfTable(
        tableOf(["12.5%", "11.1%"]),
        "table",
        asked,
        "en",
        calculatedCells(
          ["| Quarter | Growth |", "|---|---|", "| Q2 | [=1] |", "| Q3 | [=2] |"].join("\n"),
          figureOf,
        ),
      ),
    ).toHaveProperty("chart");
    expect(
      chartOfTable(
        tableOf(["20.4%"]),
        "table",
        asked,
        "en",
        calculatedCells(
          ["| Quarter | Growth |", "|---|---|", "| Q2 | 20.4% [=9] |"].join("\n"),
          figureOf,
        ),
      ),
    ).toMatchObject({ problem: "uncited" });
  });

  // protects="chart this table" charts a table already in the Mind as "Chart from table" does, cited or not; fails_when=the User's own uncited table is refused; no_claim=the assistant's own tables, which stay held to their Citations.
  test("a table already in the Mind charts uncited", () => {
    const [table] = markdownToBlocks(
      ["| Quarter | Revenue |", "|---|---|", "| Q1 | 10 |", "| Q2 | 12 |"].join("\n"),
    );
    if (!table) throw new Error("No table.");
    const asked = { kind: null, title: "Revenue" };
    expect(chartOfTable(table, "table", asked, "en", null)).toHaveProperty("chart");
    expect(chartOfTable(table, "table", asked, "en", () => false)).toMatchObject({
      problem: "uncited",
    });
  });
});

describe("A chart of figures calculate worked out, with a model that calculates", {
  timeout: 120_000,
}, () => {
  const GROWTH = "Revenue was $1,482.6 million in 2025, compared with $1,231.0 million in 2024.";
  const REPORT = {
    name: "Acme Annual Report 2025.pdf",
    contents: buildPdf([{ lines: ["Acme Annual Report 2025", GROWTH] }]),
  };
  const FIGURES = [1, 2].map((marker) => ({
    marker,
    label: `Revenue growth ${marker}`,
    formula: "rev2025 / rev2024 - 1",
    as: "percent",
    inputs: [
      { name: "rev2025", label: "Revenue 2025", citation: 1, number: "$1,482.6 million" },
      { name: "rev2024", label: "Revenue 2024", citation: 1, number: "$1,231.0 million" },
    ],
  }));
  const growthTable = (delimiter: string, cells: readonly [string, string]) =>
    ["| Year | Growth |", delimiter, `| 2025 | ${cells[0]} |`, `| 2026 | ${cells[1]} |`].join("\n");

  /** Searches, cites the revenue, calculates growth when `calculating`, then adds `table` with chart. */
  const growthModel = (table: string, calculating: boolean) =>
    scriptedModel((call: ModelCall): ScriptedReply => {
      const searches = call.results.filter((each) => each.tool === "search_documents");
      if (searches.length === 0) {
        return { calls: [{ tool: "search_documents", input: { query: "revenue" } }] };
      }
      if (!called(call, "cite")) {
        const passage =
          searches
            .flatMap((each) => shownPassages(each.text))
            .find((each) => each.document.startsWith("Acme"))?.id ?? "";
        return {
          calls: [
            {
              tool: "cite",
              input: { citations: [{ marker: 1, passage, location: "p. 1", quote: GROWTH }] },
            },
            ...(calculating ? [{ tool: "calculate", input: { figures: FIGURES } }] : []),
          ],
        };
      }
      if (!called(call, "add_to_mind")) {
        return {
          calls: [
            {
              tool: "add_to_mind",
              input: { chart: { kind: "bar", title: "Growth" }, content: table },
            },
          ],
        };
      }
      return { text: "" };
    });

  /** A model that calculates, as Claude Haiku 5.5 does: calculate is offered. */
  async function withCalculate(model: ReturnType<typeof scriptedModel>) {
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model).createChatModel,
    });
    const saved = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (saved.service) await core.allowDataFlow("chat", saved.service.id);
    const sources = await createTempDataFolder();
    await addAndProcess(core, [await writeSourceFile(sources, REPORT.name, REPORT.contents)]);
    const mind = await core.createMind({ title: "Tides" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [note("Notes.")]);
    await client.settled();
    return { core, mind, client };
  }

  // protects=figures calculate recorded chart, whatever delimiter row the table has ("|---|", "|:--|--:|", "|--|"), through the engine that records them; fails_when=a calculated figure is refused as uncited, or the wiring from calculate to the chart breaks; no_claim=how calculate works a figure out (#439).
  test.each(["|---|---|", "|:--|--:|", "|--|--|"])(
    "recorded figures chart, with the delimiter row %s",
    async (delimiter) => {
      const { core, mind, client } = await withCalculate(
        growthModel(growthTable(delimiter, ["[=1]", "[=2]"]), true),
      );

      const answer = await askAssistant(core, {
        text: "make a bar chart of revenue growth",
        mindId: mind.id,
      });
      await client.settled();

      const { types, charts } = blocksOf(readMind(client));
      expect(types).toEqual(["paragraph", "table", "chart"]);
      expect(charts[0]?.data.rows.map((row) => row.values[0]?.value)).toEqual([
        expect.closeTo(0.204, 3),
        expect.closeTo(0.204, 3),
      ]);
      expect(changesIn(answer).at(-1)?.chartNotDrawn).toBeUndefined();
    },
  );

  // protects=a figure typed with a marker calculate never recorded ("20.4% [=9]") draws no chart, and the card says why; fails_when=it is charted as calculated; no_claim=the reply's words.
  test("a typed figure with a marker nothing recorded draws no chart", async () => {
    const { core, mind, client } = await withCalculate(
      growthModel(growthTable("|:--|--:|", ["20.4% [=9]", "20.4% [=9]"]), false),
    );

    const answer = await askAssistant(core, {
      text: "make a bar chart of revenue growth",
      mindId: mind.id,
    });
    await client.settled();

    expect(blocksOf(readMind(client)).types).toEqual(["paragraph", "table"]);
    expect(changesIn(answer).at(-1)?.chartNotDrawn).toBe("uncited");
  });
});
