import type {
  CheckFigure,
  ClaimCheckAttributes,
  ClaimCheckBasis,
  ClaimCheckPart,
  ClaimJudgment,
  FigureCheckAttributes,
  FigureCheckResult,
  FigureFinding,
  FigureLocator,
  FigureSourceFooting,
} from "../core/api";
import { isRecord } from "../core/errors";
import {
  MAX_INPUTS_PER_FIGURE,
  readCalculatedFigureAttributes,
  readCalculationUnit,
  readFigureCitation,
  readFigureInput,
} from "./calculatedFigures";
import type { ClaimCheckShown } from "./claimChecks";
import { checkWithParts, figuresByPart, partWithResult, pendingPart } from "./claimParts";
import type { FigureFooting } from "./figureFooting";
import type { Ambiguity, Figure, Reading } from "./figures";
import type { InlineTextProjection } from "./inlineText";

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const index = (value: unknown): value is number =>
  finite(value) && Number.isSafeInteger(value) && value >= 0;
const named = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const optionalText = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const optionalNumber = (value: unknown): value is number | null => value === null || finite(value);

function readingOf(value: unknown): Reading | null {
  if (!isRecord(value)) return null;
  const unit = readCalculationUnit(value.unit);
  if (
    !unit ||
    unit.kind === "rate" ||
    unit.kind === "ratio" ||
    unit.kind === "yes-no" ||
    !finite(value.value) ||
    !finite(value.scale) ||
    value.scale <= 0 ||
    !optionalText(value.scaleWord) ||
    !index(value.decimals) ||
    (value.precision !== undefined &&
      value.precision !== null &&
      (!finite(value.precision) || value.precision <= 0))
  )
    return null;
  return {
    value: value.value,
    scale: value.scale,
    scaleWord: value.scaleWord,
    unit,
    decimals: value.decimals,
    ...(value.precision !== undefined && { precision: value.precision }),
  };
}

function figureOf(value: unknown): Figure | null {
  const reading = readingOf(value);
  if (
    !reading ||
    !isRecord(value) ||
    !index(value.start) ||
    !index(value.end) ||
    value.end <= value.start ||
    !named(value.chars) ||
    !optionalText(value.currency) ||
    typeof value.approximate !== "boolean" ||
    !optionalNumber(value.rangeTo) ||
    !optionalText(value.footnote) ||
    !Array.isArray(value.ambiguous)
  )
    return null;
  const ambiguous: Ambiguity[] = [];
  const kinds: Ambiguity["kind"][] = ["separator", "currency", "scale", "sign", "range", "points"];
  for (const item of value.ambiguous) {
    if (!isRecord(item) || !Array.isArray(item.readings)) return null;
    const kind = kinds.find((kind) => kind === item.kind);
    const readings = item.readings.map(readingOf);
    if (!kind || readings.length === 0 || readings.some((item) => item === null)) return null;
    ambiguous.push({ kind, readings: readings.filter((item): item is Reading => item !== null) });
  }
  return {
    ...reading,
    start: value.start,
    end: value.end,
    chars: value.chars,
    currency: value.currency,
    approximate: value.approximate,
    rangeTo: value.rangeTo,
    footnote: value.footnote,
    ambiguous,
  };
}

function locatorOf(value: unknown): FigureLocator | null {
  if (!isRecord(value)) return null;
  if (value.kind === "chart")
    return named(value.blockId) && index(value.row) && index(value.series)
      ? { kind: "chart", blockId: value.blockId, row: value.row, series: value.series }
      : null;
  if (
    value.kind !== "text" ||
    !isRecord(value.from) ||
    !isRecord(value.to) ||
    !named(value.from.blockId) ||
    value.to.blockId !== value.from.blockId ||
    !index(value.from.offset) ||
    !index(value.to.offset) ||
    value.to.offset <= value.from.offset
  )
    return null;
  return {
    kind: "text",
    from: { blockId: value.from.blockId, offset: value.from.offset },
    to: { blockId: value.from.blockId, offset: value.to.offset },
  };
}

