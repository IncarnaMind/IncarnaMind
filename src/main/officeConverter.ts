/**
 * The LibreOffice installed on the User's computer (#762): found where it
 * really is, never bundled, copied or downloaded, and run headless with a
 * profile of its own in a temporary folder, so no window shows, the User's
 * own LibreOffice settings are never touched, and a LibreOffice window
 * already open isn't fought over. It writes only into that folder: the file
 * converted is read, never changed, renamed or removed.
 */
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { OfficeConversion, OfficeConverter, OfficeTarget, ProcessLauncher } from "../core";
import { looksLikeSecret } from "../core/execution";

/** How long LibreOffice may take to say it is there. */
const VERSION_TIMEOUT_MS = 20_000;
/** How long a conversion may take; a large .doc on a slow computer can take a minute. */
const CONVERT_TIMEOUT_MS = 120_000;
/** The most of LibreOffice's own error output kept for the log. */
const MAX_ERROR_BYTES = 4_000;

export interface OfficeConverterOptions {
  /** Starts the process with the User's login-shell environment, as a terminal would. */
  processes: ProcessLauncher;
  /** The User's home folder, where an app can also be installed. */
  home: string;
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Where the User's programs are on Windows. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Where the temporary folders go. Defaults to the OS's temporary folder. */
  tempDir?: string;
  /**
   * Where to look for it, in order: absolute paths, or names on the PATH.
   * Defaults to where each platform installs it, then `soffice` and
   * `libreoffice` on the PATH; tests pin their own.
   */
  look?: readonly string[];
  versionTimeoutMs?: number;
  convertTimeoutMs?: number;
}

/** The places LibreOffice is installed on each platform, its own executable. */
function installPaths(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/LibreOffice.app/Contents/MacOS/soffice",
      join(home, "Applications/LibreOffice.app/Contents/MacOS/soffice"),
    ];
  }
  if (platform === "win32") {
    const program = env.ProgramFiles;
    const programX86 = env["ProgramFiles(x86)"];
    const local = env.LOCALAPPDATA;
    return [
      ...(program ? [join(program, "LibreOffice", "program", "soffice.exe")] : []),
      ...(programX86 ? [join(programX86, "LibreOffice", "program", "soffice.exe")] : []),
      ...(local ? [join(local, "Programs", "LibreOffice", "program", "soffice.exe")] : []),
    ];
  }
  return [
    "/usr/bin/soffice",
    "/usr/local/bin/soffice",
    "/opt/libreoffice/program/soffice",
    "/snap/bin/libreoffice",
  ];
}

function contains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * The LibreOffice on this computer, as the core's `OfficeConverter`. Asking
 * whether one is there starts it once with `--version` (headless, no window),
 * and the answer is kept for the session.
 */
export function createOfficeConverter(options: OfficeConverterOptions): OfficeConverter {
  const platform = options.platform ?? process.platform;
  const timeout = options.convertTimeoutMs ?? CONVERT_TIMEOUT_MS;
  let located: Promise<{ command: string; problem: string | null }> | null = null;

  /** Runs a command to its end, keeping its last error output; whether it ended with 0. */
  function run(
    command: string,
    args: readonly string[],
    timeoutMs: number,
    env: Record<string, string> = {},
  ): Promise<{ code: number | null; error: string; output: string }> {
    return new Promise((resolve, reject) => {
      options.processes
        // LibreOffice never gets a variable whose name looks like a secret.
        .spawn(command, args, { env, omitEnv: looksLikeSecret })
        .then((child) => {
          let error = "";
          let output = "";
          const keep = (chunk: string, into: "error" | "output") => {
            if (into === "error") error = (error + chunk).slice(-MAX_ERROR_BYTES);
            else output += chunk;
          };
          child.stderr?.setEncoding("utf8");
          child.stdout?.setEncoding("utf8");
          child.stderr?.on("data", (chunk: string) => keep(chunk, "error"));
          child.stdout?.on("data", (chunk: string) => keep(chunk, "output"));
          const limit = setTimeout(() => child.kill(), timeoutMs);
          child.once("close", (code) => {
            clearTimeout(limit);
            resolve({ code, error, output });
          });
          child.once("error", (error) => {
            clearTimeout(limit);
            reject(error);
          });
        }, reject);
    });
  }

  async function version(command: string): Promise<boolean> {
    try {
      const result = await run(
        command,
        ["--version"],
        options.versionTimeoutMs ?? VERSION_TIMEOUT_MS,
      );
      return result.code === 0 && contains(`${result.output}\n${result.error}`, "libreoffice");
    } catch {
      return false;
    }
  }

  async function find(): Promise<{ command: string; problem: string | null }> {
    const look = options.look ?? [
      ...installPaths(platform, options.home, options.env ?? process.env),
      ...(platform === "win32" ? ["soffice.exe"] : ["soffice", "libreoffice"]),
    ];
    for (const command of look) {
      if (isAbsolute(command)) {
        try {
          await access(command);
        } catch {
          continue;
        }
      }
      if (await version(command)) return { command, problem: null };
    }
    return { command: "", problem: "LibreOffice wasn't found on this computer." };
  }

  const locate = () => {
    located ??= find();
    return located;
  };

  return {
    async available() {
      return (await locate()).problem === null;
    },

    async convert(path: string, target: OfficeTarget): Promise<OfficeConversion> {
      const found = await locate();
      if (found.problem !== null) return { outcome: "failed", message: found.problem };
      const folder = await mkdtemp(join(options.tempDir ?? tmpdir(), "incarnamind-convert-"));
      const profile = join(folder, "profile");
      const out = join(folder, "out");
      try {
        await mkdir(profile, { recursive: true, mode: 0o700 });
        await mkdir(out, { recursive: true, mode: 0o700 });
        // LibreOffice reads a copy, never the User's file: it may write beside what it is given.
        const copy = join(folder, basename(path));
        await copyFile(path, copy);
        const args = [
          "--headless",
          "--invisible",
          "--nodefault",
          "--norestore",
          "--nolockcheck",
          "--nofirststartwizard",
          `-env:UserInstallation=${pathToFileURL(profile).href}`,
          "--convert-to",
          target,
          "--outdir",
          out,
          copy,
        ];
        const result = await run(found.command, args, timeout, { HOME: profile });
        if (result.code !== 0) {
          return {
            outcome: "failed",
            message: result.error.trim() || `LibreOffice ended with code ${result.code ?? "none"}.`,
          };
        }
        const written = (await readdir(out)).filter((name) => contains(name, `.${target}`));
        const name = written[0];
        if (name === undefined) {
          return {
            outcome: "failed",
            message: result.error.trim() || "LibreOffice wrote no converted file.",
          };
        }
        const converted = join(out, name);
        const size = (await stat(converted)).size;
        const bytes = new Uint8Array(await readFile(converted));
        if (bytes.byteLength === 0 || bytes.byteLength !== size) {
          return { outcome: "failed", message: "The converted file couldn't be read." };
        }
        return { outcome: "converted", name: basename(name), bytes };
      } catch (error) {
        return {
          outcome: "failed",
          message: error instanceof Error ? error.message : String(error),
        };
      } finally {
        await rm(folder, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
