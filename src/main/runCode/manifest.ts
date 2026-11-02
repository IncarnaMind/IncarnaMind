/**
 * What the core runs `run_code` with on this computer (ADR-0025): the archive of IncarnaMind's
 * own Python this build was made with, as the build wrote it into the app's resources
 * (`python-native/runtime.json`, scripts/pythonNative.ts), and the font plots draw Chinese with.
 * A copy without the file (a build from the repository that never built the runtime, Windows)
 * runs bash alone. No Electron imports: tests read the manifest in Node.
 */
import { readFileSync } from "node:fs";
import type { PythonRuntimeManifest } from "../../core/runCode";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): value is string => typeof value === "string" && value !== "";

/** https, or a stand-in on this computer, which only tests serve. */
const allowedUrl = (url: URL) =>
  url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1");

/** This computer's platform as the runtime's archives are named: "darwin-arm64", "linux-x64". */
export const runtimePlatform = (platform: NodeJS.Platform, arch: string) => `${platform}-${arch}`;

/**
 * The manifest in `file`, checked field by field; null when there is none, or it is for
 * another platform, or anything in it is wrong, which the log says.
 */
export function readPythonManifest(
  file: string,
  platform: string,
  warn: (reason: string) => void,
): PythonRuntimeManifest | null {
  let given: unknown;
  try {
    given = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warn(`${file} can't be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }
  if (!isRecord(given) || !isRecord(given.packages)) {
    warn(`${file} isn't a runtime manifest.`);
    return null;
  }
  const { file: archive, url, size, sha256, python, packages } = given;
  const fine =
    text(archive) &&
    /^[\w.-]+\.tar\.zst$/.test(archive) &&
    text(url) &&
    URL.canParse(url) &&
    allowedUrl(new URL(url)) &&
    typeof size === "number" &&
    Number.isSafeInteger(size) &&
    size > 0 &&
    text(sha256) &&
    /^[0-9a-f]{64}$/.test(sha256) &&
    text(python) &&
    given.platform === platform;
  const versions: Record<string, string> = {};
  for (const [name, version] of Object.entries(packages)) {
    if (!text(version)) {
      warn(`${file} gives ${name} no version.`);
      return null;
    }
    versions[name] = version;
  }
  if (!fine) {
    warn(`${file} names a runtime for ${String(given.platform)}, or has a field that's wrong.`);
    return null;
  }
  return { file: archive, url, size, sha256, platform, python, packages: versions };
}
