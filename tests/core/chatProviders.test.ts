import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type Core, InvalidInputError } from "../../src/core";
import { createFileKeychain, SECRETS_FILE } from "../../src/main/secretsFile";
import { createFakeCipher } from "../helpers/cipher";
import { createMemoryKeychain, createTempDataFolder, nextEvent, startCore } from "../helpers/core";
import { failingModel, replyingModel, scriptedModels, unreachableModel } from "../helpers/models";

const OPENAI_KEY = "sk-test-0123456789-do-not-store-in-sqlite";

/** Accepts every consent request, for tests that aren't about consent. */
function acceptConsentAutomatically(core: Core): void {
  core.on("consent.requested", (request) => void core.respondToConsent(request.requestId, true));
}

/** Every file in a folder, recursively, as bytes. */
async function readAllFiles(dir: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files.set(path, await readFile(path));
    }
  }
  return files;
}

describe("Chat providers", () => {
  test("a new data folder has no provider, so Questions can't be asked", async () => {
    const core = startCore(await createTempDataFolder());

    expect(await core.listChatProviders()).toEqual([]);
    expect(await core.getChatReadiness()).toEqual({ ready: false, reason: "no-provider" });
    expect((await core.getSettings()).user.chatModel).toBeNull();
  });

  test("saving a provider makes its model the default chat model", async () => {
    const core = startCore(await createTempDataFolder());
    const settingsChanged = nextEvent(core, "settings.changed");
    const readinessChanged = nextEvent(core, "chatReadiness.changed");

    const provider = await core.saveChatProvider({
      kind: "openai",
      apiKey: OPENAI_KEY,
      modelId: " gpt-5.4-mini ",
    });

    expect(provider).toEqual({
      id: expect.any(String),
      kind: "openai",
      // OpenAI in the catalog, on its one endpoint.
      catalogId: "openai",
      endpoint: "global",
      baseUrl: null,
      hasApiKey: true,
      service: { id: "https://api.openai.com", name: "OpenAI" },
    });
    expect(await core.listChatProviders()).toEqual([provider]);
    const chatModel = { providerId: provider.id, modelId: "gpt-5.4-mini" };
    expect((await settingsChanged).user.chatModel).toEqual(chatModel);
    // Choosing it allowed sending to it (ADR-0022): the first Question asks nothing.
    expect(await readinessChanged).toEqual({
      ready: true,
      provider,
      modelId: "gpt-5.4-mini",
      consent: "accepted",
    });
  });

  test("the key goes to the secrets file, encrypted, and never into the database", async () => {
    const dataDir = await createTempDataFolder();
    const secretsFile = join(dataDir, SECRETS_FILE);
    const before = startCore(dataDir, {
      keychain: createFileKeychain(secretsFile, createFakeCipher()),
    });
    await before.saveChatProvider({ kind: "openai", apiKey: OPENAI_KEY, modelId: "gpt-5.4-mini" });
    before.close();

    const files = await readAllFiles(dataDir);
    expect([...files.keys()].map((path) => path.slice(dataDir.length + 1)).sort()).toEqual([
      "incarnamind.db",
      SECRETS_FILE,
    ]);
    for (const [path, bytes] of files) {
      expect(bytes.includes(OPENAI_KEY), `${path} contains the key in plain text`).toBe(false);
    }

    // After a restart the key is still there: the connection test sends it.
    const models = scriptedModels(replyingModel());
    const after = startCore(dataDir, {
      keychain: createFileKeychain(secretsFile, createFakeCipher()),
      createChatModel: models.createChatModel,
    });
    acceptConsentAutomatically(after);
    await after.testChatConnection({ kind: "openai", modelId: "gpt-5.4-mini" });
    expect(models.specs[0]?.apiKey).toBe(OPENAI_KEY);
  });

  test("providers and the default model survive a restart", async () => {
    const dataDir = await createTempDataFolder();
    const keychain = createMemoryKeychain();
    const before = startCore(dataDir, { keychain });
    const provider = await before.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-sonnet-4-6",
    });
    before.close();

    const after = startCore(dataDir, { keychain });

    expect(await after.listChatProviders()).toEqual([provider]);
    expect(await after.getChatReadiness()).toMatchObject({
      ready: true,
      provider,
      modelId: "claude-sonnet-4-6",
    });
  });

  test("saving the same provider again updates it, and an omitted key keeps the stored one", async () => {
    const keychain = createMemoryKeychain();
    const core = startCore(await createTempDataFolder(), { keychain });
    const first = await core.saveChatProvider({
      kind: "google",
      apiKey: "first-key",
      modelId: "gemini-flash-latest",
    });

    const second = await core.saveChatProvider({ kind: "google", modelId: "gemini-2.5-pro" });
    const third = await core.saveChatProvider({
      kind: "google",
      apiKey: "second-key",
      modelId: "gemini-2.5-pro",
    });

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(await core.listChatProviders()).toHaveLength(1);
    expect([...keychain.secrets.values()]).toEqual(["second-key"]);
    expect((await core.getSettings()).user.chatModel).toEqual({
      providerId: first.id,
      modelId: "gemini-2.5-pro",
    });
  });

  test("an OpenAI-compatible server needs a URL; its key is optional", async () => {
    const core = startCore(await createTempDataFolder());

    await expect(
      core.saveChatProvider({ kind: "openai-compatible", modelId: "deepseek-chat" }),
    ).rejects.toThrow(InvalidInputError);
    const provider = await core.saveChatProvider({
      kind: "openai-compatible",
      baseUrl: " https://api.deepseek.com/v1/ ",
      modelId: "deepseek-chat",
    });

    expect(provider).toMatchObject({
      kind: "openai-compatible",
      baseUrl: "https://api.deepseek.com/v1",
      hasApiKey: false,
      service: { id: "https://api.deepseek.com", name: "api.deepseek.com" },
    });
    expect(await core.getChatReadiness()).toMatchObject({ ready: true, consent: "accepted" });
  });

  test("a server on this computer sends nothing out, so it needs no consent", async () => {
    const core = startCore(await createTempDataFolder());

    const provider = await core.saveChatProvider({
      kind: "openai-compatible",
      baseUrl: "http://localhost:1234/v1",
      modelId: "qwen3-8b",
    });

    expect(provider.service).toBeNull();
    expect(await core.getChatReadiness()).toEqual({
      ready: true,
      provider,
      modelId: "qwen3-8b",
      consent: "not-required",
    });
    expect(await core.listDataFlows()).toEqual([]);
  });

  test.each([
    { name: "OpenAI", kind: "openai" },
    { name: "Anthropic", kind: "anthropic" },
    { name: "Google", kind: "google" },
  ] as const)("$name needs an API key, and nothing is saved without one", async ({ kind }) => {
    const core = startCore(await createTempDataFolder());

    await expect(core.saveChatProvider({ kind, modelId: "some-model" })).rejects.toThrow(/API key/);
    await expect(core.saveChatProvider({ kind, apiKey: "  ", modelId: "m" })).rejects.toThrow(
      InvalidInputError,
    );
    expect(await core.listChatProviders()).toEqual([]);
    expect(await core.getChatReadiness()).toEqual({ ready: false, reason: "no-provider" });
  });

  test.each([
    { name: "an unknown provider", input: { kind: "gemini-subscription", modelId: "m" } },
    { name: "no model", input: { kind: "openai", apiKey: "k", modelId: " " } },
    {
      name: "a URL for OpenAI",
      input: { kind: "openai", apiKey: "k", baseUrl: "https://x.io", modelId: "m" },
    },
    {
      name: "a URL that isn't one",
      input: { kind: "openai-compatible", baseUrl: "not a url", modelId: "m" },
    },
    {
      name: "a file URL",
      input: { kind: "openai-compatible", baseUrl: "file:///etc", modelId: "m" },
    },
    {
      name: "a URL with a password in it",
      input: {
        kind: "openai-compatible",
        baseUrl: "https://me:sk-secret@api.example.com",
        modelId: "m",
      },
    },
    { name: "a key for Ollama", input: { kind: "ollama", apiKey: "k", modelId: "m" } },
  ])("rejects $name", async ({ input }) => {
    const core = startCore(await createTempDataFolder());

    await expect(core.saveChatProvider(input as never)).rejects.toThrow(InvalidInputError);
    expect(await core.listChatProviders()).toEqual([]);
  });

  test("deleting the default provider deletes its key and disables Questions", async () => {
    const keychain = createMemoryKeychain();
    const core = startCore(await createTempDataFolder(), { keychain });
    const provider = await core.saveChatProvider({
      kind: "openai",
      apiKey: OPENAI_KEY,
      modelId: "gpt-5.4-mini",
    });

    await core.deleteChatProvider(provider.id);
    await core.deleteChatProvider(provider.id);

    expect(await core.listChatProviders()).toEqual([]);
    expect(keychain.secrets.size).toBe(0);
    expect((await core.getSettings()).user.chatModel).toBeNull();
    expect(await core.getChatReadiness()).toEqual({ ready: false, reason: "no-provider" });
  });

  test("the User can switch the default model between saved providers", async () => {
    const core = startCore(await createTempDataFolder());
    const openai = await core.saveChatProvider({
      kind: "openai",
      apiKey: OPENAI_KEY,
      modelId: "gpt-5.4-mini",
    });
    await core.saveChatProvider({
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:8080/v1",
      modelId: "local-model",
    });

    await core.updateSettings({
      user: { chatModel: { providerId: openai.id, modelId: "gpt-5.5" } },
    });

    expect(await core.getChatReadiness()).toMatchObject({
      ready: true,
      provider: { id: openai.id },
      modelId: "gpt-5.5",
    });
  });

  test("Questions are disabled when the provider's key is missing on this device", async () => {
    const dataDir = await createTempDataFolder();
    const before = startCore(dataDir, { keychain: createMemoryKeychain() });
    const provider = await before.saveChatProvider({
      kind: "openai",
      apiKey: OPENAI_KEY,
      modelId: "gpt-5.4-mini",
    });
    before.close();

    // A new keychain: e.g. the secrets file was lost, or the database was copied to another machine.
    const after = startCore(dataDir, { keychain: createMemoryKeychain() });

    expect(await after.getChatReadiness()).toEqual({
      ready: false,
      reason: "missing-api-key",
      provider: { ...provider, hasApiKey: false },
      modelId: "gpt-5.4-mini",
    });
  });
});

