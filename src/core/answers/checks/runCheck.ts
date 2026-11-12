/**
 * A claim taken through its check, the same way in every flow that checks one (#2897): Check
 * against Documents, a whole read's windows, Verify, Check this Note, the contradiction watch, the
 * assistant's writing and the claim-check function. Each flow keeps its own order, landing and
 * what it does with the claims a stop leaves.
 *
 * - A provider that says to slow down for a stated time has the refused request sent again inside
 *   its check once that time is over (../../runs/stop, #2944); past two minutes of waiting it is
 *   "wait", and the run's later claims aren't sent. One that doesn't say has the claim sent again
 *   after each pause of `RATE_LIMIT_PAUSES_MS`, the run's other claims waiting too; still limited
 *   after the last, it is "wait", and the run's later claims aren't sent.
 * - The monthly cap or a plan's limit is "stop": nothing more is sent, and the claim and every one
 *   after it are Not checked for its reason.
 * - A check with no reply within the time limit is given up on: "failed", timed out.
 * - A claim whose check a model replied to, on any try, is one use of AI in its Note's record
 *   (#906), written once its outcome is final, whether or not it lands: "sentence-checked" with a
 *   verdict, "sentence-asked" with none. A claim no model replied to (refused before it was sent,
 *   turned away by its provider, kept inside a wall) is none.
 */
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { ClaimCheckFailure, ClaimCheckResult, RecordAiUseInput, RunStop } from "../../api";
import type { PreparedChatModel } from "../../providers/chat";
import { BEFORE_REPLY } from "../../providers/modelRefusal";
import type { ChatLanguageModel } from "../../providers/models";
import { classifyProviderError } from "../../providers/providerErrors";
import {
  type ItemOutcome,
  RunItemError,
  RunItemGaveWay,
  type RunRequests,
  runItems,
} from "../../runs/stop";
import { type PaceTimers, realTimers } from "../../sources/pace";
import { failureOf, runFailureOf } from "./checkResults";
import type { ClaimCheckRequest } from "./claimCheck";

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

/** A model lent to a check, and what to tell when a reply comes to it some other way. */
const lent = new WeakMap<PreparedChatModel, () => void>();

/** How a check's requests go out: straight away, or through its run (`RunRequests.send`). */
type Send = <R>(request: () => PromiseLike<R>) => PromiseLike<R>;

/**
 * `prepared`, and whether a reply from its model has begun: a request refused before it was
 * sent, or one its provider turned away, began none. `heard` hears the first; `send` sends each
 * request.
 */
export function heardFrom(
  prepared: PreparedChatModel,
  heard?: () => void,
  send: Send = (request) => request(),
): {
  prepared: PreparedChatModel;
  replied(): boolean;
} {
  let replied = false;
  const hear = () => {
    if (replied) return;
    replied = true;
    heard?.();
  };
  const listen = (model: ChatLanguageModel) =>
    wrapLanguageModel({
      model,
      middleware: {
        specificationVersion: "v4",
        wrapGenerate: async ({ doGenerate }) => {
          const result = await send(doGenerate);
          hear();
          return result;
        },
        wrapStream: async ({ doStream }) => {
          const result = await send(doStream);
          const stream = result.stream.pipeThrough(
            new TransformStream<StreamPart, StreamPart>({
              transform(part, controller) {
                if (part.type !== "error" && !BEFORE_REPLY.has(part.type)) hear();
                controller.enqueue(part);
              },
            }),
          );
          return { ...result, stream };
        },
      },
    });
  let listened: ChatLanguageModel | null = null;
  const listening: PreparedChatModel = {
    ...prepared,
    // Wrapped when a request first asks for it: a check may never send one.
    get model() {
      listened ??= listen(prepared.model);
      return listened;
    },
  };
  lent.set(listening, hear);
  return { prepared: listening, replied: () => replied };
}

/**
 * Tells the check that was lent `prepared` (`heardFrom`) that its claim was read, by a check it
 * took in place of its own: one Check this Note started early.
 */
export const heardThrough = (prepared: PreparedChatModel): void => lent.get(prepared)?.();

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

/**
 * The check, or `TimedOut` once the time limit passes; `read` hears its model reply. Its requests
 * go through `requests` when given, and the time limit doesn't run while one waits on a rate limit.
 */
