/**
 * A card holds only the cited part of its Document, read from the stored text of the version the
 * Citation quotes, never the whole Document: anyone the page is sent to can read it.
 */
import {
  badgeMessage,
  type CitationState,
  citationState,
  citedLocation,
  citedTextKept,
  shownDocumentName,
} from "../../shared/citations";
import { clockTime } from "../../shared/clock";
import { anchorsCovered, joinUnits, quoteInUnits, type Translate } from "../../shared/locations";
import type { TextRange } from "../../shared/quoteMatch";
import type { SourceDocument } from "../../shared/sources";
import {
  anchorsOf,
  columnName,
  parseCellRef,
  parseCueTarget,
  type UnitText,
} from "../../shared/units";
import type { CitationAttributes, CitationCheck, KeptCitationText } from "../api";
import { looksLikeHeader } from "../documents/formats/grid";

export interface CardRun {
  text: string;
  quote: boolean;
}

export interface CardCell {
  text: string;
  quote: boolean;
}

export type CardContent =
  | { kind: "passage"; runs: CardRun[]; address: string | null }
  | { kind: "cells"; columns: string[]; rows: { label: string; cells: CardCell[] }[] }
  | { kind: "lines"; lines: { time: string; speaker: string | null; runs: CardRun[] }[] }
  | { kind: "quote"; text: string; from: "scan" | "picture" | null }
  /** The page's `picture`, in pixels twice its size on the page. */
  | {
      kind: "picture";
      picture: number;
      width: number;
      height: number;
      slide: boolean;
      scan: boolean;
    }
  | { kind: "missing"; quote: string };

export interface CitationCard {
  check: CitationCheck;
  /** "Quote found on p. 9", "Contradicted". */
  heading: string;
  /** Its Document's name, with the Location when the heading doesn't give it. */
  source: string;
  /** The check has a day to say it was made on: it was found, not found, unsupported or contradicted. */
  dated: boolean;
  verdict: string | null;
  /** Its Document and Location as a screen reader says them: "Tides, page 9". */
  spoken: string;
  /** The quote the Mind holds, whether or not it was found. */
  quote: string;
  changedAfterCited: boolean;
  content: CardContent;
}

export interface CardSources {
  documents: readonly SourceDocument[];
  kept: readonly KeptCitationText[];
  /** The stored text of the Units a Citation cites, of the version it quotes; empty once it is gone. */
  units(attributes: Partial<CitationAttributes>): UnitText[];
  t: Translate;
}

/** Past this many characters, a paragraph is cut to `CONTEXT_CHARACTERS` on each side of its quote. */
const PASSAGE_CHARACTERS = 900;
const CONTEXT_CHARACTERS = 320;
const MAX_COLUMNS = 6;
const MAX_ROWS = 8;
const MAX_LINES = 6;

export function citationCard(
  attributes: Partial<CitationAttributes>,
  { documents, kept, units, t }: CardSources,
): CitationCard {
  const state = knownCheck(citationState(attributes, documents, kept));
  const quote = attributes.quote?.trim() ?? "";
  const name = shownDocumentName(attributes, documents) || t("export.unnamedDocument");
  const location = citedLocation(attributes, t);
  const placed = location !== null && (state.check === "found" || state.check === "not-found");
  const spokenLocation = citedLocation(attributes, spoken(t));
  const address = documents.find((each) => each.id === state.documentId)?.web?.address ?? null;
  return {
    check: state.check,
    heading: headingOf(state, attributes, t),
    source:
      location && !placed ? t("export.citation.location", { document: name, location }) : name,
    dated: state.check !== "checking" && state.check !== "cant-check",
    verdict: state.check === "contradicted" ? (attributes.verdict ?? null) : null,
    spoken: spokenLocation
      ? t("export.citation.location", { document: name, location: spokenLocation })
      : name,
    quote,
    changedAfterCited: state.changedAfterCited,
    content: contentOf(
      quote,
      // A Document deleted and added again is the same content under a new id.
      units({ ...attributes, documentId: state.documentId ?? attributes.documentId ?? null }),
      address,
      citedTextKept(attributes, kept),
      t,
    ),
  };
}

