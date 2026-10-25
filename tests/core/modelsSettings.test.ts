import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { type Core, DATABASE_FILE } from "../../src/core";
import { TYPICAL_ANSWER, typicalAnswerCost } from "../../src/core/cost/price";
import { catalogFacts } from "../../src/core/providers/catalog";
import { migrate, openDatabase } from "../../src/core/storage";
import { migrations } from "../../src/core/storage/migrations";
import { createMemoryKeychain, createTempDataFolder, startCore } from "../helpers/core";
import { failingModel, replyingModel, scriptedModels } from "../helpers/models";

/*
 * Settings › Models (#179): providers added beside the default, models taken out of the menu
 * and put back, what each model can do and costs, and a saved provider's Test.
 */

const urlOf = (input: Parameters<typeof fetch>[0]) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

/** Answers `fetch` for the URLs given, each with a JSON body or an HTTP status; others go through. */
function answerFetch(answers: Record<string, unknown>) {
  const original = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const answer = answers[urlOf(input)];
    if (answer === undefined) return original(input as Parameters<typeof original>[0], init);
    return Promise.resolve(
      typeof answer === "number"
        ? new Response("refused", { status: answer })
        : Response.json(answer),
    );
  });
  onTestFinished(() => spy.mockRestore());
  return {
    asked: (url: string) => spy.mock.calls.filter(([input]) => urlOf(input) === url).length,
  };
}

const OPENAI_MODELS = "https://api.openai.com/v1/models";
const ANTHROPIC_MODELS = "https://api.anthropic.com/v1/models?limit=100";
const DEEPSEEK_MODELS = "https://api.deepseek.com/models";

/** An OpenAI-compatible server on this computer that lists `models`. */
async function modelServer(models: string[]): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => {
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

/** Accepts every consent request, and counts them. */
function acceptConsent(core: Core) {
  let asked = 0;
  core.on("consent.requested", (request) => {
    asked += 1;
    void core.respondToConsent(request.requestId, true);
  });
  return () => asked;
}

describe("Adding a provider", () => {
  test("keeps the default model when there is one, and gives one when there is none", async () => {
    const core = startCore(await createTempDataFolder(), { keychain: createMemoryKeychain() });
    const first = await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-test",
      modelId: "gpt-6-luna",
      keepDefault: true,
    });
    expect((await core.getSettings()).user.chatModel).toEqual({
      providerId: first.id,
      modelId: "gpt-6-luna",
    });

    const second = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
      keepDefault: true,
    });
    expect(second.id).not.toBe(first.id);
    expect((await core.getSettings()).user.chatModel).toEqual({
      providerId: first.id,
      modelId: "gpt-6-luna",
    });
    expect((await core.listChatProviders()).map((each) => each.kind)).toEqual([
      "openai",
      "anthropic",
    ]);
  });
});

describe("The model menu", () => {
  test("a provider's own model can be taken out and put back, in its place; the default model stays", async () => {
    const dataDir = await createTempDataFolder();
    const keychain = createMemoryKeychain();
    const core = startCore(dataDir, { keychain });
    const provider = await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-test",
      modelId: "gpt-6.1-sol",
    });
    if (provider.service) await core.allowDataFlow("chat", provider.service.id);
    answerFetch({ [OPENAI_MODELS]: { data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] } });

    const [before] = await core.listChatModels();
    expect(before?.models).toEqual(["gpt-6.1-sol", "gpt-6-luna"]);
    expect(before?.offered).toEqual(["gpt-6.1-sol", "gpt-6-luna"]);
    expect(before?.hidden).toEqual([]);

    await core.setChatModelInMenu({
      providerId: provider.id,
      modelId: "gpt-6-luna",
      inMenu: false,
    });
    // The default model can't be taken out of its own menu.
    await core.setChatModelInMenu({
      providerId: provider.id,
      modelId: "gpt-6.1-sol",
      inMenu: false,
    });
    const [out] = await core.listChatModels();
    expect(out?.models).toEqual(["gpt-6.1-sol"]);
    expect(out?.offered).toEqual(["gpt-6.1-sol", "gpt-6-luna"]);
    expect(out?.hidden).toEqual(["gpt-6-luna"]);
    expect(out?.added).toEqual([]);

    // Kept after a restart.
    core.close();
    const after = startCore(dataDir, { keychain });
    const [kept] = await after.listChatModels();
    expect(kept?.hidden).toEqual(["gpt-6-luna"]);

    await after.setChatModelInMenu({
      providerId: provider.id,
      modelId: "gpt-6-luna",
      inMenu: true,
    });
    const [back] = await after.listChatModels();
    expect(back?.models).toEqual(["gpt-6.1-sol", "gpt-6-luna"]);
    expect(back?.hidden).toEqual([]);
  });
});

