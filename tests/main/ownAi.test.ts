/**
 * The desktop app's run of the User's own Claude Code for a check (ADR-0032): what it starts, what
 * it hands over and where, how it holds the command line to IncarnaMind's Tools, and how it reads
 * whether Claude Code is there and signed in. A small Node program stands in for `claude`.
 */
import { spawn as spawnNode } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOwnAi } from "../../src/main/ownAi";

const launch = vi.hoisted(() => vi.fn());
vi.mock("../../src/main/processes", () => ({
  createLoginShellProcesses: () => ({ spawn: launch }),
}));

afterEach(() => launch.mockReset());

const TOOLS = [
  "check_mind_yourself",
  "search",
  "read_passages",
  "cite",
  "run_analysis",
  "report_check",
];
const SERVER = {
  command: "/Applications/IncarnaMind.app/Contents/MacOS/IncarnaMind",
  args: ["/Applications/IncarnaMind.app/agentShim.cjs"],
  env: {
    INCARNAMIND_AGENT_TOKEN: "im_grant_for_the_test",
    INCARNAMIND_AGENT_SOCKET: "/tmp/a.sock",
  },
};

/** What the run's settings file held while it ran, and its mode. */
let seen: { file: string; mode: number; text: string } | null = null;

/** `claude` for each call: its version, its sign-in, then the run's own program. */
function useClaude({
  version = "2.1.330 (Claude Code)",
  signedIn = true,
  run = "",
}: {
  version?: string;
  signedIn?: boolean;
  run?: string;
} = {}) {
  seen = null;
  launch.mockImplementation(async (_command: string, args: string[], options: { cwd?: string }) => {
    const program =
      args[0] === "--version"
        ? `console.log(${JSON.stringify(version)})`
        : args[0] === "auth"
          ? `process.exit(${signedIn ? 0 : 1})`
          : run;
    const at = args.indexOf("--mcp-config");
    if (at >= 0) {
      const file = args[at + 1] ?? "";
      seen = { file, mode: (await stat(file)).mode & 0o777, text: await readFile(file, "utf8") };
    }
    const child = spawnNode(process.execPath, ["-e", program], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      stdio: "pipe",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return child;
  });
}

/** A stand-in for the stream-json session: settings first, then `after` once the prompt comes. */
const session = (after: unknown[]) => `
  const lines = require("node:readline").createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const v = JSON.parse(line);
    if (v.type === "control_request") {
      console.log(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: v.request_id,
        response: { effective: { disableAllHooks: true }, sources: [{ source: "flagSettings", settings: {} }] } } }));
    } else if (v.type === "user") {
      for (const each of ${JSON.stringify(after)}) console.log(JSON.stringify(each));
    }
  });
`;

const init = (tools = TOOLS.map((tool) => `mcp__incarnamind__${tool}`), status = "connected") => ({
  type: "system",
  subtype: "init",
  tools,
  mcp_servers: [{ name: "incarnamind", status }],
});
const done = { type: "result", subtype: "success", is_error: false, result: "Checked." };
const call = (name: string) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: "t1", name, input: {} }] },
});

const run = (signal = new AbortController().signal) =>
  createOwnAi().run({
    client: "claude-code",
    server: SERVER,
    tools: TOOLS,
    instructions: "Check the note.",
    prompt: "Check my note “Tides” in IncarnaMind (mindId: m1).",
    signal,
  });

