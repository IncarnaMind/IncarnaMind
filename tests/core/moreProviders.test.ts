/**
 * The providers of #178 (DeepSeek, Qwen, Kimi, GLM, SiliconFlow, Mistral, xAI and
 * OpenRouter), each added with a key, listed, and asked a Question with a
 * Citation, through the real AI SDK providers against a fake endpoint: what the
 * tests check is what each package puts on the wire. A live smoke test per
 * provider is tests/live/providers.live.test.ts.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatProviderKind } from "../../src/core/api";
import { catalogModel } from "../../src/core/providers/catalog";
import { catalogProvider, endpointOf } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { askAndFinish, citationsIn, setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, startCore, turnOnAutomaticTagging } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { fakeProvider, type Loose, type RecordedRequest } from "../helpers/fakeProvider";
import { replyingModel, scriptedModels } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";
import { taggingModel, waitForTagging } from "../helpers/tags";

afterEach(() => vi.unstubAllGlobals());

const TIDES = buildPdf([
  {
    lines: [
      "Spring and neap tides",
      "Spring tides happen at new moon and at full moon.",
      "Neap tides happen when the Moon is at its first or last quarter.",
    ],
  },
]);
const SPRING = "Spring tides happen at new moon and at full moon.";

interface Case {
  kind: ChatProviderKind;
  /** The endpoint to add it on; its first when left out. */
  endpoint?: string;
  protocol: "chat" | "responses";
  /** The path of the chat endpoint under the base URL. */
  chatPath: string;
  /** The path (and query) of the model list. */
  listPath: string;
  /** Whether the request asks for streamed usage. */
  streamsUsage: boolean;
  /** The provider sends usage on the last chunk, not in one of its own. */
  usageOnLastChunk?: boolean;
  /** What else every request to it carries. */
  carries?(body: Loose): void;
}

const CASES: Case[] = [
  {
    kind: "deepseek",
    protocol: "chat",
    chatPath: "/chat/completions",
    listPath: "/models",
    streamsUsage: true,
  },
  {
    kind: "qwen",
    protocol: "chat",
    chatPath: "/chat/completions",
    listPath: "/models",
    streamsUsage: true,
  },
  {
    kind: "qwen",
    endpoint: "intl",
    protocol: "chat",
    chatPath: "/chat/completions",
    listPath: "/models",
    streamsUsage: true,
  },
  {
    kind: "kimi",
    protocol: "chat",
    chatPath: "/chat/completions",
    listPath: "/models",
    streamsUsage: true,
  },
  {
    kind: "kimi",
    endpoint: "intl",
    protocol: "chat",
    chatPath: "/chat/completions",
    listPath: "/models",
    streamsUsage: true,
  },
  {
    kind: "glm",
    protocol: "chat",
    chatPath: "/chat/completions",
    listPath: "/models",
    streamsUsage: false,
  },
  {
    kind: "glm",
    endpoint: "intl",
    protocol: "chat",
    chatPath: "/chat/completions",
    listPath: "/models",
    streamsUsage: false,
  },
  {
    kind: "siliconflow",
    protocol: "chat",
    chatPath: "/chat/completions",
    listPath: "/models?type=text&sub_type=chat",
    streamsUsage: true,
  },
  {
    kind: "siliconflow",
    endpoint: "intl",
    protocol: "chat",
    chatPath: "/chat/completions",
    listPath: "/models?type=text&sub_type=chat",
    streamsUsage: true,
  },
  {
    kind: "mistral",
    usageOnLastChunk: true,
    protocol: "chat",
    chatPath: "/chat/completions",
    listPath: "/models",
    streamsUsage: false,
  },
  {
    kind: "xai",
    protocol: "responses",
    chatPath: "/responses",
    listPath: "/models",
    streamsUsage: false,
    carries: (body) => expect(body.store).toBe(false),
  },
  {
    kind: "openrouter",
    protocol: "chat",
    chatPath: "/chat/completions",
    listPath: "/models",
    streamsUsage: true,
    carries: (body) =>
      expect(body.provider).toMatchObject({ data_collection: "deny", require_parameters: true }),
  },
];

const label = (each: Case) => `${each.kind}${each.endpoint ? ` (${each.endpoint})` : ""}`;

