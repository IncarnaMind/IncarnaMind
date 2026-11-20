/**
 * The agents in wide use, each given what its own documentation takes (#3374): the exact line it
 * runs, the settings pasted into its screen, or the entry in its settings file, cited beside each
 * agent in src/core/agents/clients.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentLaunch } from "../../src/core";
import {
  AGENT_CLIENT_DEFINITIONS,
  clientDefinition,
  isInexactNumber,
  promptLinkFor,
  withMcpServersEntry,
} from "../../src/core/agents/clients";
import { AGENT_CLIENT_IDS } from "../../src/core/api";

const LAUNCH: AgentLaunch = {
  command: "/Applications/IncarnaMind.app/Contents/MacOS/IncarnaMind",
  args: ["/Applications/IncarnaMind.app/Contents/Resources/app.asar/out/main/agentShim.js"],
  env: {
    ELECTRON_RUN_AS_NODE: "1",
    INCARNAMIND_AGENT_SOCKET: "/Users/ada/Library/Application Support/IncarnaMind/agents.sock",
    INCARNAMIND_AGENT_TOKEN: "k3y",
  },
};
const SERVER = `${LAUNCH.command} ${LAUNCH.args[0]}`;
const ENV = [
  "ELECTRON_RUN_AS_NODE=1",
  "'INCARNAMIND_AGENT_SOCKET=/Users/ada/Library/Application Support/IncarnaMind/agents.sock'",
  "INCARNAMIND_AGENT_TOKEN=k3y",
];
const flags = (flag: string) => ENV.map((each) => `${flag} ${each}`).join(" ");
const entry = { command: LAUNCH.command, args: LAUNCH.args, env: LAUNCH.env };

const definition = (id: string) => {
  const found = clientDefinition(id);
  if (!found) throw new Error(`No agent ${id}.`);
  return found;
};

describe("the agents IncarnaMind is set up in", () => {
  // protects=each agent is set up the way it says; fails_when=an agent listed with a line has none, a file agent writes no file, or the list and its ids drift apart
  it("gives every agent what its kind of setup needs, and lists each id once", () => {
    expect(AGENT_CLIENT_DEFINITIONS.map((each) => each.id)).toEqual([...AGENT_CLIENT_IDS]);
    for (const client of AGENT_CLIENT_DEFINITIONS) {
      // A line is a "command" agent's setup, and what a "file" agent is given when its file can't be written.
      if (client.setup === "command") expect(client.command, client.id).toBeDefined();
      else if (client.command) expect(client.setup, client.id).toBe("file");
      expect(client.setup === "link", client.id).toBe(client.link !== undefined);
      expect(client.setup === "file", client.id).toBe((client.files?.length ?? 0) > 0);
    }
    expect(AGENT_CLIENT_DEFINITIONS.at(-1)?.id).toBe("other");
  });

  // protects=the line the User runs adds IncarnaMind in each agent, for every project, its key and socket included; fails_when=a line differs from the form the agent's documentation gives, misses a variable, or adds it to one project only
  it.each([
    ["claude-code", `claude mcp add --scope user incarnamind ${flags("--env")} -- ${SERVER}`],
    ["opencode", `opencode mcp add incarnamind --global ${flags("--env")} -- ${SERVER}`],
    [
      "openclaw",
      `openclaw mcp add incarnamind --command ${LAUNCH.command} --arg ${LAUNCH.args[0]} ${flags("--env")} --no-probe`,
    ],
    ["gemini-cli", `gemini mcp add -s user ${flags("-e")} incarnamind ${SERVER}`],
    ["qwen-code", `qwen mcp add --scope user ${flags("-e")} incarnamind ${SERVER}`],
  ])("gives %s its own line", (id, line) => {
    expect(definition(id).command?.(LAUNCH, "darwin")).toBe(line);
  });

  // protects=a line works in PowerShell too; fails_when=a word is left unquoted for Windows
  it("quotes each word of a line for PowerShell on Windows", () => {
    const windows: AgentLaunch = {
      command: "C:\\Users\\Ada Lovelace\\AppData\\Local\\Programs\\IncarnaMind\\IncarnaMind.exe",
      args: ["C:\\Program Files\\IncarnaMind\\agentShim.js"],
      env: { INCARNAMIND_AGENT_TOKEN: "k3y" },
    };
    expect(definition("gemini-cli").command?.(windows, "win32")).toBe(
      `gemini mcp add -s user -e "INCARNAMIND_AGENT_TOKEN=k3y" incarnamind "${windows.command}" "${windows.args[0]}"`,
    );
  });

  // protects=what the User pastes is what the agent's own screen takes; fails_when=Zed is given the settings file's wrapper, or CodeBuddy and MiniMax Code lose the type their form asks for
  it("gives each agent that takes pasted settings the form its screen takes", () => {
    const pasted = (id: string) => JSON.parse(definition(id).pasted?.(LAUNCH) ?? "null");
    expect(pasted("zed")).toEqual({ incarnamind: entry });
    for (const id of ["codebuddy", "minimax-code"]) {
      expect(pasted(id)).toEqual({ mcpServers: { incarnamind: { type: "stdio", ...entry } } });
    }
    for (const id of ["devin", "trae", "qoder", "kilo-code", "other"]) {
      expect(definition(id).setup, id).toBe("manual");
      expect(definition(id).pasted, id).toBeUndefined();
    }
  });

  // protects=IncarnaMind writes only the files each agent's documentation gives, in the shape it reads, and Claude Code's own state file whole with a copy kept (#3487); fails_when=VS Code's entry lacks the type and tools Copilot's file takes, Claude Code's lacks the type its CLI writes or is written with no copy, or a file is a synced or commented one
  it("writes each file agent's own documented file, in its shape", () => {
    const keepingCopy = AGENT_CLIENT_DEFINITIONS.filter((each) =>
      each.files?.some((file) => file.backup),
    );
    expect(keepingCopy.map((each) => each.id)).toEqual(["claude-code"]);
    const files = Object.fromEntries(
      AGENT_CLIENT_DEFINITIONS.filter((each) => each.setup === "file").map((each) => [
        each.id,
        each.files?.map((file) => [file.path.join("/"), (file.entry?.(LAUNCH) ?? entry) as object]),
      ]),
    );
    expect(files).toEqual({
      "claude-code": [[".claude.json", { type: "stdio", ...entry }]],
      codex: [[".codex/config.toml", entry]],
      vscode: [[".copilot/mcp-config.json", { type: "stdio", ...entry, tools: ["*"] }]],
      antigravity: [[".gemini/config/mcp_config.json", entry]],
      cline: [[".cline/data/settings/cline_mcp_settings.json", entry]],
      "kimi-code": [[".kimi-code/mcp.json", entry]],
      workbuddy: [[".workbuddy/mcp.json", entry]],
    });
  });

  // protects=the Skill goes where each agent reads Skills, the shared folder first where it reads it; fails_when=an agent's Skill lands in a folder it doesn't read, or Claude Code is given the shared folder
  it("puts the Skill in the folder each agent reads first", () => {
    const first = Object.fromEntries(
      AGENT_CLIENT_DEFINITIONS.map((each) => [each.id, each.skills?.[0]?.join("/") ?? null]),
    );
    expect(first).toMatchObject({
      "claude-code": ".claude/skills",
      codex: ".agents/skills",
      cursor: ".agents/skills",
      vscode: ".copilot/skills",
      opencode: ".agents/skills",
      openclaw: ".agents/skills",
      "gemini-cli": ".agents/skills",
      cline: ".cline/skills",
      antigravity: ".gemini/config/skills",
      workbuddy: null,
      other: null,
    });
  });

  // protects=only the agents whose own documentation gives a link that types a prompt and doesn't send it have one, in the form the page gives, within its limit (#3373); fails_when=an agent gets a link its page doesn't give, the form drifts, or a prompt past the limit is linked
  it("gives a prompt link only where the agent's documentation gives one, within its limit", () => {
    expect(AGENT_CLIENT_DEFINITIONS.filter((each) => each.prompt).map((each) => each.id)).toEqual([
      "claude-desktop",
      "claude-code",
      "codex",
      "cursor",
    ]);
    expect(promptLinkFor("claude-desktop", "Fix it?")).toBe("claude://claude.ai/new?q=Fix%20it%3F");
    expect(promptLinkFor("claude-code", "Fix it?")).toBe("claude-cli://open?q=Fix%20it%3F");
    expect(promptLinkFor("codex", "Fix it?")).toBe("codex://new?prompt=Fix%20it%3F");
    expect(promptLinkFor("cursor", "Fix it?")).toBe(
      "cursor://anysphere.cursor-deeplink/prompt?text=Fix%20it%3F",
    );
    expect(promptLinkFor("claude-code", "a".repeat(5_000))).not.toBeNull();
    expect(promptLinkFor("claude-code", "a".repeat(5_001))).toBeNull();
    // Cursor counts the whole link once encoded: a Chinese character takes nine.
    expect(promptLinkFor("cursor", "渡".repeat(1_200))).toBeNull();
    expect(promptLinkFor("cursor", "渡".repeat(1_000))).not.toBeNull();
    for (const id of ["vscode", "opencode", "gemini-cli", "other"]) {
      expect(promptLinkFor(id, "Fix it?"), id).toBeNull();
    }
    expect(promptLinkFor(null, "Fix it?")).toBeNull();
  });
});

describe("a state file's numbers are kept exactly or the file is left alone (#3487)", () => {
  const ENTRY = { type: "stdio", command: "c", args: [], env: {} };
  const kept = (text: string) => withMcpServersEntry(text, ENTRY);
  afterEach(() => vi.restoreAllMocks());

  it("judges a whole number past the safe range inexact, however it is written", () => {
    for (const value of [JSON.parse("12345678901234567890"), 2 ** 53, -(2 ** 53) - 2, 1e300]) {
      expect(isInexactNumber(value), String(value)).toBe(true);
    }
    for (const value of [
      0,
      -0,
      41,
      Number.MAX_SAFE_INTEGER,
      0.1,
      1.5e-7,
      "12345678901234567890",
      null,
    ]) {
      expect(isInexactNumber(value), String(value)).toBe(false);
    }
  });

  it.each([
    "12345678901234567890",
    "-12345678901234567890",
    "12345678901234567890.0",
    "1.2345678901234567e19",
    "9007199254740993",
  ])("refuses a file holding %s, which JSON can't write back as it was", (number) => {
    expect(() => kept(`{"count": ${number}}`)).toThrow(/can't be kept exactly/);
    expect(() => kept(`{"nested": {"list": [${number}]}}`)).toThrow(/can't be kept exactly/);
  });

  it("keeps the numbers JSON writes back as they were", () => {
    const written = kept('{"a": 9007199254740991, "b": 0.1, "c": -3, "d": 1.5e-7, "e": 0}');
    expect(JSON.parse(written)).toMatchObject({
      a: 9007199254740991,
      b: 0.1,
      c: -3,
      d: 1.5e-7,
      e: 0,
    });
  });

  it("refuses the same where the runtime gives a reviver no source text", () => {
    const parse = JSON.parse.bind(JSON);
    vi.spyOn(JSON, "parse").mockImplementation((text, reviver) =>
      parse(text, reviver ? (key, value) => reviver(key, value) : undefined),
    );
    expect(() => kept('{"count": 12345678901234567890}')).toThrow(/can't be kept exactly/);
    expect(() => kept('{"count": 12345678901234567890.0}')).toThrow(/can't be kept exactly/);
    expect(JSON.parse(kept('{"count": 12}')).count).toBe(12);
  });
});
