/**
 * The desktop app's `CallWatcher` (#208): which call apps use the microphone, from a program that
 * waits on the system and prints a JSON line each time that changes. macOS runs the app's own
 * watcher (native/callWatcher/mac.m), Windows its own PowerShell (./windowsScript), Linux
 * PulseAudio's `pactl`. IncarnaMind's own processes never count: it records the microphone too.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { CallWatcher, Logger } from "../../core";
import type { CallWatchProblem } from "../../core/api";
import { appOfBundle, appOfLinuxStream, appOfWindowsProgram } from "../../shared/meetingApps";
import { isRecordingEvent, type RecordingStream, streamsOfJson, streamsOfText } from "./pactl";
import { windowsWatchScript } from "./windowsScript";

/** The macOS watcher's file beside app.asar, where the packager builds it (scripts/callWatcher.mjs). */
export const MAC_WATCHER = "call-watcher";

/** How long to wait before starting a watcher again after it stopped by itself; it gives up after `RESTARTS`. */
const RESTART_MS = 5000;
const RESTARTS = 3;
/** `pactl subscribe` says each stream change; a call opens several at once, so they are read once after this. */
const PACTL_SETTLE_MS = 300;

export interface OwnProcesses {
  /** IncarnaMind's processes now: the main one, its windows', its audio service's. */
  pids(): ReadonlySet<number>;
  /** Bundle identifiers of IncarnaMind's own on macOS, its helpers' included: a development build is Electron's. */
  bundles: readonly string[];
}

/** The call apps a macOS watcher line names, leaving out IncarnaMind's own processes. */
export function appsOfMacLine(line: string, own: OwnProcesses): string[] {
  const parsed = JSON.parse(line) as { apps?: { pid?: unknown; bundle?: unknown }[] };
  const pids = own.pids();
  const found = new Set<string>();
  for (const each of parsed.apps ?? []) {
    const bundle = typeof each.bundle === "string" ? each.bundle.toLowerCase() : "";
    if (typeof each.pid === "number" && pids.has(each.pid)) continue;
    if (own.bundles.some((ours) => bundle === ours || bundle.startsWith(`${ours}.`))) continue;
    const app = appOfBundle(bundle);
    if (app) found.add(app);
  }
  return [...found];
}

/** The call apps a Windows watcher line names. */
export function appsOfWindowsLine(line: string): string[] {
  const parsed = JSON.parse(line) as { apps?: unknown[] };
  const found = new Set<string>();
  for (const name of parsed.apps ?? []) {
    const app = typeof name === "string" ? appOfWindowsProgram(name) : null;
    if (app) found.add(app);
  }
  return [...found];
}

/** The call apps among PulseAudio's recording streams. */
export function appsOfStreams(streams: readonly RecordingStream[], own: OwnProcesses): string[] {
  const pids = own.pids();
  const found = new Set<string>();
  for (const stream of streams) {
    if (stream.pid !== null && pids.has(stream.pid)) continue;
    const app = appOfLinuxStream(stream.binary, stream.name);
    if (app) found.add(app);
  }
  return [...found];
}

type Listener = Parameters<CallWatcher["watch"]>[0];

/**
 * Runs `start` and reads its lines with `read`, starting it again when it stops by itself, a few
 * times, then saying the problem. Stopping kills it.
 */