function footingOf(value: unknown): FigureFinding["footing"][number] | null {
  if (
    !isRecord(value) ||
    !named(value.id) ||
    (value.axis !== "row" && value.axis !== "column") ||
    !Array.isArray(value.componentIds) ||
    !value.componentIds.every(named) ||
    !Array.isArray(value.excludedIds) ||
    !value.excludedIds.every(named) ||
    !optionalNumber(value.sum) ||
    !optionalNumber(value.difference) ||
    !(value.agrees === null || typeof value.agrees === "boolean")
  )
    return null;
  const roles: FigureFooting["role"][] = ["subtotal", "total", "grand-total"];
  const failures: NonNullable<FigureFooting["inability"]>[] = [
    "missing-figure",
    "unsettled-figure",
    "no-components",
    "calculation",
    "precision",
  ];
  const role = roles.find((role) => role === value.role);
  const inability = failures.find((kind) => kind === value.inability);
  if (!role || (value.inability !== undefined && !inability)) return null;
  return {
    id: value.id,
    axis: value.axis,
    role,
    componentIds: [...value.componentIds],
    excludedIds: [...value.excludedIds],
    sum: value.sum,
    difference: value.difference,
    agrees: value.agrees,
    ...(inability && { inability }),
  };
}

export function readFigureFinding(value: unknown): FigureFinding | null {
  if (
    !isRecord(value) ||
    !named(value.id) ||
    !optionalNumber(value.roundedFrom) ||
    !optionalNumber(value.difference)
  )
    return null;
  if (
    !Array.isArray(value.footing) ||
    value.footing.length > 2 ||
    (value.sourceFooting !== undefined &&
      (!Array.isArray(value.sourceFooting) || value.sourceFooting.length > 2))
  )
    return null;
  if (
    (value.context !== undefined && typeof value.context !== "string") ||
    (value.label !== undefined && typeof value.label !== "string")
  )
    return null;
  const locator = locatorOf(value.locator);
  const reading = figureOf(value.reading);
  const calculated =
    value.calculated === null ? null : readCalculatedFigureAttributes(value.calculated);
  const sourceInput = value.sourceInput === null ? null : readFigureInput(value.sourceInput);
  const source = value.source == null ? null : readFigureCitation(value.source);
  const readFooting = value.footing.map(footingOf);
  const footing = readFooting.flatMap((item) => (item ? [item] : []));
  const readSourceFooting = Array.isArray(value.sourceFooting)
    ? value.sourceFooting.map(sourceFootingOf)
    : [];
  const sourceFooting = readSourceFooting.flatMap((item) => (item ? [item] : []));
  if (
    !locator ||
    !reading ||
    (value.calculated !== null && !calculated) ||
    (value.sourceInput !== null && !sourceInput) ||
    (value.source != null && !source) ||
    footing.length !== readFooting.length ||
    footing.some((item) => item.id !== value.id) ||
    new Set(footing.map((item) => item.axis)).size !== footing.length
  )
    return null;
  if (
    sourceFooting.length !== readSourceFooting.length ||
    new Set(sourceFooting.map((item) => item.axis)).size !== sourceFooting.length ||
    sourceFooting.reduce((count, item) => count + item.inputs.length, 0) > MAX_INPUTS_PER_FIGURE ||
    sourceFooting.some((item) => !footing.some((axis) => axis.axis === item.axis))
  )
    return null;
  return {
    id: value.id,
    locator,
    reading,
    calculated,
    sourceInput,
    ...(value.source !== undefined && { source }),
    roundedFrom: value.roundedFrom,
    difference: value.difference,
    footing,
    ...(value.sourceFooting !== undefined && { sourceFooting }),
    ...(typeof value.context === "string" && { context: value.context }),
    ...(typeof value.label === "string" && { label: value.label }),
  };
}

function sourceFootingOf(value: unknown): FigureSourceFooting | null {
  if (
    !isRecord(value) ||
    (value.axis !== "row" && value.axis !== "column") ||
    !Array.isArray(value.componentIds) ||
    !value.componentIds.every(named) ||
    !Array.isArray(value.inputs) ||
    value.inputs.length > MAX_INPUTS_PER_FIGURE ||
    !optionalNumber(value.sum) ||
    !(value.agrees === null || typeof value.agrees === "boolean")
  )
    return null;
  const inputs = value.inputs.map(readFigureInput);
  if (inputs.some((input) => input === null)) return null;
  return {
    axis: value.axis,
    componentIds: [...value.componentIds],
    inputs: inputs.filter((input): input is NonNullable<typeof input> => input !== null),
    sum: value.sum,
    agrees: value.agrees,
  };
}

