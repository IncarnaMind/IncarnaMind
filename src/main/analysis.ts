/**
 * The core's `AnalysisRuntime` (ADR-0023): Python runs in Pyodide, in module
 * Workers of a hidden page, a fresh one for each job, with a spare kept
 * ready. The page is sandboxed, with no Node, in a session of its own that
 * serves only the page and the bundled Python files, each under a
 * Content-Security-Policy that allows no network, and cancels every other
 * request; permissions, navigation, new windows and downloads are refused, and
 * its storage is cleared after each job. It starts with the first job and
 * closes when idle. A job that runs past its time, is stopped or runs out of
 * memory, or a page that goes, ends the window, and another starts.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  app,
  BaseWindow,
  type CustomScheme,
  type IpcMainEvent,
  ipcMain,
  net,
  type Session,
  session,
  type WebContents,
  WebContentsView,
} from "electron";
import type { AnalysisRuntime, Logger } from "../core";
import { isRecord } from "../core/errors";
import helper from "../renderer/analysis/incarnamind.py?raw";
import {
  ANALYSIS_LIMITS,
  ANALYSIS_TIME_LIMIT_MS,
  type AnalysisEnd,
  type AnalysisJob,
  type AnalysisResult,
  type AnalysisVersions,
  endedBefore,
  noAnalysisOutput,
  readAnalysisEnd,
  readAnalysisOutput,
} from "../shared/analysis";
import {
  ANALYSIS_CHANNELS,
  ANALYSIS_ORIGIN,
  ANALYSIS_SCHEME,
  type AnalysisReady,
  type AnalysisReply,
  type AnalysisRequest,
  MAX_REPLY_CHARACTERS,
  PYTHON_PATH,
} from "../shared/analysisWindow";
import { devServerUrl, pageFile, sandboxOff } from "./analysisPaths";

/** Registered with the app's other privileged schemes, before it is ready (index.ts). */
export const ANALYSIS_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: ANALYSIS_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true },
};

const PARTITION = "analysis";

const CSP = [
  "default-src 'none'",
  // Pyodide compiles its WebAssembly; nothing may evaluate text as code.
  `script-src ${ANALYSIS_SCHEME}: 'wasm-unsafe-eval'`,
  `worker-src ${ANALYSIS_SCHEME}:`,
  `connect-src ${ANALYSIS_SCHEME}:`,
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".zip": "application/zip",
  ".whl": "application/zip",
};

/** Starting Pyodide with numpy and pandas took 3–6 s on the spike's runners; a slow computer gets far longer. */
const START_LIMIT_MS = 120_000;
/** The window and its spare interpreter wait this long for the next job before they close, freeing their memory. */
const IDLE_MS = 5 * 60_000;
/** Past this, a job is ended as out of memory, well before WebAssembly's 4 GB would let Python run out. */
const MEMORY_LIMIT_KB = 2 * 1024 * 1024;
/** WebAssembly memory never shrinks: past this after a job, the window starts again to give it back. */
const RESTART_ABOVE_KB = 1024 * 1024;
const MEMORY_CHECK_MS = 250;

export interface ElectronAnalysisOptions {
  log: Logger;
  /** The dev server's address in development; the built page otherwise. */
  rendererUrl: string | undefined;
  /** Where Pyodide's files and the packages are: `resources/python`, as `npm run build` fills it. */
  folder: string;
}

