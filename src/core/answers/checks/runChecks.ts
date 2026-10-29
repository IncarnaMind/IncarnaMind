import type * as Y from "yjs";
import { settleFigureCheck } from "../../../shared/figureChecks";
/**
 * Checks claims already marked "checking", for Verify (#97) and Check this
 * Mind (#737): a cloud model six at a time, one on this computer one at a
 * time, each result written onto its mark as it comes. The monthly cap or a
 * plan's limit stops the run, and the claims left say why they weren't checked.
 */
import type {
  ClaimCheckAttributes,
  ClaimCheckResult,
  RecordAiUseInput,
  RunStop,
  ThirdPartyReason,
} from "../../api";
import type { MindContent } from "../../mindContent";
import type { PreparedChatModel } from "../../providers/chat";
import type { RecordCitePlace } from "../../recordCites/referents";
import { RunItemError, runItems } from "../../runs/stop";
import { type ClaimCheckRequest, recordJudged, runFailureOf } from "./claimCheck";
import { updateCheck } from "./sentences";

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
  context: string;
  cited?: ClaimCheckRequest["cited"];
  figures?: ClaimCheckRequest["figures"];
  /** The sentence as the Note has it, and where it starts there, for its record cites. */
  recordClaim?: string;
  place?: RecordCitePlace;
  /** Where it is checked, when not where the run's other claims are. */
  scope?: ClaimCheckRequest["scope"];
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
  ): ClaimCheckAttributes;
  /** Keeps the text of the evidence the Mind's checks show (#79). */
  retainEvidence(mindId: string): void;
  recordAiUse(inputs: RecordAiUseInput[]): void;
  now(): Date;
}

export async function runChecks(
  options: RunChecksOptions,
  run: {
    mindId: string;
    queued: readonly QueuedClaim[];
    scope: ClaimCheckRequest["scope"];
    prepared: PreparedChatModel;
    thirdParty?: readonly ThirdPartyReason[];
    signal: AbortSignal;
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
    (check: ClaimCheckAttributes): ClaimCheckAttributes =>
      settleFigureCheck(check, (basis) => ({
        ...basis,
        state: "not-checked",
        reason,
        detail,
        checkedAt: options.now().toISOString(),
      }));

  let checked = 0;
  const { stop } = await runItems(
    run.queued,
    async (claim) => {
      const result = await options.claimCheck({
        claim: claim.claim,
        context: claim.context,
        ...(claim.cited && { cited: claim.cited }),
        ...(claim.figures && { figures: claim.figures }),
        scope: claim.scope ?? run.scope,
        model: prepared,
        ...(run.thirdParty && { thirdParty: run.thirdParty }),
        mindId,
        ...(claim.recordClaim !== undefined && { recordClaim: claim.recordClaim }),
        ...(claim.place && { place: claim.place }),
        cacheKey: mindId,
        signal,
      });
      const failure = runFailureOf(result);
      if (failure) throw new RunItemError(failure);
      return result;
    },
    {
      concurrency: claimsAtOnce(prepared),
      signal,
      onOutcome(claim, outcome) {
        if (outcome.status === "done") {
          const at = options.now().toISOString();
          if (outcome.value.verdict !== "not-checked") checked++;
          recordJudged(options.recordAiUse, mindId, prepared, outcome.value, at);
          write(claim.id, (each, blocks) =>
            options.withResult(each, outcome.value, at, blocks, mindId),
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
