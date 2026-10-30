import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { type Core, DATABASE_FILE } from "../../src/core";
import { ANSWER_TEMPERATURE } from "../../src/core/answers/engine";
import { givesStructuredOutput, readsImages } from "../../src/core/providers/capabilities";
import { catalogMenu } from "../../src/core/providers/catalog";
import {
  catalogProvider,
  isPreset,
  keyProviderGroups,
  kindOfCatalogId,
} from "../../src/core/providers/catalog/providers";
import { anthropicModelFacts, openRouterModelFacts } from "../../src/core/providers/modelLists";
import { migrate, openDatabase } from "../../src/core/storage";
import { migrations } from "../../src/core/storage/migrations";
import { modelName } from "../../src/shared/modelName";
import { askAndFinish, setUpWithDocuments } from "../helpers/citations";
import {
  createMemoryKeychain,
  createTempDataFolder,
  queryDatabase,
  startCore,
} from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { note, question, writeMind } from "../helpers/minds";
import {
  promptOf,
  replyingModel,
  scriptedModel,
  scriptedModels,
  streamingModel,
} from "../helpers/models";

/** Starts a core with a cloud provider the User has allowed Questions to go to. */
async function startWithCloudModel(
  provider: { kind: "openai" | "anthropic" | "google" | "openrouter"; modelId: string },
  model = streamingModel("Twice a day."),
) {
  const models = scriptedModels(model);
  const core = startCore(await createTempDataFolder(), { createChatModel: models.createChatModel });
  const saved = await core.saveChatProvider({ ...provider, apiKey: "sk-test" });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  return { core, models, model, provider: saved };
}

/** Answers `fetch` for one URL with a JSON body; every other request goes through. */
function answerFetch(url: string, body: unknown) {
  const original = globalThis.fetch;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const asked = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return asked === url
      ? Promise.resolve(Response.json(body))
      : original(input as Parameters<typeof original>[0], init);
  });
  onTestFinished(() => fetch.mockRestore());
  return fetch;
}

/** Asks a Question below `above` in a new Mind and waits for its Answer. */
async function askBelow(core: Core, above: string[], text: string) {
  const mind = await core.createMind({ title: "Tides" });
  const client = await connectToMind(core, mind.id);
  const asked = question(text);
  writeMind(client, [...above.map((each) => note(each)), asked]);
  await client.settled();
  const result = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
  if (!result.asked) throw new Error("The Question wasn't asked.");
  const answerId = result.answerId;
  await new Promise<void>((resolve, reject) => {
    const stops = [
      core.on("answer.finished", (payload) => {
        if (payload.answerId !== answerId) return;
        for (const stop of stops) stop();
        resolve();
      }),
      core.on("answer.failed", (payload) => {
        if (payload.answerId !== answerId) return;
        for (const stop of stops) stop();
        reject(new Error(JSON.stringify(payload.error)));
      }),
    ];
  });
}

