import { MARKER } from "../../../shared/answerSentences";
import { aggregateFigureResults } from "../../../shared/figureChecks";
import { quotedSourceText } from "../../../shared/figureSchedule";
import {
  type Figure,
  type FigureUnit,
  namedCurrencies,
  readFigures,
  readStatedUnits,
} from "../../../shared/figures";
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
import { type CalculationSession, documentFigureContext, shifted, whole } from "../calculations";
import { labelled, parseJson } from "../judge";
import { linesSayFrame, namingHolds } from "./analysisNaming";
import { agreesAtShownPrecision, comparedFigure } from "./calculated";
import { type FigureMeasure, measureFinding, readMeasure } from "./figureMeasures";
import { isPropertyPassage } from "./fileProperties";
import { FIGURES, figureHandle, ownDetailDiffers, type ReadVerdict, readVerdict } from "./prompt";
import type { BoundNumber } from "./units";

export interface FigureReplyItem extends ReadVerdict {
  id: string;
  /** What the number measures, in the sentence's words and the quote's; null when it gives none that reads. */
  measure: FigureMeasure | null;
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
  /** An Analysis's figure: whether the sentence's words name it as its label and rule do; null when not given. */
  names: "same" | "other" | "unclear" | null;
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
    !["same", "differs", "other"].includes(String(value.roles)) ||
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
  const line = labelled(reply.split(/\r?\n/), FIGURES, (rest) => rest.trimStart().startsWith("{"));
  if (line === undefined || line === null) return null;
  const end = line.lastIndexOf("}") + 1;
  if (end === 0 || !/^(?:\s*\[\^[1-9]\d{0,3}\])*\s*$/.test(line.slice(end))) return null;
  // A quote copied from a sheet row keeps its raw tabs, as in a Tool call's input (#1827).
  const value = parseJson(escapedInStrings(line.slice(0, end)))?.value;
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length !== figures.length)
    return null;
  const ids = new Set(figures.map((figure) => figure.id));
  if (ids.size !== figures.length) return null;
  const byHandle = new Map(figures.map((figure, index) => [figureHandle(index), figure.id]));
  // An Analysis's figure is judged by its name alone: a source or calculation given for it is
  // never read, so one written as prose doesn't make the reply unreadable (#2378).
  const analysed = new Set(
    figures.filter((figure) => figure.calculated?.figure.analysis).map((figure) => figure.id),
  );
  const items: FigureReplyItem[] = [];
  for (const given of value.items) {
    const id = isRecord(given) && typeof given.id === "string" ? byHandle.get(given.id) : undefined;
    const raw =
      isRecord(given) && id !== undefined && analysed.has(id)
        ? { ...given, source: null, calculation: null, reading: null }
        : given;
    const judgment = judgmentOf(raw);
    const reading = isRecord(raw) ? optionalCount(raw.reading) : undefined;
    const calculation = isRecord(raw) ? optionalCount(raw.calculation) : undefined;
    if (
      !isRecord(raw) ||
      !judgment ||
      id === undefined ||
      !ids.delete(id) ||
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
    items.push({
      ...judgment,
      id,
      measure: readMeasure(raw.measure),
      reading,
      relation: raw.relation,
      source,
      calculation,
      names:
        raw.names === "same" || raw.names === "other" || raw.names === "unclear" ? raw.names : null,
    });
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

function finding({ unitLines: _unitLines, ...figure }: CheckFigure) {
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
 * A wider word, another party, another duty, a condition left out, what has happened for what is
 * still to happen, or another topic takes a Supported verdict's support away; for a
 * contradiction the parties the other way round are what contradicts, and its quote is judged. A
 * sentence about someone the Passage gives no part in it is neither backed nor contradicted (#1766).
 */
export function figureJudgment(
  reply: ReadVerdict,
  evidence: Citation | null,
  facts: Facts,
  flags: CaseFlags,
): ClaimJudgment {
  if (
    reply.verdict === "unsupported" ||
    reply.roles === "other" ||
    (reply.verdict === "supported" &&
      (reply.scope === "wider" || ownDetailDiffers(reply) || reply.topic === "not found"))
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

/**
 * An Analysis's figure in a sentence (#2378). Its number is its run's, never the Documents' text,
 * which never holds it; whether the sentence names it is the claim judge's, from its label, rule and
 * code (`names`). Supported only when IncarnaMind worked the number out again, the Documents it read
 * are as they were, the judge read the sentence as naming it, and `namingHolds`, which can only take
 * that away, finds its own clause names it and nothing else. Unsupported only when the judge read the
 * sentence as naming another figure. Not checked otherwise: no code ever reads a name as right.
 */
function analysisJudgment(
  target: CheckFigure,
  facts: Facts,
  options: Pick<FigureCheckOptions, "misnamed" | "keptInside">,
  item: FigureReplyItem | undefined,
  holds: boolean,
): ClaimJudgment {
  const record = target.analysisRecord;
  const read = (record?.citations ?? []).map(({ documentId, contentHash }) => ({
    documentId,
    contentHash,
  }));
  const known = { ...facts, versions: [...facts.versions, ...read] };
  if (!record) return { verdict: "not-checked", reason: "analysis-gone", detail: null, ...known };
  // Its run read a Document kept inside a walled Folder this check is outside: nothing of it counts.
  const wall = record.citations.map((each) => options.keptInside(each.documentId)).find(Boolean);
  if (wall) return { verdict: "not-checked", reason: "kept-inside", detail: wall, ...known };
  const [evidence] = record.citations;
  if (!record.recalculated || !evidence)
    return { verdict: "not-checked", reason: "analysis", detail: null, ...known };
  const label = record.label ?? target.calculated?.figure.label ?? "";
  const unread = { citedCaseUnchecked: false, citedCaseFound: false, calculation: null };
  // The judge decides: a reply whose fields disagree with its verdict was asked once already
  // (`analysisItemDisagrees`), and still can't be read as one.
  if (!item || analysisItemDisagrees(item) !== null)
    return { verdict: "not-checked", reason: "malformed", detail: null, ...known };
  if (item.names === "other")
    return {
      verdict: "unsupported",
      evidence: null,
      says: item.says,
      unsupported: options.misnamed(label),
      ...unread,
      ...known,
    };
  if (item.names === "same" && holds)
    return { verdict: "supported", evidence, says: null, unsupported: null, ...unread, ...known };
  return { verdict: "not-checked", reason: "analysis-unnamed", detail: label, ...known };
}

/**
 * Why an Analysis figure's item disagrees with its own verdict (#2378); null when it agrees. Its
 * "same" stands only with the verdict supported, the relation equals and its subject, roles and
 * scope the figure's own; "other" only with unsupported; "unclear" never with supported.
 */
export function analysisItemDisagrees(item: FigureReplyItem): string | null {
  switch (item.names) {
    case "same":
      return item.verdict === "supported" &&
        item.relation === "equals" &&
        item.topic === "found" &&
        item.roles === "same" &&
        item.scope === "same"
        ? null
        : `"names" is "same", but its verdict is ${item.verdict}, relation ${item.relation}, topic ${item.topic}, roles ${item.roles} and scope ${item.scope}`;
    case "other":
      return item.verdict === "unsupported"
        ? null
        : `"names" is "other", but its verdict is ${item.verdict}`;
    case "unclear":
      return item.verdict === "supported"
        ? `"names" is "unclear", but its verdict is supported`
        : null;
    default:
      return 'it gives no "names"';
  }
}

export interface FigureCheckOptions {
  requested: readonly CheckFigure[];
  claim: string;
  /** The paragraph the sentence is in: its words for what a figure measures may be there. */
  paragraph?: string;
  reply: string;
  /** The reply's own explanation of its verdict: the reason of a figure its item gives none for. */
  explanation: string | null;
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
  /** The texts a quote is in, its cited pages first: where its table's rows and headings are. */
  around(citation: Citation): readonly string[];
  /** Why a figure isn't backed by a source number (`amount`) that measures something else (#2255). */
  otherMeasure(amount: string, measured: string, claimed: string): UnsupportedReason;
  /** Why a bare figure needs a look when its source (`amount`, in its terms) differs only by a unit (#2864). */
  unitsMayDiffer(amount: string): UnsupportedReason;
  /** Why an Analysis's figure isn't backed by its run: the sentence doesn't name it as `label` does. */
  misnamed(label: string): UnsupportedReason;
  /** The walled Folder that keeps a Document inside it, outside this check's scope; null otherwise. */
  keptInside(documentId: string): string | null;
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
): Promise<{ cell: FigureInput | null; figure: CalculatedFigure } | ClaimCheckFailure> {
  const book = saved.workbook;
  if (!book) return "workbook-changed";
  const found = (input: FigureInput) => {
    const checked = options.calculations.recheck(input);
    return "problem" in checked || checked.input.citation.check !== "found" ? null : checked.input;
  };
  const own = book.cell.input;
  // A text figure has no number to read again; the workbook isn't said to have changed for that.
  if (!own) return book.text ? "workbook-text" : "workbook-changed";
  const cell = found(own);
  if (!cell || cell.number.value !== book.saved) return "workbook-changed";
  const inputs: FigureInput[] = [];
  for (const input of saved.inputs) {
    const checked = found(input);
    if (!checked) return "workbook-changed";
    inputs.push(checked);
  }
  const { documentId, contentHash } = cell.citation;
  const stored = { documentId, contentHash, units: options.units(cell.citation) };
  const { changes } = book;
  if (changes.length > 0) {
    const places: { sheet: string | null; ref: string; value: number }[] = [];
    for (const change of changes) {
      const changed = inputs.find((input) => input.name === change.input)?.cell;
      if (!changed) return "workbook-changed";
      places.push({ sheet: changed.sheet, ref: changed.ref, value: change.value });
    }
    const value = await whatIfAgain(stored, book.cell, places, options.signal);
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

/** A figure written as digits alone: no currency, unit or scale of its own, and none offered. */
function writtenBare(reading: Figure): boolean {
  return (
    reading.unit.kind === "plain" &&
    reading.scale === 1 &&
    reading.scaleWord === null &&
    reading.currency === null &&
    reading.rangeTo === null &&
    !reading.ambiguous.some(({ kind }) => kind === "scale" || kind === "currency")
  );
}

const scaledBy = (value: number, scale: number) => {
  const exponent = Math.round(Math.log10(scale));
  return 10 ** exponent === scale ? shifted(value, exponent) : value * scale;
};

/** `reading` with a scale and unit put on its digits, its shown precision scaled with it. */
function readAt(
  reading: Figure,
  scale: number,
  scaleWord: string | null,
  unit: FigureUnit,
): Figure {
  return {
    ...reading,
    value: scaledBy(reading.value, scale),
    scale,
    scaleWord,
    unit,
    ...(typeof reading.precision === "number" && {
      precision: scaledBy(reading.precision, scale),
    }),
  };
}

/**
 * The scale and unit a figure's source is in: its number's, or a calculation's own, at the scale
 * its inputs share. Null for a ratio, a rate or a yes or no, which no unit line is said of.
 */
function sourceFrame(
  source: FigureInput | null,
  calculation: CalculatedFigure | null,
): { scale: number; unit: FigureUnit } | null {
  if (source) {
    const { unit, scale } = source.number;
    return unit.kind === "rate" ? null : { scale, unit };
  }
  if (!calculation) return null;
  const { unit } = calculation;
  if (unit.kind === "ratio" || unit.kind === "rate" || unit.kind === "yes-no") return null;
  const scales = new Set(calculation.inputs.map((input) => input.number.scale));
  const [scale] = scales;
  return { scale: scales.size === 1 && scale !== undefined ? scale : 1, unit };
}

/** The unit a scale line states, as its Document writes it: "GBP million", "人民币百万元". */
function statedUnitWords(statement: NonNullable<FigureInput["unitStatement"]>): string {
  const line = statement.citation.quote;
  const read = readStatedUnits(line, documentFigureContext([{ text: line }])).find(
    (each) => each.scale === statement.scale,
  );
  const words = read?.chars
    .replace(/^(?:金额|金額)?(?:单位|單位)\s*[:：]\s*/u, "")
    .replace(/^[(（]\s*|\s*[)）]$/gu, "")
    .replace(/^in\s+/i, "")
    .trim();
  return (
    words ||
    [statement.currencyChars ?? statement.currency, statement.scaleWord].filter(Boolean).join(" ")
  );
}

/**
 * A figure the sentence writes as bare digits, read in the unit its source's Document states
 * (#2864): "668.3" under "GBP million unless stated otherwise" is the Document's 668.3, written as
 * the Document writes it. Only the line the judge quoted as its unitQuote, which the check found
 * in the Document, gives the scale, so the comparison is of the same digits in one frame. Null
 * when the source's scale isn't the line's, or the sentence names another currency.
 */
function inStatedUnit(
  target: CheckFigure,
  source: FigureInput | null,
  claim: string,
): { target: CheckFigure; unit: string } | null {
  const statement = source?.unitStatement;
  if (!source || !statement || statement.scale === 1) return null;
  const { number } = source;
  if (number.scale !== statement.scale) return null;
  if (number.unit.kind !== "plain" && number.unit.kind !== "currency") return null;
  const code = number.unit.kind === "currency" ? number.unit.code : null;
  const named = namedCurrencies(claim, documentFigureContext([{ text: claim }]), null);
  if ([...named].some((each) => each !== code)) return null;
  return {
    target: {
      ...target,
      reading: readAt(target.reading, statement.scale, statement.scaleWord, number.unit),
    },
    unit: statedUnitWords(statement),
  };
}

// A thousand, a million and a billion: the scales a unit line most often leaves off a figure.
const UNIT_SCALES = [1e3, 1e6, 1e9];
// "3" is 3,400 at its shown places a thousand times over; a unit explains only a near-equal figure.
const UNIT_CLOSENESS = 0.005;

/**
 * Whether a figure written as bare digits differs from what it is compared with only by a unit:
 * by a thousand, a million, a billion or the scale its source's Document states (万, 亿), either
 * way, to the figure's shown precision and within half a percent (#2864). A share, a multiple or
 * a limit never is.
 */
function differsOnlyByUnit(
  bare: Figure,
  compared: Pick<CalculatedFigure, "value" | "unit" | "inputs" | "formula">,
  stated: number | null,
): boolean {
  if (typeof compared.value !== "number") return false;
  if (compared.unit.kind !== "plain" && compared.unit.kind !== "currency") return false;
  const { value } = compared;
  const close = (a: number, b: number) =>
    Math.abs(a - b) <= UNIT_CLOSENESS * Math.max(Math.abs(a), Math.abs(b));
  const scales = new Set([...UNIT_SCALES, ...(stated !== null && stated > 1 ? [stated] : [])]);
  return [...scales].some((scale) => {
    const up = readAt(bare, scale, null, bare.unit);
    const down = scaledBy(value, scale);
    return (
      (agreesAtShownPrecision(up, compared) === true && close(up.value, value)) ||
      (agreesAtShownPrecision(bare, { ...compared, value: down }) === true &&
        close(bare.value, down))
    );
  });
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
    if (target.calculated?.figure.analysis) {
      const result = analysisJudgment(
        target,
        options.facts(),
        options,
        items.get(target.id),
        namingHolds(options.claim, target, requested, options.paragraph),
      );
      rows.push({
        ...finding(target),
        ...(result.verdict === "supported" && { named: true as const }),
        result,
      });
      continue;
    }
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
    // Of digits whose separators the Note doesn't settle ("8.214"), the reading listed first is the
    // one English and Chinese write. Another, a thousand times from it, chosen because it agrees,
    // rests on the digits' scale as a unit would: it is never Supported (#2864).
    const [separators] = ambiguities;
    const asWrittenFirst =
      separators?.kind === "separator" && selected && selected !== separators.readings[0]
        ? separators.readings[0]
        : undefined;
    let sourceInput: FigureInput | null = null;
    let pageUnread = false;
    let calculation: CalculatedFigure | null = null;
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
      if (savedFigure.workbook.changes.length > 0) calculation = again.figure;
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
      if (
        calculation?.analysis ||
        calculation?.inputs.some(
          (input) =>
            input.citation.check !== "found" ||
            (input.unitStatement && input.unitStatement.citation.check !== "found"),
        )
      )
        calculation = null;
      else if (calculation)
        calculation = comparedFigure(target.reading, calculation, options.costs(item.calculation));
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
    // The figure as the sentence writes it, before a unit its source's Document states frames it.
    const written = target;
    // Bare as the Note writes it: neither its own words nor a heading it is under give it a unit. A
    // file's size is compared in the unit written after its figure, where its property is read.
    const bareDigits =
      !replayed &&
      !isPropertyPassage(sourceInput?.citation.passageId) &&
      writtenBare(original.reading) &&
      writtenBare(written.reading);
    // A unit the Note states for them is the digits' own: one its source isn't in is never
    // Supported, whatever the digits (#2864). A ratio or a rate is in none.
    const frame = sourceFrame(sourceInput, calculation);
    const noteSays =
      bareDigits && target.unitLines && frame
        ? linesSayFrame(target.unitLines.split("\n"), frame.scale, frame.unit)
        : null;
    const stated =
      bareDigits && noteSays !== false ? inStatedUnit(target, sourceInput, options.claim) : null;
    if (stated) target = stated.target;
    else if (noteSays && frame)
      target = { ...target, reading: readAt(target.reading, frame.scale, null, frame.unit) };
    const base = {
      ...finding(target),
      ...(stated && { statedUnit: stated.unit }),
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
    // An item gives its own `says` only when it wants to: the reply's explanation is the reason of
    // one it leaves without, so its Unsupported card is never bare (#2184).
    const unbackedItem = {
      ...item,
      verdict: "unsupported" as const,
      says: item.says ?? options.explanation,
    };
    const unbacked = (quoted: Citation | null) =>
      figureJudgment(unbackedItem, quoted, facts, flags);
    // Bare digits that differ from their source only by a unit need a look, never Contradicted:
    // the check can't tell which unit the sentence means. Nor are they ever Supported (#2864).
    const unitsDiffer = (figure: CheckFigure = written): FigureCheckResult => {
      const judged = unbacked(evidence);
      const amount = sourceInput
        ? quotedSourceText({ reading: figure.reading, sourceInput })
        : (calculation?.shown ?? null);
      return {
        ...finding(figure),
        source: base.source,
        sourceInput,
        result:
          judged.verdict === "unsupported"
            ? { ...judged, unsupported: options.unitsMayDiffer(amount ?? "") }
            : judged,
      };
    };
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
    const bound = sourceInput;
    const measure =
      bound && !replayed
        ? measureFinding(
            item.measure,
            [options.claim, target.label ?? "", target.context ?? "", options.paragraph ?? ""],
            bound.citation.quote,
            { chars: bound.number.chars, at: bound.number.at },
            () => options.around(bound.citation),
          )
        : null;
    // A number that measures something else neither backs the figure nor contradicts it, and the
    // card says so whatever verdict the model gave the figure.
    if (bound && measure?.kind === "differs") {
      const judged = unbacked(evidence);
      const { shown } = measure;
      const why = shown && options.otherMeasure(bound.number.chars, shown.measured, shown.claimed);
      rows.push({
        ...base,
        sourceInput,
        result: why && judged.verdict === "unsupported" ? { ...judged, unsupported: why } : judged,
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
    const agrees = compared ? agreesAtShownPrecision(target.reading, compared, { relation }) : null;
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
      const judged = unbacked(evidence);
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
      // Equal only in the unit its Document states, the judge's Contradicted is about that unit.
      rows.push(stated ? unitsDiffer() : { ...base, sourceInput, result: unavailable("unread") });
      continue;
    }
    // An equal number in another row's or column's cell of the quoted table backs nothing.
    if (agrees && measure?.kind === "other-cell") {
      rows.push({ ...base, sourceInput, result: unavailable("other-cell") });
      continue;
    }
    if (
      !agrees &&
      bareDigits &&
      relation === undefined &&
      differsOnlyByUnit(written.reading, compared, sourceInput?.unitStatement?.scale ?? null)
    ) {
      rows.push(unitsDiffer());
      continue;
    }
    if (agrees && noteSays === false) {
      rows.push(unitsDiffer());
      continue;
    }
    if (agrees && asWrittenFirst) {
      rows.push(
        unitsDiffer({
          ...original,
          reading: { ...original.reading, ...asWrittenFirst, ambiguous: [] },
        }),
      );
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
    // Only the judge's own Supported can stand here; the arithmetic never gives one.
    rows.push({
      ...base,
      sourceInput,
      difference: Number.isFinite(difference) ? difference : null,
      roundedFrom: rounded ? compared.value : null,
      result: {
        verdict: agrees && item.verdict === "supported" ? "supported" : "contradicted",
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

/**
 * One verdict everywhere (#2378): a sentence whose reply couldn't be read, once its last ask is
 * settled, backs none of its figures either, so its marker, its schedule row and the sentence read
 * the same.
 */
export function oneVerdict(result: ClaimCheckResult): ClaimCheckResult {
  if (result.verdict !== "not-checked" || result.reason !== "malformed" || !result.figures)
    return result;
  return {
    ...result,
    figures: result.figures.map(({ named, ...figure }) =>
      figure.result.verdict === "supported"
        ? {
            ...figure,
            result: {
              verdict: "not-checked",
              reason: "malformed",
              detail: null,
              versions: figure.result.versions,
              excluded: figure.result.excluded,
            },
          }
        : { ...figure, ...(named && { named }) },
    ),
  };
}

/**
 * A sentence's figure results when the reply's Roles line gives the sentence to someone its
 * Passage doesn't name (#1766): a figure that agreed or disagreed with that Passage's number is
 * Unsupported, since the number is someone else's, and so are the sentence's other words, whatever
 * the remainder's own roles say. An Analysis's figure, which no Passage holds, is Unsupported only
 * for another figure's name (#2378): when its item names it, the reply is at odds with itself and
 * the figure is Not checked (#2584).
 */
export function aboutSomeoneElse(result: ClaimCheckResult): ClaimCheckResult {
  const { figures } = result;
  if (!figures) return result;
  const unbacked = (judged: ClaimJudgment): ClaimJudgment =>
    judged.verdict === "supported" || judged.verdict === "contradicted"
      ? {
          verdict: "unsupported",
          evidence: null,
          says: null,
          unsupported: { reason: judged.says, covered: null, uncovered: null, found: true },
          calculation: null,
          citedCaseUnchecked: judged.citedCaseUnchecked,
          citedCaseFound: judged.citedCaseFound,
          versions: judged.versions,
          excluded: judged.excluded,
        }
      : judged;
  const rows = figures.map(
    (figure): FigureCheckResult => ({
      ...figure,
      result:
        figure.calculated?.figure.analysis && figure.result.verdict === "supported"
          ? {
              verdict: "not-checked",
              reason: "malformed",
              detail: null,
              versions: figure.result.versions,
              excluded: figure.result.excluded,
            }
          : unbacked(figure.result),
    }),
  );
  const remainder = result.remainder ? unbacked(result.remainder) : result.remainder;
  return { ...aggregateFigureResults(rows, remainder), figures: rows, remainder };
}

const unitsMayDiffer = ({ result }: FigureCheckResult) =>
  result.verdict === "unsupported" && result.unsupported?.kind === "units";

/** Whether the words a contradiction would change are that figure's digits and nothing else. */
function onlyItsDigits(changed: string, figure: FigureCheckResult): boolean {
  const at = changed.indexOf(figure.reading.chars);
  if (at < 0) return false;
  const rest = changed.slice(0, at) + changed.slice(at + figure.reading.chars.length);
  return !/[\p{L}\p{N}]/u.test(rest);
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
 * checked. `changed`: the words of the sentence the judge's correction would change, if any.
 */
export async function withSentenceVerdict(
  result: ClaimCheckResult,
  sentence: () => Promise<ClaimJudgment>,
  changed: string | null = null,
): Promise<ClaimCheckResult> {
  const { figures, remainder } = result;
  if (!figures || result.verdict === "contradicted") return result;
  // The verdict on the whole sentence weighed an Analysis's figure against the Documents, which
  // never hold it: only the remainder the reply gave speaks for its other words (#2378).
  if (figures.some((figure) => figure.calculated?.figure.analysis)) return result;
  const judged = await sentence();
  if (
    judged.verdict === "supported" ||
    (remainder && STRICTNESS[remainder.verdict] <= STRICTNESS[judged.verdict])
  )
    return result;
  // A contradiction whose only change is a figure's digits, whose units may differ, is that unit:
  // the sentence needs a look as the figure does. Any other stays Contradicted (#2864).
  if (
    judged.verdict === "contradicted" &&
    changed !== null &&
    figures.some((figure) => unitsMayDiffer(figure) && onlyItsDigits(changed, figure))
  )
    return result;
  return { ...aggregateFigureResults(figures, judged), figures, remainder: judged };
}
