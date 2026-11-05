/**
 * A Skill's Python script, as an Answer runs it, on IncarnaMind's own Python (ADR-0025) when that
 * is already on this computer, and on python3 from the PATH as before when it isn't. The runtime
 * here is a stand-in placed in the data folder as a finished download leaves it, its interpreter
 * a shell script; the Executor runs on this computer and only says it is the OS sandbox's. The
 * real runtime in the real sandbox is tested in tests/main/runCode.test.ts.
 */
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AnswerToolCall, CoreAdapters, ExecRequest } from "../../src/core";
import { createLocalExecutor, WORKING_FOLDER } from "../../src/core/execution";
import { createProcessLauncher } from "../../src/main/processes";
import { createCodeHost } from "../../src/main/runCode/host";
import { type PythonRuntimeManifest, pythonRuntimeFolder } from "../../src/main/runCode/python";
import { answerEnded, askNew } from "../helpers/citations";
import { createTempDataFolder, LOCAL_FETCH, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { answerIn } from "../helpers/minds";
import { answerRequests, scriptedModel, scriptedModels } from "../helpers/models";
import { importSkill, simpleSkillMd, writeFolder } from "../helpers/skills";

const MANIFEST: PythonRuntimeManifest = {
  file: "python-runtime-test.tar.zst",
  url: "http://127.0.0.1:9/python-runtime-test.tar.zst",
  size: 1000,
  sha256: "c".repeat(64),
  platform: "test",
  python: "3.14.10",
  packages: { numpy: "2.5.4" },
};

const shell = (...lines: string[]) => ["#!/bin/sh", ...lines, ""].join("\n");

const OWN_PYTHON = shell(`echo "IncarnaMind's Python: $*"`);

async function standIn(folder: string, name: string, script: string) {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, name), script);
  await chmod(join(folder, name), 0o755);
}

/**
 * The runtime as a download that finished leaves it: unpacked, imported once, and marked ready for
 * the archive it came from (`marked`: the SHA-256 its ready.json names; null, no ready.json).
 */
async function placeRuntime(
  dataDir: string,
  interpreter: string,
  { marked = MANIFEST.sha256 }: { marked?: string | null } = {},
) {
  const folder = pythonRuntimeFolder(dataDir, MANIFEST.sha256);
  const prefix = join(folder, "files", "python");
  await standIn(join(prefix, "bin"), "python3", interpreter);
  if (marked !== null)
    await writeFile(join(folder, "ready.json"), JSON.stringify({ sha256: marked }));
  return { command: join(prefix, "bin", "python3"), prefix };
}

/** A model that runs the Skill's where.py once, then answers with what the run gave it. */
function whereModel() {
  const results: string[] = [];
  const model = scriptedModel((call) => {
    const result = call.results.find((each) => each.tool === "run_skill_script");
    if (result) {
      results.push(result.text);
      return { text: "Done." };
    }
    return {
      calls: [
        { tool: "run_skill_script", input: { skill: "toolbox", script: "scripts/where.py" } },
      ],
    };
  });
  return { model, results };
}

/** What the model was sent as each run_skill_script call's result. */
function toldOfScripts(model: ReturnType<typeof whereModel>["model"]) {
  const told: unknown[] = [];
  for (const message of answerRequests(model).at(-1)?.prompt ?? []) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolName === "run_skill_script") {
        told.push(part.output);
      }
    }
  }
  return told;
}

