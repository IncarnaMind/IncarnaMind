/**
 * Tasks (CONTEXT.md, #126): Runs that go on in the background and keep their
 * place when IncarnaMind is quit, force-quit or crashes. Each kind of Task
 * (`TaskKind`: a comparison table's fill, today) does its steps through a
 * `TaskRun`, which journals them (./journal):
 *
 * - A step is recorded as started before it runs and as completed after.
 *   A step without an Effect that a crash interrupted is simply done again:
 *   it changed nothing outside IncarnaMind's database.
 * - A step with an Effect (a file written, a change through a Connector) is
 *   journalled with what it will do. Before a Task goes on after a crash, a
 *   pause or a quit, each such step left open is checked (./effects): done,
 *   it counts as completed; not done, it runs again; when IncarnaMind can't
 *   tell, it asks the User ("unknown-outcome") and waits.
 * - A call that asks first (`approvals`) is the same approval an Answer's is.
 *   The ask is kept in the Task's row, so a Task that was waiting when
 *   IncarnaMind closed comes back paused, "Needs you", and asks again.
 * - At start, Tasks a quit or a crash left running go on; those waiting for
 *   the User are paused with the ask.
 * - Tasks come below Answers and recordings, and above tagging: no step
 *   starts while an Answer is written or a Meeting recorded, and a step on a
 *   model on this computer gives way to them; background jobs wait while a
 *   step runs (`turn`).
 * - An unfinished Task keeps the versions of Documents it reads (#79), and
 *   releases them when it is done.
 * - A Task waiting for the User, or finished, says so in a system
 *   notification when its Mind isn't on screen.
 */

import { randomUUID } from "node:crypto";
import type {
  Money,
  Task,
  TaskAction,
  TaskAsk,
  TaskAskAnswer,
  TaskEffect,
  TaskPausedReason,
  TaskProgress,
  TaskSources,
  TaskStep,
} from "../api";
import type { RetainVersion, VersionRetention } from "../documents/retention";
import { InvalidInputError, isRecord, NotFoundError } from "../errors";
import type { Database } from "../storage";
import { currentTask } from "./current";
import { verifyEffect } from "./effects";
import {
  createJournal,
  isStep,
  RECORD_PREFIX,
  type StepRecord,
  type StoredAsk,
  type TaskApprovalCall,
  type TaskRecord,
} from "./journal";

/** How long a finished Task stays in the list (Recent). */
export const RECENT_TASK_DAYS = 7;

/** How a kind's run ended, when nothing else (a pause, a stop, a quit) ended it. */
export type TaskEnd =
  | { status: "done" }
  /** It can't go on: its table or its Mind is gone. */
  | { status: "stopped" }
  | {
      status: "paused";
      reason: Exclude<TaskPausedReason, "user" | "closed">;
      resetsAt?: string | null;
    }
  | { status: "failed"; problem: string };

/** A turn to run a step: it aborts when the step must give way. */
export interface TaskTurn {
  readonly signal: AbortSignal;
  /** The step is over: background jobs may go on. */
  end(): void;
}

/** What a kind's run does its work through. */
export interface TaskRun {
  readonly id: string;
  readonly mindId: string | null;
  readonly input: unknown;
  /** When it was started (ISO 8601): what it made since is its own. */
  readonly startedAt: string;
  /** Aborts when the Task is paused or stopped, or IncarnaMind closes: start no more steps. */
  readonly signal: AbortSignal;
  /** Records a step without an Effect as started. */
  started(key: string): void;
  /** Records how a step without an Effect ended. */
  settled(key: string, status: "completed" | "failed", result?: unknown): void;
  /** A step as the journal has it. */
  step(key: string): StepRecord | null;
  /**
   * Does a step with an Effect once: journalled before and after. A step
   * completed before (this run or one before a quit) isn't done again; false
   * if the User chose to skip it. Pausing doesn't interrupt `perform`.
   */
  effect(key: string, effect: TaskEffect, perform: () => Promise<void>): Promise<boolean>;
  /** Asks the User about a call, once: the answer is journalled, and the ask outlasts a quit. */
  approve(key: string, call: TaskApprovalCall): Promise<boolean>;
  progress(progress: TaskProgress): void;
  /**
   * Waits until no Answer is being written and no Meeting recorded, then
   * gives a turn. `local`: the step's model runs on this computer, so it
   * gives way (its turn aborts) when an Answer or a recording starts.
   */
  turn(local: boolean): Promise<TaskTurn>;
  /** The versions of Documents it reads (#79): kept until it finishes. */
  retain(versions: readonly RetainVersion[]): void;
  /** What the User told it since it last looked (Tell it…), now read: at the start of a step. */
  takeMessages(): string[];
  /** Everything the User told it that it has read, oldest first. */
  messages(): string[];
}

