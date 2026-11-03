/**
 * The Task journal (#126, migration 81): each Task's row in `runs` and its
 * steps in `run_steps`, in SQLite with `synchronous=FULL`, so what is
 * written here is on disk before the step it records goes on. Every write is
 * its own transaction: a force-quit leaves the journal as the last write did.
 */
import { randomUUID } from "node:crypto";
import type {
  ApprovalRequest,
  TaskEffect,
  TaskPausedReason,
  TaskProgress,
  TaskStatus,
} from "../api";
import { isRecord } from "../errors";
import type { Database, SqlValue } from "../storage";

/** A Task's call that asks first, as it is asked again after a quit. */
export type TaskApprovalCall = ApprovalRequest extends infer Request
  ? Request extends ApprovalRequest
    ? Omit<Request, "requestId" | "answerId" | "taskId" | "toolCallId">
    : never
  : never;

/** What a Task waits for the User to answer, as stored: an approval keeps its call. */
export type StoredAsk =
  | { kind: "approval"; stepKey: string; number: number; call: TaskApprovalCall }
  | { kind: "unknown-outcome"; stepKey: string; number: number; effect: TaskEffect };

export interface TaskRecord {
  id: string;
  kind: string;
  mindId: string | null;
  input: unknown;
  status: TaskStatus;
  pausedReason: TaskPausedReason | null;
  resetsAt: string | null;
  ask: StoredAsk | null;
  asks: number;
  progress: TaskProgress | null;
  problem: string | null;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
}

export type StepStatus = "started" | "completed" | "failed" | "skipped";

/**
 * A key that starts with this is a record a kind keeps in its journal (what
 * it made, to find again after a quit), not a step: progress doesn't show it.
 */
export const RECORD_PREFIX = "~";

export const isStep = (key: string) => !key.startsWith(RECORD_PREFIX);

export interface StepRecord {
  key: string;
  effect: TaskEffect | null;
  status: StepStatus;
  result: unknown;
  attempts: number;
}

interface RunRow {
  id: string;
  kind: string;
  mind_id: string | null;
  input: string;
  status: string;
  paused_reason: string | null;
  resets_at: string | null;
  ask: string | null;
  asks: number;
  progress: string | null;
  problem: string | null;
  started_at: string;
  finished_at: string | null;
  updated_at: string;
}

interface StepRow {
  key: string;
  effect: string | null;
  status: string;
  result: string | null;
  attempts: number;
}

const RUN_COLUMNS = `id, kind, mind_id, input, status, paused_reason, resets_at, ask, asks,
  progress, problem, started_at, finished_at, updated_at`;

const STATUSES: readonly TaskStatus[] = ["running", "paused", "done", "stopped", "failed"];
const REASONS: readonly TaskPausedReason[] = [
  "user",
  "closed",
  "cost-cap",
  "plan-limit",
  "not-ready",
];
const STEP_STATUSES: readonly StepStatus[] = ["started", "completed", "failed", "skipped"];