describe("Test connection", () => {
  test("a working key sends one small real request and reports success", async () => {
    const models = scriptedModels(replyingModel());
    const core = startCore(await createTempDataFolder(), {
      createChatModel: models.createChatModel,
    });
    acceptConsentAutomatically(core);

    const result = await core.testChatConnection({
      kind: "openai",
      apiKey: OPENAI_KEY,
      modelId: "gpt-5.4-mini",
    });

    expect(result).toEqual({ ok: true });
    expect(models.specs).toEqual([
      {
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: OPENAI_KEY,
        modelId: "gpt-5.4-mini",
      },
    ]);
    expect(models.model.doGenerateCalls).toHaveLength(1);
  });

  test("testing doesn't save anything", async () => {
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(replyingModel()).createChatModel,
    });
    acceptConsentAutomatically(core);

    await core.testChatConnection({ kind: "anthropic", apiKey: "k", modelId: "claude-sonnet-4-6" });

    expect(await core.listChatProviders()).toEqual([]);
    expect(await core.getChatReadiness()).toEqual({ ready: false, reason: "no-provider" });
  });

  test.each([
    { status: 401, message: "Incorrect API key provided", kind: "auth" },
    { status: 403, message: "Permission denied", kind: "auth" },
    { status: 400, message: "API key not valid. Please pass a valid API key.", kind: "auth" },
    { status: 404, message: "The model `gpt-9` does not exist", kind: "model" },
    { status: 429, message: "Rate limit reached", kind: "rate-limit" },
    { status: 500, message: "Internal server error", kind: "provider" },
  ])("an HTTP $status is reported as $kind", async ({ status, message, kind }) => {
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(failingModel(status, message)).createChatModel,
    });
    acceptConsentAutomatically(core);

    const result = await core.testChatConnection({
      kind: "openai",
      apiKey: "sk-wrong",
      modelId: "gpt-9",
    });

    expect(result).toEqual({ ok: false, error: { kind, message, status } });
  });

  // protects=a key a provider refuses is not tried with any other provider by itself (#1384); fails_when=a refusal makes a second model, for another service, get the key; no_claim=the key form's own check of whose key it looks like, which keyForms.test.ts and the keyForm smoke test cover.
  test("a key that is refused is tested once, with the provider it was given for, and never with another", async () => {
    const models = scriptedModels(failingModel(401, "Incorrect API key provided"));
    const core = startCore(await createTempDataFolder(), {
      createChatModel: models.createChatModel,
    });
    acceptConsentAutomatically(core);
    const kimiKey = `sk-${"aZ3".repeat(16)}`;

    const result = await core.testChatConnection({
      kind: "anthropic",
      apiKey: kimiKey,
      modelId: "claude-haiku-5-5",
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "auth" } });
    expect(models.specs).toHaveLength(1);
    expect(models.specs[0]).toMatchObject({ kind: "anthropic", apiKey: kimiKey });
    expect(models.model.doGenerateCalls).toHaveLength(1);
  });

  test("a server that can't be reached is reported as a network problem", async () => {
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(unreachableModel()).createChatModel,
    });

    const result = await core.testChatConnection({
      kind: "ollama",
      baseUrl: "http://127.0.0.1:1",
      modelId: "qwen3:4b",
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "network" } });
  });

  test("without a key in the input, the stored key is tested", async () => {
    const models = scriptedModels(replyingModel());
    const core = startCore(await createTempDataFolder(), {
      createChatModel: models.createChatModel,
    });
    acceptConsentAutomatically(core);
    await core.saveChatProvider({ kind: "openai", apiKey: OPENAI_KEY, modelId: "gpt-5.4-mini" });

    await core.testChatConnection({ kind: "openai", modelId: "gpt-5.4-mini" });

    expect(models.specs[0]?.apiKey).toBe(OPENAI_KEY);
  });

  test("a key is tested without the spaces, line breaks and invisible characters around it", async () => {
    const models = scriptedModels(replyingModel());
    const core = startCore(await createTempDataFolder(), {
      createChatModel: models.createChatModel,
    });
    acceptConsentAutomatically(core);

    const result = await core.testChatConnection({
      kind: "openai",
      apiKey: `\uFEFF \n${OPENAI_KEY}\u200B\u00A0 `,
      modelId: "gpt-5.4-mini",
    });

    expect(result).toEqual({ ok: true });
    expect(models.specs[0]?.apiKey).toBe(OPENAI_KEY);
  });

  test("a key with a character that keys don't use is refused in plain words, naming only that character, before anything is sent", async () => {
    const models = scriptedModels(replyingModel());
    const core = startCore(await createTempDataFolder(), {
      createChatModel: models.createChatModel,
    });
    acceptConsentAutomatically(core);
    const apiKey = "sk-test-1234作品-not-a-real-key";
    const wording = { key: "error.provider.keyCharacter", values: { character: "作" } };

    const test = core.testChatConnection({ kind: "openai", apiKey, modelId: "gpt-5.4-mini" });
    await expect(test).rejects.toMatchObject({ wording });
    await expect(test).rejects.not.toThrow(/sk-test/);
    await expect(
      core.saveChatProvider({ kind: "openai", apiKey, modelId: "gpt-5.4-mini" }),
    ).rejects.toMatchObject({ wording });

    expect(models.specs).toEqual([]);
    expect(await core.listChatProviders()).toEqual([]);
  });

  test("a provider that needs a key isn't tested without one", async () => {
    const models = scriptedModels(replyingModel());
    const core = startCore(await createTempDataFolder(), {
      createChatModel: models.createChatModel,
    });

    await expect(core.testChatConnection({ kind: "google", modelId: "m" })).rejects.toThrow(
      InvalidInputError,
    );
    expect(models.specs).toEqual([]);
  });
});
