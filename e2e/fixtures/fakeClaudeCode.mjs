// Stands in for the User's Claude Code command line in a spec of the check run in the background
// (#3606): `--version` and `auth status` as `claude` answers them, and a run that speaks its
// stream, reaching IncarnaMind's server only through the settings file it was given. What it does
// is read from the file INCARNAMIND_TEST_OWN_AI_MODE_FILE names at each start: "check" (the
// default) marks every sentence it is given as not found; "wait" runs until it is stopped;
// "signed-out" is not signed in; "limit" ends as a plan's limit does. A request typed at a Note's
// foot (#3627): "change" puts the words selected in capitals, in the paragraph that holds them;
// "explain" answers and changes nothing ("plan" too, about the harbour plan); "write" writes a new
// Note, "Ferry summary"; "long" reads the ferry interviews step by step, each step
// waiting until the number in the mode file's ".step" file reaches it, then answers with
// Citations; "lost" finds no conversation to resume, then changes as "change" does; "make" writes
// a new Note, proposes a change to the Note the mode file's ".other" file names, and makes a page.
// The init event names the model `--model` asked for, as Claude Code's does, and an `initialize`
// control request is answered with the models it offers, only in a run started with a run's flags
// and environment: asked anywhere else, it answers with an error, so a spec sees no list.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);
const modeFile = process.env.INCARNAMIND_TEST_OWN_AI_MODE_FILE ?? "";
const readOr = (path, fallback) => {
  try {
    return readFileSync(path, "utf8").trim() || fallback;
  } catch {
    return fallback;
  }
};
const mode = readOr(modeFile, "check");
// Each start, as the spec counts them: what it was started for, and the model a run was given.
if (modeFile !== "") {
  const what = args[0] === "-p" ? "run" : args.slice(0, 2).join(" ");
  const asked = args.includes("--model") ? ` --model ${args[args.indexOf("--model") + 1]}` : "";
  appendFileSync(`${modeFile}.starts`, `${what}${asked}\n`);
}
if (args[0] === "--version") {
  console.log("2.1.330 (Claude Code)");
  process.exit(0);
}
if (args[0] === "auth") process.exit(mode === "signed-out" ? 1 : 0);
// `claude purge <folder> --yes` deletes a project's transcripts; the stand-in keeps none.
if (args[0] === "purge") process.exit(0);

const MODELS = [
  {
    value: "default",
    resolvedModel: "claude-sonnet-5-5",
    displayName: "Default (recommended)",
    description: "Sonnet 5.5 · Best for everyday tasks",
  },
  {
    value: "opus",
    resolvedModel: "claude-opus-5-5",
    displayName: "Opus",
    description: "Opus 5.5 · Most capable for complex work",
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5-5",
    displayName: "Sonnet",
    description: "Sonnet 5.5 · Best for everyday tasks",
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-5-5",
    displayName: "Haiku",
    description: "Haiku 5.5 · Fastest for quick answers",
  },
];
const asked = args.includes("--model") ? args[args.indexOf("--model") + 1] : "default";
const model = (MODELS.find((each) => each.value === asked) ?? MODELS[0]).resolvedModel;

const serverOf = () => {
  const at = args.indexOf("--mcp-config");
  return JSON.parse(readFileSync(args[at + 1] ?? "", "utf8")).mcpServers.incarnamind;
};
const say = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits until the spec lets step `n` go. */
const gate = async (n) => {
  while (Number(readOr(`${modeFile}.step`, "0")) < n) await sleep(100);
};

createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    if (message.request?.subtype === "initialize") {
      const held =
        ["--restricted", "--disable-slash-commands", "--strict-mcp-config"].every((flag) =>
          args.includes(flag),
        ) &&
        args[args.indexOf("--permission-mode") + 1] === "dontAsk" &&
        process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === "1" &&
        process.env.ENABLE_CLAUDEAI_MCP_SERVERS === "false" &&
        process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS === "1" &&
        process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === "1";
      say({
        type: "control_response",
        response: held
          ? { subtype: "success", request_id: message.request_id, response: { models: MODELS } }
          : { subtype: "error", request_id: message.request_id, error: "not a run's flags" },
      });
      return;
    }
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
  if (mode === "lost" && args.includes("--resume")) {
    say({ type: "result", subtype: "error_during_execution", is_error: true });
    process.exit(1);
  }
  const agent = new Client({ name: "fake-claude-code", version: "1.0.0" });
  await agent.connect(new StdioClientTransport({ ...serverOf(), stderr: "pipe" }));
  const { tools } = await agent.listTools();
  say({
    type: "system",
    subtype: "init",
    model,
    tools: tools.map((tool) => `mcp__incarnamind__${tool.name}`),
    mcp_servers: [{ name: "incarnamind", status: "connected" }],
  });
  if (mode === "wait") {
    // Says what it is about to do, as the instructions ask, then works on until it is stopped.
    say({
      type: "assistant",
      message: { content: [{ type: "text", text: "Looking at your note" }] },
    });
    return;
  }
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
  const sayText = (text) =>
    say({ type: "assistant", message: { content: [{ type: "text", text }] } });
  // Search gives Passages, not Citations: each Passage is cited by a quote copied from its text,
  // as an agent cites one. A Passage whose quote isn't found has none.
  const citesOf = async (passages) => {
    if (passages.length === 0) return [];
    const cited = await use("cite", {
      citations: passages.map((each) => ({
        passageId: each.passageId,
        quote: each.text.split(/(?<=[.!?])\s/)[0].trim(),
      })),
    });
    return (cited?.citations ?? []).map((each) =>
      each.cite ? (each.cite.startsWith("[cite:") ? each.cite : `[cite:${each.cite}]`) : null,
    );
  };
  if (prompt.startsWith("In their note") && mode === "long") {
    // Thinks after its reads, as Claude Code sends a tick about every second.
    let ticking = null;
    await gate(1);
    sayText("Looking at your note first.");
    await use("read_mind", { mindId, named: true });
    await gate(2);
    sayText("Finding the ferry interviews.");
    const found = await use("search", { query: "ferry crossing interview" });
    const passages = found?.passages ?? [];
    const documents = [...new Set(passages.map((each) => each.documentId))].slice(0, 5);
    let step = 3;
    for (const documentId of documents) {
      await gate(step++);
      await use("read_passages", { documentId });
    }
    await gate(step++);
    sayText("Comparing what the crew and the passengers said.");
    ticking = setInterval(() => say({ type: "system", subtype: "thinking_tokens" }), 1000);
    await gate(step++);
    clearInterval(ticking);
    const tokens = await citesOf(passages.slice(0, 5));
    const cite = (n) => (tokens[n] ? ` ${tokens[n]}` : "");
    await agent.close();
    say({
      type: "result",
      subtype: "success",
      is_error: false,
      result: [
        "The five interviews agree on one thing: the 07:40 crossing is the one that fails people.",
        "",
        `**Crew.** The deckhand says the 07:40 leaves late most weeks because loading the freight vans takes too long.${cite(0)} The harbour master puts it down to the single ramp at Kestrel Bay.${cite(1)}`,
        "",
        `**Passengers.** The commuter has missed the 08:15 train four times since September.${cite(2)} The café owner sees the queue on the quay start at 07:00.${cite(3)}`,
        "",
        "**What they would change:**",
        `- a second ramp, or vans loaded before the foot passengers${cite(4)}`,
        "- a timetable that names the real departure time",
        "",
        "I left your note as it is; say if you want this summary in it.",
      ].join("\n"),
    });
    return;
  }
  if (prompt.startsWith("In their note") && mode === "make") {
    // Writes a new Note, proposes a change to another Note the spec names, and makes a page.
    const other = readOr(`${modeFile}.other`, "");
    sayText("Writing up the delays as a new note.");
    await use("create_mind", {
      title: "Ferry delays: what the interviews say",
      markdown:
        "# Ferry delays: what the interviews say\n\nThe 07:40 crossing from Kestrel Bay leaves late most weekdays, because the freight vans load first.\n",
    });
    sayText("Fixing the departure time in the timetable note.");
    const read = await use("read_mind", { mindId: other, named: true });
    await use("propose_changes", {
      mindId: other,
      version: read?.version,
      changes: [{ paragraph: "¶1", text: "The 07:40 crossing leaves at about 07:55 on weekdays." }],
    });
    sayText("Making a page for the harbour board.");
    await use("publish_canvas", {
      title: "Kestrel Bay ferry delays",
      html: "<!doctype html><html><body><h1>Kestrel Bay ferry delays</h1><p>The 07:40 crossing leaves late most weekdays.</p></body></html>",
    });
    await agent.close();
    say({
      type: "result",
      subtype: "success",
      is_error: false,
      result:
        "I wrote a new note on the delays, proposed one change to “Ferry timetable”, and made a page for the harbour board.",
    });
    return;
  }
  if (prompt.startsWith("In their note")) {
    if (mode === "plan") {
      await agent.close();
      say({
        type: "result",
        subtype: "success",
        is_error: false,
        result:
          "A second ramp at Kestrel Bay, in 2027, so the vans and the foot passengers can board at once.",
      });
      return;
    }
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
    if (mode === "write") {
      await use("create_mind", {
        title: "Ferry summary",
        markdown: "The harbour handled 1,240 ship calls in 2025.",
      });
      await agent.close();
      say({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "I wrote a new note, “Ferry summary”, from this one.",
      });
      return;
    }
    const quote = prompt.match(/The words they selected in it: “([^”]*)”/)?.[1] ?? "";
    const read = await use("read_mind", { mindId, named: true });
    // With nothing selected, the Note's second paragraph is the one changed.
    const line = (read?.markdown ?? "")
      .split("\n")
      .find((each) => (quote === "" ? each.startsWith("¶2 ") : each.includes(quote)));
    const name = line?.match(/¶\d+/)?.[0];
    if (name && line) {
      // A paragraph the User wrote reads "(the User wrote this)" between its name and its words.
      const words = line
        .slice(line.indexOf(name) + name.length)
        .replace(/^\s*\(the User (?:wrote|changed) this\)/, "")
        .trim();
      // "outside": the whole paragraph, beyond the words selected.
      const text =
        quote === "" || mode === "outside"
          ? words.toUpperCase()
          : words.replace(quote, quote.toUpperCase());
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
  if (mode === "check-mixed" || mode === "check-good") {
    // Waits for the spec's step 1, then hands back verdicts resting on Citations it found:
    // "check-good" every sentence supported; "check-mixed" one each supported, partly supported
    // and contradicted.
    await gate(1);
    const found = await use("search", { query: "ferry crossing ramp late" });
    const cites = (await citesOf(found?.passages ?? [])).filter(Boolean);
    const verdicts =
      mode === "check-good" ? ["supported"] : ["supported", "partly supported", "contradicted"];
    await use("report_check", {
      mindId,
      task: given.task,
      results: given.sentences.map((sentence, index) => {
        const verdict = verdicts[index % verdicts.length];
        return {
          n: sentence.n,
          verdict,
          ...(verdict !== "partly supported" && { cites: [cites[index % cites.length]] }),
          explanation: "The interviews say so.",
        };
      }),
    });
    await agent.close();
    say({ type: "result", subtype: "success", is_error: false, result: "Checked." });
    return;
  }
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
