import {
  figuresByPart,
  partWithResult,
  pendingPart,
  readPartPlans,
  resultFromParts,
  withFigureFacts,
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
import { readPartsLine } from "./claims";
import { claimsAmong } from "./findClaims";
import { claimsAtOnce } from "./runChecks";

const sameSpan = (a: ClaimPartSpan, b: ClaimPartSpan) => a.start === b.start && a.end === b.end;

type Sorted = { plans: readonly ClaimPartPlan[] } | { failed: ClaimCheckResult };

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
    const limit = request.slots ?? slots(claimsAtOnce(request.model));
    const withFigures = (found: readonly ClaimPartPlan[]) =>
      withFigureFacts(request.claim, found, request.figures ?? [], request.projection);
    const sortAlone = async (): Promise<Sorted> => {
      const sorted = await limit.run(() =>
        claimsAmong(request.model, [request.claim], "own", request.signal),
      );
      if (sorted.kind === "cancelled") return { failed: failed("stopped") };
      if (sorted.kind === "failed") {
        const failure = failureOf(sorted.error);
        return { failed: failed(failure.reason, failure.detail) };
      }
      const found = sorted.parts.get(0);
      return sorted.undecided.has(0) || found === undefined
        ? { failed: failed("malformed") }
        : { plans: withFigures(found) };
    };
    const opinionsChecked = request.parts === undefined && !request.opinionsLeftOut;
    // A first turn's Run checks the whole sentence, so its result is one part's only when that
    // part is the sentence, but for the spaces and punctuation around it: one fact, or the one
    // opinion the User asked to check. A shorter part is checked on its own words.
    const isSentence = ({ start, end }: ClaimPartSpan) =>
      /^[\s\p{P}]*$/u.test(request.claim.slice(0, start) + request.claim.slice(end));
    const whole = (found: readonly ClaimPartPlan[]): ClaimPartPlan | null => {
      const [only, ...more] = found;
      if (more.length > 0) return null;
      if (!only) return opinionsChecked ? { ...full, kind: "opinion" } : null;
      if (only.kind === "opinion" && !opinionsChecked) return null;
      return isSentence(only.span) ? only : null;
    };
    if (
      plans === undefined &&
      request.figureIds === undefined &&
      request.only === undefined &&
      request.previous === undefined
    ) {
      // The Run names the sentence's parts in its first turn, so a sentence of one fact costs no
      // sorting request and goes on as its own check (#1635). Any other stops there, before its
      // next request, and is checked part by part. A Run whose line can't be read goes on, and its
      // sentence is sorted after it, as before parts were named in the check; one that names no
      // part checks the sentence whole, as a sentence the User or a Citation put up to check is.
      const run = new AbortController();
      const heard: { plans?: readonly ClaimPartPlan[] | null } = {};
      const result = await limit.run(() =>
        atomic({
          ...request,
          signal: AbortSignal.any([request.signal, run.signal]),
          findParts: (text) => {
            const named = readPartsLine(text, request.claim);
            if (named?.length === 0) return;
            heard.plans = named && withFigures(named);
            if (heard.plans && whole(heard.plans) === null) run.abort();
          },
        }),
      );
      if (request.signal.aborted) return failed("stopped");
      if (heard.plans === undefined) return resultFromParts([partWithResult(full, result)]);
      let found = heard.plans;
      if (found === null) {
        const sorted = await sortAlone();
        if (!("plans" in sorted)) return sorted.failed;
        found = sorted.plans;
      }
      const plan = whole(found);
      if (plan && !run.signal.aborted)
        return resultFromParts([
          partWithResult(plan, result, result.checkedEvidence, result.coverage),
        ]);
      plans = found;
    }
    if (plans === undefined) {
      const sorted = await sortAlone();
      if (!("plans" in sorted)) return sorted.failed;
      plans = sorted.plans;
    }
    if (plans.length === 0 && opinionsChecked) plans = [{ ...full, kind: "opinion" }];
    plans = withFigures(plans);
    // What the User didn't ask about leaves its opinions out, as Check this Note does.
    if (request.opinionsLeftOut && !plans.some((part) => part.kind === "fact"))
      return {
        verdict: "not-checked",
        reason: "empty",
        detail: null,
        versions: [],
        excluded: [],
        parts: plans.map(pendingPart),
      };
    const forcedOpinion = opinionsChecked && plans.every((part) => part.kind === "opinion");
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
    // Parts are checked at once, within the run's limit; a failure that stops the run leaves the
    // parts not started yet not checked, for its reason.
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
