import type * as Y from "yjs";
import { settleFigureCheck } from "../../../shared/figureChecks";
/**
 * Checks claims already marked "checking", for Verify (#97) and Check this
 * Mind (#737): a cloud model six at a time, one on this computer one at a
 * time, each result written onto its mark as it comes. The monthly cap or a
 * plan's limit stops the run, and the claims left say why they weren't checked.
 */

import { pendingPart, resultFromParts } from "../../../shared/claimParts";
import type {
  ClaimCheckAttributes,
  ClaimCheckPart,
  ClaimCheckResult,
  ClaimPartPlan,
  ClaimPartSpan,
  RecordAiUseInput,
  RunStop,
  ThirdPartyReason,
} from "../../api";
import type { MindContent } from "../../mindContent";
import type { PreparedChatModel } from "../../providers/chat";
import type { RecordCitePlace } from "../../recordCites/referents";
import { asCheckWork } from "../../reranking/order";
import { RunItemError, runItems, type Slots, slots } from "../../runs/stop";
import { type ClaimCheckRequest, recordJudged, runFailureOf } from "./claimCheck";
import { updateCheck } from "./sentences";

export function pendingParts(
  plans: readonly ClaimPartPlan[],
  previous: readonly ClaimCheckPart[] = [],
): ClaimCheckPart[] {
  return plans.map((plan) => {
    const part = pendingPart(plan);
    const prior = previous.find(
      (each) =>
        each.kind === plan.kind &&
        each.span.start === plan.span.start &&
        each.span.end === plan.span.end,
    );
    return plan.kind === "opinion" && prior?.verdict != null
      ? { ...part, verdict: "checking" }
      : part;
  });
}

// Six checked 12 sentences in about half the time three took on Claude and Kimi, with no rate-limit
// answer; eight saved little more (#1618).
const CLOUD_CLAIMS_AT_ONCE = 6;

/** How many claims a check sends to `prepared` at once; a model on this computer takes one at a time. */
export const claimsAtOnce = (prepared: PreparedChatModel): number =>
  prepared.provider.service ? CLOUD_CLAIMS_AT_ONCE : 1;

// Check this Note alone, held to its gate (#2532, eval/speed/gates/check-note-speed.md › Gate C):
// the write and Verify keep six, as twelve failed the write's own (check-speed-twelve.md).
const NOTE_CLAIMS_AT_ONCE = 12;

/** How many sentences Check this Note checks at once on `prepared`. */
export const noteClaimsAtOnce = (prepared: PreparedChatModel): number =>
  prepared.provider.service ? NOTE_CLAIMS_AT_ONCE : 1;

/** A claim marked "checking", and what its check sends. */
export interface QueuedClaim {
  id: string;
  claim: string;
  projection?: ClaimCheckRequest["projection"];
  figureIds?: readonly string[];
  context: string;
  cited?: ClaimCheckRequest["cited"];
  figures?: ClaimCheckRequest["figures"];
  /** The sentence as the Note has it, and where it starts there, for its record cites. */
  recordClaim?: string;
  place?: RecordCitePlace;
  /** Where it is checked, when not where the run's other claims are. */
  scope?: ClaimCheckRequest["scope"];
  /** The Search scope `scope` was resolved from, when it isn't the run's. */
  searched?: ClaimCheckRequest["searched"];
  parts?: readonly ClaimPartPlan[];
  only?: ClaimPartSpan;
  previous?: readonly ClaimCheckPart[];
  priorParts?: readonly ClaimCheckPart[];
}

export interface RunChecksOptions {
  content: Pick<MindContent, "edit">;
  claimCheck(request: ClaimCheckRequest): Promise<ClaimCheckResult>;
  withResult(
    check: ClaimCheckAttributes,
    result: ClaimCheckResult,
    at: string,
    blocks: Y.XmlFragment,
    mindId: string,
    sourceText?: string,
    priorParts?: readonly ClaimCheckPart[],
  ): ClaimCheckAttributes;
  /** Keeps the text of the evidence the Mind's checks show (#79). */
  retainEvidence(mindId: string): void;
  recordAiUse(inputs: RecordAiUseInput[]): void;
  now(): Date;
}

