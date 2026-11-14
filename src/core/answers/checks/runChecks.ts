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
  ClaimCheckFailure,
  ClaimCheckPart,
  ClaimCheckResult,
  ClaimPartPlan,
  ClaimPartSpan,
  RunStop,
  ThirdPartyReason,
} from "../../api";
import type { MindContent } from "../../mindContent";
import type { PreparedChatModel } from "../../providers/chat";
import type { RecordCitePlace } from "../../recordCites/referents";
import { asCheckWork } from "../../reranking/order";
import { type Slots, slots } from "../../runs/stop";
import type { ClaimCheckRequest } from "./claimCheck";
import {
  type CheckRecord,
  type CheckRuns,
  checkRunOf,
  heardFrom,
  heardThrough,
  recordCheck,
  runClaimChecks,
} from "./runCheck";
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
  /** Its own words' search, started before its check (#2532). */
  ahead?: ClaimCheckRequest["ahead"];
}

export interface RunChecksOptions extends CheckRuns {
  content: Pick<MindContent, "edit">;
  claimCheck(request: ClaimCheckRequest): Promise<ClaimCheckResult>;
  withResult: WithResult;
  /** Keeps the text of the evidence the Mind's checks show (#79). */
  retainEvidence(mindId: string): void;
}

type WithResult = (
  check: ClaimCheckAttributes,
  result: ClaimCheckResult,
  at: string,
  blocks: Y.XmlFragment,
  mindId: string,
  sourceText?: string,
  priorParts?: readonly ClaimCheckPart[],
  before?: ClaimCheckAttributes | null,
  /** The parts an earlier check gave this very text, unlike `priorParts`, which may be of words since changed. */
  sameTextParts?: readonly ClaimCheckPart[],
) => ClaimCheckAttributes;

/** A sentence's mark Not checked for `reason`: its figures and each part still checking say so too. */
export function notCheckedMark(
  check: ClaimCheckAttributes,
  blocks: Y.XmlFragment,
  landing: { withResult: WithResult; mindId: string; at: string },
  reason: ClaimCheckFailure,
  detail: string | null,
): ClaimCheckAttributes {
  const { at } = landing;
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
  return landing.withResult(
    { ...settled, parts },
    resultFromParts(parts),
    at,
    blocks,
    landing.mindId,
  );
}

