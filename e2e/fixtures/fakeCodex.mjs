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
// exits before its turn starts, "late-debug" first prints debug lines, as with RUST_LOG set, and
// puts the grant in its last line, and "late-split" splits a Chinese character of its error
// across two writes; "slow-preflight" lists its tools only once stopped; "old" is 0.169.0; "signed-out" isn't signed in; "extra-tool" offers
// a tool of its own in the preflight; "renamed" no longer knows the feature shell_snapshot, as a
// later Codex might; "bad-catalog" prints a catalog that isn't one; "other-tool" and "other-server"
// call an IncarnaMind Tool it wasn't allowed, or another server's; "early-item" prints an item
// before its turn starts; "resources" lists and reads IncarnaMind's resources as Codex 0.170.0
// reports it, then checks; "resource-list-all" lists every server's, which asks any other server
// configured; "resource-read-codex" and "resource-list-other" show a read under Codex's own name
// and a list naming another server; "stall" goes silent after its turn starts; "slow" thinks for
// ever.
//
// Like Codex 0.170.0, it refuses a feature it doesn't know.
import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
/** Writes a file beside the mode file whole before a test can see it. */
const publish = (name, text) => {
  const file = join(dirname(modeFile), name);
  writeFileSync(`${file}.part`, text);
  renameSync(`${file}.part`, file);
};
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
  if (mode === "bad-catalog") console.log("not a catalog");
  else say(CATALOG);
  process.exit(0);
}

/** The features this stand-in knows: those Codex 0.170.0's `codex features list` names that the run uses, and more. */
const FEATURES = new Set(
  "agent_message_board agent_message_board_mcp analytics_plan_history api_key_cyber_access_programs api_key_model_discovery app_server_websocket_compression apply_patch_streaming_events apps apps_early_resource_discovery artifact async_compaction async_compaction_root_only auth_elicitation background_paginated_rollout_migration bedrock_setup_wizard browser_annotation_api browser_use browser_use_external browser_use_full_cdp_access chronicle cli_daybreak cli_resume_account_check code_mode code_mode_host code_mode_host_grpc code_mode_host_output_truncation code_mode_interrupt code_mode_only code_mode_only_strict_3p_tools code_mode_prewarm code_mode_tool_search codex_apps_mcp_2026_07_28 command_sessions_world_state compaction_image_budget computer_use concurrent_reasoning_summaries content_item_kinds context_management credential_masking critical_path_timing current_time_reminder cwd_relative_turn_diffs daemon_auto_start daybreak_program_propagation default_mode_request_user_input defer_mailbox_preemption deferred_executor deferred_tool_world_state enable_mcp_apps enable_request_compression exec_permission_approvals executed_tool_call_metadata executor_capability_discovery executor_capability_discovery_v2 external_agent_memory_import fast_mode gateway_setup_wizard gcp_setup_wizard goals guardian_approval hooks image_generation in_app_browser in_app_chat in_app_dictation in_app_local_automation in_app_updates in_app_voice local_thread_store_compression memories multi_agent multi_agent_v2 plugin_sharing plugins remote_plugin request_permissions_tool shell_snapshot shell_snapshot_v2 shell_tool skill_mcp_dependency_install skill_search sleep_tool tool_suggest unified_exec use_agent_identity view_image workspace_dependencies".split(
    " ",
  ),
);
if (mode === "renamed") FEATURES.delete("shell_snapshot");
for (let at = 0; at < args.length; at++) {
  if ((args[at] === "--disable" || args[at] === "--enable") && !FEATURES.has(args[at + 1])) {
    console.error(`Error: Unknown feature flag: ${args[at + 1]}`);
    process.exit(1);
  }
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
  if (mode === "slow-preflight") {
    publish("preflight-pid", String(process.pid));
    setInterval(() => undefined, 1000);
    await new Promise(() => undefined);
  }
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
  console.error("Error: unknown configuration field `sqlite_homes` in -c/--config override");
  process.exit(1);
}
if (mode === "late-debug") {
  for (let at = 0; at < 50; at++)
    console.error(`2026-11-24T00:00:00Z DEBUG codex_core: line ${at} DEBUG-MARKER`);
  console.error(`Error: ${"x".repeat(280)}${process.env.INCARNAMIND_AGENT_TOKEN ?? ""} end`);
  process.exit(1);
}
if (mode === "late-split") {
  const error = Buffer.from("Error: 配置无效\n");
  process.stderr.write(error.subarray(0, 9));
  await new Promise((resolve) => setTimeout(resolve, 200));
  process.stderr.write(error.subarray(9), () => process.exit(1));
  await new Promise(() => undefined);
}
const started = await server();
say({ type: "thread.started", thread_id: "00000000-0000-7000-8000-000000000000" });
if (mode === "early-item") {
  say({
    type: "item.completed",
    item: { id: "item_early", type: "agent_message", text: "Early." },
  });
  setInterval(() => undefined, 1000);
}
say({ type: "turn.started" });
let item = 0;
const message = (text) =>
  say({ type: "item.completed", item: { id: `item_${item++}`, type: "agent_message", text } });
if (mode === "wait") {
  message("Looking at your note.");
  publish("pids", `${process.pid} ${started.child.pid}`);
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
} else if (mode === "other-tool" || mode === "other-server") {
  const tool = mode === "other-tool" ? "create_mind" : "search";
  const server = mode === "other-tool" ? "incarnamind" : "elsewhere";
  say({
    type: "item.started",
    item: {
      id: `item_${item++}`,
      type: "mcp_tool_call",
      server,
      tool,
      arguments: {},
      status: "in_progress",
    },
  });
  setInterval(() => undefined, 1000);
} else if (
  mode === "resource-list-all" ||
  mode === "resource-read-codex" ||
  mode === "resource-list-other"
) {
  const call = {
    "resource-list-all": { server: "codex", tool: "list_mcp_resources", arguments: {} },
    "resource-read-codex": {
      server: "codex",
      tool: "read_mcp_resource",
      arguments: { uri: "x://y" },
    },
    "resource-list-other": {
      server: "codex",
      tool: "list_mcp_resources",
      arguments: { server: "elsewhere" },
    },
  }[mode];
  say({
    type: "item.started",
    item: { id: `item_${item++}`, type: "mcp_tool_call", ...call, status: "in_progress" },
  });
  setInterval(() => undefined, 1000);
} else if (mode === "stall") {
  setInterval(() => undefined, 1000);
} else if (mode === "slow") {
  setInterval(
    () =>
      say({ type: "item.completed", item: { id: `item_${item++}`, type: "reasoning", text: "" } }),
    100,
  );
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
  if (mode === "resources") {
    for (const call of [
      { server: "incarnamind", tool: "list_mcp_resources", arguments: { server: "incarnamind" } },
      {
        server: "incarnamind",
        tool: "list_mcp_resource_templates",
        arguments: { server: "incarnamind" },
      },
      {
        server: "incarnamind",
        tool: "read_mcp_resource",
        arguments: { server: "incarnamind", uri: "x://y" },
      },
    ]) {
      const shown = { id: `item_${item++}`, type: "mcp_tool_call", ...call };
      say({ type: "item.started", item: { ...shown, status: "in_progress" } });
      say({ type: "item.completed", item: { ...shown, status: "completed" } });
    }
  }
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
