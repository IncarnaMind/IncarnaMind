/**
 * How each run of the app ends, in its log (#2309): what asked it to quit, and the code it exited
 * with. A quit the app didn't ask for, with no menu, signal, update or session end behind it, came
 * from outside: on macOS, the Dock's Quit or another program's quit request, which Electron hands on
 * as a plain quit. A run that ends with none of this (a crash, a force quit) is told at the next start.
 */
import type { LogFields, Logger } from "../core";
import type { UnsavedAtEnd } from "../core/api";
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
  /** Stores, quits as `by=os` and records the end when Windows ends the session, before it ends the process. */
  watchSessionEnd(window: SessionWindow, ending: SessionEnding): void;
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

/** What the app does as Windows ends the session, besides quitting. */
export interface SessionEnding {
  /** Stores the changes that wait, at once; says how many still wait, and where. */
  store(): UnsavedAtEnd;
  /** Records the run as ended by the system, with the changes it couldn't store. */
  record(unsaved: UnsavedAtEnd): void;
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
    watchSessionEnd(window, ending) {
      // On Windows Electron sends no quit events when the session ends, and ends the process as
      // soon as this returns, whether or not a quit goes through: everything here is synchronous.
      // The record comes last, as a quit held for unsaved changes marks the run as still in use.
      // Not at `query-session-end`, which another program can still cancel.
      window.on("session-end", () => {
        const unsaved = ending.store();
        quit("os", unsaved.count > 0 ? { unsaved: unsaved.count } : undefined);
        ending.record(unsaved);
      });
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
 * (`lastRun`), and each window whose page was reopened after it crashed.
 */
export function unexpectedEnds(lastRun: Exclude<UnexpectedEnd, { kind: "window" }> | null) {
  let app = lastRun;
  const pages = new Set<number>();
  return {
    pageEnded(contentsId: number): void {
      pages.add(contentsId);
    },
    /** Said once: later asks get null. The app's end, if untold, is said before a page's. */
    take(contentsId: number): UnexpectedEnd | null {
      const page = pages.delete(contentsId);
      if (app) {
        const told = app;
        app = null;
        return told;
      }
      return page ? { kind: "window" } : null;
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

/**
 * Which page a window shows, for the log: the file name of one of the app's own pages (under one
 * of `ownPages`), else `web`, as a cited website's address is the User's.
 */
export function pageName(url: string, ownPages: readonly string[]): string {
  if (!URL.canParse(url) || !ownPages.some((own) => url.startsWith(own))) return "web";
  return new URL(url).pathname.split("/").at(-1) || "index.html";
}