describe("Models in the app, by the catalog", () => {
  test("image input, structured output and context come from the catalog when a model is prepared", async () => {
    const { core } = await startWithCloudModel({ kind: "anthropic", modelId: "claude-sonnet-5-5" });
    const prepared = await core.prepareChatModel();
    expect(prepared.capabilities.known).toBe(true);
    expect(readsImages(prepared.capabilities)).toBe(true);
    expect(givesStructuredOutput(prepared.capabilities)).toBe(true);
    expect(prepared.support).toBe("tools");
    expect(prepared.window).toEqual({ tokens: 1_000_000, outputTokens: 128_000 });
    // A cloud model's quotes are never asked for again (ADR-0007).
    expect(prepared.retryQuotes).toBeUndefined();
  });

  test("an unknown model id on a known provider works, and is reported as capabilities unknown", async () => {
    const { core, model } = await startWithCloudModel({
      kind: "openai",
      modelId: "gpt-7-preview",
    });
    const prepared = await core.prepareChatModel();
    expect(prepared.capabilities).toEqual({ known: false, facts: {} });
    expect(prepared.window).toBeUndefined();
    expect(prepared.support).toBeUndefined();

    await askBelow(core, [], "How often are high tides?");
    expect(model.doStreamCalls[0]?.temperature).toBe(ANSWER_TEMPERATURE);

    answerFetch("https://api.openai.com/v1/models", { data: [] });
    const [group] = await core.listChatModels();
    expect(group).toMatchObject({ models: ["gpt-7-preview"], unknown: ["gpt-7-preview"] });
  });

  test("a model's requests are kept within the context window the catalog gives it", async () => {
    const oldest = `Oldest note. ${"tide ".repeat(1_400)}`;
    const newest = `Newest note. ${"moon ".repeat(1_400)}`;

    // GPT-4 has an 8,192-token window: the oldest note doesn't fit in it.
    const small = await startWithCloudModel({ kind: "openai", modelId: "gpt-4" });
    await askBelow(small.core, [oldest, newest], "How often are high tides?");
    const sent = promptOf(small.model)
      .map((message) => message.text)
      .join("\n");
    expect(sent).toContain("How often are high tides?");
    expect(sent).not.toContain("Oldest note.");

    // A model whose window isn't known gets the Question context as it is.
    const unknown = await startWithCloudModel({ kind: "openai", modelId: "gpt-7-preview" });
    await askBelow(unknown.core, [oldest, newest], "How often are high tides?");
    const all = promptOf(unknown.model)
      .map((message) => message.text)
      .join("\n");
    expect(all).toContain("Oldest note.");
    expect(all).toContain("Newest note.");
  });

  // protects=an Answer asks for a modest thinking budget, and a Question that asks to check or calculate for a larger one; fails_when=an Answer to "Calculate" is built with the modest budget or one to "Write a summary" with the larger; no_claim=only what the core asks the model factory for, not what a provider does with it.
  test("an Answer is prepared with a modest thinking budget, and one that asks to calculate with a larger", async () => {
    const { core, models } = await startWithCloudModel({
      kind: "anthropic",
      modelId: "claude-sonnet-5-5",
    });
    await askBelow(core, [], "Write a summary page of these documents");
    expect(models.specs.at(-1)?.thinking).toBe("answer");
    await askBelow(core, [], "Calculate the leverage headroom after the step-down");
    expect(models.specs.at(-1)?.thinking).toBe("careful");
  });

  test("a model the catalog says gives no structured output isn't tried with it when it refuses Tools", async () => {
    // GPT-4 Turbo calls Tools but has no JSON schema output; here its provider refuses the Tools.
    const model = scriptedModel((call) =>
      call.tools.length > 0
        ? { error: { status: 400, message: "This model does not support tools" } }
        : { text: "Twice a day." },
    );
    const { core, mind, client } = await setUpWithDocuments(model, [
      { name: "Tides.md", contents: "# Tides\n\nHigh tides come twice a day.\n" },
    ]);
    const provider = await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-test",
      modelId: "gpt-4-turbo",
    });
    if (provider.service) await core.allowDataFlow("chat", provider.service.id);

    const { finished } = await askAndFinish(core, client, mind.id, "How often are high tides?");

    expect(finished.citationSupport).toBe("none");
    expect(model.doStreamCalls.some((call) => call.responseFormat?.type === "json")).toBe(false);
  });
});

