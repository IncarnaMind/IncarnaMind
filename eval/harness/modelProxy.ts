/**
 * The model endpoint Codex is pointed at in the bake-off (README.md), on
 * 127.0.0.1. Codex 0.162 speaks only OpenAI's Responses API, so:
 *
 * - **OpenAI:** each request goes on to OpenAI as it came, and the stream
 *   comes back as it went; only the usage is read from it.
 * - **Anthropic:** each request is translated into one Messages API request
 *   and the reply back into the Responses API's stream. Claude's thinking
 *   blocks travel to Codex and back inside a reasoning item's
 *   `encrypted_content`, so a later step sends them back as they were.
 *   Prompt caching gets the breakpoints the app's own requests have: the
 *   system prompt, the last Tool and the last message.
 *
 * The provider's key stays in this process: Codex is given a token of its
 * own for each run, which names the run's log. Each request is logged
 * (`ProxyRecord`): the Tools offered, the calls the model made with their
 * arguments, the Tool results sent back and the usage, which is what the
 * adapter's check and the cost read.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isRecord } from "../../src/core/errors";

export type ProxyUpstream = "openai" | "anthropic";

export interface ProxyUsage {
  /** All input tokens, the cached ones too. */
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

/** One request through the proxy, as its run's log keeps it. */
export interface ProxyRecord {
  at: string;
  ms: number;
  status: number;
  /** The Tools Codex offered the model, by name. */
  tools: string[];
  /** The Tool calls the model made in its reply, as Codex was given them. */
  calls: { callId: string; name: string; arguments: string }[];
  /** The Tool results in the request, as Codex sent them. */
  results: { callId: string; output: string }[];
  usage: ProxyUsage;
  error: string | null;
}

// ---------------------------------------------------------------------------
// The Responses API, as much of it as Codex sends

type Json = Record<string, unknown>;

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
};

const outputText = (output: unknown): string =>
  typeof output === "string" ? output : textOf(output);

/** The Tool results a Responses request carries, by call. */
export function resultsIn(body: Json): ProxyRecord["results"] {
  const input = Array.isArray(body.input) ? body.input : [];
  return input.flatMap((item) =>
    isRecord(item) &&
    (item.type === "function_call_output" || item.type === "custom_tool_call_output") &&
    typeof item.call_id === "string"
      ? [{ callId: item.call_id, output: outputText(item.output) }]
      : [],
  );
}

/**
 * The Tools a request offers, by name, whatever their type: for the log only. Codex in Code
 * Mode sends them in an `additional_tools` input item instead of `tools`.
 */
export const toolNames = (body: Json): string[] =>
  [
    ...(Array.isArray(body.tools) ? body.tools : []),
    ...(Array.isArray(body.input) ? body.input : []).flatMap((item) =>
      isRecord(item) && item.type === "additional_tools" && Array.isArray(item.tools)
        ? item.tools
        : [],
    ),
  ].flatMap((tool) => {
    if (!isRecord(tool)) return [];
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      return tool.tools.map(
        (each) => `${String(tool.name)}__${isRecord(each) ? String(each.name) : ""}`,
      );
    }
    return [String(tool.name ?? tool.type)];
  });

/** A Tool the model is offered: Codex groups an MCP server's Tools in a namespace. */
export interface OfferedTool {
  namespace: string | null;
  name: string;
  description: string;
  parameters: Json;
}

/** The functions a request offers, by the one name each has for Claude: "mcp__incarnamind__search". */
export function flatTools(body: Json): Map<string, OfferedTool> {
  const flat = new Map<string, OfferedTool>();
  const add = (tool: Json, namespace: string | null) => {
    if (tool.type !== "function") {
      throw new Error(`The adapter doesn't know the Tool type "${String(tool.type)}".`);
    }
    const name = String(tool.name);
    flat.set(namespace ? `${namespace}__${name}` : name, {
      namespace,
      name,
      description: typeof tool.description === "string" ? tool.description : "",
      parameters: isRecord(tool.parameters) ? tool.parameters : { type: "object" },
    });
  };
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (!isRecord(tool)) continue;
    if (tool.type === "namespace") {
      const inner = Array.isArray(tool.tools) ? tool.tools : [];
      for (const each of inner) if (isRecord(each)) add(each, String(tool.name));
    } else {
      add(tool, null);
    }
  }
  return flat;
}

