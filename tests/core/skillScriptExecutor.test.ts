/**
 * Skill scripts go through the Executor (#61): the script runner chooses the
 * interpreter, checks the arguments and writes the result text, and asks the
 * Executor to run it with what it may touch. A fake Executor records each
 * request: the Skill's folder and the working folder to read, the working
 * folder to write, and no network.
 */
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  type ExecRequest,
  type ExecResult,
  type Executor,
  type SandboxLevel,
  SKILL_SCRIPT_LIMITS,
} from "../../src/core";
import { WORKING_FOLDER } from "../../src/core/execution";
import { createScriptRunner, type ScriptToRun } from "../../src/core/skills/scripts";
import { answerEnded, askNew } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { answerIn } from "../helpers/minds";
import { scriptedModel, scriptedModels } from "../helpers/models";
import { importSkill, simpleSkillMd, writeFolder } from "../helpers/skills";

const RAN: ExecResult = {
  exitCode: 0,
  timedOut: false,
  stdout: "faked\n",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};

/**
 * An Executor at `level` that runs nothing: it records each request and
 * resolves with what `respond` gives (`RAN` by default; a promise that may
 * wait for the request's signal).
 */
function fakeExecutor(
  level: SandboxLevel = "none",
  respond: (request: ExecRequest) => Promise<ExecResult> = async () => RAN,
) {
  const requests: ExecRequest[] = [];
  const executor: Executor = {
    level,
    run: async (request) => {
      requests.push(request);
      return respond(request);
    },
  };
  return { executor, requests };
}

const SKILL_DIR = "/data/skills/toolbox-id";

/** IncarnaMind's own Python, where a download leaves it in the data folder. */
const OWN = {
  command: "/data/runtimes/python-0123456789abcdef/files/python/bin/python3",
  prefix: "/data/runtimes/python-0123456789abcdef/files/python",
};

/** IncarnaMind's own Python started again with nothing to run, to see whether it starts. */
const startCheck = (request: ExecRequest) => request.args.includes("-c");

/** A run of the toolbox's echo script, with what the case changes. */
const toRun = (overrides: Partial<ScriptToRun>): ScriptToRun => ({
  skillDir: SKILL_DIR,
  script: "scripts/echo.js",
  args: [],
  timeoutMs: 5_000,
  signal: new AbortController().signal,
  language: "en",
  ...overrides,
});

