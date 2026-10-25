import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { AnswerToolCall, ConversationAnswer, Core } from "../../src/core";
import { toolClaimsIn, unrunToolClaims } from "../../src/core/answers/claimedTools";
import { answerEnded, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";

/**
 * A reply that says a figure was calculated or checked, or that a search ran,
 * when none of the Answer's calls did (#1796): read from the reply's own
 * sentences that give the act to a Tool, IncarnaMind or the assistant, never
 * from one reporting a Document, and held to the calls. A model with the
 * calculation Tool is asked once more; a reply that still says so, or one
 * written without Tools, keeps a line under it. The models are scripted.
 */

describe("What a reply says a Tool did", () => {
  // protects=a sentence that gives a calculation, a check of figures or a search to a Tool, IncarnaMind or the assistant reads as a claim, in English and Chinese; fails_when=one reads as none; no_claim=every wording a model may use.
  test.each([
    ["The calculation tool confirms 3.37x and GBP 15m.", ["calculate"]],
    ["Using the calculation Tool: 310 / 95 = 3.26x.", ["calculate"]],
    ["Recomputed with the calculator, the headroom is £22.5m.", ["calculate"]],
    ["I recalculated the ratio: 3.26x.", ["calculate"]],
    ["I've verified the figures, and the headroom is £22.5m.", ["calculate"]],
    ["IncarnaMind calculated the headroom as £22.5m.", ["calculate"]],
    ["Checked by IncarnaMind's calculation: 3.26x.", ["calculate"]],
    ["- I computed 310 / 95 = 3.26.", ["calculate"]],
    ["I searched your Documents for the covenant.", ["search"]],
    ["The search found the executed agreement and the amendment.", ["search"]],
    ["计算工具确认：杠杆率为3.37倍。", ["calculate"]],
    ["我用计算工具核对了这些数字。", ["calculate"]],
    ["使用计算工具重新计算：310/95=3.26倍。", ["calculate"]],
    ["经计算工具验证，结果正确。", ["calculate"]],
    ["我重新计算了杠杆率，结果是3.26倍。", ["calculate"]],
    ["我已核实上述数字。", ["calculate"]],
    ["我搜索了你的文档。", ["search"]],
    ["搜索结果显示，修订函2027年才生效。", ["search"]],
  ])("“%s” claims %j", (reply, tools) => {
    expect(toolClaimsIn(reply)).toEqual(tools);
  });

  // protects=a sentence that reports what a Document says, or says no Tool was or can be used, or asks, is no claim; fails_when=one reads as a claim, which would put a wrong line under an honest Answer; no_claim=every wording a Document may use.
  test.each([
    "The auditor confirmed net debt of GBP 310m.",
    "Leverage is calculated in the report as Total Net Debt divided by EBITDA.",
    "According to the agreement, Leverage is calculated on each Quarter Date.",
    "Northbank's covenant calculator gives 3.37x.",
    "The lender's calculation tool, described in Schedule 3, shows 3.37x.",
    "I didn't use the calculation Tool: this model can't call it.",
    "The Documents do not contain a calculation tool; I cannot use IncarnaMind's calculation Tool to verify figures.",
    "**I cannot use IncarnaMind's calculation Tool.** Any number I work out is my own working.",
    "The calculation Tool isn't available with this model, so 310 / 95 ≈ 3.26 is my own working.",
    "Without the calculation tool, these figures are unchecked.",
    "You can check this with the calculation tool.",
    "Would you like me to run the calculation tool?",
    "The 3.37x I calculated earlier was wrong.",
    "You asked me to “recompute using the calculation Tool”.",
    "The facility agent confirmed the ratio in its compliance certificate.",
    "310 / 95 = 3.26, so the earlier 3.37x was wrong.",
    "IncarnaMind checked every quote against its page.",
    "An online loan calculator would give a different figure.",
    "审计师确认净负债为3.1亿英镑。",
    "报告中计算得出杠杆率为3.26倍。",
    "根据协议，杠杆率按净负债除以EBITDA计算。",
    "贷款方的计算工具显示为3.37倍。",
    "我没有使用计算工具，这个模型无法调用它。",
    "这个模型无法调用计算工具。",
    "这个模型无法调用 IncarnaMind 的计算工具，以下数字是我自己算的。",
    "你可以用计算工具核对这些数字。",
    "财务部已核对上述数字。",
    "我核对了协议的生效日期。",
    "我之前算出的3.37倍是错的。",
  ])("“%s” claims nothing", (reply) => {
    expect(toolClaimsIn(reply)).toEqual([]);
  });

  // protects=a claim is held to the calls: a calculate call that worked out figures backs a calculation, a search that ran backs a search; fails_when=a call that did nothing backs one, or one that did is ignored; no_claim=that the right figures were calculated.
  test("held to what the calls did", () => {
    const reply = "I recalculated the ratio: 3.26x. I searched your Documents first.";
    const calculated = (resultCount: number): AnswerToolCall => ({
      id: "calculated-figures",
      tool: "calculate",
      source: "documents",
      input: {},
      status: "done",
      resultCount,
    });
    const searched = (status: AnswerToolCall["status"]): AnswerToolCall => ({
      id: "s1",
      tool: "search_documents",
      source: "documents",
      input: { query: "leverage" },
      status,
      resultCount: 3,
    });

    expect(unrunToolClaims(reply, [])).toEqual(["calculate", "search"]);
    expect(unrunToolClaims(reply, [calculated(0), searched("failed")])).toEqual([
      "calculate",
      "search",
    ]);
    expect(unrunToolClaims(reply, [calculated(1), searched("done")])).toEqual([]);
  });
});

const COVENANT = "Clause 21.2: Leverage shall not exceed 3.50:1.";
const FIGURES = "Total Net Debt 310; EBITDA 95 (GBP m, final).";
const CEDAR = {
  name: "Cedar compliance.md",
  contents: `# Cedar compliance\n\n${COVENANT}\n\n${FIGURES}\n`,
};
const CLAIM = "The calculation tool confirms 3.37x and GBP 15m.";
const ASKED = "Recompute 310/95 using the calculation Tool. Is 3.37x correct?";

/** The assistant's core with `model` as `provider`, and the covenant added as a Document. */
async function setUp(
  model: MockLanguageModelV4,
  provider:
    | { kind: "anthropic"; apiKey: string; modelId: string }
    | { kind: "ollama"; modelId: string },
) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  const saved = await core.saveChatProvider(provider);
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  const sources = await createTempDataFolder();
  await addAndProcess(core, [await writeSourceFile(sources, CEDAR.name, CEDAR.contents)]);
  return core;
}

