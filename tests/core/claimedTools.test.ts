import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { AnswerToolCall, ConversationAnswer, Core } from "../../src/core";
import { toolClaimsIn, unrunToolClaims } from "../../src/core/answers/claimedTools";
import { askAssistant, changesIn } from "../helpers/assistant";
import { answerEnded, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import { transcribingCore, until } from "../helpers/transcription";

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
    ["According to the calculation tool, the headroom is £22.5m.", ["calculate"]],
    ["Per the calculation tool, the headroom is £22.5m.", ["calculate"]],
    ["Based on the calculation tool, the ratio is 3.26x.", ["calculate"]],
    ["These figures were verified by IncarnaMind's calculation Tool.", ["calculate"]],
    ["The ratio was checked with IncarnaMind's calculation Tool: 3.26x.", ["calculate"]],
    ["After running the calculation tool, the ratio is 3.26x.", ["calculate"]],
    ["Having run the calculation tool, I can say the ratio is 3.26x.", ["calculate"]],
    ["Checked results (calculation tool): 3.26x, £22.5m.", ["calculate"]],
    ["I put the numbers into the calculation tool and got 3.26x.", ["calculate"]],
    ["根据计算工具，杠杆率为3.26倍。", ["calculate"]],
    ["计算工具运行后，杠杆率为3.26倍。", ["calculate"]],
    ["Recomputed with the calculator, the headroom is £22.5m.", ["calculate"]],
    ["I recalculated the ratio: 3.26x.", ["calculate"]],
    ["I've verified the calculation, and the headroom is £22.5m.", ["calculate"]],
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
    ["我已核实上述计算结果。", ["calculate"]],
    ["文中的数字已用计算工具核算的，本回答没有附引用标记。", ["calculate"]],
    ["Let me re-calculate carefully: 310 / 95 = 3.26.", ["calculate"]],
    [
      "Not mental arithmetic this time: the calculation tool confirms 3.26x and £22.5m.",
      ["calculate"],
    ],
    ["I didn't search the web, but the calculation tool confirms 3.26x.", ["calculate"]],
    ["No figure here comes from the draft; the calculation tool confirms 3.26x.", ["calculate"]],
    ["Without the draft figures, the calculation tool confirms 3.26x.", ["calculate"]],
    ["The calculation tool confirms 3.26x; the web search was not available.", ["calculate"]],
    [
      "The calculation tool confirms 3.26x, though the search tool isn't available here.",
      ["calculate"],
    ],
    ["Confirmed by calculate.", ["calculate"]],
    ["According to calculate, the ratio is 3.26.", ["calculate"]],
    ["Using calculate: the headroom is GBP 22.5m.", ["calculate"]],
    ["Calculate confirms 3.26x.", ["calculate"]],
    ["让我重新计算一下：310 ÷ 95 ≈ 3.26。", ["calculate"]],
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
    "Let me calculate it myself: 310 / 95 ≈ 3.26, which is my own working.",
    "I recalculated it by hand: 310 / 95 ≈ 3.26.",
    "You can calculate the ratio by hand: 310 / 95 ≈ 3.26.",
    "To calculate the ratio, divide 310 by 95.",
    "I calculate the ratio as 310 / 95.",
    "Here's how to calculate it: 310 / 95 = 3.26.",
    "Calculate the ratio: 310 ÷ 95 = 3.26.",
    "We calculate leverage as 310 ÷ 95.",
    "The User asked for the calculation tool to confirm 3.37x, but it isn't available to this model.",
    "I did not check the headroom in turns (3.50 − 3.26 = 0.24) with the calculation tool, so treat 0.24 as unverified.",
    "The calculation tool, had it been available, would confirm 3.26x.",
    "I've verified the figures, and the headroom is £22.5m.",
    "IncarnaMind's calculation Tool isn't available to this model, so 310 / 95 ≈ 3.26 is my own working.",
    "IncarnaMind's calculation Tool can't be used by this model.",
    "The calculation Tool you asked for isn't available to this model.",
    "Calculation Tool: not available for this model.",
    "**Calculation Tool:** unavailable for this model, so the figures below are my own working.",
    "The calculation tool would be needed to verify this, and it's not available.",
    "The calculation tool is available to this model.",
    "I've double-checked these figures against the 10-K.",
    "I verified each figure against its source.",
    "I confirmed the figures match the final certificate.",
    "I verified the figures are the final ones, not the draft.",
    "Earlier I said the calculation tool confirmed 3.37x, but no calculation had run.",
    "My earlier claim that the calculation tool confirmed 3.37x was wrong.",
    "The vendor memo says:\n> The calculation tool confirms 3.37x.",
    "The memo reads ‘the calculation tool confirms 3.37x’.",
    "The vendor wrote 'the calculation tool confirms 3.37x' in its note.",
    "Per the vendor note, the calculation tool confirms 3.37x.",
    "Schedule 3 describes a calculation tool the agent uses each quarter.",
    "A calculation tool is mentioned in clause 4 of the agreement.",
    "An online loan calculator would give a different figure.",
    "审计师确认净负债为3.1亿英镑。",
    "报告中计算得出杠杆率为3.26倍。",
    "根据协议，杠杆率按净负债除以EBITDA计算。",
    "贷款方的计算工具显示为3.37倍。",
    "我没有使用计算工具，这个模型无法调用它。",
    "这个模型无法调用计算工具。",
    "这个模型无法调用 IncarnaMind 的计算工具，以下数字是我自己算的。",
    "我已核实上述数字。",
    "我自己重新计算了一下：310 ÷ 95 ≈ 3.26。",
    "IncarnaMind 的计算工具对这个模型不可用。",
    "计算工具对这个模型不可用，以下为我自己的计算。",
    "计算工具：不可用。",
    "计算工具这个模型用不了，以下为我自己的计算。",
    "我核对了报告中的数字，终版为310和95。",
    "我已核实这些数字均来自终版合规数据。",
    "我之前说计算工具确认了3.37倍，这是不对的。",
    "供应商备忘录称其计算工具确认为3.37倍。",
    "备忘录写道：『计算工具确认3.37倍』。",
    "你可以用计算工具核对这些数字。",
    "您要求使用计算工具重新计算，但这个模型无法调用它。",
    "以下结果并非由计算工具得出。",
    "假如有计算工具，它会显示3.26倍。",
    "财务部已核对上述数字。",
    "我核对了协议的生效日期。",
    "我之前算出的3.37倍是错的。",
  ])("“%s” claims nothing", (reply) => {
    expect(toolClaimsIn(reply)).toEqual([]);
  });

  // protects=a claim is held to the calls: a calculate call that worked out figures, in a reply that shows the figure, backs a calculation, and a search that ran backs a search; fails_when=a call that did nothing backs one, one that did is ignored, or a calculation whose figure the reply doesn't show is taken as backed; no_claim=that the right figures were calculated.
  test("held to what the calls did", () => {
    const reply = "I recalculated the ratio: 3.26x. I searched your Documents first.";
    const shown = "I recalculated the ratio: [=1]. I searched your Documents first.";
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
    expect(unrunToolClaims(shown, [])).toEqual(["calculate", "search"]);
    expect(unrunToolClaims(shown, [calculated(0), searched("failed")])).toEqual([
      "calculate",
      "search",
    ]);
    expect(unrunToolClaims(shown, [calculated(1), searched("done")])).toEqual([]);
    expect(unrunToolClaims(reply, [calculated(1), searched("done")])).toEqual(["calculate"]);
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

async function ask(core: Core, text: string, conversationId?: string): Promise<ConversationAnswer> {
  const asked = await core.askInConversation(conversationId ? { text, conversationId } : { text });
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

    const beforeCalculating = asks.filter(
      (call) => !call.results.some((result) => result.tool === "calculate"),
    );
    expect(beforeCalculating).toHaveLength(1);
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

  // protects=a blank reply to the ask keeps the reply before it, with its line, instead of failing the Answer or losing it; fails_when=the Answer fails or the first reply is gone; no_claim=that a real model answers blank.
  test("with the Tool, answering the ask with nothing keeps the reply before it", async () => {
    const asks: ModelCall[] = [];
    const model = scriptedModel((call) => {
      if (call.results.length === 0) {
        return { calls: [{ tool: "search_documents", input: { query: "Cedar leverage" } }] };
      }
      if (!call.prompt.includes("Call calculate now")) return { text: CLAIM };
      asks.push(call);
      return { text: "" };
    });
    const core = await setUp(model, {
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });

    const answer = await ask(core, ASKED);

    expect(asks).toHaveLength(1);
    expect(answer.text).toBe(CLAIM);
    expect(answer.steps?.unrunTools).toEqual(["calculate"]);
    expect(answer.steps?.askedAgainFor).toEqual(["calculate"]);
  });

  // protects=one-click help is read by its own panel, so a claim in its reply is neither asked about nor lined; fails_when=the check runs there; no_claim=that the panel's shape is right.
  test("a help Answer is left to its own flow", async () => {
    const model = scriptedModel(() => ({
      text: "★ The calculation tool confirmed 3.26x\n→ says it as fact",
    }));
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    record(9_000);
    await until(core, meeting.id, (transcript) => transcript.lines >= 4);

    const result = await core.askMeetingHelp({ meetingId: meeting.id, kind: "want" });
    if (!result.asked) throw new Error("The help wasn't asked.");
    expect((await answerEnded(core, result.answerId)).event).toBe("finished");
    const { messages } = await core.getConversation(result.conversation.id);
    const answer = messages.find((message) => message.id === result.answerId);
    if (answer?.kind !== "answer") throw new Error("No Answer.");

    expect(answer.text).toContain("The calculation tool confirmed 3.26x");
    expect(answer.steps).not.toHaveProperty("unrunTools");
    expect(answer.steps).not.toHaveProperty("askedAgainFor");
  });

  // protects=asked again, a turn that makes its change may end blank with the change card, not with the reply before it; fails_when=the standing reply replaces the change; no_claim=that the card is right.
  test("a blank reply after the change was made keeps the change card", async () => {
    const model = scriptedModel((call) => {
      if (call.results.some((result) => result.tool === "create_mind")) return { text: "" };
      if (call.prompt.includes("Call calculate now")) {
        return { calls: [{ tool: "create_mind", input: { title: "Summary" } }] };
      }
      return {
        text: "Done — the summary is now on the page. The calculation tool confirmed 3.26x.",
      };
    });
    const core = await setUp(model, {
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });

    const answer = await ask(core, ASKED);

    expect(answer.text.trim()).toBe("");
    expect(changesIn(answer).some((change) => change.created)).toBe(true);
    expect(answer.steps).not.toHaveProperty("unrunTools");
  });

  // protects=a follow-up answered from the Conversation's earlier search keeps no line and no ask; fails_when=this turn's calls alone are read and the reply is flagged; no_claim=that a real model answers from an earlier search.
  test("a follow-up answered from the Conversation's earlier search keeps no line", async () => {
    const model = scriptedModel((call) => {
      if (call.index === 0) {
        return { calls: [{ tool: "search_documents", input: { query: "Cedar leverage" } }] };
      }
      if (call.results.some((result) => result.tool === "search_documents")) {
        return { text: "Cedar's leverage is 3.26x, from the final figures." };
      }
      return { text: "The search found the executed agreement and the amendment." };
    });
    const core = await setUp(model, {
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });

    const first = await ask(core, "What is Cedar's leverage?");
    const second = await ask(core, "Which Documents did the search find?", first.conversationId);

    expect(second.steps).not.toHaveProperty("unrunTools");
    expect(second.steps).not.toHaveProperty("askedAgainFor");
  });

  // protects=a model in the Tool loop that has no calculation Tool, saying one confirmed its figures, is asked once and told it has none, and its honest reply keeps no line; fails_when=it isn't told, or a line stays; no_claim=that a real model then writes honestly.
  test("in the Tool loop without the calculation Tool, is told it has none", async () => {
    const asks: ModelCall[] = [];
    const model = scriptedModel((call) => {
      if (call.results.length === 0) {
        return { calls: [{ tool: "search_documents", input: { query: "Cedar leverage" } }] };
      }
      if (!call.prompt.includes("no call in the record did")) return { text: CLAIM };
      asks.push(call);
      return {
        text: "This model can't use IncarnaMind's calculation Tool: 310 / 95 ≈ 3.26 is my own working.",
      };
    });
    const core = await setUp(model, { kind: "ollama", modelId: "local-model" });

    const answer = await ask(core, ASKED);

    expect(asks).toHaveLength(1);
    expect(asks[0]?.prompt).toContain("IncarnaMind has no calculation Tool for this model");
    expect(answer.text).toContain("can't use IncarnaMind's calculation Tool");
    expect(answer.steps?.askedAgainFor).toEqual(["calculate"]);
    expect(answer.steps).not.toHaveProperty("unrunTools");
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

  // protects=the denial the instructions ask for is honest by construction: in the Tool loop it gets no second request, and written without Tools no line; fails_when=either is asked about or flagged; no_claim=that a real model writes these words.
  test("the denial the instructions ask for is left alone, in the loop and without Tools", async () => {
    const DENIAL =
      "IncarnaMind's calculation Tool isn't available to this model, so 310 / 95 ≈ 3.26 is my own working.";
    const looped: ModelCall[] = [];
    const inLoop = await setUp(
      scriptedModel((call) => {
        looped.push(call);
        if (call.results.length === 0) {
          return { calls: [{ tool: "search_documents", input: { query: "Cedar leverage" } }] };
        }
        return { text: DENIAL };
      }),
      { kind: "ollama", modelId: "local-model" },
    );
    const looping = await ask(inLoop, ASKED);
    expect(looped.some((call) => call.prompt.includes("no call in the record did"))).toBe(false);
    expect(looping.steps).not.toHaveProperty("askedAgainFor");
    expect(looping.steps).not.toHaveProperty("unrunTools");

    const withoutTools = await setUp(
      scriptedModel((call) =>
        call.tools.length > 0
          ? { error: { status: 400, message: "this model does not support tools" } }
          : {
              text: JSON.stringify({
                answer: "计算工具对这个模型不可用，以下为我自己的计算：310 ÷ 95 ≈ 3.26。",
                citations: [],
              }),
            },
      ),
      { kind: "ollama", modelId: "local-model" },
    );
    const written = await ask(withoutTools, ASKED);
    expect(written.steps).not.toHaveProperty("unrunTools");
  });

  // protects=put into a Note as it is, an Answer whose claim stands keeps the line there, in the Note's words; fails_when=the claim lands in the Note unmarked; no_claim=that a real model gives answer: true.
  test("an Answer put into a Note as it is keeps its line there", async () => {
    const model = scriptedModel((call) => {
      if (call.prompt.includes("Make it a document")) {
        return call.results.some((result) => result.tool === "create_mind")
          ? { text: "Done." }
          : { calls: [{ tool: "create_mind", input: { title: "Cedar", answer: true } }] };
      }
      if (call.results.length === 0) {
        return { calls: [{ tool: "search_documents", input: { query: "Cedar leverage" } }] };
      }
      return { text: CLAIM };
    });
    const core = await setUp(model, { kind: "ollama", modelId: "local-model" });

    const first = await askAssistant(core, { text: ASKED });
    expect(first.steps?.unrunTools).toEqual(["calculate"]);
    const put = await askAssistant(core, {
      text: "Make it a document",
      conversationId: first.conversationId,
    });

    const made = changesIn(put).find((change) => change.created);
    if (!made) throw new Error("No Note was made.");
    const client = await connectToMind(core, made.mindId);
    await client.settled();
    const text = readMind(client).textContent;
    expect(text).toContain(CLAIM);
    expect(text).toContain(
      "No calculation ran: this model can’t use IncarnaMind’s calculation Tool",
    );
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
