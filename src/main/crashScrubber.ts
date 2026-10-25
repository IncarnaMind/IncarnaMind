/**
 * Scrubs crash reports before they leave this computer.
 *
 * A report keeps only what helps fix a bug: the error's type and a cleaned-up
 * message, where in IncarnaMind's code it happened, app lifecycle breadcrumbs,
 * the app and Electron versions, and the operating system. It is rebuilt from
 * an allowlist, so anything else is dropped, including fields a newer SDK adds:
 * the user and their IP address, the computer's name, request data, extra
 * data, local variables, source lines, logs and attachments (screenshots,
 * minidumps).
 *
 * Text that is kept loses:
 * - file paths: the home folder, the data folder and any other absolute path
 *   or file URL, which name the User and their Documents;
 * - URLs' credentials, queries and fragments;
 * - e-mail and IP addresses;
 * - in messages, anything quoted and anything that looks like a key or a hash:
 *   errors quote the text they fail on, which may be Document text, Mind
 *   content, a Question or an Answer. Only a message's first line is kept,
 *   and only so much of it.
 *
 * Breadcrumbs that can carry the User's content (console output, clicks and
 * keypresses, requests) are dropped.
 */
import type {
  Breadcrumb,
  ErrorEvent,
  EventHint,
  Exception,
  StackFrame,
  Stacktrace,
  Thread,
} from "@sentry/electron/main";
import { redactMessage } from "../core/redact";

export { MAX_MESSAGE_LENGTH, REDACTED } from "../core/redact";
export const PATH = "[path]";
export const EMAIL = "[email]";
export const IP_ADDRESS = "[ip]";

export interface ScrubPaths {
  /** The User's home folder, e.g. /Users/alice: paths in it name the User. */
  homeDir: string;
  /** IncarnaMind's data folder: the database, Documents, Skills and logs. */
  dataDir: string;
  /** Other folders to remove wherever they appear, e.g. the temp folder. */
  others?: readonly string[];
}

export interface Scrubber {
  /** A copy of the event holding only what is allowed, scrubbed. Drops the hint's attachments. */
  event(event: ErrorEvent, hint?: EventHint): ErrorEvent;
  /** A scrubbed copy of a breadcrumb that can't carry the User's content, otherwise null. */
  breadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null;
  /** Removes paths, URLs' queries, e-mail and IP addresses from structured text. */
  text(value: string): string;
  /** `text`, then removes quoted text, keys and hashes, keeping the first line, shortened. */
  message(value: string): string;
}

/** Characters that end a path in free text. Spaces don't: folder names have them. */
const PATH_END = '\\n"`<>|';
const PATH_REST = `[^${PATH_END}]*`;

const FILE_URL = /\bfile:\/\/[^\s"'`<>|]*/giu;
const WINDOWS_PATH = new RegExp(String.raw`(?<![\p{L}\p{N}])[A-Za-z]:[\\/]${PATH_REST}`, "gu");
const UNC_PATH = new RegExp(String.raw`\\\\[^\s\\/]+[\\/]${PATH_REST}`, "gu");
const HOME_PATH = new RegExp(String.raw`(?<![\p{L}\p{N}_])~[\\/]${PATH_REST}`, "gu");
/** A slash starting a token: not "and/or", "1/2", a URL's "//" or the path after its host. */
const POSIX_PATH = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.:/\\\-~\])])\/(?=[^\s/])${PATH_REST}`,
  "gu",
);
const URL_PATTERN =
  /\b([a-z][a-z0-9+.-]*):\/\/([^\s/?#"'`<>|]*)([^\s?#"'`<>|]*)([?#][^\s"'`<>|]*)?/giu;
const EMAIL_PATTERN = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
const OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
const IPV4 = new RegExp(String.raw`(?<![\d.])(?:${OCTET}\.){3}${OCTET}(?![\d.])`, "g");
const HEX_GROUP = "[0-9A-Fa-f]{1,4}";
const IPV6 = new RegExp(
  String.raw`(?<![\w:])(?:(?:${HEX_GROUP}:){7}${HEX_GROUP}|(?:${HEX_GROUP}(?::${HEX_GROUP})*)?::(?:${HEX_GROUP}(?::${HEX_GROUP})*)?)(?![\w:])`,
  "g",
);

/** Sentry's message for a child process that exited abnormally: the process type and reason are Electron's. */
const PROCESS_EXITED = /^'([^'\n]{1,40})' process exited with '([a-z-]{1,40})'$/;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Marks that open a quoted path, and the marks that close them. */
const CLOSING_MARK: Readonly<Record<string, string>> = {
  "'": "'",
  "‘": "’",
  "“": "”",
  "「": "」",
  "(": ")",
  "[": "]",
};
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * Replaces a path, which runs to the end of the line because folder names
 * have spaces. A path that opens with a quote mark ends at its last closing
 * mark instead (not an apostrophe, as in "Bob's"), so the rest of the line stays.
 */