describe("The script runner asks the Executor", () => {
  test("for the interpreter, the script and its arguments, with SKILL_DIR, its timeout and output caps, and what it may touch", async () => {
    // An Executor may say more than a run's card keeps: the card stores only its own fields.
    const { executor, requests } = fakeExecutor("none", async () => ({ ...RAN, pid: 4242 }));
    const scripts = createScriptRunner({
      executor,
      runtimes: { node: { command: "/app/node", env: { ELECTRON_RUN_AS_NODE: "1" } } },
    });
    const signal = new AbortController().signal;

    const run = await scripts.run(
      toRun({ args: ["two words", "--flag"], timeoutMs: 7_000, signal }),
    );

    expect(run).toStrictEqual({ ...RAN, error: null });
    expect(requests).toEqual([
      {
        command: "/app/node",
        args: [join(SKILL_DIR, "scripts", "echo.js"), "two words", "--flag"],
        env: { ELECTRON_RUN_AS_NODE: "1", SKILL_DIR },
        allow: { read: [SKILL_DIR, WORKING_FOLDER], write: [WORKING_FOLDER], network: "none" },
        timeoutMs: 7_000,
        maxOutputBytes: SKILL_SCRIPT_LIMITS.maxOutputBytes,
        signal: expect.any(AbortSignal),
      },
    ]);
    // No working folder of its own: the Executor makes a new one.
    expect(requests[0]).not.toHaveProperty("cwd");
  });

  test("each kind of script with its interpreter, and the same allow sets", async () => {
    const { executor, requests } = fakeExecutor();
    const scripts = createScriptRunner({ executor, runtimes: { platform: "linux" } });

    await scripts.run(toRun({ script: "scripts/hello.py" }));
    await scripts.run(toRun({ script: "scripts/hello.sh" }));

    expect(requests.map(({ command, env }) => ({ command, env }))).toEqual([
      {
        command: "python3",
        env: {
          PYTHONDONTWRITEBYTECODE: "1",
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
          SKILL_DIR,
        },
      },
      { command: "bash", env: { SKILL_DIR } },
    ]);
    for (const request of requests) {
      expect(request.allow).toEqual({
        read: [SKILL_DIR, WORKING_FOLDER],
        write: [WORKING_FOLDER],
        network: "none",
      });
    }
  });

  test("a script that can't run here isn't sent to the Executor", async () => {
    const { executor, requests } = fakeExecutor();
    const scripts = createScriptRunner({ executor, runtimes: { platform: "win32" } });

    await expect(scripts.run(toRun({ script: "scripts/hello.sh" }))).rejects.toThrow(
      "scripts/hello.sh is a shell script, and shell scripts can't run on Windows.",
    );
    await expect(scripts.run(toRun({ script: "scripts/convert.ts" }))).rejects.toThrow(
      /TypeScript/,
    );
    expect(requests).toEqual([]);
  });

  test("a command the Executor can't find becomes a plain error naming what to install", async () => {
    const { executor } = fakeExecutor("none", async () => {
      throw Object.assign(new Error("spawn python3 ENOENT"), { code: "ENOENT" });
    });
    const scripts = createScriptRunner({ executor, runtimes: { platform: "darwin" } });

    await expect(scripts.run(toRun({ script: "scripts/hello.py" }))).rejects.toThrow(
      "python3 not found: install Python 3 to run scripts/hello.py.",
    );
  });

  test("stopping every script, or closing, stops what the Executor runs; closed, nothing more is sent", async () => {
    const { executor, requests } = fakeExecutor(
      "none",
      (request) =>
        new Promise((resolve) =>
          request.signal.addEventListener("abort", () => resolve({ ...RAN, exitCode: null }), {
            once: true,
          }),
        ),
    );
    const scripts = createScriptRunner({ executor });

    const first = scripts.run(toRun({}));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    scripts.stopAll();
    expect(await first).toMatchObject({ exitCode: null });

    const second = scripts.run(toRun({}));
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    scripts.close();
    expect(await second).toMatchObject({ exitCode: null });

    await expect(scripts.run(toRun({}))).rejects.toThrow(
      "IncarnaMind is closing, so the script didn't run.",
    );
    expect(requests).toHaveLength(2);
  });

  test("a Stop of the Answer reaches the Executor", async () => {
    const { executor, requests } = fakeExecutor(
      "none",
      (request) =>
        new Promise((resolve) =>
          request.signal.addEventListener("abort", () => resolve({ ...RAN, exitCode: null }), {
            once: true,
          }),
        ),
    );
    const scripts = createScriptRunner({ executor });
    const answer = new AbortController();

    const running = scripts.run(toRun({ signal: answer.signal }));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.signal.aborted).toBe(false);
    answer.abort();

    expect(await running).toMatchObject({ exitCode: null });
    expect(requests[0]?.signal.aborted).toBe(true);
  });

  test("a Python script runs on IncarnaMind's own Python once it is here, reading its folder too; asked at each run", async () => {
    let here: typeof OWN | null = null;
    const { executor, requests } = fakeExecutor("os");
    const scripts = createScriptRunner({
      executor,
      runtimes: { platform: "darwin" },
      python: () => here,
    });

    await scripts.run(toRun({ script: "scripts/hello.py", args: ["tides"] }));
    here = OWN;
    await scripts.run(toRun({ script: "scripts/hello.py", args: ["tides"] }));
    await scripts.run(toRun({ script: "scripts/hello.sh" }));

    const script = join(SKILL_DIR, "scripts", "hello.py");
    expect(
      requests.map(({ command, args, allow, environment }) => ({
        command,
        args,
        allow,
        environment,
      })),
    ).toEqual([
      {
        command: "python3",
        args: [script, "tides"],
        allow: { read: [SKILL_DIR, WORKING_FOLDER], write: [WORKING_FOLDER], network: "none" },
      },
      {
        command: OWN.command,
        args: ["-E", "-s", "-B", "-X", "utf8", script, "tides"],
        environment: "own-python",
        allow: {
          read: [SKILL_DIR, WORKING_FOLDER, OWN.prefix],
          write: [WORKING_FOLDER],
          network: "none",
        },
      },
      {
        command: "bash",
        args: [join(SKILL_DIR, "scripts", "hello.sh")],
        allow: { read: [SKILL_DIR, WORKING_FOLDER], write: [WORKING_FOLDER], network: "none" },
      },
    ]);
    // What the approval card says a run reads is the Skill's, whichever Python runs it.
    expect(scripts.access(SKILL_DIR).read).toEqual([SKILL_DIR, WORKING_FOLDER]);
  });

  test("on Windows a Python script runs on python, with IncarnaMind's own Python given or not", async () => {
    const { executor, requests } = fakeExecutor("os");
    const scripts = createScriptRunner({
      executor,
      runtimes: { platform: "win32" },
      python: () => ({ command: "C:\\data\\python\\python.exe", prefix: "C:\\data\\python" }),
    });

    await scripts.run(toRun({ script: "scripts/hello.py" }));

    expect(requests.map(({ command, args, allow }) => ({ command, args, allow }))).toEqual([
      {
        command: "python",
        args: [join(SKILL_DIR, "scripts", "hello.py")],
        allow: { read: [SKILL_DIR, WORKING_FOLDER], write: [WORKING_FOLDER], network: "none" },
      },
    ]);
  });

  describe("IncarnaMind's own Python that can't start", () => {
    const FATAL = {
      ...RAN,
      exitCode: 1,
      stdout: "",
      stderr: [
        "Fatal Python error: init_fs_encoding: failed to get the Python codec of the filesystem encoding",
        "Python runtime state: core initialized",
        "ModuleNotFoundError: No module named 'encodings'",
        "",
      ].join("\n"),
    };
    const FAILED = { ...RAN, exitCode: 1, stdout: "", stderr: "ValueError: no rows\n" };
    const ownRunner = (respond: (request: ExecRequest) => Promise<ExecResult>) => {
      const { executor, requests } = fakeExecutor("os", respond);
      const scripts = createScriptRunner({
        executor,
        runtimes: { platform: "linux" },
        python: () => OWN,
      });
      return { scripts, requests };
    };

    test("is a plain Problem naming IncarnaMind's side, and nothing runs on python3 instead", async () => {
      const { scripts, requests } = ownRunner(async () => FATAL);

      await expect(scripts.run(toRun({ script: "scripts/hello.py" }))).rejects.toThrow(
        "IncarnaMind's own Python couldn't start on this computer, so scripts/hello.py didn't run: Fatal Python error: init_fs_encoding: failed to get the Python codec of the filesystem encoding",
      );
      expect(requests.map(({ command, args }) => ({ command, args }))).toEqual([
        {
          command: OWN.command,
          args: ["-E", "-s", "-B", "-X", "utf8", join(SKILL_DIR, "scripts", "hello.py")],
        },
        { command: OWN.command, args: ["-E", "-s", "-B", "-X", "utf8", "-c", ""] },
      ]);
      // The check runs as the script did: in the same sandbox, reading the same folders.
      expect(requests[1]?.allow).toEqual(requests[0]?.allow);
      expect(requests[1]?.env).toEqual(requests[0]?.env);
    });

    test("that says nothing is that Problem with how it ended", async () => {
      const silent = ownRunner(async () => ({ ...RAN, exitCode: 2, stdout: "" }));
      await expect(silent.scripts.run(toRun({ script: "scripts/hello.py" }))).rejects.toThrow(
        "IncarnaMind's own Python couldn't start on this computer, so scripts/hello.py didn't run: it exited with code 2.",
      );

      const hung = ownRunner(async (request) =>
        startCheck(request)
          ? { ...RAN, exitCode: null, timedOut: true, stdout: "" }
          : { ...RAN, exitCode: null, stdout: "" },
      );
      await expect(hung.scripts.run(toRun({ script: "scripts/hello.py" }))).rejects.toThrow(
        "IncarnaMind's own Python couldn't start on this computer, so scripts/hello.py didn't run: it didn't start within 30 seconds.",
      );
      expect(hung.requests.find(startCheck)?.timeoutMs).toBe(30_000);
    });

    test("whose program is gone is that Problem too, not a Python 3 to install", async () => {
      const { scripts } = ownRunner(async () => {
        throw Object.assign(new Error("python3 not found"), { code: "ENOENT" });
      });

      await expect(scripts.run(toRun({ script: "scripts/hello.py" }))).rejects.toThrow(
        "IncarnaMind's own Python couldn't start on this computer, so scripts/hello.py didn't run: its program can't be found.",
      );
    });

    test("is told apart from a script that failed on its own, which comes back as it ran", async () => {
      const { scripts, requests } = ownRunner(async (request) =>
        startCheck(request) ? RAN : FAILED,
      );

      expect(await scripts.run(toRun({ script: "scripts/hello.py" }))).toStrictEqual({
        ...FAILED,
        error: null,
      });
      expect(requests.filter(startCheck)).toHaveLength(1);
    });

    test("isn't checked for after a run that ended well, ran out of time or was stopped, or on python3; a stop while checking leaves the run as it ran", async () => {
      const ended = ownRunner(async () => RAN);
      await ended.scripts.run(toRun({ script: "scripts/hello.py" }));
      expect(ended.requests).toHaveLength(1);

      const timedOut = ownRunner(async (request) =>
        startCheck(request) ? FATAL : { ...RAN, exitCode: null, timedOut: true },
      );
      expect(await timedOut.scripts.run(toRun({ script: "scripts/hello.py" }))).toMatchObject({
        timedOut: true,
        error: null,
      });
      expect(timedOut.requests).toHaveLength(1);

      const answer = new AbortController();
      const stopped = ownRunner(async (request) => {
        if (startCheck(request)) return FATAL;
        answer.abort();
        return { ...RAN, exitCode: null };
      });
      expect(
        await stopped.scripts.run(toRun({ script: "scripts/hello.py", signal: answer.signal })),
      ).toMatchObject({ exitCode: null, error: null });
      expect(stopped.requests).toHaveLength(1);

      const later = new AbortController();
      const stoppedWhileChecking = ownRunner(async (request) => {
        if (!startCheck(request)) return FAILED;
        later.abort();
        return { ...RAN, exitCode: null };
      });
      expect(
        await stoppedWhileChecking.scripts.run(
          toRun({ script: "scripts/hello.py", signal: later.signal }),
        ),
      ).toStrictEqual({ ...FAILED, error: null });

      const { executor, requests } = fakeExecutor("os", async () => FATAL);
      const onPath = createScriptRunner({ executor, runtimes: { platform: "linux" } });
      expect(await onPath.run(toRun({ script: "scripts/hello.py" }))).toMatchObject({
        exitCode: 1,
        error: null,
      });
      expect(requests).toHaveLength(1);
    });
  });

  describe("A package IncarnaMind's own Python doesn't include", () => {
    const failedOn = (last: string, exitCode = 1): ExecResult => ({
      ...RAN,
      exitCode,
      stdout: "Read 12 rows.\n",
      stderr: [
        "Traceback (most recent call last):",
        '  File "/data/skills/toolbox-id/scripts/hello.py", line 2, in <module>',
        "    import zorblax_quant.models",
        last,
        "",
      ].join("\n"),
    });
    const MISSING = "ModuleNotFoundError: No module named 'zorblax_quant'";
    const asksForModule = (request: ExecRequest) =>
      request.args.some((arg) => arg.includes("find_spec"));
    /** A runtime that starts, and has the module a script asks it about only when `included`. */
    const onOwn = (result: ExecResult, { included = false } = {}) => {
      const { executor, requests } = fakeExecutor("os", async (request) =>
        asksForModule(request)
          ? { ...RAN, exitCode: included ? 0 : 3, stdout: "" }
          : startCheck(request)
            ? RAN
            : result,
      );
      const scripts = createScriptRunner({
        executor,
        runtimes: { platform: "linux" },
        python: () => OWN,
      });
      return Object.assign(scripts, { requests });
    };
    const ran = async (
      result: ExecResult,
      scripts: Pick<ReturnType<typeof createScriptRunner>, "run"> = onOwn(result),
    ) =>
      expect(await scripts.run(toRun({ script: "scripts/hello.py" }))).toStrictEqual({
        ...result,
        error: null,
      });
    const problem = (name: string) =>
      `This Skill needs the Python package “${name}”, which isn’t included in IncarnaMind.`;

    test("is a plain Problem naming the package, in the interface's language, once the runtime says it has no such module, with nothing the script wrote", async () => {
      const scripts = onOwn(failedOn(MISSING));

      await expect(scripts.run(toRun({ script: "scripts/hello.py" }))).rejects.toMatchObject({
        message: problem("zorblax_quant"),
      });
      await expect(
        scripts.run(toRun({ script: "scripts/hello.py", language: "zh-CN" })),
      ).rejects.toMatchObject({
        message: "这个技能需要 Python 包“zorblax_quant”，IncarnaMind 未包含这个包。",
      });
      // Asked in the same sandbox as the script, from its own empty working folder.
      const [script, , asked] = scripts.requests;
      expect(asked?.args).toEqual([
        "-E",
        "-s",
        "-B",
        "-X",
        "utf8",
        "-c",
        expect.stringContaining("importlib.util.find_spec(sys.argv[1])"),
        "zorblax_quant",
      ]);
      expect(asked).not.toHaveProperty("cwd");
      expect(asked?.allow).toEqual(script?.allow);
      expect(asked?.env).toEqual(script?.env);
      expect(asked?.environment).toBe("own-python");

      await expect(
        onOwn(failedOn("ImportError: No module named zorblax")).run(
          toRun({ script: "scripts/hello.py" }),
        ),
      ).rejects.toMatchObject({ message: problem("zorblax") });
      const longest = "z".repeat(64);
      await expect(
        onOwn(failedOn(`ModuleNotFoundError: No module named '${longest}'`)).run(
          toRun({ script: "scripts/hello.py" }),
        ),
      ).rejects.toMatchObject({ message: problem(longest) });
    });

    test("a module the runtime has comes back as it ran: a dotted name, or a line the script wrote itself", async () => {
      for (const name of ["numpy.zorblax", "sklearn.externals.joblib", "zorblax_quant.models"]) {
        await ran(failedOn(`ModuleNotFoundError: No module named '${name}'`));
      }
      const wroteItself = failedOn("ModuleNotFoundError: No module named 'pandas'");
      await ran(wroteItself, onOwn(wroteItself, { included: true }));
    });

    test("a script that caught it and ended well or with another code, one that failed otherwise, and one on python3 come back as they ran", async () => {
      await ran(failedOn(MISSING, 0));
      await ran({ ...failedOn(MISSING, 3), stdout: "result: 42\n" });
      await ran(
        failedOn(
          "ValueError: ModuleNotFoundError: No module named 'zorblax_quant' was in the input",
        ),
      );
      const onPath = failedOn(MISSING);
      const { executor } = fakeExecutor("os", async () => onPath);
      await ran(onPath, createScriptRunner({ executor, runtimes: { platform: "linux" } }));
    });

    test("only the whole last line of its error output counts", async () => {
      const result = failedOn("ValueError: no rows");
      await ran({
        ...result,
        stderr: [MISSING, "", "During handling of the above exception:", "", result.stderr].join(
          "\n",
        ),
      });
      for (const line of [
        "RuntimeError: ModuleNotFoundError: No module named 'zorblax'",
        "ModuleNotFoundError: No module named 'zorblax' and more",
        "RuntimeError: ImportError: No module named zorblax",
        "ImportError: No module named zorblax and more",
      ]) {
        await ran(failedOn(line));
      }
    });

    test("a name that isn't a plain module name comes back as it ran", async () => {
      for (const name of [
        "z".repeat(65),
        "zorb-lax",
        "../../etc/passwd",
        "zorblax quant",
        "zörblax",
        "",
      ]) {
        await ran(failedOn(`ModuleNotFoundError: No module named '${name}'`));
      }
    });

    test("a Stop while the runtime is checked leaves the run as it ran", async () => {
      for (const during of [startCheck, asksForModule]) {
        const answer = new AbortController();
        const result = failedOn(MISSING);
        const { executor } = fakeExecutor("os", async (request) => {
          // As an Executor does: a request stopped already runs nothing.
          request.signal.throwIfAborted();
          if (!startCheck(request)) return result;
          if (!during(request)) return RAN;
          answer.abort();
          return { ...RAN, exitCode: null };
        });
        const scripts = createScriptRunner({
          executor,
          runtimes: { platform: "linux" },
          python: () => OWN,
        });
        expect(
          await scripts.run(toRun({ script: "scripts/hello.py", signal: answer.signal })),
        ).toStrictEqual({ ...result, error: null });
      }
    });
  });

  test("run_skill_script's declared access comes from the Executor's level", () => {
    const unconfined = createScriptRunner({ executor: fakeExecutor("none").executor });
    expect(unconfined.access(SKILL_DIR)).toEqual({
      confined: false,
      read: "anywhere",
      write: "anywhere",
      network: "any",
    });

    const sandboxed = createScriptRunner({ executor: fakeExecutor("os").executor });
    expect(sandboxed.access(SKILL_DIR)).toEqual({
      confined: true,
      read: [SKILL_DIR, WORKING_FOLDER],
      write: [WORKING_FOLDER],
      network: "none",
    });
  });
});

