/**
 * The OS sandbox for the programs Tools run, Skill scripts first (#65;
 * ADR-0013; docs/research/sandboxing.md): the "os" Executor, on macOS
 * (Seatbelt) and Linux (bubblewrap), through `@anthropic-ai/sandbox-runtime`,
 * pinned to an exact version in package.json. It is how Claude Code, Codex,
 * Cursor and Zed confine the commands their agents run.
 *
 * A program, and every process it starts:
 * - can't read the folders in `denyRead` (the User's home, IncarnaMind's data
 *   folder, the shared and per-user temporary folders, and the roots volumes
 *   are mounted under), except the folders its request allows (a Skill
 *   script's Skill folder and working folder) and its interpreter's own
 *   install when that is in a home or on a volume (pyenv, conda, the app itself
 *   in ~/Applications), never in a temporary folder or the data folder. The
 *   rest of the disk stays readable, as sandbox-runtime leaves it: the system's
 *   libraries and interpreters;
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
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExecRequest, Executor, Logger, ProcessLauncher } from "../core";
import type { SandboxProblem } from "../core/api";
import { engineModule } from "../core/engineModules";
import { type Confinement, createLocalExecutor, folderPath } from "../core/execution";
import { createMeters, type Meters } from "./programMeter";
import {
  createRunSweeper,
  type RunSweeper,
  type RunSweeperOptions,
  runServiceName,
} from "./runLeftovers";

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
   * allows, as `readDeniedFolders` builds them.
   */
  denyRead: readonly string[];
  /**
   * The denied folders an interpreter found on the PATH may still be read in where it is
   * installed, as `interpreterRoots` builds them; none unless given.
   */
  interpreterRoots?: readonly string[];
  /** Told when a run's temporary working folder can't be removed. */
  reportError(error: unknown): void;
  /**
   * Where each run is recorded until its sweep has ended it (./runLeftovers): a folder of this
   * app's own, which no run can read or write, so no other copy of the app sweeps its runs.
   */
  runRecords: string;
  /** Where each signal a run's sweep sends is logged. */
  log?: Logger;
  /** A test's stopper for the sweep, which records instead of signalling. */
  sweep?: Pick<RunSweeperOptions, "stopper">;
}

/**
 * Whether the OS sandbox can start here; if it can, how to make its Executors. Where it can't
 * on Linux, `problem` says what the User can do about it (ADR-0025).
 */
export type OsSandbox =
  | { available: true; createExecutor(options: OsExecutorOptions): Executor }
  | { available: false; reason: string; problem?: SandboxProblem };

/** The packages sandbox-runtime's dependency errors name, as a Linux distribution calls them. */
export function missingPackages(errors: readonly string[]): string[] {
  const packages: string[] = [];
  if (errors.some((error) => /bubblewrap|bwrap/.test(error))) packages.push("bubblewrap");
  if (errors.some((error) => /socat/.test(error))) packages.push("socat");
  if (errors.some((error) => /ripgrep/.test(error))) packages.push("ripgrep");
  return packages;
}

/**
 * sandbox-runtime's own temporary folder, which it keeps writable for the
 * TMPDIR it hands out (both spellings: /tmp is a link on macOS). Here a
 * program's TMPDIR is its working folder, so this is denied: it is shared
 * with every other program sandbox-runtime confines on this computer.
 */
const SANDBOX_RUNTIME_TEMP = ["/tmp/claude", "/private/tmp/claude"];

/** What a run is denied reading, whatever its request allows (#2350). */
export interface ReadDeniedOptions {
  platform: NodeJS.Platform;
  /** The User's home folder. */
  home: string;
  /** IncarnaMind's data folder. */
  dataDir: string;
  /** Where a run without a `cwd` gets its working folder (`os.tmpdir()`). */
  temporaryFolder: string;
  /**
   * The User's id, where the system has one: on Linux `/run/user/<uid>` holds this User's
   * session bus, systemd user manager, keyring and ssh-agent sockets and drive mounts.
   */
  uid?: number;
}

