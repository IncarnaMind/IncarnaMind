/**
 * Which model call help answers on (#2526), through the core's public interface as the floating
 * panel presses a button: the Answers model by default; the quick model of its own provider when
 * the User chooses Fastest, only where the list beside the catalog offers it; a model on this
 * computer keeps it; a quick model the provider refuses, or that is busy, gives way to the Answers
 * model with nothing said.
 */
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { ChatModelFactory, Core, Meeting, SaveChatProviderInput } from "../../src/core";
import type { Logger } from "../../src/core/adapters";
import { answerEnded } from "../helpers/citations";
import { createMemoryKeychain, createTempDataFolder, startCore } from "../helpers/core";
import { answerRequests, failingStreamModel, scriptedModel } from "../helpers/models";
import { transcribingCore, until } from "../helpers/transcription";

const SECOND = 1000;
const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";
const SONNET_ON_ANTHROPIC: SaveChatProviderInput = {
  kind: "anthropic",
  modelId: SONNET,
  apiKey: "sk-ant-test",
};

/** A model that answers every press with one option of its own words. */
const saying = (words: string) => scriptedModel(() => ({ text: `★ ${words}\n→ keeps it moving` }));

/** A warning the core logged, with its fields. */
type Logged = { event: string; fields: Record<string, unknown> | undefined };

/** The line logged as Claude Haiku 5.5 gives way to Claude Sonnet 5.5 for a press. */
const gaveWay = (why: string, kind: string, status: number): Logged => ({
  event: "callHelp.modelGaveWay",
  fields: { model: HAIKU, answeredOn: SONNET, why, kind, status },
});

/**
 * A meeting recording, with `answers` saved as the Answers model; `models`, the model each id
 * answers with; `fastest`, whether the User chose Fastest first; `before`, what to do then.
 */
