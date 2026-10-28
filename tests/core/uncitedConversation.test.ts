import { describe, expect, test, vi } from "vitest";
import {
  CLAIM_CHECK_MARK,
  type ConversationAnswer,
  type ConversationContent,
  type Core,
} from "../../src/core";
import { answerBlocks } from "../../src/shared/answerBlocks";
import { checkGenerate, checkReply, isCheckRun } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { scriptedModel } from "../helpers/models";

const CLAIM = "Revenue was $1,200 million.";
const QUOTE = "Revenue was $1,482.6 million.";
const OTHER = "The report says “the exact words quoted”.";
const REPORT = { name: "Report.md", contents: QUOTE };

function answerEndings(core: Core) {
  const ended = new Map<string, "finished" | "failed">();
  const waiting = new Map<string, () => void>();
  const end = (answerId: string, how: "finished" | "failed") => {
    ended.set(answerId, how);
    waiting.get(answerId)?.();
  };
  core.on("answer.finished", ({ answerId }) => end(answerId, "finished"));
  core.on("answer.failed", ({ answerId }) => end(answerId, "failed"));
  return (answerId: string) =>
    new Promise<"finished" | "failed">((resolve) => {
      const how = ended.get(answerId);
      if (how) resolve(how);
      else waiting.set(answerId, () => resolve(ended.get(answerId) ?? "failed"));
    });
}

const answerOf = (content: ConversationContent, answerId: string): ConversationAnswer => {
  const answer = content.messages.find((message) => message.id === answerId);
  if (answer?.kind !== "answer") throw new Error("No such Answer.");
  return answer;
};

const modelWith = (answer: string, plans: Parameters<typeof checkReply>[1]) =>
  scriptedModel((call) => (isCheckRun(call) ? checkReply(call, plans) : { text: answer }), {
    generate: checkGenerate(plans),
  });

describe("Uncited figures in a conversation Answer", () => {
  test("a contradiction is marked with no click, retained, and its usage counted", async () => {
    const model = modelWith(CLAIM, { [CLAIM]: { verdict: "contradicted", quote: QUOTE } });
    const { core } = await setUpWithDocuments(model, [REPORT]);
    const ended = answerEndings(core);
    const usages: number[] = [];
    core.on("answer.finished", ({ usage }) => usages.push(usage.inputTokens));
    const asked = await core.askInConversation({ text: "What was revenue?" });
    if (!asked.asked) throw new Error("The Question wasn't asked.");

    expect(await ended(asked.answerId)).toBe("finished");
    const answer = answerOf(await core.getConversation(asked.conversation.id), asked.answerId);
    expect(answer.citations).toEqual([]);
    expect(answer.claimChecks).toHaveLength(1);
    expect(answer.claimChecks?.[0]).toMatchObject({
      state: "contradicted",
      text: CLAIM,
      evidence: { quote: QUOTE },
    });
    expect(usages).toEqual([expect.any(Number)]);
    expect(usages[0]).toBeGreaterThan(5);
    const marked = answerBlocks(answer).some(
      (block) =>
        block.content?.some(
          (node) =>
            node.type === "text" && node.marks?.some((mark) => mark.type === CLAIM_CHECK_MARK),
        ) ?? false,
    );
    expect(marked).toBe(true);
  });

  test("Stop after one background result keeps it and never checks the next", async () => {
    let release = () => {};
    const paused = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const plans = {
      [CLAIM]: { verdict: "supported" as const, quote: QUOTE },
      [OTHER]: {
        verdict: "supported" as const,
        reply: { text: "Verdict: supported", pause: { after: 0, until: paused } },
      },
    };
    const model = modelWith(`${CLAIM} ${OTHER}`, plans);
    const { core } = await setUpWithDocuments(model, [REPORT]);
    const ended = answerEndings(core);
    const asked = await core.askInConversation({ text: "What was revenue?" });
    if (!asked.asked) throw new Error("The Question wasn't asked.");
    await vi.waitFor(async () => {
      const answer = answerOf(await core.getConversation(asked.conversation.id), asked.answerId);
      expect(answer.claimChecks).toHaveLength(1);
    });

    await core.stopConversationAnswer({
      conversationId: asked.conversation.id,
      answerId: asked.answerId,
    });
    expect(await ended(asked.answerId)).toBe("finished");
    const answer = answerOf(await core.getConversation(asked.conversation.id), asked.answerId);
    expect(answer.text).toContain(OTHER);
    expect(answer.claimChecks).toHaveLength(1);
    expect(answer.claimChecks?.[0]?.state).toBe("supported");
    release();
  });

  test("regenerating clears the old background checks", async () => {
    let release = () => {};
    const paused = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let answers = 0;
    const model = scriptedModel(
      (call) => {
        if (isCheckRun(call)) {
          if (answers <= 1)
            return checkReply(call, { [CLAIM]: { verdict: "contradicted", quote: QUOTE } });
          return { text: "Verdict: contradicted", pause: { after: 0, until: paused } };
        }
        answers++;
        return { text: CLAIM };
      },
      { generate: checkGenerate({ [CLAIM]: { verdict: "contradicted", quote: QUOTE } }) },
    );
    const { core } = await setUpWithDocuments(model, [REPORT]);
    const ended = answerEndings(core);
    const first = await core.askInConversation({ text: "What was revenue?" });
    if (!first.asked) throw new Error("The Question wasn't asked.");
    await vi.waitFor(async () => {
      const answer = answerOf(await core.getConversation(first.conversation.id), first.answerId);
      expect(answer.claimChecks).toHaveLength(1);
    });

    const again = await core.regenerateConversationAnswer({
      conversationId: first.conversation.id,
      answerId: first.answerId,
    });
    expect(again.asked).toBe(true);
    const answer = answerOf(await core.getConversation(first.conversation.id), first.answerId);
    expect(answer.claimChecks).toEqual([]);
    release();
    if (again.asked) expect(await ended(first.answerId)).toBe("finished");
  });
});
