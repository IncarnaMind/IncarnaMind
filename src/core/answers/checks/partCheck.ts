import {
  figuresByPart,
  partWithResult,
  pendingPart,
  readPartPlans,
  resultFromParts,
} from "../../../shared/claimParts";
import { emptyFigureFinding } from "../../../shared/figureChecks";
import type {
  CheckFigure,
  ClaimCheckFailure,
  ClaimCheckPart,
  ClaimCheckResult,
  ClaimPartPlan,
  ClaimPartSpan,
} from "../../api";
import { slots } from "../../runs/stop";
import {
  type AtomicClaimCheckResult,
  type ClaimCheckDependencies,
  type ClaimCheckRequest,
  createClaimCheck,
  failureOf,
} from "./claimCheck";
import { claimsAmong } from "./findClaims";
import { claimsAtOnce } from "./runChecks";

const sameSpan = (a: ClaimPartSpan, b: ClaimPartSpan) => a.start === b.start && a.end === b.end;

const STOPS: readonly ClaimCheckFailure[] = [
  "stopped",
  "failed",
  "rate-limit",
  "cost-cap",
  "plan-limit",
  "out-of-credit",
  "consent-revoked",
  "local-mode",
];

/** A check of some of a part's figures keeps its other figures as they were. */
function checkedPart(
  plan: ClaimPartPlan,
  result: AtomicClaimCheckResult,
  previous: ClaimCheckPart | undefined,
  figures: readonly CheckFigure[],
  figureIds: readonly string[] | undefined,
): ClaimCheckPart {
  const part = partWithResult(plan, result, result.checkedEvidence, result.coverage);
  if (!figureIds || !previous?.figures || !result.figures) return part;
  const incoming = new Map(result.figures.map((figure) => [figure.id, figure]));
  return {
    ...part,
    figures: figures.map(
      (figure) =>
        incoming.get(figure.id) ??
        previous.figures?.find((old) => old.id === figure.id) ?? {
          ...emptyFigureFinding(figure),
          result: {
            verdict: "not-checked" as const,
            reason: "unread" as const,
            detail: null,
            versions: [],
            excluded: [],
          },
        },
    ),
    ...(previous.remainder !== undefined && { remainder: previous.remainder }),
  };
}

export function createPartCheck(deps: ClaimCheckDependencies) {
  const atomic = createClaimCheck(deps);
  return async (request: ClaimCheckRequest): Promise<ClaimCheckResult> => {
    const full: ClaimPartPlan = { kind: "fact", span: { start: 0, end: request.claim.length } };
    const failed = (reason: ClaimCheckFailure, detail: string | null = null): ClaimCheckResult => {
      const result: ClaimCheckResult = {
        verdict: "not-checked",
        reason,
        detail,
        versions: [],
        excluded: [],
      };
      return { ...result, parts: request.claim.length > 0 ? [partWithResult(full, result)] : [] };
    };
    if (request.signal.aborted) return failed("stopped");
    if (request.claim.trim() === "") return failed("empty");
    let plans: readonly ClaimPartPlan[] | null | undefined =
      request.parts === undefined ? undefined : readPartPlans(request.parts, request.claim);
    if (plans === null) return failed("malformed");
    if (request.projection && request.projection.text !== request.claim) return failed("malformed");
    if (
      plans === undefined &&
      request.figures?.length &&
      request.figures.every((figure) => figure.locator.kind === "chart")
    )
      plans = [full];
    if (plans === undefined) {
      const sorted = await claimsAmong(request.model, [request.claim], "own", request.signal);
      if (sorted.kind === "cancelled") return failed("stopped");
      if (sorted.kind === "failed") {
        const failure = failureOf(sorted.error);
        return failed(failure.reason, failure.detail);
      }
      plans = sorted.parts.get(0);
      if (sorted.undecided.has(0) || plans === undefined) return failed("malformed");
      if (plans.length === 0) plans = [{ ...full, kind: "opinion" }];
    }
    const forcedOpinion =
      request.parts === undefined && plans.every((part) => part.kind === "opinion");
    if (request.only && !plans.some((part) => sameSpan(part.span, request.only ?? full.span)))
      return failed("malformed");
    const owned = figuresByPart(request.claim, plans, request.figures ?? [], request.projection);
    if (!owned) return failed("malformed");
    if (request.figureIds?.some((id) => !request.figures?.some((figure) => figure.id === id)))
      return failed("malformed");
    const parts: (ClaimCheckPart | null)[] = [];
    const checks: {
      index: number;
      plan: ClaimPartPlan;
      figures: CheckFigure[];
      previous: ClaimCheckPart | undefined;
    }[] = [];
    for (const [index, plan] of plans.entries()) {
      const previous = request.previous?.find(
        (part) => part.kind === plan.kind && sameSpan(part.span, plan.span),
      );
      const allFigures = owned[index] ?? [];
      const figures = request.figureIds
        ? allFigures.filter((figure) => request.figureIds?.includes(figure.id))
        : allFigures;
      const selected =
        (request.only !== undefined && sameSpan(plan.span, request.only)) ||
        (request.figureIds !== undefined && figures.length > 0);
      if (
        (request.only && !selected) ||
        (request.figureIds && !figures.some((figure) => request.figureIds?.includes(figure.id)))
      ) {
        parts.push(
          previous ??
            (plan.kind === "opinion"
              ? pendingPart(plan)
              : partWithResult(plan, {
                  verdict: "not-checked",
                  reason: "empty",
                  detail: null,
                  versions: [],
                  excluded: [],
                })),
        );
        continue;
      }
      if (
        plan.kind === "opinion" &&
        !selected &&
        !forcedOpinion &&
        (previous === undefined || previous.verdict === null)
      ) {
        parts.push(pendingPart(plan));
        continue;
      }
      parts.push(null);
      checks.push({ index, plan, figures, previous });
    }
    // Parts are checked at once, within the run's limit (`claimsAtOnce`); a failure that stops the
    // run leaves the parts not started yet not checked, for its reason.
    const limit = request.slots ?? slots(claimsAtOnce(request.model));
    let stopped: { reason: ClaimCheckFailure; detail: string | null } | null = null;
    await Promise.all(
      checks.map(({ index, plan, figures, previous }) =>
        limit.run(async () => {
          if (request.signal.aborted) stopped ??= { reason: "stopped", detail: null };
          if (stopped) {
            parts[index] = partWithResult(plan, {
              verdict: "not-checked",
              ...stopped,
              versions: [],
              excluded: [],
            });
            return;
          }
          const result = await atomic({
            ...request,
            claim: request.claim.slice(plan.span.start, plan.span.end),
            figures: figures.length ? figures : undefined,
            projection: undefined,
            originalClaim: request.originalClaim ?? request.claim,
            context: [request.context, request.claim].filter(Boolean).join("\n\n"),
          });
          parts[index] = checkedPart(plan, result, previous, owned[index] ?? [], request.figureIds);
          if (result.verdict === "not-checked" && STOPS.includes(result.reason)) {
            stopped ??= { reason: result.reason, detail: result.detail };
          }
        }),
      ),
    );
    return resultFromParts(parts.filter((part): part is ClaimCheckPart => part !== null));
  };
}
