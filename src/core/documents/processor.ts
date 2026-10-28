/**
 * Runs jobs on worker threads, so extracting a large PDF never blocks the
 * core's thread (the Electron main process): processing jobs, and metadata
 * jobs, which only read a Document's creation date. A job reading a PDF's
 * scanned pages (#397) asks for each page's picture to be read, and says how
 * far it is.
 *
 * Jobs are taken from one queue, in order, one at a time. A job that turns out
 * to read scanned pages moves to the scan lane, beside the queue, so the next
 * job starts at once: a text file is never held behind a scan's text
 * recognition (#1502). The lane reads `scansAtOnce` scans at a time; a scan
 * found while it is full stops, waits its turn in the lane, and starts again
 * there. Each running job has a worker of its own, so a job that crashes its
 * worker fails alone.
 */
import type { Worker } from "node:worker_threads";
import type { TextUnit } from "../../shared/units";
import type { LogFields, PagePicture, PictureRead, RecognizedLine } from "../adapters";
import type { DocumentKind } from "../api";
import type {
  KeywordsJob,
  MetadataJob,
  MetadataResult,
  ProcessingJob,
  ProcessingResult,
  WorkerJob,
  WorkerRequest,
  WorkerResponse,
  WorkerResult,
} from "./processing";
import startDocumentWorker from "./worker?nodeWorker";

export interface ProcessorHandlers {
  /** How many scans are read at once (the host works it out with `scansAtOnce`). Default: one. */
  scansAtOnce?: number | undefined;
  /**
   * A processing job is about to go to a worker, from the queue or its turn in the scan lane:
   * returns it as it starts, if that has changed since it was queued (the scanned pages it keeps).
   * `warm`: the worker has read a file of its kind before, so it has nothing to load first (a
   * new worker starts up, and loads PDF.js for its first PDF).
   */
  onStart(job: ProcessingJob, warm: boolean): ProcessingJob | undefined;
  /** A job that reads scanned pages stopped to wait its turn in the scan lane. */
  onWaiting(job: ProcessingJob): void;
  onResult(job: ProcessingJob, result: ProcessingResult): void;
  onMetadata(job: MetadataJob, result: MetadataResult): void;
  /** A keyword job finished, or its worker crashed: the core writes what it got, if anything. */
  onKeywords(job: KeywordsJob, result: WorkerResult): void;
  /**
   * How far a job is in reading the scanned pages of version `contentHash`:
   * `read` of `of`, and the page just read.
   */
  onProgress(
    job: ProcessingJob,
    progress: { contentHash: string; read: number; of: number; unit: TextUnit | null },
  ): void;
  /**
   * Reads a scanned page's picture for a job. Rejects with `unavailable` set
   * when no page can be read now (the model can't be had).
   */
  read(job: ProcessingJob, page: number, picture: PagePicture): Promise<RecognizedLine[]>;
  /** As `read`, for a picture file (`TextRecognizer.readFile`). */
  readFile(job: ProcessingJob, page: number, file: Uint8Array): Promise<PictureRead>;
  /** What a job logs. */
  onLog(job: ProcessingJob, entry: { event: string; fields: LogFields }): void;
  /** Whether an error from `read` means no page can be read now. */
  isUnavailable(error: unknown): boolean;
  /** The password that opens a job's PDF, when it is locked and one is kept (#763). */
  password?(job: WorkerJob): Promise<string | undefined>;
}

export interface Processor {
  /** Queues a job, after those already waiting. */
  enqueue(job: WorkerJob): void;
  /** Whether a Document's processing job is queued, waiting its turn in the scan lane, or under way. */
  has(documentId: string): boolean;
  /**
   * Drops a Document's processing job if it hasn't started. A started one
   * that is reading scanned pages stops before its next page, reporting
   * "stopped"; another still reports its result, as does every metadata job.
   */
  cancel(documentId: string): void;
  /**
   * Holds jobs back, while a Meeting is recorded (#135): those running finish, the rest
   * wait, except a Transcript's, which is the recording itself and small (#136), and a web
   * page's (#128).
   */
  hold(held: boolean): void;
  /** Stops the workers. Jobs not yet finished are dropped without a result. */
  close(): void;
}

const GIB = 2 ** 30;

/**
 * How many scans are read at once: two where the computer has the cores and memory, so one
 * scan's next page is drawn while another's is read, and one elsewhere. The model reads one
 * page at a time either way.
 */
export function scansAtOnce(cores: number, memoryBytes: number): number {
  return cores >= 8 && memoryBytes >= 16 * GIB ? 2 : 1;
}

