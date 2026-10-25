/**
 * The model providers IncarnaMind offers, written by hand: their names,
 * endpoints, adapter, "get a key" link, request quirks, what they do with API
 * data, and their models for each role. Checked against each provider's own
 * pages on the date in `checked`.
 *
 * A provider's Answers default is its cheaper capable model; its strongest
 * stays one click away. A changed default needs the citing evaluation to pass
 * on the new model first.
 *
 * This module holds no model facts, so the renderer can import it for names
 * and defaults without the generated data (see ./index).
 */
import type { ChatProviderKind } from "../../api";
import { PRESETS } from "./presets";
import type {
  CatalogProvider,
  DataUse,
  Endpoint,
  EndpointField,
  ProviderOptions,
  Role,
} from "./types";

const GLOBAL = { en: "Global", zh: "全球" };

export const CLAUDE_BETWEEN_TOOLS: ProviderOptions = {
  anthropic: { thinking: { type: "between_tools" } },
};

// A model that always thinks adaptively can only be asked for less (#907).
export const CLAUDE_LOW_EFFORT: ProviderOptions = {
  anthropic: { thinking: { type: "adaptive" }, effort: "low" },
};

const PROVIDERS = [
  {
    id: "anthropic",
    name: { en: "Anthropic", zh: "Anthropic" },
    support: "first-class",
    group: "international",
    adapter: "anthropic",
    endpoints: [{ id: "global", label: GLOBAL, baseUrl: "https://api.anthropic.com/v1" }],
    apiKey: "required",
    keyUrl: "https://platform.claude.com/settings/keys",
    billingUrl: "https://platform.claude.com/settings/billing",
    keyGuide: [
      {
        en: "Open Anthropic's key page and sign in to the Anthropic Console.",
        zh: "打开 Anthropic 的密钥页面，登录 Anthropic Console。",
      },
      {
        en: "Add credit under Billing.",
        zh: "在 Billing 中充值。",
      },
      {
        en: "Create a key, copy it (it's shown once) and paste it here.",
        zh: "新建一个密钥，复制（只显示一次），粘贴到这里。",
      },
    ],
    docsUrl: "https://platform.claude.com/docs/en/about-claude/models/overview",
    pricingUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
    request: {
      // Claude 5.5 thinks by default (adaptively): a small call with a short reply runs out of room
      // before it writes anything (#282). The newest refuse `disabled`, and their refusal names
      // the setting they take instead (#907).
      thinkingOff: {
        options: { anthropic: { thinking: { type: "disabled" } } },
        refused: [
          { names: "between_tools", options: CLAUDE_BETWEEN_TOOLS },
          { names: "output_config.effort", options: CLAUDE_LOW_EFFORT },
        ],
      },
      // Claude 5 models think by default, and return only an empty block unless asked for the summary.
      // At the default effort, a summary of three Documents took 30 to 85 seconds to start (#899).
      reasoningSummary: {
        options: { anthropic: { thinking: { type: "adaptive", display: "summarized" } } },
        answer: {
          anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" },
        },
        careful: {
          anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
        },
        refused: [{ names: "effort", options: { anthropic: { effort: undefined } } }],
        only: [
          "claude-fable-5",
          "claude-mythos-5",
          "claude-opus-5",
          "claude-sonnet-5",
          "claude-haiku-5",
        ],
      },
    },
    roles: {
      answers: "claude-haiku-5-5",
      strongest: "claude-fable-5-1",
      quickTasks: "claude-haiku-5-5",
      images: "claude-sonnet-5-5",
    },
    dataUse: {
      training: "no",
      summary: {
        en: "No training without your permission; kept up to 30 days, longer if flagged.",
        zh: "未经你许可不用于训练；最多保留 30 天，被标记的内容可能更久。",
      },
      url: "https://platform.claude.com/docs/en/manage-claude/api-and-data-retention",
      sources: [
        "https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data",
      ],
    },
    notes: [
      {
        en: "Not available in mainland China or Hong Kong.",
        zh: "中国大陆和香港无法使用。",
      },
    ],
    keyLine: {
      en: "Paste an API key from the Anthropic Console.",
      zh: "粘贴 Anthropic Console 中的 API 密钥。",
      url: "https://support.claude.com/en/articles/17154008",
      link: "details",
    },
    checked: "2026-10-19",
  },
  {
    id: "openai",
    name: { en: "OpenAI", zh: "OpenAI" },
    support: "first-class",
    group: "international",
    adapter: "openai",
    endpoints: [{ id: "global", label: GLOBAL, baseUrl: "https://api.openai.com/v1" }],
    apiKey: "required",
    keyUrl: "https://platform.openai.com/api-keys",
    billingUrl: "https://platform.openai.com/settings/organization/billing/overview",
    keyGuide: [
      {
        en: "Open OpenAI's key page and sign in to the OpenAI platform.",
        zh: "打开 OpenAI 的密钥页面，登录 OpenAI 平台。",
      },
      {
        en: "Add credit under Billing.",
        zh: "在 Billing 中充值。",
      },
      {
        en: "Create a key, copy it (it's shown once) and paste it here.",
        zh: "新建一个密钥，复制（只显示一次），粘贴到这里。",
      },
    ],
    docsUrl: "https://developers.openai.com/api/docs/models",
    pricingUrl: "https://developers.openai.com/api/docs/pricing",
    // The Responses API keeps each request on OpenAI's servers unless it says not to. Small
    // calls run with reasoning off: on the Organize evaluation GPT-6 Luna tagged as well with it
    // off, writing a quarter of the output tokens. These models refuse "none" (GPT-6.1 Sol and
    // GPT-6 Astra start at "low", the 2025 GPT-5 models at "minimal"; o-series, Pro and Codex
    // models aren't checked), so they keep their own.
    request: {
      store: false,
      thinkingOff: {
        options: { openai: { reasoningEffort: "none" } },
        except: [
          "gpt-6.1-sol",
          "gpt-6-astra",
          "gpt-5",
          "gpt-5-mini",
          "gpt-5-nano",
          "gpt-5-pro",
          "gpt-5.2-pro",
          "gpt-5.3-codex",
          "gpt-5.3-codex-spark",
          "gpt-5.4-pro",
          "gpt-5.5-pro",
          "o1",
          "o1-pro",
          "o3",
          "o3-mini",
          "o3-pro",
          "o4-mini",
        ],
      },
      reasoningSummary: { options: { openai: { reasoningSummary: "auto" } } },
    },
    roles: {
      answers: "gpt-6-luna",
      strongest: "gpt-6-astra",
      quickTasks: "gpt-6-luna",
      images: "gpt-6.1-sol",
    },
    dataUse: {
      training: "no",
      summary: {
        en: "Not trained on unless you opt in; abuse-monitoring logs are kept up to 30 days.",
        zh: "除非你选择加入，否则不用于训练；防滥用日志最多保留 30 天。",
      },
      url: "https://developers.openai.com/api/docs/guides/your-data",
    },
    notes: [
      {
        en: "Not available in mainland China or Hong Kong.",
        zh: "中国大陆和香港无法使用。",
      },
    ],
    keyLine: {
      en: "With a ChatGPT plan, you can use Continue with ChatGPT instead of a key.",
      zh: "有 ChatGPT 订阅时，可以改用“使用 ChatGPT 继续”，无需密钥。",
      url: "https://learn.chatgpt.com/docs/sign-in-with-chatgpt",
      link: "details",
    },
    checked: "2026-10-18",
  },
  {
    id: "google",
    name: { en: "Google", zh: "Google" },
    support: "first-class",
    group: "international",
    adapter: "google",
    endpoints: [
      {
        id: "global",
        label: GLOBAL,
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      },
    ],
    apiKey: "required",
    keyUrl: "https://aistudio.google.com/apikey",
    keyGuide: [
      {
        en: "Open Google's key page and sign in with your Google account.",
        zh: "打开 Google 的密钥页面，用 Google 账号登录。",
      },
      {
        en: "Choose Create API key, and a project if it asks.",
        zh: "选择“Create API key”，如有提示再选一个项目。",
      },
      {
        en: "Copy the key and paste it here.",
        zh: "复制密钥，粘贴到这里。",
      },
    ],
    docsUrl: "https://ai.google.dev/gemini-api/docs/models",
    pricingUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    roles: {
      answers: "gemini-3.8-flash",
      strongest: "gemini-3.1-pro-preview",
      quickTasks: "gemini-3.5-flash-lite",
      images: "gemini-3.8-flash",
    },
    dataUse: {
      training: "free-tier",
      summary: {
        en: "Unpaid use may improve Google's products, with human review; paid use doesn't.",
        zh: "未付费时可能用于改进 Google 产品并经人工审阅；付费则不会。",
      },
      url: "https://ai.google.dev/gemini-api/terms",
    },
    notes: [
      {
        en: "Not available in mainland China or Hong Kong.",
        zh: "中国大陆和香港无法使用。",
      },
    ],
    keyLine: {
      en: "Paste a Gemini API key from Google AI Studio",
      zh: "粘贴 Google AI Studio 的 Gemini API 密钥",
      url: "https://ai.google.dev/gemini-api/docs/pricing",
      link: "pricing",
    },
    checked: "2026-10-18",
  },
  {
    id: "openrouter",
    name: { en: "OpenRouter", zh: "OpenRouter" },
    support: "first-class",
    group: "international",
    adapter: "openrouter",
    endpoints: [{ id: "global", label: GLOBAL, baseUrl: "https://openrouter.ai/api/v1" }],
    apiKey: "required",
    keyUrl: "https://openrouter.ai/settings/keys",
    billingUrl: "https://openrouter.ai/credits",
    keyGuide: [
      {
        en: "Open OpenRouter's key page and sign in.",
        zh: "打开 OpenRouter 的密钥页面并登录。",
      },
      {
        en: "Add credit under Credits.",
        zh: "在 Credits 中充值。",
      },
      {
        en: "Create a key, copy it (it's shown once) and paste it here.",
        zh: "新建一个密钥，复制（只显示一次），粘贴到这里。",
      },
    ],
    docsUrl: "https://openrouter.ai/models",
    request: {
      // Route only to providers that don't keep or train on prompts, and only to those that
      // support everything a request asks for (Tools, a JSON schema).
      body: { provider: { data_collection: "deny", require_parameters: true } },
      thinkingOff: { options: { openrouter: { reasoning: { effort: "none" } } } },
    },
    roles: {
      answers: "anthropic/claude-sonnet-5.5",
      strongest: "anthropic/claude-fable-5.1",
      quickTasks: "openai/gpt-6-luna",
      images: "anthropic/claude-sonnet-5.5",
    },
    dataUse: {
      training: "no",
      summary: {
        en: "OpenRouter uses only providers it lists as not collecting data, leaving out some models.",
        zh: "OpenRouter 只用其标明不收集数据的服务，部分模型无法使用。",
      },
      url: "https://openrouter.ai/docs/guides/routing/provider-selection",
    },
    keyLine: {
      en: "Pay per use with OpenRouter credits",
      zh: "用 OpenRouter 额度按用量付费",
      url: "https://openrouter.ai/pricing",
      link: "pricing",
    },
    checked: "2026-10-18",
  },
  {
    id: "mistral",
    name: { en: "Mistral", zh: "Mistral" },
    support: "best-effort",
    group: "international",
    adapter: "mistral",
    endpoints: [{ id: "global", label: GLOBAL, baseUrl: "https://api.mistral.ai/v1" }],
    apiKey: "required",
    keyUrl: "https://console.mistral.ai/api-keys",
    docsUrl: "https://docs.mistral.ai/getting-started/models/models_overview/",
    pricingUrl: "https://mistral.ai/pricing",
    request: { thinkingOff: { options: { mistral: { reasoningEffort: "none" } } } },
    roles: {
      answers: "mistral-small-2603",
      strongest: "mistral-medium-2604",
      quickTasks: "ministral-8b-2512",
      images: "mistral-small-2603",
      // Tagging's cost is nearly all input, which Mistral Small 4 prices as Ministral 8B does,
      // and it is a much larger model.
      tagging: "mistral-small-2603",
    },
    dataUse: {
      training: "opt-out",
      summary: {
        en: "May train on your input and output; you can opt out at any time.",
        zh: "可能用你的输入和输出训练模型，你可随时选择退出。",
      },
      url: "https://help.mistral.ai/en/articles/347617-do-you-use-my-user-data-to-train-your-artificial-intelligence-models",
    },
    checked: "2026-10-18",
  },
  {
    id: "xai",
    name: { en: "xAI", zh: "xAI" },
    support: "best-effort",
    group: "international",
    adapter: "xai",
    endpoints: [{ id: "global", label: GLOBAL, baseUrl: "https://api.x.ai/v1" }],
    apiKey: "required",
    keyUrl: "https://console.x.ai",
    docsUrl: "https://docs.x.ai/docs/models",
    // The Responses API keeps each request unless it says not to.
    request: {
      store: false,
      thinkingOff: { options: { xai: { reasoningEffort: "none" } } },
    },
    roles: {
      answers: "grok-4.3",
      strongest: "grok-4.7",
      quickTasks: "grok-4.3",
      images: "grok-4.3",
    },
    dataUse: {
      training: "no",
      summary: {
        en: "No training without your permission; kept 30 days, then deleted.",
        zh: "未经你许可不用于训练；保留 30 天后删除。",
      },
      url: "https://docs.x.ai/developers/faq/security",
    },
    checked: "2026-10-18",
  },
  {
    id: "deepseek",
    name: { en: "DeepSeek", zh: "DeepSeek 深度求索" },
    support: "first-class",
    group: "china",
    adapter: "deepseek",
    endpoints: [{ id: "global", label: GLOBAL, baseUrl: "https://api.deepseek.com" }],
    apiKey: "required",
    keyUrl: "https://platform.deepseek.com/api_keys",
    billingUrl: "https://platform.deepseek.com/top_up",
    keyGuide: [
      {
        en: "Open DeepSeek's key page and sign up or sign in to the DeepSeek platform.",
        zh: "打开 DeepSeek 的密钥页面，注册或登录 DeepSeek 开放平台。",
      },
      {
        en: "Top up your balance.",
        zh: "充值账户余额。",
      },
      {
        en: "Create a key, copy it (it's shown once) and paste it here.",
        zh: "新建一个密钥，复制（只显示一次），粘贴到这里。",
      },
    ],
    docsUrl: "https://api-docs.deepseek.com/quick_start/pricing",
    request: { thinkingOff: { options: { deepseek: { thinking: { type: "disabled" } } } } },
    roles: {
      answers: "deepseek-flash",
      strongest: "deepseek-v4-pro",
      quickTasks: "deepseek-flash",
      images: "deepseek-flash",
    },
    dataUse: {
      training: "unknown",
      summary: {
        en: "Privacy policy allows training and stores data in China; API terms are silent on both.",
        zh: "隐私政策允许用于训练，数据存储在中国；API 条款对此未作说明。",
      },
      url: "https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html",
      sources: [
        "https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html",
      ],
    },
    checked: "2026-10-18",
  },
  {
    id: "qwen",
    name: { en: "Qwen (Alibaba Cloud Model Studio)", zh: "通义千问（阿里云百炼）" },
    support: "first-class",
    group: "china",
    adapter: "alibaba",
    // Each region has its own key and model list: a key works only in the region it was made in.
    endpoints: [
      {
        id: "cn",
        label: { en: "China (Beijing)", zh: "中国内地（北京）" },
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        keyUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
        pricingUrl: "https://help.aliyun.com/zh/model-studio/model-pricing",
      },
      {
        id: "intl",
        label: { en: "International (Singapore)", zh: "国际（新加坡）" },
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        keyUrl: "https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key",
        pricingUrl: "https://www.alibabacloud.com/help/en/model-studio/model-pricing",
      },
    ],
    apiKey: "required",
    keyUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
    keyGuide: [
      {
        en: "Pick the region of your account above, then open Qwen's key page. A key works only in its own region.",
        zh: "先在上方选择账号所在的区域，再打开通义千问的密钥页面。密钥只在创建它的区域有效。",
      },
      {
        en: "Sign in to Model Studio and turn it on if it asks.",
        zh: "登录百炼并按提示开通。",
      },
      {
        en: "Create a key, copy it and paste it here.",
        zh: "新建一个 API-KEY，复制，粘贴到这里。",
      },
    ],
    docsUrl: "https://www.alibabacloud.com/help/en/model-studio/regions",
    request: { thinkingOff: { options: { alibaba: { enableThinking: false } } } },
    roles: {
      answers: "qwen3.7-plus",
      strongest: "qwen3.8-max",
      quickTasks: "qwen3.8-flash",
      images: "qwen3.7-plus",
    },
    dataUse: {
      training: "no",
      summary: {
        en: "Alibaba Cloud says it never trains on your data; it stores what your calls generate.",
        zh: "阿里云称绝不用你的数据训练模型，但会存储调用产生的数据。",
      },
      url: "https://www.alibabacloud.com/help/en/model-studio/privacy-notice",
    },
    notes: [
      {
        en: "A key works only in the region it was made in. Choose the region first.",
        zh: "密钥只能用于创建它的区域。请先选择区域。",
      },
    ],
    checked: "2026-10-18",
  },
  {
    id: "kimi",
    name: { en: "Kimi (Moonshot AI)", zh: "Kimi（月之暗面）" },
    support: "best-effort",
    group: "china",
    alsoListedIn: "international",
    adapter: "moonshotai",
    endpoints: [
      {
        id: "cn",
        label: { en: "China", zh: "中国" },
        baseUrl: "https://api.moonshot.cn/v1",
        keyUrl: "https://platform.kimi.com/console/api-keys",
        pricingUrl: "https://platform.moonshot.cn/docs/pricing/chat",
        billingUrl: "https://platform.kimi.com/console",
      },
      {
        id: "intl",
        label: { en: "International", zh: "国际" },
        baseUrl: "https://api.moonshot.ai/v1",
        keyUrl: "https://platform.kimi.ai/console/api-keys",
        billingUrl: "https://platform.kimi.ai/console",
      },
    ],
    apiKey: "required",
    keyUrl: "https://platform.kimi.com/console/api-keys",
    docsUrl: "https://platform.kimi.ai/docs/pricing/chat",
    request: { thinkingOff: { options: { moonshotai: { thinking: { type: "disabled" } } } } },
    roles: {
      answers: "kimi-k2.6",
      strongest: "kimi-k3",
      quickTasks: "kimi-k2.6",
      images: "kimi-k2.6",
    },
    dataUse: {
      training: "opt-out",
      summary: {
        en: "May use what you send to train and improve its models unless agreed otherwise in writing.",
        zh: "可能用你发送的内容训练和改进模型，除非另有书面约定。",
      },
      url: "https://platform.kimi.ai/docs/agreement/modeluse",
      sources: ["https://platform.kimi.com/docs/agreement/modeluse"],
    },
    keyLine: {
      en: "If Kimi refuses requests, check your Kimi account",
      zh: "如果 Kimi 拒绝请求，请检查你的 Kimi 账户",
      url: "https://platform.kimi.ai/docs/pricing/chat",
      link: "pricing",
    },
    checked: "2026-10-19",
  },
  {
    id: "glm",
    name: { en: "GLM (Zhipu / Z.ai)", zh: "智谱 GLM" },
    support: "best-effort",
    group: "china",
    adapter: "zai",
    // BigModel (mainland China) and Z.ai (international) are separate platforms with separate keys.
    // Not the Coding Plan's endpoint: its terms forbid use in other apps.
    endpoints: [
      {
        id: "cn",
        label: { en: "China (BigModel)", zh: "中国（智谱开放平台）" },
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        keyUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
      },
      {
        id: "intl",
        label: { en: "International (Z.ai)", zh: "国际（Z.ai）" },
        baseUrl: "https://api.z.ai/api/paas/v4",
        keyUrl: "https://z.ai/manage-apikey/apikey-list",
        pricingUrl: "https://docs.z.ai/guides/overview/pricing",
      },
    ],
    apiKey: "required",
    keyUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
    docsUrl: "https://docs.bigmodel.cn/cn/guide/start/pricing",
    request: {
      thinkingOff: {
        options: { zai: { thinking: { type: "disabled" } } },
        // GLM-5.3 and its Flash can't turn thinking off.
        unless: ["glm-5.3"],
      },
    },
    roles: {
      answers: "glm-5.3-flash",
      strongest: "glm-5.3",
      quickTasks: "glm-4.7-flash",
      images: "glm-5.3-flash",
    },
    dataUse: {
      training: "unknown",
      summary: {
        en: "Z.ai says it doesn't store your content; BigModel (China) may train on anonymised data.",
        zh: "Z.ai 称不存储你的内容；智谱开放平台可能用匿名化数据训练。",
      },
      url: "https://docs.z.ai/legal-agreement/privacy-policy",
      sources: ["https://docs.bigmodel.cn/cn/terms/privacy-policy"],
    },
    notes: [
      {
        en: "BigModel asks for real-name verification before it gives a key.",
        zh: "智谱开放平台在发放密钥前需要实名认证。",
      },
    ],
    checked: "2026-10-18",
  },
  {
    id: "siliconflow",
    name: { en: "SiliconFlow", zh: "硅基流动" },
    support: "first-class",
    group: "china",
    adapter: "openai-compatible",
    endpoints: [
      {
        id: "cn",
        label: { en: "China", zh: "中国" },
        baseUrl: "https://api.siliconflow.cn/v1",
        keyUrl: "https://cloud.siliconflow.cn/account/ak",
        pricingUrl: "https://siliconflow.cn/pricing",
      },
      {
        id: "intl",
        label: { en: "International", zh: "国际" },
        baseUrl: "https://api.siliconflow.com/v1",
        keyUrl: "https://cloud.siliconflow.com/account/ak",
        pricingUrl: "https://www.siliconflow.com/pricing",
      },
    ],
    apiKey: "required",
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    keyGuide: [
      {
        en: "Pick the region of your account above, then open SiliconFlow's key page.",
        zh: "先在上方选择账号所在的区域，再打开硅基流动的密钥页面。",
      },
      {
        en: "Sign in to SiliconFlow. In mainland China it asks you to verify your identity first.",
        zh: "登录硅基流动。中国大陆账号需要先完成实名认证。",
      },
      {
        en: "Create a key, copy it and paste it here.",
        zh: "新建一个 API 密钥，复制，粘贴到这里。",
      },
    ],
    docsUrl: "https://docs.siliconflow.cn/cn/userguide/quickstart",
    request: {
      openAiCompatible: { includeUsage: true, supportsStructuredOutputs: true },
      thinkingOff: { options: { siliconflow: { enable_thinking: false } } },
    },
    roles: {
      answers: "deepseek-ai/DeepSeek-V4-Flash",
      strongest: "deepseek-ai/DeepSeek-V4-Pro",
      quickTasks: "Qwen/Qwen3-8B",
      images: "Qwen/Qwen3-VL-32B-Instruct",
    },
    dataUse: {
      training: "unknown",
      summary: {
        en: "China policy: no training, no stored inputs or outputs. International policy: doesn't say.",
        zh: "中国站政策称不训练、不保留输入和输出；国际站政策未说明。",
      },
      url: "https://docs.siliconflow.com/en/legals/privacy-policy",
      zhUrl: "https://docs.siliconflow.cn/docs/legals/privacy-policy",
    },
    notes: [
      {
        en: "Many models with one key. Mainland accounts need ID and face verification.",
        zh: "一个密钥可用多种模型。中国大陆账号需要身份证和人脸验证。",
      },
    ],
    checked: "2026-10-18",
  },
  {
    id: "ollama",
    name: { en: "Ollama", zh: "Ollama" },
    support: "first-class",
    group: "local",
    adapter: "ollama",
    endpoints: [],
    serverUrl: "optional",
    apiKey: "none",
    docsUrl: "https://ollama.com/library",
    pricingUrl: "https://ollama.com/pricing",
    // The model measured with IncarnaMind (#67); the loaded model also does the small jobs,
    // as a second local model would push it out of memory. Others by this computer's
    // memory are in ./local.
    roles: { answers: "qwen3.5:4b", quickTasks: "qwen3.5:4b" },
    dataUse: {
      training: "no",
      summary: {
        en: "Local models stay local; cloud-model questions go to ollama.com, which says no training.",
        zh: "本地模型不外传；云端模型的提问发往 ollama.com，称不训练。",
      },
      url: "https://ollama.com/privacy",
    },
    checked: "2026-10-18",
  },
  {
    id: "openai-compatible",
    name: { en: "OpenAI-compatible server", zh: "OpenAI 兼容服务器" },
    support: "best-effort",
    group: "other",
    adapter: "openai-compatible",
    endpoints: [],
    serverUrl: "required",
    apiKey: "optional",
    roles: {},
    dataUse: {
      training: "unknown",
      summary: {
        en: "Depends on the server: check its terms. A server on this computer sends nothing out.",
        zh: "取决于服务器，请查看其条款；本机的服务器不会向外发送内容。",
      },
    },
    checked: "2026-10-10",
  },
] as const satisfies readonly CatalogProvider[];