async function ask(core: Core, text: string): Promise<ConversationAnswer> {
  const asked = await core.askInConversation({ text });
  if (!asked.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(asked)}`);
  const ended = await answerEnded(core, asked.answerId);
  if (ended.event !== "finished") throw new Error(`The Answer failed: ${JSON.stringify(ended)}`);
  const content = await core.getConversation(asked.conversation.id);
  const answer = content.messages.find((message) => message.id === asked.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return answer;
}

const RATIO = {
  marker: 1,
  label: "Leverage at 30 September 2026",
  formula: "debt / ebitda",
  inputs: [
    { name: "debt", label: "Total Net Debt", citation: 1, number: "310" },
    { name: "ebitda", label: "EBITDA", citation: 1, number: "95" },
  ],
};

/**
 * Claude Haiku 5.5, scripted: it searches, then says the calculation Tool
 * confirmed 3.37x; asked again with what its calls did, it calculates, if
 * `obeys`, and says so again otherwise.
 */
function claimingModel(obeys: boolean, asks: ModelCall[]) {
  return scriptedModel((call) => {
    const searches = call.results.filter((result) => result.tool === "search_documents");
    if (searches.length === 0) {
      return { calls: [{ tool: "search_documents", input: { query: "Cedar leverage" } }] };
    }
    const toldAgain = call.prompt.includes("Call calculate now");
    if (!toldAgain) return { text: CLAIM };
    asks.push(call);
    if (!obeys) return { text: CLAIM };
    if (!call.results.some((result) => result.tool === "calculate")) {
      const passage = shownPassages(searches[0]?.text ?? "")[0]?.id;
      return {
        calls: [
          {
            tool: "cite",
            input: {
              citations: [{ marker: 1, passage, location: "Cedar compliance", quote: FIGURES }],
            },
          },
          { tool: "calculate", input: { figures: [RATIO] } },
        ],
      };
    }
    return { text: "No: leverage is [=1], from net debt of 310 and EBITDA of 95[^1]." };
  });
}

describe("A reply that says a Tool ran when none did", { timeout: 60_000 }, () => {
  // protects=a model with the calculation Tool that says it confirmed figures is asked once, with what its calls did, and once it calculates, no line stays and the ask is its own step; fails_when=it isn't asked, is asked twice, or a line stays; no_claim=that a real model then calculates.
  test("with the Tool, is asked once, and calculates", async () => {
    const asks: ModelCall[] = [];
    const core = await setUp(claimingModel(true, asks), {
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });

    const answer = await ask(core, ASKED);

    expect(asks.length).toBeGreaterThan(0);
    expect(answer.text).not.toContain("calculation tool confirms");
    expect(answer.toolCalls.find((call) => call.tool === "calculate")?.resultCount).toBe(1);
    expect(answer.steps?.askedAgainFor).toEqual(["calculate"]);
    expect(answer.steps).not.toHaveProperty("unrunTools");
  });

  // protects=one that says so again keeps its reply, with the line, and is asked no more than once; fails_when=it is asked again, or the line is missing; no_claim=none beyond protects.
  test("with the Tool, saying so again, keeps the reply and the line", async () => {
    const asks: ModelCall[] = [];
    const core = await setUp(claimingModel(false, asks), {
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });

    const answer = await ask(core, ASKED);

    expect(asks).toHaveLength(1);
    expect(answer.text).toBe(CLAIM);
    expect(answer.steps?.unrunTools).toEqual(["calculate"]);
    expect(answer.steps).not.toHaveProperty("calculateUnavailable");
    expect(answer.steps?.askedAgainFor).toEqual(["calculate"]);
  });

  // protects=a model without Tools (structured output) is told it has no calculation Tool, and a reply that says one confirmed its figures keeps a line saying this model can't use it, with no second request; fails_when=it isn't told, isn't flagged, or is asked again; no_claim=that a real small model obeys.
  test("without Tools, is told there is no calculation Tool, and flagged", async () => {
    const answers: ModelCall[] = [];
    const model = scriptedModel((call) => {
      if (call.tools.length > 0) {
        return { error: { status: 400, message: "this model does not support tools" } };
      }
      answers.push(call);
      return { text: JSON.stringify({ answer: CLAIM, citations: [] }) };
    });
    const core = await setUp(model, { kind: "ollama", modelId: "local-model" });

    const answer = await ask(core, ASKED);

    expect(answers).toHaveLength(1);
    expect(answers[0]?.system).toContain("IncarnaMind has no calculation Tool for this model");
    expect(answer.text).toBe(CLAIM);
    expect(answer.steps?.unrunTools).toEqual(["calculate"]);
    expect(answer.steps?.calculateUnavailable).toBe(true);
    expect(answer.steps).not.toHaveProperty("askedAgainFor");
  });

  // protects=a reply that reports what a Document says gets no line and no second request; fails_when=it is flagged or asked about; no_claim=none beyond protects.
  test("a reply reporting a Document is left alone", async () => {
    const calls: ModelCall[] = [];
    const model = scriptedModel((call) => {
      calls.push(call);
      if (call.results.length === 0) {
        return { calls: [{ tool: "search_documents", input: { query: "Cedar leverage" } }] };
      }
      return {
        text: "The auditor confirmed net debt of 310, and the agreement caps Leverage at 3.50:1.",
      };
    });
    const core = await setUp(model, { kind: "ollama", modelId: "local-model" });

    const answer = await ask(core, ASKED);

    expect(calls.some((call) => call.prompt.includes("no call in the record did"))).toBe(false);
    expect(answer.steps).not.toHaveProperty("unrunTools");
    expect(answer.steps).not.toHaveProperty("askedAgainFor");
  });
});
