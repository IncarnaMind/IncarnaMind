/**
 * The models for the jobs that aren't Answers: the quick-tasks model for
 * an Answer's search query, its translation and automatic tagging, the image
 * model for a scan's pages, and the one Tagging setting, Automatic unless the
 * User picks a model, which Organize uses too. Through the core's public
 * interface, with scripted models standing in for every provider: no network.
 */
import { describe, expect, test, vi } from "vitest";
import type { ChatModelFactory, ChatModelSpec, Core, CoreAdapters } from "../../src/core";
import { type AnswerRequest, createAiSdkAnswerEngine } from "../../src/core/answers/engine";
import { installedOllamaModels } from "../../src/core/providers/ollama";
import { answerEnded } from "../helpers/citations";
import {
  createTempDataFolder,
  queryDatabase,
  startCore,
  turnOnAutomaticTagging,
} from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { startFakeJev } from "../helpers/jev";
import { connectToMind } from "../helpers/mindClient";
import { note, question, writeMind } from "../helpers/minds";
import { scriptedModel } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";
import { waitForTagging } from "../helpers/tags";

const ANTHROPIC = "https://api.anthropic.com";
const OPENROUTER = "https://openrouter.ai";

/** What one call that doesn't write the Answer asked of which model. */
interface SmallCall {
  kind: string;
  modelId: string;
  thinking: ChatModelSpec["thinking"];
  /** What it was for, from its instructions. */
  purpose: "rewrite" | "translate" | "tags" | "organize" | "other";
}

/**
 * Every provider's models, scripted: a rewrite gives a query, a translation
 * a Chinese one, tagging no Tags, Organize no Folder; an Answer (streamed)
 * a plain one, as JSON for structured output. With `thinks`, a model thinks
 * through a small call's whole output unless asked not to, as Kimi K2.6 does;
 * with `refusesTools`, it takes no Tools.
 */
function scriptedProviders({ thinks = false, refusesTools = false } = {}) {
  const specs: ChatModelSpec[] = [];
  const calls: SmallCall[] = [];
  const answers: string[] = [];
  const createChatModel: ChatModelFactory = (spec) => {
    specs.push(spec);
    return scriptedModel(
      (call) => {
        if (refusesTools && call.tools.length > 0) {
          return { error: { status: 400, message: "this model does not support tools" } };
        }
        answers.push(spec.modelId);
        return call.json
          ? { text: JSON.stringify({ answer: "Cities stay warm at night.", citations: [] }) }
          : { text: "Cities stay warm at night." };
      },
      {
        modelId: spec.modelId,
        generate: ({ system, options }) => {
          const schema =
            options.responseFormat?.type === "json" ? options.responseFormat.schema : undefined;
          const purpose: SmallCall["purpose"] = schema?.properties?.groupId
            ? "organize"
            : schema?.properties?.tags
              ? "tags"
              : system.startsWith("You turn a Question")
                ? "rewrite"
                : system.startsWith("You translate a query")
                  ? "translate"
                  : "other";
          calls.push({ kind: spec.kind, modelId: spec.modelId, thinking: spec.thinking, purpose });
          if (
            thinks &&
            spec.thinking !== "off" &&
            (purpose === "rewrite" || purpose === "translate")
          ) {
            return { text: "", cutOff: true };
          }
          const text = {
            organize: JSON.stringify({ groupId: "__unsorted__", tags: [] }),
            tags: JSON.stringify({ tags: [] }),
            rewrite: "urban heat islands at night",
            translate: "城市热岛 夜间",
            other: "OK",
          }[purpose];
          return { text };
        },
      },
    );
  };
  return { createChatModel, specs, calls, answers };
}

async function start(
  adapters: Partial<CoreAdapters> = {},
  scripted: Parameters<typeof scriptedProviders>[0] = {},
) {
  const models = scriptedProviders(scripted);
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, { createChatModel: models.createChatModel, ...adapters });
  return { core, dataDir, ...models };
}

