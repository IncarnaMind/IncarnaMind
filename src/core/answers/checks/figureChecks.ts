import { aggregateFigureResults } from "../../../shared/figureChecks";
import { readFigures } from "../../../shared/figures";
import { evaluateFormula, showResult } from "../../../shared/formula";
import { escapedInStrings } from "../../../shared/jsonText";
import type {
  CalculatedFigure,
  CheckFigure,
  Citation,
  ClaimCheckFailure,
  ClaimCheckResult,
  ClaimJudgment,
  FigureCheckResult,
  FigureInput,
  LimitRelation,
  UnsupportedReason,
} from "../../api";
import { isRecord } from "../../errors";
import { type CalculationSession, documentFigureContext, whole } from "../calculations";
import { agreesAtShownPrecision } from "./calculated";
import { type ReadVerdict, readsAsRefusal, readVerdict } from "./prompt";

export interface FigureReplyItem extends ReadVerdict {
  id: string;
  reading: number | null;
  relation: "equals" | "at most" | "at least";
  source: {
    /** The marker of the quote recorded with cite; null when `record` gives the quote itself. */
    citation: number | null;
    record: { passage: string; location: string | null; quote: string } | null;
    /** The number as the quote writes it; `position` counts instead when the quote writes it twice. */
    number: string | null;
    position: number | null;
    reading: number | null;
    unitQuote: string | null;
  } | null;
  calculation: number | null;
}

export interface FigureReplyRemainder extends ReadVerdict {
  text: string;
  citation: number | null;
}

export interface FigureReply {
  items: FigureReplyItem[];
  remainder?: FigureReplyRemainder | null;
}

const FIGURES = /^\s*Figures:\s*(.*)$/i;
const MAX_REPLY_CHARACTERS = 100_000;
/** A one-based count or marker, read as `calculate` reads its inputs' ("3", "[^3]", {"marker":3}). */
const counted = (value: unknown): number | null => {
  const read = whole(isRecord(value) ? value.marker : value);
  return read !== null && read > 0 ? read : null;
};
/** An optional count: null when absent, undefined when it is there but no count. */
const optionalCount = (value: unknown): number | null | undefined =>
  value == null ? null : (counted(value) ?? undefined);
const optionalText = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && value.length <= 2_000);

function judgmentOf(value: unknown): ReadVerdict | null {
  if (
    !isRecord(value) ||
    !["supported", "unsupported", "contradicted"].includes(String(value.verdict)) ||
    !["same", "wider"].includes(String(value.scope)) ||
    !["found", "not found"].includes(String(value.topic)) ||
    !["same", "differs"].includes(String(value.roles)) ||
    !optionalText(value.says)
  )
    return null;
  if (
    (value.covered !== undefined && !optionalText(value.covered)) ||
    (value.uncovered !== undefined && !optionalText(value.uncovered))
  )
    return null;
  return readVerdict(JSON.stringify(value));
}

export function figureReplyText(reply: string, setAside: readonly string[]): string {
  if (reply.split(/\r?\n/).some((line) => FIGURES.test(line))) return reply;
  if (readsAsRefusal(reply) || readVerdict(reply)) return reply;
  const earlier = setAside.findLast((text) => readVerdict(text) !== null);
  return earlier?.split(/\r?\n/).some((line) => FIGURES.test(line))
    ? `${earlier}\n${reply}`
    : reply;
}

