import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import type {
  AnswerToolCall,
  ApprovalRequest,
  Core,
  CoreAdapters,
  CoreEvents,
  ProcessLauncher,
  SkillScriptApprovalRequest,
} from "../../src/core";
import { CHAT_FLOW_SENDS } from "../../src/core/providers/chat";
import { createProcessLauncher } from "../../src/main/processes";
import { answerEnded, askNew } from "../helpers/citations";
import { isRunning } from "../helpers/connectors";
import { createTempDataFolder, nextEvent, startCore } from "../helpers/core";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { answerIn, answerText } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import { importSkill, simpleSkillMd, writeFolder } from "../helpers/skills";

/** Interpreters this machine has: the tests that need one are skipped without it. */
function hasCommand(command: string): boolean {
  const found = spawnSync(command, ["--version"], { stdio: "ignore" });
  return found.error === undefined && found.status === 0;
}
const PYTHON = hasCommand(process.platform === "win32" ? "python" : "python3");
const BASH = process.platform !== "win32" && hasCommand("bash");

/** A Skill of tiny scripts, each doing one thing the tests look for. */
const TOOLBOX = {
  "SKILL.md": simpleSkillMd("toolbox", "Small scripts for tests. Use for running scripts."),
  // Logs that it ran to the file it's given, then reports its arguments and surroundings.
  "scripts/echo.js": [
    'const { appendFileSync, readdirSync, writeFileSync } = require("node:fs");',
    "const [log, ...rest] = process.argv.slice(2);",
    'appendFileSync(log, "ran\\n");',
    'const before = readdirSync(".");',
    'writeFileSync("made-by-the-script.txt", "x");',
    "console.log(JSON.stringify({ args: rest, skillDir: process.env.SKILL_DIR, cwd: process.cwd(), before }));",
  ].join("\n"),
  // Starts a process of its own, writes both pids to the file it's given, then never ends.
  "scripts/sleep.js": [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });',
    "writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, child: child.pid }));",
    'console.log("started");',
    "setInterval(() => {}, 1000);",
  ].join("\n"),
  // Starts a process in a session of its own, which a stop can't reach, holding the output open.
  "scripts/escape.js": [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit", detached: true });',
    "writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, child: child.pid }));",
    "setInterval(() => {}, 1000);",
  ].join("\n"),
  // More than is kept of each stream.
  "scripts/flood.js": [
    'process.stdout.write("S".repeat(30000) + "TAIL-OUT\\n");',
    'process.stderr.write("HEAD-ERR\\n" + "E".repeat(30000));',
  ].join("\n"),
  "scripts/fail.js": 'console.error("boom");\nprocess.exitCode = 3;\n',
  "scripts/hello.py": 'import sys\nprint("hello from python", " ".join(sys.argv[1:]))\n',
  "scripts/hello.sh": 'echo "hello from bash $1"\n',
  "scripts/convert.ts": 'console.log("typescript");\n',
};

const SCRIPT_TOOL = "run_skill_script";

/**
 * Starts processes with a small environment of the test process's (PATH,
 * HOME, temporary folders), and nothing else: no keys reach the scripts.
 */
function scriptProcesses(extra: Record<string, string> = {}): ProcessLauncher {
  const keep = [
    "PATH",
    "Path",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "SYSTEMROOT",
    "ComSpec",
    "PATHEXT",
  ];
  const env: Record<string, string> = {};
  for (const name of keep) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return createProcessLauncher(async () => ({ ...env, ...extra }));
}

/** The environment's PATH set to `dir`, under the name this OS gives it ("Path" on Windows, often). */
function onlyOnPath(dir: string): Record<string, string> {
  const name = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  return { [name]: dir };
}

/**
 * A model that runs one script of the toolbox (once each Answer), then
 * answers "Done."; `results` collects what each run gave it, in order.
 */
