import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

export interface OllamaStub {
  baseUrl: string;
  /** Bodies of every POST /api/pull, parsed. */
  pulls: unknown[];
}

const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });

/**
 * A tiny local HTTP server that speaks just enough of Ollama's API:
 * `/api/tags` lists `models` (with their `capabilities`, as Ollama 0.40 does,
 * where given), and `/api/pull` streams `pullLines` as newline-delimited
 * JSON, a few milliseconds apart. Stopped when the test finishes.
 */
export async function startOllamaStub(
  options: {
    models?: string[];
    capabilities?: Record<string, string[]>;
    pullLines?: object[];
  } = {},
): Promise<OllamaStub> {
  const { models = [], capabilities = {}, pullLines = [] } = options;
  const pulls: unknown[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/api/tags") {
      response.writeHead(200, { "content-type": "application/json" });
      const listed = models.map((name) => ({
        name,
        model: name,
        ...(capabilities[name] && { capabilities: capabilities[name] }),
      }));
      response.end(JSON.stringify({ models: listed }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/pull") {
      pulls.push(JSON.parse(await readBody(request)));
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      for (const line of pullLines) {
        response.write(`${JSON.stringify(line)}\n`);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      response.end();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, pulls };
}

/**
 * A tiny local OpenAI-compatible server that only lists models, at
 * `GET /v1/models`. Records the Authorization header of each request.
 */
export async function startModelListStub(
  ids: string[],
): Promise<{ baseUrl: string; authorizations: (string | undefined)[] }> {
  const authorizations: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      authorizations.push(request.headers.authorization);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: ids.map((id) => ({ id })) }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, authorizations };
}

/** A URL where nothing is listening. */
export async function unusedLocalUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/** A model the Ollama server stub has, as `/api/tags` and `/api/show` describe it. */
export interface OllamaModelStub {
  name: string;
  capabilities?: string[];
  /** Bytes on disk. */
  size?: number;
  digest?: string;
  /** `/api/show`'s `model_info`. */
  modelInfo?: Record<string, unknown>;
  /** Listed in `/api/tags` as running on ollama.com (`remote_host`). */
  remote?: boolean;
  /** `/api/show`'s `thinking`. */
  thinking?: { values: boolean[]; default: boolean };
}

/** What the stub's model replies to one chat request. */
export interface OllamaChatReply {
  content?: string;
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
  /** Lines streamed before the content that the provider can't read as a chunk. */
  unreadable?: string[];
  /** The reply reached `num_predict`: it ends there, cut off (`done_reason: "length"`). */
  cutOff?: boolean;
}

/** One chat request the stub got, and what became of it. */
export interface OllamaChatRequest {
  body: Record<string, unknown>;
  /** Its tokens, by the stub's count. */
  tokens: number;
  /** Refused as longer than `options.num_ctx` (sent with `truncate: false`). */
  refused: boolean;
  /** Cut to fit, without a word, as Ollama does when `truncate` isn't false. */
  cut: boolean;
}

export interface OllamaServer {
  baseUrl: string;
  chats: OllamaChatRequest[];
  /** What `/api/ps` lists: the models loaded, with their window. Tests may change it. */
  loaded: { name: string; context_length: number }[];
}

/**
 * A local HTTP server that speaks enough of Ollama's own API for chat:
 * `/api/tags`, `/api/show`, `/api/ps` and `/api/chat` (streamed as
 * newline-delimited JSON, or not). Like Ollama, it counts each chat request's
 * tokens (`countTokens`, by default one per four characters of its messages
 * and Tools), and a request over `options.num_ctx` (4,096 without one) is
 * refused with Ollama's error when it says `truncate: false`, and else cut
 * without a word. A request it answers loads its model into `/api/ps`,
 * taking `loadMs` when the model isn't loaded with that window yet.
 */
export async function startOllamaServer(options: {
  models: OllamaModelStub[];
  reply: (body: Record<string, unknown>, index: number) => OllamaChatReply;
  countTokens?: (body: Record<string, unknown>) => number;
  loadMs?: number;
}): Promise<OllamaServer> {
  const count =
    options.countTokens ??
    ((body) => Math.ceil(JSON.stringify([body.messages, body.tools ?? []]).length / 4));
  const chats: OllamaChatRequest[] = [];
  const loaded: OllamaServer["loaded"] = [];
  const find = (name: unknown) =>
    options.models.find((model) => model.name === name || model.name === `${String(name)}:latest`);
  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/api/tags") {
      json(response, 200, {
        models: options.models.map((model) => ({
          name: model.name,
          model: model.name,
          size: model.size ?? 2_000_000_000,
          digest: model.digest ?? `digest-of-${model.name}`,
          details: {},
          capabilities: model.capabilities,
          ...(model.remote && { remote_host: "https://ollama.com:443", remote_model: model.name }),
        })),
      });
      return;
    }
    if (request.method === "GET" && request.url === "/api/ps") {
      json(response, 200, {
        models: loaded.map((model) => ({ ...model, model: model.name })),
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/show") {
      const model = find(JSON.parse(await readBody(request)).model);
      if (!model) {
        json(response, 404, { error: "model not found" });
        return;
      }
      json(response, 200, {
        capabilities: model.capabilities,
        model_info: model.modelInfo ?? {},
        ...(model.thinking && { thinking: model.thinking }),
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/chat") {
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      const model = find(body.model);
      if (!model) {
        json(response, 404, {
          error: `model "${String(body.model)}" not found, try pulling it first`,
        });
        return;
      }
      const settings = (body.options ?? {}) as Record<string, unknown>;
      const window = typeof settings.num_ctx === "number" ? settings.num_ctx : 4_096;
      const tokens = count(body);
      const over = tokens > window;
      const chat: OllamaChatRequest = {
        body,
        tokens,
        refused: over && body.truncate === false,
        cut: over && body.truncate !== false,
      };
      chats.push(chat);
      if (chat.refused) {
        // Ollama's own words, the runner's JSON error inside its error string.
        json(response, 400, {
          error: JSON.stringify({
            error: {
              code: 400,
              message: `request (${tokens} tokens) exceeds the available context size (${window} tokens), try increasing it`,
              type: "exceed_context_size_error",
              n_prompt_tokens: tokens,
              n_ctx: window,
            },
          }),
        });
        return;
      }
      const name = String(body.model);
      const at = loaded.findIndex((each) => each.name === model.name);
      if (at === -1 || loaded[at]?.context_length !== window) {
        if (options.loadMs) await new Promise((resolve) => setTimeout(resolve, options.loadMs));
        if (at !== -1) loaded.splice(at, 1);
        loaded.push({ name: model.name, context_length: window });
      }
      const reply = options.reply(body, chats.length - 1);
      const message = {
        role: "assistant",
        content: reply.content ?? "",
        ...(reply.toolCalls && {
          tool_calls: reply.toolCalls.map((call) => ({
            function: { name: call.name, arguments: call.arguments },
          })),
        }),
      };
      const done = {
        done: true,
        done_reason: reply.cutOff ? "length" : "stop",
        prompt_eval_count: Math.min(tokens, window),
        eval_count: Math.ceil(message.content.length / 4) + 1,
      };
      const created_at = new Date().toISOString();
      if (body.stream !== true) {
        json(response, 200, { model: name, created_at, message, ...done });
        return;
      }
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      for (const line of reply.unreadable ?? []) response.write(`${line}\n`);
      const content = message.content;
      for (let start = 0; start < content.length; start += 16) {
        const delta = { role: "assistant", content: content.slice(start, start + 16) };
        response.write(
          `${JSON.stringify({ model: name, created_at, message: delta, done: false })}\n`,
        );
      }
      const last = { ...message, content: "" };
      response.end(`${JSON.stringify({ model: name, created_at, message: last, ...done })}\n`);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, chats, loaded };
}