/** What each namespace says of its Tools: an MCP server's instructions. */
const namespaceNotes = (body: Json): string[] =>
  (Array.isArray(body.tools) ? body.tools : []).flatMap((tool) =>
    isRecord(tool) &&
    tool.type === "namespace" &&
    typeof tool.description === "string" &&
    tool.description
      ? [`The Tools named ${String(tool.name)}__…:\n${tool.description}`]
      : [],
  );

// ---------------------------------------------------------------------------
// Responses → Messages

interface AnthropicBlock extends Json {
  type: string;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

/** Claude's own effort levels, for the Responses API's. */
const EFFORT: Record<string, string> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
};

const MAX_TOKENS = 32_000;
const CACHE = { type: "ephemeral" } as const;

/** Claude's thinking blocks, as a reasoning item carries them to Codex and back. */
const sealThinking = (blocks: readonly AnthropicBlock[]) =>
  Buffer.from(JSON.stringify(blocks)).toString("base64");

function unsealThinking(sealed: unknown): AnthropicBlock[] {
  if (typeof sealed !== "string") return [];
  try {
    const blocks: unknown = JSON.parse(Buffer.from(sealed, "base64").toString("utf8"));
    return Array.isArray(blocks)
      ? blocks.filter(
          (block): block is AnthropicBlock =>
            isRecord(block) && (block.type === "thinking" || block.type === "redacted_thinking"),
        )
      : [];
  } catch {
    return [];
  }
}

function parseArguments(text: unknown): Json {
  if (typeof text !== "string" || text.trim() === "") return {};
  const parsed: unknown = JSON.parse(text);
  return isRecord(parsed) ? parsed : {};
}

/**
 * The Messages API request for a Responses API request: the instructions
 * and the developer messages before the conversation become the system
 * prompt; later developer messages are the User's turn, marked as such.
 * Throws on an input item it doesn't know, so a run never goes on with
 * part of its context dropped.
 */