export function createProcessor(
  handlers: ProcessorHandlers,
  reportError: (error: unknown) => void = (error) => console.error(error),
): Processor {
  const scanSlots = Math.max(1, handlers.scansAtOnce ?? 1);
  const queue: WorkerJob[] = [];
  /**
   * Jobs that read scanned pages, in the order they were found to, waiting for the scan
   * lane. `stopping`: its run is still stopping, and it can't start again until it has.
   */
  const scansWaiting: { job: ProcessingJob; stopping: boolean }[] = [];
  /**
   * Each job under way, by its run's id, with the worker it runs on. `posted`: it has gone
   * to the worker; until then (its PDF's password is being read) a stop is kept in
   * `stopped`. `lane`: "queue" for the one taken from the queue, "scan" in the scan lane,
   * "waiting" for a scan stopping to wait for the lane.
   */
  const running = new Map<number, Run>();
  const idle: WorkerHandle[] = [];
  let nextId = 1;
  let pumpScheduled = false;
  let closed = false;
  let held = false;

  const call = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      reportError(error);
    }
  };

  const inLane = (lane: Run["lane"]) => [...running.values()].filter((run) => run.lane === lane);

  function finish(id: number, result: WorkerResult): void {
    const run = running.get(id);
    if (closed || !run) return;
    running.delete(id);
    const { job } = run;
    if (job.task === "process" && result.outcome === "ready") run.worker.kinds.add(job.kind);
    if (run.worker.alive) rest(run.worker);
    const waiting = scansWaiting.findIndex((each) => each.job === job && each.stopping);
    if (waiting !== -1 && result.outcome === "stopped" && !run.cancelled) {
      const entry = scansWaiting[waiting];
      if (entry) entry.stopping = false;
      if (job.task === "process") call(() => handlers.onWaiting(job));
      schedulePump();
      return;
    }
    // It finished before it stopped, or was cancelled: it ends here.
    if (waiting !== -1) scansWaiting.splice(waiting, 1);
    // The worker answers each job with a result of its kind (see `runJob`); a crash is any's.
    if (job.task === "process") call(() => handlers.onResult(job, result as ProcessingResult));
    else if (job.task === "keywords") call(() => handlers.onKeywords(job, result));
    else call(() => handlers.onMetadata(job, result as MetadataResult));
    schedulePump();
  }

  /** An idle worker is kept for the next job, as many as can run at once. */
  function rest(worker: WorkerHandle): void {
    if (idle.length < 1 + scanSlots) {
      idle.push(worker);
      return;
    }
    worker.alive = false;
    void worker.thread.terminate();
  }

  /** A worker died mid-job (a crash, or out of memory): fail its job; the next starts afresh. */
  function lose(lost: WorkerHandle, message: string): void {
    if (!lost.alive) return;
    lost.alive = false;
    const index = idle.indexOf(lost);
    if (index !== -1) idle.splice(index, 1);
    for (const [id, run] of running) {
      if (run.worker === lost) finish(id, { outcome: "crashed", message });
    }
  }

  /** A job's request to read a page's picture, or a picture file: answered once the model has read it. */
  function read(
    from: WorkerHandle,
    id: number,
    request: number,
    page: number,
    what: { picture: PagePicture } | { file: Uint8Array },
  ) {
    const asked = running.get(id);
    // A scan stopping to wait for the lane reads nothing now: it reads its pages in its turn.
    if (asked?.worker !== from || asked.job.task !== "process" || asked.lane === "waiting") return;
    const answer = (message: WorkerRequest) => {
      if (from.alive && running.get(id) === asked) from.thread.postMessage(message);
    };
    const reading: Promise<Pick<Extract<WorkerRequest, { request: number }>, "lines" | "read">> =
      "picture" in what
        ? handlers.read(asked.job, page, what.picture).then((lines) => ({ lines }))
        : handlers.readFile(asked.job, page, what.file).then((read) => ({ read }));
    reading.then(
      (answered) => answer({ id, request, ...answered }),
      (error: unknown) =>
        answer({
          id,
          request,
          error: {
            message: error instanceof Error ? error.message : String(error),
            unavailable: handlers.isUnavailable(error),
          },
        }),
    );
  }

  /**
   * The job from the queue starts reading scanned pages: it moves to the scan lane if there
   * is room, and stops to wait for it otherwise. Either way the queue's next job can start.
   */
  function foundScan(run: Run): void {
    if (run.job.task !== "process") return;
    // Those found before it go first.
    if (scansWaiting.length === 0 && inLane("scan").length < scanSlots) {
      run.lane = "scan";
    } else {
      run.lane = "waiting";
      scansWaiting.push({ job: run.job, stopping: true });
      stop(run);
    }
    schedulePump();
  }

  function stop(run: Run): void {
    if (run.posted)
      run.worker.thread.postMessage({ id: run.id, stop: true } satisfies WorkerRequest);
    else run.stopped = true;
  }

  function startWorker(): WorkerHandle {
    const thread = startDocumentWorker({ name: "incarnamind-documents" });
    const handle: WorkerHandle = { thread, alive: true, kinds: new Set() };
    thread.on("message", (response: WorkerResponse) => {
      if ("result" in response) {
        finish(response.id, response.result);
        return;
      }
      if ("picture" in response || "file" in response) {
        read(handle, response.id, response.request, response.page, response);
        return;
      }
      const run = running.get(response.id);
      if (run?.worker !== handle || run.job.task !== "process") return;
      const { job } = run;
      if ("log" in response) {
        call(() => handlers.onLog(job, response.log));
        return;
      }
      // Only a PDF's scanned pages go to the lane: a web page's pictures are few, and an
      // Answer may be waiting for them (#128).
      if (run.lane === "queue" && job.kind === "pdf") foundScan(run);
      call(() => handlers.onProgress(job, response.progress));
    });
    thread.on("error", (error) => lose(handle, `Processing stopped: ${error.message}`));
    thread.on("exit", (code) => lose(handle, `Processing stopped (exit code ${code}).`));
    return handle;
  }

  /**
   * The queue's next job: a web page's first, a small snapshot an Answer may be
   * waiting to read (#128), then the first in line; while held, a web page's
   * or the first Transcript's only.
   */
  function take(): WorkerJob | undefined {
    const index = queue.findIndex(
      (job) =>
        job.task === "process" && (job.kind === "web" || (held && job.kind === "transcript")),
    );
    if (index !== -1) return queue.splice(index, 1)[0];
    return held ? undefined : queue.shift();
  }

  function start(queued: WorkerJob, lane: "queue" | "scan"): void {
    const id = nextId++;
    const worker = idle.pop() ?? startWorker();
    const warm = queued.task === "process" && worker.kinds.has(queued.kind);
    const run: Run = {
      id,
      job: queued,
      worker,
      lane,
      posted: false,
      stopped: false,
      cancelled: false,
    };
    running.set(id, run);
    if (queued.task === "process") {
      try {
        run.job = handlers.onStart(queued, warm) ?? queued;
      } catch (error) {
        reportError(error);
      }
    }
    const { job } = run;
    const send = (password: string | undefined) => {
      if (closed || running.get(id) !== run || !run.worker.alive) return;
      // Stopped while its password was read: it never starts.
      if (run.stopped) {
        finish(id, { outcome: "stopped" });
        return;
      }
      run.posted = true;
      run.worker.thread.postMessage({
        id,
        job,
        ...(password !== undefined && { password }),
      } satisfies WorkerRequest);
    };
    if (job.task !== "process" || job.kind !== "pdf" || !handlers.password) {
      send(undefined);
      return;
    }
    handlers.password(job).then(send, (error: unknown) => {
      reportError(error);
      send(undefined);
    });
  }

  function pump(): void {
    pumpScheduled = false;
    if (closed) return;
    if (inLane("queue").length === 0) {
      const job = take();
      if (job) start(job, "queue");
    }
    while (!held && inLane("scan").length < scanSlots) {
      const next = scansWaiting[0];
      if (!next || next.stopping) break;
      scansWaiting.shift();
      start(next.job, "scan");
    }
  }

  // Deferred, so a job enqueued while the core starts up runs after it has returned.
  function schedulePump(): void {
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(pump);
  }

  return {
    enqueue(job) {
      if (closed) return;
      queue.push(job);
      schedulePump();
    },
    has(documentId) {
      const its = (job: WorkerJob) => job.task === "process" && job.documentId === documentId;
      return (
        queue.some(its) ||
        scansWaiting.some((each) => its(each.job)) ||
        [...running.values()].some((run) => its(run.job) && !run.cancelled)
      );
    },
    cancel(documentId) {
      const index = queue.findIndex(
        (job) => job.task === "process" && job.documentId === documentId,
      );
      if (index !== -1) queue.splice(index, 1);
      const waiting = scansWaiting.findIndex(
        (each) => !each.stopping && each.job.documentId === documentId,
      );
      if (waiting !== -1) {
        const [entry] = scansWaiting.splice(waiting, 1);
        // It had started, so it ends as a started job does when stopped.
        if (entry) call(() => handlers.onResult(entry.job, { outcome: "stopped" }));
      }
      for (const run of running.values()) {
        if (run.job.task === "process" && run.job.documentId === documentId) {
          // A scan stopping to wait for the lane ends instead.
          run.cancelled = true;
          stop(run);
        }
      }
    },
    hold(value) {
      held = value;
      if (!held) schedulePump();
    },
    close() {
      closed = true;
      queue.length = 0;
      scansWaiting.length = 0;
      const workers = new Set([...idle, ...[...running.values()].map((run) => run.worker)]);
      running.clear();
      idle.length = 0;
      for (const each of workers) {
        each.alive = false;
        void each.thread.terminate();
      }
    },
  };
}

interface WorkerHandle {
  thread: Worker;
  /** False once it has died: its job is failed, and it takes no other. */
  alive: boolean;
  kinds: Set<DocumentKind>;
}

interface Run {
  id: number;
  job: WorkerJob;
  worker: WorkerHandle;
  lane: "queue" | "scan" | "waiting";
  posted: boolean;
  stopped: boolean;
  /** Cancelled: it ends with its result, even if it was stopping to wait for the scan lane. */
  cancelled: boolean;
}
