/**
 * A figure whose calculate input quotes its Passage directly, rather than through a cite record,
 * gets its Citation marker all the same (#1831): in an Answer in the assistant, in a Mind the
 * assistant writes, and in a comparison table's cell, which without one said "not found".
 * Through the core, with a scripted Claude Haiku 5.5, a model offered calculate.
 */
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, test } from "vitest";
import type { CitationAttributes } from "../../src/core";
import { comparisonCellOf } from "../../src/shared/comparisons";
import { askAssistant } from "../helpers/assistant";
import { shownPassages } from "../helpers/citations";
import { compare } from "../helpers/comparisons";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { note, readMind, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

const CEDAR = {
  name: "Cedar Q3 2026 final.txt",
  contents:
    "Cedar Q3 2026 final.\nAll amounts in GBP thousands.\nNet debt: 310,000.\nLTM adjusted EBITDA: 95,000.\n",
};

const called = (call: ModelCall, tool: string) => call.results.some((each) => each.tool === tool);

/** The figure of net debt in GBP millions, its input quoting its Passage directly. */
function netDebt(call: ModelCall, stated?: string) {
  const search = call.results.find((each) => each.tool === "search_documents");
  const [passage] = shownPassages(search?.text ?? "");
  return {
    marker: 1,
    label: "Net debt",
    formula: "nd",
    scale: "million",
    // A check Run, as a cell is, also names the number its text writes.
    ...(stated && { stated }),
    inputs: [
      {
        name: "nd",
        label: "Net debt Q3 2026",
        passage: passage?.id,
        location: passage?.location,
        quote: "Net debt: 310,000.",
        number: "310,000",
        reading: 1,
        unitQuote: "All amounts in GBP thousands.",
      },
    ],
  };
}

/** Searches, calculates the figure from a direct quote, then writes `then` (and `last`, when given). */
function calculatingModel(
  then: (call: ModelCall) => ScriptedReply,
  last?: ScriptedReply,
  stated?: string,
) {
  return scriptedModel((call) => {
    if (!called(call, "search_documents")) {
      return { calls: [{ tool: "search_documents", input: { query: "net debt" } }] };
    }
    if (!called(call, "calculate")) {
      return { calls: [{ tool: "calculate", input: { figures: [netDebt(call, stated)] } }] };
    }
    return last && called(call, "add_to_mind") ? last : then(call);
  });
}

async function setUp(
  model: ReturnType<typeof scriptedModel>,
  files: readonly { name: string; contents: string }[] = [CEDAR],
) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  const sources = await createSourceFolder();
  const documents = await addAndProcess(
    core,
    await Promise.all(files.map((file) => writeSourceFile(sources, file.name, file.contents))),
  );
  const mind = await core.createMind({ title: "Cedar" });
  const client = await connectToMind(core, mind.id);
  return { core, documents, mind, client };
}

const passageOf = (call: ModelCall) =>
  shownPassages(call.results.find((each) => each.tool === "search_documents")?.text ?? "")[0];

/** Each paragraph of the Mind after its first, with the quotes its Citations give. */
function paragraphQuotes(client: Awaited<ReturnType<typeof setUp>>["client"]) {
  const found: { text: string; quotes: string[] }[] = [];
  readMind(client).forEach((block, _, index) => {
    if (index === 0 || block.type.name !== "paragraph") return;
    found.push({
      text: block.textContent,
      quotes: citationsIn(block).map((each) => each.quote ?? ""),
    });
  });
  return found;
}

function citationsIn(node: ProseMirrorNode): CitationAttributes[] {
  const found: CitationAttributes[] = [];
  node.descendants((each) => {
    if (each.type.name === "citation") found.push(each.attrs as CitationAttributes);
  });
  return found;
}

