/**
 * The analysis window's page (ADR-0023): it runs each job in a Worker of its
 * own, a fresh interpreter that nothing an earlier job did can reach, and
 * ends that Worker once the job is done. One spare Worker is started ahead,
 * while a job runs, so the next job doesn't wait for Python to start. Code a
 * model wrote runs in the Workers and can post to this page, so only a reply
 * to the job a Worker was given, of the shape the Worker writes and within
 * its size, is passed on.
 */
import {
  ANALYSIS_BRIDGE_KEY,
  type AnalysisBridge,
  type AnalysisRequest,
  MAX_REPLY_CHARACTERS,
} from "../../shared/analysisWindow";

const found = (window as unknown as Partial<Record<string, AnalysisBridge>>)[ANALYSIS_BRIDGE_KEY];
if (!found) throw new Error("The analysis window's preload didn't load.");
const bridge: AnalysisBridge = found;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Started = { ok: true; worker: Worker } | { ok: false; message: string };

/** A new Worker, once Python is ready in it; or why it couldn't start. */
function startWorker(): Promise<Started> {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  return new Promise((resolve) => {
    const failed = (message: string) => {
      worker.terminate();
      resolve({ ok: false, message: message.slice(0, 2000) });
    };
    worker.addEventListener(
      "message",
      ({ data }: MessageEvent<unknown>) => {
        if (isRecord(data) && data.kind === "ready") resolve({ ok: true, worker });
        else failed(isRecord(data) ? String(data.message) : "Python couldn't start.");
      },
      { once: true },
    );
    worker.addEventListener("error", (event) => failed(event.message || "Python couldn't start."), {
      once: true,
    });
  });
}

/** Runs one job in `worker`, then ends it, whatever the job did. */
function runIn(worker: Worker, request: AnalysisRequest): void {
  const done = (reply: { result: string } | { failure: string }) => {
    worker.terminate();
    bridge.done({ id: request.id, ...reply });
  };
  worker.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
    if (!isRecord(data) || data.kind !== "done" || data.id !== request.id) return;
    if (typeof data.result === "string" && data.result.length <= MAX_REPLY_CHARACTERS) {
      done({ result: data.result });
    } else if (typeof data.failure === "string") {
      done({ failure: data.failure.slice(0, 2000) });
    } else {
      done({ failure: "The analysis gave back more than it may." });
    }
  });
  worker.addEventListener("error", (event) =>
    done({ failure: event.message || "The analysis worker stopped." }),
  );
  worker.postMessage(request);
  bridge.started(request.id);
}

let spare = startWorker();

void spare.then((started) => bridge.ready(started.ok ? { ok: true } : started));

bridge.onRun(async (request) => {
  const taken = spare;
  spare = startWorker();
  const started = await taken;
  if (started.ok) runIn(started.worker, request);
  else bridge.done({ id: request.id, failure: started.message });
});
