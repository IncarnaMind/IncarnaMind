import {
  CALCULATED_FIGURE_NODE,
  type CalculatedFigure,
  type CalculatedFigureAttributes,
  type Citation,
  type CitationCheckReason,
  type CitationLocation,
  type FigureFromAnalysis,
  type FigureInput,
  type FigureShowOptions,
} from "../core/api";
import { isRecord } from "../core/errors";
import type { NodeJSON } from "./blockJson";
import { citationAttributesOf, parseQuotedWords } from "./citations";
import { FORMULA_MAX_LENGTH, type ResultUnit, type ShowAs } from "./formula";
import { parseLocation } from "./locations";
import { parseCellRef } from "./units";

export const MAX_INPUTS_PER_FIGURE = 30;

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const index = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const count = (value: unknown): value is number => index(value) && value > 0;
const named = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const optionalText = (value: unknown): string | null | undefined =>
  value == null ? null : typeof value === "string" ? value : undefined;
const optionalCount = (value: unknown): number | null | undefined =>
  value == null ? null : count(value) ? value : undefined;
const currency = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Z]{3}$/.test(value);

const REASONS: readonly CitationCheckReason[] = [
  "quote-not-on-pages",
  "quoted-words-not-on-pages",
  "pages-outside-passage",
  "too-many-pages",
  "in-several-places",
  "no-text",
  "document-removed",
];

function locationOf(value: unknown): CitationLocation | null | undefined {
  if (value == null) return null;
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  const location = parseLocation(raw);
  if (!location || !isRecord(raw)) return undefined;
  if (location.kind === "section") {
    if (optionalText(raw.heading) === undefined) return undefined;
    if (raw.paragraphs != null && !location.paragraphs) return undefined;
    if (location.paragraphs && (!count(location.paragraphs.from) || !count(location.paragraphs.to)))
      return undefined;
    if (raw.figure != null && !count(raw.figure)) return undefined;
  } else {
    if (!index(location.from) || !index(location.to)) return undefined;
    if (location.kind === "rows" && optionalText(raw.sheet) === undefined) return undefined;
    if (location.kind === "page" && raw.printed != null && !location.printed) return undefined;
  }
  return location;
}

export function readFigureCitation(value: unknown): Citation | null {
  if (!isRecord(value)) return null;
  const read = citationAttributesOf(value);
  const pageFrom = optionalCount(value.pageFrom);
  const pageTo = optionalCount(value.pageTo);
  const location = locationOf(value.location);
  const reason =
    value.checkReason == null ? null : REASONS.find((each) => each === value.checkReason);
  if (
    !named(read.passageId) ||
    !named(read.documentId) ||
    typeof read.documentName !== "string" ||
    !named(read.contentHash) ||
    !named(read.quote) ||
    !read.check ||
    pageFrom === undefined ||
    pageTo === undefined ||
    (pageFrom === null) !== (pageTo === null) ||
    (pageFrom !== null && pageTo !== null && pageTo < pageFrom) ||
    location === undefined ||
    reason === undefined
  )
    return null;
  const words = value.quotedWords == null ? null : parseQuotedWords(value.quotedWords);
  if (value.quotedWords != null && !words) return null;
  return {
    passageId: read.passageId,
    documentId: read.documentId,
    documentName: read.documentName,
    contentHash: read.contentHash,
    pageFrom,
    pageTo,
    location,
    quote: read.quote,
    check: read.check,
    checkReason: reason,
    ...(words && {
      quotedWords: {
        answer: words.answer.map(({ text, found }) => ({ text, found })),
        closest: words.closest?.map(({ text, found }) => ({ text, found })) ?? null,
      },
    }),
  };
}

export function readCalculationUnit(value: unknown): ResultUnit | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "plain":
    case "percent":
    case "points":
    case "times":
    case "ratio":
    case "yes-no":
      return { kind: value.kind };
    case "currency":
      return currency(value.code) ? { kind: "currency", code: value.code } : null;
    case "rate":
      return currency(value.of) && currency(value.per)
        ? { kind: "rate", of: value.of, per: value.per }
        : null;
    case "other":
      return named(value.word) ? { kind: "other", word: value.word } : null;
    default:
      return null;
  }
}

function cellOf(value: unknown): FigureInput["cell"] | undefined {
  if (value == null) return null;
  if (!isRecord(value) || typeof value.ref !== "string") return undefined;
  const cell = parseCellRef(value.ref);
  const sheet = optionalText(value.sheet);
  if (!cell || cell.row < 1 || sheet === undefined) return undefined;
  if (value.stored != null && !finite(value.stored)) return undefined;
  return { sheet, ref: value.ref, stored: value.stored == null ? null : value.stored };
}

function unitStatementOf(value: unknown): FigureInput["unitStatement"] | undefined {
  if (value == null) return null;
  if (!isRecord(value)) return undefined;
  const citation = readFigureCitation(value.citation);
  const scaleWord = optionalText(value.scaleWord);
  const code = optionalText(value.currency);
  if (
    !citation ||
    !finite(value.scale) ||
    value.scale <= 0 ||
    scaleWord === undefined ||
    code === undefined ||
    (code !== null && !currency(code))
  )
    return undefined;
  return { citation, scale: value.scale, scaleWord, currency: code };
}

