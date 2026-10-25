/**
 * Services that speak OpenAI's API, hosted or on this computer, one catalog
 * row each. They share the "openai-compatible" kind and its code, told apart
 * by their catalog id, so adding one is a row here and nothing else.
 */
import type { CatalogProvider } from "./types";

export const PRESETS: readonly CatalogProvider[] = [
  {
    id: "groq",
    name: { en: "Groq", zh: "Groq" },
    support: "best-effort",
    group: "international",
    adapter: "openai-compatible",
    endpoints: [
      {
        id: "global",
        label: { en: "Global", zh: "全球" },
        baseUrl: "https://api.groq.com/openai/v1",
      },
    ],
    apiKey: "required",
    keyUrl: "https://console.groq.com/keys",
    docsUrl: "https://console.groq.com/docs/models",
    pricingUrl: "https://groq.com/pricing",
    request: { openAiCompatible: { includeUsage: true, supportsStructuredOutputs: false } },
    roles: { answers: "openai/gpt-oss-120b", quickTasks: "openai/gpt-oss-20b" },
    dataUse: {
      training: "unknown",
      summary: {
        en: "Doesn't keep requests by default; may log some up to 30 days, which you can turn off.",
        zh: "默认不保留请求；可能为排查问题记录最多 30 天，可关闭。",
      },
      url: "https://console.groq.com/docs/your-data",
    },
    checked: "2026-10-18",
  },
  {
    id: "together",
    name: { en: "Together AI", zh: "Together AI" },
    support: "best-effort",
    group: "international",
    adapter: "openai-compatible",
    endpoints: [
      { id: "global", label: { en: "Global", zh: "全球" }, baseUrl: "https://api.together.ai/v1" },
    ],
    apiKey: "required",
    keyUrl: "https://api.together.ai/settings/projects/~current/api-keys",
    docsUrl: "https://docs.together.ai/docs/serverless-models",
    pricingUrl: "https://www.together.ai/pricing",
    request: { openAiCompatible: { includeUsage: true, supportsStructuredOutputs: false } },
    roles: {
      answers: "deepseek-ai/DeepSeek-V4-Flash-0731",
      strongest: "deepseek-ai/DeepSeek-V4-Pro-0813",
      quickTasks: "Qwen/Qwen3.5-9B",
    },
    dataUse: {
      training: "no",
      summary: {
        en: "Opt-in training; prompts may improve products; some models pass them to other companies.",
        zh: "选择加入才训练；提示可能用于改进产品；部分模型转交其他公司。",
      },
      url: "https://docs.together.ai/docs/privacy-and-security",
      sources: ["https://docs.together.ai/docs/zero-data-retention"],
    },
    checked: "2026-10-19",
  },
  {
    id: "fireworks",
    name: { en: "Fireworks AI", zh: "Fireworks AI" },
    support: "best-effort",
    group: "international",
    adapter: "openai-compatible",
    endpoints: [
      {
        id: "global",
        label: { en: "Global", zh: "全球" },
        baseUrl: "https://api.fireworks.ai/inference/v1",
      },
    ],
    apiKey: "required",
    keyUrl: "https://app.fireworks.ai/settings/users/api-keys",
    docsUrl: "https://docs.fireworks.ai/getting-started/quickstart",
    pricingUrl: "https://fireworks.ai/pricing",
    request: { openAiCompatible: { includeUsage: true, supportsStructuredOutputs: false } },
    roles: {
      answers: "accounts/fireworks/models/glm-5p3-flash",
      strongest: "accounts/fireworks/models/glm-5p3",
      quickTasks: "accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b",
    },
    dataUse: {
      training: "unknown",
      summary: {
        en: "Doesn't log or store prompts or replies for open models unless you opt in.",
        zh: "开放模型的提示和回复默认不记录、不保存，除非你选择加入。",
      },
      url: "https://docs.fireworks.ai/guides/security_compliance/data_handling",
    },
    checked: "2026-10-18",
  },
  {
    id: "cerebras",
    name: { en: "Cerebras", zh: "Cerebras" },
    support: "best-effort",
    group: "international",
    adapter: "openai-compatible",
    endpoints: [
      { id: "global", label: { en: "Global", zh: "全球" }, baseUrl: "https://api.cerebras.ai/v1" },
    ],
    apiKey: "required",
    keyUrl: "https://cloud.cerebras.ai",
    docsUrl: "https://inference-docs.cerebras.ai/models/overview",
    pricingUrl: "https://www.cerebras.ai/pricing",
    request: { openAiCompatible: { includeUsage: true, supportsStructuredOutputs: false } },
    roles: { answers: "gpt-oss-120b", quickTasks: "gpt-oss-120b" },
    dataUse: {
      training: "unknown",
      summary: {
        en: "Says it doesn't keep your inputs or outputs.",
        zh: "Cerebras 称不保留输入和输出。",
      },
      url: "https://www.cerebras.ai/privacy-policy",
    },
    checked: "2026-10-18",
  },
  {
    id: "cohere",
    name: { en: "Cohere", zh: "Cohere" },
    support: "best-effort",
    group: "international",
    adapter: "openai-compatible",
    endpoints: [
      {
        id: "global",
        label: { en: "Global", zh: "全球" },
        baseUrl: "https://api.cohere.ai/compatibility/v1",
      },
    ],
    apiKey: "required",
    keyUrl: "https://dashboard.cohere.com/api-keys",
    docsUrl: "https://docs.cohere.com/docs/compatibility-api",
    pricingUrl: "https://cohere.com/pricing",
    // Its compatibility API doesn't document `stream_options`, so streamed usage isn't asked for.
    request: { openAiCompatible: { includeUsage: false, supportsStructuredOutputs: false } },
    roles: {
      answers: "command-r-08-2024",
      strongest: "command-a-plus-05-2026",
      quickTasks: "command-r7b-12-2024",
    },
    dataUse: {
      training: "opt-out",
      summary: {
        en: "May train on prompts and replies unless you opt out; logs are kept up to 30 days.",
        zh: "可能用提示和回复训练，可选择退出；记录最多保留 30 天。",
      },
      url: "https://cohere.com/data-usage-policy",
    },
    checked: "2026-10-18",
  },
  {
    id: "venice",
    name: { en: "Venice", zh: "Venice" },
    support: "best-effort",
    group: "international",
    adapter: "openai-compatible",
    endpoints: [
      {
        id: "global",
        label: { en: "Global", zh: "全球" },
        baseUrl: "https://api.venice.ai/api/v1",
      },
    ],
    apiKey: "required",
    keyUrl: "https://venice.ai/settings/api",
    docsUrl: "https://docs.venice.ai/overview/getting-started",
    pricingUrl: "https://venice.ai/pricing",
    request: { openAiCompatible: { includeUsage: true, supportsStructuredOutputs: false } },
    roles: { answers: "deepseek-v4-flash-0731", quickTasks: "qwen3-5-9b" },
    dataUse: {
      training: "unknown",
      summary: {
        en: "Doesn't store or log prompts; some models are run by other companies that may see them.",
        zh: "不存储、不记录提示；部分模型由其他公司运行，对方可能看到。",
      },
      url: "https://docs.venice.ai/overview/privacy",
    },
    checked: "2026-10-18",
  },
  {
    id: "bedrock",
    name: { en: "Amazon Bedrock", zh: "Amazon Bedrock" },
    support: "best-effort",
    group: "international",
    adapter: "openai-compatible",
    endpoints: [
      {
        id: "global",
        label: { en: "Global", zh: "全球" },
        baseUrl: "https://bedrock-mantle.{region}.api.aws/v1",
        field: {
          name: "region",
          label: { en: "Region", zh: "区域" },
          hint: {
            en: "Use a long-term API key made in this region. A short-term key stops working within 12 hours.",
            zh: "请使用在这个区域创建的长期 API 密钥。短期密钥最长 12 小时后失效。",
          },
          choices: [
            {
              value: "us-east-1",
              label: { en: "US East (N. Virginia)", zh: "美国东部（弗吉尼亚北部）" },
            },
            { value: "us-east-2", label: { en: "US East (Ohio)", zh: "美国东部（俄亥俄）" } },
            { value: "us-west-2", label: { en: "US West (Oregon)", zh: "美国西部（俄勒冈）" } },
            { value: "eu-central-1", label: { en: "Europe (Frankfurt)", zh: "欧洲（法兰克福）" } },
            { value: "eu-north-1", label: { en: "Europe (Stockholm)", zh: "欧洲（斯德哥尔摩）" } },
            { value: "eu-south-1", label: { en: "Europe (Milan)", zh: "欧洲（米兰）" } },
            { value: "eu-west-1", label: { en: "Europe (Ireland)", zh: "欧洲（爱尔兰）" } },
            { value: "eu-west-2", label: { en: "Europe (London)", zh: "欧洲（伦敦）" } },
            {
              value: "ap-northeast-1",
              label: { en: "Asia Pacific (Tokyo)", zh: "亚太地区（东京）" },
            },
            { value: "ap-south-1", label: { en: "Asia Pacific (Mumbai)", zh: "亚太地区（孟买）" } },
            {
              value: "ap-southeast-2",
              label: { en: "Asia Pacific (Sydney)", zh: "亚太地区（悉尼）" },
            },
            {
              value: "ap-southeast-3",
              label: { en: "Asia Pacific (Jakarta)", zh: "亚太地区（雅加达）" },
            },
            {
              value: "sa-east-1",
              label: { en: "South America (São Paulo)", zh: "南美洲（圣保罗）" },
            },
          ],
        },
      },
    ],
    apiKey: "required",
    keyUrl: "https://console.aws.amazon.com/bedrock/home#/api-keys",
    docsUrl: "https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-mantle.html",
    pricingUrl: "https://aws.amazon.com/bedrock/pricing/",
    request: { openAiCompatible: { includeUsage: false, supportsStructuredOutputs: false } },
    roles: { answers: "openai.gpt-oss-120b", quickTasks: "openai.gpt-oss-20b" },
    dataUse: {
      training: "no",
      summary: {
        en: "Not used to train models or shared with their makers; some models are kept up to 30 days.",
        zh: "不用于训练，也不提供给模型开发方；部分模型最多保留 30 天。",
      },
      url: "https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html",
      sources: [
        "https://aws.amazon.com/bedrock/faqs/",
        "https://docs.aws.amazon.com/bedrock/latest/userguide/abuse-detection.html",
      ],
    },
    checked: "2026-10-18",
  },
  {
    id: "cloudflare",
    name: { en: "Cloudflare Workers AI", zh: "Cloudflare Workers AI" },
    support: "best-effort",
    group: "international",
    adapter: "openai-compatible",
    endpoints: [
      {
        id: "global",
        label: { en: "Global", zh: "全球" },
        baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1",
        field: {
          name: "account",
          label: { en: "Account ID", zh: "账户 ID" },
          hint: {
            en: "On the Workers AI page of the Cloudflare dashboard, under Use REST API.",
            zh: "在 Cloudflare 控制台的 Workers AI 页面，“使用 REST API”下可以找到。",
          },
          pattern: "[0-9a-f]{32}",
        },
      },
    ],
    apiKey: "required",
    keyUrl: "https://dash.cloudflare.com/profile/api-tokens",
    docsUrl: "https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/",
    pricingUrl: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
    request: { openAiCompatible: { includeUsage: false, supportsStructuredOutputs: false } },
    roles: {
      answers: "@cf/zai-org/glm-5.3-flash",
      strongest: "@cf/zai-org/glm-5.3",
      quickTasks: "@cf/zai-org/glm-4.7-flash",
    },
    dataUse: {
      training: "no",
      summary: {
        en: "Not used to train; not kept after the request, except what you store or the law requires.",
        zh: "不用于训练；请求结束后不保留，自行存储或法律要求的除外。",
      },
      url: "https://developers.cloudflare.com/workers-ai/platform/data-usage/",
    },
    checked: "2026-10-19",
  },
  {
    id: "lmstudio",
    name: { en: "LM Studio", zh: "LM Studio" },
    support: "best-effort",
    group: "local",
    adapter: "openai-compatible",
    endpoints: [
      {
        id: "local",
        label: { en: "On this computer", zh: "本机" },
        baseUrl: "http://{address}/v1",
        field: {
          name: "address",
          label: { en: "Address", zh: "地址" },
          pattern: "(?:[A-Za-z0-9.-]+|\\[[0-9A-Fa-f:]+\\])(?::[0-9]{1,5})?",
          default: "127.0.0.1:1234",
        },
      },
    ],
    // A token is needed only when the User turned on authentication in its server settings.
    apiKey: "optional",
    docsUrl: "https://lmstudio.ai/docs/developer/openai-compat",
    request: { openAiCompatible: { includeUsage: false, supportsStructuredOutputs: true } },
    roles: {},
    dataUse: {
      training: "no",
      summary: {
        en: "Runs on this computer: what you ask stays on it, unless you use a cloud model or search.",
        zh: "在本机运行，提问不会离开本机；使用云端模型或搜索则除外。",
      },
      url: "https://lmstudio.ai/app-privacy",
    },
    checked: "2026-10-18",
  },
  {
    id: "unsloth",
    name: { en: "Unsloth Studio", zh: "Unsloth Studio" },
    support: "best-effort",
    group: "local",
    adapter: "openai-compatible",
    endpoints: [
      {
        id: "local",
        label: { en: "On this computer", zh: "本机" },
        baseUrl: "http://{address}/v1",
        field: {
          name: "address",
          label: { en: "Address", zh: "地址" },
          pattern: "(?:[A-Za-z0-9.-]+|\\[[0-9A-Fa-f:]+\\])(?::[0-9]{1,5})?",
          default: "127.0.0.1:8888",
        },
      },
    ],
    apiKey: "required",
    keyUrl: "https://unsloth.ai/docs/basics/api",
    docsUrl: "https://unsloth.ai/docs/basics/api",
    request: { openAiCompatible: { includeUsage: false, supportsStructuredOutputs: false } },
    roles: {},
    dataUse: {
      training: "no",
      summary: {
        en: "Runs on this computer: what you ask stays on it, unless you use a cloud model or search.",
        zh: "在本机运行，提问不会离开本机；使用云端模型或搜索则除外。",
      },
      url: "https://unsloth.ai/docs/new/studio",
    },
    checked: "2026-10-18",
  },
];