export interface TaskKind {
  readonly kind: string;
  /** Runs the Task from where its journal is: the first time, or again after a pause or a quit. */
  run(task: TaskRun): Promise<TaskEnd>;
  /** The Block in the Task's Mind it works on, from its input. */
  blockOf?(input: unknown): string | null;
  /** What the User asked it, in their words, from its input. */
  questionOf?(input: unknown): string | null;
  /** Where Review opens, when its work went somewhere other than its own place. */
  reviewOf?(task: { id: string; mindId: string | null; input: unknown }): Task["review"];
  /** Paused at a limit, the steps it has still to do, in its own words. */
  remainingOf?(task: { id: string; mindId: string | null; input: unknown }): string[];
  /** Done, what it did in a few words. */
  summaryOf?(task: { id: string; mindId: string | null; input: unknown }): string | null;
  /** Where its saved sources went, from the kind's existing journal result. */
  sourcesOf?(task: { id: string; mindId: string | null; input: unknown }): TaskSources | null;
  /** What the User can ask of it from its progress (#657). Absent: Pause and Stop. */
  readonly actions?: readonly TaskAction[];
  /** What its steps do, in its own words, by key; a step it can't name shows its key. */
  describeSteps?(
    task: { id: string; mindId: string | null; input: unknown },
    keys: readonly string[],
  ): string[];
}

/** The steps a Task's progress shows at rest; the rest are a click away (`listTaskSteps`). */
export const LATEST_STEPS = 4;

/** A message the User told a Task, as its journal keeps it: a record, not a step. */
const MESSAGE_PREFIX = `${RECORD_PREFIX}message:`;
/** The longest message a Task takes, in characters. */
export const MAX_MESSAGE = 2_000;

const DEFAULT_ACTIONS: readonly TaskAction[] = ["pause", "stop"];

const STEP_STATUS: Record<StepRecord["status"], TaskStep["status"]> = {
  started: "running",
  completed: "done",
  failed: "failed",
  skipped: "skipped",
};

/** A Task's notification, as the host shows it. */
export interface TaskNotice {
  task: Task;
  /** It waits for the User, or it finished (done or failed). */
  what: "needs-you" | "finished";
}

export interface TasksOptions {
  db: Database;
  now: () => string;
  kinds: readonly TaskKind[];
  approvals: {
    /** Whether a call runs without asking, by the User's policy for it (see ../approvals). */
    decide(call: TaskApprovalCall): "run" | "ask";
    request(
      call: TaskApprovalCall & { answerId: string; taskId: string; toolCallId: string },
      signal: AbortSignal,
    ): Promise<boolean>;
  };
  retention: Pick<VersionRetention, "retain" | "release">;
  cost(taskId: string): Money | null;
  changed(task: Task): void;
  notify(notice: TaskNotice): void;
  /** Whether a Task's step is running, each time that changes: background jobs wait meanwhile. */
  stepsRunning(running: boolean): void;
  reportError(error: unknown): void;
}

/** A Task whose kind's run is going. */
interface Live {
  controller: AbortController;
  /** Why it is being ended, once it is: it is then left as that says. */
  ending: "pause" | "stop" | "close" | null;
  done: Promise<void>;
}

interface Turn {
  local: boolean;
  controller: AbortController;
}

const abortError = () => new DOMException("The Task stopped.", "AbortError");

export type Tasks = ReturnType<typeof createTasks>;

