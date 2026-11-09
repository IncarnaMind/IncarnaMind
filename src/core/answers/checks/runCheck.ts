/**
 * A claim taken through its check, the same way in every flow that checks one (#2897): Check
 * against Documents, a whole read's windows, Verify, Check this Note, the contradiction watch, the
 * assistant's writing and the claim-check function. Each flow keeps its own order, landing and
 * what it does with the claims a stop leaves.
 *
 * - A provider that says to slow down has the claim sent again after each pause of
 *   `RATE_LIMIT_PAUSES_MS`, the run's other claims waiting too (../../runs/stop). Still limited
 *   after the last, it is "wait", and the run's later claims aren't sent.
 * - The monthly cap or a plan's limit is "stop": nothing more is sent, and the claim and every one
 *   after it are Not checked for its reason.
 * - A check with no reply within the time limit is given up on: "failed", timed out.
 * - Every check a model replied to is a use of AI in its Note's record (#906), whether or not its
 *   result lands: "sentence-checked" with its verdict, "sentence-asked" with none. A check no
 *   model replied to (refused before it was sent, at the cap, kept inside a wall) is none.
 */
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { ClaimCheckFailure, ClaimCheckResult, RecordAiUseInput, RunStop } from "../../api";
import type { PreparedChatModel } from "../../providers/chat";
import { BEFORE_REPLY } from "../../providers/modelRefusal";
import type { ChatLanguageModel } from "../../providers/models";
import { classifyProviderError } from "../../providers/providerErrors";
import { type ItemOutcome, RunItemError, runItems } from "../../runs/stop";
import { type PaceTimers, realTimers } from "../../sources/pace";
import { type ClaimCheckRequest, failureOf, runFailureOf } from "./claimCheck";

/**
 * How long one check may take. A request whose reply never comes would otherwise hold its run, or
 * the background queue, for good (seen once with GPT-6 Luna).
 */
export const CLAIM_TIME_LIMIT_MS = 3 * 60_000;

export type ClaimCheck = (request: ClaimCheckRequest) => Promise<ClaimCheckResult>;

/** The Note whose record of AI use holds a run's checks. */
export interface CheckRecord {
  mindId: string;
  recordAiUse(inputs: RecordAiUseInput[]): void;
  now(): Date;
}

export interface CheckRun {
  model: PreparedChatModel;
  signal: AbortSignal;
  timeLimitMs: number;
  /** The clock the pauses and the time limit are kept by. */
  timers: PaceTimers;
  /** Null when what the checks are part of is recorded instead: a whole read's sentence. */
  record: CheckRecord | null;
}

/** What every run of checks shares, whichever flow it is. */
export interface CheckRuns {
  /** The real clock when left out. */
  timers?: PaceTimers;
  /** How long one check may take, in ms; `CLAIM_TIME_LIMIT_MS` when left out. */
  claimTimeLimitMs?: number;
  recordAiUse(inputs: RecordAiUseInput[]): void;
  now(): Date;
}

/** A run of checks by `model`, recorded in the Note `mindId`'s record; null: in none. */
export const checkRunOf = (
  runs: CheckRuns,
  model: PreparedChatModel,
  signal: AbortSignal,
  mindId: string | null,
): CheckRun => ({
  model,
  signal,
  timeLimitMs: runs.claimTimeLimitMs ?? CLAIM_TIME_LIMIT_MS,
  timers: runs.timers ?? realTimers,
  record: mindId === null ? null : { mindId, recordAiUse: runs.recordAiUse, now: runs.now },
});

/** A claim's result, or why it is Not checked; "wait" and "stop" end the run (see above). */
export type CheckOutcome =
  | { result: ClaimCheckResult }
  | { failure: "wait" | "failed"; reason: ClaimCheckFailure; detail: string | null }
  | { failure: "stop"; reason: RunStop["reason"]; detail: null; stop: RunStop };

/**
 * One try at a claim's check inside a run (`runClaimChecks`): it throws for a failure the run
 * waits out or stops at, so a flow that does more for a claim than its check stops there too.
 */