function parse(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function effectOf(value: unknown): TaskEffect | null {
  if (!isRecord(value)) return null;
  if (
    value.kind === "file-write" &&
    typeof value.path === "string" &&
    typeof value.sha256 === "string"
  ) {
    const previous = typeof value.previous === "string" ? value.previous : null;
    return { kind: "file-write", path: value.path, sha256: value.sha256, previous };
  }
  if (
    value.kind === "connector" &&
    typeof value.connectorId === "string" &&
    typeof value.connectorName === "string" &&
    typeof value.tool === "string"
  ) {
    return {
      kind: "connector",
      connectorId: value.connectorId,
      connectorName: value.connectorName,
      tool: value.tool,
    };
  }
  return null;
}

function askOf(value: unknown): StoredAsk | null {
  if (!isRecord(value) || typeof value.stepKey !== "string") return null;
  const number = typeof value.number === "number" ? value.number : 1;
  if (value.kind === "approval" && isRecord(value.call)) {
    return {
      kind: "approval",
      stepKey: value.stepKey,
      number,
      call: value.call as TaskApprovalCall,
    };
  }
  const effect = effectOf(value.effect);
  if (value.kind === "unknown-outcome" && effect) {
    return { kind: "unknown-outcome", stepKey: value.stepKey, number, effect };
  }
  return null;
}

function progressOf(value: unknown): TaskProgress | null {
  return isRecord(value) && typeof value.done === "number" && typeof value.total === "number"
    ? { done: value.done, total: value.total }
    : null;
}

const toRecord = (row: RunRow): TaskRecord => ({
  id: row.id,
  kind: row.kind,
  mindId: row.mind_id,
  input: parse(row.input),
  status: STATUSES.find((each) => each === row.status) ?? "failed",
  pausedReason: REASONS.find((each) => each === row.paused_reason) ?? null,
  resetsAt: row.resets_at,
  ask: askOf(parse(row.ask)),
  asks: row.asks,
  progress: progressOf(parse(row.progress)),
  problem: row.problem,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  updatedAt: row.updated_at,
});

const toStep = (row: StepRow): StepRecord => ({
  key: row.key,
  effect: effectOf(parse(row.effect)),
  status: STEP_STATUSES.find((each) => each === row.status) ?? "failed",
  result: parse(row.result),
  attempts: row.attempts,
});

/** What a Task's row is changed to; left out, it stays. */
export interface TaskPatch {
  /** What it works on, as its kind reads it; a resumed run reconstructs from this. */
  input?: unknown;
  status?: TaskStatus;
  pausedReason?: TaskPausedReason | null;
  resetsAt?: string | null;
  ask?: StoredAsk | null;
  asks?: number;
  progress?: TaskProgress | null;
  problem?: string | null;
  finishedAt?: string | null;
}

// Each column a patch writes, and whether it stores JSON whatever the value's shape.
const PATCH_COLUMNS: Record<keyof TaskPatch, { column: string; json?: true }> = {
  input: { column: "input", json: true },
  status: { column: "status" },
  pausedReason: { column: "paused_reason" },
  resetsAt: { column: "resets_at" },
  ask: { column: "ask" },
  asks: { column: "asks" },
  progress: { column: "progress" },
  problem: { column: "problem" },
  finishedAt: { column: "finished_at" },
};

export type Journal = ReturnType<typeof createJournal>;

export function createJournal(db: Database, now: () => string) {
  const get = (taskId: string): TaskRecord | null => {
    const row = db.get<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE id = ? AND deleted_at IS NULL`,
      [taskId],
    );
    return row ? toRecord(row) : null;
  };

  const step = (taskId: string, key: string): StepRecord | null => {
    const row = db.get<StepRow>(
      `SELECT key, effect, status, result, attempts FROM run_steps
       WHERE run_id = ? AND key = ? AND deleted_at IS NULL`,
      [taskId, key],
    );
    return row ? toStep(row) : null;
  };

  return {
    get,

    create(input: { kind: string; mindId: string | null; input: unknown }): TaskRecord {
      const id = randomUUID();
      const at = now();
      db.run(
        `INSERT INTO runs (id, kind, mind_id, input, status, started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
        [id, input.kind, input.mindId, JSON.stringify(input.input ?? {}), at, at, at],
      );
      return get(id) as TaskRecord;
    },

    /** Tasks not finished, oldest first. */
    unfinished(): TaskRecord[] {
      return db
        .all<RunRow>(
          `SELECT ${RUN_COLUMNS} FROM runs
           WHERE deleted_at IS NULL AND finished_at IS NULL ORDER BY started_at, rowid`,
        )
        .map(toRecord);
    },

    /** Tasks finished since `since`, most recent first. */
    finishedSince(since: string): TaskRecord[] {
      return db
        .all<RunRow>(
          `SELECT ${RUN_COLUMNS} FROM runs
           WHERE deleted_at IS NULL AND finished_at IS NOT NULL AND finished_at >= ?
           ORDER BY finished_at DESC, rowid DESC`,
          [since],
        )
        .map(toRecord);
    },

    update(taskId: string, patch: TaskPatch): TaskRecord | null {
      const entries = (Object.keys(patch) as (keyof TaskPatch)[]).filter(
        (key) => patch[key] !== undefined,
      );
      if (entries.length === 0) return get(taskId);
      const values = entries.map((key): SqlValue => {
        const value = patch[key];
        // A JSON column keeps create's contract: whatever its shape, it is stored as JSON,
        // and null is the empty input create writes.
        if (PATCH_COLUMNS[key].json) return JSON.stringify(value ?? {});
        if (value === null || value === undefined) return null;
        if (typeof value === "object") return JSON.stringify(value);
        if (typeof value === "string" || typeof value === "number") return value;
        return JSON.stringify(value);
      });
      db.run(
        `UPDATE runs SET ${entries.map((key) => `${PATCH_COLUMNS[key].column} = ?`).join(", ")},
           updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
        [...values, now(), taskId],
      );
      return get(taskId);
    },

    step,

    steps(taskId: string): StepRecord[] {
      return db
        .all<StepRow>(
          `SELECT key, effect, status, result, attempts FROM run_steps
           WHERE run_id = ? AND deleted_at IS NULL ORDER BY started_at, rowid`,
          [taskId],
        )
        .map(toStep);
    },

    /** A Task's latest steps, oldest first, and how many it has: its kind's records left out. */
    latestSteps(taskId: string, limit: number): { steps: StepRecord[]; count: number } {
      const steps = db
        .all<StepRow>(
          `SELECT key, effect, status, result, attempts FROM run_steps
           WHERE run_id = ? AND deleted_at IS NULL AND substr(key, 1, 1) <> ?
           ORDER BY started_at DESC, rowid DESC LIMIT ?`,
          [taskId, RECORD_PREFIX, limit],
        )
        .map(toStep)
        .reverse();
      const count =
        db.get<{ count: number }>(
          `SELECT count(*) AS count FROM run_steps
           WHERE run_id = ? AND deleted_at IS NULL AND substr(key, 1, 1) <> ?`,
          [taskId, RECORD_PREFIX],
        )?.count ?? 0;
      return { steps, count };
    },

    /** Steps started and never settled, those with an Effect only: their outcome isn't known. */
    openEffects(taskId: string): StepRecord[] {
      return db
        .all<StepRow>(
          `SELECT key, effect, status, result, attempts FROM run_steps
           WHERE run_id = ? AND status = 'started' AND effect IS NOT NULL AND deleted_at IS NULL
           ORDER BY started_at, rowid`,
          [taskId],
        )
        .map(toStep);
    },

    /** Keeps a record (`RECORD_PREFIX`) with what it holds, as started: a message queued, say. */
    keep(taskId: string, key: string, result: unknown): void {
      const at = now();
      db.run(
        `INSERT INTO run_steps (id, run_id, key, status, result, started_at, created_at, updated_at)
         VALUES (?, ?, ?, 'started', ?, ?, ?, ?)`,
        [randomUUID(), taskId, key, JSON.stringify(result), at, at, at],
      );
    },

    /** Records a step as started, before it runs: a new attempt of one that ran before. */
    started(taskId: string, key: string, effect: TaskEffect | null): void {
      const at = now();
      db.transaction(() => {
        const known = step(taskId, key);
        if (known) {
          db.run(
            `UPDATE run_steps SET status = 'started', effect = ?, result = NULL,
               attempts = attempts + 1, started_at = ?, completed_at = NULL, updated_at = ?
             WHERE run_id = ? AND key = ? AND deleted_at IS NULL`,
            [effect ? JSON.stringify(effect) : null, at, at, taskId, key],
          );
          return;
        }
        db.run(
          `INSERT INTO run_steps (id, run_id, key, effect, status, started_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'started', ?, ?, ?)`,
          [randomUUID(), taskId, key, effect ? JSON.stringify(effect) : null, at, at, at],
        );
      });
    },

    /** Records how a step ended, after it ran (or after its outcome was checked). */
    settled(
      taskId: string,
      key: string,
      status: Exclude<StepStatus, "started">,
      result: unknown = null,
    ): void {
      const at = now();
      db.run(
        `UPDATE run_steps SET status = ?, result = ?, completed_at = ?, updated_at = ?
         WHERE run_id = ? AND key = ? AND deleted_at IS NULL`,
        [status, result === null ? null : JSON.stringify(result), at, at, taskId, key],
      );
    },
  };
}
