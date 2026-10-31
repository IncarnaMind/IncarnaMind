/**
 * The OS sandbox for the programs Tools run, Skill scripts first (#65;
 * ADR-0013; docs/research/sandboxing.md): the "os" Executor, on macOS
 * (Seatbelt) and Linux (bubblewrap), through `@anthropic-ai/sandbox-runtime`,
 * pinned to an exact version in package.json. It is how Claude Code, Codex,
 * Cursor and Zed confine the commands their agents run.
 *
 * A program, and every process it starts:
 * - can't read the folders in `denyRead` (the User's home and IncarnaMind's
 *   data folder), except the folders its request allows (a Skill script's
 *   Skill folder and working folder) and its interpreter's own install when
 *   that is inside one (pyenv, conda, the app itself in ~/Applications). The
 *   rest of the disk stays readable, as sandbox-runtime leaves it: the
 *   system's libraries and interpreters;
 * - can write only the folders its request allows (its working folder),
 *   which is its TMPDIR too. sandbox-runtime hands out /tmp/claude, Claude
 *   Code's, which is denied here;
 * - has no network, not even to this computer.
 *
 * sandbox-runtime's `initialize()` isn't called: it starts a proxy that lets
 * allowlisted hosts through (and socat bridges on Linux) and listens for
 * SIGINT and SIGTERM, which would keep the app from quitting on them. With no
 * proxy, a wrap whose allowlist is empty blocks the network outright: no
 * localhost exception in the Seatbelt profile, and `--unshare-net` with no
 * bridge on Linux. What `initialize()` checks first, `loadOsSandbox` checks,
 * and then runs `true` in the sandbox to be sure.
 *
 * The Executor leaves out variables whose names look like secrets
 * (../core/execution), at every level. No Electron imports: tests run this
 * in Node.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExecRequest, Executor, ProcessLauncher } from "../core";
import { engineModule } from "../core/engineModules";
import { type Confinement, createLocalExecutor, folderPath } from "../core/execution";

type SandboxManager = typeof import("@anthropic-ai/sandbox-runtime")["SandboxManager"];

/** Loaded on macOS and Linux only: Windows has no OS sandbox yet. */
export const SANDBOX_RUNTIME = engineModule(
  "@anthropic-ai/sandbox-runtime",
  () => import("@anthropic-ai/sandbox-runtime"),
  [
    "SandboxManager.isSupportedPlatform",
    "SandboxManager.updateConfig",
    "SandboxManager.checkDependenciesAsync",
    "SandboxManager.wrapWithSandboxArgv",
    "SandboxManager.cleanupAfterCommand",
  ],
);

export interface OsExecutorOptions {
  /** Starts the programs, with the User's login-shell environment. */
  processes: ProcessLauncher;
  /** That environment: its PATH is where interpreters are found. */
  environment(): Promise<Readonly<Record<string, string>>>;
  /** Where each run without a `cwd` gets its temporary working folder. */
  tempDir: string;
  /**
   * Folders no program may read, except the folders inside them its request
   * allows: the User's home and IncarnaMind's data folder.
   */
  denyRead: readonly string[];
  /** Told when a run's temporary working folder can't be removed. */
  reportError(error: unknown): void;
}

/** Whether the OS sandbox can start here; if it can, how to make its Executors. */
export type OsSandbox =
  | { available: true; createExecutor(options: OsExecutorOptions): Executor }
  | { available: false; reason: string };

/**
 * sandbox-runtime's own temporary folder, which it keeps writable for the
 * TMPDIR it hands out (both spellings: /tmp is a link on macOS). Here a
 * program's TMPDIR is its working folder, so this is denied: it is shared
 * with every other program sandbox-runtime confines on this computer.
 */
const SANDBOX_RUNTIME_TEMP = ["/tmp/claude", "/private/tmp/claude"];

/** No network: an empty allowlist, and no proxy to let anything through. */
const NO_NETWORK = { allowedDomains: [], deniedDomains: [] };

