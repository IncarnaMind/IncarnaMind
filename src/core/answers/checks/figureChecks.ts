import { MARKER } from "../../../shared/answerSentences";
import { aggregateFigureResults } from "../../../shared/figureChecks";
import { readFigures } from "../../../shared/figures";
import { evaluateFormula, sameNumber, showResult } from "../../../shared/formula";
import { escapedInStrings } from "../../../shared/jsonText";
import type { UnitText } from "../../../shared/units";
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
  WorkbookKeptReason,
} from "../../api";
import { isRecord } from "../../errors";
import { figureAgain, keptReason, whatIfAgain } from "../../workbooks/trace";
import { type CalculationSession, documentFigureContext, whole } from "../calculations";
import { agreesAtShownPrecision } from "./calculated";
import { FIGURES, type ReadVerdict, readsAsRefusal, readVerdict } from "./prompt";
import type { BoundNumber } from "./units";

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

const MAX_REPLY_CHARACTERS = 100_000;
// An item's own words (says, covered, uncovered) may each run to 2,000 characters, so the reply
// may grow with the figures it answers for: a 500-value chart's shortest reply is over 100,000.
const ITEM_CHARACTERS = 8_000;
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

/**
 * A check Run's reply for a sentence with figures, read across its turns: a last turn that gives
 * no verdict is read after the last turn set aside with one. Claude Haiku 5.5 wrote its whole
 * reply in the turn that calls `cite` and prose after it, or only its verdict lines there and its
 * Figures line alone after it (#2184).
 */
export function figureReplyText(reply: string, setAside: readonly string[]): string {
  if (readsAsRefusal(reply) || readVerdict(reply)) return reply;
  // A refusal set aside after the verdict is the model's last word on it.
  const earlier = setAside.findLast((text) => readVerdict(text) !== null || readsAsRefusal(text));
  return earlier === undefined || readsAsRefusal(earlier) ? reply : `${earlier}\n${reply}`;
}

/** The markers the reply's own words carry, in order: its Figures line's are its figures'. */
export function verdictMarkers(reply: string): number[] {
  return reply
    .split(/\r?\n/)
    .filter((line) => !FIGURES.test(line))
    .flatMap((line) => [...line.matchAll(MARKER)].map((match) => Number(match[1])));
}

