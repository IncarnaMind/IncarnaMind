/**
 * Skill scripts (#41): running one of a Skill's scripts as a child process,
 * for the `run_skill_script` Tool. Answers ask the User first (see
 * ../approvals); this module only runs what was allowed.
 *
 * - The interpreter is chosen by the file's extension: Python through
 *   IncarnaMind's own Python once `run_code` has got it (ADR-0025), else
 *   `python3` (`python` on Windows), and shell scripts through `bash`, both
 *   found on the User's login-shell PATH; JavaScript through the app's own
 *   Node.js (Electron's, as plain Node), so nothing needs installing for it.
 *   Shell scripts on Windows, TypeScript and other kinds give a plain error,
 *   and so does an interpreter that isn't installed, naming what to install.
 * - IncarnaMind's own Python that can't start is said so, and the script
 *   isn't run on `python3` instead: it would see other packages than the
 *   locked ones, without the User knowing. A script that stops at importing a
 *   package it doesn't include is a Problem naming the package, never its
 *   traceback; the model is also told that installing it on this computer
 *   won't help, which it otherwise tells the User to do.
 * - The script finds its Skill's folder in the `SKILL_DIR` environment variable.
 * - The core's `Executor` (see ../execution) runs it: in a new, empty
 *   temporary working folder, removed afterwards; with no input, until it
 *   exits or its timeout; stopped with every process it started on a
 *   timeout, a Stop, or IncarnaMind closing; what it writes kept up to
 *   `SKILL_SCRIPT_LIMITS.maxOutputBytes` per stream (the start of its
 *   standard output, the end of its error output), with a note when cut.
 * - It asks the Executor to allow reading the Skill's folder and the working
 *   folder, writing the working folder, and no network. The Executor leaves
 *   out the login shell's variables whose names look like secrets.
 *
 * At sandbox level "os" (macOS and Linux, src/main/sandbox.ts) the OS
 * sandbox enforces that. At "none" (Windows; Linux without bubblewrap)
 * nothing is enforced: a script can do whatever the User can, including
 * reaching the network (see `access`). That is why each run asks first.
 */
import { join } from "node:path";
import { translate } from "../../shared/i18n";
import type { ExecAllow, ExecRequest, Executor, ScriptRuntimes } from "../adapters";
import { SKILL_SCRIPT_LIMITS, type SkillScriptRun } from "../api";
import { declaredAccess, type ExecAccess, WORKING_FOLDER } from "../execution";
import type { Language } from "../language";
import type { InstalledPython } from "../runCode";

/**
 * Why a script can't run, in plain language: for the model, and for the
 * Tool-call card. E.g. its interpreter isn't installed.
 */
class SkillScriptError extends Error {
  override name = "SkillScriptError";
  constructor(
    message: string,
    /** What the model is told, where it needs more than the card says. */
    readonly toModel = message,
  ) {
    super(message);
  }
}

/** What the model is told of a script that couldn't run, where that isn't the card's reason. */
export const toldTheModel = (error: unknown): string | null =>
  error instanceof SkillScriptError ? error.toModel : null;

/** What runs a script: the command, and what its environment needs. */
export interface Interpreter {
  command: string;
  /** Given before the script's path. */
  flags: readonly string[];
  env: Readonly<Record<string, string>>;
  /** What to install when the command isn't there, e.g. "Python 3". */
  install: string;
  /** IncarnaMind's own Python, when it is that. */
  own?: InstalledPython;
}

/** One script to run, already checked to be a script file inside its Skill's folder. */
export interface ScriptToRun {
  /** The Skill's folder: absolute. Given to the script as `SKILL_DIR`. */
  skillDir: string;
  /** The script's path inside the Skill, "/" between folders, e.g. "scripts/convert.py". */
  script: string;
  args: readonly string[];
  timeoutMs: number;
  /** Stops the script, e.g. when the User stops the Answer. */
  signal: AbortSignal;
  /** The interface's, which a Problem the User reads on the script's card is written in. */
  language: Language;
}

