/**
 * The desktop app's `CallWatcher` (#208): which call apps use the microphone, from a program that
 * waits on the system and prints a line each time that changes. macOS runs the app's own watcher
 * (native/callWatcher/mac.m), Linux PulseAudio's `pactl`. Windows has none yet: its helper waits
 * to be signed (#2843). IncarnaMind's own processes never count: it records the microphone too.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { CallWatcher, Logger } from "../../core";
import type { CallWatchProblem } from "../../core/api";
import { appOfBundle, appOfLinuxStream } from "../../shared/meetingApps";
import { isRecordingEvent, type RecordingStream, streamsOfJson, streamsOfText } from "./pactl";

/** The macOS watcher's file beside app.asar, where the packager builds it (scripts/callWatcher.mjs). */
export const MAC_WATCHER = "call-watcher";

/** `pactl subscribe` says each stream change; a call opens several at once, so they are read once after this. */
const PACTL_SETTLE_MS = 300;

export interface OwnProcesses {
  /** IncarnaMind's processes now: the main one, its windows', its audio service's. */
  pids(): ReadonlySet<number>;
  /** Bundle identifiers of IncarnaMind's own on macOS, its helpers' included: a development build is Electron's. */
  bundles: readonly string[];
}

/** A line of the macOS watcher: the call apps it names, and whether it knows which app runs input. */
export interface MacLine {
  apps: string[];
  exact: boolean;
  /** On macOS 12 and 13: whether the input device runs at all. */
  running: boolean;
}

/** The call apps a macOS watcher line names, leaving out IncarnaMind's own processes. */
export function readMacLine(line: string, own: OwnProcesses): MacLine {
  const parsed = JSON.parse(line) as {
    exact?: unknown;
    running?: unknown;
    apps?: { pid?: unknown; bundle?: unknown }[];
  };
  const pids = own.pids();
  const found = new Set<string>();
  for (const each of parsed.apps ?? []) {
    const bundle = typeof each.bundle === "string" ? each.bundle.toLowerCase() : "";
    if (typeof each.pid === "number" && pids.has(each.pid)) continue;
    if (own.bundles.some((ours) => bundle === ours || bundle.startsWith(`${ours}.`))) continue;
    const app = appOfBundle(bundle);
    if (app) found.add(app);
  }
  const exact = parsed.exact !== false;
  return { apps: [...found], exact, running: exact || parsed.running === true };
}

/**
 * The apps in a call as of a macOS line. Where the watcher names only the app in front (macOS 12
 * and 13), switching to another app isn't a call app letting go: an app stays until no input runs.
 */
export function macCallApps(previous: readonly string[], line: MacLine): string[] {
  if (line.exact) return line.apps;
  if (!line.running) return [];
  return [...new Set([...previous, ...line.apps])];
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

export interface Restarts {
  /** The first wait before starting a watcher that stopped by itself; each next one doubles. */
  firstMs: number;
  /** The longest wait. */
  maxMs: number;
  /** A watcher that ran this long was healthy: its next stop starts the waits over. */
  healthyMs: number;
  /** Stops in a row, each before it was healthy, after which the problem is said and it rests. */
  giveUpAfter: number;
}

export const RESTARTS: Restarts = {
  firstMs: 5000,
  maxMs: 5 * 60_000,
  healthyMs: 60_000,
  giveUpAfter: 6,
};

/**
 * Runs `start` and reads its lines with `read`. One that stops by itself says nothing about the
 * microphone: it is started again, after a wait that doubles each time it stops again soon, until
 * it has stopped `giveUpAfter` times in a row, when the problem is said. Stopping kills it.
 */
export function watchLines(options: {
  log: Logger;
  listener: Listener;
  start: () => ChildProcess;
  read: (line: string) => void;
  missing: CallWatchProblem;
  restarts?: Restarts;
  now?: () => number;
}): () => void {
  const { log, listener, start, read, missing } = options;
  const restarts = options.restarts ?? RESTARTS;
  const now = options.now ?? Date.now;
  let child: ChildProcess | null = null;
  let stopped = false;
  let stopsInARow = 0;
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
    const startedAt = now();
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
      log.warn("calls.watcherEnded", { code: code ?? -1, signal: signal ?? "none" });
      stopsInARow = now() - startedAt >= restarts.healthyMs ? 1 : stopsInARow + 1;
      if (stopsInARow >= restarts.giveUpAfter) {
        listener.problem("unavailable");
        return;
      }
      const wait = Math.min(restarts.maxMs, restarts.firstMs * 2 ** (stopsInARow - 1));
      timer = setTimeout(run, wait);
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
      let apps: string[] = [];
      const report = (given: string[], exact: boolean) => {
        apps = [...given].sort();
        const key = `${apps.join(",")}|${exact}`;
        if (key === last) return;
        last = key;
        listener.apps(apps, exact);
      };
      if (platform === "darwin") {
        const program = options.macWatcher;
        if (!program) {
          log.warn("calls.noWatcherInThisBuild");
          listener.problem("unavailable");
          return () => undefined;
        }
        return watchLines({
          log,
          listener,
          start: () => spawn(program, [], { stdio: ["pipe", "pipe", "pipe"] }),
          read: (line) => {
            const read = readMacLine(line, own);
            report(macCallApps(apps, read), read.exact);
          },
          missing: "unavailable",
        });
      }
      if (platform === "linux") return watchPulseAudio(log, listener, own, report);
      listener.problem(platform === "win32" ? "not-on-windows" : "unavailable");
      return () => undefined;
    },
  };
}

function watchPulseAudio(
  log: Logger,
  listener: Listener,
  own: OwnProcesses,
  report: (apps: string[], exact: boolean) => void,
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
          const streams = jsonWorks ? streamsOfJson(stdout) : streamsOfText(stdout);
          report(appsOfStreams(streams, own), true);
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
  const stop = watchLines({
    log,
    listener,
    start: () => {
      const child = spawn("pactl", ["subscribe"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, LC_ALL: "C" },
      });
      child.once("spawn", soon);
      return child;
    },
    read: (line) => {
      if (isRecordingEvent(line)) soon();
    },
    missing: "no-pactl",
  });
  return () => {
    stopped = true;
    if (settle) clearTimeout(settle);
    stop();
  };
}
