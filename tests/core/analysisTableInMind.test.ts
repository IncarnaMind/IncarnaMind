import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, test, vi } from "vitest";
import { createFakeAnalysisRuntime, type FakeAnswer } from "../../src/core/analysis/fake";
import { ANALYSIS_TABLE_ATTRIBUTE, ANALYSIS_TABLE_NODE } from "../../src/core/api";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { type AnalysisJob, noAnalysisOutput } from "../../src/shared/analysis";
import { INLINE_NODE } from "../../src/shared/sentences";
import { askAssistant, changesIn } from "../helpers/assistant";
import { checkReply, isCheckRun } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";

const SALES_CSV = [
  "Region,Quarter,Revenue",
  "North,2026Q1,120",
  "North,2026Q2,150.5",
  "South,2026Q1,80",
  "South,2026Q2,n/a",
].join("\n");

/** The Analysis's own result table, as the fake runtime gives it. */
const TOTAL_BY_REGION: FakeAnswer = {
  output: {
    ...noAnalysisOutput(),
    results: [
      {
        kind: "table",
        name: "by_region",
        label: "Revenue by region",
        unit: null,
        table: {
          columns: ["Region", "Revenue"],
          rows: [
            ["North", 270.5],
            ["South", 80],
          ],
          rowCount: 2,
          columnCount: 2,
        },
      },
    ],
  },
};

/** Searches, runs the Analysis, then writes `content` into the Note in focus. */
function writingModel(
  content: (language: "en" | "zh-CN") => string,
  language: "en" | "zh-CN",
  { cite = false }: { cite?: boolean } = {},
) {
  return scriptedModel((call: ModelCall) => {
    const search = call.results.find((result) => result.tool === "search_documents");
    if (!search) return { calls: [{ tool: "search_documents", input: { query: "revenue" } }] };
    if (cite && !call.results.some((result) => result.tool === "cite")) {
      return { calls: [{ tool: "cite", input: { citations: citationsIn(search.text) } }] };
    }
    if (!call.results.some((result) => result.tool === "run_analysis")) {
      const [passage] = shownPassages(search.text);
      return {
        calls: [
          {
            tool: "run_analysis",
            input: {
              title: language === "en" ? "Revenue by region" : "各地区收入",
              inputs: [{ name: "sales", passage: passage?.id ?? "" }],
              code: 'result("by_region", inputs["sales"].groupby("Region")["Revenue"].sum())',
            },
          },
        ],
      };
    }
    if (!call.results.some((result) => result.tool === "add_to_mind")) {
      return { calls: [{ tool: "add_to_mind", input: { content: content(language) } }] };
    }
    return { text: language === "en" ? "Written into the note." : "已写入笔记。" };
  });
}

/** The Citations a search's shown Passages can be cited with. */
function citationsIn(text: string): unknown[] {
  return shownPassages(text).map((passage, at) => ({
    passage: passage.id,
    quote: quoteOf(passage),
    marker: at + 1,
  }));
}

/** The first line of a shown Passage, as the words a Citation can quote. */
function quoteOf(passage: { text: string }): string {
  return (passage.text.split("\n")[0] ?? "").trim();
}

async function setUp(
  model: ReturnType<typeof scriptedModel>,
  answer: (job: AnalysisJob) => FakeAnswer,
) {
  const runtime = createFakeAnalysisRuntime({ answer });
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    createChatModel: scriptedModels(model).createChatModel,
    analysisRuntime: runtime,
  });
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  const sources = await createTempDataFolder();
  await addAndProcess(core, [await writeSourceFile(sources, "sales.csv", SALES_CSV)]);
  const mind = await core.createMind({ title: "Revenue" });
  const client = await connectToMind(core, mind.id);
  return { core, mind, client };
}

/** Every Citation in a Block's text, as its attributes. */
function citationsInTable(node: ProseMirrorNode): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  node.descendants((child) => {
    if (child.type.name === "citation") found.push(child.attrs);
    return true;
  });
  return found;
}

function tableIn(doc: ProseMirrorNode): ProseMirrorNode | null {
  let found: ProseMirrorNode | null = null;
  doc.forEach((block) => {
    if (block.type.name === "table") found = block;
  });
  return found;
}