/**
 * The folders no program may read, except the folders inside them its request
 * allows: every account's home (the User's and others'), the shared temporary
 * folders every app on the computer writes to, the roots this system mounts
 * volumes under (#2350), and on Linux this User's runtime folder. What stays
 * readable is the system's own files.
 * A run's working folder is inside the temporary folder, and its request's
 * allow rules re-open it within the deny. Windows has no OS sandbox, so
 * nothing is denied there.
 */
export function readDeniedFolders(options: ReadDeniedOptions): string[] {
  const { platform, home, dataDir, temporaryFolder, uid } = options;
  if (platform !== "darwin" && platform !== "linux") return [];
  const folders = [home, dataDir, temporaryFolder];
  if (temporaryFolder !== "/tmp") folders.push("/tmp");
  if (platform === "linux") {
    folders.push("/home", "/root", "/var/tmp", "/media", "/mnt", "/run/media");
    if (uid !== undefined) folders.push(`/run/user/${uid}`);
    return folders;
  }
  // The User's other temporary and cache folders beside T (.../C, .../0), where
  // T is the system's per-user temporary folder: never the parent of a TMPDIR
  // someone pointed at, which could be /opt or /var itself.
  const beside = dirname(temporaryFolder);
  if (beside.startsWith("/var/folders/") || beside.startsWith("/private/var/folders/")) {
    folders.push(beside);
  }
  folders.push("/Users", "/private/tmp", "/var/tmp", "/private/var/tmp", "/Volumes");
  return folders;
}

/**
 * What the macOS profile denies on top of sandbox-runtime's: in Seatbelt the last rule that
 * matches wins. LaunchServices (`open` starts any app or the browser outside the sandbox, with
 * a URL carrying what the code read), the security server (the Keychain), and distributed
 * notifications (a channel to other apps). Nothing a run needs uses them.
 */
export const MAC_DENIED = [
  "(deny mach-lookup",
  '  (global-name "com.apple.coreservices.launchservicesd")',
  '  (global-name "com.apple.lsd.mapdb")',
  '  (global-name "com.apple.SecurityServer")',
  '  (global-name "com.apple.securityd.xpc"))',
  "(deny distributed-notification-post)",
].join("\n");

/**
 * The profile sandbox-runtime builds, with `MAC_DENIED` after it, and the run's own service name
 * when `run` is given: nothing serves that name, so looking it up does nothing, but
 * `sandbox_check` tells the run's processes by it (./runLeftovers). Its sandbox-exec, which it
 * names by path, is started through a shell that adds them. Fails, so nothing runs, when the
 * command isn't the shape this expects.
 */
export function withMacDenials(wrapped: string, run?: string, metered = false): string {
  const call = " /usr/bin/sandbox-exec -p ";
  const at = wrapped.indexOf(call);
  if (at < 0 || wrapped.indexOf(call, at + 1) >= 0) {
    throw new Error("sandbox-runtime's command for macOS isn't the one IncarnaMind adds to.");
  }
  // No proxy and an empty allowlist give no network rule (0.0.81); a later version that adds one
  // must not run with it.
  if (wrapped.includes("(allow network")) {
    throw new Error("sandbox-runtime's profile for macOS lets programs reach the network.");
  }
  const rules = [
    MAC_DENIED,
    ...(run ? [`(allow mach-lookup (global-name ${JSON.stringify(runServiceName(run))}))`] : []),
    // POSIX shared memory counts against no limit of a program's and outlives it.
    ...(metered ? ["(deny ipc-posix-shm-write-create)"] : []),
  ].join("\n");
  const stricter = ` /bin/sh -c 'p=$1; shift; exec /usr/bin/sandbox-exec -p "$p
$0" "$@"' ${quote(rules)} `;
  return `${wrapped.slice(0, at)}${stricter}${wrapped.slice(at + call.length)}`;
}

/** The most each folder bubblewrap mounts over a denied one may hold: it is memory. */
export const DENIED_MOUNT_BYTES = 1024 * 1024;

/**
 * bubblewrap, with a size on each tmpfs it mounts over a denied folder, which is otherwise as
 * large as memory and counted by no limit; and the same for /dev, whose tmpfs (`--dev /dev`)
 * holds /dev/shm: that gets a sized tmpfs of its own, and /dev is read-only once every mount is
 * made. sandbox-runtime runs this in its place. A profile long enough to go through an
 * arguments file can't be sized here, so it doesn't run.
 */
