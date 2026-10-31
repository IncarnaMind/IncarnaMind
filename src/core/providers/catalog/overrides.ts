/**
 * Hand-written corrections to the generated model facts (./models.json), for
 * what models.dev doesn't say or says too coarsely. A model's own entry wins
 * over its provider's. Each says why; tests check that every model named here
 * is in the generated facts.
 *
 * Keys are model sets: a provider's id, or "<provider>/<endpoint>" for a
 * region whose models differ (see ./index). The sets whose source gives prices
 * only in US dollars (the Chinese regions of providers that bill in yuan) have
 * their yuan prices here, from the providers' own price pages.
 */
import { CLAUDE_BETWEEN_TOOLS, CLAUDE_LOW_EFFORT } from "./providers";
import type { CatalogOverrides, OffPeak, Price } from "./types";

/** A price in yuan per million tokens. */
const yuan = (
  input: number,
  output: number,
  cacheRead?: number,
  note?: Price["note"],
  offPeak?: OffPeak,
): Price => ({
  currency: "CNY",
  input,
  output,
  ...(cacheRead !== undefined && { cacheRead }),
  ...(note && { note }),
  ...(offPeak && { offPeak }),
});

/** DeepSeek's peak: weekdays 09:00–12:00 and 14:00–18:00 Beijing time; half price otherwise. */
const DEEPSEEK_PEAK: OffPeak = {
  factor: 0.5,
  utcOffset: 8,
  peakHours: [
    [9, 12],
    [14, 18],
  ],
};

/** Kimi fixes its sampling (any other temperature is an error) and rejects a forced Tool choice. */
const KIMI = { temperature: false, forcedToolChoice: false } as const;

/** GLM takes JSON mode but no JSON schema, and only automatic Tool choice. */
const GLM = { structuredOutput: "json_object", forcedToolChoice: false } as const;