async function addText(core: Core, name: string, text: string) {
  const [document] = await addAndProcess(core, [
    await writeSourceFile(await createTempDataFolder(), name, text),
  ]);
  if (!document) throw new Error("Nothing was added.");
  return document;
}

const automaticOf = async (core: Core) => (await core.getTaggingModels()).automatic;

describe("Automatic picks the model that tags", () => {
  test("with no model at all, nothing: Documents wait for one, and nothing is sent", async () => {
    const { core, calls } = await start();
    expect((await core.getLibrary()).settings.classifier).toEqual({ kind: "automatic" });
    expect(await automaticOf(core)).toBeNull();
    const document = await addText(core, "Notes.md", "Notes from the first meeting.");
    expect(document.tagging).toBe("waiting-for-provider");
    expect(calls).toEqual([]);
  });

  test("1. a Jev key comes first", async () => {
    const { core } = await start();
    await core.saveChatProvider({ kind: "openai", apiKey: "sk-test", modelId: "gpt-6.1-sol" });
    await core.saveJevSettings({ apiKey: "jev-test" });
    expect(await automaticOf(core)).toMatchObject({
      classifier: { kind: "jev" },
      reason: "jev",
      likelihoods: true,
    });
  });

  test.each([
    ["anthropic", "claude-sonnet-5-5", "claude-haiku-5-5", "Claude Haiku 5.5", "quick-model"],
    ["openai", "gpt-6.1-sol", "gpt-6-luna", "GPT-6 Luna", "quick-model"],
    ["mistral", "mistral-medium-2604", "mistral-small-2603", "Mistral Small 4", "tagging-model"],
  ] as const)(
    "2. a %s key: its tagging model, %s → %s",
    async (kind, answers, tagging, name, reason) => {
      const { core } = await start();
      const provider = await core.saveChatProvider({ kind, apiKey: "key", modelId: answers });
      expect(await automaticOf(core)).toMatchObject({
        classifier: { kind: "chat", choice: { providerId: provider.id, modelId: tagging } },
        name,
        reason,
        group: "keys",
        goodForTagging: true,
        likelihoods: false,
        cost: { kind: "estimate", currency: "USD" },
      });
    },
  );

  test("2. a server that names no quick model tags with its model for Answers", async () => {
    const { core } = await start();
    const provider = await core.saveChatProvider({
      kind: "openai-compatible",
      baseUrl: "https://llm.example.com/v1",
      apiKey: "key",
      modelId: "house-model",
    });
    expect(await automaticOf(core)).toMatchObject({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "house-model" } },
      reason: "answers-model",
      goodForTagging: false,
    });
  });

  test("2. never an Ollama cloud model: Ollama's cloud doesn't hold a reply to a schema", async () => {
    const { core } = await start();
    await core.saveChatProvider({ kind: "ollama", modelId: "gpt-oss:20b-cloud" });
    expect(await automaticOf(core)).toBeNull();
    const models = await core.getTaggingModels();
    expect(models.options.map((option) => option.name)).not.toContain("gpt-oss:20b-cloud");
  });

  test("2. Ollama on another computer is not Ollama's cloud: its own model tags", async () => {
    const { core } = await start();
    const provider = await core.saveChatProvider({
      kind: "ollama",
      baseUrl: "http://192.168.1.20:11434",
      modelId: "llama-lan",
    });
    expect(await automaticOf(core)).toMatchObject({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "llama-lan" } },
      reason: "answers-model",
    });
    const { options } = await core.getTaggingModels();
    expect(options.map((option) => option.name)).toContain("llama-lan");
  });

  test("3. Ollama at another computer's address, from OLLAMA_HOST, is never asked or tagged with", async () => {
    const asked: string[] = [];
    const { core, calls } = await start({
      ollamaUrl: "http://192.168.1.20:11434",
      localModels: async (baseUrl) => {
        asked.push(baseUrl);
        return ["tev1:4b", "clef-flash:latest"];
      },
    });
    expect(await automaticOf(core)).toBeNull();
    expect((await core.getTaggingModels()).options).toEqual([]);
    const document = await addText(core, "Notes.md", "Notes from the first meeting.");
    expect(document.tagging).toBe("waiting-for-provider");
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("3. a decision model kept from before at another computer's address counts as sending there", async () => {
    const dataDir = await createTempDataFolder();
    const before = startCore(dataDir, { localModels: async () => ["tev1:4b"] });
    await before.saveLibrarySettings({
      classifier: { kind: "auto", baseUrl: "http://127.0.0.1:11434" },
      automatic: true,
    });
    before.close();
    queryDatabase(
      dataDir,
      "UPDATE device_settings SET value = ? WHERE key = 'library' AND deleted_at IS NULL RETURNING key",
      [
        JSON.stringify({
          classifier: { kind: "auto", baseUrl: "http://192.168.1.20:11434" },
          automatic: true,
        }),
      ],
    );
    const core = startCore(dataDir, { localModels: async () => ["tev1:4b"] });
    const tagging = (await core.listRegisteredDataFlows()).find((flow) => flow.id === "tagging");
    expect(tagging?.services.map((each) => each.flow.service.id)).toEqual([
      "http://192.168.1.20:11434",
    ]);
    const document = await addText(core, "Notes.md", "Notes from the first meeting.");
    expect(document.tagging).toBe("waiting-for-provider");
    core.close();
  });

  test("3. a local decision model in Ollama, before the chat model on this computer", async () => {
    const { core } = await start({ localModels: async () => ["qwen3.5:4b", "tev1:4b"] });
    await core.saveChatProvider({ kind: "ollama", modelId: "qwen3.5:4b" });
    expect(await automaticOf(core)).toMatchObject({
      classifier: { kind: "auto" },
      reason: "decision-models",
      decisionModel: true,
      likelihoods: true,
      cost: { kind: "free" },
    });
  });

  test("3. with no Folders, a local decision model tags each Tag with how sure it is", async () => {
    const jev = await startFakeJev({ apiKey: "ollama", ollamaModels: ["tev1:0.8b"] });
    jev.answer({ Paper: 0.92, Report: 0.55 });
    const { core, calls } = await start({ localModels: installedOllamaModels });
    await core.saveChatProvider({ kind: "ollama", baseUrl: jev.url, modelId: "local-model" });
    expect(await automaticOf(core)).toMatchObject({ reason: "decision-models" });

    const document = await addText(core, "Attention.md", "Attention Is All You Need. A paper.");
    const [tagged] = await waitForTagging(core, [document.id]);

    expect(jev.requests.map((each) => each.body.model)).toEqual(["tev1:0.8b"]);
    // Each Tag is a yes or no, with no Folder to choose.
    expect(Object.values(jev.requests[0]?.body.questions ?? {}).map((q) => q.type)).not.toContain(
      "choice",
    );
    const names = Object.fromEntries((await core.listTags()).map((tag) => [tag.id, tag.name]));
    expect(tagged?.tags.map((tag) => [names[tag.tagId], tag.confidence, tag.needsReview])).toEqual(
      expect.arrayContaining([
        ["Paper", 0.92, false],
        ["Report", 0.55, true],
      ]),
    );
    expect(calls).toEqual([]);
  });

  test("3. a User whose only model is outside IncarnaMind gets an installed decision model", async () => {
    const { core } = await start({ localModels: async () => ["clef-flash:latest"] });
    expect(await automaticOf(core)).toMatchObject({
      classifier: { kind: "ollama", modelId: "clef-flash", usePageImages: true },
      reason: "decision-models",
    });
  });

  test("4. otherwise the chat model on this computer", async () => {
    const { core } = await start({ localModels: async () => ["qwen3.5:4b"] });
    const provider = await core.saveChatProvider({ kind: "ollama", modelId: "qwen3.5:4b" });
    expect(await automaticOf(core)).toMatchObject({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "qwen3.5:4b" } },
      reason: "local-chat",
      group: "local",
      cost: { kind: "free" },
    });
  });

  test("in local mode only a model on this computer", async () => {
    const { core } = await start({ localModels: async () => ["qwen3.5:4b"] });
    const ollama = await core.saveChatProvider({ kind: "ollama", modelId: "qwen3.5:4b" });
    await core.saveChatProvider({ kind: "anthropic", apiKey: "key", modelId: "claude-sonnet-5-5" });
    expect(await automaticOf(core)).toMatchObject({ reason: "quick-model" });

    await core.setLocalOnly(true);
    expect(await automaticOf(core)).toMatchObject({
      classifier: { kind: "chat", choice: { providerId: ollama.id, modelId: "qwen3.5:4b" } },
      reason: "local-chat",
    });
    expect((await core.getTaggingModels()).localMode).toBe(true);
  });

  test("the hand-picked list groups models as the model chip does, with what 100 Documents cost", async () => {
    const { core } = await start({ localModels: async () => ["tev1:4b", "tev1:0.8b"] });
    await core.saveChatProvider({ kind: "ollama", modelId: "qwen3.5:4b" });
    await core.saveChatProvider({ kind: "anthropic", apiKey: "key", modelId: "claude-sonnet-5-5" });
    const { options } = await core.getTaggingModels();
    expect(options.map((option) => [option.group, option.name])).toEqual([
      ["keys", "Claude Haiku 5.5"],
      ["keys", "Claude Sonnet 5.5"],
      ["local", "Tev1, Clef-Flash"],
      ["local", "Tev1 4B"],
      ["local", "Tev1 0.8B"],
    ]);
    const [haiku, sonnet] = options;
    expect(haiku).toMatchObject({ goodForTagging: true, provider: { en: "Anthropic" } });
    expect(sonnet).toMatchObject({ goodForTagging: false });
    // About 1,500 tokens in and 25 out a Document, at the catalog's price.
    if (haiku?.cost.kind !== "estimate" || sonnet?.cost.kind !== "estimate")
      throw new Error("No estimate.");
    expect(haiku.cost.amount).toBeCloseTo(0.016, 3);
    expect(sonnet.cost.amount).toBeGreaterThan(10 * haiku.cost.amount);
    expect(options.filter((option) => option.decisionModel)).toHaveLength(3);
  });
});

