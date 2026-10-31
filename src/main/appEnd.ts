/**
 * How each run of the app ends, in its log (#2309): what asked it to quit, and the code it exited
 * with. A quit the app didn't ask for, with no menu, signal, update or session end behind it, came
 * from outside: on macOS, the Dock's Quit or another program's quit request, which Electron hands on
 * as a plain quit. A run that ends with none of this (a crash, a force quit) is told at the next start.
 */
import type { LogFields, Logger } from "../core";
import type { UnexpectedEnd } from "../shared/bridge";

/** What asked the app to quit, as the log names it. */
export type QuitAsker =
  /** Quit in the app's menu, clicked. */
  | "menu"
  /** Quit's keys: ⌘Q, Ctrl+Q. */
  | "shortcut"
  | "update"
  /** The last window closed, on Windows and Linux. */
  | "lastWindow"
  | "startFailed"
  /** The User's answer to the unsaved-changes question. */
  | "unsavedChoice"
  /** SIGTERM, SIGINT or SIGHUP. */
  | "signal"
  /** The system ending the session: a shutdown, a restart or a log-out. */
  | "os"
  /** Anything else: the Dock's Quit, another program. */
  | "outside";

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

export interface AppEnd {
  /** Quits, the log saying `by` asked. Every quit the app asks for itself goes through here. */
  quit(by: QuitAsker, fields?: LogFields): void;
  /** Names what asks for the quit about to come, which something else starts (an update, a shutdown). */
  asking(by: QuitAsker): void;
  /** Quits as `by=os` when Windows ends the session, before it ends the process. */
  watchSessionEnd(window: SessionWindow): void;
  /** Takes SIGTERM, SIGINT and SIGHUP from `ready` on: each quits as Electron's own handler did, logged. */
  watchSignals(): void;
}

/** Electron's app, as far as quitting goes. */
interface QuittingApp {
  on(event: "before-quit" | "will-quit", listener: () => void): unknown;
  quit(): void;
}

/** A window, which Windows tells that the session ends. */
interface SessionWindow {
  on(event: "session-end", listener: () => void): unknown;
}

/** The process: its exit and its signals. */
interface Host {
  readonly pid: number;
  on(event: "exit", listener: (code: number) => void): unknown;
  once(event: NodeJS.Signals, listener: () => void): unknown;
}

export function logAppEnd(
  app: QuittingApp,
  logger: Pick<Logger, "info">,
  host: Host = process,
): AppEnd {
  let asked: { by: QuitAsker; fields?: LogFields } | null = null;
  const quit = (by: QuitAsker, fields?: LogFields) => {
    asked = { by, ...(fields && { fields }) };
    app.quit();
  };
  // The first listener, so it is logged before anything holds the quit back (unsaved changes).
  app.on("before-quit", () => {
    logger.info("app.quitAsked", { by: asked?.by ?? "outside", ...asked?.fields });
    asked = null;
  });
  app.on("will-quit", () => logger.info("app.quit"));
  host.on("exit", (code) => logger.info("app.exited", { pid: host.pid, code }));
  return {
    quit,
    asking(by) {
      asked = { by };
    },
    watchSessionEnd(window) {
      // On Windows Electron sends no quit events when the session ends, and ends the process right
      // after this event: quitting here runs `before-quit`, which logs and marks the run as ended.
      // Not at `query-session-end`, which another program can still cancel.
      window.on("session-end", () => quit("os"));
    },
    watchSignals() {
      // Electron installs its handler once the app has started, over any Node took before; one
      // taken after `ready` replaces it. Once, as Electron's is: a second signal ends the app at once.
      for (const signal of SIGNALS) host.once(signal, () => quit("signal", { signal }));
    },
  };
}

/**
 * Which windows have an unexpected end to tell: the first to ask after a start that followed one
 * (`appEnded`), and each window whose page was reopened after it crashed.
 */
export function unexpectedEnds(appEnded: boolean) {
  let app = appEnded;
  const pages = new Set<number>();
  return {
    pageEnded(contentsId: number): void {
      pages.add(contentsId);
    },
    /** Said once: later asks get null. The app's end, if untold, is said before a page's. */
    take(contentsId: number): UnexpectedEnd | null {
      const page = pages.delete(contentsId);
      if (app) {
        app = false;
        return "app";
      }
      return page ? "window" : null;
    },
  };
}

/**
 * Whether a window's page that crashed is loaded again: not while the last load after a crash
 * hasn't finished, and not at its third crash in a minute, so a page that can't stay up doesn't loop.
 */
export function crashReloads(now: () => number = () => performance.now()) {
  let loading = false;
  let crashes: number[] = [];
  return {
    loaded(): void {
      loading = false;
    },
    /** True when the page should be loaded again after this crash. */
    crashed(): boolean {
      const at = now();
      crashes = [...crashes.filter((each) => at - each < 60_000), at];
      if (loading || crashes.length >= 3) return false;
      loading = true;
      return true;
    },
  };
}