export type CatalogProviderId = (typeof PROVIDERS)[number]["id"];

/**
 * The ChatGPT plan's models for the jobs that aren't Answers: it has no entry
 * of its own (it serves OpenAI's models, see ../chatgpt), and the User picks
 * its Answers model from the plan's list.
 */
export const CHATGPT_PLAN_ROLES: Readonly<
  Pick<Partial<Record<Role, string>>, "quickTasks" | "tagging">
> = {
  quickTasks: "gpt-6-luna",
  tagging: "gpt-6-luna",
};

/** The providers, in the order the catalog lists them: the presets before a server the User gives. */
export const CATALOG_PROVIDERS: readonly CatalogProvider[] = PROVIDERS.flatMap(
  (each): readonly CatalogProvider[] =>
    each.id === "openai-compatible" ? [...PRESETS, each] : [each],
);

const byId = new Map<string, CatalogProvider>(CATALOG_PROVIDERS.map((each) => [each.id, each]));
const presetIds = new Set(PRESETS.map((each) => each.id));
const kinds = new Map<string, ChatProviderKind>(PROVIDERS.map((each) => [each.id, each.id]));

/** The provider with this catalog id, if the catalog has it. */
export const catalogProvider = (id: string | null | undefined): CatalogProvider | undefined =>
  id ? byId.get(id) : undefined;