describe("A provider's model list", () => {
  test("leaves out what the catalog knows isn't a chat model, and puts what nothing says anything about under Other models", async () => {
    const { core } = await startWithCloudModel({ kind: "openai", modelId: "gpt-6.1-sol" });
    answerFetch("https://api.openai.com/v1/models", {
      data: [
        { id: "gpt-6.1-sol" },
        { id: "gpt-6-luna" },
        { id: "text-embedding-3-small" },
        { id: "whisper-1" },
        { id: "gpt-7-preview" },
      ],
    });
    const [listed] = await core.listChatModels();
    expect(listed).toMatchObject({
      models: ["gpt-6.1-sol", "gpt-6-luna"],
      other: [{ id: "gpt-7-preview", why: "unknown" }],
      unknown: [],
    });
  });

  test("OpenAI's menu holds the current chat models, the role models first, and every other id waits for a reason", async () => {
    const { core, provider } = await startWithCloudModel({ kind: "openai", modelId: "gpt-6-sol" });
    answerFetch("https://api.openai.com/v1/models", {
      data: [
        "babbage-002",
        "computer-use-preview",
        "davinci-002",
        "gpt-3.5-turbo-instruct",
        "gpt-4-turbo",
        "gpt-6-astra",
        "gpt-6-luna",
        "gpt-6-sol",
        "gpt-6.1-sol",
        "gpt-6.2-sol-preview",
        "gpt-audio",
        "gpt-audio-mini",
        "gpt-image-1",
        "o3-deep-research",
        "o4-mini-deep-research",
        "text-embedding-3-small",
      ].map((id) => ({ id })),
    });

    const [group] = await core.listChatModels();

    expect(group?.models).toEqual(["gpt-6-sol", "gpt-6-luna", "gpt-6-astra", "gpt-6.1-sol"]);
    const why = (id: string) => group?.other.find((each) => each.id === id);
    for (const id of ["babbage-002", "davinci-002", "gpt-3.5-turbo-instruct"]) {
      expect(why(id)).toEqual({ id, why: "cannot-answer", reason: "completion" });
    }
    for (const id of ["gpt-audio", "gpt-audio-mini"]) {
      expect(why(id)).toEqual({ id, why: "cannot-answer", reason: "audio" });
    }
    for (const id of ["o3-deep-research", "o4-mini-deep-research"]) {
      expect(why(id)).toEqual({ id, why: "cannot-answer", reason: "deep-research" });
    }
    expect(why("computer-use-preview")).toEqual({
      id: "computer-use-preview",
      why: "cannot-answer",
      reason: "computer-use",
    });
    expect(why("gpt-4-turbo")).toEqual({ id: "gpt-4-turbo", why: "older" });
    expect(why("gpt-6.2-sol-preview")).toEqual({ id: "gpt-6.2-sol-preview", why: "unknown" });
    expect(group?.other).toHaveLength(10);
    expect(group?.added).toEqual([]);

    // Older and unknown ones can be added, and taken out again; the order of the list doesn't move.
    await core.setChatModelInMenu({
      providerId: provider.id,
      modelId: "gpt-4-turbo",
      inMenu: true,
    });
    const [after] = await core.listChatModels();
    expect(after?.models).toEqual([
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-4-turbo",
    ]);
    expect(after?.added).toEqual(["gpt-4-turbo"]);
    expect(after?.other.map((each) => each.id)).toEqual(group?.other.map((each) => each.id));

    await core.setChatModelInMenu({
      providerId: provider.id,
      modelId: "gpt-4-turbo",
      inMenu: false,
    });
    const [removed] = await core.listChatModels();
    expect(removed?.models).not.toContain("gpt-4-turbo");
    expect(removed?.added).toEqual([]);

    // One that can't answer Questions here can't be added.
    await expect(
      core.setChatModelInMenu({ providerId: provider.id, modelId: "gpt-audio", inMenu: true }),
    ).rejects.toThrow("can't answer");
  });

  test("a model OpenAI says shuts down waits under Other models, a null shutdown date doesn't", async () => {
    const { core } = await startWithCloudModel({ kind: "openai", modelId: "gpt-6.1-sol" });
    answerFetch("https://api.openai.com/v1/models", {
      data: [
        { id: "gpt-6.1-sol", shutdown_date: null },
        { id: "gpt-6-luna", shutdown_date: "2026-12-11" },
      ],
    });
    const [group] = await core.listChatModels();
    expect(group?.models).toEqual(["gpt-6.1-sol"]);
    expect(group?.other).toEqual([{ id: "gpt-6-luna", why: "older" }]);
  });

  test("a model the User added stays in the menu when the provider's list no longer has it", async () => {
    const { core, provider } = await startWithCloudModel({
      kind: "openai",
      modelId: "gpt-6.1-sol",
    });
    await core.setChatModelInMenu({
      providerId: provider.id,
      modelId: "my-tuned-model",
      inMenu: true,
    });
    answerFetch("https://api.openai.com/v1/models", { data: [{ id: "gpt-6.1-sol" }] });
    const [group] = await core.listChatModels();
    expect(group?.models).toEqual(["gpt-6.1-sol", "my-tuned-model"]);
    expect(group?.added).toEqual(["my-tuned-model"]);
    expect(group?.other).toEqual([]);
  });

  test("a dated snapshot of a current model waits, unless the list lacks the model itself", async () => {
    const { core } = await startWithCloudModel({ kind: "openai", modelId: "gpt-6.1-sol" });
    answerFetch("https://api.openai.com/v1/models", {
      data: [
        { id: "gpt-6.1-sol" },
        { id: "gpt-6.1-sol-2026-09-01" },
        { id: "gpt-6-luna-2026-09-01" },
      ],
    });
    const [group] = await core.listChatModels();
    expect(group?.models).toEqual(["gpt-6.1-sol", "gpt-6-luna-2026-09-01"]);
    expect(group?.other).toEqual([{ id: "gpt-6.1-sol-2026-09-01", why: "older" }]);
  });

  test("Anthropic's says what a model can do, which counts before the catalog", async () => {
    expect(
      anthropicModelFacts({
        id: "claude-next",
        max_input_tokens: 1_000_000,
        max_tokens: 128_000,
        capabilities: {
          image_input: { supported: true },
          pdf_input: { supported: true },
          structured_outputs: { supported: false },
        },
      }),
    ).toEqual({
      context: 1_000_000,
      maxOutput: 128_000,
      input: ["text", "image", "pdf"],
      structuredOutput: "none",
    });
    expect(anthropicModelFacts({ id: "claude-old" })).toEqual({});

    // A model the catalog doesn't know yet, as Anthropic describes it.
    const { core, provider } = await startWithCloudModel({
      kind: "anthropic",
      modelId: "claude-sonnet-5-5",
    });
    answerFetch("https://api.anthropic.com/v1/models?limit=100", {
      data: [
        { id: "claude-sonnet-5-5" },
        {
          id: "claude-next",
          max_input_tokens: 2_000_000,
          max_tokens: 128_000,
          capabilities: { image_input: { supported: true } },
        },
      ],
    });
    const [group] = await core.listChatModels();
    expect(group).toMatchObject({
      models: ["claude-sonnet-5-5"],
      other: [{ id: "claude-next", why: "unknown" }],
      unknown: [],
    });
    const next = await core.prepareChatModel({ providerId: provider.id, modelId: "claude-next" });
    expect(readsImages(next.capabilities)).toBe(true);
    expect(next.window).toEqual({ tokens: 2_000_000, outputTokens: 128_000 });
  });
});