describe("a check run on the User's own Claude Code", () => {
  // protects=the run starts Claude Code with none of its own tools, hooks, connectors or saved session, IncarnaMind's server alone and its six Tools allowed, the grant only in a settings file only the User's account reads, which goes with the run's folder; fails_when=a flag that holds the agent to IncarnaMind's Tools is missing, safe mode drops the server, or the grant is on the command line or left behind
  it("starts Claude Code held to IncarnaMind's Tools, the grant in a private file that goes with the run", async () => {
    useClaude({ run: session([init(), call("mcp__incarnamind__check_mind_yourself"), done]) });
    await expect(run()).resolves.toEqual({ kind: "finished" });
    const [command, args, options] = launch.mock.calls[0] ?? [];
    expect(command).toBe("claude");
    expect(args).toEqual(
      expect.arrayContaining([
        "-p",
        "--restricted",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--allowedTools",
        TOOLS.map((tool) => `mcp__incarnamind__${tool}`).join(","),
      ]),
    );
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual([
      "--tools",
      "",
    ]);
    expect(
      args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2),
    ).toEqual(["--permission-mode", "dontAsk"]);
    expect(args).not.toContain("--safe-mode");
    expect(args.join(" ")).not.toContain(SERVER.env.INCARNAMIND_AGENT_TOKEN);
    expect(JSON.parse(args[args.indexOf("--settings") + 1])).toEqual({
      disableAllHooks: true,
      disableClaudeAiConnectors: true,
    });
    expect(options.env).toMatchObject({ ENABLE_CLAUDEAI_MCP_SERVERS: "false" });
    expect(seen?.mode).toBe(0o600);
    expect(JSON.parse(seen?.text ?? "{}")).toEqual({
      mcpServers: { incarnamind: { type: "stdio", ...SERVER } },
    });
    await expect(stat(options.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  // protects=the run stops at the first sign that a flag didn't hold: another tool or server at the start, a call outside the six; fails_when=Claude Code's own tools, another server, or another of IncarnaMind's Tools go unnoticed
  it.each([
    [
      "a tool of its own",
      [init(["Bash", ...TOOLS.map((tool) => `mcp__incarnamind__${tool}`)]), done],
    ],
    ["IncarnaMind's server not connected", [init(undefined, "failed"), done]],
    ["a call to a Tool outside the check's", [init(), call("mcp__incarnamind__create_mind"), done]],
  ])("stops a run that shows %s", async (_name, after) => {
    useClaude({ run: session(after) });
    await expect(run()).resolves.toEqual({ kind: "failed", reason: "isolation" });
  });

  // protects=a plan's limit, an account's billing or a lost sign-in is told from Claude Code's own error category, never guessed from its words; anything else says only that it stopped; fails_when=a limit reads as a generic failure, or a text match decides it
  it.each([
    ["rate_limit", "plan-limit"],
    ["billing_error", "billing"],
    ["authentication_failed", "signed-out"],
    ["server_error", "other"],
  ])("tells a failed run by the category %s", async (category, reason) => {
    const retry = { type: "system", subtype: "api_retry", error: category, attempt: 1 };
    const failed = {
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Usage limit reached",
    };
    useClaude({ run: session([init(), retry, failed]) });
    await expect(run()).resolves.toEqual({ kind: "failed", reason });
  });

  // protects=Stop ends Claude Code and every process it started, and removes the run's folder; fails_when=a stopped run keeps the process or its folder with the grant
  it("ends the run and removes its folder when stopped", async () => {
    const stop = new AbortController();
    useClaude({ run: "process.stdin.resume(); setInterval(() => {}, 1000);" });
    const job = run(stop.signal);
    await vi.waitFor(() => expect(launch).toHaveBeenCalled());
    stop.abort();
    await expect(job).rejects.toThrow();
    const [, , options] = launch.mock.calls[0] ?? [];
    await expect(stat(options.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("whether Claude Code can run a check", () => {
  // protects=IncarnaMind reads only the exit codes of `--version` and `auth status`, and says missing, too old, signed out or ready; fails_when=a missing or old command line is taken as ready, or a signed-out one starts a run
  it("reads missing, too old, signed out and ready", async () => {
    launch.mockRejectedValueOnce(
      Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
    );
    await expect(createOwnAi().status("claude-code")).resolves.toEqual({ kind: "missing" });

    useClaude({ version: "2.1.100 (Claude Code)" });
    await expect(createOwnAi().status("claude-code")).resolves.toEqual({
      kind: "too-old",
      found: "2.1.100",
      lowest: "2.1.248",
    });

    useClaude({ signedIn: false });
    await expect(createOwnAi().status("claude-code")).resolves.toEqual({ kind: "signed-out" });

    useClaude();
    await expect(createOwnAi().status("claude-code")).resolves.toEqual({ kind: "ready" });
    expect(launch.mock.calls.map(([, args]) => args.join(" "))).toEqual([
      "--version",
      "--version",
      "--version",
      "auth status",
      "--version",
      "auth status",
    ]);
  });
});