export type CheckTry = (check: ClaimCheck, request: ClaimCheckRequest) => Promise<ClaimCheckResult>;

type Wrapped = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0];
type StreamPart =
  Awaited<ReturnType<Wrapped["doStream"]>>["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

/**
 * `prepared`, and whether a reply from its model has begun: a request refused before it was
 * sent, or one its provider turned away, began none.
 */
export function heardFrom(prepared: PreparedChatModel): {
  prepared: PreparedChatModel;
  replied(): boolean;
} {
  let replied = false;
  const listen = (model: ChatLanguageModel) =>
    wrapLanguageModel({
      model,
      middleware: {
        specificationVersion: "v4",
        wrapGenerate: async ({ doGenerate }) => {
          const result = await doGenerate();
          replied = true;
          return result;
        },
        wrapStream: async ({ doStream }) => {
          const result = await doStream();
          const stream = result.stream.pipeThrough(
            new TransformStream<StreamPart, StreamPart>({
              transform(part, controller) {
                if (part.type !== "error" && !BEFORE_REPLY.has(part.type)) replied = true;
                controller.enqueue(part);
              },
            }),
          );
          return { ...result, stream };
        },
      },
    });
  let listened: ChatLanguageModel | null = null;
  return {
    prepared: {
      ...prepared,
      // Wrapped when a request first asks for it: a check may never send one.
      get model() {
        listened ??= listen(prepared.model);
        return listened;
      },
    },
    replied: () => replied,
  };
}

/**
 * Records a check a model replied to as a use of AI: checked when it came to a verdict, else
 * asked. `result` is null for one that came to nothing, as a check that threw.
 */
export function recordCheck(
  record: CheckRecord | null,
  model: PreparedChatModel,
  result: ClaimCheckResult | null,
): void {
  if (!record) return;
  try {
    record.recordAiUse([
      {
        mindId: record.mindId,
        kind: result && result.verdict !== "not-checked" ? "sentence-checked" : "sentence-asked",
        providerId: model.provider.id,
        modelId: model.modelId,
        characters: 0,
        occurredAt: record.now().toISOString(),
      },
    ]);
  } catch (error) {
    // The result stands: a Note deleted while it was checked has no record to hold it.
    console.error(`A check in Note ${record.mindId} couldn't be recorded as a use of AI:`, error);
  }
}

class TimedOut extends Error {
  constructor() {
    super("No reply within the time limit.");
    this.name = "TimedOut";
  }
}

const timedOut = (run: CheckRun): CheckOutcome => ({
  failure: "failed",
  reason: "timed-out",
  detail: String(Math.round(run.timeLimitMs / 1000)),
});

const stopped = (): ClaimCheckResult => ({
  verdict: "not-checked",
  reason: "stopped",
  detail: null,
  versions: [],
  excluded: [],
});

/** The check, or `TimedOut` once the time limit passes; recorded when its model replied. */
async function within(
  check: ClaimCheck,
  request: ClaimCheckRequest,
  run: CheckRun,
): Promise<ClaimCheckResult> {
  const settled = new AbortController();
  const givenUp = new AbortController();
  const heard = heardFrom(request.model);
  let came: ClaimCheckResult | null = null;
  try {
    // A reply that never comes, even once its check is stopped, is given up on all the same.
    const ended = new Promise<ClaimCheckResult | TimedOut>((resolve) => {
      run.timers.sleep(run.timeLimitMs, settled.signal).then(
        () => {
          givenUp.abort();
          resolve(new TimedOut());
        },
        () => undefined,
      );
      if (request.signal.aborted) resolve(stopped());
      request.signal.addEventListener("abort", () => resolve(stopped()), {
        once: true,
        signal: settled.signal,
      });
    });
    const result = await Promise.race([
      check({
        ...request,
        model: heard.prepared,
        signal: AbortSignal.any([request.signal, givenUp.signal]),
      }),
      ended,
    ]);
    if (result instanceof TimedOut) throw result;
    came = result;
    return result;
  } finally {
    settled.abort();
    if (heard.replied()) recordCheck(run.record, run.model, came);
  }
}

/** A claim's check with the time limit, recorded, its result as it came: no pause, no stop. */
export async function checkOnce(
  check: ClaimCheck,
  request: ClaimCheckRequest,
  run: CheckRun,
): Promise<ClaimCheckResult> {
  try {
    return await within(check, request, run);
  } catch (error) {
    if (error instanceof TimedOut) return resultOf(timedOut(run));
    throw error;
  }
}

/** A Not checked result for the failure, or the check's own. */
export function resultOf(outcome: CheckOutcome): ClaimCheckResult {
  if ("result" in outcome) return outcome.result;
  return {
    verdict: "not-checked",
    reason: outcome.reason,
    detail: outcome.detail,
    versions: [],
    excluded: [],
  };
}

function outcomeOf(outcome: ItemOutcome<CheckOutcome>): CheckOutcome | null {
  switch (outcome.status) {
    case "done":
      return outcome.value;
    case "not-checked":
      return { failure: "stop", reason: outcome.stop.reason, detail: null, stop: outcome.stop };
    case "failed":
      return outcome.error.kind === "rate-limit"
        ? { failure: "wait", reason: "rate-limit", detail: null }
        : { failure: "failed", ...failureOf(outcome.error) };
    case "stopped":
      return null;
  }
}

/**
 * Takes each item's claims through their checks, `concurrency` at a time, started in order, and
 * says what became of each item as soon as it has an outcome; one the run's signal stopped has
 * none. `each` checks its item's claims with the `CheckTry` it is given and returns the result its
 * item lands. `outcomeError`: the first error `onOutcome` threw, as `runItems` returns it.
 */
export async function runClaimChecks<I>(
  items: readonly I[],
  each: (item: I, check: CheckTry) => Promise<ClaimCheckResult>,
  run: CheckRun & {
    concurrency?: number;
    onOutcome?(item: I, outcome: CheckOutcome): void;
  },
): Promise<{
  outcomes: (CheckOutcome | null)[];
  stop: RunStop | null;
  outcomeError: { error: unknown } | null;
}> {
  const attempt: CheckTry = async (check, request) => {
    const result = await within(check, request, run);
    const failure = runFailureOf(result);
    if (failure) throw new RunItemError(failure);
    return result;
  };
  const { onOutcome } = run;
  const { outcomes, stop, outcomeError } = await runItems(
    items,
    async (item): Promise<CheckOutcome> => {
      try {
        return { result: await each(item, attempt) };
      } catch (error) {
        if (error instanceof RunItemError) throw error;
        if (error instanceof TimedOut) return timedOut(run);
        if (run.signal.aborted) throw error;
        console.error(`A check in Note ${run.record?.mindId ?? "(none)"} failed:`, error);
        return { failure: "failed", ...failureOf(classifyProviderError(error)) };
      }
    },
    {
      concurrency: run.concurrency ?? 1,
      signal: run.signal,
      // A sleep rejects only when the run is stopped, which ends the pause.
      wait: (ms, signal) => run.timers.sleep(ms, signal ?? run.signal).catch(() => undefined),
      now: run.timers.now,
      ...(onOutcome && {
        onOutcome(item: I, outcome: ItemOutcome<CheckOutcome>) {
          const heard = outcomeOf(outcome);
          if (heard) onOutcome(item, heard);
        },
      }),
    },
  );
  return { outcomes: outcomes.map(outcomeOf), stop, outcomeError };
}

/** One claim through its check (`runClaimChecks`); stopped, it is Not checked, "stopped". */
export async function runCheck(
  check: ClaimCheck,
  request: ClaimCheckRequest,
  run: CheckRun,
): Promise<CheckOutcome> {
  const { outcomes } = await runClaimChecks(
    [request],
    (each, attempt) => attempt(check, each),
    run,
  );
  return outcomes[0] ?? { result: stopped() };
}