export function toMessagesRequest(body: Json): Json {
  const offered = flatTools(body);
  const system: string[] = typeof body.instructions === "string" ? [body.instructions] : [];
  const messages: AnthropicMessage[] = [];
  const push = (role: AnthropicMessage["role"], blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return;
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  let thinking: AnthropicBlock[] = [];
  const input = Array.isArray(body.input) ? body.input : [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    const type = item.type ?? "message";
    if (type === "message") {
      const text = textOf(item.content);
      if (item.role === "developer" || item.role === "system") {
        if (messages.length === 0) system.push(text);
        else if (text) push("user", [{ type: "text", text: `[developer]\n${text}` }]);
      } else if (item.role === "assistant") {
        if (text) push("assistant", [...thinking, { type: "text", text }]);
        thinking = [];
      } else if (text) {
        push("user", [{ type: "text", text }]);
      }
    } else if (type === "reasoning") {
      thinking.push(...unsealThinking(item.encrypted_content));
    } else if (type === "function_call") {
      push("assistant", [
        ...thinking,
        {
          type: "tool_use",
          id: String(item.call_id),
          name:
            typeof item.namespace === "string" && item.namespace
              ? `${item.namespace}__${String(item.name)}`
              : String(item.name),
          input: parseArguments(item.arguments),
        },
      ]);
      thinking = [];
    } else if (type === "function_call_output") {
      push("user", [
        {
          type: "tool_result",
          tool_use_id: String(item.call_id),
          content: outputText(item.output) || "(no output)",
        },
      ]);
    } else {
      throw new Error(`The adapter doesn't know the input item "${String(type)}".`);
    }
  }
  system.push(...namespaceNotes(body));
  const tools: Json[] = [...offered].map(([name, tool]) => ({
    name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
  const lastTool = tools.at(-1);
  if (lastTool) lastTool.cache_control = CACHE;
  const lastBlock = messages.at(-1)?.content.at(-1);
  if (lastBlock) lastBlock.cache_control = CACHE;
  const reasoning = isRecord(body.reasoning) ? body.reasoning : {};
  const effort = EFFORT[String(reasoning.effort ?? "")];
  const choice =
    body.tool_choice === "required"
      ? { type: "any" }
      : body.tool_choice === "none"
        ? { type: "none" }
        : { type: "auto" };
  return {
    model: body.model,
    max_tokens: MAX_TOKENS,
    system: system
      .filter(Boolean)
      .map((text, index, all) =>
        index === all.length - 1
          ? { type: "text", text, cache_control: CACHE }
          : { type: "text", text },
      ),
    messages,
    ...(tools.length > 0 && {
      tools,
      tool_choice: {
        ...choice,
        ...(body.parallel_tool_calls === false && { disable_parallel_tool_use: true }),
      },
    }),
    thinking: { type: "adaptive", display: "summarized" },
    ...(effort && { output_config: { effort } }),
  };
}

// ---------------------------------------------------------------------------
// Messages → Responses

/** A Messages API reply as the Responses API's output items, in order. */
export function toResponsesOutput(reply: Json, offered: ReadonlyMap<string, OfferedTool>): Json[] {
  const content = Array.isArray(reply.content) ? reply.content : [];
  const items: Json[] = [];
  let thinking: AnthropicBlock[] = [];
  let text = "";
  const flushThinking = () => {
    if (thinking.length === 0) return;
    items.push({
      type: "reasoning",
      id: `rs_${items.length}`,
      summary: thinking.flatMap((block) =>
        typeof block.thinking === "string" && block.thinking
          ? [{ type: "summary_text", text: block.thinking }]
          : [],
      ),
      encrypted_content: sealThinking(thinking),
    });
    thinking = [];
  };
  const flushText = () => {
    if (!text) return;
    items.push({
      type: "message",
      id: `msg_${items.length}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    });
    text = "";
  };
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      flushText();
      thinking.push(
        block.type === "thinking"
          ? { type: "thinking", thinking: block.thinking, signature: block.signature }
          : { type: "redacted_thinking", data: block.data },
      );
    } else if (block.type === "text") {
      flushThinking();
      text += typeof block.text === "string" ? block.text : "";
    } else if (block.type === "tool_use") {
      flushThinking();
      flushText();
      const tool = offered.get(String(block.name));
      items.push({
        type: "function_call",
        id: `fc_${items.length}`,
        call_id: String(block.id),
        name: tool?.name ?? String(block.name),
        ...(tool?.namespace && { namespace: tool.namespace }),
        arguments: JSON.stringify(block.input ?? {}),
        status: "completed",
      });
    }
  }
  flushThinking();
  flushText();
  return items;
}

export function anthropicUsage(reply: Json): ProxyUsage {
  const usage = isRecord(reply.usage) ? reply.usage : {};
  const count = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
  const cached = count("cache_read_input_tokens");
  const written = count("cache_creation_input_tokens");
  return {
    inputTokens: count("input_tokens") + cached + written,
    cachedInputTokens: cached,
    cacheWriteTokens: written,
    outputTokens: count("output_tokens"),
  };
}

/** The Responses API's stream for a whole reply, event by event. */
export function responsesEvents(
  id: string,
  model: unknown,
  items: Json[],
  usage: ProxyUsage,
): Json[] {
  const response = (status: string, output: Json[]) => ({
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
  });
  const events: Json[] = [{ type: "response.created", response: response("in_progress", []) }];
  items.forEach((item, index) => {
    const opening =
      item.type === "message"
        ? { ...item, status: "in_progress", content: [] }
        : item.type === "function_call"
          ? { ...item, status: "in_progress", arguments: "" }
          : { ...item, summary: [] };
    events.push({ type: "response.output_item.added", output_index: index, item: opening });
    if (item.type === "message") {
      const part = (Array.isArray(item.content) ? item.content[0] : null) as Json | null;
      const text = typeof part?.text === "string" ? part.text : "";
      const at = { item_id: item.id, output_index: index, content_index: 0 };
      events.push(
        {
          type: "response.content_part.added",
          ...at,
          part: { type: "output_text", text: "", annotations: [] },
        },
        { type: "response.output_text.delta", ...at, delta: text },
        { type: "response.output_text.done", ...at, text },
        { type: "response.content_part.done", ...at, part },
      );
    } else if (item.type === "function_call") {
      const at = { item_id: item.id, output_index: index };
      events.push(
        { type: "response.function_call_arguments.delta", ...at, delta: item.arguments },
        { type: "response.function_call_arguments.done", ...at, arguments: item.arguments },
      );
    }
    events.push({ type: "response.output_item.done", output_index: index, item });
  });
  events.push({
    type: "response.completed",
    response: {
      ...response("completed", items),
      usage: {
        input_tokens: usage.inputTokens,
        input_tokens_details: { cached_tokens: usage.cachedInputTokens },
        output_tokens: usage.outputTokens,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: usage.inputTokens + usage.outputTokens,
      },
    },
  });
  return events.map((event, sequence) => ({ ...event, sequence_number: sequence }));
}

const sse = (event: Json) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;

/** The usage in a Responses API stream's `response.completed` event, as OpenAI sends it. */
export function openAiUsage(stream: string): ProxyUsage | null {
  for (const line of stream.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event: unknown;
    try {
      event = JSON.parse(line.slice(5));
    } catch {
      continue;
    }
    if (!isRecord(event) || event.type !== "response.completed" || !isRecord(event.response))
      continue;
    const usage = isRecord(event.response.usage) ? event.response.usage : {};
    const details = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
    const number = (value: unknown) => (typeof value === "number" ? value : 0);
    return {
      inputTokens: number(usage.input_tokens),
      cachedInputTokens: number(details.cached_tokens),
      cacheWriteTokens: 0,
      outputTokens: number(usage.output_tokens),
    };
  }
  return null;
}

/** A function call as the log keeps it, named with its namespace. */
const callOf = (item: Json): ProxyRecord["calls"][number] => ({
  callId: String(item.call_id),
  name:
    typeof item.namespace === "string" && item.namespace
      ? `${item.namespace}__${String(item.name)}`
      : String(item.name),
  arguments: String(item.type === "custom_tool_call" ? item.input : item.arguments),
});

/** The calls in a Responses API stream, from its `response.output_item.done` events. */
export function callsInStream(stream: string): ProxyRecord["calls"] {
  const calls: ProxyRecord["calls"] = [];
  for (const line of stream.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event: unknown;
    try {
      event = JSON.parse(line.slice(5));
    } catch {
      continue;
    }
    if (!isRecord(event) || event.type !== "response.output_item.done" || !isRecord(event.item))
      continue;
    if (event.item.type === "function_call" || event.item.type === "custom_tool_call") {
      calls.push(callOf(event.item));
    }
  }
  return calls;
}

// ---------------------------------------------------------------------------
// The server

const NO_USAGE: ProxyUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
};

export interface ModelProxy {
  /** Codex's `base_url`. */
  baseUrl: string;
  upstream: ProxyUpstream;
  /** A token for one run, whose requests go to `logFile`. */
  tokenFor(logFile: string): string;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/** Asks the provider again after a rate limit or an overload, as its SDKs do. */
async function fetchWithRetries(url: string, init: RequestInit, tries = 4): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, init);
    if (attempt >= tries || ![429, 500, 502, 503, 529].includes(response.status)) return response;
    await response.body?.cancel();
    await new Promise((done) => setTimeout(done, 2_000 * 2 ** (attempt - 1)));
  }
}

export async function startModelProxy(options: {
  upstream: ProxyUpstream;
  apiKey: string;
  baseUrl?: string;
  /** Also keep each request's body, next to the run's log, for looking into the adapter by hand. */
  keepRequests?: boolean;
}): Promise<ModelProxy> {
  const logs = new Map<string, string>();
  const upstreamUrl =
    options.baseUrl ??
    (options.upstream === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com/v1");

  const log = (file: string, record: ProxyRecord) =>
    appendFileSync(file, `${JSON.stringify(record)}\n`);

  async function forwardToOpenAi(
    body: string,
    parsed: Json,
    response: ServerResponse,
    file: string,
  ) {
    const started = performance.now();
    const upstream = await fetchWithRetries(`${upstreamUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body,
    });
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
    });
    let seen = "";
    const reader = upstream.body?.getReader();
    const decoder = new TextDecoder();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      response.write(value);
      seen += decoder.decode(value, { stream: true });
    }
    response.end();
    log(file, {
      at: new Date().toISOString(),
      ms: Math.round(performance.now() - started),
      status: upstream.status,
      tools: toolNames(parsed),
      calls: callsInStream(seen),
      results: resultsIn(parsed),
      usage: openAiUsage(seen) ?? NO_USAGE,
      error: upstream.ok ? null : seen.slice(0, 500),
    });
  }

  async function translateToAnthropic(parsed: Json, response: ServerResponse, file: string) {
    const started = performance.now();
    const record: ProxyRecord = {
      at: new Date().toISOString(),
      ms: 0,
      status: 200,
      tools: toolNames(parsed),
      calls: [],
      results: resultsIn(parsed),
      usage: NO_USAGE,
      error: null,
    };
    try {
      const upstream = await fetchWithRetries(`${upstreamUrl}/messages`, {
        method: "POST",
        headers: {
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(toMessagesRequest(parsed)),
      });
      const text = await upstream.text();
      record.status = upstream.status;
      if (!upstream.ok) {
        record.error = text.slice(0, 500);
        response.writeHead(upstream.status === 529 ? 503 : upstream.status, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify({ error: { message: text.slice(0, 500), type: "upstream_error" } }),
        );
        return;
      }
      const reply = JSON.parse(text) as Json;
      const items = toResponsesOutput(reply, flatTools(parsed));
      record.usage = anthropicUsage(reply);
      record.calls = items.flatMap((item) => (item.type === "function_call" ? [callOf(item)] : []));
      response.writeHead(200, { "content-type": "text/event-stream" });
      const id = `resp_${randomBytes(8).toString("hex")}`;
      for (const event of responsesEvents(id, parsed.model, items, record.usage)) {
        response.write(sse(event));
      }
      response.end();
    } catch (error) {
      record.status = 400;
      record.error = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: record.error, type: "adapter_error" } }));
      }
    } finally {
      record.ms = Math.round(performance.now() - started);
      log(file, record);
    }
  }

  const server: Server = createServer((request, response) => {
    const token = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const file = logs.get(token);
    if (!file) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Unknown token.", type: "auth" } }));
      return;
    }
    if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "Only POST /responses.", type: "not_found" } }),
      );
      return;
    }
    readBody(request)
      .then((body) => {
        const parsed = JSON.parse(body) as Json;
        if (options.keepRequests) appendFileSync(`${file}.requests`, `${body}\n`);
        return options.upstream === "openai"
          ? forwardToOpenAi(body, parsed, response, file)
          : translateToAnthropic(parsed, response, file);
      })
      .catch((error: unknown) => {
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: error instanceof Error ? error.message : String(error),
              type: "proxy",
            },
          }),
        );
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    upstream: options.upstream,
    tokenFor(logFile) {
      const token = randomBytes(24).toString("base64url");
      logs.set(token, logFile);
      return token;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