export interface ScriptRunnerOptions {
  /** Runs the scripts: the core's, at its sandbox level. */
  executor: Executor;
  runtimes?: ScriptRuntimes;
  /** IncarnaMind's own Python, once it is installed here: asked at each run. */
  python?: () => InstalledPython | null;
}

const extensionOf = (path: string): string => {
  const name = path.split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
};

const supported = (platform: NodeJS.Platform) =>
  platform === "win32"
    ? "Python (.py) and JavaScript (.js, .mjs, .cjs) scripts can run on Windows."
    : "Python (.py), JavaScript (.js, .mjs, .cjs) and shell (.sh) scripts can run.";

type Runtimes = Required<ScriptRuntimes>;

/** The defaults: this process's own Node.js, as plain Node even inside Electron, on this OS. */
function runtimesFrom(given: ScriptRuntimes = {}): Runtimes {
  return {
    node: given.node ?? { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } },
    platform: given.platform ?? process.platform,
  };
}

/** No __pycache__ written into the Skill's folder; UTF-8 output on Windows too. */
const PYTHON_ENV = { PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };

/**
 * -E and -s keep the PYTHON* variables and user site-packages meant for the User's own Python out
 * of IncarnaMind's: a PYTHONHOME stops it starting, a PYTHONPATH mixes another Python's packages
 * into its locked ones. -B and -X utf8 do what `PYTHON_ENV` does, which -E ignores. Not -I: it
 * takes the script's folder off sys.path, and a script may import the modules beside it.
 */
const OWN_PYTHON_FLAGS = ["-E", "-s", "-B", "-X", "utf8"];

/** Python starts in well under a second in the sandbox (ADR-0025); one that hasn't by then won't. */
const START_CHECK_MS = 30_000;

/**
 * What runs the script at `path` (inside its Skill), by its extension: a Python script on `own`
 * when that is given. Throws `SkillScriptError` for one that can't run here.
 */
function interpreterFor(
  path: string,
  given?: ScriptRuntimes,
  own?: InstalledPython | null,
): Interpreter {
  const { node, platform } = runtimesFrom(given);
  const windows = platform === "win32";
  switch (extensionOf(path)) {
    case "py":
      // IncarnaMind's own Python is built for macOS and Linux only (ADR-0025).
      if (own && !windows) {
        return {
          command: own.command,
          flags: OWN_PYTHON_FLAGS,
          env: PYTHON_ENV,
          install: "Python 3",
          own,
        };
      }
      return {
        command: windows ? "python" : "python3",
        flags: [],
        env: PYTHON_ENV,
        install: "Python 3",
      };
    case "js":
    case "mjs":
    case "cjs":
      return { command: node.command, flags: [], env: { ...node.env }, install: "Node.js" };
    case "sh":
    case "bash":
      if (windows) {
        throw new SkillScriptError(
          `${path} is a shell script, and shell scripts can't run on Windows. ${supported(platform)}`,
        );
      }
      return { command: "bash", flags: [], env: {}, install: "bash" };
    case "ts":
    case "mts":
    case "cts":
      throw new SkillScriptError(
        `${path} is a TypeScript script, which IncarnaMind can't run yet. ${supported(platform)}`,
      );
    default:
      throw new SkillScriptError(
        `${path} isn't a kind of script IncarnaMind can run. ${supported(platform)}`,
      );
  }
}

/**
 * The arguments the model gave, checked: a list of text (numbers and
 * true/false are taken as text), within `SKILL_SCRIPT_LIMITS`.
 */
export function parseScriptArgs(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new SkillScriptError("args must be a list of strings.");
  const args = value.map((each) => {
    if (typeof each === "string") return each;
    if (typeof each === "number" || typeof each === "boolean") return String(each);
    throw new SkillScriptError("Each of the args must be a string.");
  });
  if (args.length > SKILL_SCRIPT_LIMITS.maxArgs) {
    throw new SkillScriptError(`A script takes ${SKILL_SCRIPT_LIMITS.maxArgs} args at most.`);
  }
  const chars = args.reduce((sum, each) => sum + each.length, 0);
  if (chars > SKILL_SCRIPT_LIMITS.maxArgsChars) {
    throw new SkillScriptError(
      `A script's args can have ${SKILL_SCRIPT_LIMITS.maxArgsChars} characters at most in all.`,
    );
  }
  if (args.some((each) => each.includes("\0"))) {
    throw new SkillScriptError("The args can't contain NUL characters.");
  }
  return args;
}

