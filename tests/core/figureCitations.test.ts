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

async function setUp(model: ReturnType<typeof scriptedModel>) {
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
  const documents = await addAndProcess(core, [
    await writeSourceFile(sources, CEDAR.name, CEDAR.contents),
  ]);
  const mind = await core.createMind({ title: "Cedar" });
  const client = await connectToMind(core, mind.id);
  return { core, documents, mind, client };
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
    expect(answer.text).toBe("Net debt was [=1] at Q3[^1].");
    expect(answer.citations).toMatchObject([
      { marker: 1, quote: "Net debt: 310,000.", check: "found" },
    ]);
    expect(answer.figures).toMatchObject([{ marker: 1, value: 310_000_000 }]);
  });

  // protects=a figure in a table's cell gets its input's Citation in that cell; fails_when=the cell shows the figure unmarked; no_claim=none beyond protects.
  test("in a table's cell of an Answer", async () => {
    const table = "| Metric | Q3 2026 |\n|---|---|\n| Net debt | [=1] |";
    const { core } = await setUp(calculatingModel(() => ({ text: table })));
    const answer = await askAssistant(core, { text: "Tabulate net debt in GBP millions" });
    expect(answer.text).toBe("| Metric | Q3 2026 |\n|---|---|\n| Net debt | [=1][^1] |");
    expect(answer.citations).toMatchObject([{ marker: 1, check: "found" }]);
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

  // protects=a figure the assistant writes into a Mind carries its input's Citation there, checked; fails_when=the Mind holds the figure's number with no Citation; no_claim=the reply, which only says what was done.
  test("in a Mind the assistant writes", async () => {
    const model = calculatingModel(
      () => ({ calls: [{ tool: "add_to_mind", input: { content: "Net debt was [=1] at Q3." } }] }),
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
});
