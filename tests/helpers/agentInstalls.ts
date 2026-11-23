/**
 * Puts an agent where its installer would on this system (#3644), in a test's own folders: the
 * folders a test core or a test build looks in for apps and commands, and its home folder.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { clientDefinition } from "../../src/core/agents/clients";

export interface TestInstallFolders {
  /** Where apps are installed (`agents.applications`). */
  applications: string;
  /** A folder on the PATH (`agents.commandFolders`). */
  commands: string;
  home: string;
}

export type InstallSign = "app" | "command" | "program" | "extension";

const system = (): "darwin" | "win32" | "linux" =>
  process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux";

/** The signs of `id` this system has, in the order `installAgent` tries them. */
export function installSigns(id: string): InstallSign[] {
  const client = clientDefinition(id);
  if (!client) throw new Error(`No agent ${id}.`);
  return [
    ...(client.installs?.[system()]?.length ? (["app"] as const) : []),
    ...(client.commands?.length ? (["command"] as const) : []),
    ...(client.homePrograms?.length ? (["program"] as const) : []),
    ...(client.extension ? (["extension"] as const) : []),
  ];
}

async function runnableFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
}

/**
 * Installs `id` by one of its signs (its first on this system when `sign` is not given), and
 * returns what to remove to uninstall it.
 */
export async function installAgent(
  id: string,
  folders: TestInstallFolders,
  sign: InstallSign = installSigns(id)[0] ?? "app",
): Promise<string> {
  const client = clientDefinition(id);
  if (!client) throw new Error(`No agent ${id}.`);
  switch (sign) {
    case "app": {
      const segments = client.installs?.[system()]?.[0];
      if (!segments) throw new Error(`${id} has no app on ${system()}.`);
      const path = join(folders.applications, ...segments);
      if (system() === "darwin") await mkdir(path, { recursive: true });
      else await runnableFile(path);
      return path;
    }
    case "command": {
      const command = client.commands?.[0];
      if (!command) throw new Error(`${id} has no command.`);
      const path = join(
        folders.commands,
        process.platform === "win32" ? `${command}.cmd` : command,
      );
      await runnableFile(path);
      return path;
    }
    case "program": {
      const segments = client.homePrograms?.[0];
      if (!segments) throw new Error(`${id} has no program in the home folder.`);
      const path = join(folders.home, ...segments);
      await runnableFile(path);
      return path;
    }
    case "extension": {
      if (!client.extension) throw new Error(`${id} is no editor's extension.`);
      const folder = join(folders.home, ".vscode", "extensions");
      await mkdir(join(folder, `${client.extension}-1.0.0`), { recursive: true });
      const listed = [{ identifier: { id: client.extension }, version: "1.0.0" }];
      await writeFile(join(folder, "extensions.json"), JSON.stringify(listed));
      return join(folders.home, ".vscode");
    }
  }
}
