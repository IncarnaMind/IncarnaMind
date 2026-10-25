/**
 * What an outside harness starts as IncarnaMind's MCP server in the bake-off
 * (README.md): the app's own handshake on its socket (src/main/agentShim.ts),
 * then MCP's newline-delimited JSON-RPC relayed both ways, with what only the
 * bake-off needs, so the server stays as it ships:
 *
 * - INCARNAMIND_HARNESS_TOOLS: the Tools the harness sees. Others are left
 *   out of `tools/list`, and a call to one is answered here as an error.
 * - INCARNAMIND_HARNESS_INSTRUCTIONS: the server's instructions for those Tools.
 * - INCARNAMIND_HARNESS_LOG: a file each Tool call is appended to, with its
 *   arguments and its result as the harness got them.
 *
 * Plain Node with nothing imported but Node's own modules, so a harness can
 * start it from any folder.
 */
import { appendFileSync } from "node:fs";
import { createConnection } from "node:net";

const socketPath = process.env.INCARNAMIND_AGENT_SOCKET;
const token = process.env.INCARNAMIND_AGENT_TOKEN;
const allowed = (process.env.INCARNAMIND_HARNESS_TOOLS ?? "")
  .split(",")
  .map((each) => each.trim())
  .filter(Boolean);
const instructions = process.env.INCARNAMIND_HARNESS_INSTRUCTIONS;
const logFile = process.env.INCARNAMIND_HARNESS_LOG;

if (!socketPath || !token) {
  process.stderr.write(
    "The bake-off's shim needs INCARNAMIND_AGENT_SOCKET and INCARNAMIND_AGENT_TOKEN.\n",
  );
  process.exit(2);
}

type Id = string | number;
interface Message {
  id?: Id;
  method?: string;
  params?: { name?: string; arguments?: unknown };
  result?: {
    tools?: { name: string }[];
    instructions?: string;
    content?: { type?: string; text?: string }[];
    isError?: boolean;
  };
  error?: { message?: string };
}

const pendingCalls = new Map<Id, { tool: string; arguments: unknown; started: number }>();
const toolLists = new Set<Id>();
const openings = new Set<Id>();

function log(record: Record<string, unknown>): void {
  if (!logFile) return;
  appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
}

const isAllowed = (tool: string | undefined) => tool !== undefined && allowed.includes(tool);

function parse(line: string): Message | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? (value as Message) : null;
  } catch {
    return null;
  }
}

function lines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim()) onLine(line);
    }
  });
}

const socket = createConnection(socketPath);
socket.on("error", (error) => {
  process.stderr.write(`The bake-off's shim couldn't reach IncarnaMind: ${error.message}\n`);
  process.exit(1);
});
socket.on("close", () => process.exit(0));
socket.write(`${JSON.stringify({ incarnamind: 1, token })}\n`);

lines(process.stdin, (line) => {
  const message = parse(line);
  if (message?.method === "tools/call" && message.id !== undefined) {
    const tool = message.params?.name;
    if (!isAllowed(tool)) {
      log({ tool: tool ?? null, arguments: message.params?.arguments ?? null, refused: true });
      const refusal = {
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: `Unknown tool: ${tool ?? ""}` }], isError: true },
      };
      process.stdout.write(`${JSON.stringify(refusal)}\n`);
      return;
    }
    pendingCalls.set(message.id, {
      tool: tool ?? "",
      arguments: message.params?.arguments ?? null,
      started: performance.now(),
    });
  }
  if (message?.id !== undefined && message.method === "tools/list") toolLists.add(message.id);
  if (
    message?.id !== undefined &&
    (message.method === "initialize" || message.method === "server/discover")
  ) {
    openings.add(message.id);
  }
  socket.write(`${line}\n`);
});
process.stdin.on("end", () => socket.end());

lines(socket, (line) => {
  let out = line;
  const message = parse(line);
  if (message?.id !== undefined && message.method === undefined) {
    const call = pendingCalls.get(message.id);
    if (call) {
      pendingCalls.delete(message.id);
      log({
        tool: call.tool,
        arguments: call.arguments,
        ms: Math.round(performance.now() - call.started),
        isError: message.result?.isError === true || message.error !== undefined,
        result:
          message.result?.content
            ?.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
            .join("") ??
          message.error?.message ??
          "",
      });
    }
    if (toolLists.delete(message.id) && message.result?.tools) {
      const tools = message.result.tools.filter((tool) => allowed.includes(tool.name));
      out = JSON.stringify({ ...message, result: { ...message.result, tools } });
    }
    if (
      openings.delete(message.id) &&
      instructions &&
      typeof message.result?.instructions === "string"
    ) {
      out = JSON.stringify({ ...message, result: { ...message.result, instructions } });
    }
  }
  process.stdout.write(`${out}\n`);
});