function replacePath(match: string, offset: number, whole: string): string {
  const closing = CLOSING_MARK[whole[offset - 1] ?? ""];
  if (closing) {
    for (let index = match.length - 1; index > 0; index--) {
      const next = match[index + 1];
      if (match[index] === closing && (next === undefined || !LETTER_OR_DIGIT.test(next))) {
        return PATH + match.slice(index);
      }
    }
  }
  return PATH;
}

/** Matches a known folder, written with either slash or as a file URL would, and the rest of its path. */
function knownFolders(paths: ScrubPaths): RegExp | null {
  const variants = new Set<string>();
  for (const folder of [paths.dataDir, paths.homeDir, ...(paths.others ?? [])]) {
    const trimmed = folder.replace(/[\\/]+$/, "");
    // "/" or "C:" alone would match everything.
    if (trimmed.length < 3) continue;
    for (const form of [trimmed, trimmed.replaceAll("\\", "/"), trimmed.replaceAll("/", "\\")]) {
      variants.add(form);
      variants.add(encodeURI(form));
    }
  }
  if (variants.size === 0) return null;
  const alternatives = [...variants].sort((a, b) => b.length - a.length).map(escapeRegExp);
  return new RegExp(`(?:${alternatives.join("|")})${PATH_REST}`, "giu");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Copies only the keys whose values aren't undefined. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, each]) => each !== undefined)) as T;
}

/** Context fields kept, by context. Everything else (culture, cloud, GPU, screen, memory…) is dropped. */
const CONTEXT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  os: ["name", "version", "build", "kernel_version", "type"],
  runtime: ["name", "version", "type"],
  app: ["app_name", "app_version", "app_build", "app_arch", "build_type", "type"],
  device: ["arch", "family", "processor_count", "memory_size", "type"],
  browser: ["name", "version", "type"],
  chrome: ["name", "version", "type"],
  node: ["name", "version", "type"],
};

/** Breadcrumb categories kept, and their data fields. Others (console, ui, http…) can carry content. */
const BREADCRUMB_DATA: Readonly<Record<string, readonly string[]>> = {
  // App and window lifecycle: "app.will-quit", "browser-window.focus"…
  electron: ["id"],
  // Electron child processes that exited: their type and why.
  "child-process": ["type", "reason", "exitCode", "serviceName"],
};

const TAG_KEY = /^[\w.-]{1,32}$/;
const MAX_FIELD_LENGTH = 200;