describe("The hand-picked list holds the saved choice", () => {
  const saved = [
    { name: "a role model", modelId: "claude-haiku-5-5" },
    { name: "a model that is no role", modelId: "claude-sonnet-5-5" },
    { name: "a model the User added", modelId: "claude-added-by-the-user" },
  ];
  for (const { name, modelId } of saved) {
    for (const chatDefault of ["the same", "another"] as const) {
      test(`${name}, with ${chatDefault} chat default: listed while its provider is saved, gone with it`, async () => {
        const { core } = await start();
        const anthropic = await core.saveChatProvider({
          kind: "anthropic",
          apiKey: "key",
          modelId,
        });
        const library = (await core.getLibrary()).settings;
        await core.saveLibrarySettings({
          ...library,
          classifier: { kind: "chat", choice: { providerId: anthropic.id, modelId } },
        });
        if (chatDefault === "another") {
          await core.saveChatProvider({ kind: "openai", apiKey: "key", modelId: "gpt-6-luna" });
        }
        const listed = async () =>
          (await core.getTaggingModels()).options.filter(
            (option) =>
              option.classifier.kind === "chat" &&
              option.classifier.choice.providerId === anthropic.id &&
              option.classifier.choice.modelId === modelId,
          );
        expect(await listed()).toMatchObject([{ provider: { en: "Anthropic" }, group: "keys" }]);

        await core.deleteChatProvider(anthropic.id);
        expect(await listed()).toEqual([]);
      });
    }
  }
});

