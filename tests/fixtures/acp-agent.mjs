/**
 * A scripted ACP agent for tests, written with the official SDK and spoken to
 * over stdio, as the User's own agent would be. No model and no network: the
 * prompt's words pick what it does.
 *
 * - "hello": answers with a sentence and a Citation token.
 * - "run code": asks permission twice for code it runs, then says what ran,
 *   or ends as cancelled if it was cancelled meanwhile.
 * - "wait": goes on until it is cancelled.
 * - "crash": writes part of an answer, then exits with an error.
 *
 * It starts in "full-access" and also offers "read-only". If ACP_TEST_LOG
 * names a file, it appends a JSON line there for each thing tests look at: the
 * client's capabilities, the MCP servers it was given (their environment by
 * name only), the mode set, each permission answer and a cancel.
 */
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const log = (record) => {
  const file = process.env.ACP_TEST_LOG;
  if (file) appendFileSync(file, `${JSON.stringify(record)}\n`);
};

const OPTIONS = [
  { optionId: "allow-once-id", name: "Allow", kind: "allow_once" },
  { optionId: "allow-always-id", name: "Always allow", kind: "allow_always" },
  { optionId: "reject-once-id", name: "Reject", kind: "reject_once" },
];

let cancelRequested = false;
let cancelled = () => undefined;

const say = (client, sessionId, text) =>
  client.notify("session/update", {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });

async function runCode(client, sessionId, toolCallId) {
  await client.notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId,
      title: "Run tests",
      kind: "execute",
      status: "pending",
    },
  });
  const answer = await client.request("session/request_permission", {
    sessionId,
    toolCall: { toolCallId, title: "Run tests", kind: "execute" },
    options: OPTIONS,
  });
  log({ event: "permission", toolCallId, outcome: answer.outcome });
  const ran = answer.outcome.outcome === "selected" && answer.outcome.optionId !== "reject-once-id";
  await client.notify("session/update", {
    sessionId,
    update: { sessionUpdate: "tool_call_update", toolCallId, status: ran ? "completed" : "failed" },
  });
  return ran;
}

const app = agent({ name: "scripted-agent" })
  .onRequest("initialize", ({ params }) => {
    log({ event: "initialize", clientCapabilities: params.clientCapabilities });
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {},
      agentInfo: { name: "scripted-agent", version: "1.0.0" },
      authMethods: [],
    };
  })
  .onRequest("session/new", ({ params }) => {
    log({
      event: "session/new",
      cwd: params.cwd,
      mcpServers: params.mcpServers.map((server) => ({
        name: server.name,
        env: "env" in server ? server.env.map((variable) => variable.name) : [],
      })),
    });
    return {
      sessionId: "session-1",
      modes: {
        currentModeId: "full-access",
        availableModes: [
          { id: "full-access", name: "Full access" },
          { id: "read-only", name: "Read only" },
        ],
      },
    };
  })
  .onRequest("session/set_mode", ({ params }) => {
    log({ event: "set_mode", modeId: params.modeId });
    return {};
  })
  .onNotification("session/cancel", () => {
    log({ event: "cancel" });
    cancelRequested = true;
    cancelled();
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    const { sessionId } = params;
    const words = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join(" ");
    log({ event: "prompt", words });
    if (words.includes("wait")) {
      await say(client, sessionId, "Working on it.");
      await new Promise((resolve) => {
        cancelled = resolve;
      });
      return { stopReason: "cancelled" };
    }
    if (words.includes("crash")) {
      await say(client, sessionId, "Half an answer");
      // A pipe to the parent is written asynchronously on macOS: exit once both are out.
      process.stdout.write("", () =>
        process.stderr.write("boom: the agent's model went away\n", () => process.exit(3)),
      );
      return new Promise(() => undefined);
    }
    if (words.includes("run code")) {
      const first = await runCode(client, sessionId, "call-1");
      const second = first ? await runCode(client, sessionId, "call-2") : false;
      if (cancelRequested) return { stopReason: "cancelled" };
      await say(client, sessionId, first && second ? "Both ran." : "Nothing ran.");
      return { stopReason: "end_turn" };
    }
    await say(client, sessionId, "Revenue grew 12% ");
    await say(client, sessionId, "[cite:k3x9a2b7].");
    return { stopReason: "end_turn" };
  });

app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
