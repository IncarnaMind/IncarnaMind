/**
 * The Document-processing worker thread. The core starts it through the
 * `?nodeWorker` import in `./processor`: electron-vite builds it as its own
 * chunk, and the Vitest config does the same for tests.
 *
 * A job runs one at a time. While a PDF's scanned pages are read (#397), the
 * worker draws each page and asks the core to read its picture, which runs
 * the text recognition model, and tells it how far it is; the core can stop
 * the job between pages.
 */
import { parentPort } from "node:worker_threads";
import { ReadingUnavailable } from "./extract";
import { type ReadingChannel, runJob, type WorkerRequest, type WorkerResponse } from "./processing";

const port = parentPort;
if (!port) throw new Error("The Document-processing worker must run as a worker thread.");

const send = (response: WorkerResponse) => {
  // A picture's pixels, or its file, move to the core rather than being copied.
  const transfer =
    "picture" in response
      ? [response.picture.pixels.buffer as ArrayBuffer]
      : "file" in response
        ? [response.file.buffer as ArrayBuffer]
        : [];
  port.postMessage(response, transfer);
};

type Answer = Pick<Extract<WorkerRequest, { request: number }>, "lines" | "read" | "refused">;

/** The jobs under way, by id: their stop signals and the pages waiting to be read. */
const running = new Map<
  number,
  {
    stop: AbortController;
    waiting: Map<number, { resolve(answer: Answer): void; reject(error: Error): void }>;
  }
>();
let nextRequest = 1;

port.on("message", (message: WorkerRequest) => {
  if ("job" in message) {
    const { id } = message;
    const job = { stop: new AbortController(), waiting: new Map() };
    running.set(id, job);
    const channel: ReadingChannel = {
      signal: job.stop.signal,
      progress: (contentHash, read, of, unit) =>
        send({ id, progress: { contentHash, read, of, unit } }),
      head: (head) => send({ id, head }),
      log: (event, fields) => send({ id, log: { event, fields } }),
      read: (page, picture) =>
        new Promise((resolve, reject) => {
          const request = nextRequest++;
          job.waiting.set(request, {
            resolve: (answer: Answer) =>
              answer.lines ? resolve(answer.lines) : reject(new Error("No lines were read.")),
            reject,
          });
          send({ id, request, page, picture });
        }),
      readFile: (page, file) =>
        new Promise((resolve, reject) => {
          const request = nextRequest++;
          job.waiting.set(request, {
            resolve: (answer: Answer) => {
              if (answer.refused) resolve({ refused: answer.refused });
              else if (answer.read) resolve(answer.read);
              else reject(new Error("No lines were read."));
            },
            reject,
          });
          send({ id, request, page, file });
        }),
    };
    void runJob(message.job, channel, message.password).then((result) => {
      running.delete(id);
      send({ id, result });
    });
    return;
  }
  const job = running.get(message.id);
  if (!job) return;
  if ("stop" in message) {
    job.stop.abort();
    for (const waiter of job.waiting.values()) waiter.reject(new Error("Stopped."));
    job.waiting.clear();
    return;
  }
  const waiter = job.waiting.get(message.request);
  job.waiting.delete(message.request);
  if (!waiter) return;
  if (message.lines || message.read || message.refused) waiter.resolve(message);
  else {
    const { message: text = "", unavailable = false } = message.error ?? {};
    waiter.reject(unavailable ? new ReadingUnavailable(text) : new Error(text));
  }
});