describe("Which model each quick call uses", () => {
  test("an Answer's search query and its translation go to the quick-tasks model; the Answer to its own", async () => {
    const { core, calls, answers, specs } = await start();
    // A model that can't call Tools searches once, for the Question rewritten, and translated.
    await core.saveChatProvider({
      kind: "openrouter",
      apiKey: "key",
      modelId: "cohere/command-r7b-12-2024",
    });
    await core.allowDataFlow("chat", OPENROUTER);
    await core.allowDataFlow("tagging", OPENROUTER);
    await addText(
      core,
      "城市热岛.md",
      "城市热岛效应在夜间最强。公园可以降低周边的气温。".repeat(10),
    );
    const mind = await core.createMind({ title: "Heat" });
    const client = await connectToMind(core, mind.id);
    const asked = question("How do they change at night?");
    writeMind(client, [
      note("Urban heat islands are cities warmer than the land around them."),
      asked,
    ]);
    await client.settled();

    const result = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
    if (!result.asked) throw new Error("Not asked.");
    const ended = await answerEnded(core, result.answerId);

    if (ended.event !== "finished") throw new Error("The Answer failed.");
    expect(ended.payload.citationSupport).not.toBe("tools");
    const small = calls.filter(
      (each) => each.purpose === "rewrite" || each.purpose === "translate",
    );
    expect(small).toEqual([
      { kind: "openrouter", modelId: "openai/gpt-6-luna", thinking: "off", purpose: "rewrite" },
      { kind: "openrouter", modelId: "openai/gpt-6-luna", thinking: "off", purpose: "translate" },
    ]);
    expect(answers).toEqual(["cohere/command-r7b-12-2024"]);
    expect(specs.find((spec) => spec.modelId === "cohere/command-r7b-12-2024")?.thinking).toBe(
      "answer",
    );
    // Counted as the Answer's, as its own call is: 5 input tokens each.
    expect(ended.payload.usage.inputTokens).toBe(15);
  });

  test("a quick-tasks model that is the Answers model still skips thinking, so the rewrite and its translation come back", async () => {
    const { core, calls, specs } = await start({}, { thinks: true, refusesTools: true });
    // The catalog gives Kimi K2.6 both jobs.
    const provider = await core.saveChatProvider({
      kind: "kimi",
      apiKey: "key",
      modelId: "kimi-k2.6",
    });
    if (provider.service) await core.allowDataFlow("chat", provider.service.id);
    await addText(
      core,
      "城市热岛.md",
      "城市热岛效应在夜间最强。公园可以降低周边的气温。".repeat(10),
    );
    const mind = await core.createMind({ title: "Heat" });
    const client = await connectToMind(core, mind.id);
    const asked = question("How do they change at night?");
    writeMind(client, [
      note("Urban heat islands are cities warmer than the land around them."),
      asked,
    ]);
    await client.settled();
    const searched: unknown[] = [];
    core.on("answer.toolCallStarted", ({ call }) => searched.push(call.input.query));

    const result = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
    if (!result.asked) throw new Error("Not asked.");
    const ended = await answerEnded(core, result.answerId);

    if (ended.event !== "finished") throw new Error("The Answer failed.");
    const small = calls.filter(
      (each) => each.purpose === "rewrite" || each.purpose === "translate",
    );
    expect(small).toEqual([
      { kind: "kimi", modelId: "kimi-k2.6", thinking: "off", purpose: "rewrite" },
      { kind: "kimi", modelId: "kimi-k2.6", thinking: "off", purpose: "translate" },
    ]);
    expect(searched).toEqual(["urban heat islands at night", "城市热岛 夜间"]);
    expect(specs.some((spec) => spec.thinking === "answer")).toBe(true);
  });

  test("Tag suggestions go to the provider's tagging model, and Organize too once the User lets it", async () => {
    const { core, calls } = await start();
    await core.saveChatProvider({ kind: "openai", apiKey: "sk-test", modelId: "gpt-6.1-sol" });
    await turnOnAutomaticTagging(core);
    const first = await addText(core, "Report.md", "Quarterly report on sales.");
    await waitForTagging(core, [first.id]);
    expect(calls.filter((each) => each.purpose === "tags")).toEqual([
      { kind: "openai", modelId: "gpt-6-luna", thinking: "off", purpose: "tags" },
    ]);

    await core.createLibraryGroup({ name: "Reports", description: "Reports and reviews" });
    const second = await addText(core, "Review.md", "Annual review.");
    const status = async () =>
      (await core.getLibrary()).assignments.find((each) => each.documentId === second.id)?.status;
    // Automatic covers tagging only: Organize waits for the User's "Use {company}".
    await vi.waitFor(async () => expect(await status()).toBe("waiting"));
    expect(calls.filter((each) => each.purpose === "organize")).toEqual([]);
    const { automatic } = await core.getTaggingModels();
    if (!automatic) throw new Error("Automatic picked nothing.");
    const { settings } = await core.getLibrary();
    await core.saveLibrarySettings({ ...settings, organizeWith: automatic.classifier });
    await vi.waitFor(async () => expect(await status()).toBe("classified"));
    expect(calls.filter((each) => each.purpose === "organize")).toEqual([
      { kind: "openai", modelId: "gpt-6-luna", thinking: "off", purpose: "organize" },
    ]);
  });

  test("a quick-tasks model the User sets does the small calls", async () => {
    const { core, calls } = await start();
    const provider = await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-test",
      modelId: "gpt-6.1-sol",
    });
    await core.updateSettings({
      user: { quickTasksModel: { providerId: provider.id, modelId: "gpt-5.4-nano" } },
    });
    await turnOnAutomaticTagging(core);
    const document = await addText(core, "Report.md", "Quarterly report on sales.");
    await waitForTagging(core, [document.id]);
    expect(calls.map((each) => each.modelId)).toEqual(["gpt-5.4-nano"]);
    expect(await automaticOf(core)).toMatchObject({ name: "GPT-5.4 nano", reason: "quick-model" });
  });

  test("with no quick-tasks model, the model for Answers tags", async () => {
    const { core, calls } = await start();
    await core.saveChatProvider({
      kind: "openai-compatible",
      baseUrl: "https://llm.example.com/v1",
      apiKey: "key",
      modelId: "house-model",
    });
    await turnOnAutomaticTagging(core);
    const document = await addText(core, "Report.md", "Quarterly report on sales.");
    await waitForTagging(core, [document.id]);
    expect(calls.map((each) => each.modelId)).toEqual(["house-model"]);
  });
});

