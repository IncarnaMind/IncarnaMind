// Stands in for the User's Claude Code command line in a spec of the check run in the background
// (#3606): `--version` and `auth status` as `claude` answers them, and a run that speaks its
// stream, reaching IncarnaMind's server only through the settings file it was given. What it does
// is read from the file INCARNAMIND_TEST_OWN_AI_MODE_FILE names at each start: "check" (the
// default) marks every sentence it is given as not found; "wait" runs until it is stopped;
// "signed-out" is not signed in; "limit" ends as a plan's limit does. A request typed at a Note's
// foot (#3627): "change" puts the words selected in capitals, in the paragraph that holds them;
// "explain" answers and changes nothing.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);
let mode = "check";
try {
  mode = readFileSync(process.env.INCARNAMIND_TEST_OWN_AI_MODE_FILE ?? "", "utf8").trim() || mode;
} catch {
  // No file: the default.
}
if (args[0] === "--version") {
  console.log("2.1.330 (Claude Code)");
  process.exit(0);
}
if (args[0] === "auth") process.exit(mode === "signed-out" ? 1 : 0);

const at = args.indexOf("--mcp-config");
const server = JSON.parse(readFileSync(args[at + 1] ?? "", "utf8")).mcpServers.incarnamind;
const say = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    say({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: {
          effective: { disableAllHooks: true },
          sources: [{ source: "flagSettings", settings: {} }],
        },
      },
    });
    return;
  }
  if (message.type !== "user") return;
  const agent = new Client({ name: "fake-claude-code", version: "1.0.0" });
  await agent.connect(new StdioClientTransport({ ...server, stderr: "pipe" }));
  const { tools } = await agent.listTools();
  say({
    type: "system",
    subtype: "init",
    tools: tools.map((tool) => `mcp__incarnamind__${tool.name}`),
    mcp_servers: [{ name: "incarnamind", status: "connected" }],
  });
  if (mode === "wait") return;
  if (mode === "limit") {
    say({ type: "system", subtype: "api_retry", error: "rate_limit", attempt: 1 });
    say({ type: "result", subtype: "success", is_error: true, result: "Limit reached." });
    return;
  }
  const prompt = String(message.message.content);
  const mindId = prompt.match(/mindId: ([^)]+)\)/)?.[1];
  const use = async (name, input) => {
    say({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: name, name: `mcp__incarnamind__${name}`, input }],
      },
    });
    return (await agent.callTool({ name, arguments: input })).structuredContent;
  };
  if (prompt.startsWith("In their note")) {
    if (mode === "explain") {
      await agent.close();
      say({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "It counts the ship calls the harbour handled in 2025.",
      });
      return;
    }
    const quote = prompt.match(/The words they selected in it: “([^”]*)”/)?.[1] ?? "";
    const read = await use("read_mind", { mindId, named: true });
    const line = (read?.markdown ?? "")
      .split("\n")
      .find((each) => quote !== "" && each.includes(quote));
    const name = line?.match(/¶\d+/)?.[0];
    if (name && line) {
      // A paragraph the User wrote reads "(the User wrote this)" between its name and its words.
      const text = line
        .slice(line.indexOf(name) + name.length)
        .replace(/^\s*\(the User (?:wrote|changed) this\)/, "")
        .trim()
        .replace(quote, quote.toUpperCase());
      await use("propose_changes", {
        mindId,
        version: read.version,
        changes: [{ paragraph: name, text }],
      });
    }
    await agent.close();
    say({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Put the selected words in capitals.",
    });
    return;
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
  await agent.close();
  say({ type: "result", subtype: "success", is_error: false, result: "Checked." });
});
