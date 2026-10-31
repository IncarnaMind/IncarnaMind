/**
 * How each run of the app ends, in its log (#2309): what asked it to quit, and the code it exited
 * with. A quit the app didn't ask for, with no menu, signal, update or shutdown behind it, came from
 * outside: on macOS, the Dock's Quit or another program's quit request, which Electron hands on as a
 * plain quit. A run that ends with none of this (a crash, a force quit) is told at the next start.
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
  | "shutdown"
  /** Anything else: the Dock's Quit, logging out, another program. */
  | "outside";

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

export interface AppEnd {
  /** Quits, the log saying `by` asked. Every quit the app asks for itself goes through here. */
  quit(by: QuitAsker, fields?: LogFields): void;
  /** Names what asks for the quit about to come, which something else starts (an update, a shutdown). */
  asking(by: QuitAsker): void;
  /** Takes SIGTERM, SIGINT and SIGHUP from `ready` on: each quits as Electron's own handler did, logged. */
  watchSignals(): void;
}

/** Electron's app, as far as quitting goes. */
interface QuittingApp {
  on(event: "before-quit" | "will-quit", listener: () => void): unknown;
  quit(): void;
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
    /** Said once: later asks get null. */
    take(contentsId: number): UnexpectedEnd | null {
      if (pages.delete(contentsId)) return "window";
      if (!app) return null;
      app = false;
      return "app";
    },
  };
}
