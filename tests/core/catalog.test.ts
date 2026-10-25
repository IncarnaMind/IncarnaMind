import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { RECOMMENDED_OLLAMA_MODEL } from "../../src/core";
import { type ChatProviderKind, chatProviderKinds } from "../../src/core/api";
import { automaticTagging } from "../../src/core/library/tagging";
import {
  calculates,
  cloudWindow,
  givesStructuredOutput,
  readsImages,
  resolveCapabilities,
  startingSupport,
} from "../../src/core/providers/capabilities";
import {
  CATALOG_PROVIDERS,
  catalogFacts,
  catalogModel,
  catalogModels,
  catalogRoleModel,
  type EndpointField,
  isNonChatModel,
  LOCAL_MODEL_TIERS,
  LOCAL_MODELS,
  modelsProviderOfKind,
  providersWithModels,
  recommendedLocalModels,
} from "../../src/core/providers/catalog";
import { OVERRIDES } from "../../src/core/providers/catalog/overrides";
import { PRESETS } from "../../src/core/providers/catalog/presets";
import {
  catalogProvider,
  dataUseOf,
  fieldAccepts,
  fieldUrl,
  isPreset,
  KEY_PROVIDERS,
  keyProviderGroups,
  kindOfCatalogId,
  LOCAL_PRESETS,
  untestedForCitations,
} from "../../src/core/providers/catalog/providers";
import { KNOWN_PLAN_MODELS } from "../../src/core/providers/chatgpt/planEndpoint";
import {
  baseUrlFor,
  endpointUrl,
  isLoopbackHost,
  requiresApiKey,
  serviceFor,
} from "../../src/core/providers/kinds";
import { OLLAMA_CLOUD } from "../../src/core/providers/ollamaCloud";
import { en } from "../../src/shared/i18n/en";
import { zhCN } from "../../src/shared/i18n/zh-CN";

const GIB = 1024 ** 3;

const sampleFieldValue = (field: EndpointField): string =>
  field.choices?.[0]?.value ??
  field.default ??
  (field.name === "account" ? "0123456789abcdef0123456789abcdef" : "");
const REPO_ROOT = resolve(__dirname, "../..");

/** What the catalog alone says of a model on a provider kind. */
const fromCatalog = (kind: ChatProviderKind, modelId: string) =>
  resolveCapabilities({ catalog: catalogFacts(modelsProviderOfKind(kind), modelId) });