describe("What each model can do and costs", () => {
  test("an estimate for a typical Answer in the provider's own currency, with where its prices are", async () => {
    const core = startCore(await createTempDataFolder(), { keychain: createMemoryKeychain() });
    answerFetch({
      [OPENAI_MODELS]: { data: [{ id: "gpt-6.1-sol" }] },
      [DEEPSEEK_MODELS]: { data: [{ id: "deepseek-flash" }] },
    });
    await core.saveChatProvider({ kind: "openai", apiKey: "sk-test", modelId: "gpt-6.1-sol" });
    await core.saveChatProvider({
      kind: "deepseek",
      apiKey: "sk-test",
      modelId: "deepseek-flash",
      keepDefault: true,
    });
    const [openai, deepseek] = await core.listChatModels();

    const solPrice = catalogFacts("openai", "gpt-6.1-sol")?.price;
    if (!solPrice) throw new Error("The catalog has no price for GPT-6.1 Sol.");
    expect(openai?.about["gpt-6.1-sol"]).toMatchObject({
      tools: true,
      readsImages: true,
      cost: { kind: "estimate", currency: "USD", amount: typicalAnswerCost(solPrice) },
    });
    expect(typicalAnswerCost(solPrice)).toBeCloseTo(
      (TYPICAL_ANSWER.inputTokens * solPrice.input +
        TYPICAL_ANSWER.outputTokens * solPrice.output) /
        1_000_000,
    );
    expect(openai?.prices).toEqual({
      url: "https://developers.openai.com/api/docs/pricing",
      checked: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });

    // DeepSeek prices in yuan, at its full rate whatever the hour.
    const flash = deepseek?.about["deepseek-flash"]?.cost;
    expect(flash).toEqual({ kind: "estimate", currency: "CNY", amount: expect.any(Number) });
    const flashPrice = catalogFacts("deepseek", "deepseek-flash")?.price;
    if (!flashPrice) throw new Error("The catalog has no price for DeepSeek Flash.");
    expect(flash?.kind === "estimate" && flash.amount).toBeCloseTo(
      (TYPICAL_ANSWER.inputTokens * flashPrice.input +
        TYPICAL_ANSWER.outputTokens * flashPrice.output) /
        1_000_000,
    );
  });

  test("a model on this computer is free, and a plan's counts toward the plan", async () => {
    const server = await import("node:http").then(({ createServer }) =>
      createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "local-model" }] }));
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => {
      server.close();
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port.");
    const core = startCore(await createTempDataFolder(), { keychain: createMemoryKeychain() });
    await core.saveChatProvider({
      kind: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      modelId: "local-model",
    });
    const [group] = await core.listChatModels();
    expect(group?.about["local-model"]?.cost).toEqual({ kind: "free" });
    expect(group?.prices).toBeNull();
  });
});

