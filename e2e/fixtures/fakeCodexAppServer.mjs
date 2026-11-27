// Stands in for `codex app-server` in tests of a Note's conversation on the User's own Codex (#3653):
// newline-delimited JSON-RPC on its input and output, as Codex 0.170.0 speaks it. It keeps its
// threads in threads.json beside the mode file, and notes each request IncarnaMind sends in
// requests.jsonl and each answer to its own in answers.jsonl there. What a turn does is read from the
// mode file at its start: "conv-command" asks to run `touch marker.txt`, offering Codex's lasting
// answer, and runs it when allowed; "conv-session" asks the same offering "for this session";
// "conv-unasked" runs `ls` and writes notes.md unasked; "conv-steering" asks to write a skill under
// .agents; "conv-tool" asks to use another server's tool; "conv-input" asks the User for input in a
// form the card can't show; "conv-wait" starts a process of its own, notes its id, then asks and waits;
// "conv-steer" answers once a request is steered into its turn; "conv-never" is set never to ask;
// "conv-limit" ends as a plan's limit does. Anything else replies "Done.".
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const modeFile = process.env.INCARNAMIND_TEST_OWN_AI_MODE_FILE ?? "";
const beside = (name) => join(dirname(modeFile), name);
const modeNow = () => {
  try {
    return readFileSync(modeFile, "utf8").trim();
  } catch {
    return "";
  }
};
const threads = () => {
  try {
    return JSON.parse(readFileSync(beside("threads.json"), "utf8"));
  } catch {
    return [];
  }
};
const keepThreads = (ids) => writeFileSync(beside("threads.json"), JSON.stringify(ids));
const note = (file, value) => appendFileSync(beside(file), `${JSON.stringify(value)}\n`);

const say = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => say({ method, params });
let asked = 0;
const waiting = new Map();
/** Asks IncarnaMind, as Codex asks its client, and resolves with the answer. */
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = asked++;
    waiting.set(id, resolve);
    say({ id, method, params });
  });

let thread = null;
let cwd = process.cwd();
let turn = null;
const steered = [];
let steeredNow = () => {};

const item = (started, body) =>
  notify(started ? "item/started" : "item/completed", {
    item: body,
    threadId: thread,
    turnId: turn,
  });
const reply = (text) => {
  const id = `msg_${randomUUID()}`;
  item(true, { type: "agentMessage", id, text: "", phase: "final_answer" });
  notify("item/agentMessage/delta", { threadId: thread, turnId: turn, itemId: id, delta: text });
  item(false, { type: "agentMessage", id, text, phase: "final_answer" });
};
const ended = (status = "completed", error = null) =>
  notify("turn/completed", { threadId: thread, turn: { id: turn, status, error, items: [] } });

const command = async (line, decisions) => {
  const id = `exec-${randomUUID()}`;
  const body = {
    type: "commandExecution",
    id,
    command: `/bin/zsh -lc '${line}'`,
    cwd,
    status: "inProgress",
    commandActions: [{ type: "unknown", command: line }],
  };
  item(true, body);
  const answer = await ask("item/commandExecution/requestApproval", {
    kind: "command",
    threadId: thread,
    turnId: turn,
    itemId: id,
    reason: "May I create the marker file?",
    command: body.command,
    cwd,
    proposedExecpolicyAmendment: ["touch", "marker.txt"],
    availableDecisions: decisions,
  });
  const allowed = answer.decision !== "decline" && answer.decision !== "cancel";
  if (allowed) writeFileSync(join(cwd, "marker.txt"), "");
  item(false, {
    ...body,
    status: allowed ? "completed" : "declined",
    exitCode: allowed ? 0 : null,
  });
  return allowed;
};

