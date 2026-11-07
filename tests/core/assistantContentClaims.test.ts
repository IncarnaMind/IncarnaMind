import { describe, expect, test } from "vitest";
import { CLAIM_CHECK_INSTRUCTIONS } from "../../src/core/answers/claimedChanges";
import { unbackedClaimLine } from "../../src/renderer/src/changeProblems";
import type { Translate } from "../../src/renderer/src/objects";
import { translate } from "../../src/shared/i18n";
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
 * A rewrite of a paragraph reports its result as well as the change: the
 * claim check judges whether the change was made, and the record not naming
 * the result's length, ratio or what kept, or wording the change differently,
 * doesn't turn it into a missing change (#2652). A claim of a change no call
 * made is still flagged.
 */

/** The rule that keeps a result claim out of the change check; a scripted judge follows it as a real one should. */
const RESULT_RULE = "this check judges only whether the change the sentence reports was made";

const asked = ({ options }: ModelCall): string => {
  const last = options.prompt.filter((message) => message.role === "user").at(-1);
  if (!last) return "";
  return typeof last.content === "string"
    ? last.content
    : last.content.map((part) => ("text" in part ? part.text : "")).join("");
};

const called = (call: ModelCall, tool: string) => call.results.some((each) => each.tool === tool);

const MEMO = "## Summary\n\nThe quarter was good and sales were strong.";
const LONGER =
  "## Summary\n\nThe quarter was good and sales were strong. It also covers the next quarter.";

const CASES: { language: string; text: string; reply: string }[] = [
  {
    language: "English",
    text: "Make the summary longer.",
    reply:
      "The “Summary” section now has about 30 words, up from 12, and every figure and date is unchanged.",
  },
  {
    language: "Chinese",
    text: "把摘要写长一点。",
    reply: "这段摘要只加长到原来的约两倍，没有删去任何数字和日期。",
  },
];

describe("The claim check on a rewrite's result (#2652)", { timeout: 60_000 }, () => {
  // protects=the judge is told a result claim is judged by whether the change was made, and that the record's wording or missing details don't make it unbacked; fails_when=the rule is dropped from the instructions.
  test("the judge is told what a result claim is", () => {
    expect(CLAIM_CHECK_INSTRUCTIONS).toContain(RESULT_RULE);
    expect(CLAIM_CHECK_INSTRUCTIONS).toContain(
      "nor because the record words the change differently",
    );
    expect(CLAIM_CHECK_INSTRUCTIONS).toContain(
      "不要因为记录没有给出这些细节、改动做到什么程度、或没达到用户的要求",
    );
    expect(CLAIM_CHECK_INSTRUCTIONS).toContain(
      "still waiting for the User is backed when the record shows that change not made",
    );
    expect(CLAIM_CHECK_INSTRUCTIONS).toContain("不要返回没有依据");
  });

  test.each(CASES)(
    "$language: a reply that made the change and gives its result stands",
    async (each) => {
      const model = scriptedModel(
        (call): ScriptedReply => {
          if (asked(call).endsWith("Write the memo.")) {
            return called(call, "add_to_mind")
              ? { text: "Wrote it." }
              : { calls: [{ tool: "add_to_mind", input: { content: MEMO } }] };
          }
          if (called(call, "edit_mind")) return { text: each.reply };
          return { calls: [{ tool: "edit_mind", input: { content: LONGER } }] };
        },
        {
          // Follows the rule as the real judge does: without it, this result claim reads as an unbacked change.
          generate: (call: GenerateCall) =>
            claimCheckReply(
              call,
              call.system.includes(RESULT_RULE) ? [] : [{ sentence: each.reply, kind: "changed" }],
            ),
        },
      );
      const core = startCore(await createTempDataFolder(), {
        createChatModel: scriptedModels(model).createChatModel,
      });
      await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
      const mind = await core.createMind({ title: "Q3 review" });

      const first = await askAssistant(core, { text: "Write the memo.", mindId: mind.id });
      const [change] = changesIn(first);
      await core.applyAskedChanges({
        answerId: first.id,
        mindId: mind.id,
        requests: change?.request ? [change.request] : [],
      });
      const before = model.doStreamCalls.length;
      const answer = await askAssistant(core, {
        text: each.text,
        mindId: mind.id,
        conversationId: first.conversationId,
      });

      expect(answer.text).toBe(each.reply);
      // The edit and its reply, never a third request asking the reply again.
      expect(model.doStreamCalls.length - before).toBe(2);
      expect(answer.steps?.unbackedClaims).toBeUndefined();
      const en: Translate = (key, params) => translate("en", key, params);
      const zh: Translate = (key, params) => translate("zh-CN", key, params);
      expect(unbackedClaimLine(en, answer)).toBeNull();
      expect(unbackedClaimLine(zh, answer)).toBeNull();
    },
  );

  // protects=a reply that claims a change no call made is still asked about once and flagged, rule or no rule; fails_when=the result rule excuses an unmade change.
  test("a change no call made is still flagged", async () => {
    const claim = "I've added a risks section to “Q3 review”.";
    const model = scriptedModel(
      (call): ScriptedReply => {
        if (asked(call).endsWith("Write the memo.")) {
          return called(call, "add_to_mind")
            ? { text: "Wrote it." }
            : { calls: [{ tool: "add_to_mind", input: { content: MEMO } }] };
        }
        if (called(call, "edit_mind")) return { text: claim };
        return { calls: [{ tool: "edit_mind", input: { content: LONGER } }] };
      },
      { generate: (call) => claimCheckReply(call, [{ sentence: claim, kind: "added" }]) },
    );
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const mind = await core.createMind({ title: "Q3 review" });

    const first = await askAssistant(core, { text: "Write the memo.", mindId: mind.id });
    const [change] = changesIn(first);
    await core.applyAskedChanges({
      answerId: first.id,
      mindId: mind.id,
      requests: change?.request ? [change.request] : [],
    });
    const before = model.doStreamCalls.length;
    const answer = await askAssistant(core, {
      text: "Add a risks section.",
      mindId: mind.id,
      conversationId: first.conversationId,
    });

    expect(answer.text).toBe(claim);
    // The edit, the claim, and the one request asking it again.
    expect(model.doStreamCalls.length - before).toBe(3);
    expect(answer.steps?.unbackedClaims).toEqual(["added"]);
    const en: Translate = (key, params) => translate("en", key, params);
    expect(unbackedClaimLine(en, answer)).toBe(
      "The assistant didn’t make every change this reply describes",
    );
  });
});
