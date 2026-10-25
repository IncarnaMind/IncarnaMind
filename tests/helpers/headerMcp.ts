import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export async function startHeaderMcp(
  options: {
    header?: string;
    value?: string;
    expectedHeaders?: Record<string, string>;
    legacy?: 404 | 405 | true;
    refusal?: 401 | 403;
    failure?: number;
    late404?: boolean;
    redirect?: string;
    endpoint?: string;
    echo?: string;
    structured?: boolean;
  } = {},
) {
  const sessions = new Map<string, StreamableHTTPServerTransport | SSEServerTransport>();
  const servers: Server[] = [];
  const requests: { method: string; path: string; authenticated: boolean }[] = [];
  let activeStreams = 0;
  let toolCalls = 0;
  const makeServer = () => {
    const server = new Server(
      { name: "test-service", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "lookup",
          description: options.echo ?? "Looks up synthetic tide data.",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => {
      toolCalls++;
      return options.structured
        ? { content: [], structuredContent: { text: options.echo ?? "Synthetic tide data." } }
        : { content: [{ type: "text", text: options.echo ?? "Synthetic tide data." }] };
    });
    servers.push(server);
    return server;
  };
  const bodyOf = async (request: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";
    const expected =
      options.expectedHeaders ?? (options.header ? { [options.header]: options.value } : {});
    const authenticated = Object.entries(expected).every(
      ([name, value]) => request.headers[name.toLowerCase()] === value,
    );
    requests.push({ method, path: path.pathname, authenticated });
    if (options.refusal || options.failure || !authenticated) {
      response.writeHead(options.refusal ?? options.failure ?? 401, {
        "content-type": "text/plain",
      });
      response.end(JSON.stringify(request.headers));
      return;
    }
    if (options.redirect) {
      response.writeHead(307, { location: options.redirect });
      response.end();
      return;
    }
    if (options.legacy) {
      if (method === "POST" && path.pathname === "/mcp") {
        response.writeHead(options.legacy === true ? 404 : options.legacy);
        response.end();
        return;
      }
      if (method === "GET" && path.pathname === "/mcp") {
        if (options.endpoint) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(`event: endpoint\ndata: ${options.endpoint}\n\n`);
        } else {
          const transport = new SSEServerTransport("/messages", response);
          sessions.set(transport.sessionId, transport);
          await makeServer().connect(transport);
        }
        activeStreams++;
        response.on("close", () => activeStreams--);
        return;
      }
      const session = sessions.get(path.searchParams.get("sessionId") ?? "");
      if (session instanceof SSEServerTransport) {
        await session.handlePostMessage(request, response);
        return;
      }
    } else {
      const id = request.headers["mcp-session-id"];
      let transport = typeof id === "string" ? sessions.get(id) : undefined;
      if (!transport && method === "POST") {
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (sessionId) => {
            sessions.set(sessionId, created);
          },
        });
        await makeServer().connect(created);
        transport = created;
      }
      if (transport instanceof StreamableHTTPServerTransport) {
        const body = method === "POST" ? await bodyOf(request) : undefined;
        if (
          options.late404 &&
          typeof body === "object" &&
          body !== null &&
          "method" in body &&
          body.method === "tools/list"
        ) {
          response.writeHead(404);
          response.end(options.echo ?? "Unavailable");
          return;
        }
        await transport.handleRequest(request, response, body);
        return;
      }
    }
    response.writeHead(404);
    response.end();
  };
  const http = createServer(
    (request, response) =>
      void handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      }),
  );
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  return {
    url,
    requests,
    get activeStreams() {
      return activeStreams;
    },
    get toolCalls() {
      return toolCalls;
    },
    setKey(value: string) {
      options.value = value;
    },
    setFailure(status: number) {
      options.failure = status;
    },
    async close() {
      await Promise.all(servers.map((server) => server.close()));
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
    },
  };
}