export function readFigureReply(
  reply: string,
  figures: readonly CheckFigure[],
  claim: string,
): FigureReply | null {
  if (reply.length > MAX_REPLY_CHARACTERS + figures.length * ITEM_CHARACTERS) return null;
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

/**
 * A whole read's result for an absence part with figures. A figure inside what the part says is
 * absent (`absent`, the read's copy of those words, a proper part of the sentence) is decided
 * with the absence: it takes the absence's own result and evidence. The read judges nothing
 * else, so any other figure is Not checked, never Supported on the absence.
 */
export function absenceFigureResults(
  claim: string,
  requested: readonly CheckFigure[],
  absence: ClaimJudgment,
  absent: string | null,
): ClaimCheckResult {
  const count = (text: string, part: string) => text.split(part).length - 1;
  const bare = (text: string) => text.trim().replace(/[.。!！?？]+$/u, "");
  const part =
    absent !== null &&
    claim.includes(absent) &&
    bare(absent) !== "" &&
    bare(absent) !== bare(claim);
  const inAbsent = (figure: CheckFigure) =>
    part &&
    absent !== null &&
    count(absent, figure.reading.chars) > 0 &&
    count(absent, figure.reading.chars) === count(claim, figure.reading.chars);
  const { versions, excluded } = absence;
  const unread: ClaimJudgment = {
    verdict: "not-checked",
    reason: "malformed",
    detail: null,
    versions,
    excluded,
  };
  const figures = requested.map(
    (figure): FigureCheckResult => ({
      ...finding(figure),
      result: inAbsent(figure) ? absence : unread,
    }),
  );
  return { ...aggregateFigureResults(figures, null), figures, remainder: null };
}

/**
 * A wider word, another party or another topic takes a Supported verdict's support away; for a
 * contradiction the parties the other way round are what contradicts, and its quote is judged.
 */
export function figureJudgment(
  reply: ReadVerdict,
  evidence: Citation | null,
  facts: Facts,
  flags: CaseFlags,
): ClaimJudgment {
  if (
    reply.verdict === "unsupported" ||
    (reply.verdict === "supported" &&
      (reply.scope === "wider" || reply.roles === "differs" || reply.topic === "not found"))
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
  /**
   * Why a figure's unit, currency or scale isn't backed by these Citations or their Documents
   * (#1798), given the numbers it was compared with (`bound`).
   */
  unitReason(
    figure: string,
    citations: readonly Citation[],
    bound: readonly BoundNumber[],
  ): UnsupportedReason | null;
  /** A cited Document version's Units, for a workbook's figure worked out again (#2347). */
  units(citation: Citation): readonly UnitText[];
  signal: AbortSignal;
}

/**
 * A workbook's figure checked again (#2347): its cell and its inputs read again where they are
 * cited, and a what-if worked out again from the workbook's formulas. A figure the workbook gives
 * is then compared with its cell, as a figure a Document states is; a what-if with its own result.
 */
/** Why a workbook's figure can't be checked, by why a cell it depends on keeps its saved value. */
const KEPT_FAILURES: Partial<Record<WorkbookKeptReason, ClaimCheckFailure>> = {
  differs: "workbook-differs",
  external: "workbook-external",
  volatile: "workbook-volatile",
  circular: "workbook-circular",
  iterative: "workbook-circular",
  "not-read": "workbook-not-read",
  "no-saved-value": "workbook-no-saved-value",
};

async function replayWorkbook(
  saved: CalculatedFigure,
  options: Pick<FigureCheckOptions, "calculations" | "units" | "signal">,
): Promise<{ cell: FigureInput; figure: CalculatedFigure } | ClaimCheckFailure> {
  const book = saved.workbook;
  if (!book) return "workbook-changed";
  const found = (input: FigureInput) => {
    const checked = options.calculations.recheck(input);
    return "problem" in checked || checked.input.citation.check !== "found" ? null : checked.input;
  };
  const cell = found(book.cell.input);
  if (!cell || cell.number.value !== book.saved) return "workbook-changed";
  const inputs: FigureInput[] = [];
  for (const input of saved.inputs) {
    const checked = found(input);
    if (!checked) return "workbook-changed";
    inputs.push(checked);
  }
  const { documentId, contentHash } = cell.citation;
  const stored = { documentId, contentHash, units: options.units(cell.citation) };
  const { change } = book;
  if (change) {
    const changed = inputs.find((input) => input.name === change.input)?.cell;
    if (!changed) return "workbook-changed";
    const value = await whatIfAgain(stored, book.cell, changed, change.value, options.signal);
    if (value !== saved.value) return "workbook-changed";
  } else {
    // Its cell's number backs it only when every formula behind it is worked out here and gives
    // the value Excel saved: one kept at its saved value could be stale, linked or volatile.
    const kept = await figureAgain(stored, book.cell, options.signal);
    if (!kept) return "workbook-changed";
    const [first] = kept;
    if (first) return KEPT_FAILURES[keptReason(first.problem)] ?? "workbook-unsupported";
  }
  return {
    cell,
    figure: { ...saved, inputs, workbook: { ...book, cell: { ...book.cell, input: cell } } },
  };
}

function replay(target: CheckFigure, calculations: CalculationSession): CalculatedFigure | null {
  const saved = target.calculated?.figure;
  if (!saved || saved.analysis || saved.workbook || saved.inputs.length === 0) return null;
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

/** Whether a source number equals the figure in any way the figure can be read. */
export function givesItsOwnNumber(target: CheckFigure, input: FigureInput): boolean {
  return [target.reading, ...target.reading.ambiguous.flatMap((each) => each.readings)].some(
    (reading) => sameNumber(reading.value, input.number.value),
  );
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
    // Bare digits under the note's own "(£m)" need no reading named: their source's frame
    // settles which one they are (`inSourceFrame`), as it does for the model. With no source,
    // an Unsupported one needs no reading either.
    const framedLater = ambiguities.length === 1 && ambiguities[0]?.kind === "scale";
    if (
      (ambiguities.length > 0 && target.reading.ambiguous.length > 1) ||
      (ambiguities.length === 1 && !selected && !framedLater)
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
    let pageUnread = false;
    let calculation: CalculatedFigure | null = null;
    let costs: ReadonlySet<string> = new Set();
    // A saved calculation is checked by working it out again from its own inputs: a source or a
    // calculation the model names beside it would give the verdict one number and the card another.
    const replayed = target.calculated !== null && !target.calculated.figure.analysis;
    const savedFigure = target.calculated?.figure;
    if (replayed && savedFigure?.workbook) {
      const again = await replayWorkbook(savedFigure, options);
      if (typeof again === "string") {
        rows.push({ ...finding(target), result: unavailable(again) });
        continue;
      }
      if (savedFigure.workbook.change) calculation = again.figure;
      else sourceInput = again.cell;
    } else if (replayed) {
      calculation = replay(target, calculations);
      if (!calculation) {
        rows.push({ ...finding(target), result: unavailable() });
        continue;
      }
    } else if (item.source) {
      const input = readFigureSource(calculations, target, item.source);
      if ("problem" in input) pageUnread = input.pageUnread === true;
      else if (
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
    const framed = inSourceFrame(
      original,
      target,
      sourceInput
        ? frameOf([sourceInput], sourceInput.number.unit)
        : calculation
          ? frameOf(calculation.inputs, calculation.unit)
          : null,
    );
    if (framedLater && !selected && framed === target && (sourceInput || calculation)) {
      rows.push({ ...finding(target), source: cited, result: unavailable("unread") });
      continue;
    }
    target = framed;
    const base = {
      ...finding(target),
      source: replayed ? (sourceInput?.citation ?? null) : (cited ?? sourceInput?.citation ?? null),
    };
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
    const unbacked = (quoted: Citation | null) =>
      figureJudgment({ ...item, verdict: "unsupported" }, quoted, facts, flags);
    if (!sourceInput && !calculation) {
      // A figure the model doesn't call Supported, with no source that can be read, is one its
      // quotes don't hold: Unsupported in its own right, and not asked about again (#2184). A
      // quote where the check can't read it, recorded or inline, stays not checked.
      rows.push({
        ...base,
        result:
          item.verdict !== "supported" && !target.calculated && !pageUnread
            ? unbacked(null)
            : unavailable(),
      });
      continue;
    }
    if (
      item.verdict === "unsupported" ||
      item.topic !== "found" ||
      item.scope !== "same" ||
      item.roles !== "same"
    ) {
      rows.push({ ...base, sourceInput, result: unbacked(evidence) });
      continue;
    }
    const compared =
      target.calculated && !target.calculated.figure.analysis && !sourceInput
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
    // and no number, equal or not, backs a unit its Documents never state (#1798).
    const quoted = inputs.flatMap((input) => [
      input.citation,
      ...(input.unitStatement ? [input.unitStatement.citation] : []),
    ]);
    const bare =
      sourceInput !== null &&
      addsToBareNumber(target.reading, sourceInput) &&
      (!agrees || target.reading.unit.kind === "currency");
    const unit = options.unitReason(
      target.reading.chars,
      quoted,
      inputs.map(({ number }) => ({
        chars: number.chars,
        // An exchange rate names the currency it converts into.
        unit:
          number.unit.kind === "rate" ? { kind: "currency", code: number.unit.of } : number.unit,
        scale: number.scale,
      })),
    );
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
    // The model found the Document giving something else, yet bound a number equal to the
    // figure: another row's, or one in a unit the reader doesn't see. It is never Supported.
    if (agrees && item.verdict === "contradicted") {
      rows.push({ ...base, sourceInput, result: unavailable("unread") });
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

const STRICTNESS: Record<ClaimJudgment["verdict"], number> = {
  contradicted: 0,
  unsupported: 1,
  "not-checked": 2,
  supported: 3,
};

/**
 * A sentence's figure-by-figure result, given the check's own verdict on the whole sentence
 * (`sentence`, asked for only when it can matter). A figure's result can only make that verdict
 * stricter, never weaker, and Contradicted always wins (#2184): a contradiction no figure shows
 * rests on the sentence's other words, such as its parties, period or unit, so it takes the
 * remainder's place, however the model wrote its remainder. A Supported verdict settles nothing
 * the figures and the remainder don't, so a missing remainder still leaves the sentence not
 * checked.
 */
export async function withSentenceVerdict(
  result: ClaimCheckResult,
  sentence: () => Promise<ClaimJudgment>,
): Promise<ClaimCheckResult> {
  const { figures, remainder } = result;
  if (!figures || result.verdict === "contradicted") return result;
  const judged = await sentence();
  if (
    judged.verdict === "supported" ||
    (remainder && STRICTNESS[remainder.verdict] <= STRICTNESS[judged.verdict])
  )
    return result;
  return { ...aggregateFigureResults(figures, judged), figures, remainder: judged };
}