export function readFigureReply(
  reply: string,
  figures: readonly CheckFigure[],
  claim: string,
): FigureReply | null {
  if (reply.length > MAX_REPLY_CHARACTERS) return null;
  // The protocol's line is the JSON one: a model also writes "Figures: …" as prose before it.
  const line = reply
    .split(/\r?\n/)
    .flatMap((each) => FIGURES.exec(each)?.[1] ?? [])
    .findLast((rest) => rest.trimStart().startsWith("{"));
  if (line === undefined) return null;
  const end = line.lastIndexOf("}") + 1;
  if (end === 0 || !/^(?:\s*\[\^[1-9]\d{0,3}\])*\s*$/.test(line.slice(end))) return null;
  let value: unknown;
  try {
    // A quote copied from a sheet row keeps its raw tabs, as in a Tool call's input (#1827).
    value = JSON.parse(escapedInStrings(line.slice(0, end)));
  } catch {
    return null;
  }
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length !== figures.length)
    return null;
  const ids = new Set(figures.map((figure) => figure.id));
  if (ids.size !== figures.length) return null;
  const items: FigureReplyItem[] = [];
  for (const raw of value.items) {
    const judgment = judgmentOf(raw);
    const reading = isRecord(raw) ? optionalCount(raw.reading) : undefined;
    const calculation = isRecord(raw) ? optionalCount(raw.calculation) : undefined;
    if (
      !isRecord(raw) ||
      !judgment ||
      typeof raw.id !== "string" ||
      !ids.delete(raw.id) ||
      reading === undefined ||
      calculation === undefined ||
      (raw.relation !== "equals" && raw.relation !== "at most" && raw.relation !== "at least")
    )
      return null;
    let source: FigureReplyItem["source"] = null;
    if (raw.source !== null) {
      const input = raw.source;
      const unitQuote = isRecord(input) ? (input.unitQuote ?? null) : null;
      const written =
        isRecord(input) && typeof input.number === "string" && input.number.trim() !== ""
          ? input.number.trim().slice(0, 80)
          : null;
      const citation = isRecord(input) ? counted(input.citation) : null;
      // A quote given in place of its marker, as `calculate` takes one.
      const record =
        citation === null &&
        isRecord(input) &&
        typeof input.passage === "string" &&
        typeof input.quote === "string"
          ? {
              passage: input.passage,
              location: typeof input.location === "string" ? input.location : null,
              quote: input.quote,
            }
          : null;
      const position = isRecord(input) ? optionalCount(input.position) : undefined;
      const sourceReading = isRecord(input) ? optionalCount(input.reading) : undefined;
      if (
        (citation === null && record === null) ||
        position === undefined ||
        (written === null && position === null) ||
        sourceReading === undefined ||
        !optionalText(unitQuote)
      )
        return null;
      source = { citation, record, number: written, position, reading: sourceReading, unitQuote };
    }
    if (source && calculation !== null) return null;
    items.push({ ...judgment, id: raw.id, reading, relation: raw.relation, source, calculation });
  }
  if (ids.size > 0) return null;
  const parsed: FigureReply = { items };
  if (value.remainder === null) parsed.remainder = null;
  else {
    const raw = value.remainder;
    const judgment = judgmentOf(raw);
    const citation = isRecord(raw) ? optionalCount(raw.citation) : undefined;
    if (
      isRecord(raw) &&
      judgment &&
      typeof raw.text === "string" &&
      raw.text.trim() !== "" &&
      claim.includes(raw.text) &&
      citation !== undefined &&
      readFigures(raw.text, documentFigureContext([{ text: raw.text }])).length === 0
    )
      parsed.remainder = { ...judgment, text: raw.text, citation };
  }
  return parsed;
}

type Facts = Pick<ClaimJudgment, "versions" | "excluded">;
type CaseFlags = { citedCaseUnchecked: boolean; citedCaseFound: boolean };

function finding(figure: CheckFigure) {
  return {
    ...figure,
    source: null,
    sourceInput: null,
    roundedFrom: null,
    difference: null,
    footing: [],
  };
}

export function uncheckedFigureResults(
  figures: readonly CheckFigure[],
  result: ClaimJudgment,
): ClaimCheckResult {
  const rows = figures.map((figure): FigureCheckResult => ({ ...finding(figure), result }));
  return { ...aggregateFigureResults(rows, undefined), figures: rows, remainder: undefined };
}

