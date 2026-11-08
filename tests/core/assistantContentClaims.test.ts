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
 * Plumbing for #2652: the scripted judge returns the result claim only when
 * the instructions lack the rule, so this proves the rule reaches the judge
 * and the core's path yields no status line, not that a real judge changes
 * its verdict on a held-out reply. The live runs are the verdict's evidence.
 */

/** The rule the scripted judge keys on: present, it judges the change; absent, it reads the result claim as unbacked. */
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

describe("The claim check's result rule reaches the judge (#2652 plumbing)", {
  timeout: 60_000,
}, () => {
  // protects=the judge is sent the result rule, the negated-change caveat and the no-call override, in English and Chinese; fails_when=one is dropped from the instructions; no_claim=what a real judge decides, which the live runs carry.
  test("the judge is sent the result rules (plumbing)", () => {
    expect(CLAIM_CHECK_INSTRUCTIONS).toContain(RESULT_RULE);
    expect(CLAIM_CHECK_INSTRUCTIONS).toContain(
      "nor because the record words the change differently",
    );
    expect(CLAIM_CHECK_INSTRUCTIONS).toContain(
      "不要因为记录没有给出这些细节、改动做到什么程度、或没达到用户的要求",
    );
    expect(CLAIM_CHECK_INSTRUCTIONS).toContain("never return that negated change unbacked");
    expect(CLAIM_CHECK_INSTRUCTIONS).toContain("is still a claim, judged as any other");
    expect(CLAIM_CHECK_INSTRUCTIONS).toContain("不要把那处被否定的改动判为没有依据");
    expect(CLAIM_CHECK_INSTRUCTIONS).toContain("同一句里的肯定部分仍是声称的改动，照常判断");
    expect(CLAIM_CHECK_INSTRUCTIONS).toContain(
      "a result reported with no change to that Note — is unbacked",
    );
    expect(CLAIM_CHECK_INSTRUCTIONS).toContain("记录里那篇笔记没有改动而句子报告了结果");
  });

  test.each(CASES)(
    "$language: the rule reaches the judge and the reply stands (plumbing)",
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
          // Plumbing: the rule's presence decides the scripted verdict, so this tests the path, not the judge.
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

  // protects=a reply that claims a change no call made is still asked about once and flagged, rule or no rule; fails_when=the result rule excuses an unmade change; no_claim=the judge's verdict on a held-out addition, which the live risk case carries.
  test("a change no call made is still flagged (plumbing)", async () => {
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
