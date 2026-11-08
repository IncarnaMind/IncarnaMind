/**
 * The line-places harness's own logic, apart from the models: the settings a run reads and checks
 * before any job, the jobs it builds, how a failed Answer is recorded, what a run did to the User's
 * lines, and the report it writes as each job finishes. `linePlaces.harness.test.ts` runs it with
 * no model and no key.
 */
import { appendFile } from "node:fs/promises";
import type { ConversationAnswer, EditWithAiResult } from "../../src/core";
import { PLACE_CASES, type PlaceCase } from "./linePlaces.cases";

export type PlacePath = "editWithAi" | "assistant";

export interface PlaceJob {
  each: PlaceCase;
  path: PlacePath;
  run: number;
}

export interface PlaceSettings {
  runs: number;
  concurrency: number;
  arm: string;
  only: readonly string[] | undefined;
  report: string | undefined;
}

/** Why a run counts for nothing, kept apart from the lines it kept or lost. */
export interface RunFailure {
  kind: string;
  message: string;
}

const positiveInteger = (value: string | undefined, fallback: number, name: string): number => {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer; got ${JSON.stringify(value)}.`);
  }
  return number;
};

export function liveSettings(env: Record<string, string | undefined>): PlaceSettings {
  return {
    runs: positiveInteger(env.INCARNAMIND_LIVE_RUNS, 2, "INCARNAMIND_LIVE_RUNS"),
    concurrency: positiveInteger(
      env.INCARNAMIND_LIVE_CONCURRENCY,
      4,
      "INCARNAMIND_LIVE_CONCURRENCY",
    ),
    arm: env.INCARNAMIND_LIVE_ARM ?? "unnamed",
    only: env.INCARNAMIND_LIVE_ONLY?.split(",")
      .map((id) => id.trim())
      .filter((id) => id !== ""),
    report: env.INCARNAMIND_LIVE_REPORT,
  };
}

/** The jobs the filter names, or every case's when it names none; a filter that names no job fails. */
export function placeJobs(only: readonly string[] | undefined, runs: number): PlaceJob[] {
  const known = new Set(PLACE_CASES.map((each) => each.id));
  for (const id of only ?? []) {
    if (!known.has(id)) throw new Error(`Unknown case id ${JSON.stringify(id)}.`);
  }
  const jobs = PLACE_CASES.filter((each) => !only || only.includes(each.id)).flatMap((each) =>
    (["editWithAi", "assistant"] as const).flatMap((path) =>
      Array.from({ length: runs }, (_, index) => ({ each, path, run: index + 1 })),
    ),
  );
  if (jobs.length === 0) throw new Error("No jobs to run: the case filter matches none.");
  return jobs;
}

/** What a run did to the User's lines: those lost that the request doesn't change, and whether what it asks was made. */
export function placeOutcome(each: PlaceCase, after: readonly string[]) {
  const lost = each.note.filter(
    (line, index) => !each.changes.includes(index) && !after.includes(line),
  );
  const made =
    each.kind === "add" || each.kind === "add-first"
      ? after.length > each.note.length
      : each.changes.every((index) => !after.includes(each.note[index] as string));
  return { lost, made };
}

/** Adds to a row the Note it left and what the run did to the User's lines, or the failure that leaves it uncounted. */
export function recordRun(
  row: Record<string, unknown>,
  each: PlaceCase,
  failure: RunFailure | null,
  after: () => readonly string[],
): void {
  if (failure) {
    row.failed = failure;
    return;
  }
  const shown = after();
  row.after = shown;
  Object.assign(row, placeOutcome(each, shown));
}

/** The failure of an Answer that failed or was stopped: its Note as it was would read as lines kept. */
export function answerFailure(
  answer: Pick<ConversationAnswer, "status" | "errorKind" | "errorMessage">,
): RunFailure | null {
  if (answer.status === "failed") {
    return { kind: answer.errorKind ?? "failed", message: answer.errorMessage ?? "" };
  }
  if (answer.status === "stopped") return { kind: "stopped", message: "the Answer was stopped" };
  return null;
}

/** The failure of an Edit with AI the provider failed, the User stopped, or nothing was sent for. */
export function editFailure(result: EditWithAiResult): RunFailure | null {
  if (result.kind === "failed") return { kind: result.error.kind, message: result.error.message };
  if (result.kind === "cancelled") return { kind: "stopped", message: "the edit was cancelled" };
  if (result.kind === "not-ready" || result.kind === "local-mode") {
    return { kind: result.kind, message: "nothing was sent to the model" };
  }
  return null;
}

export interface RunReport {
  /** How many rows the run has saved. */
  readonly rows: number;
  row(row: Record<string, unknown>): Promise<void>;
  spent(spent: readonly string[]): void;
  summary(summary: { arm: string; model: string; jobs: number }): Promise<void>;
}

/**
 * A report of one JSON object a line. Each row is appended as its job finishes, through one queue,
 * so a worker's failure keeps the rows already paid for and concurrent jobs never interleave.
 */
export class ReportFile implements RunReport {
  #rows = 0;
  #pending: Promise<void> = Promise.resolve();
  readonly #spent: string[] = [];
  readonly #file: string | undefined;

  constructor(file: string | undefined) {
    this.#file = file;
  }

  get rows(): number {
    return this.#rows;
  }

  row(row: Record<string, unknown>): Promise<void> {
    this.#rows += 1;
    return this.#append(row);
  }

  spent(spent: readonly string[]): void {
    this.#spent.push(...spent);
  }

  summary(summary: { arm: string; model: string; jobs: number }): Promise<void> {
    return this.#append({ ...summary, spent: this.#spent });
  }

  #append(value: unknown): Promise<void> {
    const file = this.#file;
    if (!file) return Promise.resolve();
    const line = `${JSON.stringify(value)}\n`;
    this.#pending = this.#pending.then(() => appendFile(file, line));
    return this.#pending;
  }
}

export interface LiveWorker<Job> {
  run(job: Job): Promise<Record<string, unknown>>;
  /** What its calls have cost so far, as the report keeps it. */
  spend(): readonly string[];
  close(): void;
}

/**
 * Runs the jobs on `concurrency` workers, saving each row as its job finishes. Every worker settles
 * even when one fails, so the report keeps what was paid for, the spend so far and the summary,
 * and the first failure is still thrown once they are written.
 */
export async function runLiveJobs<Job>(
  jobs: readonly Job[],
  concurrency: number,
  openWorker: () => Promise<LiveWorker<Job>>,
  report: RunReport,
  summary: { arm: string; model: string },
): Promise<void> {
  let next = 0;
  const failures: unknown[] = [];
  const workers = Array.from({ length: concurrency }, async () => {
    try {
      const worker = await openWorker();
      try {
        while (next < jobs.length) {
          const job = jobs[next++] as Job;
          await report.row(await worker.run(job));
        }
      } finally {
        report.spent(worker.spend());
        worker.close();
      }
    } catch (error) {
      failures.push(error);
    }
  });
  await Promise.all(workers);
  await report.summary({ ...summary, jobs: jobs.length });
  if (failures.length > 0) throw failures[0];
}