describe("A provider's Test", () => {
  test("lists its models, then sends one word to its quick-tasks model", async () => {
    const models = scriptedModels(replyingModel("OK"));
    const core = startCore(await createTempDataFolder(), {
      keychain: createMemoryKeychain(),
      createChatModel: models.createChatModel,
    });
    const asked = acceptConsent(core);
    const provider = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-sonnet-5-5",
    });
    const fetched = answerFetch({
      [ANTHROPIC_MODELS]: { data: [{ id: "claude-haiku-5-5" }, { id: "claude-sonnet-5-5" }] },
    });

    const result = await core.testChatProvider(provider.id);

    expect(result).toEqual({ ok: true, modelId: "claude-haiku-5-5", ms: expect.any(Number) });
    expect(fetched.asked(ANTHROPIC_MODELS)).toBe(1);
    expect(models.specs.map((spec) => spec.modelId)).toEqual(["claude-haiku-5-5"]);
    expect(models.specs[0]?.apiKey).toBe("sk-ant-test");
    // Choosing Anthropic allowed sending to it: nothing more to ask.
    expect(asked()).toBe(0);
  });

  test("a key refused at the list says so, and nothing more is sent", async () => {
    const models = scriptedModels(replyingModel("OK"));
    const core = startCore(await createTempDataFolder(), {
      keychain: createMemoryKeychain(),
      createChatModel: models.createChatModel,
    });
    const provider = await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-wrong",
      modelId: "gpt-6.1-sol",
    });
    answerFetch({ [OPENAI_MODELS]: 401 });

    const result = await core.testChatProvider(provider.id);

    expect(result).toMatchObject({
      ok: false,
      step: "list",
      modelId: null,
      error: { kind: "auth" },
    });
    expect(models.specs).toEqual([]);
  });

  test("a model that refuses the word says which one, and why", async () => {
    const models = scriptedModels(failingModel(404, "model not found"));
    const core = startCore(await createTempDataFolder(), {
      keychain: createMemoryKeychain(),
      createChatModel: models.createChatModel,
    });
    const provider = await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-test",
      modelId: "gpt-6.1-sol",
    });
    answerFetch({ [OPENAI_MODELS]: { data: [{ id: "gpt-6.1-sol" }] } });

    const result = await core.testChatProvider(provider.id);

    expect(result).toMatchObject({
      ok: false,
      step: "answer",
      modelId: "gpt-6-luna",
      error: { kind: "model" },
    });
  });

  test("in Local mode nothing goes to a cloud provider, not even its list", async () => {
    const models = scriptedModels(replyingModel("OK"));
    const core = startCore(await createTempDataFolder(), {
      keychain: createMemoryKeychain(),
      createChatModel: models.createChatModel,
    });
    const provider = await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-test",
      modelId: "gpt-6.1-sol",
    });
    await core.setLocalOnly(true);
    const fetched = answerFetch({ [OPENAI_MODELS]: { data: [{ id: "gpt-6.1-sol" }] } });

    const result = await core.testChatProvider(provider.id);

    expect(result).toMatchObject({ ok: false, step: "list", error: { kind: "local-mode" } });
    expect(fetched.asked(OPENAI_MODELS)).toBe(0);
    expect(models.specs).toEqual([]);
  });

  test("with sending turned off, the Test asks first; declined, nothing is sent", async () => {
    const models = scriptedModels(replyingModel("OK"));
    const core = startCore(await createTempDataFolder(), {
      keychain: createMemoryKeychain(),
      createChatModel: models.createChatModel,
    });
    const provider = await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-test",
      modelId: "gpt-6.1-sol",
    });
    if (!provider.service) throw new Error("OpenAI is a service.");
    await core.revokeConsent("chat", provider.service.id);
    let asked = 0;
    core.on("consent.requested", (request) => {
      asked += 1;
      void core.respondToConsent(request.requestId, false);
    });
    const fetched = answerFetch({ [OPENAI_MODELS]: { data: [{ id: "gpt-6.1-sol" }] } });

    const result = await core.testChatProvider(provider.id);

    expect(asked).toBe(1);
    expect(result).toMatchObject({ ok: false, step: "list", error: { kind: "consent-declined" } });
    expect(fetched.asked(OPENAI_MODELS)).toBe(0);
    expect(models.specs).toEqual([]);
  });
});

describe("The models for the other jobs", () => {
  test("follow the Answers model's provider until the User sets their own", async () => {
    const core = startCore(await createTempDataFolder(), { keychain: createMemoryKeychain() });
    expect(await core.getModelRoles()).toEqual({ quickTasks: null, images: null });
    const provider = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-fable-5-1",
    });
    expect(await core.getModelRoles()).toEqual({
      quickTasks: { providerId: provider.id, modelId: "claude-haiku-5-5" },
      images: { providerId: provider.id, modelId: "claude-fable-5-1" },
    });

    await core.updateSettings({
      user: { quickTasksModel: { providerId: provider.id, modelId: "claude-sonnet-5-5" } },
    });
    expect((await core.getModelRoles()).quickTasks).toEqual({
      providerId: provider.id,
      modelId: "claude-sonnet-5-5",
    });
  });
});

