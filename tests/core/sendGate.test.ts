/**
 * Every request that leaves this computer checks, as it is sent, that Local
 * mode is off and that the User still allows its flow to its service
 * (ADR-0022, #1114, #1120). Through the core's public interface, with a
 * scripted cloud model that records each request it gets.
 */
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import type { Consent } from "../../src/core/consent";
import { LocalModeError } from "../../src/core/errors";
import { createSendGate } from "../../src/core/sendGate";
import { answerEnded, shownPassages } from "../helpers/citations";
import { createTempDataFolder, nextEvent, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { answerIn, answerText, question, writeMind } from "../helpers/minds";
import { replyingModel, scriptedModel, scriptedModels } from "../helpers/models";

const OPENAI = "https://api.openai.com";
const ANSWER = "The tides come twice a day[^1].";

/** A core whose chat model is a scripted OpenAI model, chosen (so the chat flow is allowed), with a Document to search. */
async function setUp(model: MockLanguageModelV4) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "openai", apiKey: "sk-test", modelId: "gpt-5.4-mini" });
  const sources = await createTempDataFolder();
  await addAndProcess(core, [
    await writeSourceFile(sources, "tides.md", "# Tides\n\n合成私密段落：潮汐每天两次。"),
  ]);
  return core;
}

/** A model that searches, then answers, then (while `until` holds) cites a quote the Document doesn't have, so it is asked to fix it. */
function citingModel(until: Promise<void>) {
  return scriptedModel((call) => {
    const searched = call.results.find((result) => result.tool === "search_documents");
    if (!searched) return { calls: [{ tool: "search_documents", input: { query: "tides" } }] };
    const passage = shownPassages(searched.text)[0]?.id ?? "P1";
    return {
      text: ANSWER,
      calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage, quote: "三次" }] } }],
      pause: { after: 9, until },
    };
  });
}

/** A model that searches, then answers. */
const searchingModel = () =>
  scriptedModel((call) =>
    call.results.length === 0
      ? { calls: [{ tool: "search_documents", input: { query: "tides" } }] }
      : { text: "Twice a day." },
  );

function released() {
  let release = () => {};
  const until = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { until, release };
}

/** Counts the consent prompts raised from now on. */
function prompts(core: Core) {
  const raised: string[] = [];
  core.on("consent.requested", (request) => raised.push(request.flow.id));
  return raised;
}

describe("Turning off the chat flow while an Answer is written (#1114)", () => {
  test("in a conversation: nothing more is sent, the Answer stops with the line that says why, and nothing asks", async () => {
    const paused = released();
    const model = citingModel(paused.until);
    const core = await setUp(model);
    const raised = prompts(core);

    const asked = await core.askInConversation({ text: "How often are the tides?" });
    if (!asked.asked) throw new Error(`Not asked: ${JSON.stringify(asked)}`);
    await vi.waitFor(() => expect(model.doStreamCalls).toHaveLength(2));
    await core.revokeConsent("chat", OPENAI);
    expect(await core.listDataFlows()).toContainEqual(
      expect.objectContaining({
        flow: expect.objectContaining({ id: "chat" }),
        consent: "not-asked",
      }),
    );
    const ended = answerEnded(core, asked.answerId);
    paused.release();

    expect(await ended).toMatchObject({
      event: "failed",
      payload: { error: { kind: "consent-revoked" } },
    });
    expect(model.doStreamCalls).toHaveLength(2);
    expect(raised).toEqual([]);
    const { messages } = await core.getConversation(asked.conversation.id);
    expect(messages.find((message) => message.kind === "question")).toMatchObject({
      text: "How often are the tides?",
    });
    expect(messages.find((message) => message.id === asked.answerId)).toMatchObject({
      status: "failed",
      errorKind: "consent-revoked",
    });

    // Asked again, the usual consent flow runs.
    const prompt = nextEvent(core, "consent.requested");
    const again = await core.askInConversation({
      text: "And in March?",
      conversationId: asked.conversation.id,
    });
    expect(again).toMatchObject({ asked: true });
    expect((await prompt).flow).toMatchObject({ id: "chat", service: { id: OPENAI } });
    expect(model.doStreamCalls).toHaveLength(2);
  });

  test("in a Mind: nothing more is sent, what was written stays, and the Answer says why", async () => {
    const paused = released();
    const model = citingModel(paused.until);
    const core = await setUp(model);
    const mind = await core.createMind({ title: "Tides" });
    const writer = await connectToMind(core, mind.id);
    const reader = await connectToMind(core, mind.id);
    const asked = question("How often are the tides?");
    writeMind(writer, [asked]);
    await writer.settled();

    const result = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
    if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
    await vi.waitFor(() => expect(model.doStreamCalls).toHaveLength(2));
    await core.revokeConsent("chat", OPENAI);
    const ended = answerEnded(core, result.answerId);
    paused.release();

    expect(await ended).toMatchObject({ event: "failed" });
    expect(model.doStreamCalls).toHaveLength(2);
    await reader.settled();
    expect(answerIn(reader, result.answerId).attrs).toMatchObject({
      status: "failed",
      errorKind: "consent-revoked",
    });
    expect(answerText(reader, result.answerId)).toContain("The tides come twice a day");
  });

  test("while it stays allowed, the Answer searches and answers as usual", async () => {
    const model = searchingModel();
    const core = await setUp(model);

    const asked = await core.askInConversation({ text: "How often are the tides?" });
    if (!asked.asked) throw new Error(`Not asked: ${JSON.stringify(asked)}`);

    expect(await answerEnded(core, asked.answerId)).toMatchObject({ event: "finished" });
    expect(model.doStreamCalls).toHaveLength(2);
  });
});

describe("A key test's model at the gate", () => {
  const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "Hi" }] }];
  const consent = { onThisComputer: () => false } as unknown as Consent;
  const service = { id: OPENAI, name: "OpenAI" };

  test("is stopped in Local mode, streamed or not, before the model sees a request, and by nothing else", async () => {
    let localOnly = true;
    const gate = createSendGate(consent, () => localOnly);
    const model = replyingModel();
    const tested = gate.testModel(model, service);

    await expect(tested.doGenerate({ prompt })).rejects.toThrow(LocalModeError);
    await expect(tested.doStream({ prompt })).rejects.toThrow(LocalModeError);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(model.doStreamCalls).toHaveLength(0);

    localOnly = false;
    await tested.doGenerate({ prompt });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  test("a model on this computer is not wrapped", () => {
    const gate = createSendGate(consent, () => true);
    const model = replyingModel();

    expect(gate.testModel(model, null)).toBe(model);
  });
});
