// Stands in for the User's Codex command line in tests of the check run in the background (#3639):
// `--version` and `login status` as `codex` answers them, `debug models --bundled` with a small
// catalog, `debug prompt-input` listing the tools the settings it is given would offer, and `exec`
// printing Codex's JSON event stream. Like Codex, it starts IncarnaMind's server from its `-c
// mcp_servers.incarnamind.*` settings, in a process group of its own, with only the variables
// `env_vars` names, and offers code mode's tools unless the catalog turned them off. What it does
// is read from the file INCARNAMIND_TEST_OWN_AI_MODE_FILE names, at each start: "check" (the
// default) marks every sentence it is given as not found; "wait" runs until it is stopped, writing
// its own and its server's process ids beside the mode file; "outside" asks for a command of its
// own; "unreadable" prints a line that isn't JSON; "limit" ends as a plan's limit does; "late"
// exits before its turn starts; "old" is 0.169.0; "signed-out" isn't signed in; "extra-tool" offers
// a tool of its own in the preflight.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const modeFile = process.env.INCARNAMIND_TEST_OWN_AI_MODE_FILE ?? "";
let mode = "check";
try {
  mode = readFileSync(modeFile, "utf8").trim() || mode;
} catch {
  // No file: the default.
}
const say = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

if (args[0] === "--version") {
  console.log(mode === "old" ? "codex-cli 0.169.0" : "codex-cli 0.170.0");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") process.exit(mode === "signed-out" ? 1 : 0);

const CATALOG = {
  models: [
    { slug: "gpt-6.2-sol", priority: 1, visibility: "list", supported_in_api: true },
    { slug: "gpt-6-luna", priority: 7, visibility: "list", supported_in_api: true },
    { slug: "codex-auto-review", priority: 43, visibility: "hide", supported_in_api: true },
  ].map((model) => ({
    ...model,
    tool_mode: "code_mode_only",
    apply_patch_tool_type: "freeform",
    multi_agent_version: "v2",
    experimental_supported_tools: ["clock"],
    supports_search_tool: true,
  })),
};
if (args[0] === "debug" && args[1] === "models" && args[2] === "--bundled") {
  say(CATALOG);
  process.exit(0);
}

/** The `-c key=value` settings, each value as TOML gives a string, list or other value. */
const settings = new Map();
for (let at = 0; at < args.length; at++) {
  if (args[at] !== "-c") continue;
  const [key, ...rest] = String(args[at + 1]).split("=");
  const raw = rest.join("=");
  let value = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    // A table or a bare word: kept as written.
  }
  settings.set(key, value);
}
const setting = (key) => settings.get(`mcp_servers.incarnamind.${key}`);

/** What Codex gives every server it starts, besides the variables `env_vars` names. */
const BASE_ENV =
  process.platform === "win32"
    ? [
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "SystemRoot",
        "COMSPEC",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
      ]
    : ["PATH", "HOME", "TMPDIR", "LANG", "USER", "LOGNAME"];

/** IncarnaMind's server, started as Codex starts one: its own process group, the named variables only. */
async function server() {
  const env = {};
  for (const name of BASE_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];
  for (const name of setting("env_vars") ?? []) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const child = spawn(setting("command"), setting("args") ?? [], {
    env,
    stdio: ["pipe", "pipe", "ignore"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const waiting = new Map();
  let next = 1;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const reply = JSON.parse(line);
    waiting.get(reply.id)?.(reply);
    waiting.delete(reply.id);
  });
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await call("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "fake-codex", version: "0.170.0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listed = (await call("tools/list", {})).result?.tools ?? [];
  const enabled = setting("enabled_tools");
  const tools = listed
    .map((tool) => tool.name)
    .filter((name) => !enabled || enabled.includes(name));
  return {
    child,
    tools,
    async use(name, input) {
      const reply = await call("tools/call", { name, arguments: input });
      return reply.result?.structuredContent;
    },
    close() {
      child.stdin.end();
    },
  };
}

/** What the catalog it was given leaves the model besides the server's Tools. */
function ownTools() {
  const file = settings.get("model_catalog_json");
  const model = settings.get("model") ?? "gpt-6.2-sol";
  const entry = (file ? JSON.parse(readFileSync(file, "utf8")) : CATALOG).models.find(
    (each) => each.slug === model,
  );
  const tools = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];
  if (entry?.tool_mode !== "direct") tools.push("exec", "wait");
  if (entry?.apply_patch_tool_type) tools.push("apply_patch");
  if (mode === "extra-tool") tools.push("request_user_input");
  return tools;
}

if (args[0] === "debug" && args[1] === "prompt-input") {
  const started = await server();
  say([
    {
      type: "additional_tools",
      role: "developer",
      tools: [
        { type: "namespace", name: "functions", tools: ownTools().map((name) => ({ name })) },
        {
          type: "namespace",
          name: "mcp__incarnamind",
          tools: started.tools.map((name) => ({ name })),
        },
      ],
    },
    { type: "message", role: "user", content: [] },
  ]);
  started.close();
  process.exit(0);
}

if (args[0] !== "exec") process.exit(2);
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
if (mode === "late") {
  console.error("Error: unknown configuration field");
  process.exit(1);
}
const started = await server();
say({ type: "thread.started", thread_id: "00000000-0000-7000-8000-000000000000" });
say({ type: "turn.started" });
let item = 0;
const message = (text) =>
  say({ type: "item.completed", item: { id: `item_${item++}`, type: "agent_message", text } });
if (mode === "wait") {
  message("Looking at your note.");
  writeFileSync(join(dirname(modeFile), "pids"), `${process.pid} ${started.child.pid}`);
  setInterval(() => undefined, 1000);
} else if (mode === "outside") {
  say({
    type: "item.started",
    item: {
      id: `item_${item++}`,
      type: "command_execution",
      command: "touch PLANTED",
      status: "in_progress",
    },
  });
  setInterval(() => undefined, 1000);
} else if (mode === "unreadable") {
  process.stdout.write("Codex says hello\n");
  setInterval(() => undefined, 1000);
} else if (mode === "limit") {
  say({ type: "error", message: "You’ve hit your usage limit. Try again later." });
  say({ type: "turn.failed", error: { message: "You’ve hit your usage limit. Try again later." } });
  started.close();
} else {
  const mindId = prompt.match(/mindId: ([^)]+)\)/)?.[1];
  const use = async (tool, input) => {
    const id = `item_${item++}`;
    const call = { id, type: "mcp_tool_call", server: "incarnamind", tool, arguments: input };
    say({ type: "item.started", item: { ...call, status: "in_progress" } });
    const result = await started.use(tool, input);
    say({ type: "item.completed", item: { ...call, status: "completed" } });
    return result;
  };
  const given = await use("check_mind_yourself", { mindId });
  await use("report_check", {
    mindId,
    task: given.task,
    results: given.sentences.map((sentence) => ({
      n: sentence.n,
      verdict: "not found",
      explanation: "No Document says so.",
    })),
  });
  message("Checked.");
  say({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
  started.close();
}