async function setUp(
  options: {
    runtime?: { interpreter: string; marked?: string | null };
    scriptRuntimes?: CoreAdapters["scriptRuntimes"];
    language?: "en" | "zh-CN";
    /** More of the login environment than its PATH. */
    login?: Record<string, string>;
  } = {},
) {
  const dataDir = await createTempDataFolder();
  const tempDir = await createTempDataFolder();
  const sources = await createTempDataFolder();
  const path = await createTempDataFolder();
  await standIn(path, "python3", shell('echo "PATH python3: $*"'));
  await standIn(path, "python", shell('echo "PATH python: $*"'));
  const own = options.runtime
    ? await placeRuntime(dataDir, options.runtime.interpreter, options.runtime)
    : null;
  const processes = createProcessLauncher(async () => ({ PATH: path, ...options.login }));
  const local = createLocalExecutor({
    processes,
    tempDir,
    reportError: (error) => {
      throw error;
    },
  });
  const requests: ExecRequest[] = [];
  const fetched: string[] = [];
  const { model, results } = whereModel();
  const core = startCore(dataDir, {
    paths: { dataDir, tempDir },
    createChatModel: scriptedModels(model).createChatModel,
    processes,
    executor: {
      level: "os",
      run: (request) => {
        requests.push(request);
        return local.run(request);
      },
    },
    codeRuntime: createCodeHost({ python: MANIFEST, font: null, appVersion: "0.0.0-test" }),
    modelDownloads: {
      fetch: (input, init) => {
        fetched.push(String(input instanceof Request ? input.url : input));
        return LOCAL_FETCH(input, init);
      },
      copies: {},
    },
    ...(options.scriptRuntimes && { scriptRuntimes: options.scriptRuntimes }),
  });
  if (options.language) await core.updateSettings({ user: { language: options.language } });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const skill = await importSkill(
    core,
    await writeFolder(sources, "toolbox", {
      "SKILL.md": simpleSkillMd("toolbox", "Small scripts for tests. Use for running scripts."),
      "scripts/where.py": "import sys\nprint(sys.executable)\n",
    }),
  );
  await core.setApprovalPolicy({
    subject: { kind: "skill-script", skillId: skill.id },
    policy: "always",
    riskAccepted: true,
  });
  const mind = await core.createMind({ title: "Scripts" });
  const client = await connectToMind(core, mind.id);
  const skillDir = await realpath(join(dataDir, "skills", skill.id));

  async function runWhere() {
    const answerId = await askNew(core, client, mind.id, "Where does Python run?");
    expect((await answerEnded(core, answerId)).payload).toMatchObject({ status: "done" });
    const calls = JSON.parse(String(answerIn(client, answerId).attrs.toolCalls ?? "[]"));
    return (calls as AnswerToolCall[]).filter((call) => call.tool === "run_skill_script");
  }
  return { core, own, skillDir, requests, fetched, results, model, runWhere };
}

const SKILL_ONLY = (skillDir: string) => ({
  read: [skillDir, WORKING_FOLDER],
  write: [WORKING_FOLDER],
  network: "none",
});