export function readFigureInput(value: unknown): FigureInput | null {
  if (!isRecord(value) || !isRecord(value.number)) return null;
  const number = value.number;
  const citation = readFigureCitation(value.citation);
  const unit = readCalculationUnit(number.unit);
  const scaleWord = optionalText(number.scaleWord);
  const reading = optionalCount(number.reading);
  const cell = cellOf(value.cell);
  const unitStatement = unitStatementOf(value.unitStatement);
  if (
    !named(value.name) ||
    !/^[\p{L}_][\p{L}\d_]*$/u.test(value.name) ||
    /^(true|false)$/i.test(value.name) ||
    typeof value.label !== "string" ||
    !citation ||
    !named(number.chars) ||
    !index(number.at) ||
    citation.quote.slice(number.at, number.at + number.chars.length) !== number.chars ||
    !finite(number.value) ||
    !finite(number.scale) ||
    number.scale <= 0 ||
    scaleWord === undefined ||
    !unit ||
    unit.kind === "ratio" ||
    unit.kind === "yes-no" ||
    !index(number.decimals) ||
    typeof number.approximate !== "boolean" ||
    reading === undefined ||
    cell === undefined ||
    unitStatement === undefined
  )
    return null;
  return {
    name: value.name,
    label: value.label,
    citation,
    number: {
      chars: number.chars,
      at: number.at,
      value: number.value,
      scale: number.scale,
      scaleWord,
      unit,
      decimals: number.decimals,
      approximate: number.approximate,
      reading,
    },
    cell,
    unitStatement,
  };
}

function showOf(value: unknown): FigureShowOptions | null {
  if (!isRecord(value) || (value.language !== "en" && value.language !== "zh-CN")) return null;
  const allowed: readonly ShowAs[] = ["number", "percent", "points", "currency", "times", "yes-no"];
  const as = value.as == null ? null : allowed.find((each) => each === value.as);
  const scale = optionalText(value.scale);
  const decimals = value.decimals == null ? null : value.decimals;
  if (
    as === undefined ||
    scale === undefined ||
    (decimals !== null && (!index(decimals) || decimals > 10))
  )
    return null;
  return { language: value.language, as, decimals, scale };
}

function analysisOf(value: unknown): FigureFromAnalysis | null | undefined {
  if (value == null) return null;
  return isRecord(value) && count(value.analysis) && named(value.result)
    ? { analysis: value.analysis, result: value.result }
    : undefined;
}

export function readCalculatedFigure(value: unknown): CalculatedFigure | null {
  if (!isRecord(value)) return null;
  const unit = readCalculationUnit(value.unit);
  const show = showOf(value.show);
  const analysis = analysisOf(value.analysis);
  const written = optionalText(value.written);
  if (
    typeof value.label !== "string" ||
    typeof value.formula !== "string" ||
    value.formula.length > FORMULA_MAX_LENGTH ||
    (!analysis && value.formula.trim() === "") ||
    !Array.isArray(value.inputs) ||
    value.inputs.length > MAX_INPUTS_PER_FIGURE ||
    (!analysis && value.inputs.length === 0) ||
    (!finite(value.value) && typeof value.value !== "boolean") ||
    !unit ||
    (typeof value.value === "boolean") !== (unit.kind === "yes-no") ||
    typeof value.approximate !== "boolean" ||
    !named(value.shown) ||
    !show ||
    !count(value.engine) ||
    !Array.isArray(value.literals) ||
    value.literals.length > value.formula.length ||
    written === undefined ||
    analysis === undefined
  )
    return null;
  const inputs: FigureInput[] = [];
  const names = new Set<string>();
  for (const raw of value.inputs) {
    const input = readFigureInput(raw);
    if (!input || names.has(input.name.toLowerCase())) return null;
    inputs.push(input);
    names.add(input.name.toLowerCase());
  }
  const literals: CalculatedFigure["literals"] = [];
  for (const literal of value.literals) {
    if (
      !isRecord(literal) ||
      !named(literal.text) ||
      !finite(literal.value) ||
      !index(literal.at) ||
      value.formula.slice(literal.at, literal.at + literal.text.length) !== literal.text
    )
      return null;
    literals.push({ text: literal.text, value: literal.value, at: literal.at });
  }
  return {
    label: value.label,
    formula: value.formula,
    inputs,
    value: value.value,
    unit,
    approximate: value.approximate,
    shown: value.shown,
    show,
    literals,
    engine: value.engine,
    written,
    ...(analysis && { analysis }),
  };
}

export function readCalculatedFigureEvidence(
  value: unknown,
): Omit<CalculatedFigureAttributes, "id"> | null {
  if (!isRecord(value)) return null;
  const figure = readCalculatedFigure(value.figure);
  const analysisId = value.analysisId == null ? null : value.analysisId;
  if (!figure || (analysisId !== null && !named(analysisId))) return null;
  if (Boolean(figure.analysis) !== (analysisId !== null)) return null;
  return { figure, analysisId };
}

export function readCalculatedFigureAttributes(value: unknown): CalculatedFigureAttributes | null {
  if (!isRecord(value) || !named(value.id)) return null;
  const evidence = readCalculatedFigureEvidence(value);
  return evidence ? { id: value.id, ...evidence } : null;
}

/** A calculated figure node's words as the note shows them. */
export const figureShownText = (attrs: unknown): string =>
  readCalculatedFigureAttributes(attrs)?.figure.shown ?? "";

export function calculatedFigureNode(
  figure: CalculatedFigure,
  id: string,
  analysisId: string | null = null,
): NodeJSON {
  const read = readCalculatedFigureAttributes({ id, figure, analysisId });
  if (!read) throw new Error("A calculated figure needs valid provenance and an explicit id.");
  return {
    type: CALCULATED_FIGURE_NODE,
    attrs: { id: read.id, figure: read.figure, analysisId: read.analysisId },
  };
}
