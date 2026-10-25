/**
 * IncarnaMind's log: `logs/incarnamind.log` in the data folder, for working
 * out what went wrong on the User's computer. No dependencies, no Electron:
 * src/main/logging.ts wires it into the app.
 *
 * The file rotates: once the next entry would take it past `maxBytes` (5 MB),
 * it becomes `incarnamind.1.log`, the one before becomes `incarnamind.2.log`,
 * and the oldest beyond `maxFiles` (3 in all) is removed.
 *
 * What is written is kept from the User's content twice over: the core logs
 * only ids, statuses and kinds, and a failed Answer's message redacted
 * (src/core/activityLog.ts); everything here
 * goes through the crash-report scrubber (./crashScrubber) on its way in.
 * Errors keep their type, the first line of their message with anything
 * quoted and anything like a key or hash removed, and their stack's frames;
 * fields and frames lose file paths (except IncarnaMind's own code, kept as
 * `app:///…`), URLs' queries, e-mail and IP addresses. So the log can be
 * attached to a bug report as it is.
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LogFields, Logger } from "../core";
import type { RendererErrorReport } from "../shared/bridge";
import { isPanelName } from "../shared/panels";
import type { Scrubber } from "./crashScrubber";

/** The log's folder, in the data folder. */
const LOGS_FOLDER = "logs";
export const logsFolder = (dataDir: string) => join(dataDir, LOGS_FOLDER);
export const LOG_FILE = "incarnamind.log";
const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** The current file and the rotated ones. */
const MAX_LOG_FILES = 3;

/** The longest entry written, in characters; longer ones are cut. */
const MAX_ENTRY_LENGTH = 16 * 1024;
/** The most stack frames an error keeps. */
const MAX_FRAMES = 12;
const MAX_FIELD_LENGTH = 200;
const EVENT_NAME = /^[A-Za-z][\w.-]{0,63}$/;
const FIELD_NAME = /^[A-Za-z][\w.-]{0,39}$/;
/** Field values written without quotes. */
const BARE_VALUE = /^[\w.:/@+[\]-]{1,200}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

/** The log's files, newest first: incarnamind.log, incarnamind.1.log, … */
export function logFileNames(maxFiles = MAX_LOG_FILES): string[] {
  return Array.from({ length: maxFiles }, (_, index) =>
    index === 0 ? LOG_FILE : LOG_FILE.replace(/\.log$/, `.${index}.log`),
  );
}

export interface LogFileOptions {
  directory: string;
  maxBytes?: number;
  maxFiles?: number;
  /** Told once when the log can't be written, e.g. the disk is full. Defaults to the console. */
  reportError?: (error: unknown) => void;
}

export interface LogFile {
  readonly directory: string;
  /** Appends an entry, rotating first if it would take the file past its size. Never throws. */
  write(entry: string): void;
}