describe.skipIf(process.platform === "win32")(
  "A Skill's Python script and IncarnaMind's own Python",
  { timeout: 30_000 },
  () => {
    test("once it is on this computer, the script runs on it, reading its folder, and nothing is downloaded", async () => {
      const { core, own, skillDir, requests, fetched, results, runWhere } = await setUp({
        runtime: { interpreter: OWN_PYTHON },
      });

      const calls = await runWhere();

      const script = join(skillDir, "scripts", "where.py");
      expect(results[0]).toContain(`IncarnaMind's Python: -E -s -B -X utf8 ${script}`);
      expect(calls).toMatchObject([{ status: "done", script: { exitCode: 0, error: null } }]);
      expect(requests.map(({ command, allow }) => ({ command, allow }))).toEqual([
        {
          command: own?.command,
          allow: { ...SKILL_ONLY(skillDir), read: [skillDir, WORKING_FOLDER, own?.prefix] },
        },
      ]);
      expect(fetched).toEqual([]);
      expect((await core.getPythonRuntime())?.state).toBe("ready");
    });

    test("before it is downloaded, the script runs on python3 from the PATH, and running it downloads nothing", async () => {
      const { core, skillDir, requests, fetched, results, runWhere } = await setUp();

      const calls = await runWhere();

      expect(results[0]).toContain(`PATH python3: ${join(skillDir, "scripts", "where.py")}`);
      expect(calls).toMatchObject([{ status: "done", script: { exitCode: 0, error: null } }]);
      expect(requests.map(({ command, allow }) => ({ command, allow }))).toEqual([
        { command: "python3", allow: SKILL_ONLY(skillDir) },
      ]);
      expect(fetched).toEqual([]);
      expect((await core.getPythonRuntime())?.state).toBe("not-downloaded");
    });

    test("one unpacked but never marked ready, as a failed check or first import leaves it, isn't used", async () => {
      const { requests, fetched, results, runWhere } = await setUp({
        runtime: { interpreter: OWN_PYTHON, marked: null },
      });

      await runWhere();

      expect(results[0]).toContain("PATH python3: ");
      expect(requests.map(({ command }) => command)).toEqual(["python3"]);
      expect(fetched).toEqual([]);
    });

    test("one marked ready for another archive than this build's isn't used", async () => {
      const { requests, fetched, results, runWhere } = await setUp({
        runtime: { interpreter: OWN_PYTHON, marked: "d".repeat(64) },
      });

      await runWhere();

      expect(results[0]).toContain("PATH python3: ");
      expect(requests.map(({ command }) => command)).toEqual(["python3"]);
      expect(fetched).toEqual([]);
    });

    test("one that is here but can't start is a Problem on the script's card and for the model; python3 isn't run instead", async () => {
      const { own, requests, results, model, runWhere } = await setUp({
        runtime: {
          interpreter: shell(
            'echo "Fatal Python error: init_fs_encoding: failed to get the Python codec of the filesystem encoding" >&2',
            `echo "ModuleNotFoundError: No module named 'encodings'" >&2`,
            "exit 1",
          ),
        },
      });

      const calls = await runWhere();

      const problem =
        "IncarnaMind's own Python couldn't start on this computer, so scripts/where.py didn't run: Fatal Python error: init_fs_encoding: failed to get the Python codec of the filesystem encoding";
      expect(results[0]).toContain(problem);
      expect(calls).toMatchObject([
        { status: "failed", script: { exitCode: null, error: problem } },
      ]);
      // The model reads that Problem alone: installing a package has nothing to do with it.
      expect(toldOfScripts(model)).toEqual([{ type: "error-text", value: `Error: ${problem}` }]);
      expect(requests.map(({ command }) => command)).toEqual([own?.command, own?.command]);
    });

    test("it never gets the User's own Python's settings from the login environment, which python3 still does", async () => {
      const login = {
        PYTHONEXECUTABLE: "/bin/echo",
        PYTHONPATH: "/elsewhere/site-packages",
        __PYVENV_LAUNCHER__: "/elsewhere/bin/python3",
        PLAIN_SETTING: "kept",
      };
      const printed = shell(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own variables.
        'echo "executable=${PYTHONEXECUTABLE-unset} path=${PYTHONPATH-unset} launcher=${__PYVENV_LAUNCHER__-unset} setting=${PLAIN_SETTING-unset} encoding=${PYTHONIOENCODING-unset}"',
      );
      const own = await setUp({ login, runtime: { interpreter: printed } });
      await own.runWhere();
      expect(own.results[0]).toContain(
        "executable=unset path=unset launcher=unset setting=kept encoding=utf-8",
      );

      const onPath = await setUp({ login });
      await onPath.runWhere();
      expect(onPath.results[0]).toContain("PATH python3: ");
      expect(onPath.requests[0]?.environment).toBeUndefined();
      expect(own.requests[0]?.environment).toBe("own-python");
    });

    test("a script that fails on it on its own comes back as it ran", async () => {
      const { results, runWhere } = await setUp({
        runtime: {
          interpreter: shell(
            'case " $* " in *" -c "*) exit 0 ;; esac',
            'echo "ValueError: no rows" >&2',
            "exit 1",
          ),
        },
      });

      const calls = await runWhere();

      expect(results[0]).toContain("scripts/where.py exited with code 1.");
      expect(results[0]).toContain("ValueError: no rows");
      expect(calls).toMatchObject([{ status: "failed", script: { exitCode: 1, error: null } }]);
    });

    for (const [language, words, alsoTold] of [
      [
        "en",
        "This Skill needs the Python package “zorblax_quant”, which isn’t included in IncarnaMind.",
        " Installing it on this computer won’t help: IncarnaMind runs Skills on its own Python.",
      ],
      [
        "zh-CN",
        "这个技能需要 Python 包“zorblax_quant”，IncarnaMind 未包含这个包。",
        "在这台电脑上安装这个包也没有用：IncarnaMind 用自己的 Python 运行技能。",
      ],
    ] as const) {
      test(`a package it doesn't include is a plain Problem on the card and for the model, which is also told installing it here won't help, with nothing the script wrote (${language})`, async () => {
        const { skillDir, model, results, runWhere } = await setUp({
          language,
          runtime: {
            // Asked whether it has the module, it has not (3); asked to start, it starts.
            interpreter: shell(
              'case " $* " in *find_spec*) exit 3 ;; *" -c "*) exit 0 ;; esac',
              'echo "Read 12 rows."',
              'echo "Traceback (most recent call last):" >&2',
              'echo "  File \\"$6\\", line 1, in <module>" >&2',
              `echo "ModuleNotFoundError: No module named 'zorblax_quant'" >&2`,
              "exit 1",
            ),
          },
        });

        const calls = await runWhere();

        expect(calls).toMatchObject([
          { status: "failed", script: { exitCode: null, stdout: "", stderr: "", error: words } },
        ]);
        // A failed Tool call reaches the model as an error, as every one does.
        const told = `Error: ${words}${alsoTold}`;
        expect(toldOfScripts(model)).toEqual([{ type: "error-text", value: told }]);
        expect(results[0]).toBe(told);
        for (const raw of ["Traceback", "ModuleNotFoundError", "Read 12 rows", skillDir]) {
          expect(results[0]).not.toContain(raw);
        }
      });
    }

    test("on Windows the script runs on python from the PATH, as before", async () => {
      const { skillDir, requests, results, runWhere } = await setUp({
        runtime: { interpreter: OWN_PYTHON },
        scriptRuntimes: { platform: "win32" },
      });

      await runWhere();

      expect(results[0]).toContain(`PATH python: ${join(skillDir, "scripts", "where.py")}`);
      expect(requests.map(({ command, allow }) => ({ command, allow }))).toEqual([
        { command: "python", allow: SKILL_ONLY(skillDir) },
      ]);
    });
  },
);