function scriptModel(script: string, args: string[] = []) {
  const results: string[] = [];
  const calls: ModelCall[] = [];
  const model = scriptedModel((call) => {
    calls.push(call);
    if (!call.tools.includes(SCRIPT_TOOL)) return { text: "No scripts." };
    const result = call.results.find((each) => each.tool === SCRIPT_TOOL);
    if (!result) {
      return {
        text: "Let me run it.",
        calls: [{ tool: SCRIPT_TOOL, input: { skill: "toolbox", script, args } }],
      };
    }
    results.push(result.text);
    return { text: "Done." };
  });
  return { model, results, calls };
}

interface SetUpOptions {
  processes?: ProcessLauncher;
  scriptRuntimes?: CoreAdapters["scriptRuntimes"];
}

/** What scripts left in the temporary folder: all of it but the core's own count of changes waiting (#2309). */
const scriptsLeftIn = async (folder: string) =>
  (await readdir(folder)).filter((name) => !/^incarnamind-unsaved-[0-9a-f]{16}\.json$/.test(name));

/**
 * A core with a local chat model (no consent asked), the toolbox Skill, a
 * folder for the scripts' working folders, and a Mind with a client.
 */
async function setUp(model: MockLanguageModelV4, options: SetUpOptions = {}) {
  const dataDir = await createTempDataFolder();
  const tempDir = await createTempDataFolder();
  const sources = await createTempDataFolder();
  const core = startCore(dataDir, {
    paths: { dataDir, tempDir },
    createChatModel: scriptedModels(model).createChatModel,
    processes: options.processes ?? scriptProcesses(),
    ...(options.scriptRuntimes && { scriptRuntimes: options.scriptRuntimes }),
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const skill = await importSkill(core, await writeFolder(sources, "toolbox", TOOLBOX));
  const mind = await core.createMind({ title: "Scripts" });
  const client = await connectToMind(core, mind.id);
  return { core, dataDir, tempDir, sources, skill, mind, client };
}

const toolCallsOf = (client: MindClient, answerId: string): AnswerToolCall[] =>
  JSON.parse(String(answerIn(client, answerId).attrs.toolCalls ?? "[]")) as AnswerToolCall[];

/** The script runs on an Answer's cards. */
const scriptCalls = (client: MindClient, answerId: string) =>
  toolCallsOf(client, answerId).filter((call) => call.tool === SCRIPT_TOOL);

/** Collects every approval request and resolution the core announces. */
function recordApprovals(core: Core) {
  const requested: ApprovalRequest[] = [];
  const resolved: CoreEvents["approval.resolved"][] = [];
  core.on("approval.requested", (request) => requested.push(request));
  core.on("approval.resolved", (event) => resolved.push(event));
  return { requested, resolved };
}

/** Asks a Question and waits for its Answer to end; returns the Answer's id. */
async function askAndEnd(core: Core, client: MindClient, mindId: string, text: string) {
  const answerId = await askNew(core, client, mindId, text);
  const ended = await answerEnded(core, answerId);
  return { answerId, ended };
}

/** Lets the toolbox's scripts always run, as after the User confirmed the warning. */
const alwaysRun = (core: Core, skillId: string) =>
  core.setApprovalPolicy({
    subject: { kind: "skill-script", skillId },
    policy: "always",
    riskAccepted: true,
  });

/** The pids `scripts/sleep.js` wrote, once it has. */
async function pidsIn(file: string): Promise<{ pid: number; child: number }> {
  let pids: { pid: number; child: number } | undefined;
  await vi.waitFor(
    async () => {
      pids = JSON.parse(await readFile(file, "utf8"));
    },
    { timeout: 10_000, interval: 25 },
  );
  return pids as { pid: number; child: number };
}

/** Waits until neither process runs any more. */
async function expectStopped(pids: { pid: number; child: number }) {
  await vi.waitFor(
    () => {
      expect(isRunning(pids.pid)).toBe(false);
      expect(isRunning(pids.child)).toBe(false);
    },
    { timeout: 5_000, interval: 25 },
  );
}

describe("Running a Skill's scripts", { timeout: 30_000 }, () => {
  test("a run asks first, showing the Skill, the script and its arguments, and nothing runs until the User decides", async () => {
    const work = await createTempDataFolder();
    const log = join(work, "ran.log");
    const { model } = scriptModel("scripts/echo.js", [log, "two words", "--flag"]);
    const { core, skill, mind, client } = await setUp(model);

    const requested = nextEvent(core, "approval.requested");
    const answerId = await askNew(core, client, mind.id, "Run the echo script.");
    const request = await requested;

    expect(request).toEqual({
      requestId: expect.any(String),
      mindId: mind.id,
      answerId,
      toolCallId: expect.any(String),
      subject: { kind: "skill-script", skillId: skill.id },
      skill: { id: skill.id, name: "toolbox" },
      tool: "run_skill_script",
      script: "scripts/echo.js",
      args: [log, "two words", "--flag"],
      // What the run can do: run the Skill's code, unconfined (sandbox level "none").
      effects: [
        { action: "execute", scope: { kind: "skill", skillId: skill.id } },
        { action: "read", scope: { kind: "anywhere" } },
        { action: "write", scope: { kind: "anywhere" } },
        { action: "network", scope: { kind: "anywhere" } },
      ],
      // Nothing untrusted was read before it: there are no Documents to search.
      tainted: false,
    } satisfies SkillScriptApprovalRequest);
    expect(await core.listApprovalRequests()).toEqual([request]);
    // Paused: its card waits, and the script hasn't run.
    await vi.waitFor(() =>
      expect(toolCallsOf(client, answerId)).toEqual([
        {
          id: request.toolCallId,
          tool: "run_skill_script",
          source: "skill",
          input: {
            skill: "toolbox",
            script: "scripts/echo.js",
            args: [log, "two words", "--flag"],
          },
          status: "running",
          resultCount: null,
          approval: "waiting",
        },
      ]),
    );
    expect(answerIn(client, answerId).attrs.status).toBe("streaming");

    // The script appends to its log: what it wrote is below what was there when the User decided.
    await writeFile(log, "decided\n");
    const ended = answerEnded(core, answerId);
    await core.respondToApproval(request.requestId, "allow-once");
    expect((await ended).payload).toMatchObject({ status: "done" });
    expect(await readFile(log, "utf8")).toBe("decided\nran\n");
  });

  test("Allow once: it runs with its arguments in a new temporary folder, removed afterwards; the model and the card get the exit code and output; the next run asks again", async () => {
    const work = await createTempDataFolder();
    const log = join(work, "ran.log");
    const args = [log, "two words", "--flag", "ünïcode $HOME"];
    const { model, results } = scriptModel("scripts/echo.js", args);
    const { core, dataDir, tempDir, skill, mind, client } = await setUp(model);
    const { requested, resolved } = recordApprovals(core);

    const answerId = await askNew(core, client, mind.id, "Run the echo script.");
    const ended = answerEnded(core, answerId);
    await vi.waitFor(() => expect(requested).toHaveLength(1));
    await core.respondToApproval((requested[0] as ApprovalRequest).requestId, "allow-once");
    expect((await ended).payload).toMatchObject({ status: "done" });

    expect(answerText(client, answerId)).toBe("Done.");
    expect(resolved).toEqual([{ requestId: requested[0]?.requestId, decision: "allow-once" }]);
    const [result] = results;
    expect(result?.split("\n").slice(0, 2)).toEqual([
      "scripts/echo.js exited with code 0.",
      "<stdout>",
    ]);
    const report = JSON.parse(/<stdout>\n(.*)\n<\/stdout>/.exec(result ?? "")?.[1] ?? "{}");
    // The arguments as they were, with no shell in between; the Skill's folder in SKILL_DIR.
    expect(report.args).toEqual(["two words", "--flag", "ünïcode $HOME"]);
    expect(report.skillDir).toBe(await realpath(join(dataDir, "skills", skill.id)));
    // A new, empty folder of its own, gone once it ended.
    expect(report.cwd.startsWith(await realpath(tempDir))).toBe(true);
    expect(report.before).toEqual([]);
    expect(existsSync(report.cwd)).toBe(false);
    expect(await scriptsLeftIn(tempDir)).toEqual([]);

    const [call] = scriptCalls(client, answerId);
    expect(call).toMatchObject({
      status: "done",
      approval: "allowed",
      script: {
        exitCode: 0,
        timedOut: false,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        error: null,
      },
    });
    expect(JSON.parse(call?.script?.stdout ?? "{}")).toEqual(report);
    expect(await core.listApprovalPolicies()).toEqual([]);

    // Allowed once only: the next run asks again.
    const again = await askNew(core, client, mind.id, "Once more.");
    const endedAgain = answerEnded(core, again);
    await vi.waitFor(() => expect(requested).toHaveLength(2));
    await core.respondToApproval((requested[1] as ApprovalRequest).requestId, "allow-once");
    await endedAgain;
    expect(await readFile(log, "utf8")).toBe("ran\nran\n");
  });

  test("Deny: the script doesn't run, the model is told so, and the Answer carries on", async () => {
    const work = await createTempDataFolder();
    const log = join(work, "ran.log");
    const { model, results } = scriptModel("scripts/echo.js", [log]);
    const { core, mind, client } = await setUp(model);

    const asked = nextEvent(core, "approval.requested");
    const answerId = await askNew(core, client, mind.id, "Run the echo script.");
    const ended = answerEnded(core, answerId);
    await core.respondToApproval((await asked).requestId, "deny");

    expect((await ended).payload).toMatchObject({ status: "done" });
    expect(answerText(client, answerId)).toBe("Done.");
    expect(results).toEqual([
      "The User denied running scripts/echo.js of the Skill \"toolbox\", so it didn't run. Carry on without it, don't run it again, and say what wasn't done.",
    ]);
    expect(existsSync(log)).toBe(false);
    const [call] = scriptCalls(client, answerId);
    expect(call).toMatchObject({ status: "failed", approval: "denied" });
    expect(call).not.toHaveProperty("script");
  });

  test("Always run needs the risk warning confirmed; then the Skill's scripts run without asking, until the policy is revoked on the approvals page", async () => {
    const work = await createTempDataFolder();
    const log = join(work, "ran.log");
    const { model } = scriptModel("scripts/echo.js", [log]);
    const { core, skill, mind, client } = await setUp(model);
    const { requested } = recordApprovals(core);

    const answerId = await askNew(core, client, mind.id, "Run the echo script.");
    const ended = answerEnded(core, answerId);
    await vi.waitFor(() => expect(requested).toHaveLength(1));
    const request = requested[0] as ApprovalRequest;

    // Without the warning confirmed, "always run" is refused, and the run still waits.
    await expect(core.respondToApproval(request.requestId, "always-allow")).rejects.toThrow(
      /Confirm the risk warning/,
    );
    await expect(
      core.respondToApproval(request.requestId, "always-allow", { riskAccepted: false }),
    ).rejects.toThrow(/Confirm the risk warning/);
    expect(await core.listApprovalRequests()).toEqual([request]);
    expect(await core.listApprovalPolicies()).toEqual([]);
    expect(existsSync(log)).toBe(false);

    const changed = nextEvent(core, "approvals.changed");
    await core.respondToApproval(request.requestId, "always-allow", { riskAccepted: true });
    await ended;
    const policy = {
      id: expect.any(String),
      subject: { kind: "skill-script", skillId: skill.id },
      policy: "always",
      ownerName: "toolbox",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    };
    expect(await changed).toEqual([policy]);
    expect(await core.listApprovalPolicies()).toEqual([policy]);
    expect(scriptCalls(client, answerId)).toMatchObject([{ status: "done", approval: "allowed" }]);

    // Later runs don't ask; their cards have no approval to show.
    const { answerId: next } = await askAndEnd(core, client, mind.id, "Again.");
    expect(requested).toHaveLength(1);
    expect(await readFile(log, "utf8")).toBe("ran\nran\n");
    const [call] = scriptCalls(client, next);
    expect(call).toMatchObject({ status: "done", script: { exitCode: 0 } });
    expect(call).not.toHaveProperty("approval");

    // Revoked: it asks again.
    await core.revokeApprovalPolicy((await core.listApprovalPolicies())[0]?.id as string);
    expect(await core.listApprovalPolicies()).toEqual([]);
    const third = await askNew(core, client, mind.id, "And again.");
    const thirdEnded = answerEnded(core, third);
    await vi.waitFor(() => expect(requested).toHaveLength(2));
    await core.respondToApproval((requested[1] as ApprovalRequest).requestId, "deny");
    await thirdEnded;
    expect(await readFile(log, "utf8")).toBe("ran\nran\n");
  });

  test("the global switch: off, run_skill_script isn't offered and nothing about scripts is sent; a run waiting for approval is denied", async () => {
    const work = await createTempDataFolder();
    const log = join(work, "ran.log");
    const { model, calls } = scriptModel("scripts/echo.js", [log]);
    const { core, mind, client } = await setUp(model);

    // On (the default): offered, and the instructions say how to run scripts.
    const asked = nextEvent(core, "approval.requested");
    const first = await askNew(core, client, mind.id, "Run the echo script.");
    const firstEnded = answerEnded(core, first);
    const request = await asked;
    expect(calls[0]?.tools).toContain(SCRIPT_TOOL);
    expect(calls[0]?.system).toContain("run_skill_script");

    // Turned off while the run waits: it is denied, and the Answer carries on.
    const resolved = nextEvent(core, "approval.resolved");
    await core.updateSettings({ device: { skillScriptsEnabled: false } });
    expect(await resolved).toEqual({ requestId: request.requestId, decision: "deny" });
    expect((await firstEnded).payload).toMatchObject({ status: "done" });
    expect(scriptCalls(client, first)).toMatchObject([{ status: "failed", approval: "denied" }]);

    // Off: not offered at all.
    const before = calls.length;
    const { answerId } = await askAndEnd(core, client, mind.id, "Run the echo script.");
    const offered = calls.slice(before);
    expect(offered).toHaveLength(1);
    expect(offered[0]?.tools).not.toContain(SCRIPT_TOOL);
    expect(offered[0]?.tools.sort()).toEqual(["read_skill_file", "use_skill"]);
    expect(offered[0]?.system).not.toContain("run_skill_script");
    expect(answerText(client, answerId)).toBe("No scripts.");
    expect(existsSync(log)).toBe(false);

    // On again: offered again.
    await core.updateSettings({ device: { skillScriptsEnabled: true } });
    const again = nextEvent(core, "approval.requested");
    const third = await askNew(core, client, mind.id, "Run the echo script.");
    const thirdEnded = answerEnded(core, third);
    await core.respondToApproval((await again).requestId, "allow-once");
    await thirdEnded;
    expect(await readFile(log, "utf8")).toBe("ran\n");
  });

  test("a script that runs past the timeout is stopped with every process it started; what it wrote is kept", async () => {
    const work = await createTempDataFolder();
    const pidFile = join(work, "pids.json");
    const { model, results } = scriptModel("scripts/sleep.js", [pidFile]);
    const { core, tempDir, skill, mind, client } = await setUp(model);
    await alwaysRun(core, skill.id);
    await core.updateSettings({ device: { skillScriptTimeoutSeconds: 1 } });

    // The script never ends on its own, so the Answer ends only because the timeout stopped it.
    const { answerId, ended } = await askAndEnd(core, client, mind.id, "Sleep.");

    expect(ended.payload).toMatchObject({ status: "done" });
    await expectStopped(await pidsIn(pidFile));
    expect(results[0]).toBe(
      [
        "scripts/sleep.js ran longer than 1 second, so it was stopped, with every process it started. What it wrote until then:",
        "<stdout>",
        "started",
        "</stdout>",
        "<stderr>",
        "</stderr>",
      ].join("\n"),
    );
    expect(scriptCalls(client, answerId)).toMatchObject([
      { status: "failed", script: { exitCode: null, timedOut: true, stdout: "started\n" } },
    ]);
    await vi.waitFor(async () => expect(await scriptsLeftIn(tempDir)).toEqual([]));
  });

  test("Stop stops a running script at once, with every process it started", async () => {
    const work = await createTempDataFolder();
    const pidFile = join(work, "pids.json");
    const { model } = scriptModel("scripts/sleep.js", [pidFile]);
    const { core, tempDir, skill, mind, client } = await setUp(model);
    await alwaysRun(core, skill.id);

    const answerId = await askNew(core, client, mind.id, "Sleep.");
    const pids = await pidsIn(pidFile);
    expect(isRunning(pids.pid)).toBe(true);
    const ended = answerEnded(core, answerId);
    await core.stopAnswer({ mindId: mind.id, answerId });

    expect((await ended).payload).toMatchObject({ status: "stopped" });
    await expectStopped(pids);
    expect(scriptCalls(client, answerId)).toMatchObject([{ status: "failed" }]);
    await vi.waitFor(async () => expect(await scriptsLeftIn(tempDir)).toEqual([]));
  });

  test.skipIf(process.platform === "win32")(
    "a process that escapes the stop (a session of its own) doesn't keep the Answer waiting",
    async () => {
      const work = await createTempDataFolder();
      const pidFile = join(work, "pids.json");
      const { model, results } = scriptModel("scripts/escape.js", [pidFile]);
      const { core, skill, mind, client } = await setUp(model);
      await alwaysRun(core, skill.id);
      await core.updateSettings({ device: { skillScriptTimeoutSeconds: 1 } });

      // What escaped holds the output open for good, so the Answer ends only if it stopped waiting.
      const { answerId } = await askAndEnd(core, client, mind.id, "Escape.");
      const pids = await pidsIn(pidFile);
      // The test's own clean-up: what escaped is beyond the app.
      onTestFinished(() => {
        try {
          process.kill(pids.child, "SIGKILL");
        } catch {
          // Gone already.
        }
      });

      expect(results[0]).toMatch(/^scripts\/escape\.js ran longer than 1 second/);
      expect(scriptCalls(client, answerId)).toMatchObject([
        { status: "failed", script: { timedOut: true } },
      ]);
      await vi.waitFor(() => expect(isRunning(pids.pid)).toBe(false));
    },
  );

  test("closing IncarnaMind stops a running script, with every process it started", async () => {
    const work = await createTempDataFolder();
    const pidFile = join(work, "pids.json");
    const { model } = scriptModel("scripts/sleep.js", [pidFile]);
    const { core, skill, mind, client } = await setUp(model);
    await alwaysRun(core, skill.id);

    await askNew(core, client, mind.id, "Sleep.");
    const pids = await pidsIn(pidFile);
    core.close();

    await expectStopped(pids);
  });

  test("output is cut to 20 KB per stream, with a note: the start of stdout, the end of stderr", async () => {
    const { model, results } = scriptModel("scripts/flood.js");
    const { core, skill, mind, client } = await setUp(model);
    await alwaysRun(core, skill.id);

    const { answerId } = await askAndEnd(core, client, mind.id, "Flood.");

    const [call] = scriptCalls(client, answerId);
    const run = call?.script;
    expect(run).toMatchObject({ exitCode: 0, stdoutTruncated: true, stderrTruncated: true });
    expect(run?.stdout).toBe("S".repeat(20_000));
    expect(run?.stderr).toBe("E".repeat(20_000));
    const result = results[0] ?? "";
    expect(result).toContain("[… truncated: only the first 20000 bytes of stdout are kept.]");
    expect(result).toContain("[… truncated: only the last 20000 bytes of stderr are kept.]");
    expect(result).not.toContain("TAIL-OUT");
    expect(result).not.toContain("HEAD-ERR");
  });

  test("a script that fails: the model gets its exit code and error output, and its card says it failed", async () => {
    const { model, results } = scriptModel("scripts/fail.js");
    const { core, skill, mind, client } = await setUp(model);
    await alwaysRun(core, skill.id);

    const { answerId } = await askAndEnd(core, client, mind.id, "Fail.");

    expect(results[0]).toBe(
      [
        "scripts/fail.js exited with code 3.",
        "<stdout>",
        "</stdout>",
        "<stderr>",
        "boom",
        "</stderr>",
      ].join("\n"),
    );
    expect(scriptCalls(client, answerId)).toMatchObject([
      { status: "failed", script: { exitCode: 3, stderr: "boom\n", error: null } },
    ]);
  });

  test("a missing interpreter gives a plain error naming what to install", async () => {
    const emptyPath = await createTempDataFolder();
    const { model, results } = scriptModel("scripts/hello.py", ["tides"]);
    const { core, tempDir, skill, mind, client } = await setUp(model, {
      processes: scriptProcesses(onlyOnPath(emptyPath)),
    });
    await alwaysRun(core, skill.id);

    const { answerId, ended } = await askAndEnd(core, client, mind.id, "Say hello.");

    expect(ended.payload).toMatchObject({ status: "done" });
    const python = process.platform === "win32" ? "python" : "python3";
    const message = `${python} not found: install Python 3 to run scripts/hello.py.`;
    expect(results[0]).toContain(message);
    expect(scriptCalls(client, answerId)).toMatchObject([
      { status: "failed", script: { exitCode: null, error: message } },
    ]);
    expect(await scriptsLeftIn(tempDir)).toEqual([]);
  });

  test("a shell script on Windows, or a TypeScript one, gives a clear error without asking", async () => {
    const model = scriptedModel((call) => {
      if (call.results.length > 0)
        return { text: call.results.map((each) => each.text).join("\n") };
      return {
        calls: [
          { tool: SCRIPT_TOOL, input: { skill: "toolbox", script: "scripts/hello.sh" } },
          { tool: SCRIPT_TOOL, input: { skill: "toolbox", script: "scripts/convert.ts" } },
        ],
      };
    });
    const { core, mind, client } = await setUp(model, { scriptRuntimes: { platform: "win32" } });
    const { requested } = recordApprovals(core);

    const { answerId } = await askAndEnd(core, client, mind.id, "Run them.");

    expect(requested).toEqual([]);
    const text = answerText(client, answerId);
    expect(text).toContain(
      "scripts/hello.sh is a shell script, and shell scripts can't run on Windows.",
    );
    expect(text).toContain(
      "scripts/convert.ts is a TypeScript script, which IncarnaMind can't run yet.",
    );
    expect(scriptCalls(client, answerId)).toMatchObject([
      { status: "failed", script: { error: expect.stringMatching(/can't run on Windows/) } },
      { status: "failed", script: { error: expect.stringMatching(/TypeScript/) } },
    ]);
  });

  test("only a script file of a Skill the Answer may use can run: anything else is refused without asking", async () => {
    const inputs = [
      { skill: "toolbox", script: "../../incarnamind.db" },
      { skill: "toolbox", script: "SKILL.md" },
      { skill: "toolbox", script: "scripts/missing.js" },
      { skill: "nonexistent", script: "scripts/echo.js" },
      { skill: "toolbox", script: "scripts/echo.js", args: "not a list" },
    ];
    const model = scriptedModel((call) => {
      if (call.results.length > 0) {
        return { text: call.results.map((each) => `[${each.text}]`).join("\n\n") };
      }
      return { calls: inputs.map((input) => ({ tool: SCRIPT_TOOL, input })) };
    });
    const { core, mind, client } = await setUp(model);
    const { requested } = recordApprovals(core);

    const { answerId } = await askAndEnd(core, client, mind.id, "Run them.");

    expect(requested).toEqual([]);
    const results = answerText(client, answerId).split("\n\n");
    expect(results[0]).toMatch(/Give the path of a script inside the Skill "toolbox"/);
    expect(results[1]).toMatch(/has no script SKILL\.md/);
    expect(results[2]).toMatch(/has no script scripts\/missing\.js/);
    expect(results[3]).toMatch(/There is no Skill named "nonexistent"/);
    // Arguments that don't match the Tool's schema are refused before the call (#63).
    expect(results[4]).toMatch(/args must be array/);
    expect(scriptCalls(client, answerId).map((call) => call.status)).toEqual([
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
  });
});

describe("Scripts in other languages", { timeout: 30_000 }, () => {
  test.skipIf(!PYTHON)(
    "a .py script runs through Python (skipped when Python 3 isn't installed)",
    async () => {
      const { model, results } = scriptModel("scripts/hello.py", ["tides"]);
      const { core, skill, mind, client } = await setUp(model);
      await alwaysRun(core, skill.id);

      const { answerId } = await askAndEnd(core, client, mind.id, "Say hello.");

      expect(results[0]).toContain("<stdout>\nhello from python tides\n</stdout>");
      expect(scriptCalls(client, answerId)).toMatchObject([
        { status: "done", script: { exitCode: 0 } },
      ]);
    },
  );

  test.skipIf(!BASH)(
    "a .sh script runs through bash (skipped on Windows, or without bash)",
    async () => {
      const { model, results } = scriptModel("scripts/hello.sh", ["tides"]);
      const { core, skill, mind, client } = await setUp(model);
      await alwaysRun(core, skill.id);

      const { answerId } = await askAndEnd(core, client, mind.id, "Say hello.");

      expect(results[0]).toContain("<stdout>\nhello from bash tides\n</stdout>");
      expect(scriptCalls(client, answerId)).toMatchObject([
        { status: "done", script: { exitCode: 0 } },
      ]);
    },
  );
});

describe("The chat flow with Skill scripts", { timeout: 30_000 }, () => {
  test("with a cloud chat model, a Skill whose scripts can run makes chat ask again, for Tool results; turned off, it doesn't", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createTempDataFolder();
    const core = startCore(dataDir, {
      createChatModel: scriptedModels(scriptedModel(() => ({ text: "OK" }))).createChatModel,
      processes: scriptProcesses(),
    });
    // Choosing the provider allows the chat flow as it was: without Tool results.
    await core.saveChatProvider({ kind: "openai", apiKey: "sk-test", modelId: "gpt-5.4-mini" });
    expect(await core.getChatReadiness()).toMatchObject({ consent: "accepted" });
    const sends = async () =>
      (await core.listDataFlows()).find((status) => status.flow.id === "chat")?.flow.sends;

    const readiness = nextEvent(core, "chatReadiness.changed");
    const skill = await importSkill(core, await writeFolder(sources, "toolbox", TOOLBOX));

    expect(await readiness).toMatchObject({ ready: true, consent: "needed" });
    expect(await sends()).toEqual([...CHAT_FLOW_SENDS, "tool-results"]);
    // Scripts turned off: chat sends only what the User accepted, and asks nothing.
    await core.updateSettings({ device: { skillScriptsEnabled: false } });
    expect(await sends()).toEqual([...CHAT_FLOW_SENDS]);
    expect(await core.getChatReadiness()).toMatchObject({ consent: "accepted" });
    await core.updateSettings({ device: { skillScriptsEnabled: true } });
    expect(await sends()).toEqual([...CHAT_FLOW_SENDS, "tool-results"]);
    // So does the Skill with scripts turned off.
    await core.setSkillEnabled(skill.id, false);
    expect(await sends()).toEqual([...CHAT_FLOW_SENDS]);
    await core.setSkillEnabled(skill.id, true);

    // The next request asks for the new kind only, and goes once it is accepted.
    const again = nextEvent(core, "consent.requested");
    const prepared = core.prepareChatModel();
    const request = await again;
    expect(request.flow.sends).toEqual([...CHAT_FLOW_SENDS, "tool-results"]);
    expect(request.newKinds).toEqual(["tool-results"]);
    await core.respondToConsent(request.requestId, true);
    await prepared;
    expect(await core.getChatReadiness()).toMatchObject({ consent: "accepted" });
  });

  test("a Skill without scripts doesn't count", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createTempDataFolder();
    const core = startCore(dataDir, { processes: scriptProcesses() });
    await importSkill(
      core,
      await writeFolder(sources, "plain", { "SKILL.md": simpleSkillMd("plain", "No scripts.") }),
    );

    const chat = (await core.listRegisteredDataFlows()).find((flow) => flow.id === "chat");
    expect(chat?.sends).toEqual([...CHAT_FLOW_SENDS]);
  });
});