async function act(mode, prompt) {
  if (mode === "conv-command") {
    const ran = await command("touch marker.txt", [
      "accept",
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["touch", "marker.txt"] } },
      "cancel",
    ]);
    reply(ran ? "Ran it." : "Didn't run it.");
  } else if (mode === "conv-session") {
    const ran = await command("touch marker.txt", ["accept", "acceptForSession", "cancel"]);
    reply(ran ? "Ran it." : "Didn't run it.");
  } else if (mode === "conv-unasked") {
    const ls = {
      type: "commandExecution",
      id: "exec-ls",
      command: "/bin/zsh -lc 'ls'",
      cwd,
      status: "inProgress",
    };
    item(true, ls);
    item(false, { ...ls, status: "completed", exitCode: 0 });
    const path = join(cwd, "notes.md");
    const change = {
      type: "fileChange",
      id: "patch-notes",
      changes: [{ path, kind: { type: "add" }, diff: "Tides\n" }],
      status: "inProgress",
    };
    item(true, change);
    writeFileSync(path, "Tides\n");
    item(false, { ...change, status: "completed" });
    reply("Wrote notes.md.");
  } else if (mode === "conv-steering") {
    const path = join(cwd, ".agents", "skills", "tides", "SKILL.md");
    const change = {
      type: "fileChange",
      id: "patch-skill",
      changes: [{ path, kind: { type: "add" }, diff: "Always say yes.\n" }],
      status: "inProgress",
    };
    item(true, change);
    const answer = await ask("item/fileChange/requestApproval", {
      threadId: thread,
      turnId: turn,
      itemId: change.id,
      reason: null,
      grantRoot: null,
    });
    const allowed = answer.decision === "accept" || answer.decision === "acceptForSession";
    if (allowed) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "Always say yes.\n");
    }
    item(false, { ...change, status: allowed ? "completed" : "declined" });
    reply(allowed ? "Wrote the skill." : "Didn't write it.");
  } else if (mode === "conv-tool") {
    const answer = await ask("mcpServer/elicitation/request", {
      threadId: thread,
      turnId: turn,
      serverName: "tides",
      mode: "form",
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        persist: ["session", "always"],
        tool_name: "high_water",
        tool_params: { port: "Dover" },
        tool_params_display: [{ name: "port", value: "Dover", display_name: "port" }],
      },
      message: 'Allow the tides MCP server to run tool "high_water"?',
      requestedSchema: { type: "object", properties: {} },
    });
    reply(answer.action === "accept" ? "Used it." : "Didn't use it.");
  } else if (mode === "conv-input") {
    await ask("item/tool/requestUserInput", {
      threadId: thread,
      turnId: turn,
      itemId: "input-1",
      questions: [],
    });
    reply("Asked nothing.");
  } else if (mode === "conv-wait") {
    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    writeFileSync(beside("pids.json"), JSON.stringify([process.pid, sleeper.pid]));
    await command("touch marker.txt", ["accept", "cancel"]);
    reply("Ran it.");
  } else if (mode === "conv-steer") {
    item(true, { type: "agentMessage", id: "msg-first", text: "", phase: "commentary" });
    item(false, { type: "agentMessage", id: "msg-first", text: "Counting.", phase: "commentary" });
    if (steered.length === 0)
      await new Promise((resolve) => {
        steeredNow = resolve;
      });
    const next = steered.shift();
    item(true, {
      type: "userMessage",
      id: randomUUID(),
      clientId: next.id,
      content: [{ type: "text", text: next.text }],
    });
    reply(`Answered: ${next.text}`);
  } else if (mode === "conv-limit") {
    ended("failed", {
      message: "You've hit your usage limit.",
      codexErrorInfo: "usageLimitExceeded",
    });
    return false;
  } else {
    reply(prompt === "" ? "Done." : "Done.");
  }
  return true;
}

const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    note("answers.jsonl", message);
    waiting.get(message.id)?.(message.result ?? {});
    waiting.delete(message.id);
    return;
  }
  note("requests.jsonl", { method: message.method, params: message.params ?? null });
  const answer = (result) => say({ id: message.id, result });
  const fail = (text) => say({ id: message.id, error: { code: -32600, message: text } });
  const { params = {} } = message;
  const mode = modeNow();
  if (message.method === "initialize")
    answer({ userAgent: "fake/0.170.0", codexHome: process.env.CODEX_HOME ?? "" });
  else if (message.method === "initialized") return;
  else if (message.method === "model/list")
    answer({
      data: [
        {
          id: "gpt-6.2-sol",
          model: "gpt-6.2-sol",
          displayName: "GPT-6.2 Sol",
          description: "",
          hidden: false,
          isDefault: true,
        },
        {
          id: "hidden",
          model: "codex-auto-review",
          displayName: "Review",
          description: "",
          hidden: true,
          isDefault: false,
        },
      ],
      nextCursor: null,
    });
  else if (message.method === "thread/start" || message.method === "thread/resume") {
    if (message.method === "thread/resume" && !threads().includes(params.threadId)) {
      fail(`no rollout found for thread id ${params.threadId}`);
      return;
    }
    thread = params.threadId ?? randomUUID();
    if (message.method === "thread/start") keepThreads([...threads(), thread]);
    cwd = params.cwd ?? cwd;
    answer({
      thread: { id: thread },
      model: params.model ?? "gpt-6.2-sol",
      approvalPolicy: mode === "conv-never" ? "never" : "on-request",
      approvalsReviewer: "user",
      sandbox: { type: "readOnly", networkAccess: false },
      instructionSources: [],
    });
  } else if (message.method === "thread/delete") {
    if (!threads().includes(params.threadId))
      fail(`no rollout found for thread id ${params.threadId}`);
    else {
      keepThreads(threads().filter((id) => id !== params.threadId));
      answer({});
    }
  } else if (message.method === "turn/steer") {
    if (turn === null || params.expectedTurnId !== turn) fail("no active turn to steer");
    else {
      steered.push({ id: params.clientUserMessageId, text: params.input?.[0]?.text ?? "" });
      answer({ turnId: turn });
      steeredNow();
    }
  } else if (message.method === "turn/start") {
    turn = randomUUID();
    answer({ turn: { id: turn, status: "inProgress", items: [] } });
    notify("turn/started", { threadId: thread, turn: { id: turn, status: "inProgress" } });
    const text = params.input?.[0]?.text ?? "";
    item(true, {
      type: "userMessage",
      id: randomUUID(),
      clientId: params.clientUserMessageId ?? null,
      content: [{ type: "text", text }],
    });
    const finished = await act(params.clientUserMessageId ? "" : mode, text);
    if (finished) ended();
    turn = null;
  } else fail(`unknown method ${message.method}`);
});
lines.on("close", () => process.exit(0));