/** What a run of checks shares: where its claims are checked, by which model, and when it stops. */
export interface ChecksRun {
  mindId: string;
  scope: ClaimCheckRequest["scope"];
  searched?: ClaimCheckRequest["searched"];
  prepared: PreparedChatModel;
  thirdParty?: readonly ThirdPartyReason[];
  /** Its checks are of a flow the search-first gate measured (`ClaimCheckRequest.searchFirst`). */
  searchFirst?: true;
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
    ...(claim.ahead && { ahead: claim.ahead }),
    ...(run.searchFirst && { searchFirst: true }),
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
  record: CheckRecord | null = null,
) {
  interface Early {
    result: Promise<ClaimCheckResult>;
    stop: AbortController;
    /** What the check reads besides its request, as it was when it started, and as it is now. */
    read: string;
    readNow(): string;
    replied(): boolean;
    /** Tells the run that took the check that a model replied to it. */
    taken: (() => void) | null;
  }
  const started = new Map<string, Early[]>();
  // One the run takes is its claim's own check, recorded by the run; one it doesn't is a claim of
  // its own, recorded here once it ends, when a model replied to it.
  const drop = (early: Early) => {
    early.stop.abort();
    const ended = (result: ClaimCheckResult | null) => {
      if (early.replied()) recordCheck(record, run.prepared, result);
    };
    early.result.then(ended, () => ended(null));
  };
  return {
    /**
     * `readNow` says what the check reads besides its request (the Library, the Note's record
     * choices): it is taken only if that is unchanged. False when no place was free to start it.
     */
    start(claim: QueuedClaim, readNow: () => string): boolean {
      if (limit.free() === 0) return false;
      const stop = new AbortController();
      const heard = heardFrom(run.prepared, () => early.taken?.());
      const request = checkRequestOf(
        claim,
        { ...run, prepared: heard.prepared },
        limit,
        AbortSignal.any([run.signal, stop.signal]),
      );
      const key = requestKey(request);
      const early: Early = {
        result: checkClaim(claimCheck, request),
        stop,
        read: readNow(),
        readNow,
        replied: heard.replied,
        taken: null,
      };
      early.result.catch((error: unknown) => {
        // A check the run takes fails there, as any other does.
        if (stop.signal.aborted || !started.get(key)?.includes(early)) return;
        console.error(`A check started early for Note ${run.mindId} failed:`, error);
      });
      started.set(key, [...(started.get(key) ?? []), early]);
      return true;
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
          if (!same) drop(early);
          return same;
        });
        const kept = wanted.get(key) ?? 0;
        for (const early of each.slice(kept)) drop(early);
        started.set(key, each.slice(0, kept));
      }
    },
    /** The run's claim check: an early one that sends the same, or a new one. */
    claimCheck(request: ClaimCheckRequest): Promise<ClaimCheckResult> {
      const early = started.size === 0 ? undefined : started.get(requestKey(request))?.shift();
      if (!early) return claimCheck(request);
      // The run's time limit stops it as it would the check the run sends.
      request.signal.addEventListener("abort", () => early.stop.abort(), { once: true });
      // A reply is the run's as it comes, not as the check settles: a run stopped or timed out
      // meanwhile has already recorded the claim (#2909).
      early.taken = () => heardThrough(request.model);
      if (early.replied()) early.taken();
      return early.result;
    },
    /** Stops every early check the run didn't take. */
    drop(): void {
      for (const each of started.values()) for (const early of each) drop(early);
      started.clear();
    },
  };
}

export async function runChecks(
  options: RunChecksOptions,
  run: ChecksRun & {
    queued: readonly QueuedClaim[];
    /** The limit on checks at once, when the run shares it with checks started before it. */
    slots?: Slots;
  },
): Promise<{ checked: number; stop: RunStop | null }> {
  const { mindId, prepared, signal } = run;
  const write = (
    id: string,
    change: (check: ClaimCheckAttributes, blocks: Y.XmlFragment) => ClaimCheckAttributes,
  ) => {
    if (signal.aborted) return false;
    const kept = options.content.edit(mindId, (blocks) =>
      updateCheck(blocks, id, (check) => change(check, blocks)),
    );
    if (kept) options.retainEvidence(mindId);
    return kept;
  };

  let checked = 0;
  const atOnce = claimsAtOnce(prepared);
  const limit = run.slots ?? slots(atOnce);
  const { stop, outcomeError } = await runClaimChecks(
    run.queued,
    (claim, check) =>
      check(
        (request) => checkClaim(options.claimCheck, request),
        checkRequestOf(claim, run, limit, signal),
      ),
    {
      ...checkRunOf(options, prepared, signal, mindId),
      concurrency: atOnce,
      onOutcome(claim, outcome) {
        const at = options.now().toISOString();
        if (!("result" in outcome)) {
          const landing = { withResult: options.withResult, mindId, at };
          write(claim.id, (each, blocks) =>
            notCheckedMark(each, blocks, landing, outcome.reason, outcome.detail),
          );
          return;
        }
        const { result } = outcome;
        const landed = write(claim.id, (each, blocks) =>
          options.withResult(
            each,
            result,
            at,
            blocks,
            mindId,
            claim.claim,
            claim.priorParts,
            null,
            claim.previous,
          ),
        );
        if (landed && result.verdict !== "not-checked") checked++;
      },
    },
  );
  if (outcomeError !== null) {
    console.error(`A mark for Note ${mindId} couldn't be written:`, outcomeError.error);
    throw outcomeError.error;
  }
  return { checked, stop };
}