const CHECKS: ReadonlySet<string> = new Set<CitationCheck>([
  "checking",
  "found",
  "not-found",
  "cant-check",
  "unsupported",
  "contradicted",
]);

/** A check this version doesn't know, from a newer one through sync, is one it can't vouch for. */
const knownCheck = (state: CitationState): CitationState =>
  CHECKS.has(state.check) ? state : { ...state, check: "cant-check", reason: null };

/** The check in the app's words, except where those speak to the User: "your Documents", "checking…". */
function headingOf(
  state: CitationState,
  attributes: Partial<CitationAttributes>,
  t: Translate,
): string {
  if (state.check === "unsupported") return t("share.card.unsupported");
  if (state.check === "checking") return t("share.card.unchecked");
  const { key, params } = badgeMessage(state, attributes, t);
  return t(key, params);
}

const spoken =
  (t: Translate): Translate =>
  (key, params) =>
    key === "location.page"
      ? t(String(params?.range).includes("–") ? "share.card.pages" : "share.card.page", params)
      : t(key, params);

function contentOf(
  quote: string,
  units: readonly UnitText[],
  address: string | null,
  kept: boolean,
  t: Translate,
): CardContent {
  const first = units[0];
  if (!first) return kept ? { kind: "quote", text: quote, from: null } : { kind: "missing", quote };
  const kind = first.kind ?? "page";
  const read = units.flatMap((unit) => (unit.label?.scan ? [unit.label.scan] : []));
  const asText: CardContent = {
    kind: "quote",
    text: quote,
    from: read.some((scan) => !scan.picture) ? "scan" : read.length > 0 ? "picture" : null,
  };
  if (kind === "page" || kind === "slide" || quote === "") return asText;
  const ranges = quoteInUnits(units, quote);
  if (!ranges) return asText;
  switch (kind) {
    case "rows":
      return cellsOf(units, ranges, t) ?? asText;
    case "cues":
      return linesOf(units, ranges) ?? asText;
    default:
      return passageOf(units, ranges, kind === "section", address) ?? asText;
  }
}

function runsOf(text: string, ranges: readonly TextRange[]): CardRun[] {
  const runs: CardRun[] = [];
  let at = 0;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const start = Math.max(range.start, at);
    const end = Math.min(range.end, text.length);
    if (end <= start) continue;
    if (start > at) runs.push({ text: text.slice(at, start), quote: false });
    runs.push({ text: text.slice(start, end), quote: true });
    at = end;
  }
  if (at < text.length) runs.push({ text: text.slice(at), quote: false });
  return runs;
}

function passageOf(
  units: readonly UnitText[],
  ranges: readonly TextRange[],
  linesAreParagraphs: boolean,
  address: string | null,
): CardContent | null {
  const { text } = joinUnits(units);
  const start = Math.min(...ranges.map((range) => range.start));
  const end = Math.max(...ranges.map((range) => range.end));
  if (end - start > PASSAGE_CHARACTERS) return null;
  let [from, to] = paragraphAround(text, start, end, linesAreParagraphs ? /\n/g : /\n[ \t]*\n/g);
  const cutBefore = start - from > CONTEXT_CHARACTERS && to - from > PASSAGE_CHARACTERS;
  const cutAfter = to - end > CONTEXT_CHARACTERS && to - from > PASSAGE_CHARACTERS;
  if (cutBefore) from = wordBreakAfter(text, start - CONTEXT_CHARACTERS);
  if (cutAfter) to = wordBreakBefore(text, end + CONTEXT_CHARACTERS);
  while (from < start && /\s/.test(text[from] ?? "")) from++;
  while (to > end && /\s/.test(text[to - 1] ?? "")) to--;
  const runs = runsOf(
    text.slice(from, to),
    ranges.map((range) => ({ start: range.start - from, end: range.end - from })),
  );
  if (cutBefore) runs.unshift({ text: "… ", quote: false });
  if (cutAfter) runs.push({ text: " …", quote: false });
  return { kind: "passage", runs, address };
}