const isNotFound = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";

/** "python3" for "/usr/bin/python3" or "C:\\…\\python.exe". */
const commandName = (command: string) =>
  (command.split(/[\\/]/).at(-1) ?? command).replace(/\.(exe|cmd|bat)$/i, "");

/** A run that couldn't start, for the Tool-call card: why, in plain language. */
export const scriptNotRun = (error: string): SkillScriptRun => ({
  exitCode: null,
  timedOut: false,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  error,
});

/** What the model is told about a run: how it ended, then what it wrote. */
export function scriptResultText(script: string, run: SkillScriptRun, timeoutSeconds: number) {
  const limit = SKILL_SCRIPT_LIMITS.maxOutputBytes;
  const seconds = `${timeoutSeconds} second${timeoutSeconds === 1 ? "" : "s"}`;
  const ending = run.timedOut
    ? `${script} ran longer than ${seconds}, so it was stopped, with every process it started. What it wrote until then:`
    : run.exitCode === null
      ? `${script} was stopped before it finished. What it wrote until then:`
      : `${script} exited with code ${run.exitCode}.`;
  const stream = (name: string, text: string, cut: boolean, which: string) => [
    `<${name}>`,
    ...(text ? [text.replace(/\n$/, "")] : []),
    ...(cut ? [`[… truncated: only the ${which} ${limit} bytes of ${name} are kept.]`] : []),
    `</${name}>`,
  ];
  return [
    ending,
    ...stream("stdout", run.stdout, run.stdoutTruncated, "first"),
    ...stream("stderr", run.stderr, run.stderrTruncated, "last"),
  ].join("\n");
}

/**
 * What a script of the Skill in `skillDir` may touch: the Skill's folder and
 * its working folder to read, and IncarnaMind's own Python's when it runs on
 * that; its working folder to write; and no network.
 */
const scriptAllow = (skillDir: string, own?: InstalledPython): ExecAllow => ({
  read: [skillDir, WORKING_FOLDER, ...(own ? [own.prefix] : [])],
  write: [WORKING_FOLDER],
  network: "none",
});

const ownPythonCantStart = (script: string, why: string) =>
  new SkillScriptError(
    `IncarnaMind's own Python couldn't start on this computer, so ${script} didn't run: ${why}`,
  );

/**
 * Why IncarnaMind's own Python can't start, in its own words, or null if it starts. A script that
 * failed on it may have failed on its own: started again with nothing to run, as the script was,
 * the interpreter tells the two apart.
 */
async function whyOwnPythonFails(executor: Executor, check: ExecRequest): Promise<string | null> {
  const ran = await executor.run(check);
  if (ran.exitCode === 0) return null;
  const said = ran.stderr
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (said) return said;
  if (ran.timedOut) return `it didn't start within ${START_CHECK_MS / 1000} seconds.`;
  return ran.exitCode === null ? "the system stopped it." : `it exited with code ${ran.exitCode}.`;
}

/**
 * The package a script couldn't import, when the last line of its error output is that import's
 * error, or null. The name is the script's own text: only a plain module name is ever shown, and
 * nothing else it wrote. Python names a dotted module only once the package above it has
 * imported, so a dotted name is never a package that is missing.
 */
function missingPackage(stderr: string): string | null {
  const last = stderr.trimEnd().split("\n").at(-1)?.trim() ?? "";
  const named =
    /^ModuleNotFoundError: No module named '([^']*)'$/.exec(last)?.[1] ??
    /^ImportError: No module named '?([^'\s]*)'?$/.exec(last)?.[1];
  return named !== undefined && /^[A-Za-z0-9_]{1,64}$/.test(named) ? named : null;
}

/**
 * Exits with 3 when the runtime has no module of the name it is given. Run from the run's own
 * empty working folder, so neither the Skill's folder nor anything the script wrote counts.
 */
const NOT_INCLUDED =
  "import importlib.util, sys; sys.exit(3 if importlib.util.find_spec(sys.argv[1]) is None else 0)";