function versionsIn(folder: string, log: Logger): AnalysisVersions | null {
  try {
    const read: unknown = JSON.parse(readFileSync(join(folder, "packages.json"), "utf8"));
    if (!isRecord(read) || typeof read.pyodide !== "string" || typeof read.python !== "string") {
      throw new Error("packages.json doesn't say which Pyodide and Python it holds.");
    }
    const packages: Record<string, string> = {};
    for (const each of Array.isArray(read.packages) ? read.packages : []) {
      if (isRecord(each) && typeof each.name === "string" && typeof each.version === "string") {
        packages[each.name] = each.version;
      }
    }
    return {
      language: "python",
      languageVersion: read.python,
      runtime: `Pyodide ${read.pyodide}`,
      packages,
      helper: createHash("sha256").update(helper).digest("hex"),
      app: app.getVersion(),
    };
  } catch (error) {
    log.warn("analysis.noFiles", {
      folder,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

const respond = (body: ConstructorParameters<typeof Response>[0], type: string, status = 200) =>
  new Response(body, {
    status,
    headers: {
      "Content-Type": type,
      "Content-Security-Policy": CSP,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

const notFound = () => respond("Not found", "text/plain", 404);

function prepareSession(options: ElectronAnalysisOptions): Session {
  const sandbox = session.fromPartition(PARTITION, { cache: false });
  const page = join(__dirname, "../renderer");
  sandbox.protocol.handle(ANALYSIS_SCHEME, async (request) => {
    const { pathname, search } = new URL(request.url);
    const path = decodeURIComponent(pathname);
    if (path.startsWith(PYTHON_PATH)) {
      const name = path.slice(PYTHON_PATH.length);
      if (!/^[\w.+-]+$/.test(name)) return notFound();
      const file = join(options.folder, name);
      const bytes = await readFile(file).catch(() => null);
      return bytes
        ? respond(bytes, TYPES[extname(name)] ?? "application/octet-stream")
        : notFound();
    }
    if (options.rendererUrl) {
      // Development: the dev server builds the page; the main process fetches it, so the page
      // itself still reaches nothing but this scheme.
      const url = devServerUrl(`${pathname}${search}`, options.rendererUrl);
      if (!url) return notFound();
      const fetched = await net.fetch(url);
      return respond(
        await fetched.arrayBuffer(),
        fetched.headers.get("Content-Type") ?? "text/plain",
        fetched.status,
      );
    }
    const file = pageFile(page, path);
    const bytes = file ? await readFile(file).catch(() => null) : null;
    return bytes ? respond(bytes, TYPES[extname(path)] ?? "application/octet-stream") : notFound();
  });
  sandbox.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(`${ANALYSIS_SCHEME}:`) });
  });
  sandbox.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  sandbox.setPermissionCheckHandler(() => false);
  sandbox.on("will-download", (event) => event.preventDefault());
  return sandbox;
}

interface Sandbox {
  window: BaseWindow;
  contents: WebContents;
  ready: Promise<AnalysisReady>;
  replies: Map<number, (reply: AnalysisReply) => void>;
  /** The job waiting for its interpreter to take it. */
  starts: Map<number, () => void>;
  /** Resolves with why the page went: "closed" when it was ended here. */
  gone: Promise<string>;
  end(reason: string): void;
}

type Outcome =
  | { kind: "reply"; reply: AnalysisReply }
  | { kind: "timed-out" }
  | { kind: "stopped" }
  | { kind: "memory" }
  | { kind: "no-start" }
  | { kind: "gone"; reason: string };

function resultOf(text: string, ms: number): AnalysisResult {
  let read: unknown = null;
  try {
    read = JSON.parse(text);
  } catch {
    read = null;
  }
  const end = isRecord(read) ? readAnalysisEnd(read.end) : null;
  if (!end || !isRecord(read)) {
    return {
      end: {
        kind: "error",
        message: "The analysis gave back something that isn't a result.",
        line: null,
      },
      output: noAnalysisOutput(),
      ms,
    };
  }
  return { end, output: readAnalysisOutput(read.output), ms };
}

export function createElectronAnalysisRuntime(options: ElectronAnalysisOptions): AnalysisRuntime {
  const { log } = options;
  const versions = versionsIn(options.folder, log);
  let analysisSession: Session | null = null;
  let current: Sandbox | null = null;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let nextId = 0;
  let listening = false;

  const sandboxOf = (event: IpcMainEvent) =>
    current && event.sender === current.contents ? current : null;

  const listen = () => {
    if (listening) return;
    listening = true;
    ipcMain.on(ANALYSIS_CHANNELS.done, (event, reply: unknown) => {
      const sandbox = sandboxOf(event);
      if (!sandbox || !isRecord(reply) || typeof reply.id !== "number") return;
      const { id } = reply;
      const answer = sandbox.replies.get(id);
      if (!answer) return;
      if (typeof reply.result === "string" && reply.result.length <= MAX_REPLY_CHARACTERS) {
        answer({ id, result: reply.result });
      } else {
        answer({ id, failure: typeof reply.failure === "string" ? reply.failure : "No result." });
      }
    });
    ipcMain.on(ANALYSIS_CHANNELS.started, (event, id: unknown) => {
      if (typeof id === "number") sandboxOf(event)?.starts.get(id)?.();
    });
  };

  /** Clears what the window's pages could keep: IndexedDB, the file system and the rest. */
  const clearStorage = () => analysisSession?.clearStorageData() ?? Promise.resolve();

  const open = (): Sandbox => {
    listen();
    analysisSession ??= prepareSession(options);
    const window = new BaseWindow({ show: false, width: 320, height: 240 });
    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, "../preload/analysis.js"),
        session: analysisSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        devTools: !app.isPackaged,
        backgroundThrottling: false,
        spellcheck: false,
        disableDialogs: true,
      },
    });
    window.contentView.addChildView(view);
    const contents = view.webContents;
    contents.setAudioMuted(true);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-redirect", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("will-frame-navigate", (event) => {
      if (!event.url.startsWith(`${ANALYSIS_ORIGIN}/`)) event.preventDefault();
    });

    let markGone: (reason: string) => void = () => {};
    const gone = new Promise<string>((resolve) => {
      markGone = resolve;
    });
    contents.on("render-process-gone", (_event, details) => markGone(details.reason));

    const started = performance.now();
    const ready = new Promise<AnalysisReady>((resolve) => {
      const timer = setTimeout(
        () => resolve({ ok: false, message: "Python didn't start in time." }),
        START_LIMIT_MS,
      );
      const onReady = (event: IpcMainEvent, state: unknown) => {
        if (event.sender !== contents) return;
        clearTimeout(timer);
        ipcMain.off(ANALYSIS_CHANNELS.ready, onReady);
        resolve(
          isRecord(state) && state.ok === true
            ? { ok: true }
            : {
                ok: false,
                message: isRecord(state) ? String(state.message) : "Python couldn't start.",
              },
        );
      };
      ipcMain.on(ANALYSIS_CHANNELS.ready, onReady);
      void gone.then((reason) => {
        clearTimeout(timer);
        ipcMain.off(ANALYSIS_CHANNELS.ready, onReady);
        resolve({ ok: false, message: `The analysis window went (${reason}).` });
      });
      contents.once("did-fail-load", (_event, code, description) => {
        resolve({ ok: false, message: `The analysis page didn't load (${code}): ${description}` });
      });
    }).then((state) => {
      if (state.ok) log.info("analysis.started", { ms: Math.round(performance.now() - started) });
      else log.error("analysis.startFailed", { message: state.message });
      return state;
    });
    // A new window starts with nothing an earlier one left.
    void clearStorage()
      .then(() => contents.loadURL(`${ANALYSIS_ORIGIN}/analysis.html`))
      .catch((error: unknown) => {
        log.error("analysis.pageFailed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return {
      window,
      contents,
      ready,
      replies: new Map(),
      starts: new Map(),
      gone,
      end(reason) {
        markGone(reason);
        if (!contents.isDestroyed()) contents.close();
        if (!window.isDestroyed()) window.destroy();
      },
    };
  };

  /** Ends the window, and starts another at once when `again`, so the next job finds it warm. */
  const endWindow = (again: boolean) => {
    current?.end("closed");
    current = again ? open() : null;
  };

  const closeWhenIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => endWindow(false), IDLE_MS);
  };

  const memoryOf = (contents: WebContents): number | null => {
    if (contents.isDestroyed()) return null;
    const pid = contents.getOSProcessId();
    return app.getAppMetrics().find((each) => each.pid === pid)?.memory.workingSetSize ?? null;
  };

  /** Sends a job, and waits for its end: its time runs from when its fresh interpreter takes it. */
  const wait = (
    sandbox: Sandbox,
    request: AnalysisRequest,
    limitMs: number,
    signal: AbortSignal,
  ): Promise<{ outcome: Outcome; ms: number }> =>
    new Promise((resolve) => {
      let started: number | null = null;
      const done = (outcome: Outcome) => {
        clearTimeout(timer);
        clearInterval(memory);
        signal.removeEventListener("abort", stop);
        sandbox.replies.delete(request.id);
        sandbox.starts.delete(request.id);
        resolve({ outcome, ms: started === null ? 0 : Math.round(performance.now() - started) });
      };
      const stop = () => done({ kind: "stopped" });
      let timer = setTimeout(() => done({ kind: "no-start" }), START_LIMIT_MS);
      sandbox.starts.set(request.id, () => {
        started = performance.now();
        clearTimeout(timer);
        timer = setTimeout(() => done({ kind: "timed-out" }), limitMs);
      });
      const memory = setInterval(() => {
        if ((memoryOf(sandbox.contents) ?? 0) > MEMORY_LIMIT_KB) done({ kind: "memory" });
      }, MEMORY_CHECK_MS);
      signal.addEventListener("abort", stop, { once: true });
      sandbox.replies.set(request.id, (reply) => done({ kind: "reply", reply }));
      void sandbox.gone.then((reason) => done({ kind: "gone", reason }));
      sandbox.contents.send(ANALYSIS_CHANNELS.run, request);
    });

  const runOne = async (job: AnalysisJob, signal: AbortSignal): Promise<AnalysisResult> => {
    if (!versions) {
      return endedBefore({
        kind: "unavailable",
        reason: "missing",
        detail: `No Python files in ${options.folder}.`,
      });
    }
    // With Chromium's sandbox off for every renderer, nothing would keep the code from this computer.
    if (sandboxOff((name) => app.commandLine.hasSwitch(name), process.env)) {
      return endedBefore({
        kind: "unavailable",
        reason: "no-sandbox",
        detail: "Electron runs with its sandbox off (--no-sandbox or ELECTRON_DISABLE_SANDBOX).",
      });
    }
    if (signal.aborted) return endedBefore({ kind: "stopped" });
    clearTimeout(idle);
    current ??= open();
    const sandbox = current;
    const ready = await Promise.race([
      sandbox.ready,
      new Promise<null>((resolve) => {
        if (signal.aborted) resolve(null);
        signal.addEventListener("abort", () => resolve(null), { once: true });
      }),
    ]);
    if (ready === null) {
      closeWhenIdle();
      return endedBefore({ kind: "stopped" });
    }
    if (!ready.ok) {
      if (current === sandbox) endWindow(false);
      return endedBefore({ kind: "unavailable", reason: "start", detail: ready.message });
    }

    const limitMs = job.timeLimitMs ?? ANALYSIS_TIME_LIMIT_MS;
    const request: AnalysisRequest = {
      id: ++nextId,
      job: JSON.stringify({ code: job.code, inputs: job.inputs, limits: ANALYSIS_LIMITS }),
    };
    const { outcome, ms } = await wait(sandbox, request, limitMs, signal);
    let result: AnalysisResult;
    let again = false;
    if (outcome.kind === "reply") {
      if ("result" in outcome.reply) {
        result = resultOf(outcome.reply.result, ms);
        again =
          result.end.kind === "out-of-memory" ||
          (memoryOf(sandbox.contents) ?? 0) > RESTART_ABOVE_KB;
      } else {
        log.error("analysis.failed", { message: outcome.reply.failure });
        result = { end: { kind: "crashed" }, output: noAnalysisOutput(), ms };
        again = true;
      }
    } else {
      const ends: Record<Exclude<Outcome["kind"], "reply">, AnalysisEnd> = {
        "timed-out": { kind: "timed-out", limitMs },
        stopped: { kind: "stopped" },
        memory: { kind: "out-of-memory" },
        "no-start": { kind: "crashed" },
        gone:
          outcome.kind === "gone" && outcome.reason === "oom"
            ? { kind: "out-of-memory" }
            : outcome.kind === "gone" && outcome.reason === "closed"
              ? { kind: "stopped" }
              : { kind: "crashed" },
      };
      result = { ...endedBefore(ends[outcome.kind]), ms };
      if (outcome.kind === "no-start") log.error("analysis.noStart", { limitMs: START_LIMIT_MS });
      if (outcome.kind === "gone" && outcome.reason !== "closed") {
        log.error("analysis.windowGone", { reason: outcome.reason });
      }
      again = outcome.kind !== "gone" || outcome.reason !== "closed";
    }
    log.info("analysis.ran", { ms, end: result.end.kind });
    if (again && current === sandbox) endWindow(true);
    await clearStorage();
    closeWhenIdle();
    return result;
  };

  return {
    languages: versions ? [versions] : [],
    run(job, signal) {
      const result = queue.then(() => runOne(job, signal));
      queue = result.catch(() => undefined);
      return result.catch((error: unknown) =>
        endedBefore({
          kind: "unavailable",
          reason: "start",
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    },
    close() {
      clearTimeout(idle);
      endWindow(false);
    },
  };
}
