/**
 * A live smoke test per provider, against its real API with a real key. Each
 * runs only when its key is in the environment and is skipped otherwise, so
 * `npx vitest run` makes no request without one. It costs a few tokens: a
 * connection test, a model list, and one small call with thinking off.
 *
 *   DEEPSEEK_API_KEY             DeepSeek
 *   DASHSCOPE_API_KEY            Qwen (Alibaba Cloud Model Studio); QWEN_REGION=cn|intl, cn if unset
 *   MOONSHOT_API_KEY             Kimi; KIMI_REGION=cn|intl
 *   ZHIPU_API_KEY                GLM; GLM_REGION=cn|intl (BigModel or Z.ai)
 *   SILICONFLOW_API_KEY          SiliconFlow; SILICONFLOW_REGION=cn|intl
 *   MISTRAL_API_KEY              Mistral
 *   XAI_API_KEY                  xAI
 *   OPENROUTER_API_KEY           OpenRouter
 *
 * A key works only in the region it was made in: set the region to match.
 */
import { generateText } from "ai";
import { describe, expect, test } from "vitest";
import type { ChatProviderKind } from "../../src/core/api";
import { catalogProvider, endpointOf } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { createTempDataFolder, startCore } from "../helpers/core";

const LIVE: { kind: ChatProviderKind; key: string; region?: string }[] = [
  { kind: "deepseek", key: "DEEPSEEK_API_KEY" },
  { kind: "qwen", key: "DASHSCOPE_API_KEY", region: "QWEN_REGION" },
  { kind: "kimi", key: "MOONSHOT_API_KEY", region: "KIMI_REGION" },
  { kind: "glm", key: "ZHIPU_API_KEY", region: "GLM_REGION" },
  { kind: "siliconflow", key: "SILICONFLOW_API_KEY", region: "SILICONFLOW_REGION" },
  { kind: "mistral", key: "MISTRAL_API_KEY" },
  { kind: "xai", key: "XAI_API_KEY" },
  { kind: "openrouter", key: "OPENROUTER_API_KEY" },
];

describe.each(LIVE)("$kind, live", ({ kind, key, region }) => {
  const apiKey = process.env[key];
  const endpointId = region ? process.env[region] : undefined;

  test.skipIf(!apiKey)(
    `${kind}: a key connects, the models list, and a small call answers (set ${key})`,
    { timeout: 120_000 },
    async () => {
      const provider = catalogProvider(kind);
      const endpoint = provider && endpointOf(provider, endpointId);
      const answers = provider?.roles.answers as string;
      const quick = provider?.roles.quickTasks as string;
      const core = startCore(await createTempDataFolder(), {
        createChatModel: createAiSdkChatModel,
      });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));

      const tested = await core.testChatConnection({
        kind,
        ...(endpoint && { endpoint: endpoint.id }),
        apiKey: apiKey as string,
        modelId: answers,
      });
      expect(tested, JSON.stringify(tested)).toEqual({ ok: true });

      const saved = await core.saveChatProvider({
        kind,
        ...(endpoint && { endpoint: endpoint.id }),
        apiKey: apiKey as string,
        modelId: quick,
      });
      const group = (await core.listChatModels()).find((each) => each.provider.id === saved.id);
      expect(group?.models.length ?? 0).toBeGreaterThan(0);

      // A call that doesn't write an Answer, as tagging makes it: the quick-tasks model, thinking off.
      const reply = await generateText({
        model: createAiSdkChatModel({
          kind,
          // The endpoint's own address: a model made from the endpoint id alone goes to the first one (#1650).
          baseUrl: endpoint && !endpoint.field ? endpoint.baseUrl : null,
          apiKey: apiKey as string,
          modelId: quick,
          thinking: "off",
          ...(endpoint && { endpoint: endpoint.id }),
        }),
        prompt: "Reply with the word OK.",
        maxOutputTokens: 256,
        maxRetries: 0,
      });
      expect(reply.text.trim().length).toBeGreaterThan(0);
      expect(reply.usage.totalTokens ?? 0).toBeGreaterThan(0);
    },
  );
});
