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

  test("a small local model's warning survives persistence", async () => {
    const model = modelWith(CLAIM, { [CLAIM]: { verdict: "supported", quote: QUOTE } });
    const { core } = await setUpWithDocuments(model, [REPORT], {
      ollamaModels: {
        describe: async () => ({
          digest: null,
          capabilities: ["completion", "tools"],
          contextLength: 32_768,
          parameters: 4_500_000_000,
          support: "tools",
          chat: true,
          remote: false,
          settings: { numCtx: 32_768, outputTokens: 8_192, keepAlive: "5m", think: false },
        }),
        loaded: async () => null,
        running: async () => true,
      },
    });
    const ended = answerEndings(core);
    const asked = await core.askInConversation({ text: "What was revenue?" });
    if (!asked.asked) throw new Error("The Question wasn't asked.");

    const outcome = await ended(asked.answerId);
    const answer = answerOf(await core.getConversation(asked.conversation.id), asked.answerId);
    expect(answer.errorMessage).toBeNull();
    expect(outcome).toBe("finished");
    expect(answer.claimChecks).toHaveLength(1);
    expect(answer.steps?.smallModel).toBe(true);
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
      expect(answer.claimChecks?.filter((check) => check.state !== "checking")).toHaveLength(1);
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

  test("identical sentences keep occurrence order when the second check finishes first", async () => {
    const waiting: (() => void)[] = [];
    const plans = {
      [CLAIM]: { verdict: "supported" as const, quote: QUOTE, judgement: "conflict" as const },
    };
    const model = scriptedModel(
      (call) => {
        if (!isCheckRun(call)) return { text: `${CLAIM}\n\n${CLAIM}` };
        if (!call.results.some((result) => result.tool === "cite") || waiting.length >= 2) {
          return checkReply(call, plans);
        }
        let release = () => {};
        const paused = new Promise<void>((resolve) => {
          release = () => resolve();
        });
        waiting.push(release);
        return {
          text: `Verdict: ${waiting.length === 1 ? "contradicted" : "unsupported"}\nCovered: revenue\nNot covered: the amount`,
          pause: { after: 0, until: paused },
        };
      },
      { generate: checkGenerate(plans) },
    );
    const { core } = await setUpWithDocuments(model, [REPORT]);
    const cloud = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (cloud.service) await core.allowDataFlow("chat", cloud.service.id);
    const ended = answerEndings(core);
    const asked = await core.askInConversation({ text: "What was revenue?" });
    if (!asked.asked) throw new Error("The Question wasn't asked.");
    await vi.waitFor(() => expect(waiting).toHaveLength(2));

    waiting[1]?.();
    await vi.waitFor(async () => {
      const answer = answerOf(await core.getConversation(asked.conversation.id), asked.answerId);
      expect(answer.claimChecks).toHaveLength(2);
      expect(answer.claimChecks?.map((check) => check.state)).toEqual(["checking", "unsupported"]);
      const marked = answerBlocks(answer).map(
        (block) =>
          block.content
            ?.flatMap((node) => node.marks ?? [])
            .find((mark) => mark.type === CLAIM_CHECK_MARK)?.attrs?.state,
      );
      expect(marked).toEqual(["checking", "unsupported"]);
    });
    waiting[0]?.();
    expect(await ended(asked.answerId)).toBe("finished");

    const answer = answerOf(await core.getConversation(asked.conversation.id), asked.answerId);
    expect(answer.claimChecks?.map((check) => check.state)).toEqual([
      "contradicted",
      "unsupported",
    ]);
    const marked = answerBlocks(answer).map(
      (block) =>
        block.content
          ?.flatMap((node) => node.marks ?? [])
          .find((mark) => mark.type === CLAIM_CHECK_MARK)?.attrs?.state,
    );
    expect(marked).toEqual(["contradicted", "unsupported"]);
  });

  test("a refused regeneration still finishes the superseded Answer", async () => {
    let release = () => {};
    const forever = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const events: string[] = [];
    const model = scriptedModel((call) => {
      if (isCheckRun(call)) return checkReply(call, {});
      return { text: CLAIM, pause: { after: 0, until: forever } };
    });
    const { core } = await setUpWithDocuments(model, [REPORT]);
    core.on("answer.started", () => events.push("started"));
    core.on("answer.finished", ({ status }) => events.push(status));
    const first = await core.askInConversation({ text: "What was revenue?" });
    if (!first.asked) throw new Error("The Question wasn't asked.");
    const provider = (await core.listChatProviders())[0];
    if (!provider) throw new Error("No chat provider.");
    await core.deleteChatProvider(provider.id);

    try {
      const again = await core.regenerateConversationAnswer({
        conversationId: first.conversation.id,
        answerId: first.answerId,
      });

      expect(again).toMatchObject({ asked: false, reason: "not-ready" });
      await vi.waitFor(() => expect(events).toEqual(["started", "stopped"]));
      const answer = answerOf(await core.getConversation(first.conversation.id), first.answerId);
      expect(answer.status).toBe("stopped");
    } finally {
      release();
    }
  });

  test("regenerating a streaming Answer emits no completion for the superseded generation", async () => {
    let release = () => {};
    const forever = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let answers = 0;
    const events: string[] = [];
    const model = scriptedModel(
      (call) => {
        if (isCheckRun(call)) return checkReply(call, {});
        answers++;
        if (answers === 1) return { text: CLAIM, pause: { after: 0, until: forever } };
        return { text: "Second try." };
      },
      { generate: checkGenerate({}) },
    );
    const { core } = await setUpWithDocuments(model, [REPORT]);
    const ended = answerEndings(core);
    core.on("answer.started", () => events.push("started"));
    core.on("answer.finished", ({ status }) => events.push(status));
    const first = await core.askInConversation({ text: "What was revenue?" });
    if (!first.asked) throw new Error("The Question wasn't asked.");

    const again = await core.regenerateConversationAnswer({
      conversationId: first.conversation.id,
      answerId: first.answerId,
    });

    expect(again.asked).toBe(true);
    release();
    expect(await ended(first.answerId)).toBe("finished");
    expect(events).toEqual(["started", "started", "done"]);
  });

  test("a refused regeneration finishes an Answer whose background check was running", async () => {
    let release = () => {};
    const paused = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const events: string[] = [];
    const plans = {
      [CLAIM]: { verdict: "supported" as const, quote: QUOTE },
      [OTHER]: {
        verdict: "supported" as const,
        reply: { text: "Verdict: supported", pause: { after: 0, until: paused } },
      },
    };
    const model = scriptedModel(
      (call) => (isCheckRun(call) ? checkReply(call, plans) : { text: `${CLAIM} ${OTHER}` }),
      { generate: checkGenerate(plans) },
    );
    const { core } = await setUpWithDocuments(model, [REPORT]);
    core.on("answer.started", () => events.push("started"));
    core.on("answer.finished", ({ status }) => events.push(status));
    const first = await core.askInConversation({ text: "What was revenue?" });
    if (!first.asked) throw new Error("The Question wasn't asked.");
    await vi.waitFor(async () => {
      const answer = answerOf(await core.getConversation(first.conversation.id), first.answerId);
      expect(answer.claimChecks?.filter((check) => check.state !== "checking")).toHaveLength(1);
    });
    const provider = (await core.listChatProviders())[0];
    if (!provider) throw new Error("No chat provider.");
    await core.deleteChatProvider(provider.id);

    try {
      const again = await core.regenerateConversationAnswer({
        conversationId: first.conversation.id,
        answerId: first.answerId,
      });

      expect(again).toMatchObject({ asked: false, reason: "not-ready" });
      await vi.waitFor(() => expect(events).toEqual(["started", "done"]));
      await vi.waitFor(async () => {
        const answer = answerOf(await core.getConversation(first.conversation.id), first.answerId);
        expect(answer.claimChecks?.map((check) => check.state)).toEqual(["supported"]);
      });
    } finally {
      release();
    }
  });

  test("regenerating while a background check runs still lets the new Answer stop", async () => {
    let release = () => {};
    const paused = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let never = () => {};
    const forever = new Promise<void>((resolve) => {
      never = () => resolve();
    });
    let answers = 0;
    const events: string[] = [];
    const plans = {
      [CLAIM]: { verdict: "supported" as const, quote: QUOTE },
      [OTHER]: {
        verdict: "supported" as const,
        reply: { text: "Verdict: supported", pause: { after: 0, until: paused } },
      },
    };
    const model = scriptedModel(
      (call) => {
        if (isCheckRun(call)) return checkReply(call, plans);
        answers++;
        if (answers === 1) return { text: `${CLAIM} ${OTHER}` };
        return { text: "Second try.", pause: { after: 0, until: forever } };
      },
      { generate: checkGenerate(plans) },
    );
    const { core } = await setUpWithDocuments(model, [REPORT]);
    core.on("answer.started", () => events.push("started"));
    core.on("answer.finished", ({ status }) => events.push(status));
    const first = await core.askInConversation({ text: "What was revenue?" });
    if (!first.asked) throw new Error("The Question wasn't asked.");
    await vi.waitFor(async () => {
      const answer = answerOf(await core.getConversation(first.conversation.id), first.answerId);
      expect(answer.claimChecks?.filter((check) => check.state !== "checking")).toHaveLength(1);
    });

    const again = await core.regenerateConversationAnswer({
      conversationId: first.conversation.id,
      answerId: first.answerId,
    });
    expect(again.asked).toBe(true);
    await vi.waitFor(() => expect(events.filter((event) => event === "started")).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await core.stopConversationAnswer({
      conversationId: first.conversation.id,
      answerId: first.answerId,
    });
    const answer = answerOf(await core.getConversation(first.conversation.id), first.answerId);
    expect(answer.status).toBe("stopped");
    expect(events).toEqual(["started", "started", "stopped"]);
    release();
    never();
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
      expect(answer.claimChecks?.filter((check) => check.state !== "checking")).toHaveLength(1);
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