describe("The key form's Model list (#890)", () => {
  /** Answers every provider's model-list request with these ids, in the provider's own shape. */
  function listing(ids: readonly string[]) {
    const original = globalThis.fetch;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!/\/models(\?|$)/.test(url)) {
        return original(input as Parameters<typeof original>[0], init);
      }
      return Promise.resolve(
        Response.json(
          url.includes("generativelanguage")
            ? {
                models: ids.map((id) => ({
                  name: `models/${id}`,
                  supportedGenerationMethods: ["generateContent"],
                })),
              }
            : { data: ids.map((id) => ({ id })) },
        ),
      );
    });
    onTestFinished(() => fetch.mockRestore());
  }

  async function settingsMenu(catalogId: string, modelId: string): Promise<string[]> {
    const core = startCore(await createTempDataFolder());
    const saved = await core.saveChatProvider({
      kind: kindOfCatalogId(catalogId),
      ...(isPreset(catalogProvider(catalogId)) && { catalogId }),
      modelId,
      apiKey: "sk-test",
    });
    if (saved.service) await core.allowDataFlow("chat", saved.service.id);
    const [group] = await core.listChatModels();
    return group?.models ?? [];
  }

  test("for each first-class company, it holds what Settings' Default model menu lists once the key is saved, in that order", async () => {
    const firstClass = keyProviderGroups().main;
    expect(firstClass).toEqual(expect.arrayContaining(["anthropic", "openai", "deepseek"]));
    for (const catalogId of firstClass) {
      const form = catalogMenu(catalogId);
      const recommended = form[0];
      if (!recommended) throw new Error(`${catalogId} offers no model.`);
      listing(form);
      expect(await settingsMenu(catalogId, recommended), catalogId).toEqual(form);
    }
  });

  test("for Anthropic, it has every current Claude model by name, Sonnet 5.5 and Opus 5.5 among them, as Anthropic lists them", async () => {
    const form = catalogMenu("anthropic");
    expect(form[0]).toBe("claude-haiku-5-5");
    expect(form).toEqual(expect.arrayContaining(["claude-sonnet-5-5", "claude-opus-5-5"]));
    // A model and its dated snapshot are one model: the form offers it once.
    expect(form).toContain("claude-haiku-4-5");
    expect(form).not.toContain("claude-haiku-4-5-20251001");

    // Anthropic lists its 4.5 models by their dated ids; the names and their order are the same.
    listing([
      "claude-fable-5",
      "claude-fable-5-1",
      "claude-haiku-4-5-20251001",
      "claude-haiku-5-5",
      "claude-opus-4-5-20251101",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-opus-5-5",
      "claude-sonnet-4-5-20250929",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "claude-sonnet-5-5",
    ]);
    const settings = await settingsMenu("anthropic", "claude-haiku-5-5");
    const names = (ids: string[]) => ids.map((id) => modelName(id, { kind: "anthropic" }));
    expect(names(form)).toEqual(names(settings));
    expect(names(form)).toContain("Claude Sonnet 5.5");
  });
});