export function createScriptRunner(options: ScriptRunnerOptions) {
  const { executor } = options;
  const runtimes = runtimesFrom(options.runtimes);
  /** The runs going on, as `stopAll` and `close` stop them. */
  const running = new Set<AbortController>();
  let closed = false;

  return {
    /** Throws `SkillScriptError` if a script like this can't run here, before anyone is asked. */
    check(script: string): void {
      interpreterFor(script, runtimes);
    },

    /**
     * What a run of a script of the Skill in `skillDir` can reach, as
     * `run_skill_script` declares it: from the Executor's sandbox level. At
     * "none", anything, whatever the script was allowed.
     */
    access(skillDir: string): ExecAccess {
      return declaredAccess(executor.level, scriptAllow(skillDir));
    },

    /**
     * Runs a script in a new temporary folder, removed afterwards, and
     * resolves with how it went. Rejects with `SkillScriptError` when it can't
     * start, e.g. its interpreter isn't installed.
     */
    async run(request: ScriptToRun): Promise<SkillScriptRun> {
      const interpreter = interpreterFor(request.script, runtimes, options.python?.());
      if (closed) throw new SkillScriptError("IncarnaMind is closing, so the script didn't run.");
      request.signal.throwIfAborted();
      // Stopped by `stopAll` or `close`, as well as by the request's own signal.
      const stop = new AbortController();
      running.add(stop);
      const signal = AbortSignal.any([request.signal, stop.signal]);
      const program = {
        command: interpreter.command,
        env: { ...interpreter.env, SKILL_DIR: request.skillDir },
        ...(interpreter.own && { environment: "own-python" as const }),
        allow: scriptAllow(request.skillDir, interpreter.own),
        maxOutputBytes: SKILL_SCRIPT_LIMITS.maxOutputBytes,
        signal,
      };
      try {
        const run = await executor.run({
          ...program,
          args: [
            ...interpreter.flags,
            join(request.skillDir, ...request.script.split("/")),
            ...request.args,
          ],
          timeoutMs: request.timeoutMs,
        });
        if (interpreter.own && run.exitCode !== 0 && !run.timedOut && !signal.aborted) {
          const why = await whyOwnPythonFails(executor, {
            ...program,
            args: [...interpreter.flags, "-c", ""],
            timeoutMs: START_CHECK_MS,
          });
          if (why !== null && !signal.aborted) throw ownPythonCantStart(request.script, why);
          // Python ends with 1 on an exception nothing caught: any other run went on past it.
          const missing = run.exitCode === 1 && !signal.aborted ? missingPackage(run.stderr) : null;
          const notIncluded = async (name: string) =>
            (
              await executor.run({
                ...program,
                args: [...interpreter.flags, "-c", NOT_INCLUDED, name],
                timeoutMs: START_CHECK_MS,
              })
            ).exitCode === 3;
          if (missing !== null && (await notIncluded(missing))) {
            const problem = translate(request.language, "scripts.call.missingPackage", {
              package: missing,
            });
            throw new SkillScriptError(
              problem,
              translate(request.language, "scripts.call.missingPackage.model", { problem }),
            );
          }
        }
        // Field by field: the card stores exactly these in the Mind.
        return {
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          stdout: run.stdout,
          stderr: run.stderr,
          stdoutTruncated: run.stdoutTruncated,
          stderrTruncated: run.stderrTruncated,
          error: null,
        };
      } catch (error) {
        if (!isNotFound(error)) throw error;
        if (interpreter.own)
          throw ownPythonCantStart(request.script, "its program can't be found.");
        throw new SkillScriptError(
          `${commandName(interpreter.command)} not found: install ${interpreter.install} to run ${request.script}.`,
        );
      } finally {
        running.delete(stop);
      }
    },

    /** Stops every script running, e.g. when the User turns scripts off; their folders go once they have. */
    stopAll(): void {
      for (const stop of [...running]) stop.abort();
    },

    /** Stops every script running, and runs no more, e.g. when the app quits. */
    close(): void {
      closed = true;
      for (const stop of [...running]) stop.abort();
    },
  };
}
