// Preloaded (node --import) into the nightly real-model run's processes (scripts/nightlyRealModel.ts)
// to count the tokens every model request used, the judge's and the checks' included, which the
// evaluations' own reports leave out. It writes one JSON line per request to NIGHTLY_USAGE_FILE,
// and never the request's headers or text.
import { appendFileSync } from "node:fs";

const HOSTS = new Set(["api.anthropic.com", "api.moonshot.ai"]);

export interface Usage {
  /** The prompt's tokens, those read from and written to the cache included. */
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

const last = (text: string, name: string): number => {
  const found = [...text.matchAll(new RegExp(`"${name}":\\s*(\\d+)`, "g"))];
  return Number(found.at(-1)?.[1] ?? 0);
};

/**
 * The tokens a response counted, whether it is one JSON body or a stream of events: the last count
 * of each kind wins, since a stream's later events hold the running totals. Anthropic's input count
 * leaves out the cache's, while OpenAI-compatible APIs' (Kimi) includes it.
 */
export function usageOf(text: string): Usage {
  const anthropic = text.includes('"input_tokens"');
  const cacheRead = last(text, "cache_read_input_tokens") || last(text, "cached_tokens");
  const cacheWrite = last(text, "cache_creation_input_tokens");
  return {
    inputTokens: anthropic
      ? last(text, "input_tokens") + cacheRead + cacheWrite
      : last(text, "prompt_tokens"),
    cachedInputTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: last(text, anthropic ? "output_tokens" : "completion_tokens"),
  };
}

const file = process.env.NIGHTLY_USAGE_FILE;
if (file) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await original(input, init);
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (HOSTS.has(url.host) && response.ok) {
      const model = /"model":\s*"([^"]+)"/.exec(
        typeof init?.body === "string" ? init.body : "",
      )?.[1];
      response
        .clone()
        .text()
        .then((text) => appendFileSync(file, `${JSON.stringify({ model, ...usageOf(text) })}\n`))
        // A request the caller cancels half way ends its copy of the stream too; it counted what it read.
        .catch(() => {});
    }
    return response;
  };
}
