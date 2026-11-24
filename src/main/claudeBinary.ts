import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

export async function isRunnableFile(path: string, platform: NodeJS.Platform): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return false;
  if (platform === "win32") return true;
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}

export function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string {
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === name.toUpperCase() && typeof value === "string") return value;
  }
  return "";
}

export function localClaudeBinaryPath(home: string, platform: NodeJS.Platform): string {
  return join(home, ".local", "bin", platform === "win32" ? "claude.exe" : "claude");
}

/**
 * Resolves `command` using the login shell's PATH first (so an existing Homebrew/npm/system
 * installation is always found and preferred), falling back to Anthropic's default user-folder
 * launcher (`~/.local/bin/claude` or `%USERPROFILE%\.local\bin\claude.exe`) only when not on PATH.
 */
export async function resolveCommandOnPath(
  command: string,
  options: {
    environment: () => Promise<Readonly<Record<string, string | undefined>>>;
    home: string;
    platform?: NodeJS.Platform;
  },
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  if (isAbsolute(command)) return (await isRunnableFile(command, platform)) ? command : null;

  const env = await options.environment();
  const names =
    platform === "win32"
      ? (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
          .map((ext) => `${command}${ext}`)
      : [command];
  for (const folder of envValue(env, "PATH").split(delimiter).filter(Boolean)) {
    if (!isAbsolute(folder)) continue;
    for (const name of names) {
      const candidate = join(folder, name);
      if (await isRunnableFile(candidate, platform)) return candidate;
    }
  }

  if (command === "claude") {
    const local = localClaudeBinaryPath(options.home, platform);
    if (await isRunnableFile(local, platform)) return local;
  }
  return null;
}