/** Missing remainder is not evidence that the sentence has no other assertion. */
export function aggregateFigureStates(
  figures: readonly ClaimCheckShown[],
  remainder: ClaimCheckShown | null | undefined,
): ClaimCheckShown {
  if (figures.length === 0) return { state: "not-checked", reason: "malformed" };
  const all = [...figures, ...(remainder ? [remainder] : [])];
  for (const state of [
    "contradicted",
    "unsupported",
    "needs-recheck",
    "checking",
    "not-checked",
  ] as const) {
    const found = all.find((each) => each.state === state);
    if (found) return found;
  }
  if (remainder === undefined) return { state: "not-checked", reason: "malformed" };
  return all.length > 0 && all.every((each) => each.state === "kept")
    ? { state: "kept" }
    : { state: "supported" };
}

export function figureProblem(figure: FigureFinding): "doesnt-add-up" | "quote-not-found" | null {
  if (figure.footing.some((axis) => axis.agrees === false)) return "doesnt-add-up";
  if (
    (figure.sourceInput?.citation ?? figure.source)?.check === "not-found" ||
    figure.sourceInput?.unitStatement?.citation.check === "not-found"
  )
    return "quote-not-found";
  return null;
}

export function aggregateFigureResults(
  figures: readonly FigureCheckResult[],
  remainder: ClaimJudgment | null | undefined,
): ClaimJudgment {
  const shown = (result: ClaimJudgment): ClaimCheckShown =>
    result.kept
      ? { state: "kept" }
      : result.verdict === "not-checked"
        ? { state: "not-checked", reason: result.reason }
        : { state: result.verdict };
  const summary = aggregateFigureStates(
    figures.map((figure) =>
      !figure.result.kept &&
      figureProblem(figure) !== null &&
      figure.result.verdict !== "contradicted"
        ? { state: "unsupported" }
        : shown(figure.result),
    ),
    remainder ? shown(remainder) : remainder,
  );
  const all = [...figures.map((figure) => figure.result), ...(remainder ? [remainder] : [])];
  const versions = [
    ...new Map(
      all
        .flatMap((result) => result.versions)
        .map((version) => [`${version.documentId}\n${version.contentHash}`, version]),
    ).values(),
  ];
  const excluded = [
    ...new Map(
      all
        .flatMap((result) => result.excluded)
        .map((item) => [`${item.documentId}\n${item.reason}`, item]),
    ).values(),
  ];
  const selected = all.find((result) => !result.kept && result.verdict === summary.state);
  if (selected) return { ...selected, versions, excluded };
  if (summary.state === "kept")
    return {
      verdict: "supported",
      kept: true,
      evidence: null,
      says: null,
      unsupported: null,
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
      versions,
      excluded,
    };
  if (summary.state === "unsupported") {
    const total = figures.find((figure) => figureProblem(figure) !== null);
    return {
      verdict: "unsupported",
      evidence: total?.sourceInput?.citation ?? total?.source ?? null,
      says: null,
      unsupported: { reason: null, covered: null, uncovered: null, found: true },
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
      versions,
      excluded,
    };
  }
  return {
    verdict: "not-checked",
    reason: summary.state === "not-checked" ? summary.reason : "malformed",
    detail: null,
    versions,
    excluded,
  };
}

export function emptyFigureFinding(figure: CheckFigure): FigureFinding {
  return {
    id: figure.id,
    locator: figure.locator,
    reading: figure.reading,
    calculated: figure.calculated,
    ...(figure.context !== undefined && { context: figure.context }),
    ...(figure.label !== undefined && { label: figure.label }),
    sourceInput: null,
    roundedFrom: null,
    difference: null,
    footing: [],
  };
}

