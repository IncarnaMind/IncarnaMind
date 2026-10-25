/**
 * A tiny MCP server for tests, written with the official SDK and spoken to
 * over stdio. It offers two Tools: `lookup_tide` only reads (it says so with
 * its `readOnlyHint` annotation), and `book_boat` changes something.
 *
 * `lookup_tide` for a harbour called "slowly" takes a few seconds to answer, for a test to see
 * the call while it runs.
 *
 * If MCP_TEST_LOG names a file, it appends a JSON line there when it starts
 * (its pid and the environment variables tests look at) and for every Tool
 * call that reaches it, so tests can see what happened on the server's side.
 */
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const log = (record) => {
  const file = process.env.MCP_TEST_LOG;
  if (file) appendFileSync(file, `${JSON.stringify(record)}\n`);
};

const placeSchema = {
  type: "object",
  properties: { place: { type: "string", description: "A harbour, e.g. Dover." } },
  required: ["place"],
};

const server = new Server(
  { name: "tide-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "lookup_tide",
      title: "Look up the tides",
      description: "The times of high water at a harbour today.",
      inputSchema: placeSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "book_boat",
      description: "Books a boat trip from a harbour.",
      inputSchema: placeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  log({ event: "call", tool: name, arguments: args });
  if (name === "lookup_tide") {
    if (args.place === "slowly") await new Promise((done) => setTimeout(done, 3000));
    return { content: [{ type: "text", text: `High water at ${args.place}: 06:12 and 18:40.` }] };
  }
  if (name === "book_boat") {
    return { content: [{ type: "text", text: `Booked a boat trip from ${args.place}.` }] };
  }
  return { content: [{ type: "text", text: `There is no Tool called ${name}.` }], isError: true };
});

log({
  event: "start",
  pid: process.pid,
  env: {
    TIDE_TOKEN: process.env.TIDE_TOKEN ?? null,
    LOGIN_SHELL_MARKER: process.env.LOGIN_SHELL_MARKER ?? null,
  },
});
await server.connect(new StdioServerTransport());
