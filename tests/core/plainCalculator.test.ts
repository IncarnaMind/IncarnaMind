/**
 * The plain calculator an Answer's model calls (#3393): each input a plain number with its quote,
 * an expression, a label and the text the figure is shown as. IncarnaMind confirms by digits that
 * each number stands in its quote and that the shown text carries the result, does the
 * arithmetic, and the Answer shows the figure with its working. Through the core's public
 * interface, as the assistant uses it, with a scripted chat model.
 */
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { Core, MarkedFigure } from "../../src/core";
import { answerBlocks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import { inputInWorking, readCalculatedFigureAttributes } from "../../src/shared/calculatedFigures";
import { answerEnded, type ShownPassage, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { answerRequests, judgesNothing, scriptedModel, scriptedModels } from "../helpers/models";

const LINE = "The bakery used 52,000 kWh of electricity at 31.5 pence per kWh.";
const BAKERY = {
  name: "Gullhaven Bakery energy.md",
  text: `# Gullhaven Bakery energy\n\n${LINE}\n`,
};

type Call = { tool: string; input: unknown };

/** Searches, cites the line as [^1], calculates `figures`, then writes `answer`. */
function calculatingModel(figures: unknown[], answer: string): MockLanguageModelV4 {
  return scriptedModel(
    (call) => {
      const searched = call.results.find((result) => result.tool === "search_documents");
      if (!searched)
        return { calls: [{ tool: "search_documents", input: { query: "bakery electricity" } }] };
      if (!call.results.some((result) => result.tool === "cite")) {
        const passage = shownPassages(searched.text).find((each: ShownPassage) =>
          each.document.startsWith("Gullhaven"),
        );
        const cite: Call = {
          tool: "cite",
          input: {
            citations: [
              { marker: 1, passage: passage?.id, location: passage?.location, quote: LINE },
            ],
          },
        };
        return { calls: [cite, { tool: "calculate", input: { figures } }] };
      }
      return { text: answer };
    },
    { generate: judgesNothing },
  );
}

async function asked(model: MockLanguageModelV4, question: string) {
  const core: Core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    answerPaths: { retrievesFirst: () => false },
  });
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  await addAndProcess(core, [
    await writeSourceFile(await createTempDataFolder(), BAKERY.name, BAKERY.text),
  ]);
  const started = await core.askInConversation({ text: question });
  if (!started.asked) throw new Error("The Question wasn't asked.");
  const ended = await answerEnded(core, started.answerId);
  if (ended.event !== "finished") throw new Error("The Answer failed.");
  const { messages } = await core.getConversation(started.conversation.id);
  const answer = messages.find((message) => message.id === started.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return answer;
}

/** What the model was told by each calculate call, as its last request shows them. */
function told(model: MockLanguageModelV4): string[] {
  return (answerRequests(model).at(-1)?.prompt ?? []).flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) =>
          part.type === "tool-result" &&
          part.toolName === "calculate" &&
          part.output.type === "text"
            ? [part.output.value]
            : [],
        )
      : [],
  );
}

/** An Answer's text as its reader sees it, a figure as its shown text, a missing one as ‹mark›. */
const shown = (nodes: readonly NodeJSON[]): string =>
  nodes
    .map((node) =>
      node.type === "text"
        ? (node.text ?? "")
        : node.type === "calculatedFigure"
          ? (readCalculatedFigureAttributes(node.attrs)?.figure.shown ?? "")
          : node.type === "missingNumber"
            ? "‹mark›"
            : shown(node.content ?? []),
    )
    .join("");

const COST = {
  marker: 1,
  label: "Electricity cost 2025 (£)",
  inputs: [
    { name: "kwh", citation: 1, value: 52_000 },
    { name: "price", citation: 1, value: 0.315 },
  ],
  formula: "kwh * price",
  shown: "£16,380",
};