describe("The default Answers model", () => {
  test("a model the User picked stays their choice, first in the menu, when the catalog's default changes", async () => {
    const { core } = await startWithCloudModel({ kind: "anthropic", modelId: "claude-sonnet-5-5" });
    answerFetch("https://api.anthropic.com/v1/models?limit=100", {
      data: ["claude-fable-5-1", "claude-haiku-5-5", "claude-sonnet-5-5"].map((id) => ({ id })),
    });
    expect((await core.prepareChatModel()).modelId).toBe("claude-sonnet-5-5");
    const [group] = await core.listChatModels();
    expect(group?.models).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]);
  });
});

describe("Providers saved before the catalog", () => {
  test("keep working after the migration, keys included", async () => {
    const dataDir = await createTempDataFolder();
    const at = "2026-10-01T09:00:00.000Z";
    const ids = {
      openai: randomUUID(),
      anthropic: randomUUID(),
      google: randomUUID(),
      compatible: randomUUID(),
      ollama: randomUUID(),
      chatgpt: randomUUID(),
    };
    // The database as the version before the catalog left it.
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(
      db,
      migrations.filter((migration) => migration.version < 31),
    );
    const rows: [string, string, string | null][] = [
      [ids.openai, "openai", null],
      [ids.anthropic, "anthropic", null],
      [ids.google, "google", null],
      [ids.compatible, "openai-compatible", "https://api.deepseek.com/v1"],
      [ids.ollama, "ollama", "http://127.0.0.1:11434"],
      [ids.chatgpt, "chatgpt", null],
    ];
    for (const [id, kind, baseUrl] of rows) {
      db.run(
        `INSERT INTO chat_providers (id, kind, base_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [id, kind, baseUrl, at, at],
      );
    }
    db.run(
      `INSERT INTO user_settings (id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        "chatModel",
        JSON.stringify({ providerId: ids.openai, modelId: "gpt-6.1-sol" }),
        at,
        at,
      ],
    );
    db.close();
    const keychain = createMemoryKeychain();
    await keychain.set(`chat-provider:${ids.openai}:api-key`, "sk-openai");
    await keychain.set(`chat-provider:${ids.anthropic}:api-key`, "sk-ant");
    await keychain.set(`chat-provider:${ids.google}:api-key`, "google-key");
    await keychain.set(`chat-provider:${ids.compatible}:api-key`, "sk-deepseek");

    const models = scriptedModels(replyingModel());
    const core = startCore(dataDir, { keychain, createChatModel: models.createChatModel });

    expect(await core.listChatProviders()).toEqual([
      {
        id: ids.openai,
        kind: "openai",
        catalogId: "openai",
        endpoint: "global",
        baseUrl: null,
        hasApiKey: true,
        service: { id: "https://api.openai.com", name: "OpenAI" },
      },
      {
        id: ids.anthropic,
        kind: "anthropic",
        catalogId: "anthropic",
        endpoint: "global",
        baseUrl: null,
        hasApiKey: true,
        service: { id: "https://api.anthropic.com", name: "Anthropic" },
      },
      {
        id: ids.google,
        kind: "google",
        catalogId: "google",
        endpoint: "global",
        baseUrl: null,
        hasApiKey: true,
        service: { id: "https://generativelanguage.googleapis.com", name: "Google" },
      },
      {
        id: ids.compatible,
        kind: "openai-compatible",
        catalogId: "openai-compatible",
        endpoint: null,
        baseUrl: "https://api.deepseek.com/v1",
        hasApiKey: true,
        service: { id: "https://api.deepseek.com", name: "api.deepseek.com" },
      },
      {
        id: ids.ollama,
        kind: "ollama",
        catalogId: "ollama",
        endpoint: null,
        baseUrl: "http://127.0.0.1:11434",
        hasApiKey: false,
        service: null,
      },
    ]);
    // The ChatGPT plan, off here, has no provider in the catalog.
    expect(
      queryDatabase<{ catalog_id: string | null; endpoint: string | null }>(
        dataDir,
        "SELECT catalog_id, endpoint FROM chat_providers WHERE id = ?",
        [ids.chatgpt],
      ),
    ).toEqual([{ catalog_id: null, endpoint: null }]);

    // The default model is ready, and its key goes with it.
    expect(await core.getChatReadiness()).toMatchObject({ ready: true, modelId: "gpt-6.1-sol" });
    await core.allowDataFlow("chat", "https://api.openai.com");
    const prepared = await core.prepareChatModel();
    expect(models.specs.at(-1)).toEqual({
      kind: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-openai",
      modelId: "gpt-6.1-sol",
      thinking: "summary",
    });
    expect(prepared.capabilities.known).toBe(true);
    const deepseek = { providerId: ids.compatible, modelId: "deepseek-chat" };
    await core.allowDataFlow("chat", "https://api.deepseek.com");
    await core.prepareChatModel(deepseek);
    expect(models.specs.at(-1)).toMatchObject({
      kind: "openai-compatible",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-deepseek",
    });

    // Saving one of them again finds its row, and keeps its key.
    const anthropic = await core.saveChatProvider({
      kind: "anthropic",
      modelId: "claude-sonnet-5-5",
    });
    expect(anthropic).toMatchObject({ id: ids.anthropic, hasApiKey: true });
    const compatible = await core.saveChatProvider({
      kind: "openai-compatible",
      baseUrl: "https://api.deepseek.com/v1",
      modelId: "deepseek-chat",
    });
    expect(compatible).toMatchObject({ id: ids.compatible, hasApiKey: true });
    expect(await core.listChatProviders()).toHaveLength(5);
  });
});

// protects=the server listing decides mandatory reasoning and whether a Claude correction can force Tools; fails_when=listed constraints are discarded; no_claim=model quality.
test.each([
  {
    id: "anthropic/claude-next",
    efforts: ["high", "minimal", "low"],
    effort: "minimal",
    forced: false,
  },
  { id: "openai/next", efforts: ["max", "medium", "high"], effort: "medium" },
  { id: "vendor/future", efforts: ["high"], effort: "high" },
])("OpenRouter listing constraints for $id", ({ id, efforts, effort, forced }) => {
  expect(
    openRouterModelFacts({ id, reasoning: { mandatory: true, supported_efforts: efforts } }),
  ).toMatchObject({
    reasoning: true,
    thinkingOff: { openrouter: { reasoning: { effort } } },
    ...(forced === false && { forcedToolChoice: false }),
  });
});
test("OpenRouter mandatory reasoning without listed efforts uses the provider default", () => {
  expect(
    openRouterModelFacts({ id: "vendor/future", reasoning: { mandatory: true } }),
  ).toMatchObject({
    thinkingOff: { openrouter: { reasoning: { enabled: true } } },
  });
});
test("OpenRouter live listing facts reach the model factory", async () => {
  const { core, models } = await startWithCloudModel({
    kind: "openrouter",
    modelId: "anthropic/claude-opus-5.5",
  });
  answerFetch("https://openrouter.ai/api/v1/models", {
    data: [
      {
        id: "anthropic/claude-opus-5.5",
        reasoning: { mandatory: true, supported_efforts: ["high"] },
      },
    ],
  });
  await core.listChatModels();
  const prepared = await core.prepareChatModel();
  expect(prepared.capabilities.facts).toMatchObject({ forcedToolChoice: false });
  expect(models.specs.at(-1)).toMatchObject({
    thinkingOff: { openrouter: { reasoning: { effort: "high" } } },
  });
});

test.each([
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-opus-5.5",
  "anthropic/claude-fable-5.1",
])("OpenRouter bundled constraints reach prepared %s", async (modelId) => {
  const { core, models } = await startWithCloudModel({ kind: "openrouter", modelId });
  const prepared = await core.prepareChatModel();
  expect(prepared.capabilities.facts).toMatchObject({ forcedToolChoice: false });
  expect(models.specs.at(-1)).toMatchObject({
    thinkingOff: { openrouter: { reasoning: { effort: "low" } } },
  });
});