export function createTasks(options: TasksOptions) {
  const journal = createJournal(options.db, options.now);
  const kinds = new Map(options.kinds.map((kind) => [kind.kind, kind]));
  const live = new Map<string, Live>();
  /** Paused Tasks asking again after a quit, by id: aborting withdraws the ask. */
  const asking = new Map<string, AbortController>();
  const turns = new Set<Turn>();
  let waiters: (() => void)[] = [];
  let answering = false;
  let recording = false;
  let closed = false;
  const held = () => answering || recording;

  /** Steps as the thread shows them, in their kind's words. */
  const stepsOf = (record: TaskRecord, steps: readonly StepRecord[]): TaskStep[] => {
    const texts = describe(
      record,
      steps.map((step) => step.key),
    );
    return steps.map((step, index) => ({
      key: step.key,
      text: texts[index] ?? step.key,
      status: STEP_STATUS[step.status],
    }));
  };

  const describe = (record: TaskRecord, keys: readonly string[]): readonly string[] => {
    const kind = kinds.get(record.kind);
    if (!kind?.describeSteps || keys.length === 0) return keys;
    try {
      return kind.describeSteps(
        { id: record.id, mindId: record.mindId, input: record.input },
        keys,
      );
    } catch (error) {
      options.reportError(error);
      return keys;
    }
  };

  const reviewOf = (record: TaskRecord): Task["review"] => {
    const kind = kinds.get(record.kind);
    if (!kind?.reviewOf || record.status !== "done") return null;
    try {
      return kind.reviewOf({ id: record.id, mindId: record.mindId, input: record.input });
    } catch (error) {
      options.reportError(error);
      return null;
    }
  };

  /** What a kind says of a Task, or its fallback when it says nothing or fails to. */
  const kindSays = <T>(
    record: TaskRecord,
    say: ((task: { id: string; mindId: string | null; input: unknown }) => T) | undefined,
    fallback: T,
  ): T => {
    if (!say) return fallback;
    try {
      return say({ id: record.id, mindId: record.mindId, input: record.input });
    } catch (error) {
      options.reportError(error);
      return fallback;
    }
  };

  /** The messages the User told a Task, as kept in its journal. */
  const messagesOf = (taskId: string) =>
    journal
      .steps(taskId)
      .filter((step) => step.key.startsWith(MESSAGE_PREFIX))
      .map((step) => ({
        id: step.key.slice(MESSAGE_PREFIX.length),
        status: step.status,
        text: isRecord(step.result) && typeof step.result.text === "string" ? step.result.text : "",
      }));

  const view = (record: TaskRecord): Task => {
    const latest = journal.latestSteps(record.id, LATEST_STEPS);
    const ask: TaskAsk | null =
      record.ask?.kind === "approval"
        ? { kind: "approval", stepKey: record.ask.stepKey, number: record.ask.number }
        : record.ask;
    return {
      id: record.id,
      kind: record.kind,
      mindId: record.mindId,
      blockId: kinds.get(record.kind)?.blockOf?.(record.input) ?? null,
      question: kinds.get(record.kind)?.questionOf?.(record.input) ?? null,
      review: reviewOf(record),
      status: record.status,
      pausedReason: record.status === "paused" ? record.pausedReason : null,
      resetsAt: record.resetsAt,
      ask,
      progress: record.progress,
      problem: record.problem,
      cost: options.cost(record.id),
      actions: [...(kinds.get(record.kind)?.actions ?? DEFAULT_ACTIONS)],
      steps: stepsOf(record, latest.steps),
      stepCount: latest.count,
      queued:
        record.finishedAt === null
          ? messagesOf(record.id)
              .filter((message) => message.status === "started")
              .map(({ id, text }) => ({ id, text }))
          : [],
      remaining:
        record.status === "paused" &&
        (record.pausedReason === "cost-cap" || record.pausedReason === "plan-limit")
          ? kindSays(record, kinds.get(record.kind)?.remainingOf, [])
          : [],
      summary:
        record.status === "done" ? kindSays(record, kinds.get(record.kind)?.summaryOf, null) : null,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      updatedAt: record.updatedAt,
    };
  };

  const announce = (record: TaskRecord | null) => {
    if (record && !closed) options.changed(view(record));
  };

  const update = (taskId: string, patch: Parameters<typeof journal.update>[1]) => {
    const record = journal.update(taskId, patch);
    announce(record);
    return record;
  };

  const notify = (record: TaskRecord | null, what: TaskNotice["what"]) => {
    if (!record || closed) return;
    try {
      options.notify({ task: view(record), what });
    } catch (error) {
      options.reportError(error);
    }
  };

  const release = (taskId: string) => {
    try {
      options.retention.release("task", taskId);
    } catch (error) {
      options.reportError(error);
    }
  };

  const finish = (taskId: string, status: "done" | "stopped" | "failed", problem?: string) => {
    const record = update(taskId, {
      status,
      pausedReason: null,
      ask: null,
      problem: problem ?? null,
      finishedAt: options.now(),
    });
    release(taskId);
    return record;
  };

  const releaseWaiters = () => {
    const ready = waiters;
    waiters = [];
    for (const resolve of ready) resolve();
  };

  const holdChanged = () => {
    if (held()) {
      for (const turn of turns) if (turn.local) turn.controller.abort();
    } else {
      releaseWaiters();
    }
  };

  const takeTurn = async (local: boolean, signal: AbortSignal): Promise<TaskTurn> => {
    while (held()) {
      if (signal.aborted) throw abortError();
      await new Promise<void>((resolve) => {
        const done = () => {
          signal.removeEventListener("abort", done);
          resolve();
        };
        waiters.push(done);
        signal.addEventListener("abort", done, { once: true });
      });
    }
    if (signal.aborted) throw abortError();
    const turn: Turn = { local, controller: new AbortController() };
    turns.add(turn);
    if (turns.size === 1) options.stepsRunning(true);
    let ended = false;
    return {
      signal: turn.controller.signal,
      end() {
        if (ended) return;
        ended = true;
        turns.delete(turn);
        if (turns.size === 0 && !closed) options.stepsRunning(false);
      },
    };
  };

  /** The next ask's number, counted in the Task's row. */
  const nextAsk = (taskId: string) => (journal.get(taskId)?.asks ?? 0) + 1;

  /**
   * Checks each Effect a crash, a pause or a quit left open. Returns the
   * first whose outcome can't be told, after settling those before it.
   */
  async function checkOpenEffects(taskId: string): Promise<StepRecord | null> {
    for (const step of journal.openEffects(taskId)) {
      if (!step.effect) continue;
      let verdict: Awaited<ReturnType<typeof verifyEffect>>;
      try {
        verdict = await verifyEffect(step.effect);
      } catch (error) {
        options.reportError(error);
        verdict = "unknown";
      }
      if (verdict === "unknown") return step;
      journal.settled(taskId, step.key, verdict === "done" ? "completed" : "failed", {
        checked: verdict,
      });
    }
    return null;
  }

  function context(record: TaskRecord, signal: AbortSignal): TaskRun {
    const taskId = record.id;
    return {
      id: taskId,
      mindId: record.mindId,
      input: record.input,
      startedAt: record.startedAt,
      signal,
      started: (key) => {
        journal.started(taskId, key, null);
        announce(journal.get(taskId));
      },
      settled: (key, status, result) => {
        journal.settled(taskId, key, status, result ?? null);
        announce(journal.get(taskId));
      },
      step: (key) => journal.step(taskId, key),
      async effect(key, effect, perform) {
        const known = journal.step(taskId, key);
        if (known?.status === "completed") return true;
        if (known?.status === "skipped") return false;
        journal.started(taskId, key, effect);
        announce(journal.get(taskId));
        try {
          await perform();
        } catch (error) {
          journal.settled(taskId, key, "failed", { message: String(error) });
          throw error;
        }
        journal.settled(taskId, key, "completed");
        announce(journal.get(taskId));
        return true;
      },
      async approve(key, call) {
        const known = journal.step(taskId, key);
        if (known?.status === "completed") {
          const result = known.result as { allowed?: unknown } | null;
          return result?.allowed === true;
        }
        if (signal.aborted) throw abortError();
        journal.started(taskId, key, null);
        if (options.approvals.decide(call) === "run") {
          journal.settled(taskId, key, "completed", { allowed: true });
          return true;
        }
        const number = nextAsk(taskId);
        notify(
          update(taskId, { ask: { kind: "approval", stepKey: key, number, call }, asks: number }),
          "needs-you",
        );
        const allowed = await options.approvals.request(
          { ...call, answerId: taskId, taskId, toolCallId: key },
          signal,
        );
        journal.settled(taskId, key, "completed", { allowed });
        update(taskId, { ask: null });
        return allowed;
      },
      progress: (progress) => {
        update(taskId, { progress });
      },
      turn: (local) => takeTurn(local, signal),
      retain: (versions) => options.retention.retain("task", taskId, versions),
      takeMessages() {
        const fresh = messagesOf(taskId).filter((message) => message.status === "started");
        for (const message of fresh) {
          journal.settled(taskId, MESSAGE_PREFIX + message.id, "completed", { text: message.text });
        }
        if (fresh.length > 0) announce(journal.get(taskId));
        return fresh.map((message) => message.text);
      },
      messages: () =>
        messagesOf(taskId)
          .filter((message) => message.status === "completed")
          .map((message) => message.text),
    };
  }

  /** Asks the User about an Effect it can't check, and leaves the Task waiting for the answer. */
  function askUnknown(record: TaskRecord, step: StepRecord, reason: "closed" | "user") {
    if (!step.effect) return;
    const number = nextAsk(record.id);
    notify(
      update(record.id, {
        status: "paused",
        pausedReason: reason,
        ask: { kind: "unknown-outcome", stepKey: step.key, number, effect: step.effect },
        asks: number,
      }),
      "needs-you",
    );
  }

  /** Runs a Task's kind from where its journal is. */
  function launch(record: TaskRecord, reason: "closed" | "user"): void {
    const kind = kinds.get(record.kind);
    if (!kind || live.has(record.id) || closed) return;
    const controller = new AbortController();
    const entry: Live = { controller, ending: null, done: Promise.resolve() };
    live.set(record.id, entry);
    if (record.status === "running") announce(record);
    else update(record.id, { status: "running", pausedReason: null, resetsAt: null });
    entry.done = (async () => {
      let end: TaskEnd | "asked";
      try {
        const unknown = await checkOpenEffects(record.id);
        if (unknown) {
          askUnknown(record, unknown, reason);
          end = "asked";
        } else {
          const current = journal.get(record.id) ?? record;
          end = await currentTask.run(record.id, () =>
            kind.run(context(current, controller.signal)),
          );
        }
      } catch (error) {
        if (!controller.signal.aborted) options.reportError(error);
        end = controller.signal.aborted
          ? { status: "stopped" }
          : { status: "failed", problem: "unknown" };
      } finally {
        live.delete(record.id);
      }
      settle(record.id, entry, end);
    })();
  }

  /** Leaves a Task as its run ended it. */
  function settle(taskId: string, entry: Live, end: TaskEnd | "asked"): void {
    if (entry.ending === "close" || closed) return;
    if (entry.ending === "stop") {
      finish(taskId, "stopped");
      return;
    }
    if (entry.ending === "pause") {
      // What it asked is asked again when it goes on.
      update(taskId, { status: "paused", pausedReason: "user", ask: null });
      return;
    }
    if (end === "asked") return;
    switch (end.status) {
      case "done":
        notify(finish(taskId, "done"), "finished");
        return;
      case "stopped":
        finish(taskId, "stopped");
        return;
      case "failed":
        notify(finish(taskId, "failed", end.problem), "finished");
        return;
      case "paused":
        notify(
          update(taskId, {
            status: "paused",
            pausedReason: end.reason,
            resetsAt: end.resetsAt ?? null,
            ask: null,
          }),
          "needs-you",
        );
        return;
    }
  }

  /**
   * Runs a Task again from its journal, once its run that is ending (it has
   * just asked, or is pausing) has ended.
   */
  function goOn(taskId: string): void {
    const again = () => {
      const record = journal.get(taskId);
      if (record && record.finishedAt === null && record.ask === null) launch(record, "user");
    };
    const ending = live.get(taskId);
    if (ending) void ending.done.then(again);
    else again();
  }

  /** A paused Task waiting on an approval after a quit asks again; answered, it goes on. */
  function askAgain(record: TaskRecord, ask: Extract<StoredAsk, { kind: "approval" }>): void {
    if (asking.has(record.id) || closed) return;
    const answered = (allowed: boolean) => {
      journal.settled(record.id, ask.stepKey, "completed", { allowed });
      journal.update(record.id, { ask: null });
      goOn(record.id);
    };
    // The User may have allowed it always meanwhile, from another call of the same Tool.
    if (options.approvals.decide(ask.call) === "run") {
      answered(true);
      return;
    }
    const controller = new AbortController();
    asking.set(record.id, controller);
    options.approvals
      .request(
        { ...ask.call, answerId: record.id, taskId: record.id, toolCallId: ask.stepKey },
        controller.signal,
      )
      .then(
        (allowed) => {
          asking.delete(record.id);
          if (!closed) answered(allowed);
        },
        () => {
          asking.delete(record.id);
        },
      );
  }

  const requireTask = (taskId: unknown): TaskRecord => {
    if (typeof taskId !== "string" || taskId === "") {
      throw new InvalidInputError("A Task's id must be a non-empty string.");
    }
    const record = journal.get(taskId);
    if (!record) throw new NotFoundError("That Task doesn't exist.");
    return record;
  };

  const current = (taskId: string) => view(journal.get(taskId) as TaskRecord);

  return {
    /** Starts a Task of a kind: it runs at once, below Answers. */
    start(kind: string, mindId: string | null, input: unknown): Task {
      if (!kinds.has(kind)) throw new InvalidInputError(`No Task runs as ${kind}.`);
      if (closed) throw new InvalidInputError("IncarnaMind is closing.");
      const record = journal.create({ kind, mindId, input });
      launch(record, "user");
      return view(record);
    },

    /** A Task as its journal keeps it, finished or not; null for none. */
    record: (taskId: string): TaskRecord | null => journal.get(taskId),

    /**
     * Changes what an unfinished Task works on, so the run going and any
     * resume after a quit reconstruct from the new input.
     */
    updateInput(taskId: string, input: unknown): void {
      const record = requireTask(taskId);
      if (record.finishedAt !== null) return;
      journal.update(record.id, { input });
    },

    /** Unfinished Tasks, oldest first, as records (for a kind to find its own). */
    unfinished: (): TaskRecord[] => journal.unfinished(),

    /** Whether a Task's kind's run is going. */
    isLive: (taskId: string) => live.has(taskId),

    /** Unfinished Tasks, most recent first, then those finished in the last 7 days. */
    list(): Task[] {
      const since = new Date(
        new Date(options.now()).getTime() - RECENT_TASK_DAYS * 86_400_000,
      ).toISOString();
      return [...journal.unfinished().reverse(), ...journal.finishedSince(since)].map(view);
    },

    get(taskId: unknown): Task {
      return view(requireTask(taskId));
    },

    /** The journal's steps of a Task, in the order they first started. */
    steps(taskId: string): StepRecord[] {
      return journal.steps(taskId);
    },

    /** Every step of a Task as its progress shows them. */
    listSteps(taskId: unknown): TaskStep[] {
      const record = requireTask(taskId);
      return stepsOf(
        record,
        journal.steps(record.id).filter((step) => isStep(step.key)),
      );
    },

    /** The journal's saved sources, approval outcomes and read steering, for a finished Task (#147). */
    recordDetails(taskId: unknown) {
      const record = requireTask(taskId);
      return {
        sources: kindSays(record, kinds.get(record.kind)?.sourcesOf, null),
        approvals: journal.steps(record.id).flatMap((step) => {
          if (!step.key.startsWith(`${RECORD_PREFIX}approve:`)) return [];
          return isRecord(step.result) && typeof step.result.allowed === "boolean"
            ? [{ key: step.key, allowed: step.result.allowed }]
            : [];
        }),
        messages: messagesOf(record.id)
          .filter((message) => message.status === "completed")
          .map((message) => message.text),
      };
    },

    /** Tell it…: a message for a running Task whose kind reads them, until its next step. */
    tell(taskId: unknown, text: unknown): Task {
      const record = requireTask(taskId);
      if (!kinds.get(record.kind)?.actions?.includes("tell") || record.finishedAt !== null) {
        throw new InvalidInputError({ key: "error.task.tell" });
      }
      const said = typeof text === "string" ? text.trim() : "";
      if (said === "" || said.length > MAX_MESSAGE) {
        throw new InvalidInputError({ key: "error.task.message", values: { max: MAX_MESSAGE } });
      }
      journal.keep(record.id, MESSAGE_PREFIX + randomUUID(), { text: said });
      announce(journal.get(record.id));
      return current(record.id);
    },

    /** Takes back a message its Task hasn't read yet. */
    untell(taskId: unknown, messageId: unknown): Task {
      const record = requireTask(taskId);
      const message = messagesOf(record.id).find((each) => each.id === messageId);
      if (message?.status === "started") {
        journal.settled(record.id, MESSAGE_PREFIX + message.id, "skipped", { text: message.text });
        announce(journal.get(record.id));
      }
      return current(record.id);
    },

    async pause(taskId: unknown): Promise<Task> {
      const record = requireTask(taskId);
      const entry = live.get(record.id);
      if (entry && !entry.ending) {
        entry.ending = "pause";
        entry.controller.abort();
        await entry.done;
      }
      return current(record.id);
    },

    async resume(taskId: unknown): Promise<Task> {
      const record = requireTask(taskId);
      if (record.status === "paused" && record.ask === null) goOn(record.id);
      return current(record.id);
    },

    async stop(taskId: unknown): Promise<Task> {
      const record = requireTask(taskId);
      const entry = live.get(record.id);
      if (entry) {
        if (!entry.ending || entry.ending === "pause") {
          entry.ending = "stop";
          entry.controller.abort();
        }
        await entry.done;
        return current(record.id);
      }
      asking.get(record.id)?.abort();
      if (record.finishedAt === null) finish(record.id, "stopped");
      return current(record.id);
    },

    async answer(taskId: unknown, answer: unknown): Promise<Task> {
      const record = requireTask(taskId);
      if (answer !== "redo" && answer !== "skip") {
        throw new InvalidInputError('An answer must be "redo" or "skip".');
      }
      const ask = record.ask;
      if (ask?.kind !== "unknown-outcome") return current(record.id);
      journal.settled(
        record.id,
        ask.stepKey,
        (answer as TaskAskAnswer) === "skip" ? "skipped" : "failed",
        { answered: answer },
      );
      journal.update(record.id, { ask: null });
      goOn(record.id);
      return current(record.id);
    },

    /**
     * At start, before anything else runs: Tasks a quit or a crash left
     * running go on, and those that were waiting for the User are paused
     * with what they asked, which is asked again.
     */
    settleOrphans(): void {
      for (const record of journal.unfinished()) {
        if (!kinds.has(record.kind)) continue;
        if (record.status === "running" && record.ask === null) {
          launch(record, "closed");
          continue;
        }
        const ask = record.ask;
        if (record.status === "running") {
          const paused = update(record.id, { status: "paused", pausedReason: "closed" });
          notify(paused, "needs-you");
        }
        if (ask?.kind === "approval") askAgain(journal.get(record.id) ?? record, ask);
      }
    },

    /** Whether an Answer (not a Task's) is being written: steps wait, and local ones give way. */
    setAnswering(value: boolean): void {
      if (value === answering) return;
      answering = value;
      holdChanged();
    },

    /** Whether a Meeting's audio is being captured: held back in the same way. */
    setRecording(value: boolean): void {
      if (value === recording) return;
      recording = value;
      holdChanged();
    },

    /**
     * IncarnaMind is closing: every Task stops where it is, its row left as it
     * was, so it goes on at the next start. What it waits for is withdrawn
     * without an answer.
     */
    close(): void {
      if (closed) return;
      for (const entry of live.values()) {
        entry.ending = "close";
        entry.controller.abort();
      }
      for (const controller of asking.values()) controller.abort();
      closed = true;
      releaseWaiters();
    },
  };
}