describe("The provider catalog", () => {
  test("every provider has both names, a default for each role it offers, and a data-use line", () => {
    expect(CATALOG_PROVIDERS.map((provider) => provider.id)).toEqual([
      "anthropic",
      "openai",
      "google",
      "openrouter",
      "mistral",
      "xai",
      "deepseek",
      "qwen",
      "kimi",
      "glm",
      "siliconflow",
      "ollama",
      "groq",
      "together",
      "fireworks",
      "cerebras",
      "cohere",
      "venice",
      "bedrock",
      "cloudflare",
      "lmstudio",
      "unsloth",
      "openai-compatible",
    ]);
    for (const provider of CATALOG_PROVIDERS) {
      const where = provider.id;
      expect(provider.name.en.trim(), where).not.toBe("");
      expect(provider.name.zh.trim(), where).not.toBe("");
      expect(provider.dataUse.summary.en.trim(), where).not.toBe("");
      expect(provider.dataUse.summary.zh.trim(), where).not.toBe("");
      expect(["no", "opt-out", "free-tier", "unknown"], where).toContain(provider.dataUse.training);
      expect(provider.checked, where).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const note of provider.notes ?? []) {
        expect(note.en.trim() && note.zh.trim(), where).not.toBe("");
      }
      // A hosted provider has its API; a server the User gives has a URL rule instead.
      if (provider.endpoints.length > 0) {
        for (const endpoint of provider.endpoints) {
          const value = endpoint.field ? sampleFieldValue(endpoint.field) : "";
          expect(new URL(fieldUrl(endpoint, value)).protocol, where).toBe(
            provider.group === "local" ? "http:" : "https:",
          );
          expect(endpoint.label.en && endpoint.label.zh, where).toBeTruthy();
          if (endpoint.field) {
            expect(endpoint.baseUrl, where).toContain(`{${endpoint.field.name}}`);
            expect(fieldAccepts(endpoint.field, value), where).toBe(true);
            expect(fieldAccepts(endpoint.field, "elsewhere.example.com/x"), where).toBe(false);
          }
        }
      } else {
        expect(provider.serverUrl, where).toBeDefined();
      }
      // Each role names a model the catalog knows: a cloud model, or one recommended for Ollama.
      for (const [role, modelId] of Object.entries(provider.roles)) {
        const known =
          provider.id === "ollama"
            ? LOCAL_MODELS.some((model) => model.tag === modelId)
            : catalogModel(provider.id, modelId) !== undefined;
        expect(known, `${where} ${role}: ${modelId}`).toBe(true);
      }
    }
  });

  test("a hosted provider offers every role: a capable, cheaper Answers model, its strongest one click away, a cheap quick-tasks model and one that reads images", () => {
    for (const provider of CATALOG_PROVIDERS.filter(
      (each) => each.endpoints.length > 0 && !isPreset(each),
    )) {
      const { answers, strongest, quickTasks, images } = provider.roles;
      const model = (id: string | undefined) => {
        const found = id ? catalogModel(provider.id, id) : undefined;
        if (!found) throw new Error(`${provider.id} has no model ${id}.`);
        return found;
      };
      expect(model(answers).tools, provider.id).toBe(true);
      expect(model(images).input, provider.id).toContain("image");
      // The Answers model costs less than the strongest, and a quick-tasks model no more than it
      // (where the strongest's price is known: SiliconFlow's yuan price for it is not listed).
      const output = (id: string | undefined) => model(id).price?.output;
      expect(output(answers), provider.id).toBeDefined();
      if (output(strongest) !== undefined) {
        expect(output(answers) ?? Number.NaN, provider.id).toBeLessThan(output(strongest) ?? 0);
      }
      expect(output(quickTasks) ?? Number.NaN, provider.id).toBeLessThanOrEqual(
        output(answers) ?? Number.NaN,
      );
      // Prices in the provider's own currency: yuan on a Chinese endpoint of a provider that bills in it.
      const yuan = provider.id === "deepseek" || provider.endpoints[0]?.id === "cn";
      expect(model(answers).price?.currency, provider.id).toBe(yuan ? "CNY" : "USD");
    }
  });

  test("Claude Haiku 5.5 and GPT-6 Luna answer by default, the strongest models stay in the menu, and the ChatGPT plan keeps its best model first", () => {
    expect(catalogProvider("anthropic")?.roles).toMatchObject({
      answers: "claude-haiku-5-5",
      strongest: "claude-fable-5-1",
    });
    expect(catalogProvider("openai")?.roles).toMatchObject({
      answers: "gpt-6-luna",
      strongest: "gpt-6-astra",
    });
    expect(KNOWN_PLAN_MODELS[0]?.id).toBe("gpt-6.1-sol");
  });

  test("the generated facts cover the hosted providers, with unique ids, and their sources' licences ship with the app", async () => {
    expect(providersWithModels().sort()).toEqual([
      "anthropic",
      "bedrock",
      "cerebras",
      "cloudflare",
      "cohere",
      "deepseek",
      "fireworks",
      "glm",
      "glm/intl",
      "google",
      "groq",
      "kimi",
      "kimi/intl",
      "mistral",
      "openai",
      "openrouter",
      "qwen",
      "qwen/intl",
      "siliconflow",
      "siliconflow/intl",
      "together",
      "venice",
      "xai",
    ]);
    for (const providerId of providersWithModels()) {
      const ids = catalogModels(providerId).map((model) => model.id);
      expect(new Set(ids).size, providerId).toBe(ids.length);
      for (const model of catalogModels(providerId)) {
        expect(model.context, model.id).toBeGreaterThan(0);
        expect(model.input, model.id).toContain("text");
        // A chat model is never also listed as something else.
        expect(isNonChatModel(providerId, model.id), model.id).toBe(false);
      }
    }
    const notice = await readFile(join(REPO_ROOT, "resources/notices/model-catalog.txt"), "utf8");
    expect(notice).toContain("Copyright (c) 2025 models.dev");
    expect(notice).toContain("Copyright (c) 2023 Berri AI");
    expect(notice.match(/Permission is hereby granted/g)).toHaveLength(2);
    const builder = await readFile(join(REPO_ROOT, "electron-builder.yml"), "utf8");
    expect(builder).toMatch(/- from: resources\/notices\n\s+to: notices\n/);
  });

  test("every hand-written correction names a model the generated facts have", () => {
    for (const providerId of Object.keys(OVERRIDES.providers)) {
      expect(providersWithModels()).toContain(providerId);
    }
    for (const [providerId, models] of Object.entries(OVERRIDES.models)) {
      for (const modelId of Object.keys(models)) {
        expect(catalogModel(providerId, modelId)?.id, `${providerId}/${modelId}`).toBe(modelId);
      }
    }
    // Corrections apply: Claude Sonnet 5.5 refuses a forced Tool choice, and Gemini runs at its default.
    expect(catalogModel("anthropic", "claude-sonnet-5-5")?.forcedToolChoice).toBe(false);
    expect(catalogModel("google", "gemini-2.5-flash")?.temperature).toBe(false);
    expect(catalogModel("google", "gemini-3.8-flash")?.price?.note?.en).toContain("2027-01-01");
  });

  test("a model is found by its id, or a dated snapshot by the id without its date; nothing else is guessed from a name", () => {
    expect(catalogModel("openai", "gpt-6.1-sol")?.name).toBe("GPT-6.1 Sol");
    expect(catalogModel("openai", "gpt-5-2025-08-07")?.id).toBe("gpt-5");
    expect(catalogModel("anthropic", "claude-haiku-4-5-20251001")?.id).toBe(
      "claude-haiku-4-5-20251001",
    );
    expect(catalogModel("anthropic", "claude-sonnet-4-6-20991231")?.id).toBe("claude-sonnet-4-6");
    expect(catalogModel("openai", "gpt-6.1-sol-mini")).toBeUndefined();
    expect(catalogModel("openai", "openai/gpt-6.1-sol")).toBeUndefined();
    expect(catalogModel("google", "models/gemini-3.8-flash")).toBeUndefined();
    // Ids its sources know as something else than a chat model.
    expect(isNonChatModel("openai", "text-embedding-3-small")).toBe(true);
    expect(isNonChatModel("openai", "whisper-1")).toBe(true);
    expect(isNonChatModel("google", "gemini-embedding-001")).toBe(true);
    expect(isNonChatModel("openai", "gpt-7-preview")).toBe(false);
  });

  test.each<[ChatProviderKind, string, boolean]>([
    ["anthropic", "claude-haiku-5-5", true],
    ["anthropic", "claude-sonnet-5-5", true],
    ["openai", "gpt-6-luna", true],
    ["chatgpt", "gpt-6-sol", true],
    ["openrouter", "openai/gpt-6-luna", false],
    ["google", "gemini-3.8-flash", false],
    ["deepseek", "deepseek-flash", false],
    ["qwen", "qwen3.8-flash", false],
    ["siliconflow", "deepseek-ai/DeepSeek-V4", false],
    ["ollama", "gpt-oss:20b-cloud", false],
    ["ollama", "qwen3.5:4b", false],
  ])("%s %s is offered calculate by the catalog: %s", (kind, modelId, offered) => {
    // Only models measured to use it well (#438); the evaluation (#441) turns on more.
    expect(calculates(fromCatalog(kind, modelId))).toBe(offered);
  });

  test.each<[ChatProviderKind, string, boolean]>([
    ["anthropic", "claude-sonnet-5-5", true],
    ["anthropic", "claude-haiku-4-5-20251001", true],
    ["anthropic", "claude-2.1", false],
    ["openai", "gpt-5.5", true],
    ["openai", "gpt-4o-mini", true],
    ["openai", "o4-mini", true],
    ["openai", "o3-mini", false],
    ["openai", "gpt-3.5-turbo", false],
    ["openai", "gpt-7-preview", false],
    ["chatgpt", "gpt-6-sol", true],
    ["google", "gemini-3.8-flash", true],
    ["google", "gemini-pro-latest", false],
    ["openai-compatible", "qwen-vl-max", false],
    ["ollama", "llava", false],
  ])("%s %s reads images by the catalog: %s", (kind, modelId, reads) => {
    expect(readsImages(fromCatalog(kind, modelId))).toBe(reads);
  });

  test("models recommended for Ollama follow this computer's memory", () => {
    const tags = (gb: number) => recommendedLocalModels(gb * GIB).map((model) => model.tag);
    expect(tags(4)).toEqual(["qwen3.5:4b", "qwen3.5:2b"]);
    expect(tags(8)).toEqual(["qwen3.5:4b", "qwen3.5:2b"]);
    expect(tags(16)).toEqual(["qwen3.5:4b", "qwen3.5:9b", "gemma4:12b"]);
    expect(tags(15.6)).toEqual(tags(16));
    expect(tags(32)[0]).toBe("qwen3.5:9b");
    expect(tags(64)[0]).toBe("qwen3.6:35b-a3b");
    expect(tags(128)).toEqual(tags(64));
    for (const tier of LOCAL_MODEL_TIERS) {
      for (const tag of tier.models) {
        expect(
          LOCAL_MODELS.some((model) => model.tag === tag),
          tag,
        ).toBe(true);
      }
    }
    // Only a model the evaluation measured counts as tested; the one-click model is one.
    expect(LOCAL_MODELS.filter((model) => model.evaluated).map((model) => model.tag)).toEqual([
      RECOMMENDED_OLLAMA_MODEL,
    ]);
  });
});

