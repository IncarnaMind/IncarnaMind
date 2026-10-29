import {
  figuresByPart,
  partWithResult,
  pendingPart,
  readPartPlans,
  resultFromParts,
} from "../../../shared/claimParts";
import { emptyFigureFinding } from "../../../shared/figureChecks";
import type {
  ClaimCheckFailure,
  ClaimCheckPart,
  ClaimCheckResult,
  ClaimPartPlan,
  ClaimPartSpan,
} from "../../api";
import {
  type ClaimCheckDependencies,
  type ClaimCheckRequest,
  createClaimCheck,
  failureOf,
} from "./claimCheck";
import { claimsAmong } from "./findClaims";

const sameSpan = (a: ClaimPartSpan, b: ClaimPartSpan) => a.start === b.start && a.end === b.end;

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
    const parts: ClaimCheckPart[] = [];
    let stopped: { reason: ClaimCheckFailure; detail: string | null } | null = null;
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
      if (request.signal.aborted) stopped = { reason: "stopped", detail: null };
      if (stopped) {
        parts.push(
          partWithResult(plan, { verdict: "not-checked", ...stopped, versions: [], excluded: [] }),
        );
        continue;
      }
      const result = await atomic({
        ...request,
        claim: request.claim.slice(plan.span.start, plan.span.end),
        figures: figures.length ? figures : undefined,
        projection: undefined,
        originalClaim: request.originalClaim ?? request.claim,
        context: [request.context, request.claim].filter(Boolean).join("\n\n"),
      });
      if (request.figureIds && previous?.figures && result.figures) {
        const incoming = new Map(result.figures.map((figure) => [figure.id, figure]));
        const kept = allFigures.map(
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
        );
        const merged = {
          ...partWithResult(plan, result, result.checkedEvidence, result.coverage),
          figures: kept,
          ...(previous.remainder !== undefined && { remainder: previous.remainder }),
        };
        parts.push(merged);
      } else {
        parts.push(partWithResult(plan, result, result.checkedEvidence, result.coverage));
      }
      if (
        result.verdict === "not-checked" &&
        [
          "stopped",
          "failed",
          "rate-limit",
          "cost-cap",
          "plan-limit",
          "out-of-credit",
          "consent-revoked",
          "local-mode",
        ].includes(result.reason)
      ) {
        stopped = { reason: result.reason, detail: result.detail };
      }
    }
    return resultFromParts(parts);
  };
}
