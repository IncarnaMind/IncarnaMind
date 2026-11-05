import { createServer } from "node:http";
import { type AddressInfo, connect, type LookupFunction } from "node:net";
import { MockLanguageModelV4 } from "ai/test";
import type { buildConnector } from "undici";
import { onTestFinished } from "vitest";
import type { Resolve } from "../../src/core/tools/web/addresses";
import type { PublicFetchOptions } from "../../src/core/tools/web/fetcher";

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;
type CallOptions = Parameters<MockLanguageModelV4["doStream"]>[0];

/** A public address the test resolver gives every host: connections still go to the local server. */
export const PUBLIC_ADDRESS = "93.184.215.14";

export interface WebRoute {
  status: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

/** Connections a guarded lookup allows go to the local server at `port`, whatever address it allowed. */
export const connectorTo =
  (port: number) =>
  (lookup: LookupFunction): buildConnector.connector =>
  (options, callback) => {
    lookup(options.hostname, {}, (error) => {
      if (error) {
        callback(error, null);
        return;
      }
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => callback(null, socket));
      socket.once("error", (failure) => callback(failure, null));
    });
  };

/**
 * A local server standing in for the web, for every host: what each path
 * answers (given the server's port), and every request it heard
 * ("host/path"), each on a connection of its own. With `adapters`, the core's
 * web search fetcher resolves every host to a public address and connects
 * here, its guard still deciding which hosts it reaches.
 */
export async function startWeb(routes: Record<string, (port: number) => WebRoute>) {
  const heard: string[] = [];
  const server = createServer((request, response) => {
    heard.push(`${request.headers.host}${request.url}`);
    const route = routes[request.url ?? ""];
    const answer = route ? route(port) : { status: 404, body: "Not found" };
    response.writeHead(answer.status, {
      "Content-Type": "text/html; charset=utf-8",
      Connection: "close",
      ...answer.headers,
    });
    response.end(answer.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const resolve: Resolve = async () => [{ address: PUBLIC_ADDRESS, family: 4 }];
  // The local server stands in for the web, its pages as well as its pictures: a page a test
  // saves by its literal 127.0.0.1 address reaches it. The guard over a saved page is
  // webFetcher.test.ts's and webPagePublicFetch.test.ts's, which build their own adapters.
  const adapters: { web: PublicFetchOptions; webPages: { fetch: typeof fetch } } = {
    web: { resolve, connector: connectorTo(port) },
    webPages: { fetch },
  };
  return { port, heard, adapters };
}

export interface FoundPage {
  url: string;
  title: string;
}

const USAGE = {
  inputTokens: { total: 12_000, noCache: 12_000, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 40, text: 40, reasoning: undefined },
};

/** The text of a request's last user message. */
const lastUserText = (options: CallOptions) => {
  const last = options.prompt.filter((message) => message.role === "user").at(-1);
  if (!last || typeof last.content === "string") return "";
  return last.content.map((part) => (part.type === "text" ? part.text : "")).join("");
};

/**
 * A chat model whose provider searches the web: a request that offers the
 * provider's own search tool searches once and finds `pages`, as Anthropic's
 * reports them; every other request is `answering`'s. `searches` keeps each
 * search request.
 */
export function webSearchingModel(answering: MockLanguageModelV4, pages: readonly FoundPage[]) {
  const searches: CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: (options) => answering.doGenerate(options),
    doStream: async (options) => {
      const tool = options.tools?.find((each) => each.type === "provider");
      if (!tool) return answering.doStream(options);
      searches.push(options);
      const parts: StreamPart[] = [
        { type: "stream-start", warnings: [] },
        {
          type: "tool-call",
          toolCallId: `search-${searches.length}`,
          toolName: tool.name,
          input: JSON.stringify({ query: lastUserText(options) }),
          providerExecuted: true,
        },
        {
          type: "tool-result",
          toolCallId: `search-${searches.length}`,
          toolName: tool.name,
          result: pages.map((page) => ({
            type: "web_search_result",
            url: page.url,
            title: page.title,
            pageAge: "2 days ago",
            encryptedContent: "",
          })),
        },
        ...pages.map(
          (page, index): StreamPart => ({
            type: "source",
            sourceType: "url",
            id: `source-${index}`,
            url: page.url,
            title: page.title,
          }),
        ),
        { type: "text-start", id: "done" },
        { type: "text-delta", id: "done", delta: "done" },
        { type: "text-end", id: "done" },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
      ];
      return {
        stream: new ReadableStream<StreamPart>({
          pull(controller) {
            const part = parts.shift();
            if (part) controller.enqueue(part);
            else controller.close();
          },
        }),
      };
    },
  });
  return { model, searches };
}