/** A rotating log file. Writes are synchronous, so an entry written just before a crash is kept. */
export function createLogFile(options: LogFileOptions): LogFile {
  const { directory, maxBytes = MAX_LOG_BYTES, maxFiles = MAX_LOG_FILES } = options;
  const names = logFileNames(maxFiles).map((name) => join(directory, name));
  const current = names[0] as string;
  let size: number | undefined;
  let reported = false;

  const fail = (error: unknown) => {
    if (reported) return;
    reported = true;
    (options.reportError ?? ((cause) => console.error("The log can't be written:", cause)))(error);
  };

  const currentSize = () => {
    try {
      return statSync(current).size;
    } catch {
      return 0;
    }
  };

  const rotate = () => {
    rmSync(names.at(-1) as string, { force: true });
    for (let index = names.length - 1; index > 0; index--) {
      try {
        renameSync(names[index - 1] as string, names[index] as string);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    size = 0;
  };

  return {
    directory,
    write(entry) {
      const text = entry.endsWith("\n") ? entry : `${entry}\n`;
      const bytes = Buffer.byteLength(text);
      try {
        if (size === undefined) {
          mkdirSync(directory, { recursive: true });
          size = currentSize();
        }
        if (size > 0 && size + bytes > maxBytes) rotate();
        appendFileSync(current, text);
        size += bytes;
      } catch (error) {
        size = undefined; // looked at afresh next time
        fail(error);
      }
    },
  };
}

type Level = "info" | "warn" | "error";

export interface FileLoggerOptions {
  file: Pick<LogFile, "write">;
  scrubber: Scrubber;
  /**
   * IncarnaMind's own code (Electron's `app.getAppPath()`): shown in stack
   * frames as `app:///…`, as crash reports show it, rather than removed.
   */
  appPath?: string;
  now?: () => Date;
}

/** The core's `Logger`, plus what the main process logs itself. */
export interface FileLogger extends Logger {
  /**
   * An error: its type, scrubbed message and code, and its stack's frames, then `componentStack`,
   * the components a panel was drawing when it failed.
   */
  exception(
    event: string,
    error: unknown,
    fields?: LogFields,
    level?: Level,
    componentStack?: string,
  ): void;
  /** What was written to the console with `console.error` or `console.warn`. */
  console(level: "warn" | "error", args: readonly unknown[]): void;
}

export function createFileLogger(options: FileLoggerOptions): FileLogger {
  const { file, scrubber } = options;
  const now = options.now ?? (() => new Date());
  const appPrefixes = appPathPrefixes(options.appPath);

  /** Paths into IncarnaMind's own code become app:///…, which the scrubber keeps. */
  const appRelative = (text: string) =>
    appPrefixes.reduce((result, prefix) => result.split(prefix).join("app:///"), text);

  const value = (input: unknown): string | undefined => {
    if (input === undefined) return undefined;
    if (input === null || typeof input === "number" || typeof input === "boolean") {
      return String(input);
    }
    if (typeof input !== "string") return undefined;
    const scrubbed = scrubber.text(input).slice(0, MAX_FIELD_LENGTH);
    return BARE_VALUE.test(scrubbed) ? scrubbed : JSON.stringify(scrubbed);
  };

  const fieldsText = (fields: LogFields | undefined) => {
    let text = "";
    for (const [name, input] of Object.entries(fields ?? {})) {
      if (!FIELD_NAME.test(name)) continue;
      const written = value(input);
      if (written !== undefined) text += ` ${name}=${written}`;
    }
    return text;
  };

  /** An error's summary for the entry's line, and its frames for the lines after it. */
  const describe = (error: unknown): { summary: string; frames: string[] } => {
    if (error instanceof Error) {
      const name = scrubber.text(error.name || "Error").slice(0, 60);
      const message = scrubber.message(error.message);
      const code = (error as NodeJS.ErrnoException).code;
      const frames = (error.stack ?? "")
        .split("\n")
        .filter((line) => /^\s+at /.test(line))
        .slice(0, MAX_FRAMES)
        .map((line) => scrubber.text(appRelative(line.trim())));
      const codeText = typeof code === "string" && ERROR_CODE.test(code) ? ` [${code}]` : "";
      return { summary: `${name}${codeText}: ${message}`, frames };
    }
    if (typeof error === "string") return { summary: scrubber.message(error), frames: [] };
    // Anything else could hold anything: only its type is kept.
    return { summary: `(${error === null ? "null" : typeof error})`, frames: [] };
  };

  const write = (level: Level, event: string, fields?: LogFields, extra = "") => {
    const name = EVENT_NAME.test(event) ? event : "event";
    let entry = `${now().toISOString()} ${level.toUpperCase().padEnd(5)} ${name}${fieldsText(fields)}${extra}`;
    if (entry.length > MAX_ENTRY_LENGTH) entry = `${entry.slice(0, MAX_ENTRY_LENGTH - 1)}…`;
    file.write(entry);
  };

  const exception: FileLogger["exception"] = (
    event,
    error,
    fields,
    level = "error",
    componentStack,
  ) => {
    const { summary, frames } = describe(error);
    const stack = frames.map((frame) => `\n    ${frame}`).join("");
    const components = (componentStack ?? "")
      .split("\n")
      .filter((line) => /^\s+at /.test(line))
      .slice(0, MAX_FRAMES)
      .map((line) => `\n    ${scrubber.text(appRelative(line.trim()))}`)
      .join("");
    const inComponents = components ? `\n    component stack:${components}` : "";
    write(level, event, fields, ` error=${JSON.stringify(summary)}${stack}${inComponents}`);
  };

  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    exception,
    console(level, args) {
      const error = args.find((arg) => arg instanceof Error);
      // The words around an error, e.g. "The update check failed:", are the code's own.
      const words = args
        .filter((arg) => typeof arg === "string")
        .map((arg) => scrubber.message(arg as string))
        .join(" ")
        .slice(0, MAX_FIELD_LENGTH);
      const fields = words ? { message: words } : undefined;
      if (error) exception(`console.${level}`, error, fields, level);
      else write(level, `console.${level}`, fields);
    },
  };
}

/** The forms a path into the app's code takes in stack frames: plain, with either slash, and as a file URL. */
function appPathPrefixes(appPath: string | undefined): string[] {
  const trimmed = appPath?.replace(/[\\/]+$/, "");
  if (!trimmed || trimmed.length < 3) return [];
  const forms = new Set([
    `${pathToFileURL(trimmed).href}/`,
    `${trimmed}/`,
    `${trimmed.replaceAll("\\", "/")}/`,
    `${trimmed}\\`,
  ]);
  // Longest first, so the file URL goes before the plain path inside it.
  return [...forms].sort((a, b) => b.length - a.length);
}

/** The most of a window error's stack that is looked at. */
const MAX_WINDOW_STACK_LENGTH = 8 * 1024;

/**
 * Logs an error nothing caught in the window, as the preload script reports
 * it (a `RendererErrorReport`, unchecked: it comes from another process).
 */
export function logWindowError(logger: Pick<FileLogger, "exception">, report: unknown): void {
  const { kind, name, message, stack, panel, componentStack } = (report ??
    {}) as Partial<RendererErrorReport>;
  const error = new Error(typeof message === "string" ? message : "");
  error.name = typeof name === "string" && name ? name : "Error";
  // Only its frames are kept: the stack's first line repeats the message.
  error.stack = typeof stack === "string" ? stack.slice(0, MAX_WINDOW_STACK_LENGTH) : "";
  if (isPanelName(panel)) {
    // Caught by the boundary of a panel: named, and with the components it was drawing.
    logger.exception(
      "window.panel-failed",
      error,
      { panel, caught: "boundary" },
      "error",
      typeof componentStack === "string" ? componentStack.slice(0, MAX_WINDOW_STACK_LENGTH) : "",
    );
    return;
  }
  logger.exception("window.uncaught", error, {
    kind: kind === "rejection" ? "rejection" : "error",
  });
}

/**
 * Also writes what goes to `console.error` and `console.warn` to the log, as
 * the core and the main process report problems there. Returns a function
 * that puts the console back.
 */
export function logConsole(
  logger: Pick<FileLogger, "console">,
  target: Pick<Console, "error" | "warn"> = console,
): () => void {
  const original = { error: target.error, warn: target.warn };
  let logging = false;
  const wrap =
    (level: "error" | "warn") =>
    (...args: unknown[]) => {
      original[level].apply(target, args);
      if (logging) return; // the log reporting its own trouble
      logging = true;
      try {
        logger.console(level, args);
      } finally {
        logging = false;
      }
    };
  target.error = wrap("error");
  target.warn = wrap("warn");
  return () => {
    target.error = original.error;
    target.warn = original.warn;
  };
}
