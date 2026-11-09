import { describe, expect, test } from "vitest";
import { CLAIM_CHECK_INSTRUCTIONS } from "../../src/core/answers/claimedChanges";
import { askAssistant, changesIn } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import {
  claimCheckReply,
  type GenerateCall,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/**
 * A summary the assistant wrote into the empty Note in front, which the window applied, then made
 * longer: the change log read by the claim check must back the reply's claim (#1559).
 */

const asked = ({ options }: ModelCall): string => {
  const last = options.prompt.filter((message) => message.role === "user").at(-1);
  if (!last) return "";
  return typeof last.content === "string"
    ? last.content
    : last.content.map((part) => ("text" in part ? part.text : "")).join("");
};

const called = (call: ModelCall, tool: string) => call.results.some((each) => each.tool === tool);

const SUMMARY = "## Summary\n\nThe paper is about spring tides.";
const LONGER = "## Summary\n\nThe paper is about spring tides, and how the moon drives them.";

async function wroteThenLonger(
  {
    first,
    second,
    claim,
    edit = true,
  }: { first: string; second: string; claim: string; edit?: boolean },
  windowApplies: boolean,
) {
  let record = "";
  const model = scriptedModel(
    (call): ScriptedReply => {
      if (called(call, "add_to_mind")) return { text: "Wrote the summary." };
      if (asked(call).endsWith(first))
        return { calls: [{ tool: "add_to_mind", input: { content: SUMMARY } }] };
      if (called(call, "edit_mind") || !edit) return { text: claim };
      return { calls: [{ tool: "edit_mind", input: { content: LONGER } }] };
    },
    {
      generate: (call: GenerateCall) => {
        if (call.question !== "claimed-changes") return { text: "" };
        record = call.prompt;
        return claimCheckReply(
          call,
          call.prompt.includes('"applied": true') ? [] : [{ sentence: claim, kind: "changed" }],
        );
      },
    },
  );
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title: "" });

  const firstAnswer = await askAssistant(core, { text: first, mindId: mind.id });
  const changes = changesIn(firstAnswer);
  if (windowApplies) {
    await core.applyAskedChanges({
      answerId: firstAnswer.id,
      mindId: mind.id,
      requests: changes.flatMap((each) => (each.request === "" ? [] : [each.request])),
    });
  }
  const secondAnswer = await askAssistant(core, {
    text: second,
    mindId: mind.id,
    conversationId: firstAnswer.conversationId,
  });
  return { secondAnswer, record };
}

describe("A claim about its own summary made longer", { timeout: 30_000 }, () => {
  // protects=the judge is told, in Chinese, that a sentence saying a change was not confirmed or
  // did not take effect claims nothing, and that the app's own marks in the Note are not a change;
  // fails_when=those rules are dropped from the instructions.
  test("the judge is told what a Chinese denial and an app mark are", () => {
    expect(CLAIM_CHECK_INSTRUCTIONS).toContain("没能, 无法 or 尚未");
    expect(CLAIM_CHECK_INSTRUCTIONS).toContain("已在笔记中标出");
  });

  test("the change log backs it once the window applied the summary (en)", async () => {
    const { secondAnswer, record } = await wroteThenLonger(
      {
        first: "Write a short summary.",
        second: "Make the summary longer.",
        claim: "I made the summary longer.",
      },
      true,
    );
    expect(record).toContain('"applied": true');
    expect(secondAnswer.text).toBe("I made the summary longer.");
    expect(secondAnswer.steps?.unbackedClaims).toBeUndefined();
  });

  test("the change log backs it once the window applied the summary (zh)", async () => {
    const { secondAnswer, record } = await wroteThenLonger(
      {
        first: "帮我写一份简短摘要。",
        second: "把摘要写长一点。",
        claim: "我已把摘要写长了一点。",
      },
      true,
    );
    expect(record).toContain('"applied": true');
    expect(secondAnswer.text).toBe("我已把摘要写长了一点。");
    expect(secondAnswer.steps?.unbackedClaims).toBeUndefined();
  });

  test("it backs it while the summary still waits, before the window takes it (zh)", async () => {
    const { secondAnswer, record } = await wroteThenLonger(
      {
        first: "帮我写一份简短摘要。",
        second: "把摘要写长一点。",
        claim: "我已把摘要写长了一点。",
      },
      false,
    );
    expect(record).toContain('"applied": true');
    expect(secondAnswer.text).toBe("我已把摘要写长了一点。");
    expect(secondAnswer.steps?.unbackedClaims).toBeUndefined();
  });

  test("it flags the same claim when the second turn made no edit (zh)", async () => {
    const { secondAnswer } = await wroteThenLonger(
      {
        first: "帮我写一份简短摘要。",
        second: "把摘要写长一点。",
        claim: "我已把摘要写长了一点。",
        edit: false,
      },
      true,
    );
    expect(secondAnswer.text).toBe("我已把摘要写长了一点。");
    expect(secondAnswer.steps?.unbackedClaims).toEqual(["changed"]);
  });
});