export function createScrubber(paths: ScrubPaths): Scrubber {
  const folders = knownFolders(paths);

  /** Keeps a URL's scheme, host and path. Credentials, the query and the fragment may carry anything. */
  const normaliseUrl = (_match: string, scheme: string, authority: string, path: string) =>
    `${scheme}://${authority.slice(authority.lastIndexOf("@") + 1)}${path}`;

  const text = (value: string): string => {
    let result = value.replace(FILE_URL, PATH);
    if (folders) result = result.replace(folders, replacePath);
    result = result
      .replace(URL_PATTERN, normaliseUrl)
      .replace(WINDOWS_PATH, replacePath)
      .replace(UNC_PATH, replacePath)
      .replace(HOME_PATH, replacePath)
      .replace(POSIX_PATH, replacePath)
      .replace(EMAIL_PATTERN, EMAIL)
      .replace(IPV4, IP_ADDRESS)
      .replace(IPV6, IP_ADDRESS);
    return result;
  };

  const message = (value: string): string => {
    const exited = PROCESS_EXITED.exec(value);
    if (exited) return `'${text(exited[1] ?? "")}' process exited with '${exited[2]}'`;
    return redactMessage(text(value.split(/\r?\n/, 1)[0] ?? ""));
  };

  /** A short structured value: scrubbed text, a number or a boolean. Anything else goes. */
  const field = (value: unknown): string | number | boolean | undefined => {
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value !== "string") return undefined;
    const scrubbed = text(value);
    return scrubbed.length > MAX_FIELD_LENGTH ? scrubbed.slice(0, MAX_FIELD_LENGTH) : scrubbed;
  };

  const optional = <T>(value: T | undefined, scrub: (value: T) => T) =>
    value === undefined ? undefined : scrub(value);

  // A frame's file: IncarnaMind's own code is app-relative by now (app:///out/main/index.js)
  // and kept, as are Node's and Electron's (node:internal/…); other paths go.
  const frame = (input: StackFrame): StackFrame =>
    defined({
      filename: optional(input.filename, text),
      abs_path: optional(input.abs_path, text),
      module: optional(input.module, text),
      function: optional(input.function, text),
      platform: input.platform,
      lineno: input.lineno,
      colno: input.colno,
      in_app: input.in_app,
      instruction_addr: input.instruction_addr,
      addr_mode: input.addr_mode,
      debug_id: input.debug_id,
      // Not kept: vars (local variables), context_line, pre_context and post_context (source lines).
    });

  const stacktrace = (input: Stacktrace): Stacktrace =>
    defined({
      frames: input.frames?.map(frame),
      frames_omitted: input.frames_omitted,
    });

  const exception = (input: Exception): Exception =>
    defined({
      type: optional(input.type, text),
      value: optional(input.value, message),
      module: optional(input.module, text),
      thread_id: input.thread_id,
      // The mechanism's `data` may hold anything; only how the error was caught is kept.
      mechanism: input.mechanism
        ? defined({
            type: input.mechanism.type,
            handled: input.mechanism.handled,
            synthetic: input.mechanism.synthetic,
            source: input.mechanism.source,
            is_exception_group: input.mechanism.is_exception_group,
            exception_id: input.mechanism.exception_id,
            parent_id: input.mechanism.parent_id,
          })
        : undefined,
      stacktrace: optional(input.stacktrace, stacktrace),
    });

  const thread = (input: Thread): Thread =>
    defined({
      id: input.id,
      name: optional(input.name, text),
      main: input.main,
      crashed: input.crashed,
      current: input.current,
      stacktrace: optional(input.stacktrace, stacktrace),
    });

  const contexts = (input: unknown): ErrorEvent["contexts"] => {
    if (!isRecord(input)) return undefined;
    const kept: Record<string, Record<string, string | number | boolean>> = {};
    for (const [name, keys] of Object.entries(CONTEXT_FIELDS)) {
      const context = input[name];
      if (!isRecord(context)) continue;
      const values: Record<string, string | number | boolean> = {};
      for (const key of keys) {
        const value = field(context[key]);
        if (value !== undefined) values[key] = value;
      }
      if (Object.keys(values).length > 0) kept[name] = values;
    }
    return Object.keys(kept).length > 0 ? kept : undefined;
  };

  const tags = (input: unknown): ErrorEvent["tags"] => {
    if (!isRecord(input)) return undefined;
    const kept: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(input)) {
      if (!TAG_KEY.test(key)) continue;
      const scrubbed = field(value);
      if (scrubbed !== undefined) kept[key] = scrubbed;
    }
    return Object.keys(kept).length > 0 ? kept : undefined;
  };

  const debugMeta = (input: unknown): ErrorEvent["debug_meta"] => {
    if (!isRecord(input) || !Array.isArray(input.images)) return undefined;
    const images = input.images.filter(isRecord).map((image) =>
      defined({
        type: field(image.type),
        debug_id: field(image.debug_id),
        code_id: field(image.code_id),
        code_file: field(image.code_file),
        debug_file: field(image.debug_file),
        arch: field(image.arch),
        image_addr: field(image.image_addr),
        image_size: field(image.image_size),
        image_vmaddr: field(image.image_vmaddr),
      }),
    );
    return { images } as ErrorEvent["debug_meta"];
  };

  const breadcrumb = (input: Breadcrumb): Breadcrumb | null => {
    const allowed = input.category === undefined ? undefined : BREADCRUMB_DATA[input.category];
    if (!allowed) return null;
    let data: Record<string, string | number | boolean> | undefined;
    if (isRecord(input.data)) {
      data = {};
      for (const key of allowed) {
        const value = field(input.data[key]);
        if (value !== undefined) data[key] = value;
      }
    }
    return defined({
      type: input.type,
      category: input.category,
      level: input.level,
      timestamp: input.timestamp,
      message: optional(input.message, message),
      data: data && Object.keys(data).length > 0 ? data : undefined,
    });
  };

  const event = (input: ErrorEvent, hint?: EventHint): ErrorEvent => {
    // Screenshots, minidumps and any other file attached to the event: never sent.
    if (hint) hint.attachments = [];
    return defined({
      type: undefined,
      event_id: input.event_id,
      timestamp: input.timestamp,
      platform: input.platform,
      level: input.level,
      logger: optional(input.logger, text),
      release: input.release,
      dist: input.dist,
      environment: input.environment,
      sdk: input.sdk,
      message: optional(input.message, message),
      logentry: input.logentry?.message ? { message: message(input.logentry.message) } : undefined,
      exception: input.exception?.values
        ? { values: input.exception.values.map(exception) }
        : undefined,
      threads: input.threads?.values ? { values: input.threads.values.map(thread) } : undefined,
      breadcrumbs: input.breadcrumbs
        ?.map(breadcrumb)
        .filter((each): each is Breadcrumb => each !== null),
      contexts: contexts(input.contexts),
      tags: tags(input.tags),
      fingerprint: input.fingerprint?.map(message),
      debug_meta: debugMeta(input.debug_meta),
      // Not kept: user (and its IP address), server_name, request, extra, modules,
      // transaction, spans, measurements and the SDK's internal processing metadata.
    }) as ErrorEvent;
  };

  return { event, breadcrumb, text, message };
}
