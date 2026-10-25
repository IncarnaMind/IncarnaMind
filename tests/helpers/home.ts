import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REAL_HOME_VARIABLE = "INCARNAMIND_TEST_REAL_HOME";

export function homeEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  };
}

/**
 * Electron switches that keep a launched app out of the User's own keychain. On macOS a locked or
 * prompting login keychain would also stall the launch, since safeStorage waits on it.
 */
export const KEYCHAIN_ARGS: readonly string[] =
  process.platform === "darwin" ? ["--use-mock-keychain"] : [];

/**
 * Arguments after the app path: on macOS, an app that quit within a second makes the next launch
 * wait for the "reopen windows?" prompt, for about ten minutes (#1176).
 */
export const APP_ARGS: readonly string[] =
  process.platform === "darwin" ? ["-ApplePersistenceIgnoreState", "YES"] : [];

export interface HomeGuard {
  /** Throws, naming the path, when it is in the real home folder and in none of the writable ones. */
  check(path: unknown): void;
  /** The paths refused since the last call. */
  takeRefused(): string[];
}

const within = (folder: string, path: string): boolean => {
  const rest = relative(folder, path);
  return rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
};

function pathOf(value: unknown): string | null {
  if (typeof value === "string") return resolve(value);
  if (Buffer.isBuffer(value)) return resolve(value.toString());
  if (value instanceof URL && value.protocol === "file:") return fileURLToPath(value);
  return null;
}

export function createHomeGuard(realHome: string, writable: readonly string[]): HomeGuard {
  // Left out: a writable folder that holds the home folder, as the temporary folder holds the
  // temporary HOME a run may be started with, would let every write in the home folder through.
  const inHome = writable.filter((folder) => !within(folder, realHome));
  const refused: string[] = [];
  return {
    check(value) {
      const path = pathOf(value);
      if (!path || !within(realHome, path) || inHome.some((folder) => within(folder, path))) {
        return;
      }
      refused.push(path);
      throw new Error(
        `Refused a write under the real home folder: ${path}. Tests use temporary folders (docs/agents/testing.md).`,
      );
    },
    takeRefused: () => refused.splice(0),
  };
}

const first = (args: unknown[]) => [args[0]];
const second = (args: unknown[]) => [args[1]];
const WRITE_FLAGS =
  fs.constants.O_WRONLY |
  fs.constants.O_RDWR |
  fs.constants.O_CREAT |
  fs.constants.O_APPEND |
  fs.constants.O_TRUNC;
const opensToWrite = (flags: unknown) =>
  typeof flags === "number" ? (flags & WRITE_FLAGS) !== 0 : /[wa+]/.test(String(flags ?? "r"));

const PATHS_WRITTEN_BY: Record<string, (args: unknown[]) => unknown[]> = {
  appendFile: first,
  copyFile: second,
  cp: second,
  createWriteStream: first,
  link: second,
  mkdir: first,
  mkdtemp: first,
  open: (args) => (opensToWrite(args[1]) ? [args[0]] : []),
  rename: (args) => [args[0], args[1]],
  rm: first,
  rmdir: first,
  symlink: second,
  truncate: first,
  unlink: first,
  writeFile: first,
};

let installed: HomeGuard | null = null;

/**
 * Makes every write through `fs`, `fs/promises` and their named imports go
 * past `guard` first: a refused one throws, or rejects as a failed write
 * would. Only this thread's: worker threads and child processes have only
 * the temporary HOME.
 */
export function installHomeGuard(guard: HomeGuard): void {
  for (const [module, suffixes, rejects] of [
    [fs, ["", "Sync"], false],
    [fs.promises, [""], true],
  ] as const) {
    for (const [name, pathsWritten] of Object.entries(PATHS_WRITTEN_BY)) {
      for (const suffix of suffixes) {
        const original: unknown = Reflect.get(module, `${name}${suffix}`);
        if (typeof original !== "function") continue;
        Reflect.set(
          module,
          `${name}${suffix}`,
          function guarded(this: unknown, ...args: unknown[]) {
            try {
              for (const path of pathsWritten(args)) guard.check(path);
            } catch (error) {
              if (rejects) return Promise.reject(error);
              throw error;
            }
            return Reflect.apply(original, this, args);
          },
        );
      }
    }
  }
  syncBuiltinESMExports();
  installed = guard;
}

export function installedHomeGuard(): HomeGuard {
  if (!installed)
    throw new Error("No home guard: tests/setup/home.ts isn't in this config's setupFiles.");
  return installed;
}
