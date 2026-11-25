/**
 * Desktop host file adapter for hand editing decks (#149): adds Windows Files On-Demand
 * cloud-placeholder detection (never hydrating the file), and in test builds supports
 * `INCARNAMIND_TEST_DECK_FILES` so smoke tests inject file-system failures without `chmod`.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import type { DeckFiles } from "../core/adapters";
import { createNodeDeckFiles, isWindowsCloudAttributes } from "../core/decks/places";
import { markReplaceStage } from "../core/fileNames";

const execFileAsync = promisify(execFile);

/** Queries Win32 `FileAttributes` without opening or hydrating a cloud placeholder. */
async function windowsCloudPlaceholder(path: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[int][System.IO.File]::GetAttributes($env:INCARNAMIND_CHECK_PATH)",
      ],
      {
        env: { ...process.env, INCARNAMIND_CHECK_PATH: path },
        timeout: 3_000,
        windowsHide: true,
      },
    );
    return isWindowsCloudAttributes(Number(stdout.trim()));
  } catch {
    return false;
  }
}

type TestDeckFault =
  | "read-only"
  | "locked"
  | "folder"
  | "cloud"
  | "full"
  | "gone"
  | "copy-failed-full"
  | "copy-failed-folder";

const errno = (code: string, message: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: ${message}`), { code });

function readTestRules(spec: string): Record<string, TestDeckFault> {
  try {
    const raw = spec.trim().startsWith("{") ? spec : readFileSync(spec, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, TestDeckFault>) : {};
  } catch {
    return {};
  }
}

/**
 * Host `DeckFiles` adapter for `createPlatformAdapters`. Returns `undefined` on macOS/Linux
 * outside test-injected runs so the core uses its default `createNodeDeckFiles`.
 */
export function createHostDeckFiles(): Partial<DeckFiles> | undefined {
  const testSpec =
    import.meta.env.MODE === "test" ? process.env.INCARNAMIND_TEST_DECK_FILES : undefined;
  if (!testSpec) {
    if (process.platform !== "win32") return undefined;
    return createNodeDeckFiles({ detectDataless: false, windowsCloudPlaceholder });
  }
  const base = createNodeDeckFiles({
    detectDataless: process.platform === "darwin",
    windowsCloudPlaceholder,
  });
  const faultFor = (path: string): TestDeckFault | undefined => {
    const rules = readTestRules(testSpec);
    return rules[basename(path)] ?? rules["*"];
  };
  const folderFaultFor = (folder: string): TestDeckFault | undefined => {
    const rules = readTestRules(testSpec);
    return rules[`folder:${basename(folder)}`];
  };
  return {
    ...base,
    async stat(path) {
      if (faultFor(path) === "gone") throw errno("ENOENT", `no such file '${path}'`);
      return base.stat(path);
    },
    async access(path, mode) {
      if (mode === "write") {
        const fault = faultFor(path);
        if (
          fault === "read-only" ||
          fault === "copy-failed-full" ||
          fault === "copy-failed-folder"
        ) {
          throw errno("EACCES", `permission denied '${path}'`);
        }
        if (folderFaultFor(path) === "folder") {
          throw errno("EACCES", `permission denied '${path}'`);
        }
      }
      return base.access(path, mode);
    },
    async isCloudPlaceholder(path, info) {
      if (faultFor(path) === "cloud") return true;
      return base.isCloudPlaceholder(path, info);
    },
    async replaceFile(path, data, stillSo, mode) {
      const fault = faultFor(path);
      if (fault === "locked") {
        throw markReplaceStage(errno("EBUSY", `resource busy '${path}'`), "rename");
      }
      if (fault === "full") {
        throw markReplaceStage(errno("ENOSPC", `no space left '${path}'`), "temp");
      }
      if (fault === "folder") {
        throw markReplaceStage(errno("EACCES", `permission denied '${dirname(path)}'`), "temp");
      }
      return base.replaceFile(path, data, stillSo, mode);
    },
    async saveCopy(file, save) {
      const fault = faultFor(file.name);
      if (fault === "copy-failed-full") {
        throw errno("ENOSPC", `no space left '${file.name}'`);
      }
      if (fault === "copy-failed-folder") {
        throw errno("EACCES", `permission denied '${file.name}'`);
      }
      return save();
    },
  };
}
