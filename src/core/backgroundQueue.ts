/**
 * The background model queue (docs/designs/library-structure-view.md, R4, R8
 * and O7): background work that calls a model, automatic tagging and
 * Organize's classification, runs here, one job at a time, in the order
 * queued, whatever its kind.
 *
 * Answers come first:
 * - While any Answer is being written, no job starts. Jobs queued meanwhile
 *   wait, and start once none is.
 * - When an Answer starts, a job whose model call is in flight on a model
 *   server on this computer (Ollama, or another local endpoint) is aborted
 *   and queued again at the front. Such a server serves one request at a
 *   time, so the Answer would otherwise wait behind it. A call to a cloud
 *   provider finishes: aborting it would waste paid tokens, for no gain.
 *
 * A Meeting being recorded comes first in the same way (#135): while its
 * audio is captured no job starts, and a local call in flight gives way, so
 * the computer's attention stays on the live capture. Jobs go on once the
 * recording pauses or stops.
 *
 * Tasks come first too (#126): while a Task's step runs, no job starts, and a
 * local call in flight gives way. Tasks themselves give way to Answers and
 * recordings (see ./runs/tasks).
 */

import { outsideFlows } from "./timing/flows";

/** One piece of background work: as a rule, one model call. */
export interface BackgroundJob {
  /** What kind of work it is, e.g. "tagging" or "classification". */
  readonly kind: string;
  /**
   * Does the work. A job that fails is reported, and the queue goes on.
   * When `call.signal` aborts, the job stops without recording a result:
   * the queue is closing, or the job gave way to an Answer and runs again,
   * from the start, later.
   */
  run(call: BackgroundCall): Promise<void>;
}

/** What a job gets for one run. */
export interface BackgroundCall {
  /** Aborts when the queue closes, or when the job gives way to an Answer. */
  readonly signal: AbortSignal;
  /** Whether the job gave way to an Answer: it is queued again, at the front. */
  readonly gaveWay: boolean;
  /**
   * The job says its model call goes to a model server on this computer
   * (see `serviceFor` in ./providers/kinds: no service to send to). From
   * then on, an Answer that starts makes it give way; if one is being
   * written already, it gives way at once. A job that never says so counts
   * as calling a cloud provider, and finishes.
   */
  runsLocally(): void;
}

export interface BackgroundQueue {
  /** Queues a job, after those already waiting. */
  add(job: BackgroundJob): void;
  /**
   * Whether any Answer is being written, each time that changes. While one
   * is, no job starts; when one starts, a local call in flight gives way.
   */
  setAnswering(answering: boolean): void;
  /** Whether a Meeting's audio is being captured, each time that changes: held back in the same way. */
  setRecording(recording: boolean): void;
  /** Whether a Task's step is running, each time that changes: held back in the same way. */
  setTasksRunning(running: boolean): void;
  /** Stops for good: the job in flight is aborted, and those waiting are dropped. */
  close(): void;
}

/** The job in flight. */
interface Running {
  job: BackgroundJob;
  controller: AbortController;
  local: boolean;
  gaveWay: boolean;
}

export function createBackgroundQueue(options: {
  reportError(error: unknown): void;
}): BackgroundQueue {
  const waiting: BackgroundJob[] = [];
  let running: Running | null = null;
  let answering = false;
  let recording = false;
  let tasksRunning = false;
  let closed = false;
  const held = () => answering || recording || tasksRunning;

  const giveWay = (run: Running) => {
    if (run.gaveWay) return;
    run.gaveWay = true;
    run.controller.abort();
  };

  /** Starts the next job, unless one is in flight, an Answer is being written, or none waits. */
  function next(): void {
    if (closed || held() || running) return;
    const job = waiting.shift();
    if (!job) return;
    const run: Running = { job, controller: new AbortController(), local: false, gaveWay: false };
    running = run;
    const call: BackgroundCall = {
      signal: run.controller.signal,
      get gaveWay() {
        return run.gaveWay;
      },
      runsLocally() {
        run.local = true;
        if (held() && running === run) giveWay(run);
      },
    };
    let done: Promise<void>;
    try {
      // A job often starts as an Answer ends, from inside its flow: it isn't that Answer's work.
      done = outsideFlows(() => job.run(call));
    } catch (error) {
      done = Promise.reject(error);
    }
    done
      .catch((error: unknown) => {
        // Giving way, or closing, aborts the job's call: that isn't a failure.
        if (!run.gaveWay && !closed) options.reportError(error);
      })
      .finally(() => {
        running = null;
        if (closed) return;
        if (run.gaveWay) waiting.unshift(job);
        next();
      });
  }

  function changedHold(): void {
    if (held()) {
      if (running?.local) giveWay(running);
    } else {
      // Not from inside the code that ended the Answer or the recording: on a later turn.
      queueMicrotask(next);
    }
  }

  return {
    add(job) {
      if (closed) return;
      waiting.push(job);
      next();
    },

    setAnswering(value) {
      if (closed || value === answering) return;
      answering = value;
      changedHold();
    },

    setRecording(value) {
      if (closed || value === recording) return;
      recording = value;
      changedHold();
    },

    setTasksRunning(value) {
      if (closed || value === tasksRunning) return;
      tasksRunning = value;
      changedHold();
    },

    close() {
      if (closed) return;
      closed = true;
      waiting.length = 0;
      running?.controller.abort();
    },
  };
}
