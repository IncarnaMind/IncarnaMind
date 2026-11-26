// Stands in for the User's Claude Code in the meeting stills (#3762), as e2e/fixtures/fakeClaudeCode.mjs
// does for the specs: `--version` and `auth status` as `claude` answers them, and a run that reaches
// IncarnaMind's server only through the settings file it was given. The mode file names what a run
// does: "ask" answers a question from the meeting's Transcript with Citations; "notes" writes the
// meeting's notes under the User's own lines; anything else is a check, which finds no support for
// the one sentence nobody said and supports the rest.
import { readFileSync } from "node:fs";
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
if (args[0] === "--version") {
  console.log("2.1.330 (Claude Code)");
  process.exit(0);
}
if (args[0] === "auth") process.exit(0);
if (args[0] === "purge") process.exit(0);

const MODELS = [
  {
    value: "default",
    resolvedModel: "claude-sonnet-5-5",
    displayName: "Default (recommended)",
    description: "Sonnet 5.5 · Best for everyday tasks",
  },
];
const own = args[args.indexOf("--permission-prompt-tool") + 1] === "stdio";
const serverOf = () => {
  const at = args.indexOf("--mcp-config");
  return JSON.parse(readFileSync(args[at + 1] ?? "", "utf8")).mcpServers.incarnamind;
};
const say = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const WORDS = {
  en: {
    ask: [
      ["start on the third of March", "The ramp works start on the third of March."],
      ["07:55", "The 07:40 crossing moves to 07:55 for the six weeks."],
    ],
    answer: (c) =>
      `The ramp works start on 3 March.${c[0]} While they last, the 07:40 crossing leaves at 07:55.${c[1]}`,
    notes: [
      {
        after: 0,
        key: "six weeks",
        text: (c) => `The ramp works start on 3 March and close the slipway for six weeks.${c}`,
      },
      {
        after: 0,
        key: "two hundred thousand",
        text: (c) => `The dredging adds about £200,000, taking the budget to £1.4 million.${c}`,
      },
      { after: 0, text: () => "The harbour board has already approved the extra cost." },
      {
        after: 1,
        key: "07:55",
        text: (c) => `The 07:40 crossing moves to 07:55 while the works last.${c}`,
      },
      {
        after: 1,
        key: "confirms the tide tables by Friday",
        text: (c) => `The harbour master confirms the tide tables by Friday.${c}`,
      },
    ],
    unsupported: "approved",
    nobody: "Nobody in the call said so.",
    said: "The call says so.",
    done: "I filled in your notes from the call.",
  },
  zh: {
    ask: [
      ["三月三日", "坡道工程三月三日开工。"],
      ["七点五十五", "七点四十的班次改到七点五十五，持续六周。"],
    ],
    answer: (c) => `坡道工程3月3日开工。${c[0]}施工期间，7:40 的班次改为 7:55 开出。${c[1]}`,
    notes: [
      { after: 0, key: "六周", text: (c) => `坡道工程3月3日开工，滑道关闭六周。${c}` },
      { after: 0, key: "二十万", text: (c) => `疏浚增加约20万英镑，预算增至140万英镑。${c}` },
      { after: 0, text: () => "港务委员会已经批准了追加的费用。" },
      { after: 1, key: "七点五十五", text: (c) => `施工期间，7:40 的班次改为 7:55。${c}` },
      { after: 1, key: "周五前确认潮汐表", text: (c) => `港务长周五前确认潮汐表。${c}` },
    ],
    unsupported: "批准",
    nobody: "通话里没有人这样说。",
    said: "通话里这样说过。",
    done: "已根据通话补全你的笔记。",
  },
};

createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    say({
      type: "control_response",
      response:
        message.request?.subtype === "initialize" && own
          ? {
              subtype: "success",
              request_id: message.request_id,
              response: {
                models: MODELS,
                current_permission_mode: "default",
                hooks_applied: true,
                hook_on_failure_supported: true,
              },
            }
          : {
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
  const prompt = String(message.message?.content ?? "");
  const words = /\p{Script=Han}/u.test(prompt) || mode.endsWith("-zh") ? WORDS.zh : WORDS.en;
  const agent = new Client({ name: "fake-claude-code", version: "1.0.0" });
  await agent.connect(new StdioClientTransport({ ...serverOf(), stderr: "pipe" }));
  const { tools } = await agent.listTools();
  say({
    type: "system",
    subtype: "init",
    model: MODELS[0].resolvedModel,
    session_id: "fake-session",
    ...(own && { permissionMode: "default" }),
    tools: tools.map((tool) => `mcp__incarnamind__${tool.name}`),
    mcp_servers: [{ name: "incarnamind", status: "connected" }],
  });
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
  const transcript = async () => {
    const documentId = readOr(`${modeFile}.doc`, "");
    if (!documentId) return [];
    return (await use("read_passages", { documentId }))?.passages ?? [];
  };
  /** A Citation for the sentence of the Transcript that holds `key`, quoted word for word. */
  const citeFor = async (passages, key) => {
    for (const passage of passages) {
      const at = passage.text.indexOf(key);
      if (at < 0) continue;
      const before = passage.text.slice(0, at);
      const start = Math.max(
        ...[". ", "? ", "! ", "\n", "。", "？", "！", ": ", "："].map((mark) => {
          const found = before.lastIndexOf(mark);
          return found < 0 ? 0 : found + mark.length;
        }),
      );
      const rest = passage.text.slice(at);
      const end = rest.search(/[.?!。？！](\s|$)|[.?!。？！]/);
      const quote = passage.text.slice(start, at + (end < 0 ? rest.length : end + 1)).trim();
      if (!quote) continue;
      const cited = await use("cite", { citations: [{ passageId: passage.passageId, quote }] });
      const cite = cited?.citations?.[0]?.cite;
      if (cite) return cite.startsWith("[cite:") ? cite : `[cite:${cite}]`;
    }
    return "";
  };
  const end = async (result) => {
    await agent.close();
    say({ type: "result", subtype: "success", is_error: false, result });
  };

  if (prompt.startsWith("In their note") && mode.startsWith("ask")) {
    sayText(words === WORDS.zh ? "正在读转写稿。" : "Reading the Transcript.");
    const passages = await transcript();
    const cites = [];
    for (const [key] of words.ask) cites.push(await citeFor(passages, key));
    await end(words.answer(cites.map((each) => (each ? ` ${each}` : ""))));
    return;
  }
  if (prompt.startsWith("In their note") && mode.startsWith("notes")) {
    sayText(
      words === WORDS.zh ? "正在读转写稿和你的笔记。" : "Reading the Transcript and your notes.",
    );
    const passages = await transcript();
    const read = await use("read_mind", { mindId, named: true });
    const names = (read?.markdown ?? "")
      .split("\n")
      .map((each) => each.match(/^¶(\d+)/)?.[1])
      .filter(Boolean);
    const changes = [];
    for (const note of words.notes) {
      const cite = note.key ? await citeFor(passages, note.key) : "";
      const at = names[note.after] ?? names.at(-1) ?? "0";
      changes.push({ paragraph: `¶${at}+`, text: note.text(cite ? ` ${cite}` : "") });
    }
    await use("propose_changes", { mindId, version: read?.version, changes });
    await end(words.done);
    return;
  }
  const given = await use("check_mind_yourself", { mindId });
  const passages = await transcript();
  const results = [];
  for (const sentence of given?.sentences ?? []) {
    const text = String(sentence.text ?? "");
    if (text.includes(words.unsupported)) {
      results.push({ n: sentence.n, verdict: "not found", explanation: words.nobody });
      continue;
    }
    const note = words.notes.find((each) => each.key && text.includes(each.text("").slice(0, 8)));
    const cite = note?.key ? await citeFor(passages, note.key) : "";
    results.push(
      cite
        ? { n: sentence.n, verdict: "supported", cites: [cite], explanation: words.said }
        : { n: sentence.n, verdict: "nothing to check", explanation: words.said },
    );
  }
  await use("report_check", { mindId, task: given?.task, results });
  await end("Checked.");
});
