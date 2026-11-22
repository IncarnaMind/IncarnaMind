/**
 * The command an outside agent starts to reach IncarnaMind (#351): an MCP
 * server over stdio that hands everything to the running app through its
 * socket (src/core/agents/socket.ts), after one opening line naming the
 * pairing by its token. The app's own binary runs it as plain Node
 * (`ELECTRON_RUN_AS_NODE`), so nothing is downloaded when an agent starts it,
 * and the app it talks to already has its index loaded. It imports nothing
 * but Node and the shared protocol, so it starts in a few tens of milliseconds.
 *
 * When the app isn't open, or connecting agents is off in it, the shim
 * answers each request with an error saying so in plain words, rather than
 * leaving the agent waiting. It never writes the token anywhere.
 *
 * It imports nothing at all but Node, so its build is one file: Claude's
 * install bundle carries a copy and runs it on Claude's own Node. The
 * protocol is src/shared/agentSocket.ts's, written out again here; the
 * tests run this shim against the core, so the two can't drift apart.
 */
import { createConnection } from "node:net";

const AGENT_TOKEN_ENV = "INCARNAMIND_AGENT_TOKEN";
const AGENT_SOCKET_ENV = "INCARNAMIND_AGENT_SOCKET";
const handshakeLine = (token: string) => `${JSON.stringify({ incarnamind: 1, token })}\n`;

/** The shim doesn't know the interface language, so it says this in both. */
const NOT_OPEN =
  "IncarnaMind isn't open, or connecting agents is turned off in it. Open IncarnaMind, check Settings → AI, then reconnect this agent to it. / IncarnaMind 没有打开，或已关闭智能体连接。打开 IncarnaMind，检查“设置 → AI”，然后让这个智能体重新连接。";
const NOT_SET_UP =
  "This agent's IncarnaMind settings are incomplete. Connect it again in IncarnaMind, in Settings → AI. / 这个智能体的 IncarnaMind 设置不完整。在 IncarnaMind 的“设置 → AI”中重新连接它。";

/** Answers every request on stdin with an error saying `message`, until stdin ends. */
function refuseEverything(message: string): void {
  let pending = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    pending += chunk;
    for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
      const line = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      let request: unknown;
      try {
        request = JSON.parse(line);
      } catch {
        continue;
      }
      // Only requests are answered; notifications have no id.
      if (typeof request !== "object" || request === null || !("id" in request)) continue;
      const reply = { jsonrpc: "2.0", id: request.id, error: { code: -32000, message } };
      process.stdout.write(`${JSON.stringify(reply)}\n`);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

const token = process.env[AGENT_TOKEN_ENV];
const socketPath = process.env[AGENT_SOCKET_ENV];

if (!token || !socketPath) {
  refuseEverything(NOT_SET_UP);
} else {
  const socket = createConnection(socketPath);
  let connected = false;
  socket.once("connect", () => {
    connected = true;
    socket.write(handshakeLine(token));
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });
  socket.on("error", () => {
    if (!connected) refuseEverything(NOT_OPEN);
  });
  // The app closed the connection: it quit, or the agent was disconnected.
  socket.on("close", () => {
    if (connected) process.exit(0);
  });
}