/**
 * What a provider does with what it is sent. A local app's own line holds only
 * while its server runs on this computer: at an address `elsewhere` it is any
 * server's, so it says that.
 */
export function dataUseOf(provider: CatalogProvider, elsewhere: boolean): DataUse {
  return (
    (elsewhere && provider.group === "local" && catalogProvider("openai-compatible")?.dataUse) ||
    provider.dataUse
  );
}

/**
 * The catalog provider a provider kind stands for: each kind is one, except
 * the ChatGPT plan, which signs in instead (see ../chatgpt).
 */
export const catalogProviderOfKind = (kind: ChatProviderKind): CatalogProvider | undefined =>
  catalogProvider(kind);

export type Preset = CatalogProvider & { adapter: "openai-compatible" };

export const isPreset = (provider: CatalogProvider | undefined): provider is Preset =>
  provider !== undefined && presetIds.has(provider.id);

export const catalogProviderOf = (
  kind: ChatProviderKind,
  catalogId: string | null | undefined,
): CatalogProvider | undefined =>
  (catalogId && presetIds.has(catalogId) ? catalogProvider(catalogId) : undefined) ??
  catalogProviderOfKind(kind);

/** Throws for an id the catalog doesn't have. */
export function kindOfCatalogId(id: string): ChatProviderKind {
  if (presetIds.has(id)) return "openai-compatible";
  const kind = kinds.get(id);
  if (!kind) throw new Error(`The catalog has no provider kind "${id}".`);
  return kind;
}