export function beginFigureCheck(
  previous: ClaimCheckAttributes | null,
  basis: ClaimCheckBasis,
  figures: readonly CheckFigure[],
  selected: ReadonlySet<string> | null,
  projection?: InlineTextProjection,
): ClaimCheckAttributes {
  if (basis.parts) {
    const plans = basis.parts;
    const owned = figuresByPart(basis.text, plans, figures, projection);
    if (!owned)
      return checkWithParts(
        basis,
        plans.map((part) =>
          partWithResult(part, {
            verdict: "not-checked",
            reason: "malformed",
            detail: null,
            versions: [],
            excluded: [],
          }),
        ),
      );
    const parts = plans.map((plan, index): ClaimCheckPart => {
      const previousPart = previous?.parts?.find(
        (part) =>
          part.kind === plan.kind &&
          part.span.start === plan.span.start &&
          part.span.end === plan.span.end,
      );
      const current = previousPart ?? plan;
      const occurrences = owned[index] ?? [];
      if (selected && !occurrences.some((figure) => selected.has(figure.id))) return current;
      if (plan.verdict !== "checking" && selected === null) return current;
      if (plan.kind === "opinion" && plan.verdict === null && selected === null)
        return pendingPart(plan);
      if (!occurrences.length)
        return selected ? current : { ...pendingPart(plan), verdict: "checking" };
      const native = occurrences.map((figure) => {
        const old = current.figures?.find((child) => child.id === figure.id);
        if (selected && !selected.has(figure.id) && old) return old;
        return {
          ...emptyFigureFinding(figure),
          result: { verdict: "checking" as const, versions: [], excluded: [] },
        };
      });
      return {
        ...pendingPart(plan),
        verdict: "checking",
        figures: native,
        ...(selected
          ? current.remainder !== undefined && { remainder: current.remainder }
          : { remainder: { verdict: "checking", versions: [], excluded: [] } }),
      };
    });
    return checkWithParts(basis, parts);
  }
  const initial: ClaimCheckAttributes = previous ?? basis;
  const { figures: _figures, remainder: _remainder, ...old } = initial;
  const { kept: _kept, ...current } = basis;
  const pending = { ...current, state: "checking" as const };
  return {
    ...pending,
    figures: figures.map((figure): FigureCheckAttributes => {
      if (selected === null || selected.has(figure.id))
        return { ...pending, ...emptyFigureFinding(figure), id: figure.id };
      const sibling = previous?.figures?.find((child) => child.id === figure.id);
      return sibling
        ? { ...sibling, ...(previous?.kept && { kept: true }) }
        : {
            ...old,
            ...emptyFigureFinding(figure),
            id: figure.id,
            state: "not-checked",
            reason: "unread",
            ...(previous?.kept && { kept: true }),
          };
    }),
    ...(selected === null
      ? { remainder: { ...pending, id: `${basis.id}:remainder` } }
      : previous?.kept
        ? { remainder: { ...old, kept: true } }
        : previous?.remainder !== undefined
          ? { remainder: previous.remainder }
          : {}),
  };
}

export function settleFigureCheck(
  check: ClaimCheckAttributes,
  settle: (basis: ClaimCheckBasis) => ClaimCheckBasis,
): ClaimCheckAttributes {
  if (check.parts) {
    if (
      !check.parts.some(
        (part) =>
          part.verdict === "checking" ||
          part.figures?.some((figure) => figure.result.verdict === "checking") ||
          part.remainder?.verdict === "checking",
      )
    )
      return check;
    const settled = settle(check);
    const failure = {
      verdict: "not-checked" as const,
      reason: settled.reason ?? "failed",
      detail: settled.detail,
      versions: settled.versions,
      excluded: settled.excluded,
    };
    const parts = check.parts.map(
      (part): ClaimCheckPart => ({
        ...part,
        ...(part.verdict === "checking" && {
          verdict: "not-checked",
          reason: failure.reason,
          detail: failure.detail,
        }),
        ...(part.figures && {
          figures: part.figures.map((figure) =>
            figure.result.verdict === "checking" ? { ...figure, result: failure } : figure,
          ),
        }),
        ...(part.remainder?.verdict === "checking" && { remainder: failure }),
      }),
    );
    return checkWithParts(settled, parts);
  }
  const pending = (basis: ClaimCheckBasis) =>
    basis.request === check.request && basis.state === "checking" ? settle(basis) : basis;
  return {
    ...pending(check),
    ...(check.figures && {
      figures: check.figures.map((figure) => ({ ...figure, ...pending(figure) })),
    }),
    ...(check.remainder !== undefined && {
      remainder: check.remainder === null ? null : pending(check.remainder),
    }),
  };
}