/** No folders of its own to deny or allow: sandbox-runtime's defaults (reads open, writes closed). */
const NO_FILE_RULES = { denyRead: [], allowWrite: [], denyWrite: [] };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `text` as one word for the shell, as it is. */
const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** Whether `path` is `folder` or inside it. */
function isInside(path: string, folder: string): boolean {
  const between = relative(folder, path);
  return (
    between === "" || (between !== ".." && !between.startsWith(`..${sep}`) && !isAbsolute(between))
  );
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The program `command` names, as the shell inside the sandbox would find
 * it: a path as it is (from `cwd` if relative), a name on `path`. Rejects
 * with an error whose `code` is "ENOENT" when there is none.
 */
async function findCommand(command: string, path: string | undefined, cwd: string) {
  const candidates = command.includes("/")
    ? [resolve(cwd, command)]
    : (path ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((folder) => resolve(cwd, folder, command));
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) return candidate;
  }
  throw Object.assign(new Error(`${command} not found`), { code: "ENOENT" });
}

/**
 * Where the interpreter at `command` is installed, to read even inside a
 * denied folder: the folder above the one it is in (`<prefix>` of
 * `<prefix>/bin/python3`; the app bundle's Contents for Electron), else the
 * one it is in, for the command as found and as its real path (a venv's
 * python, Homebrew's links). Never a folder that holds a denied one.
 */
async function installFolders(command: string, denied: readonly string[]): Promise<string[]> {
  const real = await realpath(command).catch(() => command);
  const folders = new Set<string>();
  for (const path of [command, real]) {
    const folder = [dirname(dirname(path)), dirname(path)].find(
      (candidate) => !denied.some((deny) => isInside(deny, candidate)),
    );
    if (folder !== undefined) folders.add(folder);
  }
  return [...folders];
}

const execFileAsync = promisify(execFile);

/** How many processes the User's account runs now, as `ps` counts them. */
async function accountProcesses(): Promise<number> {
  const { stdout } = await execFileAsync("ps", [
    "-U",
    String(process.getuid?.() ?? 0),
    "-o",
    "pid=",
  ]);
  return stdout.split("\n").filter((line) => line.trim() !== "").length;
}

/**
 * The shell lines that set a request's file and process limits before its
 * program starts; a limit the shell can't set stops the run there. bash
 * counts `ulimit -f` in KiB. The process limit is per account on macOS and
 * Linux, so it is the account's processes now plus the request's.
 */
async function limitLines(limits: ExecRequest["limits"]): Promise<string[]> {
  const lines: string[] = [];
  if (limits?.fileBytes !== undefined) {
    lines.push(`ulimit -f ${Math.max(1, Math.floor(limits.fileBytes / 1024))} || exit 125`);
  }
  if (limits?.processes !== undefined) {
    lines.push(`ulimit -u ${(await accountProcesses()) + limits.processes} || exit 125`);
  }
  return lines;
}

/** The program and arguments that run `script` in the sandbox `config` describes. */
async function wrap(
  sandbox: SandboxManager,
  script: string,
  config: Partial<SandboxRuntimeConfig>,
): Promise<{ command: string; args: string[] }> {
  const { argv } = await sandbox.wrapWithSandboxArgv(script, undefined, config);
  const [command, ...args] = argv;
  if (command === undefined) throw new Error("sandbox-runtime gave no command to run.");
  return { command, args };
}