/**
 * A preset whose Answers model hasn't passed the citing evaluation (#185): its
 * models are labelled "Not yet tested for checked Citations" and it is never
 * recommended, whatever else its row says.
 */
export const untestedForCitations = (provider: CatalogProvider | undefined): boolean =>
  isPreset(provider) && provider.citingTested === undefined;

/** The presets that run on this computer (LM Studio, Unsloth Studio), by catalog id: set up beside Ollama, not by a key. */
export const LOCAL_PRESETS: readonly string[] = CATALOG_PROVIDERS.filter(
  (each) => isPreset(each) && each.group === "local",
).map((each) => each.id);

/**
 * The providers set up with a key or a server address, by catalog id, in
 * catalog order: every hosted provider and preset, then a server the User
 * gives. Ollama and the presets on this computer have their own place.
 */
export const KEY_PROVIDERS: readonly string[] = CATALOG_PROVIDERS.filter(
  (each) =>
    (each.endpoints.length > 0 || each.id === "openai-compatible") &&
    !LOCAL_PRESETS.includes(each.id),
).map((each) => each.id);

/**
 * The providers to offer for a key, in the two groups the screens show: `main`,
 * the first-class ones, and `more`, the rest, under "More…".
 */
export function keyProviderGroups(): { main: string[]; more: string[] } {
  const main = KEY_PROVIDERS.filter((id) => catalogProvider(id)?.support === "first-class");
  return { main, more: KEY_PROVIDERS.filter((id) => !main.includes(id)) };
}