async function setUp(
  models: Record<string, MockLanguageModelV4>,
  {
    answers = SONNET_ON_ANTHROPIC,
    fastest = true,
    before,
  }: {
    answers?: SaveChatProviderInput;
    fastest?: boolean;
    before?: (core: Core) => Promise<void>;
  } = {},
) {
  const warned: Logged[] = [];
  const log: Logger = {
    info: () => {},
    warn: (event, fields) => {
      if (event.startsWith("callHelp.")) warned.push({ event, fields });
    },
    error: () => {},
  };
  const createChatModel: ChatModelFactory = (spec) => {
    const model = models[spec.modelId];
    if (!model) throw new Error(`No model ${spec.modelId} in this test.`);
    return model;
  };
  const { core, record } = await transcribingCore(await createTempDataFolder(), {
    createChatModel,
    log,
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  const provider = await core.saveChatProvider(answers);
  if (provider.service) await core.allowDataFlow("chat", provider.service.id);
  if (fastest) await core.updateSettings({ user: { callHelpModel: "fastest" } });
  await before?.(core);
  const meeting = await core.createMeeting();
  await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
  record(9 * SECOND);
  await until(core, meeting.id, (transcript) => transcript.lines >= 4);
  return { core, meeting, provider, warned };
}

async function press(core: Core, meeting: Meeting) {
  const result = await core.askMeetingHelp({ meetingId: meeting.id, kind: "say" });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  await answerEnded(core, result.answerId);
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  const question = messages.find((message) => message.kind === "question");
  if (answer?.kind !== "answer" || question?.kind !== "question") throw new Error("No Answer.");
  return { answer, question };
}

describe("Call help's model", { timeout: 60_000 }, () => {
  test("is the Answers model by default, as before, with Fastest offered on Anthropic", async () => {
    const haiku = saying("Haiku's line");
    const sonnet = saying("Sonnet's line");
    const { core, meeting, provider } = await setUp(
      { [HAIKU]: haiku, [SONNET]: sonnet },
      { fastest: false },
    );

    const { answer } = await press(core, meeting);

    expect((await core.getSettings()).user.callHelpModel).toBe("answers");
    expect(answer.text).toContain("Sonnet's line");
    expect(answer.model).toEqual({ providerId: provider.id, modelId: SONNET });
    expect(answerRequests(haiku)).toHaveLength(0);
    expect((await core.getModelRoles()).callHelp).toEqual({
      providerId: provider.id,
      modelId: HAIKU,
    });
  });

  test("chosen Fastest on Anthropic, is Claude Haiku 5.5, and the Answer names it; the Answers model stays as it was", async () => {
    const haiku = saying("Haiku's line");
    const sonnet = saying("Sonnet's line");
    const { core, meeting, provider } = await setUp({ [HAIKU]: haiku, [SONNET]: sonnet });

    const { answer, question } = await press(core, meeting);

    expect(answer.status).toBe("done");
    expect(answer.text).toContain("Haiku's line");
    expect(answer.model).toEqual({ providerId: provider.id, modelId: HAIKU });
    expect(answerRequests(haiku).length).toBeGreaterThan(0);
    expect(answerRequests(sonnet)).toHaveLength(0);
    expect(question.model).not.toEqual({ providerId: provider.id, modelId: HAIKU });
    expect((await core.getSettings()).user.chatModel).toEqual({
      providerId: provider.id,
      modelId: SONNET,
    });
  });

  test("follows a choice made mid-call from the next press: Fastest, then Same as Answers again", async () => {
    const haiku = saying("Haiku's line");
    const sonnet = saying("Sonnet's line");
    const { core, meeting, provider } = await setUp(
      { [HAIKU]: haiku, [SONNET]: sonnet },
      { fastest: false },
    );

    expect((await press(core, meeting)).answer.model?.modelId).toBe(SONNET);
    await core.updateSettings({ user: { callHelpModel: "fastest" } });
    const fastest = await press(core, meeting);
    await core.updateSettings({ user: { callHelpModel: "answers" } });
    const same = await press(core, meeting);

    expect(fastest.answer.text).toContain("Haiku's line");
    expect(fastest.answer.model).toEqual({ providerId: provider.id, modelId: HAIKU });
    expect(same.answer.text).toContain("Sonnet's line");
    expect(same.answer.model).toEqual({ providerId: provider.id, modelId: SONNET });
  });

  test("chosen Fastest on a provider not offered yet, is the Answers model, and no choice is offered", async () => {
    const luna = saying("Luna's line");
    const sol = saying("Sol's line");
    const { core, meeting } = await setUp(
      { "gpt-6-luna": luna, "gpt-6.1-sol": sol },
      { answers: { kind: "openai", modelId: "gpt-6.1-sol", apiKey: "sk-test" } },
    );

    const { answer } = await press(core, meeting);

    expect(answer.text).toContain("Sol's line");
    expect(answer.model?.modelId).toBe("gpt-6.1-sol");
    expect(answerRequests(luna)).toHaveLength(0);
    expect((await core.getModelRoles()).callHelp).toBeNull();
  });

  test("on a provider that refuses the quick model, the press is answered on the Answers model with nothing said, and the next goes there at once", async () => {
    const haiku = failingStreamModel(404, "model: claude-haiku-5-5 not found");
    const sonnet = saying("Sonnet's line");
    const { core, meeting, provider, warned } = await setUp({ [HAIKU]: haiku, [SONNET]: sonnet });

    const first = await press(core, meeting);
    const refusals = haiku.doStreamCalls.length;
    const second = await press(core, meeting);

    for (const { answer } of [first, second]) {
      expect(answer.status).toBe("done");
      expect(answer.errorKind).toBeNull();
      expect(answer.text).toContain("Sonnet's line");
      expect(answer.model).toEqual({ providerId: provider.id, modelId: SONNET });
    }
    expect(refusals).toBe(1);
    expect(haiku.doStreamCalls).toHaveLength(1);
    expect(warned).toEqual([gaveWay("refused", "model", 404)]);

    expect((await core.getModelRoles()).callHelp).toBeNull();

    // A new key may reach it: it is offered again, and the next press asks it again.
    await core.saveChatProvider({ ...SONNET_ON_ANTHROPIC, apiKey: "sk-ant-new" });
    expect((await core.getModelRoles()).callHelp).toEqual({
      providerId: provider.id,
      modelId: HAIKU,
    });
    await press(core, meeting);
    expect(haiku.doStreamCalls).toHaveLength(2);
  });

  test("a quick model that is busy has that press answered on the Answers model with nothing said, and the next tries it again", async () => {
    const haiku = failingStreamModel(429, "rate limited");
    const sonnet = saying("Sonnet's line");
    const { core, meeting, provider, warned } = await setUp({ [HAIKU]: haiku, [SONNET]: sonnet });

    const first = await press(core, meeting);
    const second = await press(core, meeting);

    for (const { answer } of [first, second]) {
      expect(answer.status).toBe("done");
      expect(answer.errorKind).toBeNull();
      expect(answer.model).toEqual({ providerId: provider.id, modelId: SONNET });
    }
    expect(haiku.doStreamCalls).toHaveLength(2);
    expect(warned).toEqual([
      gaveWay("busy", "rate-limit", 429),
      gaveWay("busy", "rate-limit", 429),
    ]);
  });

  test("a quick model whose stream opens with Anthropic's Overloaded has that press answered on the Answers model, logged", async () => {
    const haiku = scriptedModel(() => ({ text: "Haiku's line" }));
    const overloaded = new MockLanguageModelV4({
      doStream: async (options) => {
        const { stream, ...rest } = await haiku.doStream(options);
        const parts = stream.getReader();
        return {
          ...rest,
          stream: new ReadableStream({
            async start(controller) {
              const first = await parts.read();
              if (!first.done) controller.enqueue(first.value);
              controller.enqueue({
                type: "error",
                error: { type: "overloaded_error", message: "Overloaded" },
              });
              controller.close();
              await parts.cancel();
            },
          }),
        };
      },
    });
    const sonnet = saying("Sonnet's line");
    const { core, meeting, provider, warned } = await setUp({
      [HAIKU]: overloaded,
      [SONNET]: sonnet,
    });

    const { answer } = await press(core, meeting);

    expect(answer.status).toBe("done");
    expect(answer.text).toContain("Sonnet's line");
    expect(answer.model).toEqual({ providerId: provider.id, modelId: SONNET });
    expect(warned).toEqual([gaveWay("busy", "provider", 529)]);
  });

  test("a quick model refused while the Answers model fails too: the press says the Answers model's problem, naming it", async () => {
    const haiku = failingStreamModel(404, "model: claude-haiku-5-5 not found");
    const sonnet = failingStreamModel(402, "Your credit balance is too low");
    const { core, meeting, provider, warned } = await setUp({ [HAIKU]: haiku, [SONNET]: sonnet });

    const { answer } = await press(core, meeting);

    expect(answer.status).toBe("failed");
    expect(answer.errorKind).toBe("out-of-credit");
    expect(answer.model).toEqual({ providerId: provider.id, modelId: SONNET });
    expect(warned).toEqual([gaveWay("refused", "model", 404)]);
  });

  test("with Claude Haiku 5.5 as the Answers model, it answers as before, with nothing to choose", async () => {
    const haiku = saying("Haiku's line");
    const { core, meeting, provider } = await setUp(
      { [HAIKU]: haiku },
      { answers: { ...SONNET_ON_ANTHROPIC, modelId: HAIKU } },
    );

    const { answer } = await press(core, meeting);

    expect(answer.status).toBe("done");
    expect(answer.model).toEqual({ providerId: provider.id, modelId: HAIKU });
    expect((await core.getModelRoles()).callHelp).toBeNull();
  });

  test("a model on this computer keeps call help, even with a cloud model of the same Ollama set for quick tasks", async () => {
    const local = saying("Local line");
    const cloud = saying("Cloud line");
    const { core, meeting } = await setUp(
      { [SONNET]: saying("Sonnet's line"), "local-model": local, "gpt-oss:120b-cloud": cloud },
      {
        before: async (core) => {
          const here = await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
          await core.updateSettings({
            user: { quickTasksModel: { providerId: here.id, modelId: "gpt-oss:120b-cloud" } },
          });
        },
      },
    );

    const { answer } = await press(core, meeting);

    expect(answer.text).toContain("Local line");
    expect(answer.model?.modelId).toBe("local-model");
    expect(answerRequests(cloud)).toHaveLength(0);
    expect((await core.getModelRoles()).callHelp).toBeNull();
  });
});

describe("Call help's quick model, as Settings offers it", () => {
  test("is Claude Haiku 5.5 on Anthropic alone: not another quick model the User set there, nor another provider's", async () => {
    const core = startCore(await createTempDataFolder(), { keychain: createMemoryKeychain() });
    const anthropic = await core.saveChatProvider(SONNET_ON_ANTHROPIC);
    expect((await core.getModelRoles()).callHelp).toEqual({
      providerId: anthropic.id,
      modelId: HAIKU,
    });

    await core.updateSettings({
      user: { quickTasksModel: { providerId: anthropic.id, modelId: "claude-fable-5-1" } },
    });
    expect((await core.getModelRoles()).callHelp).toBeNull();

    const openai = await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-test",
      modelId: "gpt-6.1-sol",
    });
    expect((await core.getModelRoles()).callHelp).toBeNull();

    // The model a new Note answers on decides it, as it decides which model call help asks.
    await core.updateSettings({
      user: { chatModel: { providerId: anthropic.id, modelId: SONNET } },
    });
    expect((await core.getModelRoles()).callHelp).toEqual({
      providerId: anthropic.id,
      modelId: HAIKU,
    });
    await core.updateSettings({
      user: { chatModel: { providerId: openai.id, modelId: "gpt-6.1-sol" } },
    });

    // Claude on OpenRouter is another service's route to it, not offered even with Haiku set there.
    const openrouter = await core.saveChatProvider({
      kind: "openrouter",
      apiKey: "sk-or-test",
      modelId: "anthropic/claude-sonnet-5.5",
    });
    await core.updateSettings({
      user: {
        quickTasksModel: { providerId: openrouter.id, modelId: "anthropic/claude-haiku-5.5" },
      },
    });
    expect((await core.getModelRoles()).callHelp).toBeNull();

    const server = await core.saveChatProvider({
      kind: "openai-compatible",
      baseUrl: "https://models.example.net/v1",
      apiKey: "sk-test",
      modelId: "house-model",
    });
    await core.updateSettings({
      user: { chatModel: { providerId: server.id, modelId: "house-model" } },
    });
    expect((await core.getModelRoles()).callHelp).toBeNull();
  });
});