describe("The model menu's list in the background", () => {
  test("isn't asked for in Local mode: its request carries the key", async () => {
    const core = startCore(await createTempDataFolder(), { keychain: createMemoryKeychain() });
    await core.saveChatProvider({ kind: "openai", apiKey: "sk-test", modelId: "gpt-6.1-sol" });
    await core.setLocalOnly(true);
    const fetched = answerFetch({ [OPENAI_MODELS]: { data: [{ id: "gpt-6.1-sol" }] } });

    const [group] = await core.listChatModels();

    expect(fetched.asked(OPENAI_MODELS)).toBe(0);
    expect(group?.models).toEqual(["gpt-6.1-sol"]);
  });
});

describe("Removing a provider", () => {
  test("puts the quick-tasks and image models it held back to Automatic", async () => {
    const core = startCore(await createTempDataFolder(), { keychain: createMemoryKeychain() });
    const answers = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
    const other = await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-test",
      modelId: "gpt-6-luna",
      keepDefault: true,
    });
    await core.updateSettings({
      user: {
        quickTasksModel: { providerId: other.id, modelId: "gpt-6-luna" },
        imageModel: { providerId: other.id, modelId: "gpt-6.1-sol" },
      },
    });

    await core.deleteChatProvider(other.id);

    const { user } = await core.getSettings();
    expect(user.quickTasksModel).toBeNull();
    expect(user.imageModel).toBeNull();
    expect(user.chatModel).toEqual({ providerId: answers.id, modelId: "claude-haiku-5-5" });
  });

  test("that held the Answers model moves Answers to a provider that is left, or to none", async () => {
    const core = startCore(await createTempDataFolder(), { keychain: createMemoryKeychain() });
    const server = await core.saveChatProvider({
      kind: "openai-compatible",
      baseUrl: await modelServer(["first-model", "second-model"]),
      modelId: "first-model",
    });
    const anthropic = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });

    await core.deleteChatProvider(anthropic.id);
    expect((await core.getSettings()).user.chatModel).toEqual({
      providerId: server.id,
      modelId: "first-model",
    });

    await core.deleteChatProvider(server.id);
    expect((await core.getSettings()).user.chatModel).toBeNull();
  });
});

describe("Data from before migration 101", () => {
  test("keeps its providers as rows, the model the User added and the one taken back out, which can be put back", async () => {
    const dataDir = await createTempDataFolder();
    const baseUrl = await modelServer(["listed-a", "listed-b"]);
    const providerId = "3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c";
    const at = "2026-10-01T09:00:00.000Z";
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      migrate(
        db,
        migrations.filter((migration) => migration.version <= 99),
      );
      db.run(
        `INSERT INTO chat_providers (id, kind, base_url, catalog_id, endpoint, created_at, updated_at)
         VALUES (?, 'openai-compatible', ?, 'openai-compatible', NULL, ?, ?)`,
        [providerId, baseUrl, at, at],
      );
      db.run(
        `INSERT INTO chat_menu_models (id, provider_id, model_id, created_at, updated_at)
         VALUES ('a1b2c3d4-0000-4000-8000-000000000001', ?, 'my-model', ?, ?)`,
        [providerId, at, at],
      );
      db.run(
        `INSERT INTO chat_menu_models (id, provider_id, model_id, created_at, updated_at, deleted_at)
         VALUES ('a1b2c3d4-0000-4000-8000-000000000002', ?, 'taken-out-model', ?, ?, ?)`,
        [providerId, at, at, at],
      );
    } finally {
      db.close();
    }

    const core = startCore(dataDir);
    expect((await core.listChatProviders()).map((each) => each.id)).toEqual([providerId]);
    const [group] = await core.listChatModels();
    expect(group?.models).toEqual(["listed-a", "listed-b", "my-model"]);
    expect(group?.added).toEqual(["my-model"]);
    expect(group?.hidden).toEqual([]);

    await core.setChatModelInMenu({ providerId, modelId: "taken-out-model", inMenu: true });
    await core.setChatModelInMenu({ providerId, modelId: "listed-b", inMenu: false });
    const [after] = await core.listChatModels();
    expect(after?.models).toEqual(["listed-a", "my-model", "taken-out-model"]);
    expect(after?.hidden).toEqual(["listed-b"]);
  });
});