describe("an Analysis's own result table written into a Note (#2378)", () => {
  test.each(["en", "zh-CN"] as const)(
    "%s: [=table 1] writes the Analysis's table, bound to its run under its caption and marker",
    async (language) => {
      const model = writingModel(
        (each) =>
          each === "en" ? "Revenue by region:\n\n[=table 1]" : "各地区收入：\n\n[=table 1]",
        language,
      );
      const { core, mind, client } = await setUp(model, () => TOTAL_BY_REGION);

      const answer = await askAssistant(core, {
        text:
          language === "en"
            ? "What was revenue by region? Put it in the note."
            : "按地区汇总 Revenue，写进笔记。",
        mindId: mind.id,
        analyse: true,
      });
      await client.settled();

      const note = readMind(client);
      const table = tableIn(note);
      if (!table) throw new Error("The Note has no table.");
      expect(table.textContent).toContain("Region");
      expect(table.textContent).toContain("North");
      expect(table.textContent).toContain("270.5");
      expect(table.textContent).toContain("80");
      expect(note.textContent).not.toContain("[=table");
      expect(
        answer.toolCalls.some(
          (call) => call.tool === "add_to_mind" && call.mindChange?.tables === 1,
        ),
      ).toBe(true);
      // One calculated object: no heading carries a Citation of its own; the caption's marker
      // and the table both name the run the Note keeps.
      expect(citationsInTable(table)).toEqual([]);
      expect(table.attrs[ANALYSIS_TABLE_ATTRIBUTE]).toMatchObject({
        table: { result: "by_region" },
      });
      let marker: ProseMirrorNode | null = null;
      note.descendants((node) => {
        if (node.type.name === ANALYSIS_TABLE_NODE) marker = node;
        return marker === null;
      });
      expect((marker as ProseMirrorNode | null)?.attrs[ANALYSIS_TABLE_ATTRIBUTE]).toEqual(
        table.attrs[ANALYSIS_TABLE_ATTRIBUTE],
      );
      expect(note.textContent).toContain("Revenue by region");
      core.close();
    },
  );

  test("a table the model typed itself, unlike any Analysis result, is kept without Citations", async () => {
    const model = writingModel(
      () => "Revenue by region [^1]:\n\n| Region | Revenue |\n| --- | --- |\n| North | 999 |",
      "en",
      { cite: true },
    );
    const { core, mind, client } = await setUp(model, () => TOTAL_BY_REGION);

    await askAssistant(core, {
      text: "What was revenue by region? Put it in the note.",
      mindId: mind.id,
      analyse: true,
    });
    await client.settled();

    const table = tableIn(readMind(client));
    if (!table) throw new Error("The Note has no table.");
    expect(table.textContent).toContain("999");
    expect(citationsInTable(table)).toEqual([]);
    core.close();
  });
});

describe("text written before cite, read as more Blocks once an Analysis has run (#1635)", () => {
  // protects=a write made before cite whose markers an Analysis run after it reads as more Blocks is still checked, as it stands, once the Run ends: its found Citation lands marked and its card counts the check; fails_when=the Citation stays found with no mark and no check on the card, which reads as checked; no_claim=how often a real model runs an Analysis after it writes.
  test("is still checked as it stands", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const analysis = (passage: string) => ({
        tool: "run_analysis",
        input: {
          title: "Revenue by region",
          inputs: [{ name: "sales", passage }],
          code: 'result("by_region", inputs["sales"].groupby("Region")["Revenue"].sum())',
        },
      });
      const model = scriptedModel((call: ModelCall) => {
        if (isCheckRun(call)) return checkReply(call, {});
        const search = call.results.find((result) => result.tool === "search_documents");
        if (!search) return { calls: [{ tool: "search_documents", input: { query: "revenue" } }] };
        const [passage] = shownPassages(search.text);
        const cite = (marker: number) => ({
          tool: "cite",
          input: {
            citations: [{ marker, passage: passage?.id, quote: quoteOf(passage ?? { text: "" }) }],
          },
        });
        const runs = call.results.filter((result) => result.tool === "run_analysis").length;
        const cites = call.results.filter((result) => result.tool === "cite").length;
        const wrote = call.results.some((result) => result.tool === "add_to_mind");
        if (runs === 0) return { calls: [analysis(passage?.id ?? "")] };
        if (cites === 0) return { calls: [cite(1)] };
        if (!wrote) {
          const content =
            "North revenue was 270.5 [^1].\n\nSouth revenue was 80 [^2].\n\n[=table 2]";
          return { calls: [{ tool: "add_to_mind", input: { content } }] };
        }
        if (runs === 1) return { calls: [analysis(passage?.id ?? "")] };
        if (cites === 1) return { calls: [cite(2)] };
        return { text: "Written into the note." };
      });
      const runtime = createFakeAnalysisRuntime({ answer: () => TOTAL_BY_REGION });
      const core = startCore(await createTempDataFolder(), {
        createChatModel: scriptedModels(model).createChatModel,
        analysisRuntime: runtime,
      });
      const saved = await core.saveChatProvider({
        kind: "anthropic",
        apiKey: "sk-ant-test",
        modelId: "claude-haiku-5-5",
      });
      for (const flow of ["chat", "checks"] as const) {
        if (saved.service) await core.allowDataFlow(flow, saved.service.id);
      }
      const sources = await createTempDataFolder();
      await addAndProcess(core, [await writeSourceFile(sources, "sales.csv", SALES_CSV)]);
      const mind = await core.createMind({ title: "Revenue" });
      const client = await connectToMind(core, mind.id);

      const answer = await askAssistant(core, {
        text: "What was revenue by region? Put it in the note.",
        mindId: mind.id,
        analyse: true,
      });
      await client.settled();

      expect(warned.mock.calls.some(([line]) => String(line).includes("the text reads as"))).toBe(
        true,
      );
      const [change] = changesIn(answer);
      expect(change?.selfCheck).toMatchObject({ cited: 1, failed: 0 });
      const marked = claimSpans(readMind(client)).map((span) =>
        span.sentence.text.replaceAll(INLINE_NODE, "").trim(),
      );
      expect(marked).toContain("North revenue was 270.5 .");
      core.close();
    } finally {
      warned.mockRestore();
    }
  });
});