/** What a run of checks shares: where its claims are checked, by which model, and when it stops. */
export interface ChecksRun {
  mindId: string;
  scope: ClaimCheckRequest["scope"];
  searched?: ClaimCheckRequest["searched"];
  prepared: PreparedChatModel;
  thirdParty?: readonly ThirdPartyReason[];
  signal: AbortSignal;
}

/** What a queued claim's check sends, in `run`. */
export function checkRequestOf(
  claim: QueuedClaim,
  run: ChecksRun,
  limit: Slots,
  signal: AbortSignal,
): ClaimCheckRequest {
  return {
    claim: claim.claim,
    ...(claim.projection && { projection: claim.projection }),
    ...(claim.figureIds && { figureIds: claim.figureIds }),
    context: claim.context,
    ...(claim.cited && { cited: claim.cited }),
    ...(claim.parts && { parts: claim.parts }),
    ...(claim.only && { only: claim.only }),
    ...(claim.previous && { previous: claim.previous }),
    ...(claim.figures && { figures: claim.figures }),
    scope: claim.scope ?? run.scope,
    ...((claim.searched ?? run.searched) !== undefined && {
      searched: claim.searched ?? run.searched,
    }),
    model: run.prepared,
    ...(run.thirdParty && { thirdParty: run.thirdParty }),
    mindId: run.mindId,
    ...(claim.recordClaim !== undefined && { recordClaim: claim.recordClaim }),
    ...(claim.place && { place: claim.place }),
    cacheKey: run.mindId,
    slots: limit,
    signal,
  };
}

/** A claim's check, as one piece of work: its searches are reranked before those of checks started after it. */
export const checkClaim = (
  claimCheck: RunChecksOptions["claimCheck"],
  request: ClaimCheckRequest,
): Promise<ClaimCheckResult> => asCheckWork(() => claimCheck(request));

/** A request as a key: what it sends, without its signal, its run's limit and its model (the run's own). */
function requestKey({ signal: _signal, slots: _slots, model: _model, ...sent }: ClaimCheckRequest) {
  return JSON.stringify(sent, (_key, value: unknown) =>
    value instanceof Map ? [...value] : value instanceof Set ? [...value] : value,
  );
}

/**
 * Checks started before a run's queue is made, as soon as each claim is known (#2532): a Note's
 * claims are checked while the model is still naming the rest. Only as many start as the run's
 * limit has free places, so none waits outside the run, where a provider's rate limit wouldn't
 * slow it (#1618). Once the run's queue is made from the Note as it is then, a check it would send
 * is taken from those started early only if it sends exactly the same, and what it reads besides
 * (the Library, a record cite's sources) hasn't changed; every other early check is stopped at
 * once and its result dropped, so no result lands that the run wouldn't have got.
 */
export function earlyChecks(
  claimCheck: RunChecksOptions["claimCheck"],
  run: ChecksRun,
  limit: Slots,
) {
  interface Early {
    result: Promise<ClaimCheckResult>;
    stop: AbortController;
    /** What the check reads besides its request, as it was when it started, and as it is now. */
    read: string;
    readNow(): string;
  }
  const started = new Map<string, Early[]>();
  return {
    /** `readNow` says what the check reads besides its request (the Library, the Note's record choices): it is taken only if that is unchanged. */
    start(claim: QueuedClaim, readNow: () => string): void {
      if (limit.free() === 0) return;
      const stop = new AbortController();
      const request = checkRequestOf(claim, run, limit, AbortSignal.any([run.signal, stop.signal]));
      const key = requestKey(request);
      const early: Early = {
        result: checkClaim(claimCheck, request),
        stop,
        read: readNow(),
        readNow,
      };
      early.result.catch((error: unknown) => {
        // A check the run takes fails there, as any other does.
        if (stop.signal.aborted || !started.get(key)?.includes(early)) return;
        console.error(`A check started early for Note ${run.mindId} failed:`, error);
      });
      started.set(key, [...(started.get(key) ?? []), early]);
    },
    /** Stops at once the early checks of claims the run won't send as they were sent. */
    keep(queued: readonly QueuedClaim[]): void {
      const wanted = new Map<string, number>();
      for (const claim of queued) {
        const key = requestKey(checkRequestOf(claim, run, limit, run.signal));
        wanted.set(key, (wanted.get(key) ?? 0) + 1);
      }
      for (const [key, all] of started) {
        const each = all.filter((early) => {
          const same = early.readNow() === early.read;
          if (!same) early.stop.abort();
          return same;
        });
        const kept = wanted.get(key) ?? 0;
        for (const { stop } of each.slice(kept)) stop.abort();
        started.set(key, each.slice(0, kept));
      }
    },
    /** The run's claim check: an early one that sends the same, or a new one. */
    claimCheck(request: ClaimCheckRequest): Promise<ClaimCheckResult> {
      if (started.size === 0) return claimCheck(request);
      return started.get(requestKey(request))?.shift()?.result ?? claimCheck(request);
    },
    /** Stops every early check the run didn't take. */
    drop(): void {
      for (const each of started.values()) for (const { stop } of each) stop.abort();
      started.clear();
    },
  };
}