/** The catalog's provider and endpoint for a case. */
function where(each: Case) {
  const provider = catalogProvider(each.kind);
  if (!provider) throw new Error(`The catalog has no ${each.kind}.`);
  const endpoint = endpointOf(provider, each.endpoint);
  if (!endpoint) throw new Error(`${each.kind} has no endpoint.`);
  const url = new URL(endpoint.baseUrl);
  return { provider, endpoint, url, base: endpoint.baseUrl };
}

/** What each provider's model list says: its Answers model, a quick-tasks one, and something that isn't a chat model. */
function modelList(each: Case) {
  const { provider } = where(each);
  const chat = [provider.roles.answers, provider.roles.quickTasks].filter(
    (id): id is string => id !== undefined,
  );
  if (each.kind === "mistral") {
    return {
      data: [
        ...chat.map((id) => ({
          id,
          capabilities: { completion_chat: true, function_calling: true, vision: true },
          max_context_length: 262144,
        })),
        { id: "mistral-embed", capabilities: { completion_chat: false } },
      ],
    };
  }
  if (each.kind === "openrouter") {
    return {
      data: chat.map((id) => ({
        id,
        context_length: 1_000_000,
        architecture: { input_modalities: ["text", "image"] },
        supported_parameters: ["tools", "temperature"],
      })),
    };
  }
  return { data: chat.map((id) => ({ id })) };
}

const plan = (requests: RecordedRequest[]) => requests.filter((each) => each.method === "POST");

describe.each(CASES)("$kind on its fake endpoint", (each) => {
  test(`${label(each)}: add a key, list the models, and ask a Question with a Citation`, async () => {
    const { provider, endpoint, url, base } = where(each);
    const modelId = provider.roles.answers as string;
    const { core, client, mind } = await setUpWithDocuments(
      replyingModel(),
      [{ name: "Tides.pdf", contents: TIDES }],
      { createChatModel: createAiSdkChatModel },
    );

    // Adding it: one provider, on this endpoint, with a key kept for it.
    const saved = await core.saveChatProvider({
      kind: each.kind,
      ...(each.endpoint && { endpoint: each.endpoint }),
      apiKey: "key-for-the-test",
      modelId,
    });
    expect(saved).toMatchObject({
      kind: each.kind,
      catalogId: each.kind,
      endpoint: endpoint.id,
      baseUrl: null,
      hasApiKey: true,
      service: { id: url.origin, name: provider.name.en },
    });
    expect(await core.getChatReadiness()).toMatchObject({ ready: true, modelId });
    await core.allowDataFlow("chat", url.origin);

    const requests = fakeProvider(url.host, {
      protocol: each.protocol,
      ...(each.usageOnLastChunk && { usageOnLastChunk: true }),
      models: modelList(each),
      query: "spring tides",
      records: (passages) => [
        { marker: 1, passage: passages[0]?.id, pageFrom: 1, pageTo: 1, quote: SPRING },
      ],
      answer: "Spring tides come at new and full moon [^1].",
    });

    // Listing models: the chat models, not the others, asked with the key.
    const groups = await core.listChatModels();
    const group = groups.find((each) => each.provider.id === saved.id);
    expect(group?.models).toContain(modelId);
    expect(group?.models).not.toContain("mistral-embed");
    const listing = requests.find((request) => request.method === "GET");
    expect(listing?.url).toBe(`${base}${each.listPath}`);
    expect(listing?.headers.authorization).toBe("Bearer key-for-the-test");

    // An Answer with a Citation, found in the Document.
    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");
    const citations = citationsIn(client, answerId);
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ pageFrom: 1, check: "found" });

    // Every request went to the provider's own endpoint with the key, as the provider takes it.
    const posts = plan(requests);
    expect(posts.length).toBeGreaterThanOrEqual(3);
    for (const request of posts) {
      expect(request.url).toBe(`${base}${each.chatPath}`);
      expect(request.headers.authorization).toBe("Bearer key-for-the-test");
      expect(request.body.model).toBe(modelId);
      each.carries?.(request.body);
      if (each.streamsUsage)
        expect(request.body.stream_options).toMatchObject({ include_usage: true });
    }
  });
});