export function figureJudgment(
  reply: ReadVerdict,
  evidence: Citation | null,
  facts: Facts,
  flags: CaseFlags,
): ClaimJudgment {
  if (
    reply.verdict === "unsupported" ||
    reply.scope !== "same" ||
    reply.roles !== "same" ||
    reply.topic !== "found"
  )
    return {
      verdict: "unsupported",
      evidence: null,
      says: null,
      unsupported: {
        reason: reply.says,
        covered: reply.covered,
        uncovered: reply.uncovered,
        ...(reply.topic === "found" && { found: true }),
      },
      calculation: null,
      ...flags,
      ...facts,
    };
  if (evidence?.check !== "found")
    return { verdict: "not-checked", reason: "no-evidence", detail: null, ...facts };
  return {
    verdict: reply.verdict,
    evidence,
    says: reply.says,
    unsupported: null,
    calculation: null,
    ...flags,
    ...facts,
  };
}

export interface FigureCheckOptions {
  requested: readonly CheckFigure[];
  claim: string;
  reply: string;
  calculations: CalculationSession;
  citation(marker: number): Citation | null;
  facts(): Facts;
  caseFlags(evidence: Citation | null): CaseFlags;
  costs(marker: number): ReadonlySet<string>;
  remainder(reply: FigureReplyRemainder): Promise<ClaimJudgment>;
  /** Why a figure's unit, currency or scale isn't backed by these Citations or their Documents (#1798). */
  unitReason(figure: string, citations: readonly Citation[]): UnsupportedReason | null;
  signal: AbortSignal;
}

function replay(target: CheckFigure, calculations: CalculationSession): CalculatedFigure | null {
  const saved = target.calculated?.figure;
  if (!saved || saved.analysis || saved.inputs.length === 0) return null;
  const inputs: FigureInput[] = [];
  for (const input of saved.inputs) {
    const checked = calculations.recheck(input);
    if (
      "problem" in checked ||
      checked.input.citation.check !== "found" ||
      (checked.input.unitStatement && checked.input.unitStatement.citation.check !== "found")
    )
      return null;
    inputs.push(checked.input);
  }
  const result = evaluateFormula(
    saved.formula,
    inputs.map((input) => ({ name: input.name, ...input.number })),
    saved.engine,
  );
  if (!result.ok || result.value !== saved.value) return null;
  const shown = showResult(result, saved.show);
  if (!shown.ok || shown.shown !== saved.shown) return null;
  return { ...saved, inputs };
}

/** The source writes only digits, with no unit, currency or scale of its own or from a quoted heading, and the note's figure has one. */
function addsToBareNumber(figure: CheckFigure["reading"], source: FigureInput): boolean {
  return (
    source.number.unit.kind === "plain" &&
    source.number.scale === 1 &&
    source.unitStatement === null &&
    (figure.unit.kind !== "plain" || figure.scale !== 1)
  );
}

/**
 * The scale and unit a figure's source writes it in: its source number's, or a calculation's
 * when every input shares one with the result ("£m" inputs summed to an amount in £).
 */
function frameOf(
  inputs: readonly FigureInput[],
  result: unknown,
): { scale: number; unit: string } | null {
  const unit = JSON.stringify(result);
  const scales = new Set(inputs.map((input) => input.number.scale));
  const [scale] = scales;
  if (
    scale === undefined ||
    scales.size !== 1 ||
    inputs.some((input) => JSON.stringify(input.number.unit) !== unit)
  )
    return null;
  return { scale, unit };
}

/**
 * A number the note writes as bare digits under its own statement of a scale ("(£m)") is
 * compared in its source's frame when the note offers that one: both write the same digits
 * under the same statement, which is how the model compares them too. A frame the note
 * doesn't offer leaves the digits as written.
 */
