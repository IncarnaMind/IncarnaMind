import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import { KeyCharacterError } from "../../src/core/providers/apiKey";
import { askJev } from "../../src/core/providers/jev";
import { createMemoryKeychain, createTempDataFolder, startCore } from "../helpers/core";
import { mockEmbeddingModels, mockRerankingModels } from "../helpers/embeddingProviders";
import {
  answerConsent,
  found,
  requestsTo,
  setUp as setUpSources,
} from "../helpers/findSourcesTesting";
import { JEV_KEY, startFakeJev } from "../helpers/jev";
import { replyingModel, scriptedModels } from "../helpers/models";
import { transcribingCore, until } from "../helpers/transcription";

/*
 * A key with a character keys don't use is said in plain words on every route that takes or sends
 * one, before any request is made: one the User pastes now, and one an earlier version saved.
 */

const BAD_KEY = "sk-test-1234作品-not-a-real-key";
const GOOD_KEY = "sk-test-1234-not-a-real-key";
const LOCAL_SERVER = "http://127.0.0.1:9/v1";
const SAID = { key: "error.provider.keyCharacter", values: { character: "作" } };

const accepting = (core: Core) =>
  core.on("consent.requested", (request) => void core.respondToConsent(request.requestId, true));

describe("A key pasted now is refused on every route, with nothing stored", () => {
  const routes: [string, (core: Core) => Promise<unknown>][] = [
    [
      "Questions",
      (core) => core.saveChatProvider({ kind: "openai", apiKey: BAD_KEY, modelId: "gpt-5.4-mini" }),
    ],
    [
      "Search by meaning",
      (core) =>
        core.saveEmbeddingProvider({
          kind: "openai-compatible",
          baseUrl: LOCAL_SERVER,
          modelId: "any",
          apiKey: BAD_KEY,
        }),
    ],
    ["Ordering results", (core) => core.saveRerankSettings({ kind: "cohere", apiKey: BAD_KEY })],
    ["Tagging with Jev", (core) => core.saveJevSettings({ apiKey: BAD_KEY })],
    [
      "Meeting transcription",
      (core) => core.setTranscriptionKey({ route: "soniox", apiKey: BAD_KEY }),
    ],
    ["Find sources", (core) => core.setSourceProviderKey("openfda", BAD_KEY)],
  ];

  test.each(routes)("%s", async (_route, paste) => {
    const keychain = createMemoryKeychain();
    const core = startCore(await createTempDataFolder(), { keychain });

    await expect(paste(core)).rejects.toMatchObject({ wording: SAID });

    expect(keychain.secrets.size).toBe(0);
  });
});