async function within(
  check: ClaimCheck,
  request: ClaimCheckRequest,
  run: CheckRun,
  read: () => void,
  requests?: RunRequests,
): Promise<ClaimCheckResult> {
  const settled = new AbortController();
  const givenUp = new AbortController();
  const signal = AbortSignal.any([request.signal, givenUp.signal]);
  /**
   * The time limit is moved on by the time the check's requests waited on a rate limit: how many
   * wait now, since when, the time waited not yet added, and whether the limit came during a wait.
   */
  let waiting = 0;
  let since = 0;
  let waited = 0;
  let due = false;
  let expire = (_ms: number) => undefined;
  const hold = (on: boolean) => {
    if (on) {
      if (waiting++ === 0) since = run.timers.now();
      return;
    }
    if (--waiting > 0) return;
    waited += run.timers.now() - since;
    if (!due) return;
    due = false;
    expire(waited);
    waited = 0;
  };
  const heard = heardFrom(
    request.model,
    read,
    requests && ((send) => requests.send(send, { signal, waiting: hold })),
  );
  try {
    // A reply that never comes, even once its check is stopped, is given up on all the same.
    const ended = new Promise<ClaimCheckResult | TimedOut>((resolve) => {
      expire = (ms) => {
        run.timers.sleep(ms, settled.signal).then(
          () => {
            if (waiting > 0) {
              due = true;
              return;
            }
            if (waited > 0) {
              expire(waited);
              waited = 0;
              return;
            }
            givenUp.abort();
            resolve(new TimedOut());
          },
          () => undefined,
        );
      };
      expire(run.timeLimitMs);
      if (request.signal.aborted) resolve(stopped());
      request.signal.addEventListener("abort", () => resolve(stopped()), {
        once: true,
        signal: settled.signal,
      });
    });
    const result = await Promise.race([
      check({ ...request, model: heard.prepared, signal }),
      ended,
    ]);
    if (result instanceof TimedOut) throw result;
    return result;
  } finally {
    settled.abort();
  }
}

/** A claim's check with the time limit, recorded, its result as it came: no pause, no stop. */
export async function checkOnce(
  check: ClaimCheck,
  request: ClaimCheckRequest,
  run: CheckRun,
): Promise<ClaimCheckResult> {
  let read = false;
  let result: ClaimCheckResult | null = null;
  try {
    result = await within(check, request, run, () => {
      read = true;
    });
    return result;
  } catch (error) {
    if (!(error instanceof TimedOut)) throw error;
    result = resultOf(timedOut(run));
    return result;
  } finally {
    if (read) recordCheck(run.record, run.model, result);
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
    limitedAtOnce?: number;
    onOutcome?(item: I, outcome: CheckOutcome): void;
    /** Hears the run's wait after a rate limit: when it ends, or null once it has. */
    onPause?(until: number | null): void;
    /** Hears each rate limit a check's request met. */
    onLimit?(): void;
  },
): Promise<{
  outcomes: (CheckOutcome | null)[];
  stop: RunStop | null;
  outcomeError: { error: unknown } | null;
}> {
  /** Whether a model replied to each item's check, on any of its tries. */
  const read = items.map(() => false);
  const attempt =
    (index: number, requests: RunRequests): CheckTry =>
    async (check, request) => {
      const result = await within(
        check,
        request,
        run,
        () => {
          read[index] = true;
        },
        requests,
      );
      const failure = runFailureOf(result);
      if (failure) throw new RunItemError(failure);
      return result;
    };
  const { onOutcome } = run;
  const { outcomes, stop, outcomeError } = await runItems(
    items.map((item, index) => ({ item, index })),
    async ({ item, index }, requests): Promise<CheckOutcome> => {
      try {
        return { result: await each(item, attempt(index, requests)) };
      } catch (error) {
        if (error instanceof RunItemError || error instanceof RunItemGaveWay) throw error;
        if (error instanceof TimedOut) return timedOut(run);
        if (run.signal.aborted) throw error;
        console.error(`A check in Note ${run.record?.mindId ?? "(none)"} failed:`, error);
        return { failure: "failed", ...failureOf(classifyProviderError(error)) };
      }
    },
    {
      concurrency: run.concurrency ?? 1,
      ...(run.limitedAtOnce !== undefined && { limitedAtOnce: run.limitedAtOnce }),
      ...(run.onPause && { onPause: run.onPause }),
      ...(run.onLimit && { onLimit: run.onLimit }),
      signal: run.signal,
      // A sleep rejects only when the run is stopped, which ends the pause.
      wait: (ms, signal) => run.timers.sleep(ms, signal ?? run.signal).catch(() => undefined),
      now: run.timers.now,
      // Heard once an item's tries are over: its one record, from what it came to in the end.
      onOutcome({ item, index }, outcome) {
        const heard = outcomeOf(outcome);
        if (read[index]) recordCheck(run.record, run.model, heard && resultOf(heard));
        if (heard) onOutcome?.(item, heard);
      },
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