describe("The plain calculator", { timeout: 60_000 }, () => {
  // protects=a figure an Answer works out shows as the model's shown text, with its working: the quoted numbers and the values used; fails_when=the figure shows another unit or text than the model's, or its working loses the value used or the number as quoted
  test("shows the figure as its model writes it, with its working", async () => {
    const model = calculatingModel([COST], "The bakery's electricity cost [=1] in 2025[^1].");
    const answer = await asked(model, "What did the bakery's electricity cost?");

    expect(told(model)).toEqual([
      [
        "Recorded [=1] = £16,380 (Electricity cost 2025 (£): 52,000 × 0.315 = £16,380 · 31.5 → 0.315).",
        "Write each marker in its number's place, in the text or a table's cell, as in \"grew [=1] in 2025\": it shows as its shown text, so write neither the number nor its unit beside it.",
      ].join("\n"),
    ]);
    expect(shown(answerBlocks(answer))).toBe("The bakery's electricity cost £16,380 in 2025.");
    const [figure] = answer.figures;
    expect(figure).toMatchObject({
      label: "Electricity cost 2025 (£)",
      formula: "kwh * price",
      value: 16_380,
      shown: "£16,380",
      inputs: [
        { name: "kwh", citation: { quote: LINE, check: "found" }, number: { chars: "52,000" } },
        { name: "price", citation: { quote: LINE, check: "found" }, number: { chars: "31.5" } },
      ],
    });
    // The card's line of working: the value used where the model moved the quoted number.
    expect(figure?.inputs.map(inputInWorking)).toEqual(["52,000", "0.315"]);
  });

  // protects=a figure rests only on numbers its quotes write and on the result the arithmetic gives; fails_when=a number not in its quote, or a shown text whose digits aren't the result's, is shown as a calculated figure
  test("refuses a number not in its quote, and a shown text that doesn't carry the result", async () => {
    const model = calculatingModel(
      [
        {
          ...COST,
          inputs: [COST.inputs[0], { name: "price", citation: 1, value: 0.13 }],
          shown: "£6,760",
        },
        { ...COST, marker: 2, shown: "£16,830" },
      ],
      "It cost [=1], or [=2], in 2025[^1].",
    );
    const answer = await asked(model, "What did the bakery's electricity cost?");

    const [said = ""] = told(model);
    expect(said).toMatch(/^Nothing was recorded\.\nFix these with another calculate call:/);
    expect(said).toContain("[=1] price: 0.13 isn't in its quote, which has 52,000, 31.5");
    expect(said).toContain('[=2] the formula gives 16,380, and shown "£16,830"');
    expect(answer.figures).toEqual([]);
    expect(shown(answerBlocks(answer))).toBe("It cost ‹mark›, or ‹mark›, in 2025.");
  });

  // protects=a figure rests on whole numbers of its quotes, its shown text carries the result to every digit it writes, and a comparison's says its result; fails_when=part of a longer number, a shown text whose zeros after the point aren't the result's, or a "No" for a true comparison is recorded
  test("refuses part of a longer number, a shown text more exact than its result, and a comparison's wrong word", async () => {
    const model = calculatingModel(
      [
        {
          ...COST,
          inputs: [{ name: "price", citation: 1, value: 31, number: "31" }],
          formula: "price",
          shown: "31p",
        },
        { ...COST, marker: 2, shown: "£16,000.0" },
        { ...COST, marker: 3, formula: "kwh > price", shown: "No" },
      ],
      "It used [=1], cost [=2], and the use was larger: [=3][^1].",
    );
    const answer = await asked(model, "What did the bakery's electricity cost?");

    const [said = ""] = told(model);
    expect(said).toContain("[=1] price: 31 isn't in its quote, which has 52,000, 31.5");
    expect(said).toContain('[=2] the formula gives 16,380, and shown "£16,000.0"');
    expect(said).toContain('[=3] the formula gives yes, and shown "No" doesn\'t say so');
    expect(answer.figures).toEqual([]);
  });

  // protects=a figure an older build worked out, its unit read by rule, still opens and shows as it did, its card's line writing each input as its quote does; fails_when=an older figure's shown text or input numbers read otherwise than they were saved
  test("a figure an older build worked out still shows as it did", () => {
    const quote = "Revenue was $1,482.6 million in 2025, compared with $1,231.0 million in 2024.";
    const input = (name: string, chars: string, value: number) => ({
      name,
      label: name,
      citation: {
        passageId: "p1",
        documentId: "d1",
        documentName: "Acme Annual Report 2025",
        contentHash: "h1",
        pageFrom: 1,
        pageTo: 1,
        location: null,
        quote,
        check: "found" as const,
        checkReason: null,
      },
      number: {
        chars,
        at: quote.indexOf(chars),
        value,
        scale: 1_000_000,
        scaleWord: "million",
        unit: { kind: "currency" as const, code: "USD" },
        decimals: 1,
        approximate: false,
        reading: null,
      },
      cell: null,
      unitStatement: null,
    });
    const older: MarkedFigure = {
      marker: 1,
      label: "Revenue growth 2025",
      formula: "rev2025 / rev2024 - 1",
      inputs: [
        input("rev2025", "$1,482.6 million", 1_482_600_000),
        input("rev2024", "$1,231.0 million", 1_231_000_000),
      ],
      value: 1482.6 / 1231 - 1,
      unit: { kind: "ratio" },
      approximate: false,
      shown: "20.4%",
      show: { language: "en", as: "percent", decimals: null, scale: null },
      literals: [],
      engine: 1,
      written: null,
    };
    const blocks = answerBlocks({
      text: "Revenue grew [=1] in 2025.",
      citations: [],
      figures: [older],
      status: "done",
    });
    expect(shown(blocks)).toBe("Revenue grew 20.4% in 2025.");
    const [saved] = blocks.flatMap((block) =>
      (block.content ?? []).flatMap((node) =>
        node.type === "calculatedFigure" ? [readCalculatedFigureAttributes(node.attrs)] : [],
      ),
    );
    expect(saved?.figure.inputs.map(inputInWorking)).toEqual([
      "$1,482.6 million",
      "$1,231.0 million",
    ]);
  });
});