describe("A key saved earlier is refused before anything is sent", () => {
  test("for Questions, whose test says the line", async () => {
    const keychain = createMemoryKeychain();
    const models = scriptedModels(replyingModel());
    const core = startCore(await createTempDataFolder(), {
      keychain,
      createChatModel: models.createChatModel,
    });
    accepting(core);
    const provider = await core.saveChatProvider({
      kind: "openai",
      apiKey: GOOD_KEY,
      modelId: "gpt-5.4-mini",
    });
    await keychain.set(`chat-provider:${provider.id}:api-key`, BAD_KEY);

    const result = await core.testChatConnection({ kind: "openai", modelId: "gpt-5.4-mini" });

    expect(result).toMatchObject({ ok: false, error: { kind: "auth", wording: SAID } });
    expect(models.specs).toEqual([]);
  });

  test("for a provider's own test, whose list of models the engine itself refuses", async () => {
    const keychain = createMemoryKeychain();
    const core = startCore(await createTempDataFolder(), {
      keychain,
      createChatModel: scriptedModels(replyingModel()).createChatModel,
    });
    accepting(core);
    const provider = await core.saveChatProvider({
      kind: "openai",
      apiKey: GOOD_KEY,
      modelId: "gpt-5.4-mini",
    });
    await keychain.set(`chat-provider:${provider.id}:api-key`, BAD_KEY);

    const result = await core.testChatProvider(provider.id);

    expect(result).toMatchObject({
      ok: false,
      step: "list",
      error: { kind: "auth", wording: SAID },
    });
  });

  test("for Tagging with Jev, which would have retried and then said it can't reach the server", async () => {
    const jev = await startFakeJev();
    const keychain = createMemoryKeychain();
    const core = startCore(await createTempDataFolder(), { keychain, jevHostedUrl: jev.url });
    await core.saveJevSettings({ apiKey: JEV_KEY, endpoint: jev.url });
    await keychain.set("jev:api-key", BAD_KEY);

    const result = await core.testJevConnection();

    expect(result).toMatchObject({ ok: false, error: { kind: "auth", wording: SAID } });
    expect(jev.requests).toEqual([]);
  });

  test("for Tagging with Jev, not after its retries", async () => {
    const asked = askJev({
      baseUrl: "http://127.0.0.1:9",
      apiKey: BAD_KEY,
      model: "any",
      state: "text",
      questions: { one: { type: "noul", instructions: "Is it?" } },
      signal: new AbortController().signal,
      retries: 3,
      timeoutMs: 1_000,
    });

    await expect(asked).rejects.toBeInstanceOf(KeyCharacterError);
  });

  test("for Ordering results", async () => {
    const keychain = createMemoryKeychain();
    const rerankers = mockRerankingModels(() => 0.5);
    const core = startCore(await createTempDataFolder(), {
      keychain,
      createRerankingModel: rerankers.createRerankingModel,
    });
    accepting(core);
    await core.saveRerankSettings({ kind: "cohere", apiKey: GOOD_KEY });
    await keychain.set("rerank:api-key", BAD_KEY);

    await expect(core.testRerankConnection({ kind: "cohere" })).rejects.toMatchObject({
      wording: SAID,
    });
    expect(rerankers.calls).toEqual([]);
  });

  test("for Search by meaning", async () => {
    const keychain = createMemoryKeychain();
    const embeddings = mockEmbeddingModels();
    const core = startCore(await createTempDataFolder(), {
      keychain,
      createEmbeddingModel: embeddings.createEmbeddingModel,
    });
    const server = { kind: "openai-compatible", baseUrl: LOCAL_SERVER, modelId: "any" } as const;
    await core.saveEmbeddingProvider({ ...server, apiKey: GOOD_KEY });
    await keychain.set("embedding-provider:api-key", BAD_KEY);
    const before = embeddings.calls.length;

    await expect(core.testEmbeddingConnection(server)).rejects.toMatchObject({ wording: SAID });
    expect(embeddings.calls).toHaveLength(before);
  });

  test("for Meeting transcription, which goes on on this computer and says the key wasn't accepted", async () => {
    const keychain = createMemoryKeychain();
    const { core } = await transcribingCore(await createTempDataFolder(), { keychain });
    await core.setTranscriptionKey({ route: "soniox", apiKey: GOOD_KEY });
    await core.updateSettings({ device: { transcriptionRoute: "soniox" } });
    await keychain.set("transcription:soniox:api-key", BAD_KEY);

    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    const transcript = await until(core, meeting.id, (each) => each.state === "live");

    expect(transcript).toMatchObject({
      cloud: null,
      fellBack: { route: "soniox", reason: "refused" },
    });
  });

  test("for Find sources, which says the provider didn't accept the key", async () => {
    const keychain = createMemoryKeychain();
    const { core, services } = await setUpSources({ keychain });
    answerConsent(core);
    await core.setSourceProviderKey("openfda", GOOD_KEY);
    await keychain.set("sources.openfda.key", BAD_KEY);

    const result = found(await core.findSources({ query: "metformin", providers: ["openfda"] }));

    expect(result.providers[0]?.failure).toMatchObject({ reason: "key-rejected" });
    expect(requestsTo(services, "openfda")).toEqual([]);
  });
});