function paragraphAround(
  text: string,
  start: number,
  end: number,
  breaks: RegExp,
): [number, number] {
  let from = 0;
  let to = text.length;
  for (const match of text.matchAll(breaks)) {
    const after = match.index + match[0].length;
    if (after <= start) from = after;
    else if (match.index >= end) {
      to = match.index;
      break;
    }
  }
  return [from, to];
}

const wordBreakAfter = (text: string, at: number) => {
  const found = text.slice(at).search(/\s/);
  return found < 0 ? at : at + found + 1;
};

const wordBreakBefore = (text: string, at: number) => {
  const found = text.slice(0, at).search(/\s\S*$/);
  return found < 0 ? at : found;
};

function cellsOf(
  units: readonly UnitText[],
  ranges: readonly TextRange[],
  t: Translate,
): CardContent | null {
  const values = new Map<string, string>();
  let header: number | null = null;
  for (const unit of units) {
    for (const anchor of anchorsOf(unit)) {
      values.set(anchor.target, unit.text.slice(anchor.start, anchor.end));
    }
    if (unit.label?.header) header = unit.label.rows?.[0] ?? null;
  }
  const cited = new Set(anchorsCovered(units, ranges).map((covered) => covered.target));
  const cells = [...cited].flatMap((target) => {
    const cell = parseCellRef(target);
    return cell ? [cell] : [];
  });
  if (cells.length === 0) return null;
  const rowsInUnits = [...new Set(units.flatMap((unit) => unit.label?.rows ?? []))].sort(
    (a, b) => a - b,
  );
  const top = Math.min(...cells.map((cell) => cell.row));
  const bottom = Math.max(...cells.map((cell) => cell.row));
  const left = Math.min(...cells.map((cell) => cell.column));
  const right = Math.min(Math.max(...cells.map((cell) => cell.column)), left + MAX_COLUMNS - 1);
  const rows = rowsInUnits.filter((row) => row >= top && row <= bottom).slice(0, MAX_ROWS);
  const firstColumn = units[0]?.label?.column ?? 0;
  const columns = Array.from({ length: right - left + 1 }, (_, index) => left + index);
  // A sheet's first block holds its header row as a row of its own, unmarked.
  const topRow = rowsInUnits[0];
  if (header === null && topRow !== undefined && topRow < top) {
    const line = [...values].filter(([target]) => parseCellRef(target)?.row === topRow);
    if (looksLikeHeader(line.map(([, value]) => ({ value, numeric: false })))) header = topRow;
  }
  const at = (column: number, row: number) => values.get(`${columnName(column)}${row}`) ?? "";
  const labelled = left > firstColumn;
  return {
    kind: "cells",
    columns: columns.map((column) =>
      header !== null && header < top
        ? at(column, header) || columnName(column)
        : columnName(column),
    ),
    rows: rows.map((row) => ({
      label: (labelled && at(firstColumn, row)) || t("share.card.row", { row }),
      cells: columns.map((column) => ({
        text: at(column, row),
        quote: cited.has(`${columnName(column)}${row}`),
      })),
    })),
  };
}

function linesOf(units: readonly UnitText[], ranges: readonly TextRange[]): CardContent | null {
  const { starts } = joinUnits(units);
  const lines: { time: string; speaker: string | null; runs: CardRun[] }[] = [];
  units.forEach((unit, index) => {
    const offset = starts[index] ?? 0;
    anchorsOf(unit).forEach((anchor, cue) => {
      const times = parseCueTarget(anchor.target);
      const inside = ranges
        .map((range) => ({
          start: Math.max(range.start - offset, anchor.start) - anchor.start,
          end: Math.min(range.end - offset, anchor.end) - anchor.start,
        }))
        .filter((range) => range.start < range.end);
      if (!times || inside.length === 0) return;
      lines.push({
        time: clockTime(times.startMs),
        speaker: unit.label?.speakers?.[cue] ?? null,
        runs: runsOf(unit.text.slice(anchor.start, anchor.end), inside),
      });
    });
  });
  return lines.length > 0 ? { kind: "lines", lines: lines.slice(0, MAX_LINES) } : null;
}