describe("What is known of a model", () => {
  test("the User's word wins over the server's, the server's over the catalog's, and what none says is unknown", () => {
    const known = resolveCapabilities({
      user: { input: ["text", "image"] },
      server: { context: 32_768, tools: false, input: ["text"] },
      catalog: {
        context: 128_000,
        tools: true,
        temperature: false,
        structuredOutput: "json_schema",
      },
    });
    expect(known.known).toBe(true);
    expect(known.facts).toEqual({
      input: ["text", "image"],
      context: 32_768,
      tools: false,
      temperature: false,
      structuredOutput: "json_schema",
    });
    expect(readsImages(known)).toBe(true);
    expect(startingSupport(known)).toBe("structured-output");

    // A source leaving a fact out doesn't hide the next one's.
    expect(
      resolveCapabilities({ server: { tools: undefined }, catalog: { tools: true } }).facts.tools,
    ).toBe(true);
  });

  test("a model nothing says anything about keeps today's behaviour: Tools first, a temperature, no images, no window", () => {
    const unknown = resolveCapabilities({});
    expect(unknown.known).toBe(false);
    expect(readsImages(unknown)).toBe(false);
    expect(startingSupport(unknown)).toBeUndefined();
    expect(givesStructuredOutput(unknown)).toBeUndefined();
    expect(cloudWindow(unknown)).toBeUndefined();
    expect(unknown.facts.temperature).toBeUndefined();
  });

  test("how a model cites starts from what it can do, and a measured or server-decided way wins", () => {
    const support = (facts: Parameters<typeof resolveCapabilities>[0]["catalog"]) =>
      startingSupport(resolveCapabilities({ catalog: facts }));
    expect(support({ tools: true })).toBe("tools");
    expect(support({ tools: false, structuredOutput: "json_object" })).toBe("structured-output");
    expect(support({ tools: false })).toBe("structured-output");
    expect(support({ tools: false, structuredOutput: "none" })).toBe("none");
    expect(support({ tools: true, citing: "structured-output" })).toBe("structured-output");
  });

  test("a cloud model's window is its context, less its input limit or the room for its longest reply", () => {
    const window = (facts: Parameters<typeof resolveCapabilities>[0]["catalog"]) =>
      cloudWindow(resolveCapabilities({ catalog: facts }));
    expect(window({ context: 1_050_000, maxInput: 922_000, maxOutput: 128_000 })).toEqual({
      tokens: 1_050_000,
      outputTokens: 128_000,
    });
    expect(window({ context: 1_000_000, maxOutput: 128_000 })).toEqual({
      tokens: 1_000_000,
      outputTokens: 128_000,
    });
    // The reply never takes more than half the window.
    expect(window({ context: 8_192, maxOutput: 8_192 })).toEqual({
      tokens: 8_192,
      outputTokens: 4_096,
    });
    expect(window({ maxOutput: 8_192 })).toBeUndefined();
  });
});