describe("A figure whose input quotes its Passage directly is cited", { timeout: 60_000 }, () => {
  // protects=an Answer whose figure's input quoted its Passage directly shows the figure with that quote's Citation after its sentence; fails_when=the figure stands with no Citation marker; no_claim=a figure whose sentence already has a marker, which keeps only that one.
  test("in an Answer in the assistant", async () => {
    const { core } = await setUp(calculatingModel(() => ({ text: "Net debt was [=1] at Q3." })));
    const answer = await askAssistant(core, { text: "What was net debt in GBP millions?" });
    expect(answer.text).toBe("Net debt was [=1][^9001] at Q3.");
    expect(answer.citations).toMatchObject([
      { marker: 9001, quote: "Net debt: 310,000.", check: "found" },
    ]);
    expect(answer.figures).toMatchObject([{ marker: 1, value: 310_000_000 }]);
  });

  // protects=a figure whose input cites a record the model wrote only as a footnote definition, not a marker, gets that record's marker after its sentence; fails_when=the definition hides the missing marker and the figure ends uncited (a cell said not found); no_claim=none beyond protects.
  test("from its cite record when the Answer wrote only a footnote definition", async () => {
    const model = scriptedModel((call) => {
      const search = call.results.find((each) => each.tool === "search_documents");
      if (!search) return { calls: [{ tool: "search_documents", input: { query: "net debt" } }] };
      const passage = shownPassages(search.text)[0]?.id;
      if (!called(call, "cite")) {
        const citations = [{ marker: 1, passage, quote: "Net debt: 310,000." }];
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      if (!called(call, "calculate")) {
        const figure = netDebt(call);
        const [input] = figure.inputs;
        const inputs = [{ ...input, citation: 1, passage: undefined, quote: undefined }];
        return { calls: [{ tool: "calculate", input: { figures: [{ ...figure, inputs }] } }] };
      }
      return { text: "Net debt was [=1] at Q3.\n\n[^1]: Net debt: 310,000." };
    });
    const { core } = await setUp(model);
    const answer = await askAssistant(core, { text: "What was net debt in GBP millions?" });
    expect(answer.text.trim()).toBe("Net debt was [=1][^1] at Q3.");
    expect(answer.citations).toMatchObject([{ marker: 1, check: "found" }]);
  });

  // protects=a figure in a table's cell gets its input's Citation in that cell; fails_when=the cell shows the figure unmarked; no_claim=none beyond protects.
  test("in a table's cell of an Answer", async () => {
    const table = "| Metric | Q3 2026 |\n|---|---|\n| Net debt | [=1] |";
    const { core } = await setUp(calculatingModel(() => ({ text: table })));
    const answer = await askAssistant(core, { text: "Tabulate net debt in GBP millions" });
    expect(answer.text).toBe("| Metric | Q3 2026 |\n|---|---|\n| Net debt | [=1][^9001] |");
    expect(answer.citations).toMatchObject([{ marker: 9001, check: "found" }]);
  });

  // protects=a figure whose sentence the model already cited gets no second marker; fails_when=the direct quote is cited again beside it; no_claim=none beyond protects.
  test("and not again when its sentence has a Citation", async () => {
    const model = calculatingModel((call) =>
      called(call, "cite")
        ? { text: "Net debt was [=1] at Q3[^1]." }
        : {
            calls: [
              {
                tool: "cite",
                input: {
                  citations: [
                    {
                      marker: 1,
                      passage: shownPassages(
                        call.results.find((each) => each.tool === "search_documents")?.text ?? "",
                      )[0]?.id,
                      quote: "Net debt: 310,000.",
                    },
                  ],
                },
              },
            ],
          },
    );
    const { core } = await setUp(model);
    const answer = await askAssistant(core, { text: "What was net debt in GBP millions?" });
    expect(answer.text).toBe("Net debt was [=1] at Q3[^1].");
    expect(answer.citations).toHaveLength(1);
  });

  // protects=a figure whose sentence cites a Citation of the Mind by the id it was shown with keeps that one Citation (#1800); fails_when=the figure's input is cited beside it again; no_claim=none beyond protects.
  test("and not again when its sentence cites a Citation by its id", async () => {
    let id = "";
    const model = calculatingModel((call) => {
      id = /\[[^\]]*· C\d+\]/.exec(call.prompt)?.[0] ?? "";
      return { text: `Net debt was [=1] ${id} at Q3.` };
    });
    const { core, documents, mind, client } = await setUp(model);
    const [cedar] = documents;
    if (!cedar) throw new Error("No Document.");
    const cited = await core.citeSelection({
      documentId: cedar.id,
      parts: [{ unit: 1, text: "Net debt: 310,000." }],
    });
    const block = note("Net debt was 310,000");
    block.content?.push({ type: "citation", attrs: { ...cited, documentId: cedar.id } });
    writeMind(client, [block]);
    await client.settled();
    const answer = await askAssistant(core, { text: "What was net debt?", mindId: mind.id });
    expect(id).not.toBe("");
    expect(answer.text.match(/\[\^\d+\]/g)).toHaveLength(1);
    expect(answer.citations).toMatchObject([{ quote: "Net debt: 310,000." }]);
  });

  // protects=a figure the assistant writes into a Mind carries its input's Citation there, checked; fails_when=the Mind holds the figure's number with no Citation; no_claim=the reply, which only says what was done.
  test("in a Mind the assistant writes", async () => {
    const model = calculatingModel(
      () => ({
        calls: [
          {
            tool: "add_to_mind",
            input: { content: "Net debt was [=1] at Q3." },
            streamInput: true,
          },
        ],
      }),
      { text: "" },
    );
    const { core, mind, client } = await setUp(model);
    writeMind(client, [note("Cedar's quarter.")]);
    await client.settled();
    await askAssistant(core, { text: "Add net debt in GBP millions to the note", mindId: mind.id });
    await client.settled();
    const written = readMind(client).lastChild;
    if (!written) throw new Error("Nothing was written.");
    expect(written.textContent).toContain("Net debt was");
    expect(citationsIn(written)).toMatchObject([{ quote: "Net debt: 310,000.", check: "found" }]);
  });

  // protects=a comparison table's cell whose only amount is a figure with a direct quote is answered and cited, not "not found"; fails_when=the cell says not found; no_claim=none beyond protects.
  test("in a comparison table's cell, which is answered, not 'not found'", async () => {
    const { core, documents, mind, client } = await setUp(
      calculatingModel(() => ({ text: "[=1]" }), undefined, "£310 million"),
    );
    await compare(core, client, {
      mindId: mind.id,
      documentIds: documents.map((each) => each.id),
      questions: ["Net debt at Q3 2026, in GBP millions"],
    });
    const cells: { status: string; problem: string | null; citations: CitationAttributes[] }[] = [];
    readMind(client).forEach((block) => {
      if (block.type.name !== "comparisonTable") return;
      block.descendants((cell) => {
        if (cell.type.name !== "comparisonCell") return true;
        const { status, problem } = comparisonCellOf(cell.attrs);
        cells.push({ status, problem, citations: citationsIn(cell) });
        return false;
      });
    });
    expect(cells).toMatchObject([
      {
        status: "done",
        problem: null,
        citations: [{ quote: "Net debt: 310,000.", check: "found" }],
      },
    ]);
  });

  // protects=a Citation the model numbers itself never takes a figure's quote, whether its cite comes in the same step as the Mind write or the next (review of #1831); fails_when="LTM adjusted EBITDA was 95,000 [^1]" cites "Net debt: 310,000."; no_claim=none beyond protects.
  test.each(["same step", "next step"])(
    "a Citation the model writes later keeps its own quote (%s)",
    async (when) => {
      const content =
        "Net debt was [=1] at Q3.\n\nLTM adjusted EBITDA was 95,000 [^1].\n\nThat is all for the quarter.";
      const cite = (call: ModelCall) => ({
        tool: "cite",
        input: {
          citations: [
            { marker: 1, passage: passageOf(call)?.id, quote: "LTM adjusted EBITDA: 95,000." },
          ],
        },
      });
      const model = calculatingModel((call) => {
        if (!called(call, "add_to_mind")) {
          const write = { tool: "add_to_mind", input: { content }, streamInput: true };
          return { calls: when === "same step" ? [write, cite(call)] : [write] };
        }
        if (!called(call, "cite")) return { calls: [cite(call)] };
        return { text: "" };
      });
      const { core, mind, client } = await setUp(model);
      writeMind(client, [note("Cedar's quarter.")]);
      await client.settled();
      await askAssistant(core, { text: "Add net debt and EBITDA to the note", mindId: mind.id });
      await client.settled();
      expect(paragraphQuotes(client)).toEqual([
        { text: "Net debt was £310.000 million at Q3.", quotes: ["Net debt: 310,000."] },
        { text: "LTM adjusted EBITDA was 95,000 .", quotes: ["LTM adjusted EBITDA: 95,000."] },
        { text: "That is all for the quarter.", quotes: [] },
      ]);
    },
  );

  // protects=two figures quoting the same words from two places in one Passage cite each its own place (review of #1831); fails_when=the second figure cites the first one's line; no_claim=none beyond protects.
  test("cites each quote at its own place in the Passage", async () => {
    const lines = Array.from({ length: 130 }, (_, at) =>
      at + 1 === 63 || at + 1 === 124 ? "Net debt: 310,000." : `${at + 1}.`,
    );
    const figure = (marker: number, line: number) => (call: ModelCall) => ({
      marker,
      label: `Net debt, line ${line}`,
      formula: "nd",
      inputs: [
        {
          name: "nd",
          label: "Net debt",
          passage: passageOf(call)?.id,
          location: `lines ${line}–${line}`,
          quote: "Net debt: 310,000.",
          number: "310,000",
          reading: 1,
        },
      ],
    });
    const model = scriptedModel((call) => {
      if (!called(call, "search_documents")) {
        return { calls: [{ tool: "search_documents", input: { query: "net debt" } }] };
      }
      const steps = [
        { tool: "calculate", input: { figures: [figure(1, 63)(call)] } },
        { tool: "add_to_mind", input: { content: "Net debt was [=1]." } },
        { tool: "calculate", input: { figures: [figure(2, 124)(call)] } },
        { tool: "add_to_mind", input: { content: "Net debt was [=2] again." } },
      ];
      const done = call.results.filter((each) => each.tool !== "search_documents").length;
      const step = steps[done];
      return step ? { calls: [step] } : { text: "" };
    });
    const { core, mind, client } = await setUp(model, [
      { name: "Ledger.txt", contents: `${lines.join("\n")}\n` },
    ]);
    writeMind(client, [note("The ledger.")]);
    await client.settled();
    await askAssistant(core, { text: "Add net debt twice", mindId: mind.id });
    await client.settled();
    const cited: (CitationAttributes["location"] | undefined)[] = [];
    readMind(client).forEach((block, _, index) => {
      if (index > 0) cited.push(citationsIn(block)[0]?.location);
    });
    expect(cited).toMatchObject([
      { kind: "lines", from: 63, to: 63 },
      { kind: "lines", from: 124, to: 124 },
    ]);
  });

  // protects=#1831's Chinese cell: "净负债 [=1]" from a 万元 Document shows "净负债 3.1亿元" with a found Citation, not "not found"; fails_when=the cell says not found or shows the figure unmarked; no_claim=none beyond protects.
  test("in a Chinese comparison cell from a Document in 万元", async () => {
    const model = scriptedModel((call) => {
      if (!called(call, "search_documents")) {
        return { calls: [{ tool: "search_documents", input: { query: "净负债" } }] };
      }
      if (!called(call, "calculate")) {
        const passage = passageOf(call);
        const figure = {
          marker: 1,
          label: "净负债（亿元）",
          formula: "nd",
          scale: "亿",
          decimals: 1,
          stated: "3.1亿元",
          inputs: [
            {
              name: "nd",
              label: "净负债",
              passage: passage?.id,
              location: passage?.location,
              quote: "净负债：31,000",
              number: "31,000",
              unitQuote: "单位：万元",
            },
          ],
        };
        return { calls: [{ tool: "calculate", input: { figures: [figure] } }] };
      }
      return { text: "净负债 [=1]" };
    });
    const { core, documents, mind, client } = await setUp(model, [
      { name: "雪松控股.txt", contents: "雪松控股2026年三季度\n单位：万元\n净负债：31,000\n" },
    ]);
    await compare(core, client, {
      mindId: mind.id,
      documentIds: documents.map((each) => each.id),
      questions: ["2026年三季度的净负债是多少亿元？"],
    });
    const cells: { text: string; problem: string | null; citations: CitationAttributes[] }[] = [];
    readMind(client).forEach((block) => {
      block.descendants((cell) => {
        if (cell.type.name !== "comparisonCell") return true;
        const { problem } = comparisonCellOf(cell.attrs);
        cells.push({ text: cell.textContent.trim(), problem, citations: citationsIn(cell) });
        return false;
      });
    });
    expect(cells).toMatchObject([
      {
        text: "净负债 3.1亿元",
        problem: null,
        citations: [{ quote: "净负债：31,000", check: "found" }],
      },
    ]);
  });
});