export const bwrapScript = (bwrap: string) =>
  [
    "#!/bin/sh",
    `real=${quote(bwrap)}`,
    'n=$#; past=""; dev=""; devmade=""',
    "for a do",
    '  if [ -z "$past" ] && [ "$a" = --args ]; then',
    '    echo "The sandbox profile is too long to size its folders." >&2; exit 125',
    "  fi",
    '  if [ -z "$past" ] && [ "$a" = -- ] && [ -n "$devmade" ]; then set -- "$@" --remount-ro "$devmade"; fi',
    `  if [ -z "$past" ] && [ "$a" = --tmpfs ]; then set -- "$@" --size ${DENIED_MOUNT_BYTES} --tmpfs`,
    '  else set -- "$@" "$a"; fi',
    `  if [ -z "$past" ] && [ -n "$dev" ]; then set -- "$@" --size ${DENIED_MOUNT_BYTES} --tmpfs "$a/shm"; devmade="$a"; fi`,
    '  dev=""',
    '  if [ -z "$past" ] && [ "$a" = --dev ]; then dev=1; fi',
    '  if [ "$a" = -- ]; then past=1; fi',
    "done",
    'shift "$n"',
    'exec "$real" "$@"',
    "",
  ].join("\n");

/** Whether bubblewrap's help names `--size`, which came in bubblewrap 0.7 (Ubuntu 22.04 has 0.6). */
export const bwrapSizesTmpfs = (help: string): boolean => /^\s*--size\b/m.test(help);

/**
 * What `sizedBwrap` found: no `bwrap` on the PATH, which the dependency check names as a missing
 * package; a bubblewrap that can't size a tmpfs, which runs as it is; or the sized script.
 */
export type SizedBwrap =
  | { kind: "missing" }
  | { kind: "unsized" }
  | { kind: "sized"; script: string };

/**
 * Writes `bwrapScript` where only this User can change it, in a folder of this User's own
 * (the shared /tmp is checked: a folder someone else made there is refused).
 */
export async function sizedBwrap(tempFolder: string): Promise<SizedBwrap> {
  const real = await findCommand("bwrap", process.env.PATH, "/").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (real === null) return { kind: "missing" };
  let help: string;
  try {
    const { stdout, stderr } = await execFileAsync(real, ["--help"]);
    help = `${stdout}\n${stderr}`;
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    // Only silence means the probe itself failed: help can come with a nonzero exit.
    if (!stdout && !stderr) throw error;
    help = `${stdout ?? ""}\n${stderr ?? ""}`;
  }
  if (!bwrapSizesTmpfs(help)) return { kind: "unsized" };
  const folder = join(tempFolder, `incarnamind-bwrap-${process.getuid?.() ?? 0}`);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const info = await lstat(folder);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error(`${folder} isn't a private folder of this User's.`);
  }
  const script = join(folder, "bwrap");
  // A name of this process's own, renamed into place: another copy starting at the same moment
  // writes its own file, and a rename over an existing `bwrap` is atomic (#2599).
  const writing = join(folder, `bwrap.${process.pid}.${randomUUID()}.new`);
  await writeFile(writing, bwrapScript(real), { mode: 0o700 });
  await rename(writing, script);
  return { kind: "sized", script };
}

/** No network: an empty allowlist, and no proxy to let anything through. */
const NO_NETWORK = { allowedDomains: [], deniedDomains: [] };

/** No folders of its own to deny or allow: sandbox-runtime's defaults (reads open, writes closed). */
const NO_FILE_RULES = { denyRead: [], allowWrite: [], denyWrite: [] };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const startFailed = (error: unknown) =>
  new Error(`The OS sandbox couldn't start, so the program didn't run: ${messageOf(error)}`, {
    cause: error,
  });

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
 * The one spelling of `path` the sandbox is given and compares: every link on its way followed,
 * as realpath gives it (macOS's /tmp, /var and /etc are links into /private). A program in the
 * sandbox can't follow a link the profile denies, and a rule compared in another spelling than
 * the path it guards doesn't hold, so nothing reaches the profile, or is compared with a denied
 * folder, in any other. For a path that isn't there, the folders on its way that are, and the
 * rest as written; `mustExist`: refused instead, so a run never goes ahead on a spelling that
 * may not be the real one.
 */
export async function canonicalPath(
  path: string,
  { mustExist = false }: { mustExist?: boolean } = {},
): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    const parent = dirname(path);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === path) throw error;
    if (mustExist) {
      throw new Error("A folder or program the sandbox was given can't be found, so nothing ran.", {
        cause: error,
      });
    }
    return join(await canonicalPath(parent), basename(path));
  }
}

