/**
 * Which model call help answers on (#2526), through the core's public interface as the floating
 * panel presses a button: the quick model of the Answers model's own provider, unless the User
 * chose the Answers model; a model on this computer keeps it; a quick model the provider refuses
 * gives way to the Answers model with nothing said.
 */
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { ChatModelFactory, Core, Meeting } from "../../src/core";
import type { Logger } from "../../src/core/adapters";
import { answerEnded } from "../helpers/citations";
import { createMemoryKeychain, createTempDataFolder, startCore } from "../helpers/core";
import { answerRequests, failingStreamModel, scriptedModel } from "../helpers/models";
import { transcribingCore, until } from "../helpers/transcription";

const SECOND = 1000;
const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";

/** A model that answers every press with one option of its own words. */
const saying = (words: string) => scriptedModel(() => ({ text: `★ ${words}\n→ keeps it moving` }));

/** A warning the core logged, with its fields. */
type Logged = { event: string; fields: Record<string, unknown> | undefined };

/**
 * A meeting recording, the Answers model `answersModel` on a direct Anthropic key; `models`, the
 * model each id answers with; `before`, what to do before the meeting starts.
 */
async function setUp(
  models: Record<string, MockLanguageModelV4>,
  {
    answersModel = SONNET,
    before,
  }: { answersModel?: string; before?: (core: Core) => Promise<void> } = {},
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
  const provider = await core.saveChatProvider({
    kind: "anthropic",
    modelId: answersModel,
    apiKey: "sk-ant-test",
  });
  if (provider.service) await core.allowDataFlow("chat", provider.service.id);
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
  test("is the Answers provider's fastest by default, thinking off, and the Answer names it; the Answers model stays as it was", async () => {
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

  test("follows a choice made mid-call from the next press: Same as Answers, then Fastest again", async () => {
    const haiku = saying("Haiku's line");
    const sonnet = saying("Sonnet's line");
    const { core, meeting, provider } = await setUp({ [HAIKU]: haiku, [SONNET]: sonnet });

    expect((await press(core, meeting)).answer.model?.modelId).toBe(HAIKU);
    await core.updateSettings({ user: { callHelpModel: "answers" } });
    const same = await press(core, meeting);
    await core.updateSettings({ user: { callHelpModel: "fastest" } });
    const fastest = await press(core, meeting);

    expect(same.answer.text).toContain("Sonnet's line");
    expect(same.answer.model).toEqual({ providerId: provider.id, modelId: SONNET });
    expect(fastest.answer.text).toContain("Haiku's line");
    expect(fastest.answer.model).toEqual({ providerId: provider.id, modelId: HAIKU });
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
    expect(warned).toEqual([
      {
        event: "callHelp.modelRefused",
        fields: { model: HAIKU, answeredOn: SONNET, kind: "model", status: 404 },
      },
    ]);
    expect((await core.getModelRoles()).callHelp).toEqual({
      providerId: provider.id,
      modelId: SONNET,
    });

    // A new key may reach it: the next press asks the quick model again.
    await core.saveChatProvider({ kind: "anthropic", modelId: SONNET, apiKey: "sk-ant-new" });
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
    expect(warned).toEqual([]);
  });

  test("a quick model refused while the Answers model fails too: the press says the Answers model's problem, naming it", async () => {
    const haiku = failingStreamModel(404, "model: claude-haiku-5-5 not found");
    const sonnet = failingStreamModel(402, "Your credit balance is too low");
    const { core, meeting, provider, warned } = await setUp({ [HAIKU]: haiku, [SONNET]: sonnet });

    const { answer } = await press(core, meeting);

    expect(answer.status).toBe("failed");
    expect(answer.errorKind).toBe("out-of-credit");
    expect(answer.model).toEqual({ providerId: provider.id, modelId: SONNET });
    expect(warned).toEqual([]);
  });

  test("with Claude Haiku 5.5 as the Answers model, it answers as before", async () => {
    const haiku = saying("Haiku's line");
    const { core, meeting, provider } = await setUp({ [HAIKU]: haiku }, { answersModel: HAIKU });

    const { answer } = await press(core, meeting);

    expect(answer.status).toBe("done");
    expect(answer.model).toEqual({ providerId: provider.id, modelId: HAIKU });
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
  });

  test("a model on this computer keeps call help, even with a cloud quick model set", async () => {
    const local = saying("Local line");
    const haiku = saying("Haiku's line");
    const { core, meeting } = await setUp(
      { [HAIKU]: haiku, [SONNET]: saying("Sonnet's line"), "local-model": local },
      {
        before: async (core) => {
          const cloud = (await core.listChatProviders())[0];
          await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
          if (cloud) {
            await core.updateSettings({
              user: { quickTasksModel: { providerId: cloud.id, modelId: HAIKU } },
            });
          }
        },
      },
    );

    const { answer } = await press(core, meeting);

    expect(answer.text).toContain("Local line");
    expect(answer.model?.modelId).toBe("local-model");
    expect(answerRequests(haiku)).toHaveLength(0);
  });
});

describe("Call help's fastest model, as Settings names it", () => {
  test("is the Answers provider's own quick model, the User's there, never one of another provider's; else the Answers model", async () => {
    const core = startCore(await createTempDataFolder(), { keychain: createMemoryKeychain() });
    const anthropic = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: SONNET,
    });
    expect((await core.getModelRoles()).callHelp).toEqual({
      providerId: anthropic.id,
      modelId: HAIKU,
    });

    await core.updateSettings({
      user: { quickTasksModel: { providerId: anthropic.id, modelId: "claude-fable-5-1" } },
    });
    expect((await core.getModelRoles()).callHelp).toEqual({
      providerId: anthropic.id,
      modelId: "claude-fable-5-1",
    });

    const openai = await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-test",
      modelId: "gpt-6.1-sol",
      keepDefault: true,
    });
    await core.updateSettings({
      user: { quickTasksModel: { providerId: openai.id, modelId: "gpt-6-luna" } },
    });
    expect((await core.getModelRoles()).callHelp).toEqual({
      providerId: anthropic.id,
      modelId: HAIKU,
    });

    const server = await core.saveChatProvider({
      kind: "openai-compatible",
      baseUrl: "https://models.example.net/v1",
      apiKey: "sk-test",
      modelId: "house-model",
    });
    expect((await core.getModelRoles()).callHelp).toEqual({
      providerId: server.id,
      modelId: "house-model",
    });
  });
});