describe("The Answer engine's small calls", () => {
  /** A model that says which it is in every reply, and records what it was asked for. */
  const named = (name: string, asked: string[]) =>
    scriptedModel(() => ({ text: JSON.stringify({ answer: `From ${name}.`, citations: [] }) }), {
      modelId: name,
      generate: ({ system }) => {
        asked.push(`${name}: ${system.startsWith("You turn") ? "rewrite" : "translate"}`);
        return { text: system.startsWith("You turn") ? "query" : "查询" };
      },
    });
  const request = (overrides: Partial<AnswerRequest>): AnswerRequest => ({
    instructions: () => "Answer from the Documents.",
    messages: [
      { role: "user", content: "Tides come twice a day." },
      { role: "assistant", content: "Noted." },
      { role: "user", content: "Why?" },
    ],
    question: "Why?",
    model: named("answers", []),
    documents: {
      documentCount: 1,
      documentLanguages: [{ language: "Chinese", documents: 1 }],
      searchDocuments: async () => ({ text: "No Passages found.", passageCount: 0 }),
      cite: () => "Recorded.",
    },
    tools: [],
    support: "structured-output",
    signal: new AbortController().signal,
    ...overrides,
  });
  const run = async (answer: AnswerRequest) => {
    for await (const event of createAiSdkAnswerEngine().generate(answer)) {
      if (event.type === "failed") throw new Error(event.error.message);
    }
  };

  test("go to the quick-tasks model when there is one", async () => {
    const asked: string[] = [];
    await run(
      request({
        model: named("answers", asked),
        quickModel: async () => named("quick", asked),
      }),
    );
    expect(asked).toEqual(["quick: rewrite", "quick: translate"]);
  });

  test("go to the Answer's model with no quick-tasks model, or when it can't be had", async () => {
    const without: string[] = [];
    await run(request({ model: named("answers", without) }));
    expect(without).toEqual(["answers: rewrite", "answers: translate"]);

    const declined: string[] = [];
    await run(
      request({
        model: named("answers", declined),
        quickModel: async () => {
          throw new Error("The User declined the chat flow to its service.");
        },
      }),
    );
    expect(declined).toEqual(["answers: rewrite", "answers: translate"]);
  });

  test("an empty reply is logged with its model and why it stopped, and the Question is searched as asked", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const searched: string[] = [];
    const thinker = scriptedModel(() => ({ text: "" }), {
      modelId: "thinker",
      generate: () => ({ text: "", cutOff: true }),
    });
    await run(
      request({
        quickModel: async () => thinker,
        documents: {
          documentCount: 1,
          documentLanguages: [{ language: "Chinese", documents: 1 }],
          searchDocuments: async (query) => {
            searched.push(query);
            return { text: "No Passages found.", passageCount: 0 };
          },
          cite: () => "Recorded.",
        },
      }),
    );
    expect(searched).toEqual(["Why?"]);
    const logged = errors.mock.calls.map((each) => String(each[0]));
    errors.mockRestore();
    expect(logged).toEqual([
      expect.stringMatching(
        /search rewrite came back empty from \S+ thinker \(finish reason: length\)/,
      ),
      expect.stringMatching(
        /translation came back empty from \S+ thinker \(finish reason: length\)/,
      ),
    ]);
  });
});

