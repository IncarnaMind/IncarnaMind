/**
 * Web search through the provider of the model an Answer is asked with
 * (#128): Anthropic's, OpenAI's (also the ChatGPT plan's) and OpenRouter's
 * bounded server search (../../shared/webSearch).
 *
 * A search is one request with the provider's tool forced and used once: the
 * provider runs it and returns the pages it found. Only their addresses,
 * titles and dates are kept. What the model writes after is dropped, so an
 * Answer learns nothing from the web but the pages it saves and reads.
 *
 * Not built for the other first-class providers (checked 2026-10-12):
 * Google's terms for grounding with Google Search forbid storing grounded
 * results or showing them with other content; Qwen's search isn't in its AI SDK
 * provider; Ollama's is a separate API on an Ollama account; DeepSeek and SiliconFlow have none.
 */
import { jsonSchema, streamText, tool } from "ai";
import { normaliseAddress } from "../../shared/webAddresses";
import type { ChatProviderKind, Money } from "../api";
import type { ChatLanguageModel } from "./models";

/** A page a web search found. */
export interface WebResult {
  /** http or https, without its fragment. */
  url: string;
  title: string | null;
  /** How old the provider says the page is ("3 days ago", "March 3, 2026"); null when it doesn't. */
  age: string | null;
}

/** The name the search tool goes by in the request. */
const TOOL = "web_search";

/** Pages one search gives an Answer, at most. */
export const MAX_RESULTS = 10;

/**
 * Room for what the model writes after searching: OpenAI's reasoning models
 * count their reasoning in it too, and a search cut off before it is made finds nothing.
 */
const OUTPUT_TOKENS = 2_048;

const INSTRUCTIONS =
  "Search the web once for what the User asks, as they asked it. Then reply with the single word: done.";

/**
 * Each provider's web search tool, by its id in the AI SDK, its settings
 * there (used once a request), and what one search costs on top of its
 * tokens. OpenRouter's Exa search costs $7 per 1,000; the others cost $10
 * (the providers' pricing pages, checked 2026-10-30). Pages read also count as input tokens.
 */
const SEARCH_TOOLS: Partial<
  Record<ChatProviderKind, { id: `${string}.${string}`; args: Record<string, unknown>; fee: Money }>
> = {
  anthropic: {
    id: "anthropic.web_search_20250305",
    args: { maxUses: 1 },
    fee: { currency: "USD", amount: 0.01 },
  },
  openai: { id: "openai.web_search", args: {}, fee: { currency: "USD", amount: 0.01 } },
  chatgpt: { id: "openai.web_search", args: {}, fee: { currency: "USD", amount: 0.01 } },
  openrouter: {
    id: "openrouter.web_search",
    args: {
      parameters: {
        engine: "exa",
        max_uses: 1,
        max_results: MAX_RESULTS,
        max_total_results: MAX_RESULTS,
      },
    },
    fee: { currency: "USD", amount: 0.007 },
  },
};

/** What one search costs with a provider of this kind; undefined for one with no web search. */
export const searchFeeOf = (kind: ChatProviderKind): Money | undefined => SEARCH_TOOLS[kind]?.fee;

/** What one search with a provider's tool costs, by the tool's id; undefined for any other tool. */
export const searchFee = (toolId: string): Money | undefined =>
  Object.values(SEARCH_TOOLS).find((each) => each.id === toolId)?.fee;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/**
 * The pages in what the search tool returned: Anthropic's list of results
 * (`url`, `title`, `pageAge`), or OpenAI's action with its `sources`.
 */
function resultPages(output: unknown): WebResult[] {
  const listed = Array.isArray(output)
    ? output
    : isRecord(output) && Array.isArray(output.sources)
      ? output.sources
      : [];
  return listed.flatMap((each): WebResult[] => {
    if (!isRecord(each) || typeof each.url !== "string") return [];
    return [{ url: each.url, title: text(each.title), age: text(each.pageAge) }];
  });
}

const ageOf = (metadata: unknown): string | null =>
  isRecord(metadata) && isRecord(metadata.anthropic) ? text(metadata.anthropic.pageAge) : null;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Searches the web with `model`'s provider, whose `kind` says which tool to
 * use: the pages found, in the provider's order, each once. Rejects when the
 * provider has no web search, refuses the request, or the search fails.
 */
export async function searchWeb(
  model: ChatLanguageModel,
  kind: ChatProviderKind,
  query: string,
  signal: AbortSignal,
): Promise<WebResult[]> {
  const search = SEARCH_TOOLS[kind];
  if (!search) throw new Error(`${kind} has no web search of its own.`);
  const found = new Map<string, WebResult>();
  const add = (page: WebResult) => {
    const url = normaliseAddress(page.url);
    if (!url) return;
    const known = found.get(url);
    found.set(url, {
      url,
      title: known?.title ?? page.title,
      age: known?.age ?? page.age,
    });
  };
  const result = streamText({
    model,
    instructions: INSTRUCTIONS,
    prompt: query,
    tools: {
      [TOOL]: tool({
        type: "provider",
        id: search.id,
        args: search.args,
        isProviderExecuted: true,
        inputSchema: jsonSchema({ type: "object" }),
      }),
    },
    toolChoice: kind === "openrouter" ? "auto" : { type: "tool", toolName: TOOL },
    maxOutputTokens: OUTPUT_TOKENS,
    // OpenRouter executes search without returning a Tool-call part; keep its forced choice on
    // the wire without the SDK requiring a client-visible call (#2248).
    providerOptions:
      kind === "openrouter"
        ? { openrouter: { tool_choice: "required" } }
        : { openai: { maxToolCalls: 1 } },
    abortSignal: signal,
    // Errors arrive as stream parts; don't also log them.
    onError: () => undefined,
  });
  for await (const part of result.fullStream) {
    if (part.type === "source" && part.sourceType === "url") {
      add({ url: part.url, title: text(part.title), age: ageOf(part.providerMetadata) });
    } else if (part.type === "tool-result" && part.toolName === TOOL) {
      for (const page of resultPages(part.output)) add(page);
    } else if (part.type === "tool-error" && part.toolName === TOOL) {
      throw new Error(`The web search failed: ${messageOf(part.error)}`);
    } else if (part.type === "error") {
      throw part.error;
    }
  }
  return [...found.values()].slice(0, MAX_RESULTS);
}
