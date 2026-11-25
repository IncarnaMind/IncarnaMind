/**
 * `CitationStyleEngine` (ADR-0016): the one way the core formats citations, as `RunEngine`
 * is for the agent loop. Today it is Hayagriva in wasm on a worker thread; if Hayagriva stops
 * being maintained, hand-written styles can sit behind the same interface.
 */
import type { Worker } from "node:worker_threads";
import { closeWorkerThread } from "../workerClose";
import type { FormatJob } from "./format";
import type { EngineStyle, WorkerRequest, WorkerResponse } from "./protocol";
import startCitationWorker from "./styleWorker?nodeWorker";
import type { EngineOutput, StyleDescription } from "./wasm";

export interface Formatted {
  description: StyleDescription;
  output: EngineOutput;
}

export interface CitationStyleEngine {
  /** Formats with a style of the pack. */
  format(style: EngineStyle, job: FormatJob): Promise<Formatted>;
  /** Stops it; requests not yet answered fail. */
  close(): void;
}

/** A style or request the engine couldn't format, said plainly in English for logs and tooltips. */
export class CitationFormatError extends Error {
  readonly styleProblem: boolean;

  constructor(message: string, styleProblem: boolean) {
    super(message);
    this.name = "CitationFormatError";
    this.styleProblem = styleProblem;
  }
}

/**
 * The engine on its own thread, started on the first request and again after a crash, with
 * the engine and the pack of styles and locales read from `folder` (resources/citation-styles).
 */
export function createWorkerEngine(folder: string): CitationStyleEngine {
  let worker: Worker | undefined;
  let nextId = 1;
  let closed = false;
  const pending = new Map<
    number,
    { resolve(value: Formatted): void; reject(error: Error): void }
  >();

  /** The thread stopped: what it was asked fails, and the next request starts another. */
  const lose = (lost: Worker, message: string) => {
    if (worker !== lost) return;
    worker = undefined;
    for (const each of pending.values()) each.reject(new CitationFormatError(message, false));
    pending.clear();
  };

  const start = (): Worker => {
    const started = startCitationWorker({
      name: "incarnamind-citation-styles",
      workerData: { folder },
    });
    started.on("message", (response: WorkerResponse) => {
      const waiting = pending.get(response.id);
      if (!waiting) return;
      pending.delete(response.id);
      if (response.ok) {
        waiting.resolve({ description: response.description, output: response.output });
      } else {
        waiting.reject(new CitationFormatError(response.message, response.style));
      }
    });
    started.on("error", (error) => lose(started, `Formatting stopped: ${error.message}`));
    started.on("exit", (code) => lose(started, `Formatting stopped (exit code ${code}).`));
    // Formatting never keeps the app from quitting.
    started.unref();
    return started;
  };

  return {
    format(style, job) {
      if (closed) return Promise.reject(new CitationFormatError("The core is closed.", false));
      const id = nextId++;
      return new Promise<Formatted>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker ??= start();
        worker.postMessage({ id, style, job } satisfies WorkerRequest);
      });
    },
    close() {
      closed = true;
      const stopping = worker;
      worker = undefined;
      for (const each of pending.values()) {
        each.reject(new CitationFormatError("The core is closed.", false));
      }
      pending.clear();
      if (stopping) closeWorkerThread(stopping);
    },
  };
}