describe("The providers of #178", () => {
  const added = ["openrouter", "mistral", "xai", "deepseek", "qwen", "kimi", "glm", "siliconflow"];

  test("each is a chat provider kind with its own catalog entry, names in both languages, and a key link", () => {
    for (const id of added) {
      const provider = catalogProvider(id);
      expect(provider, id).toBeDefined();
      expect(chatProviderKinds as readonly string[], id).toContain(id);
      expect(provider?.apiKey, id).toBe("required");
      expect(provider?.keyUrl, id).toMatch(/^https:\/\//);
      for (const endpoint of provider?.endpoints ?? []) {
        expect(endpoint.keyUrl ?? provider?.keyUrl, `${id} ${endpoint.id}`).toMatch(/^https:/);
      }
      // The names the page shows are the catalog's, in both languages.
      expect(en[`providers.kind.${id as ChatProviderKind}`], id).toBe(provider?.name.en);
      expect(zhCN[`providers.kind.${id as ChatProviderKind}`], id).toBe(provider?.name.zh);
    }
  });

  test("each says whether it may train on API data: Mistral and Kimi may, with an opt-out; DeepSeek's, Z.ai's and SiliconFlow's terms don't say", () => {
    const training = Object.fromEntries(
      added.map((id) => [id, catalogProvider(id)?.dataUse.training]),
    );
    expect(training).toEqual({
      openrouter: "no",
      mistral: "opt-out",
      xai: "no",
      deepseek: "unknown",
      qwen: "no",
      kimi: "opt-out",
      glm: "unknown",
      siliconflow: "unknown",
    });
    expect(catalogProvider("kimi")?.dataUse.url).toBe(
      "https://platform.kimi.ai/docs/agreement/modeluse",
    );
  });

  test("Anthropic's data line says content is kept up to 30 days and longer if flagged, and no link uses an address that has moved", () => {
    const { summary, sources } = catalogProvider("anthropic")?.dataUse ?? {};
    expect(summary?.en).toMatch(/30 days.*longer if flagged/);
    expect(summary?.zh).toMatch(/30 天.*更久/);
    expect(summary?.en).not.toMatch(/\bonly\b/);
    expect(sources).toContain(
      "https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data",
    );
    const links = CATALOG_PROVIDERS.flatMap((each) => [each.docsUrl, each.dataUse.url]);
    expect(
      links.filter((url) => /docs\.anthropic\.com|platform\.openai\.com\/docs/.test(url ?? "")),
    ).toEqual([]);
  });

  test("Kimi's data line says it may train on what you send unless agreed otherwise in writing", () => {
    const { summary, sources } = catalogProvider("kimi")?.dataUse ?? {};
    expect(summary?.en).toMatch(/train.*unless agreed otherwise in writing/);
    expect(summary?.zh).toMatch(/训练.*除非另有书面约定/);
    expect(sources).toEqual(["https://platform.kimi.com/docs/agreement/modeluse"]);
  });

  test("a claim that rests on another page keeps its address in the catalog", () => {
    const second = Object.fromEntries(
      CATALOG_PROVIDERS.filter((each) => each.dataUse.sources || each.dataUse.zhUrl).map((each) => [
        each.id,
        [...(each.dataUse.sources ?? []), each.dataUse.zhUrl ?? ""].filter(Boolean),
      ]),
    );
    expect(Object.keys(second).sort()).toEqual([
      "anthropic",
      "bedrock",
      "deepseek",
      "glm",
      "kimi",
      "siliconflow",
      "together",
    ]);
    for (const url of Object.values(second).flat()) expect(url).toMatch(/^https:\/\//);
    expect(catalogProvider("siliconflow")?.dataUse.url).toContain("docs.siliconflow.com/en/");
  });

  test("a local app's data line gives way to a server's when its server is on another computer, Ollama's included", () => {
    const server = catalogProvider("openai-compatible")?.dataUse;
    expect(server?.summary.en).toMatch(/^Depends on the server/);
    for (const id of ["lmstudio", "unsloth", "ollama"]) {
      const provider = catalogProvider(id);
      expect(provider && dataUseOf(provider, false), id).toBe(provider?.dataUse);
      expect(provider && dataUseOf(provider, true), id).toBe(server);
    }
    for (const id of ["anthropic", "openai-compatible"]) {
      const provider = catalogProvider(id);
      expect(provider && dataUseOf(provider, true), id).toBe(provider?.dataUse);
    }
  });

  test("every provider's data-use line fits one line at 900px beside its link, states no price or plan, and a hosted provider links its own page", () => {
    // The narrowest 900px screen is first run's key form, 524px wide, in 12px type: the line,
    // "Data use ↗" and in Chinese "数据使用：" before it must fit in one line of it.
    const MOST_ENGLISH_CHARACTERS = 90;
    const MOST_CHINESE_UNITS = 30;
    const wide = /[\u2e80-\u9fff\uff00-\uffef]/u;
    const units = (text: string) =>
      [...text].reduce((sum, each) => sum + (wide.test(each) ? 1 : each === " " ? 0.25 : 0.5), 0);
    for (const provider of CATALOG_PROVIDERS) {
      const { summary, url } = provider.dataUse;
      expect(summary.en.length, provider.id).toBeLessThanOrEqual(MOST_ENGLISH_CHARACTERS);
      expect(units(summary.zh), provider.id).toBeLessThanOrEqual(MOST_CHINESE_UNITS);
      expect(summary.en, provider.id).not.toMatch(
        /\bplans?\b|\bfees?\b|\bcredits?\b|\bprices?\b|[$¥]\s?\d|\d\s?%/i,
      );
      expect(summary.zh, provider.id).not.toMatch(
        /订阅|套餐|方案|费用|收费|价格|额度|[$¥]\s?\d|\d\s?%/,
      );
      if (provider.id === "openai-compatible") {
        expect(url, provider.id).toBeUndefined();
      } else {
        expect(url, provider.id).toMatch(/^https:\/\//);
      }
    }
  });

  test("a provider with regions has an endpoint for each, the first the default, and a set of model facts for each", () => {
    const regions = (id: string) => catalogProvider(id)?.endpoints.map((each) => each.id);
    expect(regions("qwen")).toEqual(["cn", "intl"]);
    expect(regions("kimi")).toEqual(["cn", "intl"]);
    expect(regions("glm")).toEqual(["cn", "intl"]);
    expect(regions("siliconflow")).toEqual(["cn", "intl"]);
    expect(regions("deepseek")).toEqual(["global"]);
    expect(endpointUrl("qwen")).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(endpointUrl("qwen", "intl")).toBe(
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    );
    expect(endpointUrl("kimi", "cn")).toBe("https://api.moonshot.cn/v1");
    expect(endpointUrl("kimi", "intl")).toBe("https://api.moonshot.ai/v1");
    expect(endpointUrl("glm", "cn")).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(endpointUrl("glm", "intl")).toBe("https://api.z.ai/api/paas/v4");
    expect(endpointUrl("siliconflow", "intl")).toBe("https://api.siliconflow.com/v1");
    // The region picks the model set; one without its own uses the provider's.
    expect(modelsProviderOfKind("qwen")).toBe("qwen");
    expect(modelsProviderOfKind("qwen", "cn")).toBe("qwen");
    expect(modelsProviderOfKind("qwen", "intl")).toBe("qwen/intl");
    expect(modelsProviderOfKind("deepseek", "global")).toBe("deepseek");
    // Each region is its own service for consent: data goes to its host.
    expect(serviceFor("qwen", null, "cn")?.id).toBe("https://dashscope.aliyuncs.com");
    expect(serviceFor("qwen", null, "intl")?.id).toBe("https://dashscope-intl.aliyuncs.com");
  });

  test("prices are in the provider's own currency and the defaults are as chosen", () => {
    const answers = (id: string, set = id) => {
      const model = catalogModel(set, catalogProvider(id)?.roles.answers ?? "");
      return [model?.id, model?.price?.currency, model?.price?.input, model?.price?.output];
    };
    expect(answers("deepseek")).toEqual(["deepseek-flash", "CNY", 2, 8]);
    expect(answers("qwen")).toEqual(["qwen3.7-plus", "CNY", 2, 8]);
    expect(answers("qwen", "qwen/intl")).toEqual(["qwen3.7-plus", "USD", 0.4, 1.6]);
    expect(answers("kimi")).toEqual(["kimi-k2.6", "CNY", 6.5, 27]);
    expect(answers("kimi", "kimi/intl")).toEqual(["kimi-k2.6", "USD", 0.95, 4]);
    expect(answers("glm")).toEqual(["glm-5.3-flash", "CNY", 0.8, 2.8]);
    expect(answers("glm", "glm/intl")).toEqual(["glm-5.3-flash", "USD", 0.15, 0.5]);
    expect(answers("siliconflow")).toEqual(["deepseek-ai/DeepSeek-V4-Flash", "CNY", 3, 9]);
    expect(answers("mistral")).toEqual(["mistral-small-2603", "USD", 0.15, 0.6]);
    expect(answers("xai")).toEqual(["grok-4.3", "USD", 1.25, 2.5]);
    expect(catalogProvider("kimi")?.roles.strongest).toBe("kimi-k3");
    expect(catalogProvider("glm")?.roles.quickTasks).toBe("glm-4.7-flash");
    // The corrections: Kimi fixes its sampling, GLM and DeepSeek take JSON mode only.
    expect(catalogModel("kimi", "kimi-k2.6")?.temperature).toBe(false);
    expect(catalogModel("glm", "glm-5.3")?.structuredOutput).toBe("json_object");
    expect(catalogModel("deepseek", "deepseek-flash")?.structuredOutput).toBe("json_object");
  });

  test("their requests carry what the provider needs", () => {
    expect(catalogProvider("xai")?.request?.store).toBe(false);
    expect(catalogProvider("openrouter")?.request?.body).toEqual({
      provider: { data_collection: "deny", require_parameters: true },
    });
    expect(catalogProvider("siliconflow")?.request?.openAiCompatible).toEqual({
      includeUsage: true,
      supportsStructuredOutputs: true,
    });
    // Every one that thinks by default says how a small call turns it off.
    for (const id of [
      "anthropic",
      "deepseek",
      "qwen",
      "kimi",
      "glm",
      "siliconflow",
      "openrouter",
      "xai",
    ]) {
      expect(catalogProvider(id)?.request?.thinkingOff, id).toBeDefined();
    }
    expect(catalogProvider("glm")?.request?.thinkingOff?.unless).toEqual(["glm-5.3"]);
    // OpenAI's small calls run with reasoning off, except on the models that refuse "none".
    expect(catalogProvider("openai")?.request?.thinkingOff?.except).toEqual(
      expect.arrayContaining(["gpt-6.1-sol", "gpt-6-astra", "gpt-5", "gpt-5-mini", "gpt-5-nano"]),
    );
    expect(catalogProvider("openai")?.request?.thinkingOff?.except).not.toContain("gpt-6-luna");
  });

  test("a provider needs a key and takes no server URL; a region comes with the endpoint", () => {
    for (const id of added) {
      expect(requiresApiKey(id as ChatProviderKind), id).toBe(true);
      expect(() => baseUrlFor(id as ChatProviderKind, "https://example.com"), id).toThrow(
        /doesn't take a server URL/,
      );
      expect(baseUrlFor(id as ChatProviderKind, undefined), id).toBeNull();
    }
  });
});

describe("Tagging models", () => {
  test("a provider tags with its quick-tasks model, except Mistral, whose tagging model is Mistral Small 4", () => {
    const tagging = CATALOG_PROVIDERS.filter((each) => each.roles.tagging !== undefined);
    expect(tagging.map((each) => [each.id, each.roles.tagging])).toEqual([
      ["mistral", "mistral-small-2603"],
    ]);
    // Same input price as Ministral 8B, which is nearly all of what tagging costs.
    expect(catalogModel("mistral", "mistral-small-2603")?.price?.input).toBe(
      catalogModel("mistral", "ministral-8b-2512")?.price?.input,
    );
    expect(
      catalogRoleModel({ kind: "anthropic", catalogId: "anthropic" }, "tagging"),
    ).toBeUndefined();
    expect(catalogRoleModel({ kind: "anthropic", catalogId: "anthropic" }, "quickTasks")).toBe(
      "claude-haiku-5-5",
    );
  });

  test("a preset tags with its own quick-tasks model", () => {
    expect(catalogRoleModel({ kind: "openai-compatible", catalogId: "groq" }, "quickTasks")).toBe(
      "openai/gpt-oss-20b",
    );
    expect(
      catalogRoleModel({ kind: "openai-compatible", catalogId: "openai-compatible" }, "quickTasks"),
    ).toBeUndefined();
  });

  test("the ChatGPT plan tags with GPT-6 Luna", () => {
    expect(catalogRoleModel({ kind: "chatgpt", catalogId: null }, "tagging")).toBe("gpt-6-luna");
    expect(catalogRoleModel({ kind: "chatgpt", catalogId: null }, "quickTasks")).toBe("gpt-6-luna");
    expect(catalogRoleModel({ kind: "chatgpt", catalogId: null }, "images")).toBeUndefined();
  });

  test("Ollama's cloud models get no tagging default: Automatic passes them by", () => {
    expect(catalogRoleModel({ kind: "ollama", catalogId: "ollama" }, "tagging")).toBeUndefined();
    const cloud = {
      choice: { providerId: "ollama", modelId: "gpt-oss:20b-cloud" },
      kind: "ollama" as const,
      catalogId: "ollama",
      service: OLLAMA_CLOUD,
      ollamaCloud: true,
      readsImages: false,
      name: "gpt-oss:20b-cloud",
      price: undefined,
    };
    const picked = automaticTagging({
      localOnly: false,
      jev: { enabled: false, local: false },
      chat: { model: cloud, tagging: cloud, reason: "answers-model" },
      decision: null,
      localChat: null,
    });
    expect(picked).toBeNull();
  });
});

describe("Support tiers (ADR-0019)", () => {
  const FIRST_CLASS = [
    "anthropic",
    "openai",
    "google",
    "openrouter",
    "ollama",
    "deepseek",
    "qwen",
    "siliconflow",
  ];
  const BEST_EFFORT = ["mistral", "xai", "kimi", "glm"];

  test("every catalog provider has a support value, as the ADR sets out", () => {
    for (const each of CATALOG_PROVIDERS) {
      expect(["first-class", "best-effort"], each.id).toContain(each.support);
    }
    const supportOf = (tier: string) =>
      CATALOG_PROVIDERS.filter((each) => each.support === tier).map((each) => each.id);
    expect(supportOf("first-class").sort()).toEqual([...FIRST_CLASS].sort());
    expect(supportOf("best-effort").sort()).toEqual(
      [...BEST_EFFORT, "openai-compatible", ...PRESETS.map((each) => each.id)].sort(),
    );
  });

  test("a hosted preset is an OpenAI-compatible row with a key page and an Answers model, a local one a server on this computer; each is saved as that kind, and not yet tested is never first-class", () => {
    expect(PRESETS.length).toBeGreaterThan(0);
    for (const preset of PRESETS) {
      const where = preset.id;
      expect(isPreset(preset), where).toBe(true);
      expect(chatProviderKinds as readonly string[], where).not.toContain(preset.id);
      expect(preset.adapter, where).toBe("openai-compatible");
      expect(kindOfCatalogId(preset.id), where).toBe("openai-compatible");
      expect(preset.endpoints.length, where).toBeGreaterThan(0);
      expect(untestedForCitations(preset), where).toBe(preset.citingTested === undefined);
      if (untestedForCitations(preset)) expect(preset.support, where).toBe("best-effort");
      if (preset.group === "local") {
        // The models are whatever the User has loaded: none is named here.
        expect(preset.roles, where).toEqual({});
        // Set up at its default address, it is on this computer; and it is in no list of keys.
        for (const endpoint of preset.endpoints) {
          const address = endpoint.field?.default ?? "";
          expect(isLoopbackHost(new URL(fieldUrl(endpoint, address)).hostname), where).toBe(true);
        }
        expect(KEY_PROVIDERS, where).not.toContain(preset.id);
        expect(LOCAL_PRESETS, where).toContain(preset.id);
        continue;
      }
      expect(preset.keyUrl ?? preset.endpoints[0]?.keyUrl, where).toMatch(/^https:\/\//);
      expect(preset.roles.answers, where).toBeDefined();
      // An Answers model that calls Tools, and quick tasks that cost no more.
      const output = (id: string | undefined) =>
        id ? catalogModel(preset.id, id)?.price?.output : undefined;
      expect(catalogModel(preset.id, preset.roles.answers ?? "")?.tools, where).toBe(true);
      expect(output(preset.roles.quickTasks) ?? Number.NaN, where).toBeLessThanOrEqual(
        output(preset.roles.answers) ?? Number.NaN,
      );
    }
    // Rows that aren't presets are never marked untested.
    expect(
      CATALOG_PROVIDERS.filter((each) => untestedForCitations(each) && !isPreset(each)),
    ).toEqual([]);
  });

  test("the key providers are the first-class ones that take a key, then every other", () => {
    const { main, more } = keyProviderGroups();
    const expected = CATALOG_PROVIDERS.filter(
      (each) => each.support === "first-class" && each.endpoints.length > 0,
    ).map((each) => each.id);
    expect(main).toEqual(expected);
    // "More…" holds the rest, and nothing is lost between the two.
    expect([...main, ...more].sort()).toEqual([...KEY_PROVIDERS].sort());
    expect(more).toEqual(expect.arrayContaining([...BEST_EFFORT, "openai-compatible"]));
  });

  test("each first-class provider that needs a key has a key guide in both languages, and the rest have none", () => {
    for (const each of CATALOG_PROVIDERS) {
      const needsGuide = each.support === "first-class" && each.apiKey === "required";
      if (!needsGuide) {
        expect(each.keyGuide, each.id).toBeUndefined();
        continue;
      }
      expect(each.keyUrl, each.id).toBeDefined();
      expect(each.keyGuide?.length, each.id).toBeGreaterThan(0);
      for (const step of each.keyGuide ?? []) {
        expect(step.en.trim(), each.id).not.toBe("");
        expect(step.zh.trim(), each.id).not.toBe("");
      }
    }
  });

  test("a key guide's steps and notes say what to do, and no line states another company's price, fee, credit or plan contents, in both languages", () => {
    const withLine = CATALOG_PROVIDERS.filter((each) => each.keyLine);
    expect(withLine.map((each) => each.id)).toEqual(
      expect.arrayContaining(["anthropic", "openai", "google", "openrouter", "kimi"]),
    );
    for (const each of CATALOG_PROVIDERS) {
      const lines = [
        ...(each.keyGuide ?? []),
        ...(each.notes ?? []),
        ...(each.keyLine ? [each.keyLine] : []),
      ];
      for (const line of lines) {
        expect(line.en, each.id).not.toMatch(
          /include|doesn't|\bfree\b|\bfees?\b|\bdouble\b|[$¥]\s?\d|\d\s?%/i,
        );
        expect(line.zh, each.id).not.toMatch(/不含|不包含|附带|免费|手续费|翻倍|[$¥]\s?\d|\d\s?%/);
      }
    }
    for (const each of withLine) {
      expect(each.keyLine?.url, each.id).toMatch(/^https:\/\//);
    }
    expect(catalogProvider("google")?.keyLine?.link).toBe("pricing");
    expect(catalogProvider("openrouter")?.keyLine?.link).toBe("pricing");
  });

  test("a best-effort provider keeps its link to the provider's key page", () => {
    for (const id of BEST_EFFORT) {
      expect(catalogProvider(id)?.keyUrl, id).toMatch(/^https:\/\//);
    }
  });
});