/** Runs each program in the OS sandbox, with only what its request allows. */
function osConfinement(sandbox: SandboxManager, options: OsExecutorOptions): Confinement {
  return {
    level: "os",
    async confine(request: ExecRequest, workingFolder: string) {
      if (request.allow.network !== "none") {
        throw new Error(
          "The OS sandbox gives programs no network, and this one asks for it, so it didn't run.",
        );
      }
      const env = { ...(await options.environment()), ...request.env };
      const command = await findCommand(request.command, env.PATH, workingFolder);
      const paths = (folders: ExecRequest["allow"]["read"]) =>
        folders.map((folder) => folderPath(folder, workingFolder));
      const config: Partial<SandboxRuntimeConfig> = {
        network: NO_NETWORK,
        filesystem: {
          denyRead: [...options.denyRead],
          allowRead: [
            ...paths(request.allow.read),
            ...(await installFolders(command, options.denyRead)),
          ],
          allowWrite: paths(request.allow.write),
          denyWrite: SANDBOX_RUNTIME_TEMP,
        },
      };
      const script = [
        `export TMPDIR=${quote(workingFolder)}`,
        ...(await limitLines(request.limits)),
        `exec ${[command, ...request.args].map(quote).join(" ")}`,
      ].join("; ");
      try {
        return { ...(await wrap(sandbox, script, config)), env: request.env };
      } catch (error) {
        throw new Error(
          `The OS sandbox couldn't start, so the program didn't run: ${messageOf(error)}`,
          {
            cause: error,
          },
        );
      }
    },
    release: () => sandbox.cleanupAfterCommand(),
  };
}

/**
 * Why a program can't run in the sandbox here, or undefined if it can: it
 * runs `true` in it. bubblewrap can be installed and still fail, e.g. where
 * Ubuntu 24.04 restricts user namespaces.
 */
async function cantRunHere(sandbox: SandboxManager): Promise<string | undefined> {
  let program: { command: string; args: string[] };
  try {
    program = await wrap(sandbox, "true", { network: NO_NETWORK, filesystem: NO_FILE_RULES });
  } catch (error) {
    return messageOf(error);
  }
  try {
    await execFileAsync(program.command, program.args, { timeout: 10_000 });
    return undefined;
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const said = typeof stderr === "string" ? stderr.trim().split("\n")[0] : "";
    return `a program in it couldn't start${said ? `: ${said}` : ` (${messageOf(error)})`}`;
  } finally {
    sandbox.cleanupAfterCommand();
  }
}

export interface OsSandboxOptions {
  /**
   * sandbox-runtime's seccomp helper, which bubblewrap runs on Linux, when
   * sandbox-runtime wouldn't find a copy bubblewrap can run: in a packaged
   * app it would name the one inside app.asar.
   */
  seccompHelper?: string;
}

/**
 * Finds out, once (at startup), whether the OS sandbox can start here:
 * macOS, and Linux with bubblewrap, socat and ripgrep where it can run.
 * Windows has none yet. Where it can't, scripts stay at level "none", where
 * each run asks first, and `reason` says why.
 */
export async function loadOsSandbox({ seccompHelper }: OsSandboxOptions = {}): Promise<OsSandbox> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return { available: false, reason: `there is no OS sandbox on ${process.platform} yet` };
  }
  let sandbox: SandboxManager;
  try {
    ({ SandboxManager: sandbox } = await SANDBOX_RUNTIME.load());
  } catch (error) {
    return { available: false, reason: `sandbox-runtime didn't load: ${messageOf(error)}` };
  }
  if (!sandbox.isSupportedPlatform()) {
    return { available: false, reason: "sandbox-runtime doesn't support this system (WSL 1)" };
  }
  if (seccompHelper !== undefined) {
    // Only the helper's place is taken from this: each wrap brings its own file and network rules.
    sandbox.updateConfig({
      network: NO_NETWORK,
      filesystem: NO_FILE_RULES,
      seccomp: { applyPath: seccompHelper },
    });
  }
  const { errors } = await sandbox.checkDependenciesAsync();
  if (errors.length > 0) return { available: false, reason: errors.join("; ") };
  const reason = await cantRunHere(sandbox);
  if (reason !== undefined) return { available: false, reason };
  return {
    available: true,
    createExecutor: (options) =>
      createLocalExecutor({ ...options, confinement: osConfinement(sandbox, options) }),
  };
}
