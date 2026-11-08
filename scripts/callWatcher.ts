/**
 * Builds the macOS call watcher (#208) from native/callWatcher/mac.m into resources/call-watcher/,
 * which electron-builder ships beside app.asar and signs with the app. `npm run build` does it on
 * macOS, as the release job's build does; it needs Xcode's command line tools. A build made where
 * they are missing works without the watcher, and the offers for calls say this computer can't
 * tell, except in CI, where it fails instead: a release must never ship without it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const CALL_WATCHER = "incarnamind-call-watcher";

export function buildCallWatcher(root: string): { built: string } | { skipped: string } {
  if (process.platform !== "darwin") return { skipped: "only macOS has one to build" };
  const source = join(root, "native", "callWatcher", "mac.m");
  const folder = join(root, "resources", "call-watcher");
  const output = join(folder, CALL_WATCHER);
  if (existsSync(output) && statSync(output).mtimeMs >= statSync(source).mtimeMs) {
    return { built: output };
  }
  mkdirSync(folder, { recursive: true });
  try {
    execFileSync(
      "xcrun",
      [
        "clang",
        "-fobjc-arc",
        "-O2",
        "-Wall",
        "-Werror",
        "-arch",
        "arm64",
        "-mmacosx-version-min=12.0",
        "-framework",
        "AppKit",
        "-framework",
        "CoreAudio",
        "-framework",
        "Foundation",
        "-o",
        output,
        source,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
  } catch (error) {
    if (process.env.CI) throw error;
    return { skipped: `clang couldn't build it (${error instanceof Error ? error.message : error})` };
  }
  return { built: output };
}