/** Each of `folders` as written and as `canonicalPath` spells it: a link to one is it too. */
async function bothSpellings(folders: readonly string[]): Promise<string[]> {
  return [
    ...new Set([...folders, ...(await Promise.all(folders.map((each) => canonicalPath(each))))]),
  ];
}

/**
 * The denied folders an interpreter's own install may still be read in (`installFolders`): the
 * homes and the roots volumes are mounted under, where pyenv, conda, nvm, Homebrew in a home or
 * the app itself in ~/Applications put them. In every other denied folder (the temporary folders,
 * IncarnaMind's data folder, this User's runtime folder) another app's or another run's files
 * could sit beside it, so it never is; IncarnaMind's own Python names its folder in its request.
 */
export function interpreterRoots(options: Pick<ReadDeniedOptions, "platform" | "home">): string[] {
  const { platform, home } = options;
  if (platform === "darwin") return [home, "/Users", "/Volumes"];
  if (platform === "linux") return [home, "/home", "/root", "/media", "/mnt", "/run/media"];
  return [];
}

/**
 * What is read back inside the denied folders for the interpreter, no wider than the interpreter:
 * for the command as it is run, its own folder, and the venv above it where there is one (whose
 * packages it reads); for its real path, its own folder and, of the install it belongs to
 * (`<prefix>` of `<prefix>/bin/python3`), the bin and lib folders only, never the rest of a prefix
 * such as ~/.local; a venv or the app bundle's Contents whole. Never a folder that holds a denied
 * one, nor one inside a denied folder but where interpreters are installed (`interpreterRoots`);
 * nothing for one outside every denied folder, readable already. Every path here is canonical.
 */
