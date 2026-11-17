/**
 * How a figure an Answer worked out was worked out (its saved calculation, an Analysis's label,
 * rows and code) goes to the model only on a check whose consent covers "worked-figures". The
 * contradiction watch's doesn't: there such a figure is sent as its shown number alone, and reads
 * Not checked until the User runs Check.
 */
import { aggregateFigureResults } from "../../../shared/figureChecks";
import type { CheckFigure, DataKind, FigureCheckResult } from "../../api";
import type { AtomicClaimCheckResult, ClaimCheckRequest } from "./claimCheck";

const sendsWorking = (request: Pick<ClaimCheckRequest, "sends">): boolean =>
  request.sends === undefined || request.sends.includes("worked-figures" satisfies DataKind);

const hasWorking = (figure: CheckFigure): boolean =>
  figure.calculated !== null || figure.analysisRecord !== undefined;

/** The figures as the request's model may be sent them: without their working when it may not. */
export function figuresAsSent(
  request: Pick<ClaimCheckRequest, "sends" | "figures">,
): CheckFigure[] | undefined {
  if (!request.figures || sendsWorking(request)) return request.figures?.slice();
  return request.figures.map(({ analysisRecord: _record, ...figure }) => ({
    ...figure,
    calculated: null,
  }));
}

/** Each figure whose working wasn't sent reads Not checked, never Supported or Unsupported. */
export function withWorkingUnsent(
  request: Pick<ClaimCheckRequest, "sends">,
  result: AtomicClaimCheckResult,
): AtomicClaimCheckResult {
  const { figures, remainder } = result;
  if (sendsWorking(request) || !figures?.some(hasWorking)) return result;
  const rows = figures.map((figure): FigureCheckResult => {
    if (!hasWorking(figure)) return figure;
    const { named: _named, statedUnit: _unit, sourceFooting: _footing, result, ...rest } = figure;
    return {
      ...rest,
      source: null,
      sourceInput: null,
      roundedFrom: null,
      difference: null,
      footing: [],
      result: {
        verdict: "not-checked",
        reason: "working-not-sent",
        detail: null,
        versions: result.versions,
        excluded: result.excluded,
      },
    };
  });
  return { ...aggregateFigureResults(rows, remainder), figures: rows, remainder };
}