describe("Regions", () => {
  test("Qwen's regions are separate providers, each with its own key, models and endpoint", async () => {
    const { core } = await setUpWithDocuments(replyingModel(), [], {
      createChatModel: createAiSdkChatModel,
    });
    const beijing = await core.saveChatProvider({
      kind: "qwen",
      apiKey: "key-beijing",
      modelId: "qwen3.7-plus",
    });
    const singapore = await core.saveChatProvider({
      kind: "qwen",
      endpoint: "intl",
      apiKey: "key-singapore",
      modelId: "qwen3.7-plus",
    });

    expect(beijing).toMatchObject({
      endpoint: "cn",
      service: { id: "https://dashscope.aliyuncs.com", name: "Qwen (Alibaba Cloud Model Studio)" },
    });
    expect(singapore.id).not.toBe(beijing.id);
    expect(singapore).toMatchObject({
      endpoint: "intl",
      hasApiKey: true,
      service: { id: "https://dashscope-intl.aliyuncs.com" },
    });
    expect(await core.listChatProviders()).toHaveLength(3);

    // Saving a region again finds its row and keeps its key.
    const again = await core.saveChatProvider({
      kind: "qwen",
      endpoint: "intl",
      modelId: "qwen3.8-max",
    });
    expect(again.id).toBe(singapore.id);
    expect(await core.listChatProviders()).toHaveLength(3);

    // Each region's models are asked of its own host with its own key.
    await core.allowDataFlow("chat", "https://dashscope.aliyuncs.com");
    await core.allowDataFlow("chat", "https://dashscope-intl.aliyuncs.com");
    const seen: { url: string; authorization: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        seen.push({ url, authorization: new Headers(init?.headers).get("authorization") });
        return Response.json({ data: [{ id: "qwen3.7-plus" }] });
      }),
    );
    await core.listChatModels();
    expect(seen).toEqual(
      expect.arrayContaining([
        {
          url: "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
          authorization: "Bearer key-beijing",
        },
        {
          url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
          authorization: "Bearer key-singapore",
        },
      ]),
    );
  });

  test("a region the provider doesn't have is refused, as is a region for a provider without any", async () => {
    const { core } = await setUpWithDocuments(replyingModel(), [], {
      createChatModel: createAiSdkChatModel,
    });
    await expect(
      core.saveChatProvider({
        kind: "qwen",
        endpoint: "mars",
        apiKey: "k",
        modelId: "qwen3.7-plus",
      }),
    ).rejects.toThrow(/no endpoint "mars"/);
    await expect(
      core.saveChatProvider({
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:1/v1",
        endpoint: "cn",
        modelId: "local",
      }),
    ).rejects.toThrow(/no endpoints to choose/);
  });

  test("a key is needed for a region, and another region's key is not used", async () => {
    const { core } = await setUpWithDocuments(replyingModel(), [], {
      createChatModel: createAiSdkChatModel,
    });
    await core.saveChatProvider({ kind: "kimi", apiKey: "key-cn", modelId: "kimi-k2.6" });
    await expect(
      core.saveChatProvider({ kind: "kimi", endpoint: "intl", modelId: "kimi-k2.6" }),
    ).rejects.toThrow(/Enter an API key/);
  });

  test("each region has the model facts of its own site: Qwen in yuan in Beijing and dollars in Singapore", () => {
    const beijing = catalogModel("qwen", "qwen3.7-plus");
    expect(beijing?.price).toMatchObject({ currency: "CNY", input: 2, output: 8 });
    const singapore = catalogModel("qwen/intl", "qwen3.7-plus");
    expect(singapore?.price).toMatchObject({ currency: "USD", input: 0.4, output: 1.6 });
  });
});