export const fieldAccepts = (field: EndpointField, value: string): boolean =>
  field.choices
    ? field.choices.some((each) => each.value === value)
    : new RegExp(`^(?:${field.pattern ?? ".+"})$`).test(value);

/** An endpoint's address with its field's value in it. */
export const fieldUrl = (endpoint: Endpoint, value: string): string =>
  endpoint.field ? endpoint.baseUrl.replace(`{${endpoint.field.name}}`, value) : endpoint.baseUrl;

/** The field's value a saved address was built with; null when it wasn't built from this endpoint. */
export function fieldValueOf(endpoint: Endpoint, baseUrl: string | null): string | null {
  if (!endpoint.field || !baseUrl) return null;
  const [before = "", after = ""] = endpoint.baseUrl.split(`{${endpoint.field.name}}`);
  if (!baseUrl.startsWith(before) || !baseUrl.endsWith(after)) return null;
  const value = baseUrl.slice(before.length, baseUrl.length - after.length);
  return fieldAccepts(endpoint.field, value) ? value : null;
}

export const billingUrlOf = (
  provider: CatalogProvider,
  endpointId: string | null | undefined,
): string | undefined => endpointOf(provider, endpointId)?.billingUrl ?? provider.billingUrl;

export const pricingUrlOf = (
  provider: CatalogProvider,
  endpointId: string | null | undefined,
): string | undefined =>
  endpointOf(provider, endpointId)?.pricingUrl ?? provider.pricingUrl ?? provider.docsUrl;

/** The provider's endpoint with this id, else its first (the default); none for a server the User gives. */
export const endpointOf = (
  provider: CatalogProvider,
  id: string | null | undefined,
): Endpoint | undefined =>
  provider.endpoints.find((each) => each.id === id) ?? provider.endpoints[0];

/**
 * A provider's model for a job that isn't Answers, from the catalog: the
 * ChatGPT plan's from its own roles, a Claude account's from Anthropic's, as
 * it serves the same models. Undefined when it names none.
 */
export const catalogRoleModel = (
  { kind, catalogId }: { kind: ChatProviderKind; catalogId: string | null },
  role: "quickTasks" | "images" | "tagging",
): string | undefined =>
  kind === "chatgpt"
    ? role === "images"
      ? undefined
      : CHATGPT_PLAN_ROLES[role]
    : catalogProviderOf(kind === "claude-account" ? "anthropic" : kind, catalogId)?.roles[role];
