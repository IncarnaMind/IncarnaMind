/**
 * How each provider is paid for, beside its prices (./overrides, ./models.json):
 *
 * - "per-token": an API key billed per token, in the price's currency. Claude
 *   Max and Team credits are spent through an ordinary Anthropic key, so they
 *   count here too. So do Ollama's cloud models: their plans include usage
 *   priced per token, in dollars, and past it the same prices apply.
 * - "plan": the ChatGPT plan, whose own limits apply instead of a price.
 * - "free": a model on this computer.
 *
 * Only "per-token" requests are priced, reserved against the monthly cap and
 * estimated before large runs. A plan's requests (ChatGPT, a Claude account, Copilot) are counted, never priced.
 */
import type { Billing, ChatProviderKind, ExternalService } from "../../api";
import type { OffPeak, Price } from "./types";

export function billingOf(kind: ChatProviderKind, service: ExternalService | null): Billing {
  if (kind === "chatgpt" || kind === "claude-account" || kind === "copilot") return "plan";
  return service === null ? "free" : "per-token";
}

/** Where Ollama shows an account's usage and plan. */
export const OLLAMA_USAGE_URL = "https://ollama.com/settings";

export const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";

/** Yuan to the dollar, for counting spending in one currency against a cap in the other. */
export const CNY_PER_USD = 7.1;

/** Ollama's off-peak hours for DeepSeek: half price outside 12:00–18:00 UTC on weekdays. */
const OLLAMA_PEAK: OffPeak = { factor: 0.5, utcOffset: 0, peakHours: [[12, 18]] };

const usd = (input: number, cacheRead: number | undefined, output: number): Price => ({
  currency: "USD",
  input,
  output,
  ...(cacheRead !== undefined && { cacheRead }),
});

/** When Ollama's cloud prices below were checked against https://ollama.com/pricing. */
export const OLLAMA_CLOUD_PRICES_CHECKED = "2026-10-11";

/** Ollama's cloud models, per million tokens. Keys are the model's name without its cloud suffix. */
const OLLAMA_CLOUD_PRICES: Readonly<Record<string, Price>> = {
  "deepseek-v4.1-flash": { ...usd(0.3, 0.006, 1.2), offPeak: OLLAMA_PEAK },
  "deepseek-v4-pro": { ...usd(1.32, 0.044, 3.96), offPeak: OLLAMA_PEAK },
  gemma4: usd(0.14, 0.05, 0.4),
  "glm-5.3": usd(1.4, 0.26, 4.4),
  "glm-5.3-flash": usd(0.15, 0.03, 0.5),
  "glm-5.2": usd(1.4, 0.26, 4.4),
  "gpt-oss:120b": usd(0.15, 0.014, 0.6),
  "gpt-oss:20b": usd(0.07, 0.035, 0.3),
  "kimi-k3": usd(3, 0.3, 15),
  "kimi-k2.7-code": usd(0.95, 0.19, 4),
  "kimi-k2.6": usd(0.95, 0.16, 4),
  "minimax-m3": usd(0.6, 0.12, 2.4),
  "minimax-m2.7": usd(0.3, 0.06, 1.2),
  "mistral-large-4": usd(0.68, 0.07, 2.09),
  "mistral-large-3": usd(0.5, undefined, 1.5),
  "nemotron-3-nano": usd(0.06, undefined, 0.24),
  "nemotron-3-super": usd(0.015, 0.015, 0.6),
  "nemotron-3-ultra": usd(0.1, 0.1, 3),
};

/**
 * The price of an Ollama cloud model by its name in Ollama ("gpt-oss:120b-cloud",
 * "glm-5.3:cloud"): its exact name, else its family when Ollama prices only
 * one size of it ("gemma4:31b-cloud" is gemma4). Undefined when unknown.
 */
export function ollamaCloudPrice(modelId: string): Price | undefined {
  const name = modelId
    .trim()
    .toLowerCase()
    .replace(/[:-]cloud$/, "")
    .replace(/:latest$/, "");
  const exact = OLLAMA_CLOUD_PRICES[name];
  if (exact) return exact;
  const family = name.split(":")[0] ?? name;
  const sizes = Object.keys(OLLAMA_CLOUD_PRICES).filter(
    (each) => each === family || each.startsWith(`${family}:`),
  );
  return sizes.length === 1 && sizes[0] ? OLLAMA_CLOUD_PRICES[sizes[0]] : undefined;
}