describe("The core runs Skill scripts through its Executor", { timeout: 30_000 }, () => {
  test("an Executor in the core's adapters runs the scripts Answers run, and the model reads what it returns", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createTempDataFolder();
    const { executor, requests } = fakeExecutor();
    const results: string[] = [];
    const model = scriptedModel((call) => {
      const result = call.results.find((each) => each.tool === "run_skill_script");
      if (result) {
        results.push(result.text);
        return { text: "Done." };
      }
      return {
        calls: [
          {
            tool: "run_skill_script",
            input: { skill: "toolbox", script: "scripts/echo.js", args: ["one"] },
          },
        ],
      };
    });
    const core = startCore(dataDir, {
      createChatModel: scriptedModels(model).createChatModel,
      executor,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const skill = await importSkill(
      core,
      await writeFolder(sources, "toolbox", {
        "SKILL.md": simpleSkillMd("toolbox", "Small scripts for tests. Use for running scripts."),
        "scripts/echo.js": 'console.log("real");\n',
      }),
    );
    await core.setApprovalPolicy({
      subject: { kind: "skill-script", skillId: skill.id },
      policy: "always",
      riskAccepted: true,
    });
    const mind = await core.createMind({ title: "Scripts" });
    const client = await connectToMind(core, mind.id);

    const answerId = await askNew(core, client, mind.id, "Run the echo script.");
    expect((await answerEnded(core, answerId)).payload).toMatchObject({ status: "done" });

    const skillDir = await realpath(join(dataDir, "skills", skill.id));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      args: [join(skillDir, "scripts", "echo.js"), "one"],
      env: { SKILL_DIR: skillDir },
      allow: { read: [skillDir, WORKING_FOLDER], write: [WORKING_FOLDER], network: "none" },
      timeoutMs: SKILL_SCRIPT_LIMITS.defaultTimeoutSeconds * 1000,
    });
    expect(results).toEqual([
      [
        "scripts/echo.js exited with code 0.",
        "<stdout>",
        "faked",
        "</stdout>",
        "<stderr>",
        "</stderr>",
      ].join("\n"),
    ]);
    const calls = JSON.parse(String(answerIn(client, answerId).attrs.toolCalls ?? "[]"));
    expect(calls).toMatchObject([{ status: "done", script: { ...RAN, error: null } }]);
  });
});
