/**
 * The command an AI app is given to start IncarnaMind's agent connection (#351): this app's
 * program, as plain Node, running the shim beside it. Started from an AppImage, the program runs
 * from a folder that exists only while that run lasts (`/tmp/.mount_…`, a new one each start), so
 * a command naming it stops working at the next start (#3643). The AppImage file itself can't run
 * the shim either: its AppRun puts `--no-sandbox` before every argument where the system refuses
 * user namespaces, and Node refuses that option. So from an AppImage the command is a script in
 * IncarnaMind's data folder, written again at each start with that run's program and shim: its
 * path never changes, and it says plainly when IncarnaMind isn't open. Pure Node, so it is tested
 * without Electron.
 */
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface AgentLauncher {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The script's name in the data folder. */
export const AGENT_LAUNCHER_SCRIPT = "agent-connection";

/** A path as one word of a POSIX shell, whatever it holds. */
const quoted = (path: string) => `'${path.replaceAll("'", `'\\''`)}'`;

/** The script that starts the shim with this run's program. */
export function launcherScript(program: string, shim: string): string {
  return [
    "#!/bin/sh",
    "# IncarnaMind writes this file each time it starts from its AppImage: its program runs from a",
    "# folder of that start only, and an AI app starts IncarnaMind's agent connection through here.",
    `program=${quoted(program)}`,
    `shim=${quoted(shim)}`,
    'if [ ! -x "$program" ]; then',
    '  echo "IncarnaMind isn\'t open. Open it, then try again. / IncarnaMind 没有打开。打开它后再试。" >&2',
    "  exit 1",
    "fi",
    'ELECTRON_RUN_AS_NODE=1 exec "$program" "$shim"',
    "",
  ].join("\n");
}

/**
 * The agent connection's command for this run. From an AppImage (`appImage`, the APPIMAGE
 * variable), writes the script into `dataFolder` first, readable and runnable by its owner only.
 */
export function agentLauncher(options: {
  execPath: string;
  shim: string;
  appImage: string | undefined;
  dataFolder: string;
}): AgentLauncher {
  if (!options.appImage) {
    return { command: options.execPath, args: [options.shim], env: { ELECTRON_RUN_AS_NODE: "1" } };
  }
  const path = join(options.dataFolder, AGENT_LAUNCHER_SCRIPT);
  const next = `${path}.${process.pid}.new`;
  writeFileSync(next, launcherScript(options.execPath, options.shim), { mode: 0o700 });
  // The mode a file is created with is narrowed by the umask; this one is set whatever it is.
  chmodSync(next, 0o700);
  renameSync(next, path);
  return { command: path, args: [], env: {} };
}