describe("Local mode", () => {
  test("makes the quick-tasks, image and tagging models local or off, with the existing explanation", async () => {
    const { core, calls } = await start();
    const anthropic = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "key",
      modelId: "claude-sonnet-5-5",
    });
    await core.createLibraryGroup({ name: "Scans", description: "Scanned papers" });
    // Chosen by hand: a cloud model, which can't be used in local mode.
    await core.saveLibrarySettings({
      classifier: {
        kind: "chat",
        choice: { providerId: anthropic.id, modelId: "claude-haiku-5-5" },
      },
      automatic: true,
    });
    await core.setLocalOnly(true);
    const [text] = await addAndProcess(core, [
      await writeSourceFile(await createTempDataFolder(), "Notes.md", "Notes on scans."),
    ]);
    if (!text) throw new Error("Not added.");
    await vi.waitFor(async () =>
      expect(
        (await core.getLibrary()).assignments.find((each) => each.documentId === text.id),
      ).toMatchObject({
        status: "waiting",
        error: {
          message: "Cloud tagging paused: “Keep everything on this computer” is on.",
        },
      }),
    );
    // Automatic: no model on this computer, so nothing tags, and no small call leaves it.
    await core.saveLibrarySettings({ classifier: { kind: "automatic" }, automatic: true });
    expect(await automaticOf(core)).toBeNull();
    expect(calls).toEqual([]);
    expect(await core.listConsentRequests()).toEqual([]);
  });
});