export const OVERRIDES: CatalogOverrides = {
  cannotAnswer: {
    openai: {
      // Background research through the Responses API, not a chat: https://developers.openai.com/api/docs/guides/deep-research
      "o3-deep-research": "deep-research",
      "o4-mini-deep-research": "deep-research",
      // Drives a computer through the Responses API's computer tool: https://developers.openai.com/api/docs/guides/tools-computer-use
      "computer-use-preview": "computer-use",
    },
  },
  providers: {
    // Measured using the calculate Tool well (#438: Claude Haiku 5.5, GPT-6 Luna); the ChatGPT plan
    // serves OpenAI's models. Every other provider stays off until the evaluation (#441) says.
    anthropic: { calculates: true, toolsEveryRequest: true },
    openai: { calculates: true },
    // Google asks for its Gemini 3 models to run at their default temperature: lower makes
    // them loop or reason worse.
    google: { temperature: false },
    // DeepSeek takes JSON mode only (its prompt must say "json"), and answers 400 to a forced
    // Tool choice while it thinks, which it does by default; then it ignores the temperature.
    deepseek: { structuredOutput: "json_object", forcedToolChoice: false, temperature: false },
    // Qwen thinks by default, and a forced Tool choice fails while it does.
    qwen: { forcedToolChoice: false },
    "qwen/intl": { forcedToolChoice: false },
    kimi: KIMI,
    "kimi/intl": KIMI,
    glm: GLM,
    "glm/intl": GLM,
  },
  models: {
    anthropic: {
      // Measured 2026-10-15 (#907): these refuse `thinking: disabled`, and some a forced Tool choice.
      "claude-fable-5": { thinkingOff: CLAUDE_LOW_EFFORT },
      "claude-fable-5-1": { forcedToolChoice: false, thinkingOff: CLAUDE_LOW_EFFORT },
      "claude-opus-5-5": { forcedToolChoice: false, thinkingOff: CLAUDE_LOW_EFFORT },
      "claude-sonnet-5-5": { forcedToolChoice: false, thinkingOff: CLAUDE_BETWEEN_TOOLS },
    },
    openai: {
      // It calls functions (OpenAI's docs, and LiteLLM); models.dev says it doesn't.
      "gpt-3.5-turbo": { tools: true },
    },
    google: {
      "gemini-3.8-flash": {
        price: {
          currency: "USD",
          input: 0.75,
          output: 3.75,
          cacheRead: 0.075,
          note: { en: "From 2027-01-01: $1.50 / $7.50", zh: "2027-01-01 起：$1.50 / $7.50" },
        },
      },
    },
    xai: {
      // xAI bills a prompt that reaches 200K tokens at the higher prices (docs.x.ai/docs/models);
      // models.dev's tier starts above it. Written here, these prices don't follow a refresh.
      "grok-4.3": {
        price: {
          currency: "USD",
          input: 1.25,
          output: 2.5,
          cacheRead: 0.2,
          tiers: [{ above: 199_999, input: 2.5, output: 5, cacheRead: 0.4 }],
        },
      },
      "grok-4.7": {
        price: {
          currency: "USD",
          input: 2,
          output: 6,
          cacheRead: 0.5,
          tiers: [{ above: 199_999, input: 4, output: 12, cacheRead: 1 }],
        },
      },
    },
    mistral: {
      // Strict JSON schema works on Mistral's current models (its docs); models.dev leaves this one out.
      "mistral-small-2603": { structuredOutput: "json_schema" },
    },
    deepseek: {
      // The peak price, from the Chinese price page; the rest of the day it is half.
      "deepseek-flash": {
        price: yuan(
          2,
          8,
          0.04,
          {
            en: "Half outside weekdays 09:00–12:00 and 14:00–18:00 Beijing time: ¥1 / ¥4",
            zh: "非北京时间工作日 9:00–12:00、14:00–18:00 的时段为半价：¥1 / ¥4",
          },
          DEEPSEEK_PEAK,
        ),
      },
      "deepseek-v4-pro": {
        price: yuan(
          9,
          27,
          0.3,
          {
            en: "Half outside weekdays 09:00–12:00 and 14:00–18:00 Beijing time: ¥4.5 / ¥13.5",
            zh: "非北京时间工作日 9:00–12:00、14:00–18:00 的时段为半价：¥4.5 / ¥13.5",
          },
          DEEPSEEK_PEAK,
        ),
      },
    },
    qwen: {
      // Beijing, from Alibaba Cloud's price page, where K is 1,000. A cache hit is the implicit
      // cache's, 20% of the input price: requests to Qwen carry no explicit cache marks.
      "qwen3.7-plus": {
        structuredOutput: "json_schema",
        price: {
          ...yuan(2, 8, 0.4),
          tiers: [{ above: 256_000, input: 6, output: 24, cacheRead: 1.2 }],
        },
      },
      "qwen3.7-flash": {
        price: {
          ...yuan(0.2, 0.8, 0.04),
          tiers: [
            { above: 32_000, input: 0.6, output: 2.4, cacheRead: 0.12 },
            { above: 256_000, input: 1.2, output: 4.8, cacheRead: 0.24 },
          ],
        },
      },
      "qwen3.8-max": { price: yuan(12, 36) },
      "qwen3.8-flash": { price: yuan(0.8, 2.7) },
    },
    kimi: {
      "kimi-k2.6": { price: yuan(6.5, 27, 1.1) },
      "kimi-k3": { price: yuan(20, 100, 2) },
    },
    glm: {
      "glm-5.3": { price: yuan(8, 28) },
      "glm-5.3-flash": { price: yuan(0.8, 2.8) },
      // Free, text only.
      "glm-4.7-flash": { price: yuan(0, 0) },
    },
    siliconflow: {
      "deepseek-ai/DeepSeek-V4-Flash": {
        price: yuan(
          3,
          9,
          undefined,
          { en: "From 02:00 to 08:00: ¥1.5 / ¥4.5", zh: "凌晨 2 点至 8 点：¥1.5 / ¥4.5" },
          {
            factor: 0.5,
            utcOffset: 8,
            peakHours: [
              [0, 2],
              [8, 24],
            ],
            everyDay: true,
          },
        ),
      },
      // Free.
      "Qwen/Qwen3-8B": { price: yuan(0, 0) },
    },
  },
};