export async function runChecks(
  options: RunChecksOptions,
  run: ChecksRun & {
    queued: readonly QueuedClaim[];
    /** How many claims it checks at once, when not `claimsAtOnce`'s. */
    atOnce?: number;
    /** The limit on checks at once, when the run shares it with checks started before it. */
    slots?: Slots;
  },
): Promise<{ checked: number; stop: RunStop | null }> {
  const { mindId, prepared, signal } = run;
  const write = (
    id: string,
    change: (check: ClaimCheckAttributes, blocks: Y.XmlFragment) => ClaimCheckAttributes,
  ) => {
    if (signal.aborted) return;
    const kept = options.content.edit(mindId, (blocks) =>
      updateCheck(blocks, id, (check) => change(check, blocks)),
    );
    if (kept) options.retainEvidence(mindId);
  };
  const notChecked =
    (reason: ClaimCheckAttributes["reason"], detail: string | null = null) =>
    (check: ClaimCheckAttributes, blocks: Y.XmlFragment): ClaimCheckAttributes => {
      const at = options.now().toISOString();
      const settled = settleFigureCheck(check, (basis) => ({
        ...basis,
        state: "not-checked",
        reason,
        detail,
        checkedAt: at,
      }));
      if (!check.parts) return settled;
      const parts = (settled.parts ?? check.parts).map(
        (part): ClaimCheckPart =>
          part.verdict === "checking" ? { ...part, verdict: "not-checked", reason, detail } : part,
      );
      return options.withResult({ ...settled, parts }, resultFromParts(parts), at, blocks, mindId);
    };

  let checked = 0;
  const atOnce = run.atOnce ?? claimsAtOnce(prepared);
  const limit = run.slots ?? slots(atOnce);
  const { stop } = await runItems(
    run.queued,
    async (claim) => {
      const result = await checkClaim(
        options.claimCheck,
        checkRequestOf(claim, run, limit, signal),
      );
      const failure = runFailureOf(result);
      if (failure) throw new RunItemError(failure);
      return result;
    },
    {
      concurrency: atOnce,
      signal,
      onOutcome(claim, outcome) {
        if (outcome.status === "done") {
          const at = options.now().toISOString();
          if (outcome.value.verdict !== "not-checked") checked++;
          recordJudged(options.recordAiUse, mindId, prepared, outcome.value, at);
          write(claim.id, (each, blocks) =>
            options.withResult(
              each,
              outcome.value,
              at,
              blocks,
              mindId,
              claim.claim,
              claim.priorParts,
            ),
          );
        } else if (outcome.status === "not-checked") {
          write(claim.id, notChecked(outcome.stop.reason));
        } else if (outcome.status === "failed") {
          const rateLimited = outcome.error.kind === "rate-limit";
          write(
            claim.id,
            notChecked(
              rateLimited ? "rate-limit" : "failed",
              rateLimited ? null : outcome.error.message,
            ),
          );
        }
      },
    },
  );
  return { checked, stop };
}