function watchLines(
  log: Logger,
  listener: Listener,
  start: () => ChildProcess,
  read: (line: string) => void,
  missing: CallWatchProblem,
): () => void {
  let child: ChildProcess | null = null;
  let stopped = false;
  let restarts = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    timer = null;
    if (stopped) return;
    let running: ChildProcess;
    try {
      running = start();
    } catch (error) {
      log.error("calls.watcherFailed", {
        message: error instanceof Error ? error.message : String(error),
      });
      listener.problem("unavailable");
      return;
    }
    child = running;
    running.stdout?.setEncoding("utf8");
    if (running.stdout) {
      createInterface({ input: running.stdout }).on("line", (line) => {
        if (line.trim() === "") return;
        try {
          read(line);
        } catch (error) {
          log.warn("calls.watcherLineUnread", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }
    running.stderr?.setEncoding("utf8");
    running.stderr?.on("data", (text: string) =>
      log.warn("calls.watcherSaid", { text: text.slice(0, 500) }),
    );
    running.on("error", (error: NodeJS.ErrnoException) => {
      log.warn("calls.watcherDidntStart", { code: error.code ?? "unknown" });
      if (error.code === "ENOENT") {
        stopped = true;
        listener.problem(missing);
      }
    });
    running.on("exit", (code, signal) => {
      if (child === running) child = null;
      if (stopped) return;
      listener.apps([]);
      log.warn("calls.watcherEnded", { code: code ?? -1, signal: signal ?? "none" });
      if (restarts >= RESTARTS) {
        listener.problem("unavailable");
        return;
      }
      restarts += 1;
      timer = setTimeout(run, RESTART_MS);
    });
  };
  run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    child?.kill();
    child = null;
  };
}

export interface CallWatcherOptions {
  log: Logger;
  platform: NodeJS.Platform;
  own: OwnProcesses;
  /** The macOS watcher program; absent where the build has none. */
  macWatcher: string | null;
}

export function createCallWatcher(options: CallWatcherOptions): CallWatcher {
  const { log, platform, own } = options;
  return {
    watch(listener) {
      let last = "";
      const report = (apps: string[]) => {
        const sorted = [...apps].sort();
        const key = sorted.join(",");
        if (key === last) return;
        last = key;
        listener.apps(sorted);
      };
      if (platform === "darwin") {
        const program = options.macWatcher;
        if (!program) {
          log.warn("calls.noWatcherInThisBuild");
          listener.problem("unavailable");
          return () => undefined;
        }
        return watchLines(
          log,
          listener,
          () => spawn(program, [], { stdio: ["pipe", "pipe", "pipe"] }),
          (line) => report(appsOfMacLine(line, own)),
          "unavailable",
        );
      }
      if (platform === "win32") {
        return watchLines(
          log,
          listener,
          () =>
            spawn(
              "powershell.exe",
              [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                windowsWatchScript(process.pid),
              ],
              { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
            ),
          (line) => report(appsOfWindowsLine(line)),
          "unavailable",
        );
      }
      if (platform === "linux") return watchPulseAudio(log, listener, own, report);
      listener.problem("unavailable");
      return () => undefined;
    },
  };
}

function watchPulseAudio(
  log: Logger,
  listener: Listener,
  own: OwnProcesses,
  report: (apps: string[]) => void,
): () => void {
  let settle: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let jsonWorks = true;
  const list = () => {
    settle = null;
    const args = jsonWorks ? ["-f", "json", "list", "source-outputs"] : ["list", "source-outputs"];
    execFile(
      "pactl",
      args,
      { env: { ...process.env, LC_ALL: "C" }, timeout: 5000 },
      (error, stdout) => {
        if (stopped) return;
        if (error && jsonWorks) {
          jsonWorks = false;
          list();
          return;
        }
        if (error) {
          log.warn("calls.pactlListFailed", { message: error.message.slice(0, 300) });
          return;
        }
        try {
          report(appsOfStreams(jsonWorks ? streamsOfJson(stdout) : streamsOfText(stdout), own));
        } catch (parseError) {
          if (jsonWorks) {
            jsonWorks = false;
            list();
            return;
          }
          log.warn("calls.pactlListUnread", {
            message: parseError instanceof Error ? parseError.message : String(parseError),
          });
        }
      },
    );
  };
  const soon = () => {
    if (settle) clearTimeout(settle);
    settle = setTimeout(list, PACTL_SETTLE_MS);
  };
  const stop = watchLines(
    log,
    listener,
    () => {
      const child = spawn("pactl", ["subscribe"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, LC_ALL: "C" },
      });
      child.once("spawn", soon);
      return child;
    },
    (line) => {
      if (isRecordingEvent(line)) soon();
    },
    "no-pactl",
  );
  return () => {
    stopped = true;
    if (settle) clearTimeout(settle);
    stop();
  };
}
