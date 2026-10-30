import {
  figuresByPart,
  partWithResult,
  pendingPart,
  readPartPlans,
  resultFromParts,
  sameClaimPart,
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
import { inCheck } from "./checkedText";
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
    const sentence = request.originalClaim ?? request.claim;
    const withFigures = (found: readonly ClaimPartPlan[]) =>
      found.length > 0 && found.every((plan) => plan.facet)
        ? found
        : withFigureFacts(request.claim, found, request.figures ?? [], request.projection);
    const sortAlone = async (): Promise<Sorted> => {
      const sorted = await limit.run(() =>
        inCheck({ sentence, part: null }, () =>
          claimsAmong(request.model, [request.claim], "own", request.signal),
        ),
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
      const [only, ...more] = found.filter((part) => part.facet === undefined);
      if (more.length > 0) return null;
      if (!only) return found.length === 0 && opinionsChecked ? { ...full, kind: "opinion" } : null;
      if (only.kind === "opinion" && !opinionsChecked) return null;
      if (only.kind === "fact" && found.some((part) => part.facet !== undefined)) return only;
      return isSentence(only.span) ? only : null;
    };
    const unavailable = (
      plan: ClaimPartPlan,
      result: AtomicClaimCheckResult,
      reason: ClaimCheckFailure = "malformed",
    ) =>
      partWithResult(plan, {
        verdict: "not-checked",
        reason: result.verdict === "not-checked" ? result.reason : reason,
        detail: result.verdict === "not-checked" ? result.detail : null,
        versions: result.versions,
        excluded: result.excluded,
      });
    const facetResult = (
      plan: ClaimPartPlan,
      result: AtomicClaimCheckResult,
      figures: readonly CheckFigure[] = [],
      previous?: ClaimCheckPart,
    ): ClaimCheckPart => {
      const found = result.facetParts?.find(
        (part) =>
          part.kind === plan.kind &&
          sameSpan(part.span, plan.span) &&
          part.facet?.kind === plan.facet?.kind,
      );
      if (result.verdict === "not-checked") return unavailable(found ?? plan, result);
      const semantic = found ?? unavailable(plan, result);
      const native = result.figures?.filter((figure) =>
        figures.some((own) => own.id === figure.id),
      );
      if (!native?.length) return semantic;
      const judgment = resultFromParts([semantic]);
      return checkedPart(
        semantic,
        { ...judgment, figures: native, remainder: judgment },
        previous,
        figures,
        request.figureIds,
      );
    };
    const remainderInFacet = (result: AtomicClaimCheckResult, found: readonly ClaimPartPlan[]) => {
      const text = result.remainderText;
      if (!text) return false;
      const start = request.claim.indexOf(text);
      return (
        start >= 0 &&
        request.claim.indexOf(text, start + 1) < 0 &&
        found.some(
          (plan) => plan.facet && plan.span.start <= start && plan.span.end >= start + text.length,
        )
      );
    };
    const ordinaryResult = (
      result: AtomicClaimCheckResult,
      figures: readonly CheckFigure[],
      found: readonly ClaimPartPlan[],
    ): AtomicClaimCheckResult => {
      if (!result.figures || !found.some((plan) => plan.facet)) return result;
      if (result.verdict === "not-checked")
        return {
          verdict: result.verdict,
          reason: result.reason,
          detail: result.detail,
          versions: result.versions,
          excluded: result.excluded,
        };
      const native = result.figures.filter((figure) => figures.some((own) => own.id === figure.id));
      const remainder = remainderInFacet(result, found) ? null : result.remainder;
      if (native.length > 0) return { ...result, figures: native, remainder };
      return (
        remainder ?? {
          verdict: "not-checked",
          reason: "unread",
          detail: null,
          versions: result.versions,
          excluded: result.excluded,
        }
      );
    };
    const family = (
      found: readonly ClaimPartPlan[],
      primary: ClaimPartPlan,
      result: AtomicClaimCheckResult,
    ) => {
      const rows = found.length === 0 ? [primary] : found;
      const owned = figuresByPart(request.claim, rows, request.figures ?? [], request.projection);
      if (!owned) return failed("malformed");
      return resultFromParts(
        rows.map((plan, index) =>
          plan.facet
            ? facetResult(plan, result, owned[index])
            : checkedPart(
                plan,
                ordinaryResult(result, owned[index] ?? [], rows),
                undefined,
                owned[index] ?? [],
                undefined,
              ),
        ),
      );
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
        inCheck({ sentence, part: null }, () =>
          atomic({
            ...request,
            signal: AbortSignal.any([request.signal, run.signal]),
            findParts: (text) => {
              const named = readPartsLine(text, request.claim);
              if (named?.length === 0) return;
              heard.plans = named && withFigures(named);
              if (heard.plans && whole(heard.plans) === null) run.abort();
              return heard.plans;
            },
          }),
        ),
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
      if (plan && !run.signal.aborted) return family(found, plan, result);
      plans = found;
    }
    if (plans === undefined) {
      const sorted = await sortAlone();
      if (!("plans" in sorted)) return sorted.failed;
      plans = sorted.plans;
    }
    if (plans.length === 0 && opinionsChecked) plans = [{ ...full, kind: "opinion" }];
    plans = withFigures(
      plans.map((plan) => {
        if (plan.facet?.kind !== "source" || plan.facet.selectedDocumentId !== undefined)
          return plan;
        const previous = request.previous?.find(
          (part) =>
            part.kind === plan.kind &&
            sameSpan(part.span, plan.span) &&
            part.facet?.kind === "source",
        );
        return previous?.facet?.kind === "source" && previous.facet.selectedDocumentId !== undefined
          ? {
              ...plan,
              facet: {
                ...previous.facet,
                ...plan.facet,
                selectedDocumentId: previous.facet.selectedDocumentId,
              },
            }
          : plan;
      }),
    );
    if (plans.length > 0 && plans.every((plan) => plan.facet)) {
      const offered = plans;
      const previous =
        request.previous?.filter(
          (part) => !offered.some((plan) => sameSpan(plan.span, part.span)),
        ) ?? [];
      const restored = previous.some((part) => !part.facet)
        ? readPartPlans(
            [...plans, ...previous].sort((a, b) => a.span.start - b.span.start),
            request.claim,
          )
        : null;
      if (!restored) {
        const failure = failed("malformed");
        return resultFromParts(plans.map((plan) => unavailable(plan, failure)));
      }
      plans = restored;
    }
    const planned = plans;
    const sourceContext = planned.filter(
      (plan) => plan.facet?.kind === "source" && plan.facet.selectedDocumentId !== undefined,
    );
    const primary = whole(planned);
    if (
      primary &&
      planned.some((plan) => plan.facet !== undefined) &&
      request.only === undefined &&
      request.figureIds === undefined
    ) {
      const result = await limit.run(() =>
        inCheck({ sentence, part: null }, () =>
          atomic({ ...request, parts: plans, sourceContext }),
        ),
      );
      return family(planned, primary, result);
    }
    // What the User didn't ask about leaves its opinions out, as Check this Note does.
    if (request.opinionsLeftOut && !planned.some((part) => part.kind === "fact"))
      return {
        verdict: "not-checked",
        reason: "empty",
        detail: null,
        versions: [],
        excluded: [],
        parts: planned.map(pendingPart),
      };
    const forcedOpinion = opinionsChecked && planned.every((part) => part.kind === "opinion");
    if (request.only && !planned.some((part) => sameSpan(part.span, request.only ?? full.span)))
      return failed("malformed");
    const owned = figuresByPart(request.claim, planned, request.figures ?? [], request.projection);
    if (!owned) return failed("malformed");
    if (request.figureIds?.some((id) => !request.figures?.some((figure) => figure.id === id)))
      return failed("malformed");
    const parts: (ClaimCheckPart | null)[] = [];
    const facets: { index: number; plan: ClaimPartPlan }[] = [];
    const checks: {
      index: number;
      plan: ClaimPartPlan;
      figures: CheckFigure[];
      previous: ClaimCheckPart | undefined;
    }[] = [];
    for (const [index, plan] of planned.entries()) {
      const previous = request.previous?.find((part) => sameClaimPart(part, plan));
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
      if (plan.facet) facets.push({ index, plan });
      else checks.push({ index, plan, figures, previous });
    }
    // Parts are checked at once, within the run's limit; a failure that stops the run leaves the
    // parts not started yet not checked, for its reason.
    if (checks.length === 0 && facets.length > 0)
      checks.push({ index: -1, plan: full, figures: [], previous: undefined });
    const first = checks[0];
    const writeFacets = (result: AtomicClaimCheckResult) => {
      for (const { index, plan } of facets)
        parts[index] = facetResult(
          plan,
          result,
          owned[index],
          request.previous?.find((part) => sameClaimPart(part, plan)),
        );
    };
    let stopped: { reason: ClaimCheckFailure; detail: string | null } | null = null;
    await Promise.all(
      checks.map(({ index, plan, figures, previous }) =>
        limit.run(async () => {
          if (request.signal.aborted) stopped ??= { reason: "stopped", detail: null };
          if (stopped) {
            const result: ClaimCheckResult = {
              verdict: "not-checked",
              ...stopped,
              versions: [],
              excluded: [],
            };
            if (index >= 0) parts[index] = partWithResult(plan, result);
            if (index === first?.index) writeFacets(result);
            return;
          }
          const requestedFigures =
            index === first?.index
              ? [
                  ...figures,
                  ...facets.flatMap((facet) =>
                    (owned[facet.index] ?? []).filter(
                      (figure) => !request.figureIds || request.figureIds.includes(figure.id),
                    ),
                  ),
                ]
              : figures;
          const result = await inCheck(
            {
              sentence,
              part: isSentence(plan.span)
                ? null
                : request.claim.slice(plan.span.start, plan.span.end),
            },
            () =>
              atomic({
                ...request,
                claim:
                  index < 0 ? request.claim : request.claim.slice(plan.span.start, plan.span.end),
                parts:
                  index === first?.index
                    ? planned.filter(
                        (part) =>
                          sameClaimPart(part, plan) || facets.some((facet) => facet.plan === part),
                      )
                    : [plan],
                sourceContext,
                findParts: undefined,
                figures: requestedFigures.length ? requestedFigures : undefined,
                projection: undefined,
                originalClaim: request.originalClaim ?? request.claim,
                context: [request.context, request.claim].filter(Boolean).join("\n\n"),
              }),
          );
          if (index >= 0)
            parts[index] = checkedPart(
              plan,
              ordinaryResult(result, owned[index] ?? [], planned),
              previous,
              owned[index] ?? [],
              request.figureIds,
            );
          if (index === first?.index) writeFacets(result);
          if (result.verdict === "not-checked" && STOPS.includes(result.reason)) {
            stopped ??= { reason: result.reason, detail: result.detail };
          }
        }),
      ),
    );
    return resultFromParts(parts.filter((part): part is ClaimCheckPart => part !== null));
  };
}