export async function installFolders(
  command: string,
  real: string,
  denied: readonly string[],
  roots: readonly string[],
): Promise<string[]> {
  const reopens = (candidate: string) => {
    if (denied.some((deny) => isInside(deny, candidate))) return false;
    const around = denied.filter((deny) => isInside(candidate, deny));
    const innermost = around.reduce<string | null>(
      (deepest, deny) => (deepest === null || deny.length > deepest.length ? deny : deepest),
      null,
    );
    return innermost !== null && roots.includes(innermost);
  };
  const there = (path: string) =>
    access(path).then(
      () => true,
      () => false,
    );
  // A prefix's bin or lib may be a link: read where it really is, with its name to follow there,
  // only when that place is itself a bin or lib folder of the prefix (lib-3.12, lib64). One that
  // links anywhere else, the prefix itself or its share folder among them, opens nothing.
  const linkedFolders = async (folders: readonly string[]) =>
    (
      await Promise.all(
        folders.map(async (each) => {
          const real = await canonicalPath(each);
          return dirname(real) === dirname(each) &&
            /^(bin|lib)([-._]?\d[\w.]*)?$/.test(basename(real))
            ? [real, ...(real === each ? [] : [each])]
            : [];
        }),
      )
    ).flat();
  const own = dirname(command);
  const venv = dirname(own);
  const named = (await there(join(venv, "pyvenv.cfg"))) ? [venv, own] : [own];
  const prefix = dirname(dirname(real));
  const whole =
    (await there(join(prefix, "pyvenv.cfg"))) ||
    (basename(prefix) === "Contents" && dirname(prefix).endsWith(".app"));
  const installed = !reopens(prefix)
    ? [dirname(real)]
    : whole
      ? [prefix]
      : [dirname(real), ...(await linkedFolders([join(prefix, "bin"), join(prefix, "lib")]))];
  const folders = [...new Set([...named, ...installed])].filter(reopens);
  // bubblewrap refuses to start with a folder to read that isn't there.
  return (
    await Promise.all(folders.map(async (each) => ((await there(each)) ? each : null)))
  ).filter((each): each is string => each !== null);
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
  if (limits?.fileBytes !== undefined || limits?.folderBytes !== undefined) {
    // A run can't duplicate file descriptors without bound: unmeasured, they would hide unlinked
    // files the folder limit counts (#2351). 1024 is Linux's usual default and above macOS's 256,
    // so ordinary programs keep their descriptors.
    lines.push("ulimit -n 1024 || exit 125");
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
  run?: string,
  metered = false,
): Promise<{ command: string; args: string[] }> {
  const { argv } = await sandbox.wrapWithSandboxArgv(script, undefined, config);
  const [command, flag, wrapped, ...rest] = argv;
  if (command === undefined || flag !== "-c" || wrapped === undefined || rest.length > 0) {
    throw new Error("sandbox-runtime gave no command IncarnaMind can run.");
  }
  return {
    command,
    args: [flag, process.platform === "darwin" ? withMacDenials(wrapped, run, metered) : wrapped],
  };
}

/**
 * Runs each program in the OS sandbox, with only what its request allows. `readable`: what every
 * program must read wherever it is (sandbox-runtime's seccomp helper, which runs inside).
 */
function osConfinement(
  sandbox: SandboxManager,
  options: OsExecutorOptions,
  readable: readonly string[],
  sweeper: RunSweeper,
  sizedMasks: boolean,
  meters: Meters,
): Confinement {
  return {
    level: "os",
    async confine(request: ExecRequest, workingFolder: string) {
      const blocked = await sweeper.stuck();
      if (blocked !== null) throw new Error(blocked);
      if (!sizedMasks && request.limits?.memoryBytes !== undefined) {
        throw new Error(
          "This computer's bubblewrap can't size the folders it puts over denied ones (bubblewrap 0.7 or later can), so a program's memory limit can't hold and it didn't run.",
        );
      }
      if (request.allow.network !== "none") {
        throw new Error(
          "The OS sandbox gives programs no network, and this one asks for it, so it didn't run.",
        );
      }
      const env = { ...(await options.environment()), ...request.env };
      const strict = (path: string) => canonicalPath(path, { mustExist: true });
      const found = await findCommand(request.command, env.PATH, workingFolder);
      // Run by its own name in its canonical folder: a venv's python is a link, and finds its
      // venv only when run by it.
      const command = join(await strict(dirname(found)), basename(found));
      const working = await strict(workingFolder);
      const denied = await bothSpellings(options.denyRead);
      // Canonical, an allowed folder that is a link opens what it points at, where sandbox-runtime
      // would open only the name: safe because every folder a request allows is one the app made
      // (a run's folders, a Skill's own folder, the runtime's and the font's).
      const allowed = async (folders: ExecRequest["allow"]["read"]) => {
        const real = await Promise.all(folders.map((each) => strict(folderPath(each, working))));
        if (real.some((folder) => denied.some((deny) => isInside(deny, folder)))) {
          throw new Error(
            "A folder the program was to read or write holds one no program may read, so it didn't run.",
          );
        }
        return real;
      };
      const config: Partial<SandboxRuntimeConfig> = {
        network: NO_NETWORK,
        filesystem: {
          denyRead: denied,
          allowRead: [
            ...(await allowed(request.allow.read)),
            ...(await installFolders(
              command,
              await strict(found),
              denied,
              await bothSpellings(options.interpreterRoots ?? []),
            ).catch((error: unknown) => {
              throw startFailed(error);
            })),
            ...(await Promise.all(readable.map(strict))),
          ],
          allowWrite: await allowed(request.allow.write),
          denyWrite: SANDBOX_RUNTIME_TEMP,
        },
      };
      const script = [
        `export TMPDIR=${quote(working)}`,
        ...(await limitLines(request.limits)),
        `exec ${[command, ...request.args].map(quote).join(" ")}`,
      ].join("; ");
      try {
        const run = randomUUID();
        const metered = request.limits?.memoryBytes !== undefined;
        const program = await wrap(sandbox, script, config, run, metered);
        const { sweep, adopted } = await sweeper.begin(run, working);
        return { ...program, env: request.env, sweep, meter: meters.meter(adopted) };
      } catch (error) {
        throw startFailed(error);
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
async function cantRunHere(
  sandbox: SandboxManager,
  readable: readonly string[],
): Promise<string | undefined> {
  // A denied folder, as every run has: on Linux that is where bubblewrap's sized mounts go.
  const denied = await mkdtemp(join(tmpdir(), "incarnamind-sandbox-probe-"));
  let program: { command: string; args: string[] };
  try {
    program = await wrap(sandbox, "true", {
      network: NO_NETWORK,
      filesystem: { ...NO_FILE_RULES, denyRead: [denied], allowRead: [...readable] },
    });
  } catch (error) {
    await rm(denied, { recursive: true, force: true });
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
    await rm(denied, { recursive: true, force: true });
  }
}

/** sandbox-runtime's own seccomp helper for this computer's processor. */
function bundledSeccompHelper(): string {
  const runtime = dirname(
    dirname(createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime")),
  );
  return join(runtime, "vendor", "seccomp", process.arch, "apply-seccomp");
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
  // On Linux the seccomp helper runs inside the sandbox, so its folder stays readable.
  const readable: string[] = [];
  // macOS's profile mounts nothing; on Linux only a bubblewrap that can size a tmpfs does.
  let sizedMasks = process.platform === "darwin";
  if (process.platform === "linux") {
    // The meter tells the User's processes from the sandbox's own by their PID namespaces (#2351).
    let status: string;
    try {
      status = await readFile("/proc/self/status", "utf8");
    } catch (error) {
      return { available: false, reason: messageOf(error), problem: { kind: "start" } };
    }
    if (!/^NSpid:/m.test(status)) {
      return {
        available: false,
        reason:
          "this Linux doesn't show the PID namespaces of a process (it needs Linux 4.1 or later)",
        problem: { kind: "start" },
      };
    }
    const helper = seccompHelper ?? bundledSeccompHelper();
    readable.push(dirname(helper));
    let bwrapPath: string | undefined;
    try {
      const sized = await sizedBwrap(tmpdir());
      if (sized.kind === "sized") {
        bwrapPath = sized.script;
        sizedMasks = true;
      }
      // Missing: the dependency check below names the package. Unsized: an older bubblewrap runs
      // as it is, and a run that asks for a memory limit is refused (osConfinement).
    } catch (error) {
      return { available: false, reason: messageOf(error), problem: { kind: "start" } };
    }
    // Only the helper's and bubblewrap's places are taken from this: each wrap brings its own
    // file and network rules.
    sandbox.updateConfig({
      network: NO_NETWORK,
      filesystem: NO_FILE_RULES,
      seccomp: { applyPath: helper },
      ...(bwrapPath !== undefined && { bwrapPath }),
    });
  } else if (seccompHelper !== undefined) {
    sandbox.updateConfig({
      network: NO_NETWORK,
      filesystem: NO_FILE_RULES,
      seccomp: { applyPath: seccompHelper },
    });
  }
  const { errors, warnings } = await sandbox.checkDependenciesAsync();
  // Without its seccomp filter the sandbox lets a program open unix sockets (the session bus,
  // systemd, ssh-agent): sandbox-runtime runs anyway and only warns, so this fails closed.
  const unfiltered = warnings.filter((warning) => /seccomp/i.test(warning));
  if (process.platform === "linux" && errors.length === 0 && unfiltered.length > 0) {
    return { available: false, reason: unfiltered.join("; "), problem: { kind: "start" } };
  }
  if (errors.length > 0) {
    const packages = missingPackages(errors);
    return {
      available: false,
      reason: errors.join("; "),
      ...(process.platform === "linux" &&
        packages.length > 0 && {
          problem: { kind: "missing" as const, packages },
        }),
    };
  }
  const reason = await cantRunHere(sandbox, readable);
  if (reason !== undefined) {
    return {
      available: false,
      reason,
      ...(process.platform === "linux" && { problem: { kind: "start" as const } }),
    };
  }
  return {
    available: true,
    createExecutor: (options) =>
      createLocalExecutor({
        ...options,
        confinement: osConfinement(
          sandbox,
          options,
          readable,
          createRunSweeper({
            report: options.reportError,
            log: (fields) => options.log?.info("runSweep.signal", fields),
            records: options.runRecords,
            ...options.sweep,
          }),
          sizedMasks,
          createMeters(),
        ),
      }),
  };
}