describe("The image model reads scans the model that tags can't", () => {
  const SCAN = buildPdf([{ image: true }]);

  test("a scan goes to the image model the User set; in local mode, to none, so it waits", async () => {
    const { core, calls, specs } = await start();
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const anthropic = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "key",
      modelId: "claude-sonnet-5-5",
    });
    const ollama = (await core.listChatProviders()).find((each) => each.kind === "ollama");
    if (!ollama) throw new Error("No Ollama.");
    await core.updateSettings({
      user: {
        chatModel: { providerId: ollama.id, modelId: "local-model" },
        imageModel: { providerId: anthropic.id, modelId: "claude-haiku-5-5" },
      },
    });
    // Organize uses the local model, as "Use Ollama" in the Library sets it.
    await core.saveLibrarySettings({
      classifier: { kind: "automatic" },
      automatic: true,
      organizeWith: { kind: "chat", choice: { providerId: ollama.id, modelId: "local-model" } },
    });
    await core.allowDataFlow("classification", ANTHROPIC);
    await core.allowDataFlow("scan-images", ANTHROPIC);
    await core.createLibraryGroup({ name: "Scans", description: "Scanned papers" });
    const [scan] = await addAndProcess(core, [
      await writeSourceFile(await createTempDataFolder(), "scan.pdf", SCAN),
    ]);
    if (!scan) throw new Error("Not added.");
    await vi.waitFor(
      async () =>
        expect(
          (await core.getLibrary()).assignments.find((each) => each.documentId === scan.id),
        ).toMatchObject({ status: "classified", model: { id: "claude-haiku-5-5", images: true } }),
      { timeout: 15_000 },
    );
    expect(calls.filter((each) => each.purpose === "organize").map((each) => each.modelId)).toEqual(
      ["claude-haiku-5-5"],
    );
    expect(specs.some((spec) => spec.modelId === "local-model")).toBe(true);

    await core.setLocalOnly(true);
    const [second] = await addAndProcess(core, [
      await writeSourceFile(
        await createTempDataFolder(),
        "scan2.pdf",
        buildPdf([{ image: true }, { image: true }]),
      ),
    ]);
    if (!second) throw new Error("Not added.");
    await core.classifyDocuments([second.id]);
    expect(
      (await core.getLibrary()).assignments.find((each) => each.documentId === second.id)?.status,
    ).toBe("waiting");
    expect(calls.filter((each) => each.purpose === "organize")).toHaveLength(1);
  });
});

