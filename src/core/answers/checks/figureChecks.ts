import { aggregateFigureResults } from "../../../shared/figureChecks";
import { readFigures } from "../../../shared/figures";
import { evaluateFormula, showResult } from "../../../shared/formula";
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
} from "../../api";
import { isRecord } from "../../errors";
import { type CalculationSession, documentFigureContext } from "../calculations";
import { agreesAtShownPrecision } from "./calculated";
import { type ReadVerdict, readsAsRefusal, readVerdict } from "./prompt";

export interface FigureReplyItem extends ReadVerdict {
  id: string;
  reading: number | null;
  relation: "equals" | "at most" | "at least";
  source: {
    citation: number;
    position: number;
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
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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
  const lines = reply.split(/\r?\n/).flatMap((line) => FIGURES.exec(line)?.[1] ?? []);
  if (lines.length !== 1) return null;
  const line = lines[0] ?? "";
  const end = line.lastIndexOf("}") + 1;
  if (end === 0 || !/^(?:\s*\[\^[1-9]\d{0,3}\])*\s*$/.test(line.slice(end))) return null;
  let value: unknown;
  try {
    value = JSON.parse(line.slice(0, end));
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
    if (
      !isRecord(raw) ||
      !judgment ||
      typeof raw.id !== "string" ||
      !ids.delete(raw.id) ||
      !(raw.reading == null || positive(raw.reading)) ||
      (raw.relation !== "equals" && raw.relation !== "at most" && raw.relation !== "at least")
    )
      return null;
    let source: FigureReplyItem["source"] = null;
    if (raw.source !== null) {
      const input = raw.source;
      const unitQuote = isRecord(input) ? (input.unitQuote ?? null) : null;
      if (
        !isRecord(input) ||
        !positive(input.citation) ||
        !positive(input.position) ||
        !(input.reading == null || positive(input.reading)) ||
        !optionalText(unitQuote)
      )
        return null;
      source = {
        citation: input.citation,
        position: input.position,
        reading: input.reading ?? null,
        unitQuote,
      };
    }
    if (
      !(raw.calculation === null || positive(raw.calculation)) ||
      (source && raw.calculation !== null)
    )
      return null;
    items.push({
      ...judgment,
      id: raw.id,
      reading: raw.reading ?? null,
      relation: raw.relation,
      source,
      calculation: raw.calculation,
    });
  }
  if (ids.size > 0) return null;
  const parsed: FigureReply = { items };
  if (value.remainder === null) parsed.remainder = null;
  else {
    const raw = value.remainder;
    const judgment = judgmentOf(raw);
    if (
      isRecord(raw) &&
      judgment &&
      typeof raw.text === "string" &&
      raw.text.trim() !== "" &&
      claim.includes(raw.text) &&
      (raw.citation === null || positive(raw.citation)) &&
      readFigures(raw.text, documentFigureContext([{ text: raw.text }])).length === 0
    )
      parsed.remainder = { ...judgment, text: raw.text, citation: raw.citation };
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
    const source = item.source ? options.citation(item.source.citation) : null;
    const ambiguities = target.reading.ambiguous.filter((reading) => reading.kind !== "range");
    const selected = ambiguities[0]?.readings[(item.reading ?? 0) - 1];
    if (
      (ambiguities.length > 0 && target.reading.ambiguous.length > 1) ||
      (ambiguities.length === 1 && !selected)
    ) {
      rows.push({ ...finding(target), source, result: unavailable("unread") });
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
    const base = { ...finding(target), source };
    let sourceInput: FigureInput | null = null;
    let calculation: CalculatedFigure | null = null;
    let costs: ReadonlySet<string> = new Set();
    if (item.source) {
      const input = calculations.number({
        name: "source",
        label: target.label ?? target.reading.chars,
        ...item.source,
      });
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
    // Digits alone neither back nor contradict the currency, unit or scale the note adds (#2073).
    if (
      sourceInput &&
      addsToBareNumber(target.reading, sourceInput) &&
      (!agrees || target.reading.unit.kind === "currency")
    ) {
      rows.push({
        ...base,
        sourceInput,
        result: figureJudgment({ ...item, verdict: "unsupported" }, evidence, facts, flags),
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