function inSourceFrame(
  original: CheckFigure,
  target: CheckFigure,
  frame: { scale: number; unit: string } | null,
): CheckFigure {
  const { reading } = target;
  if (!frame || reading.unit.kind !== "plain" || reading.scale !== 1) return target;
  const framed = original.reading.ambiguous
    .find((each) => each.kind === "scale")
    ?.readings.find(
      (each) =>
        each.scale !== 1 && each.scale === frame.scale && JSON.stringify(each.unit) === frame.unit,
    );
  if (!framed) return target;
  return {
    ...target,
    reading: {
      ...reading,
      ...framed,
      ambiguous: reading.ambiguous.filter((each) => each.kind !== "scale"),
    },
  };
}

/** A Figures line's source, read as `calculate` reads an input: its number, or why it can't be read. */
export function readFigureSource(
  calculations: Pick<CalculationSession, "number">,
  target: CheckFigure,
  source: NonNullable<FigureReplyItem["source"]>,
): ReturnType<CalculationSession["number"]> {
  const { record, ...given } = source;
  return calculations.number({
    name: "source",
    label: target.label ?? target.reading.chars,
    ...given,
    ...record,
  });
}

export async function checkFigureReply(options: FigureCheckOptions): Promise<ClaimCheckResult> {
  const { requested, calculations } = options;
  const unavailable = (reason: ClaimCheckFailure = "no-evidence"): ClaimJudgment => ({
    verdict: "not-checked",
    reason,
    detail: null,
    ...options.facts(),
  });
  const parsed = readFigureReply(options.reply, requested, options.claim);
  if (!parsed) return uncheckedFigureResults(requested, unavailable("malformed"));
  calculations.check();
  const items = new Map(parsed.items.map((item) => [item.id, item]));
  const rows: FigureCheckResult[] = [];
  for (const original of requested) {
    let target = original;
    const item = items.get(target.id);
    if (!item) {
      rows.push({ ...finding(target), result: unavailable("malformed") });
      continue;
    }
    const cited = item.source?.citation ? options.citation(item.source.citation) : null;
    const ambiguities = target.reading.ambiguous.filter((reading) => reading.kind !== "range");
    const selected = ambiguities[0]?.readings[(item.reading ?? 0) - 1];
    if (
      (ambiguities.length > 0 && target.reading.ambiguous.length > 1) ||
      (ambiguities.length === 1 && !selected)
    ) {
      rows.push({ ...finding(target), source: cited, result: unavailable("unread") });
      continue;
    }
    if (selected)
      target = {
        ...target,
        reading: {
          ...target.reading,
          ...selected,
          ambiguous: target.reading.ambiguous.filter((reading) => reading.kind === "range"),
        },
      };
    let sourceInput: FigureInput | null = null;
    let calculation: CalculatedFigure | null = null;
    let costs: ReadonlySet<string> = new Set();
    if (item.source) {
      const input = readFigureSource(calculations, target, item.source);
      if (
        "input" in input &&
        input.input.citation.check === "found" &&
        (!input.input.unitStatement || input.input.unitStatement.citation.check === "found")
      )
        sourceInput = input.input;
    } else if (item.calculation !== null) {
      calculation = calculations.figure(item.calculation);
      costs = options.costs(item.calculation);
      if (
        calculation?.analysis ||
        calculation?.inputs.some(
          (input) =>
            input.citation.check !== "found" ||
            (input.unitStatement && input.unitStatement.citation.check !== "found"),
        )
      )
        calculation = null;
    }
    target = inSourceFrame(
      original,
      target,
      sourceInput
        ? frameOf([sourceInput], sourceInput.number.unit)
        : calculation
          ? frameOf(calculation.inputs, calculation.unit)
          : null,
    );
    const base = { ...finding(target), source: cited ?? sourceInput?.citation ?? null };
    if (target.calculated && !target.calculated.figure.analysis) {
      calculation = replay(target, calculations);
      if (!calculation) {
        rows.push({ ...base, sourceInput, result: unavailable() });
        continue;
      }
    }
    const evidence = sourceInput?.citation ?? calculation?.inputs[0]?.citation ?? null;
    const inputs = sourceInput ? [sourceInput] : (calculation?.inputs ?? []);
    const known = options.facts();
    const facts = {
      ...known,
      versions: [
        ...known.versions,
        ...inputs
          .flatMap((input) => [
            input.citation,
            ...(input.unitStatement ? [input.unitStatement.citation] : []),
          ])
          .map((citation) => ({
            documentId: citation.documentId,
            contentHash: citation.contentHash,
          })),
      ],
    };
    const flags = options.caseFlags(evidence);
    if (!sourceInput && !calculation) {
      const result =
        item.verdict === "unsupported" &&
        !target.calculated &&
        item.source === null &&
        item.calculation === null
          ? figureJudgment(item, null, facts, flags)
          : unavailable();
      rows.push({ ...base, result });
      continue;
    }
    if (
      item.verdict === "unsupported" ||
      item.topic !== "found" ||
      item.scope !== "same" ||
      item.roles !== "same"
    ) {
      rows.push({ ...base, sourceInput, result: figureJudgment(item, evidence, facts, flags) });
      continue;
    }
    const compared =
      target.calculated && !target.calculated.figure.analysis
        ? calculation
        : sourceInput
          ? {
              value: sourceInput.number.value,
              unit: sourceInput.number.unit,
              inputs: [sourceInput],
              formula: "",
            }
          : calculation;
    const relation: LimitRelation | undefined =
      item.relation === "equals" ? undefined : item.relation;
    const agrees = compared
      ? agreesAtShownPrecision(target.reading, compared, { relation, costs })
      : null;
    if (agrees === null || !compared || typeof compared.value !== "number" || !evidence) {
      rows.push({ ...base, sourceInput, result: unavailable() });
      continue;
    }
    // Digits alone neither back nor contradict the currency, unit or scale the note adds (#2073),
    // and an agreeing number backs no unit its Documents never state (#1798).
    const quoted = inputs.flatMap((input) => [
      input.citation,
      ...(input.unitStatement ? [input.unitStatement.citation] : []),
    ]);
    const bare =
      sourceInput !== null &&
      addsToBareNumber(target.reading, sourceInput) &&
      (!agrees || target.reading.unit.kind === "currency");
    const unit = bare || agrees ? options.unitReason(target.reading.chars, quoted) : null;
    if (bare || unit) {
      const judged = figureJudgment({ ...item, verdict: "unsupported" }, evidence, facts, flags);
      rows.push({
        ...base,
        sourceInput,
        result:
          unit && judged.verdict === "unsupported" ? { ...judged, unsupported: unit } : judged,
      });
      continue;
    }
    const difference = target.reading.value - compared.value;
    const rounded =
      agrees &&
      relation === undefined &&
      target.reading.rangeTo === null &&
      target.reading.value * compared.value >= 0 &&
      difference !== 0;
    // Unlike a sentence's, this contradiction isn't judged a second time: it is arithmetic on two
    // numbers read in one frame, and the card shows the source value and its Location beside it.
    rows.push({
      ...base,
      sourceInput,
      difference: Number.isFinite(difference) ? difference : null,
      roundedFrom: rounded ? compared.value : null,
      result: {
        verdict: agrees ? "supported" : "contradicted",
        evidence,
        says: item.says,
        unsupported: null,
        calculation: calculation
          ? {
              figure: calculation,
              stated: target.reading.chars,
              agrees,
              ...(relation && { relation }),
            }
          : null,
        ...flags,
        ...facts,
      },
    });
  }
  const remainder =
    parsed.remainder === null
      ? null
      : parsed.remainder
        ? await options.remainder(parsed.remainder)
        : undefined;
  if (options.signal.aborted) return uncheckedFigureResults(requested, unavailable("stopped"));
  return { ...aggregateFigureResults(rows, remainder), figures: rows, remainder };
}