describe("Small calls skip thinking", () => {
  test("automatic tagging builds its model with thinking off; an Answer's model asks for a reasoning summary instead", async () => {
    const tagging = taggingModel(["Paper"]);
    const models = scriptedModels(tagging.model);
    const core = startCore(await createTempDataFolder(), {
      createChatModel: models.createChatModel,
    });
    await core.saveChatProvider({ kind: "deepseek", apiKey: "key", modelId: "deepseek-flash" });
    await turnOnAutomaticTagging(core);
    await core.allowDataFlow("chat", "https://api.deepseek.com");

    const sources = await createTempDataFolder();
    const [document] = await addAndProcess(core, [
      await writeSourceFile(sources, "Attention.md", "Attention Is All You Need\n\nA paper."),
    ]);
    await waitForTagging(core, [document?.id ?? ""]);
    expect(models.specs.at(-1)).toMatchObject({ kind: "deepseek", thinking: "off" });

    await core.prepareChatModel();
    expect(models.specs.at(-1)).toMatchObject({ kind: "deepseek", thinking: "summary" });
  });

  const spec = (kind: ChatProviderKind, modelId: string, thinking?: "off") => ({
    kind,
    baseUrl: null,
    apiKey: "key",
    modelId,
    ...(thinking && { thinking }),
  });

  const bodyOf = async (kind: ChatProviderKind, modelId: string, thinking?: "off") => {
    const { provider, url } = where({
      kind,
      protocol: "chat",
      chatPath: "",
      listPath: "",
      streamsUsage: false,
    });
    const requests = fakeProvider(url.host, {
      protocol: kind === "xai" || kind === "openai" ? "responses" : "chat",
      models: { data: [] },
      query: "",
      records: () => [],
      answer: "",
    });
    const { generateText } = await import("ai");
    await generateText({
      model: createAiSdkChatModel(spec(kind, modelId, thinking)),
      prompt: "Hi",
      maxRetries: 0,
    });
    expect(provider.id).toBe(kind);
    return requests[0]?.body ?? {};
  };

  test.each([
    ["deepseek", "deepseek-flash", "thinking", { type: "disabled" }],
    ["qwen", "qwen3.8-flash", "enable_thinking", false],
    ["kimi", "kimi-k2.6", "thinking", { type: "disabled" }],
    ["glm", "glm-4.7-flash", "thinking", { type: "disabled" }],
    ["siliconflow", "Qwen/Qwen3-8B", "enable_thinking", false],
    ["openrouter", "openai/gpt-6-luna", "reasoning", { effort: "none" }],
    ["openrouter", "anthropic/claude-haiku-5.5", "reasoning", { effort: "none" }],
    ["xai", "grok-4.3", "reasoning", { effort: "none" }],
    // On the Organize evaluation, GPT-6 Luna tagged as well with reasoning off.
    ["openai", "gpt-6-luna", "reasoning", { effort: "none" }],
    ["openai", "gpt-5.4-nano", "reasoning", { effort: "none" }],
    ["mistral", "mistral-small-2603", "reasoning_effort", "none"],
  ] as const)("%s (%s) asks for no thinking", async (kind, modelId, field, value) => {
    expect((await bodyOf(kind, modelId, "off"))[field]).toEqual(value);
    afterEachStub();
    expect((await bodyOf(kind, modelId))[field]).not.toEqual(value);
  });

  test("GLM-5.3 can't turn thinking off, so it is not asked to", async () => {
    expect((await bodyOf("glm", "glm-5.3-flash", "off")).thinking).toBeUndefined();
  });

  // protects=mandatory reasoning uses the catalog's lowest accepted effort; fails_when=Sonnet is sent none; no_claim=reasoning quality.
  test("OpenRouter's mandatory-reasoning model uses its catalog effort for a small call", async () => {
    expect(await bodyOf("openrouter", "anthropic/claude-sonnet-5.5", "off")).toMatchObject({
      reasoning: { effort: "low" },
      provider: { data_collection: "deny", require_parameters: true },
    });
  });

  test.each(["gpt-6.1-sol", "gpt-6-astra", "gpt-5", "gpt-5-nano", "gpt-5-2025-08-07"])(
    "OpenAI's %s refuses reasoning effort none, so it is not asked to",
    async (modelId) => {
      expect((await bodyOf("openai", modelId, "off")).reasoning).toBeUndefined();
    },
  );

  test("OpenAI keeps storing nothing with reasoning off", async () => {
    expect(await bodyOf("openai", "gpt-6-luna", "off")).toMatchObject({
      store: false,
      reasoning: { effort: "none" },
    });
  });
});

function afterEachStub() {
  vi.unstubAllGlobals();
}