describe("Until Organize has a model", () => {
  test("with Folders, automatic tagging tags their Documents and Organize leaves them tagged", async () => {
    const { core, calls } = await start();
    const contracts = await core.createLibraryGroup({
      name: "Contracts",
      description: "Signed contracts",
    });
    await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-sonnet-5-5",
    });
    await turnOnAutomaticTagging(core);
    const { documents } = await core.addDocuments(
      [
        await writeSourceFile(
          await createTempDataFolder(),
          "Supply.md",
          "The supply contract with Brazos Steel.",
        ),
      ],
      { groupId: contracts.id },
    );
    const loose = await addText(core, "Notes.md", "Notes from the first meeting.");
    const ids = [documents[0]?.id ?? "", loose.id];
    await waitForTagging(core, ids);
    await vi.waitFor(async () => {
      const { assignments } = await core.getLibrary();
      for (const id of ids) {
        expect(assignments.find((each) => each.documentId === id)?.status).toBe("waiting");
      }
    });
    const tagged = (await core.listDocuments()).filter((each) => ids.includes(each.id));
    expect(tagged.map((each) => each.tagging)).toEqual(["tagged", "tagged"]);
    expect(calls.filter((call) => call.purpose === "organize")).toEqual([]);
  });
});

describe("Moving to one Tagging setting", () => {
  test("a classifier chosen before is kept; a Library that chose none, or Organize manually, gets Automatic", async () => {
    const dataDir = await createTempDataFolder();
    const before = startCore(dataDir);
    const kept = {
      classifier: {
        kind: "ollama" as const,
        baseUrl: "http://127.0.0.1:11434",
        modelId: "tev1:0.8b",
      },
      automatic: false,
    };
    await before.saveLibrarySettings(kept);
    before.close();
    const after = startCore(dataDir);
    expect((await after.getLibrary()).settings).toEqual({
      ...kept,
      organizeWith: null,
      taggingStopped: [],
    });
    after.close();

    // As the version before stored "Organize manually".
    queryDatabase(
      dataDir,
      "UPDATE device_settings SET value = ? WHERE key = 'library' AND deleted_at IS NULL RETURNING key",
      [JSON.stringify({ classifier: null, automatic: true })],
    );
    const upgraded = startCore(dataDir);
    expect((await upgraded.getLibrary()).settings).toEqual({
      classifier: { kind: "automatic" },
      automatic: true,
      organizeWith: null,
      taggingStopped: [],
    });
  });

  test("null still saves as Automatic, for a caller that knew Organize manually", async () => {
    const { core } = await start();
    await core.saveLibrarySettings({ classifier: null, automatic: false });
    expect((await core.getLibrary()).settings).toEqual({
      classifier: { kind: "automatic" },
      automatic: false,
      organizeWith: null,
      taggingStopped: [],
    });
  });
});
